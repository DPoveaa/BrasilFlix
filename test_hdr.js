const axios = require('axios');
const cheerio = require('cheerio');

async function testHDR() {
    try {
        console.log('🔍 Testando busca no HDRTorrent...');
        const searchUrl = 'https://hdrtorrent.com/?s=the+rookie';
        const res = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 10000
        });

        console.log('✅ Status busca:', res.status);
        const $ = cheerio.load(res.data);

        const posts = [];
        $('article, .item, .post, .capa, .filme-item, .entry-title a, h2 a, h3 a').each((i, el) => {
            const link = $(el).attr('href') || $(el).find('a').attr('href');
            const title = $(el).text().trim();
            if (link && link.includes('hdrtorrent.com') && !link.includes('category') && !link.includes('tag') && link !== 'https://hdrtorrent.com/') {
                posts.push({ title, link });
            }
        });

        console.log('📦 Posts encontrados na busca:', posts.slice(0, 10));

        // Testar página do post específico
        const pageUrl = 'https://hdrtorrent.com/the-rookie-1-temporada-torrent-download/';
        console.log('\n📄 Acessando página do post:', pageUrl);
        const pageRes = await axios.get(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        const $p = cheerio.load(pageRes.data);
        const magnets = [];
        $p('a[href^="magnet:"]').each((i, el) => {
            const magnet = $p(el).attr('href');
            const text = $p(el).text().trim() || $p(el).parent().text().trim();
            magnets.push({ text, magnet });
        });

        console.log(`🧲 Encontrados ${magnets.length} magnet links na página:`);
        magnets.slice(0, 10).forEach((m, idx) => {
            console.log(`[${idx + 1}] Texto: "${m.text.slice(0, 60)}"`);
            console.log(`    Magnet: ${m.magnet.slice(0, 100)}...`);
        });

    } catch (e) {
        console.error('❌ Erro no teste HDRTorrent:', e.message);
    }
}

testHDR();
