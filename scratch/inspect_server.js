const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connection ready. Running queries on remote server...');
    const cmd = `node -e "
        const db = require('./src/database/db');
        (async () => {
            try {
                const res = await db.query('SELECT * FROM filmes WHERE id = 15 OR LOWER(nome) LIKE \\'%minion%\\'');
                console.log('Filmes:', JSON.stringify(res.rows, null, 2));
            } catch (e) {
                console.error('DB Error:', e.message);
            }
            process.exit(0);
        })();
    "`;

    conn.exec(`cd /home/povea/BrasilFlix && ${cmd}`, (err, stream) => {
        if (err) throw err;
        stream.on('close', () => conn.end());
        stream.on('data', (d) => process.stdout.write(d));
        stream.stderr.on('data', (d) => process.stderr.write(d));
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
