const axios = require('axios');

async function testTorrentio() {
    const imdbId = 'tt7587890'; // The Rookie
    const season = 1;
    const episode = 1;

    // Testar diferentes configurações do Torrentio
    const urls = [
        `https://torrentio.strem.fun/stream/series/${imdbId}:${season}:${episode}.json`,
        `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex,rutor,rutracker,comandotorrents,bludv/stream/series/${imdbId}:${season}:${episode}.json`,
        `https://torrentio.strem.fun/sort=qualitysize|qualityfilter=4k,scr,cam/stream/series/${imdbId}:${season}:${episode}.json`
    ];

    for (const url of urls) {
        console.log(`\n🔍 Testando URL: ${url}`);
        try {
            const res = await axios.get(url, { timeout: 8000 });
            const streams = res.data?.streams || [];
            console.log(`   Streams retornados: ${streams.length}`);
            const brStreams = streams.filter(s => {
                const text = (s.title || '') + ' ' + (s.name || '');
                return /comando|bludv|dublado|dual|brazilian|pt-br|portugues/i.test(text);
            });
            console.log(`   🇧🇷 Streams em Português / BR: ${brStreams.length}`);
            brStreams.slice(0, 5).forEach(s => {
                console.log(`     - [${s.name}] ${s.title.replace(/\n/g, ' | ').slice(0, 100)}`);
            });
        } catch (e) {
            console.error('   ❌ Erro:', e.message);
        }
    }
}

testTorrentio();
