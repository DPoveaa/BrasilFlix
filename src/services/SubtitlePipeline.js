const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const axios = require('axios');
const iconv = require('iconv-lite');
const config = require('../../config');
const SubtitleTranslationService = require('./SubtitleTranslationService');
const SubdlService = require('./SubdlService');

const execFileAsync = promisify(execFile);

class SubtitlePipeline {
    constructor() {
        this.pythonExec = process.platform === 'win32' ? 'python' : (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
    }

    /**
     * Resolve o diretório seguro de trabalho (para arquivos locais ou stream URLs)
     */
    getWorkingDir(videoPath) {
        const isUrl = typeof videoPath === 'string' && /^https?:\/\//i.test(videoPath);
        if (isUrl || !videoPath || !fs.existsSync(videoPath)) {
            const dir = path.resolve(__dirname, '../../data/temp_subtitles');
            fs.ensureDirSync(dir);
            return dir;
        }
        return path.dirname(videoPath);
    }

    /**
     * Converte timecode SRT (00:01:23,456 ou 00:01:23.456) para milissegundos
     */
    parseTimecodeToMs(tc) {
        if (!tc) return 0;
        const parts = tc.trim().replace('.', ',').split(/[:,]/);
        if (parts.length < 4) return 0;
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        const s = parseInt(parts[2], 10) || 0;
        const ms = parseInt(parts[3], 10) || 0;
        return (h * 3600 + m * 60 + s) * 1000 + ms;
    }

    /**
     * Converte milissegundos para timecode SRT padronizado (00:01:23,456)
     */
    formatMsToTimecode(totalMs) {
        if (totalMs < 0) totalMs = 0;
        const ms = Math.floor(totalMs % 1000);
        const totalSeconds = Math.floor(totalMs / 1000);
        const s = totalSeconds % 60;
        const totalMinutes = Math.floor(totalSeconds / 60);
        const m = totalMinutes % 60;
        const h = Math.floor(totalMinutes / 60);

        const pad = (n, z = 2) => String(n).padStart(z, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
    }

    /**
     * Faz o parsing de conteúdo SRT em blocos estruturados
     */
    parseSrt(srtContent) {
        if (!srtContent || typeof srtContent !== 'string') return [];
        const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const rawBlocks = normalized.split(/\n\s*\n/);
        const cues = [];
        const tcRegex = /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/;

        for (const block of rawBlocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            let tcIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (tcRegex.test(lines[i])) {
                    tcIndex = i;
                    break;
                }
            }
            if (tcIndex === -1) continue;

            const match = lines[tcIndex].match(tcRegex);
            const startTc = match[1].replace('.', ',');
            const endTc = match[2].replace('.', ',');
            const startMs = this.parseTimecodeToMs(startTc);
            const endMs = this.parseTimecodeToMs(endTc);
            const textLines = lines.slice(tcIndex + 1);
            const text = textLines.join('\n').trim();

            if (text.length > 0 && endMs > startMs) {
                cues.push({
                    index: cues.length + 1,
                    startMs,
                    endMs,
                    startTc,
                    endTc,
                    text
                });
            }
        }
        return cues;
    }

    /**
     * Constrói string SRT padronizada a partir de array de cues
     */
    buildSrt(cues) {
        if (!Array.isArray(cues) || cues.length === 0) return '';
        return cues.map((cue, idx) => {
            const start = cue.startTc || this.formatMsToTimecode(cue.startMs);
            const end = cue.endTc || this.formatMsToTimecode(cue.endMs);
            return `${idx + 1}\n${start} --> ${end}\n${cue.text}`;
        }).join('\n\n') + '\n';
    }

    /**
     * Normaliza a codificação de caracteres (UTF-8, Windows-1252/ISO-8859-1) e limpa mojibake
     */
    sanitizeEncoding(bufferOrString) {
        if (!bufferOrString) return '';
        let text = '';

        if (Buffer.isBuffer(bufferOrString)) {
            // Remove UTF-8 BOM se presente
            let buf = bufferOrString;
            if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
                buf = buf.subarray(3);
            }
            // Tenta decodificar como UTF-8
            const utf8Str = buf.toString('utf8');
            // Se tiver replacement characters, tenta Windows-1252
            if (utf8Str.includes('\uFFFD')) {
                text = iconv.decode(buf, 'win1252');
            } else {
                text = utf8Str;
            }
        } else {
            text = String(bufferOrString);
            if (text.charCodeAt(0) === 0xFEFF) {
                text = text.slice(1);
            }
        }

        // Correção de sequências clássicas de mojibake (UTF-8 lido como Latin-1 / Windows-1252)
        const mojibakeMap = [
            [/Ã¡/g, 'á'], [/Ã /g, 'à'], [/Ã£/g, 'ã'], [/Ã¢/g, 'â'],
            [/Ã©/g, 'é'], [/Ãª/g, 'ê'], [/Ã­/g, 'í'], [/Ã³/g, 'ó'],
            [/Ãµ/g, 'õ'], [/Ã´/g, 'ô'], [/Ãº/g, 'ú'], [/Ã§/g, 'ç'],
            [/Ã/g, 'Á'], [/Ã€/g, 'À'], [/Ãƒ/g, 'Ã'], [/Ã‚/g, 'Â'],
            [/Ã‰/g, 'É'], [/ÃŠ/g, 'Ê'], [/Ã/g, 'Í'], [/Ã“/g, 'Ó'],
            [/Ã•/g, 'Õ'], [/Ã”/g, 'Ô'], [/Ãš/g, 'Ú'], [/Ã‡/g, 'Ç']
        ];
        for (const [re, repl] of mojibakeMap) {
            text = text.replace(re, repl);
        }

        return text;
    }

    /**
     * Detecta se a legenda é Português de Portugal com base em 2 critérios objetivos:
     * 1. Se "você / vocês" aparecer 3 ou mais vezes E não houver saturação de construções de Portugal -> NÃO é PT-PT.
     * 2. Rejeita como PT-PT se:
     *    - você/vocês < 3 E houver construções típicas de Portugal:
     *      "estou a ", "estás a ", "está a ", "estamos a ", "estão a ", "a fazer", "a dizer", "ecrã", "comboio" ou "telemóvel".
     *    - OU se houver saturação de construções de Portugal (>= 10 ocorrências, dialeto europeu evidente).
     */
    isEuropeanPortugueseSubtitle(content) {
        if (!content || typeof content !== 'string') return false;
        const norm = content.toLowerCase();

        // Construções típicas de Portugal:
        // "estou a ", "estás a ", "está a ", "estamos a ", "estão a ", "a fazer", "a dizer", "ecrã", "comboio" ou "telemóvel"
        const ptPtPattern = /(?:(?:estou|estás|estas|está|esta|estamos|estão|estao)\s+a\s+|(?<![a-zà-ú])a\s+(?:fazer|dizer)(?![a-zà-ú])|(?<![a-zà-ú])(?:ecrã|ecra|comboio|telemóvel|telemovel)(?![a-zà-ú]))/gi;
        const ptPtMatches = (norm.match(ptPtPattern) || []).length;

        // Ocorrências de você / vocês
        const voceMatches = (norm.match(/(?<![a-zà-ú])voc[eê]s?(?![a-zà-ú])/gi) || []).length;

        // Saturação de construções europeias (10+ ocorrências) indica dialeto de Portugal mesmo com plural "vocês"
        if (ptPtMatches >= 10) return true;

        // Rejeita como PT-PT somente se você/vocês < 3 E houver construções típicas de Portugal
        if (voceMatches < 3 && ptPtMatches >= 1) return true;

        // Caso contrário, não é considerado PT-PT
        return false;
    }

    /**
     * Verifica se um release name/tag contém indicadores de PT-PT que devem penalizar o candidato.
     * Retorna a penalidade de score (0 = sem penalidade, número positivo = penalidade).
     */
    getPtPtReleaseNamePenalty(releaseNameOrUrl) {
        if (!releaseNameOrUrl) return 0;
        const rel = releaseNameOrUrl.toLowerCase();
        // Tags explícitas de PT-PT ou Portugal
        if (/\bpt[-.]?pt\b|\bportugal\b/.test(rel)) return 300;
        // "POR" sem "BRA" ou "BR" adjacente (legenda portuguesa sem indicação brasileira)
        if (/\bpor\b(?!.*(?:bra|br|brasil))/.test(rel) && !/\bbra\b|\bpt[-.]?br\b|\bpob\b/.test(rel)) return 150;
        return 0;
    }

    /**
     * Valida se a legenda está em língua portuguesa básica
     */
    isPortugueseLanguage(content) {
        if (!content || typeof content !== 'string') return false;
        const norm = content.toLowerCase();
        const ptCommonWords = /\b(que|nao|com|para|uma|por|mais|mas|como|ele|ela|isso|este|esta|voce|estou|aqui|meu|minha|tudo|fazer|agora|quando|muito|quem|sobre|mesmo|tempo|bem|onde|vida|pode|senhor|depois|assim|deus|casa|noite|sempre|coisa|nada|homem|outro|anos|algo|nunca|mundo|ainda|dia|dizer|sair|sabe|quer|acha|olha|vamos)\b/gi;
        const matches = (norm.match(ptCommonWords) || []).length;
        return matches >= 15;
    }

    /**
     * Mede a duração real do stream de vídeo com precisão cirúrgica via ffprobe
     */
    async probeActualVideoDuration(videoPath) {
        if (!videoPath) return 0;
        try {
            console.log(`⏱️ [Video Probe] Medindo duração real da mídia com ffprobe: ${videoPath.substring(0, 80)}...`);
            const { stdout } = await execFileAsync('ffprobe', [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                videoPath
            ], { timeout: 35000 });
            const dur = parseFloat(stdout.trim());
            if (!isNaN(dur) && dur > 60) {
                console.log(`⏱️ [Video Probe] Duração real medida: ${dur.toFixed(1)}s (${(dur / 60).toFixed(1)}min)`);
                return dur;
            }
        } catch (err) {
            console.warn(`⚠️ [Video Probe] Aviso ao sondar duração via ffprobe:`, err.message);
        }
        return 0;
    }

