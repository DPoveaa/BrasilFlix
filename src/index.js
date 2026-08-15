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
        this.favoritosManager = new FavoritosManager();
        this.queueManager = new QueueManager(this.bot, this.catalogoManager, this.pedidosManager, this.favoritosManager);
        this.autoFeeder = new AutoFeeder(this.queueManager, this.catalogoManager);
        this.stremioServer = new StremioServer(this.catalogoManager, this.assinaturaManager, this.queueManager);
        this.commandHandler = new CommandHandler(this.bot, this.pedidosManager, this.catalogoManager, this.assinaturaManager, this.queueManager, this.favoritosManager);
        this.messageHandler = new MessageHandler(this.bot, this.pedidosManager, this.catalogoManager, this.assinaturaManager, this.commandHandler, this.queueManager);
        
        this.setupEventHandlers();
        this.setupCronJobs();
        this.autoFeeder.start();
        this.stremioServer.start();
        console.log('🤖 BrasilFlix Bot + Auto-Feeder + Servidor Stremio iniciado com sucesso!');
    }

    setupEventHandlers() {
        // Handler para comandos básicos
        this.bot.onText(/\/start/, (msg) => this.commandHandler.handleStart(msg));
        this.bot.onText(/\/admin/, (msg) => this.commandHandler.handleAdminStart(msg));
        this.bot.onText(/\/stremio/, (msg) => this.commandHandler.handleStremioCommand(msg));
        this.bot.onText(/\/favoritos/, (msg) => this.commandHandler.handleMeusFavoritos(msg.chat.id, msg.from.id, 1));
        this.bot.onText(/\/ajuda/, (msg) => this.commandHandler.handleHelp(msg));
        this.bot.onText(/\/pedido (.+)/, (msg, match) => this.commandHandler.handlePedido(msg, match));
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
                // Instabilidade temporária da API do Telegram (502 Bad Gateway) - o bot reconecta sozinho
                return;
            }
            if (error.code === 'EFATAL' || error.code === 'ETIMEDOUT') {
                return;
            }
            console.warn(`⚠️ Aviso de rede Telegram (${error.code || 'Desconhecido'}): ${error.message}`);
        });
    }

    setupCronJobs() {
        // Verificar assinaturas vencendo diariamente às 9h
        cron.schedule('0 9 * * *', async () => {
            await this.verificarAssinaturasVencendo();
        });

        // Verificar assinaturas vencidas a cada 6 horas
        cron.schedule('0 */6 * * *', async () => {
            await this.verificarAssinaturasVencidas();
        });
    }

    async verificarAssinaturasVencendo() {
        try {
            const vencendo = this.assinaturaManager.getAssinaturasVencendo(3); // 3 dias
            
            if (vencendo.length > 0) {
                let mensagem = `⚠️ *Assinaturas Vencendo em Breve*\n\n`;
                
                vencendo.forEach(assinatura => {
                    const info = this.assinaturaManager.formatarAssinatura(assinatura);
                    mensagem += `👤 ${assinatura.username}\n`;
                    mensagem += `📅 Vence em: ${info.diasRestantes} dias\n`;
                    mensagem += `💳 Plano: ${info.plano}\n\n`;
                });

                // Enviar para o grupo de notificações
                await this.bot.sendMessage(config.NOTIFICATION_GROUP_ID, mensagem, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Erro ao verificar assinaturas vencendo:', error);
        }
    }

    async verificarAssinaturasVencidas() {
        try {
            const vencidas = this.assinaturaManager.getAssinaturasVencidas();
            
            if (vencidas.length > 0) {
                let mensagem = `❌ *Assinaturas Vencidas*\n\n`;
                
                vencidas.forEach(assinatura => {
                    mensagem += `👤 ${assinatura.username}\n`;
                    mensagem += `📅 Venceu em: ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n`;
                    mensagem += `💳 Plano: ${assinatura.plano}\n\n`;
                });

                // Enviar para o grupo de notificações
                await this.bot.sendMessage(config.NOTIFICATION_GROUP_ID, mensagem, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Erro ao verificar assinaturas vencidas:', error);
        }
    }

    start() {
        // Bot já está rodando com polling
    }
}

// Iniciar o bot (apenas se executado diretamente)
if (require.main === module) {
    const bot = new BrasilFlixBot();
    bot.start();
}

// Exportar a classe para uso externo
module.exports = { BrasilFlixBot };