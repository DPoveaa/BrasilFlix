const config = require('../../config');
const telegramUploader = require('./TelegramUploader');
const CatalogoManager = require('../managers/CatalogoManager');

class StremioService {
    constructor(catalogoManager, assinaturaManager) {
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
    }

    getManifest(userToken = 'public') {
        const generos = this.catalogoManager.getGenerosDisponiveis().map(g => g.nome);

        return {
            id: 'org.brasilflix.addon',
            version: '1.2.0',
            name: 'BrasilFlix VIP',
            description: 'Catálogo VIP do BrasilFlix: Filmes, Séries e Doramas em 1080p Full HD com áudios Dublados e Legendados!',
            logo: 'https://raw.githubusercontent.com/DPoveaa/BrasilFlix/main/assets/logo.png',
            background: 'https://images.unsplash.com/photo-1574375927938-d5a98e8ffe85?w=1280&q=80',
            resources: ['catalog', 'meta', 'stream'],
            types: ['movie', 'series'],
            catalogs: [
                {
                    type: 'movie',
                    id: 'bf_movies',
                    name: 'BrasilFlix - Filmes',
                    extra: [
                        { name: 'genre', options: generos, isRequired: false },
                        { name: 'search', isRequired: false },
                        { name: 'skip', isRequired: false }
                    ]
                },
                {
                    type: 'series',
                    id: 'bf_series',
                    name: 'BrasilFlix - Séries',
                    extra: [
                        { name: 'genre', options: generos, isRequired: false },
                        { name: 'search', isRequired: false },
                        { name: 'skip', isRequired: false }
                    ]
                }
            ],
            idPrefixes: ['bf_', 'tt'],
            behaviorHints: {
                configurable: true,
                configurationRequired: false
            }
        };
    }

    getCatalog(type, id, extra = {}, userToken = 'public') {
        const limit = 20;
        const skip = parseInt(extra.skip || 0, 10);
        let items = [];

        if (type === 'movie' || id === 'bf_movies') {
            items = [...(this.catalogoManager.catalogo.filmes || [])];
        } else if (type === 'series' || id === 'bf_series') {
            items = [...(this.catalogoManager.catalogo.series || [])];
        }

        // Filtro por busca
        if (extra.search) {
            const query = extra.search.toLowerCase().trim();
            items = items.filter(item => 
                item.nome.toLowerCase().includes(query) ||
                (item.nomeOriginal && item.nomeOriginal.toLowerCase().includes(query)) ||
                (item.tags && item.tags.some(t => t.includes(query)))
            );
        }

        // Filtro por gênero
        if (extra.genre) {
            const g = extra.genre.toLowerCase().trim();
            items = items.filter(item => 
                (item.generos || []).some(ig => ig.toLowerCase().trim() === g)
            );
        }

        // Paginação
        const paginated = items.slice(skip, skip + limit);

        const metas = paginated.map(item => {
            const isMovie = item.tipo === 'filme';
            const audioBadge = this.catalogoManager.getAudioBadge(item);
            const badgeStr = audioBadge ? ` ${audioBadge}` : '';

            return {
                id: item.imdbId || (isMovie ? `bf_filme_${item.id}` : `bf_serie_${item.id}`),
                type: isMovie ? 'movie' : 'series',
                name: `${item.nome}${badgeStr}`,
                poster: item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80',
                background: item.backdropUrl || null,
                genres: item.generos || ['Geral'],
                releaseInfo: item.ano ? item.ano.toString() : '',
                description: item.sinopse || item.descricao || 'Disponível no catálogo BrasilFlix VIP.',
                imdbRating: item.nota ? item.nota.toString() : undefined
            };
        });

        return { metas };
    }

