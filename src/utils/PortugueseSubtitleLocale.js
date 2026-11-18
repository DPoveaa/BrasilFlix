const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');

const model = process.env.SUBTITLE_PT_VARIANT_MODEL ||
    path.resolve(__dirname, '../../data/subtitle_models/portuguese-locale/model_quantized.ftz');
const script = path.resolve(__dirname, '../../scripts/classify_portuguese_subtitles.py');
const cache = new Map();
let tail = Promise.resolve();

function explicitlyEuropean(sourceLang, sourceFile) {
    const lang = String(sourceLang || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
    const file = String(sourceFile || '').toLowerCase();
    return ['pt-pt', 'pt_pt', 'ptpt', 'por-pt', 'por_pt', 'portuguese (portugal)',
        'portugues (portugal)', 'european portuguese'].includes(lang) ||
        /(?:^|[^a-z0-9])(?:pt[-_. ]?pt|por[-_. ]?pt)(?:$|[^a-z0-9])/.test(file);
}

function run(cues) {
    return new Promise((resolve, reject) => {
        const python = process.env.SUBTITLE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
        const child = spawn(python, [script, model], { timeout: 15000, windowsHide: true, killSignal: 'SIGKILL' });
        let output = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.resume();
        const unavailable = () => reject(Object.assign(new Error('Classificador local de português indisponível.'),
            { code: 'SUBTITLE_LOCALE_UNAVAILABLE' }));
        child.on('error', unavailable);
        child.stdin.on('error', unavailable);
        child.on('close', code => {
            if (code !== 0) return unavailable();
            try {
                const result = JSON.parse(output);
                if (!['pt-BR', 'pt-PT', 'uncertain'].includes(result.variety)) return unavailable();
                resolve(result);
            } catch (_) { unavailable(); }
        });
        child.stdin.end(JSON.stringify(cues));
    });
}

function classifyPortuguese(cues) {
    const dialogue = cues.map(cue => String(cue).replace(/<[^>]+>|\{[^}]+\}/g, '').replace(/\s+/gu, ' ').trim());
    const key = createHash('sha256').update(dialogue.join(' ')).digest('hex');
    if (!cache.has(key)) {
        const result = tail.then(() => run(dialogue)).catch(error => {
            cache.delete(key);
            throw error;
        });
        tail = result.catch(() => {});
        cache.set(key, result);
        if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    return cache.get(key);
}

module.exports = { classifyPortuguese, explicitlyEuropean };
