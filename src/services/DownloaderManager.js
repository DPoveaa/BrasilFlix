const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const EventEmitter = require('events');
const config = require('../../config');
const VideoProcessor = require('./VideoProcessor');

let WebTorrentClass = null;

class DownloaderManager extends EventEmitter {
    constructor() {
        super();
        this.downloadDir = path.resolve(config.DOWNLOAD_DIR || './downloads/temp');
        this.ensureDirectories();
        // Não limpa o diretório temp no início para permitir retomada inteligente de downloads/conversões anteriores
    }

    ensureDirectories() {
        fs.ensureDirSync(this.downloadDir);
    }

    async getWebTorrentClass() {
        if (!WebTorrentClass) {
            try {
                const wtModule = await import('webtorrent');
                WebTorrentClass = wtModule.default || wtModule;
            } catch (e1) {
                try {
                    const modulePath = require.resolve('webtorrent');
                    const wtModule = await import(`file://${modulePath}`);
                    WebTorrentClass = wtModule.default || wtModule;
                } catch (e2) {
                    console.error('❌ Falha ao carregar webtorrent:', e2.message);
                    throw e2;
                }
            }
        }
        return WebTorrentClass;
    }

    formatBytes(bytes) {
        if (!bytes || isNaN(bytes) || bytes <= 0) return '0 MB';
        const gb = bytes / (1024 * 1024 * 1024);
        if (gb >= 1.0) {
            return `${gb.toFixed(2)} GB`;
        }
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(1)} MB`;
    }

    formatDuration(sec) {
        if (!sec || isNaN(sec) || sec < 0) return '00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        if (h > 0) {
            return `${h}h ${m.toString().padStart(2, '0')}m ${s.toString().padStart(2, '0')}s`;
        }
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    extractCleanHash(magnetOrTorrent) {
        if (typeof magnetOrTorrent === 'string') {
            const hashMatch = magnetOrTorrent.match(/([a-fA-F0-9]{40})/);
            if (hashMatch) {
                return hashMatch[1].toLowerCase();
            }
        }
        return magnetOrTorrent;
    }

    async downloadTorrent(magnetOrTorrent, onProgress = null, options = {}) {
        this.ensureDirectories();
        const WT = await this.getWebTorrentClass();
        if (!WT) {
            throw new Error('Módulo WebTorrent não disponível.');
        }

        const torrentTarget = this.extractCleanHash(magnetOrTorrent);
        const mediaTitle = options.title || 'Mídia';
        const startTime = Date.now();

        const trackers = [
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://open.stealth.si:80/announce',
            'udp://tracker.torrent.eu.org:451/announce',
            'udp://explodie.org:6969/announce',
            'udp://tracker.moeking.me:6969/announce',
            'http://tracker.opentrackr.org:1337/announce',
            'udp://p4p.arenabg.com:1337/announce',
            'udp://tracker.birkenwald.de:6969/announce',
            'udp://tracker.dler.org:6969/announce',
            'udp://opentor.net:6969/announce',
            'udp://open.demonii.com:1337/announce',
            'udp://tracker.openbittorrent.com:80/announce',
            'udp://tracker.cyberia.is:6969/announce',
            'udp://9.rarbg.to:2920/announce',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.btorrent.xyz',
            'wss://tracker.files.fm:7073/announce'
        ];

        const isSerie = options.type === 'serie' || (options.season && options.episode && options.type !== 'filme');
        const displayTitle = isSerie
            ? `${mediaTitle} (T${options.season || 1}E${options.episode || 1})` 
            : mediaTitle;

        return new Promise((resolve, reject) => {
            console.log(`📥 Iniciando download via Torrent: "${displayTitle}" [Hash: ${String(torrentTarget).substring(0, 15)}...]`);

            // Instância isolada por download com alto limite de conexões simultâneas
            const client = new WT({
                maxConns: 150,
                dht: true,
                tracker: true,
                downloadLimit: -1,
                uploadLimit: 1024 * 50
            });

            let torrent = null;
            let watchdogInterval = null;
            let finished = false;

            const safeCleanup = () => {
                if (watchdogInterval) {
                    clearInterval(watchdogInterval);
                    watchdogInterval = null;
                }
                try {
                    if (torrent) {
                        torrent.removeAllListeners();
                    }
                    client.destroy(() => {});
                } catch (e) {
                    console.warn('⚠️ Aviso ao finalizar cliente WebTorrent:', e.message);
                }
            };

            client.on('error', (err) => {
                console.error('⚠️ Aviso do cliente WebTorrent:', err?.message || err);
            });

            try {
                torrent = client.add(torrentTarget, { 
                    path: this.downloadDir,
                    announce: trackers
                });
            } catch (err) {
                safeCleanup();
                return reject(new Error(`Falha ao iniciar torrent: ${err.message}`));
            }

            let lastProgressTime = Date.now();
            let lastLogTime = Date.now();
            let targetEpisodeFile = null;

            torrent.on('metadata', () => {
                // Proteção contra arquivos gigantes (4K / 20GB): aborta na hora para filmes
                if (!options.episode && torrent.length > 5.8 * 1024 * 1024 * 1024) {
                    console.log(`⚠️ Arquivo de filme muito pesado (${this.formatBytes(torrent.length)} > 5.5 GB). Abortando para priorizar 1080p leve...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Arquivo excede o limite de tamanho para filmes 1080p (${this.formatBytes(torrent.length)}).`));
                }

                if (options.episode && torrent.files && torrent.files.length > 1) {
                    const seasonNum = parseInt(options.season || 1, 10);
                    const epNum = parseInt(options.episode, 10);
                    const epPadded2 = String(epNum).padStart(2, '0');
                    const epPadded3 = String(epNum).padStart(3, '0');
                    const sPadded2 = String(seasonNum).padStart(2, '0');

                    // Filtra apenas arquivos com extensão de vídeo
                    const videoFiles = torrent.files.filter(f => {
                        const ext = path.extname(f.name).toLowerCase();
                        return ['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext);
                    });

                    // 1. Padrões estritos de Temporada + Episódio (S01E02, S1E2, S01.E02, S01 - E02, T01E02, 1x02, 01x02, Season 1 Episode 2)
                    const strictPatterns = [
                        new RegExp(`s0*${seasonNum}[._ -]*e0*${epNum}(?:v\\d+)?\\b`, 'i'),
                        new RegExp(`s${sPadded2}[._ -]*e${epPadded2}\\b`, 'i'),
                        new RegExp(`\\b${seasonNum}x0*${epNum}\\b`, 'i'),
                        new RegExp(`\\bt0*${seasonNum}[._ -]*e0*${epNum}\\b`, 'i'),
                        new RegExp(`(?:season|temporada)[._ -]*0*${seasonNum}[._ -]+(?:episode|episodio|ep|e)[._ -]*0*${epNum}\\b`, 'i')
                    ];

                    let found = null;
                    for (const regex of strictPatterns) {
                        found = videoFiles.find(f => regex.test(f.name) || regex.test(f.path));
                        if (found) break;
                    }

                    // 2. Padrão de Faixa/Multi-episódio (ex: S01E01-E05, S01E01-04 onde epNum está dentro do intervalo)
                    if (!found) {
                        found = videoFiles.find(f => {
                            const str = `${f.path} ${f.name}`;
                            const rangeMatch = str.match(new RegExp(`s0*${seasonNum}[._ -]*e0*(\\d+)[._ -]*(?:-|~|a|e|to)[._ -]*e?0*(\\d+)`, 'i'));
                            if (rangeMatch) {
                                const start = parseInt(rangeMatch[1], 10);
                                const end = parseInt(rangeMatch[2], 10);
                                if (epNum >= start && epNum <= end) return true;
                            }
                            return false;
                        });
                    }

                    // 3. Padrão por pasta da temporada (ex: pasta "Season 1/" ou "S01/" contendo arquivos "01.mkv" ou "Ep.1.mp4")
                    if (!found) {
                        const seasonFolderRegex = new RegExp(`(?:season|temporada|s)[._ -]*0*${seasonNum}(?:[\\\\/]|$)`, 'i');
                        const seasonFolderFiles = videoFiles.filter(f => seasonFolderRegex.test(f.path));

                        if (seasonFolderFiles.length > 0) {
                            const epInFolderPatterns = [
                                new RegExp(`\\b(?:ep|e|episodio|episode)[._ -]*0*${epNum}\\b`, 'i'),
                                new RegExp(`\\b${epPadded2}\\b`),
                                new RegExp(`\\b0*${epNum}\\b`)
                            ];
                            for (const regex of epInFolderPatterns) {
                                found = seasonFolderFiles.find(f => regex.test(f.name));
                                if (found) break;
                            }
                        }
                    }

                    // 4. Padrões avulsos de Episódio com proteção contra números de resolução/ano/codec
                    if (!found) {
                        const epPatterns = [
                            new RegExp(`\\b(?:ep|episodio|episode)[._ -]*0*${epNum}\\b`, 'i'),
                            new RegExp(`\\be0*${epNum}\\b`, 'i'),
                            new RegExp(`[._ -]e0*${epNum}[._ -]`, 'i'),
                            new RegExp(`[._ -]ep0*${epNum}[._ -]`, 'i')
                        ];
                        for (const regex of epPatterns) {
                            found = videoFiles.find(f => regex.test(f.name));
                            if (found) break;
                        }
                    }

                    if (found) {
                        targetEpisodeFile = found;
                        try {
                            torrent.files.forEach(f => {
                                if (f !== found) f.deselect();
                            });
                            found.select();
                            found.on('done', () => checkAndComplete());
                            console.log(`🎯 [Multi-Pack] Otimização: baixando somente o episódio desejado: ${found.name} (${this.formatBytes(found.length)})`);
                        } catch (e) {
                            console.warn('⚠️ Erro ao selecionar arquivo alvo no pack:', e.message);
                        }
                    } else {
                        console.log(`ℹ️ [Multi-Pack] Nenhum arquivo avulso isolado para S${sPadded2}E${epPadded2}. Mantendo seleção completa.`);
                    }
                }
            });

            let isCompleting = false;
            const checkAndComplete = async () => {
                if (finished || isCompleting) return;
                isCompleting = true;

                try {
                    let selectedFile = targetEpisodeFile;
                    if (!selectedFile) {
                        const videoFiles = torrent.files.filter(f => {
                            const ext = path.extname(f.name).toLowerCase();
                            return ['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext);
                        });

                        // Filtra arquivos que NÃO sejam amostras ou propagandas
                        const realVideoFiles = videoFiles.filter(f => {
                            const lower = f.name.toLowerCase();
                            return !lower.includes('sample') && !lower.includes('amostra') && !lower.includes('trailer') && !lower.includes('teaser') && !lower.includes('comando.to') && !lower.includes('baixe');
                        });

                        const candidateFiles = realVideoFiles.length > 0 ? realVideoFiles : videoFiles;
                        if (candidateFiles.length > 0) {
                            selectedFile = candidateFiles.reduce((prev, curr) => (curr.length > prev.length ? curr : prev), candidateFiles[0]);
                        }
                    }

                    if (!selectedFile) {
                        selectedFile = torrent.files.reduce((prev, curr) => (curr.length > prev.length ? curr : prev), torrent.files[0]);
                    }

                    if (!selectedFile) {
                        isCompleting = false;
                        return;
                    }

                    const fullPath = path.join(this.downloadDir, selectedFile.path);

                    // 1. Verificação de existência do arquivo físico
                    if (!fs.existsSync(fullPath)) {
                        isCompleting = false;
                        return;
                    }

                    // 2. Verificação de tamanho do arquivo em disco
                    const stat = fs.statSync(fullPath);
                    const expectedSize = selectedFile.length;

                    if (expectedSize > 0 && stat.size < expectedSize * 0.95) {
                        isCompleting = false;
                        return;
                    }

                    // 3. Verificação de integridade estrutural via ffprobe
                    const videoInfo = await VideoProcessor.getVideoInfo(fullPath);
                    if (!videoInfo.duration || videoInfo.duration <= 0) {
                        isCompleting = false;
                        return;
                    }

                    finished = true;
                    process.stdout.write('\n');
                    console.log(`✅ Download concluído e validado em disco (${this.formatBytes(stat.size)}): ${selectedFile.name}`);

                    const fileInfo = {
                        filePath: fullPath,
                        fileName: selectedFile.name,
                        sizeBytes: stat.size,
                        totalTorrentFiles: torrent.files.length
                    };

                    safeCleanup();
                    resolve(fileInfo);
                } catch (e) {
                    console.warn('⚠️ Validação de download:', e.message);
                    isCompleting = false;
                }
            };

            torrent.on('download', () => {
                if (finished) return;

                const curTotal = targetEpisodeFile ? targetEpisodeFile.length : torrent.length;
                const curDownloaded = targetEpisodeFile 
                    ? (targetEpisodeFile.downloaded || 0)
                    : (torrent.downloaded || 0);

                const curRatio = curTotal > 0 ? (curDownloaded / curTotal) : 0;

                // Se o arquivo selecionado ou torrent atingiu 98%+, conclui imediatamente
                if (curRatio >= 0.98 || torrent.progress >= 0.98) {
                    checkAndComplete();
                }

                const now = Date.now();
                if (now - lastProgressTime > 800) {
                    lastProgressTime = now;

                    const curRatio = curTotal > 0 ? (curDownloaded / curTotal) : 0;
                    const percent = Math.min(100, Math.max(0, curRatio * 100)).toFixed(1);

                    const speedMB = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                    const downloadedStr = this.formatBytes(curDownloaded);
                    const totalStr = this.formatBytes(curTotal);

                    const barLength = 25;
                    const filled = Math.min(barLength, Math.round(curRatio * barLength));
                    const empty = Math.max(0, barLength - filled);
                    const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

                    const elapsedSec = Math.floor((now - startTime) / 1000);
                    const elapsedFormatted = this.formatDuration(elapsedSec);

                    const remainingBytes = Math.max(0, curTotal - curDownloaded);
                    const remainingSec = torrent.downloadSpeed > 0 ? Math.floor(remainingBytes / torrent.downloadSpeed) : null;
                    const remainingFormatted = remainingSec ? `~${this.formatDuration(remainingSec)}` : '--:--';
                    const audioTag = options.audio ? ` | ${options.audio.includes('Dublado') ? '🔊 Dublado' : '💬 Legendado'}` : '';

                    const logLine = `\x1b[36m📥 [DOWNLOAD: "${displayTitle}"] [${progressBar}] ${percent}% | ${downloadedStr} / ${totalStr} | ${speedMB} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ${remainingFormatted}) | Peers: ${torrent.numPeers}${audioTag}\x1b[0m`;

                    if (process.stdout.isTTY) {
                        process.stdout.write(`\r${logLine} `);
                    } else if (now - lastLogTime >= 5000) {
                        lastLogTime = now;
                        console.log(logLine);
                    }

                    if (onProgress) {
                        onProgress({
                            percent: parseFloat(percent),
                            speed: `${speedMB} MB/s`,
                            downloaded: downloadedStr,
                            total: totalStr,
                            timeRemaining: remainingSec ? remainingSec * 1000 : null
                        });
                    }
                }
            });

            torrent.on('done', () => checkAndComplete());

            torrent.on('error', (err) => {
                finished = true;
                safeCleanup();
                reject(new Error(`Falha no download do torrent: ${err.message}`));
            });

            let lastBytes = 0;
            let lastBytesChangeTime = Date.now();
            const downloadStartTime = Date.now();

            watchdogInterval = setInterval(() => {
                if (finished || !torrent) return;

                const curTotal = targetEpisodeFile ? targetEpisodeFile.length : torrent.length;
                const curDownloaded = targetEpisodeFile ? (targetEpisodeFile.downloaded || 0) : (torrent.downloaded || 0);

                if (curTotal > 0 && (curDownloaded >= curTotal * 0.98 || torrent.progress >= 0.98 || torrent.done)) {
                    checkAndComplete();
                    return;
                }

                const now = Date.now();
                const currentBytes = torrent.downloaded || 0;
                if (currentBytes !== lastBytes) {
                    lastBytes = currentBytes;
                    lastBytesChangeTime = now;
                }

                const stalledMs = now - lastBytesChangeTime;
                const elapsedSec = Math.floor((now - downloadStartTime) / 1000);

                // 1. Aborta se estiver completamente estagnado por 150s no início (sem progresso significativo e sem peers)
                if (stalledMs >= 150000 && torrent.progress < 0.01) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent estagnado sem velocidade ativa (${torrent.numPeers} peer(s), estagnado por ${Math.round(stalledMs / 1000)}s). Abortando para tentar outra fonte...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error('Download estagnado sem dados/seeders ativos após 150s.'));
                }

                // 2. Aborta se for um torrent excessivamente lento (< 0.25 MB/s após 180 segundos com previsão > 75 min)
                const speedMB = torrent.downloadSpeed / (1024 * 1024);
                const remainingSec = speedMB > 0 ? (torrent.length - currentBytes) / (speedMB * 1024 * 1024) : 99999;
                
                if (elapsedSec >= 180 && speedMB < 0.25 && remainingSec > 4500 && torrent.progress < 0.05) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent excessivamente lento (${speedMB.toFixed(2)} MB/s, ${torrent.numPeers} peer(s), previsão: > 75 min). Abortando para buscar fonte mais rápida...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error('Torrent com poucos seeders/velocidade insuficiente.'));
                }
            }, 5000);
        });
    }

    async downloadHttp(url, fileName, onProgress = null) {
        this.ensureDirectories();
        const targetPath = path.join(this.downloadDir, fileName);
        console.log(`📥 Baixando arquivo direto via HTTP: ${fileName}...`);

        const response = await axios({
            method: 'GET',
            url: url,
            responseType: 'stream',
            timeout: 30000
        });

        const totalBytes = parseInt(response.headers['content-length'] || 0, 10);
        let downloadedBytes = 0;
        let lastProgressTime = Date.now();

        const writer = fs.createWriteStream(targetPath);

        return new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                downloadedBytes += chunk.length;
                const now = Date.now();
                if (now - lastProgressTime > 1000) {
                    lastProgressTime = now;
                    const percent = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
                    const downloadedMB = (downloadedBytes / (1024 * 1024)).toFixed(1);
                    const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);

                    process.stdout.write(`\r📥 Baixando: ${percent.toFixed(1)}% | ${downloadedMB}/${totalMB} MB `);

                    if (onProgress) {
                        onProgress({
                            percent: parseFloat(percent.toFixed(1)),
                            downloaded: `${downloadedMB} MB`,
                            total: `${totalMB} MB`
                        });
                    }
                }
            });

            response.data.pipe(writer);

            writer.on('finish', () => {
                process.stdout.write('\n');
                console.log(`✅ Download HTTP concluído: ${fileName}`);
                resolve({
                    filePath: targetPath,
                    fileName: fileName,
                    sizeBytes: downloadedBytes
                });
            });

            writer.on('error', (err) => {
                writer.close();
                fs.removeSync(targetPath);
                reject(new Error(`Falha no download HTTP: ${err.message}`));
            });
        });
    }

    async cleanupFile(filePath) {
        try {
            if (filePath && fs.existsSync(filePath)) {
                await fs.remove(filePath);
                console.log(`🗑️ Arquivo temporário removido: ${path.basename(filePath)}`);
            }
        } catch (e) {
            console.warn(`⚠️ Não foi possível remover arquivo ${filePath}:`, e.message);
        }
    }
}

module.exports = new DownloaderManager();
