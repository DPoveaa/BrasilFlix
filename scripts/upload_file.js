#!/usr/bin/env node
/**
 * Upload de arquivo via SFTP para o servidor de produção BrasilFlix.
 * Uso: node scripts/upload_file.js <local_path> <remote_path>
 */
const { Client } = require('ssh2');
const fs = require('fs');
const [, , localPath, remotePath] = process.argv;

if (!localPath || !remotePath) {
    console.error('Usage: node scripts/upload_file.js <local_path> <remote_path>');
    process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
    conn.sftp((err, sftp) => {
        if (err) { console.error(err); conn.end(); process.exit(1); }
        sftp.fastPut(localPath, remotePath, (err2) => {
            if (err2) {
                console.error(`❌ Upload falhou: ${err2.message}`);
                conn.end();
                process.exit(1);
            }
            console.log(`✅ Upload concluído: ${localPath} → ${remotePath}`);
            conn.end();
        });
    });
}).connect({
    host: '192.168.68.58',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
