const axios = require('axios');
const config = require('../../config');

class TMDBService {
    constructor() {
        this.apiKey = config.TMDB_API_KEY;
        this.language = config.TMDB_LANGUAGE || 'pt-BR';
        this.baseUrl = 'https://api.themoviedb.org/3';
        this.imageBaseUrl = 'https://image.tmdb.org/t/p';
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
        const nowStr = new Date().toISOString().split('T')[0];

        return items.sort((a, b) => {
            let scoreA = 0;
            let scoreB = 0;

            const nameA = this._cleanForComparison(a.nome);
            const origA = this._cleanForComparison(a.nomeOriginal);
            const nameB = this._cleanForComparison(b.nome);
            const origB = this._cleanForComparison(b.nomeOriginal);

            // 1. Correspondência Exata de Título
            if (nameA === qClean || origA === qClean) scoreA += 10000;
            if (nameB === qClean || origB === qClean) scoreB += 10000;

            // 2. Prefixo de Título
            if (nameA.startsWith(qClean) || origA.startsWith(qClean)) scoreA += 2500;
            if (nameB.startsWith(qClean) || origB.startsWith(qClean)) scoreB += 2500;

            // 3. Contém todas as palavras da consulta
            if (qTokens.length > 0) {
                if (qTokens.every(tok => nameA.includes(tok) || origA.includes(tok))) scoreA += 1500;
                if (qTokens.every(tok => nameB.includes(tok) || origB.includes(tok))) scoreB += 1500;
            }

            // 4. Já lançado vs Lançamento Futuro (privilegia obras já disponíveis em disco/digital)
            if (a.dataLancamento && a.dataLancamento <= nowStr) scoreA += 2000;
            else if (a.dataLancamento && a.dataLancamento > nowStr) scoreA -= 2000;

            if (b.dataLancamento && b.dataLancamento <= nowStr) scoreB += 2000;
            else if (b.dataLancamento && b.dataLancamento > nowStr) scoreB -= 2000;

            // 5. Popularidade e Quantidade de Votos (obras consagradas têm prioridade sobre curtas/spin-offs)
            scoreA += Math.min(3000, Math.log10(Math.max(1, a.votos || 0)) * 600);
            scoreB += Math.min(3000, Math.log10(Math.max(1, b.votos || 0)) * 600);

            scoreA += (a.nota || 0) * 50;
            scoreB += (b.nota || 0) * 50;

            return scoreB - scoreA;
        });
    }

    async searchMulti(query) {
        try {
            if (!query || query.trim().length === 0) return [];
            
            const response = await axios.get(`${this.baseUrl}/search/multi`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language,
                    query: query.trim(),
                    include_adult: false
                },
                timeout: 10000
            });

