const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const config = require('../../config');
const TMDBService = require('../services/TMDBService');
const MediaSearchService = require('../services/MediaSearchService');
const DownloaderManager = require('../services/DownloaderManager');
const VideoProcessor = require('../services/VideoProcessor');
const TelegramUploader = require('../services/TelegramUploader');

const PRIORITIES = {
    USER: 1,      // Pedido direto de assinante (Fura-fila)
    SERIES: 2,    // Continuação de série/dorama em andamento
    FEEDER: 3     // Auto-Feeder (população em background)
};

class QueueManager extends EventEmitter {
    constructor(bot, catalogoManager) {
        super();
        this.bot = bot;
        this.catalogoManager = catalogoManager;
        this.uploader = new TelegramUploader(bot);
        this.queueFile = config.QUEUE_FILE || './data/queue.json';
        this.queue = [];
        this.activeTask = null;
        this.isProcessing = false;
        
        this.loadQueue();

        // Inicia processamento 2s após inicializar
        setTimeout(() => {
            this.processNext();
        }, 2000);
    }

    setBot(bot) {
        this.bot = bot;
        this.uploader.setBot(bot);
    }

    loadQueue() {
        try {
            if (fs.existsSync(this.queueFile)) {
                this.queue = fs.readJsonSync(this.queueFile);
                // Reseta tarefas interrompidas para que sejam retomadas
                this.queue.forEach(j => {
                    if (['processing', 'downloading', 'uploading'].includes(j.status)) {
                        j.status = 'queued';
                        j.progress = 0;
                    }
                });
                this.saveQueue();
            } else {
                this.queue = [];
                this.saveQueue();
            }
        } catch (e) {
            console.error('❌ Erro ao carregar fila:', e.message);
            this.queue = [];
        }
    }

    saveQueue() {
        try {
            fs.writeJsonSync(this.queueFile, this.queue, { spaces: 2 });
        } catch (e) {
            console.error('❌ Erro ao salvar fila:', e.message);
        }
    }

    addJob(title, type = 'filme', priority = PRIORITIES.FEEDER, extraData = {}) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        const job = {
            id: jobId,
            title: title.trim(),
            type: type, // 'filme' ou 'serie'
            priority: priority,
            userId: extraData.userId || null,
            username: extraData.username || null,
            season: extraData.season || 1,
            episode: extraData.episode || (type === 'serie' ? 1 : null),
            tmdbId: extraData.tmdbId || null,
            status: 'queued', // 'queued', 'downloading', 'processing', 'uploading', 'completed', 'failed'
            progress: 0,
            progressDetails: '',
            createdAt: new Date().toISOString(),
            error: null
        };

        // Verifica se já existe um trabalho igual na fila
        const existing = this.queue.find(j => 
            j.title.toLowerCase() === title.toLowerCase() && 
            j.season === job.season && 
            j.episode === job.episode &&
            j.status !== 'failed'
        );

        if (existing) {
            // Se for pedido de usuário, eleva a prioridade do existente
            if (priority === PRIORITIES.USER && existing.priority > PRIORITIES.USER) {
                existing.priority = PRIORITIES.USER;
                existing.userId = job.userId;
                existing.username = job.username;
                this.sortQueue();
                this.saveQueue();
            }
            return existing;
        }

        this.queue.push(job);
        this.sortQueue();
        this.saveQueue();

        console.log(`📌 Novo trabalho na fila: "${job.title}" [Prioridade: ${job.priority}] (Total na fila: ${this.queue.length})`);
        
