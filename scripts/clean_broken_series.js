const fs = require('fs-extra');
const path = require('path');

const catalogoPath = path.join(__dirname, '../data/catalogo.json');
if (fs.existsSync(catalogoPath)) {
    const catalogo = fs.readJsonSync(catalogoPath);
    catalogo.series = (catalogo.series || []).filter(s => s.nome !== 'A Casa do Dragão');
    fs.writeJsonSync(catalogoPath, catalogo, { spaces: 2 });
    console.log('✅ Série A Casa do Dragão (com vídeo antigo de 30s) removida com sucesso!');
} else {
    console.log('⚠️ Arquivo catalogo.json não encontrado.');
}
