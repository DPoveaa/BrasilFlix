const path = require('path');
const CatalogoManager = require('./src/managers/CatalogoManager');
const StremioService = require('./src/services/StremioService');
const db = require('./src/database/db');

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

// Pré-popula cache de verificação para IDs de teste unitário
[102, 103, 104, 201, 401, 402, 501, 502, 506, 601, 602, 901, 1001].forEach(id => {
    CatalogoManager.mediaVerificationCache.set(id, 'VERIFIED_PLAYABLE', { docId: `doc_${id}` });
});
CatalogoManager.mediaVerificationCache.set(301, 'VERIFIED_PLAYABLE', { docId: 'file_leg_301' });
CatalogoManager.mediaVerificationCache.set(902, 'VERIFIED_PLAYABLE', { docId: 'leg_901' });

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
    { numero: 1, isLegendado: true, messageId: 301, fileId: 'file_leg_301' }
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

// 7b. Teste estrito de identificadores inválidos (0, whitespace, strings vazias, negativos)
console.log('\n--- Teste 7b: Validação Estrita de Identificadores Inválidos (0, "", "   ", negativo) ---');
assert(CatalogoManager.isValidMediaIdentifier(0, null) === false, 'messageId 0 deve ser invalido');
assert(CatalogoManager.isValidMediaIdentifier(-5, null) === false, 'messageId negativo deve ser invalido');
assert(CatalogoManager.isValidMediaIdentifier(null, "") === false, 'fileId vazio deve ser invalido');
assert(CatalogoManager.isValidMediaIdentifier(null, "   ") === false, 'fileId com apenas espacos deve ser invalido');
assert(CatalogoManager.isValidMediaIdentifier(undefined, undefined) === false, 'undefined deve ser invalido');
assert(CatalogoManager.isValidMediaIdentifier(12345, null) === true, 'messageId positivo deve ser valido');
assert(CatalogoManager.isValidMediaIdentifier(null, "valid_file_id") === true, 'fileId preenchido deve ser valido');
assert(CatalogoManager.isValidMediaIdentifier("54321", "  ") === true, 'messageId em string numerica positiva deve ser valido');

// 8. No valid media for either language -> season hidden
console.log('\n--- Teste 8: Sem mídia válida para nenhum idioma -> Temporada Oculta ---');
const t8_eps = [
    { numero: 1, isDublado: true, isLegendado: true, messageId: 0, fileId: "   ", versoes: {} },
    { numero: 2, isDublado: true, isLegendado: true, messageId: null, fileId: "", versoes: {} }
];
const res8 = CatalogoManager.normalizeSeasonEpisodes(t8_eps, 1);
assert(res8 === null, 'Temporada sem midia real para dublado nem legendado deve retornar null (oculta)');

