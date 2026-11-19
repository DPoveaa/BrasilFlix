const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const translator = require('./SubtitleTranslationService');
const dialogueReferenceVersion = 'dialogue-full-v3';

const run = promisify(execFile);
const script = path.resolve(__dirname, '../../scripts/transcribe_subtitle_audio.py');
const inputFlags = input => /^https?:\/\//i.test(input) ? [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '429,5xx', '-reconnect_delay_max', '5', '-rw_timeout', '30000000'
] : [];
const transcribeTimeout = 90 * 60 * 1000;
const maxConcurrentTranscribes = parseInt(process.env.MAX_SUBTITLE_SLOTS || '2', 10);
let activeTranscribes = 0;
const transcribeQueue = [];

function acquireTranscribeSlot() {
    if (activeTranscribes < maxConcurrentTranscribes) {
        activeTranscribes++;
        return Promise.resolve();
    }
    return new Promise(resolve => transcribeQueue.push(resolve));
}

function releaseTranscribeSlot() {
    activeTranscribes--;
    if (transcribeQueue.length > 0) {
        activeTranscribes++;
        const next = transcribeQueue.shift();
        next();
    }
}

let pendingCheckpoints = Promise.resolve();

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

async function transcribe(inputPath, audioIndex, workspace, title, audioCachePath, duration = 0, onProgress = null) {
    const wav = audioCachePath || path.join(workspace, 'audio.wav');
    const cachedSource = audioCachePath ? `${audioCachePath}.source.srt` : null;
    if (cachedSource && await fs.pathExists(cachedSource)) return fs.readFile(cachedSource, 'utf8');
    const source = path.join(workspace, 'source.srt');
    const model = process.env.SUBTITLE_WHISPER_MODEL || 'turbo';
    const minimumBytes = duration > 0 ? duration * 32000 * 0.97 : 10000;
    const cachedAudio = await fs.stat(wav).catch(() => null);
    if (!cachedAudio || cachedAudio.size < minimumBytes) {
        const temporary = `${wav}.${require('crypto').randomUUID()}.partial.wav`;
        try {
            console.log(`🎙️ [Legenda: "${title}"] Extraindo faixa de áudio para conferência...`);
            await run('ffmpeg', [
                '-nostdin', '-v', 'error', '-y', ...inputFlags(inputPath), '-i', inputPath, '-map', `0:a:${audioIndex}`,
                '-af', 'aresample=async=1000:first_pts=0', '-ac', '1', '-ar', '16000', temporary
            ], { timeout: /^https?:/.test(inputPath) ? 90 * 60 * 1000 : 20 * 60 * 1000 });
            if ((await fs.stat(temporary)).size < minimumBytes) throw new Error('Extração de áudio incompleta.');
            await fs.rename(temporary, wav);
        } finally { await fs.remove(temporary).catch(() => {}); }
    }
    console.log(`🎙️ [Legenda: "${title}"] Iniciando transcrição com Whisper ${model} (6 threads)...`);
    const timeout = Math.ceil(Math.max(transcribeTimeout, ((await fs.stat(wav)).size / 32000) * 2000));
    const pyBin = process.env.SUBTITLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const pyArgs = [script, wav, source, '--model', model, '--threads', process.env.SUBTITLE_WHISPER_THREADS || '6', '--recover-gaps'];

    let lastStderr = '';
    const child = execFile(pyBin, pyArgs, { timeout, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 });
    child.stderr.on('data', chunk => {
        const text = chunk.toString();
        lastStderr += text;
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.includes('[WHISPER_PROGRESS]')) {
                const prog = line.replace(/.*\[WHISPER_PROGRESS\]\s*/, '').trim();
                console.log(`🎙️ [Legenda: "${title}"] Whisper IA: ${prog}`);
                onProgress?.(Math.min(75, 24 + Math.round(parseInt(prog) * 0.5)), `Transcrevendo áudio: ${prog}`);
            }
        }
    });

    await new Promise((resolve, reject) => {
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(Object.assign(new Error(`Whisper falhou com código ${code}`), { stderr: lastStderr }));
        });
        child.on('error', reject);
    });

    const summaryLine = lastStderr.trim().split('\n').filter(l => !l.includes('[WHISPER_PROGRESS]')).at(-1) || 'concluído';
    console.log(`✅ [Legenda: "${title}"] Transcrição concluída: ${summaryLine}`);

    if (cachedSource) {
        const temporary = `${cachedSource}.${require('crypto').randomUUID()}.tmp`;
        await fs.copy(source, temporary);
        await fs.rename(temporary, cachedSource);
        await fs.remove(wav).catch(() => {});
    }
    return fs.readFile(source, 'utf8');
}

