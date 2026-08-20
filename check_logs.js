const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
    const cmd = `
        grep -a -C 10 -i "The.Rookie.SEASON.01" /home/povea/.pm2/logs/brasilflix-out.log | tail -n 80
    `;
    conn.exec(cmd, (err, stream) => {
        if (err) { console.error(err); conn.end(); return; }
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => { conn.end(); process.exit(0); });
    });
});
conn.connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