    getMeta(type, id, userToken = 'public') {
        let item = null;
        const isMovie = type === 'movie';

        // Busca por ID customizado ou IMDb ID
        if (id.startsWith('bf_filme_')) {
            const numId = parseInt(id.replace('bf_filme_', ''), 10);
            item = (this.catalogoManager.catalogo.filmes || []).find(f => f.id === numId);
        } else if (id.startsWith('bf_serie_')) {
            const numId = parseInt(id.replace('bf_serie_', '').split(':')[0], 10);
            item = (this.catalogoManager.catalogo.series || []).find(s => s.id === numId);
        } else {
            // Tenta por IMDb ID, tmdbId numérico, tmdb:ID ou nome
            item = (this.catalogoManager.catalogo.filmes || []).find(f => 
                f.imdbId === id || 
                f.tmdbId == id || 
                (f.tmdbId && `tmdb:${f.tmdbId}` === id) ||
                f.nome?.toLowerCase() === id.toLowerCase() ||
                f.nomeOriginal?.toLowerCase() === id.toLowerCase()
            ) ||
            (this.catalogoManager.catalogo.series || []).find(s => 
                s.imdbId === id || 
                s.tmdbId == id || 
                (s.tmdbId && `tmdb:${s.tmdbId}` === id) ||
                s.nome?.toLowerCase() === id.toLowerCase() ||
                s.nomeOriginal?.toLowerCase() === id.toLowerCase()
            );
        }

        if (!item) return { meta: null };

        const audioBadge = this.catalogoManager.getAudioBadge(item);
        const badgeStr = audioBadge ? ` ${audioBadge}` : '';

        const meta = {
            id: item.imdbId || (item.tipo === 'filme' ? `bf_filme_${item.id}` : `bf_serie_${item.id}`),
            type: item.tipo === 'filme' ? 'movie' : 'series',
            name: `${item.nome}${badgeStr}`,
            poster: item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80',
            background: item.backdropUrl || null,
            genres: item.generos || ['Geral'],
            releaseInfo: item.ano ? item.ano.toString() : '',
            description: item.sinopse || item.descricao || 'Disponível no catálogo BrasilFlix VIP.',
            imdbRating: item.nota ? item.nota.toString() : undefined
        };

        if (item.tipo === 'serie') {
            const videos = [];
            (item.temporadas || []).forEach(temp => {
                (temp.episodios || []).forEach(ep => {
                    videos.push({
                        id: `bf_serie_${item.id}:${temp.numero}:${ep.numero}`,
                        title: ep.nome || `Episódio ${ep.numero}`,
                        season: temp.numero,
                        episode: ep.numero,
                        released: ep.dataAdicionado || new Date().toISOString(),
                        overview: ep.sinopse || `Temporada ${temp.numero}, Episódio ${ep.numero}`
                    });
                });
            });
            meta.videos = videos;
        }

        return { meta };
    }

