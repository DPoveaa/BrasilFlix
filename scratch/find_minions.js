const db = require('../src/database/db');
const fs = require('fs-extra');
const config = require('../config');

(async () => {
    try {
        const allFilmes = await db.query(`SELECT id, nome, nome_original, ano, qualidade, is_cam, message_id, file_id, versoes FROM filmes ORDER BY id DESC`);
        console.log(`Total filmes no banco: ${allFilmes.rows.length}`);
        for (const f of allFilmes.rows) {
            console.log(`[Filme ${f.id}] "${f.nome}" (${f.ano}) - Qualidade: ${f.qualidade}, CAM: ${f.is_cam}, MsgId: ${f.message_id}`);
        }

        const allSeries = await db.query(`SELECT id, nome, total_episodios FROM series ORDER BY id DESC`);
        console.log(`\nTotal séries no banco: ${allSeries.rows.length}`);
        for (const s of allSeries.rows) {
            console.log(`[Série ${s.id}] "${s.nome}"`);
        }

        if (fs.existsSync(config.CATALOGO_FILE)) {
            const cat = fs.readJsonSync(config.CATALOGO_FILE);
            console.log(`\nFilmes em catalogo.json: ${cat.filmes?.length || 0}`);
            for (const f of cat.filmes || []) {
                if (f.nome.toLowerCase().includes('minion') || f.nome.toLowerCase().includes('gru') || f.nome.toLowerCase().includes('malvado')) {
                    console.log('Encontrado no JSON:', f);
                }
            }
        }
    } catch (e) {
        console.error('Erro:', e.message);
    } finally {
        process.exit(0);
    }
})();