            const results = response.data.results || [];
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
                api_key: this.apiKey,
                language: this.language,
                query: query.trim(),
                include_adult: false
            };
            if (year) params.year = year;

            const response = await axios.get(`${this.baseUrl}/search/movie`, {
                params,
                timeout: 10000
            });

            const results = response.data.results || [];
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
                api_key: this.apiKey,
                language: this.language,
                query: query.trim(),
                include_adult: false
            };
            if (year) params.first_air_date_year = year;

            const response = await axios.get(`${this.baseUrl}/search/tv`, {
                params,
                timeout: 10000
            });

            const results = response.data.results || [];
            const formatted = results.map(item => this.formatItem({ ...item, media_type: 'tv' }));
            return this.rankSearchResults(formatted, query);
        } catch (error) {
            console.error('❌ Erro na busca de série TMDB:', error.message);
            return [];
        }
    }

    async getMovieDetails(tmdbId) {
        try {
            const response = await axios.get(`${this.baseUrl}/movie/${tmdbId}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language,
                    append_to_response: 'external_ids'
                },
                timeout: 10000
            });
            return this.formatItem({ ...response.data, media_type: 'movie' });
        } catch (error) {
            console.error(`❌ Erro ao obter detalhes do filme ${tmdbId}:`, error.message);
            return null;
        }
    }

    async getTVDetails(tmdbId) {
        try {
            const response = await axios.get(`${this.baseUrl}/tv/${tmdbId}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language,
                    append_to_response: 'external_ids'
                },
                timeout: 10000
            });
            return this.formatTVDetails(response.data);
        } catch (error) {
            console.error(`❌ Erro ao obter detalhes da série ${tmdbId}:`, error.message);
            return null;
        }
    }

    async getSeasonDetails(tmdbId, seasonNumber) {
        try {
            const response = await axios.get(`${this.baseUrl}/tv/${tmdbId}/season/${seasonNumber}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language
                },
                timeout: 10000
            });
            const data = response.data;
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
            const response = await axios.get(`${this.baseUrl}/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language
                },
                timeout: 10000
            });
            const ep = response.data;
            return {
                numero: ep.episode_number,
                nome: ep.name || `Episódio ${ep.episode_number}`,
                sinopse: ep.overview || '',
                nota: ep.vote_average || 0,
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
            const response = await axios.get(`${this.baseUrl}/movie/${tmdbId}/release_dates`, {
                params: { api_key: this.apiKey },
                timeout: 6000
            });
            const results = response.data?.results || [];
            const now = new Date();

            let hasTheatrical = false;
            let hasGlobalDigital = false;
            let hasBrazilDigital = false;

            for (const country of results) {
                const isBR = country.iso_3166_1 === 'BR';
                for (const rd of (country.release_dates || [])) {
                    const rDate = rd.release_date ? new Date(rd.release_date) : null;
                    if (rd.type === 2 || rd.type === 3) {
                        if (rDate && rDate <= now) hasTheatrical = true;
                    } else if (rd.type === 4 || rd.type === 5) {
                        if (rDate && rDate <= now) {
                            hasGlobalDigital = true;
                            if (isBR) hasBrazilDigital = true;
                        }
                    }
                }
            }

            // Se o filme já estreou digitalmente/em streaming no mundo ou no Brasil, ele já existe em WEB-DL/BluRay oficial
            const isDigitalReleased = hasGlobalDigital || hasBrazilDigital;
            // TheatricalOnly só é true se estreou nos cinemas E NÃO teve nenhum lançamento digital/físico no mundo
            const isTheatricalOnly = hasTheatrical && !isDigitalReleased;

            return {
                isDigitalReleased: isDigitalReleased,
                isTheatricalOnly: isTheatricalOnly,
                hasTheatrical,
                hasGlobalDigital,
                hasBrazilDigital
            };
        } catch (e) {
            return { isDigitalReleased: true, isTheatricalOnly: false };
        }
    }

    async getTrendingMovies(timeWindow = 'week') {
        try {
            const response = await axios.get(`${this.baseUrl}/trending/movie/${timeWindow}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language
                },
                timeout: 5000
            });
            return (response.data.results || []).map(item => this.formatItem({ ...item, media_type: 'movie' }));
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
            const response = await axios.get(`${this.baseUrl}/trending/tv/${timeWindow}`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language
                },
                timeout: 5000
            });
            return (response.data.results || []).map(item => this.formatItem({ ...item, media_type: 'tv' }));
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
            const response = await axios.get(`${this.baseUrl}/discover/tv`, {
                params: {
                    api_key: this.apiKey,
                    language: this.language,
                    sort_by: 'popularity.desc',
                    with_original_language: 'ko',
                    'vote_count.gte': 10
                },
                timeout: 5000
            });
            return (response.data.results || []).map(item => this.formatItem({ ...item, media_type: 'tv' }));
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

    formatItem(raw) {
        const isMovie = raw.media_type === 'movie' || !!raw.title;
        const nome = raw.title || raw.name || raw.original_title || raw.original_name || 'Sem título';
        const nomeOriginal = raw.original_title || raw.original_name || '';
        const dataLancamento = raw.release_date || raw.first_air_date || '';
        const ano = dataLancamento ? dataLancamento.substring(0, 4) : '';
        const generos = raw.genres ? raw.genres.map(g => g.name) : [];
        const isDorama = raw.original_language === 'ko' || raw.original_language === 'zh' || raw.original_language === 'ja';

        return {
            tmdbId: raw.id,
            imdbId: raw.external_ids?.imdb_id || raw.imdb_id || null,
            tipo: isMovie ? 'filme' : 'serie',
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
            idiomaOriginal: raw.original_language || '',
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
