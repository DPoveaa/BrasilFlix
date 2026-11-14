const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const config = require('../config');

const run = promisify(execFile);

async function backup() {
    const destination = process.env.BRASILFLIX_BACKUP_DEST;
    if (!destination || !path.isAbsolute(destination)) {
        throw new Error('Defina BRASILFLIX_BACKUP_DEST com o diretório absoluto do volume de backup.');
    }
    const target = path.join(destination, `brasilflix-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`);
    const partial = `${target}.partial`;
    const env = { ...process.env, PGPASSWORD: config.DB_PASSWORD };
    try {
        await fs.access(destination);
        await run('pg_dump', [
            '--no-password', '--format=custom', '--no-owner', '--no-acl', '--file', partial,
            '--host', String(config.DB_HOST), '--port', String(config.DB_PORT),
            '--username', config.DB_USER, '--dbname', config.DB_NAME
        ], { env });
        await run('pg_restore', ['--list', partial], { maxBuffer: 8 * 1024 * 1024 });
        await fs.rename(partial, target);
        console.log(`Backup PostgreSQL verificado: ${target}`);
    } finally {
        await fs.rm(partial, { force: true });
    }
}

backup().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
