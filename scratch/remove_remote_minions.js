const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    console.log('SSH connected. Removing Minions & Monstros (ID 15) from remote server...');
    const script = `node -e "
        const db = require('./src/database/db');
        const CatalogoManager = require('./src/managers/CatalogoManager');
        const TelegramUploader = require('./src/services/TelegramUploader');
        const config = require('./config');

        (async () => {
            try {
                console.log('1. Consultando filme ID 15 no PostgreSQL...');
                const res = await db.query('SELECT * FROM filmes WHERE id = 15');
                console.log('Filme encontrado:', res.rows);

                const msgIdsToDelete = [];
                for (const f of res.rows) {
                    if (f.message_id) msgIdsToDelete.push(Number(f.message_id));
                    let v = f.versoes;
                    if (typeof v === 'string') try { v = JSON.parse(v); } catch (e) {}
                    if (v?.dublado?.messageId) msgIdsToDelete.push(Number(v.dublado.messageId));
                    if (v?.legendado?.messageId) msgIdsToDelete.push(Number(v.legendado.messageId));
                }

                console.log('MessageIds a deletar do Telegram Storage:', msgIdsToDelete);

                if (msgIdsToDelete.length > 0) {
                    try {
                        const uploader = TelegramUploader.getInstance();
                        await uploader.deleteStorageMessages(msgIdsToDelete);
                        console.log('✅ Mensagens deletadas do grupo de armazenamento do Telegram!');
                    } catch (errTg) {
                        console.warn('⚠️ Erro ao deletar mensagens do Telegram:', errTg.message);
                    }
                }

                console.log('2. Removendo do PostgreSQL...');
                await db.query('DELETE FROM filmes WHERE id = 15');
                await db.query('DELETE FROM lancamentos_notificados WHERE media_id = \\'15\\'');
                console.log('✅ Removido do PostgreSQL e lancamentos_notificados!');

                console.log('3. Recarregando catálogo e salvando backup...');
                const catMgr = new CatalogoManager();
                await catMgr.loadCatalogo();
                console.log('✅ Catálogo recarregado com sucesso! Total filmes restantes:', catMgr.catalogo?.filmes?.length);

            } catch (e) {
                console.error('❌ Erro na remoção:', e);
            }
            process.exit(0);
        })();
    "`;

    conn.exec(`cd /home/povea/BrasilFlix && ${script}`, (err, stream) => {
        if (err) throw err;
        stream.on('close', () => {
            console.log('Script execution finished. Restarting PM2 brasilflix...');
            const conn2 = new Client();
            conn2.on('ready', () => {
                conn2.exec('pm2 reload brasilflix', (err2, stream2) => {
                    if (err2) throw err2;
                    stream2.on('close', () => {
                        console.log('✅ PM2 brasilflix recarregado!');
                        conn2.end();
                        conn.end();
                    });
                    stream2.on('data', (d) => process.stdout.write(d));
                });
            }).connect({
                host: '192.168.68.56',
                port: 22,
                username: 'povea',
                password: 'Daniel123.'
            });
        });
        stream.on('data', (d) => process.stdout.write(d));
        stream.stderr.on('data', (d) => process.stderr.write(d));
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
