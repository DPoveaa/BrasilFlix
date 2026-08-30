const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `
        cd /mnt/ssd500/projetos/BrasilFlix &&
        node -e '
            const axios = require("axios");
            async function check() {
                const res = await axios.get("http://127.0.0.1:7000/api/catalogo");
                const st = (res.data.series || []).find(s => s.id == 17);
                const t4 = st.temporadas.find(t => t.numero === 4);
                console.log("Stranger Things T4 in Live API:", t4.episodios.map(e => e.numero));
                process.exit(0);
            }
            check().catch(e => { console.error(e.message); process.exit(1); });
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
