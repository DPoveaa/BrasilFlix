const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const VideoProcessor = require('./VideoProcessor');

class TelegramUploader {
    constructor(bot) {
        this.bot = bot;
        this.storageGroupId = config.STORAGE_GROUP_ID;
    }

    setBot(bot) {
        this.bot = bot;
    }

    async uploadVideo(filePath, metadata = {}, onProgress = null) {
        if (!this.bot) {
            throw new Error('Instância do bot Telegram não configurada no Uploader.');
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`Arquivo de vídeo não encontrado: ${filePath}`);
        }

        console.log(`📤 Preparando upload para o canal de armazenamento: ${filePath}...`);

        // Obter informações do vídeo (largura, altura, duração)
        let videoInfo = { width: 1920, height: 1080, duration: 0 };
        try {
            videoInfo = await VideoProcessor.getVideoInfo(filePath);
        } catch (e) {
            console.warn('⚠️ Não foi possível obter info com ffprobe, usando padrão:', e.message);
        }

        // Gerar thumbnail temporária para o Telegram
        const thumbPath = path.join(path.dirname(filePath), `thumb_${Date.now()}.jpg`);
        let hasThumb = false;
        try {
            await VideoProcessor.generateThumbnail(filePath, thumbPath);
            hasThumb = fs.existsSync(thumbPath);
        } catch (e) {
            console.warn('⚠️ Thumbnail não gerada:', e.message);
        }

        // Montar legenda rica com metadados
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

        try {
            const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
            console.log(`📤 Enviando vídeo de ${sizeMB} MB para o grupo de armazenamento (${this.storageGroupId})... Aguarde o envio...`);

            const sendOptions = {
                caption: caption,
                parse_mode: 'Markdown',
                supports_streaming: true,
                duration: Math.round(videoInfo.duration) || undefined,
                width: videoInfo.width || undefined,
                height: videoInfo.height || undefined
            };

            if (hasThumb) {
                sendOptions.thumb = thumbPath;
            }

            const sentMessage = await this.bot.sendVideo(
                this.storageGroupId,
                filePath,
                sendOptions
            );

            // Limpa thumbnail temporária
            if (hasThumb) {
                await fs.remove(thumbPath).catch(() => {});
            }

            const videoFile = sentMessage.video || sentMessage.document;
            const fileId = videoFile ? videoFile.file_id : null;
            const messageId = sentMessage.message_id;

            console.log(`✅ Vídeo enviado com sucesso ao Storage! MessageId: ${messageId}, FileId: ${fileId?.substring(0, 20)}...`);

            return {
                success: true,
                messageId: messageId,
                fileId: fileId,
                fileUniqueId: videoFile?.file_unique_id,
                fileSize: videoFile?.file_size || videoInfo.sizeBytes,
                sentMessage: sentMessage
            };
        } catch (error) {
            // Limpa thumbnail em caso de erro
            if (hasThumb) {
                await fs.remove(thumbPath).catch(() => {});
            }
            console.error('❌ Erro no upload para o Telegram:', error.message);
            throw error;
        }
    }
}

module.exports = TelegramUploader;
