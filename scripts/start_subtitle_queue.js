require('dotenv').config({ quiet: true });

const path = require('node:path');
const fs = require('fs-extra');
const db = require('../src/database/db');
const SubtitleMaintenance = require('../src/services/SubtitleMaintenance');

async function main() {
    const maintenance = new SubtitleMaintenance({});
    const eligible = await maintenance.seed();
    const data = path.resolve(__dirname, '../data');
    await fs.ensureDir(data);
    await fs.writeFile(path.join(data, 'subtitle_queue.enabled'), new Date().toISOString());
    console.log(JSON.stringify({ eligible, ...(await maintenance.dashboard('', 0)), jobs: undefined }));
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
}).finally(() => db.getPool().end());
