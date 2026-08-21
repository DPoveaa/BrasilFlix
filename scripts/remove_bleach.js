/**
 * Script: remove_bleach.js
 * Remove todos os episódios de Bleach do catálogo PostgreSQL, da fila de jobs e das mensagens Telegram.
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

async function removeBleach() {
    console.log('\n🔴 [remove_bleach] Iniciando limpeza total de Bleach...\n');

    // 1. Localizar a série Bleach no banco
    const serieRes = await db.query(
        `SELECT id, nome FROM series WHERE nome ILIKE '%Bleach%' LIMIT 10`
    );

    if (serieRes.rowCount === 0) {
        console.log('ℹ️ Nenhuma série "Bleach" encontrada no catálogo.');
    } else {
        for (const serie of serieRes.rows) {
            console.log(`📺 Série encontrada: [${serie.id}] ${serie.nome}`);

            // 2. Coletar message_ids dos episódios para deletar do Telegram
            const epRes = await db.query(
                `SELECT message_id, file_id FROM episodios WHERE serie_id = $1 AND message_id IS NOT NULL`,
                [serie.id]
            );

            const msgIds = epRes.rows.map(r => r.message_id).filter(Boolean);
            console.log(`📝 ${msgIds.length} episódios com message_id encontrados para excluir do Telegram.`);

            // 3. Deletar mensagens do Telegram
            if (msgIds.length > 0) {
                let deleted = 0, failed = 0;
                for (const msgId of msgIds) {
                    const ok = await deleteTelegramMessage(msgId);
                    if (ok) deleted++; else failed++;
                    process.stdout.write(`\r🗑️ Deletando mensagens Telegram: ${deleted + failed}/${msgIds.length}...`);
                    await new Promise(r => setTimeout(r, 100));
                }
                console.log(`\n✅ Mensagens Telegram: ${deleted} deletadas, ${failed} já não existiam.`);
            }

            // 4. Deletar episódios do banco
            const delEpRes = await db.query(`DELETE FROM episodios WHERE serie_id = $1`, [serie.id]);
            console.log(`🗑️ ${delEpRes.rowCount} episódios removidos do banco.`);

            // 5. Deletar temporadas (se tabela existir)
            try {
                await db.query(`DELETE FROM temporadas WHERE serie_id = $1`, [serie.id]);
            } catch (e) {}

            // 6. Deletar a série
            const delSerieRes = await db.query(`DELETE FROM series WHERE id = $1`, [serie.id]);
            console.log(`🗑️ Série [${serie.id}] ${serie.nome} removida do catálogo.`);
        }
    }

    // 7. Remover jobs da fila (qualquer status)
    const queueRes = await db.query(
        `DELETE FROM queue_jobs WHERE title ILIKE '%Bleach%' OR (extra_data->>'title') ILIKE '%Bleach%'`
    );
    console.log(`\n🗑️ ${queueRes.rowCount} jobs de Bleach removidos da fila.`);

    // 8. Remover da swarm_watchlist
    const swarmRes = await db.query(`DELETE FROM swarm_watchlist WHERE title ILIKE '%Bleach%'`);
    if (swarmRes.rowCount > 0) {
        console.log(`🗑️ ${swarmRes.rowCount} entradas de Bleach removidas do Swarm Watcher.`);
    }

    console.log('\n✅ [remove_bleach] Limpeza de Bleach concluída com sucesso!\n');
}

db.initDb()
    .then(() => removeBleach())
    .then(() => process.exit(0))
    .catch(err => {
        console.error('❌ Erro:', err.message);
        process.exit(1);
    });