// 9. A valid newly released season containing only Ep 1 remains visible
console.log('\n--- Teste 9: Temporada recém lançada com apenas Ep 1 -> Permanece Visível ---');
const t9_eps = [
    { numero: 1, isDublado: true, isLegendado: true, versoes: { dublado: { messageId: 901 }, legendado: { messageId: 902, fileId: 'leg_901' } } }
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

        // Teste 11: StremioServer Validação e Fallback de Streaming
        console.log('\n--- Teste 11: StremioServer Validação de Streaming e fileId explícito ---');
        const StremioServer = require('./src/services/StremioServer');
        const mockServerMgr = {
            buscarFilmePorId: (id) => {
                if (id === '10') return { id: 10, nome: 'Filme Invalido', isDublado: true, versoes: { dublado: { messageId: 0, fileId: '   ' } } };
                if (id === '20') return { id: 20, nome: 'Filme Apenas FileId', isDublado: true, versoes: { dublado: { fileId: 'valid_telegram_file_id' } } };
                return null;
            },
            buscarSeriePorId: () => null,
            buscarEpisodio: () => null,
            getGenerosDisponiveis: () => []
        };
        const serverInstance = new StremioServer(mockServerMgr, mockAssinaturaMgr, null, null, 9999);

        // Teste de filme com identificadores inválidos (0 / "   ") -> deve retornar 404
        let statusResp1 = null;
        let bodyResp1 = null;
        const fakeReq1 = { params: { userToken: 'token_user', id: '10', audio: 'dublado' }, headers: {} };
        const fakeRes1 = {
            status: (s) => { statusResp1 = s; return fakeRes1; },
            send: (b) => { bodyResp1 = b; }
        };
        await serverInstance.handleStreamFilme(fakeReq1, fakeRes1);
        assert(statusResp1 === 404, 'Mídia com messageId 0 / fileId com espaços deve retornar 404');

        // Teste de filme apenas com fileId sem Cloudflare configurado -> deve retornar 404 explicito
        let statusResp2 = null;
        let bodyResp2 = null;
        const fakeReq2 = { params: { userToken: 'token_user', id: '20', audio: 'dublado' }, headers: {} };
        const fakeRes2 = {
            status: (s) => { statusResp2 = s; return fakeRes2; },
            send: (b) => { bodyResp2 = b; }
        };
        await serverInstance.handleStreamFilme(fakeReq2, fakeRes2);
        assert(statusResp2 === 404, 'Mídia apenas com fileId sem Cloudflare deve retornar 404 explícito');
        assert(bodyResp2.includes('sem messageId de armazenamento'), 'Mensagem de 404 deve ser explicita sobre messageId');

        // Teste 12: Teste de Consumo de Cota Gratuita (Quota Lifecycle)
        console.log('\n--- Teste 12: Testes de Consumo de Cota Gratuita e Validação Antecipada ---');
        let registeredConsumptions = [];
        let checkedConsumptions = [];

        const mockQuotaAssinaturaMgr = {
            verificarAcessoStremio: () => ({ authorized: false }),
            verificarOuRegistrarConsumoGratis: async (token, tipo, mediaKey) => {
                checkedConsumptions.push({ token, tipo, mediaKey });
                return { permitido: true, isVip: false, restanteFilmes: 1, restanteEpisodios: 1 };
            },
            registrarStreamConsumido: async (token, tipo, mediaKey) => {
                registeredConsumptions.push({ token, tipo, mediaKey });
            }
        };

        const mockQuotaCatMgr = {
            buscarFilmePorId: (id) => {
                if (id === '100') return { id: 100, nome: 'Filme Valido', isDublado: true, versoes: { dublado: { messageId: 9999 } } };
                if (id === '101') return { id: 101, nome: 'Filme Sem Audio Leg', isDublado: true, isLegendado: false, versoes: { dublado: { messageId: 9998 } } };
                if (id === '102') return { id: 102, nome: 'Filme Identificador Invalido', isDublado: true, versoes: { dublado: { messageId: 0, fileId: '' } } };
                return null;
            },
            buscarSeriePorId: (id) => {
                if (id === '200') {
                    return {
                        id: 200,
                        nome: 'Serie Teste Cota',
                        temporadas: [
                            {
                                numero: 1,
                                episodios: [
                                    { numero: 1, isDublado: true, isLegendado: false, versoes: { dublado: { messageId: 8881 } } },
                                    { numero: 2, isDublado: true, isLegendado: false, versoes: { dublado: { messageId: 8882 } } }
                                    // Ep 6 foi filtrado pela regra de continuidade e não existe na lista de episódios da temporada
                                ]
                            }
                        ]
                    };
                }
                return null;
            },
            getGenerosDisponiveis: () => []
        };

        const quotaServer = new StremioServer(mockQuotaCatMgr, mockQuotaAssinaturaMgr, null, null, 9998);
        quotaServer.streamTelegramMedia = async () => {}; // Mock streaming

        // 12.1 Episódio inexistente -> não consome cota
        registeredConsumptions = [];
        checkedConsumptions = [];
        let s1 = null;
        await quotaServer.handleStreamSerie({ params: { userToken: 'u1', id: '200', season: '1', episode: '99', audio: 'dublado' }, headers: {} }, { status: (c) => { s1 = c; return { send: () => {} }; } });
        assert(s1 === 404, 'Episodio inexistente deve retornar 404');
        assert(registeredConsumptions.length === 0, 'Episodio inexistente NAO deve consumir cota');
        assert(checkedConsumptions.length === 0, 'Episodio inexistente NAO deve verificar cota');

        // 12.2 Episódio após gap de continuidade (ex: Ep 6 quando só temos 1 e 2) -> não consome cota
        registeredConsumptions = [];
        checkedConsumptions = [];
        let s2 = null;
        await quotaServer.handleStreamSerie({ params: { userToken: 'u1', id: '200', season: '1', episode: '6', audio: 'dublado' }, headers: {} }, { status: (c) => { s2 = c; return { send: () => {} }; } });
        assert(s2 === 404, 'Episodio apos gap de continuidade deve retornar 404');
        assert(registeredConsumptions.length === 0, 'Episodio apos gap NAO deve consumir cota');
        assert(checkedConsumptions.length === 0, 'Episodio apos gap NAO deve verificar cota');

        // 12.3 Versão de áudio inexistente (ex: pede legendado num ep apenas dublado) -> não consome cota
        registeredConsumptions = [];
        checkedConsumptions = [];
        let s3 = null;
        await quotaServer.handleStreamSerie({ params: { userToken: 'u1', id: '200', season: '1', episode: '1', audio: 'legendado' }, headers: {} }, { status: (c) => { s3 = c; return { send: () => {} }; } });
        assert(s3 === 404, 'Versao de audio inexistente deve retornar 404');
        assert(registeredConsumptions.length === 0, 'Audio inexistente NAO deve consumir cota');
        assert(checkedConsumptions.length === 0, 'Audio inexistente NAO deve verificar cota');

        // 12.4 Identificador de mídia inválido (0 / vazio) -> não consome cota
        registeredConsumptions = [];
        checkedConsumptions = [];
        let s4 = null;
        await quotaServer.handleStreamFilme({ params: { userToken: 'u1', id: '102', audio: 'dublado' }, headers: {} }, { status: (c) => { s4 = c; return { send: () => {} }; } });
        assert(s4 === 404, 'Identificador invalido deve retornar 404');
        assert(registeredConsumptions.length === 0, 'Identificador invalido NAO deve consumir cota');
        assert(checkedConsumptions.length === 0, 'Identificador invalido NAO deve verificar cota');

        // 12.5 Episódio válido com mídia válida -> consome cota normalmente
        registeredConsumptions = [];
        checkedConsumptions = [];
        await quotaServer.handleStreamSerie({ params: { userToken: 'u1', id: '200', season: '1', episode: '1', audio: 'dublado' }, headers: {} }, { status: () => ({ send: () => {} }) });
        assert(registeredConsumptions.length === 1, 'Episodio valido DEVE consumir cota');
        assert(registeredConsumptions[0].mediaKey === 'serie_200_s1_e1', 'mediaKey da serie deve estar correto');

        // 12.6 Filme válido com mídia válida -> consome cota normalmente
        registeredConsumptions = [];
        checkedConsumptions = [];
        await quotaServer.handleStreamFilme({ params: { userToken: 'u1', id: '100', audio: 'dublado' }, headers: {} }, { status: () => ({ send: () => {} }) });
        assert(registeredConsumptions.length === 1, 'Filme valido DEVE consumir cota');
        assert(registeredConsumptions[0].mediaKey === 'filme_100', 'mediaKey do filme deve estar correto');

        // Teste 13: Segurança na Deleção de Mensagens no Armazém (Eliminação do bug id + 1)
        console.log('\n--- Teste 13: Segurança de Deleção no Telegram (Sem Deletar id + 1) ---');
        const TelegramUploader = require('./src/services/TelegramUploader');
        const uploader = new TelegramUploader();

        let deletedIdsInMock = [];
        uploader.getClient = async () => ({
            deleteMessages: async (groupId, ids) => {
                deletedIdsInMock = ids;
                return true;
            }
        });

        // 13.1 Deletando mensagem 100 deve deletar APENAS 100, NUNCA 101
        await uploader.deleteStorageMessages([100]);
        assert(deletedIdsInMock.length === 1 && deletedIdsInMock[0] === 100, 'Deletar mensagem 100 deve deletar apenas [100]');
        assert(!deletedIdsInMock.includes(101), 'Deletar mensagem 100 NUNCA deve incluir 101');

        // 13.2 Substituição de episódio: antigo=100, novo=101 -> ao remover antigo, 101 permanece intacto
        await uploader.deleteStorageMessages([100]);
        assert(deletedIdsInMock.includes(100) && !deletedIdsInMock.includes(101), 'Ao substituir episódio antigo 100 por novo 101, 101 deve permanecer intacto');

        // 13.3 Deletando múltiplos IDs explícitos ([100, 200]) -> não deve deletar 101 nem 201
        await uploader.deleteStorageMessages([100, 200]);
        assert(deletedIdsInMock.length === 2 && deletedIdsInMock.includes(100) && deletedIdsInMock.includes(200), 'Deletar [100, 200] deve conter exatamente [100, 200]');
        assert(!deletedIdsInMock.includes(101) && !deletedIdsInMock.includes(201), 'Deletar [100, 200] NUNCA deve incluir vizinhos 101 ou 201');

        // Teste 14: Auto-Healing de Mídia Ausente e Invalidação Parcial
        console.log('\n--- Teste 14: Auto-Healing de Mídia e Invalidação Parcial ---');
        let healedCalls = [];
        const mockHealCatMgr = {
            loadCatalogo: async () => { healedCalls.push('loadCatalogo'); }
        };
        const mockHealServer = new StremioServer(mockHealCatMgr, mockAssinaturaMgr, null, null, 9998);

        let queryLogs = [];
        const originalDbQuery = db.query;
        db.query = async (sql, params) => {
            queryLogs.push({ sql, params });
            if (sql.includes('SELECT * FROM filmes')) {
                return { rows: [] };
            }
            if (sql.includes('SELECT * FROM episodios')) {
                return {
                    rows: [{
                        id: 55,
                        serie_id: 17,
                        temporada_numero: 4,
                        numero: 7,
                        is_dublado: true,
                        is_legendado: true,
                        versoes: { dublado: { messageId: 8888 }, legendado: { messageId: 315641 } }
                    }]
                };
            }
            return { rows: [] };
        };

        try {
            await mockHealServer.autoHealMissingMedia(315641);
            assert(healedCalls.includes('loadCatalogo'), 'Auto-healing deve recarregar o catalogo');
            const updateEpQuery = queryLogs.find(q => q.sql.includes('UPDATE episodios SET'));
            assert(updateEpQuery, 'Auto-healing deve atualizar episodios no banco');
            const updatedVersoes = JSON.parse(updateEpQuery.params[0]);
            assert(updatedVersoes.legendado === null, 'Versao legendada ausente deve ser definida como null');
            assert(updatedVersoes.dublado !== null && updatedVersoes.dublado.messageId === 8888, 'Versao dublada valida deve ser preservada');
            assert(updateEpQuery.params[1] === true, 'is_dublado deve permanecer true');
            assert(updateEpQuery.params[2] === false, 'is_legendado deve se tornar false');
        } finally {
            db.query = originalDbQuery;
        }

        // Teste 15: Helper Centralizado getStorageMessages & getStorageMessage
        console.log('\n--- Teste 15: Helper Centralizado getStorageMessages & getStorageMessage ---');
        const helperUploader = new TelegramUploader();
        let entityTypeQueried = null;
        let lastInvokeType = null;

        helperUploader.getClient = async () => ({
            getEntity: async (id) => {
                entityTypeQueried = id;
                return { className: 'Chat' }; // Basic Group
            },
            invoke: async (request) => {
                lastInvokeType = request.className;
                return {
                    messages: [
                        {
                            id: 100,
                            className: 'Message',
                            media: {
                                document: {
                                    id: 1234567890n,
                                    size: 104857600, // 100MB
                                    mimeType: 'video/mp4',
                                    attributes: [{ className: 'DocumentAttributeVideo', duration: 3600 }]
                                }
                            }
                        },
                        {
                            id: 101,
                            className: 'MessageEmpty'
                        },
                        {
                            id: 102,
                            className: 'Message',
                            media: {
                                document: {
                                    id: 9999999999n,
                                    size: 0, // 0 bytes
                                    mimeType: 'video/mp4'
                                }
                            }
                        },
                        {
                            id: 103,
                            className: 'Message',
                            media: {
                                document: {
                                    id: 8888888888n,
                                    size: 5000,
                                    mimeType: 'application/pdf' // Não é vídeo
                                }
                            }
                        }
                    ]
                };
            }
        });

        const batchResults = await helperUploader.getStorageMessages([100, 101, 102, 103]);
        assert(batchResults.get(100).status === 'FOUND', 'Msg 100 com vídeo válido deve ser FOUND');
        assert(batchResults.get(100).isVideo === true, 'Msg 100 deve ser reconhecida como vídeo');
        assert(batchResults.get(100).docId === '1234567890', 'Msg 100 docId deve ser string correto');
        assert(batchResults.get(101).status === 'NOT_FOUND', 'Msg 101 MessageEmpty deve ser NOT_FOUND');
        assert(batchResults.get(102).status === 'INVALID_MEDIA', 'Msg 102 tamanho 0 bytes deve ser INVALID_MEDIA');
        assert(batchResults.get(103).status === 'INVALID_MEDIA', 'Msg 103 PDF deve ser INVALID_MEDIA');

        // Teste de canal/supergroup
        helperUploader.getClient = async () => ({
            getEntity: async () => ({ className: 'Channel' }),
            getInputEntity: async () => ({ className: 'InputChannel' }),
            invoke: async (request) => {
                lastInvokeType = request.className || request.constructor?.name;
                return { messages: [] };
            }
        });
        await helperUploader.getStorageMessages([200]);
        assert(lastInvokeType && (lastInvokeType.includes('GetMessages') || lastInvokeType.includes('Channel')), 'Deve invocar API adequada para Channel');

        // Teste de Erro de Rede -> status ERROR (não NOT_FOUND)
        helperUploader.getClient = async () => ({
            getEntity: async () => { throw new Error('CONNECTION_TIMEOUT'); }
        });
        const errResult = await helperUploader.getStorageMessage(500);
        assert(errResult.status === 'ERROR', 'Erro de rede/timeout deve retornar status ERROR, NUNCA NOT_FOUND');

        // Teste 16: verifyCatalogIntegrity Completa com Detecção de Duplicados e Divergência de fileId
        console.log('\n--- Teste 16: verifyCatalogIntegrity com Detecção de Duplicados e Validação Real ---');
        const auditUploader = new TelegramUploader();
        auditUploader.getStorageMessages = async (ids) => {
            const map = new Map();
            for (const id of ids) {
                if (id === 1000) {
                    map.set(id, {
                        status: 'FOUND',
                        doc: { id: 777777n, size: 500000000, mimeType: 'video/mkv' },
                        docId: '777777',
                        docSize: 500000000,
                        isVideo: true,
                        duration: 7200,
                        fileName: 'filme_a.mkv',
                        error: null
                    });
                } else if (id === 2000) {
                    map.set(id, {
                        status: 'FOUND',
                        doc: { id: 888888n, size: 500000000, mimeType: 'video/mp4' },
                        docId: '888888', // No catálogo está cadastrado com fileId '999999' -> Mismatch
                        docSize: 500000000,
                        isVideo: true,
                        duration: 3600,
                        fileName: 'filme_b.mp4',
                        error: null
                    });
                } else if (id === 3000) {
                    map.set(id, { status: 'NOT_FOUND', doc: null, error: null });
                } else if (id === 4000) {
                    map.set(id, { status: 'INVALID_MEDIA', doc: null, error: 'Documento com 0 bytes' });
                } else if (id === 5000) {
                    map.set(id, { status: 'ERROR', error: 'FLOOD_WAIT_30' });
                }
            }
            return map;
        };

        const mockCatalogToAudit = {
            filmes: [
                // 1. Válido e fileId compatível
                { id: 1, nome: 'Filme Valido', versoes: { dublado: { messageId: 1000, fileId: '777777' } } },
                // 2. Válido mas fileId divergente
                { id: 2, nome: 'Filme Divergente', versoes: { dublado: { messageId: 2000, fileId: '999999' } } },
                // 3. Ausente no Telegram
                { id: 3, nome: 'Filme Ausente', versoes: { dublado: { messageId: 3000 } } },
                // 4. Corrompido
                { id: 4, nome: 'Filme Corrompido', versoes: { dublado: { messageId: 4000 } } },
                // 5. Erro temporário de rede
                { id: 5, nome: 'Filme Erro Rede', versoes: { dublado: { messageId: 5000 } } },
                // 6. Duplicado com filme 1 (mesmo messageId 1000)
                { id: 6, nome: 'Filme Duplicado', versoes: { dublado: { messageId: 1000 } } }
            ],
            series: []
        };

        const auditReport = await auditUploader.verifyCatalogIntegrity(mockCatalogToAudit);
        assert(auditReport.validos.length === 2, 'Deve haver 2 mídias válidas (filmes 1 e 6, com filme 2 divergente excluído de válidos)');
        assert(auditReport.fileIdMismatches.length === 1, 'Deve detectar 1 divergência de fileId (filme 2)');
        assert(auditReport.fileIdMismatches[0].storedFileId === '999999' && auditReport.fileIdMismatches[0].actualDocId === '888888', 'Detalhes da divergência de fileId devem estar corretos');
        assert(auditReport.ausentes.length === 1, 'Deve detectar 1 mídia ausente (filme 3)');
        assert(auditReport.corrompidos.length === 1, 'Deve detectar 1 mídia corrompida (filme 4)');
        assert(auditReport.unverified.length === 1, 'Deve classificar erro temporário em unverified (filme 5)');
        assert(auditReport.duplicates.length === 1, 'Deve detectar a duplicata de messageId antes da deduplicação de chamadas');
        assert(auditReport.duplicates[0].identifier === 1000 && auditReport.duplicates[0].count === 2, 'Duplicata do messageId 1000 deve conter 2 itens');

        // Teste 17: StremioServer com getStorageMessage e Auto-Healing condicional
        console.log('\n--- Teste 17: StremioServer Proteção de Streaming e Erros de Rede ---');
        let autoHealTriggeredFor = [];
        const mockStreamServer = new StremioServer(mockHealCatMgr, mockAssinaturaMgr, null, null, 9997);
        mockStreamServer.autoHealMissingMedia = async (id) => {
            autoHealTriggeredFor.push(id);
        };

        // 17.1 Erro temporário de rede -> Retorna 503 e NÃO chama auto-healing
        const telegramUploaderInstance = TelegramUploader.getInstance();
        const origGetStorageMessage = telegramUploaderInstance.getStorageMessage;
        try {
            telegramUploaderInstance.getStorageMessage = async () => ({ status: 'ERROR', error: 'Network timeout' });
            let respCode = null;
            await mockStreamServer.streamTelegramMedia({}, { status: (c) => { respCode = c; return { send: () => {} }; } }, { messageId: 999 });
            assert(respCode === 503, 'Erro de rede deve retornar 503');
            assert(autoHealTriggeredFor.length === 0, 'Erro de rede NÃO deve disparar auto-healing');

            // 17.2 Mídia confirmada ausente (NOT_FOUND) -> Retorna 404 e DISPARA auto-healing
            telegramUploaderInstance.getStorageMessage = async () => ({ status: 'NOT_FOUND', error: null });
            respCode = null;
            await mockStreamServer.streamTelegramMedia({}, { status: (c) => { respCode = c; return { send: () => {} }; } }, { messageId: 888 });
            assert(respCode === 404, 'Mídia NOT_FOUND deve retornar 404');
            assert(autoHealTriggeredFor.includes(888), 'Mídia confirmada ausente DEVE disparar auto-healing');
        } finally {
            telegramUploaderInstance.getStorageMessage = origGetStorageMessage;
        }

        // Teste 18: hasPlayableMedia e Rejeição de fileId não verificado
        console.log('\n--- Teste 18: hasPlayableMedia e Rejeição de fileId Não Verificado ---');
        CatalogoManager.mediaVerificationCache.set(100, 'VERIFIED_PLAYABLE', { docId: 'doc_100' });
        CatalogoManager.mediaVerificationCache.set(200, 'VERIFIED_PLAYABLE', { docId: 'doc_200' });
        assert(CatalogoManager.hasPlayableMedia({ messageId: 100 }) === true, 'messageId numérico positivo verificado deve ser playable');
        assert(CatalogoManager.hasPlayableMedia({ messageId: '200' }) === true, 'messageId string numérica positiva verificada deve ser playable');
        assert(CatalogoManager.hasPlayableMedia({ messageId: 999999 }) === false, 'messageId numérico positivo NÃO verificado NÃO deve ser playable');
        assert(CatalogoManager.hasPlayableMedia({ fileId: '4931446608492496572' }) === false, 'Apenas fileId sem messageId NÃO deve ser tratado como playable no catálogo público');
        assert(CatalogoManager.hasPlayableMedia({ messageId: 0, fileId: 'some_id' }) === false, 'messageId 0 com fileId NÃO deve ser playable');

        // Teste de exclusão estrita de FILE_ID_MISMATCH da lista de válidos
        const mismatchAuditUploader = new TelegramUploader();
        mismatchAuditUploader.getStorageMessages = async () => {
            const map = new Map();
            map.set(100, {
                status: 'FOUND',
                docId: 'real_doc_999',
                docSize: 500000000,
                isVideo: true,
                duration: 3600,
                fileName: 'video.mp4'
            });
            return map;
        };
        const mismatchResult = await mismatchAuditUploader.verifyCatalogIntegrity([
            { id: 1, nome: 'Item Mismatch', messageId: 100, fileId: 'wrong_stored_doc_111' }
        ]);
        assert(mismatchResult.validos.length === 0, 'Item com divergência de fileId NÃO pode estar em válidos');
        assert(mismatchResult.fileIdMismatches.length === 1, 'Item com divergência de fileId DEVE estar em fileIdMismatches');

        // Teste 19: Auditoria Direta de PostgreSQL (verifyDatabaseIntegrity)
        console.log('\n--- Teste 19: Auditoria Direta do Banco de Dados PostgreSQL ---');
        const mockDb = {
            query: async (sql) => {
                if (sql.includes('FROM filmes')) {
                    return {
                        rows: [
                            { id: 1, nome: 'Filme A', is_dublado: true, message_id: 100, versoes: { dublado: { messageId: 100 } } },
                            { id: 2, nome: 'Filme Stale Flag', is_dublado: true, is_legendado: false, message_id: null, file_id: null, versoes: null }
                        ]
                    };
                }
                if (sql.includes('FROM series')) {
                    return {
                        rows: [
                            { id: 10, nome: 'Serie Teste', total_temporadas: 1, total_episodios: 2 }
                        ]
                    };
                }
                if (sql.includes('FROM episodios')) {
                    return {
                        rows: [
                            { id: 50, serie_id: 10, temporada_numero: 1, numero: 1, nome: 'E1', message_id: 200, versoes: { dublado: { messageId: 200 } } },
                            { id: 51, serie_id: 10, temporada_numero: 1, numero: 1, nome: 'E1 Duplicado no DB', message_id: 201, versoes: { dublado: { messageId: 201 } } },
                            { id: 99, serie_id: 999, temporada_numero: 1, numero: 1, nome: 'E Órfão', message_id: 300 }
                        ]
                    };
                }
                return { rows: [] };
            }
        };

        const directAuditUploader = new TelegramUploader();
        directAuditUploader.getStorageMessages = async (ids) => {
            const map = new Map();
            for (const id of ids) {
                map.set(id, { status: 'FOUND', docId: String(id), docSize: 1000000, isVideo: true, duration: 1000 });
            }
            return map;
        };

        const dbAuditReport = await directAuditUploader.verifyDatabaseIntegrity(mockDb);
        assert(dbAuditReport.databaseTotals.totalFilmes === 2, 'Total de filmes no banco deve ser 2');
        assert(dbAuditReport.databaseTotals.totalEpisodios === 3, 'Total de episódios no banco deve ser 3');
        assert(dbAuditReport.anomalousDbRecords.staleFlags.length === 1, 'Deve detectar 1 flag inconsistente (is_dublado sem mídia)');
        assert(dbAuditReport.anomalousDbRecords.orphanedEpisodes.length === 1, 'Deve detectar 1 episódio órfão');
        assert(dbAuditReport.anomalousDbRecords.duplicateEpisodes.length === 1, 'Deve detectar 1 número de episódio duplicado no banco');

        // Teste 20: Resiliência de autoHealMissingMedia com JSONB contendo strings não numéricas
        console.log('\n--- Teste 20: Resiliência contra Strings Não-Numéricas no JSONB ---');
        let autoHealExecutedSafely = false;
        const mockSafeCatMgr = { loadCatalogo: async () => {} };
        const mockSafeServer = new StremioServer(mockSafeCatMgr, mockAssinaturaMgr, null, null, 9996);

        const origSafeQuery = db.query;
        db.query = async (sql, params) => {
            if (sql.includes('SELECT * FROM filmes') || sql.includes('SELECT * FROM episodios')) {
                autoHealExecutedSafely = true;
                return {
                    rows: [{
                        id: 77,
                        serie_id: 10,
                        temporada_numero: 1,
                        numero: 1,
                        is_dublado: false,
                        is_legendado: false,
                        versoes: { dublado: { messageId: "valor_invalido_texto" }, legendado: { messageId: 315641 } }
                    }]
                };
            }
            return { rows: [] };
        };

        try {
            await mockSafeServer.autoHealMissingMedia(315641);
            assert(autoHealExecutedSafely === true, 'autoHealMissingMedia deve executar com segurança sem erro de casting');
        } finally {
            db.query = origSafeQuery;
        }

        // Teste 21: Validação Estrita dos 12 Contratos de Integridade e Cache de Verificação
        console.log('\n--- Teste 21: Validação dos 12 Contratos de Integridade da Pipeline ---');

        // Contrato 1: messageId positivo porém DELETADO (status MISSING) NÃO é considerado playable
        CatalogoManager.mediaVerificationCache.set(315641, 'MISSING', { error: 'MessageEmpty' });
        assert(CatalogoManager.hasPlayableMedia({ messageId: 315641 }) === false, '1. messageId positivo deletado (MISSING) NÃO deve ser playable');

        // Contrato 2: MessageEmpty faz o episódio desaparecer do catálogo público
        const seasonWithGhost = [
            { numero: 1, isDublado: true, messageId: 401 },
            { numero: 2, isDublado: true, messageId: 402 },
            { numero: 7, isLegendado: true, messageId: 315641 }
        ];
        const resGhost = CatalogoManager.normalizeSeasonEpisodes(seasonWithGhost, 4);
        assert(resGhost !== null && resGhost.totalEpisodios === 2, '2. MessageEmpty no Ep 7 faz o Ep 7 desaparecer e expõe apenas E1 e E2');
        assert(resGhost.episodios.some(e => e.numero === 7) === false, '2b. Episódio com MessageEmpty não está presente no catálogo público');

        // Contrato 3: Erro temporário de rede do Telegram NÃO remove episódio previamente verificado
        CatalogoManager.mediaVerificationCache.set(777, 'VERIFIED_PLAYABLE', { docId: 'doc_777' });
        // Simula erro transitório de rede
        const cachedBefore = CatalogoManager.mediaVerificationCache.get(777);
        assert(cachedBefore.status === 'VERIFIED_PLAYABLE', '3. Erro transitório preserva o estado previamente verificado no cache');

        // Contrato 4: Mídia verificada no Telegram permanece visível
        CatalogoManager.mediaVerificationCache.set(888, 'VERIFIED_PLAYABLE', { docId: 'doc_888' });
        assert(CatalogoManager.hasPlayableMedia({ messageId: 888 }) === true, '4. Mídia VERIFIED_PLAYABLE no Telegram permanece visível');

        // Contrato 5: fileId unverified (sem messageId verificado) permanece oculto
        assert(CatalogoManager.hasPlayableMedia({ fileId: 'doc_only_123' }) === false, '5. fileId sem messageId verificado permanece oculto');

        // Contrato 6: FILE_ID_MISMATCH NÃO é reproduzível
        CatalogoManager.mediaVerificationCache.set(999, 'VERIFIED_PLAYABLE', { docId: 'real_doc_999' });
        assert(CatalogoManager.hasPlayableMedia({ messageId: 999, fileId: 'wrong_stored_fid' }) === false, '6. FILE_ID_MISMATCH não é considerado playable');

        // Contrato 7 & 8: Auto-healing remove apenas a versão inválida e preserva a alternativa válida
        const episodeDual = {
            numero: 1,
            versoes: {
                dublado: { messageId: 201 },
                legendado: { messageId: 315641 } // 315641 é MISSING
            }
        };
        assert(CatalogoManager.hasValidDubbedMedia(episodeDual) === true, '7. Versão dublada válida permanece disponível');
        assert(CatalogoManager.hasValidSubtitledMedia(episodeDual) === false, '8. Versão legendada com MessageEmpty é rejeitada');

        // Contrato 9: Episódio 1 com mídia válida permanece visível
        const singleEpSeason = [{ numero: 1, isDublado: true, messageId: 201 }];
        const resSingle = CatalogoManager.normalizeSeasonEpisodes(singleEpSeason, 1);
        assert(resSingle !== null && resSingle.totalEpisodios === 1, '9. Episódio 1 com mídia válida permanece visível');

        // Contrato 10: Episódio 1 com mídia deletada + Ep 2 válido -> Temporada oculta por falta de Ep 1 válido
        const deadE1Season = [
            { numero: 1, isDublado: true, messageId: 315641 }, // MISSING
            { numero: 2, isDublado: true, messageId: 402 }     // VERIFIED
        ];
        const resDeadE1 = CatalogoManager.normalizeSeasonEpisodes(deadE1Season, 1);
        assert(resDeadE1 === null, '10. Temporada com Ep 1 deletado (MISSING) deve ficar totalmente oculta');

        // Contrato 11: Ep 1 válido + Ep 2 válido + Ep 6 válido -> apenas Ep 1 e Ep 2 são expostos
        const gapSeason = [
            { numero: 1, isDublado: true, messageId: 401 },
            { numero: 2, isDublado: true, messageId: 402 },
            { numero: 6, isDublado: true, messageId: 506 }
        ];
        const resGap = CatalogoManager.normalizeSeasonEpisodes(gapSeason, 1);
        assert(resGap !== null && resGap.totalEpisodios === 2, '11. Apenas E1 e E2 são expostos em temporada com gap');
        assert(resGap.episodios.some(e => e.numero === 6) === false, '11b. Episódio 6 após o gap foi omitido');

        // Contrato 12: Proteção de deleção contra messageId + 1 permanece intacta
        const deletedIdsCollector = [];
        const mockSafeStorageUploader = new TelegramUploader();
        mockSafeStorageUploader.getClient = async () => ({
            deleteMessages: async (peer, ids) => {
                deletedIdsCollector.push(...ids);
                return true;
            }
        });
        await mockSafeStorageUploader.deleteStorageMessages(500);
        assert(deletedIdsCollector.length === 1 && deletedIdsCollector[0] === 500, '12. Deletar 500 deve deletar APENAS 500');
        assert(deletedIdsCollector.includes(501) === false, '12b. Deletar 500 NUNCA deve tocar no 501');

        // Teste 22: Isolamento Estrito de Versões de Áudio e Verificador Periódico
        console.log('\n--- Teste 22: Isolamento de Versões de Áudio e Verificador Periódico ---');

        CatalogoManager.mediaVerificationCache.set(500, 'VERIFIED_PLAYABLE', { docId: 'doc_500' });
        CatalogoManager.mediaVerificationCache.set(501, 'VERIFIED_PLAYABLE', { docId: 'doc_501' });

        // 22.1 Versão dublada vazia explícita + legendada válida com ep.messageId = 500
        const epExplicitEmptyDub = {
            isDublado: true,
            isLegendado: true,
            messageId: 500,
            versoes: {
                dublado: {},
                legendado: { messageId: 500 }
            }
        };
        assert(CatalogoManager.hasValidDubbedMedia(epExplicitEmptyDub) === false, '22.1 Dublado explícito vazio NÃO pode herdar ep.messageId do legendado');
        assert(CatalogoManager.hasValidSubtitledMedia(epExplicitEmptyDub) === true, '22.1b Legendado válido deve permanecer disponível');

        // 22.2 Versão legendada vazia explícita + dublada válida com ep.messageId = 500
        const epExplicitEmptyLeg = {
            isDublado: true,
            isLegendado: true,
            messageId: 500,
            versoes: {
                dublado: { messageId: 500 },
                legendado: {}
            }
        };
        assert(CatalogoManager.hasValidDubbedMedia(epExplicitEmptyLeg) === true, '22.2 Dublado válido deve permanecer disponível');
        assert(CatalogoManager.hasValidSubtitledMedia(epExplicitEmptyLeg) === false, '22.2b Legendado explícito vazio NÃO pode herdar ep.messageId do dublado');

        // 22.3 Ambas versões válidas explicitamente
        const epBothValid = {
            versoes: {
                dublado: { messageId: 500 },
                legendado: { messageId: 501 }
            }
        };
        assert(CatalogoManager.hasValidDubbedMedia(epBothValid) === true, '22.3 Ambas versões válidas: Dublado disponível');
        assert(CatalogoManager.hasValidSubtitledMedia(epBothValid) === true, '22.3b Ambas versões válidas: Legendado disponível');

        // 22.4 Registro legado sem versoes
        const epLegacy = {
            isDublado: true,
            isLegendado: false,
            messageId: 500
        };
        assert(CatalogoManager.hasValidDubbedMedia(epLegacy) === true, '22.4 Registro legado sem versoes deve usar fallback do messageId');
        assert(CatalogoManager.hasValidSubtitledMedia(epLegacy) === false, '22.4b Registro legado não-legendado deve ser false');

        // 22.5 Testes do Verificador Periódico (startPeriodicRevalidation e revalidateCachedMedia)
        const catMgrInstance = new CatalogoManager();
        catMgrInstance.startPeriodicRevalidation(60000);
        const timer1 = CatalogoManager._periodicRevalidationTimer;
        catMgrInstance.startPeriodicRevalidation(60000);
        const timer2 = CatalogoManager._periodicRevalidationTimer;
        assert(timer1 === timer2 && timer1 !== null, '22.5 startPeriodicRevalidation deve ser singleton e não criar timers duplicados');

        // 22.6 Mutex contra execuções sobrepostas
        CatalogoManager._isPeriodicRevalidating = true;
        let queryAttemptedWhileLocked = false;
        const origUploaderInst = TelegramUploader.getInstance();
        const origGetStorageMsgs = origUploaderInst.getStorageMessages;
        try {
            origUploaderInst.getStorageMessages = async () => {
                queryAttemptedWhileLocked = true;
                return new Map();
            };
            await catMgrInstance.revalidateCachedMedia();
            assert(queryAttemptedWhileLocked === false, '22.6 Revalidação periódica NÃO deve executar se já houver job em andamento (mutex)');
        } finally {
            CatalogoManager._isPeriodicRevalidating = false;
            origUploaderInst.getStorageMessages = origGetStorageMsgs;
        }

        // 22.7 Preservação de estado em caso de erro temporário de rede
        CatalogoManager.mediaVerificationCache.set(600, 'VERIFIED_PLAYABLE', { docId: 'doc_600' });
        try {
            origUploaderInst.getStorageMessages = async () => {
                const map = new Map();
                map.set(600, { status: 'ERROR', error: 'Network timeout' });
                return map;
            };
            await catMgrInstance.revalidateCachedMedia();
            const stateAfterNetErr = CatalogoManager.getMediaVerificationState(600);
            assert(stateAfterNetErr === 'VERIFIED_PLAYABLE', '22.7 Erro transitório de rede DEVE preservar o estado previamente verificado');
        } finally {
            origUploaderInst.getStorageMessages = origGetStorageMsgs;
        }

        // 22.8 Invalidação definitiva e trigger de rebuild
        let catalogRebuilt = false;
        catMgrInstance.loadCatalogo = async () => { catalogRebuilt = true; };
        try {
            origUploaderInst.getStorageMessages = async () => {
                const map = new Map();
                map.set(600, { status: 'NOT_FOUND', error: 'MessageEmpty' });
                return map;
            };
            await catMgrInstance.revalidateCachedMedia();
            const stateAfterDeleted = CatalogoManager.getMediaVerificationState(600);
            assert(stateAfterDeleted === 'MISSING', '22.8 Mídia confirmadamente deletada deve se tornar MISSING');
            assert(catalogRebuilt === true, '22.8b Invalidação definitiva DEVE disparar reconstrução do catálogo público');
        } finally {
            origUploaderInst.getStorageMessages = origGetStorageMsgs;
            catMgrInstance.stopPeriodicRevalidation();
        }

        console.log('\n====================================================');
        console.log('🎉 TODOS OS 22 TESTES DE REGRESSÃO, INTEGRIDADE E CONTRATOS PASSARAM COM SUCESSO!');
        console.log('====================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NO TESTE:', err);
        process.exit(1);
    }
})();
