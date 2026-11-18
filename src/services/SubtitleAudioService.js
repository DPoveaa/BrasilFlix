const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const translator = require('./SubtitleTranslationService');

const run = promisify(execFile);
const script = path.resolve(__dirname, '../../scripts/transcribe_subtitle_audio.py');
const inputFlags = input => /^https?:\/\//i.test(input) ? [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '429,5xx', '-reconnect_delay_max', '5', '-rw_timeout', '30000000'
] : [];
const transcribeTimeout = 90 * 60 * 1000;
let pendingTranscription = Promise.resolve();

function subtitleError(message, code) {
    return Object.assign(new Error(message), { code });
}

function timedCues(srt) {
    const seconds = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
    return translator.parseSrt(srt).flatMap(({ timecode, text }) => {
        const match = timecode.match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
        if (!match) return [];
        const start = seconds(...match.slice(1, 5));
        const end = seconds(...match.slice(5));
        const words = new Set(text.replace(/<[^>]*>/g, '').normalize('NFD')
            .replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}{4,}/gu) || []);
        return end > start ? [{ start, end, words }] : [];
    }).sort((a, b) => a.start - b.start);
}

function matchesSpokenDialogue(candidate, reference) {
    const expected = timedCues(reference);
    const embedded = timedCues(candidate);
    if (embedded.length < 10 || expected.length < 10 || embedded.length < expected.length * 0.55 ||
        embedded.some(cue => cue.end - cue.start > 10)) return false;
    const end = Math.max(...expected.map(cue => cue.end));
    // Compare both directions in every quarter, so a missing scene or a
    // mismatch late in the film cannot be masked by a good match at the start.
    function matchesWithinPeriods(from, to) {
        const periods = Array.from({ length: 4 }, () => ({ matched: 0, words: 0 }));
        let first = 0;
        for (const cue of from) {
            const period = periods[Math.min(3, Math.floor(cue.start / end * 4))];
            while (first < to.length && to[first].end <= cue.start) first++;
            const nearby = new Set();
            for (let index = first; index < to.length && to[index].start < cue.end; index++) {
                const other = to[index];
                const overlap = Math.min(cue.end, other.end) - Math.max(cue.start, other.start);
                if (overlap < 0.25 * Math.min(cue.end - cue.start, other.end - other.start)) continue;
                for (const word of other.words) nearby.add(word);
            }
            period.words += cue.words.size;
            for (const word of cue.words) if (nearby.has(word)) period.matched++;
        }
        return periods.every(period => period.words >= 8 && period.matched / period.words >= 0.68);
    }
    return matchesWithinPeriods(expected, embedded) && matchesWithinPeriods(embedded, expected);
}

async function validateEmbedded(inputPath, streams, reference, isEuropeanPortuguese) {
    const ptTracks = streams.filter(track =>
        /^(pt[-_]?br|por|pob|pt)$/.test(track.language) &&
        !track.disposition?.forced && !/forced|for[cç]ad|signs|songs|placas/i.test(track.title)
    );
    for (const track of ptTracks.slice(0, 3)) {
        const { stdout } = await run('ffmpeg', [
            '-nostdin', '-v', 'error', '-y', ...inputFlags(inputPath), '-i', inputPath, '-map', `0:s:${track.index}`, '-c:s', 'srt', '-f', 'srt', 'pipe:1'
        ], { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
        if (!isEuropeanPortuguese?.(stdout) && matchesSpokenDialogue(stdout, reference)) return stdout;
    }
    return null;
}

async function transcribe(inputPath, audioIndex, workspace, title) {
    const wav = path.join(workspace, 'audio.wav');
    const source = path.join(workspace, 'source.srt');
    const model = process.env.SUBTITLE_WHISPER_MODEL || 'turbo';
    console.log(`[Legenda: ${title}] Analisando a faixa de áudio ${audioIndex} com Whisper ${model}.`);
    await run('ffmpeg', [
        '-nostdin', '-v', 'error', '-y', ...inputFlags(inputPath), '-i', inputPath, '-map', `0:a:${audioIndex}`,
        '-af', 'aresample=async=1000:first_pts=0', '-ac', '1', '-ar', '16000', wav
    ], { timeout: 15 * 60 * 1000 });
    const { stderr } = await run(process.env.SUBTITLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [script, wav, source, '--model', model], {
        timeout: transcribeTimeout,
        killSignal: 'SIGKILL'
    });
    const summary = stderr.trim().split('\n').at(-1);
    console.log(`[Legenda: ${title}] ${summary}.`);
    return fs.readFile(source, 'utf8');
}

async function create(inputPath, audioIndex, { title, onProgress, subtitleStreams = [], isEuropeanPortuguese }) {
    if (!translator.isAvailable()) {
        throw subtitleError('Tradução PT-BR indisponível. GEMINI_API_KEY ausente.', 'SUBTITLE_PROVIDER_UNAVAILABLE');
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'brasilflix-sub-'));
    try {
        let source;
        try {
            onProgress?.(0, 'Aguardando análise da faixa de áudio');
            // Serializa a transcrição para evitar múltiplas cópias do modelo na memória.
            const task = pendingTranscription.then(() => {
                onProgress?.(0, 'Transcrevendo e marcando falas da faixa de áudio');
                return transcribe(inputPath, audioIndex, workspace, title);
            });
            pendingTranscription = task.catch(() => {});
            source = await task;
        } catch (error) {
            const detail = error.stderr?.trim().split('\n').at(-1) || error.code || 'sem resultado';
            throw subtitleError(`Falha na transcrição da faixa de áudio (${detail}).`, 'SUBTITLE_SYNC_FAILED');
        } finally {
            await fs.remove(path.join(workspace, 'audio.wav')).catch(() => {});
        }

        let translated;
        try {
            translated = await translator.translateSrt(source, {
                title,
                onBatch: (done, total) => onProgress?.(0, `Traduzindo legendas (${done}/${total} lotes)`)
            });
        } catch (error) {
            throw subtitleError(`Tradução PT-BR incompleta (${error.message}).`, 'SUBTITLE_PROVIDER_UNAVAILABLE');
        }
        const output = path.join(workspace, 'pt-br.srt');
        const embedded = await validateEmbedded(inputPath, subtitleStreams, translated, isEuropeanPortuguese);
        if (embedded) console.log(`[Legenda: ${title}] Faixa PT-BR do arquivo corroborada pelas falas. Mantendo seus horários.`);
        await fs.writeFile(output, embedded || translated, 'utf8');
        const retained = path.join(os.tmpdir(), `brasilflix-ptbr-${require('crypto').randomUUID()}.srt`);
        await fs.move(output, retained);
        return retained;
    } catch (error) {
        await fs.remove(workspace).catch(() => {});
        throw error;
    } finally {
        await fs.remove(workspace).catch(() => {});
    }
}

module.exports = { create, matchesSpokenDialogue };
