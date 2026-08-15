const fs = require('fs');
const p = './data/catalogo.json';
if (fs.existsSync(p)) {
    const c = JSON.parse(fs.readFileSync(p, 'utf8'));
    c.series = (c.series || []).filter(s => s.nome.toLowerCase() !== 'reacher');
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
    console.log('✅ Server catalogo.json cleaned! Total series:', c.series.length);
}
