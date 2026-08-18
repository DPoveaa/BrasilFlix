const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
    conn.exec('cd /mnt/ssd500/projetos/BrasilFlix && node -e "const db = require(\\"./src/database/db\\"); db.query(\\"SELECT s.id, s.nome, s.nome_original, s.tmdb_id, e.temporada_numero, e.numero, e.message_id FROM series s JOIN episodios e ON s.id = e.serie_id\\").then(r => { console.log(r.rows); process.exit(0); });"', (err, stream) => {
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => conn.end());
    });
}).connect({
    host: '192.168.15.50',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
