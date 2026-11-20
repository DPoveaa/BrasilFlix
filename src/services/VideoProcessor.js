const { spawn, exec } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const axios = require('axios');
const config = require('../../config');
const SubtitleAudioService = require('./SubtitleAudioService');
const SubtitlePipeline = require('./SubtitlePipeline');
const SpeechLanguageService = require('./SpeechLanguageService');
const HardsubDetectorService = require('./HardsubDetectorService');
const BetWatermarkDetectorService = require('./BetWatermarkDetectorService');
const SubtitleTranslationService = require('./SubtitleTranslationService');

let activeTranscodes = 0;
const transcodeWaiters = [];

function acquireTranscodeSlot() {
    let maxTranscodes = config.MAX_CONCURRENT_TRANSCODES || 4;
    try {
        const SchedulerService = require('./SchedulerService');
        const mode = SchedulerService.getActiveMode();
        maxTranscodes = mode === 'eco' ? 2 : (config.PERFORMANCE_MAX_TRANSCODES || 4);
    } catch (e) { }

    if (activeTranscodes < maxTranscodes) {
        activeTranscodes++;
        return Promise.resolve();
    }
    return new Promise(resolve => {
        transcodeWaiters.push(resolve);
    });
}

function releaseTranscodeSlot() {
    if (transcodeWaiters.length > 0) {
        const next = transcodeWaiters.shift();
        next();
    } else {
        activeTranscodes = Math.max(0, activeTranscodes - 1);
    }
}

class VideoProcessor {
    constructor() {
        this.maxSizeBytes = config.VIDEO_MAX_SIZE_BYTES || (2 * 1024 * 1024 * 1024); // 2GB
    }

