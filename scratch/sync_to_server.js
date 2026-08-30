const { Client } = require('ssh2');
const fs = require('fs-extra');
const path = require('path');

const filesToSync = [
    'src/database/db.js',
    'src/services/AuthService.js',
    'src/services/MicrodramaService.js',
    'src/services/StremioServer.js',
    'src/services/DiskCleaner.js',
    'src/managers/CatalogoManager.js',
    'src/managers/QueueManager.js',
    'public/index.html'
];

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Opening SFTP...');
    conn.sftp((err, sftp) => {
        if (err) throw err;

        let completed = 0;
        filesToSync.forEach(relPath => {
            const localPath = path.resolve(__dirname, '..', relPath);
            const remotePath = `/home/povea/BrasilFlix/${relPath.replace(/\\/g, '/')}`;

            console.log(`Enviando: ${relPath} -> ${remotePath}`);
            sftp.fastPut(localPath, remotePath, (errPut) => {
                if (errPut) {
                    console.error(`❌ Erro ao enviar ${relPath}:`, errPut.message);
                } else {
                    console.log(`✅ Sincronizado: ${relPath}`);
                }
                completed++;
                if (completed === filesToSync.length) {
                    console.log('Todos os arquivos enviados. Recarregando PM2...');
                    conn.exec('pm2 reload brasilflix', (errExec, stream) => {
                        if (errExec) throw errExec;
                        stream.on('close', () => {
                            console.log('🎉 PM2 recarregado com sucesso no servidor de produção!');
                            conn.end();
                        });
                        stream.on('data', (d) => process.stdout.write(d));
                    });
                }
            });
        });
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
