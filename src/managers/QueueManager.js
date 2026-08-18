const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const config = require('../../config');
const db = require('../database/db');
const TMDBService = require('../services/TMDBService');
const MediaSearchService = require('../services/MediaSearchService');
const DownloaderManager = require('../services/DownloaderManager');
const VideoProcessor = require('../services/VideoProcessor');
const TelegramUploader = require('../services/TelegramUploader');

const PRIORITIES = {
    VIP_USER: 1,  // Pedido de Assinante VIP (Fura-fila)
    USER: 1,      // Compatibilidade
    FREE_USER: 2, // Pedido de Usuário Gratuito (Fila normal)
    SERIES: 3,    // Continuação de série/dorama em andamento
    FEEDER: 4     // Auto-Feeder (população em background)
};

class QueueManager extends EventEmitter {
    constructor(bot, catalogoManager, pedidosManager = null, favoritosManager = null) {
        super();
        this.bot = bot;
        this.catalogoManager = catalogoManager;
        this.pedidosManager = pedidosManager;
        this.favoritosManager = favoritosManager;
        this.uploader = new TelegramUploader(bot);
        this.queue = []; // cache em memória sincronizado com o banco
        this.activeTask = null;
        this.isProcessing = false;
        this.skippedEpisodes = new Map(); // Controle de episódios sem sementes / pulados para evitar loops

        // Inicializa banco e carrega fila de forma assíncrona
        this._init();
    }

    isEpisodeSkippedRecently(title, season, episode) {
        const key = `${(title || '').toLowerCase()}_S${season}_E${episode}`;
        const lastSkipped = this.skippedEpisodes.get(key);
        if (!lastSkipped) return false;
        // Expira após 3 horas para permitir nova tentativa futura
        if (Date.now() - lastSkipped > 3 * 60 * 60 * 1000) {
            this.skippedEpisodes.delete(key);
            return false;
        }
        return true;
    }

    recordSkippedEpisode(title, season, episode) {
        const key = `${(title || '').toLowerCase()}_S${season}_E${episode}`;
        this.skippedEpisodes.set(key, Date.now());
    }

