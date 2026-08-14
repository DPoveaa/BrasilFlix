const axios = require('axios');
const config = require('../../config');
const TMDBService = require('./TMDBService');

class MediaSearchService {
    constructor() {
        this.timeout = 12000;
    }

    async search(query, tipo = 'filme', options = {}) {
        const cleanQuery = this.cleanQuery(query);
        const originalName = options.nomeOriginal ? this.cleanQuery(options.nomeOriginal) : null;
        const ano = options.ano || '';
        const forcarNaoCam = options.onlyWebDl || false;
        let imdbId = options.imdbId || null;
        const season = options.season || 1;
        const episode = options.episode || 1;

        console.log(`\n🔍 Buscando fontes em Português (Dublado > Legendado) para: "${cleanQuery}" ${originalName ? `(${originalName})` : ''}...`);

        const allResults = [];
        const seenHashes = new Set();

        // 1. Tentar obter IMDb ID caso não tenha sido fornecido
        if (!imdbId && options.tmdbId) {
            try {
                if (tipo === 'filme') {
                    const det = await TMDBService.getMovieDetails(options.tmdbId);
                    imdbId = det?.imdbId;
                } else {
                    const det = await TMDBService.getTVDetails(options.tmdbId);
                    imdbId = det?.imdbId;
                }
            } catch (e) {}
        }

        // Se ainda não temos IMDb ID, faz busca rápida no TMDB
        if (!imdbId) {
            try {
                const searchRes = tipo === 'filme' ? 
                    await TMDBService.searchMovie(cleanQuery, ano || null) : 
                    await TMDBService.searchTV(cleanQuery, ano || null);
                
                if (searchRes.length > 0) {
                    const first = searchRes[0];
                    const det = tipo === 'filme' ? 
                        await TMDBService.getMovieDetails(first.tmdbId) : 
                        await TMDBService.getTVDetails(first.tmdbId);
                    imdbId = det?.imdbId;
                }
            } catch (e) {}
        }

        // 2. BUSCA NO TORRENTIO / STREMIO MULTI-PROVIDER (ComandoTorrents, BluDV, CineGAVETA, TorrentGalaxy, etc.)
        if (imdbId) {
            try {
                console.log(`🌐 Consultando catálogo Stremio/Torrentio para IMDb: ${imdbId} ${tipo === 'serie' ? `(S${season}E${episode})` : ''}...`);
                const torrentioResults = await this.searchTorrentio(imdbId, tipo, { forcarNaoCam, query: cleanQuery, originalName, ano, season, episode });
                for (const item of torrentioResults) {
                    if (item.isPtBr && !seenHashes.has(item.infoHash)) {
                        seenHashes.add(item.infoHash);
                        allResults.push(item);
                    }
                }
            } catch (e) {
                console.warn('⚠️ Falha temporária ao consultar Torrentio:', e.message);
            }
        }

        // 3. BUSCA COMPLEMENTAR NO THE PIRATE BAY / APIBAY
        const variations = [];
        if (tipo === 'serie') {
            variations.push(
                `${cleanQuery} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')} dublado`,
                `${cleanQuery} temporada completa dublado`,
                `${cleanQuery} completa dublado`,
                `${cleanQuery} 1080p dublado`,
                `${cleanQuery} dublado`,
                `${cleanQuery} s01 dublado`
            );
            if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                variations.push(
                    `${originalName} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')} dublado`,
                    `${originalName} season 1 dublado`,
                    `${originalName} dublado`
                );
            }
        } else {
            variations.push(
                `${cleanQuery} 1080p dublado`,
                `${cleanQuery} dublado`,
                `${cleanQuery} nacional`,
                `${cleanQuery} 1080p legendado`,
                `${cleanQuery} legendado`
            );
            if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                variations.push(
                    `${originalName} 1080p dublado`,
                    `${originalName} dublado`,
                    `${originalName} 1080p legendado`
                );
                if (ano) {
                    variations.push(
                        `${originalName} ${ano} dublado`,
                        `${originalName} ${ano} legendado`
                    );
                }
            }
        }

        for (const q of variations) {
            try {
                const apiResults = await this.searchTorrentApi(q, { forcarNaoCam, query: cleanQuery, originalName, ano });
                for (const item of apiResults) {
                    if (item.isPtBr && !seenHashes.has(item.infoHash)) {
                        seenHashes.add(item.infoHash);
                        allResults.push(item);
                    }
                }
                const dubladosComSeeds = allResults.filter(r => r.isDublado && r.seeders > 5);
                if (dubladosComSeeds.length >= 3) break;
            } catch (e) {}
        }

        let ptBrResults = allResults.filter(r => r.isPtBr);

        if (forcarNaoCam) {
            ptBrResults = ptBrResults.filter(r => !r.isCam);
        }

        if (ptBrResults.length === 0) {
            console.log(`⚠️ Nenhuma versão em Português (Dublada ou Legendada) encontrada para "${cleanQuery}".`);
            return [];
        }

        const dublados = ptBrResults.filter(r => r.isDublado);
        const legendados = ptBrResults.filter(r => r.isLegendado);
        console.log(`✅ Encontradas ${ptBrResults.length} opções em Português (${dublados.length} Dublado(s), ${legendados.length} Legendado(s))!`);
        
        return this.rankResults(ptBrResults, cleanQuery, options);
    }

    async searchTorrentio(imdbId, tipo = 'filme', opts = {}) {
        if (!imdbId) return [];
        const results = [];
        try {
            const season = opts.season || 1;
            const episode = opts.episode || 1;
            const streamPath = tipo === 'serie' ? `series/${imdbId}:${season}:${episode}.json` : `movie/${imdbId}.json`;
            const url = `https://torrentio.strem.fun/stream/${streamPath}`;
            
            const response = await axios.get(url, { timeout: this.timeout });
            const streams = response.data.streams || [];

            for (const st of streams) {
                const rawTitle = st.title || '';
                const lines = rawTitle.split('\n');
                const title = lines[0] || '';

                const isBrazilianGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|kyogo|lipeh|starckfilmes|yg⭐|filmesmega|guanabara|ondebaixo|acervo/i.test(rawTitle);
                const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(title);
                const hasPtAudioFlag = (/(Dubbed|Dual Audio|Multi Audio)/i.test(rawTitle)) && (/(🇧🇷|🇵🇹|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle));
                const isDualPtInTitle = /\b(dual)\b/i.test(title) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(title));

                const isDublado = isExplicitPtDubInTitle || isBrazilianGroup || hasPtAudioFlag || isDualPtInTitle;

                const isExplicitLegendadoInTitle = /\b(legendado|legendas|legenda|sub[-_ ]?pt|subs?\.por|pt[-_ ]?subs?|hc-sub)\b/i.test(title);
                const hasPtSubFlag = (/(Multi Subs|Subtitles|Subs:?)/i.test(rawTitle)) && (/(🇧🇷|🇵🇹|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle));

                const isLegendado = !isDublado && (isExplicitLegendadoInTitle || hasPtSubFlag);

                // Se não tiver nem áudio dublado nem legenda em português comprovada, descarta imediatamente
                if (!isDublado && !isLegendado) continue;

                // Extrai seeders e tamanho do texto completo retornado pelo Torrentio/Stremio
                const seedersMatch = rawTitle.match(/👤\s*(\d+)/);
                const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 0;

                const sizeMatch = rawTitle.match(/💾\s*([\d\.]+)\s*(GB|MB)/i);
                let sizeMB = 0;
                if (sizeMatch) {
                    const val = parseFloat(sizeMatch[1]);
                    sizeMB = sizeMatch[2].toUpperCase() === 'GB' ? (val * 1024).toFixed(1) : val.toFixed(1);
                }

                const sourceGroup = rawTitle.match(/⚙️\s*([^\n\r]+)/)?.[1]?.trim() || 'Stremio';
                const magnet = `magnet:?xt=urn:btih:${st.infoHash}&dn=${encodeURIComponent(title)}`;
                const isCam = /\b(cam|camrip|hdcam|ts|telesync|hdts)\b/i.test(title);
                const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(title) && !isCam;

                results.push({
                    title: title,
                    infoHash: st.infoHash,
                    source: `Torrentio (${sourceGroup})`,
                    magnet: magnet,
                    sizeBytes: parseFloat(sizeMB) * 1024 * 1024,
                    sizeMB: sizeMB,
                    seeders: seeders,
                    isCam: isCam,
                    isWebDl: isWebDl,
                    quality: /1080p/i.test(title) ? '1080p Full HD' : (/720p/i.test(title) ? '720p HD' : 'Qualidade Digital'),
                    audio: isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                    isPtBr: true,
                    isDublado: isDublado,
                    isLegendado: isLegendado
                });
            }
        } catch (e) {}
        return results;
    }

    cleanQuery(text) {
        if (!text) return '';
        return text
            .replace(/[^\w\s\u00C0-\u00FF]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    cleanTitleForNLP(text) {
        if (!text) return '';
        return text
            .toLowerCase()
            .replace(/[\._\-\+\[\]\(\)\{\}~]/g, ' ')
            .replace(/\b(19\d\d|20\d\d)\b/g, '')
            .replace(/\b(2160p|1080p|720p|480p|4k|2k|fhd|uhd|bluray|blu-ray|bdrip|brrip|web-dl|webrip|web|hdtv|hdrip|dvdrip|dvd|remux|telesync|hdts|ts|cam|camrip|hdcam|x264|x265|hevc|h264|h265|aac|ac3|dts|ddp\d*|atmos|mp3|eac3|flac|mkv|mp4|avi|dublado|dual|legendado|nacional|pt-br|ptbr|sub|multi|season|temporada|completa|s\d+|e\d+|ep\d*|hc-sub|pre|lipeh|kyogo|lapumia|wolverdon|starck|vizer|acervo|yg|1xbet|mostbet|remuxdoc|lmntry|maze|ddr|tmb|psa|galaxyrg|rarbg|tgx|megusta|ntb|yify|yts)\b/gi, '')
            .replace(/\b(and|e|&|the|a|o|as|os|um|uma|de|da|do|em|of|in|for|no|na)\b/gi, '')
            .replace(/[^\w\s\u00C0-\u00FF]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    extractSequelNumber(text) {
        if (!text) return null;
        const clean = text.toLowerCase()
            .replace(/\b(19\d\d|20\d\d)\b/g, '')
            .replace(/\b(1080p|720p|480p|2160p|4k|2k|h264|h265|x264|x265|hevc|ddp5|5\.1|7\.1|ch)\b/g, '');
        
        const match = clean.match(/\b(ii|iii|iv|v|vi|vii|viii|ix|x|parte\s*\d+|part\s*\d+|[1-9]|1[0-5])\b/);
        if (!match) return null;
        let val = match[1].replace(/parte\s*|part\s*/, '');
        const romanMap = { 'ii': '2', 'iii': '3', 'iv': '4', 'v': '5', 'vi': '6', 'vii': '7', 'viii': '8', 'ix': '9', 'x': '10' };
        return romanMap[val] || val;
    }

    extractYear(text) {
        if (!text) return null;
        const match = text.match(/\b(19\d\d|20\d\d)\b/);
        return match ? parseInt(match[1], 10) : null;
    }

    validateSequelAndYear(torrentTitle, targetTitle, targetYear) {
        const qNum = this.extractSequelNumber(targetTitle);
        const tNum = this.extractSequelNumber(torrentTitle);
        const tYear = this.extractYear(torrentTitle);

        if (qNum && tNum !== qNum) {
            return false;
        }

        if (!qNum && tNum) {
            return false;
        }

        if (targetYear && tYear) {
            const qYearInt = parseInt(targetYear, 10);
            if (!isNaN(qYearInt) && Math.abs(tYear - qYearInt) > 1) {
                return false;
            }
        }

        return true;
    }

    levenshtein(a, b) {
        const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
        for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }
        return matrix[a.length][b.length];
    }

    computeSimilarity(torrentTitle, targetTitle) {
        const cTorrent = this.cleanTitleForNLP(torrentTitle);
        const cTarget = this.cleanTitleForNLP(targetTitle);

        if (!cTorrent || !cTarget) return 0;
        if (cTorrent === cTarget) return 1.0;

        const tTokens = cTorrent.split(' ').filter(Boolean);
        const qTokens = cTarget.split(' ').filter(Boolean);

        let intersection = 0;
        const tSet = new Set(tTokens);
        for (const q of qTokens) {
            if (tSet.has(q)) intersection++;
        }

        const jaccard = intersection / new Set([...tTokens, ...qTokens]).size;
        const maxLen = Math.max(cTorrent.length, cTarget.length);
        const levSim = maxLen === 0 ? 1 : 1 - (this.levenshtein(cTorrent, cTarget) / maxLen);

        return (jaccard * 0.5) + (levSim * 0.5);
    }

    matchesMovieTitle(torrentTitle, queryPt, originalNameEn = '', targetYear = null) {
        if (!this.validateSequelAndYear(torrentTitle, queryPt, targetYear)) {
            return false;
        }

        const scorePt = this.computeSimilarity(torrentTitle, queryPt);
        const scoreEn = originalNameEn ? this.computeSimilarity(torrentTitle, originalNameEn) : 0;
        const bestScore = Math.max(scorePt, scoreEn);
        return bestScore >= 0.55;
    }

    async searchTorrentApi(query, opts = {}) {
        const results = [];
        try {
            const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
            const response = await axios.get(url, { timeout: this.timeout });

            if (Array.isArray(response.data) && response.data.length > 0 && response.data[0].id !== '0') {
                for (const item of response.data.slice(0, 30)) {
                    const name = item.name || '';
                    const sizeBytes = parseInt(item.size || 0, 10);
                    const seeders = parseInt(item.seeders || 0, 10);
                    const magnet = `magnet:?xt=urn:btih:${item.info_hash}&dn=${encodeURIComponent(name)}`;

                    if (opts.query && !this.matchesMovieTitle(name, opts.query, opts.originalName, opts.ano)) {
                        continue;
                    }

                    const isBrazilianGroup = /yg⭐|dual[._ -]?yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(name);
                    const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(name);
                    const isDualPtInTitle = /\b(dual)\b/i.test(name) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(name));

                    const isDublado = isExplicitPtDubInTitle || isBrazilianGroup || isDualPtInTitle;

                    const isLegendadoPt = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br)\b/i.test(name);
                    const isExplicitPtBr = /\b(pt[-_]?br|ptbr|pt_br|portugues[a-z]*|brazilian)\b/i.test(name);

                    const isLegendado = !isDublado && (isLegendadoPt || isExplicitPtBr);

                    if (!isDublado && !isLegendado) {
                        continue;
                    }

                    const isCam = /\b(cam|camrip|hdcam|ts|telesync|hdts)\b/i.test(name);
                    const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(name) && !isCam;
                    const is1080p = (/\b(1080p|fhd|fullhd|bluray|web-dl|1080)\b/i.test(name)) && !isCam;

                    if (isCam && (!config.ALLOW_CINEMA_CAM && !opts.allowCam)) {
                        continue;
                    }

                    results.push({
                        title: name,
                        infoHash: item.info_hash,
                        source: 'ThePirateBay',
                        magnet: magnet,
                        sizeBytes: sizeBytes,
                        sizeMB: (sizeBytes / (1024 * 1024)).toFixed(1),
                        seeders: seeders,
                        isCam: isCam,
                        isWebDl: isWebDl,
                        quality: isCam ? 'CAM (Cinema)' : (is1080p ? '1080p Full HD' : '720p HD'),
                        audio: isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                        isPtBr: true,
                        isDublado: isDublado,
                        isLegendado: isLegendado
                    });
                }
            }
        } catch (e) {}
        return results;
    }

    rankResults(results, query, options = {}) {
        if (!results || results.length === 0) return [];

        const withSeeds = results.filter(r => (r.seeders || 0) > 0);
        const candidates = withSeeds.length > 0 ? withSeeds : results;

        return candidates.sort((a, b) => {
            let scoreA = 0;
            let scoreB = 0;

            if (a.isDublado) scoreA += 1200;
            if (b.isDublado) scoreB += 1200;

            if (a.isWebDl) scoreA += 500;
            if (b.isWebDl) scoreB += 500;

            // Prioridade para 1080p Full HD e 720p HD
            const is1080pA = /\b(1080p|1080|fhd|fullhd)\b/i.test(a.title);
            const is1080pB = /\b(1080p|1080|fhd|fullhd)\b/i.test(b.title);
            if (is1080pA) scoreA += 400;
            if (is1080pB) scoreB += 400;

            const is720pA = /\b(720p|720|hd)\b/i.test(a.title) && !is1080pA;
            const is720pB = /\b(720p|720|hd)\b/i.test(b.title) && !is1080pB;
            if (is720pA) scoreA += 200;
            if (is720pB) scoreB += 200;

            // Desprioriza 4K/2160p (pesado demais sem ganho visual no Telegram)
            const is4kA = /\b(2160p|4k|uhd)\b/i.test(a.title);
            const is4kB = /\b(2160p|4k|uhd)\b/i.test(b.title);
            if (is4kA) scoreA -= 600;
            if (is4kB) scoreB -= 600;

            // PRIORIDADE CRÍTICA DE SEEDERS (Evita fontes lentas/travadas)
            const seedsA = a.seeders || 0;
            const seedsB = b.seeders || 0;

            if (seedsA >= 15) scoreA += 1200;
            else if (seedsA >= 8) scoreA += 700;
            else if (seedsA >= 4) scoreA += 300;
            else if (seedsA <= 2) scoreA -= 800; // Penalidade forte para torrents com quase nenhum seeder

            if (seedsB >= 15) scoreB += 1200;
            else if (seedsB >= 8) scoreB += 700;
            else if (seedsB >= 4) scoreB += 300;
            else if (seedsB <= 2) scoreB -= 800;

            scoreA += Math.min(600, seedsA * 25);
            scoreB += Math.min(600, seedsB * 25);

            // Tamanho doce (Sweet Spot) entre 1.2 GB e 3.8 GB para downloads rápidos em 1080p
            const sizeA = (a.sizeBytes || 0) / (1024 * 1024);
            const sizeB = (b.sizeBytes || 0) / (1024 * 1024);

            if (sizeA >= 1200 && sizeA <= 3800) scoreA += 350;
            if (sizeB >= 1200 && sizeB <= 3800) scoreB += 350;

            return scoreB - scoreA;
        });
    }
}

module.exports = new MediaSearchService();
