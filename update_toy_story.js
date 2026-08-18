const { Client } = require('ssh2');
const conn = new Client();

conn.on('ready', () => {
    const cmd = `cd /mnt/ssd500/projetos/BrasilFlix && node -e "
const db = require('./src/database/db');
const fs = require('fs-extra');
const path = require('path');

(async () => {
    // 1. Atualiza no PostgreSQL
    const res = await db.query(
        \"UPDATE filmes SET qualidade = 'CAM (Cinema)', is_cam = true WHERE nome ILIKE '%Toy Story%' RETURNING *\"
    );
    console.log('Filmes atualizados no PostgreSQL:', res.rows);

    // 2. Atualiza no catalogo.json
    const catPath = path.resolve('./data/catalogo.json');
    if (fs.existsSync(catPath)) {
        const cat = fs.readJsonSync(catPath);
        (cat.filmes || []).forEach(f => {
            if (f.nome && f.nome.toLowerCase().includes('toy story')) {
                f.qualidade = 'CAM (Cinema)';
                f.isCam = true;
                if (f.versoes?.dublado) {
                    f.versoes.dublado.qualidade = 'CAM (Cinema)';
                    f.versoes.dublado.isCam = true;
                }
                if (f.versoes?.legendado) {
                    f.versoes.legendado.qualidade = 'CAM (Cinema)';
                    f.versoes.legendado.isCam = true;
                }
            }
        });
        fs.writeJsonSync(catPath, cat, { spaces: 2 });
        console.log('catalogo.json atualizado!');
    }
    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
"`;

    conn.exec(cmd, (err, stream) => {
        if (err) throw err;
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => {
            conn.end();
            process.exit(0);
        });
    });
});

conn.connect({
    host: '192.168.15.50',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
