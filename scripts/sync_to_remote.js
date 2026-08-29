const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

const filesToSync = [
    'config.js',
    'deploy_server.js',
    'test_audit_fixes.js',
    'src/index.js',
    'src/database/db.js',
    'src/services/AuthService.js',
    'src/handlers/MessageHandler.js',
    'src/handlers/CommandHandler.js',
    'src/services/SettingsService.js',
    'src/services/SchedulerService.js',
    'src/services/PriorityService.js',
    'src/services/DownloaderManager.js',
    'src/services/VideoProcessor.js',
    'src/services/SubtitleSync.js',
    'src/services/StremioService.js',
    'src/services/StremioServer.js',
    'src/managers/CatalogoManager.js',
    'src/managers/AssinaturaManager.js',
    'src/managers/QueueManager.js',
    'src/managers/ProgressManager.js',
    'src/services/AutoFeeder.js',
    'src/services/SwarmWatcher.js',
    'src/services/DiskCleaner.js',
    'src/services/MediaSearchService.js',
    'src/services/TelegramUploader.js',
    'public/index.html',
    'public/assinar.html',
    'public/configure.html',
    'public/favicon.ico',
    'public/favicon.png',
    'public/favicon-32x32.png',
    'public/favicon-16x16.png',
    'public/apple-touch-icon.png',
    'public/icon.png',
    'public/logo.jpg',
    'public/assets/logos/symbol_icon.jpg',
    'public/assets/logos/logo_horizontal.jpg',
    'public/assets/logos/original_logo.jpg',
    'public/assets/telegram/bot_avatar.jpg',
    'public/assets/telegram/vip_clients_avatar.jpg',
    'public/assets/telegram/storage_group_avatar.jpg',
    'scripts/run_production_audit.js'
];

async function sync() {
    const conn = new Client();
    await new Promise((resolve, reject) => {
        conn.on('ready', () => resolve());
        conn.on('error', reject);
        conn.connect({ host: '192.168.68.56', port: 22, username: 'povea', password: 'Daniel123.' });
    });

    console.log('Connected to remote server 192.168.68.56 via SSH.');

    // Garante que os diretórios remotos existam
    await new Promise((resolve, reject) => {
        conn.exec('mkdir -p /mnt/ssd500/projetos/BrasilFlix/public/assets/logos /mnt/ssd500/projetos/BrasilFlix/public/assets/telegram', (err, stream) => {
            if (err) return reject(err);
            stream.on('data', () => {});
            stream.stderr.on('data', () => {});
            stream.on('close', () => resolve());
        });
    });

    const sftp = await new Promise((resolve, reject) => {
        conn.sftp((err, sftp) => {
            if (err) return reject(err);
            resolve(sftp);
        });
    });

    for (const relPath of filesToSync) {
        const localPath = path.resolve(__dirname, '..', relPath);
        if (!fs.existsSync(localPath)) continue;
        const remotePath = `/mnt/ssd500/projetos/BrasilFlix/${relPath.replace(/\\/g, '/')}`;
        const content = fs.readFileSync(localPath);

        await new Promise((resolve, reject) => {
            sftp.writeFile(remotePath, content, (err) => {
                if (err) return reject(err);
                console.log(`✅ Synced (SFTP): ${relPath}`);
                resolve();
            });
        });
    }

    // Restart pm2 process to reload new configuration & QoS code
    await new Promise((resolve, reject) => {
        conn.exec(`pm2 restart brasilflix`, (err, stream) => {
            if (err) return reject(err);
            let out = '';
            stream.on('data', d => { out += d.toString(); process.stdout.write(d.toString()); });
            stream.stderr.on('data', d => { out += d.toString(); process.stderr.write(d.toString()); });
            stream.on('close', () => {
                console.log('🔄 PM2 BrasilFlix restarted successfully!');
                resolve();
            });
        });
    });

    conn.end();
}

sync().then(() => process.exit(0)).catch(e => { console.error('❌ Sync failed:', e); process.exit(1); });

