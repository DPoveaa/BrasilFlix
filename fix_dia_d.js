const db = require('./src/database/db');

async function main() {
    try {
        console.log('Atualizando Dia D no banco para 1080p Full HD (is_cam = false)...');
        await db.query(`
            UPDATE filmes 
            SET is_cam = false,
                qualidade = '1080p Full HD',
                versoes = jsonb_set(
                    jsonb_set(COALESCE(versoes, '{}'::jsonb), '{dublado,isCam}', 'false'::jsonb),
                    '{dublado,qualidade}', '"1080p Full HD"'::jsonb
                )
            WHERE nome ILIKE '%Dia D%'
        `);
        console.log('✅ Dia D atualizado no banco como 1080p Full HD!');
    } catch (e) {
        console.error('Erro:', e);
    } finally {
        process.exit(0);
    }
}

main();
