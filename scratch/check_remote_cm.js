const { Client } = require('ssh2');
const fs = require('fs');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `
        cd /mnt/ssd500/projetos/BrasilFlix &&
        node -e '
            const CatalogoManager = require("./src/managers/CatalogoManager");
            async function test() {
                const cm = new CatalogoManager();
                await cm.loadCatalogo();
                const st = cm.buscarSeriePorId(17);
                console.log("In-Memory Serie 17 Seasons:");
                for (const t of st.temporadas) {
                    console.log("Temporada", t.numero, "Eps:", t.episodios.map(e => e.numero));
                }
                process.exit(0);
            }
            test().catch(e => { console.error(e); process.exit(1); });
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
