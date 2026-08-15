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
        const pref = options.audioPreference || 'geral';
        const season = options.season || 1;
        const episode = options.episode || 1;
        const prefTexto = pref === 'legendado' ? 'Legendada (PT-BR)' : (pref === 'dublado' ? 'Dublada (PT-BR)' : 'em Português (Dublado > Legendado)');
        console.log(`\n🔍 Buscando fontes ${prefTexto} para: "${cleanQuery}" ${originalName ? `(${originalName})` : ''}...`);

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
            } catch (e) {
                console.warn('⚠️ Diagnóstico TMDB (busca por ID):', e.message);
            }
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
            } catch (e) {
                console.warn('⚠️ Diagnóstico TMDB (busca por título):', e.message);
            }
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
        const sPadded = season.toString().padStart(2, '0');
        const ePadded = episode.toString().padStart(2, '0');
        const variations = [];

        if (tipo === 'serie') {
            if (pref === 'legendado') {
                variations.push(
                    `${cleanQuery} S${sPadded}E${ePadded} legendado`,
                    `${cleanQuery} S${sPadded} legendado`,
                    `${cleanQuery} temporada ${season} legendado`,
                    `${cleanQuery} season ${season} legendado`,
                    `${cleanQuery} S${sPadded}E${ePadded}`,
                    `${cleanQuery} 1080p legendado`
                );
                if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                    variations.push(
                        `${originalName} S${sPadded}E${ePadded}`,
                        `${originalName} S${sPadded} legendado`,
                        `${originalName} season ${season}`
                    );
                }
            } else {
                variations.push(
                    `${cleanQuery} S${sPadded}E${ePadded} dublado`,
                    `${cleanQuery} S${sPadded} dublado`,
                    `${cleanQuery} temporada ${season} dublado`,
                    `${cleanQuery} temporada ${season} completa`,
                    `${cleanQuery} season ${season} dublado`,
                    `${cleanQuery} 1080p dublado`,
                    `${cleanQuery} dublado`
                );
                if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                    variations.push(
                        `${originalName} S${sPadded}E${ePadded} dublado`,
                        `${originalName} season ${season} dublado`,
                        `${originalName} S${sPadded} dublado`,
                        `${originalName} dublado`
                    );
                }
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
                const apiResults = await this.searchTorrentApi(q, { forcarNaoCam, query: cleanQuery, originalName, ano, tipo, season, episode });
                for (const item of apiResults) {
                    if (item.isPtBr && !seenHashes.has(item.infoHash)) {
                        seenHashes.add(item.infoHash);
                        allResults.push(item);
                    }
                }
                // Para busca mais eficiente: só para cedo se já tiver fontes saudáveis suficientes do tipo preferido
                const dubladosComSeeds = allResults.filter(r => r.isDublado && r.seeders >= 5);
                const legendadosComSeeds = allResults.filter(r => r.isLegendado && r.seeders >= 5);
                const targetCount = pref === 'legendado' ? legendadosComSeeds.length : dubladosComSeeds.length;
                if (targetCount >= 4) break;
            } catch (e) {
                console.warn(`⚠️ Diagnóstico busca Torrent API ("${q}"):`, e.message);
            }
        }

        // Filtro rigoroso: descarta categoricamente qualquer release 4K/2160p e arquivos incompatíveis
        let ptBrResults = allResults.filter(r => {
            if (!r.isPtBr) return false;

            // 1. Bloqueia 4K / 2160p / UHD
            const is4k = /\b(2160p|4k|uhd|remux\.2160p)\b/i.test(r.title);
            if (is4k) return false;

            // 2. Se for filme, limita o tamanho a no máximo 5.5 GB (padrão 1080p leve e nítido). Para séries, aceita season packs até 80 GB
            if (tipo === 'filme') {
                const sizeMB = parseFloat(r.sizeMB) || ((r.sizeBytes || 0) / (1024 * 1024));
                if (sizeMB > 5500) return false;
            }

            return true;
        });

        if (forcarNaoCam) {
            ptBrResults = ptBrResults.filter(r => !r.isCam);
        }

        if (ptBrResults.length === 0) {
            const descFalta = pref === 'legendado' ? 'Legendada (PT-BR)' : (pref === 'dublado' ? 'Dublada (PT-BR)' : 'em Português (Dublada ou Legendada)');
            console.log(`⚠️ Nenhuma versão 1080p/720p ${descFalta} encontrada para "${cleanQuery}".`);
            return [];
        }

        const dublados = ptBrResults.filter(r => r.isDublado);
        const legendados = ptBrResults.filter(r => r.isLegendado);
        console.log(`✅ Encontradas ${ptBrResults.length} opções 1080p/720p em Português (${dublados.length} Dublado(s), ${legendados.length} Legendado(s))!`);

        // Ranking inteligente unificado: avalia saúde, preferência de áudio, qualidade e resolução
        return this.rankResults(ptBrResults, cleanQuery, { ...options, tipo });
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

                // Distinção explícita de PT-BR vs PT-PT
                const isPtBrExplicit = /(🇧🇷|\b(PT-BR|PT_BR|PTBR|BRAZILIAN)\b)/i.test(rawTitle) || /\b(pt-br|ptbr|nacional|dublado)\b/i.test(title);
                const isPtPtExplicit = /(🇵🇹|\b(PT-PT|PT_PT|PTPT|EUROPEAN[._ -]?PORTUGUESE|DOBRADO)\b)/i.test(rawTitle) || /\b(pt-pt|dobrado)\b/i.test(title);
                const isBrazilianGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|kyogo|lipeh|starckfilmes|yg⭐|filmesmega|guanabara|ondebaixo|acervo/i.test(rawTitle) || /comando|bludv|lapumia|starck|vizer/i.test(title);

                const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt[-_ ]?br|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(title);
                const hasPtAudioFlag = (/(Dubbed|Dual Audio|Multi Audio|Dual)/i.test(rawTitle)) && (isPtBrExplicit || isBrazilianGroup || /(🇧🇷|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle));
                const isDualPtInTitle = /\b(dual)\b/i.test(title) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(rawTitle));

                const isDublado = (isExplicitPtDubInTitle || (isBrazilianGroup && (/\b(dual|dublado|dub)\b/i.test(title) || hasPtAudioFlag)) || hasPtAudioFlag || isDualPtInTitle) && !isPtPtExplicit;

                const isExplicitLegendadoInTitle = /\b(legendado|legendas|legenda|sub[-_ ]?pt[-_ ]?br|subs?\.pob|pt[-_ ]?subs?|hc-sub)\b/i.test(title);
                const hasPtSubFlag = (/(Multi Subs|Subtitles|Subs:?)/i.test(rawTitle)) && (isPtBrExplicit || /(🇧🇷|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle)) && !isPtPtExplicit;

                const isLegendado = !isDublado && (isExplicitLegendadoInTitle || hasPtSubFlag || (isBrazilianGroup && /\b(leg|legendado)\b/i.test(title)));

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

                // Descarta apenas arquivos absurdamente gigantes (> 9.5 GB para filmes, > 80 GB para séries)
                const maxAllowedMB = tipo === 'serie' ? 80000 : 9500;
                if (parseFloat(sizeMB) > maxAllowedMB) {
                    continue;
                }

                // Descarta apenas amostras, trailers ou teasers falsos
                if (/\b(amostra|sample|trailer|teaser)\b/i.test(title)) {
                    continue;
                }

                // Descarta arquivos anormalmente pequenos (filmes < 300MB ou episódios < 50MB)
                if (tipo === 'filme' && parseFloat(sizeMB) < 300) {
                    continue;
                }
                if (tipo === 'serie' && parseFloat(sizeMB) < 50) {
                    continue;
                }

                const sourceGroup = rawTitle.match(/⚙️\s*([^\n\r]+)/)?.[1]?.trim() || 'Stremio';
                const magnet = `magnet:?xt=urn:btih:${st.infoHash}&dn=${encodeURIComponent(title)}`;
                const isCam = /\b(cam|camrip|hdcam|ts|telesync|hdts)\b/i.test(title);
                const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(title) && !isCam;
                const is4k = /\b(2160p|4k|uhd|remux\.2160p)\b/i.test(rawTitle) || /\b(2160p|4k|uhd)\b/i.test(title);

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
                    is4k: is4k,
                    quality: is4k ? '4K UHD (Otimizando 1080p)' : (/1080p/i.test(title) ? '1080p Full HD' : (/720p/i.test(title) ? '720p HD' : 'Qualidade Digital')),
                    audio: isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                    isPtBr: true,
                    isPtBrExplicit: isPtBrExplicit || isBrazilianGroup,
                    isPtPt: isPtPtExplicit,
                    isDublado: isDublado,
                    isLegendado: isLegendado
                });
            }
        } catch (e) {
            console.warn('⚠️ Diagnóstico Torrentio stream fetch:', e.message);
        }
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

                    const isPtBrExplicit = /\b(pt[-_]?br|ptbr|pt_br|brazilian|nacional|dublado)\b/i.test(name);
                    const isPtPtExplicit = /\b(pt[-_]?pt|pt_pt|ptpt|dobrado)\b/i.test(name);
                    const isBrazilianGroup = /yg⭐|dual[._ -]?yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(name);
                    const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(name);
                    const isDualPtInTitle = /\b(dual)\b/i.test(name) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(name));

                    const isDublado = (isExplicitPtDubInTitle || isBrazilianGroup || isDualPtInTitle) && !isPtPtExplicit;

                    const isLegendadoPt = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br)\b/i.test(name);
                    const isExplicitPtBr = /\b(pt[-_]?br|ptbr|pt_br|portugues[a-z]*|brazilian)\b/i.test(name);

                    const isLegendado = !isDublado && (isLegendadoPt || isExplicitPtBr) && !isPtPtExplicit;

                    // Descarta categoricamente qualquer release 4K / 2160p / UHD
                    if (/\b(2160p|4k|uhd|remux\.2160p)\b/i.test(name)) {
                        continue;
                    }

                    // Se for filme, descarta arquivos gigantes (> 5.5 GB). Para séries, permite season packs até 60 GB
                    const maxAllowedBytes = opts.tipo === 'serie' ? (60 * 1024 * 1024 * 1024) : (5.5 * 1024 * 1024 * 1024);
                    if (sizeBytes > maxAllowedBytes) {
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
                        isPtBrExplicit: isPtBrExplicit || isBrazilianGroup,
                        isPtPt: isPtPtExplicit,
                        isDublado: isDublado,
                        isLegendado: isLegendado
                    });
                }
            }
        } catch (e) {
            // Silencia timeout esperado do TPB/ApiBay para manter logs limpos
        }
        return results;
    }

    rankResults(results, query, options = {}) {
        if (!results || results.length === 0) return [];

        const withSeeds = results.filter(r => (r.seeders || 0) > 0);
        const candidates = withSeeds.length > 0 ? withSeeds : results;
        const pref = options.audioPreference || 'dublado';
        const tipo = options.tipo || 'filme';

        return candidates.sort((a, b) => {
            let scoreA = 0;
            let scoreB = 0;

            // 1. Preferência de Áudio
            if (pref === 'legendado') {
                if (a.isLegendado) scoreA += 900;
                if (b.isLegendado) scoreB += 900;
                if (a.isDublado) scoreA += 250;
                if (b.isDublado) scoreB += 250;
            } else {
                if (a.isDublado) scoreA += 900;
                if (b.isDublado) scoreB += 900;
                if (a.isLegendado) scoreA += 300;
                if (b.isLegendado) scoreB += 300;
            }

            // 2. Fidelidade PT-BR vs PT-PT
            if (a.isPtBrExplicit) scoreA += 400;
            if (b.isPtBrExplicit) scoreB += 400;
            if (a.isPtPt) scoreA -= 800;
            if (b.isPtPt) scoreB -= 800;

            // 3. Formato e Qualidade
            if (a.isWebDl) scoreA += 450;
            if (b.isWebDl) scoreB += 450;

            const is1080pA = /\b(1080p|1080|fhd|fullhd)\b/i.test(a.title);
            const is1080pB = /\b(1080p|1080|fhd|fullhd)\b/i.test(b.title);
            if (is1080pA) scoreA += 600;
            if (is1080pB) scoreB += 600;

            const is720pA = /\b(720p|720|hd)\b/i.test(a.title) && !is1080pA;
            const is720pB = /\b(720p|720|hd)\b/i.test(b.title) && !is1080pB;
            if (is720pA) scoreA += 300;
            if (is720pB) scoreB += 300;

            // 4. SAÚDE DA FONTE (Seeders / Disponibilidade com peso superior a torrents mortos)
            const seedsA = a.seeders || 0;
            const seedsB = b.seeders || 0;

            if (seedsA >= 25) scoreA += 1400;
            else if (seedsA >= 10) scoreA += 900;
            else if (seedsA >= 4) scoreA += 400;
            else if (seedsA >= 2) scoreA += 100;
            else if (seedsA === 1) scoreA -= 1200; // Penalidade forte para torrent quase sem seeder
            else if (seedsA === 0) scoreA -= 2500; // Penalidade severa para torrent morto

            if (seedsB >= 25) scoreB += 1400;
            else if (seedsB >= 10) scoreB += 900;
            else if (seedsB >= 4) scoreB += 400;
            else if (seedsB >= 2) scoreB += 100;
            else if (seedsB === 1) scoreB -= 1200;
            else if (seedsB === 0) scoreB -= 2500;

            scoreA += Math.min(400, seedsA * 10);
            scoreB += Math.min(400, seedsB * 10);

            // 5. Ajuste por Tamanho
            const sizeA = (a.sizeBytes || 0) / (1024 * 1024);
            const sizeB = (b.sizeBytes || 0) / (1024 * 1024);

            if (tipo === 'filme') {
                if (sizeA > 10000) scoreA -= 4000;
                else if (sizeA > 5500) scoreA -= 2000;
                else if (sizeA >= 1300 && sizeA <= 4500) scoreA += 800; // Ponto ideal 1080p filme

                if (sizeB > 10000) scoreB -= 4000;
                else if (sizeB > 5500) scoreB -= 2000;
                else if (sizeB >= 1300 && sizeB <= 4500) scoreB += 800;
            } else {
                // Séries: pacotes de temporada não são penalizados por tamanho total
                if (sizeA >= 350 && sizeA <= 2500) scoreA += 500; // Episódio avulso ideal
                else if (sizeA > 70000) scoreA -= 1500;

                if (sizeB >= 350 && sizeB <= 2500) scoreB += 500;
                else if (sizeB > 70000) scoreB -= 1500;
            }

            return scoreB - scoreA;
        });
    }
}

module.exports = new MediaSearchService();
