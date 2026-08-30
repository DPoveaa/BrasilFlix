const axios = require('axios');

(async () => {
    try {
        const res = await axios.get(`https://brasilflix.kapsu.com.br/?t=${Date.now()}`);
        const html = res.data;
        console.log('Tamanho HTML:', html.length);
        console.log('Contém rail-section-playback-recs?', html.includes('id="rail-section-playback-recs"'));
        console.log('Contém track-playback-recs?', html.includes('id="track-playback-recs"'));
        console.log('Contém Assistir no Bot?', html.includes('Assistir no Bot'));
        console.log('Contém <div class="playback-details-grid">?', html.includes('<div class="playback-details-grid">'));
        console.log('Contém getNextEpisodeInfo?', html.includes('getNextEpisodeInfo'));
        console.log('Contém getPreviousEpisodeInfo?', html.includes('getPreviousEpisodeInfo'));
        console.log('Contém 1080p na lista de episódios?', html.includes('<span>✨ ${ep.qualidade || \'1080p\'}</span>'));
    } catch (e) {
        console.error('Erro na consulta:', e.message);
    }
})();
