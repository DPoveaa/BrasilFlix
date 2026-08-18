const db = require('./src/database/db');
const fs = require('fs-extra');
const path = require('path');

async function fixToyStory() {
    console.log('🔄 Atualizando Toy Story 5 no banco de dados e catálogo...');
    try {
        const res = await db.query(
            "UPDATE filmes SET qualidade = 'CAM (Cinema)', is_cam = true WHERE nome ILIKE '%Toy Story%' RETURNING *"
        );
        console.log('✅ PostgreSQL atualizado:', res.rows.map(r => ({ id: r.id, nome: r.nome, qualidade: r.qualidade, is_cam: r.is_cam })));

        const catPath = path.resolve('./data/catalogo.json');
        if (fs.existsSync(catPath)) {
            const cat = fs.readJsonSync(catPath);
            (cat.filmes || []).forEach(f => {
                if (f.nome && f.nome.toLowerCase().includes('toy story')) {
                    f.qualidade = 'CAM (Cinema)';
                    f.isCam = true;
                    if (f.versoes?.dublado) {
                        f.versoes.dublado.qualidade = 'CAM (Cinema)';
                        f.versoes.dublado.isCam = true;
                    }
                    if (f.versoes?.legendado) {
                        f.versoes.legendado.qualidade = 'CAM (Cinema)';
                        f.versoes.legendado.isCam = true;
                    }
                }
            });
            fs.writeJsonSync(catPath, cat, { spaces: 2 });
            console.log('✅ catalogo.json atualizado!');
        }
    } catch (e) {
        console.error('Erro:', e.message);
    }
}

fixToyStory().then(() => process.exit(0));
