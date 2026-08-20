const { Client } = require('ssh2');
const conn = new Client();

const serverScript = `
const db = require('/mnt/ssd500/projetos/BrasilFlix/src/database/db');

async function run() {
    try {
        const f = await db.query('SELECT id, nome, generos, tmdb_id, imdb_id, is_dublado, is_legendado, is_cam FROM filmes ORDER BY id DESC');
        const s = await db.query('SELECT id, nome, generos, is_dorama, tmdb_id, imdb_id, is_dublado, is_legendado FROM series ORDER BY id DESC');
        
        console.log('=== FILMES NO BANCO (' + f.rows.length + ') ===');
        f.rows.forEach(r => console.log('🎬 [' + r.id + '] ' + r.nome + ' | TMDB: ' + r.tmdb_id + ' | Generos: ' + JSON.stringify(r.generos)));
        
        console.log('\\n=== SERIES NO BANCO (' + s.rows.length + ') ===');
        s.rows.forEach(r => console.log('📺 [' + r.id + '] ' + r.nome + ' | is_dorama=' + r.is_dorama + ' | TMDB: ' + r.tmdb_id + ' | Generos: ' + JSON.stringify(r.generos)));
    } catch (e) {
        console.error('Erro na query:', e.message);
    }
    process.exit(0);
}
run();
`;

conn.on('ready', () => {
    conn.sftp((err, sftp) => {
        if (err) { console.error('SFTP:', err); conn.end(); return; }
        const stream = sftp.createWriteStream('/tmp/inspect_db.js');
        stream.write(serverScript);
        stream.end();
        stream.on('close', () => {
            conn.exec('cd /mnt/ssd500/projetos/BrasilFlix && node /tmp/inspect_db.js', (err2, st) => {
                if (err2) { console.error('Exec:', err2); conn.end(); return; }
                st.on('data', d => process.stdout.write(d.toString()));
                st.stderr.on('data', d => process.stderr.write(d.toString()));
                st.on('close', () => { conn.end(); process.exit(0); });
            });
        });
    });
});

conn.on('error', e => console.error('SSH Error:', e.message));

conn.connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
