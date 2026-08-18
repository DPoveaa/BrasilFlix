const db = require('./src/database/db');
const config = require('./config');
const TelegramUploader = require('./src/services/TelegramUploader');

async function run() {
    console.log('🔄 Atualizando registro de O Novato (The Rookie) no PostgreSQL...');
    
    // 1. Atualizar Episódio 1 com as duas versões reais (Dublado 291559 e Legendado 291876)
    const versoesEp1 = {
        dublado: {
            messageId: 291559,
            fileId: '4907161184068700491',
            qualidade: '1080p Full HD'
        },
        legendado: {
            messageId: 291876,
            fileId: '4909412983882385497',
            qualidade: '1080p Full HD'
        }
    };

    await db.query(`
        UPDATE episodios 
        SET is_dublado = true, 
            is_legendado = true, 
            audio = 'Dual Áudio (Dublado + Legendado)',
            versoes = $1
        WHERE serie_id = 16 AND temporada_numero = 1 AND numero = 1
    `, [JSON.stringify(versoesEp1)]);

    // 2. Atualizar série para is_dublado = true
    await db.query(`
        UPDATE series 
        SET is_dublado = true, 
            is_legendado = true,
            updated_at = NOW()
        WHERE id = 16
    `);

    console.log('✅ PostgreSQL atualizado com sucesso para O Novato T1E1 (Dublado + Legendado)!');

    // 3. Excluir mensagem 291815 (vídeo duplicado legendado no Telegram)
    try {
        const uploader = TelegramUploader.getInstance();
        const client = await uploader.getClient();
        await client.deleteMessages(config.STORAGE_GROUP_ID, [291815], { revoke: true });
        console.log('🗑️ Mensagem de vídeo duplicada (ID 291815) excluída do Telegram Storage!');
    } catch(err) {
        console.warn('⚠️ Erro ao excluir 291815:', err.message);
    }

    await db.getPool().end();
    process.exit(0);
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});
