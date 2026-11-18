const db = require('../database/db');
const { setTimeout: delay } = require('node:timers/promises');

const key = 42701115;

async function run(label, work, wait = true) {
    for (;;) {
        const client = await db.getPool().connect();
        let locked = false;
        let broken = false;
        const onError = () => { broken = true; };
        client.on('error', onError);
        try {
            locked = (await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key])).rows[0].locked;
            if (locked) {
                await client.query("SELECT set_config('application_name', $1, false)", [`Legenda: ${label}`.slice(0, 55)]);
                return await work();
            }
        } finally {
            try {
                if (locked && !broken) {
                    await client.query('RESET application_name');
                    await client.query('SELECT pg_advisory_unlock($1)', [key]);
                }
            } catch (_) { broken = true; }
            client.removeListener('error', onError);
            client.release(broken);
        }
        if (!wait) return null;
        await delay(2500);
    }
}

async function active() {
    const { rows } = await db.query(`SELECT a.application_name AS label
        FROM pg_locks l JOIN pg_stat_activity a USING (pid)
        WHERE l.locktype='advisory' AND l.classid=0 AND l.objid=$1 AND l.objsubid=1 AND l.granted`, [key]);
    return rows[0]?.label || null;
}

module.exports = { run, active, revision: 3 };
