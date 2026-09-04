const path = require('path');
const fs = require('fs');
const db = require('../src/database/db');

(async () => {
    const e2 = '/mnt/ssd500/projetos/BrasilFlix/downloads/temp/Jujutsu Kaisen S01 2020 WEB-DL 1080p x265 DUAL 2.0/Jujutsu Kaisen S01E02 WEB-DL 1080p x265 DUAL 2.0.mkv';
    if (!fs.existsSync(e2)) {
        console.log('S01E02 não encontrado no SSD:', e2);
        process.exit(1);
    }

    // Remove jobs E2 dublado stale
    await db.query(`DELETE FROM queue_jobs WHERE title ILIKE '%jujutsu%' AND season=1 AND episode=2 AND audio_preference='dublado'`);

    const id = `job_${Date.now()}_jujutsu_e2_fix`;
    const extra = {
        rawFilePath: e2,
        expectedSize: fs.statSync(e2).size,
        isAnime: true,
        originalLanguage: 'ja',
        idiomaOriginal: 'ja',
        audioPreference: 'dublado'
    };
    await db.query(
        `INSERT INTO queue_jobs (id, title, type, priority, audio_preference, season, episode, status, progress, progress_details, extra_data, queue_order, created_at, updated_at)
         VALUES ($1,$2,'serie',2,'dublado',1,2,'queued',0,'Arquivo local pronto (E2 corrigido)',$3::jsonb,2,NOW(),NOW())`,
        [id, 'Jujutsu Kaisen', JSON.stringify(extra)]
    );
    console.log('Enqueued', id, '→', e2);
    // ping pm2 process by touching - queue polls DB
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
