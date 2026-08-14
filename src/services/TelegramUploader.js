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

            console.log('🔌 Conectando ao Telegram MTProto (suporte a uploads de até 2GB)...');
            await client.start({
                botAuthToken: config.BOT_TOKEN
            });

            this.client = client;
            this.isClientReady = true;
            console.log('✅ Cliente MTProto do Telegram conectado com sucesso para uploads de 2GB!');
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

        try {
            const client = await this.getClient();
            const sentMessage = await client.sendFile(this.storageGroupId, {
                file: filePath,
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
                ],
                progressCallback: (fraction) => {
                    const now = Date.now();
                    const percent = (fraction * 100).toFixed(1);
                    if (process.stdout.isTTY) {
                        process.stdout.write(`\r📤 Enviando para o Telegram: ${percent}%... `);
                    } else if (now - lastLogTime >= 5000) {
                        lastLogTime = now;
                        console.log(`📤 [Upload Telegram] ${percent}% de ${sizeMB} MB enviado...`);
                    }
                    if (onProgress) {
                        onProgress({ percent: parseFloat(percent) });
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