    async enqueueNextAvailableEpisode(metadata, job) {
        try {
            const currentSeason = job.season || 1;
            const currentEp = job.episode || 1;
            let totalEpsNestaTemporada = 10;
            let totalTemporadas = metadata.totalTemporadas || (metadata.temporadas ? metadata.temporadas.length : 1);

            try {
                if (metadata.tmdbId) {
                    const seasonInfo = await TMDBService.getSeasonDetails(metadata.tmdbId, currentSeason);
                    if (seasonInfo?.episodios?.length > 0) {
                        totalEpsNestaTemporada = seasonInfo.episodios.length;
                    }
                }
            } catch (e) {}

            const nextEp = currentEp + 1;
            if (nextEp <= totalEpsNestaTemporada) {
                console.log(`⏩ [PULO INTELIGENTE] Avançando esteira para: "${metadata.nome || job.title}" - T${currentSeason}E${nextEp}`);
                this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                    tmdbId: metadata.tmdbId,
                    season: currentSeason,
                    episode: nextEp,
                    userId: job.userId,
                    username: job.username,
                    audioPreference: job.audioPreference || 'dublado',
                    queueOrder: -1
                });
            } else if (currentSeason + 1 <= totalTemporadas) {
                console.log(`⏩ [PULO INTELIGENTE] Fim da Temporada ${currentSeason}. Avançando esteira para: "${metadata.nome || job.title}" - T${currentSeason + 1}E1`);
                this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                    tmdbId: metadata.tmdbId,
                    season: currentSeason + 1,
                    episode: 1,
                    userId: job.userId,
                    username: job.username,
                    audioPreference: job.audioPreference || 'dublado',
                    queueOrder: -1
                });
            }
        } catch (e) {
            console.warn('⚠️ Erro ao enfileirar próximo episódio no pulo inteligente:', e.message);
        }
    }

    async _init() {
        try {
            await this.loadQueue();
        } catch (e) {
            console.error('❌ Erro ao inicializar fila do banco:', e.message);
        }
        setTimeout(() => this.processNext(), 2000);
    }

    setManagers(pedidosManager, favoritosManager) {
        this.pedidosManager = pedidosManager;
        this.favoritosManager = favoritosManager;
    }

    setBot(bot) {
        this.bot = bot;
        this.uploader.setBot(bot);
    }

    // ─── Persistência no PostgreSQL ───────────────────────────────────────────

    async loadQueue() {
        try {
            // Reseta jobs interrompidos (crash recovery) e carrega todos os jobs não-completados
            await db.query(
                `UPDATE queue_jobs SET status = 'queued', progress = 0
                 WHERE status IN ('processing', 'downloading', 'uploading')`
            );
            const res = await db.query(
                `SELECT * FROM queue_jobs
                 WHERE status NOT IN ('completed', 'failed')
                 ORDER BY priority ASC, queue_order ASC, created_at ASC`
            );
            this.queue = res.rows.map(r => this._rowToJob(r));
            console.log(`📋 Fila PostgreSQL carregada: ${this.queue.length} jobs pendentes.`);
        } catch (e) {
            console.error('❌ Erro ao carregar fila do PostgreSQL:', e.message);
            this.queue = [];
        }
    }

    async saveJob(job) {
        try {
            await db.query(
                `INSERT INTO queue_jobs
                    (id, title, type, priority, audio_preference, season, episode,
                     status, progress, progress_details, user_id, username, tmdb_id,
                     extra_data, error, queue_order, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
                 ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    progress = EXCLUDED.progress,
                    progress_details = EXCLUDED.progress_details,
                    priority = EXCLUDED.priority,
                    extra_data = EXCLUDED.extra_data,
                    error = EXCLUDED.error,
                    queue_order = EXCLUDED.queue_order,
                    updated_at = NOW()`,
                [
                    job.id,
                    job.title,
                    job.type,
                    job.priority,
                    job.audioPreference || 'dublado',
                    job.season || null,
                    job.episode || null,
                    job.status,
                    Math.round(job.progress || 0),
                    job.progressDetails || '',
                    job.userId || null,
                    job.username || null,
                    job.tmdbId || null,
                    JSON.stringify({
                        rawFilePath: job.rawFilePath,
                        optimizedPath: job.optimizedPath,
                        expectedSize: job.expectedSize,
                        bestSource: job.bestSource,
                        langInfo: job.langInfo,
                        customMagnet: job.customMagnet || null,
                        isManualAdd: job.isManualAdd || false,
                        metaDetails: job.metaDetails || null
                    }),
                    job.error || null,
                    job.queueOrder !== undefined ? job.queueOrder : 0,
                    job.createdAt || new Date().toISOString()
                ]
            );
        } catch (e) {
            console.error('❌ Erro ao persistir job no PostgreSQL:', e.message);
        }
    }

    // Mantido como alias síncrono-compatível para chamadas legadas
    saveQueue() {
        // No-op: persistência é feita job a job via saveJob()
    }

    _rowToJob(row) {
        const extra = row.extra_data || {};
        return {
            id: row.id,
            title: row.title,
            type: row.type,
            priority: row.priority,
            audioPreference: row.audio_preference,
            season: row.season,
            episode: row.episode,
            userId: row.user_id ? Number(row.user_id) : null,
            username: row.username,
            tmdbId: row.tmdb_id,
            status: row.status,
            progress: row.progress,
            progressDetails: row.progress_details,
            error: row.error,
            queueOrder: row.queue_order !== null && row.queue_order !== undefined ? Number(row.queue_order) : (row.created_at ? new Date(row.created_at).getTime() : 0),
            rawFilePath: extra.rawFilePath || null,
            optimizedPath: extra.optimizedPath || null,
            expectedSize: extra.expectedSize || null,
            bestSource: extra.bestSource || null,
            langInfo: extra.langInfo || null,
            customMagnet: extra.customMagnet || null,
            isManualAdd: extra.isManualAdd || false,
            metaDetails: extra.metaDetails || null,
            createdAt: row.created_at
        };
    }

    // ─────────────────────────────────────────────────────────────────────────

    addJob(title, type = 'filme', priority = PRIORITIES.FEEDER, extraData = {}) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const job = {
            id: jobId,
            title: title.trim(),
            type: type, // 'filme' ou 'serie'
            priority: priority,
            audioPreference: extraData.audioPreference || 'dublado',
            userId: extraData.userId || null,
            username: extraData.username || null,
            season: type === 'serie' ? (extraData.season || 1) : null,
            episode: type === 'serie' ? (extraData.episode || 1) : null,
            tmdbId: extraData.tmdbId || null,
            rawFilePath: extraData.rawFilePath || null,
            customMagnet: extraData.customMagnet || extraData.magnet || null,
            isManualAdd: extraData.isManualAdd || false,
            metaDetails: extraData.metaDetails || null,
            status: 'queued', // 'queued', 'downloading', 'processing', 'uploading', 'completed', 'failed'
            progress: 0,
            progressDetails: '',
            createdAt: new Date().toISOString(),
            error: null
        };

        if (extraData.rawFilePath) {
            job.priority = PRIORITIES.VIP_USER;
            job.queueOrder = -999;
            job.isManualAdd = true;
            job.progressDetails = 'Arquivo local pronto para processamento';
        }

        // Verifica se já existe um trabalho igual na fila com a mesma preferência de áudio
        const existing = this.queue.find(j => 
            j.title.toLowerCase() === title.toLowerCase() && 
            j.season === job.season && 
            j.episode === job.episode &&
            (j.audioPreference || 'dublado') === job.audioPreference &&
            j.status !== 'failed'
        );

        if (existing) {
            // Se foi enviado um arquivo via upload manual, atualiza o existing imediatamente com o arquivo local
            if (extraData.rawFilePath) {
                console.log(`📁 [UPLOAD MANUAL] Vinculando arquivo local "${extraData.rawFilePath}" ao trabalho existente: "${job.title}"`);
                existing.rawFilePath = extraData.rawFilePath;
                existing.isManualAdd = true;
                existing.priority = PRIORITIES.VIP_USER;
                existing.queueOrder = -999;
                existing.status = 'queued';
                existing.progress = 0;
                existing.progressDetails = 'Arquivo local pronto para processamento';
                existing.error = null;
                if (extraData.metaDetails) existing.metaDetails = extraData.metaDetails;
                if (extraData.tmdbId) existing.tmdbId = extraData.tmdbId;
                this.sortQueue();
                this.saveJob(existing).catch(() => {});
                setImmediate(() => this.processNext());
                return existing;
            }

            // Se for pedido de usuário, eleva a prioridade do existente
            if ((priority === PRIORITIES.VIP_USER || priority === PRIORITIES.USER) && existing.priority > priority) {
                existing.priority = priority;
                existing.userId = job.userId;
                existing.username = job.username;
                this.sortQueue();
                this.saveJob(existing).catch(() => {});
            }
            return existing;
        }

        // Se for filme e já existir no catálogo em qualidade oficial (não-CAM), valida por áudio
        if (type === 'filme' && !extraData.isUpgrade) {
            const existente = this.catalogoManager.buscarItemExato(title, 'filme');
            if (existente && !existente.isCam) {
                const pref = job.audioPreference;
                const temDublado = existente.isDublado || !!existente.versoes?.dublado;
                const temLegendado = existente.isLegendado || !!existente.versoes?.legendado;

                if (pref === 'dublado' && temDublado) {
                    console.log(`ℹ️ [Fila] "${title}" já possui versão Dublada no catálogo. Ignorando adição duplicada.`);
                    return null;
                }
                if (pref === 'legendado' && temLegendado) {
                    console.log(`ℹ️ [Fila] "${title}" já possui versão Legendada no catálogo. Ignorando adição duplicada.`);
                    return null;
                }
                if (!extraData.audioPreference && temDublado && temLegendado) {
                    console.log(`ℹ️ [Fila] "${title}" já possui ambas as versões (Dub/Leg) no catálogo.`);
                    return null;
                }
            }
        }

        // Se for série e o episódio já existir no catálogo com o áudio desejado, busca o próximo episódio pendente
        if (type === 'serie') {
            const serieExistente = this.catalogoManager.buscarItemExato(title, 'serie');
            if (serieExistente) {
                const temporada = (serieExistente.temporadas || []).find(t => t.numero === job.season);
                const epExistente = (temporada?.episodios || []).find(e => e.numero === job.episode);
                if (epExistente) {
                    const pref = job.audioPreference || 'dublado';
                    const epDub = epExistente.isDublado || epExistente.audio?.toLowerCase().includes('dublado');
                    const epLeg = epExistente.isLegendado || epExistente.audio?.toLowerCase().includes('legendado');
                    const audioMatches = (pref === 'dublado' && epDub) || (pref === 'legendado' && epLeg);

                    if (audioMatches) {
                        if (!extraData.isManualAdd || (!extraData.episode && !extraData.season)) {
                            const epsCadastrados = (temporada?.episodios || []).map(e => e.numero);
                            let nextMissing = null;
                            for (let ep = 1; ep <= 30; ep++) {
                                const epObj = (temporada?.episodios || []).find(e => e.numero === ep);
                                if (!epObj) {
                                    nextMissing = ep;
                                    break;
                                }
                                const isD = epObj.isDublado || epObj.audio?.toLowerCase().includes('dublado');
                                const isL = epObj.isLegendado || epObj.audio?.toLowerCase().includes('legendado');
                                if ((pref === 'dublado' && !isD) || (pref === 'legendado' && !isL)) {
                                    nextMissing = ep;
                                    break;
                                }
                            }
                            if (nextMissing) {
                                console.log(`📺 [Fila] "${title}" T${job.season}E${job.episode} já existe. Direcionando trabalho para o próximo episódio pendente: T${job.season}E${nextMissing}`);
                                job.episode = nextMissing;
                            } else {
                                console.log(`ℹ️ [Fila] Todos os episódios da Temporada ${job.season} de "${title}" já estão no catálogo com áudio ${pref}.`);
                                return null;
                            }
                        } else {
                            console.log(`ℹ️ [Fila] "${title}" T${job.season}E${job.episode} (${pref}) já está cadastrado no catálogo. Ignorando.`);
                            return null;
                        }
                    }
                }
            }
        }

        this.queue.push(job);
        this.sortQueue();
        this.saveJob(job).catch(() => {});

        console.log(`📌 Novo trabalho na fila: "${job.title}" [Áudio: ${job.audioPreference}, Prioridade: ${job.priority}] (Total na fila: ${this.queue.length})`);
        
        // Inicia processamento se ocioso
        this.processNext();
        return job;
    }

    async marcarPedidosAtendidos(titulo, userId = null, tipo = 'filme') {
        if (!this.pedidosManager) return;
        try {
            const cleanTitle = (titulo || '').toLowerCase().trim();
            if (!cleanTitle) return;

            const pedidos = this.pedidosManager.getPedidos() || [];
            const correspondentes = pedidos.filter(p => {
                if (p.processado || p.status === 'adicionado') return false;
                const pNome = (p.nome || '').toLowerCase().trim();
                return pNome === cleanTitle || cleanTitle.includes(pNome) || pNome.includes(cleanTitle);
            });

            for (const p of correspondentes) {
                console.log(`📝 [PEDIDOS] Marcando pedido de @${p.username || p.userId} ("${p.nome}") como ATENDIDO no histórico!`);
                await this.pedidosManager.marcarComoProcessado(p.id);

                if (this.bot && p.userId && p.userId !== config.ADMIN_ID) {
                    const itemSalvo = this.catalogoManager.buscarItemExato(p.nome, p.tipo || tipo);
                    const sId = itemSalvo?.id || '';
                    const callbackAssistir = (p.tipo === 'serie' || tipo === 'serie') ? `info_serie_${sId}` : `info_filme_${sId}`;
                    const msgPedido = `🎉 *Seu Pedido Chegou no BrasilFlix!*\n\n` +
                                     `🎬 *${p.nome}*\n` +
                                     `✨ *Qualidade:* 1080p Full HD\n` +
                                     `🔊 *Versão:* Dublado / Legendado\n\n` +
                                     `O título que você pediu já está disponível no catálogo para assistir! 🍿`;

                    this.bot.sendMessage(p.userId, msgPedido, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '▶️ Assistir Agora', callback_data: callbackAssistir }]]
                        }
                    }).catch(() => {});
                }
            }
        } catch (e) {
            console.warn('⚠️ Erro ao marcar pedidos como atendidos:', e.message);
        }
    }

    sortQueue() {
        this.queue.sort((a, b) => {
            const pA = Number(a.priority || 4);
            const pB = Number(b.priority || 4);
            if (pA !== pB) {
                return pA - pB; // Prioridade menor = executa primeiro (1 > 2 > 3 > 4)
            }
            const orderA = a.queueOrder !== undefined && a.queueOrder !== null ? Number(a.queueOrder) : (a.createdAt ? new Date(a.createdAt).getTime() : 0);
            const orderB = b.queueOrder !== undefined && b.queueOrder !== null ? Number(b.queueOrder) : (b.createdAt ? new Date(b.createdAt).getTime() : 0);
            if (orderA !== orderB) {
                return orderA - orderB;
            }
            return new Date(a.createdAt) - new Date(b.createdAt);
        });
    }

    async processNext() {
        if (this.isProcessing) return;

        // Pega o próximo item não concluído e não falhado
        const nextJob = this.queue.find(j => j.status === 'queued');
        if (!nextJob) {
            this.activeTask = null;
            return;
        }

        this.isProcessing = true;
        this.activeTask = nextJob;
        nextJob.status = 'processing';
        await this.saveJob(nextJob);

        console.log(`\n⚙️ INICIANDO PROCESSAMENTO: "${nextJob.title}" (Prioridade: ${nextJob.priority})`);

        try {
            await this.executeJob(nextJob);
            nextJob.status = 'completed';
            nextJob.progress = 100;
            await this.saveJob(nextJob);
            // Remove da fila em memória (não é mais necessário processar)
            this.queue = this.queue.filter(j => j.id !== nextJob.id);
            console.log(`🎉 Trabalho concluído com sucesso: "${nextJob.title}"`);
        } catch (error) {
            console.error(`❌ Falha no processamento de "${nextJob.title}":`, error.message);
            nextJob.status = 'failed';
            nextJob.error = error.message;
            await this.saveJob(nextJob);
            // Remove da fila em memória
            this.queue = this.queue.filter(j => j.id !== nextJob.id);
        } finally {
            this.isProcessing = false;
            this.activeTask = null;

            // Continua imediatamente para o próximo da fila
            setImmediate(() => this.processNext());
        }
    }

    async executeJob(job) {
        // 1. Obter metadados TMDB
        let metadata = { nome: job.title, tipo: job.type };
        try {
            if (job.type === 'filme') {
                const results = await TMDBService.searchMovie(job.title);
                if (results.length > 0) {
                    const details = await TMDBService.getMovieDetails(results[0].tmdbId);
                    metadata = details || results[0];
                }
            } else {
                const results = await TMDBService.searchTV(job.title);
                if (results.length > 0) {
                    const details = await TMDBService.getTVDetails(results[0].tmdbId);
                    metadata = details || results[0];
                }
            }
        } catch (e) {
            console.warn('⚠️ Erro ao consultar TMDB, usando metadados básicos:', e.message);
        }

        // Validação de Existência Prévia para Filmes (evita rebaixar filmes que já estão 100% no catálogo)
        if (job.type === 'filme' && !job.isUpgrade && !job.extraData?.isUpgrade) {
            const filmeExistente = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'filme') ||
                                  this.catalogoManager.buscarItemExato(job.title, 'filme');
            if (filmeExistente && !filmeExistente.isCam) {
                const pref = job.audioPreference || 'dublado';
                const temDublado = filmeExistente.isDublado || !!filmeExistente.versoes?.dublado;
                const temLegendado = filmeExistente.isLegendado || !!filmeExistente.versoes?.legendado;

                if ((pref === 'dublado' && temDublado) || (pref === 'legendado' && temLegendado) || (temDublado && !job.userId)) {
                    console.log(`✅ [FILME] "${job.title}" já está no catálogo em 1080p oficial (${temDublado ? 'Dublado' : 'Legendado'}). Ignorando download duplicado.`);
                    await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'filme');
                    return;
                }
            }
        }

        // Validação de Ordem Cronológica e Verificação de Existência de Episódios para Séries/Doramas
        if (job.type === 'serie') {
            const seasonNum = job.season || 1;
            const requestedEp = job.episode || 1;
            const pref = job.audioPreference || 'dublado';

            const serieExistente = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie') ||
                                  this.catalogoManager.buscarItemExato(job.title, 'serie');
            if (serieExistente) {
                const totalTemporadas = metadata.totalTemporadas || (metadata.temporadas ? metadata.temporadas.length : 1);
                
                // Busca de forma estritamente cronológica o PRIMEIRO episódio faltante desde a Temporada 1
                let nextTargetSeason = null;
                let nextTargetEp = null;

                // 1º Passo: Encontrar o primeiro episódio totalmente faltante no catálogo
                for (let s = 1; s <= totalTemporadas; s++) {
                    const tempS = (serieExistente.temporadas || []).find(t => t.numero === s);
                    
                    let totalEpsInS = 10;
                    try {
                        if (metadata.tmdbId) {
                            const tmdbSInfo = (metadata.temporadas || []).find(t => t.numero === s);
                            if (tmdbSInfo && tmdbSInfo.episodiosContagem > 0) {
                                totalEpsInS = tmdbSInfo.episodiosContagem;
                            } else {
                                const sDetails = await TMDBService.getSeasonDetails(metadata.tmdbId, s);
                                if (sDetails?.episodios?.length > 0) {
                                    totalEpsInS = sDetails.episodios.length;
                                }
                            }
                        }
                    } catch (e) {}

                    for (let ep = 1; ep <= totalEpsInS; ep++) {
                        const epItem = (tempS?.episodios || []).find(e => e.numero === ep);
                        if (!epItem) {
                            if (this.isEpisodeSkippedRecently(metadata.nome || job.title, s, ep)) {
                                continue;
                            }
                            nextTargetSeason = s;
                            nextTargetEp = ep;
                            break;
                        } else if (pref === 'legendado') {
                            const epLeg = epItem.isLegendado || epItem.audio?.toLowerCase().includes('legendado');
                            if (!epLeg) {
                                if (this.isEpisodeSkippedRecently(metadata.nome || job.title, s, ep)) {
                                    continue;
                                }
                                nextTargetSeason = s;
                                nextTargetEp = ep;
                                break;
                            }
                        } else if (pref === 'dublado') {
                            const epDub = epItem.isDublado || epItem.audio?.toLowerCase().includes('dublado');
                            if (!epDub) {
                                if (this.isEpisodeSkippedRecently(metadata.nome || job.title, s, ep)) {
                                    continue;
                                }
                                nextTargetSeason = s;
                                nextTargetEp = ep;
                                break;
                            }
                        }
                    }

                    if (nextTargetSeason !== null) break;
                }

                // 2º Passo: Se todos os episódios já existem no catálogo, verifica se algum pode receber upgrade de áudio
                if (nextTargetSeason === null && pref === 'dublado') {
                    for (let s = 1; s <= totalTemporadas; s++) {
                        const tempS = (serieExistente.temporadas || []).find(t => t.numero === s);
                        for (const epItem of (tempS?.episodios || [])) {
                            const epDub = epItem.isDublado || epItem.audio?.toLowerCase().includes('dublado');
                            if (!epDub) {
                                if (this.isEpisodeSkippedRecently(metadata.nome || job.title, s, epItem.numero)) {
                                    continue;
                                }
                                nextTargetSeason = s;
                                nextTargetEp = epItem.numero;
                                break;
                            }
                        }
                        if (nextTargetSeason !== null) break;
                    }
                }

                if (nextTargetSeason !== null && nextTargetEp !== null) {
                    if (job.season !== nextTargetSeason || job.episode !== nextTargetEp) {
                        console.log(`📺 [SÉRIE CRONOLÓGICA] Ajustando esteira para baixar o próximo episódio pendente na ordem: "${metadata.nome || job.title}" - T${nextTargetSeason}E${nextTargetEp}`);
                        job.season = nextTargetSeason;
                        job.episode = nextTargetEp;
                        await this.saveJob(job);
                    }
                } else {
                    console.log(`🎉 [SÉRIE COMPLETA] Todos os episódios de todas as ${totalTemporadas} temporadas de "${job.title}" já estão 100% catalogados com áudio ${pref.toUpperCase()}!`);
                    await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'serie');
                    return;
                }
            } else if (requestedEp > 1 && !this.isEpisodeSkippedRecently(metadata.nome || job.title, seasonNum, 1) && !this.isEpisodeSkippedRecently(job.title, seasonNum, 1)) {
                console.log(`⚠️ [ORDEM CRONOLÓGICA] Série "${job.title}" não possui cadastro no catálogo. Iniciando a partir do Episódio 1 (T${seasonNum}E1)!`);
                job.episode = 1;
                await this.saveJob(job);
            }
        }

        // 2. Buscar fontes (Torrents / Direct) se necessário
        let sources = [];
        let downloadedMedia = null;
        let bestSource = job.bestSource || null;
        let rawFilePath = job.rawFilePath || null;
        let optimizedPath = job.optimizedPath || null;
        let langInfo = job.langInfo || { isValid: true, isDublado: true, isLegendado: false, audioText: 'Dublado (PT-BR)' };

        // 2.5 Verificar se já existe arquivo codificado ou baixado no SSD — retomada inteligente após crash
        let resumeFromOptimized = false;
        let resumeFromRaw = false;

        // Primeiro tenta retomar do arquivo otimizado (já codificado, pronto para upload)
        if (optimizedPath && fs.existsSync(optimizedPath)) {
            const optStat = fs.statSync(optimizedPath);
            if (optStat.size > 100 * 1024 * 1024) {
                try {
                    const VideoProcessor = require('../services/VideoProcessor');
                    const optInfo = await VideoProcessor.getVideoInfo(optimizedPath);

                    // Validação de Duração Completa para Retomada
                    let isDurationValid = optInfo && optInfo.duration >= 300; // Mínimo 5 min

                    if (rawFilePath && fs.existsSync(rawFilePath)) {
                        const rawInfo = await VideoProcessor.getVideoInfo(rawFilePath);
                        if (rawInfo && rawInfo.duration > 0) {
                            const diff = Math.abs(optInfo.duration - rawInfo.duration);
                            if (diff > 15 && optInfo.duration < rawInfo.duration * 0.95) {
                                isDurationValid = false;
                            }
                        }
                    }

                    if (isDurationValid) {
                        console.log(`♻️ Retomando do arquivo otimizado completo (${(optStat.size / (1024*1024*1024)).toFixed(2)} GB, Duração: ${optInfo.durationFormatted}): ${path.basename(optimizedPath)}`);
                        resumeFromOptimized = true;
                        downloadedMedia = { filePath: rawFilePath || optimizedPath, fileName: path.basename(rawFilePath || optimizedPath), sizeBytes: optStat.size };
                        bestSource = job.bestSource;
                    } else {
                        console.warn(`🧹 Arquivo otimizado incompleto/cortado (${optInfo?.durationFormatted || '0s'}), descartando para re-codificar do início...`);
                        await DownloaderManager.cleanupFile(optimizedPath);
                        optimizedPath = null;
                        job.optimizedPath = null;
                    }
                } catch (e) {
                    console.warn('⚠️ Arquivo otimizado inválido, descartando:', e.message);
                    await DownloaderManager.cleanupFile(optimizedPath);
                    optimizedPath = null;
                    job.optimizedPath = null;
                }
            } else {
                await DownloaderManager.cleanupFile(optimizedPath);
                optimizedPath = null;
                job.optimizedPath = null;
            }
        }

        // Se não retomou do otimizado, tenta retomar do arquivo raw (já baixado ou enviado via upload)
        if (!resumeFromOptimized && rawFilePath && fs.existsSync(rawFilePath)) {
            const rawStat = fs.statSync(rawFilePath);
            const expectedOk = !job.expectedSize || rawStat.size >= job.expectedSize * 0.85;
            if (rawStat.size > 5 * 1024 * 1024 && expectedOk) {
                try {
                    const VideoProcessor = require('../services/VideoProcessor');
                    const info = await VideoProcessor.getVideoInfo(rawFilePath);
                    if (info && info.duration > 0) {
                        console.log(`📁 Utilizando arquivo de vídeo existente (${(rawStat.size / (1024*1024*1024)).toFixed(2)} GB): ${path.basename(rawFilePath)}`);
                        resumeFromRaw = true;
                        downloadedMedia = { filePath: rawFilePath, fileName: path.basename(rawFilePath), sizeBytes: rawStat.size };
                        bestSource = job.bestSource || { title: job.title, source: 'Upload Manual', audio: job.audioPreference === 'dublado' ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)' };
                        langInfo = job.langInfo || langInfo;
                    }
                } catch (e) {
                    console.warn('⚠️ Arquivo raw inválido, descartando:', e.message);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    rawFilePath = null;
                    job.rawFilePath = null;
                }
            } else if (!expectedOk) {
                console.log(`🧹 Arquivo raw incompleto no disco (${rawStat.size} de ${job.expectedSize} bytes) descartado para reiniciar limpo.`);
                await DownloaderManager.cleanupFile(rawFilePath);
                rawFilePath = null;
                job.rawFilePath = null;
            }
        }


        if (!resumeFromOptimized && !resumeFromRaw) {
            if (job.customMagnet) {
                console.log(`🧲 [MANUAL MAGNET] Utilizando fonte magnética direta informada pelo administrador: "${job.title}"`);
                sources = [{
                    title: job.title,
                    magnet: job.customMagnet,
                    sizeMB: 'Manual',
                    seeders: 20,
                    isPtBr: true,
                    isDublado: job.audioPreference === 'dublado',
                    isLegendado: job.audioPreference === 'legendado',
                    audio: job.audioPreference === 'dublado' ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                    source: 'Manual (Admin Magnet)'
                }];
            } else {
                sources = await MediaSearchService.search(job.title, job.type, {
                    nomeOriginal: metadata.nomeOriginal,
                    ano: metadata.ano,
                    tmdbId: metadata.tmdbId,
                    imdbId: metadata.imdbId,
                    season: job.season || 1,
                    episode: job.episode || 1,
                    audioPreference: job.audioPreference || 'dublado'
                });
            }

            if (sources.length === 0) {
                if (job.type === 'serie') {
                    this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                }
                throw new Error(`Nenhuma fonte em Português encontrada para "${job.title}".`);
            }

            // Se a preferência do job for estritamente Dublado, filtra APENAS fontes Dubladas:
            if (job.audioPreference === 'dublado') {
                const dubSources = sources.filter(s => s.isDublado);
                if (dubSources.length > 0) {
                    sources = dubSources;
                } else {
                    // Verifica se já temos a versão legendada no catálogo
                    let jaTemLegendado = false;
                    if (job.type === 'filme') {
                        const f = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'filme');
                        jaTemLegendado = f && (f.isLegendado || !!f.versoes?.legendado || f.audio?.toLowerCase().includes('legendado'));
                    } else {
                        const s = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie');
                        const t = (s?.temporadas || []).find(temp => temp.numero === (job.season || 1));
                        const ep = (t?.episodios || []).find(e => e.numero === (job.episode || 1));
                        jaTemLegendado = ep && (ep.isLegendado || ep.audio?.toLowerCase().includes('legendado'));
                    }

                    if (jaTemLegendado) {
                        console.log(`ℹ️ "${job.title}" ${job.type === 'serie' ? `T${job.season || 1}E${job.episode || 1}` : ''} já possui versão Legendada no catálogo e não há fontes Dubladas disponíveis.`);
                        job.status = 'completed';
                        job.progress = 100;
                        job.progressDetails = 'Já possui versão Legendada no catálogo';
                        await this.saveJob(job);
                        return;
                    }
                }
            } else if (job.audioPreference === 'legendado') {
                const legSources = sources.filter(s => s.isLegendado);
                if (legSources.length > 0) {
                    sources = legSources;
                }
            }

            // 3. Download com Fallback Automático entre as melhores opções (tenta até 8 fontes com timeout global de 25 min)
            job.status = 'downloading';
            await this.saveJob(job);

            let lastError = null;
            const maxAttempts = Math.min(8, sources.length);
            for (let i = 0; i < maxAttempts; i++) {
                const currentSource = sources[i];
                console.log(`🎯 Tentando fonte [${i + 1}/${maxAttempts}]: ${currentSource.title} (${currentSource.sizeMB} MB, ${currentSource.seeders || 0} seeds, ${currentSource.audio || 'PT-BR'})`);

                try {
                    if (currentSource.magnet) {
                        downloadedMedia = await DownloaderManager.downloadTorrent(currentSource.magnet, (progress) => {
                            job.progress = progress.percent;
                            job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed})`;
                        }, {
                            title: job.title,
                            season: job.season,
                            episode: job.episode,
                            type: job.type,
                            audio: currentSource.audio,
                            isDublado: currentSource.isDublado,
                            audioPreference: job.audioPreference || 'geral'
                        });
                    } else if (currentSource.url) {
                        const fileName = `${Date.now()}_${path.basename(currentSource.url) || 'video.mp4'}`;
                        downloadedMedia = await DownloaderManager.downloadHttp(currentSource.url, fileName, (progress) => {
                            job.progress = progress.percent;
                            job.progressDetails = `${progress.downloaded} / ${progress.total}`;
                        }, {
                            title: job.title,
                            season: job.season,
                            episode: job.episode,
                            type: job.type,
                            audio: currentSource.audio,
                            isDublado: currentSource.isDublado ?? (currentSource.audio ? currentSource.audio.includes('Dublado') : true),
                            audioPreference: job.audioPreference || 'dublado'
                        });
                    }

                    if (downloadedMedia && downloadedMedia.filePath) {
                        bestSource = currentSource;
                        break;
                    }
                } catch (err) {
                    console.warn(`⚠️ Fonte [${i + 1}/${maxAttempts}] falhou ou estagnou (${err.message}). Tentando próxima opção...`);
                    lastError = err;
                }
            }

            if (!downloadedMedia || !bestSource) {
                // Se a busca inicial era Dublado e todas as fontes falharam, tenta fallback para 1080p Legendado (OpenSubtitles PT-BR)
                if (job.audioPreference === 'dublado') {
                    console.log(`⚠️ Todas as fontes dubladas para "${job.title}" estavam sem seeders. Buscando fallback 1080p Legendado com OpenSubtitles PT-BR...`);
                    try {
                        const legSources = await MediaSearchService.search(job.title, job.type, {
                            nomeOriginal: metadata.nomeOriginal,
                            ano: metadata.ano,
                            tmdbId: metadata.tmdbId,
                            imdbId: metadata.imdbId,
                            season: job.season || 1,
                            episode: job.episode || 1,
                            audioPreference: 'legendado',
                            allowOriginalAudio: true
                        });

                        const candidatesLeg = legSources.filter(s => s.isLegendado || s.hasPtSub || s.isOriginal);
                        for (let j = 0; j < Math.min(6, candidatesLeg.length); j++) {
                            const currentLeg = candidatesLeg[j];
                            console.log(`🎯 [Fallback Legendado] Tentando fonte [${j + 1}/${Math.min(6, candidatesLeg.length)}]: ${currentLeg.title} (${currentLeg.sizeMB} MB, ${currentLeg.seeders || 0} seeds)`);
                            try {
                                if (currentLeg.magnet) {
                                    downloadedMedia = await DownloaderManager.downloadTorrent(currentLeg.magnet, (progress) => {
                                        job.progress = progress.percent;
                                        job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed})`;
                                    }, {
                                        title: job.title,
                                        season: job.season,
                                        episode: job.episode,
                                        type: job.type,
                                        audio: currentLeg.audio || 'Legendado (PT-BR)',
                                        isDublado: false,
                                        audioPreference: 'legendado'
                                    });
                                }
                                if (downloadedMedia && downloadedMedia.filePath) {
                                    bestSource = currentLeg;
                                    break;
                                }
                            } catch (errLeg) {
                                console.warn(`⚠️ [Fallback Legendado] Fonte [${j + 1}] falhou: ${errLeg.message}`);
                                lastError = errLeg;
                            }
                        }
                    } catch (eLeg) {
                        console.warn('⚠️ Falha ao buscar fallback legendado:', eLeg.message);
                    }
                }
            }

            if (!downloadedMedia || !bestSource) {
                if (job.type === 'serie') {
                    this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                    console.warn(`⚠️ [PULO INTELIGENTE] Todas as fontes para "${job.title}" T${job.season || 1}E${job.episode || 1} estavam sem seeders ou falharam. Registrado para retry posterior e avançando na esteira...`);
                    await this.enqueueNextAvailableEpisode(metadata, job);
                }
                throw new Error(`Todas as fontes testadas falharam ou estavam sem seeders: ${lastError?.message || 'Sem conexão'}`);
            }

            rawFilePath = downloadedMedia.filePath;
            job.rawFilePath = rawFilePath;
            job.expectedSize = downloadedMedia.sizeBytes;
            job.bestSource = bestSource;
            await this.saveJob(job);

            // Validação de tamanho físico do arquivo
            if (fs.existsSync(rawFilePath)) {
                const stat = fs.statSync(rawFilePath);
                if (downloadedMedia.sizeBytes > 0 && stat.size < downloadedMedia.sizeBytes * 0.85) {
                    console.log(`❌ Arquivo bruto descartado: tamanho físico (${stat.size} B) menor que o esperado (${downloadedMedia.sizeBytes} B).`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`Download incompleto: arquivo recebido com tamanho menor que o esperado (${stat.size} de ${downloadedMedia.sizeBytes} bytes).`);
                }
            }
        }

        let tmdbExpectedDurationMin = 0;
        try {
            if (metadata.tmdbId) {
                if (job.type === 'filme') {
                    tmdbExpectedDurationMin = metadata.duracaoMinutos || 0;
                } else {
                    const epDet = await TMDBService.getEpisodeDetails(metadata.tmdbId, job.season || 1, job.episode || 1);
                    if (epDet && epDet.duracaoMinutos) {
                        tmdbExpectedDurationMin = epDet.duracaoMinutos;
                    } else if (metadata.duracaoMinutos) {
                        tmdbExpectedDurationMin = metadata.duracaoMinutos;
                    }
                }
            }
        } catch (e) {}

        if (!resumeFromOptimized) {
            // 3.5 Verificação de Integridade, Duração Mínima e Idioma PT-BR
            try {
                const videoInfo = await VideoProcessor.getVideoInfo(rawFilePath);

                // Verificação de Duração Mínima Absoluta (Anti-Sample / Anti-Propaganda de 30s)
                const minDurationSec = 300;
                if (videoInfo.duration && videoInfo.duration < minDurationSec) {
                    console.log(`⚠️ Arquivo descartado: Duração inválida de apenas ${videoInfo.durationFormatted} (${Math.round(videoInfo.duration)}s). Mínimo exigido: 5 minutos. Possível amostra/vídeo promocional falso para "${job.title}".`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`Vídeo com duração inferior a 5 minutos (${Math.round(videoInfo.duration)}s). Amostra descartada.`);
                }

                // Verificação de Duração Oficial via TMDB API:
                // Para séries: permite até 40% da duração teórica de slot (episódios de 40-45min de slots de 60min no TMDB).
                // Para filmes: permite até 60% da duração oficial.
                if (tmdbExpectedDurationMin > 0) {
                    const expectedSec = tmdbExpectedDurationMin * 60;
                    const minRatio = job.type === 'serie' ? 0.40 : 0.60;
                    const minAcceptableSec = Math.floor(expectedSec * minRatio);
                    if (videoInfo.duration && videoInfo.duration < minAcceptableSec) {
                        const durAtualMin = (videoInfo.duration / 60).toFixed(1);
                        console.log(`⚠️ Arquivo descartado: Duração insuficiente detectada (${videoInfo.durationFormatted} / ~${durAtualMin} min). A duração oficial no TMDB é de ${tmdbExpectedDurationMin} min. Possível corte/arquivo incompleto em "${job.title}".`);
                        await DownloaderManager.cleanupFile(rawFilePath);
                        throw new Error(`Vídeo com duração inferior à oficial do TMDB (${videoInfo.durationFormatted} vs ${tmdbExpectedDurationMin} min esperados). Arquivo cortado/incompleto.`);
                    }
                }

                langInfo = VideoProcessor.validatePortugueseContent(videoInfo, path.basename(rawFilePath), bestSource || {});

                if (!langInfo.isValid) {
                    console.log(`⚠️ Arquivo descartado: Nenhuma faixa de áudio dublado nem legenda em Português detectada no download de "${job.title}".`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    if (job.type === 'serie') {
                        this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                    }
                    throw new Error(`O arquivo baixado não contém áudio nem legendas em Português.`);
                }

                console.log(`🎙️ Conteúdo em Português e Duração validados com sucesso: ${langInfo.audioText} (Duração: ${videoInfo.durationFormatted}${tmdbExpectedDurationMin ? ` / Esperado TMDB: ~${tmdbExpectedDurationMin} min` : ''})`);
            } catch (err) {
                if (err.message.includes('não contém áudio nem legendas') || err.message.includes('duração inferior')) {
                    if (job.type === 'serie') {
                        this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                    }
                    throw err;
                }
            }

            // 4. Otimização de Vídeo 1080p com FFmpeg
            job.status = 'processing';
            job.progressDetails = 'Otimizando para 1080p...';
            job.langInfo = langInfo;
            await this.saveJob(job);

            optimizedPath = path.join(path.dirname(rawFilePath), `opt_${path.basename(rawFilePath, path.extname(rawFilePath))}.mp4`);
            job.optimizedPath = optimizedPath;
            await this.saveJob(job);
            
            await VideoProcessor.optimizeForTelegram(rawFilePath, optimizedPath, (percent, details) => {
                job.progress = percent;
                job.progressDetails = details || `Otimizando 1080p: ${percent}%`;
                this.activeTask = job;
            }, {
                nome: job.title,
                tipo: job.type,
                season: job.season,
                episode: job.episode,
                totalTemporadas: metadata.totalTemporadas,
                totalEpisodios: metadata.totalEpisodios,
                imdbId: metadata.imdbId,
                tmdbId: metadata.tmdbId,
                subtitleUrl: bestSource?.subtitleUrl,
                isDublado: langInfo?.isDublado ?? true,
                isLegendado: langInfo?.isLegendado ?? false
            });
        }

        // 5. Envio ao Telegram com Barra de Upload em Tempo Real
        job.status = 'uploading';
        job.progress = 0;
        job.progressDetails = 'Iniciando envio ao Telegram...';
        this.activeTask = job;
        await this.saveJob(job);

        metadata.tipo = job.type;
        metadata.season = job.season;
        metadata.episode = job.episode;
        metadata.episodioNome = job.type === 'serie' ? `Episódio ${job.episode || 1}` : '';

        // Detecção robusta de Cinema/CAM (por título, tags ou data de lançamento futura no TMDB)
        const isCamTitle = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|gravado\s*no\s*cinema|audio\s*cinema|som\s*cinema)\b/i.test(bestSource?.title || '') || (bestSource?.isCam === true);
        const tmdbYear = parseInt(metadata.ano || new Date().getFullYear(), 10);
        const isUnreleasedMovie = job.type === 'filme' && tmdbYear >= new Date().getFullYear() && (metadata.dataLancamento && new Date(metadata.dataLancamento) > new Date());
        const isCamFinal = isCamTitle || isUnreleasedMovie || (bestSource?.quality && bestSource.quality.includes('CAM'));

        metadata.isCam = isCamFinal;
        metadata.qualidade = isCamFinal ? 'CAM (Cinema)' : (bestSource?.quality || '1080p Full HD');
        metadata.audio = langInfo?.audioText || bestSource?.audio || 'Dublado (PT-BR)';
        metadata.isDublado = langInfo ? langInfo.isDublado : true;
        metadata.isLegendado = langInfo ? langInfo.isLegendado : false;

        const uploadResult = await this.uploader.uploadVideo(optimizedPath, metadata, (p) => {
            job.progress = p.percent;
            job.progressDetails = `Enviando Telegram: ${p.percent}% (${p.speed})`;
            this.activeTask = job;
        });

        // 6. Cadastrar ou Atualizar no Catálogo
        if (job.type === 'filme') {
            const existente = this.catalogoManager.buscarItemExato(metadata.nome, 'filme');
            if (existente) {
                this.catalogoManager.atualizarMidiaFilme(metadata.nome, {
                    messageId: uploadResult.messageId,
                    fileId: uploadResult.fileId,
                    qualidade: metadata.qualidade,
                    isCam: metadata.isCam,
                    audio: metadata.audio,
                    isDublado: metadata.isDublado,
                    isLegendado: metadata.isLegendado,
                    tmdbId: metadata.tmdbId
                });
            } else {
                await this.catalogoManager.adicionarFilme(
                    metadata.nome,
                    metadata.sinopse,
                    uploadResult.messageId,
                    'filme',
                    true,
                    {
                        ...metadata,
                        fileId: uploadResult.fileId
                    }
                );
            }
        } else {
            await this.catalogoManager.adicionarEpisodioSerie(
                metadata.nome,
                job.season || 1,
                job.episode || 1,
                uploadResult.messageId,
                uploadResult.fileId,
                {
                    ...metadata,
                    episodioNome: metadata.episodioNome
                }
            );
        }

        // Se o download bruto for Dual Áudio (tem Áudio Dublado E também Legendas/Áudio Original),
        // gera e envia automaticamente a versão Legendada a partir do MESMO arquivo sem precisar baixar de novo!
        if (langInfo && langInfo.hasBoth && rawFilePath && fs.existsSync(rawFilePath)) {
            try {
                console.log(`🎙️ [DUAL ÁUDIO DETECTADO] Aproveitando o download único para gerar e subir também a versão LEGENDADA oficial...`);
                const optLegPath = path.join(path.dirname(rawFilePath), `opt_leg_${path.basename(rawFilePath, path.extname(rawFilePath))}.mp4`);
                
                await VideoProcessor.optimizeForTelegram(rawFilePath, optLegPath, null, {
                    nome: job.title,
                    tipo: job.type,
                    season: job.season,
                    episode: job.episode,
                    totalTemporadas: metadata.totalTemporadas,
                    totalEpisodios: metadata.totalEpisodios,
                    imdbId: metadata.imdbId,
                    tmdbId: metadata.tmdbId,
                    subtitleUrl: bestSource?.subtitleUrl,
                    isDublado: false,
                    isLegendado: true
                });

                if (fs.existsSync(optLegPath)) {
                    const metaLeg = {
                        ...metadata,
                        audio: 'Legendado (PT-BR)',
                        isDublado: false,
                        isLegendado: true
                    };
                    const uploadLegResult = await this.uploader.uploadVideo(optLegPath, metaLeg);
                    
                    if (job.type === 'filme') {
                        await this.catalogoManager.atualizarMidiaFilme(metadata.nome, {
                            messageId: uploadLegResult.messageId,
                            fileId: uploadLegResult.fileId,
                            qualidade: metadata.qualidade,
                            isCam: metadata.isCam,
                            audio: 'Legendado (PT-BR)',
                            isDublado: false,
                            isLegendado: true,
                            tmdbId: metadata.tmdbId
                        });
                    } else {
                        await this.catalogoManager.adicionarEpisodioSerie(
                            metadata.nome,
                            job.season || 1,
                            job.episode || 1,
                            uploadLegResult.messageId,
                            uploadLegResult.fileId,
                            {
                                ...metaLeg,
                                episodioNome: metadata.episodioNome
                            }
                        );
                    }
                    console.log(`✅ [DUAL ÁUDIO] Versão Legendada gerada e vinculada ao catálogo com sucesso! (MessageId: ${uploadLegResult.messageId})`);
                    await DownloaderManager.cleanupFile(optLegPath);
                }
            } catch (errLeg) {
                console.warn('⚠️ Não foi possível gerar versão legendada complementar no dual áudio:', errLeg.message);
            }
        }

        // Se o arquivo possui AMBAS as versões (Dublado e Legendado) a partir do mesmo download,
        // marca como concluídos quaisquer jobs pendentes na fila para a outra versão, evitando download duplicado!
        if (metadata.isDublado && metadata.isLegendado) {
            console.log(`✨ Conteúdo possui Áudio Dublado + Legenda PT-BR no mesmo arquivo! Auto-concluindo pedidos pendentes da versão alternativa...`);
            try {
                if (job.type === 'filme') {
                    await db.query(
                        `UPDATE queue_jobs SET status = 'completed', progress = 100, progress_details = 'Concluído via versão Dual + Sub' 
                         WHERE title ILIKE $1 AND type = 'filme' AND id != $2 AND status = 'queued'`,
                        [job.title, job.id]
                    );
                } else {
                    await db.query(
                        `UPDATE queue_jobs SET status = 'completed', progress = 100, progress_details = 'Concluído via versão Dual + Sub' 
                         WHERE title ILIKE $1 AND type = 'serie' AND season = $2 AND episode = $3 AND id != $4 AND status = 'queued'`,
                        [job.title, job.season || 1, job.episode || 1, job.id]
                    );
                }
            } catch (e) {}
        }

        // 7. Notificação formal EXCLUSIVAMENTE no Grupo de Armazém
        // 7. Notificação formal nos Grupos e Canais oficiais
        try {
            const storageGroupId = config.STORAGE_GROUP_ID;
            const notifGroupId = config.NOTIFICATION_GROUP_ID;

            if (this.bot) {
                const tipoTexto = job.type === 'serie' ? `📺 *Série/Dorama:* ${metadata.nome} (T${job.season || 1}E${job.episode || 1})` : `🎬 *Filme:* ${metadata.nome}${metadata.ano ? ` (${metadata.ano})` : ''}`;
                const fonteInfo = bestSource?.title || bestSource?.provider || bestSource?.source || 'Automática (Torrentio/Stremio)';

                let audioBloco = '🔊 *Áudio:* Dublado (Áudio PT-BR)';
                if (metadata.isDublado && metadata.isLegendado) {
                    audioBloco = '🔊 *Áudio:* Dual Áudio (Dublado + Original)\n📝 *Legendas:* Português (PT-BR)';
                } else if (metadata.isLegendado) {
                    audioBloco = '🔊 *Áudio:* Original (Inglês)\n📝 *Legendas:* Português (PT-BR) [Embutida/Hardsub]';
                }

                const notifMsg = `✅ *Conteúdo Armazenado & Catalogado com Sucesso!*\n\n` +
                                 `${tipoTexto}\n` +
                                 `✨ *Qualidade:* ${metadata.qualidade || '1080p Full HD'}\n` +
                                 `${audioBloco}\n` +
                                 `📦 *Fonte/Release:* \`${fonteInfo}\`\n` +
                                 `🆔 *Message ID:* \`${uploadResult.messageId}\`\n\n` +
                                 `🍿 *Disponível imediatamente para todos os usuários!*`;

                if (storageGroupId) {
                    await this.bot.sendMessage(storageGroupId, notifMsg, { parse_mode: 'Markdown' }).catch(() => {});
                }
                if (notifGroupId && notifGroupId !== storageGroupId) {
                    await this.bot.sendMessage(notifGroupId, notifMsg, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        } catch (e) {}

        // 8. Limpeza dos arquivos temporários
        await DownloaderManager.cleanupFile(rawFilePath);
        await DownloaderManager.cleanupFile(optimizedPath);

        // 9. Notificação de Pedido Concluído (notifica exclusivamente clientes que fizeram o pedido)
        try {
            const itemSalvo = this.catalogoManager.buscarItemExato(metadata.nome, job.type);
            const itemId = itemSalvo?.id;
            const callbackAssistir = job.type === 'filme' ? `info_filme_${itemId}` : `info_serie_${itemId}`;

            // Notifica usuário solicitante (somente se não for a conta de admin para evitar spam)
            if (job.type === 'filme' && job.userId && job.userId !== config.ADMIN_ID && this.bot) {
                const mensagem = `🎉 *Seu pedido chegou no BrasilFlix!*\n\n` +
                                `🎬 *${metadata.nome}*\n` +
                                `✨ *Qualidade:* 1080p Full HD\n` +
                                `🔊 *Versão:* ${metadata.audio || 'Dublado (Áudio PT-BR)'}\n\n` +
                                `Já está no catálogo e pronto para você assistir! 🍿`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '▶️ Assistir Agora', callback_data: callbackAssistir }]
                    ]
                };

                this.bot.sendMessage(job.userId, mensagem, {
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                }).catch(() => {});
            }

            // Para filmes: marca o pedido como atendido no catálogo (para séries, marca apenas ao completar a temporada)
            if (job.type === 'filme') {
                await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'filme');
            }

            // Notificação para quem favoritou a série quando sai novo episódio
            if (job.type === 'serie' && this.favoritosManager && itemId && this.bot) {
                const usuariosFav = this.favoritosManager.getUsuariosQueFavoritaram(itemId, 'serie');
                const epSeason = job.season || 1;
                const epNum = job.episode || 1;

                for (const uid of usuariosFav) {
                    if (uid.toString() === job.userId?.toString()) continue;
                    const msgFav = `🔔 *Novo Episódio Disponível!*\n\n` +
                                  `📺 *${metadata.nome}* — Temporada ${epSeason}, Episódio ${epNum}\n` +
                                  `🔊 *Áudio:* ${metadata.audio || 'Dublado (PT-BR)'}\n\n` +
                                  `Novo episódio da sua série favorita acabou de chegar no catálogo!`;

                    this.bot.sendMessage(uid, msgFav, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '📺 Assistir Episódio', callback_data: `serie_ep_${itemId}_${epSeason}_${epNum}` }]]
                        }
                    }).catch(() => {});
                }
            }
        } catch (errNotif) {
            console.warn('⚠️ Erro ao disparar notificações de conclusão:', errNotif.message);
        }

        // 9.5 Esteira Contínua para Filmes: Se faltar a versão complementar (Dublado ou Legendado), enfileira automaticamente!
        if (job.type === 'filme') {
            const itemAtualizado = this.catalogoManager.buscarItemExato(metadata.nome, 'filme');
            const temDublado = itemAtualizado?.isDublado || !!itemAtualizado?.versoes?.dublado;
            const temLegendado = itemAtualizado?.isLegendado || !!itemAtualizado?.versoes?.legendado;

            if (metadata.isDublado && !temLegendado) {
                console.log(`💬 [ESTEIRA DUAL] "${metadata.nome}" cadastrado dublado. Enfileirando versão Legendada em background...`);
                this.addJob(metadata.nome, 'filme', PRIORITIES.FEEDER, {
                    tmdbId: metadata.tmdbId,
                    audioPreference: 'legendado'
                });
            } else if (metadata.isLegendado && !temDublado) {
                console.log(`🇧🇷 [ESTEIRA DUAL] "${metadata.nome}" cadastrado legendado. Enfileirando busca por versão Dublada em background...`);
                this.addJob(metadata.nome, 'filme', PRIORITIES.FEEDER, {
                    tmdbId: metadata.tmdbId,
                    audioPreference: 'dublado'
                });
            }
        }

        // 10. Se for Série/Dorama, enfileira o próximo episódio e próxima temporada automaticamente até completar 100%!
        if (job.type === 'serie') {
            const currentSeasonNum = job.season || 1;
            const currentEpNum = job.episode || 1;

            // Obter informações exatas de episódios e temporadas do TMDB
            let totalEpsNestaTemporada = 10;
            let totalTemporadas = metadata.totalTemporadas || (metadata.temporadas ? metadata.temporadas.length : 1);

            try {
                if (metadata.tmdbId) {
                    const seasonInfo = await TMDBService.getSeasonDetails(metadata.tmdbId, currentSeasonNum);
                    if (seasonInfo && seasonInfo.episodios && seasonInfo.episodios.length > 0) {
                        totalEpsNestaTemporada = seasonInfo.episodios.length;
                    } else {
                        const temporadaAtual = (metadata.temporadas || []).find(t => t.numero === currentSeasonNum);
                        if (temporadaAtual && temporadaAtual.episodiosContagem > 0) {
                            totalEpsNestaTemporada = temporadaAtual.episodiosContagem;
                        }
                    }
                }
            } catch (e) {
                const temporadaAtual = (metadata.temporadas || []).find(t => t.numero === currentSeasonNum);
                totalEpsNestaTemporada = temporadaAtual?.episodiosContagem || 10;
            }

            // Se o episódio atual foi catalogado como Legendado, verifica se episódios anteriores só têm versão Dublada e enfileira a Legendada para manter 100% de cobertura
            if (metadata.isLegendado) {
                const sItem = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie');
                const tItem = (sItem?.temporadas || []).find(t => t.numero === currentSeasonNum);
                for (let ep = 1; ep < currentEpNum; ep++) {
                    const prevEp = (tItem?.episodios || []).find(e => e.numero === ep);
                    if (prevEp && !prevEp.isLegendado && !prevEp.audio?.toLowerCase().includes('legendado')) {
                        console.log(`💬 [ESTEIRA DUAL SÉRIE] Enfileirando versão Legendada complementar para "${metadata.nome || job.title}" - T${currentSeasonNum}E${ep}...`);
                        this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                            tmdbId: metadata.tmdbId,
                            season: currentSeasonNum,
                            episode: ep,
                            audioPreference: 'legendado',
                            queueOrder: -1
                        });
                    }
                }
            }

            const nextEp = currentEpNum + 1;

            if (nextEp <= totalEpsNestaTemporada) {
                // Próximo episódio da mesma temporada — Prioridade VIP_USER e queueOrder -1 para terminar a série antes de ir para outra!
                console.log(`📺 [SÉRIE/DORAMA] Enfileirando próximo episódio COM PRIORIDADE MÁXIMA (continuidade): "${metadata.nome || job.title}" - T${currentSeasonNum}E${nextEp} (de ${totalEpsNestaTemporada} eps)`);
                this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                    tmdbId: metadata.tmdbId,
                    season: currentSeasonNum,
                    episode: nextEp,
                    userId: job.userId,
                    username: job.username,
                    audioPreference: job.audioPreference || 'dublado',
                    queueOrder: -1
                });
            } else {
                // Temporada atual concluída! Notifica clientes sobre a temporada completa
                if (job.userId && job.userId !== config.ADMIN_ID && this.bot) {
                    const itemSalvo = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie');
                    const sId = itemSalvo?.id || '';
                    const msgTemporada = `🎉 *Temporada ${currentSeasonNum} Completa Disponível!*\n\n` +
                                         `📺 *${metadata.nome || job.title}*\n` +
                                         `✨ Todos os episódios da Temporada ${currentSeasonNum} já estão catalogados em 1080p Full HD!\n\n` +
                                         `🍿 Aproveite e assista agora!`;
                    this.bot.sendMessage(job.userId, msgTemporada, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            inline_keyboard: [[{ text: '▶️ Assistir Série', callback_data: `info_serie_${sId}` }]]
                        }
                    }).catch(() => {});

                    if (this.pedidosManager) {
                        await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'serie');
                    }
                }

                // Avança para a próxima temporada com prioridade contínua
                const nextSeasonNum = currentSeasonNum + 1;
                if (nextSeasonNum <= totalTemporadas) {
                    console.log(`📺 [SÉRIE/DORAMA] Temporada ${currentSeasonNum} concluída! Avançando para Temporada ${nextSeasonNum} (Episódio 1) de "${metadata.nome || job.title}"`);
                    this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                        tmdbId: metadata.tmdbId,
                        season: nextSeasonNum,
                        episode: 1,
                        userId: job.userId,
                        username: job.username,
                        audioPreference: job.audioPreference || 'dublado',
                        queueOrder: -1
                    });
                } else {
                    console.log(`🎉 [SÉRIE/DORAMA] SÉRIE COMPLETA! Todas as ${totalTemporadas} temporada(s) de "${metadata.nome || job.title}" foram catalogadas com sucesso!`);
                }
            }
        }
    }

    getStatus() {
        return {
            total: this.queue.length,
            queued: this.queue.filter(j => j.status === 'queued').length,
            completed: this.queue.filter(j => j.status === 'completed').length,
            failed: this.queue.filter(j => j.status === 'failed').length,
            activeTask: this.activeTask
        };
    }

    getPublicStatus(catalogoManager = null) {
        const priorityLabels = {
            1: 'VIP 🔥',
            2: 'Pedido 🍿',
            3: 'Série 📺',
            4: 'Auto-Feeder 🤖'
        };

        const formatJob = (j) => ({
            id: j.id,
            title: j.title,
            type: j.type,
            priority: priorityLabels[j.priority] || 'Normal',
            audioPreference: j.audioPreference || 'dublado',
            season: j.type === 'serie' ? (j.season || 1) : null,
            episode: j.type === 'serie' ? (j.episode || 1) : null,
            status: j.status,
            progress: typeof j.progress === 'number' ? Math.round(j.progress) : 0,
            progressDetails: j.progressDetails || '',
            createdAt: j.createdAt
        });

        const active = this.activeTask ? formatJob(this.activeTask) : null;
        const pending = this.queue
            .filter(j => j.status === 'queued')
            .map(formatJob);
        
        // Itens recentes baseados estritamente no catálogo ativo real
        const cat = catalogoManager || this.catalogoManager;
        let recentCompleted = [];

        if (cat && cat.catalogo) {
            const filmesRecentes = (cat.catalogo.filmes || []).map(f => ({
                id: f.id,
                title: f.nome,
                type: 'filme',
                season: null,
                episode: null,
                qualidade: f.qualidade || '1080p Full HD',
                data: new Date(f.dataAdicionado || 0).getTime()
            }));

            const epsRecentes = [];
            for (const s of (cat.catalogo.series || [])) {
                for (const t of (s.temporadas || [])) {
                    for (const ep of (t.episodios || [])) {
                        epsRecentes.push({
                            id: ep.id || s.id,
                            title: s.nome,
                            type: 'serie',
                            season: t.numero,
                            episode: ep.numero,
                            qualidade: ep.qualidade || '1080p Full HD',
                            data: new Date(ep.dataAdicionado || s.dataAdicionado || 0).getTime()
                        });
                    }
                }
            }

            recentCompleted = [...filmesRecentes, ...epsRecentes]
                .sort((a, b) => b.data - a.data)
                .slice(0, 6);
        } else {
            recentCompleted = this.queue
                .filter(j => j.status === 'completed')
                .slice(-6)
                .reverse()
                .map(formatJob);
        }

        return {
            isProcessing: this.isProcessing,
            activeTask: active,
            queue: pending,
            recentCompleted: recentCompleted,
            totalQueued: pending.length
        };
    }

    async updatePriority(jobId, newPriority) {
        const priorityInt = parseInt(newPriority, 10);
        if (isNaN(priorityInt) || priorityInt < 1 || priorityInt > 4) {
            throw new Error('Prioridade inválida (deve ser entre 1 e 4).');
        }

        const job = this.queue.find(j => j.id === jobId);
        if (job) {
            job.priority = priorityInt;
            this.sortQueue();
            await this.saveJob(job);
            return job;
        }

        // Se não estiver na memória, atualiza no PostgreSQL
        await db.query(`UPDATE queue_jobs SET priority = $1, updated_at = NOW() WHERE id = $2`, [priorityInt, jobId]);
        return { id: jobId, priority: priorityInt };
    }

    async editJob(jobId, updates = {}) {
        let job = this.queue.find(j => j.id === jobId);
        if (!job) {
            const res = await db.query(`SELECT * FROM queue_jobs WHERE id = $1`, [jobId]);
            if (res.rows.length === 0) {
                throw new Error('Trabalho não encontrado no banco de dados.');
            }
            job = this._rowToJob(res.rows[0]);
        }

        if (updates.title) job.title = updates.title.trim();
        if (updates.type) job.type = updates.type;
        if (updates.audioPreference) job.audioPreference = updates.audioPreference;
        if (updates.priority !== undefined) job.priority = parseInt(updates.priority, 10);
        if (updates.season !== undefined) job.season = updates.type === 'serie' ? parseInt(updates.season || 1, 10) : null;
        if (updates.episode !== undefined) job.episode = updates.type === 'serie' ? parseInt(updates.episode || 1, 10) : null;
        if (updates.rawFilePath !== undefined) job.rawFilePath = updates.rawFilePath;
        if (updates.isManualAdd !== undefined) job.isManualAdd = updates.isManualAdd;

        if (updates.metaDetails) {
            job.metaDetails = {
                ...(job.metaDetails || {}),
                ...updates.metaDetails
            };
        }

        // Se o job estava com erro/falha ou se foi solicitado requeue, reseta status para queued
        if (job.status === 'failed' || updates.requeue) {
            job.status = 'queued';
            job.progress = 0;
            job.error = null;
            job.progressDetails = 'Atualizado pelo Administrador';
        }

        const memIdx = this.queue.findIndex(j => j.id === jobId);
        if (memIdx >= 0) {
            this.queue[memIdx] = job;
        } else if (job.status === 'queued') {
            this.queue.push(job);
        }

        this.sortQueue();
        await this.saveJob(job);
        return job;
    }

    async deleteJob(jobId, deletePhysicalFile = true) {
        const job = this.queue.find(j => j.id === jobId);
        if (job && job.rawFilePath && deletePhysicalFile) {
            try {
                if (fs.existsSync(job.rawFilePath)) {
                    await fs.remove(job.rawFilePath);
                }
            } catch (err) {
                console.warn('⚠️ Não foi possível excluir arquivo físico do upload:', err.message);
            }
        }

        this.queue = this.queue.filter(j => j.id !== jobId);
        await db.query(`DELETE FROM queue_jobs WHERE id = $1`, [jobId]);
        return { success: true, id: jobId };
    }

    async cancelJob(jobId) {
        const job = this.queue.find(j => j.id === jobId);
        if (job) {
            job.status = 'failed';
            job.error = 'Cancelado pelo Administrador';
            await this.saveJob(job);
            this.queue = this.queue.filter(j => j.id !== jobId);
        } else {
            await db.query(`DELETE FROM queue_jobs WHERE id = $1`, [jobId]);
        }
        return { success: true, id: jobId };
    }

    async retryJob(jobId) {
        const res = await db.query(`SELECT * FROM queue_jobs WHERE id = $1`, [jobId]);
        if (res.rows.length === 0) {
            throw new Error('Job não encontrado no banco de dados.');
        }

        const row = res.rows[0];
        const job = this._rowToJob(row);
        job.status = 'queued';
        job.progress = 0;
        job.progressDetails = 'Reenfileirado pelo Administrador';
        job.error = null;

        // Se já estava na fila em memória, atualiza
        const existingIdx = this.queue.findIndex(j => j.id === jobId);
        if (existingIdx >= 0) {
            this.queue[existingIdx] = job;
        } else {
            this.queue.push(job);
        }

        this.sortQueue();
        await this.saveJob(job);

        // Dispara processador caso ocioso
        this.processNext();
        return job;
    }

    async moveJobToTop(jobId) {
        const currentIdx = this.queue.findIndex(j => j.id === jobId);
        if (currentIdx > -1) {
            const [job] = this.queue.splice(currentIdx, 1);
            this.queue.unshift(job);
        } else {
            const res = await db.query(`SELECT * FROM queue_jobs WHERE id = $1`, [jobId]);
            if (res.rows.length > 0) {
                const j = this._rowToJob(res.rows[0]);
                this.queue.unshift(j);
            }
        }

        // Reindexa toda a fila com valores estritamente crescentes
        const baseOrder = 1000;
        for (let i = 0; i < this.queue.length; i++) {
            this.queue[i].queueOrder = baseOrder + (i * 10);
            await db.query(`UPDATE queue_jobs SET queue_order = $1 WHERE id = $2`, [this.queue[i].queueOrder, this.queue[i].id]);
        }

        this.sortQueue();
        const topJob = this.queue[0];
        return topJob;
    }

    async moveJobStep(jobId, direction = 'up') {
        const currentIdx = this.queue.findIndex(j => j.id === jobId);
        if (currentIdx === -1) {
            await this.loadQueue();
        }
        const idx = this.queue.findIndex(j => j.id === jobId);
        if (idx === -1) return { success: false, error: 'Trabalho não encontrado na fila.' };

        const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= this.queue.length) return { success: true };

        const currentJob = this.queue[idx];
        const targetJob = this.queue[targetIdx];

        this.queue[idx] = targetJob;
        this.queue[targetIdx] = currentJob;

        const baseOrder = 1000;
        for (let i = 0; i < this.queue.length; i++) {
            this.queue[i].queueOrder = baseOrder + (i * 10);
            await db.query(`UPDATE queue_jobs SET queue_order = $1 WHERE id = $2`, [this.queue[i].queueOrder, this.queue[i].id]);
        }

        this.sortQueue();
        return { success: true, message: `Trabalho movido para ${direction === 'up' ? 'cima' : 'baixo'} com sucesso!` };
    }

    async reorderQueue(orderedJobIds) {
        if (!Array.isArray(orderedJobIds) || orderedJobIds.length === 0) return { success: false };

        const baseOrder = 1000;
        for (let i = 0; i < orderedJobIds.length; i++) {
            const id = orderedJobIds[i];
            const orderVal = baseOrder + (i * 10);
            const job = this.queue.find(j => j.id === id);
            if (job) {
                job.queueOrder = orderVal;
            }
            await db.query(`UPDATE queue_jobs SET queue_order = $1 WHERE id = $2`, [orderVal, id]);
        }
        this.sortQueue();
        return { success: true };
    }

    async clearFailed() {
        await db.query(`DELETE FROM queue_jobs WHERE status = 'failed'`);
        this.queue = this.queue.filter(j => j.status !== 'failed');
        return { success: true };
    }

    async getAllAdminJobs(limit = 100) {
        const res = await db.query(
            `SELECT * FROM queue_jobs ORDER BY 
                CASE 
                    WHEN status = 'processing' THEN 1 
                    WHEN status = 'downloading' THEN 2 
                    WHEN status = 'uploading' THEN 3 
                    WHEN status = 'queued' THEN 4 
                    WHEN status = 'failed' THEN 5 
                    ELSE 6 
                END, 
                queue_order ASC, 
                created_at ASC 
            LIMIT $1`,
            [limit]
        );
        return res.rows.map(row => this._rowToJob(row));
    }
}

module.exports = { QueueManager, PRIORITIES };
