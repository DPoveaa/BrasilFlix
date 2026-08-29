const path = require('path');
const CatalogoManager = require('./src/managers/CatalogoManager');
const StremioService = require('./src/services/StremioService');

function assert(condition, message) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${message}`);
        process.exit(1);
    } else {
        console.log(`✅ PASS: ${message}`);
    }
}

console.log('====================================================');
console.log('🧪 INICIANDO TESTES DE REGRESSÃO E AUDITORIA BRASILFLIX');
console.log('====================================================\n');

// 1. No Ep 1 -> season hidden
console.log('--- Teste 1: Sem Ep 1 -> Temporada Oculta ---');
const t1_eps = [
    { numero: 2, isDublado: true, messageId: 102 },
    { numero: 3, isDublado: true, messageId: 103 },
    { numero: 4, isDublado: true, messageId: 104 }
];
const res1 = CatalogoManager.normalizeSeasonEpisodes(t1_eps, 1);
assert(res1 === null, 'Temporada sem Episodio 1 deve retornar null (oculta)');

// 2. Ep 1 dubbed -> season visible as dubbed
console.log('\n--- Teste 2: Ep 1 Dublado -> Temporada visível como Dublado ---');
const t2_eps = [
    { numero: 1, isDublado: true, messageId: 201 }
];
const res2 = CatalogoManager.normalizeSeasonEpisodes(t2_eps, 1);
assert(res2 !== null, 'Temporada com Ep 1 dublado deve estar visivel');
assert(res2.isDublado === true, 'isDublado deve ser true');
assert(res2.isLegendado === false, 'isLegendado deve ser false');
assert(res2.totalEpisodios === 1, 'Deve ter 1 episodio');

// 3. Ep 1 subtitled -> season visible as subtitled
console.log('\n--- Teste 3: Ep 1 Legendado -> Temporada visível como Legendado ---');
const t3_eps = [
    { numero: 1, isLegendado: true, fileId: 'file_leg_301' }
];
const res3 = CatalogoManager.normalizeSeasonEpisodes(t3_eps, 1);
assert(res3 !== null, 'Temporada com Ep 1 legendado deve estar visivel');
assert(res3.isDublado === false, 'isDublado deve ser false');
assert(res3.isLegendado === true, 'isLegendado deve ser true');
assert(res3.totalEpisodios === 1, 'Deve ter 1 episodio');

// 4. Ep 1 dubbed + Ep 2 dubbed -> both visible
console.log('\n--- Teste 4: Ep 1 Dublado + Ep 2 Dublado -> Ambos Visíveis ---');
const t4_eps = [
    { numero: 1, isDublado: true, messageId: 401 },
    { numero: 2, isDublado: true, messageId: 402 }
];
const res4 = CatalogoManager.normalizeSeasonEpisodes(t4_eps, 1);
assert(res4 !== null, 'Temporada com E1+E2 dublados deve estar visivel');
assert(res4.isDublado === true, 'isDublado deve ser true');
assert(res4.totalEpisodios === 2, 'Total de episodios deve ser 2');
assert(res4.episodios.map(e => e.numero).join(',') === '1,2', 'Episodios 1 e 2 presentes');

// 5. Ep 1 dubbed + Ep 2 dubbed + Ep 6 dubbed -> only E1/E2 visible, season remains visible
console.log('\n--- Teste 5: Ep 1 Dub + Ep 2 Dub + Ep 6 Dub -> Apenas E1/E2 Visíveis, Temporada Visível ---');
const t5_eps = [
    { numero: 1, isDublado: true, messageId: 501 },
    { numero: 2, isDublado: true, messageId: 502 },
    { numero: 6, isDublado: true, messageId: 506 }
];
const res5 = CatalogoManager.normalizeSeasonEpisodes(t5_eps, 1);
assert(res5 !== null, 'Temporada deve permanecer visivel');
assert(res5.totalEpisodios === 2, `Apenas E1 e E2 devem estar visiveis (obteve: ${res5.totalEpisodios})`);
assert(res5.episodios.some(e => e.numero === 6) === false, 'Episodio 6 isolado deve ser ocultado');

// 6. Ep 1 subtitled + Ep 2 dubbed -> only subtitled E1 is exposed
console.log('\n--- Teste 6: Ep 1 Leg + Ep 2 Dub -> Apenas E1 Legendado Exposto ---');
const t6_eps = [
    { numero: 1, isLegendado: true, messageId: 601 },
    { numero: 2, isDublado: true, messageId: 602 }
];
const res6 = CatalogoManager.normalizeSeasonEpisodes(t6_eps, 1);
assert(res6 !== null, 'Temporada deve estar visivel como legendada');
assert(res6.isDublado === false, 'isDublado da temporada deve ser false porque Ep 1 nao e dublado');
assert(res6.isLegendado === true, 'isLegendado deve ser true');
assert(res6.totalEpisodios === 1, `Apenas Ep 1 legendado deve ser exposto (obteve: ${res6.totalEpisodios})`);
assert(res6.episodios[0].numero === 1, 'Apenas episodio 1 presente');

// 7. Ep 1 flagged as dubbed but without messageId/fileId -> dubbed version NOT available
console.log('\n--- Teste 7: Ep 1 com flag Dublado mas SEM messageId/fileId -> NÃO Disponível ---');
const t7_eps = [
    { numero: 1, isDublado: true, messageId: null, fileId: null, versoes: { dublado: { qualidade: '1080p' } } }
];
const res7 = CatalogoManager.normalizeSeasonEpisodes(t7_eps, 1);
assert(res7 === null, 'Sem messageId/fileId real, versao dublada nao deve estar disponivel (temporada oculta)');

// 8. No valid media for either language -> season hidden
console.log('\n--- Teste 8: Sem mídia válida para nenhum idioma -> Temporada Oculta ---');
const t8_eps = [
    { numero: 1, isDublado: true, isLegendado: true, messageId: null, fileId: null, versoes: {} },
    { numero: 2, isDublado: true, isLegendado: true, messageId: null, fileId: null, versoes: {} }
];
const res8 = CatalogoManager.normalizeSeasonEpisodes(t8_eps, 1);
assert(res8 === null, 'Temporada sem midia real para dublado nem legendado deve retornar null (oculta)');

// 9. A valid newly released season containing only Ep 1 remains visible
console.log('\n--- Teste 9: Temporada recém lançada com apenas Ep 1 -> Permanece Visível ---');
const t9_eps = [
    { numero: 1, isDublado: true, isLegendado: true, versoes: { dublado: { messageId: 901 }, legendado: { fileId: 'leg_901' } } }
];
const res9 = CatalogoManager.normalizeSeasonEpisodes(t9_eps, 1);
assert(res9 !== null, 'Temporada recem lancada com apenas Ep 1 deve estar visivel');
assert(res9.totalEpisodios === 1, 'Total de episodios deve ser 1');
assert(res9.isDublado === true && res9.isLegendado === true, 'Episodio 1 com audio dual');

// 10. Teste Integrado com processSerie e StremioService
console.log('\n--- Teste 10: Teste Integrado com processSerie & StremioService Streams ---');
(async () => {
    try {
        const serieData = {
            id: 88,
            nome: 'Série Exemplo',
            generos: ['Drama']
        };
        const seriesObj = CatalogoManager.processSerie(serieData, { 1: t5_eps });
        assert(seriesObj !== null, 'processSerie com temporada valida deve retornar serie');
        assert(seriesObj.totalEpisodios === 2, 'Total de episodios da serie processada deve ser 2');

        const mockCatMgr = {
            buscarFilmePorId: (id) => {
                if (id === '1') return { id: 1, nome: 'Filme Dub', isDublado: true, isLegendado: false, versoes: { dublado: { messageId: 1001 } } };
                if (id === '2') return { id: 2, nome: 'Filme Sem Midia', isDublado: true, isLegendado: false, versoes: { dublado: {} } };
                return null;
            },
            buscarSeriePorId: (id) => {
                if (id === '88') return seriesObj;
                return null;
            }
        };

        const mockAssinaturaMgr = {
            verificarAcessoStremio: () => ({ authorized: true }),
            verificarOuRegistrarConsumoGratis: async () => ({ permitido: true })
        };

        const stremio = new StremioService(mockCatMgr, mockAssinaturaMgr);

        // Filme com mídia
        const stFilme1 = await stremio.getStreams('movie', 'bf_filme_1', 'token_user');
        assert(stFilme1.streams.length === 1, 'Filme com media real deve ter 1 stream');

        // Filme sem messageId/fileId real -> sem stream (não retorna fallback falso)
        const stFilme2 = await stremio.getStreams('movie', 'bf_filme_2', 'token_user');
        assert(stFilme2.streams.length === 0, 'Filme sem messageId/fileId real deve ter 0 streams');

        // Série Ep 1 e Ep 2
        const stEp1 = await stremio.getStreams('series', 'bf_serie_88:1:1', 'token_user');
        assert(stEp1.streams.length === 1, 'Episodio 1 valido deve ter 1 stream');

        // Série Ep 6 (oculto pela regra de continuidade)
        const stEp6 = await stremio.getStreams('series', 'bf_serie_88:1:6', 'token_user');
        assert(stEp6.streams.length === 0, 'Episodio 6 fora da sequencia nao deve ter streams');

        console.log('\n====================================================');
        console.log('🎉 TODOS OS 10 TESTES DE REGRESSÃO PASSARAM COM SUCESSO!');
        console.log('====================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NO TESTE:', err);
        process.exit(1);
    }
})();
