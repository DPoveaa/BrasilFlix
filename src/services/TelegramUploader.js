const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const VideoProcessor = require('./VideoProcessor');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

class TelegramUploader {
    constructor(bot) {
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
                connectionRetries: 5,
                useIPv6: false
            });

            console.log('🔌 Conectando ao Telegram MTProto (suporte a uploads de até 4GB Premium)...');
            if (config.TELEGRAM_SESSION && config.TELEGRAM_SESSION.trim() !== '') {
                await client.connect();
                console.log('✅ Cliente MTProto autenticado via Sessão Premium (Uploads de até 4GB desbloqueados)!');
            } else {
                await client.start({
                    botAuthToken: config.BOT_TOKEN
                });
                console.log('✅ Cliente MTProto autenticado via Bot Token!');
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
        const ids = (Array.isArray(messageIds) ? messageIds : [messageIds])
            .map(id => Number(id))
            .filter(id => !isNaN(id) && id > 0);

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
        const qualidadeBadge = isCam ? '📹 Versão Cinema (Provisória)' : (metadata.qualidade || '1080p Full HD');
        const audio = metadata.audio || 'Dublado';

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
                      `✨ *Qualidade:* ${qualidadeBadge} | 🔊 *Áudio:* ${audio}` +
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
            const audioEtiqueta = metadata.isLegendado || (audio && audio.toLowerCase().includes('legendado')) ? 'Legendado' : 'Dublado';
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
                const percent = Math.min(100, Math.max(0, fraction * 100)).toFixed(1);
                const elapsedSec = Math.max(1, (now - uploadStartTime) / 1000);
                const uploadedBytes = totalBytes * fraction;
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

                const logLine = `\x1b[35m📤 [UPLOAD TELEGRAM: "${uploadTitle}"] [${bar}] ${percent}% | ${uploadedStr} / ${totalStr} | ${speedMBs} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ~${remainingFormatted}) | 🔊 ${audioEtiqueta}\x1b[0m`;

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

            console.log(`✅ Vídeo enviado com sucesso ao Storage! MessageId: ${messageId}, FileId: ${fileId}...`);

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
        
        // Criar pool de 8 conexões de socket TCP independentes para superar o limite de 1.6 MB/s por socket
        const poolSize = Math.min(8, Math.max(2, Math.ceil(partCount / 10)));
        const senders = [];
        const dcId = client.session.dcId;

        console.log(`\x1b[35m🔌 Abrindo ${poolSize} conexões de rede TCP paralelas com os servidores do Telegram (DC${dcId})...\x1b[0m`);
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

        console.log(`\x1b[35m🚀 ${senders.length} canais TCP paralelos ativados para velocidade máxima de upload!\x1b[0m`);

        const totalWorkers = Math.min(senders.length * 2, partCount);

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
                }
            };

            await Promise.all(Array.from({ length: totalWorkers }, (_, idx) => worker(idx)));
        } finally {
            await fileHandle.close().catch(() => {});
            // Desconectar os senders auxiliares para liberar sockets
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
}

module.exports = TelegramUploader;
