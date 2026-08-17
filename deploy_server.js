const { Client } = require('ssh2');

async function deployToServer() {
    console.log('🚀 Conectando ao servidor para deploy e reinicialização...');
    const conn = new Client();

    conn.on('ready', () => {
        console.log('🔌 Conectado via SSH (192.168.15.50:22). Executando git pull, npm install, clear-queue e restart no PM2...');
        const cmd = 'cd /mnt/ssd500/projetos/BrasilFlix && git pull && npm install --omit=dev && node clear_queue.js && pm2 restart brasilflix';

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
        host: '192.168.15.50',
        port: 22,
        username: 'povea',
        password: 'Daniel123.',
        readyTimeout: 10000
    });
}

deployToServer();