        // Inicia processamento se ocioso
        this.processNext();
        return job;
    }

    sortQueue() {
        this.queue.sort((a, b) => {
            if (a.priority !== b.priority) {
                return a.priority - b.priority; // 1 antes de 2, 2 antes de 3
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
        this.saveQueue();

        console.log(`\n⚙️ INICIANDO PROCESSAMENTO: "${nextJob.title}" (Prioridade: ${nextJob.priority})`);

        try {
            await this.executeJob(nextJob);
            nextJob.status = 'completed';
            nextJob.progress = 100;
            console.log(`🎉 Trabalho concluído com sucesso: "${nextJob.title}"`);
        } catch (error) {
            console.error(`❌ Falha no processamento de "${nextJob.title}":`, error.message);
            nextJob.status = 'failed';
            nextJob.error = error.message;

            // Se for pedido de usuário, avisa do erro
            if (nextJob.userId && this.bot) {
                this.bot.sendMessage(nextJob.userId, `⚠️ Não conseguimos baixar "${nextJob.title}" automaticamente no momento. Nossa equipe foi notificada!`).catch(() => {});
            }
        } finally {
            this.saveQueue();
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

        // Notifica usuário sobre início do download
        if (job.userId && this.bot) {
            this.bot.sendMessage(job.userId, `🎬 Encontramos seu pedido *"${job.title}"*!\nIniciando download em alta qualidade (1080p)...`, { parse_mode: 'Markdown' }).catch(() => {});
        }

        // 2. Buscar fontes (Torrents / Direct)
        const sources = await MediaSearchService.search(job.title, job.type, {
            nomeOriginal: metadata.nomeOriginal,
            ano: metadata.ano,
            tmdbId: metadata.tmdbId,
            imdbId: metadata.imdbId,
            season: job.season || 1,
            episode: job.episode || 1
        });
        if (sources.length === 0) {
            if (job.userId && this.bot) {
                const aviso = `🔔 *Aviso sobre o seu pedido: "${job.title}"*\n\n` +
                              `Informamos que este título ainda não possui versão Dublada ou Legendada em Português disponível no momento.\n\n` +
                              `🔄 *Fique tranquilo!* Nosso sistema cadastrou seu pedido no radar e monitorará diariamente. Assim que a versão em Português for lançada, ela será baixada e você será notificado! 🍿`;
                this.bot.sendMessage(job.userId, aviso, { parse_mode: 'Markdown' }).catch(() => {});
            }
            throw new Error(`Nenhuma fonte em Português encontrada para "${job.title}".`);
        }

        const bestSource = sources[0];
        console.log(`🎯 Melhor fonte selecionada: ${bestSource.title} (${bestSource.sizeMB} MB, ${bestSource.audio})`);

        // 3. Download
        job.status = 'downloading';
        this.saveQueue();

        let downloadedMedia;
        if (bestSource.magnet) {
            downloadedMedia = await DownloaderManager.downloadTorrent(bestSource.magnet, (progress) => {
                job.progress = progress.percent;
                job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed})`;
            }, { title: job.title });
        } else if (bestSource.url) {
            const fileName = `${Date.now()}_${path.basename(bestSource.url) || 'video.mp4'}`;
            downloadedMedia = await DownloaderManager.downloadHttp(bestSource.url, fileName, (progress) => {
                job.progress = progress.percent;
                job.progressDetails = `${progress.downloaded} / ${progress.total}`;
            }, { title: job.title });
        }

        const rawFilePath = downloadedMedia.filePath;

        // 3.5 Verificação de Áudio (Garantia de Idioma PT-BR)
        try {
            const videoInfo = await VideoProcessor.getVideoInfo(rawFilePath);
            const hasPortuguese = VideoProcessor.hasPortugueseAudio(videoInfo, downloadedMedia.fileName);
            if (!hasPortuguese && !bestSource.isLegendado) {
                console.log(`⚠️ Arquivo descartado: Nenhuma faixa de áudio em Português detectada no download de "${job.title}".`);
                await DownloaderManager.cleanupFile(rawFilePath);
                throw new Error(`O arquivo baixado não contém áudio em Português.`);
            }
        } catch (err) {
            if (err.message.includes('não contém áudio em Português')) {
                throw err;
            }
        }

        // 4. Otimização de Vídeo 1080p com FFmpeg
        job.status = 'processing';
        job.progressDetails = 'Otimizando para 1080p...';
        this.saveQueue();

        const optimizedPath = path.join(path.dirname(rawFilePath), `opt_${path.basename(rawFilePath, path.extname(rawFilePath))}.mp4`);
        
        await VideoProcessor.optimizeForTelegram(rawFilePath, optimizedPath, (percent) => {
            job.progress = percent;
            job.progressDetails = `Codificando 1080p: ${percent}%`;
        });

        // 5. Upload para o Canal de Armazenamento
        job.status = 'uploading';
        job.progressDetails = 'Enviando para o Telegram...';
        this.saveQueue();

        metadata.qualidade = bestSource.quality || '1080p';
        metadata.isCam = bestSource.isCam || false;
        metadata.audio = bestSource.audio || (bestSource.isDublado ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)');
        metadata.isDublado = bestSource.isDublado || false;
        metadata.isLegendado = bestSource.isLegendado || false;

        const uploadResult = await this.uploader.uploadVideo(optimizedPath, metadata);

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
                    episodioNome: `Episódio ${job.episode}`
                }
            );
        }

        // 7. Limpeza dos arquivos temporários
        await DownloaderManager.cleanupFile(rawFilePath);
        await DownloaderManager.cleanupFile(optimizedPath);

        // 8. Se for pedido de usuário, notifica com o botão de assistir
        if (job.userId && this.bot) {
            const mensagem = `🎉 *Seu pedido está pronto para assistir!*\n\n` +
                            `🎬 *${metadata.nome}*\n` +
                            `✨ *Qualidade:* 1080p Full HD\n` +
                            `🔊 *Áudio:* ${metadata.audio}\n\n` +
                            `Clique abaixo para assistir agora:`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '▶️ Assistir Agora', callback_data: `ver_${uploadResult.messageId}` }]
                ]
            };

            this.bot.sendMessage(job.userId, mensagem, {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            }).catch(() => {});
        }

        // 9. Se for Série/Dorama, enfileira o próximo episódio com prioridade de série!
        if (job.type === 'serie') {
            const nextEp = (job.episode || 1) + 1;
            const maxEpisodes = metadata.totalEpisodios || 16; // Padrão doramas: 16 eps

            if (nextEp <= maxEpisodes) {
                console.log(`📺 Enfileirando próximo episódio: ${job.title} T${job.season}E${nextEp}`);
                this.addJob(job.title, 'serie', PRIORITIES.SERIES, {
                    tmdbId: metadata.tmdbId,
                    season: job.season,
                    episode: nextEp,
                    userId: job.userId
                });
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
}

module.exports = { QueueManager, PRIORITIES };
