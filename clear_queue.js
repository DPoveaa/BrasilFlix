const db = require('./src/database/db');
const fs = require('fs-extra');
const path = require('path');

async function clearQueue() {
    console.log('🧹 Limpando toda a fila do BrasilFlix...');
    try {
        // 1. Limpar apenas tabela queue_jobs no PostgreSQL
        await db.query('DELETE FROM queue_jobs');
        console.log('✅ Fila de downloads (queue_jobs) limpa no PostgreSQL!');

        // 2. Limpar arquivo local queue.json
        const queueFile = path.resolve('./data/queue.json');
        if (fs.existsSync(queueFile)) {
            await fs.writeJson(queueFile, []);
        }
        console.log('✅ Arquivo local data/queue.json resetado!');

        // 3. Limpar pasta temporária de downloads
        const tempDir = path.resolve('./downloads/temp');
        if (fs.existsSync(tempDir)) {
            await fs.emptyDir(tempDir);
            console.log('✅ Diretório downloads/temp esvaziado!');
        }

        console.log('\n🚀 Fila 100% resetada! Agora você pode reiniciar o bot com: pm2 restart brasilflix');
    } catch (e) {
        console.error('❌ Erro ao limpar fila:', e.message);
    } finally {
        process.exit(0);
    }
}

clearQueue();