    async getStreams(type, id, userToken = 'public', baseUrl = 'https://brasilflix.kapsu.com.br') {
        const isMovie = type === 'movie' || (!id.includes(':') && !id.startsWith('bf_serie_'));

        if (isMovie) {
            let filme = null;
            if (id.startsWith('bf_movie_') || id.startsWith('bf_filme_')) {
                const numId = id.replace(/^(bf_movie_|bf_filme_)/, '');
                filme = this.catalogoManager.buscarFilmePorId(numId);
            } else {
                filme = this.catalogoManager.buscarFilmePorId(id);
            }

            if (!filme) return { streams: [] };

            const temDub = CatalogoManager.isValidMediaIdentifier(
                filme.versoes?.dublado?.messageId || (filme.isDublado || filme.is_dublado ? (filme.messageId || filme.message_id) : null),
                filme.versoes?.dublado?.fileId || (filme.isDublado || filme.is_dublado ? (filme.fileId || filme.file_id) : null)
            );
            const temLeg = CatalogoManager.isValidMediaIdentifier(
                filme.versoes?.legendado?.messageId || (filme.isLegendado || filme.is_legendado ? (filme.messageId || filme.message_id) : null),
                filme.versoes?.legendado?.fileId || (filme.isLegendado || filme.is_legendado ? (filme.fileId || filme.file_id) : null)
            );

            if (!temDub && !temLeg) return { streams: [] };

            const mediaKey = `filme_${filme.id}`;
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(
                userToken, 
                'filme',
                mediaKey
            );

            if (!consumo.permitido) {
                const assinarUrl = `${baseUrl}/assinar?token=${encodeURIComponent(userToken)}`;
                return {
                    streams: [
                        {
                            name: '🔒 BrasilFlix VIP',
                            title: `🚫 Limite Grátis Atingido!\n👑 Assine o VIP para Acesso Ilimitado:\n👉 ${assinarUrl}\n📱 Ou aponte a câmera para o QR Code no app!`,
                            url: `${baseUrl}/assinar`
                        }
                    ]
                };
            }

            const tagCota = consumo.isVip ? '👑 VIP' : `🎁 Grátis (${consumo.restanteFilmes} filme restante no mês)`;
            const streams = [];

            if (temDub) {
                streams.push({
                    name: 'BrasilFlix [1080p]',
                    title: `🎬 ${filme.nome}\n🇧🇷 Dublado (PT-BR) • 1080p Full HD\n[${tagCota}]`,
                    url: `${baseUrl}/stream/video/${userToken}/filme/${filme.id}/dublado`
                });
            }

            if (temLeg) {
                streams.push({
                    name: 'BrasilFlix [1080p]',
                    title: `💬 ${filme.nome}\n💬 Legendado (PT-BR) • 1080p Full HD\n[${tagCota}]`,
                    url: `${baseUrl}/stream/video/${userToken}/filme/${filme.id}/legendado`
                });
            }

            return { streams };
        } else {
            // ID formato: bf_serie_123:1:1 ou tt12345:1:1
            const parts = id.split(':');
            const serieIdOrImdb = parts[0];
            const seasonNum = parseInt(parts[1] || 1, 10);
            const epNum = parseInt(parts[2] || 1, 10);

            let serie = null;
            if (serieIdOrImdb.startsWith('bf_serie_')) {
                const numId = serieIdOrImdb.replace('bf_serie_', '');
                serie = this.catalogoManager.buscarSeriePorId(numId);
            } else {
                serie = this.catalogoManager.buscarSeriePorId(serieIdOrImdb);
            }

            if (!serie) return { streams: [] };

            const temporada = (serie.temporadas || []).find(t => t.numero === seasonNum);
            const ep = temporada?.episodios?.find(e => e.numero === epNum);

            if (!ep) return { streams: [] };

            const temDub = CatalogoManager.hasValidDubbedMedia(ep);
            const temLeg = CatalogoManager.hasValidSubtitledMedia(ep);

            if (!temDub && !temLeg) return { streams: [] };

            const mediaKey = `serie_${serie.id}_s${seasonNum}_e${epNum}`;
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(
                userToken, 
                'serie',
                mediaKey
            );

            if (!consumo.permitido) {
                const assinarUrl = `${baseUrl}/assinar?token=${encodeURIComponent(userToken)}`;
                return {
                    streams: [
                        {
                            name: '🔒 BrasilFlix VIP',
                            title: `🚫 Limite Grátis Atingido!\n👑 Assine o VIP para Acesso Ilimitado:\n👉 ${assinarUrl}\n📱 Ou aponte a câmera para o QR Code no app!`,
                            url: `${baseUrl}/assinar`
                        }
                    ]
                };
            }

            const tagCota = consumo.isVip ? '👑 VIP' : `🎁 Grátis (${consumo.restanteEpisodios} eps restantes no mês)`;
            const streams = [];

            if (temDub) {
                streams.push({
                    name: 'BrasilFlix [1080p]',
                    title: `📺 ${serie.nome} T${seasonNum}E${epNum}\n🇧🇷 Dublado (PT-BR) • 1080p Full HD\n[${tagCota}]`,
                    url: `${baseUrl}/stream/video/${userToken}/serie/${serie.id}/${seasonNum}/${epNum}/dublado`
                });
            }

            if (temLeg) {
                streams.push({
                    name: 'BrasilFlix [1080p]',
                    title: `📺 ${serie.nome} T${seasonNum}E${epNum}\n💬 Legendado (PT-BR) • 1080p Full HD\n[${tagCota}]`,
                    url: `${baseUrl}/stream/video/${userToken}/serie/${serie.id}/${seasonNum}/${epNum}/legendado`
                });
            }

            return { streams };
        }
    }
}

module.exports = StremioService;
