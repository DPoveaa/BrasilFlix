const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const VideoProcessor = require('./VideoProcessor');
const SchedulerService = require('./SchedulerService');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');


class TelegramUploader {
    static getInstance() {
        if (!TelegramUploader._instance) {
            TelegramUploader._instance = new TelegramUploader();
        }
        return TelegramUploader._instance;
    }

    static async deleteStorageMessages(messageIds) {
        return TelegramUploader.getInstance().deleteStorageMessages(messageIds);
    }

    constructor(bot = null) {
        this.bot = bot;
        this.storageGroupId = config.STORAGE_GROUP_ID;
        this.client = null;
        this.isClientReady = false;
        this.initClientPromise = null;
    }

    setBot(bot) {
        this.bot = bot;
    }

    async getClient() {
        if (this.client && this.isClientReady) return this.client;
        if (this.initClientPromise) return this.initClientPromise;

        this.initClientPromise = (async () => {
            const apiId = config.TELEGRAM_API_ID || 2040;
            const apiHash = config.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627';
            const session = new StringSession(config.TELEGRAM_SESSION || '');

            const client = new TelegramClient(session, apiId, apiHash, {
                connectionRetries: 15,
                retryDelay: 2000,
                autoReconnect: true,
                useIPv6: false,
                timeout: 60,
                floodSleepThreshold: 120,
                deviceModel: 'BrasilFlix Engine',
                appVersion: '2.0.0',
                systemVersion: 'Linux'
            });

            console.log('🔌 Conectando ao Telegram MTProto (suporte a uploads de até 4GB Premium)...');
            if (config.TELEGRAM_SESSION && config.TELEGRAM_SESSION.trim() !== '') {
                await client.connect();
                console.log('✅ Cliente MTProto autenticado via Sessão Premium (Uploads de até 4GB desbloqueados)!');
            } else {
                const savedSessionFile = path.resolve(__dirname, '../../data/telegram_bot_session.txt');
                let savedSession = '';
                try {
                    if (fs.existsSync(savedSessionFile)) {
                        savedSession = fs.readFileSync(savedSessionFile, 'utf8').trim();
                    }
                } catch (e) {}

                let isAuthorized = false;
                if (savedSession) {
                    try {
                        client.session = new StringSession(savedSession);
                        await client.connect();
                        isAuthorized = await client.checkAuthorization();
                        if (isAuthorized) {
                            console.log('✅ Cliente MTProto autenticado via Sessão Salva!');
                        }
                    } catch (e) {
                        isAuthorized = false;
                    }
                }

                if (!isAuthorized) {
                    await client.start({ botAuthToken: config.BOT_TOKEN });
                    try {
                        const sessStr = client.session.save();
                        if (sessStr) {
                            fs.ensureDirSync(path.dirname(savedSessionFile));
                            fs.writeFileSync(savedSessionFile, sessStr, 'utf8');
                        }
                    } catch (e) {
                        console.warn('⚠️ Não foi possível persistir sessão do bot:', e.message);
                    }
                    console.log('✅ Cliente MTProto autenticado via Bot Token!');
                }
            }

            // Desativa o loop de updates em segundo plano (o GramJS é usado apenas como uploader/sender de arquivos pesados)
            if (typeof client._updateLoop === 'function') {
                client._updateLoop = async () => {};
            }

            this.client = client;
            this.isClientReady = true;
            return client;
        })();

        return this.initClientPromise;
    }

