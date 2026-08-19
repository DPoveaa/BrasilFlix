const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const SubtitleSync = require('./SubtitleSync');

let activeTranscodes = 0;
const transcodeWaiters = [];

function acquireTranscodeSlot() {
    const maxTranscodes = config.MAX_CONCURRENT_TRANSCODES || 2;
    if (activeTranscodes < maxTranscodes) {
        activeTranscodes++;
        return Promise.resolve();
    }
    return new Promise(resolve => {
        transcodeWaiters.push(resolve);
    });
}

function releaseTranscodeSlot() {
    if (transcodeWaiters.length > 0) {
        const next = transcodeWaiters.shift();
        next();
    } else {
        activeTranscodes = Math.max(0, activeTranscodes - 1);
    }
}

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
                        pixFmt: (videoStream.pix_fmt || 'yuv420p').toLowerCase(),
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

        // 2. Legendas em Português verificadas via ffprobe ou fonte comprovada (ou original para OpenSubtitles)
        const hasPtSubsInFile = this.hasPortugueseSubtitles(info, rawFileName);
        const isLegendado = hasPtSubsInFile || source.isLegendado === true || source.hasPtSub === true || source.isOriginal === true || /\b(legendado|legendas|legenda)\b/i.test(lowerName);

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

    isPortugueseSubtitleContent(content) {
        if (!content || typeof content !== 'string' || content.length < 200) return false;
        const ptKeywords = /\b(você|vocês|não|está|estão|então|também|muito|aqui|agora|isso|isto|aquilo|porque|por que|senhor|senhora|olha|vamos|fazer|coisa|onde|quando|quem|tudo|nada|estou|tenho|tinha|dele|dela|obrigado|obrigada|por favor)\b/gi;
        const matches = content.match(ptKeywords) || [];
        // Exige pelo menos 8 palavras legítimas em Português no arquivo para ser aceito
        return matches.length >= 8;
    }

    async getOrExtractPortugueseSubtitle(inputPath, info, metadata = {}) {
        const axios = require('axios');
        const https = require('https');
        const agent = new https.Agent({ rejectUnauthorized: false });
        const srtPath = path.join(path.dirname(inputPath), `sub_pt_${Date.now()}.srt`);

        // 1. Tenta extrair legenda embutida em Português do arquivo original
        const ptLanguages = ['pob', 'pt-br', 'brazilian', 'portuguese', 'português', 'por', 'pt'];
        const ptSubStream = (info.subtitleStreams || []).find(s => {
            const lang = (s.language || '').toLowerCase();
            const title = (s.title || '').toLowerCase();
            return ptLanguages.includes(lang) || title.includes('portug') || title.includes('legenda') || title.includes('pt-br') || title.includes('pob');
        });

        if (ptSubStream) {
            const isTextCodec = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'text', 'webvtt'].includes((ptSubStream.codec || '').toLowerCase());
            if (isTextCodec) {
                try {
                    console.log(`📝 Extraindo legenda PT-BR embutida (Stream 0:s:${ptSubStream.index}, Codec: ${ptSubStream.codec})...`);
                    await new Promise((resolve, reject) => {
                        let isDone = false;
                        const extract = spawn('ffmpeg', ['-nostdin', '-y', '-i', inputPath, '-map', `0:s:${ptSubStream.index}`, srtPath]);

                        const timer = setTimeout(() => {
                            if (!isDone) {
                                isDone = true;
                                try { extract.kill('SIGKILL'); } catch (e) {}
                                reject(new Error('Timeout de 15s ao extrair legenda interna'));
                            }
                        }, 15000);

                        extract.on('close', code => {
                            if (!isDone) {
                                isDone = true;
                                clearTimeout(timer);
                                (code === 0 && fs.existsSync(srtPath)) ? resolve() : reject(new Error(`Erro ao extrair srt (código ${code})`));
                            }
                        });

                        extract.on('error', err => {
                            if (!isDone) {
                                isDone = true;
                                clearTimeout(timer);
                                reject(err);
                            }
                        });
                    });

                    if (fs.existsSync(srtPath) && fs.statSync(srtPath).size > 500) {
                        const content = await fs.readFile(srtPath, 'utf8');
                        if (this.isPortugueseSubtitleContent(content)) {
                            console.log(`✅ Legenda PT-BR interna extraída e validada linguisticamente!`);
                            return srtPath;
                        } else {
                            console.warn(`⚠️ Legenda interna extraída não continha texto em Português genuíno (possível idioma errado), descartando...`);
                            await fs.remove(srtPath).catch(() => {});
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ Falha ou timeout ao extrair legenda interna:', e.message);
                    await fs.remove(srtPath).catch(() => {});
                }
            } else {
                console.log(`ℹ️ Legenda interna é bitmap/gráfico (${ptSubStream.codec || 'desconhecido'}), buscando versão em texto no OpenSubtitles...`);
            }
        }

        // 2. Busca e validação no OpenSubtitles via IMDb ID (priorizando pob / pt-br sobre por)
        if (!metadata.imdbId && metadata.tmdbId) {
            try {
                const extPath = metadata.tipo === 'serie' ? `tv/${metadata.tmdbId}` : `movie/${metadata.tmdbId}`;
                const extRes = await axios.get(`https://api.themoviedb.org/3/${extPath}/external_ids`, {
                    params: { api_key: config.TMDB_API_KEY },
                    timeout: 6000
                });
                if (extRes.data?.imdb_id) {
                    metadata.imdbId = extRes.data.imdb_id;
                    console.log(`🆔 [TMDB External IDs] IMDb ID resolvido com sucesso: ${metadata.imdbId}`);
                }
            } catch (e) {}
        }

        if (metadata.imdbId) {
            try {
                const season = metadata.season || 1;
                const episode = metadata.episode || 1;
                const streamPath = metadata.tipo === 'serie' ? `series/${metadata.imdbId}:${season}:${episode}.json` : `movie/${metadata.imdbId}.json`;
                const osUrl = `https://opensubtitles-v3.strem.io/subtitles/${streamPath}`;
                const res = await axios.get(osUrl, { timeout: 8000, httpsAgent: agent });
                const subs = res.data?.subtitles || [];

                // Prioriza: pob (Português do Brasil) > pt-br > brazilian > por > pt
                const ptSubs = subs.filter(s => {
                    const lang = (s.lang || s.language || '').toLowerCase();
                    return ['pob', 'pt-br', 'brazilian', 'por', 'pt', 'ptbr'].includes(lang);
                }).sort((a, b) => {
                    const langA = (a.lang || a.language || '').toLowerCase();
                    const langB = (b.lang || b.language || '').toLowerCase();
                    const scoreA = ['pob', 'pt-br', 'brazilian'].includes(langA) ? 2 : 1;
                    const scoreB = ['pob', 'pt-br', 'brazilian'].includes(langB) ? 2 : 1;
                    return scoreB - scoreA;
                });

                console.log(`🌐 Testando ${ptSubs.length} legendas candidatas no OpenSubtitles...`);

                for (const sub of ptSubs) {
                    try {
                        const subRes = await axios.get(sub.url, { timeout: 8000, httpsAgent: agent, responseType: 'text' });
                        if (subRes.data && this.isPortugueseSubtitleContent(subRes.data)) {
                            await fs.writeFile(srtPath, subRes.data, 'utf8');
                            console.log(`✅ Legenda PT-BR oficial (${sub.lang}) baixada e validada linguisticamente (${(subRes.data.length / 1024).toFixed(1)} KB)!`);
                            
                            // Sincroniza a legenda externa contra o áudio real do vídeo para garantir alinhamento perfeito (100% sincronizado)
                            const syncedSrtPath = path.join(path.dirname(inputPath), `sub_pt_synced_${Date.now()}.srt`);
                            const finalSrt = await SubtitleSync.syncSubtitle(inputPath, srtPath, syncedSrtPath);
                            return finalSrt;
                        }
                    } catch (errSub) {}
                }
            } catch (e) {
                console.warn('⚠️ Falha ao consultar OpenSubtitles:', e.message);
            }
        }

        // 3. Fallback de URL direta caso fornecida
        if (metadata.subtitleUrl) {
            try {
                const res = await axios.get(metadata.subtitleUrl, { timeout: 10000, httpsAgent: agent, responseType: 'text' });
                if (res.data && this.isPortugueseSubtitleContent(res.data)) {
                    await fs.writeFile(srtPath, res.data, 'utf8');
                    console.log(`✅ Legenda PT-BR direta baixada e validada!`);
                    
                    const syncedSrtPath = path.join(path.dirname(inputPath), `sub_pt_synced_${Date.now()}.srt`);
                    const finalSrt = await SubtitleSync.syncSubtitle(inputPath, srtPath, syncedSrtPath);
                    return finalSrt;
                }
            } catch (e) {}
        }

        return null;
    }

    async optimizeForTelegram(inputPath, outputPath, onProgress = null, metadata = {}) {
        await fs.ensureDir(path.dirname(outputPath));
        const info = await this.getVideoInfo(inputPath);

        const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
            ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
            : (metadata.nome || metadata.title || path.basename(inputPath));

        const isUnderSizeLimit = info.sizeBytes <= this.maxSizeBytes;
        const isStandard8Bit = info.pixFmt === 'yuv420p';
        const isFastCodec = info.videoCodec === 'h264' && isStandard8Bit;
        const isResolutionFine = (info.width || 1920) <= 1920; // 1080p ou menor

        // Detectar com precisão a faixa de áudio em Português
        const portugueseAudioIndex = this.detectPortugueseAudioIndex(info.audioStreams, path.basename(inputPath));
        const selectedAudioStream = portugueseAudioIndex !== null ? info.audioStreams[portugueseAudioIndex] : (info.audioStreams[0] || null);

        // Se o conteúdo for Legendado (não dublado), DEVE queimar/embutir as legendas em Português
        const isOnlyLegendado = metadata.isLegendado && !metadata.isDublado;
        let srtPath = null;

        if (isOnlyLegendado) {
            srtPath = await this.getOrExtractPortugueseSubtitle(inputPath, info, metadata);
            if (!srtPath) {
                console.warn(`⚠️ [${optTitle}] Nenhuma legenda em Português encontrada para o release legendado.`);
                throw new Error(`Nenhuma legenda em Português encontrada para "${optTitle}". Abortando processamento para evitar vídeo legendado sem legendas.`);
            } else {
                metadata.srtPath = srtPath;
            }
        }

        let finalPath;

        // Se for somente Dublado (sem necessidade de queimar legendas), faz Remux Rápido quando compatível
        if (!isOnlyLegendado && isUnderSizeLimit && isFastCodec && isResolutionFine) {
            console.log(`⚡ [${optTitle}] Vídeo já está em 1080p H.264 compatível (${info.sizeMB} MB). Fazendo Remux Rápido com normalização universal de áudio AAC...`);
            if (portugueseAudioIndex !== null) {
                console.log(`🔊 Faixa de áudio em Português selecionada: Stream 0:a:${portugueseAudioIndex} [${selectedAudioStream?.codec?.toUpperCase()} | ${selectedAudioStream?.channels} canais | lang: ${selectedAudioStream?.language}]`);
            }

            finalPath = await new Promise((resolve, reject) => {
                const remuxArgs = [
                    '-i', inputPath,
                    '-c:v', 'copy' // Cópia direta do vídeo sem reprocessamento
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

                            const audioBadge = metadata.isDublado || metadata.audioText?.includes('Dublado') || (portugueseAudioIndex !== null && !metadata.srtPath) ? '🔊 Dublado' : '💬 Legendado';
                            process.stdout.write(`\r\x1b[36m⚡ [REMUX: "${optTitle}"] [${audioBadge}] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)} | 🚀 ${speedStr}\x1b[0m `);
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

        // Limpa arquivo temporário de legenda .srt após a codificação
        if (srtPath && fs.existsSync(srtPath)) {
            await fs.remove(srtPath).catch(() => {});
        }

        // Validação Pós-Conversão: Duração do arquivo de saída deve ser consistente
        const outInfo = await this.getVideoInfo(finalPath);
        if (info.duration > 0 && outInfo.duration > 0) {
            const minAcceptableSec = Math.max(300, info.duration * 0.50);
            if (outInfo.duration < minAcceptableSec) {
                await fs.remove(finalPath).catch(() => {});
                throw new Error(`Inconsistência severa de duração pós-processamento: original tinha ${info.durationFormatted} (${Math.round(info.duration)}s) e arquivo gerado tem apenas ${outInfo.durationFormatted} (${Math.round(outInfo.duration)}s). Conversão descartada.`);
            }
        }

        return finalPath;
    }

    async encodeVideoFull(inputPath, outputPath, info, portugueseAudioIndex = null, onProgress = null, metadata = {}) {
        await acquireTranscodeSlot();
        try {
            const os = require('os');
            const cpuCount = os.cpus()?.length || 4;
            // Usa as threads configuradas ou limite seguro de CPU
            const safeThreads = config.FFMPEG_THREADS_PER_JOB || Math.max(2, Math.min(6, Math.floor(cpuCount * 0.50)));

            const optTitle = (metadata.tipo === 'serie' || metadata.season || metadata.episode)
                ? `${metadata.nome || metadata.title || path.basename(inputPath)} (T${metadata.season || 1}E${metadata.episode || 1})`
                : (metadata.nome || metadata.title || path.basename(inputPath));

            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] Iniciando codificação (Preset: faster, Threads: ${safeThreads}, CRF: 20, Slots ativos: ${activeTranscodes}/${config.MAX_CONCURRENT_TRANSCODES || 2}${metadata.srtPath ? ', Legenda Queimada: SIM' : ''})...\x1b[0m`);
            
            return await new Promise((resolve, reject) => {
                const totalDuration = info.duration || 1;

                const safeMaxMB = (config.VIDEO_MAX_SIZE_BYTES / (1024 * 1024)) || 3950;
                const maxTotalKbps = Math.floor((safeMaxMB * 1024 * 8) / Math.max(1, totalDuration));
                const audioBitrateKbps = 192;
                const maxVideoKbps = Math.max(1500, maxTotalKbps - audioBitrateKbps);

                // Monta filtros de vídeo (Escalonamento 1080p + Legendas Hardsub Profissionais)
                let vfFilter = "scale='min(1920,iw)':-2";
                if (metadata.srtPath && fs.existsSync(metadata.srtPath)) {
                    const srtEscaped = metadata.srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
                    vfFilter += `,subtitles='${srtEscaped}':force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H00000000,BorderStyle=1,Outline=0.8,Shadow=0,MarginV=30,Alignment=2,Bold=0'`;
                }

                const args = [
                    '-i', inputPath,
                    '-vf', vfFilter,
                    '-c:v', 'libx264',
                    '-preset', 'faster',
                    '-crf', '20',
                    '-profile:v', 'high',
                    '-level', '4.1',
                    '-pix_fmt', 'yuv420p',
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
                let ffmpegStderrBuffer = [];

                ffmpeg.stderr.on('data', (data) => {
                    const text = data.toString();
                    ffmpegStderrBuffer.push(text);
                    if (ffmpegStderrBuffer.length > 20) ffmpegStderrBuffer.shift();

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
                        if (now - lastLogTime > 3000) { // Atualiza a cada 3s para evitar flood nos logs do PM2
                            lastLogTime = now;
                            const barLength = 25;
                            const filled = Math.min(barLength, Math.round((percent / 100) * barLength));
                            const empty = Math.max(0, barLength - filled);
                            const bar = '█'.repeat(filled) + '░'.repeat(empty);

                            // Amarelo vibrante para a etapa de Otimização FFmpeg
                            const audioBadge = metadata.isDublado || metadata.audioText?.includes('Dublado') || (portugueseAudioIndex !== null && !metadata.srtPath) ? '🔊 Dublado' : '💬 Legendado';
                            console.log(`\x1b[33m⚙️ [OTIMIZAÇÃO 1080p: "${optTitle}"] [${audioBadge}] [${bar}] ${percent}% | ⏱️ ${this.formatDuration(currentTime)} / ${this.formatDuration(totalDuration)}${speedStr ? ` | ⚡ ${speedStr}` : ''}${fpsStr}\x1b[0m`);
                        }

                        if (onProgress) onProgress(percent, `Otimizando 1080p (${percent}%) ${speedStr ? `[${speedStr}]` : ''}`);
                    }
                });

                ffmpeg.on('close', (code) => {
                    if (tempSrtRelative && fs.existsSync(tempSrtRelative)) {
                        fs.remove(tempSrtRelative).catch(() => {});
                    }

                    if (code === 0 && fs.existsSync(outputPath)) {
                        process.stdout.write('\n');
                        console.log(`\x1b[32m✅ Otimização 1080p concluída com sucesso e máxima fidelidade visual!\x1b[0m`);
                        if (onProgress) onProgress(100, 'Otimização Concluída');
                        resolve(outputPath);
                    } else {
                        process.stdout.write('\n');
                        const errSnippet = ffmpegStderrBuffer.slice(-5).join('\n').trim();
                        if (errSnippet) {
                            console.error(`❌ [FFmpeg Erro] Código ${code}. Diagnóstico:\n${errSnippet}`);
                        }
                        reject(new Error(`Erro na transcodificação do vídeo: código ${code}`));
                    }
                });

                ffmpeg.on('error', (err) => {
                    if (tempSrtRelative && fs.existsSync(tempSrtRelative)) {
                        fs.remove(tempSrtRelative).catch(() => {});
                    }
                    reject(err);
                });
            });
        } finally {
            releaseTranscodeSlot();
        }
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
