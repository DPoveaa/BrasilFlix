const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    conn.exec('node -e "const s = require(\'/home/povea/BrasilFlix/src/services/SchedulerService.js\'); console.log(JSON.stringify(s.getStatus(), null, 2));"', (err, stream) => {
        if (err) throw err;
        stream.on('close', () => conn.end()).on('data', d => console.log(d.toString()));
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
