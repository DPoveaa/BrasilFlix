const cron = require('node-cron');
const config = require('../../config');
const TMDBService = require('./TMDBService');
const MediaSearchService = require('./MediaSearchService');
const SwarmWatcher = require('./SwarmWatcher');
const DiskCleaner = require('./DiskCleaner');
const { PRIORITIES } = require('../managers/QueueManager');

class AutoFeeder {
    constructor(queueManager, catalogoManager, pedidosManager = null) {
        this.queueManager = queueManager;
        this.catalogoManager = catalogoManager;
        this.pedidosManager = pedidosManager;
        this.isEnabled = config.AUTO_FEEDER_ENABLED !== false;
        this.isRunningCheck = false;
    }

    start() {
        if (!this.isEnabled) {
            console.log('💤 AutoFeeder desativado na configuração.');
            return;
        }

        console.log('🤖 AutoFeeder ativado! Monitorando pedidos de clientes, lançamentos e episódios semanais...');

        // Inicializa o Monitor de Sementes e Watchlist de Torrents (a cada 3 minutos)
        SwarmWatcher.init(this.queueManager, this.catalogoManager);
        SwarmWatcher.startWatchCycle(3 * 60 * 1000);

        // Inicializa o Auto-Cleaner de Disco (remove arquivos órfãos > 30 min)
        DiskCleaner.startAutoCleanup(() => this.queueManager.getActiveFiles(), 45 * 60 * 1000);

        // Executa uma verificação inicial após 8 segundos de inicialização
        setTimeout(() => {
            this.runCheck();
        }, 8000);

        // Agendamento periódico: roda a cada 4 horas
        cron.schedule('0 */4 * * *', () => {
            console.log('⏰ AutoFeeder: Iniciando ciclo de varredura periódica...');
            this.runCheck();
        });
    }

    async runCheck() {
        if (this.isRunningCheck) return;
        this.isRunningCheck = true;

        try {
            // 0. Checa sementes de itens monitorados na watchlist
            await SwarmWatcher.checkWatchlist();

            // 1. Reprocessar Pedidos Pendentes de Clientes (ex: The Rookie, pedidos que ainda não foram concluídos)
            await this.checkPendingPedidos();

            console.log('🔍 AutoFeeder: Consultando conteúdos em alta no TMDB...');

            // 2. Filmes em alta
            const trendingMovies = await TMDBService.getTrendingMovies('week');
            for (const movie of trendingMovies.slice(0, 15)) {
                await this.considerItem(movie, 'filme');
            }

            // 3. Séries em alta
            const trendingTV = await TMDBService.getTrendingTV('week');
            for (const tv of trendingTV.slice(0, 10)) {
                await this.considerItem(tv, 'serie');
            }

            // 4. Doramas populares (K-Dramas)
            const popularDoramas = await TMDBService.getPopularKDramas();
            for (const dorama of popularDoramas.slice(0, 10)) {
                await this.considerItem(dorama, 'serie', true);
            }

            // 5. Auto-Upgrade: Verificar se filmes de cinema já possuem versão oficial WEB-DL/BluRay
            if (config.AUTO_UPGRADE_CAM) {
                await this.checkCamUpgrades();
            }

            // 6. Auto-Upgrade: Verificar se filmes apenas Legendados já ganharam versão Dublada (PT-BR)
            await this.checkLegendadoUpgrades();

            // 7. Monitor de Lançamentos Semanais / Novas Temporadas de Séries do Catálogo
            await this.checkSeriesUpdates();

        } catch (error) {
            console.error('❌ Erro no ciclo do AutoFeeder:', error.message);
        } finally {
            this.isRunningCheck = false;
        }
    }

