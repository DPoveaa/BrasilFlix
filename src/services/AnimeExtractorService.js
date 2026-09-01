const axios = require('axios');

class AnimeExtractorService {
    constructor() {
        this.baseUrl = 'https://meusanimes.blog';
        this.cachedNonce = null;
        this.nonceTime = 0;
        this.timeout = 8000;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    }

    async getNonce() {
        const now = Date.now();
        // Cache nonce for 10 minutes
        if (this.cachedNonce && (now - this.nonceTime < 600000)) {
            return this.cachedNonce;
        }

        try {
            const res = await axios.get(this.baseUrl, {
                headers: { 'User-Agent': this.userAgent },
                timeout: this.timeout
            });
            const match = res.data.match(/"nonce":"([a-f0-9]+)"/);
            if (match) {
                this.cachedNonce = match[1];
                this.nonceTime = now;
                return this.cachedNonce;
            }
        } catch (e) {
            console.warn('⚠️ [AnimeExtractor] Falha ao obter nonce do MeusAnimes:', e.message);
        }
        return this.cachedNonce || '8722e8e076';
    }

    cleanQuery(text) {
        if (!text) return '';
        return text
            .replace(/\s*\(\d{4}\)|\b\d{4}\b/g, '')
            .replace(/[:\-–—]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    normalizeForComparison(text) {
        if (!text) return '';
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '')
            .trim();
    }

    async searchSite(keyword) {
        try {
            const nonce = await this.getNonce();
            const url = `${this.baseUrl}/wp-json/dooplay/search/?nonce=${nonce}&keyword=${encodeURIComponent(keyword)}`;
            const res = await axios.get(url, {
                headers: {
                    'User-Agent': this.userAgent,
                    'Referer': `${this.baseUrl}/`
                },
                timeout: this.timeout
            });

            if (res.data && typeof res.data === 'object') {
                return Object.values(res.data);
            }
            return [];
        } catch (e) {
            console.warn(`⚠️ [AnimeExtractor] Erro na busca por "${keyword}":`, e.message);
            return [];
        }
    }

    matchPost(entries, query, isDublado = false, year = null) {
        if (!entries || entries.length === 0) return null;
        const normQuery = this.normalizeForComparison(query);

        // Filter entries according to dub/sub preference
        let filtered = entries.filter(e => {
            const titleLower = (e.title || '').toLowerCase();
            if (isDublado) {
                return titleLower.includes('dublado');
            } else {
                return !titleLower.includes('dublado');
            }
        });

        if (filtered.length === 0) {
            filtered = entries;
        }

        // Score results
        let best = null;
        let bestScore = -1;

        for (const item of filtered) {
            let score = 0;
            const normTitle = this.normalizeForComparison(item.title);
            const itemTitleLower = (item.title || '').toLowerCase();

            if (normTitle === normQuery || normTitle === `${normQuery}dublado`) score += 100;
            else if (normTitle.includes(normQuery) || normQuery.includes(normTitle.replace('dublado', ''))) score += 70;

            if (isDublado && itemTitleLower.includes('dublado')) score += 30;
            if (!isDublado && !itemTitleLower.includes('dublado')) score += 30;

            if (year && item.extra?.date && String(item.extra.date) === String(year)) {
                score += 20;
            }

            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }

        return bestScore >= 40 ? best : null;
    }

    async resolveDirectVideoUrl(iframeSrc) {
        if (!iframeSrc) return null;

        try {
            // Pattern: serv01.meusdoramas.club/#/video/{id}/{season}/{episode}/
            const match = iframeSrc.match(/\/video\/(\d+)\/(\d+)\/(\d+)\//);
            if (!match) return null;

            const [, tmdbOrPostId, seasonNum, epNum] = match;

            const res = await axios.get('https://serv01.meusdoramas.club/posts/get-video.php', {
                params: {
                    episode_number: epNum,
                    season_number: seasonNum,
                    tmdb: tmdbOrPostId
                },
                headers: {
                    'Referer': 'https://serv01.meusdoramas.club/',
                    'User-Agent': this.userAgent
                },
                timeout: this.timeout
            });

            if (!res.data?.success || !res.data?.videoUrl) {
                return null;
            }

            let videoUrl = res.data.videoUrl;

            // Handle multi-server selector (e.g. serv01.meusdoramas.club/e/?a=...&b=...)
            if (videoUrl.includes('/e/?')) {
                const selRes = await axios.get(videoUrl, {
                    headers: { 'Referer': 'https://serv01.meusdoramas.club/', 'User-Agent': this.userAgent },
                    timeout: this.timeout
                });

                const iframeParamMatch = selRes.data.match(/location\.href=['"]iframe\.php\?([^'"]+)['"]/);
                if (iframeParamMatch) {
                    const subParam = iframeParamMatch[1]; // e.g. a=16698091/1/2/
                    const parts = subParam.split('=')[1]?.split('/');
                    if (parts && parts.length >= 3) {
                        const subEp = parts[2];
                        const subRes = await axios.get('https://serv01.meusdoramas.club/posts/get-video.php', {
                            params: {
                                episode_number: subEp,
                                season_number: seasonNum,
                                tmdb: tmdbOrPostId
                            },
                            headers: { 'Referer': 'https://serv01.meusdoramas.club/', 'User-Agent': this.userAgent },
                            timeout: this.timeout
                        });
                        if (subRes.data?.videoUrl) {
                            videoUrl = subRes.data.videoUrl;
                        }
                    }
                }
            }

            // If embed URL (video.meusdoramas.club/embed/{uuid})
            if (videoUrl && videoUrl.includes('/embed/')) {
                const embedRes = await axios.get(videoUrl, {
                    headers: { 'Referer': 'https://serv01.meusdoramas.club/', 'User-Agent': this.userAgent },
                    timeout: this.timeout
                });
                const configMatch = embedRes.data.match(/var\s+config\s*=\s*(\{[\s\S]*?\});\s*(?:var|vp|if)/);
                if (configMatch) {
                    try {
                        const cfg = JSON.parse(configMatch[1]);
                        const directFile = cfg.sources?.[0]?.file || cfg.sources?.[0]?.src;
                        if (directFile && directFile.startsWith('http')) {
                            return directFile;
                        }
                    } catch (e) {}
                }

                // Fallback: look for direct mp4 file in embed HTML
                const mp4Match = embedRes.data.match(/"file"\s*:\s*"([^"]+\.mp4[^"]*)"/i);
                if (mp4Match) {
                    return mp4Match[1].replace(/\\\//g, '/');
                }
            }

            // Direct mp4 stream url
            if (typeof videoUrl === 'string' && (videoUrl.includes('.mp4') || videoUrl.includes('.mkv') || videoUrl.includes('.m3u8'))) {
                return videoUrl;
            }

            return null;
        } catch (e) {
            console.warn('⚠️ [AnimeExtractor] Falha ao resolver URL do player:', e.message);
            return null;
        }
    }

    async getMediaSizeMB(url) {
        try {
            const head = await axios.head(url, {
                headers: { 'User-Agent': this.userAgent },
                timeout: 5000
            });
            const bytes = parseInt(head.headers['content-length'] || 0, 10);
            if (bytes > 0) {
                return Math.round(bytes / (1024 * 1024));
            }
        } catch (e) {}
        return 180; // Default estimate
    }

    toAbsoluteUrl(url) {
        if (!url) return '';
        if (url.startsWith('http://') || url.startsWith('https://')) return url;
        return `${this.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
    }

    async searchAnime(query, tipo = 'serie', options = {}) {
        const cleanTitle = this.cleanQuery(query);
        const originalName = options.nomeOriginal ? this.cleanQuery(options.nomeOriginal) : null;
        const season = parseInt(options.season || 1, 10);
        const episode = parseInt(options.episode || 1, 10);
        const audioPref = options.audioPreference || 'dublado';
        const year = options.ano || options.year || null;

        const results = [];
        const seenUrls = new Set();

        const searchQueries = [];
        if (audioPref === 'dublado') {
            searchQueries.push({ q: `${cleanTitle} Dublado`, isDub: true });
            searchQueries.push({ q: cleanTitle, isDub: false }); // Fallback if general allows
            if (originalName && originalName !== cleanTitle) {
                searchQueries.push({ q: `${originalName} Dublado`, isDub: true });
            }
        } else if (audioPref === 'legendado') {
            searchQueries.push({ q: cleanTitle, isDub: false });
            if (originalName && originalName !== cleanTitle) {
                searchQueries.push({ q: originalName, isDub: false });
            }
        } else {
            // Geral: tenta ambos
            searchQueries.push({ q: `${cleanTitle} Dublado`, isDub: true });
            searchQueries.push({ q: cleanTitle, isDub: false });
        }

        for (const sq of searchQueries) {
            try {
                // If user specifically requested Dublado and catalog already has Legendado, avoid searching subbed
                if (options.ignorarFallbackLegendado && !sq.isDub) continue;
                if (options.ignorarFallbackDublado && sq.isDub) continue;

                const entries = await this.searchSite(sq.q);
                if (entries.length === 0) continue;

                const targetPost = this.matchPost(entries, sq.q, sq.isDub, year);
                if (!targetPost || !targetPost.url) continue;

                const targetPostUrl = this.toAbsoluteUrl(targetPost.url);

                // Fetch post page
                const postPage = await axios.get(targetPostUrl, {
                    headers: { 'User-Agent': this.userAgent },
                    timeout: this.timeout
                });

                let episodeUrl = null;

                // If direct episode link (/e/)
                if (targetPostUrl.includes('/e/')) {
                    episodeUrl = targetPostUrl;
                } else {
                    // Extract episode links from the anime listing page (/a/)
                    const epRegex = /href=['"](https?:\/\/[^'"]*meusanimes\.blog\/e\/[^'"]+|\/e\/[^'"]+)['"]/g;
                    const allLinks = [];
                    let epMatch;
                    while ((epMatch = epRegex.exec(postPage.data)) !== null) {
                        const linkAbs = this.toAbsoluteUrl(epMatch[1]);
                        if (linkAbs !== `${this.baseUrl}/e/` && !allLinks.includes(linkAbs)) {
                            allLinks.push(linkAbs);
                        }
                    }

                    if (tipo === 'filme') {
                        // Para filmes, pega o link de episódio/player correspondente ou converte o slug /a/ para /e/
                        episodeUrl = allLinks[0] || targetPostUrl.replace('/a/', '/e/');
                    } else if (allLinks.length > 0) {
                        // Para séries, localiza o episódio exato da temporada solicitada
                        let matched = allLinks.find(l => {
                            const lower = l.toLowerCase();
                            if (season > 1) {
                                return lower.includes(`-${season}-episodio-${episode}/`) || lower.includes(`-${season}-episodio-${episode}-`);
                            } else {
                                return lower.includes(`-1-episodio-${episode}/`) || lower.includes(`-episodio-${episode}/`);
                            }
                        });

                        if (!matched) {
                            matched = allLinks.find(l => l.toLowerCase().includes(`-episodio-${episode}/`));
                        }

                        episodeUrl = matched || allLinks[0];
                    }
                }

                if (!episodeUrl) continue;

                const finalEpisodeUrl = this.toAbsoluteUrl(episodeUrl);

                // Fetch episode page to get iframe
                const epPage = await axios.get(finalEpisodeUrl, {
                    headers: { 'User-Agent': this.userAgent },
                    timeout: this.timeout
                });

                const iframeMatch = epPage.data.match(/<iframe[^>]+src=['"]([^'"]+)['"]/i);
                if (!iframeMatch) continue;

                const directVideoUrl = await this.resolveDirectVideoUrl(iframeMatch[1]);
                if (directVideoUrl && !seenUrls.has(directVideoUrl)) {
                    seenUrls.add(directVideoUrl);

                    const sizeMB = await this.getMediaSizeMB(directVideoUrl);
                    const isDub = sq.isDub || targetPost.title.toLowerCase().includes('dublado');
                    const audioLabel = isDub ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)';

                    results.push({
                        title: `[Web Direct] ${targetPost.title} ${tipo === 'serie' ? `T${season}E${episode}` : ''} - 1080p Web-DL [${audioLabel}]`,
                        url: directVideoUrl,
                        isDirect: true,
                        isWebDl: true,
                        isDublado: isDub,
                        isLegendado: !isDub,
                        isPtBr: true,
                        isPtBrExplicit: true,
                        isCam: false,
                        audio: audioLabel,
                        provider: 'MeusAnimes Web Direct',
                        sizeMB: sizeMB,
                        seeders: 999, // Max priority for fast direct CDN
                        quality: '1080p Full HD'
                    });

                    // If we found the exact preference requested, we can stop searching more variations
                    if (audioPref === 'dublado' && isDub) break;
                    if (audioPref === 'legendado' && !isDub) break;
                }

            } catch (e) {
                console.warn(`⚠️ [AnimeExtractor] Erro ao extrair "${sq.q}":`, e.message);
            }
        }

        return results;
    }
}

module.exports = new AnimeExtractorService();
