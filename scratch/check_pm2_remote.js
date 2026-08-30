const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Checking PM2 status and logs...');
    conn.exec('pm2 status && pm2 logs brasilflix --lines 25 --nostream', (err, stream) => {
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