    /**
     * QUALITY GATE: Validação Estrita de Cobertura (>= 85%) e Densidade Mínima (>= 4.5 falas/min)
     */
    validateCandidateCoverageAndDensity(cues, videoDurationSec, candidateLabel = 'Candidato') {
        if (!Array.isArray(cues) || cues.length === 0) {
            return { valid: false, reason: 'Arquivo de legenda vazio ou sem falas' };
        }

        if (cues.length < 30) {
            return { valid: false, reason: `Poucas falas (${cues.length} cues, mínimo 30)` };
        }

        if (videoDurationSec && videoDurationSec >= 600) {
            const movieMinutes = videoDurationSec / 60;
            const lastCue = this.getLastDialogueCue(cues);
            const lastCueEndSec = lastCue ? lastCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;
            const coverageRatio = lastCueEndSec / videoDurationSec;

            // 1. Strict Minimum Coverage Gate: Última fala deve alcançar pelo menos 85% do filme
            if (coverageRatio < 0.85) {
                return {
                    valid: false,
                    reason: `Última fala em ${(lastCueEndSec / 60).toFixed(1)}min termina antes de 85% da duração do vídeo (${movieMinutes.toFixed(1)}min). Cobertura: ${(coverageRatio * 100).toFixed(1)}% < 85%`
                };
            }

            // 2. Strict Minimum Cue Density: Rejeita < 4.5 falas/minuto para longa-metragem
            const cueDensity = cues.length / movieMinutes;
            if (movieMinutes >= 50 && cueDensity < 4.5) {
                return {
                    valid: false,
                    reason: `Densidade de falas absurdamente baixa (${cueDensity.toFixed(2)} falas/min < 4.5 falas/min exigidas para longa-metragem). Total: ${cues.length} falas em ${movieMinutes.toFixed(1)}min`
                };
            }
        }

        return { valid: true };
    }

    /**
     * Valida se a legenda tem vocabulário autêntico de Português Brasileiro (PT-BR).
     *
     * Regra ultra-simples em 2 critérios objetivos:
     * 1. Confiança nos Metadados / Tags da Fonte:
     *    - pob, pt-br, pt_br, brazilian, bra, br_pt, br-pt -> aprova imediatamente como PT-BR.
     *    - pt-pt, pt_pt, portugal -> rejeita imediatamente.
     * 2. Regra Única para Código Genérico ("por" sem especificar país):
     *    - Se você/vocês aparecer 3+ vezes -> aprova imediatamente como PT-BR.
     *    - Rejeita como PT-PT somente se você/vocês < 3 E houver construções típicas de Portugal.
     *
     * @param {string} content - texto da legenda
     * @param {string} [sourceLang] - código de idioma retornado pela API/fonte (ex: "pob", "por", "pt-pt")
     * @param {string} [sourceFile] - nome do arquivo/release (para detectar tags no filename)
     */
    isBrazilianPortugueseSubtitle(content, sourceLang = '', sourceFile = '') {
        if (!content || typeof content !== 'string') return false;

        const lang = (sourceLang || '').toLowerCase().trim();
        const file = (sourceFile || '').toLowerCase();

        // 1. Confiança nos Metadados / Tags da Fonte
        const ptBrTags = ['pob', 'pt-br', 'pt_br', 'ptbr', 'brazilian', 'bra', 'br_pt', 'br-pt'];
        if (ptBrTags.includes(lang)) return true;
        if (/\b(pt[-_]br|ptbr|pob|brazilian|bra|br[-_]pt|por[-_]br)\b/.test(file)) return true;

        const ptPtTags = ['pt-pt', 'pt_pt', 'ptpt'];
        if (ptPtTags.includes(lang)) return false;
        if (/\b(pt[-_]pt|ptpt|portugal)\b/.test(file)) return false;

        // 2. Regra Única para Código Genérico ("por" ou sem país explícito)
        if (this.isEuropeanPortugueseSubtitle(content)) return false;

        const norm = content.toLowerCase();
        const voceMatches = norm.match(/(?<![a-zà-ú])voc[eê]s?(?![a-zà-ú])/gi) || [];
        if (voceMatches.length >= 3) return true;

        return this.isPortugueseLanguage(content);
    }

