const { Client } = require('ssh2');

async function deployToServer() {
    console.log('🚀 Conectando ao servidor para deploy e reinicialização...');
    const conn = new Client();

    conn.on('ready', () => {
        console.log('🔌 Conectado via SSH (192.168.68.56:22). Executando deploy seguro (preservando catálogo)...');
        const cmd = 'cd /mnt/ssd500/projetos/BrasilFlix && git reset --hard HEAD && git pull origin main && npm install --omit=dev && node clear_queue.js && node scripts/remove_duplicate_reacher.js && (pip install ffsubsync --break-system-packages 2>/dev/null || pip install ffsubsync 2>/dev/null || true) && pm2 restart brasilflix && pm2 status';

        conn.exec(cmd, (err, stream) => {
            if (err) {
                console.error('❌ Erro no comando SSH:', err.message);
                conn.end();
                process.exit(1);
            }

            stream.on('data', d => process.stdout.write(d.toString()));
            stream.stderr.on('data', d => process.stderr.write(d.toString()));
            stream.on('close', (code) => {
                console.log(`\n✅ Deploy e reinicialização do BrasilFlix concluídos com código ${code}!`);
                conn.end();
                process.exit(code || 0);
            });
        });
    });

    conn.on('error', (err) => {
        console.error('❌ Falha na conexão SSH com o servidor:', err.message);
        process.exit(1);
    });

    conn.connect({
        host: '192.168.68.56',
        port: 22,
        username: 'povea',
        password: 'Daniel123.',
        readyTimeout: 10000
    });
}

deployToServer();
