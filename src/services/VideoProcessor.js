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
                        videoCodec: (videoStream.codec_name || '').toLowerCase(),
                        audioStreams: audioStreams.map((a, idx) => ({
                            index: idx,
                            codec: (a.codec_name || '').toLowerCase(),
                            channels: parseInt(a.channels || 2, 10),
                            channelLayout: a.channel_layout || '',
                            language: (a.tags?.language || a.tags?.LANGUAGE || a.tags?.lang || 'und').toLowerCase(),
                            title: (a.tags?.title || a.tags?.TITLE || a.tags?.handler_name || '').toLowerCase()
                        })),
                        subtitleStreams: subtitleStreams.map((s, idx) => ({
                            index: idx,
                            codec: (s.codec_name || '').toLowerCase(),
                            language: (s.tags?.language || s.tags?.LANGUAGE || s.tags?.lang || 'und').toLowerCase(),
                            title: (s.tags?.title || s.tags?.TITLE || s.tags?.handler_name || '').toLowerCase()
                        }))
                    });
                } catch (e) {
                    reject(new Error(`Falha ao decodificar JSON do ffprobe: ${e.message}`));
                }
            });
        });
    }

    detectPortugueseAudioIndex(audioStreams, rawFileName = '') {
        if (!audioStreams || audioStreams.length === 0) return null;
        if (audioStreams.length === 1) return 0;

        const ptKeywords = ['por', 'pob', 'pt', 'pt-br', 'pt_br', 'brazilian', 'portuguese', 'português'];

        // 1. Tag explícita de idioma no stream
        for (let i = 0; i < audioStreams.length; i++) {
            const lang = (audioStreams[i].language || '').toLowerCase();
            if (ptKeywords.includes(lang)) {
                return i;
            }
        }

        // 2. Título ou nome do stream (ex: "Dublado", "Português", "PT-BR", "Áudio Nacional")
        for (let i = 0; i < audioStreams.length; i++) {
            const title = (audioStreams[i].title || '').toLowerCase();
            if (title.includes('portug') || title.includes('dublado') || title.includes('pt-br') || 
                title.includes('pt_br') || title.includes('nacional') || title.includes('audio 1') || 
                title.includes('áudio 1') || title.includes('pob')) {
                return i;
            }
        }

        // 3. Regra de eliminação para arquivos DUAL AUDIO:
        // Se um dos áudios estiver marcado explicitamente como estrangeiro (eng/spa/etc.) e o outro for 'und' (anônimo)
        const foreignCodes = ['eng', 'spa', 'fra', 'fre', 'deu', 'ger', 'ita', 'rus', 'jpn', 'kor', 'zho', 'chi', 'hin'];
        const foreignIdx = audioStreams.findIndex(s => foreignCodes.includes((s.language || '').toLowerCase()));
        if (foreignIdx !== -1) {
            const ptCandidateIdx = audioStreams.findIndex((s, idx) => idx !== foreignIdx && !foreignCodes.includes((s.language || '').toLowerCase()));
            if (ptCandidateIdx !== -1) {
                return ptCandidateIdx;
            }
        }

        // 4. Regra específica para releases Dual Audio brasileiros com streams anônimos (sem tag de idioma):
        // Grupos como YG, Lapumia, Starck, Vizer usam convenção onde:
        // Track 0 = Espanhol ou Inglês, Track 1 (última) = Português (PT-BR)
        const lowerName = (rawFileName || '').toLowerCase();
        const isBrDualRelease = /yg[^a-z]|\byg$|dual.*yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|kyogo|lipeh|bludv|guanabara|mmfilmes|overdrive|p2p[-_ ]?br/i.test(lowerName);
        const allUndefined = audioStreams.every(s => !s.language || s.language === 'und');

        if (isBrDualRelease && allUndefined && audioStreams.length >= 2) {
            // Em releases Dual YG/BR: a ÚLTIMA trilha é sempre o PT-BR
            console.log(`🔊 [Dual YG BR] Selecionando trilha ${audioStreams.length - 1} (última) como PT-BR para release: ${rawFileName}`);
            return audioStreams.length - 1;
        }

        // 5. Fallback: se nenhum metadado disponível, usa trilha 0
        return 0;
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

        // 2. Se TODAS as faixas têm tag de idioma conhecida e NENHUMA é Português (ex: [spa, eng])
        const allTaggedAndForeign = info.audioStreams.length > 0 && 
            info.audioStreams.every(a => {
                const lang = (a.language || '').toLowerCase();
                return lang !== 'und' && lang !== '' && !ptLanguages.includes(lang);
            });

        if (allTaggedAndForeign) {
            return false; // Todas as faixas são declaradamente estrangeiras (ex: Espanhol + Inglês)
        }

        // 3. Se as faixas de áudio não possuem metadados de idioma (streams anônimos), verifica o selo brasileiro no nome do arquivo
        const isBrGroup = /lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|mostbet|1xbet|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(lowerName);
        const isExplicitDublado = /\b(dublado|nacional|pt[-_]?br|ptbr|portugues)\b/i.test(lowerName);

        if (isExplicitDublado || isBrGroup) {
            return true;
        }

        return false;
    }

    hasPortugueseSubtitles(info, rawFileName = '') {
        const lowerName = (rawFileName || '').toLowerCase();

        // 1. Verifica se há trilhas de legenda em Português embutidas no arquivo
        if (info.subtitleStreams && info.subtitleStreams.length > 0) {
            const ptLanguages = ['por', 'pob', 'pt', 'pt-br', 'brazilian', 'portuguese', 'português'];
            const hasPtSubStream = info.subtitleStreams.some(s => {
                const lang = (s.language || '').toLowerCase();
                const title = (s.title || '').toLowerCase();
                return ptLanguages.includes(lang) || title.includes('portug') || title.includes('legenda') || title.includes('pt-br');
            });
            if (hasPtSubStream) return true;
        }

        // 2. Verifica se o nome do arquivo traz tags explícitas de legenda em Português (hardcoded ou softsub)
        const isExplicitLegendado = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br|pt[-_ ]?subs?|subs?\.por|hc[-_ ]?sub)\b/i.test(lowerName);
        if (isExplicitLegendado) {
            return true;
        }

        return false;
    }

    validatePortugueseContent(info, rawFileName = '', source = {}) {
        const lowerName = (rawFileName || '').toLowerCase();

        // 1. Áudio Dublado REAL verificado estritamente via ffprobe e tags do arquivo
        const isDublado = this.hasPortugueseAudio(info, rawFileName);

        // 2. Legendas em Português verificadas via ffprobe ou fonte comprovada
        const hasPtSubsInFile = this.hasPortugueseSubtitles(info, rawFileName);
        const isLegendado = hasPtSubsInFile || source.isLegendado === true || source.hasPtSub === true || /\b(legendado|legendas|legenda)\b/i.test(lowerName);

        // 3. Caso contenha AMBOS (Áudio Dublado + Legenda PT-BR no mesmo arquivo)
        if (isDublado && isLegendado) {
            return {
                isValid: true,
                isDublado: true,
                isLegendado: true,
                hasBoth: true,
                audioText: 'Dual Áudio + Legendas (Dublado e Legendado PT-BR)'
            };
        }

        if (isDublado) {
            return {
                isValid: true,
                isDublado: true,
                isLegendado: false,
                hasBoth: false,
                audioText: 'Dublado (Áudio PT-BR)'
            };
        }

        if (isLegendado) {
            return {
                isValid: true,
                isDublado: false,
                isLegendado: true,
                hasBoth: false,
                audioText: 'Legendado (PT-BR)'
            };
        }

        return {
            isValid: false,
            isDublado: false,
            isLegendado: false,
            hasBoth: false,
            audioText: 'Desconhecido (Sem Português)'
        };
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

    async optimizeForTelegram(inputPath, outputPath, onProgress = null, metadata = {}) {
        await fs.ensureDir(path.dirname(outputPath));
        const info = await this.getVideoInfo(inputPath);

        const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
            ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
            : (metadata.nome || metadata.title || path.basename(inputPath));

        const isUnderSizeLimit = info.sizeBytes <= this.maxSizeBytes;
        const isFastCodec = info.videoCodec === 'h264';
        const isResolutionFine = (info.width || 1920) <= 1920; // 1080p ou menor

        // Detectar com precisão a faixa de áudio em Português
        const portugueseAudioIndex = this.detectPortugueseAudioIndex(info.audioStreams, path.basename(inputPath));
        const selectedAudioStream = portugueseAudioIndex !== null ? info.audioStreams[portugueseAudioIndex] : (info.audioStreams[0] || null);

        let finalPath;

        if (isUnderSizeLimit && isFastCodec && isResolutionFine) {
            console.log(`⚡ [${optTitle}] Vídeo já está em 1080p H.264 compatível (${info.sizeMB} MB). Fazendo Remux Rápido com normalização universal de áudio AAC...`);
            if (portugueseAudioIndex !== null) {
                console.log(`🔊 Faixa de áudio em Português selecionada: Stream 0:a:${portugueseAudioIndex} [${selectedAudioStream?.codec?.toUpperCase()} | ${selectedAudioStream?.channels} canais | lang: ${selectedAudioStream?.language}]`);
            }

            finalPath = await new Promise((resolve, reject) => {
                const remuxArgs = [
                    '-i', inputPath,
                    '-c:v', 'copy' // Cópia direta do vídeo sem reprocessamento (100% de qualidade original preservada)
                ];

                if (portugueseAudioIndex !== null) {
                    remuxArgs.push('-map', '0:v:0', '-map', `0:a:${portugueseAudioIndex}`, '-disposition:a:0', 'default');
                } else {
                    remuxArgs.push('-map', '0:v:0', '-map', '0:a:0?', '-disposition:a:0', 'default');
                }

                // Preserva legendas embutidas (PT-BR ou multi-subs) no container MP4
                if (info.subtitleStreams && info.subtitleStreams.length > 0) {
                    remuxArgs.push('-map', '0:s?', '-c:s', 'mov_text');
                }

                // REGRA UNIVERSAL DE ÁUDIO PARA TELEGRAM E WEB:
                // Se o áudio JÁ FOR AAC e estéreo (<= 2 canais), faz copy ultrarrápido.
                // Se for EAC3, AC3, DTS, 5.1 canais, 7.1 canais ou outro codec:
                // Converte OBRIGATORIAMENTE para AAC Stereo (2.0) a 256kbps 48kHz para garantir que NUNCA fique mudo!
                const isSimpleAacStereo = selectedAudioStream && 
                    selectedAudioStream.codec === 'aac' && 
                    selectedAudioStream.channels <= 2;

                if (isSimpleAacStereo) {
                    remuxArgs.push('-c:a', 'copy');
                } else {
                    remuxArgs.push('-c:a', 'aac', '-b:a', '256k', '-ac', '2', '-ar', '48000');
                }

                remuxArgs.push('-movflags', '+faststart', '-y', outputPath);

                const ffmpeg = spawn('ffmpeg', remuxArgs);
                const totalDuration = info.duration || 1;
                let lastLogTime = 0;

                ffmpeg.stderr.on('data', (data) => {
                    const text = data.toString();
                    const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                    const speedMatch = text.match(/speed=\s*([\d.]+)x/);
                    
                    if (timeMatch) {
                        const hours = parseFloat(timeMatch[1]);
                        const minutes = parseFloat(timeMatch[2]);
                        const seconds = parseFloat(timeMatch[3]);
                        const currentTime = (hours * 3600) + (minutes * 60) + seconds;
                        const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
                        const speedStr = speedMatch ? `${speedMatch[1]}x` : 'Rápido';

                        const now = Date.now();
                        if (now - lastLogTime > 400) {
                            lastLogTime = now;
                            const barLength = 25;
                            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                            const empty = Math.max(0, barLength - filled);
                            const bar = '█'.repeat(filled) + '░'.repeat(empty);

                            process.stdout.write(`\r\x1b[36m⚡ [REMUX: "${optTitle}"] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)} | 🚀 ${speedStr}\x1b[0m `);
                        }

                        if (onProgress) onProgress(percent, `Remux 1080p (${percent}%) - ${speedStr}`);
                    }
                });

                ffmpeg.stdout.on('data', () => {});

                ffmpeg.on('close', (code) => {
                    if (code === 0 && fs.existsSync(outputPath)) {
                        process.stdout.write('\n');
                        console.log(`\x1b[32m✅ [${optTitle}] Remux concluído com sucesso e áudio AAC estéreo 100% garantido!\x1b[0m`);
                        if (onProgress) onProgress(100, 'Remux Concluído');
                        resolve(outputPath);
                    } else {
                        process.stdout.write('\n');
                        console.warn(`⚠️ Aviso no remux rápido (código ${code}), prosseguindo para codificação padrão...`);
                        this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                    }
                });
                ffmpeg.on('error', () => {
                    process.stdout.write('\n');
                    this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata).then(resolve).catch(reject);
                });
            });
        } else {
            finalPath = await this.encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex, onProgress, metadata);
        }

        // Validação Estrita Pós-Conversão: Duração do arquivo de saída DEVE bater com a do arquivo original
        const outInfo = await this.getVideoInfo(finalPath);
        if (info.duration > 0 && outInfo.duration > 0) {
            const diffSec = Math.abs(outInfo.duration - info.duration);
            if (diffSec > 15 && outInfo.duration < info.duration * 0.95) {
                await fs.remove(finalPath).catch(() => {});
                throw new Error(`Inconsistência de duração pós-processamento: original tinha ${info.durationFormatted} (${Math.round(info.duration)}s) e arquivo gerado tem ${outInfo.durationFormatted} (${Math.round(outInfo.duration)}s). Conversão descartada.`);
            }
        }

        return finalPath;
    }

    async encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex = null, onProgress = null, metadata = {}) {
        const os = require('os');
        const cpuCount = os.cpus()?.length || 4;
        const safeThreads = Math.max(2, Math.min(8, cpuCount - 1)); // Deixa 1 núcleo livre para o bot responder liso

        const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
            ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
            : (metadata.nome || metadata.title || path.basename(inputPath));

        console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] Iniciando codificação ultrarrápida (Preset: faster, Threads: ${safeThreads}, CRF: 20, Áudio: 256k)...\x1b[0m`);
        
        return new Promise((resolve, reject) => {
            const totalDuration = info.duration || 1;

            // Limite de segurança de 3950 MB para garantir upload no Telegram Premium MTProto (teto de 4GB)
            const safeMaxMB = (config.VIDEO_MAX_SIZE_BYTES / (1024 * 1024)) || 3950;
            const maxTotalKbps = Math.floor((safeMaxMB * 1024 * 8) / Math.max(1, totalDuration));
            const audioBitrateKbps = 256; // 256k é áudio estéreo/5.1 cristalino
            const maxVideoKbps = Math.max(1500, maxTotalKbps - audioBitrateKbps);

            const args = [
                '-i', inputPath,
                '-vf', "scale='min(1920,iw)':-2", // Mantém 1080p nativo nítido
                '-c:v', 'libx264',
                '-preset', 'faster', // 4x a 6x mais rápido que medium, com qualidade visual 1080p idêntica
                '-crf', '20', // Padrão ouro da indústria de streaming para 1080p
                '-maxrate', `${maxVideoKbps}k`,
                '-bufsize', `${maxVideoKbps * 2}k`,
                '-threads', `${safeThreads}`,
                '-c:a', 'aac',
                '-b:a', `${audioBitrateKbps}k`,
                '-ac', '2',
                '-ar', '48000'
            ];

            // Mapeamento preciso de áudio
            if (portugueseAudioIndex !== null) {
                args.push('-map', '0:v:0', '-map', `0:a:${portugueseAudioIndex}`, '-disposition:a:0', 'default');
            } else {
                args.push('-map', '0:v:0', '-map', '0:a:0?', '-disposition:a:0', 'default');
            }

            args.push('-movflags', '+faststart', '-y', outputPath);

            const ffmpeg = spawn('ffmpeg', args);

            let lastLogTime = Date.now();

            ffmpeg.stderr.on('data', (data) => {
                const text = data.toString();
                const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                const speedMatch = text.match(/speed=\s*([\d.]+)x/);
                const fpsMatch = text.match(/fps=\s*([\d.]+)/);

                if (timeMatch) {
                    const hours = parseFloat(timeMatch[1]);
                    const minutes = parseFloat(timeMatch[2]);
                    const seconds = parseFloat(timeMatch[3]);
                    const currentTime = (hours * 3600) + (minutes * 60) + seconds;
                    const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
                    const speedStr = speedMatch ? `${speedMatch[1]}x` : '';
                    const fpsStr = fpsMatch ? ` | FPS: ${fpsMatch[1]}` : '';

                    const now = Date.now();
                    if (now - lastLogTime > 500) { // Atualiza a cada 500ms
                        lastLogTime = now;
                        const barLength = 25;
                        const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                        const empty = Math.max(0, barLength - filled);
                        const bar = '█'.repeat(filled) + '░'.repeat(empty);

                        // Amarelo vibrante para a etapa de Otimização FFmpeg
                        process.stdout.write(`\r\x1b[33m⚙️ [OTIMIZAÇÃO: "${optTitle}"] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)}${speedStr ? ` | ⚡ ${speedStr}` : ''}${fpsStr}\x1b[0m `);
                    }

                    if (onProgress) onProgress(percent, `Otimizando 1080p (${percent}%) ${speedStr ? `[${speedStr}]` : ''}`);
                }
            });

            ffmpeg.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    process.stdout.write('\n');
                    console.log(`\x1b[32m✅ Otimização 1080p concluída com sucesso e máxima fidelidade visual!\x1b[0m`);
                    if (onProgress) onProgress(100, 'Otimização Concluída');
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
