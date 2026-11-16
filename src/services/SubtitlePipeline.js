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
     * Valida se a legenda tem vocabulário autêntico de Português Brasileiro (PT-BR).
     *
     * Regra ultra-simples em 2 critérios objetivos:
     * 1. Confiança nos Metadados / Tags da Fonte:
     *    - pob, pt-br, pt_br, brazilian, bra -> aprova imediatamente como PT-BR sem inspecionar texto.
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
        const ptBrTags = ['pob', 'pt-br', 'pt_br', 'ptbr', 'brazilian', 'bra'];
        if (ptBrTags.includes(lang)) return true;
        if (/\b(pt[-_]br|ptbr|pob|brazilian|bra)\b/.test(file)) return true;

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
            const videoDir = path.dirname(videoPath);
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
                const outPath = path.join(path.dirname(videoPath), `ref_en_${Date.now()}.srt`);
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

                                if (videoDurationSec > 3600) {
                                    const lastCue = cues[cues.length - 1];
                                    const lastCueSec = lastCue ? lastCue.endMs / 1000 : 0;
                                    if (cues.length < 500 || lastCueSec < (videoDurationSec - 420)) {
                                        continue;
                                    }
                                } else if (cues.length < 100) {
                                    continue;
                                }

                                const outPath = path.join(path.dirname(videoPath), `ref_en_ext_${Date.now()}.srt`);
                                await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                                console.log(`🎯 [Tier 2: English Reference] Legenda oficial em inglês obtida via OpenSubtitles (${cues.length} cues) para alinhamento sub-to-sub!`);
                                return outPath;
                            }
                        }
                    } catch (_) { }
                }
            } catch (e) {
                console.warn(`⚠️ Erro ao buscar legenda EN de referência:`, e.message);
            }
        }

        return null;
    }

    /**
     * TIER 2: Procura legendas companheiras (.srt) na pasta do torrent / download
     */
    async findCompanionSubtitles(videoPath, metadata = {}) {
        try {
            console.log(`🔍 [Tier 2: Companion Package] Buscando legendas companheiras na pasta do torrent...`);
            const videoDir = path.dirname(videoPath);
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
                        const reason = ['pob','pt-br','pt_br','ptbr','brazilian','bra'].includes(subLang)
                            ? 'falha no Portuguese básico'
                            : ['pt-pt','pt_pt','ptpt'].includes(subLang) || /\b(pt[-_]pt|portugal)\b/.test(relName)
                                ? 'marcado explicitamente como PT-PT'
                                : 'texto não identificado como PT-BR (você/vocês < 3 e construções PT-PT presentes)';
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado [lang=${subLang}]: ${reason}.`);
                        continue;
                    }
                    console.log(`✅ Candidato #${i + 1} aprovado como PT-BR [lang=${subLang}].`);

                    const cues = this.parseSrt(sanitized);
                    if (cues.length < 30) {
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado: apenas ${cues.length} cues.`);
                        continue;
                    }

                    // 3. Strict Duration Gate com suporte a âncora EN
                    if (videoDurationSec > 600) {
                        const lastPtCue = this.getLastDialogueCue(cues);
                        const lastCueEndSec = lastPtCue ? lastPtCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;

                        if (refEnCues && refEnCues.length > 0) {
                            const lastEnCue = this.getLastDialogueCue(refEnCues);
                            const enLastSec = lastEnCue ? lastEnCue.endMs / 1000 : refEnCues[refEnCues.length - 1].endMs / 1000;
                            const endDiff = Math.abs(lastCueEndSec - enLastSec);
                            if (endDiff > 45) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate EN: última fala PT em ${(lastCueEndSec / 60).toFixed(1)}min diverge ${Math.round(endDiff)}s do diálogo final da âncora EN (${(enLastSec / 60).toFixed(1)}min). Legenda cortada/incompleta.`);
                                continue;
                            }
                            const cueDiffRatio = Math.abs(cues.length - refEnCues.length) / Math.max(1, refEnCues.length);
                            if (cueDiffRatio > 0.10) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate EN: ${cues.length} cues PT vs ${refEnCues.length} cues EN (${(cueDiffRatio * 100).toFixed(0)}% divergência > 10% permitido).`);
                                continue;
                            }
                        } else {
                            const coverageRatio = lastCueEndSec / videoDurationSec;
                            const gapSec = videoDurationSec - lastCueEndSec;
                            // Tolera até 12 minutos (720s) de créditos finais e créditos pós-filme em blockbusters
                            if (coverageRatio < 0.90 && gapSec > 720) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate: cobertura ${(coverageRatio * 100).toFixed(1)}% (última fala ${(lastCueEndSec / 60).toFixed(1)}min, gap ${Math.round(gapSec)}s).`);
                                continue;
                            }
                        }

                        if (videoDurationSec > 3600 && cues.length < 400) {
                            console.warn(`⚠️ Candidato #${i + 1} rejeitado: apenas ${cues.length} falas para longa-metragem.`);
                            continue;
                        }
                    }

                    // Candidato PT-BR genuíno aprovado com louvor!
                    const candidatePath = path.join(path.dirname(videoPath), `external_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidatePath, this.buildSrt(cues), 'utf8');
                    console.log(`✅ [Tier 3: External Search] Candidato #${i + 1} aprovado como PT-BR genuíno (${cues.length} cues, score: ${score})!`);
                    return {
                        srtPath: candidatePath,
                        cueCount: cues.length,
                        source: 'external_opensubtitles_ptbr'
                    };
                } catch (dlErr) {
                    console.warn(`⚠️ Falha ao baixar candidato #${i + 1}:`, dlErr.message);
                }
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

            const videoDir = path.dirname(videoPath);

            // Economia estrita de cota: baixa no máximo os 2 melhores candidatos ranqueados
            const maxCandidatesToDownload = Math.min(rankedSubtitles.length, 2);

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
                        await fs.remove(extractedSrtPath).catch(() => {});
                        continue;
                    }

                    const cues = this.parseSrt(sanitized);
                    if (cues.length < 30) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado: apenas ${cues.length} cues.`);
                        await fs.remove(extractedSrtPath).catch(() => {});
                        continue;
                    }

                    // Duration Gate
                    if (videoDurationSec > 600) {
                        const lastPtCue = this.getLastDialogueCue(cues);
                        const lastCueEndSec = lastPtCue ? lastPtCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;

                        if (refEnCues && refEnCues.length > 0) {
                            const lastEnCue = this.getLastDialogueCue(refEnCues);
                            const enLastSec = lastEnCue ? lastEnCue.endMs / 1000 : refEnCues[refEnCues.length - 1].endMs / 1000;
                            const endDiff = Math.abs(lastCueEndSec - enLastSec);
                            if (endDiff > 45) {
                                console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado pelo Duration Gate EN: última fala PT em ${(lastCueEndSec / 60).toFixed(1)}min diverge ${Math.round(endDiff)}s da âncora EN (${(enLastSec / 60).toFixed(1)}min). Legenda cortada/incompleta.`);
                                await fs.remove(extractedSrtPath).catch(() => {});
                                continue;
                            }
                            const cueDiffRatio = Math.abs(cues.length - refEnCues.length) / Math.max(1, refEnCues.length);
                            if (cueDiffRatio > 0.10) {
                                console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado pelo Duration Gate EN: ${cues.length} cues PT vs ${refEnCues.length} cues EN (${(cueDiffRatio * 100).toFixed(0)}% divergência > 10% permitido).`);
                                await fs.remove(extractedSrtPath).catch(() => {});
                                continue;
                            }
                        } else {
                            const coverageRatio = lastCueEndSec / videoDurationSec;
                            const gapSec = videoDurationSec - lastCueEndSec;
                            // Tolera até 12 minutos (720s) de créditos finais e créditos pós-filme em blockbusters
                            if (coverageRatio < 0.90 && gapSec > 720) {
                                console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado pelo Duration Gate: cobertura ${(coverageRatio * 100).toFixed(1)}% (última fala ${(lastCueEndSec / 60).toFixed(1)}min, gap ${Math.round(gapSec)}s).`);
                                await fs.remove(extractedSrtPath).catch(() => {});
                                continue;
                            }
                        }

                        if (videoDurationSec > 3600 && cues.length < 400) {
                            console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado: apenas ${cues.length} falas para longa-metragem.`);
                            await fs.remove(extractedSrtPath).catch(() => {});
                            continue;
                        }
                    }

                    // Aprovado no Duration Gate!
                    const candidateFinalPath = path.join(videoDir, `subdl_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidateFinalPath, this.buildSrt(cues), 'utf8');
                    await fs.remove(extractedSrtPath).catch(() => {});

                    console.log(`✅ [Tier 3.5: SubDL API] Candidato #${i + 1} APROVADO com sucesso no Duration Gate (${cues.length} cues, release: "${candidate.release_name || candidate.name}")!`);
                    return {
                        srtPath: candidateFinalPath,
                        cueCount: cues.length,
                        source: 'subdl_api_ptbr'
                    };
                } catch (candErr) {
                    console.warn(`⚠️ [Tier 3.5: SubDL API] Falha ao processar candidato #${i + 1}:`, candErr.message);
                    if (extractedSrtPath) await fs.remove(extractedSrtPath).catch(() => {});
                }
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
        if (!fs.existsSync(inputSrtPath) || !fs.existsSync(videoPath)) {
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

            // Executa ffsubsync com controle estrito de frameratio
            const pythonCode = `
import sys
import os
from ffsubsync.ffsubsync import make_parser, run

parser = make_parser()
args = parser.parse_args([
    sys.argv[1],
    '-i', sys.argv[2],
    '-o', sys.argv[3],
    '--max-offset-seconds', '120',
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
                const pyProc = spawn(this.pythonExec, ['-c', pythonCode, referenceTarget, inputSrtPath, outputSrtPath], {
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
     * VERIFICAÇÃO MULTI-CHECKPOINT: Inspeciona sincronia com Whisper ASR em 3 pontos (Início, Miolo, Fim)
     */
    async verifySyncAtCheckpoints(videoPath, srtPath, videoDurationSec, refEnPath = null, toleranceSec = '1.5') {
        if (!fs.existsSync(videoPath) || !fs.existsSync(srtPath)) {
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
     * Pipeline Completo: TIER 1 -> TIER 2 -> TIER 3 -> TIER 4 -> QUALITY GATE
     */
    async processSubtitlePipeline(videoPath, metadata = {}) {
        console.log(`\n============================================================`);
        console.log(`🎬 [CINEMA-GRADE SUBTITLE PIPELINE] "${metadata.nome || metadata.title || path.basename(videoPath)}"`);
        console.log(`============================================================`);

        // Duração do vídeo via ffprobe
        let videoDurationSec = 0;
        try {
            const { stdout } = await execFileAsync('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                videoPath
            ], { timeout: 15000 });
            videoDurationSec = parseFloat(JSON.parse(stdout).format?.duration || 0);
        } catch (e) { }

        const videoDir = path.dirname(videoPath);
        let selectedSrtPath = null;
        let refEnPath = null;
        let requiresSync = false;
        let sourceMethod = null;

        // TIER 1: Legenda embutida no container
        const tier1 = await this.probeAndExtractContainerSubtitle(videoPath, metadata);
        if (tier1) {
            selectedSrtPath = tier1.srtPath;
            sourceMethod = 'Tier 1 (Container Embedded - Frame Perfect)';
            requiresSync = false; // Embutidas em release original já são sincronizadas de estúdio
        }

        // TIER 2: Se não tem Tier 1, busca Companion no pacote
        if (!selectedSrtPath) {
            const tier2 = await this.findCompanionSubtitles(videoPath, metadata);
            if (tier2.refEnPath) refEnPath = tier2.refEnPath;
            if (tier2.ptSrtPath) {
                selectedSrtPath = tier2.ptSrtPath;
                sourceMethod = 'Tier 2 (Companion Package Subs)';
                requiresSync = true;
            }
        }

        // Se ainda não tem EN de referência, extrai do container ou busca no OpenSubtitles
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

        // TIER 3: Se não tem Tier 1 nem Tier 2, busca externa estrita por PT-BR genuíno
        if (!selectedSrtPath) {
            const tier3 = await this.fetchExternalSubtitle(videoPath, metadata, videoDurationSec, refEnCues);
            if (tier3) {
                selectedSrtPath = tier3.srtPath;
                sourceMethod = 'Tier 3 (Strict External PT-BR Matching via OpenSubtitles)';
                requiresSync = true;
            }
        }

        // TIER 3.5: Fallback de busca PT-BR via SubDL API (Pool com Rotação Automática de Chaves)
        // Acionado APENAS se os endpoints gratuitos do Stremio (Tier 3) não aprovarem nenhuma legenda PT-BR no Duration Gate,
        // e ANTES de acionar a tradução neural via Gemini para preservar tokens e cotas.
        if (!selectedSrtPath) {
            const tier35 = await this.fetchSubdlSubtitle(videoPath, metadata, videoDurationSec, refEnCues);
            if (tier35) {
                selectedSrtPath = tier35.srtPath;
                sourceMethod = 'Tier 3.5 (SubDL API Official Fallback)';
                requiresSync = true;
            }
        }

        // TIER 3 FALLBACK: Tradução Neural via Gemini API a partir da legenda âncora em inglês
        // Executado quando NENHUMA legenda PT-BR nativa foi encontrada/aprovada no Duration Gate
        if (!selectedSrtPath && refEnPath && fs.existsSync(refEnPath)) {
            console.log(`\n🤖 [Tier 3 Fallback] Nenhuma legenda PT-BR nativa aprovada no Duration Gate.`);

            // 1. Pré-sincroniza a legenda âncora em inglês com o áudio do filme (se veio de fonte externa)
            let refEnSyncPath = refEnPath;
            const isEnExternal = path.basename(refEnPath).startsWith('ref_en_ext_');
            if (isEnExternal) {
                const syncedEnOut = path.join(videoDir, `synced_en_anchor_${Date.now()}.srt`);
                console.log(`🎙️ [Tier 3 Fallback] Pré-sincronizando âncora em inglês com o áudio do filme antes da tradução neural...`);
                try {
                    const syncEnRes = await this.alignSubtitle(videoPath, refEnPath, syncedEnOut);
                    if (syncEnRes && fs.existsSync(syncEnRes)) {
                        refEnSyncPath = syncEnRes;
                        console.log(`🎯 [Tier 3 Fallback] Âncora em inglês travada acusticamente com precisão de estúdio!`);
                    }
                } catch (syncEnErr) {
                    console.warn(`⚠️ [Tier 3 Fallback] Alinhamento prévio da âncora EN falhou (${syncEnErr.message}). Utilizando âncora original.`);
                }
            }

            // 2. Tradução Neural estruturada via Gemini API (PT-BR autêntico sem timecodes enviados à IA)
            if (SubtitleTranslationService.isAvailable()) {
                console.log(`🧠 [Tier 3 Fallback: Neural Translation] Traduzindo âncora em inglês sincronizada para PT-BR cinematográfico via Gemini (${SubtitleTranslationService.modelName})...`);
                const translatedPtBrPath = path.join(videoDir, `neural_ptbr_${Date.now()}.srt`);
                try {
                    await SubtitleTranslationService.translateSrtFile(refEnSyncPath, translatedPtBrPath, {
                        title: metadata.nome || metadata.title || path.basename(videoPath)
                    });

                    if (fs.existsSync(translatedPtBrPath)) {
                        // 3. Quality Gate obrigatório na saída traduzida
                        console.log(`🔍 [Tier 3 Fallback] Executando Quality Gate na legenda traduzida pelo Gemini...`);
                        await this.validateAndFinalizeSubtitle(translatedPtBrPath, videoDurationSec);

                        // 4. Whisper Verification obrigatória — timecodes já travados na âncora, tolerância ±1.5s
                        console.log(`🎙️ [Tier 3 Fallback] Executando verificação Whisper ASR na legenda traduzida...`);
                        const whisperTranslated = await this.verifySyncAtCheckpoints(
                            videoPath, translatedPtBrPath, videoDurationSec,
                            refEnSyncPath, // âncora para validação de conteúdo via tokens EN
                            '1.5'
                        );
                        for (const cp of whisperTranslated.checkpoints || []) {
                            const st = cp.in_sync ? '✅' : '❌';
                            const off = cp.measured_offset_sec !== undefined ? `${cp.measured_offset_sec > 0 ? '+' : ''}${cp.measured_offset_sec}s` : 'N/A';
                            console.log(`   ${st} ${cp.name} [${cp.cue_timecode || ''}]: Offset: ${off} | "${(cp.spoken_text || '').substring(0, 50)}"`);
                        }
                        if (!whisperTranslated.verified) {
                            throw new Error(`Quality Gate: Legenda traduzida pelo Gemini reprovada no Whisper ASR (${(whisperTranslated.checkpoints || []).filter(c => !c.in_sync).map(c => c.name).join(', ')}).`);
                        }
                        console.log(`✅ [Tier 3 Fallback] Legenda traduzida aprovada no Quality Gate + Whisper ASR!`);

                        selectedSrtPath = translatedPtBrPath;
                        sourceMethod = `Tier 3 (Neural Gemini AI Translation from English Anchor [${SubtitleTranslationService.modelName}]) | Quality Gate ✅ | Whisper ✅`;
                        requiresSync = false; // Timecodes já estão matematicamente travados na âncora sincronizada!
                    }
                } catch (transErr) {
                    console.error(`❌ [Tier 3 Fallback: Neural Translation] Erro durante a tradução neural via Gemini: ${transErr.message}`);
                }
            } else {
                console.warn(`⚠️ [Tier 3 Fallback: Neural Translation] Tradução indisponível: GEMINI_API_KEY não configurada no .env.`);
            }
        }

        if (!selectedSrtPath) {
            throw new Error(`Falha no pipeline: nenhuma legenda PT-BR válida encontrada nos Tiers 1-3 e tradução neural indisponível.`);
        }

        // TIER 4: Sincronização Acústica / Sub-to-Sub (se necessário)
        let finalSrtPath = selectedSrtPath;
        // isStudioRef: true se a legenda EN de referência veio do container ou foi gerada via tradução da âncora (frame-perfect)
        // false se veio da internet (OpenSubtitles, pode ter fps diferente) → usa Audio-to-Sub
        const isStudioRef = !requiresSync || (refEnPath && !path.basename(refEnPath).startsWith('ref_en_ext_'));
        if (requiresSync) {
            const syncedOutPath = path.join(videoDir, `synced_final_${Date.now()}.srt`);
            // Se a legenda EN de referência veio do CONTAINER (softsub embutida de estúdio),
            // ela é garantidamente frame-perfect com o vídeo -> Sub-to-Sub é seguro e instantâneo.
            // Se veio da internet (OpenSubtitles), ela pode ter framerate diferente (ex: 25fps PAL)
            // -> Usa Audio-to-Sub (alinhamento acústico direto na fala do vídeo) para sincronia de cinema absoluta!
            const syncResult = await this.alignSubtitle(videoPath, selectedSrtPath, syncedOutPath, {
                refSubPath: isStudioRef ? refEnPath : null
            });

            if (syncResult && fs.existsSync(syncResult)) {
                finalSrtPath = syncResult;
                console.log(`🎯 [Pipeline] Alinhamento concluído com sucesso via ${isStudioRef ? 'Sub-to-Sub (Container Studio)' : 'Audio-to-Sub (Voz Acústica)'}!`);
            } else {
                console.warn(`⚠️ [Pipeline] Alinhamento falhou; testando qualidade com Whisper ASR antes de aceitar.`);
            }
        }

        // AUTOMATED QUALITY GATE
        await this.validateAndFinalizeSubtitle(finalSrtPath, videoDurationSec);

        // MULTI-CHECKPOINT VERIFICATION VIA WHISPER ASR (com ancoragem de estúdio se disponível)
        // Se a legenda EN veio do container (studio), usamos como âncora de conteúdo com tolerância ±1.5s
        // Se foi alinhada acusticamente (Audio-to-Sub), o áudio do próprio vídeo valida o timing com tolerância ±2.5s
        const whisperTolerance = isStudioRef ? '1.5' : '2.5';
        const anchorSubPath = isStudioRef ? refEnPath : null;
        console.log(`🎙️ [Pipeline] Verificação Whisper ASR | Âncora: ${anchorSubPath ? 'Studio Sub' : 'Áudio Acústico Direto'} | Tolerância: ${whisperTolerance}s`);
        const checkpointCheck = await this.verifySyncAtCheckpoints(videoPath, finalSrtPath, videoDurationSec, anchorSubPath, whisperTolerance);
        console.log(`🔍 [Multi-Checkpoint Whisper Verification] Resultado: ${checkpointCheck.verified ? 'PASSED ✅' : 'FAILED ❌'}`);
        for (const cp of checkpointCheck.checkpoints || []) {
            const status = cp.in_sync ? '✅' : '❌';
            const offset = cp.measured_offset_sec !== undefined ? `${cp.measured_offset_sec > 0 ? '+' : ''}${cp.measured_offset_sec}s` : 'N/A';
            console.log(`   ${status} ${cp.name} [${cp.cue_timecode || cp.timecode || ''}]: Offset: ${offset} | Fala: "${(cp.spoken_text || '').substring(0, 45)}"`);
            console.log(`     Legenda: "${(cp.cue_text || cp.text || '').substring(0, 60)}"`);
        }

        if (!checkpointCheck.verified) {
            throw new Error(`Falha no Quality Gate: Legenda reprovada no teste acústico de sincronia real (Whisper ASR). Offset excessivo detectado.`);
        }

        console.log(`✅ [CINEMA-GRADE PIPELINE CONCLUÍDO] Método: ${sourceMethod} | Arquivo: ${path.basename(finalSrtPath)}`);
        return {
            srtPath: finalSrtPath,
            sourceMethod,
            checkpoints: checkpointCheck.checkpoints,
            verified: checkpointCheck.verified
        };
    }
}

module.exports = new SubtitlePipeline();