    /**
     * Helper centralizado para buscar mensagens do storage por ID.
     * Trata o tipo de STORAGE_GROUP_ID (Chat vs Channel/Supergroup) e distingue:
     * - 'FOUND': Mensagem existe com mídia válida
     * - 'NOT_FOUND': Mensagem confirmada como deletada/inexistente (MessageEmpty ou sem doc)
     * - 'INVALID_MEDIA': Mensagem existe mas com doc 0 bytes ou formato não-vídeo
     * - 'ERROR': Erro temporário de rede/Telegram (NÃO invalida mídia)
     * 
     * @param {number|number[]} messageIds ID ou lista de IDs de mensagens
     * @returns {Promise<Map<number, { status: string, message: any, doc: any, docId: string|null, docSize: number, isVideo: boolean, duration: number, fileName: string|null, error: string|null }>>}
     */
    async getStorageMessages(messageIds) {
        const resultMap = new Map();
        const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
            .map(id => Number(id))
            .filter(id => !isNaN(id) && id > 0))];

        if (ids.length === 0) return resultMap;

        let client;
        try {
            client = await this.getClient();
        } catch (err) {
            for (const id of ids) {
                resultMap.set(id, {
                    status: 'ERROR',
                    message: null,
                    doc: null,
                    docId: null,
                    docSize: 0,
                    isVideo: false,
                    duration: 0,
                    fileName: null,
                    error: err.message
                });
            }
            return resultMap;
        }

        const batchSize = 100;
        for (let i = 0; i < ids.length; i += batchSize) {
            const batch = ids.slice(i, i + batchSize);
            try {
                let entity = null;
                try {
                    entity = await client.getEntity(this.storageGroupId);
                } catch (e) {}

                let rawMessages = [];
                if (entity && (entity.className === 'Channel' || entity.className === 'ChatForbidden')) {
                    const inputChannel = await client.getInputEntity(entity);
                    const res = await client.invoke(new Api.channels.GetMessages({
                        channel: inputChannel,
                        id: batch.map(id => new Api.InputMessageID({ id }))
                    }));
                    rawMessages = res.messages || [];
                } else {
                    const res = await client.invoke(new Api.messages.GetMessages({
                        id: batch.map(id => new Api.InputMessageID({ id }))
                    }));
                    rawMessages = res.messages || [];
                }

                for (const requestedId of batch) {
                    const msg = rawMessages.find(m => m && m.id === requestedId);
                    if (!msg || msg.className === 'MessageEmpty') {
                        resultMap.set(requestedId, {
                            status: 'NOT_FOUND',
                            message: null,
                            doc: null,
                            docId: null,
                            docSize: 0,
                            isVideo: false,
                            duration: 0,
                            fileName: null,
                            error: null
                        });
                    } else if (msg.media && msg.media.document) {
                        const doc = msg.media.document;
                        const docSize = Number(doc.size || 0);
                        const mimeType = String(doc.mimeType || '').toLowerCase();
                        const videoAttr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeVideo');
                        const fnAttr = (doc.attributes || []).find(a => a.fileName);
                        const isVideo = mimeType.startsWith('video/') || !!videoAttr;
                        const duration = videoAttr?.duration || 0;

                        if (docSize === 0 || !isVideo) {
                            resultMap.set(requestedId, {
                                status: 'INVALID_MEDIA',
                                message: msg,
                                doc: doc,
                                docId: doc.id ? doc.id.toString() : null,
                                docSize: docSize,
                                isVideo: isVideo,
                                duration: duration,
                                fileName: fnAttr?.fileName || null,
                                error: docSize === 0 ? 'Documento com 0 bytes' : 'Documento não é formato de vídeo'
                            });
                        } else {
                            resultMap.set(requestedId, {
                                status: 'FOUND',
                                message: msg,
                                doc: doc,
                                docId: doc.id ? doc.id.toString() : null,
                                docSize: docSize,
                                isVideo: true,
                                duration: duration,
                                fileName: fnAttr?.fileName || null,
                                error: null
                            });
                        }
                    } else {
                        resultMap.set(requestedId, {
                            status: 'NOT_FOUND',
                            message: msg,
                            doc: null,
                            docId: null,
                            docSize: 0,
                            isVideo: false,
                            duration: 0,
                            fileName: null,
                            error: 'Mensagem sem documento de mídia'
                        });
                    }
                }
            } catch (err) {
                console.warn(`⚠️ Erro ao consultar lote de mensagens no Telegram (${batch.join(',')}):`, err.message);
                for (const requestedId of batch) {
                    resultMap.set(requestedId, {
                        status: 'ERROR',
                        message: null,
                        doc: null,
                        docId: null,
                        docSize: 0,
                        isVideo: false,
                        duration: 0,
                        fileName: null,
                        error: err.message
                    });
                }
            }
        }

        return resultMap;
    }

    async getStorageMessage(messageId) {
        const id = Number(messageId);
        if (isNaN(id) || id <= 0) return { status: 'NOT_FOUND', message: null, doc: null, error: 'ID inválido' };
        const map = await this.getStorageMessages([id]);
        return map.get(id) || { status: 'NOT_FOUND', message: null, doc: null, error: 'Não encontrado' };
    }

    async forwardStorageMessage(targetChatId, messageId, caption = null) {
        try {
            const client = await this.getClient();
            await client.forwardMessages(targetChatId, {
                messages: [Number(messageId)],
                fromPeer: this.storageGroupId,
                dropAuthor: true
            });
            console.log(`🚀 [MTProto] Vídeo (MessageId ${messageId}) entregue com sucesso para o usuário ${targetChatId}!`);
            return true;
        } catch (error) {
            console.error(`❌ Erro ao encaminhar vídeo via MTProto (MessageId ${messageId}):`, error.message);
            return false;
        }
    }

    async deleteStorageMessages(messageIds) {
        if (!messageIds) return false;
        const ids = [...new Set((Array.isArray(messageIds) ? messageIds : [messageIds])
            .map(id => Number(id))
            .filter(id => !isNaN(id) && id > 0))];

        if (ids.length === 0) return false;

        try {
            const client = await this.getClient();
            await client.deleteMessages(this.storageGroupId, ids, { revoke: true });
            console.log(`🗑️ [Storage Group] ${ids.length} mensagem(ns) excluída(s) permanentemente do grupo de armazém:`, ids);
            return true;
        } catch (error) {
            console.warn(`⚠️ Aviso ao excluir mensagens ${ids.join(', ')} do storage:`, error.message);
            return false;
        }
    }

    async uploadVideo(filePath, metadata = {}, onProgress = null) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Arquivo de vídeo não encontrado: ${filePath}`);
        }

        console.log(`📤 Preparando upload para o canal de armazenamento: ${filePath}...`);

        let videoInfo = { width: 1920, height: 1080, duration: 0 };
        try {
            videoInfo = await VideoProcessor.getVideoInfo(filePath);
        } catch (e) {
            console.warn('⚠️ Não foi possível obter info com ffprobe, usando padrão:', e.message);
        }

        const thumbPath = path.join(path.dirname(filePath), `thumb_${Date.now()}.jpg`);
        let hasThumb = false;
        try {
            await VideoProcessor.generateThumbnail(filePath, thumbPath);
            hasThumb = fs.existsSync(thumbPath);
        } catch (e) {
            console.warn('⚠️ Thumbnail não gerada:', e.message);
        }

        const nome = metadata.nome || path.basename(filePath);
        const ano = metadata.ano ? ` (${metadata.ano})` : '';
        const genero = metadata.generos ? `\n🎭 *Gêneros:* ${metadata.generos.join(', ')}` : '';
        const nota = metadata.nota ? `\n⭐ *Avaliação:* ${metadata.nota}/10` : '';
        const isCam = metadata.isCam === true;
        const isDub = metadata.isDublado || (metadata.audio && metadata.audio.toLowerCase().includes('dublado'));
        const isLeg = metadata.isLegendado || (metadata.audio && metadata.audio.toLowerCase().includes('legendado'));
        let audioTexto = 'Dublado (Áudio PT-BR)';
        if (isDub && isLeg) audioTexto = 'Dub/Leg (Dublado + Legendado)';
        else if (isLeg) audioTexto = 'Legendado (PT-BR)';
        else if (metadata.audio) audioTexto = metadata.audio;

        const qualidadeBadge = isCam ? '📹 Cinema (CAM/Provisório)' : (metadata.qualidade || '1080p Full HD');

        let headerTitulo = '';
        if (metadata.tipo === 'serie' || metadata.type === 'serie' || metadata.season || metadata.episode) {
            const sNum = metadata.season || 1;
            const eNum = metadata.episode || 1;
            const epNome = metadata.episodioNome && !metadata.episodioNome.startsWith('Episódio') ? ` - ${metadata.episodioNome}` : '';
            headerTitulo = `📺 *${nome}* (T${sNum}E${eNum})${epNome}${ano}`;
        } else {
            headerTitulo = `🎬 *${nome}*${ano}`;
        }

        let caption = `${headerTitulo}\n` +
                      `✨ *Qualidade:* ${qualidadeBadge} | 🔊 *Áudio:* ${audioTexto}` +
                      `${nota}${genero}\n\n`;

        if (isCam) {
            caption += `⚠️ *Aviso:* Este filme está em qualidade de cinema. O robô atualizará automaticamente para 1080p Full HD assim que a versão oficial sair!\n\n`;
        }

        caption += `🍿 *BrasilFlix Oficial*`;

        const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
        console.log(`📤 Enviando vídeo de ${sizeMB} MB via MTProto para o grupo de armazenamento (${this.storageGroupId})...`);

        let lastLogTime = Date.now();
        let uploadStartTime = Date.now();

        try {
            const client = await this.getClient();

            // Determina a etiqueta de áudio resumida
            const audioEtiqueta = (isDub && isLeg) ? 'Dub/Leg' : (isLeg ? '💬 Legendado' : '🔊 Dublado');
            const totalBytes = fs.statSync(filePath).size;
            const formatBytesHelper = (bytes) => {
                const gb = bytes / (1024 * 1024 * 1024);
                if (gb >= 1.0) return `${gb.toFixed(2)} GB`;
                const mb = bytes / (1024 * 1024);
                return `${mb.toFixed(1)} MB`;
            };
            const totalStr = formatBytesHelper(totalBytes);

            // Upload ultrarrápido com pipeline paralelo contínuo
            const inputFile = await this.uploadBigFileFast(client, filePath, (fraction) => {
                const now = Date.now();
                const percent = Math.min(100, (fraction * 100).toFixed(1));
                const elapsedSec = Math.max(1, Math.floor((now - uploadStartTime) / 1000));
                const uploadedBytes = Math.floor(fraction * totalBytes);
                const uploadedStr = formatBytesHelper(uploadedBytes);

                const speedMBs = (uploadedBytes / (1024 * 1024) / elapsedSec).toFixed(2);
                const remainingSec = speedMBs > 0 ? Math.max(0, Math.round((totalBytes - uploadedBytes) / (speedMBs * 1024 * 1024))) : 0;
                
                const elapsedFormatted = VideoProcessor.formatDuration(elapsedSec);
                const remainingFormatted = VideoProcessor.formatDuration(remainingSec);

                // Barra de progresso visual (25 caracteres)
                const barLength = 25;
                const filled = Math.min(barLength, Math.round((fraction) * barLength));
                const empty = Math.max(0, barLength - filled);
                const bar = '█'.repeat(filled) + '░'.repeat(empty);
                const uploadTitle = (metadata.tipo === 'serie' || metadata.type === 'serie' || metadata.season || metadata.episode)
                    ? `${nome} (T${metadata.season || 1}E${metadata.episode || 1})`
                    : nome;

                const logLine = `\x1b[35m📤 [UPLOAD TELEGRAM: "${uploadTitle}"] [${bar}] ${percent}% | ${uploadedStr} / ${totalStr} | ${speedMBs} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ~${remainingFormatted}) | ${audioEtiqueta}\x1b[0m`;

                if (process.stdout.isTTY) {
                    process.stdout.write(`\r${logLine} `);
                } else if (now - lastLogTime >= 3500) {
                    lastLogTime = now;
                    console.log(logLine);
                }
                if (onProgress) {
                    onProgress({ percent: parseFloat(percent), speed: `${speedMBs} MB/s` });
                }
            });

            if (process.stdout.isTTY) process.stdout.write('\n');

            const sentMessage = await client.sendFile(this.storageGroupId, {
                file: inputFile,
                mimeType: 'video/mp4',
                caption: caption,
                parseMode: 'md',
                supportsStreaming: true,
                thumb: hasThumb ? thumbPath : undefined,
                attributes: [
                    new Api.DocumentAttributeVideo({
                        duration: Math.round(videoInfo.duration) || 0,
                        w: videoInfo.width || 1920,
                        h: videoInfo.height || 1080,
                        supportsStreaming: true
                    })
                ]
            });

            if (hasThumb) {
                await fs.remove(thumbPath).catch(() => {});
            }

            const messageId = sentMessage.id;
            const doc = sentMessage.media?.document;
            const fileId = doc ? doc.id.toString() : null;

            // 🛡️ Verificação de Integridade Imediata no Telegram (Zero Mídia Quebrada)
            // Valida o episódio que acabou de subir: se estiver quebrado/nulo, apaga na hora e aborta
            const [checkMsg] = await client.getMessages(this.storageGroupId, { ids: [messageId] });
            if (!checkMsg || !checkMsg.media || !checkMsg.media.document) {
                console.error(`❌ [Upload Inválido] Telegram não indexou a mídia para MessageId ${messageId}. Removendo do storage...`);
                await this.deleteStorageMessages([messageId]).catch(() => {});
                throw new Error(`Upload inválido: Telegram retornou mensagem sem mídia para MessageId ${messageId}`);
            }

            const docAttr = (checkMsg.media.document.attributes || []).find(a => a.className === 'DocumentAttributeVideo');
            const checkedDur = docAttr?.duration || 0;
            const checkedSize = checkMsg.media.document.size;
            const checkedSizeMB = (checkedSize / (1024 * 1024)).toFixed(1);

            if (!checkedSize || checkedSize === 0) {
                console.error(`❌ [Upload Inválido] Mídia com tamanho 0 bytes no Telegram (MessageId: ${messageId}). Removendo do storage...`);
                await this.deleteStorageMessages([messageId]).catch(() => {});
                throw new Error(`Upload corrompido: arquivo com 0 bytes no Telegram para MessageId ${messageId}`);
            }

            console.log(`🛡️ [Integridade Telegram] Vídeo verificado com sucesso no Storage: ${checkedSizeMB} MB, ${checkedDur}s de duração (MessageId: ${messageId}).`);

            return {
                success: true,
                messageId: messageId,
                fileId: fileId,
                fileUniqueId: doc?.accessHash?.toString(),
                fileSize: fs.statSync(filePath).size,
                sentMessage: sentMessage
            };
        } catch (error) {
            if (hasThumb) {
                await fs.remove(thumbPath).catch(() => {});
            }
            console.error('❌ Erro no upload para o Telegram:', error.message);
            throw error;
        }
    }

    async uploadBigFileFast(client, filePath, onProgress = null) {
        const bigInt = require('big-integer');
        const stat = await fs.promises.stat(filePath);
        const size = stat.size;
        const partSize = 512 * 1024; // 512 KB (tamanho ótimo MTProto)
        const partCount = Math.floor((size + partSize - 1) / partSize);
        const fileId = bigInt.randBetween(bigInt(1), bigInt('9223372036854775807'));
        const fileName = path.basename(filePath);

        const fileHandle = await fs.promises.open(filePath, 'r');
        let nextPart = 0;
        let uploadedCount = 0;
        
        // Pool otimizado de sockets TCP: Modo Econômico usa 1 socket com micro-espera para não afogar o upstream residencial
        const isEcoMode = SchedulerService.getActiveMode() === 'eco';
        const maxSockets = isEcoMode ? (config.ECO_TELEGRAM_SOCKETS || 1) : (config.TELEGRAM_UPLOAD_MAX_SOCKETS || 4);
        const poolSize = Math.min(maxSockets, Math.max(1, Math.ceil(partCount / 25)));
        const senders = [];
        const dcId = client.session.dcId;

        console.log(`\x1b[35m🔌 [QoS Upload MTProto] Modo ${isEcoMode ? '🍃 ECONÔMICO (1 canal TCP com controle de fluxo)' : '⚡ DESEMPENHO (' + poolSize + ' canais TCP)'} (DC${dcId})...\x1b[0m`);
        for (let i = 0; i < poolSize; i++) {
            try {
                const sender = client._createExportedSender(dcId);
                await client._connectSender(sender, dcId);
                senders.push(sender);
            } catch (err) {
                console.warn(`⚠️ Não foi possível abrir canal TCP extra ${i + 1}: ${err.message}`);
                break;
            }
        }

        if (senders.length === 0) {
            const fallback = await client.getSender(dcId);
            senders.push(fallback);
        }

        console.log(`\x1b[35m🚀 ${senders.length} canal(is) TCP ativado(s) para upload MTProto!\x1b[0m`);

        const totalWorkers = senders.length;

        try {
            const worker = async (workerIndex) => {
                const sender = senders[workerIndex % senders.length];

                while (true) {
                    const currentPart = nextPart++;
                    if (currentPart >= partCount) break;

                    const offset = currentPart * partSize;
                    const length = Math.min(partSize, size - offset);
                    const buffer = Buffer.alloc(length);
                    await fileHandle.read(buffer, 0, length, offset);

                    let attempts = 0;
                    while (true) {
                        try {
                            await sender.send(new Api.upload.SaveBigFilePart({
                                fileId: fileId,
                                filePart: currentPart,
                                fileTotalParts: partCount,
                                bytes: buffer
                            }));
                            break;
                        } catch (err) {
                            attempts++;
                            if (attempts > 5) throw err;
                            await new Promise(r => setTimeout(r, 600 * attempts));
                        }
                    }

                    uploadedCount++;
                    if (onProgress) {
                        onProgress(uploadedCount / partCount);
                    }

                    // No modo econômico, insere um delay cooperativo de 60ms entre pacotes de 512KB para evitar saturação do buffer upstream
                    if (isEcoMode) {
                        await new Promise(r => setTimeout(r, 60));
                    } else {
                        await new Promise(r => setImmediate(r));
                    }
                }
            };


            await Promise.all(Array.from({ length: totalWorkers }, (_, idx) => worker(idx)));
        } finally {
            await fileHandle.close().catch(() => {});
            // Desconectar os senders auxiliares para liberar sockets imediatamente
            for (const sender of senders) {
                try {
                    await sender.disconnect();
                } catch (e) {}
            }
        }


        return new Api.InputFileBig({
            id: fileId,
            parts: partCount,
            name: fileName
        });
    }

    /**
     * Varre todos os registros de mídia do catálogo no Telegram utilizando o helper centralizado
     * e retorna um relatório completo de integridade (válidos, ausentes, corrompidos, divergências de fileId, duplicados e unverified).
     */
    async verifyCatalogIntegrity(catalogo) {
        let itemsList = Array.isArray(catalogo) ? catalogo : [];

        if (!Array.isArray(catalogo) && catalogo) {
            // 1. Filmes
            for (const filme of (catalogo.filmes || [])) {
                if (filme.versoes?.dublado?.messageId || filme.versoes?.dublado?.fileId) {
                    itemsList.push({
                        tipo: 'filme',
                        id: filme.id,
                        nome: filme.nome,
                        versao: 'dublado',
                        messageId: filme.versoes.dublado.messageId ? Number(filme.versoes.dublado.messageId) : null,
                        fileId: filme.versoes.dublado.fileId || null,
                        ano: filme.ano,
                        tmdbId: filme.tmdbId
                    });
                }
                if (filme.versoes?.legendado?.messageId || filme.versoes?.legendado?.fileId) {
                    itemsList.push({
                        tipo: 'filme',
                        id: filme.id,
                        nome: filme.nome,
                        versao: 'legendado',
                        messageId: filme.versoes.legendado.messageId ? Number(filme.versoes.legendado.messageId) : null,
                        fileId: filme.versoes.legendado.fileId || null,
                        ano: filme.ano,
                        tmdbId: filme.tmdbId
                    });
                }
                if (!filme.versoes?.dublado && !filme.versoes?.legendado && (filme.messageId || filme.fileId)) {
                    itemsList.push({
                        tipo: 'filme',
                        id: filme.id,
                        nome: filme.nome,
                        versao: filme.is_dublado ? 'dublado' : (filme.is_legendado ? 'legendado' : 'principal'),
                        messageId: filme.messageId ? Number(filme.messageId) : null,
                        fileId: filme.fileId || null,
                        ano: filme.ano,
                        tmdbId: filme.tmdbId
                    });
                }
            }

            // 2. Séries e Episódios
            for (const serie of (catalogo.series || [])) {
                for (const temp of (serie.temporadas || [])) {
                    for (const ep of (temp.episodios || [])) {
                        const epTitulo = `${serie.nome} T${temp.numero}E${ep.numero} (${ep.nome || ''})`;
                        if (ep.versoes?.dublado?.messageId || ep.versoes?.dublado?.fileId) {
                            itemsList.push({
                                tipo: 'serie',
                                id: serie.id,
                                epId: ep.id,
                                nome: epTitulo,
                                season: temp.numero,
                                episode: ep.numero,
                                versao: 'dublado',
                                messageId: ep.versoes.dublado.messageId ? Number(ep.versoes.dublado.messageId) : null,
                                fileId: ep.versoes.dublado.fileId || null,
                                tmdbId: serie.tmdbId
                            });
                        }
                        if (ep.versoes?.legendado?.messageId || ep.versoes?.legendado?.fileId) {
                            itemsList.push({
                                tipo: 'serie',
                                id: serie.id,
                                epId: ep.id,
                                nome: epTitulo,
                                season: temp.numero,
                                episode: ep.numero,
                                versao: 'legendado',
                                messageId: ep.versoes.legendado.messageId ? Number(ep.versoes.legendado.messageId) : null,
                                fileId: ep.versoes.legendado.fileId || null,
                                tmdbId: serie.tmdbId
                            });
                        }
                        if (!ep.versoes?.dublado && !ep.versoes?.legendado && (ep.messageId || ep.fileId)) {
                            itemsList.push({
                                tipo: 'serie',
                                id: serie.id,
                                epId: ep.id,
                                nome: epTitulo,
                                season: temp.numero,
                                episode: ep.numero,
                                versao: ep.is_dublado ? 'dublado' : (ep.is_legendado ? 'legendado' : 'principal'),
                                messageId: ep.messageId ? Number(ep.messageId) : null,
                                fileId: ep.fileId || null,
                                tmdbId: serie.tmdbId
                            });
                        }
                    }
                }
            }
        }

        // 3. Detecção de Duplicatas ANTES da deduplicação de chamadas
        const msgIdToItems = new Map();
        const fileIdToItems = new Map();
        const duplicateReferences = [];

        for (const item of itemsList) {
            if (item.messageId && !isNaN(item.messageId) && Number(item.messageId) > 0) {
                const mid = Number(item.messageId);
                if (!msgIdToItems.has(mid)) msgIdToItems.set(mid, []);
                msgIdToItems.get(mid).push(item);
            }
            if (item.fileId && typeof item.fileId === 'string' && item.fileId.trim().length > 0) {
                const fid = item.fileId.trim();
                if (!fileIdToItems.has(fid)) fileIdToItems.set(fid, []);
                fileIdToItems.get(fid).push(item);
            }
        }

        for (const [mid, list] of msgIdToItems.entries()) {
            if (list.length > 1) {
                duplicateReferences.push({
                    type: 'DUPLICATE_MESSAGE_ID',
                    identifier: mid,
                    count: list.length,
                    items: list
                });
            }
        }

        for (const [fid, list] of fileIdToItems.entries()) {
            if (list.length > 1) {
                duplicateReferences.push({
                    type: 'DUPLICATE_FILE_ID',
                    identifier: fid,
                    count: list.length,
                    items: list
                });
            }
        }

        // 4. Executa consulta em lote usando o helper centralizado
        const allMsgIds = Array.from(msgIdToItems.keys());
        const tgResults = await this.getStorageMessages(allMsgIds);

        const results = {
            total: itemsList.length,
            totalUniqueMessageIds: allMsgIds.length,
            validos: [],
            ausentes: [],
            corrompidos: [],
            fileIdMismatches: [],
            duplicates: duplicateReferences,
            unverified: []
        };

        for (const item of itemsList) {
            if (!item.messageId || isNaN(item.messageId) || Number(item.messageId) <= 0) {
                if (item.fileId && typeof item.fileId === 'string' && item.fileId.trim().length > 0) {
                    results.unverified.push({ ...item, motivo: 'Mídia apenas com fileId (sem messageId para verificação direta no Telegram)' });
                } else {
                    results.ausentes.push({ ...item, motivo: 'Sem messageId e sem fileId' });
                }
                continue;
            }

            const mid = Number(item.messageId);
            const tgInfo = tgResults.get(mid);

            if (!tgInfo) {
                results.unverified.push({ ...item, motivo: 'Não consultado' });
            } else if (tgInfo.status === 'ERROR') {
                results.unverified.push({ ...item, erro: tgInfo.error });
            } else if (tgInfo.status === 'NOT_FOUND') {
                results.ausentes.push({ ...item, motivo: 'Mensagem deletada ou inexistente no Telegram' });
            } else if (tgInfo.status === 'INVALID_MEDIA') {
                results.corrompidos.push({ ...item, motivo: tgInfo.error });
            } else if (tgInfo.status === 'FOUND') {
                // Checa se há divergência de fileId com o documentId real do Telegram
                if (item.fileId && typeof item.fileId === 'string' && item.fileId.trim().length > 0) {
                    const storedFid = item.fileId.trim();
                    if (tgInfo.docId && tgInfo.docId !== storedFid) {
                        results.fileIdMismatches.push({
                            ...item,
                            storedFileId: storedFid,
                            actualDocId: tgInfo.docId,
                            motivo: 'fileId no banco difere do documentId real do Telegram'
                        });
                        continue; // Mídia com divergência de fileId NÃO é classificada como válida
                    }
                }

                results.validos.push({
                    ...item,
                    docId: tgInfo.docId,
                    sizeMB: (tgInfo.docSize / (1024 * 1024)).toFixed(1),
                    durationSec: tgInfo.duration,
                    fileName: tgInfo.fileName
                });
            }
        }

        return results;
    }

    /**
     * Realiza a auditoria direta e completa das tabelas brutas do PostgreSQL (filmes, episodios, series)
     * contra o Armazém do Telegram, sem depender de normalização do catálogo em memória.
     * Identifica:
     * - Mídias válidas vs ausentes/corrompidas no Telegram;
     * - Divergências de fileId vs docId do Telegram (excluídas de válidas);
     * - Duplicatas de messageId e fileId no banco;
     * - Registros com flags inconsistentes/órfãos;
     * - Episódios duplicados por (serie_id, temporada_numero, numero);
     * - Divergências entre message_id primário e versoes.
     */
    async verifyDatabaseIntegrity(db) {
        if (!db || typeof db.query !== 'function') {
            throw new Error('Instância válida do banco de dados (db) é obrigatória para a auditoria direta.');
        }

        const filmesRes = await db.query('SELECT * FROM filmes ORDER BY id ASC');
        const seriesRes = await db.query('SELECT * FROM series ORDER BY id ASC');
        const epsRes = await db.query('SELECT * FROM episodios ORDER BY serie_id ASC, temporada_numero ASC, numero ASC');

        const seriesMap = new Map();
        for (const s of seriesRes.rows) {
            seriesMap.set(Number(s.id), s);
        }

        const rawMediaReferences = [];
        const anomalousDbRecords = {
            staleFlags: [],
            orphanedEpisodes: [],
            duplicateEpisodes: [],
            conflictingPrimaryIds: [],
            malformedJson: []
        };

        // 1. Audita tabela de Filmes
        for (const f of filmesRes.rows) {
            let versoes = f.versoes || {};
            if (typeof versoes === 'string') {
                try {
                    versoes = JSON.parse(versoes);
                } catch (e) {
                    anomalousDbRecords.malformedJson.push({ tabela: 'filmes', id: f.id, nome: f.nome, erro: e.message });
                    versoes = {};
                }
            }

            const dubMsgId = versoes.dublado?.messageId ? Number(versoes.dublado.messageId) : null;
            const legMsgId = versoes.legendado?.messageId ? Number(versoes.legendado.messageId) : null;
            const primaryMsgId = f.message_id ? Number(f.message_id) : null;

            if (primaryMsgId && dubMsgId && legMsgId && primaryMsgId !== dubMsgId && primaryMsgId !== legMsgId) {
                anomalousDbRecords.conflictingPrimaryIds.push({
                    tabela: 'filmes',
                    id: f.id,
                    nome: f.nome,
                    primaryMsgId,
                    dubMsgId,
                    legMsgId
                });
            }

            if (f.is_dublado && !versoes.dublado && !f.message_id && !f.file_id) {
                anomalousDbRecords.staleFlags.push({ tabela: 'filmes', id: f.id, nome: f.nome, flag: 'is_dublado sem mídia' });
            }
            if (f.is_legendado && !versoes.legendado && !f.message_id && !f.file_id) {
                anomalousDbRecords.staleFlags.push({ tabela: 'filmes', id: f.id, nome: f.nome, flag: 'is_legendado sem mídia' });
            }

            if (versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId)) {
                rawMediaReferences.push({
                    origem: 'filmes',
                    id: f.id,
                    nome: f.nome,
                    versao: 'dublado',
                    messageId: versoes.dublado.messageId ? Number(versoes.dublado.messageId) : null,
                    fileId: versoes.dublado.fileId || null,
                    tmdbId: f.tmdb_id
                });
            }
            if (versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId)) {
                rawMediaReferences.push({
                    origem: 'filmes',
                    id: f.id,
                    nome: f.nome,
                    versao: 'legendado',
                    messageId: versoes.legendado.messageId ? Number(versoes.legendado.messageId) : null,
                    fileId: versoes.legendado.fileId || null,
                    tmdbId: f.tmdb_id
                });
            }
            if (!versoes.dublado && !versoes.legendado && (f.message_id || f.file_id)) {
                rawMediaReferences.push({
                    origem: 'filmes',
                    id: f.id,
                    nome: f.nome,
                    versao: f.is_dublado ? 'dublado' : (f.is_legendado ? 'legendado' : 'principal'),
                    messageId: f.message_id ? Number(f.message_id) : null,
                    fileId: f.file_id || null,
                    tmdbId: f.tmdb_id
                });
            }
        }

        // 2. Audita tabela de Episódios
        const epUniqueKeys = new Map();
        for (const ep of epsRes.rows) {
            const epKey = `${ep.serie_id}_s${ep.temporada_numero}_e${ep.numero}`;
            if (!epUniqueKeys.has(epKey)) {
                epUniqueKeys.set(epKey, []);
            }
            epUniqueKeys.get(epKey).push(ep.id);

            const serie = seriesMap.get(Number(ep.serie_id));
            if (!serie) {
                anomalousDbRecords.orphanedEpisodes.push({ epId: ep.id, serieId: ep.serie_id, epNome: ep.nome });
            }

            let versoes = ep.versoes || {};
            if (typeof versoes === 'string') {
                try {
                    versoes = JSON.parse(versoes);
                } catch (e) {
                    anomalousDbRecords.malformedJson.push({ tabela: 'episodios', id: ep.id, nome: ep.nome, erro: e.message });
                    versoes = {};
                }
            }

            const serieNome = serie ? serie.nome : `Série #${ep.serie_id}`;
            const epTitulo = `${serieNome} T${ep.temporada_numero}E${ep.numero} (${ep.nome || ''})`;

            if (ep.is_dublado && !versoes.dublado && !ep.message_id && !ep.file_id) {
                anomalousDbRecords.staleFlags.push({ tabela: 'episodios', id: ep.id, nome: epTitulo, flag: 'is_dublado sem mídia' });
            }
            if (ep.is_legendado && !versoes.legendado && !ep.message_id && !ep.file_id) {
                anomalousDbRecords.staleFlags.push({ tabela: 'episodios', id: ep.id, nome: epTitulo, flag: 'is_legendado sem mídia' });
            }

            if (versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId)) {
                rawMediaReferences.push({
                    origem: 'episodios',
                    id: ep.id,
                    serieId: ep.serie_id,
                    nome: epTitulo,
                    season: ep.temporada_numero,
                    episode: ep.numero,
                    versao: 'dublado',
                    messageId: versoes.dublado.messageId ? Number(versoes.dublado.messageId) : null,
                    fileId: versoes.dublado.fileId || null,
                    tmdbId: serie?.tmdb_id
                });
            }
            if (versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId)) {
                rawMediaReferences.push({
                    origem: 'episodios',
                    id: ep.id,
                    serieId: ep.serie_id,
                    nome: epTitulo,
                    season: ep.temporada_numero,
                    episode: ep.numero,
                    versao: 'legendado',
                    messageId: versoes.legendado.messageId ? Number(versoes.legendado.messageId) : null,
                    fileId: versoes.legendado.fileId || null,
                    tmdbId: serie?.tmdb_id
                });
            }
            if (!versoes.dublado && !versoes.legendado && (ep.message_id || ep.file_id)) {
                rawMediaReferences.push({
                    origem: 'episodios',
                    id: ep.id,
                    serieId: ep.serie_id,
                    nome: epTitulo,
                    season: ep.temporada_numero,
                    episode: ep.numero,
                    versao: ep.is_dublado ? 'dublado' : (ep.is_legendado ? 'legendado' : 'principal'),
                    messageId: ep.message_id ? Number(ep.message_id) : null,
                    fileId: ep.file_id || null,
                    tmdbId: serie?.tmdb_id
                });
            }
        }

        for (const [key, ids] of epUniqueKeys.entries()) {
            if (ids.length > 1) {
                anomalousDbRecords.duplicateEpisodes.push({ key, ids, count: ids.length });
            }
        }

        // Executa a auditoria das referências de mídia no Telegram
        const telegramAudit = await this.verifyCatalogIntegrity(rawMediaReferences);

        return {
            databaseTotals: {
                totalFilmes: filmesRes.rows.length,
                totalSeries: seriesRes.rows.length,
                totalEpisodios: epsRes.rows.length,
                totalMediaReferences: rawMediaReferences.length
            },
            telegramAudit,
            anomalousDbRecords
        };
    }
}

module.exports = TelegramUploader;
