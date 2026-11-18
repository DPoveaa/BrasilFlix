/**
 * SubtitleUtils.js
 * Utilitários para parsing, formatação, deslocamento temporal (shift),
 * validação de monotonicidade e saneamento de legendas SRT e WebVTT.
 */

function timecodeToMs(tc) {
    if (!tc || typeof tc !== 'string') return 0;
    const clean = tc.trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length < 2) return 0;

    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    if (parts.length === 3) {
        hours = parseInt(parts[0], 10) || 0;
        minutes = parseInt(parts[1], 10) || 0;
        seconds = parseFloat(parts[2]) || 0;
    } else {
        minutes = parseInt(parts[0], 10) || 0;
        seconds = parseFloat(parts[1]) || 0;
    }

    return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function msToSrtTimecode(ms) {
    const totalMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function msToVttTimecode(ms) {
    const totalMs = Math.max(0, Math.round(ms));
    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function stripOuterQuotes(text) {
    if (!text || typeof text !== 'string') return '';
    let t = text.trim();
    let changed = true;
    while (changed && t.length >= 2) {
        changed = false;
        if ((t.startsWith('"') && t.endsWith('"')) ||
            (t.startsWith("'") && t.endsWith("'")) ||
            (t.startsWith('“') && t.endsWith('”')) ||
            (t.startsWith('«') && t.endsWith('»')) ||
            (t.startsWith('”') && t.endsWith('”'))) {
            t = t.slice(1, -1).trim();
            changed = true;
        }
    }
    // Remove também aspas escapadas como \"texto\"
    if (t.startsWith('\\"') && t.endsWith('\\"') && t.length >= 4) {
        t = t.slice(2, -2).trim();
    }
    return t;
}

// Only speaker-marked cues are split; hyphenated words and ordinary dashes stay intact.
function formatDialogue(text) {
    const value = String(text || '').trim();
    if (!/^(?:<[^>]+>)*[-–—]\s*\p{L}/u.test(value)) return value;
    return value.replace(/[ \t]+[-–—][ \t]*(?=[\p{L}¿¡"“])/gu, '\n- ')
        .replace(/^([ \t]*)(?:[-–—])[ \t]*/gm, '- ');
}

// Applied at every serialization boundary, throughout the entire timeline.
function cleanCueText(text) {
    return formatDialogue(text).split('\n').filter(line => {
        const plain = line.replace(/<[^>]*>|\{[^}]*\}/g, '').normalize('NFKC');
        return !/(@[\w.]+|https?:\/\/|www\.|\bt\.me\/|\b[\w-]+\.(?:com|net|org|tv|xyz|site|me|io|br)\b|telegram|opensubtitles|legendas\.tv|pipocas|yify|comandotorrents|bludv|lapumia|baixarfilmes|legendas?\s+(?:por|de|by)|subtitles?\s+by|tradu[cç][aã]o\s*:|ripada\s+por|acesse\b|visite\s*:|baixe\s+em|anuncie\s+aqui|canal\s+(?:do|no)\b)/i.test(plain);
    }).join('\n').trim();
}

function parseSrt(srtContent) {
    if (!srtContent || typeof srtContent !== 'string') return [];
    const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const blocks = normalized.split(/\n\s*\n/);
    const cues = [];

    let cueIndex = 1;
    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 2) continue;

        let timecodeLine = '';
        let textLines = [];

        if (lines[0].includes('-->')) {
            timecodeLine = lines[0];
            textLines = lines.slice(1);
        } else if (lines.length >= 2 && lines[1].includes('-->')) {
            timecodeLine = lines[1];
            textLines = lines.slice(2);
        } else {
            continue;
        }

        const match = timecodeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
        if (!match) continue;

        const startTime = match[1].replace('.', ',');
        const endTime = match[2].replace('.', ',');
        const startMs = timecodeToMs(startTime);
        const endMs = timecodeToMs(endTime);
        const text = formatDialogue(stripOuterQuotes(textLines.join('\n')));

        cues.push({
            index: cueIndex++,
            startTime,
            endTime,
            startMs,
            endMs,
            text
        });
    }

    return cues;
}

function parseVtt(vttContent) {
    if (!vttContent || typeof vttContent !== 'string') return [];
    let normalized = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    // Remove cabeçalho WEBVTT e metadados
    if (normalized.startsWith('WEBVTT')) {
        normalized = normalized.replace(/^WEBVTT[^\n]*\n+/i, '').trim();
    }

    const blocks = normalized.split(/\n\s*\n/);
    const cues = [];
    let cueIndex = 1;

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 1) continue;

        let timecodeLine = '';
        let textLines = [];

        if (lines[0].includes('-->')) {
            timecodeLine = lines[0];
            textLines = lines.slice(1);
        } else if (lines.length >= 2 && lines[1].includes('-->')) {
            timecodeLine = lines[1];
            textLines = lines.slice(2);
        } else {
            continue;
        }

        const match = timecodeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/);
        if (!match) continue;

        const startTime = match[1].replace(',', '.');
        const endTime = match[2].replace(',', '.');
        const startMs = timecodeToMs(startTime);
        const endMs = timecodeToMs(endTime);
        const text = formatDialogue(stripOuterQuotes(textLines.join('\n')));

        cues.push({
            index: cueIndex++,
            startTime: msToSrtTimecode(startMs),
            endTime: msToSrtTimecode(endMs),
            startMs,
            endMs,
            text
        });
    }

    return cues;
}