    async checkPendingPedidos() {
        try {
            if (!this.pedidosManager) return;
            const pedidosPendentes = (this.pedidosManager.getPedidos() || []).filter(p => !p.processado);
            if (pedidosPendentes.length === 0) return;

            console.log(`📋 AutoFeeder: Verificando ${pedidosPendentes.length} pedido(s) pendente(s) de clientes...`);

            for (const pedido of pedidosPendentes) {
                const title = pedido.nome;
                if (!title) continue;

                // Verifica se já existe no catálogo
                const filmeExistente = this.catalogoManager.buscarItemExato(title, 'filme');
                const serieExistente = this.catalogoManager.buscarItemExato(title, 'serie');

                if (filmeExistente) {
                    await this.pedidosManager.marcarComoProcessado(pedido.id);
                    continue;
                }

                if (serieExistente) {
                    let totalEpsTemp1 = 10;
                    try {
                        if (serieExistente.tmdbId) {
                            const sDetails = await TMDBService.getSeasonDetails(serieExistente.tmdbId, 1);
                            if (sDetails?.episodios?.length > 0) {
                                totalEpsTemp1 = sDetails.episodios.length;
                            }
                        }
                    } catch (e) {}

                    const temp1 = (serieExistente.temporadas || []).find(t => t.numero === 1);
                    const epsCadastrados = temp1 ? (temp1.episodios || []).length : 0;

                    if (epsCadastrados >= totalEpsTemp1 && totalEpsTemp1 > 0) {
                        await this.pedidosManager.marcarComoProcessado(pedido.id);
                        continue;
                    }
                }

                // Detecta tipo no TMDB
                let tipo = 'filme';
                let tmdbId = null;
                let originalName = '';
                try {
                    const searchResults = await TMDBService.searchMulti(title);
                    if (searchResults && searchResults.length > 0) {
                        tipo = searchResults[0].tipo === 'serie' ? 'serie' : 'filme';
                        tmdbId = searchResults[0].tmdbId;
                        originalName = searchResults[0].nomeOriginal || '';
                    }
                } catch (e) {}

                const priority = pedido.isAssinante ? PRIORITIES.VIP_USER : PRIORITIES.USER;

                const inQueue = this.queueManager.queue.some(j => 
                    j.title.toLowerCase() === title.toLowerCase() && j.status !== 'failed'
                );

                if (!inQueue) {
                    console.log(`🚀 [PEDIDO PENDENTE] Enfileirando pedido prioritário de cliente: "${title}" (${tipo}) [Prioridade: ${priority}]`);
                    this.queueManager.addJob(title, tipo, priority, {
                        userId: pedido.userId,
                        username: pedido.username,
                        tmdbId,
                        nomeOriginal: originalName,
                        season: tipo === 'serie' ? 1 : null,
                        episode: tipo === 'serie' ? 1 : null
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao reprocessar pedidos pendentes no AutoFeeder:', e.message);
        }
    }

    async checkSeriesUpdates() {
        try {
            const seriesList = this.catalogoManager.catalogo.series || [];
            if (seriesList.length === 0) return;

            console.log(`📺 AutoFeeder: Verificando lançamentos e episódios semanais para ${seriesList.length} série(s) do catálogo...`);

            for (const serie of seriesList) {
                let tmdbData = null;
                if (serie.tmdbId) {
                    tmdbData = await TMDBService.getTVDetails(serie.tmdbId);
                } else {
                    const search = await TMDBService.searchTV(serie.nome, serie.ano);
                    if (search && search.length > 0) {
                        tmdbData = await TMDBService.getTVDetails(search[0].tmdbId);
                    }
                }

                if (!tmdbData || !tmdbData.temporadas) continue;

                const hoje = new Date().toISOString().split('T')[0];

                for (const t of tmdbData.temporadas) {
                    const sNum = t.numero;
                    if (sNum <= 0) continue;

                    const seasonDetail = await TMDBService.getSeasonDetails(tmdbData.tmdbId, sNum);
                    if (!seasonDetail || !seasonDetail.episodios) continue;

                    const epsLancados = seasonDetail.episodios.filter(ep => ep.dataLancamento && ep.dataLancamento <= hoje);
                    const tempNoCatalogo = (serie.temporadas || []).find(temp => temp.numero === sNum);
                    const epsNoCatalogo = new Set((tempNoCatalogo?.episodios || []).map(e => e.numero));

                    const proximoEpFaltante = epsLancados.find(ep => !epsNoCatalogo.has(ep.numero));

                    if (proximoEpFaltante) {
                        const jaNaFila = this.queueManager.queue.some(j => 
                            j.type === 'serie' && 
                            j.title.toLowerCase() === serie.nome.toLowerCase() && 
                            j.season === sNum && 
                            j.episode === proximoEpFaltante.numero &&
                            j.status !== 'failed'
                        );

                        if (!jaNaFila) {
                            console.log(`🌟 NOVO EPISÓDIO DETECTADO: "${serie.nome}" T${sNum}E${proximoEpFaltante.numero} ("${proximoEpFaltante.nome}")! Enfileirando download...`);
                            this.queueManager.addJob(serie.nome, 'serie', PRIORITIES.FEEDER, {
                                tmdbId: tmdbData.tmdbId,
                                season: sNum,
                                episode: proximoEpFaltante.numero,
                                nomeOriginal: serie.nomeOriginal,
                                isDorama: serie.isDorama
                            });
                            break;
                        }
                    }
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar episódios de séries no AutoFeeder:', e.message);
        }
    }

    async checkCamUpgrades() {
        try {
            const camMovies = this.catalogoManager.buscarFilmesCam();
            if (camMovies.length === 0) return;

            console.log(`🔄 AutoFeeder: Verificando possíveis upgrades para ${camMovies.length} filme(s) em qualidade de Cinema...`);

            for (const filme of camMovies) {
                const sources = await MediaSearchService.search(filme.nome, 'filme', {
                    nomeOriginal: filme.nomeOriginal,
                    ano: filme.ano,
                    onlyWebDl: true
                });

                const officialSource = sources.find(s => s.isWebDl && s.seeders > 0);
                if (officialSource) {
                    console.log(`🌟 UPGRADE ENCONTRADO para "${filme.nome}"! Fonte Oficial: ${officialSource.title}`);
                    this.queueManager.addJob(filme.nome, 'filme', 2, {
                        tmdbId: filme.tmdbId,
                        isUpgrade: true,
                        allowCam: false
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de cinema:', e.message);
        }
    }

    async checkLegendadoUpgrades() {
        try {
            const apenasLegendados = this.catalogoManager.buscarFilmesApenasLegendados();
            if (apenasLegendados.length === 0) return;

            console.log(`🎙️ AutoFeeder: Verificando se ${apenasLegendados.length} filme(s) apenas legendado(s) já ganharam versão DUBLADA...`);

            for (const filme of apenasLegendados) {
                const sources = await MediaSearchService.search(filme.nome, 'filme', {
                    nomeOriginal: filme.nomeOriginal,
                    ano: filme.ano,
                    audioPreference: 'dublado'
                });

                const dubladaSource = sources.find(s => s.isDublado && s.seeders > 0);
                if (dubladaSource) {
                    console.log(`🌟 VERSÃO DUBLADA ENCONTRADA para "${filme.nome}"! Fonte: ${dubladaSource.title}`);
                    this.queueManager.addJob(filme.nome, 'filme', 2, {
                        tmdbId: filme.tmdbId,
                        audioPreference: 'dublado',
                        isUpgrade: true
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de dublagem:', e.message);
        }
    }

    async considerItem(item, tipo, isDorama = false) {
        const title = item.nome;
        if (!title) return;

        // 1. Filtrar títulos em idiomas asiáticos sem tradução/ocidentalização
        if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/.test(title)) {
            // Se o título está em caracteres coreanos/chineses puros e não tem título em português legível
            if (!item.nomeOriginal || /[\uac00-\ud7af]/.test(item.nomeOriginal)) {
                return;
            }
        }

        // 2. Filtrar conteúdos futuros que ainda não estrearam em streaming/digital
        const nowStr = new Date().toISOString().split('T')[0];
        if (item.dataLancamento && item.dataLancamento > nowStr) {
            // Se for filme futuro não lançado, não enfileira
            if (!config.ALLOW_CINEMA_CAM) {
                return;
            }
        }

        const existing = this.catalogoManager.buscarItemExato(title, tipo);
        if (existing) {
            return;
        }

        const inQueue = this.queueManager.queue.some(j => 
            j.title.toLowerCase() === title.toLowerCase() && j.status !== 'failed'
        );

        if (inQueue) {
            return;
        }

        console.log(`✨ AutoFeeder adicionando à fila de background: "${title}" (${tipo}${isDorama ? ' - Dorama' : ''})`);

        this.queueManager.addJob(title, tipo, PRIORITIES.FEEDER, {
            tmdbId: item.tmdbId,
            isDorama: isDorama,
            season: 1,
            episode: tipo === 'serie' ? 1 : null
        });
    }
}

module.exports = AutoFeeder;