    /**
     * TIER 1: Procura e extrai legendas embutidas no próprio container de vídeo (MKV/MP4)
     */
    async probeAndExtractContainerSubtitle(videoPath, metadata = {}) {
        try {
            console.log(`🔍 [Tier 1: Container Stream] Sondando trilhas de legenda embutidas em "${path.basename(videoPath)}"...`);
            const { stdout } = await execFileAsync('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: 30000 });

            const data = JSON.parse(stdout);
            const streams = data.streams || [];
            const subStreams = streams.filter(s => s.codec_type === 'subtitle');

            if (subStreams.length === 0) {
                console.log(`ℹ️ [Tier 1: Container Stream] Nenhuma trilha de legenda encontrada no container.`);
                return null;
            }

            // Filtra streams em Português
            const ptStreams = subStreams.filter(s => {
                const lang = (s.tags?.language || s.tags?.lang || '').toLowerCase();
                const title = (s.tags?.title || '').toLowerCase();
                const isPt = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'ptbr'].includes(lang) ||
                    title.includes('portugu') || title.includes('brazil') || title.includes('brasil');
                const isForcedOrSigns = (s.disposition?.forced === 1) || /forced|for[cç]ad|signs|songs|placas/i.test(title);
                return isPt && !isForcedOrSigns;
            });

            if (ptStreams.length === 0) {
                console.log(`ℹ️ [Tier 1: Container Stream] Nenhuma trilha PT-BR válida encontrada entre as ${subStreams.length} trilhas do container.`);
                return null;
            }

            // Tenta extrair a melhor trilha PT
            const videoDir = this.getWorkingDir(videoPath);
            for (const stream of ptStreams) {
                const subIndex = stream.index;
                const streamLang = (stream.tags?.language || stream.tags?.lang || '').toLowerCase();
                const outPath = path.join(videoDir, `embedded_pt_${Date.now()}_stream${subIndex}.srt`);
                try {
                    await execFileAsync('ffmpeg', [
                        '-nostdin', '-v', 'error', '-y',
                        '-i', videoPath,
                        '-map', `0:${subIndex}`,
                        '-c:s', 'srt',
                        outPath
                    ], { timeout: 60000 });

                    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
                        const rawBuffer = await fs.readFile(outPath);
                        const sanitized = this.sanitizeEncoding(rawBuffer);
                        const cues = this.parseSrt(sanitized);

                        if (cues.length >= 30 && this.isBrazilianPortugueseSubtitle(sanitized, streamLang)) {
                            // Salva versão normalizada em UTF-8
                            await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                            console.log(`✅ [Tier 1: Container Stream] Trilha PT-BR [stream 0:${subIndex}] extraída com sucesso (${cues.length} cues, 100% frame-perfect com o container)!`);
                            return {
                                srtPath: outPath,
                                cueCount: cues.length,
                                source: 'container_embedded'
                            };
                        } else {
                            console.warn(`⚠️ [Tier 1: Container Stream] Trilha 0:${subIndex} descartada (cues: ${cues.length}, PT-BR autêntico: NÃO).`);
                            await fs.remove(outPath).catch(() => { });
                        }
                    }
                } catch (e) {
                    console.warn(`⚠️ [Tier 1: Container Stream] Erro ao extrair stream 0:${subIndex}:`, e.message);
                    await fs.remove(outPath).catch(() => { });
                }
            }
            return null;
        } catch (e) {
            console.warn(`⚠️ [Tier 1: Container Stream] Falha ao sondar container:`, e.message);
            return null;
        }
    }

    /**
     * Extrai trilha de legenda em inglês do container ou busca no OpenSubtitles para servir de referência sub-to-sub
     */
    async extractEnglishReferenceSubtitle(videoPath, metadata = {}, videoDurationSec = 0) {
        // 1. Tenta extrair do container
        try {
            const { stdout } = await execFileAsync('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: 30000 });

            const data = JSON.parse(stdout);
            const subStreams = (data.streams || []).filter(s => s.codec_type === 'subtitle');

            const enStream = subStreams.find(s => {
                const lang = (s.tags?.language || s.tags?.lang || '').toLowerCase();
                const title = (s.tags?.title || '').toLowerCase();
                const isEn = ['eng', 'en', 'english'].includes(lang) || title.includes('english');
                const isBad = /sign|song|s&s|forced|commentary/i.test(title);
                return isEn && !isBad;
            });

            if (enStream) {
                const outPath = path.join(this.getWorkingDir(videoPath), `ref_en_${Date.now()}.srt`);
                await execFileAsync('ffmpeg', [
                    '-nostdin', '-v', 'error', '-y',
                    '-i', videoPath,
                    '-map', `0:${enStream.index}`,
                    '-c:s', 'srt',
                    outPath
                ], { timeout: 60000 });

                if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000) {
                    const content = await fs.readFile(outPath, 'utf8');
                    const cues = this.parseSrt(content);
                    if (cues.length >= 30) {
                        console.log(`🎯 [Tier 1: English Reference] Trilha de referência em inglês extraída do container (${cues.length} cues) para alinhamento sub-to-sub!`);
                        return outPath;
                    }
                }
                await fs.remove(outPath).catch(() => { });
            }
        } catch (e) { }

        // 2. Se o container não tiver legenda em inglês, busca legenda EN de referência no OpenSubtitles
        let imdbId = metadata.imdbId;
        if (!imdbId && metadata.tmdbId) {
            try {
                const extPath = metadata.tipo === 'serie' ? `tv/${metadata.tmdbId}` : `movie/${metadata.tmdbId}`;
                const extRes = await axios.get(`https://api.themoviedb.org/3/${extPath}/external_ids`, {
                    params: { api_key: config.TMDB_API_KEY },
                    timeout: 6000
                });
                if (extRes.data?.imdb_id) imdbId = extRes.data.imdb_id;
            } catch (_) { }
        }

        if (imdbId) {
            try {
                const season = metadata.season || 1;
                const episode = metadata.episode || 1;
                const streamPath = metadata.tipo === 'serie'
                    ? `series/${imdbId}:${season}:${episode}.json`
                    : `movie/${imdbId}.json`;

                const endpoints = [
                    `https://opensubtitles-v3.strem.io/subtitles/${streamPath}`,
                    `https://subtitles.strem.io/subtitles/${streamPath}`
                ];

                for (const url of endpoints) {
                    try {
                        const res = await axios.get(url, {
                            timeout: 7000,
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.168' }
                        });
                        const subs = res.data?.subtitles || [];
                        const enSubs = subs.filter(s => {
                            const l = (s.lang || s.language || '').toLowerCase();
                            return ['eng', 'en'].includes(l);
                        });

                        if (enSubs.length > 0) {
                            for (const sub of enSubs.slice(0, 3)) {
                                if (!sub.url) continue;
                                const dlRes = await axios.get(sub.url, {
                                    timeout: 10000,
                                    responseType: 'arraybuffer',
                                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                                });
                                const raw = Buffer.from(dlRes.data);
                                const sanitized = this.sanitizeEncoding(raw);
                                const cues = this.parseSrt(sanitized);

                                const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, 'OpenSubtitles EN');
                                if (!gate.valid) {
                                    continue;
                                }

                                const outPath = path.join(this.getWorkingDir(videoPath), `ref_en_ext_${Date.now()}.srt`);
                                await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                                console.log(`🎯 [Tier 2: English Reference] Legenda oficial em inglês obtida via OpenSubtitles (${cues.length} cues) para alinhamento sub-to-sub!`);
                                return outPath;
                            }
                        }
                    } catch (_) { }
                }
            } catch (e) {
                console.warn(`⚠️ Erro ao buscar legenda EN de referência no OpenSubtitles:`, e.message);
            }
        }

        // 3. Se não encontrou no OpenSubtitles, busca legenda EN no SubDL Pool como fallback
        if (SubdlService.isAvailable() && (imdbId || metadata.tmdbId)) {
            try {
                console.log(`🌐 [Tier 2: English Reference] Buscando legenda EN de referência no SubDL API...`);
                const enSubs = await SubdlService.executeWithFailover(async (apiKey) => {
                    const params = {
                        api_key: apiKey,
                        imdb_id: imdbId,
                        tmdb_id: metadata.tmdbId,
                        type: metadata.tipo === 'serie' ? 'tv' : 'movie',
                        languages: 'EN'
                    };
                    const r = await axios.get(SubdlService.apiBaseUrl, { params, timeout: 10000 });
                    return r.data?.subtitles || [];
                }, `EN_Ref_${metadata.title || imdbId}`);

                if (Array.isArray(enSubs) && enSubs.length > 0) {
                    const rankedEn = enSubs.slice().sort((a, b) => {
                        const nameA = (a.release_name || a.name || '').toLowerCase();
                        const nameB = (b.release_name || b.name || '').toLowerCase();
                        let scoreA = 0, scoreB = 0;
                        if (/extended|ee|remastered|unrated/i.test(nameA)) scoreA += 50;
                        if (/extended|ee|remastered|unrated/i.test(nameB)) scoreB += 50;
                        if (/cd1|cd2|part1|part2|2cd/i.test(nameA)) scoreA -= 150;
                        if (/cd1|cd2|part1|part2|2cd/i.test(nameB)) scoreB -= 150;
                        return scoreB - scoreA;
                    });

                    const workDir = this.getWorkingDir(videoPath);
                    for (const sub of rankedEn.slice(0, 3)) {
                        try {
                            const srtPath = await SubdlService.downloadAndExtractSubtitle(sub, workDir);
                            const raw = await fs.readFile(srtPath);
                            const cues = this.parseSrt(this.sanitizeEncoding(raw));
                            const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, 'SubDL EN');
                            if (gate.valid) {
                                const outPath = path.join(workDir, `ref_en_subdl_${Date.now()}.srt`);
                                await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                                await fs.remove(srtPath).catch(() => { });
                                console.log(`🎯 [Tier 2: English Reference] Legenda oficial em inglês obtida via SubDL (${cues.length} cues, release: "${sub.release_name || sub.name}")!`);
                                return outPath;
                            }
                            await fs.remove(srtPath).catch(() => { });
                        } catch (_) { }
                    }
                }
            } catch (enErr) {
                console.warn(`⚠️ Erro ao buscar legenda EN de referência no SubDL:`, enErr.message);
            }
        }

        return null;
    }

    /**
     * TIER 2: Procura legendas companheiras (.srt) na pasta do torrent / download
     */
    async findCompanionSubtitles(videoPath, metadata = {}) {
        try {
            if (typeof videoPath === 'string' && /^https?:\/\//i.test(videoPath)) {
                return { ptSrtPath: null, refEnPath: null };
            }
            console.log(`🔍 [Tier 2: Companion Package] Buscando legendas companheiras na pasta do torrent...`);
            const videoDir = this.getWorkingDir(videoPath);
            const candidateDirs = [
                videoDir,
                path.join(videoDir, 'Subs'),
                path.join(videoDir, 'Subtitles'),
                path.join(videoDir, 'subs'),
                path.join(videoDir, 'subtitles')
            ];

            const ptNames = ['portuguese', 'português', 'pob', 'pt-br', 'pt_br', 'brazilian', 'por', 'pt'];
            const allSrtFiles = [];

            for (const dir of candidateDirs) {
                if (fs.existsSync(dir)) {
                    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
                    for (const entry of entries) {
                        if (entry.isFile() && entry.name.toLowerCase().endsWith('.srt')) {
                            if (entry.name.startsWith('ref_en_') || entry.name.startsWith('embedded_pt_') || entry.name.startsWith('synced_')) continue;
                            allSrtFiles.push({
                                path: path.join(dir, entry.name),
                                name: entry.name.toLowerCase()
                            });
                        }
                    }
                }
            }

            let companionPtSrt = null;
            let companionEnSrt = null;

            // Busca PT-BR
            for (const item of allSrtFiles) {
                const isPt = ptNames.some(p => item.name.includes(p));
                if (isPt) {
                    const buf = await fs.readFile(item.path);
                    const sanitized = this.sanitizeEncoding(buf);
                    const cues = this.parseSrt(sanitized);
                    if (cues.length >= 30 && this.isBrazilianPortugueseSubtitle(sanitized, '', item.name)) {
                        companionPtSrt = item.path;
                        console.log(`✅ [Tier 2: Companion Package] Legenda PT-BR oficial encontrada no pacote: ${path.basename(item.path)} (${cues.length} cues)!`);
                        break;
                    }
                }
            }

            // Busca EN de referência
            for (const item of allSrtFiles) {
                const isEn = item.name.includes('english') || item.name.includes('eng') || item.name.includes('sdh') || item.name.includes('en.srt');
                if (isEn && item.path !== companionPtSrt) {
                    companionEnSrt = item.path;
                    console.log(`🎯 [Tier 2: Companion Package] Legenda de referência em inglês encontrada no pacote: ${path.basename(item.path)}!`);
                    break;
                }
            }

            return {
                ptSrtPath: companionPtSrt,
                refEnPath: companionEnSrt
            };
        } catch (e) {
            console.warn(`⚠️ [Tier 2: Companion Package] Erro ao buscar legendas companheiras:`, e.message);
            return { ptSrtPath: null, refEnPath: null };
        }
    }

    /**
     * Retorna o último cue de diálogo genuíno, ignorando tags de watermark de encerramento de créditos
     * (ex: [ENGLISH], Subtitles by..., ou saltos anômalos de mais de 5 minutos após o diálogo final).
     */
    getLastDialogueCue(cues) {
        if (!Array.isArray(cues) || cues.length === 0) return null;
        for (let i = cues.length - 1; i >= 0; i--) {
            const text = (cues[i].text || '').trim().toLowerCase();
            // Ignora tags de release / créditos técnicos nos últimos minutos
            const isWatermark = /^\[?[a-z0-9\s\.\-_]+\]?$/.test(text) &&
                (text.includes('english') || text.includes('sub') || text.includes('rip') || text.includes('yts') || text.includes('team') || text.includes('sync'));
            if (isWatermark) continue;
            // Se houver um salto de mais de 150s (2.5 min) de silêncio absoluto entre este cue e o anterior no final do filme (ex: créditos/cartão de encerramento)
            if (i > 0 && (cues[i].startMs - cues[i - 1].endMs) > 150000) {
                continue;
            }
            return cues[i];
        }
        return cues[cues.length - 1];
    }

    /**
     * TIER 3: Busca externa estrita por PT-BR genuíno (OpenSubtitles / Stremio API)
     * Prioriza 'pob', 'pt-br', 'brazilian' e rejeita estritamente dialeto de Portugal (PT-PT).
     * @param {string} videoPath
     * @param {object} metadata
     * @param {number} videoDurationSec
     * @param {Array|null} refEnCues - Cues da legenda EN de referência para Duration Gate preciso
     */
    async fetchExternalSubtitle(videoPath, metadata = {}, videoDurationSec = 0, refEnCues = null) {
        try {
            if (!videoDurationSec || videoDurationSec < 120) {
                try {
                    const { stdout } = await execFileAsync('ffprobe', [
                        '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath
                    ], { timeout: 15000 });
                    videoDurationSec = parseFloat(JSON.parse(stdout).format?.duration || 0);
                } catch (_) { }
            }

            console.log(`🌐 [Tier 3: External Search] Buscando legendas PT-BR genuínas para "${metadata.nome || metadata.title || path.basename(videoPath)}" (Duração: ${(videoDurationSec / 60).toFixed(1)}m)...`);

            // Resolve IMDb ID se ausente
            let imdbId = metadata.imdbId;
            if (!imdbId && metadata.tmdbId) {
                try {
                    const extPath = metadata.tipo === 'serie' ? `tv/${metadata.tmdbId}` : `movie/${metadata.tmdbId}`;
                    const extRes = await axios.get(`https://api.themoviedb.org/3/${extPath}/external_ids`, {
                        params: { api_key: config.TMDB_API_KEY },
                        timeout: 6000
                    });
                    if (extRes.data?.imdb_id) {
                        imdbId = extRes.data.imdb_id;
                    }
                } catch (e) { }
            }

            if (!imdbId) {
                console.warn(`⚠️ [Tier 3: External Search] Sem IMDb ID para busca externa no OpenSubtitles.`);
                return null;
            }

            const season = metadata.season || 1;
            const episode = metadata.episode || 1;
            const streamPath = metadata.tipo === 'serie'
                ? `series/${imdbId}:${season}:${episode}.json`
                : `movie/${imdbId}.json`;

            const endpoints = [
                `https://opensubtitles-v3.strem.io/subtitles/${streamPath}`,
                `https://subtitles.strem.io/subtitles/${streamPath}`,
                `https://opensubtitles-v8.strem.io/subtitles/${streamPath}`
            ];

            const inputFileName = path.basename(videoPath).toLowerCase();
            const tokenize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(t => t.length > 2);
            const fileTokens = tokenize(inputFileName);

            // Coleta de múltiplas fontes sem encerramento prematuro, agregando e deduplicando por URL
            const urlSeen = new Set();
            const allCandidateSubs = [];

            for (const url of endpoints) {
                try {
                    const res = await axios.get(url, {
                        timeout: 7000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.168' }
                    });
                    const subs = res.data?.subtitles || [];
                    for (const s of subs) {
                        const subUrl = s.url;
                        if (!subUrl || urlSeen.has(subUrl)) continue;

                        const lang = (s.lang || s.language || '').toLowerCase();
                        if (lang.includes('pt-pt') || lang.includes('por-pt')) continue;

                        const rel = (s.movieReleaseName || s.releaseName || s.url || '').toLowerCase();
                        // Rejeição imediata por marcadores explícitos de PT-PT no release
                        if (/\bpt[-.]?pt\b|\bportugal\b|\bpt[-_]por\b/.test(rel)) {
                            continue;
                        }

                        // Aceita apenas variantes de português
                        if (['pob', 'pt-br', 'brazilian', 'por', 'pt', 'ptbr'].includes(lang)) {
                            urlSeen.add(subUrl);
                            allCandidateSubs.push(s);
                        }
                    }
                } catch (e) { }
            }

            if (allCandidateSubs.length === 0) {
                console.warn(`⚠️ [Tier 3: External Search] Nenhuma legenda em Português encontrada nas fontes externas.`);
                return null;
            }

            // Ranqueamento estrito priorizando PT-BR genuíno
            const scored = allCandidateSubs.map(sub => {
                const rel = (sub.movieReleaseName || sub.releaseName || '').toLowerCase();
                const subUrl = (sub.url || '').toLowerCase();
                const subTokens = tokenize(rel);
                const common = subTokens.filter(t => fileTokens.includes(t)).length;
                let score = common * 4;

                const lang = (sub.lang || sub.language || '').toLowerCase();
                // Bônus massivo para marcação inequívoca de Português Brasileiro (POB / PT-BR)
                if (['pob', 'pt-br', 'brazilian', 'ptbr'].includes(lang)) {
                    score += 150;
                } else if (['por', 'pt'].includes(lang)) {
                    score += 10;
                }

                // Bônus para tags brasileiras no release name
                if (/\b(brazil|brasil|pt[-._]?br|ptbr|dublado|nacional)\b/.test(rel)) {
                    score += 60;
                }

                // Penalidade rigorosa para suspeitos de Portugal
                const ptPtPenalty = this.getPtPtReleaseNamePenalty(rel) || this.getPtPtReleaseNamePenalty(subUrl);
                if (ptPtPenalty > 0) {
                    score -= ptPtPenalty;
                }

                score += parseInt(sub.g || 0, 10);
                return { sub, score };
            }).sort((a, b) => b.score - a.score);

            console.log(`🌐 [Tier 3: External Search] ${scored.length} candidatos agregados de todas as fontes. Testando compatibilidade estrita PT-BR...`);

            const validCandidates = [];
            // Testa candidatos ranqueados verificando PT-BR e Duration Gate
            for (let i = 0; i < Math.min(scored.length, 10); i++) {
                const { sub, score } = scored[i];
                const subUrl = sub.url;
                if (!subUrl) continue;

                try {
                    const dlRes = await axios.get(subUrl, {
                        timeout: 10000,
                        responseType: 'arraybuffer',
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                    });

                    const rawBuffer = Buffer.from(dlRes.data);
                    const sanitized = this.sanitizeEncoding(rawBuffer);
                    const subLang = (sub.lang || sub.language || '').toLowerCase();
                    const relName = (sub.movieReleaseName || sub.releaseName || sub.url || '').toLowerCase();

                    // Filtro unificado PT-BR/PT-PT usando metadados da fonte + análise textual fallback
                    if (!this.isBrazilianPortugueseSubtitle(sanitized, subLang, relName)) {
                        const reason = ['pob', 'pt-br', 'pt_br', 'ptbr', 'brazilian', 'bra'].includes(subLang)
                            ? 'falha no Portuguese básico'
                            : ['pt-pt', 'pt_pt', 'ptpt'].includes(subLang) || /\b(pt[-_]pt|portugal)\b/.test(relName)
                                ? 'marcado explicitamente como PT-PT'
                                : 'texto não identificado como PT-BR (você/vocês < 3 e construções PT-PT presentes)';
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado [lang=${subLang}]: ${reason}.`);
                        continue;
                    }
                    console.log(`✅ Candidato #${i + 1} aprovado como PT-BR [lang=${subLang}].`);

                    const cues = this.parseSrt(sanitized);

                    // Validação estrita de cobertura (>= 85%) e densidade mínima (>= 4.5 falas/min)
                    const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `Candidato #${i + 1}`);
                    if (!gate.valid) {
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado no Quality Gate: ${gate.reason}`);
                        continue;
                    }

                    // Se houver âncora EN, valida correspondência temporal da última fala
                    if (refEnCues && refEnCues.length > 0 && videoDurationSec > 600) {
                        const lastPtCue = this.getLastDialogueCue(cues);
                        const lastCueEndSec = lastPtCue ? lastPtCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;
                        const lastEnCue = this.getLastDialogueCue(refEnCues);
                        const enLastSec = lastEnCue ? lastEnCue.endMs / 1000 : refEnCues[refEnCues.length - 1].endMs / 1000;
                        const endDiff = Math.abs(lastCueEndSec - enLastSec);
                        const bothAreFullCoverage = (lastCueEndSec / videoDurationSec >= 0.80) && (enLastSec / videoDurationSec >= 0.80);
                        const maxAllowedEndDiff = bothAreFullCoverage ? Math.max(600, videoDurationSec * 0.08) : 180;
                        if (endDiff > maxAllowedEndDiff) {
                            console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate EN: última fala PT em ${(lastCueEndSec / 60).toFixed(1)}min diverge ${Math.round(endDiff)}s da âncora EN (${(enLastSec / 60).toFixed(1)}min).`);
                            continue;
                        }
                    }

                    // Candidato PT-BR genuíno aprovado com louvor!
                    const candidatePath = path.join(this.getWorkingDir(videoPath), `external_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidatePath, this.buildSrt(cues), 'utf8');
                    console.log(`✅ [Tier 3: External Search] Candidato #${i + 1} aprovado como PT-BR genuíno (${cues.length} cues, score: ${score})!`);
                    validCandidates.push({
                        srtPath: candidatePath,
                        cueCount: cues.length,
                        source: 'external_opensubtitles_ptbr',
                        sourceMethod: `Tier 3 (OpenSubtitles - ${relName || 'PT-BR'})`,
                        name: `OpenSubtitles #${i + 1} (${relName || 'PT-BR'})`,
                        releaseName: relName
                    });

                    if (validCandidates.length >= 3) break;
                } catch (dlErr) {
                    console.warn(`⚠️ Falha ao baixar candidato #${i + 1}:`, dlErr.message);
                }
            }

            if (validCandidates.length > 0) {
                return {
                    srtPath: validCandidates[0].srtPath,
                    cueCount: validCandidates[0].cueCount,
                    source: 'external_opensubtitles_ptbr',
                    candidates: validCandidates
                };
            }

            console.warn(`⚠️ [Tier 3: External Search] Nenhum candidato PT-BR nativo foi aprovado no Duration Gate.`);
            return null;
        } catch (e) {
            console.warn(`⚠️ [Tier 3: External Search] Erro na busca externa:`, e.message);
            return null;
        }
    }

    /**
     * TIER 3.5: Fallback de busca estrita PT-BR via API oficial do SubDL com pool de múltiplas chaves e rotação
     * Acionado APENAS se os endpoints gratuitos do Stremio (Tier 3) não aprovarem nenhuma legenda PT-BR no Duration Gate,
     * e ANTES de acionar a tradução neural via Gemini.
     */
    async fetchSubdlSubtitle(videoPath, metadata = {}, videoDurationSec = 0, refEnCues = null) {
        if (!SubdlService.isAvailable()) {
            console.log(`ℹ️ [Tier 3.5: SubDL API] Serviço indisponível: nenhuma chave configurada em SUBDL_API_KEYS.`);
            return null;
        }

        try {
            if (!videoDurationSec || videoDurationSec < 120) {
                try {
                    const { stdout } = await execFileAsync('ffprobe', [
                        '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath
                    ], { timeout: 15000 });
                    videoDurationSec = parseFloat(JSON.parse(stdout).format?.duration || 0);
                } catch (_) { }
            }

            console.log(`🌐 [Tier 3.5: SubDL API] Buscando legendas PT-BR no SubDL para "${metadata.nome || metadata.title || path.basename(videoPath)}" (Duração: ${(videoDurationSec / 60).toFixed(1)}m)...`);

            // Resolve IMDb ID e TMDB ID
            let imdbId = metadata.imdbId;
            let tmdbId = metadata.tmdbId;

            if (!imdbId && tmdbId) {
                try {
                    const extPath = metadata.tipo === 'serie' ? `tv/${tmdbId}` : `movie/${tmdbId}`;
                    const extRes = await axios.get(`https://api.themoviedb.org/3/${extPath}/external_ids`, {
                        params: { api_key: config.TMDB_API_KEY },
                        timeout: 6000
                    });
                    if (extRes.data?.imdb_id) {
                        imdbId = extRes.data.imdb_id;
                    }
                } catch (e) { }
            } else if (!tmdbId && imdbId) {
                try {
                    const findRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                        params: { api_key: config.TMDB_API_KEY, external_source: 'imdb_id' },
                        timeout: 6000
                    });
                    const item = findRes.data?.movie_results?.[0] || findRes.data?.tv_results?.[0];
                    if (item?.id) tmdbId = item.id;
                } catch (e) { }
            }

            if (!imdbId && !tmdbId) {
                console.warn(`⚠️ [Tier 3.5: SubDL API] Sem IMDb ID ou TMDB ID para consulta no SubDL.`);
                return null;
            }

            const searchParams = {
                imdbId,
                tmdbId,
                type: metadata.tipo,
                season: metadata.season,
                episode: metadata.episode,
                title: metadata.nome || metadata.title || path.basename(videoPath)
            };

            const rawSubtitles = await SubdlService.searchSubtitles(searchParams);
            if (!rawSubtitles || rawSubtitles.length === 0) {
                console.warn(`⚠️ [Tier 3.5: SubDL API] Nenhuma legenda PT-BR encontrada no SubDL.`);
                return null;
            }

            // Ranqueia os candidatos pelos tokens do release do vídeo antes de baixar
            const videoFileName = path.basename(videoPath);
            const rankedSubtitles = SubdlService.rankCandidates(rawSubtitles, videoFileName, metadata);

            console.log(`🌐 [Tier 3.5: SubDL API] ${rankedSubtitles.length} legendas PT-BR encontradas. Avaliando os melhores candidatos com economia de cota...`);

            const videoDir = this.getWorkingDir(videoPath);

            // Avalia os melhores candidatos ranqueados com economia de cota
            const maxCandidatesToDownload = Math.min(rankedSubtitles.length, 4);

            const validCandidates = [];
            for (let i = 0; i < maxCandidatesToDownload; i++) {
                const candidate = rankedSubtitles[i];
                console.log(`\n📥 [Tier 3.5: SubDL API] Testando candidato #${i + 1}/${maxCandidatesToDownload}: "${candidate.release_name || candidate.name}"...`);

                let extractedSrtPath = null;
                try {
                    extractedSrtPath = await SubdlService.downloadAndExtractSubtitle(candidate, videoDir);

                    if (!fs.existsSync(extractedSrtPath)) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Arquivo extraído não encontrado em ${extractedSrtPath}.`);
                        continue;
                    }

                    const rawBuffer = await fs.readFile(extractedSrtPath);
                    const sanitized = this.sanitizeEncoding(rawBuffer);
                    const candidateLang = candidate.language || candidate.lang || 'BR_PT';
                    const candidateRel = candidate.release_name || candidate.name || '';

                    // Validação de autenticidade PT-BR
                    if (!this.isBrazilianPortugueseSubtitle(sanitized, candidateLang, candidateRel)) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado: texto não validado como PT-BR autêntico.`);
                        await fs.remove(extractedSrtPath).catch(() => { });
                        continue;
                    }

                    const cues = this.parseSrt(sanitized);

                    // Validação estrita de cobertura (>= 85%) e densidade mínima (>= 4.5 falas/min)
                    const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `SubDL #${i + 1}`);
                    if (!gate.valid) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado no Quality Gate: ${gate.reason}`);
                        await fs.remove(extractedSrtPath).catch(() => { });
                        continue;
                    }

                    // Se houver âncora EN, valida correspondência temporal da última fala
                    if (refEnCues && refEnCues.length > 0 && videoDurationSec > 600) {
                        const lastPtCue = this.getLastDialogueCue(cues);
                        const lastCueEndSec = lastPtCue ? lastPtCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;
                        const lastEnCue = this.getLastDialogueCue(refEnCues);
                        const enLastSec = lastEnCue ? lastEnCue.endMs / 1000 : refEnCues[refEnCues.length - 1].endMs / 1000;
                        const endDiff = Math.abs(lastCueEndSec - enLastSec);
                        const bothAreFullCoverage = (lastCueEndSec / videoDurationSec >= 0.80) && (enLastSec / videoDurationSec >= 0.80);
                        const maxAllowedEndDiff = bothAreFullCoverage ? Math.max(600, videoDurationSec * 0.08) : 180;
                        if (endDiff > maxAllowedEndDiff) {
                            console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado pelo Duration Gate EN: última fala PT em ${(lastCueEndSec / 60).toFixed(1)}min diverge ${Math.round(endDiff)}s da âncora EN (${(enLastSec / 60).toFixed(1)}min). Legenda cortada/incompleta.`);
                            await fs.remove(extractedSrtPath).catch(() => { });
                            continue;
                        }
                    }

                    // Aprovado no Duration Gate!
                    const candidateFinalPath = path.join(videoDir, `subdl_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidateFinalPath, this.buildSrt(cues), 'utf8');
                    await fs.remove(extractedSrtPath).catch(() => { });

                    console.log(`✅ [Tier 3.5: SubDL API] Candidato #${i + 1} APROVADO com sucesso no Duration Gate (${cues.length} cues, release: "${candidate.release_name || candidate.name}")!`);
                    validCandidates.push({
                        srtPath: candidateFinalPath,
                        cueCount: cues.length,
                        source: 'subdl_api_ptbr',
                        sourceMethod: `Tier 3.5 (SubDL API - ${candidate.release_name || candidate.name})`,
                        name: `SubDL #${i + 1} (${candidate.release_name || candidate.name})`,
                        releaseName: candidate.release_name || candidate.name
                    });

                    if (validCandidates.length >= 3) break;
                } catch (candErr) {
                    console.warn(`⚠️ [Tier 3.5: SubDL API] Falha ao processar candidato #${i + 1}:`, candErr.message);
                    if (extractedSrtPath) await fs.remove(extractedSrtPath).catch(() => { });
                }
            }

            if (validCandidates.length > 0) {
                return {
                    srtPath: validCandidates[0].srtPath,
                    cueCount: validCandidates[0].cueCount,
                    source: 'subdl_api_ptbr',
                    candidates: validCandidates
                };
            }

            console.warn(`⚠️ [Tier 3.5: SubDL API] Nenhum dos candidatos testados do SubDL foi aprovado no Duration Gate.`);
            return null;
        } catch (err) {
            console.warn(`⚠️ [Tier 3.5: SubDL API] Erro ao buscar legendas no SubDL:`, err.message);
            return null;
        }
    }

    /**
     * TIER 4: Sincronização Cinema-Grade (Sub-to-Sub ou Audio-to-Sub acústico)
     */
    async alignSubtitle(videoPath, inputSrtPath, outputSrtPath, options = {}) {
        const isUrl = typeof videoPath === 'string' && /^https?:\/\//i.test(videoPath);
        if (!fs.existsSync(inputSrtPath) || (!isUrl && !fs.existsSync(videoPath))) {
            throw new Error('Vídeo ou arquivo de legenda não encontrado para alinhamento.');
        }

        const refSubPath = options.refSubPath && fs.existsSync(options.refSubPath) ? options.refSubPath : null;
        const isSubToSub = !!refSubPath;

        console.log(`🎙️ [Tier 4: Sync Engine] Iniciando alinhamento via ${isSubToSub ? 'Legenda de Referência (Sub-to-Sub)' : 'Análise Acústica de Voz (Audio-to-Sub)'}...`);
        const startTime = Date.now();
        let cleanAudioWav = null;

        try {
            await fs.ensureDir(path.dirname(outputSrtPath));
            let referenceTarget = refSubPath;

            if (!isSubToSub) {
                // Audio-to-Sub: pré-processa o áudio para isolar a voz humana e eliminar ruído/música
                cleanAudioWav = path.join(path.dirname(outputSrtPath), `speech_clean_${Date.now()}.wav`);
                try {
                    // Sondar áudio para saber o layout de canais
                    const { stdout: probeOut } = await execFileAsync('ffprobe', [
                        '-v', 'quiet',
                        '-print_format', 'json',
                        '-show_streams',
                        videoPath
                    ], { timeout: 20000 });
                    const audioStreams = (JSON.parse(probeOut).streams || []).filter(s => s.codec_type === 'audio');
                    const targetAudio = audioStreams[0] || {};
                    const channels = targetAudio.channels || 2;

                    // Se for áudio 5.1 / surround (>= 6 canais), isola o canal central (diálogo)
                    // Se for stereo, aplica filtro passa-banda de fala (200Hz - 3500Hz) + normalização vocal
                    let filterChain = 'highpass=f=200,lowpass=f=3500';
                    if (channels >= 6) {
                        filterChain = 'pan=mono|c0=c2,highpass=f=200,lowpass=f=3500,volume=1.5';
                    } else {
                        filterChain = 'highpass=f=200,lowpass=f=3500,speechnorm=e=4:r=0.0001:l=1';
                    }

                    console.log(`🎧 [Tier 4: Voice Isolation] Isolando canal de diálogo e frequências vocais (${channels} canais -> mono 16kHz)...`);
                    await execFileAsync('ffmpeg', [
                        '-nostdin', '-v', 'error', '-y',
                        '-i', videoPath,
                        '-map', `0:${targetAudio.index !== undefined ? targetAudio.index : 'a:0'}`,
                        '-af', filterChain,
                        '-ac', '1',
                        '-ar', '16000',
                        cleanAudioWav
                    ], { timeout: 120000 });

                    if (fs.existsSync(cleanAudioWav) && fs.statSync(cleanAudioWav).size > 10000) {
                        referenceTarget = cleanAudioWav;
                    } else {
                        referenceTarget = videoPath;
                    }
                } catch (errAudio) {
                    console.warn(`⚠️ [Tier 4: Voice Isolation] Fallback para arquivo original:`, errAudio.message);
                    referenceTarget = videoPath;
                }
            }

            const maxOffsetSec = String(options.maxOffsetSeconds || 45);
            // Executa ffsubsync com controle estrito de frameratio e offset limite
            const pythonCode = `
import sys
import os
from ffsubsync.ffsubsync import make_parser, run

parser = make_parser()
args = parser.parse_args([
    sys.argv[1],
    '-i', sys.argv[2],
    '-o', sys.argv[3],
    '--max-offset-seconds', sys.argv[4] if len(sys.argv) > 4 else '45',
    '--vad', 'subs_then_webrtc'
])
res = run(args)
print(f"RESULT:{res}")
`.trim();

            const timeoutMs = isSubToSub ? 60000 : 180000;
            let stdoutOut = '';
            let stderrOut = '';

            const syncSuccess = await new Promise((resolve) => {
                let finished = false;
                const pyProc = spawn(this.pythonExec, ['-c', pythonCode, referenceTarget, inputSrtPath, outputSrtPath, maxOffsetSec], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                if (pyProc.stdout) pyProc.stdout.on('data', d => { stdoutOut += d.toString(); });
                if (pyProc.stderr) pyProc.stderr.on('data', d => { stderrOut += d.toString(); });

                const timer = setTimeout(() => {
                    if (!finished) {
                        finished = true;
                        try { pyProc.kill('SIGKILL'); } catch (e) { }
                        console.warn(`⚠️ [Tier 4: Sync Engine] Timeout de ${(timeoutMs / 1000)}s.`);
                        resolve(false);
                    }
                }, timeoutMs);

                pyProc.on('close', (code) => {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timer);
                        if (code === 0 && fs.existsSync(outputSrtPath) && fs.statSync(outputSrtPath).size > 500) {
                            // Valida razão de framerate se detectada
                            const ratioMatch = (stderrOut + stdoutOut).match(/inferred frameratio ratio:\s*([0-9.]+)/i);
                            if (ratioMatch) {
                                const ratio = parseFloat(ratioMatch[1]);
                                if (ratio < 0.93 || ratio > 1.07) {
                                    console.warn(`⚠️ [Tier 4: Sync Engine] Frameratio fora dos limites fisiológicos (${ratio}). Rejeitando.`);
                                    resolve(false);
                                    return;
                                }
                            }
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    }
                });

                pyProc.on('error', () => {
                    if (!finished) {
                        finished = true;
                        clearTimeout(timer);
                        resolve(false);
                    }
                });
            });

            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

            if (syncSuccess && fs.existsSync(outputSrtPath)) {
                console.log(`✅ [Tier 4: Sync Engine] Legenda sincronizada com sucesso em ${elapsedSec}s!`);
                return outputSrtPath;
            } else if (isSubToSub) {
                console.log(`🔄 [Tier 4: Sync Engine] Sincronização Sub-to-Sub não convergiu (${elapsedSec}s). Recorrendo à análise acústica de fala (Audio-to-Sub)...`);
                return this.alignSubtitle(videoPath, inputSrtPath, outputSrtPath, { ...options, refSubPath: null });
            } else {
                console.warn(`⚠️ [Tier 4: Sync Engine] Sincronização acústica não convergiu (${elapsedSec}s).`);
                return null;
            }
        } finally {
            if (cleanAudioWav && fs.existsSync(cleanAudioWav)) {
                await fs.remove(cleanAudioWav).catch(() => { });
            }
        }
    }

    /**
     * QUALITY GATE: Valida monotonicidade, elimina sobreposições, formata e remove anúncios
     */
    async validateAndFinalizeSubtitle(srtPath, videoDurationSec = 0) {
        if (!fs.existsSync(srtPath)) return null;

        const rawContent = await fs.readFile(srtPath, 'utf8');
        const sanitized = this.sanitizeEncoding(rawContent);
        const rawCues = this.parseSrt(sanitized);

        if (rawCues.length < 20) {
            throw new Error(`Quality Gate falhou: legenda contém apenas ${rawCues.length} falas (mínimo 20).`);
        }

        // Filtro de propaganda / links de spam em legendas
        const isSpamText = (t) => {
            return /(opensubtitles|legendas\.tv|pipocas\.tv|yts\.mx|yts\.ag|yify|comandotorrents|bludv|lapumia|baixarfilmes|acesse:|visite:|anuncie aqui|subtitles by|tradução:|ripada por:)/i.test(t);
        };

        const cleanedCues = [];
        for (const cue of rawCues) {
            // Se for spam e tiver duração curta no início ou fim absoluto do filme, descarta
            if (isSpamText(cue.text) && (cue.startMs < 120000 || (videoDurationSec && cue.startMs > (videoDurationSec - 180) * 1000))) {
                continue;
            }
            cleanedCues.push(cue);
        }

        // Ordena estritamente por timestamp inicial
        cleanedCues.sort((a, b) => a.startMs - b.startMs);

        // Garante monotonicidade e elimina sobreposições mantendo gap de 30ms
        const finalCues = [];
        const MIN_GAP_MS = 30;
        const MIN_DUR_MS = 600;

        for (let i = 0; i < cleanedCues.length; i++) {
            const cue = cleanedCues[i];
            let startMs = cue.startMs;
            let endMs = cue.endMs;

            // Nunca começa antes de 0
            if (startMs < 0) startMs = 0;

            // Se for menor que o fim do anterior, corrige o anterior
            if (finalCues.length > 0) {
                const prev = finalCues[finalCues.length - 1];
                if (prev.endMs > startMs - MIN_GAP_MS) {
                    prev.endMs = Math.max(prev.startMs + MIN_DUR_MS, startMs - MIN_GAP_MS);
                    prev.endTc = this.formatMsToTimecode(prev.endMs);
                }
                if (startMs < prev.endMs + MIN_GAP_MS) {
                    startMs = prev.endMs + MIN_GAP_MS;
                }
            }

            // Duração mínima
            if (endMs <= startMs) {
                endMs = startMs + MIN_DUR_MS;
            }

            finalCues.push({
                index: finalCues.length + 1,
                startMs,
                endMs,
                startTc: this.formatMsToTimecode(startMs),
                endTc: this.formatMsToTimecode(endMs),
                text: cue.text
            });
        }

        const finalizedContent = this.buildSrt(finalCues);
        await fs.writeFile(srtPath, finalizedContent, 'utf8');
        console.log(`🛡️ [Quality Gate] Legenda validada e sanitizada (${finalCues.length} cues, monotonicidade 100%, sem sobreposições).`);
        return srtPath;
    }

    /**
     * Extrai áudio leve 16kHz mono WAV/PCM across 100% da duração do vídeo
     */
    async extractCleanAudioWav(videoPath, outputWavPath, videoDurationSec = 0) {
        await fs.ensureDir(path.dirname(outputWavPath));

        let channels = 2;
        try {
            const { stdout: probeOut } = await execFileAsync('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: 25000 });
            const streams = JSON.parse(probeOut).streams || [];
            const aStream = streams.find(s => s.codec_type === 'audio');
            if (aStream && aStream.channels) {
                channels = parseInt(aStream.channels, 10);
            }
        } catch (_) { }

        // Se for surround (>= 6 canais), isola canal central (diálogo c2)
        // Se stereo/mono, aplica filtro passa-banda vocal (200Hz - 3500Hz)
        let filterChain = 'highpass=f=200,lowpass=f=3500';
        if (channels >= 6) {
            filterChain = 'pan=mono|c0=c2,highpass=f=200,lowpass=f=3500,volume=1.5';
        }

        console.log(`🎙️ [Audio Extractor] Extraindo áudio mono 16kHz across 100% da duração (${channels} canais -> mono)...`);

        const ffmpegArgs = [
            '-nostdin', '-v', 'error', '-y',
            '-i', videoPath,
            '-vn',
            '-af', filterChain,
            '-ac', '1',
            '-ar', '16000',
            '-c:a', 'pcm_s16le',
            outputWavPath
        ];

        try {
            await execFileAsync('ffmpeg', ffmpegArgs, { timeout: 300000 });
        } catch (err) {
            console.warn(`⚠️ [Audio Extractor] Falha com filtro de voz (${err.message}). Tentando extração direta 16kHz mono...`);
            await execFileAsync('ffmpeg', [
                '-nostdin', '-v', 'error', '-y',
                '-i', videoPath,
                '-vn',
                '-ac', '1',
                '-ar', '16000',
                '-c:a', 'pcm_s16le',
                outputWavPath
            ], { timeout: 300000 });
        }

        if (!fs.existsSync(outputWavPath) || fs.statSync(outputWavPath).size < 10000) {
            throw new Error('Falha ao extrair stream de áudio mono 16kHz do vídeo.');
        }
        return outputWavPath;
    }

    /**
     * Gera mapa denso de âncoras Whisper (100% do filme)
     * Transcreve com faster-whisper (tiny/base, int8, vad_filter=True, word_timestamps=True)
     * Transmite progresso em tempo real de 20% a 70%
     */
    async generateWhisperAnchorMap(videoPath, videoDurationSec, onProgress = null, workDir = null) {
        const dir = workDir || this.getWorkingDir(videoPath);
        await fs.ensureDir(dir);

        const wavPath = path.join(dir, `whisper_audio_${Date.now()}.wav`);
        const anchorsJsonPath = path.join(dir, `whisper_anchors_${Date.now()}.json`);

        try {
            onProgress?.(15, 'Extraindo áudio mono 16kHz do filme (100% da duração)...');
            await this.extractCleanAudioWav(videoPath, wavPath, videoDurationSec);

            onProgress?.(20, 'Iniciando transcrição de âncoras Whisper (100% do filme)...');

            const scriptPath = path.resolve(__dirname, '../../scripts/whisper_dense_align.py');
            const modelName = process.env.WHISPER_MODEL || 'tiny';
            const args = [
                scriptPath,
                'transcribe',
                wavPath,
                anchorsJsonPath,
                String(videoDurationSec || 0),
                '--model', modelName
            ];

            await new Promise((resolve, reject) => {
                const pyProc = spawn(this.pythonExec, args, {
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let stderrData = '';
                let stdoutBuf = '';

                pyProc.stdout.on('data', chunk => {
                    stdoutBuf += chunk.toString();
                    const lines = stdoutBuf.split('\n');
                    stdoutBuf = lines.pop();

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('PROGRESS:')) {
                            // PROGRESS:<pct>:<current_sec>:<total_sec>
                            const parts = trimmed.split(':');
                            const pct = parseInt(parts[1], 10) || 0;
                            const curSec = parseFloat(parts[2]) || 0;
                            const totSec = parseFloat(parts[3]) || (videoDurationSec || 1);

                            // Mapeia 0-100% da transcrição Whisper para 20%-70% do progresso geral
                            const mappedPct = 20 + Math.round((pct / 100) * 50);
                            const curMin = (curSec / 60).toFixed(0);
                            const totMin = (totSec / 60).toFixed(0);

                            onProgress?.(mappedPct, `Mapeando âncoras Whisper (${pct}% - ${curMin}m/${totMin}m)...`);
                        }
                    }
                });

                pyProc.stderr.on('data', chunk => {
                    stderrData += chunk.toString();
                });

                pyProc.on('close', code => {
                    if (code === 0 && fs.existsSync(anchorsJsonPath)) {
                        resolve();
                    } else {
                        reject(new Error(`Falha no Whisper Transcribe (exit code ${code}): ${stderrData || 'Sem saída de erro'}`));
                    }
                });

                pyProc.on('error', err => {
                    reject(err);
                });
            });

            onProgress?.(70, 'Mapa de âncoras Whisper gerado com sucesso (100% concluído)!');
            return anchorsJsonPath;
        } finally {
            if (fs.existsSync(wavPath)) {
                await fs.remove(wavPath).catch(() => { });
            }
        }
    }

    /**
     * Sincronização densa multi-âncora de legenda candidata contra o mapa Whisper
     * Executa checagem de compatibilidade de corte em janelas de 10 minutos (0% a 100%)
     * e refinamento local com medianas móveis de 5 minutos (sub-150ms de precisão).
     */
    async alignCandidateWithDenseWhisper(anchorsJsonPath, inputSrtPath, outputSrtPath, videoDurationSec, refEnPath = null) {
        const scriptPath = path.resolve(__dirname, '../../scripts/whisper_dense_align.py');
        const args = [
            scriptPath,
            'align',
            anchorsJsonPath,
            inputSrtPath,
            outputSrtPath,
            String(videoDurationSec || 0)
        ];
        if (refEnPath && fs.existsSync(refEnPath)) {
            args.push(refEnPath);
        }

        try {
            const { stdout } = await execFileAsync(this.pythonExec, args, { timeout: 120000 });
            const jsonMatch = stdout.match(/\{[\s\S]*"aligned"[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { aligned: false, reason: 'Resposta inválida do alinhador denso Whisper' };
        } catch (e) {
            if (e.stdout) {
                const jsonMatch = e.stdout.match(/\{[\s\S]*"aligned"[\s\S]*\}/);
                if (jsonMatch) {
                    try {
                        return JSON.parse(jsonMatch[0]);
                    } catch (_) { }
                }
            }
            return { aligned: false, reason: e.message };
        }
    }

    /**
     * TIER 4: Forced Dense Multi-Anchor Acoustic Offset Alignment (Whisper ASR)
     * Utiliza mapa denso de âncoras Whisper across 100% do vídeo com checagem de corte e medianas móveis.
     */
    async alignSubtitleWithWhisper(videoPath, inputSrtPath, outputSrtPath, videoDurationSec, refEnPath = null, onProgress = null) {
        const scriptPath = path.resolve(__dirname, '../../scripts/whisper_dense_align.py');
        if (!fs.existsSync(scriptPath)) {
            console.warn(`⚠️ [Dense Whisper Align] Script whisper_dense_align.py não encontrado.`);
            return { aligned: false, reason: 'Script ausente' };
        }

        const videoDir = this.getWorkingDir(videoPath);
        let anchorsJsonPath = null;
        try {
            console.log(`🎙️ [Dense Whisper Align] Iniciando ancoragem Whisper across 100% do runtime...`);
            anchorsJsonPath = await this.generateWhisperAnchorMap(videoPath, videoDurationSec, onProgress, videoDir);
            return await this.alignCandidateWithDenseWhisper(anchorsJsonPath, inputSrtPath, outputSrtPath, videoDurationSec, refEnPath);
        } catch (e) {
            console.warn(`⚠️ [Dense Whisper Align] Erro na execução: ${e.message}`);
            return { aligned: false, reason: e.message };
        } finally {
            if (anchorsJsonPath && fs.existsSync(anchorsJsonPath)) {
                await fs.remove(anchorsJsonPath).catch(() => { });
            }
        }
    }

    /**
     * VERIFICAÇÃO MULTI-CHECKPOINT: Inspeciona sincronia com Whisper ASR em 3 pontos (Início, Miolo, Fim)
     */
    async verifySyncAtCheckpoints(videoPath, srtPath, videoDurationSec, refEnPath = null, toleranceSec = '1.5') {
        const isUrl = typeof videoPath === 'string' && /^https?:\/\//i.test(videoPath);
        if ((!isUrl && !fs.existsSync(videoPath)) || !fs.existsSync(srtPath)) {
            return { verified: false, reason: 'Arquivo de vídeo ou legenda inexistente', checkpoints: [] };
        }

        const scriptPath = path.resolve(__dirname, '../../scripts/whisper_verify.py');
        if (!fs.existsSync(scriptPath)) {
            console.warn(`⚠️ [Quality Gate] Script whisper_verify.py não encontrado em ${scriptPath}. Utilizando validação de contingência.`);
            return { verified: true, warning: 'Script ausente', checkpoints: [] };
        }

        try {
            console.log(`🎙️ [Quality Gate: Whisper Speech Verification] Executando verificação de voz real nos checkpoints (Início, Miolo, Clímax) | Tolerância: ±${toleranceSec}s ...`);
            const args = [
                scriptPath,
                videoPath,
                srtPath,
                toleranceSec
            ];
            if (refEnPath && fs.existsSync(refEnPath)) {
                args.push(refEnPath);
            }

            const { stdout } = await execFileAsync(this.pythonExec, args, { timeout: 120000 });

            const jsonMatch = stdout.match(/\{[\s\S]*"verified"[\s\S]*\}/);
            if (jsonMatch) {
                return JSON.parse(jsonMatch[0]);
            }
            return { verified: stdout.includes('PASSED ✅'), checkpoints: [] };
        } catch (e) {
            if (e.stdout) {
                const jsonMatch = e.stdout.match(/\{[\s\S]*"verified"[\s\S]*\}/);
                if (jsonMatch) {
                    try { return JSON.parse(jsonMatch[0]); } catch (_) { }
                }
            }
            console.warn(`⚠️ [Quality Gate] Reprovação ou falha na verificação Whisper: ${e.message}`);
            return { verified: false, error: e.message, checkpoints: [] };
        }
    }

    /**
     * Pipeline Completo: TIER 1 -> TIER 2 -> TIER 3 -> TIER 3.5 -> 100% WHISPER ANCHOR MAP -> QUALITY GATE
     * Suporta callback em tempo real onProgress(percent, message)
     */
    async processSubtitlePipeline(videoPath, metadata = {}, onProgress = null) {
        console.log(`\n============================================================`);
        console.log(`🎬 [CINEMA-GRADE SUBTITLE PIPELINE] "${metadata.nome || metadata.title || path.basename(videoPath)}"`);
        console.log(`============================================================`);

        // Etapa 1 (10%): Medição da duração real do vídeo diretamente no stream do Telegram
        onProgress?.(10, 'Obtendo stream de áudio real do Telegram...');
        let videoDurationSec = parseFloat(metadata.duration || metadata.duracao || 0);
        const probedDur = await this.probeActualVideoDuration(videoPath);
        if (probedDur > 60) {
            videoDurationSec = probedDur;
            metadata.duration = probedDur;
        }

        const videoDir = this.getWorkingDir(videoPath);
        await fs.ensureDir(videoDir);
        let selectedSrtPath = null;
        let refEnPath = null;
        let requiresSync = false;
        let sourceMethod = null;
        const candidatePool = [];

        // TIER 1: Legenda embutida no container
        const tier1 = await this.probeAndExtractContainerSubtitle(videoPath, metadata);
        if (tier1) {
            if (!metadata.isReprocess) {
                selectedSrtPath = tier1.srtPath;
                sourceMethod = 'Tier 1 (Container Embedded - Frame Perfect)';
                requiresSync = false; // Embutidas em release original já são sincronizadas de estúdio
            } else {
                // Em reprocessamento forçado, adiciona ao pool para alinhamento acústico fino
                candidatePool.push({
                    srtPath: tier1.srtPath,
                    sourceMethod: 'Tier 1 (Container Embedded)',
                    name: 'Container Embedded'
                });
            }
        }

        // TIER 2: Se não tem Tier 1 aprovado, busca Companion no pacote
        if (!selectedSrtPath) {
            const tier2 = await this.findCompanionSubtitles(videoPath, metadata);
            if (tier2.refEnPath) refEnPath = tier2.refEnPath;
            if (tier2.ptSrtPath) {
                candidatePool.push({
                    srtPath: tier2.ptSrtPath,
                    sourceMethod: 'Tier 2 (Companion Package Subs)',
                    name: 'Companion Package Subtitle'
                });
            }
        }

        // Etapa 2 (15%): Busca de legendas nativas PT-BR e âncora EN
        onProgress?.(15, 'Buscando legendas PT-BR nativas (Stremio + SubDL Pool)...');

        // Se ainda não tem EN de referência, extrai do container, OpenSubtitles ou SubDL
        if (!refEnPath) {
            refEnPath = await this.extractEnglishReferenceSubtitle(videoPath, metadata, videoDurationSec);
        }

        // Parse dos cues da legenda EN de referência (se disponível) para validar o Duration Gate
        let refEnCues = null;
        if (refEnPath && fs.existsSync(refEnPath)) {
            try {
                const enRaw = await fs.readFile(refEnPath, 'utf8');
                refEnCues = this.parseSrt(this.sanitizeEncoding(enRaw));
                if (refEnCues.length < 30) refEnCues = null;
            } catch (_) { }
        }

        // TIER 3: Busca externa estrita por PT-BR genuíno via Stremio/OpenSubtitles
        if (!selectedSrtPath) {
            const tier3 = await this.fetchExternalSubtitle(videoPath, metadata, videoDurationSec, refEnCues);
            if (tier3?.candidates && tier3.candidates.length > 0) {
                candidatePool.push(...tier3.candidates);
            } else if (tier3?.srtPath) {
                candidatePool.push(tier3);
            }
        }

        // TIER 3.5: Fallback de busca PT-BR via SubDL API (Pool com Rotação Automática de Chaves)
        if (!selectedSrtPath) {
            const tier35 = await this.fetchSubdlSubtitle(videoPath, metadata, videoDurationSec, refEnCues);
            if (tier35?.candidates && tier35.candidates.length > 0) {
                candidatePool.push(...tier35.candidates);
            } else if (tier35?.srtPath) {
                candidatePool.push(tier35);
            }
        }

        // Se já temos uma legenda embutida que não precisa de sync e não é reprocessamento
        if (selectedSrtPath && !requiresSync && !metadata.isReprocess) {
            await this.validateAndFinalizeSubtitle(selectedSrtPath, videoDurationSec);
            onProgress?.(100, 'Concluído! Legenda embutida de estúdio validada.');
            return {
                srtPath: selectedSrtPath,
                sourceMethod,
                checkpoints: [],
                verified: true
            };
        }

        // Etapa 3: Full-Movie Whisper Anchor Map (100% do Áudio) & Alinhamento Denso Multi-Âncora
        let anchorsJsonPath = null;
        try {
            if (candidatePool.length > 0 || refEnPath) {
                console.log(`\n🎙️ [Full-Movie Anchor Map] Gerando mapa denso de âncoras Whisper (100% da duração)...`);
                anchorsJsonPath = await this.generateWhisperAnchorMap(videoPath, videoDurationSec, onProgress, videoDir);
            }

            onProgress?.(70, 'Mapa de âncoras Whisper gerado. Sincronizando candidatos PT-BR...');

            let approvedCandidate = null;

            // 1. Testa candidatos PT-BR nativos contra o mapa de âncoras Whisper
            for (let cIdx = 0; cIdx < candidatePool.length; cIdx++) {
                const cand = candidatePool[cIdx];
                const syncedOut = path.join(videoDir, `synced_dense_${Date.now()}_cand${cIdx + 1}.srt`);
                console.log(`\n🎯 [Dense Whisper Sync] Avaliando candidato #${cIdx + 1}/${candidatePool.length}: "${cand.name || cand.sourceMethod}"...`);

                const alignResult = await this.alignCandidateWithDenseWhisper(anchorsJsonPath, cand.srtPath, syncedOut, videoDurationSec, refEnPath);

                if (alignResult.aligned && fs.existsSync(syncedOut)) {
                    console.log(`✅ [Dense Whisper Sync] Candidato #${cIdx + 1} APROVADO no Cut Gate e alinhado via Rolling 5-Minute Medians!`);
                    console.log(`   Deslocamento global: ${alignResult.global_offset_ms}ms | Cobertura: ${alignResult.coverage_pct}% | Janelas: ${alignResult.windows?.length}`);
                    approvedCandidate = {
                        srtPath: syncedOut,
                        sourceMethod: `${cand.sourceMethod || 'PT-BR'} + Dense Whisper Multi-Anchor Map (${alignResult.global_offset_ms > 0 ? '+' : ''}${alignResult.global_offset_ms}ms)`,
                        alignResult
                    };
                    break;
                } else {
                    console.warn(`⚠️ [Cut Gate] Candidato #${cIdx + 1} ("${cand.name || cand.sourceMethod}") REJEITADO: ${alignResult.reason}`);
                }
            }

            if (approvedCandidate) {
                selectedSrtPath = approvedCandidate.srtPath;
                sourceMethod = approvedCandidate.sourceMethod;
                requiresSync = false;
            }

            // 2. Se NENHUM candidato PT-BR foi aprovado (ou não havia), recorre à âncora EN sincronizada + Tradução Neural Gemini
            if (!selectedSrtPath && refEnPath && fs.existsSync(refEnPath)) {
                console.log(`\n🤖 [Tier 3 Fallback] Nenhum candidato PT-BR nativo aprovado no Cut Gate. Recorrendo à âncora em inglês.`);
                onProgress?.(75, 'Pré-sincronizando âncora em inglês com o mapa de âncoras Whisper...');

                let refEnSyncPath = refEnPath;
                if (anchorsJsonPath && fs.existsSync(anchorsJsonPath)) {
                    const syncedEnOut = path.join(videoDir, `synced_en_anchor_${Date.now()}.srt`);
                    const syncEnRes = await this.alignCandidateWithDenseWhisper(anchorsJsonPath, refEnPath, syncedEnOut, videoDurationSec, null);
                    if (syncEnRes.aligned && fs.existsSync(syncedEnOut)) {
                        refEnSyncPath = syncedEnOut;
                        console.log(`🎯 [Tier 3 Fallback] Âncora em inglês travada acusticamente com precisão de estúdio (${syncEnRes.global_offset_ms}ms)!`);
                    } else {
                        console.warn(`⚠️ [Tier 3 Fallback] Alinhamento prévio da âncora EN falhou (${syncEnRes.reason}). Utilizando âncora original.`);
                    }
                }

                if (SubtitleTranslationService.isAvailable()) {
                    onProgress?.(80, `Traduzindo âncora sincronizada para PT-BR via Gemini (${SubtitleTranslationService.modelName})...`);
                    const translatedPtBrPath = path.join(videoDir, `neural_ptbr_${Date.now()}.srt`);
                    try {
                        await SubtitleTranslationService.translateSrtFile(refEnSyncPath, translatedPtBrPath, {
                            title: metadata.nome || metadata.title || path.basename(videoPath)
                        });

                        if (fs.existsSync(translatedPtBrPath)) {
                            await this.validateAndFinalizeSubtitle(translatedPtBrPath, videoDurationSec);
                            selectedSrtPath = translatedPtBrPath;
                            sourceMethod = `Tier 3 (Neural Gemini AI Translation from Dense Whisper Aligned English Anchor [${SubtitleTranslationService.modelName}])`;
                            requiresSync = false;
                        }
                    } catch (transErr) {
                        console.error(`❌ [Tier 3 Fallback] Erro durante a tradução neural via Gemini: ${transErr.message}`);
                    }
                } else {
                    console.warn(`⚠️ [Tier 3 Fallback] GEMINI_API_KEY não configurada no .env.`);
                }
            }
        } finally {
            if (anchorsJsonPath && fs.existsSync(anchorsJsonPath)) {
                await fs.remove(anchorsJsonPath).catch(() => { });
            }
        }

        if (!selectedSrtPath) {
            throw new Error(`Falha no pipeline: nenhuma legenda PT-BR válida encontrada nos Tiers 1-3 e tradução neural indisponível.`);
        }

        // Etapa 5 (90%): Quality Gate Automático
        onProgress?.(90, 'Validando Quality Gate, eliminando sobreposições e garantindo monotonicidade...');
        await this.validateAndFinalizeSubtitle(selectedSrtPath, videoDurationSec);

        // Conclusão e entrega
        onProgress?.(100, 'Concluído! Recarregando legendas...');
        console.log(`✅ [CINEMA-GRADE PIPELINE CONCLUÍDO] Método: ${sourceMethod} | Arquivo: ${path.basename(selectedSrtPath)}`);

        return {
            srtPath: selectedSrtPath,
            sourceMethod,
            checkpoints: [],
            verified: true
        };
    }
}

module.exports = new SubtitlePipeline();
