const axios = require('axios');

(async () => {
    try {
        const res = await axios.get(`https://brasilflix.kapsu.com.br/?t=${Date.now()}`);
        const html = res.data;
        console.log('Contém PADRONIZAÇÃO DE DROPDOWNS E SELECTS NO TEMA ESCURO?', html.includes('PADRONIZAÇÃO DE DROPDOWNS E SELECTS NO TEMA ESCURO'));
        console.log('Contém #0d1322 no rating select?', html.includes('id="playback-review-rating-select" style="background: #0d1322'));
    } catch (e) {
        console.error('Erro na verificação:', e.message);
    }
})();
