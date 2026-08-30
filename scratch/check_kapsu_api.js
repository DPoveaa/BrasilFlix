const axios = require('axios');

async function testPublicDomain() {
    try {
        console.log('Fetching https://brasilflix.kapsu.com.br/api/catalogo ...');
        const res = await axios.get('https://brasilflix.kapsu.com.br/api/catalogo', { timeout: 10000 });
        const st = (res.data.series || []).find(s => s.id == 17);
        if (!st) {
            console.log('Stranger Things not found on brasilflix.kapsu.com.br!');
            return;
        }
        console.log('Stranger Things found on brasilflix.kapsu.com.br:');
        for (const t of st.temporadas) {
            console.log(`Temporada ${t.numero} - ${t.episodios?.length} eps:`, t.episodios?.map(e => `E${e.numero}: ${e.nome} (isDub: ${e.isDublado}, isLeg: ${e.isLegendado})`));
        }
    } catch (e) {
        console.error('Error fetching public domain:', e.message);
    }
}

testPublicDomain();
