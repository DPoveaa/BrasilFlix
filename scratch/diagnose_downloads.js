const { Client } = require('ssh2');

const conn = new Client();

const scriptContent = `
const db = require('/home/povea/BrasilFlix/src/database/db.js');

async function check() {
    try {
        console.log('=== 1. CONTAGEM DE JOBS NA TABELA queue_jobs ===');
        const counts = await db.query('SELECT status, COUNT(*) FROM queue_jobs GROUP BY status');
        console.log(JSON.stringify(counts.rows, null, 2));

        console.log('=== 2. JOBS ATIVOS / EM PROCESSAMENTO ===');
        const active = await db.query("SELECT id, title, type, priority, status, season, episode, audio_preference, progress, progress_details, created_at FROM queue_jobs WHERE status = 'downloading' OR status = 'processing' OR status = 'uploading'");
        console.log(JSON.stringify(active.rows, null, 2));

        console.log('=== 3. PRÓXIMOS 10 JOBS NA FILA (QUEUED) ===');
        const queued = await db.query("SELECT id, title, type, priority, status, season, episode, audio_preference, queue_order, created_at FROM queue_jobs WHERE status = 'queued' ORDER BY priority ASC, queue_order ASC, id ASC LIMIT 10");
        console.log(JSON.stringify(queued.rows, null, 2));

        console.log('=== 4. SWARM WATCHLIST (ESPERANDO SEEDS) ===');
        const swarm = await db.query("SELECT id, title, type, season, episode, audio_preference, reason, check_count, last_checked FROM swarm_watchlist ORDER BY id DESC LIMIT 10");
        console.log(JSON.stringify(swarm.rows, null, 2));
    } catch(e) {
        console.error('Erro:', e.message);
    } finally {
        process.exit(0);
    }
}
check();
`;

conn.on('ready', () => {
    console.log('SSH connected. Uploading diagnose script...');
    conn.sftp((err, sftp) => {
        if (err) throw err;
        const writeStream = sftp.createWriteStream('/home/povea/diagnose_downloads.js');
        writeStream.end(scriptContent, () => {
            conn.exec('cd /home/povea/BrasilFlix && node /home/povea/diagnose_downloads.js', (err, stream) => {
                if (err) throw err;
                stream.on('close', (code) => {
                    console.log('Finished with code:', code);
                    conn.end();
                }).on('data', (data) => {
                    console.log(data.toString());
                }).stderr.on('data', (data) => {
                    console.error(data.toString());
                });
            });
        });
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
