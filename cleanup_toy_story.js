const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./src/database/db');

async function main() {
    console.log('🧹 Limpando mensagem duplicada de Toy Story 5 (Message ID: 294097)...');
    
    // 1. Deletar do Telegram Storage Channel via Bot API / MTProto
    try {
        const bot = new TelegramBot(config.BOT_TOKEN);
        if (config.STORAGE_GROUP_ID) {
            await bot.deleteMessage(config.STORAGE_GROUP_ID, 294097).catch(e => console.warn('Aviso deleteMessage storage:', e.message));
        }
        if (config.NOTIFICATION_GROUP_ID) {
            // Tenta deletar mensagens recentes do grupo de notificacao se houver
            await bot.deleteMessage(config.NOTIFICATION_GROUP_ID, 294097).catch(() => null);
        }
    } catch (e) {
        console.warn('Aviso ao deletar mensagem do Telegram:', e.message);
    }

    // 2. Atualizar banco de dados para manter apenas a versão CAM legítima (291244)
    try {
        await db.query(`
            UPDATE filmes 
            SET is_cam = true,
                qualidade = 'CAM (Cinema)',
                message_id = '291244',
                versoes = jsonb_build_object(
                    'dublado', jsonb_build_object(
                        'isCam', true,
                        'fileId', '4911664783696070452',
                        'messageId', 291244,
                        'qualidade', 'CAM (Cinema)'
                    )
                )
            WHERE nome ILIKE '%Toy Story 5%'
        `);
        console.log('✅ Banco de dados atualizado: Toy Story 5 mantido com apenas 1 versão (CAM, Message ID: 291244)!');
    } catch (e) {
        console.error('Erro no banco:', e);
    }

    process.exit(0);
}

main();
