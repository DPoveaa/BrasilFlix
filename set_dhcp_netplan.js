const { Client } = require('ssh2');
const conn = new Client();

const netplanConfig = `network:
  version: 2
  renderer: networkd
  ethernets:
    all-en:
      match:
        name: "en*"
      dhcp4: true
      optional: true
`;

conn.on('ready', () => {
    console.log('🔌 Conectado via SSH em 192.168.15.50!');
    conn.sftp((err, sftp) => {
        if (err) {
            console.error('SFTP Error:', err);
            conn.end();
            return;
        }
        const stream = sftp.createWriteStream('/tmp/01-netcfg.yaml');
        stream.write(netplanConfig);
        stream.end();
        stream.on('close', () => {
            console.log('📝 Configuração DHCP salva em /tmp/01-netcfg.yaml!');
            const cmd = 'echo "Daniel123." | sudo -S cp /tmp/01-netcfg.yaml /etc/netplan/01-netcfg.yaml && echo "Daniel123." | sudo -S rm -f /etc/netplan/50-cloud-init.yaml && echo "Daniel123." | sudo -S chmod 600 /etc/netplan/01-netcfg.yaml && echo "Daniel123." | sudo -S netplan apply';
            conn.exec(cmd, (err2, st) => {
                if (err2) {
                    console.error('Exec error:', err2);
                    conn.end();
                    return;
                }
                let out = '';
                st.on('data', d => out += d);
                st.stderr.on('data', d => out += d);
                st.on('close', (code) => {
                    console.log('✅ Netplan DHCP aplicado com código:', code);
                    console.log(out);
                    conn.end();
                });
            });
        });
    });
});

conn.on('error', (e) => {
    console.error('❌ Falha SSH:', e.message);
});

conn.connect({
    host: '192.168.15.50',
    port: 22,
    username: 'povea',
    password: 'Daniel123.',
    readyTimeout: 10000
});
