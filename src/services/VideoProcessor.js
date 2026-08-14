const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');

class VideoProcessor {
    constructor() {
        this.maxSizeBytes = config.VIDEO_MAX_SIZE_BYTES || (2 * 1024 * 1024 * 1024); // 2GB
    }

    async getVideoInfo(filePath) {
        return new Promise((resolve, reject) => {
            const cmd = `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`;
            exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
                if (error) {
                    return reject(new Error(`Erro ao obter informações do vídeo: ${error.message}`));
                }
                try {
                    const info = JSON.parse(stdout);
                    const videoStream = (info.streams || []).find(s => s.codec_type === 'video') || {};
                    const audioStreams = (info.streams || []).filter(s => s.codec_type === 'audio');
                    const subtitleStreams = (info.streams || []).filter(s => s.codec_type === 'subtitle');
                    const format = info.format || {};

                    const width = parseInt(videoStream.width || 0, 10);
                    const height = parseInt(videoStream.height || 0, 10);
                    const duration = parseFloat(format.duration || videoStream.duration || 0);
                    const sizeBytes = parseInt(format.size || 0, 10);

                    resolve({
                        width,
                        height,
                        resolution: `${width}x${height}`,
                        is1080p: height >= 1080 || width >= 1920,
                        duration,
                        durationFormatted: this.formatDuration(duration),
                        sizeBytes,
                        sizeMB: (sizeBytes / (1024 * 1024)).toFixed(2),
                        videoCodec: videoStream.codec_name,
                        audioStreams: audioStreams.map(a => ({
                            codec: a.codec_name,
                            language: a.tags?.language || 'und',
                            title: a.tags?.title || ''
                        })),
                        subtitleStreams: subtitleStreams.map(s => ({
                            codec: s.codec_name,
                            language: s.tags?.language || 'und',
                            title: s.tags?.title || ''
                        }))
                    });
                } catch (e) {
                    reject(new Error(`Falha ao decodificar JSON do ffprobe: ${e.message}`));
                }
            });
        });
    }

    hasPortugueseAudio(info, rawFileName = '') {
        const lowerName = (rawFileName || '').toLowerCase();
        
        if (!info.audioStreams || info.audioStreams.length === 0) {
            return false;
        }

        const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
        const hasPtStream = info.audioStreams.some(a => {
            const lang = (a.language || '').toLowerCase();
            const title = (a.title || '').toLowerCase();
            return ptLanguages.includes(lang) || title.includes('portug') || title.includes('dublado') || title.includes('pt-br');
        });

        // 1. Se tem faixa comprovada em Português nas tags do áudio
        if (hasPtStream) return true;

        // 2. Se as faixas têm tag de idioma e são declaradamente estrangeiras (ex: eng, spa, hin, fre)
        const hasForeignTags = info.audioStreams.some(a => {
            const lang = (a.language || '').toLowerCase();
            return ['eng', 'hin', 'tam', 'tel', 'fra', 'fre', 'spa', 'deu', 'ger', 'ita', 'rus', 'jpn', 'kor', 'zho', 'chi'].includes(lang);
        });

        if (hasForeignTags) {
            return false; // Rejeita releases com áudio em inglês/estrangeiro mesmo que tenham legenda PT
        }

        // 3. Se as faixas de áudio não possuem metadados de idioma (streams anônimos), verifica o selo brasileiro no nome do arquivo
        const isBrGroup = /yg⭐|dual[._ -]?yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|mostbet|1xbet|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(lowerName);
        const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);

        if (isExplicitDublado || isBrGroup) {
            return true;
        }

        return false;
    }

    async generateThumbnail(videoPath, outputThumbPath, timestamp = '00:01:30') {
        await fs.ensureDir(path.dirname(outputThumbPath));
        return new Promise((resolve, reject) => {
            const args = [
                '-ss', timestamp,
                '-i', videoPath,
                '-vframes', '1',
                '-q:v', '2',
                '-vf', "scale='min(640,iw)':-2",
                '-y',
                outputThumbPath
            ];

            const ffmpeg = spawn('ffmpeg', args);
            ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputThumbPath)) {
                    resolve(outputThumbPath);
                } else {
                    // Tenta no segundo 5 se falhar no 1:30 (ex: vídeo curto)
                    const fallbackArgs = ['-ss', '00:00:05', '-i', videoPath, '-vframes', '1', '-q:v', '2', '-y', outputThumbPath];
                    const fallback = spawn('ffmpeg', fallbackArgs);
                    fallback.on('close', (fCode) => {
                        if (fCode === 0 && fs.existsSync(outputThumbPath)) {
                            resolve(outputThumbPath);
                        } else {
                            reject(new Error(`Falha ao gerar thumbnail: código ${fCode}`));
                        }
                    });
                }
            });
            ffmpeg.on('error', reject);
        });
    }

    async optimizeForTelegram(inputPath, outputPath, onProgress = null) {
        await fs.ensureDir(path.dirname(outputPath));
        const info = await this.getVideoInfo(inputPath);

        // Se já for MP4 H.264/H.265 com áudio compatível e menor que 2GB, pode copiar rápido
        const ext = path.extname(inputPath).toLowerCase();
        const isCompatibleFormat = ext === '.mp4';
        const isUnderSizeLimit = info.sizeBytes <= this.maxSizeBytes;
        const isFastCodec = info.videoCodec === 'h264';

        if (isCompatibleFormat && isUnderSizeLimit && isFastCodec) {
            console.log(`⚡ Vídeo já está no formato ideal para Telegram (${info.sizeMB} MB). Remux rápido...`);
            return new Promise((resolve, reject) => {
                const args = ['-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath];
                const ffmpeg = spawn('ffmpeg', args);
                ffmpeg.on('close', (code) => {
                    if (code === 0) resolve(outputPath);
                    else reject(new Error(`Erro no remux: código ${code}`));
                });
                ffmpeg.on('error', reject);
            });
        }

        // Detectar qual faixa de áudio é em Português
        let portugueseAudioIndex = null;
        if (info.audioStreams && info.audioStreams.length > 0) {
            for (let i = 0; i < info.audioStreams.length; i++) {
                const a = info.audioStreams[i];
                const lang = (a.language || '').toLowerCase();
                const title = (a.title || '').toLowerCase();
                if (['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'].includes(lang) ||
                    title.includes('portug') || title.includes('dublado') || title.includes('pt-br')) {
                    portugueseAudioIndex = i;
                    break;
                }
            }
        }

        console.log(`🎬 Otimizando vídeo para 1080p Telegram (Codec: H.264, Preset: fast, CRF: 22)...`);
        if (portugueseAudioIndex !== null) {
            console.log(`🔊 Faixa de áudio em Português identificada (Stream 0:a:${portugueseAudioIndex}). Configurada como ÁUDIO PADRÃO!`);
        }

        return new Promise((resolve, reject) => {
            const totalDuration = info.duration || 1;
            const args = [
                '-i', inputPath,
                '-vf', "scale='min(1920,iw)':-2", // Mantém 1080p nítido sem esticar
                '-c:v', 'libx264',
                '-preset', 'fast',
                '-crf', '22', // Excelente equilíbrio entre nitidez 1080p e tamanho reduzido
                '-c:a', 'aac',
                '-b:a', '192k'
            ];

            // Se encontrou a faixa específica em português no Multi-Áudio, mapeia ela como áudio padrão
            if (portugueseAudioIndex !== null) {
                args.push('-map', '0:v:0', '-map', `0:a:${portugueseAudioIndex}`, '-disposition:a:0', 'default');
            }

            args.push('-movflags', '+faststart', '-y', outputPath);

            const ffmpeg = spawn('ffmpeg', args);

            let lastLogTime = Date.now();

            ffmpeg.stderr.on('data', (data) => {
                const text = data.toString();
                const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                if (timeMatch) {
                    const hours = parseFloat(timeMatch[1]);
                    const minutes = parseFloat(timeMatch[2]);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentTime = (hours * 3600) + (minutes * 60) + seconds;
                    const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));

                    const now = Date.now();
                    if (now - lastLogTime > 700) { // Atualiza a cada 700ms
                        lastLogTime = now;
                        const barLength = 25;
                        const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                        const empty = Math.max(0, barLength - filled);
                        const bar = '█'.repeat(filled) + '░'.repeat(empty);

                        process.stdout.write(`\r🎬 Otimizando 1080p: [${bar}] ${percent}% | ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)} `);
                    }

                    if (onProgress) onProgress(percent);
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    process.stdout.write('\n');
                    console.log(`✅ Otimização 1080p concluída com sucesso!`);
                    if (onProgress) onProgress(100);
                    resolve(outputPath);
                } else {
                    process.stdout.write('\n');
                    reject(new Error(`Erro na transcodificação do vídeo: código ${code}`));
                }
            });

            ffmpeg.on('error', reject);
        });
    }

    formatDuration(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);
        if (hrs > 0) {
            return `${hrs}h ${mins.toString().padStart(2, '0')}m`;
        }
        return `${mins}m ${secs.toString().padStart(2, '0')}s`;
    }
}

module.exports = new VideoProcessor();
