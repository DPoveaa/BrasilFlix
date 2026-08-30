const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('🧪 Iniciando testes de validação de Microdramas Chineses / Duanju (9:16)...');

// 1. Check MicrodramaService
const microdramaService = require('../src/services/MicrodramaService');
assert(microdramaService, 'MicrodramaService deve ser importado com sucesso');

(async () => {
    try {
        const trending = await microdramaService.getTrendingMicrodramas(10);
        assert(Array.isArray(trending), 'Trending microdramas deve retornar um array');
        assert(trending.length > 0, 'Trending deve conter itens populares');
        console.log(`✅ MicrodramaService: ${trending.length} microdramas em alta encontrados`);
        
        const first = trending[0];
        assert.strictEqual(first.formato, 'vertical', 'Formato deve ser vertical');
        assert.strictEqual(first.subtipo, 'microdrama', 'Subtipo deve ser microdrama');
        assert(first.nomeOriginal && first.nomeOriginal.length > 0, 'Deve conter título original em chinês');
        assert(first.totalEpisodios >= 40, 'Microdramas devem suportar contagem alta de episódios');
        assert(first.plataformaOrigem, 'Deve indicar plataforma de origem (DramaBox/ReelShort/etc)');
        console.log(`✅ Metadados estruturados validados para "${first.nome}" (${first.nomeOriginal}) - ${first.plataformaOrigem}`);

        // 2. Test search
        const searchRes = await microdramaService.searchMicrodramas('Herdeiro');
        assert(searchRes.length > 0, 'Busca por "Herdeiro" deve retornar resultados');
        console.log(`✅ Busca por termo no MicrodramaService validada com sucesso (${searchRes.length} resultado(s))`);

        // 3. Test CatalogoManager Integration
        const CatalogoManager = require('../src/managers/CatalogoManager');
        
        const mockMicrodramaRaw = {
            id: 8881,
            nome: 'O Retorno do Herdeiro Supremo',
            nome_original: '至尊龙婿',
            ano: '2024',
            generos: ['Dorama', 'Microdrama', 'Romance', 'Vingança'],
            sinopse: 'Um jovem herdeiro humilhado revela sua verdadeira identidade.',
            poster_url: 'https://img.sample/poster.jpg',
            backdrop_url: 'https://img.sample/backdrop.jpg',
            nota: 9.4,
            subtipo: 'microdrama',
            formato: 'vertical',
            origem: 'China',
            plataforma_origem: 'DramaBox',
            trending_score: 98.5,
            is_dorama: true,
            is_dublado: true,
            is_legendado: true
        };

        // Create 80 mocked episodes
        const mockEps = [];
        for (let i = 1; i <= 80; i++) {
            mockEps.push({
                numero: i,
                nome: `Episódio ${i}`,
                messageId: 10000 + i,
                fileId: `file_${i}`,
                qualidade: '1080p',
                isDublado: true,
                isLegendado: true,
                formato: 'vertical',
                duracao: 90
            });
            // Mark as playable in CatalogoManager cache
            CatalogoManager.mediaVerificationCache.set(10000 + i, {
                status: 'VERIFIED_PLAYABLE',
                docId: `file_${i}`,
                sizeBytes: 15 * 1024 * 1024,
                timestamp: Date.now()
            });
        }

        CatalogoManager.allowUnverifiedPlayback = true;
        const processed = CatalogoManager.processSerie(mockMicrodramaRaw, { 1: mockEps });
        assert(processed, 'Microdrama deve ser processado com sucesso');
        assert.strictEqual(processed.isDorama, true, 'Microdrama deve estar categorizado em Doramas');
        assert.strictEqual(processed.isMicrodrama, true, 'isMicrodrama deve ser true');
        assert.strictEqual(processed.subtipo, 'microdrama', 'subtipo deve ser microdrama');
        assert.strictEqual(processed.formato, 'vertical', 'formato deve ser vertical');
        assert.strictEqual(processed.origem, 'China', 'origem deve ser China');
        assert.strictEqual(processed.plataformaOrigem, 'DramaBox', 'plataformaOrigem deve ser DramaBox');
        assert.strictEqual(processed.totalEpisodios, 80, 'Total de episódios deve ser 80');
        assert.strictEqual(processed.temporadas[0].episodios.length, 80, 'Temporada 1 deve conter todos os 80 episódios válidos');

        console.log(`✅ CatalogoManager processou perfeitamente microdrama vertical com 80 episódios!`);

        // 4. Validate index.html syntax
        const html = fs.readFileSync('public/index.html', 'utf8');
        assert(html.includes('.playback-player-stage.is-vertical-video'), 'CSS de vídeo vertical 9:16 deve existir em index.html');
        assert(html.includes('playback-batch-tabs-bar'), 'CSS de paginação em lote deve existir');
        assert(html.includes('dorama-filter-bar'), 'Sub-filtros da categoria de Doramas devem existir');
        assert(html.includes('filterDoramasSubtype'), 'Função de filtro de subtipos de dorama deve existir');

        const scriptMatch = html.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
        assert(scriptMatch && scriptMatch[1], 'Script JS deve existir');
        new Function(scriptMatch[1]);
        console.log('✅ Sintaxe JavaScript do index.html (com suporte a microdramas 9:16) 100% válida!');

        console.log('\n🎉 TODOS OS TESTES DE MICRODRAMAS CHINESES (9:16) PASSARAM COM SUCESSO!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Falha nos testes:', e);
        process.exit(1);
    }
})();
