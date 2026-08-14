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
            return results
                .filter(item => item.media_type === 'movie' || item.media_type === 'tv')
                .map(item => this.formatItem(item));
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
            return results.map(item => this.formatItem({ ...item, media_type: 'movie' }));
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
            return results.map(item => this.formatItem({ ...item, media_type: 'tv' }));
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
                    stillUrl: this.getPosterUrl(ep.still_path, 'w300')
                }))
            };
        } catch (error) {
            console.error(`❌ Erro ao obter temporada ${seasonNumber} de ${tmdbId}:`, error.message);
            return null;
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
