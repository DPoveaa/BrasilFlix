const db = require('../src/database/db');
(async () => {
    const r = await db.query(
        `SELECT id, season, episode, status, progress, progress_details, audio_preference
         FROM queue_jobs WHERE title ILIKE '%jujutsu%' AND episode = 2
         ORDER BY updated_at DESC LIMIT 8`
    );
    console.log(JSON.stringify(r.rows, null, 2));
    const eps = await db.query(
        `SELECT e.temporada_numero, e.numero, e.message_id, e.is_dublado, e.is_legendado
         FROM episodios e JOIN series s ON s.id=e.serie_id
         WHERE s.nome ILIKE '%jujutsu%' ORDER BY 1,2`
    );
    console.log('catalog', eps.rows);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
