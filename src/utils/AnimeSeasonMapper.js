'use strict';

/**
 * AnimeSeasonMapper
 * Utilitário central de mapeamento e normalização de temporadas e episódios de animes.
 * 
 * Resolve divergências entre o TMDB oficial (que agrupa arcos em menos temporadas)
 * e os catálogos populares/fansubs (que dividem por arcos da história).
 * Também suporta numeração de episódios absoluta para animes contínuos (One Piece, Naruto, etc.).
 */
class AnimeSeasonMapper {
    /**
     * Verifica se a obra é Kimetsu no Yaiba / Demon Slayer
     */
    isKimetsu(title) {
        return /demon slayer|kimetsu no yaiba/i.test(title || '');
    }

    /**
     * Verifica se a obra é One Piece
     */
    isOnePiece(title) {
        return /\bone[-_ .]?piece\b/i.test(title || '');
    }

    /**
     * Verifica se é um anime de transmissão contínua tradicional (sem temporadas reais na fonte)
     */
    isContinuousAnime(title) {
        return /\b(one[-_ .]?piece|naruto|bleach|black[-_ .]?clover|boruto|dragon[-_ .]?ball|detective[-_ .]?conan|fairy[-_ .]?tail|hunter[-_ .]?x[-_ .]?hunter|gintama)\b/i.test(title || '');
    }

    /**
     * Mapeia Season e Episódio do TMDB para a Temporada e Episódio do Catálogo BrasilFlix.
     * 
     * Caso Kimetsu no Yaiba:
     * - TMDB S1 (26 eps)  -> Catálogo T1 (eps 1..26)
     * - TMDB S2.1-7 (Mugen Train) -> Catálogo T2 (eps 1..7)
     * - TMDB S2.8-18 (Distrito do Entretenimento) -> Catálogo T3 (eps 1..11) [ep - 7]
     * - TMDB S3 (11 eps - Vila dos Ferreiros) -> Catálogo T4 (eps 1..11)
     * - TMDB S4 (8 eps - Treinamento dos Hashiras) -> Catálogo T5 (eps 1..8)
     *
     * Caso One Piece (se catálogo usar temporada única contínua):
     * - Se catalogHasSingleSeason === true ou options.forceContinuous:
     *   calcula episódio absoluto e mapeia para Temporada 1, Ep = absoluto!
     *
     * Default:
     * - Retorna 1:1
     *
     * @param {string} animeName
     * @param {number} tmdbSeason
     * @param {number} tmdbEpisode
     * @param {object} options { tmdbSeasons, catalogHasSingleSeason, forceContinuous }
     * @returns {{ season: number, episode: number, arcName?: string, isCustomMapped: boolean }}
     */
    mapTmdbToCatalog(animeName, tmdbSeason, tmdbEpisode, options = {}) {
        const s = parseInt(tmdbSeason, 10) || 1;
        const ep = parseInt(tmdbEpisode, 10) || 1;

        if (this.isKimetsu(animeName)) {
            if (s === 1) {
                return { season: 1, episode: ep, arcName: 'Determinação Inabalável', isCustomMapped: true };
            }
            if (s === 2) {
                if (ep <= 7) {
                    return { season: 2, episode: ep, arcName: 'Trem Infinito', isCustomMapped: true };
                } else {
                    return { season: 3, episode: ep - 7, arcName: 'Distrito do Entretenimento', isCustomMapped: true };
                }
            }
            if (s === 3) {
                return { season: 4, episode: ep, arcName: 'Vila dos Ferreiros', isCustomMapped: true };
            }
            if (s === 4) {
                return { season: 5, episode: ep, arcName: 'Treinamento dos Hashiras', isCustomMapped: true };
            }
        }

        // Caso One Piece ou animes contínuos: se o catálogo tiver apenas Temporada 1
        if (this.isContinuousAnime(animeName) && (options.catalogHasSingleSeason || options.forceContinuous)) {
            const absEp = this.calculateAbsoluteEpisode(animeName, s, ep, options.tmdbSeasons);
            return { season: 1, episode: absEp, isCustomMapped: true };
        }

        return { season: s, episode: ep, isCustomMapped: false };
    }