function parseSubtitles(content) {
    if (!content || typeof content !== 'string') return [];
    if (content.trim().startsWith('WEBVTT')) {
        return parseVtt(content);
    }
    return parseSrt(content);
}

function cuesToSrt(cues) {
    cues = (Array.isArray(cues) ? cues : []).map(cue => ({ ...cue, text: cleanCueText(cue.text) })).filter(cue => cue.text);
    if (!Array.isArray(cues) || cues.length === 0) return '';
    return cues.map((cue, idx) => {
        const start = cue.startTime || msToSrtTimecode(cue.startMs || 0);
        const end = cue.endTime || msToSrtTimecode(cue.endMs || 0);
        const text = stripOuterQuotes(cue.text || '');
        return `${idx + 1}\n${start.replace('.', ',')} --> ${end.replace('.', ',')}\n${text}`;
    }).join('\n\n') + '\n';
}

function cuesToVtt(cues) {
    cues = (Array.isArray(cues) ? cues : []).map(cue => ({ ...cue, text: cleanCueText(cue.text) })).filter(cue => cue.text);
    if (!Array.isArray(cues) || cues.length === 0) return 'WEBVTT\n\n';
    const lines = ['WEBVTT', ''];
    cues.forEach((cue, idx) => {
        const start = msToVttTimecode(cue.startMs !== undefined ? cue.startMs : timecodeToMs(cue.startTime));
        const end = msToVttTimecode(cue.endMs !== undefined ? cue.endMs : timecodeToMs(cue.endTime));
        const text = stripOuterQuotes(cue.text || '');
        lines.push(`${idx + 1}`);
        lines.push(`${start} --> ${end} line:85%`);
        lines.push(text);
        lines.push('');
    });
    return lines.join('\n');
}

/**
 * Sanitiza e normaliza rigorosamente qualquer conteúdo WebVTT:
 * - Garante ausência de BOM UTF-8 (\uFEFF)
 * - Garante cabeçalho estrito WEBVTT seguido de linha em branco (\n\n)
 * - Garante separador decimal de ponto (.) nos milissegundos (nunca vírgula)
 * - Garante posicionamento vertical cinema line:85% acima da barra de controles
 * - Descarta blocos de fala órfãos ou corrompidos
 */
