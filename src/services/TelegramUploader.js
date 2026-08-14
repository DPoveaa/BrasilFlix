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
            const sentMessage = await client.sendFile(this.storageGroupId, {
                file: filePath,
                caption: caption,
                parseMode: 'md',
                supportsStreaming: true,
                workers: 8, // 8 conexões simultâneas em paralelo (velocidade máxima MTProto)
                thumb: hasThumb ? thumbPath : undefined,
                attributes: [
                    new Api.DocumentAttributeVideo({
                        duration: Math.round(videoInfo.duration) || 0,
                        w: videoInfo.width || 1920,
                        h: videoInfo.height || 1080,
                        supportsStreaming: true
                    })
                ],
                progressCallback: (fraction) => {
                    const now = Date.now();
                    const percent = (fraction * 100).toFixed(1);
                    const elapsedSec = Math.max(1, (now - uploadStartTime) / 1000);
                    const uploadedMB = (parseFloat(sizeMB) * fraction).toFixed(1);
                    const speedMbs = (uploadedMB / elapsedSec).toFixed(2);
                    const remainingSec = speedMbs > 0 ? Math.max(0, Math.round((parseFloat(sizeMB) - uploadedMB) / speedMbs)) : 0;
                    const remainingFormatted = VideoProcessor.formatDuration(remainingSec);

                    if (process.stdout.isTTY) {
                        process.stdout.write(`\r📤 [Upload Telegram] ${percent}% (${uploadedMB}/${sizeMB} MB) | ${speedMbs} MB/s | ⏳ Restante: ~${remainingFormatted} `);
                    } else if (now - lastLogTime >= 4000) {
                        lastLogTime = now;
                        console.log(`📤 [Upload Telegram] ${percent}% de ${sizeMB} MB enviado | ${speedMbs} MB/s | ⏳ Restante: ~${remainingFormatted}`);
                    }
                    if (onProgress) {
                        onProgress({ percent: parseFloat(percent), speed: `${speedMbs} MB/s` });
                    }
                }
            });

            if (process.stdout.isTTY) process.stdout.write('\n');

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
}

module.exports = TelegramUploader;
