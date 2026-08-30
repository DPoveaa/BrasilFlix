const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Checking logs for Minions & Monstros...');
    const cmd = `grep -i "minion" /home/povea/.pm2/logs/* 2>/dev/null | tail -n 40`;

    conn.exec(cmd, (err, stream) => {
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