async function create(inputPath, audioIndex, { title, onProgress, subtitleStreams = [], isEuropeanPortuguese, audioCachePath = null, duration = 0 }) {
    if (!translator.isAvailable()) {
        throw subtitleError('Tradução PT-BR indisponível. GEMINI_API_KEY ausente.', 'SUBTITLE_PROVIDER_UNAVAILABLE');
    }

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'brasilflix-sub-'));
    try {
        let source;
        try {
            onProgress?.(0, 'Aguardando vaga para transcrição de áudio');
            await acquireTranscribeSlot();
            try {
                onProgress?.(0, 'Transcrevendo e marcando falas da faixa de áudio');
                source = await transcribe(inputPath, audioIndex, workspace, title, audioCachePath, duration, onProgress);
            } finally {
                releaseTranscribeSlot();
            }
        } catch (error) {
            const detail = error.stderr?.trim().split('\n').at(-1) || error.message || error.code || 'sem resultado';
            throw subtitleError(`Falha na transcrição da faixa de áudio (${detail}).`, 'SUBTITLE_SYNC_FAILED');
        } finally {
            await fs.remove(path.join(workspace, 'audio.wav')).catch(() => {});
        }

        let translated;
        try {
            translated = await translator.translateSrt(source, {
                title,
                onBatch: (done, total) => onProgress?.(80 + Math.floor(15 * done / total), `Traduzindo legendas (${done}/${total} lotes)`)
            });
        } catch (error) {
            throw Object.assign(subtitleError(`Tradução PT-BR incompleta (${error.message}).`, 'SUBTITLE_PROVIDER_UNAVAILABLE'),
                { retryAt: error.retryAt });
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

async function createCheckpoints(inputPath, audioIndex, { title, duration, checkpointTimes, onProgress }) {
    if (!translator.isAvailable() || duration < 120) throw subtitleError('Referência por checkpoints indisponível.', 'SUBTITLE_PROVIDER_UNAVAILABLE');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-checkpoints-'));
    try {
        const clips = [];
        for (let index = 0; index < 8; index++) {
            const center = checkpointTimes?.[index] ?? duration * ((index + 0.5) / 8);
            const offset = Math.max(0, Math.min(duration - 90, center - 30));
            const file = path.join(workspace, `${index}.wav`);
            onProgress?.(20, `Extraindo amostra de fala ${index + 1}/8`);
            await run('ffmpeg', [
                '-nostdin', '-v', 'error', '-y', ...inputFlags(inputPath),
                '-ss', String(offset), '-i', inputPath, '-t', '90', '-map', `0:a:${audioIndex}`,
                '-vn', '-af', 'aresample=async=1000:first_pts=0', '-ac', '1', '-ar', '16000', file
            ], { timeout: 180000 });
            clips.push({ path: file, offset });
        }
        const manifest = path.join(workspace, 'clips.json');
        const source = path.join(workspace, 'source.srt');
        await fs.writeJson(manifest, clips);
        const task = pendingCheckpoints.then(() => {
            onProgress?.(35, 'Reconhecendo o conteúdo das falas nos 8 checkpoints');
            return run(process.env.SUBTITLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [
                path.resolve(__dirname, '../../scripts/transcribe_subtitle_checkpoints.py'),
                manifest, source, process.env.SUBTITLE_WHISPER_CHECKPOINT_MODEL || 'tiny'
            ], { timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
        });
        pendingCheckpoints = task.catch(() => {});
        await task;
        const translated = await translator.translateSrt(await fs.readFile(source, 'utf8'), {
            title, onBatch: (done, total) => onProgress?.(55, `Verificando falas PT-BR (${done}/${total})`)
        });
        const output = path.join(os.tmpdir(), `subtitle-checkpoints-${require('crypto').randomUUID()}.srt`);
        await fs.writeFile(output, translated, 'utf8');
        return output;
    } finally { await fs.remove(workspace).catch(() => {}); }
}

async function sourceTranscript(inputPath, audioIndex, { title, duration, audioCachePath, onProgress }) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-source-'));
    try {
        onProgress?.(24, 'Aguardando vaga para comparar legendas');
        await acquireTranscribeSlot();
        try {
            onProgress?.(24, 'Transcrevendo o áudio original para comparar as legendas');
            return await transcribe(inputPath, audioIndex, workspace, title, audioCachePath, duration, onProgress);
        } finally {
            releaseTranscribeSlot();
        }
    } finally {
        await fs.remove(workspace).catch(() => {});
    }
}

module.exports = { create, createCheckpoints, matchesSpokenDialogue, sourceTranscript, dialogueReferenceVersion };
