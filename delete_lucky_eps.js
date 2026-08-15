const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
    const fullCmd = `cd /mnt/ssd500/projetos/BrasilFlix && node -e "const db = require('./src/database/db'); (async () => {
        const delEp = await db.query('DELETE FROM episodios WHERE serie_id = 6 AND numero IN (1, 2) RETURNING *');
        console.log('Deleted cut episodes from DB:', delEp.rows);
        process.exit(0);
    })()"`;
    conn.exec(fullCmd, (err, stream) => {
        if (err) throw err;
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => conn.end());
    });
}).connect({ host: '192.168.15.50', port: 22, username: 'povea', password: 'Daniel123.' });
