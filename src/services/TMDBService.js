const axios = require('axios');
const https = require('https');
const config = require('../../config');

const httpsAgent = new https.Agent({ keepAlive: true, timeout: 25000 });

class TMDBService {
    constructor() {
        this.apiKey = config.TMDB_API_KEY;
        this.language = config.TMDB_LANGUAGE || 'pt-BR';
        this.baseUrl = 'https://api.themoviedb.org/3';
        this.imageBaseUrl = 'https://image.tmdb.org/t/p';
    }

    async _getWithRetry(endpoint, params = {}, timeout = 15000, maxRetries = 2) {
        const fullParams = {
            api_key: this.apiKey,
            language: this.language,
            ...params
        };
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await axios.get(`${this.baseUrl}${endpoint}`, {
                    params: fullParams,
                    timeout: timeout,
                    httpsAgent: httpsAgent
                });
                return response.data;
            } catch (err) {
                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 1200 * attempt));
                    continue;
                }
                throw err;
            }
        }
    }

    getPosterUrl(posterPath, size = 'w500') {
        if (!posterPath) return null;
        if (posterPath.startsWith('http')) return posterPath;
        return `${this.imageBaseUrl}/${size}${posterPath}`;
    }

    _cleanForComparison(text) {
        if (!text) return '';
        return text
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    rankSearchResults(items, query) {
        if (!items || items.length === 0) return [];
        const qClean = this._cleanForComparison(query);
        const qTokens = qClean.split(' ').filter(Boolean);
        const isLatinQuery = /^[a-zA-Z0-9\s\-:.,!?'"()]+$/.test(query);

        const scored = items.map(item => {
            let score = 0;
            const nameClean = this._cleanForComparison(item.nome);
            const origClean = this._cleanForComparison(item.nomeOriginal);

            // 1. Correspondência Exata de Título
            if (nameClean === qClean || origClean === qClean) score += 10000;
            if (nameClean.startsWith(qClean) || origClean.startsWith(qClean)) score += 3500;

            // 2. Todos os termos presentes
            if (qTokens.length > 0 && qTokens.every(tok => nameClean.includes(tok) || origClean.includes(tok))) {
                score += 2500;
            }

            // 3. Relevância por Votos e Nota (Obras consagradas sempre no topo)
            const votes = item.votos || 0;
            score += Math.min(8000, Math.log10(Math.max(1, votes)) * 2000);
            score += (item.nota || 0) * 100;

            // 4. Se a obra for a série de TV / anime principal com muitos votos
            if ((item.tipo === 'anime' || item.tipo === 'serie') && votes >= 50) {
                score += 2000;
            }

            // 5. Filtro de ruído: itens sem tradução ou filmes antigos homônimos com quase 0 votos
            const hasAsianChars = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(item.nome);
            if (isLatinQuery && hasAsianChars && votes < 50) {
                score -= 8000;
            }

            return { item, score };
        });

        scored.sort((a, b) => b.score - a.score);

        // Deduplicação inteligente de títulos idênticos
        const finalResults = [];
        const seenTitles = new Map(); // normTitle -> highestVoteCount

        for (const { item, score } of scored) {
            if (score < 0) continue;

            const normTitle = this._cleanForComparison(item.nome);
            const votes = item.votos || 0;

            // Se já existe um item com exatamente o mesmo título (ex: "Avatar" 2009 com 34000 votos vs "Avatar" 1916 com 18 votos)
            if (seenTitles.has(normTitle)) {
                const bestVotes = seenTitles.get(normTitle);
                if (bestVotes > 200 && votes < 100) {
                    continue; // Ignora o clone secundário obscuro
                }
            } else {
                seenTitles.set(normTitle, votes);
            }

            finalResults.push(item);
        }

        return finalResults;
    }

    async searchMulti(query) {
        try {
            if (!query || query.trim().length === 0) return [];
            const data = await this._getWithRetry('/search/multi', {
                query: query.trim(),
                include_adult: false
            });
            const results = data.results || [];
            const formatted = results
                .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
                .map(item => this.formatItem(item));

            return this.rankSearchResults(formatted, query);
        } catch (error) {
            console.error('❌ Erro na busca TMDB:', error.message);
            return [];
        }
    }

    async searchMovie(query, year = null) {
        try {
            const params = {
                query: query.trim(),
                include_adult: false
            };
            if (year) params.year = year;

            const data = await this._getWithRetry('/search/movie', params);
            const results = data.results || [];
            const formatted = results.map(item => this.formatItem({ ...item, media_type: 'movie' }));
            return this.rankSearchResults(formatted, query);
        } catch (error) {
            console.error('❌ Erro na busca de filme TMDB:', error.message);
            return [];
        }
    }

    async searchTV(query, year = null) {
        try {
            const params = {
                query: query.trim(),
                include_adult: false
            };
            if (year) params.first_air_date_year = year;

            const data = await this._getWithRetry('/search/tv', params);
            const results = data.results || [];
            const formatted = results.map(item => this.formatItem({ ...item, media_type: 'tv' }));
            return this.rankSearchResults(formatted, query);
        } catch (error) {
            console.error('❌ Erro na busca de série TMDB:', error.message);
            return [];
        }
    }

    async getMovieDetails(tmdbId) {
        try {
            const data = await this._getWithRetry(`/movie/${tmdbId}`, {
                append_to_response: 'external_ids'
            });
            return this.formatItem({ ...data, media_type: 'movie' });
        } catch (error) {
            console.error(`❌ Erro ao obter detalhes do filme ${tmdbId}:`, error.message);
            return null;
        }
    }

    async getTVDetails(tmdbId) {
        try {
            const data = await this._getWithRetry(`/tv/${tmdbId}`, {
                append_to_response: 'external_ids'
            });
            return this.formatTVDetails(data);
        } catch (error) {
            console.error(`❌ Erro ao obter detalhes da série ${tmdbId}:`, error.message);
            return null;
        }
    }

    async getSeasonDetails(tmdbId, seasonNumber) {
        try {
            const data = await this._getWithRetry(`/tv/${tmdbId}/season/${seasonNumber}`);
            return {
                temporadaNumero: data.season_number,
                nome: data.name || `Temporada ${data.season_number}`,
                sinopse: data.overview || '',
                poster: this.getPosterUrl(data.poster_path),
                episodios: (data.episodes || []).map(ep => ({
                    numero: ep.episode_number,
                    nome: ep.name || `Episódio ${ep.episode_number}`,
                    sinopse: ep.overview || '',
                    nota: ep.vote_average || 0,
                    dataLancamento: ep.air_date || '',
                    stillUrl: this.getPosterUrl(ep.still_path, 'w300'),
                    runtime: ep.runtime || 0,
                    duracaoMinutos: ep.runtime || 0
                }))
            };
        } catch (error) {
            console.error(`❌ Erro ao obter temporada ${seasonNumber} de ${tmdbId}:`, error.message);
            return null;
        }
    }

    async getEpisodeDetails(tmdbId, seasonNumber, episodeNumber) {
        try {
            const ep = await this._getWithRetry(`/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`);
            return {
                numero: ep.episode_number,
                nome: ep.name || `Episódio ${ep.episode_number}`,
                sinopse: ep.overview || '',
                nota: ep.vote_average || 0,
                stillUrl: this.getPosterUrl(ep.still_path, 'w300'),
                runtime: ep.runtime || 0,
                duracaoMinutos: ep.runtime || 0
            };
        } catch (error) {
            return null;
        }
    }

    async checkDigitalReleaseStatus(tmdbId, isDublado = true) {
        if (!tmdbId) return { isDigitalReleased: true, isTheatricalOnly: false };
        try {
            const [relData, movieData] = await Promise.all([
                this._getWithRetry(`/movie/${tmdbId}/release_dates`, {}, 8000).catch(() => null),
                this._getWithRetry(`/movie/${tmdbId}`, {}, 8000).catch(() => null)
            ]);

            const results = relData?.results || [];
            const originalLang = movieData?.original_language || 'en';
            const isBrazilianMovie = originalLang === 'pt';
            const now = new Date();

            const primaryReleaseDateStr = movieData?.release_date;
            let daysDiff = 999;
            if (primaryReleaseDateStr) {
                const pDate = new Date(primaryReleaseDateStr);
                daysDiff = (now - pDate) / (1000 * 60 * 60 * 24);
                if (daysDiff > 90) {
                    return {
                        isDigitalReleased: true,
                        isTheatricalOnly: false,
                        hasTheatrical: true,
                        hasGlobalDigital: true,
                        hasBrazilDigital: true,
                        isCatalog: true
                    };
                }
            }

            let hasTheatrical = false;
            let hasGlobalDigital = false;
            let hasBrazilDigital = false;

            for (const country of results) {
                const isBR = country.iso_3166_1 === 'BR';
                for (const rd of (country.release_dates || [])) {
                    const rDate = rd.release_date ? new Date(rd.release_date) : null;
                    if (rd.type === 2 || rd.type === 3) {
                        if (rDate && rDate <= now) hasTheatrical = true;
                    } else if (rd.type === 4 || rd.type === 5 || rd.type === 6) {
                        if (rDate && rDate <= now) {
                            hasGlobalDigital = true;
                            if (isBR) hasBrazilDigital = true;
                        }
                    }
                }
            }

            // Se o filme já foi lançado em streaming/digital em qualquer lugar do mundo ou no Brasil, o master digital existe
            const isDigitalReleased = hasGlobalDigital || hasBrazilDigital || (daysDiff > 90);
            const isTheatricalOnly = hasTheatrical && !isDigitalReleased && (daysDiff <= 75);

            return {
                isDigitalReleased: isDigitalReleased,
                isTheatricalOnly: isTheatricalOnly,
                hasTheatrical,
                hasGlobalDigital,
                hasBrazilDigital,
                isBrazilianMovie
            };
        } catch (e) {
            return { isDigitalReleased: true, isTheatricalOnly: false };
        }
    }

    async getTrendingMovies(timeWindow = 'week') {
        try {
            const data = await this._getWithRetry(`/trending/movie/${timeWindow}`, {}, 15000);
            return (data.results || []).map(item => this.formatItem({ ...item, media_type: 'movie' }));
        } catch (error) {
            console.log('ℹ️ Usando lista padrão de filmes populares (configure TMDB_API_KEY no config.js para feeds dinâmicos)');
            return [
                { nome: 'Harry Potter e a Pedra Filosofal', ano: '2001', tipo: 'filme', nota: 8.2, generos: ['Fantasia', 'Aventura'] },
                { nome: 'Vingadores: Ultimato', ano: '2019', tipo: 'filme', nota: 8.4, generos: ['Ação', 'Ficção'] },
                { nome: 'Avatar: O Caminho da Água', ano: '2022', tipo: 'filme', nota: 7.8, generos: ['Ficção', 'Aventura'] },
                { nome: 'Interestelar', ano: '2014', tipo: 'filme', nota: 8.6, generos: ['Ficção', 'Drama'] },
                { nome: 'Duna: Parte 2', ano: '2024', tipo: 'filme', nota: 8.5, generos: ['Ficção', 'Aventura'] },
                { nome: 'Homem-Aranha: Sem Volta Para Casa', ano: '2021', tipo: 'filme', nota: 8.1, generos: ['Ação', 'Aventura'] }
            ];
        }
    }

    async getTrendingTV(timeWindow = 'week') {
        try {
            const data = await this._getWithRetry(`/trending/tv/${timeWindow}`, {}, 15000);
            return (data.results || []).map(item => this.formatItem({ ...item, media_type: 'tv' }));
        } catch (error) {
            return [
                { nome: 'Stranger Things', ano: '2016', tipo: 'serie', nota: 8.7, generos: ['Ficção', 'Terror'] },
                { nome: 'The Last of Us', ano: '2023', tipo: 'serie', nota: 8.8, generos: ['Drama', 'Ficção'] },
                { nome: 'Breaking Bad', ano: '2008', tipo: 'serie', nota: 9.5, generos: ['Drama', 'Crime'] },
                { nome: 'A Casa do Dragão', ano: '2022', tipo: 'serie', nota: 8.5, generos: ['Fantasia', 'Drama'] }
            ];
        }
    }

    async getPopularKDramas() {
        try {
            const data = await this._getWithRetry('/discover/tv', {
                sort_by: 'popularity.desc',
                with_original_language: 'ko',
                'vote_count.gte': 10
            }, 15000);
            return (data.results || []).map(item => ({
                ...this.formatItem({ ...item, media_type: 'tv' }),
                isDorama: true,
                categoria: 'Dorama'
            }));
        } catch (error) {
            return [
                { nome: 'Pousando no Amor', ano: '2019', tipo: 'serie', isDorama: true, nota: 8.8, generos: ['Romance', 'Drama'] },
                { nome: 'Vincenzo', ano: '2021', tipo: 'serie', isDorama: true, nota: 8.5, generos: ['Comédia', 'Crime'] },
                { nome: 'Tudo Bem Não Ser Normal', ano: '2020', tipo: 'serie', isDorama: true, nota: 8.6, generos: ['Drama', 'Romance'] },
                { nome: 'Round 6', ano: '2021', tipo: 'serie', isDorama: true, nota: 8.0, generos: ['Ação', 'Suspense'] },
                { nome: 'Uma Advogada Extraordinária', ano: '2022', tipo: 'serie', isDorama: true, nota: 8.7, generos: ['Drama', 'Comédia'] }
            ];
        }
    }

    async getPopularAnime() {
        try {
            const data = await this._getWithRetry('/discover/tv', {
                sort_by: 'popularity.desc',
                with_original_language: 'ja',
                with_genres: '16',
                'vote_count.gte': 10
            }, 15000);
            return (data.results || []).map(item => ({
                ...this.formatItem({ ...item, media_type: 'tv' }),
                isAnime: true,
                categoria: 'Anime'
            }));
        } catch (error) {
            return [
                { nome: 'Solo Leveling', ano: '2024', tipo: 'serie', isAnime: true, nota: 8.8, generos: ['Anime', 'Ação', 'Fantasia'] },
                { nome: 'Jujutsu Kaisen', ano: '2020', tipo: 'serie', isAnime: true, nota: 8.6, generos: ['Anime', 'Ação', 'Sobrenatural'] },
                { nome: 'Demon Slayer', ano: '2019', tipo: 'serie', isAnime: true, nota: 8.7, generos: ['Anime', 'Ação', 'Fantasia'] },
                { nome: 'One Piece', ano: '1999', tipo: 'serie', isAnime: true, nota: 8.9, generos: ['Anime', 'Aventura', 'Fantasia'] },
                { nome: 'Bleach: Thousand-Year Blood War', ano: '2022', tipo: 'serie', isAnime: true, nota: 8.9, generos: ['Anime', 'Ação'] }
            ];
        }
    }

    formatItem(raw) {
        const isMovie = raw.media_type ? raw.media_type === 'movie' : (raw.title && !raw.name);
        const nome = raw.title || raw.name || raw.original_title || raw.original_name || 'Sem título';
        const nomeOriginal = raw.original_title || raw.original_name || '';
        const dataLancamento = raw.release_date || raw.first_air_date || '';
        const ano = dataLancamento ? dataLancamento.substring(0, 4) : '';
        
        const genreIdMap = {
            16: 'Animação', 28: 'Ação', 12: 'Aventura', 10759: 'Ação & Aventura',
            35: 'Comédia', 80: 'Crime', 99: 'Documentário', 18: 'Drama',
            10751: 'Família', 14: 'Fantasia', 36: 'História', 27: 'Terror',
            10402: 'Música', 9648: 'Mistério', 10749: 'Romance', 878: 'Ficção Científica',
            10765: 'Ficção & Fantasia', 10770: 'Cinema TV', 53: 'Suspense',
            10752: 'Guerra', 10768: 'Guerra & Política', 37: 'Faroeste',
            10762: 'Infantil', 10763: 'Notícias', 10764: 'Reality', 10766: 'Novela', 10767: 'Talk'
        };

        const genreDict = {
            'action': 'Ação', 'adventure': 'Aventura', 'action & adventure': 'Ação & Aventura',
            'animation': 'Animação', 'anime': 'Anime', 'comedy': 'Comédia', 'crime': 'Crime',
            'documentary': 'Documentário', 'drama': 'Drama', 'family': 'Família', 'fantasy': 'Fantasia',
            'history': 'História', 'horror': 'Terror', 'kids': 'Infantil', 'music': 'Música',
            'mystery': 'Mistério', 'news': 'Notícias', 'reality': 'Reality Show', 'romance': 'Romance',
            'science fiction': 'Ficção Científica', 'sci-fi': 'Ficção Científica', 'sci-fi & fantasy': 'Ficção & Fantasia',
            'soap': 'Novela', 'talk': 'Entrevistas', 'thriller': 'Suspense', 'tv movie': 'Cinema TV',
            'war': 'Guerra', 'war & politics': 'Guerra & Política', 'western': 'Faroeste', 'dorama': 'Dorama'
        };
        const rawGeneros = raw.genres ? raw.genres.map(g => g.name || g) : (Array.isArray(raw.genre_ids) ? raw.genre_ids.map(id => genreIdMap[id] || id) : []);
        const generos = rawGeneros.map(g => {
            const clean = String(g).trim();
            return genreDict[clean.toLowerCase()] || clean;
        });

        const lang = (raw.original_language || '').toLowerCase();
        const originCountries = raw.origin_country || [];

        // Detecção precisa de Animação
        const hasAnimacao = generos.some(g => String(g).toLowerCase().includes('anim') || String(g).toLowerCase().includes('anime')) || (Array.isArray(raw.genre_ids) && raw.genre_ids.includes(16));
        const isJapanese = lang === 'ja' || originCountries.includes('JP');
        const isKoreanOrChinese = lang === 'ko' || lang === 'zh' || originCountries.includes('KR') || originCountries.includes('CN') || originCountries.includes('TW');

        // 1. Anime: Produção de animação japonesa ou com características claras de anime
        const isAnime = (hasAnimacao && (isJapanese || isKoreanOrChinese || /anime|shonen|seinen|isekai|bleach|one piece|naruto|dragon ball/i.test(nome + ' ' + (raw.overview || '')))) ||
                        (isJapanese && hasAnimacao);

        // 2. Dorama (K-Drama, C-Drama, J-Drama Live-Action):
        const isDorama = !isAnime && (isKoreanOrChinese || (isJapanese && !hasAnimacao)) && !isMovie;

        // 3. Categoria principal
        let tipo = isMovie ? 'filme' : 'serie';
        if (isAnime) tipo = 'anime';
        else if (isDorama) tipo = 'dorama';

        return {
            tmdbId: raw.id,
            imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null,
            tipo: tipo,
            isMovie,
            isAnime,
            isDorama,
            nome: nome.trim(),
            nomeOriginal: nomeOriginal.trim(),
            sinopse: raw.overview ? raw.overview.trim() : 'Sem sinopse disponível.',
            ano: ano,
            dataLancamento,
            nota: raw.vote_average ? Number(raw.vote_average.toFixed(1)) : 0,
            votos: raw.vote_count || 0,
            posterUrl: this.getPosterUrl(raw.poster_path),
            backdropUrl: this.getPosterUrl(raw.backdrop_path, 'original'),
            idiomaOriginal: lang,
            duracaoMinutos: raw.runtime || (Array.isArray(raw.episode_run_time) && raw.episode_run_time[0]) || 0,
            generos: generos
        };
    }

    formatTVDetails(raw) {
        const base = this.formatItem({ ...raw, media_type: 'tv' });
        base.totalTemporadas = raw.number_of_seasons || 1;
        base.totalEpisodios = raw.number_of_episodes || 0;
        base.temporadas = (raw.seasons || [])
            .filter(s => s.season_number > 0)
            .map(s => ({
                numero: s.season_number,
                nome: s.name || `Temporada ${s.season_number}`,
                episodiosContagem: s.episode_count || 0,
                poster: this.getPosterUrl(s.poster_path)
            }));
        return base;
    }
}

module.exports = new TMDBService();
