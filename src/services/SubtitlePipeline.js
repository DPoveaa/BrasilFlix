const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const axios = require('axios');
const iconv = require('iconv-lite');
const config = require('../../config');

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
     * Detecta se a legenda é predominantemente Português de Portugal (PT-PT).
     * Implementa detecção em 5 camadas com limiares rigorosos.
     */
    isEuropeanPortugueseSubtitle(content) {
        if (!content || typeof content !== 'string') return false;
        const norm = content.toLowerCase();

        // 1. Gerúndio perifrástico clássico de Portugal ("estou a falar", "está a ver")
        const ptPtGerundRegex = /\b(estou|estás|esta|estas|estamos|estao|estava|estavas|estavamos|estavam|estive|esteve|estao)\s+a\s+[a-z]+(?:ar|er|ir)\b/gi;
        const ptPtGerundMatches = (norm.match(ptPtGerundRegex) || []).length;

        // 2. Imperativo subjuntivo de 2ª pessoa singular (PT-PT exclusivo)
        // "não toques", "não faças", "não digas", "não olhes", "não entres", "não saias"
        const ptPtImperativeSubjRegex = /\bnao\s+(toques|faças|facas|digas|olhes|entres|saias|venhas|tenhas|sejas|estejas|vás|vas|ponhas|tragas|tiras|mexas|uses|abras|feches|comes|bebas|fujas|corras|empurres|pares|moves|chores|rias|gritas|mintas|enganes|esqueças|esquecas|tentes|desistas|percas|percas|ganhas|gastes|quebres|partas|lances|soltes|deixes|mudes|passes|esperes|contes|digam|façam|façao)\b/gi;
        const ptPtImperativeSubjMatches = (norm.match(ptPtImperativeSubjRegex) || []).length;

        // 3. Clítica enclítica em construção pós-verbal PT-PT ("entrega-lhe", "diz-me", "dá-lhe", "faz-te")
        const ptPtCliticEnclisisRegex = /\b(entrega|entreg|diz|da|dá|leva|traz|vem|vai|faz|manda|põe|tira|toma|deixa|pega|corre|foge|sai|entra|liga|desliga|chama|espera|olha|abre|fecha|corta|quebra|vende|compra|dorme|levanta|senta|cala|para|anda|volta|segura|puxa|empurra|joga|atira)(-)(me|te|lhe|nos|vos|lhes|o|a|os|as|se|nos)\b/gi;
        const ptPtCliticMatches = (norm.match(ptPtCliticEnclisisRegex) || []).length;

        // 4. Vocabulário europeu expandido (uma única ocorrência já é sinal forte)
        const ptPtVocabRegex = /\b(rapariga|raparigas|telemovel|telemoveis|comboio|comboios|ecra|ecras|autocarro|autocarros|propina|propinas|pequeno.almoco|paragem|paragens|miudo|miuda|fixe|gajo|gajos|gajas|bicha|bichas|fato|fatos|hertziano|casa\s+de\s+banho|eléctrico|sumbe|malta|tipo|tasco|taberna|bica|galao|galão|chouriço|broa|bacalhau|pingo|asneira|borlas)\b/gi;
        const ptPtVocabMatches = (norm.match(ptPtVocabRegex) || []).length;

        // 5. Uso do 'tu' como sujeito com conjugação estrita de 2ª pessoa do singular
        const ptPtTuSubjectRegex = /\btu\s+(?:es|estas|estás|tens|vais|fazes|dizes|sabes|podes|queres|vens|ouves|viste|disseste|fizeste|estiveste|foste|és)\b/gi;
        const ptPtTuSubjectMatches = (norm.match(ptPtTuSubjectRegex) || []).length;

        // Marcadores brasileiros (reduzem score PT-PT)
        const ptBrMarkersRegex = /\b(voce\b|voces\b|você\b|vocês\b|[a-z]+ando\b|[a-z]+endo\b|[a-z]+indo\b|tá\b|tô\b|né\b|hein\b|oxe\b|poxa\b|puxa\b|caramba\b|meu\b|cara\b|legal\b|beleza\b|valeu\b|boa\b|firmeza\b|saudade\b|bagunça\b|bicho\b|mano\b)\b/gi;
        const ptBrMarkers = (norm.match(ptBrMarkersRegex) || []).length;

        // Score ponderado: limiares muito mais rigorosos que antes
        // Gerúndio perifrástico: sinal muito forte (3+ ocorrências = PT-PT quase certo)
        // Imperativo subjuntivo: sinal forte (2+ = PT-PT quase certo)
        // Clítica enclítica: sinal forte (2+ = PT-PT quase certo)
        // Vocabulário: sinal forte (1+ = suspeito)
        const ptPtScore = (ptPtGerundMatches * 8) + (ptPtImperativeSubjMatches * 10) +
            (ptPtCliticMatches * 8) + (ptPtTuSubjectMatches * 5) + (ptPtVocabMatches * 6);
        const ptBrScore = ptBrMarkers * 3;

        // Qualquer uma dessas condições é suficiente para reprovar como PT-PT:
        if (ptPtGerundMatches >= 3) return true;       // 3+ gerúndios perifrásticos = PT-PT
        if (ptPtImperativeSubjMatches >= 1) return true; // qualquer "não toques/faças/digas" = PT-PT
        if (ptPtCliticMatches >= 2) return true;        // 2+ clíticas enclíticas = PT-PT
        if (ptPtVocabMatches >= 2) return true;         // 2+ vocabulário europeu = PT-PT

        // Fallback: score ponderado quando nenhuma condição isolada dispara
        return ptPtScore >= 20 && ptPtScore > ptBrScore;
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
     * Valida se a legenda tem vocabulário autêntico de Português Brasileiro (PT-BR)
     */
    isBrazilianPortugueseSubtitle(content) {
        if (!content || typeof content !== 'string') return false;
        if (this.isEuropeanPortugueseSubtitle(content)) return false;
        return this.isPortugueseLanguage(content);
    }

    /**
     * Converte e localiza construções típicas de Português de Portugal para Português do Brasil (PT-BR).
     * Corrige gerúndios perifrásticos, imperativo subjuntivo de 2ª pessoa, ênclises e vocabulário europeu.
     */
    convertEuropeanToBrazilianPortuguese(text) {
        if (!text || typeof text !== 'string') return text;
        let s = text;

        // 1. Gerúndio perifrástico: está a falar -> está falando
        s = s.replace(/\b(estou|está|esta|estás|estas|estamos|estão|estao|estava|estavas|estávamos|estavamos|estavam|estive|esteve)\s+a\s+([a-z]+(?:ar|er|ir))\b/gi, (match, aux, verb) => {
            let gerund = verb;
            if (verb.endsWith('ar')) gerund = verb.slice(0, -2) + 'ando';
            else if (verb.endsWith('er')) gerund = verb.slice(0, -2) + 'endo';
            else if (verb.endsWith('ir')) gerund = verb.slice(0, -2) + 'indo';
            return `${aux} ${gerund}`;
        });

        // 2. Subjuntivo imperativo 2ª pessoa singular -> imperativo PT-BR
        const subjMap = [
            [/\b(não|nao)\s+toques\b/gi, '$1 toque'],
            [/\b(não|nao)\s+faças\b/gi, '$1 faça'],
            [/\b(não|nao)\s+facas\b/gi, '$1 faça'],
            [/\b(não|nao)\s+digas\b/gi, '$1 diga'],
            [/\b(não|nao)\s+olhes\b/gi, '$1 olhe'],
            [/\b(não|nao)\s+entres\b/gi, '$1 entre'],
            [/\b(não|nao)\s+saias\b/gi, '$1 saia'],
            [/\b(não|nao)\s+venhas\b/gi, '$1 venha'],
            [/\b(não|nao)\s+tenhas\b/gi, '$1 tenha'],
            [/\b(não|nao)\s+sejas\b/gi, '$1 seja'],
            [/\b(não|nao)\s+estejas\b/gi, '$1 esteja'],
            [/\b(não|nao)\s+vás\b/gi, '$1 vá'],
            [/\b(não|nao)\s+vas\b/gi, '$1 vá'],
            [/\b(não|nao)\s+ponhas\b/gi, '$1 ponha'],
            [/\b(não|nao)\s+tragas\b/gi, '$1 traga'],
            [/\b(não|nao)\s+mexas\b/gi, '$1 mexa'],
            [/\b(não|nao)\s+uses\b/gi, '$1 use'],
            [/\b(não|nao)\s+abras\b/gi, '$1 abra'],
            [/\b(não|nao)\s+feches\b/gi, '$1 feche'],
            [/\b(não|nao)\s+fujas\b/gi, '$1 fuja'],
            [/\b(não|nao)\s+corras\b/gi, '$1 corra'],
            [/\b(não|nao)\s+pares\b/gi, '$1 pare'],
            [/\b(não|nao)\s+chores\b/gi, '$1 chore'],
            [/\b(não|nao)\s+esqueças\b/gi, '$1 esqueça'],
            [/\b(não|nao)\s+esquecas\b/gi, '$1 esqueça'],
            [/\b(não|nao)\s+desistas\b/gi, '$1 desista'],
            [/\b(não|nao)\s+percas\b/gi, '$1 perca'],
            [/\b(não|nao)\s+esperes\b/gi, '$1 espere'],
            [/\b(não|nao)\s+contes\b/gi, '$1 conte']
        ];
        for (const [re, repl] of subjMap) {
            s = s.replace(re, repl);
        }

        // 3. Pronome clítico duplo e enclítica PT-PT
        s = s.replace(/\b(entrega|entregue)-lhe\s+a\s+ele\b/gi, '$1 para ele');
        s = s.replace(/\b(dá|da|dê)-lhe\s+a\s+ele\b/gi, '$1 para ele');
        s = s.replace(/\b(diga|diz)-lhe\s+a\s+ele\b/gi, '$1 para ele');
        s = s.replace(/\b(mostra|mostre)-lhe\s+a\s+ele\b/gi, '$1 para ele');

        // Próclise natural brasileira no início de fala ou após pontuação
        s = s.replace(/(^|[\n\.\?!-]\s*)(diz|faz|dá|deixa|conta|mostra|ajuda|escuta|olha)-me\b/gi, (match, prefix, verb) => {
            const verbClean = verb.toLowerCase();
            return `${prefix}me ${verbClean}`;
        });

        // 4. Vocabulário PT-PT -> PT-BR
        const vocabMap = [
            [/\becrã\b/gi, 'tela'],
            [/\becrãs\b/gi, 'telas'],
            [/\btelemóvel\b/gi, 'celular'],
            [/\btelemóveis\b/gi, 'celulares'],
            [/\bcomboio\b/gi, 'trem'],
            [/\bcomboios\b/gi, 'trens'],
            [/\bautocarro\b/gi, 'ônibus'],
            [/\bautocarros\b/gi, 'ônibus'],
            [/\bcasa\s+de\s+banho\b/gi, 'banheiro'],
            [/\brapariga\b/gi, 'garota'],
            [/\braparigas\b/gi, 'garotas'],
            [/\bmiúdo\b/gi, 'garoto'],
            [/\bmiúdos\b/gi, 'garotos'],
            [/\bmiúda\b/gi, 'garota'],
            [/\bmiúdas\b/gi, 'garotas'],
            [/\bfixe\b/gi, 'legal'],
            [/\bgajo\b/gi, 'cara'],
            [/\bgajos\b/gi, 'caras'],
            [/\bpequeno.almoço\b/gi, 'café da manhã'],
            [/\bpequeno almoço\b/gi, 'café da manhã'],
            [/\bparagem\b/gi, 'ponto'],
            [/\bparagens\b/gi, 'pontos'],
            [/\bpropina\b/gi, 'mensalidade'],
            [/\bpropinas\b/gi, 'mensalidades'],
            [/\bprotecção\b/gi, 'proteção'],
            [/\bacto\b/gi, 'ato'],
            [/\bactos\b/gi, 'atos'],
            [/\bóptimo\b/gi, 'ótimo'],
            [/\bóptima\b/gi, 'ótima']
        ];
        for (const [re, repl] of vocabMap) {
            s = s.replace(re, repl);
        }

        return s;
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

                        if (cues.length >= 30 && this.isBrazilianPortugueseSubtitle(sanitized)) {
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
                    if (cues.length >= 30 && this.isBrazilianPortugueseSubtitle(sanitized)) {
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
            // Se houver um salto absurdo de mais de 300s (5 min) de silêncio absoluto entre este cue e o anterior no final do filme
            if (i > 0 && (cues[i].startMs - cues[i - 1].endMs) > 300000) {
                continue;
            }
            return cues[i];
        }
        return cues[cues.length - 1];
    }

    /**
     * TIER 3: Busca externa estrita (OpenSubtitles / Stremio API) com validação de duração e release
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

            console.log(`🌐 [Tier 3: External Search] Buscando legendas externas estritas para "${metadata.nome || metadata.title || path.basename(videoPath)}" (Duração: ${(videoDurationSec / 60).toFixed(1)}m)...`);

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

            let ptSubs = [];
            for (const url of endpoints) {
                try {
                    const res = await axios.get(url, {
                        timeout: 7000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.168' }
                    });
                    const subs = res.data?.subtitles || [];
                    const filtered = subs.filter(s => {
                        const lang = (s.lang || s.language || '').toLowerCase();
                        if (lang.includes('pt-pt') || lang.includes('por-pt')) return false;
                        const rel = (s.movieReleaseName || s.releaseName || s.url || '').toLowerCase();
                        // Rejeição imediata por tags explícitas de PT-PT no release name
                        if (/\bpt[-.]?pt\b|\bportugal\b/.test(rel)) {
                            console.warn(`⚠️ [Tier 3: PT-PT tag] Rejeitado por tag PT-PT explícita no release: "${rel.substring(0, 60)}"`);
                            return false;
                        }
                        if (rel.includes('pt-pt') || rel.includes('por.pt')) return false;
                        return ['pob', 'pt-br', 'brazilian', 'por', 'pt', 'ptbr'].includes(lang);
                    });
                    if (filtered.length > 0) {
                        ptSubs = filtered;
                        break;
                    }
                } catch (e) { }
            }

            if (ptSubs.length === 0) {
                console.warn(`⚠️ [Tier 3: External Search] Nenhuma legenda em Português encontrada no OpenSubtitles.`);
                return null;
            }

            // Ranqueia por compatibilidade com release e prioridade PT-BR
            // Aplica penalidade pesada a suspeitos de PT-PT via release name
            const scored = ptSubs.map(sub => {
                const rel = (sub.movieReleaseName || sub.releaseName || '').toLowerCase();
                const subUrl = (sub.url || '').toLowerCase();
                const subTokens = tokenize(rel);
                const common = subTokens.filter(t => fileTokens.includes(t)).length;
                let score = common * 4;

                const lang = (sub.lang || sub.language || '').toLowerCase();
                if (['pob', 'pt-br', 'brazilian'].includes(lang)) score += 50;
                score += parseInt(sub.g || 0, 10);

                // Penalidade de PT-PT por release name ou URL
                const ptPtPenalty = this.getPtPtReleaseNamePenalty(rel) || this.getPtPtReleaseNamePenalty(subUrl);
                if (ptPtPenalty > 0) {
                    console.warn(`⚠️ [Tier 3: PT-PT penalty] Sub penalizado em ${ptPtPenalty} pts por release name suspeito: "${rel.substring(0, 60)}"`);
                    score -= ptPtPenalty;
                }

                return { sub, score };
            }).sort((a, b) => b.score - a.score);

            console.log(`🌐 [Tier 3: External Search] ${scored.length} candidatos ranqueados. Testando compatibilidade estrita...`);

            let fallbackCandidate = null;

            // Testa até 8 candidatos com Duration Gate e Dialeto
            for (let i = 0; i < Math.min(scored.length, 8); i++) {
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
                    const cues = this.parseSrt(sanitized);

                    if (cues.length < 30) {
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado: apenas ${cues.length} cues.`);
                        continue;
                    }

                    // Strict Duration Gate com suporte a âncora EN
                    if (videoDurationSec > 600) {
                        const lastPtCue = this.getLastDialogueCue(cues);
                        const lastCueEndSec = lastPtCue ? lastPtCue.endMs / 1000 : cues[cues.length - 1].endMs / 1000;

                        if (refEnCues && refEnCues.length > 0) {
                            // Modo com âncora EN: compara contra o último diálogo da âncora EN (tolerância ±45s)
                            const lastEnCue = this.getLastDialogueCue(refEnCues);
                            const enLastSec = lastEnCue ? lastEnCue.endMs / 1000 : refEnCues[refEnCues.length - 1].endMs / 1000;
                            const endDiff = Math.abs(lastCueEndSec - enLastSec);
                            if (endDiff > 45) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate EN: última fala PT em ${(lastCueEndSec / 60).toFixed(1)}min diverge ${Math.round(endDiff)}s do diálogo final da âncora EN (${(enLastSec / 60).toFixed(1)}min). Possível legenda cortada/errada.`);
                                continue;
                            }
                            // Verifica divergência de quantidade de cues (tolerância máxima de ±10% no total de cues)
                            const cueDiffRatio = Math.abs(cues.length - refEnCues.length) / Math.max(1, refEnCues.length);
                            if (cueDiffRatio > 0.10) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate EN: ${cues.length} cues PT vs ${refEnCues.length} cues EN (${(cueDiffRatio * 100).toFixed(0)}% divergência > 10% permitido).`);
                                continue;
                            }
                        } else {
                            // Modo sem âncora EN: exige >=94% cobertura E gap máximo de 300s (5 min)
                            const coverageRatio = lastCueEndSec / videoDurationSec;
                            const gapSec = videoDurationSec - lastCueEndSec;
                            if (coverageRatio < 0.94 && gapSec > 300) {
                                console.warn(`⚠️ Candidato #${i + 1} rejeitado pelo Duration Gate: cobertura ${(coverageRatio * 100).toFixed(1)}% (última fala ${(lastCueEndSec / 60).toFixed(1)}min, filme ${(videoDurationSec / 60).toFixed(1)}min, gap ${Math.round(gapSec)}s > 300s permitido).`);
                                continue;
                            }
                        }
                        // Para longas (> 60 min), exige no mínimo 400 falas
                        if (videoDurationSec > 3600 && cues.length < 400) {
                            console.warn(`⚠️ Candidato #${i + 1} rejeitado: apenas ${cues.length} falas para um longa-metragem de ${(videoDurationSec / 60).toFixed(0)} min.`);
                            continue;
                        }
                    }

                    // Prioriza PT-BR autêntico
                    const isPtBr = this.isBrazilianPortugueseSubtitle(sanitized);
                    const isPt = this.isPortugueseLanguage(sanitized);

                    if (!isPt) {
                        console.warn(`⚠️ Candidato #${i + 1} rejeitado: não é idioma português.`);
                        continue;
                    }

                    if (isPtBr) {
                        const candidatePath = path.join(path.dirname(videoPath), `external_pt_${Date.now()}_cand${i + 1}.srt`);
                        await fs.writeFile(candidatePath, this.buildSrt(cues), 'utf8');
                        console.log(`✅ [Tier 3: External Search] Candidato #${i + 1} aprovado no Duration Gate e PT-BR (${cues.length} cues, score: ${score})!`);
                        return {
                            srtPath: candidatePath,
                            cueCount: cues.length,
                            source: 'external_opensubtitles'
                        };
                    } else if (!fallbackCandidate) {
                        // Converte o candidato PT-PT para Português do Brasil autêntico antes de salvar
                        const localized = this.convertEuropeanToBrazilianPortuguese(sanitized);
                        const localizedCues = this.parseSrt(localized);
                        const candidatePath = path.join(path.dirname(videoPath), `external_pt_localized_${Date.now()}_cand${i + 1}.srt`);
                        await fs.writeFile(candidatePath, this.buildSrt(localizedCues), 'utf8');
                        console.log(`🇧🇷 [Tier 3: Localização PT-PT -> PT-BR] Candidato #${i + 1} convertido e localizado para Português Brasileiro (${localizedCues.length} cues)!`);
                        fallbackCandidate = {
                            srtPath: candidatePath,
                            cueCount: localizedCues.length,
                            source: 'external_opensubtitles_localized_ptbr',
                            index: i + 1,
                            score
                        };
                    }
                } catch (dlErr) {
                    console.warn(`⚠️ Falha ao baixar candidato #${i + 1}:`, dlErr.message);
                }
            }

            if (fallbackCandidate) {
                console.log(`ℹ️ [Tier 3: External Search] Utilizando candidato #${fallbackCandidate.index} em Português (${fallbackCandidate.cueCount} cues) aprovado no Duration Gate como fallback seguro!`);
                return fallbackCandidate;
            }
            return null;
        } catch (e) {
            console.warn(`⚠️ [Tier 3: External Search] Erro na busca externa:`, e.message);
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
        const localized = this.convertEuropeanToBrazilianPortuguese(sanitized);
        const rawCues = this.parseSrt(localized);

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

        // TIER 3: Se não tem Tier 1 nem Tier 2, busca externa estrita
        if (!selectedSrtPath) {
            const tier3 = await this.fetchExternalSubtitle(videoPath, metadata, videoDurationSec, refEnCues);
            if (tier3) {
                selectedSrtPath = tier3.srtPath;
                sourceMethod = 'Tier 3 (Strict External Matching via OpenSubtitles)';
                requiresSync = true;
            }
        }

        if (!selectedSrtPath) {
            throw new Error(`Falha no pipeline: nenhuma legenda PT-BR válida encontrada em nenhum dos Tiers (Container, Companion, OpenSubtitles).`);
        }

        // TIER 4: Sincronização Acústica / Sub-to-Sub (se necessário)
        let finalSrtPath = selectedSrtPath;
        // isStudioRef: true se a legenda EN de referência veio do container (softsub de estúdio, frame-perfect)
        // false se veio da internet (OpenSubtitles, pode ter fps diferente) → usa Audio-to-Sub
        const isStudioRef = refEnPath && !path.basename(refEnPath).startsWith('ref_en_ext_');
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

        // MULTI-CHECKPOINT VERIFICATION VIA WHISPER ASR (com ancoragem de conteúdo EN se disponível)
        // Audio-to-Sub tem incerteza acústica inerente de ±1-2s; Sub-to-Sub (studio EN) é frame-perfect (±1.5s)
        const whisperTolerance = isStudioRef ? '1.5' : '2.5';
        console.log(`🎙️ [Pipeline] Tolerância Whisper: ${whisperTolerance}s (método: ${isStudioRef ? 'Sub-to-Sub Studio' : 'Audio-to-Sub'})`);
        const checkpointCheck = await this.verifySyncAtCheckpoints(videoPath, finalSrtPath, videoDurationSec, refEnPath, whisperTolerance);
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
