const db = require('./src/database/db');
const fs = require('fs-extra');
const path = require('path');

async function clearQueue() {
    console.log('🧹 Limpando toda a fila do BrasilFlix...');
    try {
        // 1. Limpar tabelas no PostgreSQL
        await db.query('DELETE FROM queue_jobs');
        await db.query('DELETE FROM episodios');
        await db.query('DELETE FROM series');
        await db.query('DELETE FROM filmes');
        console.log('✅ Banco de dados PostgreSQL (queue_jobs, episodios, series, filmes) limpo com sucesso!');

        // 2. Limpar arquivos locais JSON
        const queueFile = path.resolve('./data/queue.json');
        if (fs.existsSync(queueFile)) {
            await fs.writeJson(queueFile, []);
        }
        const catalogoFile = path.resolve('./data/catalogo.json');
        if (fs.existsSync(catalogoFile)) {
            await fs.writeJson(catalogoFile, { filmes: [], series: [] }, { spaces: 2 });
        }
        console.log('✅ Arquivos locais data/queue.json e data/catalogo.json resetados!');

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
