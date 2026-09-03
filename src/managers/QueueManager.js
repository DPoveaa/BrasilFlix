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
const DiskCleaner = require('../services/DiskCleaner');
const SwarmWatcher = require('../services/SwarmWatcher');
const SchedulerService = require('../services/SchedulerService');

const PriorityService = require('../services/PriorityService');

// Proxy dinâmico: os valores são sempre lidos do PriorityService (podem ser alterados em runtime via painel admin)
const PRIORITIES = new Proxy({}, {
    get(_, key) {
        return PriorityService.get(key);
    }
});


function normalizeTitle(title) {
    if (!title) return '';
    return String(title)
        .toLowerCase()
        .replace(/\s*\(\d{4}\)|\b\d{4}\b/g, '') // remove anos como (2018), 2023
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9]/g, '') // remove pontuacao e espacos
        .trim();
}

class QueueManager extends EventEmitter {
    constructor(bot, catalogoManager, pedidosManager = null, favoritosManager = null) {
        super();
        this.bot = bot;
        this.catalogoManager = catalogoManager;
        this.pedidosManager = pedidosManager;
        this.favoritosManager = favoritosManager;
        this.uploader = new TelegramUploader(bot);
        this.queue = []; // cache em memória sincronizado com o banco
        this.activeJobs = new Map(); // Mapa de jobs ativos em paralelo: id -> job
        this.transcodeLocks = new Set(); // Lock de transcode por chave única (tipo_title_s_e) para evitar remux duplicado
        this.maxConcurrentJobs = config.MAX_CONCURRENT_JOBS || 10;
        this.maxConcurrentDownloads = config.MAX_CONCURRENT_DOWNLOADS || 4;
        this.maxConcurrentUploads = config.MAX_CONCURRENT_UPLOADS || 4;
        this.skippedEpisodes = new Map(); // Controle de episódios sem sementes / pulados para evitar loops

        // Notificação em tempo real quando o agendador autorizar ou alterar o modo da esteira
        SchedulerService.on('stateChange', async ({ allowed, mode, reason }) => {
            if (allowed) {
                const modoDesc = mode === 'eco' ? 'ECONÔMICO (QoS Residencial - Sem Impacto na Rede)' : 'DESEMPENHO MÁXIMO (Velocidade Total)';
                console.log(`⏰ [Scheduler -> Queue] Esteira operando em Modo ${modoDesc} (${reason}).`);
                
                if (mode === 'eco') {
                    // Se mudou para Econômico, garante que NÃO existam múltiplos downloads/jobs rodando em paralelo
                    this.enforceConcurrencyLimits();
                } else {
                    setImmediate(() => this.processNext());
                }
            } else {
                console.log(`⏰ [Scheduler -> Queue] Janela pausada (${reason}). Pausando downloads ativos...`);
                this.enforceConcurrencyLimits();
            }
        });



        // Inicializa banco, prioridades e carrega fila de forma assíncrona
        this._init();
    }

    get isProcessing() {
        return this.activeJobs.size > 0;
    }

    get activeTask() {
        return this.activeJobs.values().next().value || null;
    }

    set activeTask(val) {
        if (val && val.id) {
            this.activeJobs.set(val.id, val);
        }
    }

    getActiveTasks() {
        return Array.from(this.activeJobs.values());
    }

    getStatus() {
        const activeTasks = Array.from(this.activeJobs.values());
        const queuedJobs = this.queue.filter(j => j.status === 'queued' && !this.activeJobs.has(j.id));
        return {
            isProcessing: activeTasks.length > 0,
            activeTask: activeTasks[0] || null,
            activeTasks: activeTasks,
            totalActive: activeTasks.length,
            maxConcurrentJobs: this.maxConcurrentJobs || 10,
            maxConcurrentDownloads: this.maxConcurrentDownloads || 4,
            maxConcurrentTranscodes: config.MAX_CONCURRENT_TRANSCODES || 2,
            maxConcurrentUploads: this.maxConcurrentUploads || 4,
            totalQueued: queuedJobs.length,
            queued: queuedJobs.length,
            total: this.queue.length + activeTasks.length,
            completed: 0,
            queue: queuedJobs,
            scheduler: SchedulerService.getStatus()
        };
    }

    getPublicStatus(catalogoManager) {
        const activeTasks = Array.from(this.activeJobs.values()).map(task => ({
            id: task.id,
            title: task.title,
            type: task.type,
            season: task.season,
            episode: task.episode,
            status: task.status,
            progress: typeof task.progress === 'number' ? Math.round(task.progress) : 0,
            progressDetails: task.progressDetails || '',
            priority: task.priority || 2,
            audioPreference: task.audioPreference || 'dublado',
            createdAt: task.createdAt
        }));

        const queued = this.queue.filter(j => j.status === 'queued' && !this.activeJobs.has(j.id)).map(j => ({
            id: j.id,
            title: j.title,
            type: j.type,
            season: j.season,
            episode: j.episode,
            status: j.status,
            priority: j.priority || 2,
            audioPreference: j.audioPreference || 'dublado',
            createdAt: j.createdAt
        }));

        return {
            isProcessing: activeTasks.length > 0,
            activeTask: activeTasks[0] || null,
            activeTasks: activeTasks,
            totalActive: activeTasks.length,
            maxConcurrentJobs: this.maxConcurrentJobs || 10,
            maxConcurrentDownloads: this.maxConcurrentDownloads || 4,
            maxConcurrentTranscodes: config.MAX_CONCURRENT_TRANSCODES || 2,
            maxConcurrentUploads: this.maxConcurrentUploads || 4,
            totalQueued: queued.length,
            queue: queued,
            scheduler: SchedulerService.getStatus()
        };
    }

