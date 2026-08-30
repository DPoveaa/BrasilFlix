const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `pm2 logs brasilflix --lines 60 --nostream`;

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
