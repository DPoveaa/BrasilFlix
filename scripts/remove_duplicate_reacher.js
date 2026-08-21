const telegramUploader = require('../src/services/TelegramUploader');
const db = require('../src/database/db');

async function removeDuplicateReacher() {
    console.log('🗑️ Excluindo mensagem duplicada de Reacher T2E2 (Message ID: 298400)...');
    
    // Apaga a mensagem 298400 e 298401 do canal de armazenamento do Telegram
    await telegramUploader.deleteStorageMessages([298400]);
    console.log('✅ Mensagem 298400 excluída do Telegram!');

    // Verifica o estado atual de Reacher no PostgreSQL
    const res = await db.query(`
        SELECT e.id, s.nome, e.temporada_numero, e.numero, e.message_id, e.versoes 
        FROM episodios e 
        JOIN series s ON s.id = e.serie_id 
        WHERE LOWER(s.nome) LIKE '%reacher%' AND e.temporada_numero = 2 AND e.numero = 2
    `);

    console.log('📋 Estado do episódio no PostgreSQL:', res.rows);
    process.exit(0);
}

removeDuplicateReacher().catch(err => {
    console.error('❌ Erro ao remover duplicata:', err);
    process.exit(1);
});
