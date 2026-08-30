const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Checking remote public/index.html size and modal presence...');
    const cmd = `grep -c "tab-playback-page" /home/povea/BrasilFlix/public/index.html; grep -c "web-player-modal" /home/povea/BrasilFlix/public/index.html; ls -lh /home/povea/BrasilFlix/public/index.html`;

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