    getActiveFiles() {
        const files = [];
        for (const task of this.activeJobs.values()) {
            if (task.rawFilePath) files.push(task.rawFilePath);
            if (task.optimizedFilePath) files.push(task.optimizedFilePath);
            if (task.optimizedPath) files.push(task.optimizedPath);
        }
        for (const j of this.queue) {
            if (j.rawFilePath) files.push(j.rawFilePath);
            if (j.optimizedFilePath) files.push(j.optimizedFilePath);
            if (j.optimizedPath) files.push(j.optimizedPath);
        }
        if (DownloaderManager && DownloaderManager.activePaths) {
            for (const p of DownloaderManager.activePaths) {
                files.push(p);
            }
        }
        return files;
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
            await PriorityService.load();
        } catch (e) {
            console.warn('⚠️ Falha ao carregar prioridades, usando padrões:', e.message);
        }
        try {
            await this.loadQueue();
        } catch (e) {
            console.error('❌ Erro ao inicializar fila do banco:', e.message);
        }
        setTimeout(() => this.processNext(), 2000);
    }

    enforceConcurrencyLimits() {
        const currentMode = SchedulerService.getActiveMode();
        const isAllowed = SchedulerService.isAllowedToRun();

        if (!isAllowed) {
            // Pausa total: cancela todos os downloads e uploads ativos
            for (const [jobId, job] of this.activeJobs.entries()) {
                const isOptimizing = job.progressDetails && job.progressDetails.includes('Otimizando');
                if (isOptimizing) continue; // deixa transcode de CPU/GPU terminar sem rede

                if (job.status === 'downloading' || job.status === 'searching' || job.status === 'processing') {
                    console.log(`🛑 [Scheduler Pausa] Abortando download de "${job.title}" e devolvendo à fila.`);
                    DownloaderManager.cancelDownload(jobId);
                    job.status = 'queued';
                    job.progress = 0;
                    job.progressDetails = 'Aguardando janela de download...';
                    this.saveJob(job).catch(() => {});
                    this.activeJobs.delete(jobId);
                } else if (job.status === 'uploading') {
                    console.log(`⏸️ [Scheduler Pausa] Segurando upload de "${job.title}".`);
                    job.status = 'queued';
                    job.progress = 100;
                    job.progressDetails = '100% Otimizado. Aguardando janela de upload...';
                    this.saveJob(job).catch(() => {});
                    this.activeJobs.delete(jobId);
                }
            }
        } else if (currentMode === 'eco') {
            // Em modo econômico: mantém limites independentes por etapa (1 download, 2 transcodes locais, 1 upload)
            const activeDownloads = [];
            const activeUploads = [];
            for (const job of this.activeJobs.values()) {
                if (job.status === 'downloading' || job.status === 'searching') {
                    activeDownloads.push(job);
                } else if (job.status === 'uploading') {
                    activeUploads.push(job);
                }
            }

            // Se houver mais de 1 download em paralelo, devolve os excedentes para a fila
            if (activeDownloads.length > 1) {
                const excessDownloads = activeDownloads.slice(1);
                for (const excessJob of excessDownloads) {
                    console.log(`🍃 [Modo Econômico] Limitando downloads simultâneos a 1. Interrompendo download excedente de "${excessJob.title}" e devolvendo à fila.`);
                    DownloaderManager.cancelDownload(excessJob.id);
                    excessJob.status = 'queued';
                    excessJob.progress = 0;
                    excessJob.progressDetails = 'Aguardando vez na esteira (1 download por vez)...';
                    this.saveJob(excessJob).catch(() => {});
                    this.activeJobs.delete(excessJob.id);
                }
            }

            // Se houver mais de 1 upload em paralelo, segura os excedentes
            if (activeUploads.length > 1) {
                const excessUploads = activeUploads.slice(1);
                for (const excessJob of excessUploads) {
                    console.log(`🍃 [Modo Econômico] Limitando uploads simultâneos a 1. Segurando upload excedente de "${excessJob.title}".`);
                    excessJob.status = 'queued';
                    excessJob.progress = 100;
                    excessJob.progressDetails = '100% Otimizado. Aguardando vez no upload...';
                    this.saveJob(excessJob).catch(() => {});
                    this.activeJobs.delete(excessJob.id);
                }
            }
        }
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
                        metaDetails: job.metaDetails || null,
                        // Campos de categoria (essenciais para o escalonador de faixas)
                        isAnime: job.isAnime || false,
                        isDorama: job.isDorama || false,
                        isMicrodrama: job.isMicrodrama || false,
                        subtipo: job.subtipo || null,
                        originalLanguage: job.originalLanguage || job.idiomaOriginal || null
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
            // Campos de categoria restaurados do extra_data
            isAnime: extra.isAnime || false,
            isDorama: extra.isDorama || false,
            isMicrodrama: extra.isMicrodrama || false,
            subtipo: extra.subtipo || null,
            originalLanguage: extra.originalLanguage || null,
            idiomaOriginal: extra.originalLanguage || null,
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
            isUpgrade: extraData.isUpgrade || priority === PRIORITIES.CAM_UPGRADE || priority === PRIORITIES.UPGRADE_DUB || false,
            allowCam: extraData.allowCam !== undefined ? extraData.allowCam : (priority !== PRIORITIES.CAM_UPGRADE),
            isDorama: extraData.isDorama || false,
            isAnime: extraData.isAnime || false,
            isMicrodrama: extraData.isMicrodrama || false,
            subtipo: extraData.subtipo || null,
            originalLanguage: extraData.originalLanguage || extraData.idiomaOriginal || null,
            idiomaOriginal: extraData.originalLanguage || extraData.idiomaOriginal || null,
            category: extraData.category || (extraData.isAnime ? 'Anime' : (extraData.isDorama ? 'Dorama' : (extraData.isMicrodrama ? 'Microdrama' : null))),
            userId: extraData.userId || null,
            username: extraData.username || null,
            season: type === 'serie' ? (extraData.season || 1) : null,
            episode: type === 'serie' ? (extraData.episode || 1) : null,
            tmdbId: extraData.tmdbId || null,
            rawFilePath: extraData.rawFilePath || null,
            bestSource: extraData.bestSource || null,
            expectedSize: extraData.expectedSize || null,
            langInfo: extraData.langInfo || null,
            customMagnet: extraData.customMagnet || extraData.magnet || null,
            isManualAdd: extraData.isManualAdd || false,
            metaDetails: extraData.metaDetails || null,
            extraData: extraData,
            status: 'queued', // 'queued', 'downloading', 'processing', 'uploading', 'completed', 'failed'
            progress: 0,
            progressDetails: '',
            createdAt: new Date().toISOString(),
            error: null
        };

        if (extraData.rawFilePath) {
            job.priority = PRIORITIES.VIP_USER;
            job.queueOrder = extraData.queueOrder !== undefined ? extraData.queueOrder : -999;
            job.isManualAdd = true;
            job.progressDetails = 'Arquivo local pronto para processamento';
        }


        // Verifica se já existe um trabalho para este mesmo episódio ou filme na fila ou em processamento ativo
        const normNewTitle = normalizeTitle(title);
        const newSeason = type === 'serie' ? (job.season || 1) : null;
        const newEpisode = type === 'serie' ? (job.episode || 1) : null;
        const newTmdbId = extraData.tmdbId || null;

        const allCurrentJobs = [...this.queue, ...Array.from(this.activeJobs.values())];
        const existing = allCurrentJobs.find(j => {
            if (j.type !== type) return false;
            if (j.status === 'completed' || j.status === 'failed') return false;

            const normExistingTitle = normalizeTitle(j.title);
            const isSameTitle = normExistingTitle === normNewTitle || (newTmdbId && j.tmdbId && j.tmdbId === newTmdbId);
            if (!isSameTitle) return false;

            if (type === 'serie') {
                const s = j.season || 1;
                const e = j.episode || 1;
                return s === newSeason && e === newEpisode;
            }
            return true;
        });

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

            console.log(`ℹ️ [Fila] Trabalho para "${job.title}" ${type === 'serie' ? `T${job.season || 1}E${job.episode || 1}` : ''} já existe na esteira (ID: ${existing.id}, Status: ${existing.status}). Evitando duplicata.`);
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
                    const epDub = epExistente.isDublado || !!epExistente.versoes?.dublado || epExistente.audio?.toLowerCase().includes('dublado');
                    const epLeg = epExistente.isLegendado || !!epExistente.versoes?.legendado || epExistente.audio?.toLowerCase().includes('legendado');
                    const audioMatches = (pref === 'dublado' && epDub) || (pref === 'legendado' && epLeg) || (epDub && epLeg);

                    if (audioMatches) {
                        if (!extraData.isManualAdd || (!extraData.episode && !extraData.season)) {
                            let nextMissing = null;
                            for (let ep = 1; ep <= 30; ep++) {
                                const epObj = (temporada?.episodios || []).find(e => e.numero === ep);
                                if (!epObj) {
                                    nextMissing = ep;
                                    break;
                                }
                                const isD = epObj.isDublado || !!epObj.versoes?.dublado || epObj.audio?.toLowerCase().includes('dublado');
                                const isL = epObj.isLegendado || !!epObj.versoes?.legendado || epObj.audio?.toLowerCase().includes('legendado');
                                if ((pref === 'dublado' && !isD) || (pref === 'legendado' && !isL)) {
                                    nextMissing = ep;
                                    break;
                                }
                            }
                            if (nextMissing) {
                                console.log(`📺 [Fila] "${title}" T${job.season}E${job.episode} já existe com áudio ${pref}. Direcionando trabalho para o próximo episódio pendente: T${job.season}E${nextMissing}`);
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

    findNextJobToProcess(capacity = { canDownload: true, canTranscode: true, canUpload: true }) {
        if (this.queue.length === 0) return null;

        // Inclui jobs em queued e também jobs em processing/downloading/uploading que ficaram órfãos (sem worker ativo)
        const queuedJobs = this.queue.filter(j => 
            (j.status === 'queued' || j.status === 'processing' || j.status === 'downloading' || j.status === 'uploading') && 
            !this.activeJobs.has(j.id)
        );
        if (queuedJobs.length === 0) return null;

        // Constrói um set de chaves de títulos / episódios ATIVOS para evitar qualquer concorrência sobre o mesmo item
        const activeKeys = new Set();
        const activeSeriesDownloading = new Set(); // Evita baixar múltiplos torrents em paralelo para a MESMA série

        for (const active of this.activeJobs.values()) {
            const normTitle = normalizeTitle(active.title);
            if (active.type === 'serie') {
                const s = active.season ?? 1;
                const e = active.episode ?? 1;
                activeKeys.add(`serie_${normTitle}_s${s}_e${e}`);
                if (active.tmdbId) activeKeys.add(`serie_tmdb_${active.tmdbId}_s${s}_e${e}`);

                const hasLocal = (active.rawFilePath && fs.existsSync(active.rawFilePath)) || (active.optimizedPath && fs.existsSync(active.optimizedPath));
                if (!hasLocal && (active.status === 'downloading' || active.status === 'searching' || active.status === 'processing')) {
                    activeSeriesDownloading.add(normTitle);
                    if (active.tmdbId) activeSeriesDownloading.add(`tmdb_${active.tmdbId}`);
                }
            } else {
                activeKeys.add(`filme_${normTitle}`);
                if (active.tmdbId) activeKeys.add(`filme_tmdb_${active.tmdbId}`);
            }
        }

        // Filtra jobs cujo episódio ou filme já está sendo processado ativamente ou já foi concluído no catálogo
        let eligibleJobs = [];
        for (const j of queuedJobs) {
            const normTitle = normalizeTitle(j.title);
            const hasRaw = !!(j.rawFilePath && fs.existsSync(j.rawFilePath));
            const hasOpt = !!(j.optimizedPath && fs.existsSync(j.optimizedPath));
            const hasLocalFile = hasRaw || hasOpt;

            if (j.type === 'serie') {
                const s = j.season ?? 1;
                const e = j.episode ?? 1;
                if (activeKeys.has(`serie_${normTitle}_s${s}_e${e}`)) continue;
                if (j.tmdbId && activeKeys.has(`serie_tmdb_${j.tmdbId}_s${s}_e${e}`)) continue;

                // Se NÃO tem arquivo local e a série já tem um download de torrent em andamento, pula para não baixar torrent concorrente duplicado
                if (!hasLocalFile) {
                    if (activeSeriesDownloading.has(normTitle) || (j.tmdbId && activeSeriesDownloading.has(`tmdb_${j.tmdbId}`))) {
                        continue;
                    }
                }

                // Checa se o episódio já está cadastrado no catálogo com a versão solicitada
                const isUpgradeJob = j.isUpgrade || j.extraData?.isUpgrade;
                if (this.catalogoManager && !j.isManualAdd && !isUpgradeJob) {
                    const serie = this.catalogoManager.buscarItemExato(j.title, 'serie', j.tmdbId);
                    if (serie) {
                        const tempObj = (serie.temporadas || []).find(t => t.numero === s);
                        const epObj = (tempObj?.episodios || []).find(ep => ep.numero === e);
                        if (epObj) {
                            const hasDub = epObj.isDublado || !!epObj.versoes?.dublado;
                            const hasLeg = epObj.isLegendado || !!epObj.versoes?.legendado;
                            const reqPref = j.audioPreference || 'dublado';
                            const isSatisfied = (reqPref === 'legendado' && hasLeg) || (reqPref === 'dublado' && hasDub);
                            if (isSatisfied) {
                                console.log(`✅ [Fila] Episódio "${j.title}" T${s}E${e} já está catalogado e satisfeito (${reqPref}). Marcando como concluído.`);
                                j.status = 'completed';
                                j.progress = 100;
                                j.progressDetails = 'Já catalogado anteriormente';
                                this.saveJob(j).catch(() => {});
                                this.queue = this.queue.filter(q => q.id !== j.id);
                                continue;
                            }
                        }
                    }
                }
            } else {
                if (activeKeys.has(`filme_${normTitle}`)) continue;
                if (j.tmdbId && activeKeys.has(`filme_tmdb_${j.tmdbId}`)) continue;

                const isUpgradeJob = j.isUpgrade || j.extraData?.isUpgrade || j.priority === PRIORITIES.CAM_UPGRADE || j.priority === PRIORITIES.UPGRADE_DUB;
                if (this.catalogoManager && !j.isManualAdd && !isUpgradeJob) {
                    const filme = this.catalogoManager.buscarItemExato(j.title, 'filme', j.tmdbId);
                    if (filme) {
                        const isCam = filme.isCam || !!filme.versoes?.cam;
                        if (!isCam || j.allowCam) {
                            const hasDub = filme.isDublado || !!filme.versoes?.dublado;
                            const hasLeg = filme.isLegendado || !!filme.versoes?.legendado;
                            const reqPref = j.audioPreference || 'dublado';
                            const isSatisfied = (reqPref === 'legendado' && hasLeg) || (reqPref === 'dublado' && hasDub);
                            if (isSatisfied) {
                                console.log(`✅ [Fila] Filme "${j.title}" já está catalogado e satisfeito (${reqPref}). Marcando como concluído.`);
                                j.status = 'completed';
                                j.progress = 100;
                                j.progressDetails = 'Já catalogado anteriormente';
                                this.saveJob(j).catch(() => {});
                                this.queue = this.queue.filter(q => q.id !== j.id);
                                continue;
                            }
                        }
                    }
                }
            }

            // Verifica compatibilidade com os recursos de esteira livres no momento
            if (hasOpt) {
                if (!capacity.canUpload) continue;
            } else if (hasRaw) {
                if (!capacity.canTranscode) continue;
            } else {
                if (!capacity.canDownload) continue;
            }

            eligibleJobs.push(j);
        }

        if (eligibleJobs.length === 0) return null;

        // 1. Sempre prioriza jobs com arquivo otimizado pronto para upload (libera disco rápido)
        const uploadReady = eligibleJobs.find(j => j.optimizedPath && fs.existsSync(j.optimizedPath));
        if (uploadReady && capacity.canUpload) return uploadReady;

        // Helper para categorização precisa do job
        const KNOWN_DORAMA_TITLES = /^(vincenzo|pousando no amor|uma advogada extraordinária|round 6|squid game|my love from the star|goblin|crash landing on you|boys over flowers|itaewon class|start-up|hospital playlist|nevertheless|twenty-five twenty-one|extraordinary attorney woo|all of us are dead|business proposal|my mister|misaeng|signal|romance is a bonus book|something in the rain|be melodramatic|dr romantic|when the camellia blooms|arthdal chronicles|kingdom|hellbound|juvenile justice|move to heaven|my name|extracurricular|sweet home|mouse|voice|beyond evil|law of the jungle|running man|amazing saturday|homens com missão|o rato)$/i;
        const KNOWN_ANIME_TITLES = /one piece|naruto|dragon ball|bleach|jujutsu kaisen|demon slayer|attack on titan|kimetsu|hunter x hunter|fullmetal|sword art online|solo leveling|fairy tail|black clover|my hero academia|tokyo ghoul|death note|neon genesis|evangelion|cowboy bebop|trigun|rurouni kenshin|samurai champloo|code geass|no game no life|re:zero|overlord|danmachi|steins.gate|jojo|vinland saga|chainsaw man|spy x family|bocchi|mob psycho|one punch man|fire force|quintessential quintuplets|rent a girlfriend|mushoku tensei|oshi no ko|blue lock|frieren|dungeon meshi/i;

        const checkJobCategory = (j) => {
            const isUserOrder = Number(j.priority || 4) <= 2 && (j.userId || j.isManualAdd);
            const isUpgrade = j.isUpgrade || j.extraData?.isUpgrade || j.priority === PRIORITIES.CAM_UPGRADE || j.priority === PRIORITIES.UPGRADE_DUB;
            const isMicrodrama = j.isMicrodrama || j.extraData?.isMicrodrama || j.subtipo === 'microdrama' || j.extraData?.subtipo === 'microdrama' || j.category === 'Microdrama' || j.generos?.includes('Microdrama') || (j.runtime && j.runtime < 5);
            const isAnime = !isMicrodrama && (j.isAnime || j.extraData?.isAnime || j.category === 'Anime' || j.genreIds?.includes(16) || 
                            j.generos?.includes('Animação') || j.generos?.includes('Anime') || 
                            j.originalLanguage === 'ja' || j.idiomaOriginal === 'ja' ||
                            KNOWN_ANIME_TITLES.test(j.title || '') ||
                            /anime|shonen|seinen|isekai|kimetsu/i.test(j.title || ''));
            const isDorama = !isAnime && !isMicrodrama && (j.isDorama || j.extraData?.isDorama || j.category === 'Dorama' || 
                             j.originalLanguage === 'ko' || j.originalLanguage === 'zh' || 
                             j.idiomaOriginal === 'ko' || j.idiomaOriginal === 'zh' || 
                             j.title?.toLowerCase().includes('dorama') || j.generos?.includes('Dorama') ||
                             KNOWN_DORAMA_TITLES.test(j.title || ''));
            
            if (isUserOrder || isUpgrade) return 'upgrade_ou_pedido';
            if (isMicrodrama) return 'microdrama';
            if (isAnime) return 'anime';
            if (isDorama) return 'dorama';
            if (j.type === 'filme') return 'filme';
            return 'serie';
        };

        // Helper inteligente para selecionar o melhor job de uma categoria:
        // Prioriza completar episódios de séries/animes que JÁ EXISTEM no catálogo (na ordem S01E01, S01E02...)
        // antes de iniciar uma série totalmente nova do zero.
        const findCategoryJob = (targetCategory) => {
            const categoryJobs = eligibleJobs.filter(j => checkJobCategory(j) === targetCategory);
            if (categoryJobs.length === 0) return null;

            if (this.catalogoManager && ['anime', 'serie', 'dorama', 'microdrama'].includes(targetCategory)) {
                // 1. Tenta encontrar jobs de séries que já possuem episódios cadastrados no catálogo
                const existingSeriesJobs = categoryJobs.filter(j => {
                    const found = this.catalogoManager.buscarItemExato(j.title, 'serie', j.tmdbId);
                    return found && (found.temporadas || []).some(t => (t.episodios || []).length > 0);
                });

                if (existingSeriesJobs.length > 0) {
                    // Ordena por temporada e episódio para preencher sequencialmente
                    existingSeriesJobs.sort((a, b) => {
                        const sA = a.season || 1;
                        const sB = b.season || 1;
                        if (sA !== sB) return sA - sB;
                        const eA = a.episode || 1;
                        const eB = b.episode || 1;
                        return eA - eB;
                    });
                    return existingSeriesJobs[0];
                }
            }

            // 2. Se nenhuma série da categoria tem episódios no catálogo, pega o primeiro da fila
            return categoryJobs[0];
        };

        // Conta quantos jobs de cada categoria estão atualmente ativos
        let activeMovies = 0;
        let activeUpgradesAndOrders = 0;
        let activeMicrodramas = 0;
        let activeSeries = 0;
        let activeDoramas = 0;
        let activeAnimes = 0;

        for (const active of this.activeJobs.values()) {
            const cat = checkJobCategory(active);
            if (cat === 'upgrade_ou_pedido') {
                activeUpgradesAndOrders++;
            } else if (cat === 'microdrama') {
                activeMicrodramas++;
            } else if (cat === 'anime') {
                activeAnimes++;
            } else if (cat === 'dorama') {
                activeDoramas++;
            } else if (cat === 'filme') {
                activeMovies++;
            } else if (cat === 'serie') {
                activeSeries++;
            }
        }

        // 2. ESCALONAMENTO POR FAIXAS DEDICADAS:
        // Faixa 1: Novos Filmes (Lançamentos)
        if (activeMovies < 1) {
            const movieJob = findCategoryJob('filme');
            if (movieJob) return movieJob;
        }

        // Faixa 2: Pedidos de Usuários & Upgrades de Qualidade
        if (activeUpgradesAndOrders < 1) {
            const upgradeOrOrderJob = findCategoryJob('upgrade_ou_pedido');
            if (upgradeOrOrderJob) return upgradeOrOrderJob;
        }

        // Faixa 4: Animes Japoneses (J-Animes com slot 100% exclusivo)
        if (activeAnimes < 1) {
            const animeJob = findCategoryJob('anime');
            if (animeJob) return animeJob;
        }

        // Faixa 5: Doramas Tradicionais (K-Dramas / C-Dramas)
        if (activeDoramas < 1) {
            const doramaJob = findCategoryJob('dorama');
            if (doramaJob) return doramaJob;
        }

        // Faixa 6: Mini-Séries Chinesas (Microdramas / Duanju)
        if (activeMicrodramas < 1) {
            const microdramaJob = findCategoryJob('microdrama');
            if (microdramaJob) return microdramaJob;
        }

        // Faixa 3: Séries Ocidentais
        if (activeSeries < 1) {
            const seriesJob = findCategoryJob('serie');
            if (seriesJob) return seriesJob;
        }

        // 3. Prioriza jobs que já possuem arquivo bruto em disco pronto para transcode
        const transcodeReady = eligibleJobs.find(j => j.rawFilePath && fs.existsSync(j.rawFilePath));
        if (transcodeReady && capacity.canTranscode) return transcodeReady;

        // 4. TRANSBORDO DINÂMICO EQUILIBRADO (WORK-STEALING BALANCEADO):
        // Se qualquer uma das 6 faixas não possuir itens pendentes no momento,
        // distribui as vagas extras para as categorias menos representadas nos workers ativos
        const categoryCounts = {
            'anime': activeAnimes,
            'microdrama': activeMicrodramas,
            'dorama': activeDoramas,
            'filme': activeMovies,
            'upgrade_ou_pedido': activeUpgradesAndOrders,
            'serie': activeSeries
        };

        // Ordena jobs elegíveis priorizando categorias com MENOS workers ativos no momento
        const balancedJob = eligibleJobs.slice().sort((a, b) => {
            const catA = checkJobCategory(a);
            const catB = checkJobCategory(b);
            const countA = categoryCounts[catA] || 0;
            const countB = categoryCounts[catB] || 0;
            if (countA !== countB) {
                return countA - countB;
            }
            return (a.priority || 5) - (b.priority || 5);
        })[0];

        return balancedJob || eligibleJobs[0];
    }

    getActiveDownloadsCount() {
        let count = 0;
        for (const job of this.activeJobs.values()) {
            if (job.status === 'downloading' || job.status === 'searching') {
                count++;
            } else if (job.status === 'processing') {
                const isOptimizing = job.progressDetails && job.progressDetails.includes('Otimizando');
                const hasLocal = (job.rawFilePath && fs.existsSync(job.rawFilePath)) || (job.optimizedPath && fs.existsSync(job.optimizedPath));
                if (!isOptimizing && !hasLocal) {
                    count++;
                }
            }
        }
        return count;
    }

    getActiveOptimizationsCount() {
        let count = 0;
        for (const job of this.activeJobs.values()) {
            if (job.status === 'processing') {
                const isOptimizing = job.progressDetails && job.progressDetails.includes('Otimizando');
                if (isOptimizing) count++;
            }
        }
        return count;
    }

    getActiveUploadsCount() {
        let count = 0;
        for (const job of this.activeJobs.values()) {
            if (job.status === 'uploading') {
                count++;
            } else if (job.optimizedPath && fs.existsSync(job.optimizedPath)) {
                count++;
            }
        }
        return count;
    }

    getActiveActualUploadsCount(excludeJobId = null) {
        let count = 0;
        for (const job of this.activeJobs.values()) {
            if (job.id !== excludeJobId && job.status === 'uploading') {
                count++;
            }
        }
        return count;
    }

    async processNext() {
        const isNetworkAllowed = SchedulerService.isAllowedToRun();
        const mode = SchedulerService.getActiveMode(); // 'performance', 'eco', 'paused'

        // Concorrência adaptativa por etapa independente (Pipeline contínua)
        // No Modo Desempenho (Madrugada): 6 downloads simultâneos, 4 transcodes simultâneos, 3 uploads simultâneos
        // No Modo Econômico: 1 download, 2 transcodes, 1 upload
        const maxDownloads = mode === 'eco' ? 1 : (config.PERFORMANCE_MAX_DOWNLOADS || config.MAX_CONCURRENT_DOWNLOADS || 6);
        const maxTranscodes = mode === 'eco' ? 2 : (config.PERFORMANCE_MAX_TRANSCODES || config.MAX_CONCURRENT_TRANSCODES || 4);
        const maxUploads = mode === 'eco' ? 1 : (config.PERFORMANCE_MAX_UPLOADS || config.MAX_CONCURRENT_UPLOADS || 3);
        // O limite global de concorrência é a soma dos slots independentes de cada fase
        const maxConcurrent = mode === 'eco' ? (maxDownloads + maxTranscodes + maxUploads) : (maxDownloads + maxTranscodes + maxUploads);

        // Se o disco estiver acima da margem, aguarda uploads liberarem espaço antes de novos downloads
        const diskCrowded = await DownloaderManager.isDiskOvercrowded().catch(() => false);
        if (diskCrowded) {
            console.log('⏳ [Guarda de Disco] Espaço temporário atingiu margem de segurança. Segurando novos downloads até uploads concluírem.');
        }

        // Dispara jobs em paralelo enquanto houver slots livres
        while (this.activeJobs.size < maxConcurrent) {
            const activeDownloads = this.getActiveDownloadsCount();
            const activeTranscodes = this.getActiveOptimizationsCount();
            const activeUploads = this.getActiveUploadsCount();

            const canDownload = !diskCrowded && isNetworkAllowed && activeDownloads < maxDownloads;
            const canTranscode = activeTranscodes < maxTranscodes;
            const canUpload = isNetworkAllowed && activeUploads < maxUploads;

            if (!canDownload && !canTranscode && !canUpload) {
                break;
            }

            const nextJob = this.findNextJobToProcess({ canDownload, canTranscode, canUpload });
            if (!nextJob) break;

            this.runJobWorker(nextJob);
        }
    }


    async runJobWorker(nextJob) {
        // Guarda de segurança atômica: se outro worker já pegou este mesmo episódio em paralelo, cancela imediatamente
        const normTitle = normalizeTitle(nextJob.title);
        const s = nextJob.season ?? 1;
        const e = nextJob.episode ?? 1;

        // Registra o job em activeJobs PRIMEIRO para fechar a janela de corrida antes de qualquer verificação
        if (this.activeJobs.has(nextJob.id)) {
            console.log(`🛡️ [Bloqueio Anti-Duplicata] Job ${nextJob.id} já está em activeJobs. Ignorando lançamento duplicado.`);
            return;
        }
        this.activeJobs.set(nextJob.id, nextJob);

        // Agora verifica se outro worker com ID diferente está processando o mesmo título/episódio
        for (const active of this.activeJobs.values()) {
            if (active.id !== nextJob.id && active.type === nextJob.type) {
                const sameTitle = normalizeTitle(active.title) === normTitle || (active.tmdbId && nextJob.tmdbId && active.tmdbId === nextJob.tmdbId);
                if (sameTitle) {
                    if (nextJob.type === 'serie' && (active.season ?? 1) === s && (active.episode ?? 1) === e) {
                        console.log(`🛡️ [Bloqueio Anti-Duplicata] Abortando worker duplicado para "${nextJob.title}" T${s}E${e} (já em execução pelo worker do job ${active.id}).`);
                        this.activeJobs.delete(nextJob.id);
                        return;
                    } else if (nextJob.type === 'filme') {
                        console.log(`🛡️ [Bloqueio Anti-Duplicata] Abortando worker duplicado para o filme "${nextJob.title}" (já em execução).`);
                        this.activeJobs.delete(nextJob.id);
                        return;
                    }
                }
            }
        }

        nextJob.status = 'processing';
        await this.saveJob(nextJob);

        console.log(`\n⚙️ [TRILHA PARALELA ${this.activeJobs.size}/${this.maxConcurrentJobs}] INICIANDO: "${nextJob.title}" (Tipo: ${nextJob.type}, Prioridade: ${nextJob.priority})`);

        try {
            await this.executeJob(nextJob);
            nextJob.status = 'completed';
            nextJob.progress = 100;
            await this.saveJob(nextJob);
            this.queue = this.queue.filter(j => j.id !== nextJob.id);
            console.log(`🎉 [TRILHA CONCLUÍDA] Trabalho finalizado com sucesso: "${nextJob.title}"`);
        } catch (error) {
            console.error(`❌ [TRILHA FALHA] Falha no processamento de "${nextJob.title}":`, error.message);
            nextJob.status = 'failed';
            nextJob.error = error.message;
            await this.saveJob(nextJob);
            this.queue = this.queue.filter(j => j.id !== nextJob.id);
        } finally {
            this.activeJobs.delete(nextJob.id);

            // Continua imediatamente para processar o próximo item disponível
            setImmediate(() => this.processNext());
        }
    }

    async executeJob(job) {
        // Se o job não tem arquivo local em disco e estamos fora da janela de download (01h-05h SP), pausa imediatamente
        const hasLocalFile = (job.rawFilePath && fs.existsSync(job.rawFilePath)) || (job.optimizedPath && fs.existsSync(job.optimizedPath));
        if (!hasLocalFile && !SchedulerService.isAllowedToRun()) {
            console.log(`⏰ [Scheduler SP] Job "${job.title}" aguardando abertura da janela de download das 01h às 05h (Horário de SP).`);
            job.status = 'queued';
            job.progress = 0;
            job.progressDetails = 'Aguardando janela de download (01h-05h SP)...';
            await this.saveJob(job);
            return;
        }

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

        // Validação de Existência Prévia para Filmes (evita rebaixar filmes que já estão 100% no catálogo ou baixar CAMs duplicados)
        if (job.type === 'filme' && !job.isUpgrade && !job.extraData?.isUpgrade) {
            const filmeExistente = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'filme') ||
                                  this.catalogoManager.buscarItemExato(job.title, 'filme');
            if (filmeExistente) {
                const pref = job.audioPreference || 'dublado';
                const temDublado = filmeExistente.isDublado || !!filmeExistente.versoes?.dublado;
                const temLegendado = filmeExistente.isLegendado || !!filmeExistente.versoes?.legendado;

                // Se já temos a versão oficial 1080p (não-CAM), nunca rebaixa
                if (!filmeExistente.isCam) {
                    if ((pref === 'dublado' && temDublado) || (pref === 'legendado' && temLegendado) || (temDublado && !job.userId)) {
                        console.log(`✅ [FILME] "${job.title}" já está no catálogo em 1080p oficial (${temDublado ? 'Dublado' : 'Legendado'}). Ignorando download duplicado.`);
                        await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'filme');
                        return;
                    }
                } else {
                    // Se já temos versão CAM no catálogo, habilita busca de upgrade oficial (não-CAM)
                    job.isUpgrade = true;
                }
            }
        }

        // Validação de Ordem Cronológica e Verificação de Existência de Episódios para Séries/Doramas
        // Apenas aplica se o job NÃO tiver arquivo bruto local nem for upload manual
        const hasSpecificLocalFile = (job.rawFilePath && fs.existsSync(job.rawFilePath)) || (job.optimizedPath && fs.existsSync(job.optimizedPath)) || job.isManualAdd;
        if (job.type === 'serie' && !hasSpecificLocalFile) {
            const seasonNum = job.season || 1;
            const requestedEp = job.episode || 1;
            const pref = job.audioPreference || 'dublado';

            const serieExistente = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie') ||
                                  this.catalogoManager.buscarItemExato(job.title, 'serie');
            if (serieExistente) {
                // Coleta todos os episódios que já estão ativos em outros workers para não colidir
                const activeEpKeys = new Set();
                for (const active of this.activeJobs.values()) {
                    if (active.id !== job.id && active.type === 'serie') {
                        const sameT = normalizeTitle(active.title) === normalizeTitle(job.title) || (active.tmdbId && job.tmdbId && active.tmdbId === job.tmdbId);
                        if (sameT) {
                            activeEpKeys.add(`s${active.season || 1}_e${active.episode || 1}`);
                        }
                    }
                }

                const totalTemporadas = metadata.totalTemporadas || (metadata.temporadas ? metadata.temporadas.length : 1);
                let nextTargetSeason = null;
                let nextTargetEp = null;

                // Busca de forma estritamente cronológica o PRIMEIRO episódio faltante ou pendente de Dublado por temporada
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

                    // Passo A: Encontra o primeiro episódio totalmente faltante na Temporada S que não esteja ativo em outro worker
                    for (let ep = 1; ep <= totalEpsInS; ep++) {
                        if (activeEpKeys.has(`s${s}_e${ep}`)) continue;
                        const epItem = (tempS?.episodios || []).find(e => e.numero === ep);
                        if (!epItem) {
                            nextTargetSeason = s;
                            nextTargetEp = ep;
                            break;
                        }
                    }
                    if (nextTargetSeason !== null) break;

                    // Passo B: Se todos os episódios da Temporada S já existem, verifica se algum precisa de upgrade para Dublado
                    if (pref === 'dublado') {
                        for (let ep = 1; ep <= totalEpsInS; ep++) {
                            if (activeEpKeys.has(`s${s}_e${ep}`)) continue;
                            const epItem = (tempS?.episodios || []).find(e => e.numero === ep);
                            if (epItem) {
                                const epDub = epItem.isDublado || !!epItem.versoes?.dublado || epItem.audio?.toLowerCase().includes('dublado');
                                if (!epDub) {
                                    nextTargetSeason = s;
                                    nextTargetEp = ep;
                                    break;
                                }
                            }
                        }
                    } else if (pref === 'legendado') {
                        // Passo C: Se o pedido for Legendado, verifica se algum episódio ainda não tem a opção Legendada
                        for (let ep = 1; ep <= totalEpsInS; ep++) {
                            if (activeEpKeys.has(`s${s}_e${ep}`)) continue;
                            const epItem = (tempS?.episodios || []).find(e => e.numero === ep);
                            if (epItem) {
                                const epLeg = epItem.isLegendado || !!epItem.versoes?.legendado;
                                if (!epLeg) {
                                    nextTargetSeason = s;
                                    nextTargetEp = ep;
                                    break;
                                }
                            }
                        }
                    }
                    if (nextTargetSeason !== null) break;
                }

                if (nextTargetSeason !== null && nextTargetEp !== null) {
                    if (job.season !== nextTargetSeason || job.episode !== nextTargetEp) {
                        console.log(`📺 [SÉRIE CRONOLÓGICA] Ajustando esteira para baixar o próximo episódio pendente/upgrade na ordem: "${metadata.nome || job.title}" - T${nextTargetSeason}E${nextTargetEp}`);
                        job.season = nextTargetSeason;
                        job.episode = nextTargetEp;
                        await this.saveJob(job);
                    }
                } else {
                    console.log(`🎉 [SÉRIE COMPLETA] Todos os episódios de todas as ${totalTemporadas} temporadas de "${job.title}" já estão 100% catalogados ou em processamento ativo!`);
                    await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'serie');
                    return;
                }
            } else if (requestedEp > 1) {
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
        let videoInfo = null;
        let langInfo = job.langInfo || { isValid: true, isDublado: true, isLegendado: false, audioText: 'Dublado (PT-BR)' };

        let tmdbExpectedDurationMin = 0;
        try {
            if (metadata.tmdbId) {
                if (job.type === 'filme') {
                    if (metadata.duracaoMinutos && metadata.duracaoMinutos > 0) {
                        tmdbExpectedDurationMin = metadata.duracaoMinutos;
                    } else {
                        const movieDet = await TMDBService.getMovieDetails(metadata.tmdbId);
                        if (movieDet && movieDet.duracaoMinutos > 0) {
                            tmdbExpectedDurationMin = movieDet.duracaoMinutos;
                            metadata.duracaoMinutos = movieDet.duracaoMinutos;
                        }
                    }
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

        const isMicro = job.isMicrodrama || job.extraData?.isMicrodrama || job.subtipo === 'microdrama' || metadata.isMicrodrama || metadata.subtipo === 'microdrama' || (job.totalEpisodiosEsperados && job.totalEpisodiosEsperados >= 30 && (tmdbExpectedDurationMin || 0) <= 10);
        const defaultExpectedMin = job.type === 'filme' ? 90 : (isMicro ? 3 : (metadata.duracaoMinutos || 45));
        const effectiveExpectedMin = tmdbExpectedDurationMin > 0 ? tmdbExpectedDurationMin : defaultExpectedMin;

        let finalMinSec = 2700; // 45 min padrão para filmes
        if (isMicro) {
            finalMinSec = 40;
        } else if (job.type === 'serie') {
            if (effectiveExpectedMin <= 15) {
                finalMinSec = 180; // 3 min para animes curtos
            } else {
                finalMinSec = Math.min(600, Math.max(300, Math.floor(effectiveExpectedMin * 60 * 0.35)));
            }
        } else {
            // Para FILMES:
            if (effectiveExpectedMin >= 120) {
                // Filmes longos (ex: Duna 2 com 166 min, Vingadores com 180 min): exige no mínimo 65% da duração (~100 min / 6000s)
                finalMinSec = Math.floor(effectiveExpectedMin * 60 * 0.65);
            } else if (effectiveExpectedMin <= 80) {
                finalMinSec = Math.max(2400, Math.floor(effectiveExpectedMin * 60 * 0.50));
            } else {
                finalMinSec = 3600; // Mínimo 60 minutos para filmes normais
            }
        }

        // 2.5 Verificar se já existe arquivo codificado ou baixado no SSD — retomada inteligente após crash
        let resumeFromOptimized = false;
        let resumeFromRaw = false;

        // Primeiro tenta retomar do arquivo otimizado (já codificado, pronto para upload)
        if (optimizedPath && fs.existsSync(optimizedPath)) {
            const optStat = fs.statSync(optimizedPath);
            if (optStat.size > 50 * 1024 * 1024) {
                try {
                    const VideoProcessor = require('../services/VideoProcessor');
                    const optInfo = await VideoProcessor.getVideoInfo(optimizedPath);
                    if (optInfo && optInfo.duration >= finalMinSec) {
                        console.log(`⚡ Retomando envio a partir de arquivo otimizado existente (${(optStat.size / (1024*1024*1024)).toFixed(2)} GB, ${optInfo.durationFormatted}): ${path.basename(optimizedPath)}`);
                        resumeFromOptimized = true;
                        videoInfo = optInfo;
                        bestSource = job.bestSource || { title: job.title, source: 'Cache Local', audio: '1080p Full HD' };
                        langInfo = job.langInfo || langInfo;
                    } else {
                        console.warn(`🧹 Arquivo otimizado incompleto (${optInfo?.durationFormatted || '0s'} < ${Math.round(finalMinSec/60)} min esperados) descartado para reprocessar.`);
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
                    if (info && info.duration >= finalMinSec) {
                        console.log(`📁 Utilizando arquivo bruto existente (${(rawStat.size / (1024*1024*1024)).toFixed(2)} GB, ${info.durationFormatted}): ${path.basename(rawFilePath)}`);
                        resumeFromRaw = true;
                        videoInfo = info;
                        downloadedMedia = { filePath: rawFilePath, fileName: path.basename(rawFilePath), sizeBytes: rawStat.size };
                        bestSource = job.bestSource || { title: job.title, source: 'Upload Manual', audio: job.audioPreference === 'dublado' ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)' };
                        langInfo = job.langInfo || langInfo;
                    } else {
                        console.warn(`🧹 Arquivo bruto em disco incompleto (${info?.durationFormatted || '0s'} < ${Math.round(finalMinSec/60)} min esperados) descartado.`);
                        await DownloaderManager.cleanupFile(rawFilePath);
                        rawFilePath = null;
                        job.rawFilePath = null;
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

        // Se for série, verifica se o episódio já está presente no disco (ex: de um pack de temporada previamente baixado)
        if (!resumeFromOptimized && !resumeFromRaw && job.type === 'serie') {
            try {
                const tempDir = DownloaderManager.downloadDir;
                if (fs.existsSync(tempDir)) {
                    const allTempFiles = [];
                    const scanDir = (dir) => {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const full = path.join(dir, entry.name);
                            if (entry.isDirectory()) {
                                scanDir(full);
                            } else {
                                const ext = path.extname(entry.name).toLowerCase();
                                if (['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext)) {
                                    try {
                                        allTempFiles.push({ path: full, name: entry.name, size: fs.statSync(full).size });
                                    } catch (err) {}
                                }
                            }
                        }
                    };
                    scanDir(tempDir);

                    // Procura se algum arquivo já existente no disco corresponde a esta série e ao episódio solicitado
                    const titleClean = (job.title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                    const matchedFile = allTempFiles.find(f => {
                        const nameClean = f.name.toLowerCase().replace(/[^a-z0-9]/g, '');
                        if (!nameClean.includes(titleClean)) return false;
                        const epMatch = DownloaderManager.isEpisodeFileMatch(f, job.season || 1, job.episode || 1);
                        return epMatch && f.size > 20 * 1024 * 1024;
                    });

                    if (matchedFile) {
                        console.log(`⚡ [REUTILIZAÇÃO DE PACK] Episódio T${job.season || 1}E${job.episode || 1} já disponível no disco (${(matchedFile.size / (1024*1024)).toFixed(1)} MB): ${matchedFile.name}`);
                        resumeFromRaw = true;
                        rawFilePath = matchedFile.path;
                        job.rawFilePath = rawFilePath;
                        downloadedMedia = { filePath: rawFilePath, fileName: matchedFile.name, sizeBytes: matchedFile.size };
                        bestSource = { title: job.title, source: 'Pack em Disco', audio: job.audioPreference === 'dublado' ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)' };
                    }
                }
            } catch (e) {
                console.warn('⚠️ Erro ao verificar pack em disco:', e.message);
            }
        }

        if (!resumeFromOptimized && !resumeFromRaw) {
            // Se estiver fora do horário de São Paulo (01h-05h), não inicia download de torrent pela rede
            if (!SchedulerService.isAllowedToRun()) {
                console.log(`⏰ [Scheduler SP] Fora da janela de download para "${job.title}". Otimizações locais continuam ativas, mas novos downloads pela rede aguardam a janela das 01h às 05h (Horário de SP).`);
                job.status = 'queued';
                job.progress = 0;
                job.progressDetails = 'Aguardando janela de download (01h-05h SP)...';
                await this.saveJob(job);
                return;
            }

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
                const filmeExist = job.type === 'filme' ? (this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'filme') || this.catalogoManager.buscarItemExato(job.title, 'filme')) : null;
                const jaTemCam = !!(filmeExist && filmeExist.isCam);
                const jaPossuiLegendadoFilme = !!(filmeExist && (filmeExist.isLegendado || !!filmeExist.versoes?.legendado));
                const jaPossuiDubladoFilme = !!(filmeExist && (filmeExist.isDublado || !!filmeExist.versoes?.dublado));

                const serieExist = job.type === 'serie' ? (this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie') || this.catalogoManager.buscarItemExato(job.title, 'serie')) : null;
                const epExistente = job.type === 'serie' && serieExist ? this.catalogoManager.buscarEpisodio(serieExist.id, job.season || 1, job.episode || 1) : null;
                const jaPossuiLegendadoSerie = !!(epExistente && (epExistente.isLegendado || !!epExistente.versoes?.legendado));
                const jaPossuiDubladoSerie = !!(epExistente && (epExistente.isDublado || !!epExistente.versoes?.dublado));

                const jaPossuiLegendado = job.type === 'serie' ? jaPossuiLegendadoSerie : jaPossuiLegendadoFilme;
                const jaPossuiDublado = job.type === 'serie' ? jaPossuiDubladoSerie : jaPossuiDubladoFilme;

                let forcarNaoCam = jaTemCam;
                if (job.type === 'filme' && metadata.tmdbId) {
                    try {
                        const relStatus = await TMDBService.checkDigitalReleaseStatus(metadata.tmdbId, job.audioPreference === 'dublado');
                        if (!relStatus.isTheatricalOnly) {
                            forcarNaoCam = true; // Filme já teve estreia digital/streaming/blu-ray: rejeita categoricamente versões CAM de cinema
                        }
                    } catch (e) {}
                }

                const isAnimeFlag = !!(job.isAnime || metadata.isAnime || metadata.is_anime || metadata.generos?.includes('Animação') || metadata.generos?.includes('Anime') || metadata.original_language === 'ja' || job.originalLanguage === 'ja');

                // Para animes com temporadas separadas no TMDB (ex: Bleach T2 = "Guerra Sangrenta de Mil Anos"),
                // passa o nome da temporada para que o AnimeExtractor possa buscar com o título correto nos sites.
                const targetSeasonNum = job.season || 1;
                let tmdbSeasonName = null;
                if (isAnimeFlag && targetSeasonNum > 1 && metadata.temporadas) {
                    const seasonInfo = metadata.temporadas.find(t => t.numero === targetSeasonNum);
                    if (seasonInfo && seasonInfo.nome && !seasonInfo.nome.match(/^temporada\s+\d+$/i)) {
                        tmdbSeasonName = seasonInfo.nome; // ex: "Guerra Sangrenta de Mil Anos"
                    }
                }

                sources = await MediaSearchService.search(job.title, job.type, {
                    nomeOriginal: metadata.nomeOriginal,
                    ano: metadata.ano,
                    tmdbId: metadata.tmdbId,
                    imdbId: metadata.imdbId,
                    season: targetSeasonNum,
                    episode: job.episode || 1,
                    audioPreference: job.audioPreference || 'dublado',
                    forcarNaoCam: forcarNaoCam,
                    ignorarFallbackLegendado: jaPossuiLegendado,
                    ignorarFallbackDublado: jaPossuiDublado,
                    isAnime: isAnimeFlag,
                    isDorama: !!(job.isDorama || metadata.isDorama),
                    isMicrodrama: !!(job.isMicrodrama || metadata.isMicrodrama),
                    originalLanguage: job.originalLanguage || metadata.original_language || metadata.originalLanguage || null,
                    tmdbSeasonName: tmdbSeasonName // Nome da temporada TMDB para busca alternativa em animes (ex: Bleach S2 -> "Guerra Sangrenta de Mil Anos")
                });

                if (jaTemCam || forcarNaoCam) {
                    const nonCamSources = sources.filter(s => !s.isCam);
                    if (nonCamSources.length > 0) {
                        sources = nonCamSources;
                    } else if (jaTemCam) {
                        console.log(`ℹ️ [UPGRADE CHECK] "${job.title}" já possui versão CAM no catálogo e todas as fontes disponíveis no momento ainda são gravações de Cinema/CAM. Mantendo versão atual.`);
                        await this.marcarPedidosAtendidos(metadata.nome || job.title, job.userId, 'filme');
                        return;
                    }
                }

                // Se o item já possui Legendado e o job busca Dublado, descarta estritamente fontes Legendadas
                if (job.audioPreference === 'dublado' && jaPossuiLegendado) {
                    sources = sources.filter(s => s.isDublado);
                    if (sources.length === 0) {
                        console.log(`ℹ️ [UPGRADE DUBLADO] "${job.title}" ${job.type === 'serie' ? `T${job.season || 1}E${job.episode || 1}` : ''} já possui versão Legendada no catálogo e nenhuma fonte Dublada foi encontrada no momento. Mantendo versão atual e passando para o próximo.`);
                        job.status = 'completed';
                        job.progress = 100;
                        job.progressDetails = 'Mantida versão Legendada existente (sem fonte Dublada no momento)';
                        await this.saveJob(job);
                        this.queue = this.queue.filter(j => j.id !== job.id);
                        return;
                    }
                }

                // Se o item já possui Dublado e o job busca Legendado, descarta estritamente fontes Dubladas
                if (job.audioPreference === 'legendado' && jaPossuiDublado) {
                    sources = sources.filter(s => s.isLegendado);
                    if (sources.length === 0) {
                        console.log(`ℹ️ [UPGRADE LEGENDADO] "${job.title}" ${job.type === 'serie' ? `T${job.season || 1}E${job.episode || 1}` : ''} já possui versão Dublada no catálogo e nenhuma fonte Legendada foi encontrada no momento. Mantendo versão atual e passando para o próximo.`);
                        job.status = 'completed';
                        job.progress = 100;
                        job.progressDetails = 'Mantida versão Dublada existente (sem fonte Legendada no momento)';
                        await this.saveJob(job);
                        this.queue = this.queue.filter(j => j.id !== job.id);
                        return;
                    }
                }
            }

            if (sources.length === 0) {
                if (job.type === 'serie') {
                    this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                }
                throw new Error(`Nenhuma fonte em Português encontrada para "${job.title}".`);
            }

            // Se a preferência for estritamente Legendado, filtra apenas fontes legendadas
            if (job.audioPreference === 'legendado') {
                const legSources = sources.filter(s => s.isLegendado);
                if (legSources.length > 0) {
                    sources = legSources;
                }
            }

            // 3. Download com Fallback Automático entre as melhores opções (tenta até 8 fontes com timeout global de 25 min)
            job.status = 'downloading';
            await this.saveJob(job);

            // Função auxiliar para determinar se um episódio da temporada está faltando ou sem mídia válida no catálogo
            const isEpisodeMissing = (epNumber) => {
                if (job.type !== 'serie') return false;
                const serieExist = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie')
                    || (metadata.tmdbId ? this.catalogoManager.buscarSeriePorTmdb(metadata.tmdbId) : null);
                if (!serieExist) return true;

                const sNum = parseInt(job.season || 1, 10);
                const temp = (serieExist.temporadas || []).find(t => t.numero === sNum);
                if (!temp) return true;

                const ep = (temp.episodios || []).find(e => Number(e.numero) === Number(epNumber));
                if (!ep) return true;

                const CatalogoManager = require('./CatalogoManager');
                const reqPref = job.audioPreference || 'dublado';
                if (reqPref === 'dublado') {
                    return !CatalogoManager.hasValidDubbedMedia(ep);
                } else if (reqPref === 'legendado') {
                    return !CatalogoManager.hasValidSubtitledMedia(ep);
                }
                return !CatalogoManager.hasValidDubbedMedia(ep) && !CatalogoManager.hasValidSubtitledMedia(ep);
            };

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
                            jobId: job.id,
                            title: job.title,
                            season: job.season,
                            episode: job.episode,
                            type: job.type,
                            audio: currentSource.audio,
                            isDublado: currentSource.isDublado,
                            audioPreference: job.audioPreference || 'geral',
                            attemptIndex: i,
                            totalAttempts: maxAttempts,
                            mode: SchedulerService.getActiveMode(),
                            isEpisodeMissing: isEpisodeMissing,
                            isAnime: !!(metadata.isAnime || metadata.is_anime || (metadata.generos || []).includes('Animação') || (metadata.generos || []).includes('Anime')),
                            isMicrodrama: !!(metadata.isMicrodrama || metadata.is_microdrama || metadata.isDoramaVertical || metadata.is_dorama_vertical || (metadata.runtime && metadata.runtime < 5)),
                            runtime: metadata.runtime || metadata.duracao
                        });

                    } else if (currentSource.url) {
                        const cleanUrlPath = currentSource.url.split('?')[0];
                        const baseName = path.basename(cleanUrlPath) || 'video.mp4';
                        const fileName = `${Date.now()}_${baseName.endsWith('.mp4') || baseName.endsWith('.mkv') ? baseName : `${baseName}.mp4`}`;

                        downloadedMedia = await DownloaderManager.downloadHttp(currentSource.url, fileName, (progress) => {
                            job.progress = progress.percent;
                            job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed || 'Web CDN'})`;
                        }, {
                            jobId: job.id,
                            title: job.title,
                            season: job.season,
                            episode: job.episode,
                            type: job.type,
                            provider: currentSource.provider || 'Web CDN',
                            referer: currentSource.referer || 'https://animesdigital.org/',
                            audio: currentSource.audio,
                            isDublado: currentSource.isDublado ?? (currentSource.audio ? currentSource.audio.includes('Dublado') : true),
                            audioPreference: job.audioPreference || 'dublado',
                            mode: SchedulerService.getActiveMode(),
                            isAnime: !!(metadata.isAnime || metadata.is_anime || (metadata.generos || []).includes('Animação') || (metadata.generos || []).includes('Anime')),
                            isMicrodrama: !!(metadata.isMicrodrama || metadata.is_microdrama || metadata.isDoramaVertical || metadata.is_dorama_vertical || (metadata.runtime && metadata.runtime < 5)),
                            runtime: metadata.runtime || metadata.duracao
                        });
                    }

                    if (downloadedMedia && downloadedMedia.filePath) {
                        bestSource = currentSource;
                        break;
                    }
                } catch (err) {
                    if (err.message === 'DOWNLOAD_CANCELLED') {
                        console.log(`⏹️ [Queue Worker] Download de "${job.title}" cancelado ordenadamente devido a mudança de modo/pausa.`);
                        return;
                    }
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
                        const totalLegAttempts = Math.min(6, candidatesLeg.length);
                        for (let j = 0; j < totalLegAttempts; j++) {
                            const currentLeg = candidatesLeg[j];
                            console.log(`🎯 [Fallback Legendado] Tentando fonte [${j + 1}/${totalLegAttempts}]: ${currentLeg.title} (${currentLeg.sizeMB} MB, ${currentLeg.seeders || 0} seeds)`);
                            try {
                                if (currentLeg.magnet) {
                                    downloadedMedia = await DownloaderManager.downloadTorrent(currentLeg.magnet, (progress) => {
                                        job.progress = progress.percent;
                                        job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed})`;
                                    }, {
                                        jobId: job.id,
                                        title: job.title,
                                        season: job.season,
                                        episode: job.episode,
                                        type: job.type,
                                        audio: currentLeg.audio || 'Legendado (PT-BR)',
                                        isDublado: false,
                                        audioPreference: 'legendado',
                                        attemptIndex: j,
                                        totalAttempts: totalLegAttempts,
                                        mode: SchedulerService.getActiveMode(),
                                        isEpisodeMissing: isEpisodeMissing
                                    });
                                }
                                if (downloadedMedia && downloadedMedia.filePath) {
                                    bestSource = currentLeg;
                                    break;
                                }
                            } catch (errLeg) {
                                if (errLeg.message === 'DOWNLOAD_CANCELLED') {
                                    console.log(`⏹️ [Queue Worker] Fallback de "${job.title}" cancelado ordenadamente.`);
                                    return;
                                }
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
                    console.warn(`⚠️ [SÉRIE PAUSADA] Todas as fontes testadas (Dublado e Legendado) para "${job.title}" T${job.season || 1}E${job.episode || 1} estavam sem seeders. Adicionando ao Swarm Watcher...`);
                }
                // Registra na watchlist persistente para baixar assim que houver sementes ativas
                SwarmWatcher.addToWatchlist({
                    title: metadata.nome || job.title,
                    type: job.type,
                    tmdbId: metadata.tmdbId,
                    imdbId: metadata.imdbId,
                    season: job.season,
                    episode: job.episode,
                    audioPreference: job.audioPreference || 'dublado',
                    userId: job.userId,
                    username: job.username,
                    reason: 'no_seeders'
                }).catch(() => {});

                throw new Error(`Todas as fontes testadas falharam ou estavam sem seeders: ${lastError?.message || 'Sem conexão'}`);
            }

            rawFilePath = downloadedMedia.filePath;
            job.rawFilePath = rawFilePath;
            job.expectedSize = downloadedMedia.sizeBytes;
            job.bestSource = bestSource;
            await this.saveJob(job);

            // Se for um Season Pack com múltiplos episódios indexados, enfileira e vincula os outros episódios ao SSD local
            if (job.type === 'serie' && downloadedMedia?.isPack && downloadedMedia?.episodeMap) {
                const epMap = downloadedMedia.episodeMap;
                const totalPackEps = Object.keys(epMap).length;
                console.log(`📦 [PACK DE TEMPORADA] ${totalPackEps} episódios baixados e indexados localmente no SSD para "${job.title}" (T${job.season || 1})!`);

                for (const [epNumStr, epInfo] of Object.entries(epMap)) {
                    const epNum = parseInt(epNumStr, 10);
                    if (epNum !== (job.episode || 1) && fs.existsSync(epInfo.filePath)) {
                        const serieExist = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie');
                        const jaCatalogado = serieExist ? this.catalogoManager.buscarEpisodio(serieExist.id, job.season || 1, epNum) : null;
                        const reqPref = job.audioPreference || 'dublado';
                        const CatalogoManager = require('./CatalogoManager');
                        const isAlreadySatisfied = jaCatalogado && (
                            (reqPref === 'dublado' && CatalogoManager.hasValidDubbedMedia(jaCatalogado)) ||
                            (reqPref === 'legendado' && CatalogoManager.hasValidSubtitledMedia(jaCatalogado)) ||
                            (reqPref === 'geral' && (CatalogoManager.hasValidDubbedMedia(jaCatalogado) || CatalogoManager.hasValidSubtitledMedia(jaCatalogado)))
                        );

                        if (!isAlreadySatisfied) {
                            try {
                                // Verifica se já existe job para este episódio com o MESMO audioPreference (evita duplicata de pack)
                                const existingJob = this.queue.find(q =>
                                    (q.title || '').toLowerCase() === (job.title || '').toLowerCase() &&
                                    q.season === (job.season || 1) &&
                                    q.episode === epNum &&
                                    (q.audioPreference || 'dublado') === (job.audioPreference || 'dublado')
                                );
                                if (existingJob) {
                                    existingJob.rawFilePath = epInfo.filePath;
                                    existingJob.expectedSize = epInfo.sizeBytes;
                                    existingJob.bestSource = bestSource;
                                    existingJob.status = 'queued';
                                    await this.saveJob(existingJob);
                                } else {
                                    this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.VIP_USER, {
                                        tmdbId: metadata.tmdbId,
                                        season: job.season || 1,
                                        episode: epNum,
                                        userId: job.userId,
                                        username: job.username,
                                        audioPreference: job.audioPreference || 'dublado',
                                        rawFilePath: epInfo.filePath,
                                        expectedSize: epInfo.sizeBytes,
                                        bestSource: bestSource,
                                        queueOrder: epNum
                                    });
                                }
                            } catch (ePack) {
                                console.warn(`⚠️ Erro ao registrar episódio T${job.season || 1}E${epNum} do pack na fila:`, ePack.message);
                            }
                        }
                    }
                }
                // Imediatamente aciona a esteira para iniciar a otimização em paralelo dos episódios já no SSD
                setImmediate(() => this.processNext());
            }

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

        if (!resumeFromOptimized) {
            // 3.5 Verificação de Integridade, Duração Mínima e Idioma PT-BR
            try {
                videoInfo = await VideoProcessor.getVideoInfo(rawFilePath);

                // Verificação de Duração Mínima Inteligente e Anti-Falsos-Positivos:
                // Filmes: Qualquer vídeo >= 65 minutos (3900s) é garantidamente um longa-metragem completo e nunca deve ser descartado por divergência de minissérie/edição estendida no TMDB.
                // Apenas descartar como corte/sample se o filme for < 45 minutos (2700s) ou < 50% de um filme curto (< 65min).
                // Mini-Séries Chinesas / Microdramas: Mínimo 40s (episódios curtos de 1 a 5 min).
                // Séries/Doramas Normais: Mínimo 10 minutos (600s) ou 35% da duração esperada (animes curtos <= 15min: 180s).
                const isMicro = job.isMicrodrama || job.extraData?.isMicrodrama || job.subtipo === 'microdrama' || metadata.isMicrodrama || metadata.subtipo === 'microdrama' || (job.totalEpisodiosEsperados && job.totalEpisodiosEsperados >= 30 && (tmdbExpectedDurationMin || 0) <= 10);
                const defaultExpectedMin = job.type === 'filme' ? 90 : (isMicro ? 3 : (metadata.duracaoMinutos || 45));
                const effectiveExpectedMin = tmdbExpectedDurationMin > 0 ? tmdbExpectedDurationMin : defaultExpectedMin;

                let finalMinSec = 2700; // 45 min padrão para filmes
                if (isMicro) {
                    finalMinSec = 40;
                } else if (job.type === 'serie') {
                    if (effectiveExpectedMin <= 15) {
                        finalMinSec = 180; // 3 min para animes curtos
                    } else {
                        finalMinSec = Math.min(600, Math.max(300, Math.floor(effectiveExpectedMin * 60 * 0.35)));
                    }
                } else {
                    // Para FILMES:
                    if (videoInfo.duration >= 3900) {
                        // Se tem pelo menos 65 minutos (ex: The Odyssey com 86min), é um filme completo!
                        finalMinSec = 3900;
                    } else if (effectiveExpectedMin <= 110) {
                        finalMinSec = Math.max(2400, Math.floor(effectiveExpectedMin * 60 * 0.45));
                    } else {
                        // Se o TMDB disser que tem 172 min (minissérie), mas o vídeo tem 65+ min, aceita. Caso contrário, exige pelo menos 45 min.
                        finalMinSec = 2700;
                    }
                }

                if (videoInfo.duration && videoInfo.duration < finalMinSec) {
                    const durAtualMin = (videoInfo.duration / 60).toFixed(1);
                    console.warn(`⚠️ Arquivo descartado: Duração inválida detectada (${videoInfo.durationFormatted} / ~${durAtualMin} min). Esperado para "${job.title}": ~${effectiveExpectedMin} min (Mínimo aceito: ${Math.round(finalMinSec / 60)} min). Corte/amostra/incompleto descartado.`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`Vídeo com duração insuficiente (${videoInfo.durationFormatted} vs ~${effectiveExpectedMin} min esperados). Arquivo incompleto descartado.`);
                }

                const effectiveSource = bestSource || job.bestSource || (job.audioPreference === 'legendado' || metadata.isDorama ? { isLegendado: true } : {});
                langInfo = VideoProcessor.validatePortugueseContent(videoInfo, path.basename(rawFilePath), effectiveSource, metadata);

                if (!langInfo.isValid) {
                    // Se foi rejeitado por conter áudio russo ou scam em filme ocidental, não aplica fallback e descarta imediatamente
                    if (langInfo.isRussianScam) {
                        console.warn(`⚠️ Arquivo descartado: Release com áudio Russo / Scam detectado para "${job.title}".`);
                        await DownloaderManager.cleanupFile(rawFilePath);
                        throw new Error(`Vídeo com áudio em Russo/Scam descartado.`);
                    }

                    // 1. Verifica se o torrent já trouxe legenda companion PT-BR na pasta (Companion Subs do pack)
                    const companion = await VideoProcessor.findCompanionSubtitle(rawFilePath, { season: job.season || 1, episode: job.episode || 1 });
                    if (companion && companion.ptSrtPath && !VideoProcessor.isRussianOrScamAudio(videoInfo, path.basename(rawFilePath), metadata)) {
                        console.log(`📦 [Companion Subs] Legenda local PT-BR encontrada no pacote para "${job.title}" T${job.season || 1}E${job.episode || 1}: ${path.basename(companion.ptSrtPath)}`);
                        langInfo = {
                            isValid: true,
                            isDublado: false,
                            isLegendado: true,
                            hasBoth: false,
                            audioText: 'Legendado (PT-BR)'
                        };
                        job.audioPreference = 'legendado';
                    } else {
                        // 2. Se o arquivo não tiver áudio PT-BR embutido nem legenda local, verifica OpenSubtitles (apenas se o áudio original for genuíno)
                        if (VideoProcessor.isRussianOrScamAudio(videoInfo, path.basename(rawFilePath), metadata)) {
                            console.warn(`⚠️ Fallback abortado: Áudio em idioma Russo / Scam detectado para "${job.title}".`);
                            await DownloaderManager.cleanupFile(rawFilePath);
                            throw new Error(`Vídeo com áudio em Russo/Scam descartado.`);
                        }

                        let imdbId = metadata.imdbId || job.metaDetails?.imdbId;
                        if (!imdbId && metadata.tmdbId && job.type === 'serie') {
                            try {
                                const extIds = await TMDBService.getTVExternalIds(metadata.tmdbId);
                                if (extIds && extIds.imdb_id) imdbId = extIds.imdb_id;
                            } catch(e) {}
                        }
                        const ptSubs = imdbId ? await MediaSearchService.getOpenSubtitlesPT(imdbId, job.type, job.season || 1, job.episode || 1).catch(() => []) : [];
                        if (ptSubs && ptSubs.length > 0 && !job.ignorarFallbackLegendado && !job.onlyDublado) {
                            console.log(`ℹ️ [Fallback Legendado] Arquivo em idioma original sem áudio PT-BR embutido, mas com ${ptSubs.length} legenda(s) PT-BR encontradas no OpenSubtitles. Processando como Legendado (PT-BR)...`);
                            langInfo = {
                                isValid: true,
                                isDublado: false,
                                isLegendado: true,
                                hasBoth: false,
                                audioText: 'Legendado (PT-BR)'
                            };
                            job.audioPreference = 'legendado';
                        } else {
                            console.log(`⚠️ Arquivo descartado: Nenhuma faixa de áudio dublado nem legenda em Português detectada no download de "${job.title}".`);
                            await DownloaderManager.cleanupFile(rawFilePath);
                            if (job.type === 'serie') {
                                this.recordSkippedEpisode(metadata.nome || job.title, job.season || 1, job.episode || 1);
                            }
                            throw new Error(`O arquivo baixado não contém áudio dublado em Português.`);
                        }
                    }
                }

                console.log(`🎙️ Conteúdo em Português e Duração validados com sucesso: ${langInfo.audioText} (Duração: ${videoInfo.durationFormatted}${tmdbExpectedDurationMin ? ` / Esperado TMDB: ~${tmdbExpectedDurationMin} min` : ''})`);

            } catch (err) {
                if (err.message.includes('não contém áudio nem legendas') || err.message.includes('duração inferior') || err.message.includes('Russo/Scam')) {
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

            // Adquire lock de transcode para este episódio/filme antes de chamar FFmpeg
            const normT = normalizeTitle(job.title);
            const transcodeKey = job.type === 'serie'
                ? `serie_${normT}_s${job.season ?? 1}_e${job.episode ?? 1}`
                : `filme_${normT}`;

            if (this.transcodeLocks.has(transcodeKey)) {
                console.log(`🛡️ [Transcode Lock] Abortando transcode duplicado: "${job.title}" ${job.type === 'serie' ? `T${job.season ?? 1}E${job.episode ?? 1}` : ''} — outro worker já está otimizando este mesmo conteúdo.`);
                throw new Error(`Transcode duplicado bloqueado: ${transcodeKey}`);
            }
            this.transcodeLocks.add(transcodeKey);

            // Dispara imediatamente o próximo download da fila enquanto este otimiza em paralelo
            setImmediate(() => this.processNext());

            try {
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
                isDirect: bestSource?.isDirect || job.bestSource?.isDirect || false,
                hasEmbeddedSub: bestSource?.hasEmbeddedSub || job.bestSource?.hasEmbeddedSub || false,
                isReadySub: bestSource?.isReadySub || job.bestSource?.isReadySub || false,
                isDublado: langInfo?.isDublado ?? true,
                isLegendado: langInfo?.isLegendado ?? false
            });

            // Assim que a otimização 1080p finaliza com sucesso, deleta imediatamente o arquivo bruto original
            // para não manter cópias duplicadas ocupando espaço durante a fase de upload
            if (rawFilePath && optimizedPath && rawFilePath !== optimizedPath && fs.existsSync(optimizedPath)) {
                console.log(`🧹 [Otimização Concluída] Liberando espaço em disco: removendo arquivo bruto original (${path.basename(rawFilePath)})...`);
                await DownloaderManager.cleanupFile(rawFilePath);
                rawFilePath = null;
                job.rawFilePath = null;
                await this.saveJob(job);
            }
            } finally {
                // Libera o lock de transcode independente de sucesso ou falha
                this.transcodeLocks.delete(transcodeKey);
            }
        }

        // 5. Envio ao Telegram com Barra de Upload em Tempo Real
        // Se estiver fora do horário de São Paulo (01h-05h), pausa antes do envio pela rede
        if (!SchedulerService.isAllowedToRun()) {
            console.log(`⏰ [Scheduler SP] Otimização 1080p concluída com sucesso para "${job.title}"! Pausando envio: aguardando janela de upload das 01h às 05h (Horário de SP)...`);
            job.status = 'queued';
            job.progress = 100;
            job.progressDetails = '100% Otimizado 1080p. Aguardando janela de upload (01h-05h SP)...';
            job.optimizedPath = optimizedPath;
            await this.saveJob(job);
            return;
        }

        // Concorrência de upload adaptativa ao modo ativo:
        // - Modo Econômico: 1 upload por vez (protege upstream residencial)
        // - Modo Desempenho: múltiplos uploads simultâneos (PERFORMANCE_MAX_UPLOADS)
        const maxUploadsAllowed = SchedulerService.getActiveMode() === 'eco' ? 1 : (config.PERFORMANCE_MAX_UPLOADS || this.maxConcurrentUploads || 3);
        while (this.getActiveActualUploadsCount(job.id) >= maxUploadsAllowed) {
            job.status = 'queued';
            job.progressDetails = 'Aguardando slot de upload livre...';
            console.log(`⏳ [QoS Upload] Job "${job.title}" aguardando upload anterior terminar (limite no modo ${SchedulerService.getActiveMode()}: ${maxUploadsAllowed} uploads simultâneos)...`);
            await new Promise(r => setTimeout(r, 5000));
        }

        // Validação Estrita de Duração Pré-Upload (Evita qualquer envio de vídeo cortado/truncado por crash prévio)
        const finalOptInfo = await VideoProcessor.getVideoInfo(optimizedPath).catch(() => null);
        if (finalOptInfo && finalOptInfo.duration > 0 && finalOptInfo.duration < finalMinSec) {
            console.error(`❌ [TRAVA ANTI-TRUNCAMENTO] Arquivo otimizado para "${job.title}" possui apenas ${finalOptInfo.durationFormatted} (${Math.round(finalOptInfo.duration)}s), mas o mínimo aceito é ${Math.round(finalMinSec / 60)} min. Abortando upload e limpando arquivo corrompido.`);
            await DownloaderManager.cleanupFile(optimizedPath);
            await DownloaderManager.cleanupFile(rawFilePath);
            throw new Error(`Vídeo com duração truncada (${finalOptInfo.durationFormatted} vs mínimo de ${Math.round(finalMinSec / 60)} min). Upload abortado.`);
        }

        job.status = 'uploading';
        job.progress = 0;
        job.progressDetails = 'Iniciando envio ao Telegram...';
        this.activeTask = job;
        await this.saveJob(job);

        // Dispara o próximo item enquanto este faz upload para o Telegram
        setImmediate(() => this.processNext());

        metadata.tipo = job.type;
        metadata.season = job.season;
        metadata.episode = job.episode;
        metadata.episodioNome = job.type === 'serie' ? `Episódio ${job.episode || 1}` : '';

        // Detecção ultra robusta e infalível de Cinema/CAM vs Master Digital (WEB-DL / Blu-ray)
        const CAM_REGEX = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|gravado\s*no\s*cinema|audio\s*cinema|som\s*cinema|audio\s*de\s*cinema|som\s*de\s*cinema|line\s*audio|mic\s*audio|hq-cam|new-cam|cam-1080p|cam-720p|tc|telecine|workprint|wp|clean\s*audio)\b/i;
        const CAM_GROUPS_REGEX = /\b(c0p|evo-cam|evo\.cam|ddhdcam|bdvd|evo-hd)\b/i;
        const DIGITAL_MASTER_REGEX = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|amzn|nf|dsnp|atvp|max|hbo|hdtv)\b/i;

        const effectiveSource = job.bestSource || (typeof bestSource !== 'undefined' ? bestSource : {}) || {};
        const sourceTitle = effectiveSource.title || path.basename(rawFilePath || optimizedPath || '');
        const hasCamKeyword = CAM_REGEX.test(sourceTitle) || CAM_GROUPS_REGEX.test(sourceTitle) || (effectiveSource.isCam === true);
        const hasDigitalKeyword = DIGITAL_MASTER_REGEX.test(sourceTitle) && !hasCamKeyword;
        const isBrazilianGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|kyogo|lipeh|guanabara|ondebaixo|acervo|mmfilmes|p2p[-_ ]?br/i.test(sourceTitle);

        const relStatus = job.type === 'filme' ? await TMDBService.checkDigitalReleaseStatus(metadata.tmdbId, job.audioPreference !== 'legendado') : { isTheatricalOnly: false };
        const isCamArtifacts = VideoProcessor.detectCamArtifacts(videoInfo, path.basename(rawFilePath || optimizedPath || ''), metadata);

        let isCamFinal = false;
        if (hasCamKeyword || isCamArtifacts || (effectiveSource.quality && effectiveSource.quality.toUpperCase().includes('CAM'))) {
            isCamFinal = true;
        } else if (relStatus.isTheatricalOnly && (!hasDigitalKeyword || !isBrazilianGroup)) {
            // Se o filme só existe em cinema no mundo, qualquer release de tracker genérico com WEBRip é fake/CAM/Bet disfarçado
            isCamFinal = true;
        }

        if (isCamFinal && !config.ALLOW_CINEMA_CAM && !job.allowCam) {
            console.log(`🚫 [CAM REJEITADO] "${job.title}" identificado como gravação de cinema/CAM e o sistema está configurado para não aceitar versões de cinema (ALLOW_CINEMA_CAM = false). Abortando.`);
            await DownloaderManager.cleanupFile(rawFilePath);
            await DownloaderManager.cleanupFile(optimizedPath);
            throw new Error(`Rejeitado: Versão de cinema/CAM detectada para "${job.title}". Aguardando lançamento digital oficial.`);
        }

        metadata.isCam = isCamFinal;
        if (isCamFinal) {
            console.log(`🎬 [CAM DETECTADO] "${job.title}" identificado como gravação de Cinema. Motivo: ${hasCamKeyword ? 'título/grupo de release CAM' : (isCamArtifacts ? 'áudio/container mono ou de microfone de cinema' : 'lançamento digital oficial não ocorreu no TMDB')}`);
        }
        metadata.qualidade = isCamFinal ? 'Versão Cinema (CAM)' : (effectiveSource.quality || '1080p Full HD');
        
        // Classificação rigorosa: Ou é 100% Dublado (áudio PT-BR sem legendas na tela) ou 100% Legendado (áudio original + legendas PT-BR)
        const sourceIsLegendadoOnly = (effectiveSource.isLegendado || bestSource?.isLegendado) && !(effectiveSource.isDublado || bestSource?.isDublado);
        const sourceIsDubladoOnly = (effectiveSource.isDublado || bestSource?.isDublado) && !(effectiveSource.isLegendado || bestSource?.isLegendado);

        const isJobDublado = (job.audioPreference === 'legendado' || sourceIsLegendadoOnly) ? false :
                             sourceIsDubladoOnly ? true :
                             (langInfo ? langInfo.isDublado : (job.langInfo ? job.langInfo.isDublado : true));
        if (isJobDublado) {
            metadata.isDublado = true;
            metadata.isLegendado = false;
            metadata.audio = 'Dublado (Áudio PT-BR)';
        } else {
            metadata.isDublado = false;
            metadata.isLegendado = true;
            metadata.audio = 'Legendado (PT-BR)';
        }

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
            let seasonNum = job.season || 1;
            let epNum = job.episode || 1;

            // Se o arquivo possui marcação explícita de temporada e episódio no caminho/nome real do arquivo baixado (ex: S04E03), usa os números reais do arquivo
            const filePathToCheck = metadata.rawFilePath || metadata.optimizedPath || metadata.nome || '';
            const matchEpFile = filePathToCheck.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\s*(?:e|ep|episodio|episódio|x)\s*(\d{1,3})\b/i);
            if (matchEpFile) {
                seasonNum = parseInt(matchEpFile[1], 10);
                epNum = parseInt(matchEpFile[2], 10);
            }

            // ─────────────────────────────────────────────────────────────────────────────
            // MAPEAMENTO DE TEMPORADA VIA TMDB: Corrige casos onde o release labela como S01
            // uma sub-temporada que no TMDB é T2+ (ex: Bleach TYBW labela S01E01 mas é T2E01 no TMDB).
            // Casos conhecidos: Bleach TYBW, Dragon Ball Super, Attack on Titan Final Season, etc.
            // ─────────────────────────────────────────────────────────────────────────────
            const KNOWN_SUBSERIES_SUFFIXES = /(thousand[- ]?year|tybw|blood war|final season|part|cour|arc|shippuden|shippuuden|super|z kai|kai)/i;
            const releaseTitle = (bestSource?.title || job.title || '').toLowerCase();
            const isSubSeries = KNOWN_SUBSERIES_SUFFIXES.test(releaseTitle) || KNOWN_SUBSERIES_SUFFIXES.test(filePathToCheck);

            if (isSubSeries && seasonNum === 1 && metadata.tmdbId) {
                try {
                    const TVDetails = await TMDBService.getTVDetails(metadata.tmdbId);
                    if (TVDetails && TVDetails.temporadas && TVDetails.temporadas.length >= 2) {
                        // Encontra a temporada cujo nome/data de lançamento corresponde melhor ao release
                        let bestSeasonMatch = null;
                        for (const t of TVDetails.temporadas) {
                            if (t.numero <= 1) continue; // Só interessa se houver T2+
                            const tName = (t.nome || '').toLowerCase();
                            if (KNOWN_SUBSERIES_SUFFIXES.test(tName) || KNOWN_SUBSERIES_SUFFIXES.test(releaseTitle)) {
                                // Verifica também se o episódio existe nesta temporada
                                const seasonDetails = await TMDBService.getSeasonDetails(metadata.tmdbId, t.numero).catch(() => null);
                                if (seasonDetails && seasonDetails.episodios && seasonDetails.episodios.find(e => e.numero === epNum)) {
                                    bestSeasonMatch = t.numero;
                                    break;
                                }
                            }
                        }
                        if (bestSeasonMatch && bestSeasonMatch !== seasonNum) {
                            console.log(`🗺️ [Season Remap] "${metadata.nome}" T${seasonNum}E${epNum} re-mapeado para T${bestSeasonMatch}E${epNum} via TMDB (release sub-série detectado: "${releaseTitle}")`);
                            seasonNum = bestSeasonMatch;
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ [Season Remap] Falha ao verificar mapeamento de temporada via TMDB:', e.message);
                }
            }

            await this.catalogoManager.adicionarEpisodioSerie(
                metadata.nome,
                seasonNum,
                epNum,
                uploadResult.messageId,
                uploadResult.fileId,
                {
                    ...metadata,
                    isCam: isCamFinal,
                    qualidade: metadata.qualidade || '1080p Full HD'
                }
            );
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
        try {
            const storageGroupId = config.STORAGE_GROUP_ID;

            if (this.bot && storageGroupId) {
                const tipoTexto = job.type === 'serie' 
                    ? `📺 <b>Série/Dorama:</b> ${metadata.nome} (T${job.season || 1}E${job.episode || 1})` 
                    : `🎬 <b>Filme:</b> ${metadata.nome}${metadata.ano ? ` (${metadata.ano})` : ''}`;
                const fonteInfo = job.bestSource?.title || job.bestSource?.source || (job.rawFilePath ? path.basename(job.rawFilePath) : null) || metadata.release || metadata.nome || 'Automática (Torrentio/Stremio)';

                let audioBloco = '🔊 <b>Áudio:</b> Dublado (Áudio PT-BR)';
                if (metadata.isDublado && metadata.isLegendado) {
                    audioBloco = '🔊 <b>Áudio:</b> Dual Áudio (Dublado + Original)\n📝 <b>Legendas:</b> Português (PT-BR) [Embutida]';
                } else if (metadata.isLegendado || !metadata.isDublado) {
                    audioBloco = '🔊 <b>Áudio:</b> Original (Inglês)\n📝 <b>Legendas:</b> Português (PT-BR) [Embutida/Hardsub]';
                }

                const qualTexto = isCamFinal ? 'Versão Cinema (CAM)' : (metadata.qualidade || '1080p Full HD');

                const notifMsg = `✅ <b>Conteúdo Armazenado & Catalogado com Sucesso!</b>\n\n` +
                                 `${tipoTexto}\n` +
                                 `✨ <b>Qualidade:</b> ${qualTexto}\n` +
                                 `${audioBloco}\n` +
                                 `📦 <b>Fonte/Release:</b> <code>${fonteInfo}</code>\n` +
                                 `🆔 <b>Message ID:</b> <code>${uploadResult.messageId}</code>\n\n` +
                                 `🍿 <b>Disponível imediatamente para todos os usuários!</b>`;

                await this.bot.sendMessage(storageGroupId, notifMsg, { parse_mode: 'HTML' }).catch(async (err) => {
                    console.warn('⚠️ Falha ao enviar com HTML no armazém, tentando texto puro:', err.message);
                    const plainMsg = notifMsg.replace(/<[^>]*>/g, '');
                    await this.bot.sendMessage(storageGroupId, plainMsg).catch(err2 => {
                        console.error('❌ Erro definitivo ao enviar confirmação no grupo armazém:', err2.message);
                    });
                });
                console.log(`📢 [ARMAZÉM] Notificação de confirmação enviada com sucesso no grupo ${storageGroupId}!`);
            }
        } catch (e) {
            console.error('❌ Erro no bloco de notificação do armazém:', e.message);
        }

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

        // 10. Se for Série/Dorama, enfileira o próximo episódio e próxima temporada automaticamente até completar 100%!
        if (job.type === 'serie') {
            const currentSeasonNum = job.season || 1;
            const currentEpNum = job.episode || 1;
            const nowStr = new Date().toISOString().split('T')[0];

            let totalEpsNestaTemporada = 10;
            let maxReleasedSeason = 1;

            try {
                if (metadata.tmdbId) {
                    const tvDetails = await TMDBService.getTVDetails(metadata.tmdbId).catch(() => null);
                    if (tvDetails && tvDetails.temporadas) {
                        // Considera apenas temporadas efetivamente lançadas (sem data futura não lançada)
                        const releasedSeasons = tvDetails.temporadas.filter(t => {
                            if (t.numero <= 0) return false;
                            if (t.dataLancamento && t.dataLancamento > nowStr) return false;
                            return (t.episodiosContagem > 0 || !t.dataLancamento);
                        });
                        if (releasedSeasons.length > 0) {
                            maxReleasedSeason = Math.max(...releasedSeasons.map(t => t.numero));
                        }
                    }

                    const seasonInfo = await TMDBService.getSeasonDetails(metadata.tmdbId, currentSeasonNum).catch(() => null);
                    if (seasonInfo && seasonInfo.episodios && seasonInfo.episodios.length > 0) {
                        // Apenas episódios que já foram lançados
                        const releasedEps = seasonInfo.episodios.filter(e => !e.dataLancamento || e.dataLancamento <= nowStr);
                        totalEpsNestaTemporada = releasedEps.length > 0 ? releasedEps.length : seasonInfo.episodios.length;
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

            const nextEp = currentEpNum + 1;

            if (nextEp <= totalEpsNestaTemporada) {
                // Próximo episódio da mesma temporada — Prioridade VIP_USER e queueOrder -1 para terminar a série antes de ir para outra!
                console.log(`📺 [SÉRIE/DORAMA] Enfileirando próximo episódio COM PRIORIDADE MÁXIMA (continuidade): "${metadata.nome || job.title}" - T${currentSeasonNum}E${nextEp} (de ${totalEpsNestaTemporada} eps lançados)`);
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

                // Avança para a próxima temporada SOMENTE se a próxima temporada estiver lançada
                const nextSeasonNum = currentSeasonNum + 1;
                if (nextSeasonNum <= maxReleasedSeason) {
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
                    console.log(`🎉 [SÉRIE/DORAMA] SÉRIE COMPLETA! Todas as ${maxReleasedSeason} temporada(s) lançadas de "${metadata.nome || job.title}" foram catalogadas com sucesso!`);
                }
            }
        }

        // Remove da watchlist de sementes pois já foi concluído
        SwarmWatcher.removeFromWatchlist(
            metadata.nome || job.title,
            job.type,
            job.season,
            job.episode,
            metadata.isDublado ? 'dublado' : 'legendado'
        ).catch(() => {});

        // Executa limpeza de disco assíncrona após finalizar processamento
        DiskCleaner.scanAndClean(this.getActiveFiles()).catch(() => {});
    }

    getStatus() {
        return {
            total: this.queue.length,
            queued: this.queue.filter(j => j.status === 'queued').length,
            completed: this.queue.filter(j => j.status === 'completed').length,
            failed: this.queue.filter(j => j.status === 'failed').length,
            activeTask: this.activeTask,
            activeTasks: Array.from(this.activeJobs.values())
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

        const activeTasks = Array.from(this.activeJobs.values()).map(formatJob);
        const active = activeTasks.length > 0 ? activeTasks[0] : null;
        const pending = this.queue
            .filter(j => j.status === 'queued')
            .map(formatJob);
        
        // Itens recentes baseados estritamente no catálogo ativo real
        const cat = catalogoManager || this.catalogoManager;
        let recentCompleted = [];

        if (cat && cat.catalogo) {
            const filmesRecentes = (cat.catalogo.filmes || []).map(f => {
                const hasDub = f.isDublado || !!f.versoes?.dublado;
                const hasLeg = f.isLegendado || !!f.versoes?.legendado;
                return {
                    id: f.id,
                    title: f.nome,
                    type: 'filme',
                    season: null,
                    episode: null,
                    qualidade: f.qualidade || (f.isCam ? 'CAM' : '1080p Full HD'),
                    isCam: f.isCam,
                    isDublado: hasDub,
                    isLegendado: hasLeg,
                    audioBadge: hasDub && hasLeg ? 'D/L' : (hasDub ? 'D' : (hasLeg ? 'L' : '')),
                    data: new Date(f.dataAdicionado || 0).getTime()
                };
            });

            const epsRecentes = [];
            for (const s of (cat.catalogo.series || [])) {
                for (const t of (s.temporadas || [])) {
                    for (const ep of (t.episodios || [])) {
                        const hasDub = ep.isDublado || !!ep.versoes?.dublado;
                        const hasLeg = ep.isLegendado || !!ep.versoes?.legendado;
                        epsRecentes.push({
                            id: ep.id || s.id,
                            title: s.nome,
                            type: 'serie',
                            season: t.numero,
                            episode: ep.numero,
                            qualidade: ep.qualidade || '1080p Full HD',
                            isCam: false,
                            isDublado: hasDub,
                            isLegendado: hasLeg,
                            audioBadge: hasDub && hasLeg ? 'D/L' : (hasDub ? 'D' : (hasLeg ? 'L' : '')),
                            data: new Date(ep.dataAdicionado || s.dataAdicionado || 0).getTime()
                        });
                    }
                }
            }

            recentCompleted = [...filmesRecentes, ...epsRecentes]
                .sort((a, b) => b.data - a.data)
                .slice(0, 8);
        } else {
            recentCompleted = this.queue
                .filter(j => j.status === 'completed')
                .slice(-8)
                .reverse()
                .map(formatJob);
        }

        return {
            isProcessing: this.isProcessing,
            activeTask: active,
            activeTasks: activeTasks,
            maxConcurrentJobs: this.maxConcurrentJobs || 4,
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

module.exports = { QueueManager, PRIORITIES, PriorityService };
