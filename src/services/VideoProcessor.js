const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const SubtitleSync = require('./SubtitleSync');

let activeTranscodes = 0;
const transcodeWaiters = [];

function acquireTranscodeSlot() {
    const maxTranscodes = config.MAX_CONCURRENT_TRANSCODES || 2;
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
                            title: (a.tags?.title || a.tags?.TITLE || a.tags?.handler_name || '').toLowerCase()
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
                    resolve({ isValid: true, warning: 'Verificação rápida concluída por tempo' });
                } else if (stderr && (stderr.includes('Invalid data found') || stderr.includes('moov atom not found'))) {
                    resolve({ isValid: false, error: stderr.substring(0, 200) });
                } else {
                    resolve({ isValid: true });
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

        // 3. Regra de eliminação para arquivos DUAL AUDIO:
        // Se um dos áudios estiver marcado explicitamente como estrangeiro (eng/spa/etc.) e o outro for 'und' (anônimo)
        const foreignCodes = ['eng', 'spa', 'fra', 'fre', 'deu', 'ger', 'ita', 'rus', 'jpn', 'kor', 'zho', 'chi', 'hin'];
        const foreignIdx = audioStreams.findIndex(s => foreignCodes.includes((s.language || '').toLowerCase()));
        if (foreignIdx !== -1 && audioStreams.length === 2) {
            const ptCandidateIdx = audioStreams.findIndex((s, idx) => idx !== foreignIdx && !foreignCodes.includes((s.language || '').toLowerCase()));
            if (ptCandidateIdx !== -1) {
                return ptCandidateIdx;
            }
        }

        // 4. Regra específica para releases Dual Audio brasileiros com streams anônimos (sem tag de idioma):
        const lowerName = (rawFileName || '').toLowerCase();
        const isBrDualRelease = /yg[^a-z]|\byg$|dual.*yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|kyogo|lipeh|bludv|guanabara|mmfilmes|overdrive|p2p[-_ ]?br/i.test(lowerName);
        const allUndefined = audioStreams.every(s => !s.language || s.language === 'und');

        if (isBrDualRelease && allUndefined && audioStreams.length >= 2) {
            console.log(`🔊 [Dual YG BR] Selecionando trilha ${audioStreams.length - 1} (última) como PT-BR para release: ${rawFileName}`);
            return audioStreams.length - 1;
        }

        // Se o arquivo tiver apenas 1 stream de áudio e for de grupo BR comprovadamente dublado
        if (audioStreams.length === 1) {
            const isBrGroup = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|bludv|guanabara|mmfilmes|filmesmega|overdrive/i.test(lowerName);
            const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);
            if (isBrGroup || isExplicitDublado) {
                return 0;
            }
        }

        return null;
    }

    detectTargetAudioIndex(audioStreams, metadata = {}, rawFileName = '') {
        if (!audioStreams || audioStreams.length === 0) return 0;
        if (audioStreams.length === 1) return 0;

        const isLegendadoOnly = metadata.isLegendado && !metadata.isDublado;
        const targetLang = (metadata.idiomaOriginal || metadata.originalLanguage || (metadata.isDorama ? 'ko' : (metadata.isAnime ? 'ja' : 'en'))).toLowerCase();

        // 1. Se for DUBLADO (ou tiver preferência por dublagem), tenta encontrar a trilha de ÁUDIO em Português
        if (!isLegendadoOnly) {
            const ptIdx = this.detectPortugueseAudioIndex(audioStreams, rawFileName);
            if (ptIdx !== null) return ptIdx;
        }

        // 2. Se for LEGENDADO (ou se o arquivo for em idioma estrangeiro), seleciona O ÁUDIO ORIGINAL EXATO:
        const langMap = {
            'en': ['eng', 'en', 'english', 'inglês', 'ingles'],
            'ko': ['kor', 'ko', 'korean', 'coreano'],
            'ja': ['jpn', 'ja', 'japanese', 'japonês', 'japones'],
            'es': ['spa', 'es', 'spanish', 'espanhol', 'castellano'],
            'fr': ['fra', 'fre', 'fr', 'french', 'francês', 'frances'],
            'de': ['deu', 'ger', 'de', 'german', 'alemão', 'alemao'],
            'it': ['ita', 'it', 'italian', 'italiano'],
            'zh': ['zho', 'chi', 'zh', 'cmn', 'chinese', 'mandarin', 'chinês'],
            'tr': ['tur', 'tr', 'turkish', 'turco'],
            'ru': ['rus', 'ru', 'russian', 'russo']
        };

        const targetKeywords = langMap[targetLang] || [targetLang];

        // A. Busca stream que case exatamente com o idioma original da obra
        for (let i = 0; i < audioStreams.length; i++) {
            const sLang = (audioStreams[i].language || '').toLowerCase();
            const sTitle = (audioStreams[i].title || '').toLowerCase();
            if (targetKeywords.some(k => sLang === k || sTitle.includes(k))) {
                console.log(`🎙️ [Áudio Original: ${targetLang.toUpperCase()}] Selecionada trilha ${i} (${sLang || sTitle || 'original'}) para "${metadata.nome || rawFileName}"`);
                return i;
            }
        }

        // B. Busca stream marcado com 'disposition: original' ou título 'original' / 'vo'
        for (let i = 0; i < audioStreams.length; i++) {
            const sTitle = (audioStreams[i].title || '').toLowerCase();
            if (audioStreams[i].disposition?.original === 1 || sTitle.includes('original') || sTitle.includes(' v.o') || sTitle.includes('vo ')) {
                console.log(`🎙️ [Áudio Original] Selecionada trilha ${i} com disposition original/VO para "${metadata.nome || rawFileName}"`);
                return i;
            }
        }

        // C. Se a série/filme é em inglês (ou fallback ocidental) e há trilha em inglês (eng)
        if (targetLang === 'en' || !langMap[targetLang]) {
            const engIdx = audioStreams.findIndex(s => {
                const l = (s.language || '').toLowerCase();
                const t = (s.title || '').toLowerCase();
                return l === 'eng' || l === 'en' || t.includes('english') || t.includes('inglês');
            });
            if (engIdx !== -1) {
                console.log(`🎙️ [Áudio Original: ENG] Selecionada trilha ${engIdx} em inglês para "${metadata.nome || rawFileName}"`);
                return engIdx;
            }
        }

        // D. Evita trilhas secundárias indesejadas (como comentários de diretor ou audiodescrição) se houver outra trilha principal
        const nonCommentaryIdx = audioStreams.findIndex(s => {
            const t = (s.title || '').toLowerCase();
            return !t.includes('commentary') && !t.includes('comentário') && !t.includes('description') && !t.includes('descrição');
        });
        if (nonCommentaryIdx !== -1) return nonCommentaryIdx;

        return 0;
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

        // 5. Se as faixas de áudio não possuem metadados de idioma (streams anônimos 'und'), verifica o selo brasileiro genuíno no nome do arquivo
        const isBrGroup = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(lowerName);
        const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);

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

        // 1. Áudio Dublado REAL verificado estritamente via ffprobe e tags do arquivo
        const isDublado = this.hasPortugueseAudio(info, rawFileName);

        // 2. Legendas em Português verificadas via ffprobe ou fonte comprovada (ou original para OpenSubtitles)
        const hasPtSubsInFile = this.hasPortugueseSubtitles(info, rawFileName);
        const isLegendado = hasPtSubsInFile || source.isLegendado === true || source.hasPtSub === true || source.isOriginal === true || /\b(legendado|legendas|legenda)\b/i.test(lowerName);

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

        // 1. Padrões característicos de Português de Portugal (PT-PT)
        // Gerúndio substituído por 'a + infinitivo': "estou a falar", "está a fazer", "estava a ver", "estavam a pensar"
        const ptPtGerundRegex = /\b(estou|está|estás|estava|estavam|estávamos|estiver|estiverem|andar|anda|andam|andava|andavam)\s+a\s+([a-z]{3,12}(?:ar|er|ir))\b/gi;
        const ptPtGerundMatches = (content.match(ptPtGerundRegex) || []).length;

        // Conjugações e pronomes específicos de PT-PT
        const ptPtTuRegex = /\btu\s+(estás|tens|queres|vais|sabes|podes|dizes|fazes|ouviste|viste|disseste|fizeste|estiveste|tiveste|consegues|achas|pensas)\b/gi;
        const ptPtTuMatches = (content.match(ptPtTuRegex) || []).length;

        // Vocabulário exclusivo europeu
        const ptPtVocabRegex = /\b(ora bem|pois bem|ó pá\b|pá\b|malta\b|rapariga|raparigas|miúdo|miúdos|miúda|miúdas|comboio|comboios|ecrã|ecrãs|telemóvel|telemóveis|autocarro|autocarros|pequeno-almoço|pequeno almoço|parvalhão|fato\b|facto\b|contacto|aspecto)\b/gi;
        const ptPtVocabMatches = (content.match(ptPtVocabRegex) || []).length;

        const ptPtScore = (ptPtGerundMatches * 4) + (ptPtTuMatches * 3) + (ptPtVocabMatches * 3);

        // 2. Padrões característicos de Português Brasileiro (PT-BR)
        // Gerúndio natural: "estou fazendo", "está vendo", "estavam ouvindo"
        const ptBrGerundRegex = /\b(estou|está|estava|estavam|estávamos)\s+([a-z]{3,12}(?:ando|endo|indo))\b/gi;
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

        if (genericMatches < 8 && ptBrScore < 5) return false;

        // Se houver indícios fortes de Português de Portugal (ex: muitas ocorrências de 'estar a <inf>' ou vocabulário PT-PT superando PT-BR), rejeita!
        if (ptPtScore >= 12 && ptPtScore > ptBrScore) {
            return false;
        }

        // Se tiver gerúndio PT-PT expressivo (>= 3) e nenhum gerúndio PT-BR, é claramente PT-PT
        if (ptPtGerundMatches >= 3 && ptBrGerundMatches === 0) {
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
                        if (this.isBrazilianPortugueseSubtitle(content)) {
                            console.log(`✅ Legenda PT-BR interna [${ptSubStream.title || ptSubStream.language}] extraída e validada linguisticamente como Português Brasileiro (100% Sincronia de Estúdio)!`);
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

        let srtPath = null;

        // Se NÃO possuir áudio em Português (ou for expressamente marcado como apenas legendado),
        // DEVE OBRIGATORIAMENTE obter e queimar/embutir as legendas em Português Brasileiro (PT-BR)
        if (!hasPortugueseAudio || (metadata.isLegendado && !metadata.isDublado)) {
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
        }

        let finalPath;

        // Se for comprovadamente Dublado (e sem necessidade de queimar legendas), faz Remux Rápido quando compatível
        if (hasPortugueseAudio && !metadata.isLegendado && isUnderSizeLimit && isFastCodec && isResolutionFine) {
            console.log(`⚡ [${optTitle}] Vídeo já está em 1080p H.264 compatível (${info.sizeMB} MB). Fazendo Remux Rápido com normalização universal de áudio AAC...`);
            console.log(`🔊 Faixa de áudio selecionada: Stream 0:a:${targetAudioIndex} [${selectedAudioStream?.codec?.toUpperCase()} | ${selectedAudioStream?.channels} canais | lang: ${selectedAudioStream?.language}]`);

            finalPath = await new Promise((resolve, reject) => {
                const remuxArgs = [
                    '-nostdin',
                    '-i', inputPath,
                    '-c:v', 'copy', // Cópia direta do vídeo sem reprocessamento
                    '-map', '0:v:0',
                    '-map', `0:a:${targetAudioIndex}`,
                    '-disposition:a:0', 'default'
                ];

                // Preserva legendas embutidas (PT-BR ou multi-subs) no container MP4
                if (info.subtitleStreams && info.subtitleStreams.length > 0) {
                    remuxArgs.push('-map', '0:s?', '-c:s', 'mov_text');
                }

                const isSimpleAacStereo = selectedAudioStream && 
                    selectedAudioStream.codec === 'aac' && 
                    selectedAudioStream.channels <= 2;

                if (isSimpleAacStereo) {
                    remuxArgs.push('-c:a', 'copy');
                } else {
                    remuxArgs.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000');
                }

                remuxArgs.push('-movflags', '+faststart', '-y', outputPath);

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
                                return this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                            }
                        } catch (e) {
                            return this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                        }
                    } else {
                        process.stdout.write('\n');
                        console.warn(`⚠️ Aviso no remux rápido (código ${code}), prosseguindo para codificação padrão...`);
                        this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                    }
                });
                ffmpeg.on('error', () => {
                    process.stdout.write('\n');
                    this.encodeVideoFull(inputPath, outputPath, info, targetAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                });
            });
        } else {
            finalPath = await this.encodeVideoFull(inputPath, outputPath, info, targetAudioIndex, onProgress, metadata);
        }

        // Limpa arquivo temporário de legenda .srt após a codificação
        if (srtPath && fs.existsSync(srtPath)) {
            await fs.remove(srtPath).catch(() => {});
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
            const os = require('os');
            const cpuCount = os.cpus()?.length || 4;
            // Usa as threads configuradas ou limite seguro de CPU
            const safeThreads = config.FFMPEG_THREADS_PER_JOB || Math.max(2, Math.min(6, Math.floor(cpuCount * 0.50)));

            const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
                ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
                : (metadata.nome || metadata.title || path.basename(inputPath));

            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] Iniciando codificação (Preset: faster, Threads: ${safeThreads}, CRF: 20, Slots ativos: ${activeTranscodes}/${config.MAX_CONCURRENT_TRANSCODES || 2}${metadata.srtPath ? ', Legenda Queimada: SIM' : ''})...\x1b[0m`);
            
            return await new Promise((resolve, reject) => {
                const totalDuration = info.duration || 1;

                const safeMaxMB = (config.VIDEO_MAX_SIZE_BYTES / (1024 * 1024)) || 3950;
                const maxTotalKbps = Math.floor((safeMaxMB * 1024 * 8) / Math.max(1, totalDuration));
                const audioBitrateKbps = 192;
                const maxVideoKbps = Math.max(1500, maxTotalKbps - audioBitrateKbps);

                // Monta filtros de vídeo (Escalonamento 1080p + Legendas Hardsub Profissionais)
                let vfFilter = "scale='min(1920,iw)':-2";
                if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                    const srtEscaped = metadata.srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    vfFilter += `,subtitles='${srtEscaped}':force_style='FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=1.8,Shadow=1,MarginV=32,Alignment=2,Bold=0'`;
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
                    '-c:a', 'aac',
                    '-b:a', `${audioBitrateKbps}k`,
                    '-ac', '2',
                    '-ar', '48000',
                    '-map', '0:v:0',
                    '-map', `0:a:${targetAudioIndex}`,
                    '-disposition:a:0', 'default'
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
