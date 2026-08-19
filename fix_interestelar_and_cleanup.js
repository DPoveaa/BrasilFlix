const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const db = require('./src/database/db');

async function main() {
    const bot = new TelegramBot(config.BOT_TOKEN);
    console.log('1. Apagando mensagens residuais do Toy Story duplicado (294095-294105)...');
    for (let id = 294095; id <= 294105; id++) {
        try {
            await bot.deleteMessage(config.STORAGE_GROUP_ID, id);
            console.log(`✅ Deletada mensagem ${id} do armazém`);
        } catch (e) {}
    }

    console.log('2. Atualizando Interestelar no banco para 1080p Full HD...');
    await db.query(`
        UPDATE filmes 
        SET is_cam = false, 
            qualidade = '1080p Full HD', 
            versoes = jsonb_set(COALESCE(versoes, '{}'::jsonb), '{dublado,isCam}', 'false'::jsonb) 
        WHERE nome ILIKE '%Interestelar%'
    `);

    console.log('3. Atualizando filmes antigos de catálogo para 1080p Full HD...');
    await db.query(`
        UPDATE filmes 
        SET is_cam = false, 
            qualidade = '1080p Full HD', 
            versoes = jsonb_set(COALESCE(versoes, '{}'::jsonb), '{dublado,isCam}', 'false'::jsonb) 
        WHERE ano ~ '^[0-9]+$' AND ano::int < 2025
    `);

    console.log('4. Lista atual de filmes no banco:');
    const r = await db.query('SELECT id, nome, ano, qualidade, is_cam, message_id FROM filmes ORDER BY id ASC');
    console.log(JSON.stringify(r.rows, null, 2));

    process.exit(0);
}

main();
