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

    setManagers(pedidosManager, favoritosManager) {
        this.pedidosManager = pedidosManager;
        this.favoritosManager = favoritosManager;
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
            audioPreference: extraData.audioPreference || 'dublado',
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

        // Verifica se já existe um trabalho igual na fila com a mesma preferência de áudio
        const existing = this.queue.find(j => 
            j.title.toLowerCase() === title.toLowerCase() && 
            j.season === job.season && 
            j.episode === job.episode &&
            (j.audioPreference || 'dublado') === job.audioPreference &&
            j.status !== 'failed'
        );

        if (existing) {
            // Se for pedido de usuário, eleva a prioridade do existente
            if ((priority === PRIORITIES.VIP_USER || priority === PRIORITIES.USER) && existing.priority > priority) {
                existing.priority = priority;
                existing.userId = job.userId;
                existing.username = job.username;
                this.sortQueue();
                this.saveQueue();
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

        // Se for série e o episódio já existir no catálogo, ignora adição duplicada
        if (type === 'serie') {
            const serieExistente = this.catalogoManager.buscarItemExato(title, 'serie');
            if (serieExistente) {
                const temporada = (serieExistente.temporadas || []).find(t => t.numero === job.season);
                const epsCadastrados = (temporada?.episodios || []).map(e => e.numero);
                if (epsCadastrados.includes(job.episode)) {
                    console.log(`ℹ️ [Fila] "${title}" T${job.season}E${job.episode} já está cadastrado no catálogo. Ignorando.`);
                    return null;
                }
            }
        }

        this.queue.push(job);
        this.sortQueue();
        this.saveQueue();

        console.log(`📌 Novo trabalho na fila: "${job.title}" [Áudio: ${job.audioPreference}, Prioridade: ${job.priority}] (Total na fila: ${this.queue.length})`);
        
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

        // Validação de Ordem Cronológica e Verificação de Existência de Episódios para Séries/Doramas
        if (job.type === 'serie') {
            const seasonNum = job.season || 1;
            const requestedEp = job.episode || 1;

            const serieExistente = this.catalogoManager.buscarItemExato(metadata.nome || job.title, 'serie') ||
                                  this.catalogoManager.buscarItemExato(job.title, 'serie');
            if (serieExistente) {
                const temporada = (serieExistente.temporadas || []).find(t => t.numero === seasonNum);
                const epsCadastrados = (temporada?.episodios || []).map(e => e.numero);

                if (epsCadastrados.includes(requestedEp)) {
                    console.log(`✅ [SÉRIE] "${job.title}" T${seasonNum}E${requestedEp} já está no catálogo! Avançando.`);
                    return;
                }

                for (let ep = 1; ep < requestedEp; ep++) {
                    if (!epsCadastrados.includes(ep)) {
                        console.log(`⚠️ [ORDEM CRONOLÓGICA] Série "${job.title}" solicitou o Ep ${requestedEp}, mas o Ep ${ep} ainda não existe no catálogo. Ajustando download para T${seasonNum}E${ep} primeiro!`);
                        job.episode = ep;
                        this.saveQueue();
                        break;
                    }
                }
            } else if (requestedEp > 1) {
                console.log(`⚠️ [ORDEM CRONOLÓGICA] Série "${job.title}" não possui cadastro no catálogo. Forçando início a partir do Episódio 1 (T${seasonNum}E1)!`);
                job.episode = 1;
                this.saveQueue();
            }
        }

        // 2. Buscar fontes (Torrents / Direct) se necessário
        let sources = [];
        let downloadedMedia = null;
        let bestSource = job.bestSource || null;
        let rawFilePath = job.rawFilePath || null;
        let optimizedPath = job.optimizedPath || null;
        let langInfo = job.langInfo || { isValid: true, isDublado: true, isLegendado: false, audioText: 'Dublado (PT-BR)' };

        // 2.5 Verificar se já existe arquivo codificado ou baixado no SSD com validação de integridade FFprobe
        let resumeFromOptimized = false;
        let resumeFromRaw = false;

        // Limpeza de arquivos temporários ao reiniciar se o job não estava 100% pronto para upload
        if (job.status !== 'uploading') {
            if (optimizedPath && fs.existsSync(optimizedPath)) {
                await DownloaderManager.cleanupFile(optimizedPath);
                optimizedPath = null;
                job.optimizedPath = null;
            }
            if (rawFilePath && fs.existsSync(rawFilePath)) {
                // Se o tamanho no disco não corresponder ao tamanho esperado completo do torrent, descarta para evitar arquivos cortados
                const rawStat = fs.statSync(rawFilePath);
                if (job.expectedSize && rawStat.size < job.expectedSize * 0.99) {
                    console.log(`🧹 Arquivo temporário incompleto no disco (${rawStat.size} de ${job.expectedSize} bytes esperados) descartado para reiniciar limpo.`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    rawFilePath = null;
                    job.rawFilePath = null;
                }
            }
        }

        if (!resumeFromOptimized && !resumeFromRaw) {
            sources = await MediaSearchService.search(job.title, job.type, {
                nomeOriginal: metadata.nomeOriginal,
                ano: metadata.ano,
                tmdbId: metadata.tmdbId,
                imdbId: metadata.imdbId,
                season: job.season || 1,
                episode: job.episode || 1,
                audioPreference: job.audioPreference || 'dublado'
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

            // 3. Download com Fallback Automático entre as melhores opções
            job.status = 'downloading';
            this.saveQueue();

            let lastError = null;
            const maxAttempts = Math.min(3, sources.length);
            for (let i = 0; i < maxAttempts; i++) {
                const currentSource = sources[i];
                console.log(`🎯 Tentando fonte [${i + 1}/${maxAttempts}]: ${currentSource.title} (${currentSource.sizeMB} MB, ${currentSource.seeders || 0} seeds, ${currentSource.audio})`);
                
                try {
                    if (currentSource.magnet) {
                        downloadedMedia = await DownloaderManager.downloadTorrent(currentSource.magnet, (progress) => {
                            job.progress = progress.percent;
                            job.progressDetails = `${progress.downloaded} / ${progress.total} (${progress.speed})`;
                        }, { title: job.title, season: job.season, episode: job.episode });
                    } else if (currentSource.url) {
                        const fileName = `${Date.now()}_${path.basename(currentSource.url) || 'video.mp4'}`;
                        downloadedMedia = await DownloaderManager.downloadHttp(currentSource.url, fileName, (progress) => {
                            job.progress = progress.percent;
                            job.progressDetails = `${progress.downloaded} / ${progress.total}`;
                        }, { title: job.title, season: job.season, episode: job.episode });
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
                throw new Error(`Todas as fontes testadas falharam ou estavam sem seeders: ${lastError?.message || 'Sem conexão'}`);
            }

            rawFilePath = downloadedMedia.filePath;
            job.rawFilePath = rawFilePath;
            job.expectedSize = downloadedMedia.sizeBytes;
            job.bestSource = bestSource;
            this.saveQueue();

            // Validação estrita: tamanho físico do arquivo deve bater com o tamanho informado no torrent
            if (fs.existsSync(rawFilePath)) {
                const stat = fs.statSync(rawFilePath);
                if (downloadedMedia.sizeBytes > 0 && stat.size < downloadedMedia.sizeBytes * 0.99) {
                    console.log(`❌ Arquivo bruto descartado: tamanho físico (${stat.size} B) menor que o esperado (${downloadedMedia.sizeBytes} B).`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`Download incompleto: arquivo recebido com tamanho menor que o esperado (${stat.size} de ${downloadedMedia.sizeBytes} bytes).`);
                }
            }
        }

        if (!resumeFromOptimized) {
            // 3.5 Verificação de Integridade, Duração Mínima e Idioma PT-BR
            try {
                const videoInfo = await VideoProcessor.getVideoInfo(rawFilePath);

                // Verificação de Duração Mínima (Anti-Sample / Anti-Propaganda de 30s)
                const minDurationSec = 300;
                if (videoInfo.duration && videoInfo.duration < minDurationSec) {
                    console.log(`⚠️ Arquivo descartado: Duração inválida de apenas ${videoInfo.durationFormatted} (${Math.round(videoInfo.duration)}s). Mínimo exigido: 5 minutos. Possível amostra/vídeo promocional falso para "${job.title}".`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`Vídeo com duração inferior a 5 minutos (${Math.round(videoInfo.duration)}s). Amostra descartada.`);
                }

                langInfo = VideoProcessor.validatePortugueseContent(videoInfo, path.basename(rawFilePath), bestSource || {});

                if (!langInfo.isValid) {
                    console.log(`⚠️ Arquivo descartado: Nenhuma faixa de áudio dublado nem legenda em Português detectada no download de "${job.title}".`);
                    await DownloaderManager.cleanupFile(rawFilePath);
                    throw new Error(`O arquivo baixado não contém áudio nem legendas em Português.`);
                }

                console.log(`🎙️ Conteúdo em Português validado com sucesso: ${langInfo.audioText} (Duração: ${videoInfo.durationFormatted})`);
            } catch (err) {
                if (err.message.includes('não contém áudio nem legendas') || err.message.includes('duração inferior')) {
                    throw err;
                }
            }

            // 4. Otimização de Vídeo 1080p com FFmpeg
            job.status = 'processing';
            job.progressDetails = 'Otimizando para 1080p...';
            job.langInfo = langInfo;
            this.saveQueue();

            optimizedPath = path.join(path.dirname(rawFilePath), `opt_${path.basename(rawFilePath, path.extname(rawFilePath))}.mp4`);
            job.optimizedPath = optimizedPath;
            this.saveQueue();
            
            await VideoProcessor.optimizeForTelegram(rawFilePath, optimizedPath, (percent, details) => {
                job.progress = percent;
                job.progressDetails = details || `Otimizando 1080p: ${percent}%`;
                this.activeTask = job;
            }, {
                nome: job.title,
                tipo: job.type,
                season: job.season,
                episode: job.episode
            });
        }

        // 5. Upload para o Canal de Armazenamento
        job.status = 'uploading';
        job.progressDetails = 'Enviando para o Telegram...';
        this.saveQueue();

        metadata.tipo = job.type;
        metadata.season = job.season;
        metadata.episode = job.episode;
        metadata.episodioNome = job.type === 'serie' ? `Episódio ${job.episode || 1}` : '';
        metadata.qualidade = bestSource?.quality || '1080p';
        metadata.isCam = bestSource?.isCam || false;
        metadata.audio = langInfo.audioText || bestSource?.audio || 'Dublado (PT-BR)';
        metadata.isDublado = langInfo.isDublado;
        metadata.isLegendado = langInfo.isLegendado;

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

        // 7. Notificação formal no Grupo de Armazenamento / Storage
        try {
            if (this.bot && config.STORAGE_GROUP_ID) {
                const tipoTexto = job.type === 'serie' ? `📺 *Série/Dorama:* ${metadata.nome} (T${job.season || 1}E${job.episode || 1})` : `🎬 *Filme:* ${metadata.nome}${metadata.ano ? ` (${metadata.ano})` : ''}`;
                const fonteInfo = bestSource?.title || bestSource?.provider || bestSource?.source || 'Automática (Torrentio/Stremio)';
                const storageMsg = `✅ *Conteúdo Armazenado & Catalogado com Sucesso!*\n\n` +
                                   `${tipoTexto}\n` +
                                   `✨ *Qualidade:* ${metadata.qualidade || '1080p Full HD'}\n` +
                                   `🔊 *Áudio:* ${metadata.audio || 'Dublado (Áudio PT-BR)'}\n` +
                                   `📦 *Fonte/Release:* \`${fonteInfo}\`\n` +
                                   `🆔 *Message ID:* \`${uploadResult.messageId}\`\n\n` +
                                   `🍿 *Disponível imediatamente para todos os usuários!*`;
                await this.bot.sendMessage(config.STORAGE_GROUP_ID, storageMsg, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (e) {}

        // 8. Limpeza dos arquivos temporários
        await DownloaderManager.cleanupFile(rawFilePath);
        await DownloaderManager.cleanupFile(optimizedPath);

        // 9. Notificação de Pedido Concluído (notifica quem fez o pedido)
        try {
            const itemSalvo = this.catalogoManager.buscarItemExato(metadata.nome, job.type);
            const itemId = itemSalvo?.id;
            const callbackAssistir = job.type === 'filme' ? `info_filme_${itemId}` : `info_serie_${itemId}`;

            // Notifica quem disparou o job apenas se for filme (para séries, notifica por temporada completa)
            if (job.type === 'filme' && job.userId && this.bot) {
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

            // Notifica outros usuários com pedidos pendentes deste título (se for filme)
            if (job.type === 'filme' && this.pedidosManager && this.bot) {
                const pedidos = this.pedidosManager.getPedidos() || [];
                const pedidosCorrespondentes = pedidos.filter(p => 
                    !p.processado && p.nome && metadata.nome &&
                    (p.nome.toLowerCase().trim() === metadata.nome.toLowerCase().trim() ||
                     metadata.nome.toLowerCase().includes(p.nome.toLowerCase().trim()))
                );

                for (const p of pedidosCorrespondentes) {
                    this.pedidosManager.marcarComoProcessado(p.id);
                    if (p.userId && p.userId !== job.userId) {
                        const msgPedido = `🎉 *Seu Pedido Chegou no BrasilFlix!*\n\n` +
                                         `🎬 *${metadata.nome}*\n` +
                                         `✨ *Qualidade:* 1080p Full HD\n` +
                                         `🔊 *Versão:* ${metadata.audio || 'Dublado (Áudio PT-BR)'}\n\n` +
                                         `O título que você pediu já está disponível no catálogo! 🍿`;

                        this.bot.sendMessage(p.userId, msgPedido, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                inline_keyboard: [[{ text: '▶️ Assistir Agora', callback_data: callbackAssistir }]]
                            }
                        }).catch(() => {});
                    }
                }
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

            // Obter informações exatas de temporadas do TMDB
            const temporadaAtual = (metadata.temporadas || []).find(t => t.numero === currentSeasonNum);
            const totalEpsNestaTemporada = temporadaAtual?.episodiosContagem || (metadata.totalEpisodios ? Math.ceil(metadata.totalEpisodios / (metadata.totalTemporadas || 1)) : 10);
            const totalTemporadas = metadata.totalTemporadas || (metadata.temporadas ? metadata.temporadas.length : 1);

            const nextEp = currentEpNum + 1;

            if (nextEp <= totalEpsNestaTemporada) {
                // Próximo episódio da mesma temporada
                console.log(`📺 [SÉRIE/DORAMA] Enfileirando próximo episódio: "${metadata.nome || job.title}" - T${currentSeasonNum}E${nextEp} (de ${totalEpsNestaTemporada} eps)`);
                this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.SERIES, {
                    tmdbId: metadata.tmdbId,
                    season: currentSeasonNum,
                    episode: nextEp,
                    userId: job.userId,
                    username: job.username
                });
            } else {
                // Temporada atual concluída! Notifica quem pediu sobre a temporada completa
                if (job.userId && this.bot) {
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
                        const pedidos = this.pedidosManager.getPedidos() || [];
                        const matchP = pedidos.filter(p => !p.processado && p.nome && (metadata.nome || job.title).toLowerCase().includes(p.nome.toLowerCase().trim()));
                        matchP.forEach(p => this.pedidosManager.marcarComoProcessado(p.id));
                    }
                }

                // Avança para a próxima temporada
                const nextSeasonNum = currentSeasonNum + 1;
                if (nextSeasonNum <= totalTemporadas) {
                    console.log(`📺 [SÉRIE/DORAMA] Temporada ${currentSeasonNum} concluída! Avançando para Temporada ${nextSeasonNum} (Episódio 1) de "${metadata.nome || job.title}"`);
                    this.addJob(metadata.nome || job.title, 'serie', PRIORITIES.SERIES, {
                        tmdbId: metadata.tmdbId,
                        season: nextSeasonNum,
                        episode: 1,
                        userId: job.userId,
                        username: job.username
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
}

module.exports = { QueueManager, PRIORITIES };
