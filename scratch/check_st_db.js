const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `
        cd /mnt/ssd500/projetos/BrasilFlix &&
        node -e '
            const db = require("./src/database/db");
            async function inspect() {
                const res = await db.query("SELECT * FROM episodios WHERE serie_id = 17 AND temporada_numero = 4 ORDER BY numero ASC");
                console.log("PostgreSQL Episodes for Stranger Things T4:");
                for (const r of res.rows) {
                    console.log("Ep", r.numero, "| msg_id:", r.message_id, "| is_dub:", r.is_dublado, "| is_leg:", r.is_legendado, "| versoes:", r.versoes);
                }
                process.exit(0);
            }
            inspect().catch(e => { console.error(e); process.exit(1); });
        '
    `;

    conn.exec(scriptToRun, (err, stream) => {
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
