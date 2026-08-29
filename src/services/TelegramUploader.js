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

                if (savedSession) {
                    try {
                        client.session = new StringSession(savedSession);
                        await client.connect();
                        console.log('✅ Cliente MTProto autenticado via Sessão Salva!');
                    } catch (e) {
                        console.warn('⚠️ Sessão salva expirada/inválida, reconectando via Bot Token...');
                        await client.start({ botAuthToken: config.BOT_TOKEN });
                        try {
                            const sessStr = client.session.save();
                            if (sessStr) fs.writeFileSync(savedSessionFile, sessStr, 'utf8');
                        } catch (e) {}
                        console.log('✅ Cliente MTProto autenticado via Bot Token e sessão renovada!');
                    }
                } else {
                    await client.start({ botAuthToken: config.BOT_TOKEN });
                    try {
                        const sessStr = client.session.save();
                        if (sessStr) fs.writeFileSync(savedSessionFile, sessStr, 'utf8');
                    } catch (e) {}
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
     * Varre todos os messageIds do catálogo no Telegram em lotes (batches de 50)
     * e retorna o relatório completo de integridade (itens válidos vs ausentes/quebrados).
     */
    async verifyCatalogIntegrity(catalogo) {
        const client = await this.getClient();

        // Se foi passado um array direto de items
        let itemsList = Array.isArray(catalogo) ? catalogo : [];

        // Se foi passado o objeto de catálogo { filmes, series }
        if (!Array.isArray(catalogo) && catalogo) {
            // 1. Mapeia todos os messageIds dos filmes
            for (const filme of (catalogo.filmes || [])) {
                if (filme.messageId) {
                    itemsList.push({ tipo: 'filme', id: filme.id, nome: filme.nome, messageId: Number(filme.messageId), fileId: filme.fileId, ano: filme.ano, tmdbId: filme.tmdbId });
                }
                if (filme.versoes?.dublado?.messageId) {
                    itemsList.push({ tipo: 'filme', id: filme.id, nome: filme.nome, messageId: Number(filme.versoes.dublado.messageId), fileId: filme.versoes.dublado.fileId, versao: 'dublado', ano: filme.ano, tmdbId: filme.tmdbId });
                }
                if (filme.versoes?.legendado?.messageId && filme.versoes?.legendado?.messageId !== filme.versoes?.dublado?.messageId) {
                    itemsList.push({ tipo: 'filme', id: filme.id, nome: filme.nome, messageId: Number(filme.versoes.legendado.messageId), fileId: filme.versoes.legendado.fileId, versao: 'legendado', ano: filme.ano, tmdbId: filme.tmdbId });
                }
            }

            // 2. Mapeia todos os messageIds dos episódios de séries
            for (const serie of (catalogo.series || [])) {
                for (const temp of (serie.temporadas || [])) {
                    for (const ep of (temp.episodios || [])) {
                        if (ep.messageId) {
                            itemsList.push({ tipo: 'serie', id: serie.id, nome: serie.nome, season: temp.numero, episode: ep.numero, messageId: Number(ep.messageId), fileId: ep.fileId, tmdbId: serie.tmdbId });
                        }
                        if (ep.versoes?.dublado?.messageId) {
                            itemsList.push({ tipo: 'serie', id: serie.id, nome: serie.nome, season: temp.numero, episode: ep.numero, messageId: Number(ep.versoes.dublado.messageId), fileId: ep.versoes.dublado.fileId, versao: 'dublado', tmdbId: serie.tmdbId });
                        }
                        if (ep.versoes?.legendado?.messageId && ep.versoes?.legendado?.messageId !== ep.versoes?.dublado?.messageId) {
                            itemsList.push({ tipo: 'serie', id: serie.id, nome: serie.nome, season: temp.numero, episode: ep.numero, messageId: Number(ep.versoes.legendado.messageId), fileId: ep.versoes.legendado.fileId, versao: 'legendado', tmdbId: serie.tmdbId });
                        }
                    }
                }
            }
        }

        // Remove duplicados de messageId na lista de checagem
        const uniqueMap = new Map();
        for (const item of itemsList) {
            if (item && item.messageId && !isNaN(item.messageId) && Number(item.messageId) > 0) {
                if (!uniqueMap.has(Number(item.messageId))) uniqueMap.set(Number(item.messageId), item);
            }
        }
        const uniqueItems = Array.from(uniqueMap.values());

        const results = {
            total: uniqueItems.length,
            validos: [],
            ausentes: [],
            corrompidos: [],
            unverified: []
        };

        const batchSize = 100;
        for (let i = 0; i < uniqueItems.length; i += batchSize) {
            const batch = uniqueItems.slice(i, i + batchSize);
            const msgIds = batch.map(b => b.messageId);

            try {
                const resMessages = await client.invoke(new Api.messages.GetMessages({
                    id: msgIds.map(id => new Api.InputMessageID({ id }))
                }));
                const messages = resMessages.messages || [];

                for (let j = 0; j < batch.length; j++) {
                    const item = batch[j];
                    const msg = messages.find(m => m && m.id === item.messageId) || messages[j];

                    if (!msg || msg.className === 'MessageEmpty' || !msg.media || !msg.media.document) {
                        results.ausentes.push(item);
                    } else {
                        const doc = msg.media.document;
                        const docSize = Number(doc.size);
                        const videoAttr = (doc.attributes || []).find(a => a.className === 'DocumentAttributeVideo');
                        const duration = videoAttr?.duration || 0;
                        const sizeMB = (docSize / (1024 * 1024)).toFixed(1);

                        if (docSize === 0) {
                            results.corrompidos.push({ ...item, motivo: 'Tamanho 0 bytes' });
                        } else {
                            const fnAttr = doc.attributes?.find(a => a.fileName);
                            results.validos.push({
                                ...item,
                                docId: doc.id.toString(),
                                sizeMB: parseFloat(sizeMB),
                                durationSec: duration,
                                width: videoAttr?.w,
                                height: videoAttr?.h,
                                fileName: fnAttr?.fileName
                            });
                        }
                    }
                }
            } catch (err) {
                console.error(`⚠️ Erro ao verificar lote de mensagens no Telegram:`, err.message);
                for (const item of batch) {
                    results.unverified.push({ ...item, erro: err.message });
                }
            }
        }

        return results;
    }
}

module.exports = TelegramUploader;
