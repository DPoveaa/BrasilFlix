const axios = require('axios');
const TMDBService = require('./TMDBService');

/**
 * MicrodramaService - Catálogo e Motor de Descoberta de Microdramas Chineses / Short Dramas Verticais (短剧 / Duanju)
 * Suporta plataformas líderes: DramaBox, ReelShort, ShortMax, GoodShort, FlexTV, NetShort.
 */
class MicrodramaService {
    constructor() {
        // Base de dados curada e sincronizável de microdramas populares em alta (com faixas PT-BR)
        this.popularMicrodramas = [
            {
                id: 'md_dramabox_01',
                nome: 'O Retorno do Herdeiro Supremo',
                nomeOriginal: '至尊龙婿 (Zhi Zun Long Xu)',
                nomeIngles: 'Return of the Supreme Heir',
                ano: '2024',
                sinopse: 'Humilhado pela família de sua esposa durante anos, ele finalmente revela sua verdadeira identidade como o governante da maior corporação e mestre das artes marciais.',
                posterUrl: 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=800&auto=format&fit=crop&q=80',
                backdropUrl: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
                generos: ['Dorama', 'Microdrama', 'Romance', 'Vingança', 'Ação'],
                totalEpisodios: 80,
                duracaoMediaSegundos: 90,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'DramaBox',
                nota: 9.4,
                trendingScore: 98.5,
                isDublado: false,
                isLegendado: true,
                audio: 'Legendado (PT-BR)',
                qualidade: '1080p Full HD (9:16)',
                status: 'Completo',
                tags: ['bilionario', 'vinganca', 'ceo', 'dramabox', 'vertical', 'duanju']
            },
            {
                id: 'md_reelshort_02',
                nome: 'Casada com o CEO Desconhecido',
                nomeOriginal: '闪婚神秘老公 (Shan Hun Shen Mi Lao Gong)',
                nomeIngles: 'Never Divorce a Secret Billionaire',
                ano: '2024',
                sinopse: 'Após ser traída pelo noivo no dia do casamento, ela se casa por impulso com um homem que aparenta ser comum, sem saber que ele é o bilionário mais influente do país.',
                posterUrl: 'https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?w=800&auto=format&fit=crop&q=80',
                backdropUrl: 'https://images.unsplash.com/photo-1485846234645-a62644f84728?w=1200&auto=format&fit=crop&q=80',
                generos: ['Dorama', 'Microdrama', 'Romance', 'Drama', 'Comédia Romântica'],
                totalEpisodios: 92,
                duracaoMediaSegundos: 105,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'ReelShort',
                nota: 9.6,
                trendingScore: 99.2,
                isDublado: false,
                isLegendado: true,
                audio: 'Legendado (PT-BR)',
                qualidade: '1080p Full HD (9:16)',
                status: 'Completo',
                tags: ['ceo', 'casamento', 'romance', 'reelshort', 'vertical']
            },
            {
                id: 'md_shortmax_03',
                nome: 'A Vingança da Herdeira Renascida',
                nomeOriginal: '重生千金归来 (Chong Sheng Qian Jin Gui Lai)',
                nomeIngles: 'Reborn as the Heiress Revenge',
                ano: '2024',
                sinopse: 'Traída e eliminada por sua meia-irmã invejosa, ela renasce 5 anos no passado com todas as memórias intactas para recuperar seu império e desmascarar os traidores.',
                posterUrl: 'https://images.unsplash.com/photo-1478720568477-152d9b164e26?w=800&auto=format&fit=crop&q=80',
                backdropUrl: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=1200&auto=format&fit=crop&q=80',
                generos: ['Dorama', 'Microdrama', 'Suspense', 'Vingança', 'Drama'],
                totalEpisodios: 75,
                duracaoMediaSegundos: 85,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'ShortMax',
                nota: 9.2,
                trendingScore: 94.0,
                isDublado: false,
                isLegendado: true,
                audio: 'Legendado (PT-BR)',
                qualidade: '1080p Full HD (9:16)',
                status: 'Completo',
                tags: ['renascimento', 'vinganca', 'shortmax', 'duanju']
            },
            {
                id: 'md_flextv_04',
                nome: 'O Segredo da Esposa Silenciosa',
                nomeOriginal: '替嫁哑妻 (Ti Jia Ya Qi)',
                nomeIngles: 'The Mute Bride Secret',
                ano: '2024',
                sinopse: 'Forçada a se casar no lugar de sua irmã fingindo ser muda, ela descobre que seu marido frio e poderoso tem investigado seu passado secreto e suas habilidades medicinais lendárias.',
                posterUrl: 'https://images.unsplash.com/photo-1524712245354-2c4e5e7121c0?w=800&auto=format&fit=crop&q=80',
                backdropUrl: 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=1200&auto=format&fit=crop&q=80',
                generos: ['Dorama', 'Microdrama', 'Romance', 'Drama', 'Médico'],
                totalEpisodios: 68,
                duracaoMediaSegundos: 95,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'FlexTV',
                nota: 9.1,
                trendingScore: 91.8,
                isDublado: false,
                isLegendado: true,
                audio: 'Legendado (PT-BR)',
                qualidade: '1080p Full HD (9:16)',
                status: 'Completo',
                tags: ['medicina', 'romance', 'flextv', 'vertical']
            },
            {
                id: 'md_goodshort_05',
                nome: 'O Deus da Guerra Desperta',
                nomeOriginal: '绝世战神 (Jue Shi Zhan Shen)',
                nomeIngles: 'The God of War Awakens',
                ano: '2024',
                sinopse: 'Após defender as fronteiras por dez anos como o general invicto, ele volta para sua cidade natal disfarçado de guarda para proteger a mulher que salvou sua vida.',
                posterUrl: 'https://images.unsplash.com/photo-1509198397868-475647b2a1e5?w=800&auto=format&fit=crop&q=80',
                backdropUrl: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?w=1200&auto=format&fit=crop&q=80',
                generos: ['Dorama', 'Microdrama', 'Ação', 'Artes Marciais', 'Drama'],
                totalEpisodios: 88,
                duracaoMediaSegundos: 110,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'GoodShort',
                nota: 9.5,
                trendingScore: 97.4,
                isDublado: false,
                isLegendado: true,
                audio: 'Legendado (PT-BR)',
                qualidade: '1080p Full HD (9:16)',
                status: 'Completo',
                tags: ['artes-marciais', 'acao', 'goodshort', 'duanju']
            }
        ];
    }

