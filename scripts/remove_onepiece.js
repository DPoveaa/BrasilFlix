const db = require('../src/database/db');
const telegramUploader = require('../src/services/TelegramUploader');

async function removeOnePiece() {
    console.log('🔍 Buscando todas as referências de One Piece no banco de dados e catálogo...');
    
    // 1. Busca séries
    const seriesRes = await db.query(`
        SELECT id, nome, tmdb_id, imdb_id FROM series 
        WHERE LOWER(nome) LIKE '%one piece%' OR LOWER(nome_original) LIKE '%one piece%' OR tmdb_id = 37854
    `);
    
    // 2. Busca filmes
    const filmesRes = await db.query(`
        SELECT id, nome, message_id, versoes FROM filmes 
        WHERE LOWER(nome) LIKE '%one piece%' OR LOWER(nome_original) LIKE '%one piece%'
    `);

    const serieIds = seriesRes.rows.map(s => s.id);
    console.log(`📋 Encontradas ${seriesRes.rows.length} série(s)/anime(s) e ${filmesRes.rows.length} filme(s) de One Piece:`, seriesRes.rows.map(s => `${s.nome} (ID: ${s.id})`));

    const messageIds = [];

    // Coleta message_ids de filmes
    for (const f of filmesRes.rows) {
        if (f.message_id) messageIds.push(Number(f.message_id));
        let versoes = f.versoes;
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (e) {}
        }
        if (versoes?.dublado?.messageId) messageIds.push(Number(versoes.dublado.messageId));
        if (versoes?.legendado?.messageId) messageIds.push(Number(versoes.legendado.messageId));
    }

    // Coleta message_ids de episódios
    if (serieIds.length > 0) {
        const epsRes = await db.query(`
            SELECT id, serie_id, temporada_numero, numero, message_id, versoes 
            FROM episodios 
            WHERE serie_id = ANY($1::int[])
        `, [serieIds]);

        console.log(`📦 Encontrados ${epsRes.rows.length} episódio(s) de One Piece cadastrados.`);

        for (const ep of epsRes.rows) {
            if (ep.message_id) messageIds.push(Number(ep.message_id));
            let versoes = ep.versoes;
            if (typeof versoes === 'string') {
                try { versoes = JSON.parse(versoes); } catch (e) {}
            }
            if (versoes?.dublado?.messageId) messageIds.push(Number(versoes.dublado.messageId));
            if (versoes?.legendado?.messageId) messageIds.push(Number(versoes.legendado.messageId));
        }
    }

    const uniqueMsgIds = [...new Set(messageIds.filter(id => id && !isNaN(id) && id > 0))];
    console.log(`🗑️ Total de ${uniqueMsgIds.length} mensagem(ns) do Telegram para apagar do grupo de armazenamento:`, uniqueMsgIds);

    // 3. Exclui mensagens no Telegram
    if (uniqueMsgIds.length > 0) {
        console.log('🚀 Apagando mensagens no Telegram...');
        await telegramUploader.deleteStorageMessages(uniqueMsgIds);
        console.log('✅ Mensagens do Telegram apagadas com sucesso.');
    }

    // 4. Remove do banco de dados
    if (serieIds.length > 0) {
        await db.query(`DELETE FROM episodios WHERE serie_id = ANY($1::int[])`, [serieIds]);
        await db.query(`DELETE FROM series WHERE id = ANY($1::int[])`, [serieIds]);
        console.log('✅ Episódios e Séries de One Piece excluídos do PostgreSQL.');
    }

    if (filmesRes.rows.length > 0) {
        const filmeIds = filmesRes.rows.map(f => f.id);
        await db.query(`DELETE FROM filmes WHERE id = ANY($1::int[])`, [filmeIds]);
        console.log('✅ Filmes de One Piece excluídos do PostgreSQL.');
    }

    // 5. Remove da fila de downloads caso haja jobs pendentes
    await db.query(`
        DELETE FROM queue_jobs 
        WHERE LOWER(title) LIKE '%one piece%' OR tmdb_id = 37854
    `);
    console.log('✅ Fila de downloads limpa de qualquer job de One Piece.');

    // 6. Remove da watchlist de sementes caso exista
    await db.query(`
        DELETE FROM swarm_watchlist 
        WHERE LOWER(title) LIKE '%one piece%' OR tmdb_id = 37854
    `);
    console.log('✅ Watchlist limpa.');

    console.log('🎉 Remoção completa de One Piece concluída!');
    process.exit(0);
}

removeOnePiece().catch(err => {
    console.error('❌ Erro durante a remoção de One Piece:', err);
    process.exit(1);
});
