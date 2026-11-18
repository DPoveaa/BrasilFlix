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
const SubtitleUtils = require('../utils/SubtitleUtils');
const SubtitleAudioService = require('./SubtitleAudioService');

const execFileAsync = promisify(execFile);

class SubtitlePipeline {
    constructor() {
        this.pythonExec = process.env.SUBTITLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
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
     * Detecta se a legenda é Português de Portugal com base em critérios objetivos:
     * - Construções típicas do gerúndio europeu: "estar a + INFINITIVO" (ex: "estou a fazer", "está a dizer", "estão a falar")
     * - Vocabulário genuinamente europeu: "ecrã", "comboio", "telemóvel", "autocarro", "pequeno-almoço", "frigorífico", "miúdo", "gajo", "fixe"
     * - NÃO classifica como PT-PT se "você/vocês" estiver presente (>= 2 vezes), a menos que haja saturação extrema (>= 8 ocorrências).
     * - NUNCA classifica como PT-PT frases comuns do Brasil como "está a caminho", "está a salvo", "esta a porta", etc.
     */
    isEuropeanPortugueseSubtitle(content) {
        if (!content || typeof content !== 'string') return false;
        const text = content.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        // "Comboio", "a ver" and "a fazer" also occur naturally in Brazilian dialogue.
        const vocabulary = text.match(/\b(ecra|telemovel|autocarro|frigorifico|pequeno[- ]almoco|miudo|gajo)\b/g) || [];
        const progressive = text.match(/\b(?:estou|estas|esta|estamos|estao) a [a-z]+(?:ar|er|ir)\b/g) || [];
        const brazilian = (text.match(/\b(voce|voces|a gente)\b/g) || []).length;
        const evidence = vocabulary.length + progressive.length;
        return (evidence >= 8 && evidence > brazilian * 2) ||
            (brazilian < 2 && evidence >= 3 && new Set(vocabulary).size >= 2);
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
     * LANGUAGE SAFETY GATE: Detecta e rejeita legendas em Romeno ou outros idiomas
     * do Leste Europeu que podem ter sido tagueados erroneamente como "por"/"pt"/"und".
     *
     * Critérios:
     *  1. Rejeição imediata se contiver diacríticos típicos do Romeno / Leste-Europeu
     *     (ă Ă ș Ș ț Ț î Î) — esses caracteres são INEXISTENTES no português.
     *     Diacríticos adicionais do Polonês/Tcheco/Eslovaco (ł ń ż ź č ř ě) também rejeitam.
     *  2. Exige taxa de acerto >= 4% de stopwords INCONFUNDÍVEIS do PT-BR
     *     (não, você, está, para, com, que, uma, isso, aqui, muito, mas, por,
     *      como, também, já) em amostragem de até 120 cues.
     *     Essa taxa garante que o texto é genuinamente português e não
     *     um idioma que coincidentemente passa pelo filtro léxico básico.
     *
     * @param {string} content   - texto bruto/completo da legenda (SRT ou plain)
     * @param {string[]} [cueTexts] - array opcional de textos dos cues já parseados
     * @returns {{ valid: boolean, reason: string }}
     */
    validatePtBrTextSafety(content, cueTexts = null) {
        if (!content || typeof content !== 'string') {
            return { valid: false, reason: 'Conteúdo vazio' };
        }

        cueTexts ||= SubtitleUtils.parseSubtitles(content).map(cue => cue.text);
        if (!cueTexts.length) cueTexts = null;

        // --- 1. Rejeição imediata por diacríticos inexistentes no Português ---
        // Romeno: ă Ă ș Ș ț Ț î Î  (note: î é diferente de í/ì)
        // Polonês/Tcheco: ł ń ż ź č ř ě
        const easternEuropeanDiacritics = /[ăĂșȘțȚîÎłńżźčřě]/;
        if (easternEuropeanDiacritics.test(content)) {
            // Conta ocorrências para evitar falso-positivo por caractere único
            const hits = (content.match(/[ăĂșȘțȚîÎłńżźčřě]/g) || []).length;
            if (hits >= 1) {
                return {
                    valid: false,
                    reason: `Detectado ${hits} diacrítico(s) de idioma Leste-Europeu (Romeno/Polonês) inexistente(s) em Português: "${content.match(/[ăĂșȘțȚîÎłńżźčřě]/g).slice(0, 5).join(' ')}"`
                };
            }
        }

        // --- 2. Taxa mínima de stopwords PT-BR inconfundíveis ---
        // Amostra até 120 cues distribuídos pelo arquivo
        const textToSample = cueTexts
            ? (() => {
                const step = Math.max(1, Math.floor(cueTexts.length / 120));
                const sampled = [];
                for (let i = 0; i < cueTexts.length; i += step) sampled.push(cueTexts[i]);
                return sampled.join(' ');
            })()
            : content.slice(0, 40000); // fallback: primeiros 40k chars

        const norm = textToSample.toLowerCase();

        // Stopwords absolutamente inequívocas do Português (incluindo formas acentuadas e não-acentuadas)
        const ptStopwordPattern = /\b(não|nao|você|voce|está|esta\b|para\b|com\b|que\b|uma\b|isso|aqui|muito|mas\b|por\b|como\b|também|tambem|já\b|ja\b|ele\b|ela\b|nos\b|seu\b|sua\b|são|sao\b|ter\b|ser\b|por\b|mais\b)\b/gi;
        const stopwordHits = (norm.match(ptStopwordPattern) || []).length;

        // Conta palavras totais no sample (aproximação)
        const totalWords = (norm.match(/\b\w{2,}\b/g) || []).length || 1;
        const hitRate = stopwordHits / totalWords;

        // Exige pelo menos 4% de stopwords PT — textos romenos típicos ficam abaixo de 0.3%
        if (hitRate < 0.04 || stopwordHits < 5) {
            return {
                valid: false,
                reason: `Taxa de stopwords PT-BR insuficiente: ${stopwordHits} hits em ${totalWords} palavras (${(hitRate * 100).toFixed(2)}% < 4%). Provável idioma não-português.`
            };
        }

        const portuguese = norm.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const distinctive = portuguese.match(/\b(nao|voce|voces|sao|entao|tambem|obrigado|obrigada|tenho|tinha|comigo|ninguem|alguem|minha|meu|muito|estou|fazer|olha|agora|ainda|preciso)\b/g) || [];
        if (distinctive.length < 5 || new Set(distinctive).size < 2) {
            return { valid: false, reason: 'Evidência textual insuficiente de português.' };
        }

        return { valid: true, reason: 'OK' };
    }

    /**
     * Builds the array of FFmpeg/FFprobe input flags required before `-i <url>`.
     * For HTTP(S) URLs, injects reconnect flags so transient TCP drops do not abort
     * a full-movie audio extraction. For local files, returns an empty array.
     */
    _buildInputFlags(videoPath) {
        const isHttp = typeof videoPath === 'string' && /^https?:\/\//i.test(videoPath);
        if (!isHttp) return [];
        return [
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_on_network_error', '1',
            '-reconnect_on_http_error', '429,5xx',
            '-rw_timeout', '30000000',
            '-reconnect_delay_max', '5'
        ];
    }

    /**
     * Mede a duração real do stream de vídeo com precisão cirúrgica via ffprobe.
     * Para URLs HTTP (stream do Telegram via StremioServer interno) injeta flags de
     * reconnect para tolerar quedas transitórias de TCP durante a sondagem.
     */
    async probeActualVideoDuration(videoPath) {
        if (!videoPath) return 0;
        try {
            console.log(`⏱️ [Video Probe] Medindo duração real da mídia com ffprobe: ${videoPath.substring(0, 80)}...`);
            const inputFlags = this._buildInputFlags(videoPath);
            const { stdout } = await execFileAsync('ffprobe', [
                ...inputFlags,
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                videoPath
            ], { timeout: 60000 });
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
     * QUALITY GATE: Validação de Cobertura (>= 65%) e Densidade Mínima (>= 2.0 falas/min)
     */
    validateCandidateCoverageAndDensity(cues, videoDurationSec, candidateLabel = 'Candidato') {
        if (!Array.isArray(cues) || cues.length === 0) {
            return { valid: false, reason: 'Arquivo de legenda vazio ou sem falas' };
        }

        if (cues.length < 20) {
            return { valid: false, reason: `Poucas falas (${cues.length} cues, mínimo 20)` };
        }

        if (videoDurationSec > 0 && cues.some(c => c.endMs > (videoDurationSec + 10) * 1000)) {
            return { valid: false, reason: 'Falas ultrapassam a duração do vídeo.' };
        }
        if (videoDurationSec && videoDurationSec >= 600) {
            const movieMinutes = videoDurationSec / 60;
            const lastCue = this.getLastDialogueCue(cues);
            const lastCueEndSec = lastCue ? lastCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;
            const coverageRatio = lastCueEndSec / videoDurationSec;

            // Minimum Coverage Gate: Permite filmes com créditos longos, músicas finais e extras (>= 65%)
            if (coverageRatio < 0.65) {
                return {
                    valid: false,
                    reason: `Última fala em ${(lastCueEndSec / 60).toFixed(1)}min termina antes de 65% da duração do vídeo (${movieMinutes.toFixed(1)}min). Cobertura: ${(coverageRatio * 100).toFixed(1)}% < 65%`
                };
            }

            // Minimum Cue Density: Permite animações, longas de suspense e ação com diálogos espaçados (>= 2.0 falas/min)
            const cueDensity = cues.length / movieMinutes;
            if (movieMinutes >= 40 && cueDensity < 2.0) {
                return {
                    valid: false,
                    reason: `Densidade de falas excessivamente baixa (${cueDensity.toFixed(2)} falas/min < 2.0 falas/min). Total: ${cues.length} falas em ${movieMinutes.toFixed(1)}min`
                };
            }
        }

        return { valid: true };
    }

    /**
     * Valida se a legenda tem vocabulário autêntico de Português Brasileiro (PT-BR).
     *
     * FLUXO DE VALIDAÇÃO (ordem de verificação):
     *  0. SAFETY GATE ESTRITO: detecta e rejeita diacríticos romenos/leste-europeus e
     *     exige taxa mínima de stopwords PT — aplicado a TODOS os candidatos, sem exceção,
     *     antes de qualquer análise de metadados/tags. Isso evita que uma trilha romena
     *     tagueada como "por" ou "und" passe pela validação.
     *  1. Confiança nos Metadados / Tags da Fonte (após passar o Safety Gate):
     *     - pob, pt-br, pt_br, ptbr, brazilian, bra, br_pt, br-pt, por_br -> aprova como PT-BR.
     *     - pt-pt, pt_pt, portugal -> rejeita imediatamente.
     *  2. Análise textual para código genérico ("por" ou sem país explícito):
     *     - Se você/vocês aparecer 2+ vezes -> aprova como PT-BR.
     *     - Rejeita como PT-PT se houver pelo menos 3 construções europeias.
     *
     * @param {string} content - texto da legenda
     * @param {string} [sourceLang] - código de idioma retornado pela API/fonte (ex: "pob", "por", "pt-pt")
     * @param {string} [sourceFile] - nome do arquivo/release (para detectar tags no filename)
     * @param {string[]} [cueTexts] - array opcional de textos dos cues já parseados (para o safety gate)
     */
    isBrazilianPortugueseSubtitle(content, sourceLang = '', sourceFile = '', cueTexts = null) {
        if (!content || typeof content !== 'string') return false;

        // 0. SAFETY GATE ESTRITO (roda SEMPRE, independentemente de tags/metadados)
        //    Detecta Romeno, Polonês e outros idiomas E-Europeus; exige taxa mínima de stopwords PT.
        const safetyCheck = this.validatePtBrTextSafety(content, cueTexts);
        if (!safetyCheck.valid) {
            console.warn(`🚫 [PT-BR Safety Gate] Candidato REJEITADO: ${safetyCheck.reason}`);
            return false;
        }

        const lang = (sourceLang || '').toLowerCase().trim();
        const file = (sourceFile || '').toLowerCase();

        if (['pt-pt', 'pt_pt', 'ptpt'].includes(lang) || /\b(pt[-_]pt|ptpt|portugal)\b/.test(file)) return false;
        if (this.isEuropeanPortugueseSubtitle(content)) return false;
        return this.isPortugueseLanguage(content);
    }

    /**
     * TIER 1: Procura e extrai legendas embutidas no próprio container de vídeo (MKV/MP4)
     */
    async probeAndExtractContainerSubtitle(videoPath, metadata = {}) {
        try {
            console.log(`🔍 [Tier 1: Container Stream] Sondando trilhas de legenda embutidas em "${path.basename(videoPath)}"...`);
            const inputFlags = this._buildInputFlags(videoPath);
            const { stdout } = await execFileAsync('ffprobe', [
                ...inputFlags,
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: inputFlags.length > 0 ? 60000 : 30000 });

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
                        ...inputFlags,
                        '-i', videoPath,
                        '-map', `0:${subIndex}`,
                        '-c:s', 'srt',
                        outPath
                    ], { timeout: 60000 });

                    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
                        const rawBuffer = await fs.readFile(outPath);
                        const sanitized = this.sanitizeEncoding(rawBuffer);
                        const cues = this.parseSrt(sanitized);
                        const cueTexts = cues.map(c => c.text);

                        if (cues.length >= 20 && this.isBrazilianPortugueseSubtitle(sanitized, streamLang, '', cueTexts)) {
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
     * Extrai trilha humana em inglês ou espanhol embutida no container (para Priority 3 Fallback)
     */
    async probeAndExtractContainerForeignSubtitle(videoPath) {
        try {
            const inputFlags = this._buildInputFlags(videoPath);
            const { stdout } = await execFileAsync('ffprobe', [
                ...inputFlags,
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: inputFlags.length > 0 ? 60000 : 30000 });

            const data = JSON.parse(stdout);
            const subStreams = (data.streams || []).filter(s => s.codec_type === 'subtitle');
            if (subStreams.length === 0) return null;

            const foreignStreams = subStreams.filter(s => {
                const lang = (s.tags?.language || s.tags?.lang || '').toLowerCase();
                const title = (s.tags?.title || '').toLowerCase();
                const isForeign = ['eng', 'en', 'english', 'spa', 'es', 'spanish', 'espanol', 'español'].includes(lang) ||
                    title.includes('english') || title.includes('spanish') || title.includes('español');
                const isBad = (s.disposition?.forced === 1) || /forced|for[cç]ad|signs|songs|commentary/i.test(title);
                return isForeign && !isBad;
            });

            if (foreignStreams.length === 0) return null;

            const videoDir = this.getWorkingDir(videoPath);
            for (const stream of foreignStreams) {
                const lang = (stream.tags?.language || stream.tags?.lang || '').toLowerCase();
                const cleanLang = ['spa', 'es', 'spanish', 'espanol', 'español'].includes(lang) ? 'es' : 'en';
                const outPath = path.join(videoDir, `embedded_foreign_${cleanLang}_${Date.now()}_stream${stream.index}.srt`);

                try {
                    await execFileAsync('ffmpeg', [
                        '-nostdin', '-v', 'error', '-y',
                        ...inputFlags,
                        '-i', videoPath,
                        '-map', `0:${stream.index}`,
                        '-c:s', 'srt',
                        outPath
                    ], { timeout: 60000 });

                    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 500) {
                        const raw = await fs.readFile(outPath);
                        const sanitized = this.sanitizeEncoding(raw);
                        const cues = this.parseSrt(sanitized);
                        if (cues.length >= 20) {
                            await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                            console.log(`🎯 [Foreign Subtitle] Trilha humana embutida [${cleanLang.toUpperCase()}] extraída do container (${cues.length} cues)!`);
                            return {
                                srtPath: outPath,
                                cueCount: cues.length,
                                lang: cleanLang,
                                source: 'container_embedded_foreign',
                                sourceMethod: `Trilha Embutida no Container (${cleanLang.toUpperCase()})`
                            };
                        }
                    }
                    await fs.remove(outPath).catch(() => { });
                } catch (_) {
                    await fs.remove(outPath).catch(() => { });
                }
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    /**
     * Extrai trilha de legenda em inglês do container ou busca no OpenSubtitles para servir de referência sub-to-sub
     */
    async extractEnglishReferenceSubtitle(videoPath, metadata = {}, videoDurationSec = 0) {
        // 1. Tenta extrair do container
        try {
            const inputFlags = this._buildInputFlags(videoPath);
            const { stdout } = await execFileAsync('ffprobe', [
                ...inputFlags,
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: inputFlags.length > 0 ? 60000 : 30000 });

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
                    ...inputFlags,
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
                    const cueTexts = cues.map(c => c.text);
                    if (cues.length >= 30 && this.isBrazilianPortugueseSubtitle(sanitized, '', item.name, cueTexts)) {
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
     * Resolve e enriquece metadados completos do filme/série via TMDB (IMDb ID, TMDB ID, Título Original, Título PT, Ano ± 1)
     */
    async resolveMovieMetadata(metadata = {}) {
        const resolved = { ...metadata };
        let imdbId = resolved.imdbId;
        let tmdbId = resolved.tmdbId;
        const tipo = resolved.tipo === 'serie' ? 'tv' : 'movie';

        // 1. Se tem tmdbId mas não tem imdbId
        if (!imdbId && tmdbId) {
            try {
                const extRes = await axios.get(`https://api.themoviedb.org/3/${tipo}/${tmdbId}/external_ids`, {
                    params: { api_key: config.TMDB_API_KEY },
                    timeout: 6000
                });
                if (extRes.data?.imdb_id) {
                    imdbId = extRes.data.imdb_id;
                    resolved.imdbId = imdbId;
                }
            } catch (_) {}
        }

        // 2. Se tem imdbId mas não tem tmdbId
        if (!tmdbId && imdbId) {
            try {
                const findRes = await axios.get(`https://api.themoviedb.org/3/find/${imdbId}`, {
                    params: { api_key: config.TMDB_API_KEY, external_source: 'imdb_id' },
                    timeout: 6000
                });
                const item = findRes.data?.movie_results?.[0] || findRes.data?.tv_results?.[0];
                if (item?.id) {
                    tmdbId = item.id;
                    resolved.tmdbId = tmdbId;
                    if (!resolved.year && (item.release_date || item.first_air_date)) {
                        resolved.year = (item.release_date || item.first_air_date).slice(0, 4);
                    }
                    if (!resolved.originalTitle && (item.original_title || item.original_name)) {
                        resolved.originalTitle = item.original_title || item.original_name;
                    }
                    if (!resolved.title && (item.title || item.name)) {
                        resolved.title = item.title || item.name;
                    }
                }
            } catch (_) {}
        }

        // 3. Se não tem imdbId nem tmdbId, busca no TMDB pelo título em inglês ou português com ano ± 1
        if (!imdbId && !tmdbId) {
            const queryTitle = resolved.nomeOriginal || resolved.originalTitle || resolved.nome || resolved.title;
            if (queryTitle && queryTitle.length >= 2) {
                try {
                    const searchRes = await axios.get(`https://api.themoviedb.org/3/search/${tipo}`, {
                        params: {
                            api_key: config.TMDB_API_KEY,
                            query: queryTitle,
                            language: 'pt-BR'
                        },
                        timeout: 7000
                    });
                    const results = searchRes.data?.results || [];
                    if (results.length > 0) {
                        let bestMatch = results[0];
                        const targetYear = parseInt(resolved.year || resolved.ano, 10);
                        if (!isNaN(targetYear) && targetYear > 1900) {
                            const closeYear = results.find(r => {
                                const y = parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10);
                                return Math.abs(y - targetYear) <= 1;
                            });
                            if (closeYear) bestMatch = closeYear;
                        }

                        resolved.tmdbId = bestMatch.id;
                        resolved.originalTitle = bestMatch.original_title || bestMatch.original_name || queryTitle;
                        resolved.title = bestMatch.title || bestMatch.name || queryTitle;
                        resolved.year = (bestMatch.release_date || bestMatch.first_air_date || '').slice(0, 4) || resolved.year;

                        const extRes = await axios.get(`https://api.themoviedb.org/3/${tipo}/${bestMatch.id}/external_ids`, {
                            params: { api_key: config.TMDB_API_KEY },
                            timeout: 6000
                        });
                        if (extRes.data?.imdb_id) {
                            resolved.imdbId = extRes.data.imdb_id;
                        }
                    }
                } catch (_) {}
            }
        }

        return resolved;
    }

    /**
     * TIER 3: Busca externa por PT-BR humano via OpenSubtitles / Stremio API
     * Prioriza 'pob', 'pt-br', 'brazilian', 'por' autêntico e rejeita PT-PT
     */
    async fetchExternalSubtitle(videoPath, metadata = {}, videoDurationSec = 0) {
        try {
            if (!videoDurationSec || videoDurationSec < 120) {
                try {
                    const { stdout } = await execFileAsync('ffprobe', [
                        '-v', 'quiet', '-print_format', 'json', '-show_format', videoPath
                    ], { timeout: 15000 });
                    videoDurationSec = parseFloat(JSON.parse(stdout).format?.duration || 0);
                } catch (_) { }
            }

            const meta = await this.resolveMovieMetadata(metadata);
            const imdbId = meta.imdbId;

            if (!imdbId) {
                console.warn(`⚠️ [Tier 3: OpenSubtitles] Sem IMDb ID para consulta.`);
                return null;
            }

            console.log(`🌐 [Tier 3: OpenSubtitles] Consultando legendas PT-BR para "${meta.originalTitle || meta.title || meta.nome}" (${imdbId})...`);

            const season = meta.season || 1;
            const episode = meta.episode || 1;
            const streamPath = meta.tipo === 'serie'
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
                        if (/\bpt[-.]?pt\b|\bportugal\b|\bpt[-_]por\b/.test(rel)) continue;

                        if (['pob', 'pt-br', 'brazilian', 'por', 'pt', 'ptbr'].includes(lang)) {
                            urlSeen.add(subUrl);
                            allCandidateSubs.push(s);
                        }
                    }
                } catch (_) { }
            }

            if (allCandidateSubs.length === 0) {
                console.warn(`⚠️ [Tier 3: OpenSubtitles] Nenhuma legenda em Português encontrada.`);
                return null;
            }

            // Ranqueamento priorizando PT-BR genuíno e tokens compatíveis
            const scored = allCandidateSubs.map(sub => {
                const rel = (sub.movieReleaseName || sub.releaseName || '').toLowerCase();
                const subUrl = (sub.url || '').toLowerCase();
                const subTokens = tokenize(rel);
                const common = subTokens.filter(t => fileTokens.includes(t)).length;
                let score = common * 4;

                const lang = (sub.lang || sub.language || '').toLowerCase();
                if (['pob', 'pt-br', 'brazilian', 'ptbr'].includes(lang)) {
                    score += 150;
                } else if (['por', 'pt'].includes(lang)) {
                    score += 10;
                }

                if (/\b(brazil|brasil|pt[-._]?br|ptbr|dublado|nacional)\b/.test(rel)) {
                    score += 60;
                }

                const ptPtPenalty = this.getPtPtReleaseNamePenalty(rel) || this.getPtPtReleaseNamePenalty(subUrl);
                if (ptPtPenalty > 0) score -= ptPtPenalty;

                score += parseInt(sub.g || 0, 10);
                return { sub, score };
            }).sort((a, b) => b.score - a.score);

            console.log(`🌐 [Tier 3: OpenSubtitles] ${scored.length} candidatos agregados. Baixando e validando PT-BR...`);

            const validCandidates = [];
            for (let i = 0; i < Math.min(scored.length, 6); i++) {
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

                    const cues = this.parseSrt(sanitized);
                    const cueTexts = cues.map(c => c.text);

                    if (!this.isBrazilianPortugueseSubtitle(sanitized, subLang, relName, cueTexts)) {
                        console.warn(`⚠️ [Tier 3: OpenSubtitles] Candidato #${i + 1} rejeitado pelo Safety Gate PT-BR (lang: ${subLang}, release: ${relName.slice(0, 60)}).`);
                        continue;
                    }

                    const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `OpenSubtitles #${i + 1}`);
                    if (!gate.valid) {
                        console.warn(`⚠️ Candidato OpenSubtitles #${i + 1} rejeitado no Quality Gate: ${gate.reason}`);
                        continue;
                    }

                    const candidatePath = path.join(this.getWorkingDir(videoPath), `opensubs_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidatePath, this.buildSrt(cues), 'utf8');
                    console.log(`✅ [Tier 3: OpenSubtitles] Candidato #${i + 1} aprovado como PT-BR humano (${cues.length} cues, score: ${score})!`);

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
                    console.warn(`⚠️ Falha ao baixar candidato OpenSubtitles #${i + 1}:`, dlErr.message);
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

            return null;
        } catch (e) {
            console.warn(`⚠️ [Tier 3: OpenSubtitles] Erro na busca externa:`, e.message);
            return null;
        }
    }

    /**
     * TIER 3.5: Busca de legendas humanas PT-BR no SubDL Pool
     * Busca por IMDb ID, TMDB ID, Título Original em Inglês e Título em Português com ano ± 1
     */
    async fetchSubdlSubtitle(videoPath, metadata = {}, videoDurationSec = 0) {
        if (!SubdlService.isAvailable()) {
            console.log(`ℹ️ [Tier 3.5: SubDL API] Serviço indisponível: nenhuma chave configurada.`);
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

            const meta = await this.resolveMovieMetadata(metadata);
            console.log(`🌐 [Tier 3.5: SubDL API] Buscando legendas PT-BR no SubDL para "${meta.originalTitle || meta.title || meta.nome}" (Ano: ${meta.year || 'N/A'})...`);

            const searchParams = {
                imdbId: meta.imdbId,
                tmdbId: meta.tmdbId,
                type: meta.tipo,
                season: meta.season,
                episode: meta.episode,
                title: meta.title || meta.nome,
                originalTitle: meta.originalTitle || meta.nomeOriginal,
                year: meta.year || meta.ano,
                languages: 'BR_PT'
            };

            const rawSubtitles = await SubdlService.searchSubtitles(searchParams);
            if (!rawSubtitles || rawSubtitles.length === 0) {
                console.warn(`⚠️ [Tier 3.5: SubDL API] Nenhuma legenda PT-BR encontrada no SubDL.`);
                return null;
            }

            const videoFileName = path.basename(videoPath);
            const rankedSubtitles = SubdlService.rankCandidates(rawSubtitles, videoFileName, meta);
            console.log(`🌐 [Tier 3.5: SubDL API] ${rankedSubtitles.length} legendas PT-BR encontradas. Baixando candidatos...`);

            const videoDir = this.getWorkingDir(videoPath);
            const maxCandidatesToDownload = Math.min(rankedSubtitles.length, 4);
            const validCandidates = [];

            for (let i = 0; i < maxCandidatesToDownload; i++) {
                const candidate = rankedSubtitles[i];
                let extractedSrtPath = null;
                try {
                    extractedSrtPath = await SubdlService.downloadAndExtractSubtitle(candidate, videoDir);
                    if (!fs.existsSync(extractedSrtPath)) continue;

                    const rawBuffer = await fs.readFile(extractedSrtPath);
                    const sanitized = this.sanitizeEncoding(rawBuffer);
                    const candidateLang = candidate.language || candidate.lang || 'BR_PT';
                    const candidateRel = candidate.release_name || candidate.name || '';

                    const cues = this.parseSrt(sanitized);
                    const cueTexts = cues.map(c => c.text);

                    if (!this.isBrazilianPortugueseSubtitle(sanitized, candidateLang, candidateRel, cueTexts)) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado pelo Safety Gate PT-BR (lang: ${candidateLang}, release: ${candidateRel.slice(0, 60)}).`);
                        await fs.remove(extractedSrtPath).catch(() => { });
                        continue;
                    }

                    const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `SubDL #${i + 1}`);
                    if (!gate.valid) {
                        console.warn(`⚠️ [Tier 3.5: SubDL API] Candidato #${i + 1} rejeitado no Quality Gate: ${gate.reason}`);
                        await fs.remove(extractedSrtPath).catch(() => { });
                        continue;
                    }

                    const candidateFinalPath = path.join(videoDir, `subdl_ptbr_${Date.now()}_cand${i + 1}.srt`);
                    await fs.writeFile(candidateFinalPath, this.buildSrt(cues), 'utf8');
                    await fs.remove(extractedSrtPath).catch(() => { });

                    console.log(`✅ [Tier 3.5: SubDL API] Candidato #${i + 1} APROVADO como PT-BR humano (${cues.length} cues, release: "${candidate.release_name || candidate.name}")!`);
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

            return null;
        } catch (err) {
            console.warn(`⚠️ [Tier 3.5: SubDL API] Erro ao buscar legendas no SubDL:`, err.message);
            return null;
        }
    }

    /**
     * PRIORITY 3 FALLBACK: Busca legendas humanas em Inglês (EN) ou Espanhol (ES)
     * quando nenhuma legenda PT-BR existe.
     * Fontes: Container embutido -> Companion Package -> OpenSubtitles -> SubDL
     */
    async fetchForeignSubtitleCandidates(videoPath, metadata = {}, videoDurationSec = 0) {
        const meta = await this.resolveMovieMetadata(metadata);
        const videoDir = this.getWorkingDir(videoPath);

        // 1. Trilha embutida no container
        const embeddedForeign = await this.probeAndExtractContainerForeignSubtitle(videoPath);
        if (embeddedForeign && embeddedForeign.srtPath && fs.existsSync(embeddedForeign.srtPath)) {
            return embeddedForeign;
        }

        // 2. Legenda de referência companheira na pasta
        const companion = await this.findCompanionSubtitles(videoPath, meta);
        if (companion.refEnPath && fs.existsSync(companion.refEnPath)) {
            const raw = await fs.readFile(companion.refEnPath, 'utf8');
            const cues = this.parseSrt(this.sanitizeEncoding(raw));
            if (cues.length >= 20) {
                return {
                    srtPath: companion.refEnPath,
                    cueCount: cues.length,
                    lang: 'en',
                    sourceMethod: 'Companion Package (EN)'
                };
            }
        }

        // 3. OpenSubtitles (Stremio endpoints para EN e ES)
        if (meta.imdbId) {
            const streamPath = meta.tipo === 'serie'
                ? `series/${meta.imdbId}:${meta.season || 1}:${meta.episode || 1}.json`
                : `movie/${meta.imdbId}.json`;

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
                    const foreignSubs = subs.filter(s => {
                        const l = (s.lang || s.language || '').toLowerCase();
                        return ['eng', 'en', 'spa', 'es'].includes(l);
                    });

                    for (const sub of foreignSubs.slice(0, 4)) {
                        if (!sub.url) continue;
                        const subLang = ['spa', 'es'].includes((sub.lang || sub.language || '').toLowerCase()) ? 'es' : 'en';
                        const dlRes = await axios.get(sub.url, {
                            timeout: 10000,
                            responseType: 'arraybuffer',
                            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
                        });
                        const sanitized = this.sanitizeEncoding(Buffer.from(dlRes.data));
                        const cues = this.parseSrt(sanitized);
                        const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `OpenSubtitles ${subLang.toUpperCase()}`);
                        if (gate.valid) {
                            const outPath = path.join(videoDir, `foreign_${subLang}_${Date.now()}.srt`);
                            await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                            return {
                                srtPath: outPath,
                                cueCount: cues.length,
                                lang: subLang,
                                sourceMethod: `OpenSubtitles (${subLang.toUpperCase()} - ${sub.movieReleaseName || sub.releaseName || 'Oficial'})`
                            };
                        }
                    }
                } catch (_) { }
            }
        }

        // 4. SubDL API com filtro languages: 'EN,ES'
        if (SubdlService.isAvailable() && (meta.imdbId || meta.tmdbId || meta.originalTitle)) {
            try {
                const foreignSubdl = await SubdlService.searchSubtitles({
                    imdbId: meta.imdbId,
                    tmdbId: meta.tmdbId,
                    type: meta.tipo,
                    season: meta.season,
                    episode: meta.episode,
                    title: meta.title || meta.nome,
                    originalTitle: meta.originalTitle || meta.nomeOriginal,
                    year: meta.year || meta.ano,
                    languages: 'EN,ES'
                });

                if (Array.isArray(foreignSubdl) && foreignSubdl.length > 0) {
                    for (const sub of foreignSubdl.slice(0, 3)) {
                        try {
                            const srtPath = await SubdlService.downloadAndExtractSubtitle(sub, videoDir);
                            const raw = await fs.readFile(srtPath);
                            const cues = this.parseSrt(this.sanitizeEncoding(raw));
                            const gate = this.validateCandidateCoverageAndDensity(cues, videoDurationSec, `SubDL Foreign`);
                            if (gate.valid) {
                                const subLang = (sub.language || sub.lang || '').toUpperCase().includes('ES') ? 'es' : 'en';
                                const outPath = path.join(videoDir, `foreign_subdl_${subLang}_${Date.now()}.srt`);
                                await fs.writeFile(outPath, this.buildSrt(cues), 'utf8');
                                await fs.remove(srtPath).catch(() => { });
                                return {
                                    srtPath: outPath,
                                    cueCount: cues.length,
                                    lang: subLang,
                                    sourceMethod: `SubDL API (${subLang.toUpperCase()} - ${sub.release_name || sub.name})`
                                };
                            }
                            await fs.remove(srtPath).catch(() => { });
                        } catch (_) { }
                    }
                }
            } catch (_) { }
        }

        return null;
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

        const cleanedCues = rawCues.map(cue => ({ ...cue, text: SubtitleUtils.cleanCueText(cue.text) }))
            .filter(cue => cue.text);
        const cleanContent = this.buildSrt(cleanedCues);
        if (!this.isBrazilianPortugueseSubtitle(cleanContent, '', '', cleanedCues.map(c => c.text))) {
            throw new Error('Quality Gate: conteúdo não confirmado como PT-BR.');
        }
        const coverage = this.validateCandidateCoverageAndDensity(cleanedCues, videoDurationSec);
        if (!coverage.valid) throw new Error(`Quality Gate: ${coverage.reason}`);

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
     * Extrai áudio leve 16kHz mono WAV/PCM across 100% da duração do vídeo com compensação de offset PTS.
     * Sonda start_time do vídeo e do áudio e aplica `aresample=async=1:first_pts=0`
     * para garantir que t=0.000s no Whisper case cirurgicamente com t=0.000s no player HTML5.
     *
     * Para URLs HTTP (Telegram stream interno via StremioServer):
     *  - Injeta -reconnect/-reconnect_streamed/-reconnect_delay_max antes de -i
     *  - Usa índice relativo de stream de áudio (`0:a:N`) em vez do índice global (`0:N`)
     *    para evitar que o índice errado seja selecionado quando a sondagem falha.
     *  - Captura e loga o stderr completo do FFmpeg em vez de engolir a mensagem genérica.
     */
    async extractCleanAudioWav(videoPath, outputWavPath, videoDurationSec = 0, audioIndex = 0) {
        // Garante que o diretório de destino existe antes de spawnar o FFmpeg
        const outputDir = path.dirname(outputWavPath);
        fs.mkdirSync(outputDir, { recursive: true });

        const inputFlags = this._buildInputFlags(videoPath);
        const isHttp = inputFlags.length > 0;

        let channels = 2;
        // relativeAudioIdx: índice RELATIVO dentro dos streams de áudio (0:a:N), sempre seguro.
        // O índice global (0:N) pode ser incorreto se o ffprobe falhar e cair no default.
        let relativeAudioIdx = Math.max(0, Number(audioIndex) || 0);
        let ptsDelaySec = 0;

        try {
            const { stdout: probeOut } = await execFileAsync('ffprobe', [
                ...inputFlags,
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                videoPath
            ], { timeout: isHttp ? 60000 : 25000 });
            const data = JSON.parse(probeOut);
            const streams = data.streams || [];
            const vStream = streams.find(s => s.codec_type === 'video');
            const audioStreams = streams.filter(s => s.codec_type === 'audio');
            const aStream = audioStreams[relativeAudioIdx] || audioStreams[0];

            if (aStream) {
                // Use relative audio index (0:a:N) — safe even when stream ordering is unusual
                relativeAudioIdx = Math.max(0, audioStreams.indexOf(aStream));
                channels = parseInt(aStream.channels, 10) || 2;
                const vStart = parseFloat(vStream?.start_time || '0') || 0;
                const aStart = parseFloat(aStream.start_time || '0') || 0;
                ptsDelaySec = aStart - vStart;
                if (Math.abs(ptsDelaySec) > 0.005) {
                    console.log(`⏱️ [Audio Extractor] Container Audio-to-Video PTS offset detectado: ${(ptsDelaySec * 1000).toFixed(1)}ms (video start: ${vStart.toFixed(3)}s, audio start: ${aStart.toFixed(3)}s). Sincronizando com aresample=async=1:first_pts=0...`);
                }
            }
        } catch (e) {
            const probeStderr = e.stderr ? `\n  stderr: ${e.stderr.trim().split('\n').slice(-5).join(' | ')}` : '';
            console.warn(`⚠️ [Audio Extractor] Aviso ao sondar streams do vídeo (fallback para 0:a:0): ${e.message}${probeStderr}`);
        }

        // Sincroniza audio samples com aresample=async=1:first_pts=0 para garantir que t=0.000s no Whisper
        // coincida exatamente com t=0.000s na linha de apresentação do player HTML5 <video>
        const filterParts = ['aresample=async=1:first_pts=0'];

        if (channels >= 6) {
            // Isola canal central (diálogo c2) em layout surround 5.1 e passa-banda vocal
            filterParts.push('pan=mono|c0=c2');
            filterParts.push('highpass=f=200,lowpass=f=3500');
            filterParts.push('volume=1.5');
        } else {
            // Passa-banda vocal para isolar fala humana
            filterParts.push('highpass=f=200,lowpass=f=3500');
        }

        const filterChain = filterParts.join(',');
        // Always use relative audio stream index (0:a:N) — never the global stream index.
        // 0:a:0 = first audio track; safe even if ffprobe succeeded and confirmed index 0.
        const mapArg = `0:a:${relativeAudioIdx}`;

        console.log(`🎙️ [Audio Extractor] Extraindo áudio mono 16kHz across 100% da duração com PTS sync (async=1:first_pts=0, stream ${mapArg}, ${channels} canais${isHttp ? ', HTTP reconnect: ON' : ''})...`);

        const buildFfmpegArgs = (filterArg) => [
            '-nostdin', '-v', 'error', '-y',
            ...inputFlags,
            '-i', videoPath,
            '-map', mapArg,
            '-vn',
            '-af', filterArg,
            '-ac', '1',
            '-ar', '16000',
            '-c:a', 'pcm_s16le',
            outputWavPath
        ];

        try {
            await execFileAsync('ffmpeg', buildFfmpegArgs(filterChain), { timeout: 20 * 60 * 1000 });
        } catch (err) {
            // Surface the full FFmpeg stderr in PM2 logs so the real error is immediately visible
            const ffmpegStderr = err.stderr ? err.stderr.trim().split('\n').slice(-15).join('\n  ') : '(sem stderr)';
            console.warn(`⚠️ [Audio Extractor] Falha no filtro vocal. Tentando fallback direto com aresample=async=1:first_pts=0...`);
            console.warn(`  FFmpeg stderr (últimas 15 linhas):\n  ${ffmpegStderr}`);
            try {
                await execFileAsync('ffmpeg', buildFfmpegArgs('aresample=async=1:first_pts=0'), { timeout: 20 * 60 * 1000 });
            } catch (fallbackErr) {
                const fallbackStderr = fallbackErr.stderr ? fallbackErr.stderr.trim().split('\n').slice(-15).join('\n  ') : '(sem stderr)';
                console.error(`❌ [Audio Extractor] Falha também no fallback FFmpeg.`);
                console.error(`  FFmpeg stderr (fallback, últimas 15 linhas):\n  ${fallbackStderr}`);
                // Re-throw with the stderr so callers (and PM2 logs) see the root cause
                const enriched = new Error(`FFmpeg falhou ao extrair áudio: ${fallbackErr.message}\nstderr: ${fallbackStderr}`);
                enriched.ffmpegStderr = fallbackStderr;
                throw enriched;
            }
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
    async generateWhisperAnchorMap(videoPath, videoDurationSec, onProgress = null, workDir = null, audioIndex = 0) {
        const dir = workDir || this.getWorkingDir(videoPath);
        await fs.ensureDir(dir);

        const wavPath = path.join(dir, `whisper_audio_${Date.now()}.wav`);
        const anchorsJsonPath = path.join(dir, `whisper_anchors_${Date.now()}.json`);

        try {
            onProgress?.(15, 'Extraindo áudio mono 16kHz do filme (100% da duração)...');
            await this.extractCleanAudioWav(videoPath, wavPath, videoDurationSec, audioIndex);

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

                const timer = setTimeout(() => pyProc.kill('SIGKILL'), 90 * 60 * 1000);
                pyProc.once('close', () => clearTimeout(timer));
                pyProc.once('error', () => clearTimeout(timer));
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
    async alignCandidateWithDenseWhisper(anchorsJsonPath, inputSrtPath, outputSrtPath) {
        const data = await fs.readJson(anchorsJsonPath).catch(() => null);
        if (!data?.ptbr_reference) return { aligned: false, reason: 'Âncoras acústicas sem correspondência textual não comprovam sincronia.' };
        return this.alignCandidateWithDialogue(data.ptbr_reference, inputSrtPath, outputSrtPath);
    }

    async alignSubtitleWithWhisper(videoPath, inputSrtPath, outputSrtPath, duration, refEnPath = null, onProgress = null) {
        let reference;
        try {
            reference = await this.audioDialogueReference(videoPath, { duration }, onProgress, true);
            return await this.alignCandidateWithDialogue(reference, inputSrtPath, outputSrtPath);
        } finally { if (reference) await fs.remove(reference).catch(() => {}); }
    }

    /**
     * VERIFICAÇÃO MULTI-CHECKPOINT: Inspeciona sincronia com Whisper ASR em 3 pontos (Início, Miolo, Fim)
     */
    async verifySyncAtCheckpoints(videoPath, srtPath, duration, refEnPath = null, toleranceSec = '1.5') {
        let reference;
        const output = path.join(os.tmpdir(), `subtitle-verify-${require('crypto').randomUUID()}.srt`);
        try {
            reference = await this.audioDialogueReference(videoPath, { duration }, null, true);
            const proof = await this.alignCandidateWithDialogue(reference, srtPath, output);
            const tolerance = Number(toleranceSec) || 1.5;
            const endOffset = (proof.offset_sec || 0) + ((proof.scale || 1) - 1) * duration;
            return { verified: !!(proof.aligned && Math.abs(proof.offset_sec) <= tolerance && Math.abs(endOffset) <= tolerance), checkpoints: proof };
        } catch (error) { return { verified: false, error: error.message }; }
        finally {
            if (reference) await fs.remove(reference).catch(() => {});
            await fs.remove(output).catch(() => {});
        }
    }

    /**
     * Pipeline Completo: Human Subtitles as 100% Source of Truth + Non-Destructive Whisper Sync
     * Priority:
     * 1) Embedded human PT-BR subtitle track.
     * 2) Downloaded human PT-BR subtitle (OpenSubtitles / SubDL).
     * 3) Downloaded/embedded human EN/ES subtitle (translated cleanly while keeping exact human cue boundaries and punctuation).
     * 4) Whisper ASR with PT-BR translation, only after human tracks fail.
     */
    async audioDialogueReference(videoPath, metadata, onProgress, checkpoints = false) {
        const stat = /^https?:/.test(videoPath) ? null : await fs.stat(videoPath);
        const fingerprint = metadata.mediaFingerprint || (stat ? `${stat.size}:${stat.mtimeMs}` : null);
        const cacheDir = path.resolve(__dirname, '../../data/subtitle_references');
        await fs.ensureDir(cacheDir);
        const key = require('crypto').createHash('sha256').update(JSON.stringify([
            checkpoints ? 'dialogue-checkpoints-v3' : 'dialogue-full-v2', videoPath, fingerprint, metadata.audioIndex || 0,
            checkpoints ? (process.env.SUBTITLE_WHISPER_CHECKPOINT_MODEL || 'tiny') : (process.env.SUBTITLE_WHISPER_MODEL || 'turbo'),
            checkpoints ? metadata.checkpointTimes : null
        ])).digest('hex');
        const cache = path.join(cacheDir, `${key}.srt`);
        const validate = async file => {
            if (!checkpoints) return this.validateAndFinalizeSubtitle(file, metadata.duration || 0);
            const content = await fs.readFile(file, 'utf8');
            const cues = SubtitleUtils.parseSubtitles(content);
            if (cues.length < 20 || !this.isBrazilianPortugueseSubtitle(content)) throw new Error('Referência textual dos checkpoints inválida.');
        };
        if (fingerprint && await fs.pathExists(cache)) {
            try {
                await validate(cache);
                const copy = path.join(os.tmpdir(), `subtitle-ref-${require('crypto').randomUUID()}.srt`);
                await fs.copy(cache, copy);
                return copy;
            } catch (_) { await fs.remove(cache); }
        }
        const reference = await (checkpoints ? SubtitleAudioService.createCheckpoints : SubtitleAudioService.create)(videoPath, metadata.audioIndex || 0, {
            title: metadata.title || metadata.nome, duration: metadata.duration, checkpointTimes: metadata.checkpointTimes, onProgress
        });
        try {
            await validate(reference);
            if (fingerprint) {
                const temporary = `${cache}.${require('crypto').randomUUID()}.tmp`;
                await fs.copy(reference, temporary);
                await fs.rename(temporary, cache);
            }
            return reference;
        } catch (error) { await fs.remove(reference).catch(() => {}); throw error; }
    }

    async alignCandidateWithDialogue(reference, candidate, output) {
        const script = path.resolve(__dirname, '../../scripts/align_subtitle_dialogue.py');
        try {
            const { stdout } = await execFileAsync(this.pythonExec, [script, candidate, reference, output], {
                timeout: 120000, maxBuffer: 2 * 1024 * 1024
            });
            const result = JSON.parse(stdout.trim());
            return result.aligned && result.method === 'dialogue_content' ? result : { aligned: false };
        } catch (error) {
            try { return JSON.parse(error.stdout.trim()); }
            catch (_) { return { aligned: false, reason: error.message }; }
        }
    }

    async processSubtitlePipeline(videoPath, metadata = {}, onProgress = null) {
        const attempt = async (label, action) => {
            try { return await action(); }
            catch (error) { console.warn(`[Subtitle ${label}]`, error.message); return null; }
        };
        const duration = await this.probeActualVideoDuration(videoPath) || Number(metadata.duration || 0);
        const meta = { ...await this.resolveMovieMetadata(metadata), duration };
        const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-dialogue-'));
        let referencePromise;
        let referencePath;
        let fullReferencePath;
        let retained;
        const reference = () => referencePromise ||= this.audioDialogueReference(videoPath, meta, onProgress, true)
            .then(file => { referencePath = file; return file; });
        const finish = async (file, sourceMethod, proof) => {
            await this.validateAndFinalizeSubtitle(file, duration);
            retained = path.join(os.tmpdir(), `subtitle-${require('crypto').randomUUID()}.srt`);
            await fs.copy(file, retained);
            return { srtPath: retained, sourceMethod, verified: true, syncValidationVersion: 2,
                checkpoints: proof, refEnPath: null };
        };
        const human = async candidates => {
            if (!candidates.length) return null;
            if (!referencePromise) {
                const cues = SubtitleUtils.parseSubtitles(await fs.readFile(candidates[0].srtPath, 'utf8'))
                    .filter(cue => SubtitleUtils.cleanCueText(cue.text).split(/\s+/).length >= 5 && !/[♪♫]/.test(cue.text))
                    .sort((left, right) => left.startMs - right.startMs);
                if (cues.length < 20) return null;
                const first = cues[0].startMs / 1000;
                const last = cues[cues.length - 1].startMs / 1000;
                meta.checkpointTimes = [0, .1875, .3125, .4375, .5625, .6875, .8125, .9375].map(fraction => {
                    const target = first + (last - first) * fraction;
                    return cues.reduce((best, cue) => Math.abs(cue.startMs / 1000 - target) < Math.abs(best.startMs / 1000 - target) ? cue : best).startMs / 1000;
                });
            }
            const spoken = await attempt('dialogue checkpoints', reference);
            if (!spoken) return null;
            for (const candidate of candidates) {
                const output = path.join(workDir, `${require('crypto').randomUUID()}.srt`);
                const result = await attempt('dialogue alignment', async () => {
                    const proof = await this.alignCandidateWithDialogue(spoken, candidate.srtPath, output);
                    if (!proof.aligned) throw new Error(proof.reason || 'Correspondência com o áudio não comprovada');
                    return finish(output, `${candidate.sourceMethod || 'Human PT-BR'} + dialogue verification`, proof);
                });
                if (result) return result;
            }
            return null;
        };
        try {
            const candidates = [];
            if (metadata.existingSubtitlePath) {
                const content = await fs.readFile(metadata.existingSubtitlePath, 'utf8');
                const candidate = path.join(workDir, 'existing.srt');
                await fs.writeFile(candidate, SubtitleUtils.cuesToSrt(SubtitleUtils.parseSubtitles(content)));
                candidates.push({ srtPath: candidate, sourceMethod: 'Existing human PT-BR' });
            }
            onProgress?.(10, 'Extraindo legendas humanas e verificando o áudio desta versão');
            const embedded = metadata.existingSubtitlePath ? null : await attempt('embedded', () => this.probeAndExtractContainerSubtitle(videoPath, meta));
            if (embedded?.srtPath) candidates.push(embedded);
            const companion = await attempt('companion', () => this.findCompanionSubtitles(videoPath, meta));
            if (companion?.ptSrtPath) candidates.push({ srtPath: companion.ptSrtPath, sourceMethod: 'Companion Human PT-BR' });
            let result = await human(candidates);
            if (result) return result;

            for (const fetch of [this.fetchExternalSubtitle, this.fetchSubdlSubtitle]) {
                const found = await attempt('provider', () => fetch.call(this, videoPath, meta, duration));
                result = await human(found?.candidates || (found?.srtPath ? [found] : []));
                if (result) return result;
            }
            onProgress?.(72, 'Traduzindo legenda humana EN/ES e comparando com as falas');
            const foreign = await attempt('foreign subtitle', () => this.fetchForeignSubtitleCandidates(videoPath, meta, duration));
            if (foreign?.srtPath && SubtitleTranslationService.isAvailable()) {
                const pt = path.join(workDir, 'translated.srt');
                result = await attempt('human translation', async () => {
                    await SubtitleTranslationService.translateSrtFile(foreign.srtPath, pt, { title: meta.title || meta.nome });
                    return human([{ srtPath: pt, sourceMethod: `Human ${foreign.lang} translated to PT-BR` }]);
                });
                if (result) return result;
            }
            onProgress?.(80, 'Último recurso: legenda das falas transcritas deste áudio');
            fullReferencePath = await this.audioDialogueReference(videoPath, meta, onProgress);
            return await finish(fullReferencePath, 'Whisper ASR + PT-BR translation (final fallback)', {
                method: 'asr_word_timestamps', audioFingerprint: metadata.mediaFingerprint || null
            });
        } catch (error) { error.code ||= 'SUBTITLE_SYNC_FAILED'; throw error; }
        finally {
            if (referencePath) await fs.remove(referencePath).catch(() => {});
            if (fullReferencePath) await fs.remove(fullReferencePath).catch(() => {});
            await fs.remove(workDir).catch(() => {});
        }
    }

}

module.exports = new SubtitlePipeline();
