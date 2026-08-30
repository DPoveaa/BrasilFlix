const axios = require('axios');

(async () => {
    try {
        console.log('Consultando https://brasilflix.kapsu.com.br ...');
        const res = await axios.get('https://brasilflix.kapsu.com.br/');
        const html = res.data;
        console.log('Tamanho HTML:', html.length);
        console.log('Contém #tab-playback-page?', html.includes('id="tab-playback-page"'));
        console.log('Contém #web-player-modal?', html.includes('id="web-player-modal"'));
        console.log('Contém openPlaybackPageForEpisode?', html.includes('openPlaybackPageForEpisode'));
        console.log('Contém openPlaybackPageForMovie?', html.includes('openPlaybackPageForMovie'));
    } catch (e) {
        console.error('Erro na consulta:', e.message);
    }
})();
