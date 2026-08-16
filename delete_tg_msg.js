const { Client } = require('ssh2');
const conn = new Client();
conn.on('ready', () => {
    conn.exec(`cd /mnt/ssd500/projetos/BrasilFlix && node << 'NODEOF'
// Delete the Telegram message with message_id 286168
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('./config');

(async () => {
    const client = new TelegramClient(
        new StringSession(config.TELEGRAM_SESSION || ''),
        parseInt(config.TELEGRAM_API_ID),
        config.TELEGRAM_API_HASH,
        { connectionRetries: 3 }
    );
    await client.connect();
    
    const channelId = config.TELEGRAM_CHANNEL_ID || config.CHANNEL_ID;
    console.log('Tentando deletar message_id 286168 do canal:', channelId);
    
    try {
        await client.deleteMessages(channelId, [286168], { revoke: true });
        console.log('✅ Mensagem 286168 deletada do Telegram!');
    } catch (e) {
        console.warn('⚠️ Erro ao deletar:', e.message);
    }
    
    await client.disconnect();
    process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
NODEOF`, (err, stream) => {
        if (err) throw err;
        stream.on('data', d => process.stdout.write(d.toString()));
        stream.stderr.on('data', d => process.stderr.write(d.toString()));
        stream.on('close', () => conn.end());
    });
}).connect({ host: '192.168.15.50', port: 22, username: 'povea', password: 'Daniel123.' });
