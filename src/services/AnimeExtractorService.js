const axios = require('axios');

class AnimeExtractorService {
    constructor() {
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        this.timeout = 12000;
    }

    normalizeText(text) {
        return (text || '')
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    scoreAnimeMatch(itemTitle, itemUrl, query, wantsDublado) {
        const normTitle = this.normalizeText(itemTitle);
        const normUrl = this.normalizeText(itemUrl);
        const normQuery = this.normalizeText(query);

        let score = 0;
        const isItemDublado = normTitle.includes('dublado') || normUrl.includes('dublado');

        // 1. Prioridade absoluta para correspondência exata do título base
        if (normTitle === normQuery) {
            score += 100;
        } else if (normTitle === `${normQuery} dublado` || normTitle === `dublado ${normQuery}`) {
            score += 100;
        } else if (normTitle.startsWith(normQuery) && !normTitle.includes('sennen') && !normTitle.includes('final') && !normTitle.includes('season')) {
            score += 70;
        } else if (normTitle.includes(normQuery)) {
            score += 40;
        }

        // 2. Ajuste pelo tipo de áudio desejado
        if (wantsDublado) {
            if (isItemDublado) {
                score += 50;
            } else {
                score -= 40; // Penaliza versão legendada se o usuário quer dublado
            }
        } else {
            if (!isItemDublado) {
                score += 30;
            } else {
                score -= 30; // Penaliza versão dublada se o usuário quer legendado
            }
        }

        // 3. Penaliza sequels/spin-offs indesejados se a busca não os mencionou
        const queryHasSennen = normQuery.includes('sennen') || normQuery.includes('thousand');
        const queryHasFinal = normQuery.includes('final');
        if (!queryHasSennen && (normTitle.includes('sennen') || normTitle.includes('thousand'))) {
            score -= 35;
        }
        if (!queryHasFinal && normTitle.includes('final season')) {
            score -= 35;
        }

        return score;
    }

    // =========================================================================
    // 1. PROVEDOR PRINCIPAL: AnimesDigital (m3u8 CDN Direto em Alta Velocidade)
    // =========================================================================
    async searchAnimesDigital(title, isDublado = false) {
        try {
            const cleanQuery = title.replace(/[^\w\s]/gi, ' ').trim();
            const searchUrl = `https://animesdigital.org/?s=${encodeURIComponent(cleanQuery)}`;
            const res = await axios.get(searchUrl, {
                headers: { 'User-Agent': this.userAgent },
                timeout: this.timeout
            });
            const html = res.data;

            const regex = /<a[^>]+href=['"](https:\/\/animesdigital\.org\/anime\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
            const results = [];
            let m;
            while ((m = regex.exec(html)) !== null) {
                const url = m[1];
                const rawTitle = m[2].replace(/<[^>]+>/g, '').trim();
                if (rawTitle && !results.find(r => r.url === url)) {
                    results.push({ url, title: rawTitle });
                }
            }

            results.sort((a, b) => {
                const scoreA = this.scoreAnimeMatch(a.title, a.url, title, isDublado);
                const scoreB = this.scoreAnimeMatch(b.title, b.url, title, isDublado);
                return scoreB - scoreA;
            });

            return results;
        } catch (e) {
            console.warn('⚠️ [AnimeExtractor] Falha na busca AnimesDigital:', e.message);
            return [];
        }
    }

    async getAnimesDigitalStream(animeUrl, targetSeason = 1, targetEpisode = 1) {
        try {
            let currentUrl = animeUrl;
            let res = await axios.get(currentUrl, {
                headers: { 'User-Agent': this.userAgent },
                timeout: this.timeout
            });
            let html = res.data;

            const parseEpsFromHtml = (h) => {
                const regex = /<a[^>]+href=['"](https:\/\/animesdigital\.org\/video\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
                const eps = [];
                let m;
                while ((m = regex.exec(h)) !== null) {
                    const epUrl = m[1];
                    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                    if (!eps.find(e => e.url === epUrl)) {
                        const epMatch = text.match(/epis[oó]dio\s*(\d+)/i) || epUrl.match(/\/(\d+)\/?$/);
                        eps.push({
                            url: epUrl,
                            title: text,
                            episodeNumber: epMatch ? parseInt(epMatch[1], 10) : null
                        });
                    }
                }
                return eps;
            };

            let episodes = parseEpsFromHtml(html);

            // Suporte a paginação para animes longos (Bleach, Naruto, One Piece, etc.)
            let targetEp = episodes.find(e => e.episodeNumber === targetEpisode);
            if (!targetEp) {
                // Procura links de paginação no HTML (ex: /page/2/, /page/8/)
                const pageMatches = html.match(/href=['"](https:\/\/animesdigital\.org\/anime\/[^'"]+\/page\/(\d+)\/?)['"]/gi) || [];
                const pages = [];
                for (const pm of pageMatches) {
                    const match = pm.match(/href=['"](https:\/\/animesdigital\.org\/anime\/[^'"]+\/page\/(\d+)\/?)['"]/i);
                    if (match) {
                        pages.push({ url: match[1], pageNum: parseInt(match[2], 10) });
                    }
                }

                if (pages.length > 0) {
                    const maxPage = Math.max(...pages.map(p => p.pageNum));
                    // Estima qual página contém o targetEpisode: página 1 tem os maiores episódios, última página tem o ep 1
                    let estimatedPage = 1;
                    if (episodes.length > 0 && episodes[0].episodeNumber) {
                        const maxEpNum = episodes[0].episodeNumber;
                        const epsPerPage = Math.max(1, episodes.length);
                        estimatedPage = Math.min(maxPage, Math.max(1, Math.ceil((maxEpNum - targetEpisode + 1) / epsPerPage)));
                    } else if (targetEpisode <= 50) {
                        estimatedPage = maxPage;
                    }

                    // Tenta a página estimada e também a última página se targetEpisode === 1
                    const pagesToTry = [estimatedPage];
                    if (targetEpisode === 1 && !pagesToTry.includes(maxPage)) {
                        pagesToTry.push(maxPage);
                    }

                    for (const pNum of pagesToTry) {
                        const pageObj = pages.find(p => p.pageNum === pNum);
                        if (!pageObj) continue;
                        try {
                            const pageRes = await axios.get(pageObj.url, {
                                headers: { 'User-Agent': this.userAgent },
                                timeout: this.timeout
                            });
                            const pEps = parseEpsFromHtml(pageRes.data);
                            const found = pEps.find(e => e.episodeNumber === targetEpisode);
                            if (found) {
                                targetEp = found;
                                break;
                            }
                        } catch (ePage) {}
                    }
                }
            }

            // Exige correspondência ESTRITA do número do episódio. NUNCA retorna episódio diferente do solicitado!
            if (!targetEp || targetEp.episodeNumber !== targetEpisode) {
                console.warn(`⚠️ [AnimeExtractor] Episódio ${targetEpisode} exato não localizado via AnimesDigital Web Direct. Ignorando stream aproximado para evitar episódio errado.`);
                return null;
            }

            if (!targetEp) return null;

            const epRes = await axios.get(targetEp.url, {
                headers: { 'User-Agent': this.userAgent, 'Referer': animeUrl },
                timeout: this.timeout
            });
            const epHtml = epRes.data;

            const iframeRegex = /<iframe[^>]+src=['"]([^'"]+)['"][^>]*>/gi;
            let im;
            while ((im = iframeRegex.exec(epHtml)) !== null) {
                const src = im[1];
                if (src.includes('videohls.php?d=')) {
                    const directUrl = decodeURIComponent(src.split('videohls.php?d=')[1].split('&')[0]);
                    return {
                        streamUrl: directUrl,
                        referer: 'https://animesdigital.org/',
                        episodeTitle: targetEp.title,
                        provider: 'AnimesDigital CDN'
                    };
                }
            }

            return null;
        } catch (e) {
            console.warn('⚠️ [AnimeExtractor] Falha ao extrair stream AnimesDigital:', e.message);
            return null;
        }
    }

    // =========================================================================
    // 2. PROVEDOR SECUNDÁRIO (FALLBACK): TopAnimes
    // =========================================================================
    async getTopAnimesNonce() {
        try {
            const res = await axios.get('https://topanimes.net/', {
                headers: { 'User-Agent': this.userAgent },
                timeout: 8000
            });
            const m = res.data.match(/["']nonce["'][^'"]*["']([a-f0-9]{8,12})["']/i)
                || res.data.match(/nonce["':\s]+["']([a-f0-9]{8,12})["']/i);
            return m ? m[1] : 'effd8615e6';
        } catch (e) {
            return 'effd8615e6';
        }
    }

    async searchTopAnimes(title, isDublado = false) {
        try {
            const nonce = await this.getTopAnimesNonce();
            const keyword = isDublado ? `${title} Dublado` : title;
            const res = await axios.get('https://topanimes.net/wp-json/dooplay/search/', {
                params: { nonce, keyword },
                headers: { 'User-Agent': this.userAgent, 'Referer': 'https://topanimes.net/' },
                timeout: this.timeout
            });
            if (!res.data || res.data.error) return [];

            const results = Object.values(res.data).map(r => ({ url: r.url, title: r.title }));

            results.sort((a, b) => {
                const scoreA = this.scoreAnimeMatch(a.title, a.url, title, isDublado);
                const scoreB = this.scoreAnimeMatch(b.title, b.url, title, isDublado);
                return scoreB - scoreA;
            });

            return results;
        } catch (e) {
            return [];
        }
    }

    async getTopAnimesStream(animeUrl, targetSeason = 1, targetEpisode = 1) {
        try {
            const res = await axios.get(animeUrl, {
                headers: { 'User-Agent': this.userAgent },
                timeout: this.timeout
            });
            const html = res.data;

            const epRegex = /href=['"](https:\/\/topanimes\.net\/episodio\/([^'"]+))['"]/gi;
            const eps = [];
            let m;
            while ((m = epRegex.exec(html)) !== null) {
                if (!eps.find(e => e.url === m[1])) {
                    const slug = m[2];
                    const numMatch = slug.match(/episodio-(\d+)/i) || slug.match(/-(\d+)\/?$/);
                    const seasonMatch = slug.match(/temporada-(\d+)/i);
                    eps.push({
                        url: m[1],
                        slug,
                        epNum: numMatch ? parseInt(numMatch[1], 10) : null,
                        season: seasonMatch ? parseInt(seasonMatch[1], 10) : 1
                    });
                }
            }

            if (eps.length === 0) return null;

            let targetEp = eps.find(e => e.epNum === targetEpisode && (targetSeason === 1 || e.season === targetSeason));
            if (!targetEp) targetEp = eps.find(e => e.epNum === targetEpisode);
            // NUNCA usa fallback de último episódio — entregaria ep errado ao usuário
            if (!targetEp) {
                console.warn(`⚠️ [AnimeExtractor/TopAnimes] Episódio ${targetEpisode} exato não encontrado. Abortando para evitar ep errado.`);
                return null;
            }

            const epRes = await axios.get(targetEp.url, {
                headers: { 'User-Agent': this.userAgent, 'Referer': animeUrl },
                timeout: this.timeout
            });
            const epHtml = epRes.data;

            // 1. API Moderna TopAnimes (sk-api.alibabacdn.net com mode=api2)
            const skApiMatch = epHtml.match(/src=['"](https:\/\/sk-api\.alibabacdn\.net\/[^'"]+)['"]/i)
                || epHtml.match(/src=['"](https:\/\/[^'"]*alibabacdn\.net\/[^'"]+)['"]/i);
            
            if (skApiMatch) {
                try {
                    const playerBaseUrl = skApiMatch[1].replace(/&amp;/g, '&');
                    const apiUrl = `${playerBaseUrl}${playerBaseUrl.includes('?') ? '&' : '?'}mode=api2`;
                    const apiRes = await axios.get(apiUrl, {
                        headers: {
                            'User-Agent': this.userAgent,
                            'Referer': targetEp.url
                        },
                        timeout: 10000
                    });

                    if (apiRes.data && apiRes.data.status === 'success' && apiRes.data.midias && apiRes.data.midias.length > 0) {
                        const midias = apiRes.data.midias;
                        // Prioriza qualidade mais alta (SD / 1080p > LD / 720p > FD / 360p)
                        const bestMedia = midias.find(med => (med.qualidade || '').toUpperCase() === 'SD' || (med.qualidade || '').includes('1080')) || midias[0];
                        if (bestMedia && bestMedia.url) {
                            const isDub = targetEp.slug.includes('dublado') || animeUrl.includes('dublado');
                            return {
                                streamUrl: bestMedia.url,
                                referer: 'https://topanimes.net/',
                                episodeTitle: targetEp.slug,
                                provider: 'TopAnimes CDN',
                                isDublado: isDub,
                                isLegendado: !isDub
                            };
                        }
                    }
                } catch (eApi) {}
            }

            // 2. Fallback legado (antivirus2 ou iframe m3u8 direto)
            const antivMatch = epHtml.match(/src=['"](https:\/\/topanimes\.net\/antivirus2\/yes\/\?id=([^&']+)[^']*)['"]/);
            if (antivMatch) {
                const antivRes = await axios.get(antivMatch[1], {
                    headers: { 'User-Agent': this.userAgent, 'Referer': targetEp.url },
                    timeout: 10000
                });
                const antivHtml = typeof antivRes.data === 'string' ? antivRes.data : '';
                const m3u8M = antivHtml.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)['"]/);
                if (m3u8M) {
                    const isDub = targetEp.slug.includes('dublado') || animeUrl.includes('dublado');
                    return {
                        streamUrl: m3u8M[1],
                        referer: 'https://topanimes.net/',
                        episodeTitle: targetEp.slug,
                        provider: 'TopAnimes CDN',
                        isDublado: isDub,
                        isLegendado: !isDub
                    };
                }
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    // =========================================================================
    // 3. MÉTODO PRINCIPAL DE BUSCA UNIFICADA
    // =========================================================================
    async searchAnime(title, tipo = 'serie', options = {}) {
        const season = options.season || 1;
        const episode = options.episode || 1;
        const audioPref = (options.audioPreference || 'dublado').toLowerCase();
        const wantsDublado = audioPref.includes('dub');
        const tmdbSeasonName = options.tmdbSeasonName || null; // ex: "Guerra Sangrenta de Mil Anos" para Bleach S2

        console.log(`⛩️ [AnimeExtractor] Buscando "${title}" T${season}E${episode} [${wantsDublado ? 'Dublado' : 'Legendado'}] nos provedores Web Direct...`);

        const candidateStreams = [];

        // Quando a temporada é > 1 e temos o nome da temporada TMDB, priorizamos buscas alternativas.
        // Os sites de anime (AnimesDigital, TopAnimes) indexam animes de temporadas separadas sob seus próprios títulos.
        // Ex: Bleach T2 (Thousand-Year Blood War) está indexado como "Bleach Sennen Kessen-hen", não como "Bleach".
        // Estratégia: tentamos o título principal (ep relativo à T1 com offset) E o nome da temporada TMDB.
        const searchTitles = [title];
        if (season > 1 && tmdbSeasonName) {
            // Normaliza o nome da temporada para busca em inglês/japonês
            // Ex: "Guerra Sangrenta de Mil Anos" -> também tenta "Bleach: Thousand-Year Blood War"
            const seasonNameForSearch = tmdbSeasonName;
            searchTitles.push(seasonNameForSearch);
            // Se o nome da temporada começa com o título principal, evita duplicata
            if (!this.normalizeText(seasonNameForSearch).startsWith(this.normalizeText(title))) {
                searchTitles.push(`${title}: ${seasonNameForSearch}`);
            }
        }

        for (const searchTitle of searchTitles) {
            if (candidateStreams.length > 0) break; // Já encontrou com o título anterior

            // 1. Tentar AnimesDigital (Provedor Principal)
            try {
                const adResults = await this.searchAnimesDigital(searchTitle, wantsDublado);
                if (adResults.length > 0) {
                    const bestAd = adResults[0];
                    // Quando buscamos pelo nome da temporada (ex: "Guerra Sangrenta de Mil Anos"), o episódio
                    // é relativo a essa série/temporada específica, então usamos episode=1 relativo (season=1 no extrator)
                    const extractorSeason = (searchTitle !== title && season > 1) ? 1 : season;
                    const streamData = await this.getAnimesDigitalStream(bestAd.url, extractorSeason, episode);
                    if (streamData && streamData.streamUrl) {
                        const isDub = bestAd.title.toLowerCase().includes('dublado') || bestAd.url.toLowerCase().includes('dublado');
                        if (wantsDublado && !isDub) {
                            console.log(`ℹ️ [AnimeExtractor] Pedido Dublado mas o resultado AnimesDigital é Legendado. Registrando como Legendado.`);
                        }
                        candidateStreams.push({
                            title: `[Web Direct] ${bestAd.title} T${season}E${episode} - 1080p Web-DL [${isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'}]`,
                            url: streamData.streamUrl,
                            referer: streamData.referer,
                            isDirect: true,
                            isPtBr: true,
                            is1080p: true,
                            isWebDl: true,
                            provider: streamData.provider || 'AnimesDigital CDN',
                            audio: isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                            isDublado: isDub,
                            isLegendado: !isDub,
                            hasEmbeddedSub: !isDub,
                            isReadySub: true,
                            sizeMB: 280,
                            seeders: 9999,
                            leechers: 0
                        });
                    }
                }
            } catch (e) {
                console.warn('⚠️ [AnimeExtractor] Falha AnimesDigital:', e.message);
            }

            // 2. Se AnimesDigital não encontrou, tentar TopAnimes (Fallback Web)
            if (candidateStreams.length === 0) {
                try {
                    const topResults = await this.searchTopAnimes(searchTitle, wantsDublado);
                    if (topResults.length > 0) {
                        const bestTop = topResults[0];
                        const extractorSeason = (searchTitle !== title && season > 1) ? 1 : season;
                        const streamData = await this.getTopAnimesStream(bestTop.url, extractorSeason, episode);
                        if (streamData && streamData.streamUrl) {
                            const isDub = (streamData.isDublado !== undefined)
                                ? streamData.isDublado
                                : (bestTop.title.toLowerCase().includes('dublado') || bestTop.url.toLowerCase().includes('dublado'));
                            if (wantsDublado && !isDub) {
                                console.log(`ℹ️ [AnimeExtractor] Pedido Dublado mas o resultado TopAnimes é Legendado. Registrando como Legendado.`);
                            }
                            candidateStreams.push({
                                title: `[Web Direct] ${bestTop.title} T${season}E${episode} - 1080p Web-DL [${isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'}]`,
                                url: streamData.streamUrl,
                                referer: streamData.referer,
                                isDirect: true,
                                isPtBr: true,
                                is1080p: true,
                                isWebDl: true,
                                provider: streamData.provider || 'TopAnimes CDN',
                                audio: isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                                isDublado: isDub,
                                isLegendado: !isDub,
                                hasEmbeddedSub: !isDub,
                                isReadySub: true,
                                sizeMB: 280,
                                seeders: 9999,
                                leechers: 0
                            });
                        }
                    }
                } catch (e) {
                    console.warn('⚠️ [AnimeExtractor] Falha TopAnimes:', e.message);
                }
            }
        }

        if (candidateStreams.length > 0) {
            console.log(`✅ [AnimeExtractor] Encontrado(s) ${candidateStreams.length} stream(s) direto(s) via ${candidateStreams[0].provider} [${candidateStreams[0].audio}]!`);
        } else {
            console.log(`ℹ️ [AnimeExtractor] Nenhum stream web direto disponível para "${title}". Utilizando Fallback Torrent.`);
        }

        return candidateStreams;
    }
}

module.exports = new AnimeExtractorService();
