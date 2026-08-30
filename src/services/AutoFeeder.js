const cron = require('node-cron');
const config = require('../../config');
const TMDBService = require('./TMDBService');
const MediaSearchService = require('./MediaSearchService');
const SwarmWatcher = require('./SwarmWatcher');
const DiskCleaner = require('./DiskCleaner');
const SchedulerService = require('./SchedulerService');
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

        // Executa uma verificação inicial após 8 segundos de inicialização se estiver no horário permitido
        setTimeout(() => {
            this.runCheck();
        }, 8000);

        // Notificação em tempo real quando o agendador autorizar o início dos downloads (01h ou force-start)
        SchedulerService.on('stateChange', ({ allowed }) => {
            if (allowed) {
                console.log('⏰ [Scheduler -> AutoFeeder] Janela aberta ou force-start acionado! Disparando busca de novos episódios e pedidos...');
                setTimeout(() => this.runCheck(), 3000);
            }
        });

        // Verificação periódica a cada 30 minutos enquanto estiver dentro da janela permitida
        setInterval(() => {
            if (SchedulerService.isAllowedToRun()) {
                console.log('⏰ [AutoFeeder] Varredura periódica da janela ativa...');
                this.runCheck();
            }
        }, 30 * 60 * 1000);

        // Agendamento leve a cada 2 horas (mesmo fora do horário, apenas checa metadados leves no TMDB)
        cron.schedule('0 */2 * * *', () => {
            if (SchedulerService.isAllowedToRun()) {
                console.log('⏰ AutoFeeder: Ciclo de varredura completa...');
                this.runCheck();
            } else {
                console.log('🔍 [AutoFeeder Off-Hours] Varredura leve de metadados (TMDB/Pedidos/Upgrades) em segundo plano...');
                this.runLightweightBackgroundCheck();
            }
        });
    }

    async runLightweightBackgroundCheck() {
        if (this.isRunningCheck) return;
        this.isRunningCheck = true;
        try {
            // 1. Reprocessar Pedidos Pendentes de Clientes (coloca na fila para quando abrir a janela)
            await this.checkPendingPedidos();

            // 2. Verificar se filmes de cinema (CAM) ganharam versão oficial WEB-DL no TMDB
            if (config.AUTO_UPGRADE_CAM) {
                await this.checkCamUpgrades();
            }

            // 3. Checar upgrades de dublagens e legendas para deixar na fila
            await this.checkLegendadoUpgrades();
            await this.checkSeriesDubladoUpgrades();
            await this.checkSeriesLegendadoUpgrades();
        } catch (e) {
            console.warn('⚠️ Erro na checagem leve de metadados:', e.message);
        } finally {
            this.isRunningCheck = false;
        }
    }

    async runCheck() {
        if (this.isRunningCheck) return;
        if (!SchedulerService.isAllowedToRun()) {
            console.log('⏰ [Scheduler SP] AutoFeeder em repouso: fora da janela de download (Horário de SP).');
            return;
        }
        this.isRunningCheck = true;

        try {
            // 0. Checa sementes de itens monitorados na watchlist
            await SwarmWatcher.checkWatchlist();

            // 1. Reprocessar Pedidos Pendentes de Clientes (Prioridade máxima)
            await this.checkPendingPedidos();

            // 2. Prioridade Total: Preencher episódios faltantes e novas temporadas de Séries já iniciadas no Catálogo
            console.log('📺 AutoFeeder: Verificando episódios pendentes de séries já no catálogo...');
            await this.checkSeriesUpdates();

            // 3. Auto-Upgrade: Verificar se filmes de cinema já possuem versão oficial WEB-DL/BluRay
            if (config.AUTO_UPGRADE_CAM) {
                await this.checkCamUpgrades();
            }

            // 4. Auto-Upgrade: Verificar se filmes apenas Legendados já ganharam versão Dublada (PT-BR)
            await this.checkLegendadoUpgrades();

            // 4.1 Auto-Upgrade: Verificar se episódios de séries apenas Legendados já ganharam versão Dublada (PT-BR)
            await this.checkSeriesDubladoUpgrades();

            // 4.2 Auto-Upgrade: Verificar se episódios de séries apenas Dublados também ganham versão Legendada oficial
            await this.checkSeriesLegendadoUpgrades();

            // 4.3 Auto-Upgrade: Verificar se filmes apenas Dublados também ganham versão Legendada oficial
            await this.checkFilmesDubladosSemLegenda();

            // Em modo econômico residencial: não introduz grandes lotes de novos títulos do TMDB
            const isEco = SchedulerService.getActiveMode() === 'eco';
            if (isEco) {
                return;
            }

            console.log('🔍 AutoFeeder: Consultando conteúdos em alta no TMDB para preenchimento equilibrado...');

            const moviesInQueue = (this.queueManager.queue || []).filter(j => j.type === 'filme' && j.status === 'queued');
            const seriesInQueue = (this.queueManager.queue || []).filter(j => j.type === 'serie' && !j.isDorama && !j.extraData?.isDorama && j.status === 'queued');
            const doramasInQueue = (this.queueManager.queue || []).filter(j => (j.isDorama || j.extraData?.isDorama) && j.status === 'queued');

            // 6. Filmes em alta (mantém cota independente para Faixa 1)
            if (moviesInQueue.length < 6) {
                const trendingMovies = await TMDBService.getTrendingMovies('week');
                for (const movie of trendingMovies.slice(0, 8)) {
                    await this.considerItem(movie, 'filme');
                }
            }

            // 7. Doramas populares (mantém cota independente para Faixa 4)
            if (doramasInQueue.length < 6) {
                const popularDoramas = await TMDBService.getPopularKDramas();
                for (const dorama of popularDoramas.slice(0, 6)) {
                    await this.considerItem(dorama, 'serie', true);
                }
            }

            // 7.1 Microdramas Chineses Verticais (Duanju 9:16) em Alta (Fila 2 / Background)
            await this.checkMicrodramasFeed();

            // 8. Séries ocidentais em alta (mantém cota independente para Faixa 3)
            if (seriesInQueue.length < 6) {
                const trendingTV = await TMDBService.getTrendingTV('week');
                for (const tv of trendingTV.slice(0, 3)) {
                    await this.considerItem(tv, 'serie');
                }
            }

        } catch (error) {
            console.error('❌ Erro no ciclo do AutoFeeder:', error.message);
        } finally {
            this.isRunningCheck = false;
        }
    }

    async checkMicrodramasFeed() {
        try {
            const MicrodramaService = require('./MicrodramaService');
            const microdramasInQueue = (this.queueManager.queue || []).filter(j => 
                (j.subtipo === 'microdrama' || j.extraData?.subtipo === 'microdrama' || j.extraData?.isMicrodrama) && j.status === 'queued'
            );

            if (microdramasInQueue.length >= 4) return;

            console.log('📱 AutoFeeder: Avaliando microdramas populares/em alta (短剧 / Duanju 9:16)...');
            const trending = await MicrodramaService.getTrendingMicrodramas(8);

            for (const md of trending) {
                const existente = this.catalogoManager.buscarItemExato(md.nome, 'serie');
                if (existente) continue;

                const inQueue = this.queueManager.queue.some(j => 
                    j.title.toLowerCase() === md.nome.toLowerCase() && j.status !== 'failed'
                );
                if (inQueue) continue;

                console.log(`📱 [AutoFeeder Duanju] Enfileirando microdrama em alta: "${md.nome}" (${md.plataformaOrigem || 'Duanju'}) [Prioridade: ${PRIORITIES.MICRODRAMA}]`);
                this.queueManager.addJob(md.nome, 'serie', PRIORITIES.MICRODRAMA, {
                    tmdbId: null,
                    nomeOriginal: md.nomeOriginal,
                    season: 1,
                    episode: 1,
                    totalEpisodiosEsperados: md.totalEpisodios,
                    isDorama: true,
                    isMicrodrama: true,
                    subtipo: 'microdrama',
                    formato: 'vertical',
                    origem: md.origem || 'China',
                    plataformaOrigem: md.plataformaOrigem || 'DramaBox',
                    trendingScore: md.trendingScore || 95.0,
                    audioPreference: md.isDublado ? 'dublado' : 'legendado'
                });
                break;
            }
        } catch (e) {
            console.warn('⚠️ Erro ao verificar microdramas no AutoFeeder:', e.message);
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
                    await this.pedidosManager.marcarComoProcessado(pedido.id);
                } else {
                    await this.pedidosManager.marcarComoProcessado(pedido.id);
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
                            ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                        );

                        if (!jaNaFila) {
                            console.log(`🌟 NOVO EPISÓDIO DETECTADO: "${serie.nome}" T${sNum}E${proximoEpFaltante.numero} ("${proximoEpFaltante.nome}")! Enfileirando download...`);
                            this.queueManager.addJob(serie.nome, 'serie', PRIORITIES.SERIES, {
                                tmdbId: tmdbData.tmdbId,
                                season: sNum,
                                episode: proximoEpFaltante.numero,
                                nomeOriginal: serie.nomeOriginal,
                                isDorama: serie.isDorama,
                                queueOrder: -1
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

            console.log(`🔄 AutoFeeder: Verificando possíveis upgrades 1080p para ${camMovies.length} filme(s) em qualidade de Cinema (Prioridade: CAM Upgrade)...`);

            for (const filme of camMovies) {
                const jaNaFila = (this.queueManager?.queue || []).some(j => 
                    j.type === 'filme' && 
                    j.title.toLowerCase() === filme.nome.toLowerCase() && 
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );
                if (jaNaFila) continue;

                const sources = await MediaSearchService.search(filme.nome, 'filme', {
                    nomeOriginal: filme.nomeOriginal,
                    ano: filme.ano,
                    onlyWebDl: true,
                    forcarNaoCam: true,
                    audioPreference: filme.isDublado ? 'dublado' : 'legendado'
                });

                const officialSource = sources.find(s => (s.isWebDl || !s.isCam) && (s.seeders || 0) > 0);
                if (officialSource) {
                    console.log(`🌟 UPGRADE OFICIAL 1080p ENCONTRADO para "${filme.nome}"! Fonte: ${officialSource.title} (Prioridade: CAM Upgrade)`);
                    const camPriority = PRIORITIES.CAM_UPGRADE || 2;
                    this.queueManager.addJob(filme.nome, 'filme', camPriority, {
                        tmdbId: filme.tmdbId,
                        isUpgrade: true,
                        allowCam: false,
                        audioPreference: filme.isDublado ? 'dublado' : 'legendado',
                        queueOrder: -1
                    });
                }
                await new Promise(r => setTimeout(r, 300));
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
                const jaNaFila = (this.queueManager?.queue || []).some(j => 
                    j.type === 'filme' && 
                    j.title.toLowerCase() === filme.nome.toLowerCase() && 
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );
                if (jaNaFila) continue;

                const sources = await MediaSearchService.search(filme.nome, 'filme', {
                    nomeOriginal: filme.nomeOriginal,
                    ano: filme.ano,
                    audioPreference: 'dublado'
                });

                const dubladaSource = sources.find(s => s.isDublado && s.seeders > 0);
                if (dubladaSource) {
                    console.log(`🌟 VERSÃO DUBLADA ENCONTRADA para "${filme.nome}"! Fonte: ${dubladaSource.title}`);
                    const dubPriority = PRIORITIES.UPGRADE_DUB || 4;
                    this.queueManager.addJob(filme.nome, 'filme', dubPriority, {
                        tmdbId: filme.tmdbId,
                        audioPreference: 'dublado',
                        isUpgrade: true
                    });
                }
                // Pausa suave para não congestionar requisições DNS/HTTP
                await new Promise(r => setTimeout(r, 300));
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de dublagem:', e.message);
        }

    }

    async checkSeriesDubladoUpgrades() {
        try {
            const pendentes = this.catalogoManager.buscarEpisodiosApenasLegendados();
            if (pendentes.length === 0) return;

            // Agrupa por série e temporada para processar na ordem cronológica (E1, E2, E3...)
            const seriesMap = {};
            for (const p of pendentes) {
                const key = `${p.serieNome}_s${p.season}`;
                if (!seriesMap[key]) seriesMap[key] = [];
                seriesMap[key].push(p);
            }

            console.log(`🎙️ AutoFeeder: Verificando upgrades para DUBLADO em ${Object.keys(seriesMap).length} temporada(s) com episódios apenas legendados...`);

            for (const [key, epsList] of Object.entries(seriesMap)) {
                // Ordena por número do episódio
                epsList.sort((a, b) => a.episode - b.episode);
                const primeiroPendente = epsList[0];

                const jaNaFila = (this.queueManager.queue || []).some(j =>
                    j.type === 'serie' &&
                    j.title.toLowerCase() === primeiroPendente.serieNome.toLowerCase() &&
                    j.season === primeiroPendente.season &&
                    j.episode === primeiroPendente.episode &&
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );

                if (!jaNaFila) {
                    console.log(`🔄 [UPGRADE DUBLADO] Enfileirando busca de versão Dublada para "${primeiroPendente.serieNome}" T${primeiroPendente.season}E${primeiroPendente.episode} (atualmente apenas Legendado)...`);
                    const dubPriority = PRIORITIES.UPGRADE_DUB || 4;
                    this.queueManager.addJob(primeiroPendente.serieNome, 'serie', dubPriority, {
                        tmdbId: primeiroPendente.tmdbId,
                        imdbId: primeiroPendente.imdbId,
                        season: primeiroPendente.season,
                        episode: primeiroPendente.episode,
                        audioPreference: 'dublado',
                        isUpgrade: true,
                        nomeOriginal: primeiroPendente.nomeOriginal,
                        isDorama: primeiroPendente.isDorama,
                        isAnime: primeiroPendente.isAnime
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de dublagem para séries no AutoFeeder:', e.message);
        }
    }

    async checkSeriesLegendadoUpgrades() {
        try {
            const pendentes = this.catalogoManager.buscarEpisodiosApenasDublados();
            if (pendentes.length === 0) return;

            // Agrupa por série e temporada para processar na ordem cronológica (E1, E2, E3...)
            const seriesMap = {};
            for (const p of pendentes) {
                const key = `${p.serieNome}_s${p.season}`;
                if (!seriesMap[key]) seriesMap[key] = [];
                seriesMap[key].push(p);
            }

            console.log(`💬 AutoFeeder: Verificando upgrades para LEGENDADO em ${Object.keys(seriesMap).length} temporada(s) com episódios sem legenda...`);

            for (const [key, epsList] of Object.entries(seriesMap)) {
                epsList.sort((a, b) => a.episode - b.episode);
                const primeiroPendente = epsList[0];

                const jaNaFila = (this.queueManager.queue || []).some(j =>
                    j.type === 'serie' &&
                    j.title.toLowerCase() === primeiroPendente.serieNome.toLowerCase() &&
                    j.season === primeiroPendente.season &&
                    j.episode === primeiroPendente.episode &&
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );

                if (!jaNaFila) {
                    console.log(`🔄 [UPGRADE LEGENDADO] Enfileirando busca de versão Legendada para "${primeiroPendente.serieNome}" T${primeiroPendente.season}E${primeiroPendente.episode} (atualmente apenas Dublado)...`);
                    this.queueManager.addJob(primeiroPendente.serieNome, 'serie', PRIORITIES.SERIES || 3, {
                        tmdbId: primeiroPendente.tmdbId,
                        imdbId: primeiroPendente.imdbId,
                        season: primeiroPendente.season,
                        episode: primeiroPendente.episode,
                        audioPreference: 'legendado',
                        isUpgrade: true,
                        nomeOriginal: primeiroPendente.nomeOriginal,
                        isDorama: primeiroPendente.isDorama,
                        isAnime: primeiroPendente.isAnime
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de legendas para séries no AutoFeeder:', e.message);
        }
    }

    async checkFilmesDubladosSemLegenda() {
        try {
            const apenasDublados = this.catalogoManager.buscarFilmesApenasDublados();
            if (apenasDublados.length === 0) return;

            for (const filme of apenasDublados.slice(0, 3)) {
                const jaNaFila = (this.queueManager.queue || []).some(j =>
                    j.type === 'filme' &&
                    j.title.toLowerCase() === filme.nome.toLowerCase() &&
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );

                if (!jaNaFila && filme.imdbId) {
                    const sources = await MediaSearchService.search(filme.nome, 'filme', {
                        nomeOriginal: filme.nomeOriginal,
                        ano: filme.ano,
                        imdbId: filme.imdbId,
                        audioPreference: 'legendado'
                    });

                    const legSource = sources.find(s => s.isLegendado && s.seeders > 0);
                    if (legSource) {
                        console.log(`🌟 VERSÃO LEGENDADA ENCONTRADA para "${filme.nome}"! Fonte: ${legSource.title}`);
                        this.queueManager.addJob(filme.nome, 'filme', PRIORITIES.SERIES || 3, {
                            tmdbId: filme.tmdbId,
                            imdbId: filme.imdbId,
                            audioPreference: 'legendado',
                            isUpgrade: true
                        });
                    }
                    await new Promise(r => setTimeout(r, 300));
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de filmes para legendado:', e.message);
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

        // 2. Filtrar conteúdos futuros que ainda não estrearam (filmes antes da data de estreia mundial são 100% fakes/scams)
        const nowStr = new Date().toISOString().split('T')[0];
        if (item.dataLancamento && item.dataLancamento > nowStr) {
            return;
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
