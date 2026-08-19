const db = require('./src/database/db');

async function main() {
    try {
        console.log('Restaurando Toy Story 5 para Message ID 291244...');
        await db.query(`
            UPDATE filmes 
            SET message_id = '291244',
                versoes = jsonb_set(COALESCE(versoes, '{}'::jsonb), '{dublado,messageId}', '291244'::jsonb)
            WHERE id = '11' OR nome ILIKE '%Toy Story 5%'
        `);
        console.log('✅ Toy Story 5 restaurado com sucesso para a mensagem original (291244)!');
    } catch (e) {
        console.error('Erro:', e);
    } finally {
        process.exit(0);
    }
}

main();
