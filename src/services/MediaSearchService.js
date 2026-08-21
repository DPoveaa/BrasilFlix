const axios = require('axios');
const config = require('../../config');
const TMDBService = require('./TMDBService');

class MediaSearchService {
    constructor() {
        this.timeout = 7000;
    }

    async search(query, tipo = 'filme', options = {}) {
        if (typeof tipo === 'object') {
            options = tipo;
            tipo = options.tipo || 'filme';
        }
        const cleanQuery = this.cleanQuery(query);
        const originalName = options.nomeOriginal ? this.cleanQuery(options.nomeOriginal) : null;
        const ano = options.ano || options.year || '';
        const forcarNaoCam = options.onlyWebDl || options.forcarNaoCam || false;
        let imdbId = options.imdbId || null;
        const pref = options.audioPreference || 'geral';
        const season = options.season || 1;
        const episode = options.episode || 1;
        const prefTexto = pref === 'legendado' ? 'Legendada (PT-BR)' : (pref === 'dublado' ? 'Dublada (PT-BR)' : 'em Português (Dublado > Legendado)');
        console.log(`\n🔍 Buscando fontes ${prefTexto} para: "${cleanQuery}" ${originalName ? `(${originalName})` : ''} ${tipo === 'serie' ? `(T${season}E${episode})` : ''}...`);

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
                    `${cleanQuery} S${sPadded} complete`,
                    `${cleanQuery} S${sPadded} legendado`,
                    `${cleanQuery} temporada ${season} completa legendado`,
                    `${cleanQuery} season ${season} complete`,
                    `${cleanQuery} S${sPadded}E${ePadded} legendado`,
                    `${cleanQuery} S${sPadded}E${ePadded}`,
                    `${cleanQuery} 1080p legendado`
                );
                if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                    variations.push(
                        `${originalName} S${sPadded} complete`,
                        `${originalName} S${sPadded} season ${season}`,
                        `${originalName} S${sPadded}E${ePadded}`,
                        `${originalName} S${sPadded} legendado`,
                        `${originalName} season ${season}`
                    );
                }
            } else {
                variations.push(
                    `${cleanQuery} S${sPadded}E${ePadded} dual`,
                    `${cleanQuery} S${sPadded}E${ePadded} dublado`,
                    `${cleanQuery} S${sPadded}E${ePadded}`,
                    `${cleanQuery} S${sPadded} dual`,
                    `${cleanQuery} S${sPadded} dublado`,
                    `${cleanQuery} S${sPadded} complete`,
                    `${cleanQuery} temporada ${season} dual`,
                    `${cleanQuery} temporada ${season} dublado`,
                    `${cleanQuery} temporada ${season} completa`,
                    `${cleanQuery} season ${season} dual`,
                    `${cleanQuery} S${sPadded} 1080p dual`,
                    `${cleanQuery} 1080p dual`,
                    `${cleanQuery} dual audio`,
                    `${cleanQuery} dublado`
                );
                if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                    variations.push(
                        `${originalName} S${sPadded}E${ePadded} dual`,
                        `${originalName} S${sPadded}E${ePadded} dublado`,
                        `${originalName} S${sPadded}E${ePadded}`,
                        `${originalName} S${sPadded} dual`,
                        `${originalName} S${sPadded} dublado`,
                        `${originalName} S${sPadded} complete`,
                        `${originalName} season ${season} dual`,
                        `${originalName} dual`
                    );
                }
            }
        } else {
            variations.push(
                `${cleanQuery} 1080p dual`,
                `${cleanQuery} 1080p dublado`,
                `${cleanQuery} dual audio`,
                `${cleanQuery} dublado`,
                `${cleanQuery} nacional`,
                `${cleanQuery} 1080p legendado`,
                `${cleanQuery} legendado`
            );
            if (originalName && originalName.toLowerCase() !== cleanQuery.toLowerCase()) {
                variations.push(
                    `${originalName} 1080p dual`,
                    `${originalName} 1080p dublado`,
                    `${originalName} dual`,
                    `${originalName} dublado`,
                    `${originalName} 1080p legendado`
                );
                if (ano) {
                    variations.push(
                        `${originalName} ${ano} dual`,
                        `${originalName} ${ano} dublado`,
                        `${originalName} ${ano} legendado`
                    );
                }
            }
        }

        // Executa as buscas de variações em lotes paralelos de 3 para resposta instantânea
        const batchSize = 3;
        for (let i = 0; i < variations.length; i += batchSize) {
            const batch = variations.slice(i, i + batchSize);
            const batchPromises = batch.map(q => 
                this.searchTorrentApi(q, { forcarNaoCam, query: cleanQuery, originalName, ano, tipo, season, episode })
                    .catch(() => [])
            );

            const batchResults = await Promise.all(batchPromises);
            for (const apiResults of batchResults) {
                for (const item of apiResults) {
                    if (item.isPtBr && !seenHashes.has(item.infoHash)) {
                        seenHashes.add(item.infoHash);
                        allResults.push(item);
                    }
                }
            }

            // Para cedo se já encontrou fontes saudáveis suficientes do tipo preferido
            const dubladosComSeeds = allResults.filter(r => r.isDublado && r.seeders >= 3);
            const legendadosComSeeds = allResults.filter(r => r.isLegendado && r.seeders >= 3);
            const targetCount = pref === 'legendado' ? legendadosComSeeds.length : dubladosComSeeds.length;
            if (targetCount >= 3) break;
        }

        // Filtro rigoroso: descarta categoricamente qualquer release 4K/2160p, amostras/trailers e arquivos de tamanho inválido
        let ptBrResults = allResults.filter(r => {
            if (!r.isPtBr) return false;

            // 1. Bloqueia 4K / 2160p / UHD
            const is4k = /\b(2160p|4k|uhd|remux\.2160p)\b/i.test(r.title);
            if (is4k) return false;

            // 2. Bloqueia amostras / trailers explícitos
            const isSampleOrTrailer = /\b(sample|amostra|trailer|teaser|preview)\b/i.test(r.title);
            if (isSampleOrTrailer) return false;

            // 3. Validação de tamanho físico mínimo e máximo
            const sizeMB = parseFloat(r.sizeMB) || ((r.sizeBytes || 0) / (1024 * 1024));
            if (tipo === 'filme') {
                if (sizeMB > 5500) return false; // Máximo 5.5 GB para filmes
                if (sizeMB > 0 && sizeMB < 150) return false; // Mínimo 150 MB para filmes
            } else if (tipo === 'serie') {
                // Se não for season pack (tamanho < 3GB), o episódio avulso deve ter ao menos 40 MB
                if (sizeMB > 0 && sizeMB < 40) return false;
            }

            return true;
        });

        if (forcarNaoCam) {
            ptBrResults = ptBrResults.filter(r => !r.isCam);
        } else {
            // Se já existirem versões oficiais (WEB-DL, BluRay, HDTV) com sementes ativas, descarta categoricamente versões de Cinema (CAM)
            const hasOfficialWithSeeds = ptBrResults.some(r => !r.isCam && (r.seeders || 0) > 0);
            if (hasOfficialWithSeeds) {
                ptBrResults = ptBrResults.filter(r => !r.isCam);
            }
        }

        const dubComSeeds = ptBrResults.filter(r => r.isDublado && (r.seeders || 0) >= 3);
        const shouldFetchLegendado = !options.ignorarFallbackLegendado && (ptBrResults.length === 0 || (pref === 'legendado') || (pref === 'dublado' && dubComSeeds.length === 0));

        // Busca fallback de OpenSubtitles se não houver dublado com seeders saudáveis
        if (shouldFetchLegendado && imdbId) {
            console.log(`🌐 Buscando e incluindo fontes 1080p Legendadas com OpenSubtitles PT-BR para "${cleanQuery}" (${imdbId})...`);
            try {
                const ptSubs = await this.getOpenSubtitlesPT(imdbId, tipo, season, episode);
                if (ptSubs.length > 0) {
                    console.log(`📝 Encontradas ${ptSubs.length} legendas oficiais em Português! Selecionando versões 1080p e Season Packs com sementes ativas...`);
                    const fallbackStreams = await this.searchTorrentioAllStreams(imdbId, tipo, { season, episode });
                    for (const st of fallbackStreams) {
                        if (!ptBrResults.some(r => r.infoHash === st.infoHash)) {
                            st.isPtBr = true;
                            st.isLegendado = true;
                            st.isDublado = false;
                            st.audio = 'Legendado (PT-BR)';
                            st.hasPtSub = true;
                            st.subtitleUrl = ptSubs[0].url;
                            ptBrResults.push(st);
                        }
                    }
                }
            } catch (e) {
                console.warn('⚠️ Falha ao buscar fallback de legendas:', e.message);
            }
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
        const seenHashes = new Set();
        const season = opts.season || 1;
        const episode = opts.episode || 1;
        const streamPath = tipo === 'serie' ? `series/${imdbId}:${season}:${episode}.json` : `movie/${imdbId}.json`;

        const endpoints = [
            `https://torrentio.strem.fun/brazuca/stream/${streamPath}`,
            `https://torrentio.strem.fun/language=portuguese/stream/${streamPath}`,
            `https://torrentio.strem.fun/stream/${streamPath}`
        ];

        const fetchStreams = async (url) => {
            try {
                const https = require('https');
                const agent = new https.Agent({ rejectUnauthorized: false });
                const res = await axios.get(url, { 
                    timeout: this.timeout,
                    httpsAgent: agent,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                return res.data?.streams || [];
            } catch (e) {
                return [];
            }
        };

        try {
            const allStreamArrays = await Promise.all(endpoints.map(fetchStreams));
            const rawStreams = allStreamArrays.flat();

            for (const st of rawStreams) {
                if (!st.infoHash || seenHashes.has(st.infoHash.toLowerCase())) continue;
                seenHashes.add(st.infoHash.toLowerCase());

                const rawTitle = st.title || '';
                const lines = rawTitle.split('\n');
                const title = lines[0] || '';

                // Grupos de lançamento 100% brasileiros
                const isBrazilianGroup = /comando|bludv|lapumia|wolverdon|starck|cinegaveta|vizer|kyogo|lipeh|starckfilmes|filmesmega|guanabara|ondebaixo|acervo|mmfilmes|p2p[-_ ]?br/i.test(rawTitle) || /comando|bludv|lapumia|starck|vizer|ondebaixo/i.test(title);

                // Marcação explícita de PT-BR / Dublado
                const isPtBrExplicit = /(🇧🇷|\b(PT-BR|PT_BR|PTBR|BRAZILIAN|DUBLADO|NACIONAL)\b)/i.test(rawTitle) || /\b(pt-br|ptbr|nacional|dublado)\b/i.test(title);

                // Marcação explícita de Portugal (NUNCA aplicada a grupos brasileiros)
                const isPtPtExplicit = !isBrazilianGroup && !isPtBrExplicit && (/\b(PT-PT|PT_PT|PTPT|EUROPEAN[._ -]?PORTUGUESE|DOBRADO)\b/i.test(rawTitle) || /\b(pt-pt|dobrado)\b/i.test(title));

                const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt[-_ ]?br|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(title);
                const hasPtAudioFlag = (/(Dubbed|Dual Audio|Multi Audio|Dual)/i.test(rawTitle)) && (isPtBrExplicit || isBrazilianGroup || /(🇧🇷|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle));
                const isDualPtInTitle = /\b(dual)\b/i.test(title) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(rawTitle) || !/\b(spanish|latino|hindi|french|german|ita|castellano)\b/i.test(rawTitle));

                const isDublado = (isExplicitPtDubInTitle || isBrazilianGroup || hasPtAudioFlag || isDualPtInTitle) && !isPtPtExplicit;

                const isExplicitLegendadoInTitle = /\b(legendado|legendas|legenda|sub[-_ ]?pt[-_ ]?br|subs?\.pob|pt[-_ ]?subs?|hc-sub)\b/i.test(title);
                const hasPtSubFlag = (/(Multi Subs|Subtitles|Subs:?)/i.test(rawTitle)) && (isPtBrExplicit || /(🇧🇷|\b(PT|POR|PORTUGUESE|PT-BR)\b)/i.test(rawTitle)) && !isPtPtExplicit;
                const isOriginalForSub = (opts.audioPreference === 'legendado' || opts.allowOriginalAudio) && !isPtPtExplicit && !/\b(hindi|telugu|tamil|russian|ita|french|german)\b/i.test(rawTitle);

                const isLegendado = !isDublado && (isExplicitLegendadoInTitle || hasPtSubFlag || (isBrazilianGroup && /\b(leg|legendado)\b/i.test(title)) || isOriginalForSub);

                // Se não tiver nem áudio dublado nem legenda/original apto para OpenSubtitles, descarta imediatamente
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

                if (tipo === 'serie' && episode) {
                    const epInt = parseInt(episode, 10);
                    // Match de faixa de episódios com ou sem prefixo "e/ep" (ex: "0892 ~ 1089", "E01-E24", "01-12", "0892-1089")
                    const cleanTitleForEp = title
                        .replace(/\b(1080p|720p|480p|2160p|4k|x264|x265|hevc|aac|10bit|dual|dublado|legendado)\b/gi, '')
                        .replace(/\b(19\d{2}|20\d{2})\b/g, '');

                    const rangeMatch = cleanTitleForEp.match(/\b(?:e|ep|episodio|episódio)?\s*0*(\d{1,4})\s*(?:-|~|a|e|to)\s*(?:e|ep)?0*(\d{1,4})\b/i);
                    const epMatch = cleanTitleForEp.match(/\b(?:e|ep|episodio|episódio|x)\s*0*(\d{1,4})\b/i) ||
                                    cleanTitleForEp.match(/(?:^|[._ -])(?:-\s*)?0*(\d{2,4})(?:[._ -]|$)/);

                    if (rangeMatch) {
                        const startEp = parseInt(rangeMatch[1], 10);
                        const endEp = parseInt(rangeMatch[2], 10);
                        if (epInt < startEp || epInt > endEp) {
                            continue; // Rejeita lotes que não contêm o episódio desejado
                        }
                    } else if (epMatch) {
                        const foundEp = parseInt(epMatch[1], 10);
                        if (foundEp !== epInt && foundEp < 1900 && foundEp !== 1080 && foundEp !== 720 && foundEp !== 480 && foundEp !== 2160) {
                            continue; // Rejeita episódios divergentes (ex: 892 quando buscamos 3)
                        }
                    }
                }

                const sourceGroup = rawTitle.match(/⚙️\s*([^\n\r]+)/)?.[1]?.trim() || 'Stremio';
                const magnet = `magnet:?xt=urn:btih:${st.infoHash.toLowerCase()}&dn=${encodeURIComponent(title)}`;
                const isCam = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|gravado\s*no\s*cinema|audio\s*cinema|som\s*cinema|audio\s*de\s*cinema|som\s*de\s*cinema|line\s*audio|mic\s*audio|hq-cam|new-cam|cam-1080p|cam-720p|tc|telecine|workprint|wp)\b/i.test(title);
                const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(title) && !isCam;
                const is4k = /\b(2160p|4k|uhd|remux\.2160p)\b/i.test(rawTitle) || /\b(2160p|4k|uhd)\b/i.test(title);

                results.push({
                    title: title,
                    infoHash: st.infoHash.toLowerCase(),
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

    async getOpenSubtitlesPT(imdbId, tipo = 'filme', season = 1, episode = 1) {
        if (!imdbId) return [];
        const cacheKey = `${imdbId}_${tipo}_${season}_${episode}`;
        if (this._subCache && this._subCache.has(cacheKey)) {
            const cached = this._subCache.get(cacheKey);
            if (Date.now() - cached.time < 30 * 60 * 1000) {
                return cached.subs;
            }
        }

        const https = require('https');
        const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
        const streamPath = tipo === 'serie' ? `series/${imdbId}:${season}:${episode}.json` : `movie/${imdbId}.json`;
        
        const endpoints = [
            `https://opensubtitles-v3.strem.io/subtitles/${streamPath}`,
            `https://subtitles.strem.io/subtitles/${streamPath}`,
            `https://opensubtitles-v8.strem.io/subtitles/${streamPath}`
        ];

        for (const url of endpoints) {
            try {
                const res = await axios.get(url, { 
                    timeout: 6000, 
                    httpsAgent: agent,
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Stremio/4.4.168' }
                });
                const subs = res.data?.subtitles || [];
                const ptSubs = subs.filter(s => {
                    const lang = (s.lang || s.language || '').toLowerCase();
                    return ['pob', 'por', 'pt', 'pt-br', 'ptbr', 'brazilian'].includes(lang);
                });

                if (ptSubs.length > 0) {
                    if (!this._subCache) this._subCache = new Map();
                    this._subCache.set(cacheKey, { subs: ptSubs, time: Date.now() });
                    return ptSubs;
                }
            } catch (e) {
                // Tenta próximo endpoint silenciosamente
            }
        }

        return [];
    }

    async searchTorrentioAllStreams(imdbId, tipo = 'filme', opts = {}) {
        if (!imdbId) return [];
        const results = [];
        try {
            const https = require('https');
            const agent = new https.Agent({ rejectUnauthorized: false });
            const season = opts.season || 1;
            const episode = opts.episode || 1;
            const streamPath = tipo === 'serie' ? `series/${imdbId}:${season}:${episode}.json` : `movie/${imdbId}.json`;
            const url = `https://torrentio.strem.fun/stream/${streamPath}`;
            
            const response = await axios.get(url, { timeout: this.timeout, httpsAgent: agent });
            const streams = response.data?.streams || [];

            for (const st of streams) {
                const rawTitle = st.title || '';
                const lines = rawTitle.split('\n');
                const title = lines[0] || '';

                const isCam = /\b(cam|camrip|hdcam|hdts|telesync|ts)\b/i.test(title);
                if (isCam) continue;

                const is4k = /\b(2160p|4k|uhd)\b/i.test(title);
                if (is4k) continue;

                const is1080p = /\b(1080p|fhd)\b/i.test(title);
                const isWebDl = /\b(web-dl|webrip|web|bluray|bdrip|brrip)\b/i.test(title);

                const seedersMatch = rawTitle.match(/👤\s*(\d+)/);
                const seeders = seedersMatch ? parseInt(seedersMatch[1], 10) : 0;

                const sizeMatch = rawTitle.match(/💾\s*([\d\.]+)\s*(GB|MB)/i);
                let sizeMB = 0;
                if (sizeMatch) {
                    const val = parseFloat(sizeMatch[1]);
                    sizeMB = sizeMatch[2].toUpperCase() === 'GB' ? (val * 1024).toFixed(1) : val.toFixed(1);
                }

                if (tipo === 'filme' && parseFloat(sizeMB) > 5500) continue;
                if (tipo === 'filme' && parseFloat(sizeMB) < 400) continue;

                const magnet = `magnet:?xt=urn:btih:${st.infoHash}&dn=${encodeURIComponent(title)}`;
                const sourceGroup = rawTitle.match(/⚙️\s*([^\n\r]+)/)?.[1]?.trim() || 'Stremio 1080p';

                results.push({
                    title: title,
                    infoHash: st.infoHash,
                    source: `Torrentio (${sourceGroup})`,
                    magnet: magnet,
                    sizeBytes: parseFloat(sizeMB) * 1024 * 1024,
                    sizeMB: sizeMB,
                    seeders: seeders,
                    isCam: false,
                    isWebDl: isWebDl,
                    is4k: false,
                    quality: is1080p ? '1080p Full HD' : '720p HD',
                    audio: 'Legendado (PT-BR)',
                    isPtBr: true,
                    isPtBrExplicit: true,
                    isPtPt: false,
                    isDublado: false,
                    isLegendado: true
                });
            }
        } catch (e) {
            console.warn('⚠️ Erro ao consultar Torrentio para streams legendados:', e.message);
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
            .replace(/\b(s\d+e\d+|s\d+|e\d+|ep\d+|\d+x\d+|temporada\s*\d+|season\s*\d+|completa|complete)\b/gi, '')
            .replace(/\b(2160p|1080p|720p|480p|4k|2k|fhd|uhd|bluray|blu-ray|bdrip|brrip|web-dl|webrip|web|hdtv|hdrip|dvdrip|dvd|remux|telesync|hdts|ts|cam|camrip|hdcam|x264|x265|hevc|h264|h265|aac|ac3|dts|ddp\d*|atmos|mp3|eac3|flac|mkv|mp4|avi|dublado|dual|legendado|nacional|pt-br|ptbr|sub|multi|dl|hc-sub|pre)\b/gi, '')
            .replace(/\b(www|com|br|org|net|acesse|ondebaixo|comandotorrents|bludv|lapumia|wolverdon|starck|vizer|acervo|yg|1xbet|mostbet|remuxdoc|lmntry|maze|ddr|tmb|psa|galaxyrg|rarbg|tgx|megusta|ntb|yify|yts)\b/gi, '')
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

        if (qTokens.length > 0 && qTokens.every(q => tTokens.includes(q))) {
            return 0.95;
        }

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
        const seenHashes = new Set();

        const parseAndAdd = (name, infoHash, sizeBytes, seeders, sourceName) => {
            if (!name || !infoHash || seenHashes.has(infoHash.toLowerCase())) return;
            seenHashes.add(infoHash.toLowerCase());

            if (opts.query && !this.matchesMovieTitle(name, opts.query, opts.originalName, opts.ano)) {
                return;
            }

            const isBrazilianGroup = /yg⭐|dual[._ -]?yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|kyogo|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(name);
            const isPtBrExplicit = /\b(pt[-_]?br|ptbr|pt_br|brazilian|nacional|dublado)\b/i.test(name) || isBrazilianGroup;
            const isPtPtExplicit = !isBrazilianGroup && !isPtBrExplicit && /\b(pt[-_]?pt|pt_pt|ptpt|dobrado|european[._ -]?portuguese)\b/i.test(name);
            const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(name);
            const isDualPtInTitle = /\b(dual)\b/i.test(name) && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(name));

            const isDublado = (isExplicitPtDubInTitle || isBrazilianGroup || isDualPtInTitle) && !isPtPtExplicit;
            const isLegendadoPt = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br)\b/i.test(name);
            const isExplicitPtBrSub = /\b(pt[-_]?br|ptbr|pt_br|portugues[a-z]*|brazilian)\b/i.test(name);
            const isOriginalForSub = (opts.audioPreference === 'legendado' || opts.allowOriginalAudio) && !isPtPtExplicit && !/\b(hindi|telugu|tamil|russian|ita|french|german)\b/i.test(name);
            const isLegendado = !isDublado && (isLegendadoPt || isExplicitPtBrSub || isOriginalForSub) && !isPtPtExplicit;

            // Se não tiver nem áudio dublado nem legenda em português comprovada nem original para OpenSubtitles, descarta
            if (!isDublado && !isLegendado) {
                return;
            }

            if (opts.tipo === 'serie') {
                if (opts.season) {
                    const sPad = String(opts.season).padStart(2, '0');
                    const sRegex = new RegExp(`\\b(s${opts.season}|s${sPad}|temporada\\s*${opts.season}|temporada\\s*${sPad}|season\\s*${opts.season}|season\\s*${sPad}|${opts.season}ª\\s*temporada)\\b`, 'i');
                    const hasSeason = sRegex.test(name);
                    const hasAnySeason = /\b(s\d+|temporada\s*\d+|season\s*\d+|\d+x\d+)\b/i.test(name);
                    
                    if (hasAnySeason && !hasSeason) {
                        return;
                    }
                }

                if (opts.episode) {
                    const rangeMatch = name.match(/\b(?:e|ep|episodio|episódio)\s*0*(\d{1,3})\s*(?:-|~|a|e|to)\s*e?0*(\d{1,3})\b/i);
                    const epMatch = name.match(/\b(?:e|ep|episodio|episódio|x)\s*0*(\d{1,3})\b/i);
                    const isPack = /\b(complete|completa|season[._ -]?\d+|temporada[._ -]?\d+|pack|all[._ -]?episodes|s\d{1,2}(?![._ -]?e\d+))\b/i.test(name) && !epMatch && !rangeMatch;

                    if (rangeMatch) {
                        const startEp = parseInt(rangeMatch[1], 10);
                        const endEp = parseInt(rangeMatch[2], 10);
                        if (opts.episode < startEp || opts.episode > endEp) {
                            return;
                        }
                    } else if (epMatch) {
                        const foundEp = parseInt(epMatch[1], 10);
                        if (foundEp !== opts.episode) {
                            return; // Rejeita episódios divergentes (ex: E17 quando buscamos E02)
                        }
                    } else if (!isPack) {
                        return;
                    }
                }
            }

            // Descarta 4K / 2160p
            if (/\b(2160p|4k|uhd|remux\.2160p)\b/i.test(name)) return;

            const maxAllowedBytes = opts.tipo === 'serie' ? (80 * 1024 * 1024 * 1024) : (5.5 * 1024 * 1024 * 1024);
            if (sizeBytes > maxAllowedBytes) return;

            const isCam = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|gravado\s*no\s*cinema|audio\s*cinema|som\s*cinema|audio\s*de\s*cinema|som\s*de\s*cinema|line\s*audio|mic\s*audio|hq-cam|new-cam|cam-1080p|cam-720p|tc|telecine|workprint|wp)\b/i.test(name);
            const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(name) && !isCam;
            const is1080p = (/\b(1080p|fhd|fullhd|bluray|web-dl|1080)\b/i.test(name)) && !isCam;

            if (isCam && (opts.forcarNaoCam || (!config.ALLOW_CINEMA_CAM && !opts.allowCam))) return;

            results.push({
                title: name,
                infoHash: infoHash.toLowerCase(),
                source: sourceName,
                magnet: `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(name)}`,
                sizeBytes: sizeBytes,
                sizeMB: (sizeBytes / (1024 * 1024)).toFixed(1),
                seeders: seeders || 0,
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
        };

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        };

        // Executa buscas paralelas em BitSearch, SolidTorrents e ApiBay
        const searches = [
            // 1. BitSearch
            axios.get(`https://bitsearch.to/api/v1/search?q=${encodeURIComponent(query)}`, { timeout: 6000, headers })
                .then(res => {
                    const items = res.data?.results || [];
                    for (const it of items) {
                        parseAndAdd(it.title, it.infohash, it.size || 0, it.seeders || 0, 'BitSearch');
                    }
                }).catch(() => {}),

            // 2. SolidTorrents
            axios.get(`https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(query)}`, { timeout: 6000, headers })
                .then(res => {
                    const items = res.data?.results || [];
                    for (const it of items) {
                        parseAndAdd(it.title, it.infohash, it.size || 0, it.seeders || 0, 'SolidTorrents');
                    }
                }).catch(() => {}),

            // 3. ApiBay (ThePirateBay)
            axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, { timeout: 6000, headers })
                .then(res => {
                    if (Array.isArray(res.data) && res.data.length > 0 && res.data[0].id !== '0') {
                        for (const it of res.data.slice(0, 30)) {
                            parseAndAdd(it.name, it.info_hash, parseInt(it.size || 0, 10), parseInt(it.seeders || 0, 10), 'ThePirateBay');
                        }
                    }
                }).catch(() => {})
        ];

        await Promise.all(searches);
        return results;
    }

    rankResults(results, query, options = {}) {
        if (!results || results.length === 0) return [];

        const pref = options.audioPreference || 'dublado';
        const tipo = options.tipo || 'filme';

        return [...results].sort((a, b) => {
            let scoreA = 0;
            let scoreB = 0;

            // 1. Preferência de Áudio (DUBLADO É PRIORIDADE MÁXIMA ABSOLUTA)
            if (pref === 'legendado') {
                if (a.isLegendado) scoreA += 5000;
                if (b.isLegendado) scoreB += 5000;
                if (a.isDublado) scoreA += 400;
                if (b.isDublado) scoreB += 400;
            } else {
                // Modo padrão: DUBLADO (PT-BR) ganha +5000 pontos para NUNCA perder para releases legendados em inglês
                if (a.isDublado) scoreA += 5000;
                if (b.isDublado) scoreB += 5000;
                if (a.isLegendado) scoreA += 300;
                if (b.isLegendado) scoreB += 300;
            }

            // 2. Fidelidade PT-BR vs PT-PT
            if (a.isPtBrExplicit) scoreA += 600;
            if (b.isPtBrExplicit) scoreB += 600;
            if (a.isPtPt) scoreA -= 2000;
            if (b.isPtPt) scoreB -= 2000;

            // 3. Formato e Qualidade
            if (a.isWebDl) scoreA += 1500;
            if (b.isWebDl) scoreB += 1500;

            if (a.isCam) scoreA -= 8000;
            if (b.isCam) scoreB -= 8000;

            const is1080pA = /\b(1080p|1080|fhd|fullhd)\b/i.test(a.title);
            const is1080pB = /\b(1080p|1080|fhd|fullhd)\b/i.test(b.title);
            if (is1080pA) scoreA += 600;
            if (is1080pB) scoreB += 600;

            const is720pA = /\b(720p|720|hd)\b/i.test(a.title) && !is1080pA;
            const is720pB = /\b(720p|720|hd)\b/i.test(b.title) && !is1080pB;
            if (is720pA) scoreA += 300;
            if (is720pB) scoreB += 300;

            // 4. SAÚDE DA FONTE: Prioriza fontes com 3+ seeders (rápidas) e coloca fontes com <= 2 seeders para o fim da lista
            const seedsA = a.seeders || 0;
            const seedsB = b.seeders || 0;

            if (seedsA >= 25) scoreA += 2500;
            else if (seedsA >= 10) scoreA += 1800;
            else if (seedsA >= 5) scoreA += 1200;
            else if (seedsA >= 3) scoreA += 600;
            else if (seedsA > 0) scoreA -= 1000; // 1 ou 2 seeds vão para baixo
            else scoreA -= 2500; // 0 seeds vai para o fim da lista de tentativas

            if (seedsB >= 25) scoreB += 2500;
            else if (seedsB >= 10) scoreB += 1800;
            else if (seedsB >= 5) scoreB += 1200;
            else if (seedsB >= 3) scoreB += 600;
            else if (seedsB > 0) scoreB -= 1000;
            else scoreB -= 2500;

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

                // 6. PRIORIDADE MÁXIMA PARA TEMPORADA COMPLETA / SEASON PACKS (Todos os episódios juntos)
                const isPackA = /\b(complete|completa|season[._ -]?\d+|temporada[._ -]?\d+|s\d{2}[._ -]?(complete|dual|dublado|1080p)|pack|all[._ -]?episodes)\b/i.test(a.title) && !/\b(e\d{2}|ep\d{2}|episodio)\b/i.test(a.title);
                const isPackB = /\b(complete|completa|season[._ -]?\d+|temporada[._ -]?\d+|s\d{2}[._ -]?(complete|dual|dublado|1080p)|pack|all[._ -]?episodes)\b/i.test(b.title) && !/\b(e\d{2}|ep\d{2}|episodio)\b/i.test(b.title);

                if (isPackA && (a.seeders || 0) > 0) scoreA += 2000;
                if (isPackB && (b.seeders || 0) > 0) scoreB += 2000;
            }

            return scoreB - scoreA;
        });
    }
}

module.exports = new MediaSearchService();
