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
        this.catalogoManager.setBot(this.bot);
        this.assinaturaManager = new AssinaturaManager();
        this.assinaturaManager.setBot(this.bot);
        this.favoritosManager = new FavoritosManager();
        this.queueManager = new QueueManager(this.bot, this.catalogoManager, this.pedidosManager, this.favoritosManager);
        this.autoFeeder = new AutoFeeder(this.queueManager, this.catalogoManager, this.pedidosManager);
        this.stremioServer = new StremioServer(this.catalogoManager, this.assinaturaManager, this.queueManager, this.pedidosManager);
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
        this.bot.onText(/\/site/, (msg) => this.commandHandler.handleWebPlayerCommand(msg));
        this.bot.onText(/\/webplayer/, (msg) => this.commandHandler.handleWebPlayerCommand(msg));
        this.bot.onText(/\/player/, (msg) => this.commandHandler.handleWebPlayerCommand(msg));
        this.bot.onText(/\/favoritos/, (msg) => this.commandHandler.handleMeusFavoritos(msg.chat.id, msg.from.id, 1));
        this.bot.onText(/\/ajuda/, (msg) => this.commandHandler.handleHelp(msg));
        this.bot.onText(/\/pedido (.+)/, (msg, match) => this.commandHandler.handlePedido(msg, match));
        this.bot.onText(/\/pedir (.+)/, (msg, match) => this.commandHandler.handlePedido(msg, match));
        this.bot.onText(/\/buscar (.+)/, (msg, match) => this.commandHandler.handleBuscar(msg, match));
        this.bot.onText(/\/catalogo/, (msg) => this.commandHandler.handleCatalogo(msg));
        this.bot.onText(/\/microdramas/, (msg) => this.commandHandler.handleMicrodramasCommand(msg));
        this.bot.onText(/\/duanju/, (msg) => this.commandHandler.handleMicrodramasCommand(msg));
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
        this.bot.onText(/\/limpar_armazem/, (msg) => this.commandHandler.handleLimparArmazem(msg));

        // Handler para callbacks dos botões
        this.bot.on('callback_query', (callbackQuery) => this.commandHandler.handleCallbackQuery(callbackQuery));

        // Handler para mensagens de texto e comandos (notifica admin sobre mensagens de outros usuários)
        this.bot.on('message', (msg) => {
            this.notifyAdminIncoming(msg);
            this.messageHandler.handleMessage(msg);
        });

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

    async notifyAdminIncoming(msg) {
        if (!msg || !msg.from) return;
        const senderId = Number(msg.from.id);
        const adminId = Number(config.ADMIN_ID);

        // Ignora se for o próprio admin ou mensagem de grupos técnicos (armazenamento/notificações)
        if (senderId === adminId) return;
        if (msg.chat && (msg.chat.id === config.STORAGE_GROUP_ID || msg.chat.id === config.NOTIFICATION_GROUP_ID)) return;

        try {
            if (!this.botUsername) {
                const me = await this.bot.getMe().catch(() => null);
                this.botUsername = me?.username || 'BrasilFlix_bot';
            }

            const nome = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || (msg.from.username ? `@${msg.from.username}` : 'Usuário');
            const idioma = msg.from.language_code || 'pt-br';

            // Data formatada no fuso de São Paulo (DD/MM/AAAA HH:mm)
            const dataHora = new Date((msg.date ? msg.date * 1000 : Date.now())).toLocaleString('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            const textoRaw = msg.text || msg.caption || (msg.photo ? '[Foto]' : (msg.document ? `[Arquivo: ${msg.document.file_name || 'Documento'}]` : (msg.video ? '[Vídeo]' : (msg.audio ? '[Áudio]' : (msg.contact ? '[Contato]' : '[Mídia]')))));

            const escapeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            const notificacao = 
                `📩 <b>Mensagem Recebida:</b>\n` +
                `🤖 <b>No Bot:</b> <a href="https://t.me/${this.botUsername}">@${this.botUsername}</a>\n` +
                `👤 <b>De:</b> ${escapeHtml(nome)}\n` +
                `🆔 <b>ID:</b> <code>${senderId}</code>\n` +
                `🌐 <b>Idioma:</b> ${escapeHtml(idioma)}\n` +
                `📅 <b>Data:</b> ${dataHora}\n` +
                `💬 <b>Texto:</b> <code>${escapeHtml(textoRaw)}</code>`;

            await this.bot.sendMessage(adminId, notificacao, {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            }).catch(err => {
                console.warn(`⚠️ Não foi possível notificar admin (${adminId}):`, err.message);
            });
        } catch (err) {
            console.warn('⚠️ Erro ao processar notificação de mensagem para admin:', err.message);
        }
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

    async setupBotCommands(retryCount = 0) {
        // Aguarda 2 segundos após a inicialização para estabilização de sockets/DNS
        if (retryCount === 0) {
            await new Promise(r => setTimeout(r, 2000));
        }

        try {
            await this.bot.setMyCommands([
                { command: 'start', description: '🍿 Início / Menu Principal' },
                { command: 'buscar', description: '🔍 Buscar Filme ou Série' },
                { command: 'catalogo', description: '📚 Ver Catálogo Completo' },
                { command: 'favoritos', description: '⭐ Meus Favoritos' },
                { command: 'pedido', description: '🎬 Fazer Pedido de Filme/Série' },
                { command: 'stremio', description: '📺 Assistir na TV (Stremio)' },
                { command: 'fila', description: '⚡ Status de Downloads' },
                { command: 'assinar', description: '💎 Planos e Assinaturas VIP' },
                { command: 'meuplano', description: '💳 Consultar Meu Plano' },
                { command: 'ajuda', description: '❓ Dúvidas e Suporte' }
            ]);
            console.log('✅ Comandos do bot configurados no Telegram com sucesso!');
        } catch (e) {
            if (retryCount < 3) {
                const waitMs = (retryCount + 1) * 3000;
                console.warn(`⚠️ [setMyCommands] Tentativa ${retryCount + 1} falhou (${e.message}). Tentando novamente em ${waitMs / 1000}s...`);
                setTimeout(() => this.setupBotCommands(retryCount + 1), waitMs);
            } else {
                console.warn('⚠️ Não foi possível registrar comandos do bot no Telegram:', e.message);
            }
        }
    }
}

module.exports = { BrasilFlixBot };