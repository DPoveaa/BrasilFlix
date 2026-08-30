const TMDBService = require('../src/services/TMDBService');

async function checkStrangerThings() {
    console.log('Querying TMDB for Stranger Things (ID: 66732)...');
    const details = await TMDBService.getTVDetails(66732);
    console.log('TV Details:', {
        name: details.nome,
        totalTemporadas: details.totalTemporadas,
        totalEpisodios: details.totalEpisodios,
        temporadas: details.temporadas
    });

    if (details.temporadas) {
        for (const s of details.temporadas) {
            console.log(`\nSeason ${s.numero} (${s.nome}) - Total Episodes: ${s.episodiosContagem}`);
            const sData = await TMDBService.getSeasonDetails(66732, s.numero);
            console.log('Episodes in TMDB:', sData?.episodios?.map(e => `E${e.numero}: ${e.nome} (${e.dataLancamento})`));
        }
    }
}

checkStrangerThings().catch(console.error);
