const { Client } = require('ssh2');
const path = require('path');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Uploading public/index.html to remote server...');
    conn.sftp((err, sftp) => {
        if (err) throw err;

        const localPath = path.resolve(__dirname, '../public/index.html');
        const remotePath = '/home/povea/BrasilFlix/public/index.html';

        sftp.fastPut(localPath, remotePath, (errPut) => {
            if (errPut) {
                console.error('❌ Erro no envio de index.html:', errPut.message);
                conn.end();
                return;
            }
            console.log('✅ public/index.html enviado com sucesso para o servidor!');

            conn.exec('pm2 reload brasilflix', (errExec, stream) => {
                if (errExec) throw errExec;
                stream.on('close', () => {
                    console.log('🎉 PM2 brasilflix recarregado no servidor de produção!');
                    conn.end();
                });
                stream.on('data', (d) => process.stdout.write(d));
            });
        });
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
