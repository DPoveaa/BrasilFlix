const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const PedidosManager = require('./managers/PedidosManager');
const CatalogoManager = require('./managers/CatalogoManager');
const AssinaturaManager = require('./managers/AssinaturaManager');
const FavoritosManager = require('./managers/FavoritosManager');
const { QueueManager } = require('./managers/QueueManager');
const AutoFeeder = require('./services/AutoFeeder');
const StremioServer = require('./services/StremioServer');
const MessageHandler = require('./handlers/MessageHandler');
const CommandHandler = require('./handlers/CommandHandler');
const cron = require('node-cron');

class BrasilFlixBot {
    constructor() {
        this.bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
        this.pedidosManager = new PedidosManager();
        this.catalogoManager = new CatalogoManager();
        this.assinaturaManager = new AssinaturaManager();
        this.queueManager = new QueueManager(this.bot, this.catalogoManager, this.pedidosManager, this.favoritosManager);
        this.autoFeeder = new AutoFeeder(this.queueManager, this.catalogoManager, this.pedidosManager);
        this.stremioServer = new StremioServer(this.catalogoManager, this.assinaturaManager, this.queueManager);
        this.commandHandler = new CommandHandler(this.bot, this.pedidosManager, this.catalogoManager, this.assinaturaManager, this.queueManager, this.favoritosManager);
        this.messageHandler = new MessageHandler(this.bot, this.pedidosManager, this.catalogoManager, this.assinaturaManager, this.commandHandler, this.queueManager);
        
        this.setupEventHandlers();
        this.setupCronJobs();
    }

    async init() {
        await Promise.all([
            this.catalogoManager.loadCatalogo(),
            this.pedidosManager.loadPedidos(),
            this.assinaturaManager.loadAssinaturas(),
            this.favoritosManager.loadData()
        ]);
        this.autoFeeder.start();
        this.stremioServer.start();
        console.log('🤖 BrasilFlix Bot + Auto-Feeder + Servidor Stremio iniciado com sucesso!');
    }

    start() {
        // Inicialização dos comandos do bot no menu oficial do Telegram
        this.setupBotCommands();
    }

    setupEventHandlers() {
        // Handler para comandos básicos
        this.bot.onText(/\/start/, (msg) => this.commandHandler.handleStart(msg));
        this.bot.onText(/\/admin/, (msg) => this.commandHandler.handleAdminStart(msg));
        this.bot.onText(/\/stremio/, (msg) => this.commandHandler.handleStremioCommand(msg));
        this.bot.onText(/\/favoritos/, (msg) => this.commandHandler.handleMeusFavoritos(msg.chat.id, msg.from.id, 1));
        this.bot.onText(/\/ajuda/, (msg) => this.commandHandler.handleHelp(msg));
        this.bot.onText(/\/pedido (.+)/, (msg, match) => this.commandHandler.handlePedido(msg, match));
        this.bot.onText(/\/pedir (.+)/, (msg, match) => this.commandHandler.handlePedido(msg, match));
        this.bot.onText(/\/buscar (.+)/, (msg, match) => this.commandHandler.handleBuscar(msg, match));
        this.bot.onText(/\/catalogo/, (msg) => this.commandHandler.handleCatalogo(msg));
        this.bot.onText(/\/fila/, (msg) => this.commandHandler.handleFila(msg));
        this.bot.onText(/\/adicionar/, (msg) => this.commandHandler.handleAdicionar(msg));
        this.bot.onText(/\/adicionar_manual (.+)/, (msg, match) => this.commandHandler.handleAdicionarManual(msg, match));
        this.bot.onText(/\/adicionar_forcar (.+)/, (msg, match) => this.commandHandler.handleAdicionarForcar(msg, match));

        // Handler para comandos de assinatura
        this.bot.onText(/\/assinar/, (msg) => this.commandHandler.handleAssinar(msg));
        this.bot.onText(/\/assinar_mensal/, (msg) => this.commandHandler.handleAssinarPlano(msg, 'mensal'));
        this.bot.onText(/\/assinar_trimestral/, (msg) => this.commandHandler.handleAssinarPlano(msg, 'trimestral'));
        this.bot.onText(/\/assinar_anual/, (msg) => this.commandHandler.handleAssinarPlano(msg, 'anual'));
        this.bot.onText(/\/minhaassinatura/, (msg) => this.commandHandler.handleMinhaAssinatura(msg));
        this.bot.onText(/\/meuplano/, (msg) => this.commandHandler.handleMinhaAssinatura(msg));

        // Handler para comandos de admin
        this.bot.onText(/\/pedidos/, (msg) => this.commandHandler.handleAdminPedidos(msg));
        this.bot.onText(/\/assinaturas/, (msg) => this.commandHandler.handleAdminAssinaturas(msg));
        this.bot.onText(/\/stats/, (msg) => this.commandHandler.handleAdminStats(msg));
        this.bot.onText(/\/rebaixar(?: (.+))?/, (msg, match) => this.commandHandler.handleRebaixar(msg, match));
        this.bot.onText(/\/atualizar(?: (.+))?/, (msg, match) => this.commandHandler.handleRebaixar(msg, match));
        this.bot.onText(/\/remover(?: (.+))?/, (msg, match) => this.commandHandler.handleRemoverAdmin(msg, match));
        this.bot.onText(/\/excluir(?: (.+))?/, (msg, match) => this.commandHandler.handleRemoverAdmin(msg, match));

        // Handler para callbacks dos botões
        this.bot.on('callback_query', (callbackQuery) => this.commandHandler.handleCallbackQuery(callbackQuery));

        // Handler para mensagens de texto
        this.bot.on('message', (msg) => this.messageHandler.handleMessage(msg));

        // Handler para erros
        this.bot.on('error', (error) => {
            console.error('❌ Erro no bot:', error);
        });

        this.bot.on('polling_error', (error) => {
            if (error.code === 'ETELEGRAM' && error.response && error.response.statusCode === 502) {
                return;
            }
            if (error.code === 'EFATAL' || error.code === 'ETIMEDOUT') {
                return;
            }
            console.warn(`⚠️ Aviso de rede Telegram (${error.code || 'Desconhecido'}): ${error.message}`);
        });
    }

