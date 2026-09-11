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

        // Gerenciamento de ciclo dinâmico do AutoFeeder:
        // - Modo Performance (Madrugada/Forçado): A cada 15 minutos (esteira ultra rápida para alimentar downloads e uploads)
        // - Modo Econômico (Horário Comercial/Residencial): A cada 4 horas (varredura leve e silenciosa)
        this.feederTimer = null;

        const scheduleNextCycle = () => {
            if (this.feederTimer) {
                clearTimeout(this.feederTimer);
                this.feederTimer = null;
            }

            const mode = SchedulerService.getActiveMode();
            const intervalMs = mode === 'performance' ? (15 * 60 * 1000) : (4 * 60 * 60 * 1000);
            const modeDesc = mode === 'performance' ? '⚡ DESEMPENHO (Ciclo: 15 min)' : '🍃 ECONÔMICO (Ciclo: 4 horas)';
            console.log(`⏱️ [AutoFeeder Agendador] Próxima varredura configurada para modo ${modeDesc}.`);

            this.feederTimer = setTimeout(async () => {
                if (SchedulerService.isAllowedToRun()) {
                    console.log(`⏰ [AutoFeeder] Iniciando varredura periódica (${modeDesc})...`);
                    await this.runCheck().catch(() => {});
                } else {
                    console.log('🔍 [AutoFeeder Off-Hours] Varredura leve de metadados em segundo plano...');
                    await this.runLightweightBackgroundCheck().catch(() => {});
                }
                scheduleNextCycle();
            }, intervalMs);
        };

        // Notificação em tempo real quando o agendador alterar o modo ou abrir a janela
        SchedulerService.on('stateChange', ({ allowed, mode }) => {
            console.log(`⏰ [Scheduler -> AutoFeeder] Mudança de estado detectada: Modo = ${mode || SchedulerService.getActiveMode()} (Permitido: ${allowed})`);
            scheduleNextCycle();
            if (allowed) {
                console.log('🚀 [AutoFeeder] Disparando busca imediata de novos episódios e pedidos...');
                setTimeout(() => this.runCheck(), 3000);
            }
        });

        // Inicia o primeiro ciclo de agendamento dinâmico
        scheduleNextCycle();
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

            console.log('🔍 AutoFeeder: Consultando conteúdos em alta no TMDB para preenchimento equilibrado de todas as faixas...');

            const moviesInQueue = (this.queueManager.queue || []).filter(j => j.type === 'filme' && j.status === 'queued');
            const seriesInQueue = (this.queueManager.queue || []).filter(j => j.type === 'serie' && !j.isDorama && !j.isAnime && !j.isMicrodrama && !j.extraData?.isDorama && !j.extraData?.isAnime && !j.extraData?.isMicrodrama && j.status === 'queued');
            const doramasInQueue = (this.queueManager.queue || []).filter(j => (j.isDorama || j.extraData?.isDorama) && j.status === 'queued');
            const animesInQueue = (this.queueManager.queue || []).filter(j => (j.isAnime || j.extraData?.isAnime) && j.status === 'queued');
            const microdramasInQueue = (this.queueManager.queue || []).filter(j => (j.isMicrodrama || j.subtipo === 'microdrama' || j.extraData?.isMicrodrama || j.extraData?.subtipo === 'microdrama') && j.status === 'queued');

            // 6. Filmes em alta (mantém cota independente para Faixa 1)
            if (moviesInQueue.length < 6) {
                const trendingMovies = await TMDBService.getTrendingMovies('week');
                for (const movie of trendingMovies.slice(0, 6)) {
                    await this.considerItem(movie, 'filme');
                }
            }

            // 7. Doramas populares (mantém cota independente para Faixa 5)
            if (doramasInQueue.length < 6) {
                const popularDoramas = await TMDBService.getPopularKDramas();
                for (const dorama of popularDoramas.slice(0, 6)) {
                    await this.considerItem(dorama, 'serie', true, false);
                }
            }

            // 7.1 Animes populares (mantém cota independente para Faixa 4)
            if (animesInQueue.length < 6) {
                const popularAnimes = await TMDBService.getPopularAnime();
                for (const anime of popularAnimes.slice(0, 6)) {
                    await this.considerItem(anime, 'serie', false, true);
                }
            }

            // 7.2 Microdramas Chineses Verticais (Duanju 9:16) em Alta (Faixa 6)
            await this.checkMicrodramasFeed();

            // 8. Séries ocidentais em alta (mantém cota independente para Faixa 3)
            if (seriesInQueue.length < 6) {
                const trendingTV = await TMDBService.getTrendingTV('week');
                for (const tv of trendingTV.slice(0, 4)) {
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

            let added = 0;
            for (const md of trending) {
                if (microdramasInQueue.length + added >= 4) break;

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
                    audioPreference: 'legendado',
                    originalLanguage: 'zh'
                });
                added++;
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

            let consecutiveFailures = 0;
            for (const serie of seriesList) {
                if (consecutiveFailures >= 3) {
                    console.warn('⚠️ [AutoFeeder] Múltiplas falhas ao consultar TMDB (API instável/offline). Postergando verificação para a próxima rodada.');
                    break;
                }

                let tmdbData = null;
                if (serie.tmdbId) {
                    tmdbData = await TMDBService.getTVDetails(serie.tmdbId);
                } else {
                    const search = await TMDBService.searchTV(serie.nome, serie.ano);
                    if (search && search.length > 0) {
                        tmdbData = await TMDBService.getTVDetails(search[0].tmdbId);
                    }
                }

                if (!tmdbData || !tmdbData.temporadas) {
                    consecutiveFailures++;
                    continue;
                }
                consecutiveFailures = 0;

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
                            const isAnime = serie.isAnime || serie.categoria === 'Anime' || (serie.generos && serie.generos.includes('Anime')) || serie.originalLanguage === 'ja';
                            const isMicrodrama = serie.isMicrodrama || serie.subtipo === 'microdrama';
                            const isDorama = !isAnime && (serie.isDorama || serie.categoria === 'Dorama' || isMicrodrama || serie.originalLanguage === 'ko' || serie.originalLanguage === 'zh');

                            console.log(`🌟 NOVO EPISÓDIO DETECTADO: "${serie.nome}" T${sNum}E${proximoEpFaltante.numero} ("${proximoEpFaltante.nome}") [${isAnime ? 'Anime' : (isMicrodrama ? 'Microdrama' : (isDorama ? 'Dorama' : 'Série'))}]! Enfileirando download...`);
                            this.queueManager.addJob(serie.nome, 'serie', PRIORITIES.SERIES, {
                                tmdbId: tmdbData.tmdbId,
                                season: sNum,
                                episode: proximoEpFaltante.numero,
                                nomeOriginal: serie.nomeOriginal,
                                isAnime: isAnime,
                                isDorama: isDorama,
                                isMicrodrama: isMicrodrama,
                                subtipo: serie.subtipo || (isMicrodrama ? 'microdrama' : null),
                                originalLanguage: serie.originalLanguage || (isAnime ? 'ja' : (isDorama ? 'ko' : null)),
                                queueOrder: -1
                            });
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
            // Mas primeiro filtra por série única para não fazer múltiplas buscas na mesma obra
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

                // ── Para doramas e animes, verifica ANTES se existe realmente uma fonte dublada PT-BR ──
                // Muitos doramas coreanos e animes japoneses nunca foram dublados em PT-BR.
                // Fazer enfileiramento cego gera um loop infinito de tentativas sem resultado.
                const isDoramaOrAnime = !!(primeiroPendente.isDorama || primeiroPendente.isAnime);
                if (isDoramaOrAnime) {
                    try {
                        const sources = await MediaSearchService.search(primeiroPendente.serieNome, 'serie', {
                            nomeOriginal: primeiroPendente.nomeOriginal,
                            tmdbId: primeiroPendente.tmdbId,
                            imdbId: primeiroPendente.imdbId,
                            season: primeiroPendente.season,
                            episode: primeiroPendente.episode,
                            audioPreference: 'dublado',
                            isDorama: primeiroPendente.isDorama,
                            isAnime: primeiroPendente.isAnime
                        });
                        const dubladaSource = sources.find(s => s.isDublado && (s.seeders || 0) > 0);
                        if (!dubladaSource) {
                            // Nenhuma fonte dublada PT-BR disponível: esta obra provavelmente
                            // não foi dublada no Brasil. Ignorar silenciosamente.
                            console.log(`ℹ️ [UPGRADE DUBLADO] Nenhuma fonte dublada PT-BR encontrada para "${primeiroPendente.serieNome}" T${primeiroPendente.season}E${primeiroPendente.episode} (${primeiroPendente.isAnime ? 'Anime' : 'Dorama'} — provavelmente sem dublagem BR). Mantendo como Legendado.`);
                            await new Promise(r => setTimeout(r, 300));
                            continue;
                        }
                        console.log(`🌟 [UPGRADE DUBLADO] Fonte dublada encontrada para "${primeiroPendente.serieNome}" T${primeiroPendente.season}E${primeiroPendente.episode}: ${dubladaSource.title}`);
                    } catch (searchErr) {
                        console.warn(`⚠️ [UPGRADE DUBLADO] Erro ao buscar fonte dublada para "${primeiroPendente.serieNome}":`, searchErr.message);
                        await new Promise(r => setTimeout(r, 300));
                        continue;
                    }
                    await new Promise(r => setTimeout(r, 300));
                }

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

            console.log(`🎬 AutoFeeder: Verificando se ${apenasDublados.length} filme(s) dublado(s) possuem versão LEGENDADA para completar o catálogo...`);

            for (const filme of apenasDublados) {
                const jaNaFila = (this.queueManager.queue || []).some(j =>
                    j.type === 'filme' &&
                    j.title.toLowerCase() === filme.nome.toLowerCase() &&
                    j.audioPreference === 'legendado' &&
                    ['queued', 'downloading', 'processing', 'uploading'].includes(j.status)
                );

                if (!jaNaFila && filme.imdbId) {
                    const sources = await MediaSearchService.search(filme.nome, 'filme', {
                        nomeOriginal: filme.nomeOriginal,
                        ano: filme.ano,
                        imdbId: filme.imdbId,
                        audioPreference: 'legendado'
                    });

                    const legSource = sources.find(s => (s.isLegendado || s.seeders >= 2) && s.seeders > 0);
                    if (legSource) {
                        console.log(`🌟 VERSÃO LEGENDADA ENCONTRADA para filme "${filme.nome}"! Fonte: ${legSource.title} [Seeds: ${legSource.seeders}]`);
                        this.queueManager.addJob(filme.nome, 'filme', PRIORITIES.SERIES || 3, {
                            tmdbId: filme.tmdbId,
                            imdbId: filme.imdbId,
                            nomeOriginal: filme.nomeOriginal,
                            ano: filme.ano,
                            audioPreference: 'legendado',
                            isUpgrade: true,
                            extraData: { isLegendadoUpgrade: true }
                        });
                    }
                    await new Promise(r => setTimeout(r, 400));
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de filmes para legendado:', e.message);
        }
    }

    /**
     * Verifica se um título é uma adaptação live-action conhecida de um anime e extrai o titulo canônico do anime.
     * Ex: "ONE PIECE: A Série" -> "One Piece" | "Death Note" Live Action -> "Death Note"
     */
    _detectLiveActionAdaptation(title, nomeOriginal, tmdbItem) {
        const KNOWN_ANIME_ORIGINALS = /one piece|death note|naruto|bleach|dragon ball|attack on titan|fullmetal alchemist|cowboy bebop|ghost in the shell|sword art online|fairy tail|hunter x hunter|demon slayer|jujutsu kaisen|my hero academia/i;
        const normTitle = (title || '').toLowerCase();
        const normOriginal = (nomeOriginal || '').toLowerCase();

        // Detecta Live Action: idioma original em inglês, título diferente do anime (com "a série", "the series", etc.)
        const isEnglish = tmdbItem?.idiomaOriginal === 'en' || tmdbItem?.originalLanguage === 'en';
        const hasSeriesSuffix = /[:–-]\s*(a série|the series|live action|la serie|la séries)/i.test(title);
        const knowAnimeMatch = KNOWN_ANIME_ORIGINALS.exec(normTitle) || KNOWN_ANIME_ORIGINALS.exec(normOriginal);

        if (isEnglish && hasSeriesSuffix && knowAnimeMatch) {
            // Extrai o titulo canônico do anime (parte antes de ":")
            const animeTitle = knowAnimeMatch[0].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            return animeTitle;
        }
        return null;
    }

    async considerItem(item, tipo, isDorama = false, isAnime = false) {
        const title = item.nome;
        if (!title) return;

        // 1. Filtrar títulos em idiomas asiáticos sem tradução/ocidentalização
        if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/.test(title)) {
            // Se o título está em caracteres coreanos/chineses puros e não tem título em português legível
            if (!item.nomeOriginal || /[\uac00-\ud7af]/.test(item.nomeOriginal)) {
                return;
            }
        }

        // 2. Filtrar conteúdos futuros que ainda não estrearam
        const nowStr = new Date().toISOString().split('T')[0];
        if (item.dataLancamento && item.dataLancamento > nowStr) {
            return;
        }

        // 3. Detectar se é um Live Action de um anime conhecido e enfileirar o anime original também
        const animeOriginalTitle = this._detectLiveActionAdaptation(title, item.nomeOriginal, item);
        if (animeOriginalTitle && !isAnime) {
            // Enfileira o anime original separadamente se não estiver no catálogo/fila
            const animeExistente = this.catalogoManager.buscarItemExato(animeOriginalTitle, 'serie');
            const animeInQueue = this.queueManager.queue.some(j =>
                j.title.toLowerCase() === animeOriginalTitle.toLowerCase() && j.status !== 'failed'
            );
            if (!animeExistente && !animeInQueue) {
                console.log(`⛩️ [AutoFeeder] Detectado Live Action de anime! Enfileirando também o anime original: "${animeOriginalTitle}"`);
                try {
                    const animeResults = await TMDBService.searchTV(animeOriginalTitle);
                    const animeResult = animeResults.find(r => r.isAnime) || animeResults[0];
                    if (animeResult) {
                        this.queueManager.addJob(animeResult.nome || animeOriginalTitle, 'serie', PRIORITIES.SERIES, {
                            tmdbId: animeResult.tmdbId,
                            isAnime: true,
                            originalLanguage: 'ja',
                            season: 1,
                            episode: 1
                        });
                    }
                } catch (e) {
                    console.warn(`⚠️ [AutoFeeder] Falha ao enfileirar anime original "${animeOriginalTitle}":`, e.message);
                }
            } else if (animeExistente) {
                console.log(`ℹ️ [AutoFeeder] Anime original "${animeOriginalTitle}" já está no catálogo.`);
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

        const tag = isAnime ? 'Anime' : (isDorama ? 'Dorama' : (item.isMicrodrama ? 'Microdrama' : (tipo === 'filme' ? 'Filme' : 'Série')));
        console.log(`✨ AutoFeeder adicionando à fila: "${title}" (${tag})`);

        const itemPrio = tipo === 'filme' ? PRIORITIES.CAM_UPGRADE : PRIORITIES.SERIES;

        this.queueManager.addJob(title, tipo, itemPrio, {
            tmdbId: item.tmdbId,
            isDorama: isDorama || item.isDorama || false,
            isAnime: isAnime || item.isAnime || false,
            isMicrodrama: item.isMicrodrama || false,
            subtipo: item.subtipo || (item.isMicrodrama ? 'microdrama' : null),
            originalLanguage: isAnime ? 'ja' : (isDorama ? 'ko' : (item.idiomaOriginal || null)),
            season: 1,
            episode: tipo === 'serie' ? 1 : null
        });
    }
}

module.exports = AutoFeeder;
