const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const SubtitleSync = require('./SubtitleSync');

let activeTranscodes = 0;
const transcodeWaiters = [];

function acquireTranscodeSlot() {
    let maxTranscodes = config.MAX_CONCURRENT_TRANSCODES || 4;
    try {
        const SchedulerService = require('./SchedulerService');
        const mode = SchedulerService.getActiveMode();
        maxTranscodes = mode === 'eco' ? 2 : (config.PERFORMANCE_MAX_TRANSCODES || 4);
    } catch (e) {}

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
                            title: (s.tags?.title || s.tags?.TITLE || s.tags?.handler_name || '').toLowerCase()
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
                    } catch (e) {}
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
        const sLang = (stream.language || '').toLowerCase();
        const sTitle = (stream.title || '').toLowerCase();
        return keywords.some(k => sLang === k || sLang.startsWith(k + '-') || sTitle.includes(k));
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
        // ~3.8% da altura → legível sem dominar a tela (~41px em 1080p)
        const fontSize = Math.max(28, Math.min(52, Math.round(outH * 0.038)));
        const outline = Math.max(2, Math.round(fontSize / 18));
        const marginV = Math.max(28, Math.round(outH * 0.035));
        const assPath = srtPath.replace(/\.srt$/i, '') + `_hardsub_${outW}x${outH}.ass`;

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
Style: Default,Arial,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,${outline},1,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join('\n')}
`;
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

        // 1. Verifica se há trilhas de legenda em Português embutidas no arquivo
        if (info.subtitleStreams && info.subtitleStreams.length > 0) {
            const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
            const hasPtSubStream = info.subtitleStreams.some(s => {
                const lang = (s.language || '').toLowerCase();
                const title = (s.title || '').toLowerCase();
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

        // 1. Tags russas ou de casas de aposta (scams) no nome do arquivo
        const isRussianName = /\b(rus|russian|dvo|mvo|avo|itunes[-_ ]?rus|itunes[-_ ]?r|hdrezka|lostfilm|redheadsound|rhs|baibako|newstudio|coldfilm|kinogo|lordfilm|rutracker|rutor)\b|\.(d|d1|d2|mvo|dvo|avo)\.|\b\d{4}\.d\b/i.test(lowerName);
        const isScamName = /\b(1xbet|1x_bet|1x-bet|mostbet|pari|melbet|betboom|fonbet|pin-up|joycasino|vavada|catcasino|winline|betandyou|dcprip|line\.audio|line[-_ ]audio)\b/i.test(lowerName);

        if (isRussianName || isScamName) {
            return true;
        }

        // 2. Streams de áudio no ffprobe: detecta trilhas marcadas como 'rus', 'ru' ou com nomes russos
        if (info.audioStreams && info.audioStreams.length > 0) {
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
                audioText: 'Rejeitado (Áudio Russo / Scam)'
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

        const isSourceDublado = (source.isDublado === true || source.audio?.toLowerCase().includes('dublado') || /\b(dublado|dub|nacional|pt[-_]?br)\b/i.test(sourceTitle)) && !allTaggedAndForeign;
        const hasDirectPtAudio = this.hasPortugueseAudio(info, rawFileName);
        const hasAudioStreams = info.audioStreams && info.audioStreams.length > 0;
        const isDublado = !allTaggedAndForeign && (hasDirectPtAudio || (isSourceDublado && hasAudioStreams && !this.isRussianOrScamAudio(info, rawFileName, metadata)));

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

    isBrazilianPortugueseSubtitle(content) {
        if (!content || typeof content !== 'string' || content.length < 200) return false;

        // 1. Padrões característicos e inequívocos de Português de Portugal (PT-PT)
        // Gerúndio substituído por 'a + infinitivo': "estou a falar", "está a fazer", "estava a ver", "estavam a pensar"
        const ptPtGerundRegex = /\b(estou|está|estás|estava|estavam|estávamos|estiver|estiverem|andar|anda|andam|andava|andavam)\s+a\s+([a-z]{3,12}(?:ar|er|ir))\b/gi;
        const ptPtGerundMatches = (content.match(ptPtGerundRegex) || []).length;

        // Conjugações e pronomes específicos de PT-PT com gerúndio / expressões tipicamente europeias
        const ptPtTuGerundRegex = /\btu\s+estás\s+a\s+([a-z]{3,12}(?:ar|er|ir))\b/gi;
        const ptPtTuGerundMatches = (content.match(ptPtTuGerundRegex) || []).length;

        // Vocabulário estritamente exclusivo europeu (sem termos comuns ao PT formal)
        const ptPtVocabRegex = /\b(ora bem|pois bem|ó pá\b|pá\b|malta\b|rapariga|raparigas|miúdo|miúdos|miúda|miúdas|comboio|comboios|ecrã|ecrãs|telemóvel|telemóveis|autocarro|autocarros|pequeno-almoço|pequeno almoço|parvalhão|casa de banho)\b/gi;
        const ptPtVocabMatches = (content.match(ptPtVocabRegex) || []).length;

        const ptPtScore = (ptPtGerundMatches * 5) + (ptPtTuGerundMatches * 4) + (ptPtVocabMatches * 4);

        // 2. Padrões característicos de Português Brasileiro (PT-BR)
        // Gerúndio natural brasileiro: "estou fazendo", "está vendo", "estavam ouvindo"
        const ptBrGerundRegex = /\b(estou|está|estava|estavam|estávamos|ficou|fica|ficam)\s+([a-z]{3,12}(?:ando|endo|indo))\b/gi;
        const ptBrGerundMatches = (content.match(ptBrGerundRegex) || []).length;

        // Vocabulário típico brasileiro
        const ptBrVocabRegex = /\b(você|vocês|legal\b|cara\b|celular|ônibus|trem\b|café da manhã|banheiro|garoto|garota|moço|moça|grana|droga|beleza|valeu\b|a gente)\b/gi;
        const ptBrVocabMatches = (content.match(ptBrVocabRegex) || []).length;

        // Próclise típica brasileira
        const ptBrProcliseRegex = /\b(me dá|te vejo|te amo|me ajuda|me diz|me fala|me conta|não me|não te)\b/gi;
        const ptBrProcliseMatches = (content.match(ptBrProcliseRegex) || []).length;

        const ptBrScore = (ptBrGerundMatches * 3) + (ptBrVocabMatches * 2) + (ptBrProcliseMatches * 2);

        // Palavras genéricas do português para validação de integridade básica
        const genericPtRegex = /\b(não|está|estão|então|também|muito|aqui|agora|isso|isto|porque|por que|senhor|senhora|olha|vamos|fazer|onde|quando|quem|tudo|nada|tenho|tinha|dele|dela|obrigado|obrigada|por favor)\b/gi;
        const genericMatches = (content.match(genericPtRegex) || []).length;

        if (genericMatches < 8 && ptBrScore < 3) return false;

        // Se houver indícios fortes e consistentes de Português de Portugal (ex: gerúndio europeu expressivo superando PT-BR), rejeita!
        if (ptPtScore >= 15 && ptPtScore > ptBrScore * 2) {
            return false;
        }

        // Se tiver gerúndio PT-PT expressivo (>= 4) e nenhum gerúndio PT-BR, é claramente PT-PT
        if (ptPtGerundMatches >= 4 && ptBrGerundMatches === 0) {
            return false;
        }

        return true;
    }

    isPortugueseSubtitleContent(content) {
        return this.isBrazilianPortugueseSubtitle(content);
    }

    async findCompanionSubtitle(inputPath, metadata = {}) {
        try {
            const videoDir = path.dirname(inputPath);
            const season = metadata.season || 1;
            const episode = metadata.episode || 1;

            const sPadded = String(season).padStart(2, '0');
            const ePadded = String(episode).padStart(2, '0');
            const epRegex = new RegExp(`(s0*${season}e0*${episode}|e0*${episode}|\\b0*${episode}\\b)`, 'i');

            // Vasculha diretório do vídeo, pasta pai e subpastas Subs / Subtitles
            const candidateDirs = [
                videoDir,
                path.join(videoDir, 'Subs'),
                path.join(videoDir, 'Subtitles'),
                path.join(videoDir, 'subs'),
                path.dirname(videoDir),
                path.join(path.dirname(videoDir), 'Subs'),
                path.join(path.dirname(videoDir), 'Subtitles')
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
                const matchesEp = epRegex.test(item.name) || epRegex.test(item.dirName) || allFiles.length <= 5;
                if (isPt && matchesEp) {
                    const content = await fs.readFile(item.path, 'utf8').catch(() => '');
                    if (this.isBrazilianPortugueseSubtitle(content)) {
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
                const matchesEp = epRegex.test(item.name) || epRegex.test(item.dirName) || allFiles.length <= 5;
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

    async getOrExtractPortugueseSubtitle(inputPath, info, metadata = {}) {
        const axios = require('axios');
        const https = require('https');
        const agent = new https.Agent({ rejectUnauthorized: false });
        const srtPath = path.join(path.dirname(inputPath), `sub_pt_${Date.now()}.srt`);

        // 1. Tenta extrair legenda embutida em Português do arquivo de vídeo original
        // Prioriza: 1º Português Brasileiro (pob, pt-br, brazilian, título com 'brasil' ou 'brasileiro')
        //           2º Português genérico (por, portuguese, português, pt)
        // Desqualifica / Penaliza: Português de Portugal (pt-pt, portugal, european, por-pt)
        const scoredPtStreams = (info.subtitleStreams || [])
            .map(s => {
                const lang = (s.language || '').toLowerCase();
                const title = (s.title || '').toLowerCase();
                let score = 0;

                const isExplicitPtPt = lang === 'pt-pt' || lang.includes('pt-pt') || lang.includes('por-pt') || 
                                       title.includes('pt-pt') || title.includes('portugal') || title.includes('european') || title.includes('europeu');
                if (isExplicitPtPt) {
                    return { stream: s, score: -10 };
                }

                if (lang === 'pob' || lang === 'pt-br' || lang.includes('brazil') || title.includes('bras') || title.includes('pob') || title.includes('pt-br')) {
                    score = 20;
                } else if (lang === 'por' || lang === 'pt' || lang.includes('portug') || title.includes('portug') || title.includes('legenda')) {
                    score = 5;
                }
                return { stream: s, score };
            })
            .filter(item => item.score > 0)
            .sort((a, b) => b.score - a.score);

        for (const { stream: ptSubStream } of scoredPtStreams) {
            const isTextCodec = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt'].includes((ptSubStream.codec || '').toLowerCase());
            if (isTextCodec) {
                try {
                    const streamTarget = ptSubStream.globalIndex !== undefined ? `0:${ptSubStream.globalIndex}` : `0:s:${ptSubStream.index}`;
                    console.log(`📝 Extraindo legenda PT-BR embutida (Stream ${streamTarget} [${ptSubStream.title || ptSubStream.language}], Codec: ${ptSubStream.codec})...`);
                    await new Promise((resolve, reject) => {
                        let isDone = false;
                        const extract = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', inputPath, '-map', streamTarget, '-c:s', 'srt', srtPath]);

                        const timer = setTimeout(() => {
                            if (!isDone) {
                                isDone = true;
                                try { extract.kill('SIGKILL'); } catch (e) {}
                                reject(new Error('Timeout de 60s ao extrair legenda interna'));
                            }
                        }, 60000);

                        extract.on('close', code => {
                            if (!isDone) {
                                isDone = true;
                                clearTimeout(timer);
                                (code === 0 && fs.existsSync(srtPath)) ? resolve() : reject(new Error(`Erro ao extrair srt (código ${code})`));
                            }
                        });

                        extract.on('error', err => {
                            if (!isDone) {
                                isDone = true;
                                clearTimeout(timer);
                                reject(err);
                            }
                        });
                    });

                    if (fs.existsSync(srtPath) && fs.statSync(srtPath).size > 500) {
                        const content = await fs.readFile(srtPath, 'utf8');
                        const langTag = (ptSubStream.language || '').toLowerCase();
                        const titleTag = (ptSubStream.title || '').toLowerCase();
                        const isOfficialStudioPob = ['pob', 'pt-br', 'brazilian'].includes(langTag) ||
                                                   titleTag.includes('brazil') || titleTag.includes('brasil') || titleTag.includes('pob');

                        if (isOfficialStudioPob || this.isBrazilianPortugueseSubtitle(content)) {
                            await SubtitleSync.optimizeSubtitleFile(srtPath);
                            console.log(`✅ Legenda PT-BR interna [${ptSubStream.title || ptSubStream.language}] extraída, otimizada e validada (100% Sincronia de Estúdio)!`);
                            return srtPath;
                        } else {
                            console.warn(`⚠️ Legenda interna [${ptSubStream.title || ptSubStream.language}] extraída continha Português de Portugal ou texto não autêntico PT-BR. Descartando trilha e buscando PT-BR...`);
                            await fs.remove(srtPath).catch(() => {});
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ Falha ao extrair trilha de legenda:', e.message);
                    await fs.remove(srtPath).catch(() => {});
                }
            }
        }

        // 2. Verifica se o torrent já trouxe a legenda oficial PT-BR na pasta (Companion Subs do release)
        const companion = await this.findCompanionSubtitle(inputPath, metadata);
        if (companion.ptSrtPath) {
            await SubtitleSync.optimizeSubtitleFile(companion.ptSrtPath);
            return companion.ptSrtPath;
        }

        // Determina a melhor referência para sincronização (Sub-to-Sub ou Audio-to-Sub)
        let refSyncTarget = companion.refEnPath || null;
        if (!refSyncTarget) {
            const enSubStream = (info.subtitleStreams || []).find(s => {
                const lang = (s.language || '').toLowerCase();
                const title = (s.title || '').toLowerCase();
                return ['eng', 'en', 'english'].includes(lang) || title.includes('english');
            });
            if (enSubStream && ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt'].includes((enSubStream.codec || '').toLowerCase())) {
                const refEnSrtPath = path.join(path.dirname(inputPath), `ref_en_${Date.now()}.srt`);
                try {
                    const streamTarget = enSubStream.globalIndex !== undefined ? `0:${enSubStream.globalIndex}` : `0:s:${enSubStream.index}`;
                    const extractProc = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', inputPath, '-map', streamTarget, '-c:s', 'srt', refEnSrtPath]);
                    await new Promise((res, rej) => {
                        const timer = setTimeout(() => {
                            try { extractProc.kill('SIGKILL'); } catch (e) {}
                            rej(new Error('Timeout de 60s ao extrair ref inglesa'));
                        }, 60000);
                        extractProc.on('close', c => { clearTimeout(timer); c === 0 ? res() : rej(); });
                        extractProc.on('error', err => { clearTimeout(timer); rej(err); });
                    });
                    if (fs.existsSync(refEnSrtPath) && fs.statSync(refEnSrtPath).size > 500) {
                        refSyncTarget = refEnSrtPath;
                        console.log(`🎯 [SubtitleSync] Trilha de referência em inglês extraída para alinhamento sub-to-sub!`);
                    }
                } catch (e) {}
            }
        }

        if (!refSyncTarget) {
            refSyncTarget = inputPath; // Fallback: alinha contra o áudio do vídeo via VAD
        }

        // 3. Busca e validação no OpenSubtitles via IMDb ID
        if (!metadata.imdbId && metadata.tmdbId) {
            try {
                const extPath = metadata.tipo === 'serie' ? `tv/${metadata.tmdbId}` : `movie/${metadata.tmdbId}`;
                const extRes = await axios.get(`https://api.themoviedb.org/3/${extPath}/external_ids`, {
                    params: { api_key: config.TMDB_API_KEY },
                    timeout: 6000
                });
                if (extRes.data?.imdb_id) {
                    metadata.imdbId = extRes.data.imdb_id;
                    console.log(`🆔 [TMDB External IDs] IMDb ID resolvido com sucesso: ${metadata.imdbId}`);
                }
            } catch (e) {}
        }

        if (metadata.imdbId) {
            try {
                const season = metadata.season || 1;
                const episode = metadata.episode || 1;
                const streamPath = metadata.tipo === 'serie' ? `series/${metadata.imdbId}:${season}:${episode}.json` : `movie/${metadata.imdbId}.json`;
                
                const endpoints = [
                    `https://opensubtitles-v3.strem.io/subtitles/${streamPath}`,
                    `https://subtitles.strem.io/subtitles/${streamPath}`,
                    `https://opensubtitles-v8.strem.io/subtitles/${streamPath}`
                ];

                let ptSubs = [];
                for (const osUrl of endpoints) {
                    try {
                        const res = await axios.get(osUrl, { 
                            timeout: 6000, 
                            httpsAgent: agent,
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.168' }
                        });
                        const subs = res.data?.subtitles || [];
                        ptSubs = subs.filter(s => {
                            const lang = (s.lang || s.language || '').toLowerCase();
                            const isPtPt = lang === 'pt-pt' || lang.includes('pt-pt') || lang.includes('por-pt');
                            if (isPtPt) return false;
                            return ['pob', 'pt-br', 'brazilian', 'por', 'pt', 'ptbr'].includes(lang);
                        }).sort((a, b) => {
                            const langA = (a.lang || a.language || '').toLowerCase();
                            const langB = (b.lang || b.language || '').toLowerCase();
                            const scoreA = ['pob', 'pt-br', 'brazilian'].includes(langA) ? 10 : 1;
                            const scoreB = ['pob', 'pt-br', 'brazilian'].includes(langB) ? 10 : 1;
                            return scoreB - scoreA;
                        });

                        if (ptSubs.length > 0) break;
                    } catch (e) {}
                }

                if (ptSubs.length > 0) {
                    console.log(`🌐 Testando ${ptSubs.length} legendas candidatas no OpenSubtitles...`);

                    for (const sub of ptSubs) {
                        try {
                            const subRes = await axios.get(sub.url, { timeout: 8000, httpsAgent: agent, responseType: 'text' });
                            if (subRes.data && this.isBrazilianPortugueseSubtitle(subRes.data)) {
                                await fs.writeFile(srtPath, subRes.data, 'utf8');
                                console.log(`✅ Legenda PT-BR oficial (${sub.lang}) baixada e validada linguisticamente (${(subRes.data.length / 1024).toFixed(1)} KB)!`);
                                
                                // Sincroniza a legenda externa contra o áudio ou referência de legenda do vídeo
                                const syncedSrtPath = path.join(path.dirname(inputPath), `sub_pt_synced_${Date.now()}.srt`);
                                const finalSrt = await SubtitleSync.syncSubtitle(refSyncTarget, srtPath, syncedSrtPath);
                                if (finalSrt) {
                                    return finalSrt;
                                }
                            } else if (subRes.data) {
                                console.warn(`⚠️ Legenda OpenSubtitles (${sub.lang}) descartada: texto identificado como Português de Portugal ou não autêntico PT-BR.`);
                            }
                        } catch (errSub) {}
                    }
                }
            } catch (e) {}
        }

        // 4. Fallback de URL direta caso fornecida
        if (metadata.subtitleUrl) {
            try {
                const res = await axios.get(metadata.subtitleUrl, { timeout: 10000, httpsAgent: agent, responseType: 'text' });
                if (res.data && this.isBrazilianPortugueseSubtitle(res.data)) {
                    await fs.writeFile(srtPath, res.data, 'utf8');
                    console.log(`✅ Legenda PT-BR direta baixada e validada!`);
                    
                    const syncedSrtPath = path.join(path.dirname(inputPath), `sub_pt_synced_${Date.now()}.srt`);
                    const finalSrt = await SubtitleSync.syncSubtitle(refSyncTarget, srtPath, syncedSrtPath);
                    if (finalSrt) {
                        return finalSrt;
                    }
                }
            } catch (e) {}
        }

        return null;
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
        const hasPortugueseAudio = portugueseAudioIndex !== null;
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
                } else {
                    throw new Error(`Seleção de áudio inválida para "${optTitle}": ${audioValidation.reason}`);
                }
            } else if (!recheck.ok) {
                throw new Error(`Seleção de áudio inválida para "${optTitle}": ${audioValidation.reason}`);
            } else {
                metadata._forcedAudioIndex = finalIdx;
            }
        }

        const effectiveAudioIndex = metadata._forcedAudioIndex !== undefined ? metadata._forcedAudioIndex : targetAudioIndex;
        const effectiveAudioStream = info.audioStreams[effectiveAudioIndex] || selectedAudioStream;
        const resolvedOriginalLang = this.resolveOriginalLanguage(metadata, info.audioStreams);
        metadata.idiomaOriginal = metadata.idiomaOriginal || metadata.originalLanguage || resolvedOriginalLang || null;
        metadata.originalLanguage = metadata.idiomaOriginal;
        // Nunca inventar o idioma da trilha a partir do idioma original da obra (causava "Coreano" com áudio inglês)
        const detectedSelLang = this.normalizeLanguageCode(effectiveAudioStream?.language) ||
            (this.streamMatchesLanguage(effectiveAudioStream, 'pt') ? 'pt' :
                (this.streamMatchesLanguage(effectiveAudioStream, 'en') ? 'en' : null));
        metadata.idiomaAudioSelecionado = detectedSelLang || 'und';
        metadata.idiomaAudioLabel = detectedSelLang
            ? this.describeLanguageLabel(detectedSelLang)
            : (resolvedOriginalLang ? `${this.describeLanguageLabel(resolvedOriginalLang)}?` : 'Original');
        console.log(`🔊 [${optTitle}] Áudio final: index=${effectiveAudioIndex} tag=${effectiveAudioStream?.language || 'und'} detectado=${metadata.idiomaAudioSelecionado} originalObra=${metadata.idiomaOriginal || 'n/a'}`);

        let srtPath = null;
        const alreadyHardsubbed = metadata.isDirect || metadata.hasEmbeddedSub || metadata.isReadySub;
        // Só é confirmado dublado se o arquivo REALMENTE tiver áudio em português detectado via ffprobe
        // e se o pedido NÃO for expressamente SOMENTE legendado (sem dublagem).
        // Releases Dual com PT-BR + softsubs NÃO devem queimar legenda: dublado = áudio PT sem legenda na tela.
        const hasVerifiedPtAudio = hasPortugueseAudio || (metadata.isDublado === true && this.hasPortugueseAudio(info, path.basename(inputPath)));
        const wantLegendadoOnly = metadata.isLegendado === true && metadata.isDublado === false;
        const isConfirmedDublado = hasVerifiedPtAudio && !wantLegendadoOnly;

        // Se NÃO possuir áudio em Português e for expressamente Legendado (sem áudio dublado),
        // DEVE OBRIGATORIAMENTE obter e queimar/embutir as legendas em Português Brasileiro (PT-BR),
        // a menos que o vídeo seja Dublado ou venha com hardsub já embutido no stream (Web Direct).
        if (!isConfirmedDublado && (wantLegendadoOnly || !hasPortugueseAudio) && !alreadyHardsubbed) {
            if (!hasPortugueseAudio) {
                console.log(`💬 [${optTitle}] Áudio em Português não detectado no arquivo original. Buscando e extraindo legendas oficiais PT-BR para Hardsub obrigatório...`);
            }
            srtPath = await this.getOrExtractPortugueseSubtitle(inputPath, info, metadata);
            if (!srtPath) {
                console.error(`❌ [Bloqueio de Qualidade: "${optTitle}"] Nenhuma legenda em Português (PT-BR) encontrada ou validada para o vídeo sem dublagem.`);
                throw new Error(`Vídeo em idioma estrangeiro sem áudio dublado e sem legenda PT-BR disponível para "${optTitle}". Abortando processamento para evitar publicação sem tradução.`);
            } else {
                metadata.srtPath = srtPath;
                if (!hasPortugueseAudio) {
                    metadata.isLegendado = true;
                    metadata.isDublado = false;
                }
            }
        } else if (alreadyHardsubbed && !isConfirmedDublado) {
            // Vídeo Web Direct: tem hardsub/legenda embutida no stream mas SEM áudio em Português.
            // Independentemente da preferência do job, deve ser catalogado como Legendado.
            console.log(`💬 [${optTitle}] Vídeo Web Direct ${metadata.isLegendado ? 'legendado' : 'sem áudio PT'} — classificando como Legendado (PT-BR) (hardsub/embedded).`);
            metadata.isLegendado = true;
            metadata.isDublado = false;
        } else if (isConfirmedDublado) {
            // Dual com PT-BR (+ softsubs): cataloga/processa como Dublado limpo — sem hardsub e sem softsubs
            metadata.isDublado = true;
            metadata.isLegendado = false;
            metadata.srtPath = null;
            srtPath = null;
            console.log(`🇧🇷 [${optTitle}] Áudio PT-BR confirmado → processando como Dublado SEM legendas (softsubs/hardsub removidos).`);
        }

        let finalPath;

        // Se for comprovadamente Dublado (e sem necessidade de queimar legendas), faz Remux Rápido quando compatível
        if (isConfirmedDublado && isUnderSizeLimit && isFastCodec && isResolutionFine) {
            console.log(`⚡ [${optTitle}] Vídeo já está em 1080p H.264 compatível (${info.sizeMB} MB). Fazendo Remux Rápido com normalização universal de áudio AAC...`);
            console.log(`🔊 Faixa de áudio selecionada: Stream 0:a:${effectiveAudioIndex} [${effectiveAudioStream?.codec?.toUpperCase()} | ${effectiveAudioStream?.channels} canais | lang: ${effectiveAudioStream?.language}]`);

            finalPath = await new Promise((resolve, reject) => {
                const remuxArgs = [
                    '-nostdin',
                    '-i', inputPath,
                    '-c:v', 'copy', // Cópia direta do vídeo sem reprocessamento
                    '-map', '0:v:0',
                    '-map', `0:a:${effectiveAudioIndex}`,
                    '-disposition:a:0', 'default',
                    '-sn' // Dublado: nunca embutir softsubs (evita PT Forced/Full na tela)
                ];

                const isSimpleAacStereo = effectiveAudioStream && 
                    effectiveAudioStream.codec === 'aac' && 
                    effectiveAudioStream.channels <= 2;

                if (isSimpleAacStereo) {
                    remuxArgs.push('-c:a', 'copy');
                } else {
                    remuxArgs.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000', '-af', 'aresample=async=1000:first_pts=0');
                }

                remuxArgs.push('-max_muxing_queue_size', '1024', '-movflags', '+faststart', '-y', outputPath);

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

                ffmpeg.stdout.on('data', () => {});

                ffmpeg.on('close', async (code) => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        try {
                            const remuxInfo = await this.getVideoInfo(outputPath).catch(() => null);
                            const minDuration = Math.max(300, totalDuration * 0.50);
                            if (remuxInfo && remuxInfo.duration >= minDuration) {
                                process.stdout.write('\n');
                                console.log(`\x1b[32m✅ [${optTitle}] Remux concluído com sucesso e áudio AAC estéreo 100% garantido!\x1b[0m`);
                                if (onProgress) onProgress(100, 'Remux Concluído');
                                return resolve(outputPath);
                            } else {
                                process.stdout.write('\n');
                                console.warn(`⚠️ [Remux Incompleto] Remux gerou apenas ${remuxInfo?.durationFormatted || 'incompleto'} (< ${this.formatDuration(totalDuration)}). Fazendo fallback automático para codificação completa 1080p...`);
                                await fs.remove(outputPath).catch(() => {});
                                return this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                            }
                        } catch (e) {
                            return this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                        }
                    } else {
                        process.stdout.write('\n');
                        console.warn(`⚠️ Aviso no remux rápido (código ${code}), prosseguindo para codificação padrão...`);
                        this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                    }
                });
                ffmpeg.on('error', () => {
                    process.stdout.write('\n');
                    this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                });
            });
        } else {
            finalPath = await this.encodeVideoFull(inputPath, outputPath, info, effectiveAudioIndex, onProgress, metadata);
        }

        // Limpa arquivos temporários de legenda (.srt / .ass) após a codificação
        if (srtPath && fs.existsSync(srtPath)) {
            await fs.remove(srtPath).catch(() => {});
        }
        if (metadata._hardsubAssPath && fs.existsSync(metadata._hardsubAssPath)) {
            await fs.remove(metadata._hardsubAssPath).catch(() => {});
            delete metadata._hardsubAssPath;
        }

        // Validação Pós-Conversão: Duração do arquivo de saída deve ser consistente
        const outInfo = await this.getVideoInfo(finalPath);
        if (info.duration > 0 && outInfo.duration > 0) {
            const minAcceptableSec = Math.max(300, info.duration * 0.50);
            if (outInfo.duration < minAcceptableSec) {
                await fs.remove(finalPath).catch(() => {});
                throw new Error(`Inconsistência severa de duração pós-processamento: original tinha ${info.durationFormatted} (${Math.round(info.duration)}s) e arquivo gerado tem apenas ${outInfo.durationFormatted} (${Math.round(outInfo.duration)}s). Conversão descartada.`);
            }

            // Teste de integridade de decodificação no meio do vídeo (Anti-Freeze / Anti-Corrupção)
            const isValidStream = await this.checkVideoDecodeIntegrity(finalPath, outInfo.duration);
            if (!isValidStream) {
                await fs.remove(finalPath).catch(() => {});
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
                            try { check.kill('SIGKILL'); } catch (e) {}
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
            } catch (e) {}

            const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
                ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
                : (metadata.nome || metadata.title || path.basename(inputPath));

            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] Iniciando codificação (Preset: faster, Threads: ${safeThreads}, CRF: 20, Slots ativos: ${activeTranscodes}/${maxTranscodes}${metadata.srtPath ? ', Legenda Queimada: SIM' : ''})...\x1b[0m`);
            
            // Escala alvo para hardsub (PlayRes do ASS deve bater com o frame de saída)
            const outW = Math.min(1920, info.width || 1920);
            const outH = info.height && info.width
                ? Math.round((Math.min(1920, info.width) / info.width) * info.height)
                : (info.height || 1080);

            let hardsubPath = null;
            if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                try {
                    hardsubPath = await this.buildHardsubAssFromSrt(metadata.srtPath, outW, outH);
                    metadata._hardsubAssPath = hardsubPath;
                    console.log(`📝 [Hardsub] ASS gerado com PlayRes ${outW}x${outH} (fonte proporcional à resolução)`);
                } catch (e) {
                    console.warn(`⚠️ [Hardsub] Falha ao gerar ASS tipográfico, usando SRT com force_style escalado: ${e.message}`);
                }
            }

            return await new Promise((resolve, reject) => {
                const totalDuration = info.duration || 1;

                const safeMaxMB = (config.VIDEO_MAX_SIZE_BYTES / (1024 * 1024)) || 3950;
                const maxTotalKbps = Math.floor((safeMaxMB * 1024 * 8) / Math.max(1, totalDuration));
                const audioBitrateKbps = 192;
                const maxVideoKbps = Math.max(1500, maxTotalKbps - audioBitrateKbps);

                // Monta filtros de vídeo (Escalonamento 1080p + Legendas Hardsub com PlayRes correto)
                let vfFilter = "scale='min(1920,iw)':-2";
                if (hardsubPath && fs.existsSync(hardsubPath)) {
                    const assEscaped = hardsubPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    vfFilter += `,ass='${assEscaped}'`;
                } else if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                    // Fallback: force_style com FontSize relativo ao PlayResY padrão (288)
                    const scaledFont = Math.max(12, Math.min(18, Math.round(outH * 0.038 * 288 / Math.max(outH, 1))));
                    const srtEscaped = metadata.srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    vfFilter += `,subtitles='${srtEscaped}':force_style='FontName=Arial,FontSize=${scaledFont},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=1.5,Shadow=0.8,MarginV=28,Alignment=2,Bold=0'`;
                }

                const args = [
                    '-nostdin',
                    '-i', inputPath,
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
                ];

                args.push('-movflags', '+faststart', '-y', outputPath);

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

                ffmpeg.on('close', (code) => {
                    if (metadata._hardsubAssPath && fs.existsSync(metadata._hardsubAssPath)) {
                        fs.remove(metadata._hardsubAssPath).catch(() => {});
                    }
                    if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                        fs.remove(metadata.srtPath).catch(() => {});
                    }

                    if (code === 0 && fs.existsSync(outputPath)) {
                        process.stdout.write('\n');
                        console.log(`\x1b[32m✅ Otimização 1080p concluída com sucesso e máxima fidelidade visual!\x1b[0m`);
                        if (onProgress) onProgress(100, 'Otimização Concluída');
                        resolve(outputPath);
                    } else {
                        process.stdout.write('\n');
                        const errSnippet = ffmpegStderrBuffer.slice(-5).join('\n').trim();
                        if (errSnippet) {
                            console.error(`❌ [FFmpeg Erro] Código ${code}. Diagnóstico:\n${errSnippet}`);
                        }
                        reject(new Error(`Erro na transcodificação do vídeo: código ${code}`));
                    }
                });

                ffmpeg.on('error', (err) => {
                    if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                        fs.remove(metadata.srtPath).catch(() => {});
                    }
                    reject(err);
                });
            });
        } finally {
            releaseTranscodeSlot();
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
