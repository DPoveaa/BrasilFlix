const db = require('./src/database/db');

async function main() {
    try {
        console.log('Atualizando Toy Story 5 no banco para CAM (Cinema)...');
        await db.query(`
            UPDATE filmes 
            SET is_cam = true,
                qualidade = 'CAM (Cinema)',
                versoes = jsonb_set(
                    jsonb_set(COALESCE(versoes, '{}'::jsonb), '{dublado,isCam}', 'true'::jsonb),
                    '{dublado,qualidade}', '"CAM (Cinema)"'::jsonb
                )
            WHERE id = '11' OR nome ILIKE '%Toy Story 5%'
        `);
        console.log('✅ Toy Story 5 atualizado no banco como CAM (Cinema)!');
    } catch (e) {
        console.error('Erro:', e);
    } finally {
        process.exit(0);
    }
}

main();
