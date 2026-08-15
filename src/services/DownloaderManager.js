const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const EventEmitter = require('events');
const config = require('../../config');

let WebTorrentClass = null;

class DownloaderManager extends EventEmitter {
    constructor() {
        super();
        this.downloadDir = path.resolve(config.DOWNLOAD_DIR || './downloads/temp');
        this.ensureDirectories();
        this.cleanupTempDirectory();
    }

    ensureDirectories() {
        fs.ensureDirSync(this.downloadDir);
    }

    cleanupTempDirectory() {
        try {
            if (fs.existsSync(this.downloadDir)) {
                fs.emptyDirSync(this.downloadDir);
                console.log('🧹 Pasta de downloads temporários limpa no início (SSD protegido contra acúmulo de arquivos incompletos).');
            }
        } catch (e) {
            console.warn('⚠️ Aviso ao limpar pasta temp:', e.message);
        }
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
            'udp://tracker.coppersurfer.tk:6969/announce',
            'udp://tracker.dler.org:6969/announce',
            'udp://opentor.net:6969/announce'
        ];

        return new Promise((resolve, reject) => {
            console.log(`📥 Iniciando download via Torrent: "${mediaTitle}" [Hash: ${String(torrentTarget).substring(0, 15)}...]`);

            // Instância isolada por download com alto limite de conexões simultâneas
            const client = new WT({
                maxConns: 120,
                dht: true,
                tracker: true,
                downloadLimit: -1,
                uploadLimit: 1024 * 50
            });

            let torrent = null;
            let watchdogInterval = null;
            let finished = false;

            const safeCleanup = () => {
                if (finished) return;
                finished = true;
                if (watchdogInterval) clearInterval(watchdogInterval);
                try {
                    client.destroy(() => {});
                } catch (e) {}
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
                    safeCleanup();
                    return reject(new Error(`Arquivo excede o limite de tamanho para filmes 1080p (${this.formatBytes(torrent.length)}).`));
                }

                if (options.episode && torrent.files && torrent.files.length > 1) {
                    const seasonNum = parseInt(options.season || 1, 10);
                    const epNum = parseInt(options.episode, 10);
                    const epPadded2 = String(epNum).padStart(2, '0');
                    const epPadded3 = String(epNum).padStart(3, '0');
                    const sPadded = String(seasonNum).padStart(2, '0');

                    // Padrões ordenados por especificidade
                    const patterns = [
                        new RegExp(`s0*${seasonNum}[._ -]*e0*${epNum}\\b`, 'i'),
                        new RegExp(`s${sPadded}[._ -]*e${epPadded2}\\b`, 'i'),
                        new RegExp(`\\b${seasonNum}x0*${epNum}\\b`, 'i'),
                        new RegExp(`\\be0*${epNum}\\b`, 'i'),
                        new RegExp(`\\bep0*${epNum}\\b`, 'i'),
                        new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
                        new RegExp(`[._ -]${epPadded2}[._ -]`, 'i'),
                        new RegExp(`[._ -]${epPadded3}[._ -]`, 'i'),
                        new RegExp(`episodio[._ -]*0*${epNum}\\b`, 'i')
                    ];

                    let found = null;
                    for (const regex of patterns) {
                        found = torrent.files.find(f => {
                            const ext = path.extname(f.name).toLowerCase();
                            return ['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext) && regex.test(f.name);
                        });
                        if (found) break;
                    }

                    if (found) {
                        targetEpisodeFile = found;
                        try {
                            torrent.files.forEach(f => {
                                if (f !== found) f.deselect();
                            });
                            found.select();
                            found.on('done', onComplete);
                            console.log(`🎯 [Multi-Pack] Otimização: baixando somente o episódio desejado: ${found.name} (${this.formatBytes(found.length)})`);
                        } catch (e) {}
                    }
                }
            });

            const onComplete = async () => {
                if (finished) return;
                finished = true;
                if (watchdogInterval) clearInterval(watchdogInterval);
                process.stdout.write('\n');
                console.log(`✅ Download concluído e verificado com sucesso: ${targetEpisodeFile ? targetEpisodeFile.name : torrent.name}`);

                // Aguarda 1.5s para garantir que todas as peças foram gravadas e liberadas pelo sistema de arquivos
                await new Promise(r => setTimeout(r, 1500));

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

                const fullPath = path.join(this.downloadDir, selectedFile.path);
                const fileInfo = {
                    filePath: fullPath,
                    fileName: selectedFile.name,
                    sizeBytes: selectedFile.length,
                    totalTorrentFiles: torrent.files.length
                };

                safeCleanup();
                resolve(fileInfo);
            };

            torrent.on('download', () => {
                if (finished) return;

                // Se o arquivo do episódio tiver 100% de progresso verificado
                if (targetEpisodeFile && (targetEpisodeFile.progress >= 0.999 || targetEpisodeFile.done || (targetEpisodeFile.downloaded >= targetEpisodeFile.length && targetEpisodeFile.length > 0))) {
                    return onComplete();
                }

                const curTotal = targetEpisodeFile ? targetEpisodeFile.length : torrent.length;
                const verifiedBytes = targetEpisodeFile ? (targetEpisodeFile.downloaded || 0) : 0;
                const streamBytes = torrent.downloaded || 0;
                const curDownloaded = targetEpisodeFile 
                    ? Math.min(curTotal, Math.max(verifiedBytes, streamBytes))
                    : streamBytes;

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

                    // Tempo restante preciso calculado sobre o tamanho restante do episódio
                    const remainingBytes = Math.max(0, curTotal - curDownloaded);
                    const remainingSec = torrent.downloadSpeed > 0 ? Math.floor(remainingBytes / torrent.downloadSpeed) : null;
                    const remainingFormatted = remainingSec ? `~${this.formatDuration(remainingSec)}` : '--:--';

                    const logLine = `\x1b[36m📥 [DOWNLOAD: "${mediaTitle}"] [${progressBar}] ${percent}% | ${downloadedStr} / ${totalStr} | ${speedMB} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ${remainingFormatted}) | Peers: ${torrent.numPeers}\x1b[0m`;

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

            torrent.on('done', onComplete);

            torrent.on('error', (err) => {
                safeCleanup();
                reject(new Error(`Falha no download do torrent: ${err.message}`));
            });

            let lastBytes = 0;
            let stalledSeconds = 0;
            let elapsedSeconds = 0;

            watchdogInterval = setInterval(() => {
                if (finished || !torrent) return;
                elapsedSeconds += 5;
                const currentBytes = torrent.downloaded || 0;
                if (currentBytes === lastBytes) {
                    stalledSeconds += 5;
                } else {
                    stalledSeconds = 0;
                    lastBytes = currentBytes;
                }

                // 1. Aborta se estiver completamente parado por 60s no início
                if (stalledSeconds >= 60 && torrent.progress < 0.02) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent estagnado sem velocidade ativa (${torrent.numPeers} peer(s)). Abortando para tentar outra fonte...`);
                    safeCleanup();
                    return reject(new Error('Download estagnado sem dados/seeders ativos.'));
                }

                // 2. Aborta se for um torrent muito pesado com velocidade crítica (< 0.4 MB/s após 90 segundos com previsão > 45 min)
                const speedMB = torrent.downloadSpeed / (1024 * 1024);
                const remainingSec = speedMB > 0 ? (torrent.length - currentBytes) / (speedMB * 1024 * 1024) : 99999;
                
                if (elapsedSeconds >= 90 && speedMB < 0.45 && remainingSec > 2700 && torrent.progress < 0.08) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent excessivamente lento (${speedMB.toFixed(2)} MB/s, ${torrent.numPeers} peer(s), previsão: > 45 min). Abortando para buscar fonte mais rápida...`);
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
