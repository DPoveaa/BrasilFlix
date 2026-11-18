// Offline cleanup: no database connection, media decoding or model invocation.
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { sanitizeVtt } = require('../src/utils/SubtitleUtils');

async function main() {
    const directory = path.resolve(__dirname, '../public/subtitles');
    let scanned = 0;
    let changed = 0;
    const names = await fs.readdir(directory).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    for (const name of names) {
        if (!name.toLowerCase().endsWith('.vtt')) continue;
        const file = path.join(directory, name);
        const raw = await fs.readFile(file, 'utf8');
        const clean = sanitizeVtt(raw);
        scanned++;
        if (raw === clean) continue;
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, clean, 'utf8');
            await fs.rename(temporary, file);
            changed++;
        } finally { await fs.rm(temporary, { force: true }); }
    }
    console.log(JSON.stringify({ scanned, changed }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
