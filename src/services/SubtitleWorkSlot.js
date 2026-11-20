const db = require('../database/db');
const BASE_KEY = 42701115;
const NUM_SLOTS = parseInt(process.env.MAX_SUBTITLE_SLOTS || '2', 10);
let schema;

function init() {
    return schema ||= db.query(`CREATE TABLE IF NOT EXISTS subtitle_active_work (
        id INTEGER PRIMARY KEY, backend INTEGER NOT NULL, title TEXT NOT NULL,
        kind TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, stage TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE subtitle_active_work DROP CONSTRAINT IF EXISTS subtitle_active_work_id_check;
    ALTER TABLE subtitle_active_work ADD COLUMN IF NOT EXISTS media_type TEXT;
    ALTER TABLE subtitle_active_work ADD COLUMN IF NOT EXISTS media_id BIGINT;`).catch(error => { schema = null; throw error; });
}

async function run(label, work, wait = true, kind = 'catalog', media = null) {
    await init();
    const client = await db.getPool().connect();
    let acquiredSlot = null;
    let acquiredKey = null;
    let broken = false;
    const onError = () => { broken = true; };
    client.on('error', onError);
    try {
        if (wait) {
            while (!acquiredSlot && !broken) {
                for (let i = 1; i <= NUM_SLOTS; i++) {
                    const testKey = BASE_KEY + (i - 1);
                    const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [testKey]);
                    if (res.rows[0].locked) {
                        acquiredSlot = i;
                        acquiredKey = testKey;
                        break;
                    }
                }
                if (!acquiredSlot) {
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        } else {
            for (let i = 1; i <= NUM_SLOTS; i++) {
                const testKey = BASE_KEY + (i - 1);
                const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [testKey]);
                if (res.rows[0].locked) {
                    acquiredSlot = i;
                    acquiredKey = testKey;
                    break;
                }
            }
        }
        if (acquiredSlot) {
            await client.query(`INSERT INTO subtitle_active_work (id,backend,title,kind,stage,media_type,media_id)
                VALUES ($1,pg_backend_pid(),$2,$3,'Preparando áudio',$4,$5)
                ON CONFLICT (id) DO UPDATE SET backend=EXCLUDED.backend,title=EXCLUDED.title,
                kind=EXCLUDED.kind,progress=0,stage=EXCLUDED.stage,started_at=NOW(),
                media_type=EXCLUDED.media_type,media_id=EXCLUDED.media_id`, [acquiredSlot, label, kind, media?.type, media?.id]);
            const progress = (percent, stage) => {
                if (broken) return;
                client.query(`UPDATE subtitle_active_work SET progress=GREATEST(progress,$1),stage=$2
                    WHERE id=$3 AND backend=pg_backend_pid()`, [percent, stage, acquiredSlot]).catch(error => {
                    if (!broken) console.warn('[Subtitle progress]', error.message);
                });
            };
            return await work(progress);
        }
    } finally {
        try {
            if (acquiredSlot && acquiredKey && !broken) {
                await client.query('DELETE FROM subtitle_active_work WHERE id=$1 AND backend=pg_backend_pid()', [acquiredSlot]);
                await client.query('SELECT pg_advisory_unlock($1)', [acquiredKey]);
            }
        } catch (_) { broken = true; }
        client.removeListener('error', onError);
        client.release(broken);
    }
    return null;
}

async function active() {
    await init();
    const { rows } = await db.query(`SELECT COALESCE(w.title,NULLIF(a.application_name,''),'Legenda em processamento') AS title,
        COALESCE(w.kind,'ingest') AS kind, w.progress, w.stage, w.started_at, w.media_type, w.media_id
        FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        LEFT JOIN subtitle_active_work w ON w.backend=l.pid
        WHERE l.locktype='advisory' AND l.classid=0 AND l.objid >= $1::bigint AND l.objid < $1::bigint + $2::bigint AND l.objsubid=1 AND l.granted
        ORDER BY w.started_at ASC`, [BASE_KEY, NUM_SLOTS]);
    return rows[0] || null;
}

module.exports = { run, active, revision: 4 };