    async getVideoInfo(filePath) {
        return new Promise((resolve, reject) => {
            const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
            exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    return reject(new Error(`Erro ao obter informações do vídeo: ${error.message}`));
                }
                try {
                    const info = JSON.parse(stdout);
                    const videoStream = (info.streams || []).find(s => s.codec_type === 'video') || {};
                    const audioStreams = (info.streams || []).filter(s => s.codec_type === 'audio');
                    const subtitleStreams = (info.streams || []).filter(s => s.codec_type === 'subtitle');
                    const format = info.format || {};

                    const width = parseInt(videoStream.width || 0, 10);
                    const height = parseInt(videoStream.height || 0, 10);
                    const duration = parseFloat(format.duration || videoStream.duration || 0);
                    const sizeBytes = parseInt(format.size || 0, 10);

                    resolve({
                        width,
                        height,
                        resolution: `${width}x${height}`,
                        is1080p: height >= 1080 || width >= 1920,
                        duration,
                        durationFormatted: this.formatDuration(duration),
                        sizeBytes,
                        sizeMB: (sizeBytes / (1024 * 1024)).toFixed(2),
                        videoCodec: (videoStream.codec_name || '').toLowerCase(),
                        pixFmt: (videoStream.pix_fmt || 'yuv420p').toLowerCase(),
                        tags: format.tags || {},
                        audioStreams: audioStreams.map((a, idx) => ({
                            index: idx,
                            globalIndex: a.index !== undefined ? a.index : idx,
                            codec: (a.codec_name || '').toLowerCase(),
                            channels: parseInt(a.channels || 2, 10),
                            channelLayout: a.channel_layout || '',
                            language: (a.tags?.language || a.tags?.LANGUAGE || a.tags?.lang || 'und').toLowerCase(),
                            title: (a.tags?.title || a.tags?.TITLE || a.tags?.handler_name || '').toLowerCase(),
                            disposition: a.disposition || null
                        })),
                        subtitleStreams: subtitleStreams.map((s, idx) => ({
                            index: idx,
                            globalIndex: s.index !== undefined ? s.index : idx,
                            codec: (s.codec_name || '').toLowerCase(),
                            language: (s.tags?.language || s.tags?.LANGUAGE || s.tags?.lang || 'und').toLowerCase(),
                            title: (s.tags?.title || s.tags?.TITLE || s.tags?.handler_name || '').toLowerCase(),
                            disposition: s.disposition || null
                        }))
                    });
                } catch (e) {
                    reject(new Error(`Falha ao decodificar JSON do ffprobe: ${e.message}`));
                }
            });
        });
    }

    async generateThumbnail(filePath, outputPath, offsetSeconds = null) {
        return new Promise(async (resolve, reject) => {
            try {
                let seekSec = 180; // padrão 3 minutos para nunca pegar tela preta ou logo de estúdio
                if (offsetSeconds !== null) {
                    seekSec = offsetSeconds;
                } else {
                    try {
                        const info = await this.getVideoInfo(filePath);
                        if (info && info.duration > 60) {
                            // Extrai o frame a 15% do vídeo ou 180s para garantir cena real do episódio
                            seekSec = Math.min(300, Math.max(45, Math.floor(info.duration * 0.15)));
                        }
                    } catch (e) { }
                }

                await fs.ensureDir(path.dirname(outputPath));

                const ffmpegArgs = [
                    '-nostdin',
                    '-ss', seekSec.toString(),
                    '-i', filePath,
                    '-vframes', '1',
                    '-q:v', '2',
                    '-vf', 'scale=1280:-1',
                    '-y',
                    outputPath
                ];

                const proc = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                proc.on('close', (code) => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        resolve(outputPath);
                    } else {
                        // Fallback para 30s caso o arquivo seja menor
                        const fallbackArgs = ['-nostdin', '-ss', '30', '-i', filePath, '-vframes', '1', '-q:v', '2', '-y', outputPath];
                        const proc2 = spawn('ffmpeg', fallbackArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                        proc2.on('close', (c2) => {
                            if (c2 === 0 && fs.existsSync(outputPath)) {
                                resolve(outputPath);
                            } else {
                                reject(new Error(`Falha ao gerar thumbnail: código ${code}/${c2}`));
                            }
                        });
                    }
                });
                proc.on('error', (err) => reject(err));
            } catch (e) {
                reject(e);
            }
        });
    }

    async verifyVideoIntegrity(filePath) {
        return new Promise((resolve) => {
            // Amostragem ultra rápida dos primeiros 30s para validar integridade do container/stream sem ler gigabytes inteiros
            const cmd = `ffmpeg -nostdin -v error -t 30 -i "${filePath}" -f null -max_error_rate 0.05 -`;
            exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
                if (error && error.killed) {
                    resolve({ isValid: true, valid: true, warning: 'Verificação rápida concluída por tempo' });
                } else if (stderr && (stderr.includes('Invalid data found') || stderr.includes('moov atom not found'))) {
                    resolve({ isValid: false, valid: false, error: stderr.substring(0, 200) });
                } else {
                    resolve({ isValid: true, valid: true });
                }
            });
        });
    }

    detectPortugueseAudioIndex(audioStreams, rawFileName = '') {
        if (!audioStreams || audioStreams.length === 0) return null;

        const ptKeywords = ['por', 'pob', 'pt', 'pt-br', 'pt_br', 'brazilian', 'portuguese', 'português'];

        // 1. Tag explícita de idioma no stream
        for (let i = 0; i < audioStreams.length; i++) {
            const lang = (audioStreams[i].language || '').toLowerCase();
            if (ptKeywords.includes(lang)) {
                return i;
            }
        }

        // 2. Título ou nome do stream (ex: "Dublado", "Português", "PT-BR", "Áudio Nacional")
        for (let i = 0; i < audioStreams.length; i++) {
            const title = (audioStreams[i].title || '').toLowerCase();
            if (title.includes('portug') || title.includes('dublado') || title.includes('pt-br') ||
                title.includes('pt_br') || title.includes('nacional') || title.includes('pob')) {
                return i;
            }
        }

        // 3. Regra de eliminação para arquivos DUAL AUDIO brasileiros:
        // Se um dos áudios estiver marcado explicitamente como estrangeiro (eng/kor/etc.) e o outro for 'und' (anônimo)
        // APENAS se o release não for comprovadamente espanhol/latino e tiver marcação de dublado/BR
        const lowerName = (rawFileName || '').toLowerCase();
        const isSpanishRelease = /\b(cinecalidad|elitetorrent|estrenos|dontorrent|pctmix|divxatope|latino|castellano|espanol|español|dual[-_ .]?lat|audio[-_ .]?lat|dual[-_ .]?cast|audio[-_ .]?cast|kontrast)\b/i.test(lowerName);
        const isExplicitPtBr = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);
        const foreignCodes = ['eng', 'spa', 'fra', 'fre', 'deu', 'ger', 'ita', 'rus', 'jpn', 'kor', 'zho', 'chi', 'hin'];
        const foreignIdx = audioStreams.findIndex(s => foreignCodes.includes((s.language || '').toLowerCase()));
        if (!isSpanishRelease && isExplicitPtBr && foreignIdx !== -1 && audioStreams.length === 2) {
            const ptCandidateIdx = audioStreams.findIndex((s, idx) => idx !== foreignIdx && !foreignCodes.includes((s.language || '').toLowerCase()));
            if (ptCandidateIdx !== -1) {
                return ptCandidateIdx;
            }
        }

        // 4. Regra específica para releases Dual Audio brasileiros com streams anônimos (sem tag de idioma):
        const isBrDualRelease = /yg[^a-z]|\byg$|dual.*yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|lipeh|bludv|guanabara|mmfilmes|overdrive|p2p[-_ ]?br/i.test(lowerName);
        const allUndefined = audioStreams.every(s => !s.language || s.language === 'und');

        if (isBrDualRelease && allUndefined && audioStreams.length >= 2) {
            console.log(`🔊 [Dual YG BR] Selecionando trilha ${audioStreams.length - 1} (última) como PT-BR para release: ${rawFileName}`);
            return audioStreams.length - 1;
        }

        // Se o arquivo tiver apenas 1 stream de áudio e for de grupo BR comprovadamente dublado
        if (audioStreams.length === 1) {
            const isBrGroup = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|lipeh|bludv|guanabara|mmfilmes|filmesmega|overdrive/i.test(lowerName);
            const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);
            if (isBrGroup || isExplicitDublado) {
                return 0;
            }
        }

        return null;
    }

    getLanguageKeywordMap() {
        return {
            en: ['eng', 'en', 'english', 'inglês', 'ingles'],
            ko: ['kor', 'ko', 'korean', 'coreano'],
            ja: ['jpn', 'ja', 'japanese', 'japonês', 'japones'],
            es: ['spa', 'es', 'spanish', 'espanhol', 'castellano', 'latino'],
            fr: ['fra', 'fre', 'fr', 'french', 'francês', 'frances'],
            de: ['deu', 'ger', 'de', 'german', 'alemão', 'alemao'],
            it: ['ita', 'it', 'italian', 'italiano'],
            zh: ['zho', 'chi', 'zh', 'cmn', 'chinese', 'mandarin', 'chinês', 'chines'],
            tr: ['tur', 'tr', 'turkish', 'turco'],
            ru: ['rus', 'ru', 'russian', 'russo'],
            hi: ['hin', 'hi', 'hindi'],
            th: ['tha', 'th', 'thai', 'tailandês', 'tailandes'],
            ar: ['ara', 'ar', 'arabic', 'árabe', 'arabe'],
            pt: ['por', 'pob', 'pt', 'pt-br', 'pt_br', 'brazilian', 'portuguese', 'português', 'portugues']
        };
    }

    normalizeLanguageCode(raw) {
        if (!raw) return null;
        const v = String(raw).toLowerCase().trim();
        if (!v || v === 'und' || v === 'unknown') return null;
        const langMap = this.getLanguageKeywordMap();
        for (const [code, keywords] of Object.entries(langMap)) {
            if (code === v || keywords.includes(v)) return code;
        }
        // ISO-639-1/2 leftovers (e.g. "kor", "jpn")
        if (v.length === 2 || v.length === 3) {
            for (const [code, keywords] of Object.entries(langMap)) {
                if (keywords.includes(v)) return code;
            }
        }
        return v.slice(0, 2);
    }

    streamMatchesLanguage(stream, langCode) {
        if (!stream || !langCode) return false;
        const langMap = this.getLanguageKeywordMap();
        const keywords = langMap[langCode] || [langCode];
        const sLang = (stream.language || '').toLowerCase().trim();
        const sTitle = (stream.title || '').toLowerCase().trim();

        // 1. Tag de idioma do stream (ffprobe tags.language): prioridade máxima
        const normalizedLang = this.normalizeLanguageCode(sLang);
        if (normalizedLang && normalizedLang === langCode) return true;
        if (keywords.some(k => sLang === k || sLang.startsWith(k + '-') || sLang.startsWith(k + '_'))) return true;

        // 2. Título da faixa: exige word boundary para códigos curtos (ex: 'en', 'pt', 'es')
        // Evita falsos positivos bizarros como "GalaxyTV - small excellence!" casando com 'en' por causa de "excellence"!
        if (sTitle) {
            for (const k of keywords) {
                if (k.length <= 3) {
                    const wordRegex = new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`, 'i');
                    if (wordRegex.test(sTitle)) return true;
                } else {
                    if (sTitle.includes(k)) return true;
                }
            }
        }
        return false;
    }

    isCommentaryOrDescriptiveTrack(stream) {
        const t = (stream?.title || '').toLowerCase();
        return t.includes('commentary') || t.includes('comentário') || t.includes('comentario') ||
            t.includes('description') || t.includes('descrição') || t.includes('descricao') ||
            t.includes('audio description') || t.includes('audiodescri');
    }

    /**
     * Resolve o idioma ORIGINAL da obra sem assumir inglês.
     * Prioridade: metadados TMDB → flags anime/dorama → inferência das trilhas → null.
     */
    resolveOriginalLanguage(metadata = {}, audioStreams = []) {
        const explicit = this.normalizeLanguageCode(metadata.idiomaOriginal || metadata.originalLanguage || metadata.original_language);
        if (explicit && explicit !== 'pt') return explicit;

        if (metadata.isAnime || metadata.is_anime) return 'ja';
        if (metadata.isDorama || metadata.is_dorama) return 'ko';

        const category = String(metadata.category || metadata.categoria || '').toLowerCase();
        if (category.includes('anime')) return 'ja';
        if (category.includes('dorama')) return 'ko';

        // Inferência a partir das trilhas reais (dual/multi-áudio):
        // nunca preferir inglês automaticamente quando existe ja/ko/zh/etc.
        const detected = new Set();
        for (const s of (audioStreams || [])) {
            if (this.isCommentaryOrDescriptiveTrack(s)) continue;
            const code = this.normalizeLanguageCode(s.language);
            if (code && code !== 'pt' && code !== 'und') detected.add(code);
            // títulos como "Japanese", "Korean", "Original"
            for (const [langCode, keywords] of Object.entries(this.getLanguageKeywordMap())) {
                if (langCode === 'pt') continue;
                if (keywords.some(k => (s.title || '').includes(k))) detected.add(langCode);
            }
        }

        const preferenceOrder = ['ja', 'ko', 'zh', 'th', 'hi', 'tr', 'ar', 'ru', 'fr', 'de', 'it', 'es', 'en'];
        for (const pref of preferenceOrder) {
            if (detected.has(pref)) return pref;
        }

        return null;
    }

    detectTargetAudioIndex(audioStreams, metadata = {}, rawFileName = '') {
        if (!audioStreams || audioStreams.length === 0) return 0;
        if (audioStreams.length === 1) return 0;

        const isLegendadoOnly = metadata.isLegendado && !metadata.isDublado;
        const targetLang = this.resolveOriginalLanguage(metadata, audioStreams);
        const langMap = this.getLanguageKeywordMap();

        // 1. Dublado: prioriza áudio PT-BR
        if (!isLegendadoOnly) {
            const ptIdx = this.detectPortugueseAudioIndex(audioStreams, rawFileName);
            if (ptIdx !== null) return ptIdx;
        }

        // 2. Legendado / fallback: seleciona o áudio ORIGINAL (nunca assume inglês por padrão)
        if (targetLang && langMap[targetLang]) {
            for (let i = 0; i < audioStreams.length; i++) {
                if (this.isCommentaryOrDescriptiveTrack(audioStreams[i])) continue;
                if (this.streamMatchesLanguage(audioStreams[i], targetLang)) {
                    console.log(`🎙️ [Áudio Original: ${targetLang.toUpperCase()}] Selecionada trilha ${i} (${audioStreams[i].language || audioStreams[i].title || 'tagged'}) para "${metadata.nome || rawFileName}"`);
                    return i;
                }
            }
        }

        // 3. Disposition / título "original" / VO
        for (let i = 0; i < audioStreams.length; i++) {
            const s = audioStreams[i];
            if (this.isCommentaryOrDescriptiveTrack(s)) continue;
            const sTitle = (s.title || '').toLowerCase();
            if (s.disposition?.original === 1 || sTitle.includes('original') || sTitle.includes(' v.o') || sTitle.includes('vo ') || sTitle === 'vo') {
                // Em dual-áudio, "original" nunca deve ser a trilha PT
                if (!this.streamMatchesLanguage(s, 'pt')) {
                    console.log(`🎙️ [Áudio Original] Selecionada trilha ${i} com disposition original/VO para "${metadata.nome || rawFileName}"`);
                    return i;
                }
            }
        }

        // 4. Dual/multi: nunca trate 'und' como "não-inglês" (isso escolhia trilha 0 em und+und = inglês com label coreano/japonês)
        if (targetLang && targetLang !== 'en') {
            const engTracks = [];
            const taggedForeign = [];
            const undTracks = [];
            for (let i = 0; i < audioStreams.length; i++) {
                const s = audioStreams[i];
                if (this.isCommentaryOrDescriptiveTrack(s) || this.streamMatchesLanguage(s, 'pt')) continue;
                if (this.streamMatchesLanguage(s, 'en')) {
                    engTracks.push(i);
                    continue;
                }
                const norm = this.normalizeLanguageCode(s.language);
                if (norm && norm !== 'und') taggedForeign.push(i);
                else undTracks.push(i);
            }

            // eng + und (clássico dual sem tag do original) → und é o original
            if (engTracks.length >= 1 && undTracks.length >= 1 && taggedForeign.length === 0) {
                console.log(`🎙️ [Áudio Original inferido: ${targetLang.toUpperCase()}] Dual eng+und → trilha und ${undTracks[0]} para "${metadata.nome || rawFileName}"`);
                return undTracks[0];
            }
            // Trilha estrangeira explicitamente tagueada (kor/jpn/...)
            if (taggedForeign.length >= 1) {
                console.log(`🎙️ [Áudio Original inferido: ${targetLang.toUpperCase()}] Selecionada trilha tagueada ${taggedForeign[0]} para "${metadata.nome || rawFileName}"`);
                return taggedForeign[0];
            }
            // und+und em dual/multi: em releases Dual de anime/dorama a 1ª trilha costuma ser a original;
            // se o filename marcar Dual e houver exatamente 2 áudios, prefere a NÃO-default quando disposition existir.
            if (undTracks.length >= 2) {
                const lowerName = (rawFileName || '').toLowerCase();
                const looksDual = /\bdual\b|dual[-_. ]?audio|multi[-_. ]?audio/i.test(lowerName);
                let pick = undTracks[0];
                const withOriginalDisp = undTracks.find(i => audioStreams[i]?.disposition?.original === 1);
                if (withOriginalDisp !== undefined) pick = withOriginalDisp;
                else {
                    const defaultIdx = undTracks.find(i => audioStreams[i]?.disposition?.default === 1);
                    // Em muitos WEBRip Dual ocidentais a default é inglês; se houver default, tenta a outra
                    if (looksDual && defaultIdx !== undefined && undTracks.length === 2) {
                        pick = undTracks.find(i => i !== defaultIdx) ?? pick;
                    } else if (looksDual && (metadata.isAnime || metadata.isDorama || targetLang === 'ja' || targetLang === 'ko' || targetLang === 'zh')) {
                        // Convenção comum em Dual asiático: original na trilha 0
                        pick = undTracks[0];
                    }
                }
                console.log(`🎙️ [Áudio Original inferido: ${targetLang.toUpperCase()}] Dual und+und → trilha ${pick} para "${metadata.nome || rawFileName}"`);
                return pick;
            }
        }

        // 5. Somente escolhe inglês se o idioma original for inglês (ou se for a única trilha estrangeira útil)
        if (targetLang === 'en') {
            const engIdx = audioStreams.findIndex(s => !this.isCommentaryOrDescriptiveTrack(s) && this.streamMatchesLanguage(s, 'en'));
            if (engIdx !== -1) {
                console.log(`🎙️ [Áudio Original: ENG] Selecionada trilha ${engIdx} em inglês para "${metadata.nome || rawFileName}"`);
                return engIdx;
            }
        }

        // 6. Evita comentários / audiodescrição
        const nonCommentaryIdx = audioStreams.findIndex(s => !this.isCommentaryOrDescriptiveTrack(s));
        if (nonCommentaryIdx !== -1) {
            const picked = audioStreams[nonCommentaryIdx];
            const pickedLang = this.normalizeLanguageCode(picked.language) || picked.language || 'und';
            if (targetLang && targetLang !== 'en' && this.streamMatchesLanguage(picked, 'en')) {
                console.warn(`⚠️ [Áudio] Fallback evitou inglês para obra originalmente em ${targetLang}; usando primeira trilha não-comentário com cautela (lang=${pickedLang}).`);
            } else {
                console.log(`🎙️ [Áudio Fallback] Selecionada trilha ${nonCommentaryIdx} (${pickedLang}) para "${metadata.nome || rawFileName}"`);
            }
            return nonCommentaryIdx;
        }

        return 0;
    }

    describeLanguageLabel(langCode) {
        const labels = {
            en: 'Inglês', ko: 'Coreano', ja: 'Japonês', es: 'Espanhol', fr: 'Francês',
            de: 'Alemão', it: 'Italiano', zh: 'Chinês', tr: 'Turco', ru: 'Russo',
            hi: 'Hindi', th: 'Tailandês', ar: 'Árabe', pt: 'Português (PT-BR)'
        };
        return labels[langCode] || (langCode ? langCode.toUpperCase() : 'Original');
    }

    /**
     * Valida se a trilha selecionada é coerente com dublado/legendado + idioma original.
     * Retorna { ok, reason, selectedLang }.
     */
    validateSelectedAudioTrack(selectedStream, metadata = {}, audioStreams = []) {
        if (!selectedStream) return { ok: false, reason: 'Nenhuma trilha de áudio selecionada', selectedLang: null };
        const selectedLang = this.normalizeLanguageCode(selectedStream.language) ||
            (this.streamMatchesLanguage(selectedStream, 'pt') ? 'pt' :
                (this.streamMatchesLanguage(selectedStream, 'en') ? 'en' : null));
        const isLegendadoOnly = metadata.isLegendado && !metadata.isDublado;
        const originalLang = this.resolveOriginalLanguage(metadata, audioStreams);

        if (!isLegendadoOnly) {
            // Dublado: deve ser PT-BR quando houver trilha PT disponível
            const hasPt = (audioStreams || []).some(s => this.streamMatchesLanguage(s, 'pt')) ||
                this.detectPortugueseAudioIndex(audioStreams, metadata.rawFileName || '') !== null;
            if (hasPt && selectedLang && selectedLang !== 'pt' && !this.streamMatchesLanguage(selectedStream, 'pt')) {
                return { ok: false, reason: `Dublado exige áudio PT-BR, mas foi selecionado ${selectedLang}`, selectedLang };
            }
            return { ok: true, reason: null, selectedLang: selectedLang || 'pt' };
        }

        // Legendado: não pode ser PT-BR; se soubermos o original, não pode ser inglês quando há alternativa
        if (this.streamMatchesLanguage(selectedStream, 'pt')) {
            return { ok: false, reason: 'Legendado não deve usar áudio PT-BR', selectedLang: 'pt' };
        }
        if (originalLang && originalLang !== 'en' && this.streamMatchesLanguage(selectedStream, 'en')) {
            const hasOriginalTrack = (audioStreams || []).some(s => this.streamMatchesLanguage(s, originalLang));
            const hasUndAlt = (audioStreams || []).some(s =>
                !this.isCommentaryOrDescriptiveTrack(s) &&
                !this.streamMatchesLanguage(s, 'pt') &&
                !this.streamMatchesLanguage(s, 'en') &&
                (!this.normalizeLanguageCode(s.language) || s.language === 'und')
            );
            if (hasOriginalTrack || hasUndAlt) {
                return { ok: false, reason: `Legendado deveria usar ${originalLang}, mas inglês foi selecionado`, selectedLang: 'en' };
            }
        }
        return { ok: true, reason: null, selectedLang: selectedLang || null };
    }

    /**
     * Duração mínima aceitável genérica (anti-trailer / anti-arquivo incompleto).
     * Usa razão sobre a duração esperada (TMDB) + pisos absolutos por faixa.
     */
    computeMinAcceptableDurationSec({ type = 'serie', expectedMin = 45, isMicrodrama = false } = {}) {
        if (isMicrodrama) return 40;
        if (type === 'filme') {
            if (expectedMin >= 120) return Math.floor(expectedMin * 60 * 0.65);
            if (expectedMin <= 80) return Math.max(2400, Math.floor(expectedMin * 60 * 0.50));
            return 3600;
        }
        // Séries / animes / doramas
        if (expectedMin <= 12) {
            // Episódios muito curtos (alguns animes especiais / kids)
            return Math.max(180, Math.floor(expectedMin * 60 * 0.55));
        }
        if (expectedMin <= 30) {
            // Anime / episódios ~20-25 min: exige >= 55% (ex.: 24min → ~13min) e piso de 10 min
            return Math.max(600, Math.floor(expectedMin * 60 * 0.55));
        }
        // Drama / episódios longos (ex.: House of the Dragon ~60min): exige >= 55% sem teto artificial de 10 min
        // Ex.: 60min → 33min mínimo (rejeita arquivo de 13 min)
        return Math.max(1200, Math.floor(expectedMin * 60 * 0.55));
    }

    /**
     * Converte SRT → ASS com PlayRes igual à resolução de saída, evitando FontSize
     * gigante do libass (default PlayResY=288 + force_style).
     */
    async buildHardsubAssFromSrt(srtPath, outputWidth, outputHeight) {
        const outW = Math.max(640, Math.min(1920, parseInt(outputWidth, 10) || 1920));
        const outH = Math.max(360, parseInt(outputHeight, 10) || 1080);
        // Altura de referência baseada no viewport 16:9 padrão para manter escala proporcional
        // consistente em qualquer formato (ex: cinemascope 2.39:1 1920x800, 2:1 1920x960, 4:3 1440x1080)
        const refH = Math.max(outH, Math.round(outW * (9 / 16)));
        // ~5% da altura de referência (~54px em 1080p, ~36px em 720p)
        // Legível e confortável sem ficar nem minúsculo em filmes ultrawide nem gigante em animes
        const fontSize = Math.max(35, Math.min(56, Math.round(refH * 0.050)));
        const outline = Math.max(2.4, Number((fontSize / 16).toFixed(1)));
        // Margem vertical generosa (~8% da altura real) para não colar no fundo da tela no Telegram
        // (o Telegram adiciona sua própria barra inferior que reduziria ainda mais o espaço disponível)
        const marginV = Math.max(70, Math.round(outH * 0.080));
        // Gera o arquivo .ass temporário diretamente em os.tmpdir com nome 100% sanitizado e alfanumérico
        // evitando problemas com apóstrofos (ex: JoJo's), colchetes [MICO XD], parênteses ou espaços no parser do FFmpeg
        const safeAssName = `hardsub_${Date.now()}_${Math.random().toString(36).substring(2, 9)}_${outW}x${outH}.ass`;
        const assPath = path.join(os.tmpdir(), safeAssName);

        const srtContent = await fs.readFile(srtPath, 'utf8');
        const events = [];
        const blocks = srtContent.replace(/\r\n/g, '\n').split(/\n\s*\n/);
        for (const block of blocks) {
            const lines = block.trim().split('\n');
            if (lines.length < 2) continue;
            const timeLineIdx = lines.findIndex(l => l.includes('-->'));
            if (timeLineIdx === -1) continue;
            const timeLine = lines[timeLineIdx];
            const m = timeLine.match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
            if (!m) continue;
            const toAssTime = (h, mi, s, ms) => {
                const cs = Math.floor(parseInt(ms, 10) / 10);
                return `${parseInt(h, 10)}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
            };
            const start = toAssTime(m[1], m[2], m[3], m[4]);
            const end = toAssTime(m[5], m[6], m[7], m[8]);
            let text = lines.slice(timeLineIdx + 1).join('\\N')
                .replace(/\{\\.*?\}/g, '') // remove overrides ASS residuais (\fs enormes etc.)
                .replace(/<[^>]+>/g, '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!text) continue;
            events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
        }

        const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${outW}
PlayResY: ${outH}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,${outline},1.2,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
        if (!events.length) throw new Error('Legenda sem falas renderizáveis.');
        await fs.writeFile(assPath, ass, 'utf8');
        return assPath;
    }

    hasPortugueseAudio(info, rawFileName = '') {
        const lowerName = (rawFileName || '').toLowerCase();

        if (!info.audioStreams || info.audioStreams.length === 0) {
            return false;
        }

        const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
        const hasPtStream = info.audioStreams.some(a => {
            const lang = (a.language || '').toLowerCase();
            const title = (a.title || '').toLowerCase();
            return ptLanguages.includes(lang) || title.includes('portug') || title.includes('dublado') || title.includes('pt-br');
        });

        // 1. Se tem faixa comprovada em Português nas tags do áudio
        if (hasPtStream) return true;

        // 2. Se o arquivo contém apenas 1 stream de áudio e ele possui tag de idioma estrangeiro (ex: eng, rus, spa, etc.), NUNCA é dublado
        const foreignLangs = ['eng', 'en', 'rus', 'ru', 'spa', 'es', 'fra', 'fre', 'deu', 'ger', 'ita', 'jpn', 'kor', 'zho', 'chi', 'hin', 'tur'];
        if (info.audioStreams.length === 1) {
            const singleLang = (info.audioStreams[0].language || '').toLowerCase();
            if (foreignLangs.includes(singleLang)) {
                return false;
            }
        }

        // 3. Se TODAS as faixas têm tag de idioma conhecida e NENHUMA é Português (ex: [spa, eng])
        const allTaggedAndForeign = info.audioStreams.length > 0 &&
            info.audioStreams.every(a => {
                const lang = (a.language || '').toLowerCase();
                return lang !== 'und' && lang !== '' && !ptLanguages.includes(lang);
            });

        if (allTaggedAndForeign) {
            return false;
        }

        // 4. Se for release russa / scam / bookmaker, NUNCA é português
        const isRussianOrScam = /\b(1xbet|mostbet|pari|melbet|betboom|fonbet|pin-up|joycasino|\.d\.|\.d1\.|\.d2\.|\[d\]|\(d\)|rus|russian)\b/i.test(lowerName);
        if (isRussianOrScam) {
            return false;
        }

        // 5. Se for release em Espanhol/Latino sem selo BR explícito, NUNCA é português
        const isSpanishRelease = /\b(cinecalidad|elitetorrent|estrenos|dontorrent|pctmix|divxatope|latino|castellano|espanol|español|dual[-_ .]?lat|audio[-_ .]?lat|dual[-_ .]?cast|audio[-_ .]?cast|kontrast)\b/i.test(lowerName);

        // 6. Se as faixas de áudio não possuem metadados de idioma (streams anônimos 'und'), verifica o selo brasileiro genuíno no nome do arquivo
        const isBrGroup = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(lowerName);
        const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);

        if (isSpanishRelease && !isExplicitDublado && !isBrGroup) {
            return false;
        }

        if (isExplicitDublado || isBrGroup) {
            return true;
        }

        return false;
    }

    hasPortugueseSubtitles(info, rawFileName = '') {
        const lowerName = (rawFileName || '').toLowerCase();

        // Se o nome do arquivo traz tag explícita de Portugal, rejeita imediatamente
        const isExplicitPtPtName = /\b(pt[-_ ]?pt|por[-_ ]?pt|portugal|european|europeu)\b/i.test(lowerName);
        if (isExplicitPtPtName) return false;

        // 1. Verifica se há trilhas de legenda em Português embutidas no arquivo (excluindo explicitamente faixas PT-PT)
        if (info.subtitleStreams && info.subtitleStreams.length > 0) {
            const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
            const hasPtSubStream = info.subtitleStreams.some(s => {
                const lang = (s.language || '').toLowerCase();
                const title = (s.title || '').toLowerCase();
                const isExplicitPtPt = lang === 'pt-pt' || lang.includes('pt-pt') || lang.includes('por-pt') ||
                    title.includes('pt-pt') || title.includes('portugal') || title.includes('european') || title.includes('europeu');
                if (isExplicitPtPt) return false;
                return ptLanguages.includes(lang) || title.includes('portug') || title.includes('legenda') || title.includes('pt-br');
            });
            if (hasPtSubStream) return true;
        }

        // 2. Verifica se o nome do arquivo traz tags explícitas de legenda em Português (hardcoded ou softsub)
        const isExplicitLegendado = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br|pt[-_ ]?subs?|subs?\.por|hc[-_ ]?sub)\b/i.test(lowerName);
        if (isExplicitLegendado) {
            return true;
        }

        return false;
    }

    isRussianOrScamAudio(info, rawFileName = '', metadata = {}) {
        const lowerName = (rawFileName || '').toLowerCase();
        const origLang = (metadata.idiomaOriginal || metadata.originalLanguage || '').toLowerCase();

        // Se a obra for legitimamente russa, o áudio russo é válido
        if (origLang === 'ru' || origLang === 'rus') return false;

        // 1. Tags russas ou de casas de aposta (scams) / dublagens fakes por IA no nome do arquivo
        const isRussianName = /\b(rus|russian|dvo|mvo|avo|itunes[-_ ]?rus|itunes[-_ ]?r|hdrezka|lostfilm|redheadsound|rhs|baibako|newstudio|coldfilm|kinogo|lordfilm|rutracker|rutor)\b|\.(d|d1|d2|mvo|dvo|avo)\.|\b\d{4}\.d\b/i.test(lowerName);
        const isScamName = /\b(1xbet|1x_bet|1x-bet|mostbet|pari|melbet|betboom|fonbet|linebet|pin-up|joycasino|vulkan|vavada|catcasino|winline|betandyou|apostas|betano|blaze|novibet|bet365|stake|esportesdasorte|vaidebet|vai[-_ ]?de[-_ ]?bet|betfair|parimatch|kto|betnacional|superbet|cassino|casino|slot|slots|ai[-_ .]?dub|aidub|ia[-_ .]?dub|dub[-_ .]?ia|dublado[-_ .]?ia|dublado[-_ .]?por[-_ .]?ia|voz[-_ .]?ia|ia[-_ .]?voz|elevenlabs|voice[-_ .]?over|voiceover|dcprip|line\.audio|line[-_ ]audio|clean\.audio|clean[-_ ]audio)\b/i.test(lowerName);

        if (isRussianName || isScamName) {
            return true;
        }

        // 2. Análise de tags globais do container (ads de apostas e IA embutidos em metadata)
        if (info && info.tags) {
            const tagsStr = JSON.stringify(info.tags).toLowerCase();
            if (/\b(1xbet|mostbet|melbet|betboom|betano|blaze|bet365|stake|esportesdasorte|vaidebet|cassino|casino|ai[-_ .]?dub|aidub|ia[-_ .]?dub|dublado[-_ .]?ia|elevenlabs)\b/i.test(tagsStr)) {
                return true;
            }
        }

        // 3. Streams de áudio no ffprobe: detecta trilhas russas ou ads/IA no título da faixa
        if (info && info.audioStreams && info.audioStreams.length > 0) {
            const hasScamOrAiAudioTitle = info.audioStreams.some(a => {
                const title = (a.title || '').toLowerCase();
                return /\b(1xbet|mostbet|melbet|betano|blaze|bet365|stake|esportesdasorte|vaidebet|cassino|casino|ai[-_ .]?dub|aidub|ia[-_ .]?dub|dublado[-_ .]?ia|elevenlabs)\b/i.test(title);
            });
            if (hasScamOrAiAudioTitle) {
                return true;
            }

            const hasRussianStream = info.audioStreams.some(a => {
                const lang = (a.language || '').toLowerCase();
                const title = (a.title || '').toLowerCase();
                return lang === 'rus' || lang === 'ru' || title.includes('rus') || title.includes('dvo') ||
                    title.includes('mvo') || title.includes('dub (rus)') || title.includes('red head') || title.includes('hdrezka');
            });
            const hasPtStream = this.hasPortugueseAudio(info, rawFileName);
            // Se tem áudio russo e NÃO tem áudio em português, é um release russo rejeitado
            if (hasRussianStream && !hasPtStream) {
                return true;
            }
        }

        return false;
    }

    detectCamArtifacts(info, rawFileName = '', metadata = {}) {
        const lowerName = (rawFileName || '').toLowerCase();

        // 1. Regex ultra robusto de CAM no nome do arquivo
        const CAM_REGEX = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|gravado\s*no\s*cinema|audio\s*cinema|som\s*cinema|audio\s*de\s*cinema|som\s*de\s*cinema|line\s*audio|mic\s*audio|hq-cam|new-cam|cam-1080p|cam-720p|tc|telecine|workprint|wp|clean\s*audio|c0p|evo-cam|evo\.cam|ddhdcam|bdvd|evo-hd)\b/i;
        if (CAM_REGEX.test(lowerName)) return true;

        // 2. Análise das trilhas do container
        if (info && info.audioStreams && info.audioStreams.length > 0) {
            // Áudio mono de microfone em filme moderno
            const isMono = info.audioStreams.length === 1 && info.audioStreams[0].channels === 1;
            const ano = parseInt(metadata.ano || '2026', 10);
            if (isMono && ano > 1980) {
                const isBrOfficial = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|bludv|guanabara/i.test(lowerName);
                if (!isBrOfficial) return true;
            }

            // Sample rate muito baixo no áudio (gravação de microfone)
            const lowSampleRate = info.audioStreams.some(a => a.sampleRate && parseInt(a.sampleRate, 10) <= 24000);
            if (lowSampleRate) return true;

            // Título da trilha de áudio indicando CAM/Line
            const hasCamAudioTitle = info.audioStreams.some(a => {
                const t = (a.title || '').toLowerCase();
                return /\b(line|mic|cinema|telesync|cam|gravado)\b/i.test(t);
            });
            if (hasCamAudioTitle) return true;
        }

        return false;
    }

    validatePortugueseContent(info, rawFileName = '', source = {}, metadata = {}) {
        const lowerName = (rawFileName || '').toLowerCase();
        const sourceTitle = (source.title || source.nome || metadata.nome || '').toLowerCase();

        // 0. Bloqueio imediato de áudio Russo / Scam em obras ocidentais/brasileiras
        if (this.isRussianOrScamAudio(info, rawFileName, metadata)) {
            return {
                isValid: false,
                isDublado: false,
                isLegendado: false,
                isRussianScam: true,
                hasBoth: false,
                audioText: 'Rejeitado (Áudio Russo / Scam / Bet / IA)'
            };
        }

        // 0.5. Fast-path para streams diretos de CDN de anime (AnimesDigital / TopAnimes):
        // Esses streams m3u8 raramente possuem tags de idioma corretas no ffprobe.
        // O próprio scraper já determinou o áudio corretamente via URL/título do item.
        // Portanto, confiamos 100% na classificação da fonte e ignoramos o ffprobe.
        if (source.isDirect === true) {
            if (source.isDublado === true && source.isLegendado === true) {
                return { isValid: true, isDublado: true, isLegendado: true, hasBoth: true, audioText: 'Dual Áudio + Legendas (Dublado e Legendado PT-BR)' };
            }
            if (source.isDublado === true) {
                return { isValid: true, isDublado: true, isLegendado: false, hasBoth: false, audioText: 'Dublado (Áudio PT-BR)' };
            }
            if (source.isLegendado === true) {
                return { isValid: true, isDublado: false, isLegendado: true, hasBoth: false, audioText: 'Legendado (PT-BR)' };
            }
            // fonte direta mas sem classificação explícita — continua análise normal
        }

        // 1. Áudio Dublado REAL verificado via ffprobe, tags do arquivo ou confirmação da fonte (Web Direct / Scraper / Torrent BR)
        const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
        const allTaggedAndForeign = info.audioStreams && info.audioStreams.length > 0 &&
            info.audioStreams.every(a => {
                const lang = (a.language || '').toLowerCase();
                return lang !== 'und' && lang !== '' && !ptLanguages.includes(lang);
            });

        const isBrGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|lipeh|filmesmega|guanabara|ondebaixo|acervo|mmfilmes|p2p[-_ ]?br|dtt|brazuca|dublamais|nerdtorrents|teladecinema|baixarfilmes/i.test(sourceTitle) || /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|lipeh|filmesmega|guanabara|ondebaixo|acervo|mmfilmes|p2p[-_ ]?br|dtt|brazuca|dublamais|nerdtorrents|teladecinema|baixarfilmes/i.test(lowerName);

        const isSourceDublado = (source.isDublado === true || source.audio?.toLowerCase().includes('dublado') || /\b(dublado|dub|nacional|pt[-_]?br)\b/i.test(sourceTitle)) && !allTaggedAndForeign;
        const hasDirectPtAudio = this.hasPortugueseAudio(info, rawFileName);
        const hasAudioStreams = info.audioStreams && info.audioStreams.length > 0;
        // Dublado só é aceito se o arquivo contiver áudio PT verificado no ffprobe OU vier de grupo brasileiro idôneo.
        // Releases de fontes desconhecidas com áudio "und" NÃO são aceitas como dubladas sem verificação.
        const isDublado = !allTaggedAndForeign && (hasDirectPtAudio || (isSourceDublado && hasAudioStreams && isBrGroup && !this.isRussianOrScamAudio(info, rawFileName, metadata)));

        // 2. Legendas em Português verificadas via ffprobe ou fonte comprovada (ou original para OpenSubtitles)
        const hasPtSubsInFile = this.hasPortugueseSubtitles(info, rawFileName);
        const isSourceLegendado = source.isLegendado === true || source.hasPtSub === true || source.hasEmbeddedSub === true;
        const isLegendado = hasPtSubsInFile || isSourceLegendado || source.isOriginal === true || /\b(legendado|legendas|legenda)\b/i.test(lowerName) || /\b(legendado|legendas|legenda)\b/i.test(sourceTitle);

        // 3. Caso contenha AMBOS (Áudio Dublado + Legenda PT-BR no mesmo arquivo)
        if (isDublado && isLegendado) {
            return {
                isValid: true,
                isDublado: true,
                isLegendado: true,
                hasBoth: true,
                audioText: 'Dual Áudio + Legendas (Dublado e Legendado PT-BR)'
            };
        }

        if (isDublado) {
            return {
                isValid: true,
                isDublado: true,
                isLegendado: false,
                hasBoth: false,
                audioText: 'Dublado (Áudio PT-BR)'
            };
        }

        if (isLegendado) {
            return {
                isValid: true,
                isDublado: false,
                isLegendado: true,
                hasBoth: false,
                audioText: 'Legendado (PT-BR)'
            };
        }

        return {
            isValid: false,
            isDublado: false,
            isLegendado: false,
            hasBoth: false,
            audioText: 'Desconhecido (Sem Português)'
        };
    }

    async generateThumbnail(videoPath, outputThumbPath, timestamp = '00:01:30') {
        await fs.ensureDir(path.dirname(outputThumbPath));
        return new Promise((resolve, reject) => {
            const args = [
                '-nostdin',
                '-ss', timestamp,
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2',
                '-vf', "scale='min(640,iw)':-2",
                '-y',
                outputThumbPath
            ];

            const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputThumbPath)) {
                    resolve(outputThumbPath);
                } else {
                    // Tenta no segundo 5 se falhar no 1:30 (ex: vídeo curto)
                    const fallbackArgs = ['-nostdin', '-ss', '00:00:05', '-i', videoPath, '-vframes', '1', '-q:v', '2', '-y', outputThumbPath];
                    const fallback = spawn('ffmpeg', fallbackArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                    fallback.on('close', (fCode) => {
                        if (fCode === 0 && fs.existsSync(outputThumbPath)) {
                            resolve(outputThumbPath);
                        } else {
                            reject(new Error(`Falha ao gerar thumbnail: código ${fCode}`));
                        }
                    });
                }
            });
            ffmpeg.on('error', reject);
        });
    }

    normalizeSubtitleText(rawContent) {
        if (!rawContent || typeof rawContent !== 'string') return '';
        return rawContent
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    isBrazilianPortugueseSubtitle(content, sourceLang = '', sourceFile = '') {
        return SubtitlePipeline.isBrazilianPortugueseSubtitle(content, sourceLang, sourceFile);
    }

    async fetchPortugueseSrt(url) {
        const { data } = await axios.get(url, {
            timeout: 6000,
            maxContentLength: 2 * 1024 * 1024,
            responseType: 'text'
        });
        const timestamps = typeof data === 'string' && data.match(/^\s*\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/gm);
        return timestamps?.length >= 3 && await this.isBrazilianPortugueseSubtitle(data) ? data : null;
    }

    async findCompanionSubtitle(inputPath, metadata = {}) {
        try {
            const videoDir = path.dirname(inputPath);
            const season = metadata.season || 1;
            const episode = metadata.episode || 1;

            const sPadded = String(season).padStart(2, '0');
            const ePadded = String(episode).padStart(2, '0');
            const epRegex = new RegExp(`(s0*${season}e0*${episode}|e0*${episode}|\\b0*${episode}\\b)`, 'i');

            // Vasculha diretório do vídeo e subpastas Subs / Subtitles
            // NÃO inclui pasta pai para evitar contaminação entre episódios diferentes
            const candidateDirs = [
                videoDir,
                path.join(videoDir, 'Subs'),
                path.join(videoDir, 'Subtitles'),
                path.join(videoDir, 'subs'),
            ];

            const ptNames = ['portuguese', 'português', 'pob', 'pt-br', 'pt_br', 'brazilian', '31_portuguese', '32_portuguese', 'por', 'pt'];
            const allFiles = [];

            for (const dir of candidateDirs) {
                if (fs.existsSync(dir)) {
                    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
                    for (const entry of entries) {
                        // Ignora arquivos temporários gerados por execuções prévias
                        if (entry.name.startsWith('sub_pt_') || entry.name.startsWith('ref_en_') || entry.name.startsWith('thumb_') || entry.name.startsWith('opt_')) {
                            continue;
                        }

                        if (entry.isFile() && entry.name.toLowerCase().endsWith('.srt')) {
                            allFiles.push({ path: path.join(dir, entry.name), name: entry.name.toLowerCase(), dirName: path.basename(dir).toLowerCase() });
                        } else if (entry.isDirectory()) {
                            // Subpasta de episódio específico (ex: Subs/Ted.Lasso.S02E06.../)
                            if (epRegex.test(entry.name) || entry.name.toLowerCase().includes(`e${ePadded}`) || entry.name.toLowerCase().includes(`s${sPadded}`)) {
                                const subDirPath = path.join(dir, entry.name);
                                const subEntries = await fs.readdir(subDirPath).catch(() => []);
                                for (const subFile of subEntries) {
                                    if (subFile.startsWith('sub_pt_') || subFile.startsWith('ref_en_')) continue;
                                    if (subFile.toLowerCase().endsWith('.srt')) {
                                        allFiles.push({ path: path.join(subDirPath, subFile), name: subFile.toLowerCase(), dirName: entry.name.toLowerCase() });
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // 1. Procura legenda em Português específica do episódio (Priorizando PT-BR e rejeitando PT-PT)
            for (const item of allFiles) {
                const lowerPath = (item.path || '').toLowerCase();
                const isPtPtTag = lowerPath.includes('pt-pt') || lowerPath.includes('portugal') || lowerPath.includes('european') || lowerPath.includes('por-pt');
                if (isPtPtTag) continue;

                const isPt = ptNames.some(p => item.name.includes(p) || item.dirName.includes(p));
                const matchesEp = epRegex.test(item.name) || epRegex.test(item.dirName);
                if (isPt && matchesEp) {
                    const content = await fs.readFile(item.path, 'utf8').catch(() => '');
                    if (await this.isBrazilianPortugueseSubtitle(content)) {
                        console.log(`📦 [Companion Subs] Legenda original PT-BR encontrada no pacote do torrent: ${path.basename(item.path)} (${(content.length / 1024).toFixed(1)} KB)!`);
                        return { ptSrtPath: item.path, refEnPath: null };
                    } else {
                        console.warn(`⚠️ [Companion Subs] Legenda local "${path.basename(item.path)}" rejeitada por conter Português de Portugal ou texto não autêntico PT-BR.`);
                    }
                }
            }

            // 2. Procura se existe legenda em Inglês/Original para servir de referência perfeita (Sub-to-Sub)
            let refEnPath = null;
            for (const item of allFiles) {
                const isEn = item.name.includes('english') || item.name.includes('2_english') || item.name.includes('eng') || item.name.includes('en.srt');
                const matchesEp = epRegex.test(item.name) || epRegex.test(item.dirName);
                if (isEn && matchesEp) {
                    refEnPath = item.path;
                    break;
                }
            }

            return { ptSrtPath: null, refEnPath };
        } catch (e) {
            console.warn('⚠️ [Companion Subs] Erro ao buscar legendas locais no pacote:', e.message);
            return { ptSrtPath: null, refEnPath: null };
        }
    }

    async optimizeForTelegram(inputPath, outputPath, onProgress = null, metadata = {}) {
        await fs.ensureDir(path.dirname(outputPath));
        const info = await this.getVideoInfo(inputPath);

        const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
            ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
            : (metadata.nome || metadata.title || path.basename(inputPath));

        const isUnderSizeLimit = info.sizeBytes <= this.maxSizeBytes;
        const isStandard8Bit = info.pixFmt === 'yuv420p';
        const isFastCodec = info.videoCodec === 'h264' && isStandard8Bit;
        const isResolutionFine = (info.width || 1920) <= 1920; // 1080p ou menor

        // Detectar com precisão a faixa de áudio em Português e a faixa de áudio Alvo (Dublado ou Original)
        const portugueseAudioIndex = this.detectPortugueseAudioIndex(info.audioStreams, path.basename(inputPath));
        const targetAudioIndex = this.detectTargetAudioIndex(info.audioStreams, metadata, path.basename(inputPath));
        const selectedAudioStream = info.audioStreams[targetAudioIndex] || info.audioStreams[0] || null;

        const audioValidation = this.validateSelectedAudioTrack(selectedAudioStream, { ...metadata, rawFileName: path.basename(inputPath) }, info.audioStreams);
        if (!audioValidation.ok) {
            // Tenta auto-corrigir: se legendado pegou inglês por engano, force o índice do idioma original / und
            const originalLang = this.resolveOriginalLanguage(metadata, info.audioStreams);
            let correctedIdx = targetAudioIndex;
            if (metadata.isLegendado && !metadata.isDublado && originalLang) {
                const idx = info.audioStreams.findIndex(s => this.streamMatchesLanguage(s, originalLang));
                if (idx !== -1) correctedIdx = idx;
                else {
                    // eng + und → und
                    const undIdx = info.audioStreams.findIndex(s =>
                        !this.isCommentaryOrDescriptiveTrack(s) &&
                        !this.streamMatchesLanguage(s, 'pt') &&
                        !this.streamMatchesLanguage(s, 'en') &&
                        (!this.normalizeLanguageCode(s.language) || s.language === 'und')
                    );
                    if (undIdx !== -1) correctedIdx = undIdx;
                }
            } else if (!metadata.isLegendado || metadata.isDublado) {
                if (portugueseAudioIndex !== null) correctedIdx = portugueseAudioIndex;
            }
            if (correctedIdx !== targetAudioIndex) {
                console.warn(`⚠️ [Áudio] Correção automática: ${audioValidation.reason}. Trocando trilha ${targetAudioIndex} → ${correctedIdx}`);
            } else {
                console.warn(`⚠️ [Áudio] Validação falhou sem correção possível: ${audioValidation.reason}`);
            }
            // Reatribui com índice corrigido
            const finalIdx = correctedIdx;
            const finalStream = info.audioStreams[finalIdx] || selectedAudioStream;
            const recheck = this.validateSelectedAudioTrack(finalStream, metadata, info.audioStreams);
            if (!recheck.ok && metadata.isLegendado && !metadata.isDublado && originalLang && originalLang !== 'en') {
                const alt = info.audioStreams.findIndex(s =>
                    !this.isCommentaryOrDescriptiveTrack(s) &&
                    !this.streamMatchesLanguage(s, 'pt') &&
                    !this.streamMatchesLanguage(s, 'en')
                );
                if (alt !== -1) {
                    console.warn(`⚠️ [Áudio] Fallback dual-áudio: usando trilha não-inglesa ${alt} para original ${originalLang}`);
                    metadata._forcedAudioIndex = alt;
                } else if (info.audioStreams.length === 1 && !this.streamMatchesLanguage(finalStream, 'pt')) {
                    // Arquivo com apenas 1 trilha de áudio: se houver legenda PT-BR garantida para hardsub, permite prosseguir
                    console.warn(`⚠️ [Áudio] Release de trilha única estrangeira para "${optTitle}". Prosseguindo pois haverá legenda PT-BR garantida.`);
                    metadata._forcedAudioIndex = 0;
                } else {
                    throw new Error(`Seleção de áudio inválida para "${optTitle}": ${audioValidation.reason}`);
                }
            } else if (!recheck.ok) {
                if (metadata.isLegendado && info.audioStreams.length === 1 && !this.streamMatchesLanguage(finalStream, 'pt')) {
                    console.warn(`⚠️ [Áudio] Release de trilha única estrangeira para "${optTitle}". Prosseguindo pois haverá legenda PT-BR garantida.`);
                    metadata._forcedAudioIndex = 0;
                } else {
                    throw new Error(`Seleção de áudio inválida para "${optTitle}": ${audioValidation.reason}`);
                }
            } else {
                metadata._forcedAudioIndex = finalIdx;
            }
        }

        let effectiveAudioIndex = metadata._forcedAudioIndex !== undefined ? metadata._forcedAudioIndex : targetAudioIndex;
        let effectiveAudioStream = info.audioStreams[effectiveAudioIndex] || selectedAudioStream;
        const resolvedOriginalLang = this.resolveOriginalLanguage(metadata, info.audioStreams);
        metadata.idiomaOriginal = metadata.idiomaOriginal || metadata.originalLanguage || resolvedOriginalLang || null;
        metadata.originalLanguage = metadata.idiomaOriginal;
        if (!metadata.srtPath || !fs.existsSync(metadata.srtPath)) {
            metadata.srtPath = null;
        }
        const wantLegendadoOnly = metadata.isLegendado === true && metadata.isDublado === false;
        let isConfirmedDublado = this.streamMatchesLanguage(effectiveAudioStream, 'pt') && !wantLegendadoOnly;

        // 1. Verificação do Idioma Falado Real (Speech Language ID com faster-whisper)
        try {
            const isDub = isConfirmedDublado;
            const targetSpoken = isDub ? 'pt' : (resolvedOriginalLang || metadata.idiomaOriginal || 'und');

            if (isDub) {
                // Filmes/Séries Dublados: DEVEM falar Português
                console.log(`🎙️ [Validação de Áudio] Verificando se áudio selecionado (trilha ${effectiveAudioIndex}) fala Português...`);
                let speechCheck = await SpeechLanguageService.verifySpokenLanguage(inputPath, effectiveAudioIndex, info.duration, 'pt');

                if (speechCheck.verified && !speechCheck.isMatch && speechCheck.probability >= 0.70) {
                    console.warn(`⚠️ [Alerta de Dublagem Falsa] Trilha ${effectiveAudioIndex} identificada como "${speechCheck.detectedLanguage.toUpperCase()}" (${(speechCheck.probability * 100).toFixed(0)}%). Testando outras trilhas disponíveis...`);

                    // Se for multi-áudio, testa se alguma outra trilha fala Português
                    let foundValidPtTrack = false;
                    for (let altIdx = 0; altIdx < info.audioStreams.length; altIdx++) {
                        if (altIdx === effectiveAudioIndex) continue;
                        const altCheck = await SpeechLanguageService.verifySpokenLanguage(inputPath, altIdx, info.duration, 'pt');
                        if (altCheck.verified && altCheck.isMatch && altCheck.probability >= 0.60) {
                            console.log(`✅ [Correção de Áudio] Trilha alternativa ${altIdx} confirmada como Português! Corrigindo seleção de áudio.`);
                            effectiveAudioIndex = altIdx;
                            effectiveAudioStream = info.audioStreams[altIdx];
                            metadata._forcedAudioIndex = altIdx;
                            foundValidPtTrack = true;
                            break;
                        }
                    }

                    if (!foundValidPtTrack) {
                        throw new Error(`Áudio dublado falso detectado para "${optTitle}": idioma falado é ${speechCheck.detectedLanguage.toUpperCase()} (confiança ${(speechCheck.probability * 100).toFixed(0)}%), esperado PT-BR.`);
                    }
                }
            } else if (targetSpoken && targetSpoken !== 'und' && targetSpoken !== 'pt') {
                // Legendado: se o idioma original da obra for bem definido (ex: en, ko, ja, es, it)
                const speechCheck = await SpeechLanguageService.verifySpokenLanguage(inputPath, effectiveAudioIndex, info.duration, targetSpoken);
                if (speechCheck.verified && !speechCheck.isMatch && speechCheck.probability >= 0.75) {
                    const detectedLang = (speechCheck.detectedLanguage || '').toLowerCase();
                    if (['pt', 'pt-br', 'por'].includes(detectedLang)) {
                        console.log(`🇧🇷 [Auto-Correção] Áudio falado real é PORTUGUÊS (${(speechCheck.probability * 100).toFixed(0)}%)! Convertendo release para Dublado automaticamente.`);
                        metadata.isDublado = true;
                        metadata.isLegendado = false;
                        metadata.audioPreference = 'dublado';
                        isConfirmedDublado = true;
                    } else {
                        console.warn(`🚨 [Alerta de Áudio Original Divergente] Esperava-se ${targetSpoken.toUpperCase()}, mas o falado real é ${speechCheck.detectedLanguage.toUpperCase()} (${(speechCheck.probability * 100).toFixed(0)}%).`);

                        let foundTarget = false;
                        for (let altIdx = 0; altIdx < info.audioStreams.length; altIdx++) {
                            if (altIdx === effectiveAudioIndex) continue;
                            const altCheck = await SpeechLanguageService.verifySpokenLanguage(inputPath, altIdx, info.duration, targetSpoken);
                            if (altCheck.verified && altCheck.isMatch) {
                                console.log(`✅ [Correção de Áudio Original] Trilha alternativa ${altIdx} confirmada como ${targetSpoken.toUpperCase()}!`);
                                effectiveAudioIndex = altIdx;
                                effectiveAudioStream = info.audioStreams[altIdx];
                                metadata._forcedAudioIndex = altIdx;
                                foundTarget = true;
                                break;
                            }
                        }
                        if (!foundTarget && (targetSpoken === 'en' || targetSpoken === 'ko' || targetSpoken === 'ja')) {
                            throw new Error(`Áudio em idioma incorreto para "${optTitle}": falado real é ${speechCheck.detectedLanguage.toUpperCase()} (esperado ${targetSpoken.toUpperCase()}).`);
                        }
                    }
                }
            }
        } catch (speechErr) {
            if (speechErr.message && (speechErr.message.includes('Áudio dublado falso detectado') || speechErr.message.includes('Áudio em idioma incorreto'))) {
                throw speechErr;
            }
            console.warn(`⚠️ [SpeechLanguage] Verificação não-bloqueante ignorada por exceção: ${speechErr.message}`);
        }

        metadata.idiomaAudioSelecionado = isConfirmedDublado ? 'pt' : (this.normalizeLanguageCode(effectiveAudioStream?.language) || 'und');
        metadata.idiomaAudioLabel = isConfirmedDublado ? this.describeLanguageLabel('pt') :
            this.describeLanguageLabel(metadata.idiomaAudioSelecionado === 'und' ? resolvedOriginalLang : metadata.idiomaAudioSelecionado);
        if (!isConfirmedDublado && metadata.requiresDub) {
            throw Object.assign(new Error('A faixa selecionada não foi confirmada como dublada em português.'), { code: 'NO_DUBBED_AUDIO' });
        }
        metadata.isDublado = isConfirmedDublado;
        metadata.isLegendado = !isConfirmedDublado;

        // Se o release for legendado e ainda não tiver legenda definida, obtém pelo SubtitlePipeline
        let cleanupGeneratedSrt = false;
        if (!isConfirmedDublado && !metadata.deferWebSubtitles) {
            let srtPath = null;
            try {
                const pipelineResult = await SubtitlePipeline.processSubtitlePipeline(inputPath, {
                    ...metadata,
                    nome: metadata.nome || metadata.title,
                    nomeOriginal: metadata.nomeOriginal || metadata.originalTitle,
                    existingSubtitlePath: metadata.srtPath && fs.existsSync(metadata.srtPath) ? metadata.srtPath : null,
                    audioIndex: effectiveAudioIndex,
                    idioma: 'pt-BR'
                });
                metadata.refEnPath = pipelineResult?.refEnPath;
                metadata.subtitleSyncValidationVersion = pipelineResult?.syncValidationVersion;
                metadata.subtitleSyncProof = pipelineResult?.checkpoints;
                metadata.subtitleSourceMethod = pipelineResult?.sourceMethod;
                srtPath = pipelineResult && pipelineResult.srtPath ? pipelineResult.srtPath : null;
                if (srtPath) {
                    console.log(`✅ [SubtitlePipeline] Legenda obtida via ${pipelineResult.sourceMethod} | verified=${pipelineResult.verified}`);
                }
            } catch (pipelineErr) {
                throw Object.assign(pipelineErr, { code: pipelineErr.code || 'SUBTITLE_SYNC_FAILED' });
            }

            metadata.srtPath = srtPath;
            cleanupGeneratedSrt = true;
        }

        if (!isConfirmedDublado && !metadata.srtPath && !metadata.deferWebSubtitles) {
            throw Object.assign(new Error('Legenda PT-BR obrigatória ausente.'), { code: 'SUBTITLE_SYNC_FAILED' });
        }

        // Persistência de legendas em formato .srt e .vtt para o site e painel admin
        if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
            await this.persistWebSubtitles(metadata, metadata.srtPath, metadata.refEnPath);
        }

        // 2. Verificação de Hardsub Visual na Imagem (OCR Multiponto)
        try {
            console.log(`🔍 [Validação de Hardsub] Verificando imagem em 5 pontos para detectar legendas fixas indesejadas...`);
            const hardsubCheck = await HardsubDetectorService.detectHardsub(inputPath, info.duration);

            if (hardsubCheck.checked) {
                const isBrGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|lipeh|guanabara|ondebaixo|acervo|mmfilmes|p2p[-_ ]?br/i.test(path.basename(inputPath)) || metadata.isBrazilianGroup;

                if (isConfirmedDublado) {
                    // Filme Dublado:
                    // Se tiver legenda fixa estrangeira (russo, asiático, etc.) -> REJEITA
                    if (hardsubCheck.isForeignHardsub && !isBrGroup) {
                        throw new Error(`Legenda fixa estrangeira (${hardsubCheck.detectedScript}) detectada na imagem de vídeo dublado para "${optTitle}": ${hardsubCheck.textSamples}`);
                    }
                    // Se tiver texto latino persistente em quase todos os pontos (>= 4 de 5) -> REJEITA
                    if (hardsubCheck.latinHits >= 4 && !isBrGroup) {
                        throw new Error(`Legenda fixa persistente detectada na imagem de vídeo dublado para "${optTitle}": ${hardsubCheck.textSamples}`);
                    }
                    if (hardsubCheck.latinHits > 0) {
                        console.log(`ℹ️ [Hardsub Check] Texto pontual na tela aceito em dublado (${hardsubCheck.latinHits}/5 amostras). Provavelmente título ou letreiro.`);
                    }
                } else if (hardsubCheck.hasHardsub) {
                    throw Object.assign(
                        new Error(`Vídeo já possui legenda fixa na imagem para "${optTitle}". É preciso revisar a fonte para evitar sobreposição.`),
                        { code: 'SUBTITLE_SYNC_FAILED' }
                    );
                }
            }
        } catch (ocrErr) {
            if (ocrErr.code === 'SUBTITLE_SYNC_FAILED' || ocrErr.message?.includes('Legenda fixa')) {
                throw ocrErr;
            }
            console.warn(`⚠️ [HardsubDetector] Verificação ignorada por exceção: ${ocrErr.message}`);
        }

        // 3. Verificação Visual Antifraude (Marcas d'Água / Banners da 1xBet e Casas de Apostas)
        try {
            console.log(`🛡️ [Validação Visual Antifraude] Analisando frames da cena inteira (início e miolo) contra marcas da 1xBet e apostas...`);
            const betCheck = await BetWatermarkDetectorService.detectBetWatermark(inputPath, info.duration);
            if (betCheck.checked && betCheck.detected) {
                throw new Error(`Vídeo com propaganda/marca d'água de casa de apostas detectado para "${optTitle}": ${betCheck.details}`);
            }
        } catch (betErr) {
            if (betErr.message && betErr.message.includes('Vídeo com propaganda/marca d\'água de casa de apostas')) {
                throw betErr;
            }
            console.warn(`⚠️ [BetWatermarkDetector] Verificação ignorada por exceção: ${betErr.message}`);
        }

        let finalPath;

        // FIM DO HARDSUB: Vídeos H.264 compatíveis (Dublados ou Legendados) utilizam Remux Rápido em segundos sem recodificar
        const canRemuxFast = isUnderSizeLimit && isFastCodec && isResolutionFine;
        if (canRemuxFast) {
            const hasSub = metadata.srtPath && fs.existsSync(metadata.srtPath);
            console.log(`⚡ [${optTitle}] Vídeo compatível (${info.sizeMB} MB). Fazendo Remux Rápido (${hasSub ? 'Softsub mov_text' : 'Sem legendas'})...`);
            console.log(`🔊 Faixa de áudio: Stream 0:a:${effectiveAudioIndex} [${effectiveAudioStream?.codec?.toUpperCase()} | ${effectiveAudioStream?.channels} canais | lang: ${effectiveAudioStream?.language}]`);

            finalPath = await new Promise((resolve, reject) => {
                const remuxArgs = [
                    '-nostdin',
                    '-i', inputPath
                ];

                let inputCount = 1;
                let ptSubInputIdx = null;
                let enSubInputIdx = null;

                if (hasSub) {
                    remuxArgs.push('-i', metadata.srtPath);
                    ptSubInputIdx = inputCount++;
                }

                if (metadata.refEnPath && fs.existsSync(metadata.refEnPath) && metadata.refEnPath !== metadata.srtPath) {
                    remuxArgs.push('-i', metadata.refEnPath);
                    enSubInputIdx = inputCount++;
                }

                remuxArgs.push(
                    '-c:v', 'copy', // Cópia direta dos frames sem perda de qualidade nem uso de CPU
                    '-map', '0:v:0',
                    '-map', `0:a:${effectiveAudioIndex}`,
                    '-disposition:a:0', 'default'
                );

                // Normalização universal do áudio para AAC estéreo
                const isSimpleAacStereo = effectiveAudioStream &&
                    effectiveAudioStream.codec === 'aac' &&
                    effectiveAudioStream.channels <= 2;

                if (isSimpleAacStereo) {
                    remuxArgs.push('-c:a', 'copy');
                } else {
                    remuxArgs.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1000:first_pts=0');
                }

                // Inserção de legendas Softsub nativas no container MP4 (mov_text)
                if (hasSub) {
                    remuxArgs.push('-c:s', 'mov_text');
                    remuxArgs.push(
                        '-map', `${ptSubInputIdx}:0`,
                        '-metadata:s:s:0', 'language=por',
                        '-metadata:s:s:0', 'title=Português (Brasil)',
                        '-disposition:s:0', 'default'
                    );

                    if (enSubInputIdx !== null) {
                        remuxArgs.push(
                            '-map', `${enSubInputIdx}:0`,
                            '-metadata:s:s:1', 'language=eng',
                            '-metadata:s:s:1', 'title=English'
                        );
                    }
                } else {
                    remuxArgs.push('-sn');
                }

                const tempOutputPath = `${outputPath}.tmp.mp4`;
                if (fs.existsSync(tempOutputPath)) {
                    try { fs.unlinkSync(tempOutputPath); } catch (_) { }
                }

                remuxArgs.push('-max_muxing_queue_size', '1024', '-movflags', '+faststart', '-y', tempOutputPath);

                const ffmpeg = spawn('ffmpeg', remuxArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                const totalDuration = info.duration || 1;
                let lastLogTime = 0;

                ffmpeg.stderr.on('data', (data) => {
                    const text = data.toString();
                    const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                    const speedMatch = text.match(/speed=\s*([\d.]+)x/);

                    if (timeMatch) {
                        const hours = parseFloat(timeMatch[1]);
                        const minutes = parseFloat(timeMatch[2]);
                        const seconds = parseFloat(timeMatch[3]);
                        const currentTime = (hours * 3600) + (minutes * 60) + seconds;
                        const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
                        const speedStr = speedMatch ? `${speedMatch[1]}x` : 'Rápido';

                        const now = Date.now();
                        if (now - lastLogTime > 400) {
                            lastLogTime = now;
                            const barLength = 25;
                            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                            const empty = Math.max(0, barLength - filled);
                            const bar = '█'.repeat(filled) + '░'.repeat(empty);

                            const audioBadge = metadata.isDublado || metadata.audioText?.includes('Dublado') || (portugueseAudioIndex !== null && !metadata.srtPath) ? '🔊 Dublado' : '💬 Legendado';
                            process.stdout.write(`\r\x1b[36m⚡ [REMUX: "${optTitle}"] [${audioBadge}] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)} | 🚀 ${speedStr}\x1b[0m `);
                        }

                        if (onProgress) onProgress(percent, `Remux 1080p (${percent}%) - ${speedStr}`);
                    }
                });

                ffmpeg.stdout.on('data', () => { });

                ffmpeg.on('close', async (code) => {
                    if (code === 0 && fs.existsSync(tempOutputPath)) {
                        try {
                            const remuxInfo = await this.getVideoInfo(tempOutputPath).catch(() => null);
                            const isMicro = metadata.isMicrodrama || metadata.subtipo === 'microdrama';
                            const minDuration = Math.max(isMicro ? 40 : 180, totalDuration * 0.95);
                            if (remuxInfo && remuxInfo.duration >= minDuration) {
                                await fs.promises.rename(tempOutputPath, outputPath);
                                process.stdout.write('\n');
                                console.log(`\x1b[32m✅ [${optTitle}] Remux concluído com sucesso e áudio AAC estéreo 100% garantido!\x1b[0m`);
                                if (onProgress) onProgress(100, 'Remux Concluído');
                                return resolve(outputPath);
                            } else {
                                process.stdout.write('\n');
                                console.warn(`⚠️ [Remux Incompleto] Remux gerou apenas ${remuxInfo?.durationFormatted || 'incompleto'} (< ${this.formatDuration(totalDuration)}). Fazendo fallback automático para codificação completa 1080p...`);
                                await fs.remove(tempOutputPath).catch(() => { });
                                return this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                            }
                        } catch (e) {
                            if (fs.existsSync(tempOutputPath)) await fs.remove(tempOutputPath).catch(() => { });
                            return this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                        }
                    } else {
                        if (fs.existsSync(tempOutputPath)) await fs.remove(tempOutputPath).catch(() => { });
                        process.stdout.write('\n');
                        console.warn(`⚠️ Aviso no remux rápido (código ${code}), prosseguindo para codificação padrão...`);
                        this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                    }
                });
                ffmpeg.on('error', () => {
                    if (fs.existsSync(tempOutputPath)) fs.remove(tempOutputPath).catch(() => { });
                    process.stdout.write('\n');
                    this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                });
            });
        } else {
            // Vídeo não compatível com Remux Rápido (ex: 4K, HEVC, perfil incompatible) -> Recodificação Full HD com softsub mov_text
            finalPath = await this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata);
        }

        // Validação Pós-Conversão: Duração do arquivo de saída deve ser consistente
        const outInfo = await this.getVideoInfo(finalPath);
        if (info.duration > 0 && outInfo.duration > 0) {
            const isMicro = metadata.isMicrodrama || metadata.subtipo === 'microdrama';
            const minAcceptableSec = Math.max(isMicro ? 40 : 180, info.duration * 0.95);
            if (outInfo.duration < minAcceptableSec) {
                await fs.remove(finalPath).catch(() => { });
                throw new Error(`Inconsistência severa de duração pós-processamento: original tinha ${info.durationFormatted} (${Math.round(info.duration)}s) e arquivo gerado tem apenas ${outInfo.durationFormatted} (${Math.round(outInfo.duration)}s). Conversão descartada.`);
            }

            // Teste de integridade de decodificação no meio do vídeo (Anti-Freeze / Anti-Corrupção)
            const isValidStream = await this.checkVideoDecodeIntegrity(finalPath, outInfo.duration);
            if (!isValidStream) {
                await fs.remove(finalPath).catch(() => { });
                throw new Error(`Arquivo de vídeo gerado falhou no teste de decodificação no meio do arquivo (vídeo congelado ou corrompido). Conversão descartada.`);
            }
        }

        return finalPath;
    }

    async checkVideoDecodeIntegrity(filePath, durationSec) {
        if (!filePath || !fs.existsSync(filePath)) return false;
        try {
            const checkPoints = [
                Math.max(5, Math.floor(durationSec * 0.15)),
                Math.max(10, Math.floor(durationSec * 0.50))
            ];

            for (const checkPointSec of checkPoints) {
                const isValid = await new Promise((resolve) => {
                    const check = spawn('ffmpeg', [
                        '-nostdin',
                        '-y',
                        '-ss', `${checkPointSec}`,
                        '-i', filePath,
                        '-frames:v', '30',
                        '-f', 'null',
                        '-'
                    ]);

                    let isDone = false;
                    const timer = setTimeout(() => {
                        if (!isDone) {
                            isDone = true;
                            try { check.kill('SIGKILL'); } catch (e) { }
                            resolve(false);
                        }
                    }, 12000);

                    check.on('close', code => {
                        if (!isDone) {
                            isDone = true;
                            clearTimeout(timer);
                            resolve(code === 0);
                        }
                    });

                    check.on('error', () => {
                        if (!isDone) {
                            isDone = true;
                            clearTimeout(timer);
                            resolve(false);
                        }
                    });
                });

                if (!isValid) return false;
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    async encodeVideoFull(inputPath, outputPath, info, targetAudioIndex = 0, onProgress = null, metadata = {}) {
        await acquireTranscodeSlot();
        try {
            let maxTranscodes = config.MAX_CONCURRENT_TRANSCODES || 4;
            let safeThreads = config.FFMPEG_THREADS_PER_JOB || 5;
            try {
                const SchedulerService = require('./SchedulerService');
                const mode = SchedulerService.getActiveMode();
                maxTranscodes = mode === 'eco' ? 2 : (config.PERFORMANCE_MAX_TRANSCODES || 4);
                safeThreads = mode === 'eco' ? 4 : (config.FFMPEG_THREADS_PER_JOB || 5);
            } catch (e) { }

            const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
                ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
                : (metadata.nome || metadata.title || path.basename(inputPath));

            const hasSub = metadata.srtPath && fs.existsSync(metadata.srtPath);
            const hasEnSub = metadata.refEnPath && fs.existsSync(metadata.refEnPath) && metadata.refEnPath !== metadata.srtPath;

            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] Iniciando codificação de vídeo (Preset: faster, Threads: ${safeThreads}, CRF: 20, Slots ativos: ${activeTranscodes}/${maxTranscodes}${hasSub ? ', Softsub mov_text: SIM' : ''})...\x1b[0m`);

            return await new Promise((resolve, reject) => {
                const totalDuration = info.duration || 1;

                const safeMaxMB = (config.VIDEO_MAX_SIZE_BYTES / (1024 * 1024)) || 3950;
                const maxTotalKbps = Math.floor((safeMaxMB * 1024 * 8) / Math.max(1, totalDuration));
                const audioBitrateKbps = 192;
                const maxVideoKbps = Math.max(1500, maxTotalKbps - audioBitrateKbps);

                // Filtro de vídeo limpo: apenas escalonamento 1080p sem queimar legendas nos pixels
                const vfFilter = "scale='min(1920,iw)':-2";

                const args = [
                    '-nostdin',
                    '-i', inputPath
                ];

                let inputCount = 1;
                let ptSubInputIdx = null;
                let enSubInputIdx = null;

                if (hasSub) {
                    args.push('-i', metadata.srtPath);
                    ptSubInputIdx = inputCount++;
                }

                if (hasEnSub) {
                    args.push('-i', metadata.refEnPath);
                    enSubInputIdx = inputCount++;
                }

                args.push(
                    '-vf', vfFilter,
                    '-c:v', 'libx264',
                    '-preset', 'faster',
                    '-crf', '20',
                    '-profile:v', 'high',
                    '-level', '4.1',
                    '-pix_fmt', 'yuv420p',
                    '-maxrate', `${maxVideoKbps}k`,
                    '-bufsize', `${maxVideoKbps * 2}k`,
                    '-threads', `${safeThreads}`,
                    '-af', 'aresample=async=1000:first_pts=0',
                    '-c:a', 'aac',
                    '-b:a', `${audioBitrateKbps}k`,
                    '-ac', '2',
                    '-ar', '48000',
                    '-map', '0:v:0',
                    '-map', `0:a:${targetAudioIndex}`,
                    '-disposition:a:0', 'default',
                    '-max_muxing_queue_size', '1024'
                );

                if (hasSub) {
                    args.push('-c:s', 'mov_text');
                    args.push(
                        '-map', `${ptSubInputIdx}:0`,
                        '-metadata:s:s:0', 'language=por',
                        '-metadata:s:s:0', 'title=Português (Brasil)',
                        '-disposition:s:0', 'default'
                    );

                    if (enSubInputIdx !== null) {
                        args.push(
                            '-map', `${enSubInputIdx}:0`,
                            '-metadata:s:s:1', 'language=eng',
                            '-metadata:s:s:1', 'title=English'
                        );
                    }
                } else {
                    args.push('-sn');
                }

                const tempOutputPath = `${outputPath}.tmp.mp4`;
                if (fs.existsSync(tempOutputPath)) {
                    try { fs.unlinkSync(tempOutputPath); } catch (_) { }
                }

                args.push('-movflags', '+faststart', '-y', tempOutputPath);

                const ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

                let lastLogTime = Date.now();
                let ffmpegStderrBuffer = [];

                ffmpeg.stderr.on('data', (data) => {
                    const text = data.toString();
                    ffmpegStderrBuffer.push(text);
                    if (ffmpegStderrBuffer.length > 20) ffmpegStderrBuffer.shift();

                    const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                    const speedMatch = text.match(/speed=\s*([\d.]+)x/);
                    const fpsMatch = text.match(/fps=\s*([\d.]+)/);

                    if (timeMatch) {
                        const hours = parseFloat(timeMatch[1]);
                        const minutes = parseFloat(timeMatch[2]);
                        const seconds = parseFloat(timeMatch[3]);
                        const currentTime = (hours * 3600) + (minutes * 60) + seconds;
                        const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
                        const speedStr = speedMatch ? `${speedMatch[1]}x` : '';
                        const fpsStr = fpsMatch ? ` | FPS: ${fpsMatch[1]}` : '';

                        const now = Date.now();
                        if (now - lastLogTime > 3000) { // Atualiza a cada 3s para evitar flood nos logs do PM2
                            lastLogTime = now;
                            const barLength = 25;
                            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                            const empty = Math.max(0, barLength - filled);
                            const bar = '█'.repeat(filled) + '░'.repeat(empty);

                            // Amarelo vibrante para a etapa de Otimização FFmpeg
                            const audioBadge = (targetAudioIndex !== null && !metadata.srtPath && metadata.isDublado) || (metadata.isDublado && !metadata.srtPath) ? '🔊 Dublado' : '💬 Legendado';
                            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] [${audioBadge}] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)}${speedStr ? ` | ⚡ ${speedStr}` : ''}${fpsStr}\x1b[0m`);
                        }

                        if (onProgress) onProgress(percent, `Otimizando 1080p (${percent}%) ${speedStr ? `[${speedStr}]` : ''}`);
                    }
                });

                const cleanupSubtitleFiles = () => {
                    // Remaining temp files cleaned up below
                    if (metadata._hardsubAssPath && fs.existsSync(metadata._hardsubAssPath)) {
                        fs.remove(metadata._hardsubAssPath).catch(() => { });
                    }
                    if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                        fs.remove(metadata.srtPath).catch(() => { });
                    }
                };

                ffmpeg.on('close', async (code) => {
                    cleanupSubtitleFiles();

                    if (code === 0 && fs.existsSync(tempOutputPath)) {
                        try {
                            await fs.promises.rename(tempOutputPath, outputPath);
                            process.stdout.write('\n');
                            console.log(`\x1b[32m✅ Otimização 1080p concluída com sucesso e máxima fidelidade visual!\x1b[0m`);
                            if (onProgress) onProgress(100, 'Otimização Concluída');
                            resolve(outputPath);
                        } catch (renameErr) {
                            console.error(`❌ [FFmpeg Erro] Falha ao renomear arquivo temporário para ${outputPath}:`, renameErr.message);
                            reject(renameErr);
                        }
                    } else {
                        if (fs.existsSync(tempOutputPath)) {
                            await fs.remove(tempOutputPath).catch(() => { });
                        }
                        process.stdout.write('\n');
                        const errSnippet = ffmpegStderrBuffer.slice(-5).join('\n').trim();
                        if (errSnippet) {
                            console.error(`❌ [FFmpeg Erro] Código ${code}. Diagnóstico:\n${errSnippet}`);
                        }
                        reject(new Error(`Erro na transcodificação do vídeo: código ${code}`));
                    }
                });

                ffmpeg.on('error', (err) => {
                    cleanupSubtitleFiles();
                    if (fs.existsSync(tempOutputPath)) {
                        fs.remove(tempOutputPath).catch(() => { });
                    }
                    reject(err);
                });
            });
        } finally {
            releaseTranscodeSlot();
        }
    }

    /**
     * Escapa caminhos de arquivos para inserção segura no filtergraph do FFmpeg.
     * Trata backslashes, colons (C:), aspas simples e caracteres especiais de grafo.
     */
    escapeFFmpegFilterPath(filePath) {
        if (!filePath) return '';
        let escaped = filePath.replace(/\\/g, '/');
        // Escapa dois pontos (ex: C\:/... no Windows)
        escaped = escaped.replace(/:/g, '\\:');
        // Escapa aspas simples
        escaped = escaped.replace(/'/g, "'\\\\''");
        // Escapa colchetes (evita que sejam interpretados como labels de links do filtergraph)
        escaped = escaped.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        // Escapa vírgulas e pontos-e-vírgulas
        escaped = escaped.replace(/;/g, '\\;').replace(/,/g, '\\,');
        return escaped;
    }

    /**
     * Salva as legendas finais validadas (.srt e .vtt) no diretório público persistente para o player web
     */
    async persistWebSubtitles(metadata, srtPath, refEnPath = null) {
        try {
            if (!srtPath && !refEnPath) return [];

            const subtitlesDir = path.resolve(__dirname, '../../public/subtitles');
            await fs.ensureDir(subtitlesDir);

            const baseId = metadata.tmdbId || metadata.imdbId || (metadata.nome || metadata.title || 'sub').toLowerCase().replace(/[^a-z0-9]/g, '_');
            const mediaType = metadata.tipo === 'serie' ? `s${metadata.season || 1}e${metadata.episode || 1}` : 'movie';
            const timestamp = Date.now();

            const savedTracks = [];

            // 1. Trilha PT-BR
            if (srtPath && fs.existsSync(srtPath)) {
                await SubtitlePipeline.validateAndFinalizeSubtitle(srtPath, Number(metadata.duration || 0));
                const srtContent = await fs.readFile(srtPath, 'utf8');
                const ptSrtName = `${baseId}_${mediaType}_ptbr_${timestamp}.srt`;
                const ptVttName = `${baseId}_${mediaType}_ptbr_${timestamp}.vtt`;

                const ptSrtDest = path.join(subtitlesDir, ptSrtName);
                const ptVttDest = path.join(subtitlesDir, ptVttName);

                await fs.writeFile(ptSrtDest, srtContent, 'utf8');
                await fs.writeFile(ptVttDest, SubtitleTranslationService.convertSrtToVtt(srtContent), 'utf8');

                savedTracks.push({
                    lang: 'pt-BR',
                    label: 'Português (Brasil)',
                    default: true,
                    srtUrl: `/subtitles/${ptSrtName}`,
                    vttUrl: `/subtitles/${ptVttName}`,
                    srtPath: ptSrtDest,
                    vttPath: ptVttDest,
                    version: timestamp,
                    validationVersion: metadata.subtitleSyncValidationVersion || 0,
                    syncProof: metadata.subtitleSyncProof,
                    sourceMethod: metadata.subtitleSourceMethod,
                    contentHash: require('../utils/SubtitleUtils').contentHash(SubtitleTranslationService.convertSrtToVtt(srtContent))
                });
                console.log(`💾 [Web Subtitles] Legenda PT-BR persistida para o player web: ${ptVttName} (.srt e .vtt)`);
            }

            // 2. Trilha EN (se disponível)
            if (refEnPath && fs.existsSync(refEnPath) && refEnPath !== srtPath) {
                const enContent = await fs.readFile(refEnPath, 'utf8');
                const enSrtName = `${baseId}_${mediaType}_en_${timestamp}.srt`;
                const enVttName = `${baseId}_${mediaType}_en_${timestamp}.vtt`;

                const enSrtDest = path.join(subtitlesDir, enSrtName);
                const enVttDest = path.join(subtitlesDir, enVttName);

                await fs.writeFile(enSrtDest, enContent, 'utf8');
                await fs.writeFile(enVttDest, SubtitleTranslationService.convertSrtToVtt(enContent), 'utf8');

                savedTracks.push({
                    lang: 'en',
                    label: 'English',
                    default: false,
                    srtUrl: `/subtitles/${enSrtName}`,
                    vttUrl: `/subtitles/${enVttName}`,
                    srtPath: enSrtDest,
                    vttPath: enVttDest,
                    version: timestamp
                });
                console.log(`💾 [Web Subtitles] Legenda EN persistida para o player web: ${enVttName} (.srt e .vtt)`);
            }

            metadata.webSubtitles = savedTracks;
            return savedTracks;
        } catch (err) {
            console.warn(`⚠️ [Web Subtitles] Falha ao persistir legendas para web: ${err.message}`);
            throw Object.assign(err, { code: err.code || 'SUBTITLE_SYNC_FAILED' });
        }
    }

    formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hrs > 0) {
            return `${hrs}h ${mins.toString().padStart(2, '0')}m`;
        }
        return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    }
}

module.exports = new VideoProcessor();