function sanitizeVtt(vttContent) {
    if (!vttContent || typeof vttContent !== 'string') return 'WEBVTT\n\n';

    // 1. Remove BOM UTF-8 e normaliza quebras de linha
    let clean = vttContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // 2. Remove cabeçalho WEBVTT e metadados anteriores
    clean = clean.replace(/^WEBVTT[^\n]*\n*/i, '').trim();

    // 3. Divide blocos por linhas em branco
    const rawBlocks = clean.split(/\n\s*\n/);
    const validCues = [];
    let cueNum = 1;

    for (const block of rawBlocks) {
        const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) continue;

        let timecodeLine = '';
        let textLines = [];

        if (lines[0].includes('-->')) {
            timecodeLine = lines[0];
            textLines = lines.slice(1);
        } else if (lines.length >= 2 && lines[1].includes('-->')) {
            timecodeLine = lines[1];
            textLines = lines.slice(2);
        } else {
            continue;
        }

        const match = timecodeLine.match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})/);
        if (!match) continue;

        const startMs = timecodeToMs(match[1]);
        const endMs = timecodeToMs(match[2]);
        if (endMs <= startMs) continue;

        const startVtt = msToVttTimecode(startMs);
        const endVtt = msToVttTimecode(endMs);

        // Posicionamento vertical para altura de cinema (line:85%)
        let cueSettings = 'line:85%';
        const remainder = timecodeLine.slice(timecodeLine.indexOf(match[2]) + match[2].length).trim();
        if (remainder) {
            cueSettings = remainder.includes('line:') ? remainder : `${remainder} line:85%`;
        }

        const text = cleanCueText(stripOuterQuotes(textLines.join('\n')));
        if (!text) continue;

        validCues.push(`${cueNum++}\n${startVtt} --> ${endVtt} ${cueSettings}\n${text}`);
    }

    return `WEBVTT\n\n${validCues.join('\n\n')}\n`;
}

function shiftCues(cues, offsetMs) {
    if (!Array.isArray(cues)) return [];
    const offset = parseInt(offsetMs, 10) || 0;

    return cues.map((cue, idx) => {
        const origStartMs = cue.startMs !== undefined ? cue.startMs : timecodeToMs(cue.startTime);
        const origEndMs = cue.endMs !== undefined ? cue.endMs : timecodeToMs(cue.endTime);
        const duration = Math.max(300, origEndMs - origStartMs);

        const newStartMs = Math.max(0, origStartMs + offset);
        const newEndMs = Math.max(newStartMs + 300, origEndMs + offset);

        return {
            index: idx + 1,
            startMs: newStartMs,
            endMs: newEndMs,
            startTime: msToSrtTimecode(newStartMs),
            endTime: msToSrtTimecode(newEndMs),
            text: stripOuterQuotes(cue.text || '')
        };
    });
}

function validateAndSanitizeCues(cues) {
    if (!Array.isArray(cues) || cues.length === 0) {
        throw new Error('Nenhuma fala fornecida para validação.');
    }

    const sanitized = [];
    let prevEndMs = 0;

    for (let i = 0; i < cues.length; i++) {
        const raw = cues[i];
        let startMs = raw.startMs !== undefined ? Number(raw.startMs) : timecodeToMs(raw.startTime);
        let endMs = raw.endMs !== undefined ? Number(raw.endMs) : timecodeToMs(raw.endTime);

        if (isNaN(startMs) || startMs < 0) startMs = 0;
        if (isNaN(endMs) || endMs <= startMs) endMs = startMs + 1500;

        // Monotonicidade: não permitir início anterior à fala anterior
        if (startMs < prevEndMs) {
            // Se houver sobreposição pequena, ajusta o término da anterior ou início da atual
            if (prevEndMs - startMs <= 100 && sanitized.length > 0) {
                sanitized[sanitized.length - 1].endMs = Math.max(sanitized[sanitized.length - 1].startMs + 300, startMs - 20);
                sanitized[sanitized.length - 1].endTime = msToSrtTimecode(sanitized[sanitized.length - 1].endMs);
            } else {
                startMs = prevEndMs + 20;
                endMs = Math.max(startMs + 500, endMs);
            }
        }

        let text = cleanCueText(stripOuterQuotes(raw.text || ''));
        if (!text) continue;
        // Limita a 2 linhas se necessário (~42 caracteres por linha)
        const lines = text.split('\n').filter(Boolean);
        if (lines.length > 2) {
            text = lines.slice(0, 2).join(' ') + '\n' + lines.slice(2).join(' ');
        }

        sanitized.push({
            index: i + 1,
            startMs,
            endMs,
            startTime: msToSrtTimecode(startMs),
            endTime: msToSrtTimecode(endMs),
            text
        });

        prevEndMs = endMs;
    }

    return sanitized;
}

module.exports = {
    contentHash: content => require('crypto').createHash('sha256').update(content).digest('hex'),
    cleanCueText,
    formatDialogue,
    timecodeToMs,
    msToSrtTimecode,
    msToVttTimecode,
    stripOuterQuotes,
    parseSrt,
    parseVtt,
    parseSubtitles,
    cuesToSrt,
    cuesToVtt,
    shiftCues,
    validateAndSanitizeCues,
    sanitizeVtt
};
