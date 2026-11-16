#!/usr/bin/env node
/**
 * Executa um comando SSH no servidor de produção BrasilFlix.
 * Uso: node scripts/run_remote.js --% "<comando>"
 */
const { Client } = require('ssh2');
const args = process.argv.slice(2);
const cmd = args.join(' ');

if (!cmd.trim()) {
    console.error('Usage: node scripts/run_remote.js <command>');
    process.exit(1);
}

const conn = new Client();
conn.on('ready', () => {
    conn.exec(cmd, (err, stream) => {
        if (err) { console.error(err); conn.end(); process.exit(1); }
        stream.on('close', (code) => {
            conn.end();
            process.exit(code || 0);
        }).on('data', (data) => {
            process.stdout.write(data);
        }).stderr.on('data', (data) => {
            process.stderr.write(data);
        });
    });
}).connect({
    host: '192.168.68.58',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
