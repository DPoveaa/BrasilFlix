const axios = require('axios');

(async () => {
    try {
        console.log('Fetching https://brasilflix.kapsu.com.br/api/catalogo ...');
        const res = await axios.get('https://brasilflix.kapsu.com.br/api/catalogo', { timeout: 10000 });
        const filmes = res.data.filmes || [];
        const series = res.data.series || [];
        console.log(`Total Filmes na API: ${filmes.length}, Séries: ${series.length}`);
        
        const minionsFilmes = filmes.filter(f => 
            f.nome.toLowerCase().includes('minion') || 
            f.nome.toLowerCase().includes('malvado') ||
            f.nome.toLowerCase().includes('gru')
        );
        console.log('Minions filmes na API remota:', JSON.stringify(minionsFilmes, null, 2));

        const minionsSeries = series.filter(s => 
            s.nome.toLowerCase().includes('minion') || 
            s.nome.toLowerCase().includes('malvado') ||
            s.nome.toLowerCase().includes('gru')
        );
        console.log('Minions séries na API remota:', JSON.stringify(minionsSeries, null, 2));
    } catch (e) {
        console.error('Erro:', e.message);
    }
})();