    setupCronJobs() {
        cron.schedule('0 9 * * *', async () => {
            await this.verificarAssinaturasVencendo();
        });

        cron.schedule('0 */6 * * *', async () => {
            await this.verificarAssinaturasVencidas();
        });
    }

    async verificarAssinaturasVencendo() {
        try {
            const vencendo = this.assinaturaManager.getAssinaturasVencendo(3);
            for (const assinatura of vencendo) {
                const info = this.assinaturaManager.formatarAssinatura(assinatura);
                const mensagem = `⚠️ *Sua assinatura BrasilFlix está vencendo!*\n\n` +
                                `📅 *Vencimento:* ${info.vencimento}\n` +
                                `⏳ *Dias restantes:* ${info.diasRestantes}\n\n` +
                                `Para renovar e continuar aproveitando todos os lançamentos 1080p, use o comando /assinar.`;
                
                await this.bot.sendMessage(assinatura.userId, mensagem, { parse_mode: 'Markdown' }).catch(() => {});
            }
        } catch (e) {
            console.error('Erro na verificação de assinaturas vencendo:', e);
        }
    }

    async verificarAssinaturasVencidas() {
        try {
            const vencidas = this.assinaturaManager.getAssinaturasVencidas();
            for (const assinatura of vencidas) {
                assinatura.status = 'vencida';
                const mensagem = `❌ *Sua assinatura BrasilFlix expirou!*\n\n` +
                                `Seu acesso VIP foi pausado temporariamente.\n` +
                                `Renove agora com o comando /assinar e continue assistindo! 🍿`;
                
                await this.bot.sendMessage(assinatura.userId, mensagem, { parse_mode: 'Markdown' }).catch(() => {});
            }
            this.assinaturaManager.saveAssinaturas();
        } catch (e) {
            console.error('Erro na verificação de assinaturas vencidas:', e);
        }
    }

    async setupBotCommands() {
        try {
            await this.bot.setMyCommands([
                { command: 'start', description: 'Abrir menu principal do BrasilFlix' },
                { command: 'catalogo', description: 'Navegar por filmes, séries e doramas' },
                { command: 'stremio', description: 'Instalar Addon no app Stremio VIP' },
                { command: 'pedir', description: 'Fazer pedido de filme ou série' },
                { command: 'fila', description: 'Ver status da fila de downloads' },
                { command: 'favoritos', description: 'Meus títulos favoritos salvos' },
                { command: 'assinar', description: 'Planos e assinaturas VIP' },
                { command: 'meuplano', description: 'Consultar status do meu plano' },
                { command: 'ajuda', description: 'Suporte e como usar o robô' }
            ]);
            console.log('✅ Comandos do bot configurados com sucesso!');
        } catch (e) {
            console.warn('Aviso ao registrar comandos do bot:', e.message);
        }
    }
}

module.exports = { BrasilFlixBot };