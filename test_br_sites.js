const axios = require('axios');
const cheerio = require('cheerio');

async function testBrSites() {
    const sites = [
        { name: 'ComandoTorrents', url: 'https://comando.la/?s=the+rookie' },
        { name: 'BluDV', url: 'https://bludv.tv/?s=the+rookie' },
        { name: 'Lapumia', url: 'https://lapumia.org/?s=the+rookie' },
        { name: 'StarckFilmes', url: 'https://starckfilmes.top/?s=the+rookie' },
        { name: 'Guanabara', url: 'https://guanabaratorrent.com/?s=the+rookie' },
        { name: 'Overdrive', url: 'https://overdrivetorrent.com/?s=the+rookie' },
        { name: 'BaixeDeTudo', url: 'https://baixedetudo.net/?s=the+rookie' }
    ];

    for (const site of sites) {
        try {
            console.log(`\n🔍 Testando ${site.name} (${site.url})...`);
            const res = await axios.get(site.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeout: 6000
            });
            console.log(`   ✅ Status ${res.status} | Bytes: ${res.data.length}`);
            const $ = cheerio.load(res.data);
            const titles = [];
            $('h2, h3, .entry-title, .title').slice(0, 5).each((i, el) => {
                titles.push($(el).text().trim().replace(/\s+/g, ' '));
            });
            console.log(`   📄 Títulos encontrados:`, titles.filter(Boolean));
        } catch (e) {
            console.log(`   ❌ Erro: ${e.message}`);
        }
    }
}

testBrSites();
