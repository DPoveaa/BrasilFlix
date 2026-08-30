const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const EventEmitter = require('events');
const config = require('../../config');
const VideoProcessor = require('./VideoProcessor');
const SchedulerService = require('./SchedulerService');

let WebTorrentClass = null;


class DownloaderManager extends EventEmitter {
    constructor() {
        super();
        this.downloadDir = path.resolve(config.DOWNLOAD_DIR || './downloads/temp');
        this.activeDownloads = new Map(); // key: jobId -> { cancel: Function }
        this.activePaths = new Set();
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

    async cleanupOrphanedFiles(maxAgeHours = 24) {
        try {
            if (!fs.existsSync(this.downloadDir)) return;
            const now = Date.now();
            const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
            const items = fs.readdirSync(this.downloadDir);
            for (const item of items) {
                const full = path.join(this.downloadDir, item);
                // Proteção: Nunca limpa arquivos ou pastas que pertençam a um download em andamento
                let isItemActive = false;
                for (const activeP of this.activePaths) {
                    if (full === activeP || full.startsWith(activeP + path.sep) || activeP.startsWith(full + path.sep)) {
                        isItemActive = true;
                        break;
                    }
                }
                if (isItemActive) continue;

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

    isEpisodeFileMatch(file, season, episode) {
        if (!file || (!file.name && !file.path)) return false;
        const seasonNum = parseInt(season || 1, 10);
        const epNum = parseInt(episode || 1, 10);
        const sPad2 = String(seasonNum).padStart(2, '0');
        const epPad2 = String(epNum).padStart(2, '0');

        const filePath = `${file.path || ''} ${file.name || ''}`;

        // 1. Padrões estritos de Temporada + Episódio (S01E01, S1E1, 1x01, T01E01, Season 1 Episode 1)
        const strictPatterns = [
            new RegExp(`s0*${seasonNum}[._ -]*e0*${epNum}(?:v\\d+)?(?:\\D|$)`, 'i'),
            new RegExp(`s${sPad2}[._ -]*e${epPad2}(?:\\D|$)`, 'i'),
            new RegExp(`\\b${seasonNum}x0*${epNum}\\b`, 'i'),
            new RegExp(`\\bt0*${seasonNum}[._ -]*e0*${epNum}\\b`, 'i'),
            new RegExp(`(?:season|temporada)[._ -]*0*${seasonNum}[._ -]+(?:episode|episodio|ep|e)[._ -]*0*${epNum}\\b`, 'i')
        ];

        for (const regex of strictPatterns) {
            if (regex.test(filePath)) return true;
        }

        // 2. Padrão de Faixa/Multi-episódio (ex: S01E01-E05)
        const rangeMatch = filePath.match(new RegExp(`s0*${seasonNum}[._ -]*e0*(\\d+)[._ -]*(?:-|~|a|e|to)[._ -]*e?0*(\\d+)`, 'i'));
        if (rangeMatch) {
            const start = parseInt(rangeMatch[1], 10);
            const end = parseInt(rangeMatch[2], 10);
            if (epNum >= start && epNum <= end) return true;
        }

        // 3. Padrão por pasta de temporada específica (ex: Season 2/01.mkv)
        const seasonFolderRegex = new RegExp(`(?:season|temporada|s)[._ -]*0*${seasonNum}(?:[\\\\/]|$)`, 'i');
        if (seasonFolderRegex.test(file.path || '')) {
            const epPatterns = [
                new RegExp(`\\b(?:ep|e|episodio|episode)[._ -]*0*${epNum}\\b`, 'i'),
                new RegExp(`\\b${epPad2}\\b`),
                new RegExp(`\\b0*${epNum}\\b`)
            ];
            for (const regex of epPatterns) {
                if (regex.test(file.name || '')) return true;
            }
        }

        return false;
    }

    findEpisodeFileInTorrent(files, season, episode) {
        if (!files || files.length === 0) return null;
        const seasonNum = parseInt(season || 1, 10);
        const epNum = parseInt(episode || 1, 10);
        const sPad2 = String(seasonNum).padStart(2, '0');
        const epPad2 = String(epNum).padStart(2, '0');
        const epPad3 = String(epNum).padStart(3, '0');

        const isSampleOrPromoFile = (f) => {
            const ext = path.extname(f.name || '').toLowerCase();
            const fullPath = (f.path ? `${f.path}/${f.name}` : (f.name || '')).toLowerCase();
            const isPromo = /\b(sample|amostra|trailer|teaser|promo|promocao|1xbet|mostbet|bet\b|cassino|casino|dinheiro[._-]?livre|ganhe[._-]?dinheiro|bonus|extras?|featurettes?|behind[._-]?the[._-]?scenes|deleted[._-]?scenes|interview|gag[._-]?reel|b-roll|making[._-]?of|specials?|bonus[._-]?features?|clips?|preview|opening|ending|ncop|nced)\b/i.test(fullPath);
            return !['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext) || isPromo;
        };

        const videoFiles = files.filter(f => !isSampleOrPromoFile(f));

        if (videoFiles.length === 0) return null;

        // Se houver apenas 1 arquivo de vídeo no torrent:
        if (videoFiles.length === 1) {
            const single = videoFiles[0];
            const clean = single.name
                .replace(/\b(1080p|720p|480p|2160p|4k|x264|x265|hevc|aac|10bit|dual|dublado|legendado)\b/gi, '')
                .replace(/\b(19\d{2}|20\d{2})\b/g, '');

            // 1. Verifica se a temporada é divergente (ex: S02E01 quando buscamos S01E01)
            const seasonMatch = clean.match(/s0*(\d{1,2})[._ -]*e/i) || clean.match(/\b(\d{1,2})x\d{1,3}\b/i) || clean.match(/(?:season|temporada)[._ -]*0*(\d{1,2})/i);
            if (seasonMatch) {
                const foundSeason = parseInt(seasonMatch[1], 10);
                if (foundSeason !== seasonNum) {
                    console.warn(`⚠️ [Download] Arquivo único de vídeo "${single.name}" é da Temporada ${foundSeason}, mas solicitamos a Temporada ${seasonNum}. Rejeitando.`);
                    return null;
                }
            } else if (seasonNum > 1) {
                // Se buscamos Temporada > 1 e o arquivo único não indica nenhuma temporada, rejeita para evitar usar T1 como T2/T3/T4
                console.warn(`⚠️ [Download] Arquivo único "${single.name}" sem identificação de temporada ao buscar Temporada ${seasonNum}. Rejeitando.`);
                return null;
            }

            // 2. Verifica se o episódio é divergente (ex: One Piece 892.mkv quando buscamos 3)
            const otherEpMatch = clean.match(/(?:s\d+[._ -]*)?e0*(\d{1,4})\b/i) || clean.match(/(?:^|[._ -])(?:-\s*)?0*(\d{2,4})(?:[._ -]|$)/);
            if (otherEpMatch) {
                const foundEp = parseInt(otherEpMatch[1], 10);
                if (foundEp !== epNum && foundEp < 1900 && foundEp !== 1080 && foundEp !== 720) {
                    console.warn(`⚠️ [Download] Arquivo único de vídeo "${single.name}" é o episódio ${foundEp}, mas solicitamos ${epNum}. Rejeitando.`);
                    return null;
                }
            }
            return single;
        }


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

        // 4. Animes e Séries sem temporada no nome do arquivo (Apenas válido se for Temporada 1)
        if (seasonNum === 1) {
            const cleanName = (str) => {
                return str
                    .replace(/\b(1080p|720p|2160p|4k|x264|x265|hevc|aac|10bit|dual|dublado|legendado)\b/gi, '')
                    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
                    .replace(/\[[^\]]*\]|\([^\)]*\)/g, ' ');
            };

            const animePatterns = [
                new RegExp(`(?:ep|episodio|episode|e)[._ -]*0*${epNum}(?:\\D|$)`, 'i'),
                new RegExp(`[._ -]0*${epNum}[._ -]`, 'i'),
                new RegExp(`(?:^|[._ -])(?:-\\s*)?0*${epPad2}(?:[._ -]|$)`),
                new RegExp(`(?:^|[._ -])(?:-\\s*)?0*${epPad3}(?:[._ -]|$)`),
                new RegExp(`(?:^|[._ -])(?:-\\s*)?0*${epNum}(?:[._ -]|$)`)
            ];

            for (const regex of animePatterns) {
                const match = videoFiles.find(f => regex.test(cleanName(f.name)));
                if (match) {
                    // Verifica se o arquivo não possui marcação explícita de OUTRA temporada
                    const otherSeasonMatch = match.name.match(/s0*(\d{1,2})[._ -]*e/i) || match.name.match(/\b(\d{1,2})x\d{1,3}\b/i) || match.path.match(/(?:season|temporada)[._ -]*0*(\d{1,2})/i);
                    if (otherSeasonMatch && parseInt(otherSeasonMatch[1], 10) !== 1) continue;
                    return match;
                }
            }
        }

        // Não aceita arquivo aleatório se o episódio não existir no pack!
        return null;
    }

    mapAllEpisodeFilesInTorrent(files, season, maxEps = 50) {
        if (!files || files.length === 0) return {};
        const seasonNum = parseInt(season || 1, 10);
        const isSampleOrPromoFile = (f) => {
            const ext = path.extname(f.name || '').toLowerCase();
            const fullPath = (f.path ? `${f.path}/${f.name}` : (f.name || '')).toLowerCase();
            const isPromo = /\b(sample|amostra|trailer|teaser|promo|promocao|1xbet|mostbet|bet\b|cassino|casino|dinheiro[._-]?livre|ganhe[._-]?dinheiro|bonus|extras?|featurettes?|behind[._-]?the[._-]?scenes|deleted[._-]?scenes|interview|gag[._-]?reel|b-roll|making[._-]?of|specials?|bonus[._-]?features?|clips?|preview|opening|ending|ncop|nced)\b/i.test(fullPath);
            return !['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext) || isPromo;
        };

        const videoFiles = files.filter(f => !isSampleOrPromoFile(f));

        const epMap = {};
        const usedPaths = new Set();

        for (let ep = 1; ep <= maxEps; ep++) {
            const found = this.findEpisodeFileInTorrent(videoFiles, seasonNum, ep);
            if (found && !usedPaths.has(found.path)) {
                // Evita que arquivos com faixas múltiplas ou nomes genéricos ocupem múltiplos episódios se for arquivo único
                usedPaths.add(found.path);
                epMap[ep] = found;
            }
        }
        return epMap;
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
            'wss://tracker.openwebtorrent.com',
            'wss://tracker.btorrent.xyz'
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

        const getAudioBadge = (opts) => {
            const isDub = opts.isDublado || (opts.audio && (opts.audio.includes('Dublado') || opts.audio.includes('Dual')));
            const isLeg = opts.isLegendado || (opts.audio && opts.audio.includes('Legendado')) || opts.audioPreference === 'legendado';
            if (isDub && isLeg) return '🔊 Dublado & 💬 Legendado';
            if (isDub) return '🔊 Dublado';
            if (isLeg) return '💬 Legendado';
            return opts.audioPreference === 'legendado' ? '💬 Legendado' : '🔊 Dublado';
        };

        const audioBadge = getAudioBadge(options);
        return new Promise((resolve, reject) => {
            console.log(`📥 Iniciando download via Torrent: "${displayTitle}" [${audioBadge}] [Hash: ${String(torrentTarget).substring(0, 15)}...]`);

            // Instância otimizada com QoS Residencial: Zero impacto na rede doméstica / Wi-Fi
            const isEcoMode = options.mode === 'eco' || SchedulerService.getActiveMode() === 'eco';
            const maxPeerConns = isEcoMode ? 12 : (config.MAX_TORRENT_PEER_CONNECTIONS || 35);
            const maxUploadBytes = isEcoMode ? ((config.ECO_UPLOAD_LIMIT_KB || 30) * 1024) : ((config.MAX_TORRENT_UPLOAD_LIMIT_KB || 250) * 1024);
            const downloadLimitBytes = isEcoMode ? Math.round((config.ECO_DOWNLOAD_LIMIT_MB || 3.0) * 1024 * 1024) : -1;

            console.log(`📡 [QoS Rede] Modo: ${isEcoMode ? '🍃 ECONÔMICO (DHT Desativado, Teto: ' + (config.ECO_DOWNLOAD_LIMIT_MB || 3.0) + ' MB/s, Max Conns: ' + maxPeerConns + ')' : '⚡ DESEMPENHO (Sem Limite)'}`);

            const client = new WT({
                maxConns: maxPeerConns, // Limite estrito (12 no eco para proteger a tabela NAT do roteador)
                dht: isEcoMode ? false : {
                    bootstrap: [
                        'router.bittorrent.com:6881',
                        'dht.transmissionbt.com:6881',
                        'router.utorrent.com:6881'
                    ]
                },
                tracker: true,
                downloadLimit: downloadLimitBytes, // Limite estrito de download no modo eco para evitar saturação e bufferbloat
                uploadLimit: maxUploadBytes // Limite estrito de upload P2P para não consumir upstream da casa
            });




            let torrent = null;
            let watchdogInterval = null;
            let finished = false;
            let activeFolderPath = null;

            const safeCleanup = () => {
                if (options.jobId && this.activeDownloads) {
                    this.activeDownloads.delete(options.jobId);
                }
                if (activeFolderPath && this.activePaths) {
                    this.activePaths.delete(activeFolderPath);
                }
                if (watchdogInterval) {
                    clearInterval(watchdogInterval);
                    watchdogInterval = null;
                }
                try {
                    if (torrent) {
                        torrent.removeAllListeners();
                        try { torrent.destroy(() => {}); } catch (e) {}
                    }
                    client.destroy(() => {});
                } catch (e) {
                    console.warn('⚠️ Aviso ao finalizar cliente WebTorrent:', e.message);
                }
            };

            if (options.jobId && this.activeDownloads) {
                this.activeDownloads.set(options.jobId, {
                    cancel: () => {
                        finished = true;
                        safeCleanup();
                        reject(new Error('DOWNLOAD_CANCELLED'));
                    }
                });
            }

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
            const downloadStartTime = Date.now();
            let targetEpisodeFile = null;


            torrent.on('wire', (wire, addr) => {
                const pAddr = typeof addr === 'string' ? addr : (wire.remoteAddress || 'peer');
                console.log(`🔗 [Swarm Torrent: "${displayTitle}"] Peer conectado (${pAddr}). Solicitando blocos de dados... (Peers ativos: ${torrent.numPeers})`);
            });

            let isSeasonPack = false;
            let detectedEpisodeMap = {};
            const seasonNum = parseInt(options.season || 1, 10);
            const epNum = options.episode ? parseInt(options.episode, 10) : null;

            torrent.on('metadata', async () => {
                if (torrent.name) {
                    activeFolderPath = path.join(this.downloadDir, torrent.name);
                    this.activePaths.add(activeFolderPath);
                }

                // Proteção contra arquivos gigantes (4K / 20GB): aborta na hora para filmes
                if (!options.episode && torrent.length > 5.8 * 1024 * 1024 * 1024) {
                    console.log(`⚠️ Arquivo de filme muito pesado (${this.formatBytes(torrent.length)} > 5.5 GB). Abortando para priorizar 1080p leve...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Arquivo excede o limite de tamanho para filmes 1080p (${this.formatBytes(torrent.length)}).`));
                }

                const isMicrodrama = options.isMicrodrama || options.is_microdrama || (options.runtime && options.runtime < 5);
                const isAnime = options.isAnime || options.is_anime;
                const minAllowedBytes = isMicrodrama ? (12 * 1024 * 1024) : (isAnime ? (75 * 1024 * 1024) : (options.episode ? (180 * 1024 * 1024) : (350 * 1024 * 1024)));

                // Proteção contra arquivos únicos muito pequenos (amostras/fakes de 10-60MB)
                if (torrent.files.length === 1 && torrent.files[0].length < minAllowedBytes) {
                    console.warn(`❌ [DOWNLOAD] Torrent "${torrent.name}" descartado: arquivo único de tamanho insuficiente (${this.formatBytes(torrent.files[0].length)} < ${this.formatBytes(minAllowedBytes)}). Trata-se de uma amostra/fake.`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Arquivo com tamanho físico insuficiente (${this.formatBytes(torrent.files[0].length)}). Amostra/Fake descartado.`));
                }

                if (options.episode && torrent.files && torrent.files.length > 1) {
                    // Mapeia todos os episódios disponíveis no torrent
                    detectedEpisodeMap = this.mapAllEpisodeFilesInTorrent(torrent.files, seasonNum);
                    const matchedCount = Object.keys(detectedEpisodeMap).length;

                    // Desmarca o torrent inteiro e todos os arquivos preventivamente
                    try {
                        torrent.deselect(0, torrent.pieces.length - 1, false);
                        torrent.files.forEach(f => {
                            try { f.deselect(); } catch (e) {}
                        });
                    } catch (e) {}

                    // Determina quais episódios mapeados precisam ser baixados (faltantes/inválidos no catálogo)
                    const neededEpisodesMap = {};
                    for (const [epKey, fileObj] of Object.entries(detectedEpisodeMap)) {
                        const epNumber = parseInt(epKey, 10);
                        let isMissing = false;
                        if (typeof options.isEpisodeMissing === 'function') {
                            isMissing = options.isEpisodeMissing(epNumber);
                        } else if (Array.isArray(options.missingEpisodes)) {
                            isMissing = options.missingEpisodes.includes(epNumber);
                        } else {
                            // Se não informado, apenas o episódio do job é considerado pendente
                            isMissing = (epNumber === epNum);
                        }

                        // O episódio solicitado explicitamente pelo job sempre é incluído como necessário
                        if (epNumber === epNum) {
                            isMissing = true;
                        }

                        if (isMissing && (fileObj.length >= minAllowedBytes)) {
                            neededEpisodesMap[epNumber] = fileObj;
                        }
                    }

                    const neededCount = Object.keys(neededEpisodesMap).length;
                    const neededTotalBytes = Object.values(neededEpisodesMap).reduce((acc, f) => acc + (f.length || 0), 0);

                    // Trava estrita de disco (100GB máximo):
                    const maxPackBytes = (config.MAX_PACK_DISK_GB || 40) * 1024 * 1024 * 1024;
                    const maxDiskBytes = (config.MAX_TEMP_DISK_GB || 100) * 1024 * 1024 * 1024;
                    const currentTempBytes = await this.getTempDirSizeBytes().catch(() => 0);
                    const isSafeToDownloadSelected = neededTotalBytes <= maxPackBytes && (currentTempBytes + neededTotalBytes * 1.3 <= maxDiskBytes * 0.75);

                    if (neededCount > 0 && isSafeToDownloadSelected) {
                        // Seleciona APENAS os arquivos correspondentes aos episódios faltantes/necessários
                        for (const [neededEpStr, neededFile] of Object.entries(neededEpisodesMap)) {
                            try {
                                neededFile.select();
                                neededFile.on('done', () => checkAndComplete());
                            } catch (e) {}
                        }

                        targetEpisodeFile = neededEpisodesMap[epNum] || this.findEpisodeFileInTorrent(torrent.files, seasonNum, epNum);

                        if (neededCount === 1) {
                            const singleFile = Object.values(neededEpisodesMap)[0];
                            console.log(`🎯 [Episódio Avulso Seletivo] Baixando SOMENTE o episódio ${epNum} do Season Pack: ${singleFile.name} (${this.formatBytes(singleFile.length)}) [Total no Pack: ${matchedCount} eps]`);
                            isSeasonPack = false;
                            detectedEpisodeMap = neededEpisodesMap;
                        } else {
                            const neededEpNums = Object.keys(neededEpisodesMap).sort((a, b) => Number(a) - Number(b));
                            console.log(`📦 [SEASON PACK SELETIVO] Baixando ${neededCount} episódios pendentes (Eps: ${neededEpNums.join(', ')}) no SSD (${this.formatBytes(neededTotalBytes)}) de um total de ${matchedCount} episódios do pack.`);
                            isSeasonPack = true;
                            detectedEpisodeMap = neededEpisodesMap;
                        }
                    } else {
                        // Se não for seguro baixar múltiplos ou neededCount for 0, baixa SOMENTE o episódio alvo do job
                        const found = neededEpisodesMap[epNum] || detectedEpisodeMap[epNum] || this.findEpisodeFileInTorrent(torrent.files, seasonNum, epNum);
                        if (found) {
                            if (found.length < minAllowedBytes) {
                                console.warn(`❌ [DOWNLOAD] Arquivo "${found.name}" descartado: tamanho físico insuficiente (${this.formatBytes(found.length)} < ${this.formatBytes(minAllowedBytes)}).`);
                                finished = true;
                                safeCleanup();
                                return reject(new Error(`Arquivo com tamanho físico insuficiente (${this.formatBytes(found.length)}). Amostra/Fake descartado.`));
                            }
                            targetEpisodeFile = found;
                            try {
                                found.select();
                                found.on('done', () => checkAndComplete());
                                console.log(`🎯 [Episódio Avulso] Baixando somente o episódio ${epNum}: ${found.name} (${this.formatBytes(found.length)})`);
                            } catch (e) {
                                console.warn('⚠️ Erro ao selecionar arquivo alvo no pack:', e.message);
                            }
                            isSeasonPack = false;
                            detectedEpisodeMap = { [epNum]: found };
                        } else {
                            console.log(`ℹ️ [Multi-Pack] Nenhum arquivo avulso isolado para S${String(seasonNum).padStart(2, '0')}E${String(epNum).padStart(2, '0')}. Baixando arquivos de vídeo.`);
                            const videoFiles = torrent.files.filter(f => {
                                const ext = path.extname(f.name).toLowerCase();
                                return ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.ts'].includes(ext) && (f.length >= minAllowedBytes);
                            });
                            videoFiles.forEach(vf => {
                                try { vf.select(); } catch (e) {}
                            });
                        }
                    }
                }
            });

            let isCompleting = false;
            let completionRetries = 0;
            const maxCompletionRetries = 10;

            const checkAndComplete = async () => {
                if (finished || isCompleting) return;
                isCompleting = true;

                try {
                    let selectedFile = targetEpisodeFile;
                    if (!selectedFile && isSerie) {
                        selectedFile = this.findEpisodeFileInTorrent(torrent.files, options.season, options.episode);
                    }

                    if (!selectedFile && isSerie) {
                        console.warn(`❌ [DOWNLOAD] Episódio S${options.season || 1}E${options.episode || 1} não localizado entre os arquivos do torrent "${torrent.name}".`);
                        finished = true;
                        safeCleanup();
                        return reject(new Error(`Episódio ${options.episode} não localizado na estrutura de arquivos do torrent.`));
                    }

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
                        finished = true;
                        safeCleanup();
                        return reject(new Error('Nenhum arquivo selecionável encontrado no torrent.'));
                    }

                    const fullPath = path.join(this.downloadDir, selectedFile.path);

                    // 1. Verificação de existência do arquivo físico
                    if (!fs.existsSync(fullPath)) {
                        completionRetries++;
                        const isDoneTorrent = (torrent.progress >= 0.999 || torrent.done);
                        if (isDoneTorrent && completionRetries >= maxCompletionRetries) {
                            console.warn(`❌ [DOWNLOAD] Arquivo físico não encontrado após download 100%: ${fullPath}`);
                            finished = true;
                            safeCleanup();
                            return reject(new Error(`Arquivo de download não encontrado no disco (${selectedFile.name}).`));
                        }
                        isCompleting = false;
                        return;
                    }

                    // 2. Verificação de tamanho do arquivo em disco
                    const stat = fs.statSync(fullPath);
                    const expectedSize = selectedFile.length;

                    // Permite margem de 95% caso WebTorrent tenha finalizado
                    const minAllowedSize = Math.floor(expectedSize * 0.95);
                    if (expectedSize > 0 && stat.size < minAllowedSize) {
                        completionRetries++;
                        const isDoneTorrent = (torrent.progress >= 0.999 || torrent.done);
                        if (isDoneTorrent && completionRetries >= maxCompletionRetries) {
                            console.warn(`❌ [DOWNLOAD] Arquivo incompleto em disco (${this.formatBytes(stat.size)} de ${this.formatBytes(expectedSize)}).`);
                            finished = true;
                            safeCleanup();
                            return reject(new Error(`Arquivo incompleto no disco (${this.formatBytes(stat.size)} de ${this.formatBytes(expectedSize)}).`));
                        }
                        isCompleting = false;
                        return;
                    }

                    // Se for Season Pack, só finaliza quando todos os episódios selecionados do pack estiverem no disco
                    if (isSeasonPack && detectedEpisodeMap && Object.keys(detectedEpisodeMap).length > 1) {
                        if (!torrent.done && torrent.progress < 0.999) {
                            let allEpsDownloaded = true;
                            for (const vf of Object.values(detectedEpisodeMap)) {
                                const epPath = path.join(this.downloadDir, vf.path);
                                if (!fs.existsSync(epPath) || fs.statSync(epPath).size < Math.floor(vf.length * 0.90)) {
                                    allEpsDownloaded = false;
                                    break;
                                }
                            }
                            if (!allEpsDownloaded) {
                                isCompleting = false;
                                return; // Aguarda os outros episódios da temporada terminarem de baixar!
                            }
                        }
                    }


                    // 2.1 Verificação de tamanho mínimo absoluto (amostras/trailers/fakes/recaps)
                    const isMicrodrama = options.isMicrodrama || options.is_microdrama || (options.runtime && options.runtime < 5);
                    const isAnime = options.isAnime || options.is_anime;
                    const minRequiredBytes = isMicrodrama ? (12 * 1024 * 1024) : (isAnime ? (75 * 1024 * 1024) : (isSerie ? (180 * 1024 * 1024) : (350 * 1024 * 1024)));

                    if (stat.size < minRequiredBytes) {
                        console.warn(`❌ [DOWNLOAD] Arquivo descartado: tamanho físico insuficiente (${this.formatBytes(stat.size)} < ${this.formatBytes(minRequiredBytes)} para ${isMicrodrama ? 'microdrama' : (isAnime ? 'anime' : (isSerie ? 'episódio de série' : 'filme'))}). Trata-se de uma amostra/fake. Descartando fonte...`);
                        finished = true;
                        safeCleanup();
                        await this.cleanupFile(fullPath).catch(() => {});
                        return reject(new Error(`Arquivo com tamanho físico insuficiente (${this.formatBytes(stat.size)} < ${this.formatBytes(minRequiredBytes)}). Amostra descartada.`));
                    }

                    // 3. Verificação de integridade estrutural via ffprobe
                    const videoInfo = await VideoProcessor.getVideoInfo(fullPath).catch(() => null);
                    if (!videoInfo || !videoInfo.duration || videoInfo.duration <= 0) {
                        completionRetries++;
                        const isDoneTorrent = (torrent.progress >= 0.999 || torrent.done);
                        if (isDoneTorrent && completionRetries >= maxCompletionRetries) {
                            console.warn(`❌ [DOWNLOAD] Arquivo corrompido ou ffprobe incapaz de ler stream: ${fullPath}`);
                            finished = true;
                            safeCleanup();
                            await this.cleanupFile(fullPath).catch(() => {});
                            return reject(new Error('Arquivo baixado inválido ou corrompido.'));
                        }
                        isCompleting = false;
                        return;
                    }

                    // 3.1 Verificação de duração mínima (evita arquivos corrompidos ou trailers/samples falsos)
                    const MIN_DURATION_SEC = 180;
                    if (videoInfo.duration < MIN_DURATION_SEC) {
                        console.warn(`❌ [DOWNLOAD] Arquivo descartado: duração muito curta (${videoInfo.duration}s < ${MIN_DURATION_SEC}s). Trata-se de um trailer/amostra. Descartando fonte...`);
                        finished = true;
                        safeCleanup();
                        await this.cleanupFile(fullPath).catch(() => {});
                        return reject(new Error(`Duração de vídeo insuficiente (${videoInfo.duration}s). Amostra descartada.`));
                    }

                    // 3.2 Validação profunda de decodificação de stream via FFmpeg
                    const integrity = await VideoProcessor.verifyVideoIntegrity(fullPath);
                    const isValid = (integrity && (integrity.isValid !== undefined ? integrity.isValid : integrity.valid));
                    if (!isValid) {
                        const errStr = integrity && integrity.error ? String(integrity.error) : '';
                        if (errStr.includes('MOOV') || errStr.includes('Incomplete') || errStr.includes('Invalid data') || errStr.includes('moov atom not found')) {
                            console.warn(`❌ [DOWNLOAD] Arquivo corrompido descartado: stream com erro (${errStr}). Tentando próxima fonte...`);
                            finished = true;
                            safeCleanup();
                            await this.cleanupFile(fullPath).catch(() => {});
                            return reject(new Error(`Arquivo corrompido no stream: ${errStr}`));
                        }
                        console.warn(`⚠️ [DOWNLOAD] Arquivo com stream parcial: ${errStr}. Aguardando mais dados...`);
                        isCompleting = false;
                        return;
                    }

                    // 4. Se for Season Pack, monta o mapa completo dos arquivos físicos válidos baixados no SSD
                    const fullEpisodeMap = {};
                    if (isSeasonPack && detectedEpisodeMap) {
                        for (const [epStr, f] of Object.entries(detectedEpisodeMap)) {
                            const epFullPath = path.join(this.downloadDir, f.path);
                            if (fs.existsSync(epFullPath)) {
                                const epStat = fs.statSync(epFullPath);
                                if (epStat.size > 20 * 1024 * 1024) {
                                    fullEpisodeMap[parseInt(epStr, 10)] = {
                                        filePath: epFullPath,
                                        fileName: f.name,
                                        sizeBytes: epStat.size
                                    };
                                }
                            }
                        }
                    }

                    finished = true;
                    process.stdout.write('\n');
                    console.log(`✅ Download concluído e validado 100% em disco (${this.formatBytes(stat.size)}): ${selectedFile.name}`);

                    const fileInfo = {
                        filePath: fullPath,
                        fileName: selectedFile.name,
                        sizeBytes: stat.size,
                        totalTorrentFiles: torrent.files.length,
                        episodeMap: fullEpisodeMap,
                        isPack: Object.keys(fullEpisodeMap).length > 1
                    };

                    safeCleanup();
                    setTimeout(() => resolve(fileInfo), 400);
                } catch (e) {
                    console.warn('⚠️ Validação de download:', e.message);
                    isCompleting = false;
                }
            };

            torrent.on('download', () => {
                if (finished) return;

                let curTotal = 0;
                let curDownloaded = 0;
                let curRatio = 0;

                if (isSeasonPack && detectedEpisodeMap && Object.keys(detectedEpisodeMap).length > 0) {
                    const selectedFiles = Object.values(detectedEpisodeMap);
                    curTotal = selectedFiles.reduce((acc, f) => acc + (f.length || 0), 0);
                    curDownloaded = selectedFiles.reduce((acc, f) => acc + Math.round((f.progress || 0) * (f.length || 0)), 0);
                    curRatio = curTotal > 0 ? curDownloaded / curTotal : 0;
                } else if (targetEpisodeFile) {
                    curTotal = targetEpisodeFile.length || torrent.length;
                    curRatio = targetEpisodeFile.progress || 0;
                    curDownloaded = Math.round(curRatio * curTotal);
                } else {
                    curTotal = torrent.length || 0;
                    curDownloaded = torrent.downloaded || 0;
                    curRatio = torrent.progress || (curTotal > 0 ? curDownloaded / curTotal : 0);
                }

                // Conclui estritamente quando os arquivos selecionados (ou episódio alvo) atingem 100% dos bytes baixados
                if (isSeasonPack && detectedEpisodeMap && Object.keys(detectedEpisodeMap).length > 0) {
                    const allSelectedDone = Object.values(detectedEpisodeMap).every(f => (f.progress || 0) >= 0.999);
                    if (allSelectedDone || curRatio >= 0.999 || torrent.done) {
                        checkAndComplete();
                    }
                } else {
                    if (curRatio >= 0.999 || (targetEpisodeFile && (targetEpisodeFile.progress || 0) >= 0.999) || torrent.progress >= 0.999 || torrent.done) {
                        checkAndComplete();
                    }
                }


                const now = Date.now();
                if (now - lastProgressTime > 800) {
                    lastProgressTime = now;

                    const percent = (curRatio * 100).toFixed(1);
                    const speedMB = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                    const downloadedStr = this.formatBytes(curDownloaded);
                    const totalStr = this.formatBytes(curTotal);

                    const barLength = 25;
                    const filled = Math.min(barLength, Math.round(curRatio * barLength));
                    const empty = Math.max(0, barLength - filled);
                    const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

                    const elapsedSec = Math.floor((now - downloadStartTime) / 1000);
                    const elapsedFormatted = this.formatDuration(elapsedSec);

                    const remainingBytes = Math.max(0, curTotal - curDownloaded);
                    const remainingSec = torrent.downloadSpeed > 0 ? Math.floor(remainingBytes / torrent.downloadSpeed) : null;
                    const remainingFormatted = remainingSec ? `~${this.formatDuration(remainingSec)}` : '--:--';
                    const audioBadge = getAudioBadge(options);

                    const packCount = isSeasonPack && detectedEpisodeMap ? Object.keys(detectedEpisodeMap).length : 0;
                    const packTitle = isSeasonPack 
                        ? `${mediaTitle} (Temporada ${seasonNum} Completa: ${packCount} Eps)`
                        : displayTitle;

                    const logLine = `\x1b[36m📥 [DOWNLOAD: "${packTitle}"] [${audioBadge}] [${progressBar}] ${percent}% | ${downloadedStr} / ${totalStr} | ${speedMB} MB/s | ⏱️ Decorrido: ${elapsedFormatted} (⏳ Restante: ${remainingFormatted}) | Peers: ${torrent.numPeers}\x1b[0m`;


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
            let slowStartTime = null;

            watchdogInterval = setInterval(() => {
                if (finished || !torrent) return;

                const curTotal = isSeasonPack ? torrent.length : (targetEpisodeFile ? targetEpisodeFile.length : torrent.length);
                let curDownloaded = 0;
                let fileProg = 0;

                if (isSeasonPack) {
                    curDownloaded = torrent.downloaded || 0;
                    fileProg = torrent.progress || 0;
                } else if (targetEpisodeFile) {
                    fileProg = targetEpisodeFile.progress || 0;
                    curDownloaded = Math.round(fileProg * curTotal);
                } else {
                    curDownloaded = torrent.downloaded || 0;
                    fileProg = torrent.progress || 0;
                }

                if (curTotal > 0 && (fileProg >= 0.99 || curDownloaded >= curTotal * 0.99 || torrent.progress >= 0.99 || torrent.done)) {
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
                const remainingBytes = Math.max(0, curTotal - curDownloaded);
                const speedMB = torrent.downloadSpeed / (1024 * 1024);
                const remainingSec = speedMB > 0.001 ? Math.floor(remainingBytes / (speedMB * 1024 * 1024)) : 999999;
                const hasMoreSources = options.attemptIndex !== undefined && options.totalAttempts !== undefined && (options.attemptIndex < options.totalAttempts - 1);

                const isDub = options.audioPreference === 'dublado' || options.isDublado || (options.audio && options.audio.includes('Dublado'));
                const hasProgress = fileProg >= 0.01 || curDownloaded >= 15 * 1024 * 1024;
                const noPeerTimeoutMs = isDub ? 90000 : 60000; // 60s - 90s sem nenhum peer no início
                // Se já tem progresso baixado, concede 15 minutos (900s) de tolerância antes de desistir por falta total de tráfego
                const stalledTimeoutMs = hasProgress ? (15 * 60 * 1000) : (isDub ? 120000 : 90000);

                // Log em tempo real a cada 6s enquanto tenta conectar e receber blocos
                if (now - lastLogTime >= 6000 && torrent.progress < 0.01) {
                    lastLogTime = now;
                    const speed = (torrent.downloadSpeed / (1024 * 1024)).toFixed(2);
                    console.log(`⏳ [TENTANDO DOWNLOAD: "${displayTitle}"] Solicitando blocos no swarm | Peers conectados: ${torrent.numPeers} | Vel: ${speed} MB/s | Tempo: ${elapsedSec}s / limite: ${Math.round(noPeerTimeoutMs / 1000)}s`);
                }

                // 1. Aborta se estiver sem nenhum peer conectado após tempo limite (apenas no início sem progresso)
                if (torrent.numPeers === 0 && stalledMs >= noPeerTimeoutMs && !hasProgress) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Torrent sem peers ativos (0 peers após ${Math.round(noPeerTimeoutMs / 1000)}s). Pulando para tentar outra fonte...`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Torrent sem peers ativos após ${Math.round(noPeerTimeoutMs / 1000)}s.`));
                }

                // 2. Aborta se estiver completamente estagnado (sem nenhum dado novo pelo tempo limite de 15 min com progresso ou 90-120s inicial)
                if (stalledMs >= stalledTimeoutMs) {
                    process.stdout.write('\n');
                    console.log(`⚠️ Download estagnado sem velocidade ativa (${torrent.numPeers} peer(s), sem tráfego por ${Math.round(stalledMs / 1000)}s). ${hasMoreSources ? 'Pulando para tentar outra fonte...' : 'Movendo para Swarm Watcher...'}`);
                    finished = true;
                    safeCleanup();
                    return reject(new Error(`Download estagnado sem dados ativos após ${Math.round(stalledTimeoutMs / 1000)}s.`));
                }

                // 3. Fast-Fail INICIAL (apenas nos primeiros 35s - 55s de arranque, sem nenhum progresso e havendo outras fontes):
                if (elapsedSec >= 35 && elapsedSec <= 55 && hasMoreSources && !hasProgress) {
                    if (speedMB < 0.25 || remainingSec > 5400) {
                        process.stdout.write('\n');
                        console.log(`⏩ [WATCHDOG VELOCIDADE] Fonte não engrenou no início (${speedMB.toFixed(2)} MB/s, baixados: ${this.formatBytes(curDownloaded)} após ${elapsedSec}s). Pulando para próxima fonte da lista (${options.attemptIndex + 2}/${options.totalAttempts})...`);
                        finished = true;
                        safeCleanup();
                        return reject(new Error(`Velocidade de arranque lenta (${speedMB.toFixed(2)} MB/s). Pulando para próxima fonte.`));
                    }
                }

                // 4. Velocidade insustentável mantida continuamente por >= 15 minutos (900s):
                // Só dispara se a velocidade for muito baixa (< 0.10 MB/s) com previsão > 2h de forma CONTÍNUA por 15 minutos.
                const isSlow = (speedMB < 0.10 && remainingSec > 7200);
                if (isSlow) {
                    if (!slowStartTime) {
                        slowStartTime = now;
                    }
                    const slowDurationSec = Math.floor((now - slowStartTime) / 1000);
                    const slowTimeoutSec = 15 * 60; // 15 minutos

                    if (slowDurationSec >= slowTimeoutSec) {
                        process.stdout.write('\n');
                        if (hasMoreSources) {
                            console.log(`⚠️ [WATCHDOG VELOCIDADE] Taxa de transferência insustentável mantida por > 15m (${speedMB.toFixed(2)} MB/s, previsão: ${this.formatDuration(remainingSec)} após ${elapsedSec}s). Abortando para tentar próxima fonte (${options.attemptIndex + 2}/${options.totalAttempts})...`);
                            finished = true;
                            safeCleanup();
                            return reject(new Error(`Velocidade insustentável mantida por > 15m (${speedMB.toFixed(2)} MB/s, previsão: ${this.formatDuration(remainingSec)}).`));
                        } else {
                            console.log(`⚠️ [WATCHDOG VELOCIDADE] Última fonte com velocidade insustentável mantida por > 15m (${speedMB.toFixed(2)} MB/s, previsão: ${this.formatDuration(remainingSec)}). Movendo para Swarm Watcher...`);
                            finished = true;
                            safeCleanup();
                            return reject(new Error(`Torrent com velocidade insuficiente mantida por > 15m (${speedMB.toFixed(2)} MB/s).`));
                        }
                    }
                } else {
                    // Qualquer oscilação ou melhora de velocidade reseta a contagem de lentidão
                    slowStartTime = null;
                }
            }, 4000);
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

    cancelDownload(jobId) {
        if (this.activeDownloads && this.activeDownloads.has(jobId)) {
            const item = this.activeDownloads.get(jobId);
            this.activeDownloads.delete(jobId);
            try {
                item.cancel();
                console.log(`⏹️ [DownloaderManager] Download cancelado/interrompido com sucesso para o job: ${jobId}`);
                return true;
            } catch (e) {}
        }
        return false;
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

