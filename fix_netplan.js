const { Client } = require('ssh2');
const conn = new Client();

const netplanYaml = `network:
  version: 2
  renderer: networkd
  ethernets:
    all-en:
      match:
        name: "en*"
      dhcp4: no
      addresses:
        - 192.168.15.50/24
        - 192.168.68.50/22
      routes:
        - to: default
          via: 192.168.15.1
      nameservers:
        addresses:
          - 8.8.8.8
          - 1.1.1.1
      optional: true
`;

conn.on('ready', () => {
    conn.sftp((err, sftp) => {
        if (err) throw err;
        const stream = sftp.createWriteStream('/tmp/50-cloud-init.yaml');
        stream.write(netplanYaml);
        stream.end();
        stream.on('close', () => {
            conn.exec('echo Daniel123. | sudo -S cp /tmp/50-cloud-init.yaml /etc/netplan/50-cloud-init.yaml && echo Daniel123. | sudo -S netplan apply && ping -c 2 8.8.8.8 && ping -c 2 api.themoviedb.org', (err2, cmdStream) => {
                cmdStream.on('data', d => process.stdout.write(d.toString()));
                cmdStream.stderr.on('data', d => process.stderr.write(d.toString()));
                cmdStream.on('close', () => conn.end());
            });
        });
    });
}).connect({
    host: '192.168.15.50',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