    /**
     * Retorna os microdramas em alta (Trending)
     */
    async getTrendingMicrodramas(limit = 20) {
        try {
            // Ordena por índice de tendência e nota
            const sorted = [...this.popularMicrodramas].sort((a, b) => b.trendingScore - a.trendingScore);
            return sorted.slice(0, limit);
        } catch (e) {
            console.error('Erro ao buscar microdramas em alta:', e.message);
            return this.popularMicrodramas;
        }
    }

    /**
     * Busca microdramas por termo de busca (Português, Chinês, Inglês ou Pinyin)
     */
    async searchMicrodramas(query) {
        if (!query || !query.trim()) return [];
        const clean = query.toLowerCase().trim();

        // 1. Busca na base interna de tendências
        const localMatches = this.popularMicrodramas.filter(m => 
            m.nome.toLowerCase().includes(clean) ||
            m.nomeOriginal.toLowerCase().includes(clean) ||
            m.nomeIngles.toLowerCase().includes(clean) ||
            m.tags.some(t => t.toLowerCase().includes(clean)) ||
            (m.plataformaOrigem && m.plataformaOrigem.toLowerCase().includes(clean))
        );

        if (localMatches.length > 0) return localMatches;

        // 2. Busca no TMDB com filtro de TV / Drama
        try {
            const tmdbResults = await TMDBService.searchTV(query);
            const enriched = tmdbResults.map(r => ({
                id: `md_tmdb_${r.tmdbId}`,
                nome: r.nome,
                nomeOriginal: r.nomeOriginal || r.nome,
                ano: r.ano,
                sinopse: r.sinopse,
                posterUrl: r.posterUrl,
                backdropUrl: r.backdropUrl,
                generos: r.generos || ['Dorama', 'Microdrama'],
                totalEpisodios: 40,
                duracaoMediaSegundos: 90,
                formato: 'vertical',
                subtipo: 'microdrama',
                origem: 'China',
                plataformaOrigem: 'Duanju',
                nota: r.nota || 8.5,
                trendingScore: 85.0,
                isDublado: true,
                isLegendado: true,
                audio: 'Dublado (Áudio PT-BR)',
                qualidade: '1080p Full HD (9:16)'
            }));
            return enriched;
        } catch (e) {
            return [];
        }
    }

    /**
     * Normaliza e desduplica títulos com base em aliases e caracteres chineses
     */
    normalizeMicrodramaTitle(title) {
        if (!title) return '';
        return title
            .replace(/\b(?:dramabox|reelshort|shortmax|goodshort|flextv|netshort|sereal|moboreels)\b/gi, '')
            .replace(/\b(?:dublado|legendado|completo|full|hd|1080p|pt-br|ptbr)\b/gi, '')
            .replace(/\[[^\]]*\]|\([^\)]*\)/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }
}

module.exports = new MicrodramaService();
