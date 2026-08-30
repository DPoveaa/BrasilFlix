const assert = require('assert');
const PriorityService = require('../src/services/PriorityService');
const CatalogoManager = require('../src/managers/CatalogoManager');
const VideoProcessor = require('../src/services/VideoProcessor');

console.log('🧪 Iniciando testes de Filas, Detecção de Áudio, Legendas e Telegram Bot para Microdramas...');

(async () => {
    try {
        // 1. Test PriorityService
        assert(PriorityService.get('MICRODRAMA') !== undefined, 'PriorityService deve conter prioridade MICRODRAMA');
        console.log(`✅ PriorityService: MICRODRAMA configurado com prioridade ${PriorityService.get('MICRODRAMA')}`);

        // 2. Test Audio Detection for Chinese Microdramas
        const vp = VideoProcessor;
        
        // Scenario A: Dual Audio release with Chinese and PT-BR
        const dualAudioStreams = [
            { language: 'zho', title: 'Chinese Original (Mandarim)' },
            { language: 'por', title: 'Português Dublado BrasilFlix' }
        ];
        const ptIdx = vp.detectPortugueseAudioIndex(dualAudioStreams, 'Zhi.Zun.Long.Xu.S01.Dual.1080p');
        assert.strictEqual(ptIdx, 1, 'Deve detectar a trilha 1 como PT-BR');
        console.log('✅ VideoProcessor: Detecção de áudio PT-BR em microdramas validada com sucesso');

        // Scenario B: Subtitled Chinese audio selection (Original Mandarin)
        const targetZhIdx = vp.detectTargetAudioIndex(dualAudioStreams, { isLegendado: true, isDublado: false, idiomaOriginal: 'zh' });
        assert.strictEqual(targetZhIdx, 0, 'Deve selecionar trilha 0 (Mandarim original) para versão legendada');
        console.log('✅ VideoProcessor: Seleção de áudio original em Mandarim para versão legendada validada com sucesso');

        // 3. Test CatalogoManager getMicrodramas
        const catMgr = new CatalogoManager();
        catMgr.catalogo = {
            filmes: [],
            series: [
                { id: 1, nome: 'Série Normal', isDorama: false, subtipo: 'serie', formato: 'horizontal', temporadas: [] },
                { id: 2, nome: 'K-Drama Coreano', isDorama: true, subtipo: 'dorama', formato: 'horizontal', temporadas: [] },
                { id: 3, nome: 'Herdeiro Supremo', isDorama: true, isMicrodrama: true, subtipo: 'microdrama', formato: 'vertical', temporadas: [] }
            ]
        };

        const microdramas = catMgr.getMicrodramas();
        assert.strictEqual(microdramas.length, 1, 'Deve retornar exatamente 1 microdrama');
        assert.strictEqual(microdramas[0].id, 3, 'O microdrama retornado deve ser o ID 3');
        
        const stats = catMgr.getEstatisticas();
        assert.strictEqual(stats.totalMicrodramas, 1, 'Estatística totalMicrodramas deve ser 1');
        console.log('✅ CatalogoManager: getMicrodramas() e getEstatisticas() validados com sucesso');

        // 4. Test AutoFeeder checkMicrodramasFeed integration
        const AutoFeeder = require('../src/services/AutoFeeder');
        const mockQueue = [];
        const mockQueueManager = {
            queue: mockQueue,
            addJob: (title, type, priority, extraData) => {
                mockQueue.push({ title, type, priority, extraData, status: 'queued' });
            }
        };

        const autoFeeder = new AutoFeeder(mockQueueManager, catMgr, null);
        await autoFeeder.checkMicrodramasFeed();
        
        assert(mockQueue.length > 0, 'AutoFeeder deve enfileirar microdramas quando a fila estiver livre');
        assert.strictEqual(mockQueue[0].type, 'serie', 'Tipo deve ser serie');
        assert.strictEqual(mockQueue[0].extraData.subtipo, 'microdrama', 'Subtipo deve ser microdrama');
        assert.strictEqual(mockQueue[0].extraData.formato, 'vertical', 'Formato deve ser vertical');
        assert.strictEqual(mockQueue[0].priority, PriorityService.get('MICRODRAMA'), 'Prioridade deve ser MICRODRAMA');
        console.log(`✅ AutoFeeder: Microdrama "${mockQueue[0].title}" enfileirado com sucesso na Fila 2/Background`);

        // 5. Test CommandHandler Bot integration
        const CommandHandler = require('../src/handlers/CommandHandler');
        const cmdHandler = new CommandHandler(null, null, catMgr, null, mockQueueManager, null);
        assert(typeof cmdHandler.handleMicrodramasCommand === 'function', 'handleMicrodramasCommand deve existir no CommandHandler');
        assert(typeof cmdHandler.handleCatalogoMicrodramas === 'function', 'handleCatalogoMicrodramas deve existir no CommandHandler');
        console.log('✅ Telegram Bot CommandHandler: Comandos /microdramas e catálogo vertical validados com sucesso');

        console.log('\n🎉 TODOS OS TESTES DE FILA, DETECÇÃO DE ÁUDIO E BOT PASSARAM COM SUCESSO!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Erro no teste:', e);
        process.exit(1);
    }
})();
