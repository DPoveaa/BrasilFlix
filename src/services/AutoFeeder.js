const cron = require('node-cron');
const config = require('../../config');
const TMDBService = require('./TMDBService');
const { PRIORITIES } = require('../managers/QueueManager');

class AutoFeeder {
    constructor(queueManager, catalogoManager) {
        this.queueManager = queueManager;
        this.catalogoManager = catalogoManager;
        this.isEnabled = config.AUTO_FEEDER_ENABLED !== false;
        this.isRunningCheck = false;
    }

    start() {
        if (!this.isEnabled) {
            console.log('💤 AutoFeeder desativado na configuração.');
            return;
        }

        console.log('🤖 AutoFeeder ativado! Monitorando filmes e doramas populares...');

        // Executa uma verificação inicial após 10 segundos de inicialização
        setTimeout(() => {
            this.runCheck();
        }, 10000);

        // Agendamento periódico: roda a cada 4 horas
        cron.schedule('0 */4 * * *', () => {
            console.log('⏰ AutoFeeder: Iniciando ciclo de varredura periódica...');
            this.runCheck();
        });
    }

    async runCheck() {
        if (this.isRunningCheck) return;
        this.isRunningCheck = true;

        try {
            console.log('🔍 AutoFeeder: Consultando conteúdos em alta no TMDB...');

            // 1. Filmes em alta
            const trendingMovies = await TMDBService.getTrendingMovies('week');
            for (const movie of trendingMovies.slice(0, 15)) {
                await this.considerItem(movie, 'filme');
            }

            // 2. Séries em alta
            const trendingTV = await TMDBService.getTrendingTV('week');
            for (const tv of trendingTV.slice(0, 10)) {
                await this.considerItem(tv, 'serie');
            }

            // 3. Doramas populares (K-Dramas)
            const popularDoramas = await TMDBService.getPopularKDramas();
            // 4. Auto-Upgrade: Verificar se filmes de cinema já possuem versão oficial WEB-DL/BluRay
            if (config.AUTO_UPGRADE_CAM) {
                await this.checkCamUpgrades();
            }

        } catch (error) {
            console.error('❌ Erro no ciclo do AutoFeeder:', error.message);
        } finally {
            this.isRunningCheck = false;
        }
    }

    async checkCamUpgrades() {
        try {
            const camMovies = this.catalogoManager.buscarFilmesCam();
            if (camMovies.length === 0) return;

            console.log(`🔄 AutoFeeder: Verificando possíveis upgrades para ${camMovies.length} filme(s) em qualidade de Cinema...`);

            for (const filme of camMovies) {
                // Pesquisa apenas por versões não-CAM (WEB-DL / BluRay)
                const sources = await MediaSearchService.search(filme.nome, 'filme', {
                    nomeOriginal: filme.nomeOriginal,
                    ano: filme.ano,
                    onlyWebDl: true
                });

                const officialSource = sources.find(s => s.isWebDl && s.seeders > 0);
                if (officialSource) {
                    console.log(`🌟 UPGRADE ENCONTRADO para "${filme.nome}"! Fonte Oficial: ${officialSource.title}`);
                    // Enfileira com prioridade alta para upgrade
                    this.queueManager.addJob(filme.nome, 'filme', 2, {
                        tmdbId: filme.tmdbId,
                        isUpgrade: true,
                        allowCam: false
                    });
                }
            }
        } catch (e) {
            console.error('⚠️ Erro ao verificar upgrades de cinema:', e.message);
        }
    }

    async considerItem(item, tipo, isDorama = false) {
        const title = item.nome;
        if (!title) return;

        // 1. Verifica se já existe no catálogo
        const existing = this.catalogoManager.buscarItemExato(title, tipo);
        if (existing) {
            return; // Já temos no catálogo
        }

        // 2. Verifica se já está na fila
        const inQueue = this.queueManager.queue.some(j => 
            j.title.toLowerCase() === title.toLowerCase() && j.status !== 'failed'
        );

        if (inQueue) {
            return; // Já está na fila
        }

        console.log(`✨ AutoFeeder adicionando à fila de background: "${title}" (${tipo}${isDorama ? ' - Dorama' : ''})`);

        this.queueManager.addJob(title, tipo, PRIORITIES.FEEDER, {
            tmdbId: item.tmdbId,
            isDorama: isDorama,
            season: 1,
            episode: tipo === 'serie' ? 1 : null
        });
    }
}

module.exports = AutoFeeder;