    /**
     * Mapeamento inverso: do Catálogo BrasilFlix para o TMDB
     * 
     * @param {string} animeName
     * @param {number} catalogSeason
     * @param {number} catalogEpisode
     * @returns {{ tmdbSeason: number, tmdbEpisode: number, isCustomMapped: boolean }}
     */
    mapCatalogToTmdb(animeName, catalogSeason, catalogEpisode) {
        const s = parseInt(catalogSeason, 10) || 1;
        const ep = parseInt(catalogEpisode, 10) || 1;

        if (this.isKimetsu(animeName)) {
            if (s === 1) return { tmdbSeason: 1, tmdbEpisode: ep, isCustomMapped: true };
            if (s === 2) return { tmdbSeason: 2, tmdbEpisode: ep, isCustomMapped: true };
            if (s === 3) return { tmdbSeason: 2, tmdbEpisode: ep + 7, isCustomMapped: true };
            if (s === 4) return { tmdbSeason: 3, tmdbEpisode: ep, isCustomMapped: true };
            if (s === 5) return { tmdbSeason: 4, tmdbEpisode: ep, isCustomMapped: true };
        }

        return { tmdbSeason: s, tmdbEpisode: ep, isCustomMapped: false };
    }

    /**
     * Calcula o número de episódio absoluto baseado nas temporadas anteriores do TMDB
     * 
     * @param {string} animeName
     * @param {number} season
     * @param {number} episode
     * @param {Array<{ numero: number, episodiosContagem: number }>} tmdbSeasons
     * @returns {number}
     */
    calculateAbsoluteEpisode(animeName, season, episode, tmdbSeasons = []) {
        const sNum = parseInt(season, 10) || 1;
        const epNum = parseInt(episode, 10) || 1;

        if (sNum <= 1) return epNum;

        if (Array.isArray(tmdbSeasons) && tmdbSeasons.length > 0) {
            let offset = 0;
            for (const s of tmdbSeasons) {
                if (s.numero > 0 && s.numero < sNum) {
                    offset += (s.episodiosContagem || 0);
                }
            }
            if (offset > 0) {
                return offset + epNum;
            }
        }

        return epNum;
    }

    /**
     * Retorna títulos de busca normalizados e enriquecidos para animes (incluindo Romaji e Ocidental)
     * 
     * @param {string} title
     * @param {string} originalName
     * @param {string[]} extraAltTitles
     * @returns {string[]}
     */
    getAnimeSearchTitles(title, originalName, extraAltTitles = []) {
        const seen = new Set();
        const results = [];

        const add = (t) => {
            if (!t) return;
            const clean = t.replace(/\s*\(\d{4}\)$/, '').trim();
            if (clean.length < 2) return;
            const norm = clean.toLowerCase();
            if (!seen.has(norm)) {
                seen.add(norm);
                results.push(clean);
            }
        };

        add(title);
        add(originalName);

        // Kimetsu no Yaiba aliases diretos
        if (this.isKimetsu(title) || this.isKimetsu(originalName)) {
            add('Kimetsu no Yaiba');
            add('Demon Slayer');
            add('Demon Slayer: Kimetsu no Yaiba');
        }

        // Attack on Titan
        if (/attack on titan|shingeki no kyojin/i.test(title || originalName)) {
            add('Attack on Titan');
            add('Shingeki no Kyojin');
        }

        // One Piece
        if (this.isOnePiece(title) || this.isOnePiece(originalName)) {
            add('One Piece');
        }

        // Solo Leveling
        if (/solo leveling|ore dake/i.test(title || originalName)) {
            add('Solo Leveling');
            add('Ore dake Level Up na Ken');
        }

        // Jujutsu Kaisen
        if (/jujutsu kaisen/i.test(title || originalName)) {
            add('Jujutsu Kaisen');
            add('Sorcery Fight');
        }

        // Títulos alternativos vindos do TMDB (Romaji / English / etc.)
        if (Array.isArray(extraAltTitles)) {
            for (const alt of extraAltTitles) {
                if (alt && typeof alt === 'string' && /[a-zA-Z0-9]/.test(alt)) {
                    add(alt);
                }
            }
        }

        return results;
    }
}

module.exports = new AnimeSeasonMapper();
