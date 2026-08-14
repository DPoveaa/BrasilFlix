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
        this.activeTorrents = new Map();
        this.client = null;
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

    async getClient() {
        if (!this.client) {
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
            this.client = new WebTorrentClass({
                maxConns: 55,
                downloadLimit: -1,
                uploadLimit: 1024 * 50
            });
            this.client.on('error', (err) => {
                console.error('❌ Erro no cliente WebTorrent:', err.message);
            });
        }
        return this.client;
    }

    createTorrentPayload(magnetOrTorrent) {
        const trackers = [
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://open.stealth.si:80/announce',
            'udp://tracker.torrent.eu.org:451/announce',
            'udp://explodie.org:6969/announce',
            'udp://tracker.moeking.me:6969/announce'
        ];

        if (typeof magnetOrTorrent === 'string') {
            const hashMatch = magnetOrTorrent.match(/([a-fA-F0-9]{40})/);
            if (hashMatch) {
                const cleanHash = hashMatch[1].toLowerCase();
                const hashBuffer = Buffer.from(cleanHash, 'hex');
                
                // Extrai nome do torrent se houver
                const nameMatch = magnetOrTorrent.match(/dn=([^&]+)/);
                const name = nameMatch ? decodeURIComponent(nameMatch[1]) : cleanHash;

                return {
                    infoHash: cleanHash,
                    infoHashBuffer: hashBuffer,
                    name: name,
                    announce: trackers,
                    urlList: []
                };
            }
        }
        return magnetOrTorrent;
    }

    async downloadTorrent(magnetOrTorrent, onProgress = null) {
        this.ensureDirectories();
        const client = await this.getClient();
        if (!client) {
            throw new Error('Módulo WebTorrent não disponível.');
        }

        const torrentPayload = this.createTorrentPayload(magnetOrTorrent);

        return new Promise((resolve, reject) => {
            console.log('📥 Iniciando download via Torrent:', String(magnetOrTorrent).substring(0, 60) + '...');

            let torrent;
            const torrentId = `torrent_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;

            try {
                torrent = client.add(torrentPayload, { 
                    path: this.downloadDir
                });
                this.activeTorrents.set(torrentId, torrent);
            } catch (err) {
                return reject(new Error(`Falha ao adicionar torrent: ${err.message}`));
            }

            let lastProgressTime = Date.now();

            torrent.on('download', () => {
                const now = Date.now();
                if (now - lastProgressTime > 800) {
                    lastProgressTime = now;
                    const percent = (torrent.progress * 100).toFixed(1);
                    const speedMB = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                    const downloadedMB = (torrent.downloaded / (1024 * 1024)).toFixed(1);
                    const totalMB = (torrent.length / (1024 * 1024)).toFixed(1);

                    const barLength = 25;
                    const filled = Math.min(barLength, Math.round((torrent.progress) * barLength));
                    const empty = Math.max(0, barLength - filled);
                    const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

                    process.stdout.write(`\r📥 Baixando: [${progressBar}] ${percent}% | ${downloadedMB}/${totalMB} MB (${speedMB} MB/s) | Peers: ${torrent.numPeers} `);

                    if (onProgress) {
                        onProgress({
                            percent: parseFloat(percent),
                            speed: `${speedMB} MB/s`,
                            downloaded: `${downloadedMB} MB`,
                            total: `${totalMB} MB`,
                            timeRemaining: torrent.timeRemaining
                        });
                    }
                }
            });

            torrent.on('done', async () => {
                clearInterval(watchdogInterval);
                process.stdout.write('\n');
                console.log(`✅ Download do Torrent concluído: ${torrent.name}`);
                this.activeTorrents.delete(torrentId);

                let largestFile = null;
                for (const file of torrent.files) {
                    const ext = path.extname(file.name).toLowerCase();
                    if (['.mp4', '.mkv', '.avi', '.mov', '.webm'].includes(ext)) {
                        if (!largestFile || file.length > largestFile.length) {
                            largestFile = file;
                        }
                    }
                }

                if (!largestFile) {
                    largestFile = torrent.files.reduce((prev, curr) => (curr.length > prev.length ? curr : prev), torrent.files[0]);
                }

                const fullPath = path.join(this.downloadDir, largestFile.path);
                torrent.destroy();

                resolve({
                    filePath: fullPath,
                    fileName: largestFile.name,
                    sizeBytes: largestFile.length,
                    totalTorrentFiles: torrent.files.length
                });
            });

            torrent.on('error', (err) => {
                clearInterval(watchdogInterval);
                this.activeTorrents.delete(torrentId);
                reject(new Error(`Falha no download do torrent: ${err.message}`));
            });

            let lastBytes = 0;
            let stalledSeconds = 0;
            const watchdogInterval = setInterval(() => {
                const currentBytes = torrent.downloaded || 0;
                if (currentBytes === lastBytes) {
                    stalledSeconds += 5;
                } else {
                    stalledSeconds = 0;
                    lastBytes = currentBytes;
                }

                if (stalledSeconds >= 35 && torrent.progress < 0.01) {
                    clearInterval(watchdogInterval);
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent estagnado sem velocidade ativa (${torrent.numPeers} peer(s)). Abortando para não travar a fila...`);
                    torrent.destroy();
                    this.activeTorrents.delete(torrentId);
                    reject(new Error('Download estagnado sem dados/seeders ativos.'));
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
