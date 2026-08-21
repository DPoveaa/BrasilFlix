/**
 * Script: clean_silo_t1e9.js
 * Remove o episódio 9 de Silo (T1E9 - message_id 299259) do Telegram e do banco PostgreSQL,
 * e re-enfileira para download com fonte legítima.
 */

const axios = require('axios');
const db = require('../src/database/db');
const config = require('../config');

async function deleteTelegramMessage(messageId) {
    if (!config.TELEGRAM_BOT_TOKEN || !messageId) return false;
    const targets = [config.STORAGE_GROUP_ID, config.TELEGRAM_CHANNEL_ID].filter(Boolean);
    for (const chatId of targets) {
        try {
            await axios.post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
                chat_id: chatId,
                message_id: messageId
            }, { timeout: 5000 });
            return true;
        } catch (e) {}
    }
    return false;
}

async function cleanSilo() {
    console.log('\n🔴 [clean_silo] Removendo Silo T1E9 corrompido...\n');

    // 1. Deleta a mensagem conhecida do Telegram
    await deleteTelegramMessage(299259);
    console.log('🗑️ Mensagem 299259 deletada do Telegram.');

    // 2. Localiza a série Silo no PostgreSQL
    const sRes = await db.query(`SELECT id, nome, tmdb_id, imdb_id FROM series WHERE nome ILIKE '%Silo%' LIMIT 1`);
    if (sRes.rowCount > 0) {
        const serie = sRes.rows[0];
        console.log(`📺 Série localizada: [${serie.id}] ${serie.nome}`);

        // Pega message_ids existentes do ep 9
        const epRes = await db.query(
            `SELECT message_id, versoes FROM episodios WHERE serie_id = $1 AND temporada_numero = 1 AND numero = 9`,
            [serie.id]
        );

        for (const row of epRes.rows) {
            if (row.message_id) await deleteTelegramMessage(row.message_id);
            if (row.versoes?.dublado?.messageId) await deleteTelegramMessage(row.versoes.dublado.messageId);
            if (row.versoes?.legendado?.messageId) await deleteTelegramMessage(row.versoes.legendado.messageId);
        }

        // Deleta o episódio do banco
        await db.query(`DELETE FROM episodios WHERE serie_id = $1 AND temporada_numero = 1 AND numero = 9`, [serie.id]);
        console.log('✅ Registro corrompido de Silo T1E9 removido do PostgreSQL.');

        // Re-enfileira na fila do PostgreSQL para baixar fonte legítima
        await db.query(`
            INSERT INTO queue (title, type, priority, status, tmdb_id, season, episode, audio_preference, created_at, updated_at)
            VALUES ($1, 'serie', 1, 'queued', $2, 1, 9, 'dublado', NOW(), NOW())
        `, [serie.nome, serie.tmdb_id]);
        console.log('📥 Silo T1E9 re-enfileirado com Prioridade 1 para download de fonte legítima!');
    }

    console.log('\n✨ Limpeza concluída!\n');
    process.exit(0);
}

cleanSilo().catch(err => {
    console.error('❌ Erro:', err.message);
    process.exit(1);
});
