const db = require('./src/database/db');

async function main() {
    try {
        console.log('Removendo T1E4 sem legenda de O Novato...');
        await db.query(`
            DELETE FROM serie_episodios 
            WHERE (serie_id = '16' OR serie_id IN (SELECT id FROM series WHERE nome ILIKE '%Novato%'))
              AND numero = 4
        `);
        console.log('✅ Episódio 4 removido do banco. Pronto para reprocessamento com legendas perfeitas!');
    } catch (e) {
        console.error('Erro:', e);
    } finally {
        process.exit(0);
    }
}

main();
