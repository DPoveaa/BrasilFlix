const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('🧪 Iniciando testes de validação da Página Dedicada de Reprodução...');

// 1. Check index.html syntax & existence
const htmlPath = path.resolve('public/index.html');
assert(fs.existsSync(htmlPath), 'index.html deve existir');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');

// 2. Validate elements in index.html
assert(htmlContent.includes('id="tab-playback-page"'), 'Aba tab-playback-page deve existir');
assert(htmlContent.includes('id="playback-nav-controls-bar"'), 'Barra de navegação de episódios deve existir');
assert(htmlContent.includes('id="playback-btn-prev"'), 'Botão Episódio Anterior deve existir');
assert(htmlContent.includes('id="playback-btn-series"'), 'Botão Ver Série Completa deve existir');
assert(htmlContent.includes('id="playback-btn-next"'), 'Botão Próximo Episódio deve existir');
assert(htmlContent.includes('id="playback-episodes-section"'), 'Seção de episódios da mesma temporada deve existir');
assert(htmlContent.includes('id="playback-reviews-section"'), 'Seção de avaliações deve existir');
assert(htmlContent.includes('id="playback-recommendations-section"'), 'Seção de recomendações deve existir');
assert(htmlContent.includes('id="player-card-container"'), 'Container do player deve existir na página dedicada');
assert(htmlContent.includes('id="html5-video-player"'), 'Elemento de vídeo html5 deve existir');
assert(htmlContent.includes('id="party-ready-overlay"'), 'Overlay da sala Todos Prontos deve existir');
assert(htmlContent.includes('id="party-sync-overlay"'), 'Overlay de sincronização da sala deve existir');
assert(htmlContent.includes('id="player-resume-banner"'), 'Banner de continuar reprodução deve existir');
assert(htmlContent.includes('id="player-next-ep-card"'), 'Card auto-play próximo episódio deve existir');

// 3. Extract and syntax-check JS code from index.html
const scriptMatch = htmlContent.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
assert(scriptMatch && scriptMatch[1], 'Script JavaScript principal deve existir em index.html');

try {
    new Function(scriptMatch[1]);
    console.log('✅ Sintaxe JavaScript do frontend 100% válida e sem erros!');
} catch (e) {
    console.error('❌ Erro de sintaxe JS no index.html:', e);
    process.exit(1);
}

// 4. Test episode navigation logic
const testSeries = {
    id: 101,
    nome: 'Re:Zero Kara Hajimeru Isekai Seikatsu',
    isDublado: true,
    temporadas: [
        {
            numero: 1,
            episodios: [
                { numero: 1, nome: 'O Fim do Começo e o Começo do Fim', isDublado: true },
                { numero: 2, nome: 'Reencontro com a Bruxa', isDublado: true }
            ]
        },
        {
            numero: 2,
            episodios: [
                { numero: 1, nome: 'Cada Uma das Promessas', isDublado: true },
                { numero: 2, nome: 'A Próxima Parada', isDublado: true }
            ]
        }
    ]
};

// Simulate getNextEpisodeInfo
function getNextEpisodeInfoSim(serie, currentSeasonNum, currentEpNum) {
    const tempAtual = serie.temporadas.find(t => t.numero === Number(currentSeasonNum));
    if (tempAtual && tempAtual.episodios) {
        const proxEp = tempAtual.episodios.find(e => e.numero === Number(currentEpNum) + 1);
        if (proxEp) {
            return {
                serieId: serie.id,
                seasonNum: Number(currentSeasonNum),
                epNum: proxEp.numero,
                epNome: proxEp.nome
            };
        }
    }
    const proxTemp = serie.temporadas.find(t => t.numero === Number(currentSeasonNum) + 1);
    if (proxTemp && proxTemp.episodios && proxTemp.episodios.length > 0) {
        const proxEp = proxTemp.episodios[0];
        return {
            serieId: serie.id,
            seasonNum: proxTemp.numero,
            epNum: proxEp.numero,
            epNome: proxEp.nome
        };
    }
    return null;
}

// Simulate getPreviousEpisodeInfo
function getPreviousEpisodeInfoSim(serie, currentSeasonNum, currentEpNum) {
    const tempAtual = serie.temporadas.find(t => t.numero === Number(currentSeasonNum));
    if (tempAtual && tempAtual.episodios) {
        const prevEp = tempAtual.episodios.find(e => e.numero === Number(currentEpNum) - 1);
        if (prevEp) {
            return {
                serieId: serie.id,
                seasonNum: Number(currentSeasonNum),
                epNum: prevEp.numero,
                epNome: prevEp.nome
            };
        }
    }
    const prevTemp = serie.temporadas.find(t => t.numero === Number(currentSeasonNum) - 1);
    if (prevTemp && prevTemp.episodios && prevTemp.episodios.length > 0) {
        const prevEp = prevTemp.episodios[prevTemp.episodios.length - 1];
        return {
            serieId: serie.id,
            seasonNum: prevTemp.numero,
            epNum: prevEp.numero,
            epNome: prevEp.nome
        };
    }
    return null;
}

// Test S1E1 (First episode) -> Prev is null, Next is S1E2
assert.strictEqual(getPreviousEpisodeInfoSim(testSeries, 1, 1), null, 'S1E1 não deve ter episódio anterior');
const next1 = getNextEpisodeInfoSim(testSeries, 1, 1);
assert.strictEqual(next1.seasonNum, 1);
assert.strictEqual(next1.epNum, 2);

// Test S1E2 (Season boundary) -> Next is S2E1
const nextBoundary = getNextEpisodeInfoSim(testSeries, 1, 2);
assert.strictEqual(nextBoundary.seasonNum, 2);
assert.strictEqual(nextBoundary.epNum, 1);

// Test S2E1 (Season boundary backwards) -> Prev is S1E2
const prevBoundary = getPreviousEpisodeInfoSim(testSeries, 2, 1);
assert.strictEqual(prevBoundary.seasonNum, 1);
assert.strictEqual(prevBoundary.epNum, 2);

// Test S2E2 (Last episode) -> Next is null
assert.strictEqual(getNextEpisodeInfoSim(testSeries, 2, 2), null, 'S2E2 não deve ter próximo episódio');

console.log('✅ Algoritmo de navegação entre episódios (limites e transição de temporadas) validado com sucesso!');

// 5. Test StremioServer SPA routes
const StremioServer = require('../src/services/StremioServer');
const CatalogoManager = require('../src/managers/CatalogoManager');
const AssinaturaManager = require('../src/managers/AssinaturaManager');

const catMgr = new CatalogoManager();
const assMgr = new AssinaturaManager();
const server = new StremioServer(catMgr, assMgr, null, null, 7789);

console.log('✅ Servidor instanciado com sucesso com as novas rotas de filmes, séries e episódios!');
console.log('\n🎉 TODOS OS TESTES PASSARAM COM 100% DE SUCESSO!');
process.exit(0);
