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

    async getTempDirSizeBytes() {
        try {
            if (!fs.existsSync(this.downloadDir)) return 0;
            let total = 0;
            const walk = (dir) => {
                const files = fs.readdirSync(dir);
                for (const f of files) {
                    const full = path.join(dir, f);
                    try {
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) {
                            walk(full);
                        } else {
                            total += stat.size;
                        }
                    } catch (e) {}
                }
            };
            walk(this.downloadDir);
            return total;
        } catch (e) {
            return 0;
        }
    }

    async cleanupOrphanedFiles(maxAgeHours = 3) {
        try {
            if (!fs.existsSync(this.downloadDir)) return;
            const now = Date.now();
            const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
            const items = fs.readdirSync(this.downloadDir);
            for (const item of items) {
                const full = path.join(this.downloadDir, item);
                try {
                    const stat = fs.statSync(full);
                    if (now - stat.mtimeMs > maxAgeMs) {
                        console.log(`🧹 [Guarda de Disco] Limpando arquivo temporário órfão (> ${maxAgeHours}h): ${item}`);
                        await fs.remove(full).catch(() => {});
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    async isDiskOvercrowded() {
        const maxBytes = (config.MAX_TEMP_DISK_GB || 100) * 1024 * 1024 * 1024;
        const currentSize = await this.getTempDirSizeBytes();
        // Se ultrapassar 75% dos 100GB (~75GB), segura novos downloads para dar espaço à duplicação da transcodificação
        return currentSize >= maxBytes * 0.75;
    }

    async ensureDiskSpace(estimatedSizeBytes = 0) {
        const maxGB = config.MAX_TEMP_DISK_GB || 100;
        const maxBytes = maxGB * 1024 * 1024 * 1024;
        // Considera margem de segurança para duplicação do vídeo durante a transcodificação FFmpeg (raw + opt)
        const safetyMarginBytes = Math.max(estimatedSizeBytes * 2, 8 * 1024 * 1024 * 1024);

        let currentSize = await this.getTempDirSizeBytes();
        if (currentSize + safetyMarginBytes >= maxBytes * 0.75) {
            console.log(`⚠️ [Guarda de Disco] Pasta temporária em ${this.formatBytes(currentSize)} (margem de duplicação: ${this.formatBytes(safetyMarginBytes)}, limite: ${maxGB} GB). Executando limpeza automática...`);
            await this.cleanupOrphanedFiles(1);
            currentSize = await this.getTempDirSizeBytes();
        }

        while (currentSize + safetyMarginBytes >= maxBytes * 0.85) {
            console.warn(`🚨 [Guarda de Disco] Espaço em disco temporário próximo ao limite (${this.formatBytes(currentSize)} / ${maxGB} GB). Aguardando liberação de espaço por uploads concluídos...`);
            await new Promise(r => setTimeout(r, 6000));
            currentSize = await this.getTempDirSizeBytes();
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

    findEpisodeFileInTorrent(files, season, episode) {
        if (!files || files.length === 0) return null;
        const seasonNum = parseInt(season || 1, 10);
        const epNum = parseInt(episode || 1, 10);
        const sPad2 = String(seasonNum).padStart(2, '0');
        const epPad2 = String(epNum).padStart(2, '0');
        const epPad3 = String(epNum).padStart(3, '0');

        const videoFiles = files.filter(f => {
            const ext = path.extname(f.name).toLowerCase();
            return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext);
        });

        if (videoFiles.length === 0) return null;
        if (videoFiles.length === 1) return videoFiles[0];

        // 1. Padrões estritos de Temporada + Episódio (S01E01, S1E1, 1x01, T01E01, Season 1 Episode 1)
        const strictPatterns = [
            new RegExp(`s0*${seasonNum}[._ -]*e0*${epNum}(?:v\\d+)?(?:\\D|$)`, 'i'),
            new RegExp(`s${sPad2}[._ -]*e${epPad2}(?:\\D|$)`, 'i'),
            new RegExp(`\\b${seasonNum}x0*${epNum}\\b`, 'i'),
            new RegExp(`\\bt0*${seasonNum}[._ -]*e0*${epNum}\\b`, 'i'),
            new RegExp(`(?:season|temporada)[._ -]*0*${seasonNum}[._ -]+(?:episode|episodio|ep|e)[._ -]*0*${epNum}\\b`, 'i')
        ];

        for (const regex of strictPatterns) {
            const match = videoFiles.find(f => regex.test(f.name) || regex.test(f.path));
            if (match) return match;
        }

        // 2. Padrão de Faixa/Multi-episódio (ex: S01E01-E05, onde epNum está dentro do intervalo)
        const rangeMatch = videoFiles.find(f => {
            const str = `${f.path} ${f.name}`;
            const m = str.match(new RegExp(`s0*${seasonNum}[._ -]*e0*(\\d+)[._ -]*(?:-|~|a|e|to)[._ -]*e?0*(\\d+)`, 'i'));
            if (m) {
                const start = parseInt(m[1], 10);
                const end = parseInt(m[2], 10);
                if (epNum >= start && epNum <= end) return true;
            }
            return false;
        });
        if (rangeMatch) return rangeMatch;

        // 3. Padrão por pasta da temporada (ex: pasta "Season 1/" ou "S01/" contendo arquivos "01.mkv" ou "Ep.1.mp4")
        const seasonFolderRegex = new RegExp(`(?:season|temporada|s)[._ -]*0*${seasonNum}(?:[\\\\/]|$)`, 'i');
        const seasonFolderFiles = videoFiles.filter(f => seasonFolderRegex.test(f.path));
        if (seasonFolderFiles.length > 0) {
            const epInFolderPatterns = [
                new RegExp(`\\b(?:ep|e|episodio|episode)[._ -]*0*${epNum}\\b`, 'i'),
                new RegExp(`\\b${epPad2}\\b`),
                new RegExp(`\\b0*${epNum}\\b`)
            ];
            for (const regex of epInFolderPatterns) {
                const match = seasonFolderFiles.find(f => regex.test(f.name));
                if (match) return match;
            }
        }

        // 4. Animes e Séries sem temporada no nome do arquivo (ex: "Bleach - 01", "Bleach 001", "01.mkv", "Episodio 01")
        const cleanName = (str) => {
            return str
                .replace(/\b(1080p|720p|2160p|4k|x264|x265|hevc|aac|10bit|dual|dublado|legendado)\b/gi, '')
                .replace(/\b(19\d{2}|20\d{2})\b/g, '')
                .replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ');
        };

        const animePatterns = [
            new RegExp(`(?:ep|episodio|episode|e)[._ -]*0*${epNum}(?:\\D|$)`, 'i'),
            new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
            new RegExp(`(?:^|[._ -])0*${epPad2}(?:[._ -]|$)`),
            new RegExp(`(?:^|[._ -])0*${epPad3}(?:[._ -]|$)`),
            new RegExp(`\\b${epNum}\\b`)
        ];

        for (const regex of animePatterns) {
            const match = videoFiles.find(f => regex.test(cleanName(f.name)));
            if (match) return match;
        }

        // 5. Fallback por ordenação alfanumérica se a lista tiver exatamente os episódios indexados
        const sortedFiles = [...videoFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (sortedFiles.length >= epNum && epNum > 0) {
            return sortedFiles[epNum - 1];
        }

        return videoFiles[0];
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
        await this.ensureDiskSpace();
        const WT = await this.getWebTorrentClass();
        if (!WT) {
            throw new Error('Módulo WebTorrent não disponível.');
        }

        let torrentTarget = magnetOrTorrent;
        if (typeof magnetOrTorrent === 'string' && !magnetOrTorrent.startsWith('magnet:') && !magnetOrTorrent.startsWith('http')) {
            const hashMatch = magnetOrTorrent.match(/([a-fA-F0-9]{40})/);
            if (hashMatch) {
                torrentTarget = `magnet:?xt=urn:btih:${hashMatch[1].toLowerCase()}`;
            }
        }

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
            'udp://tracker.coppersurfer.tk:6969/announce',
            'udp://tracker.leechers-paradise.org:6969/announce',
            'udp://tracker.internetwarriors.net:1337/announce',
            'udp://exodus.desync.com:6969/announce',
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.btorrent.xyz',
            'wss://tracker.files.fm:7073/announce'
        ];

        if (typeof torrentTarget === 'string' && torrentTarget.startsWith('magnet:')) {
            for (const tr of trackers) {
                if (!torrentTarget.includes(encodeURIComponent(tr)) && !torrentTarget.includes(tr)) {
                    torrentTarget += `&tr=${encodeURIComponent(tr)}`;
                }
            }
        }

        const isSerie = options.type === 'serie' || (options.season && options.episode && options.type !== 'filme');
        const displayTitle = isSerie
            ? `${mediaTitle} (T${options.season || 1}E${options.episode || 1})` 
            : mediaTitle;

        const audioBadge = options.audio ? (options.audio.includes('Dublado') ? '🔊 Dublado' : '💬 Legendado') : (options.audioPreference === 'legendado' ? '💬 Legendado' : '🔊 Dublado');
        return new Promise((resolve, reject) => {
            console.log(`📥 Iniciando download via Torrent: "${displayTitle}" [${audioBadge}] [Hash: ${String(torrentTarget).substring(0, 15)}...]`);

            // Instância otimizada: alta velocidade de download mantendo controle de recursos
            const client = new WT({
                maxConns: 80, // Permite conexão com até 80 peers para velocidade máxima de download
                dht: {
                    bootstrap: [
                        'router.bittorrent.com:6881',
                        'dht.transmissionbt.com:6881',
                        'router.utorrent.com:6881',
                        'dht.libtorrent.org:25401',
                        'dht.aelitis.com:6881'
                    ]
                },
                tracker: true,
                downloadLimit: -1,
                uploadLimit: 1024 * 500 // Permite 500 KB/s durante o download para troca de handshakes P2P (destruído na hora ao concluir)
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

            torrent.on('wire', (wire, addr) => {
                const pAddr = typeof addr === 'string' ? addr : (wire.remoteAddress || 'peer');
                console.log(`🔗 [Swarm Torrent: "${displayTitle}"] Peer conectado (${pAddr}). Solicitando blocos de dados... (Peers ativos: ${torrent.numPeers})`);
            });

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

                    // Desmarca o torrent inteiro para NÃO puxar blocos de outros episódios
                    try {
                        torrent.deselect(0, torrent.pieces.length - 1, false);
                        torrent.files.forEach(f => {
                            try { f.deselect(); } catch (e) {}
                        });
                    } catch (e) {}

                    const found = this.findEpisodeFileInTorrent(torrent.files, seasonNum, epNum);
                    if (found) {
                        targetEpisodeFile = found;
                        try {
                            found.select();
                            found.on('done', () => checkAndComplete());
                            console.log(`🎯 [Multi-Pack] Otimização: baixando SOMENTE o episódio solicitado: ${found.name} (${this.formatBytes(found.length)})`);
                        } catch (e) {
                            console.warn('⚠️ Erro ao selecionar arquivo alvo no pack:', e.message);
                        }
                    } else {
                        console.log(`ℹ️ [Multi-Pack] Nenhum arquivo avulso isolado para S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}. Baixando arquivos de vídeo.`);
                        const videoFiles = torrent.files.filter(f => {
                            const ext = path.extname(f.name).toLowerCase();
                            return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext);
                        });
                        videoFiles.forEach(vf => {
                            try { vf.select(); } catch (e) {}
                        });
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
                    const videoInfo = await VideoProcessor.getVideoInfo(fullPath).catch(() => null);
                    if (!videoInfo || !videoInfo.duration || videoInfo.duration <= 0) {
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
                    const audioBadge = options.audio ? (options.audio.includes('Dublado') ? '🔊 Dublado' : '💬 Legendado') : (options.audioPreference === 'legendado' ? '💬 Legendado' : '🔊 Dublado');

                    const logLine = `\x1b[36m📥 [DOWNLOAD: "${displayTitle}"] [${audioBadge}] [${progressBar}] ${percent}% | ${downloadedStr} / ${totalStr} | ${speedMB} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ${remainingFormatted}) | Peers: ${torrent.numPeers}\x1b[0m`;

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

                const isDub = options.audioPreference === 'dublado' || options.isDublado || (options.audio && options.audio.includes('Dublado'));
                const noPeerTimeoutMs = isDub ? 120000 : 90000; // 120s (2 min) de persistência para conectar em peers e puxar peças
                const stalledTimeoutMs = isDub ? 180000 : 120000; // 3 min sem tráfego

                // Log em tempo real a cada 6s enquanto tenta conectar e receber blocos
                if (now - lastLogTime >= 6000 && torrent.progress < 0.01) {
                    lastLogTime = now;
                    const elapsed = Math.floor((now - downloadStartTime) / 1000);
                    const speed = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                    console.log(`⏳ [TENTANDO DOWNLOAD: "${displayTitle}"] Solicitando blocos no swarm | Peers conectados: ${torrent.numPeers} | Vel: ${speed} MB/s | Tempo: ${elapsed}s / limite: ${Math.round(noPeerTimeoutMs / 1000)}s`);
                }

                // 1. Aborta se estiver sem nenhum peer conectado após o tempo limite
                if (torrent.numPeers === 0 && stalledMs >= noPeerTimeoutMs && torrent.progress < 0.01) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent sem peers ativos (0 peers após ${Math.round(noPeerTimeoutMs / 1000)}s). Abortando para tentar outra fonte...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Torrent sem peers ativos após ${Math.round(noPeerTimeoutMs / 1000)}s.`));
                }

                // 2. Aborta se estiver completamente estagnado por 2.5 min (com peers mas sem envio de dados)
                if (stalledMs >= stalledTimeoutMs && torrent.progress < 0.01) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent estagnado sem velocidade ativa (${torrent.numPeers} peer(s), estagnado por ${Math.round(stalledMs / 1000)}s). Abortando para tentar outra fonte...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Download estagnado sem dados/seeders ativos após ${Math.round(stalledTimeoutMs / 1000)}s.`));
                }

                // 3. Fast-Fail & Pula Rápido: Se houver outras fontes disponíveis na lista e esta fonte estiver lenta (< 1.5 MB/s após 45s)
                const speedMB = torrent.downloadSpeed / (1024 * 1024);
                const hasMoreSources = options.attemptIndex !== undefined && options.totalAttempts !== undefined && (options.attemptIndex < options.totalAttempts - 1);
                const minSpeed = config.MIN_DOWNLOAD_SPEED_MB || 1.5;

                if (elapsedSec >= 45 && speedMB < minSpeed && hasMoreSources && torrent.progress < 0.15) {
                    process.stdout.write('\n');
                    console.log(`⏩ [WATCHDOG VELOCIDADE] Fonte lenta (${speedMB.toFixed(2)} MB/s < ${minSpeed} MB/s após ${elapsedSec}s). Pulando para tentar próxima fonte da lista (${options.attemptIndex + 2}/${options.totalAttempts})...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Velocidade lenta (${speedMB.toFixed(2)} MB/s). Pulando para próxima fonte.`));
                }

                // 4. Se for a última fonte disponível (ou única), permite download paciente até 20-30 min
                const remainingSec = speedMB > 0 ? (torrent.length - currentBytes) / (speedMB * 1024 * 1024) : 99999;
                if (elapsedSec >= 600 && speedMB < 0.05 && remainingSec > 7200 && torrent.progress < 0.05) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent excessivamente lento (${speedMB.toFixed(2)} MB/s, ${torrent.numPeers} peer(s), previsão: > 120 min após 10 min de tentativa). Abortando...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error('Torrent com velocidade insuficiente após 10 min.'));
                }
            }, 5000);
        });
    }

    async downloadHttp(url, fileName, onProgress = null) {
        this.ensureDirectories();
        await this.ensureDiskSpace();
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
