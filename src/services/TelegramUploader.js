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

        let caption = `🎬 *${nome}*${ano}\n` +
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

                const logLine = `📤 [Upload: "${nome}"] [${bar}] ${percent}% | ${uploadedStr} / ${totalStr} | ${speedMBs} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ~${remainingFormatted}) | 🔊 ${audioEtiqueta}`;

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
        const partSize = 512 * 1024; // 512 KB (padrão ótimo MTProto)
        const partCount = Math.floor((size + partSize - 1) / partSize);
        const fileId = bigInt.randBetween(bigInt(1), bigInt('9223372036854775807'));
        const fileName = path.basename(filePath);

        const fileHandle = await fs.promises.open(filePath, 'r');
        let nextPart = 0;
        let uploadedCount = 0;
        const totalWorkers = Math.min(16, partCount);

        try {
            const worker = async () => {
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
                            const sender = await client.getSender(client.session.dcId);
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
                            await new Promise(r => setTimeout(r, 800 * attempts));
                        }
                    }

                    uploadedCount++;
                    if (onProgress) {
                        onProgress(uploadedCount / partCount);
                    }
                }
            };

            await Promise.all(Array.from({ length: totalWorkers }, () => worker()));
        } finally {
            await fileHandle.close().catch(() => {});
        }

        return new Api.InputFileBig({
            id: fileId,
            parts: partCount,
            name: fileName
        });
    }
}

module.exports = TelegramUploader;
