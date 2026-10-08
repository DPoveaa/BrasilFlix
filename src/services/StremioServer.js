const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const config = require('../../config');
const StremioService = require('./StremioService');
const telegramUploader = require('./TelegramUploader');
const { Api } = require('telegram');
const bigInt = require('big-integer');
const authService = require('./AuthService');
const TMDBService = require('./TMDBService');
const schedulerService = require('./SchedulerService');
const PriorityService = require('./PriorityService');
const ProgressManager = require('../managers/ProgressManager');
const CatalogoManager = require('../managers/CatalogoManager');
const RemovalQueueManager = require('../managers/RemovalQueueManager');
const db = require('../database/db');
const auditService = require('./AuditService');
const logBroadcaster = require('../utils/LogBroadcaster');

class StremioServer {
    constructor(catalogoManager, assinaturaManager, queueManager = null, pedidosManager = null, port = config.STREMIO_PORT || 7000) {
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
        this.queueManager = queueManager;
        this.pedidosManager = pedidosManager;
        this.tmdbService = TMDBService;
        this.progressManager = new ProgressManager();
        this.stremioService = new StremioService(catalogoManager, assinaturaManager);
        this.removalQueue = new RemovalQueueManager(catalogoManager, queueManager);
        this.port = port;
        this.app = express();
        this.setupMiddlewares();
        this.setupRoutes();
        this.progressManager.init().catch(() => {});
        authService.initAdminUser().catch(() => {});
    }

    setupMiddlewares() {
        this.app.use(express.json());

        // Normalização de trailing slashes para SEO (redireciona /assinar/ -> /assinar com 301)
        this.app.use((req, res, next) => {
            if (req.path.length > 1 && req.path.endsWith('/')) {
                const query = req.url.slice(req.path.length);
                const safepath = req.path.slice(0, -1);
                return res.redirect(301, safepath + query);
            }
            next();
        });

        const publicDir = path.resolve(__dirname, '../../public');
        this.app.use(express.static(publicDir));
        this.app.use('/assets', express.static(path.join(publicDir, 'assets')));

        // Header CORS universal para o Stremio e Web Players
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', '*');
            res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
            if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
            }
            next();
        });
    }

    getBaseUrl(req) {
        const forwardedHost = req?.get ? (req.get('x-forwarded-host') || req.get('host')) : null;
        if (forwardedHost && !forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')) {
            const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
            return `${protocol}://${forwardedHost}`;
        }
        return `https://${config.SERVER_HOST || 'brasilflix.kapsu.com.br'}`;
    }

    setupRoutes() {
        const publicDir = path.resolve(__dirname, '../../public');

        this.app.get('/favicon.ico', (req, res) => {
            res.setHeader('Content-Type', 'image/x-icon');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.sendFile(path.join(publicDir, 'favicon.ico'));
        });

        // 1. APIs Publicas Seguras (Zero dados sensiveis)
        this.app.get('/api/status', (req, res) => {
            const queueStatus = this.queueManager ? this.queueManager.getPublicStatus(this.catalogoManager) : { isProcessing: false, activeTask: null, activeTasks: [], maxConcurrentJobs: 4, queue: [], recentCompleted: [], totalQueued: 0 };
            const stats = this.catalogoManager.getEstatisticas();
            res.json({
                online: true,
                service: 'BrasilFlix Engine',
                uptime: process.uptime(),
                stats: stats,
                queue: queueStatus
            });
        });

        this.app.get('/api/catalogo', (req, res) => {
            const catalogo = this.catalogoManager.getPublicCatalogo();
            res.json(catalogo);
        });

        this.app.get('/api/fila', (req, res) => {
            const queueStatus = this.queueManager ? this.queueManager.getPublicStatus(this.catalogoManager) : { isProcessing: false, activeTask: null, activeTasks: [], maxConcurrentJobs: 4, queue: [], recentCompleted: [], totalQueued: 0 };
            res.json(queueStatus);
        });

        // ═══════════════════════════════════════════════════════════════════════
        // 🔒 ROTAS DE ADMINISTRAÇÃO PROTEGIDAS POR JWT
        // ═══════════════════════════════════════════════════════════════════════

        const auth = authService.authMiddleware();

        // 1. Autenticação
        this.app.post('/api/admin/login', async (req, res) => {
            const { username, password } = req.body;
            const result = await authService.login(username, password);
            if (!result.success) {
                return res.status(401).json(result);
            }
            res.json(result);
        });

        this.app.get('/api/admin/me', auth, (req, res) => {
            res.json({
                authenticated: true,
                user: req.adminUser
            });
        });

        this.app.post('/api/admin/change-password', auth, async (req, res) => {
            const { currentPassword, newPassword } = req.body;
            if (!newPassword || newPassword.length < 6) {
                return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres.' });
            }

            try {
                const userRes = await db.query(`SELECT password_hash FROM admin_users WHERE username = $1`, [req.adminUser.username]);
                if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });

                const isValid = authService.verifyPassword(currentPassword, userRes.rows[0].password_hash);
                if (!isValid) return res.status(400).json({ error: 'Senha atual incorreta.' });

                const newHash = authService.hashPassword(newPassword);
                await db.query(`UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE username = $2`, [newHash, req.adminUser.username]);
                res.json({ success: true, message: 'Senha atualizada com sucesso!' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 2. Visão Geral / Estatísticas do Sistema
        this.app.get('/api/admin/stats', auth, async (req, res) => {
            try {
                const catStats = this.catalogoManager ? this.catalogoManager.getEstatisticas() : { totalFilmes: 0, totalSeries: 0, totalEpisodios: 0 };
                const queueStats = this.queueManager ? this.queueManager.getStatus() : { total: 0, queued: 0, completed: 0, failed: 0 };
                const assinaturasAtivas = (this.assinaturaManager?.assinaturas || []).filter(a => a.status === 'ativa').length;
                const pedidosPendentes = (this.pedidosManager?.getPedidosPendentes() || []).length;
                const totalTokens = (this.assinaturaManager?.acessosVitalicios || []).length;

                res.json({
                    catalogo: catStats,
                    fila: queueStats,
                    assinaturasAtivas,
                    pedidosPendentes,
                    totalTokens,
                    uptime: process.uptime(),
                    memory: process.memoryUsage(),
                    database: 'PostgreSQL Ativo',
                    botOnline: true
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 3. Gerenciamento de Fila & Downloads
        this.app.get('/api/admin/queue', auth, async (req, res) => {
            try {
                if (!this.queueManager) return res.json({ activeTask: null, jobs: [] });
                const jobs = await this.queueManager.getAllAdminJobs(150);
                res.json({
                    isProcessing: this.queueManager.isProcessing,
                    activeTask: this.queueManager.activeTask,
                    jobs: jobs
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/add', auth, async (req, res) => {
            try {
                const { title, type, priority, audioPreference, season, episode } = req.body;
                if (!title) return res.status(400).json({ error: 'Título é obrigatório.' });

                const job = this.queueManager.addJob(title, type || 'filme', parseInt(priority || 2, 10), {
                    audioPreference: audioPreference || 'dublado',
                    season: type === 'serie' ? parseInt(season || 1, 10) : null,
                    episode: type === 'serie' ? parseInt(episode || 1, 10) : null,
                    username: 'Admin (Painel Web)'
                });

                res.json({ success: true, job });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.put('/api/admin/queue/:id/priority', auth, async (req, res) => {
            try {
                const { priority } = req.body;
                const result = await this.queueManager.updatePriority(req.params.id, priority);
                res.json({ success: true, result });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/:id/retry', auth, async (req, res) => {
            try {
                const job = await this.queueManager.retryJob(req.params.id);
                res.json({ success: true, job });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/:id/move-top', auth, async (req, res) => {
            try {
                const job = await this.queueManager.moveJobToTop(req.params.id);
                res.json({ success: true, message: `Trabalho "${job?.title || req.params.id}" movido para o topo da fila!`, job });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/:id/move-step', auth, async (req, res) => {
            try {
                const direction = req.body?.direction || 'up';
                const result = await this.queueManager.moveJobStep(req.params.id, direction);
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/reorder', auth, async (req, res) => {
            try {
                const { jobIds } = req.body;
                const result = await this.queueManager.reorderQueue(jobIds);
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.put('/api/admin/queue/:id', auth, async (req, res) => {
            try {
                const job = await this.queueManager.editJob(req.params.id, req.body);
                res.json({ success: true, message: `Trabalho "${job?.title || req.params.id}" atualizado com sucesso!`, job });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/queue/:id', auth, async (req, res) => {
            try {
                const result = await this.queueManager.deleteJob(req.params.id, true);
                res.json({ success: true, message: 'Trabalho excluído com sucesso!', result });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/:id/cancel', auth, async (req, res) => {
            try {
                const result = await this.queueManager.cancelJob(req.params.id);
                res.json({ success: true, message: 'Trabalho cancelado com sucesso!', result });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/queue/clear-failed', auth, async (req, res) => {
            try {
                const result = await this.queueManager.clearFailed();
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ── LOGS EM TEMPO REAL (SSE) ──────────────────────────────────────────────
        //
        // GET /api/admin/logs/stream   → Server-Sent Events (streaming contínuo)
        //   Autenticação: Bearer token no header Authorization OU ?token= na query
        //   (SSE não suporta headers customizados em alguns browsers / EventSource)
        //
        // GET /api/admin/logs/history  → Snapshot do buffer atual em JSON
        // ─────────────────────────────────────────────────────────────────────────

        this.app.get('/api/admin/logs/stream', (req, res) => {
            // Valida token – aceita Authorization: Bearer <token> OU ?token=<jwt>
            // (EventSource da W3C não suporta headers customizados, por isso aceitamos query param)
            const rawToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim() ||
                             String(req.query.token || '').trim();
            if (!rawToken) return res.status(401).json({ error: 'Token obrigatório.' });

            // verifyToken retorna null em caso de token inválido/expirado (não lança exceção)
            const decoded = authService.verifyToken(rawToken);
            if (!decoded) return res.status(401).json({ error: 'Token inválido ou expirado.' });

            // Cabeçalhos SSE
            res.setHeader('Content-Type',  'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection',    'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // necessário no Nginx/proxy reverso
            res.flushHeaders();

            const clientId = `sse_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            logBroadcaster.addClient(clientId, res);

            // Remove cliente ao desconectar (normal ou abrupto)
            req.on('close',   () => logBroadcaster.removeClient(clientId));
            req.on('aborted', () => logBroadcaster.removeClient(clientId));
        });

        this.app.get('/api/admin/logs/history', auth, (req, res) => {
            const limit = Math.min(parseInt(req.query.limit || 300, 10), 300);
            res.json({ logs: logBroadcaster.getHistory(limit) });
        });

        // 3.1 Gerenciamento do Agendador de Horários (Scheduler)
        this.app.get('/api/admin/scheduler', auth, (req, res) => {
            try {
                res.json(schedulerService.getStatus());
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/config', auth, (req, res) => {
            try {
                schedulerService.updateConfig(req.body);
                res.json({ success: true, message: 'Grade padrão do agendador atualizada com sucesso!', scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/override', auth, (req, res) => {
            try {
                const { data, config } = req.body;
                if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
                    return res.status(400).json({ error: 'Data deve estar no formato YYYY-MM-DD.' });
                }
                schedulerService.setOverride(data, config);
                res.json({ success: true, message: `Programação especial salva para ${data}!`, scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/scheduler/override/:data', auth, (req, res) => {
            try {
                const ruleId = req.query.ruleId || null;
                schedulerService.removeOverride(req.params.data, ruleId);
                res.json({ success: true, message: `Programação especial de ${req.params.data} removida!`, scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/force-start', auth, (req, res) => {
            try {
                const targetMode = req.body?.mode || 'performance';
                const durationHours = parseInt(req.body?.durationHours || 4, 10);
                schedulerService.forceStart(req.body?.reason || 'Acionado via Painel Admin', targetMode, durationHours);
                res.json({ 
                    success: true, 
                    message: targetMode === 'eco' 
                        ? 'Modo Econômico ativado (sem interferir na rede da casa)!' 
                        : 'Modo Desempenho Máximo ativado!', 
                    scheduler: schedulerService.getStatus() 
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/force-eco', auth, (req, res) => {
            try {
                const durationHours = parseInt(req.body?.durationHours || 4, 10);
                schedulerService.forceStart(req.body?.reason || 'Modo Econômico ativado via Painel Admin', 'eco', durationHours);
                res.json({ success: true, message: 'Modo Econômico ativado (downloads controlados sem travar a rede)!', scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/force-stop', auth, (req, res) => {
            try {
                schedulerService.forceStop(req.body?.reason || 'Pausado via Painel Admin');
                res.json({ success: true, message: 'Processamento pausado imediatamente!', scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/scheduler/clear-force', auth, (req, res) => {
            try {
                schedulerService.clearForce();
                res.json({ success: true, message: 'Controle manual removido! Bot voltou à programação automática da grade.', scheduler: schedulerService.getStatus() });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 3.1.1 Configurações Gerais do Sistema (config.js via Web UI)
        const SettingsService = require('./SettingsService');
        this.app.get('/api/admin/settings', auth, (req, res) => {
            try {
                res.json({
                    success: true,
                    settings: SettingsService.getEditableSettings()
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/settings', auth, (req, res) => {
            try {
                const updated = SettingsService.saveSettings(req.body);
                // Se a esteira estiver ativa, notifica QueueManager sobre novos limites
                if (this.queueManager) {
                    this.queueManager.maxConcurrentJobs = config.MAX_CONCURRENT_JOBS || 10;
                    this.queueManager.maxConcurrentDownloads = config.MAX_CONCURRENT_DOWNLOADS || 3;
                    this.queueManager.maxConcurrentUploads = config.MAX_CONCURRENT_UPLOADS || 2;
                }
                res.json({
                    success: true,
                    message: 'Configurações do sistema aplicadas e salvas com sucesso!',
                    settings: updated
                });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });


        // 3.2 Gerenciamento Dinâmico de Prioridades da Fila (VIP, Séries, Grátis, Animes, Auto-Feeder)
        this.app.get('/api/admin/priorities', auth, (req, res) => {
            try {
                res.json({
                    priorities: PriorityService.get(),
                    items: PriorityService.getForUI()
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/priorities', auth, async (req, res) => {
            try {
                const updated = await PriorityService.save(req.body);
                // Se o QueueManager estiver instanciado, reordena a fila em memória com as novas prioridades
                if (this.queueManager && typeof this.queueManager.reorderQueue === 'function') {
                    this.queueManager.reorderQueue();
                }
                res.json({
                    success: true,
                    message: 'Pesos e prioridades da esteira salvos com sucesso!',
                    priorities: updated,
                    items: PriorityService.getForUI()
                });
            } catch (e) {
                res.status(400).json({ error: e.message });
            }
        });

        // 4. Gerenciamento de Assinaturas & Tokens VIP
        this.app.get('/api/admin/assinaturas', auth, (req, res) => {
            try {
                res.json({
                    assinaturas: this.assinaturaManager?.assinaturas || [],
                    tokensVitalicios: this.assinaturaManager?.acessosVitalicios || []
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/assinaturas/grant', auth, async (req, res) => {
            try {
                const { userId, username, plano, dias } = req.body;
                if (!userId && !username) return res.status(400).json({ error: 'UserId ou Username é obrigatório.' });

                const targetUserId = userId ? parseInt(userId, 10) : 0;
                const cleanUser = (username || '').replace(/^@/, '');

                if (plano === 'vitalicio') {
                    const ass = await this.assinaturaManager.concederAcessoVitalicio(cleanUser || targetUserId);
                    return res.json({ success: true, assinatura: ass });
                }

                const dataInicio = new Date();
                const dataFim = new Date(Date.now() + (parseInt(dias || 30, 10) * 24 * 3600 * 1000));

                await db.query(`
                    INSERT INTO assinaturas (user_id, username, plano, data_inicio, data_fim, status)
                    VALUES ($1, $2, $3, $4, $5, 'ativa')
                    ON CONFLICT (user_id) DO UPDATE SET
                        plano = $3,
                        data_fim = $5,
                        status = 'ativa'
                `, [targetUserId, cleanUser || 'VIP', plano || 'mensal', dataInicio, dataFim]);

                await this.assinaturaManager.loadAssinaturas();
                res.json({ success: true, message: `Assinatura de ${cleanUser || targetUserId} ativada até ${dataFim.toLocaleDateString('pt-BR')}!` });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/assinaturas/revoke', auth, async (req, res) => {
            try {
                const { identifier } = req.body;
                if (!identifier) return res.status(400).json({ error: 'Identificador obrigatório.' });

                await this.assinaturaManager.revogarAcessoVitalicio(identifier);
                await db.query(`UPDATE assinaturas SET status = 'cancelada' WHERE user_id = $1 OR username = $2`, [
                    parseInt(identifier, 10) || 0,
                    String(identifier).replace(/^@/, '')
                ]);
                await this.assinaturaManager.loadAssinaturas();
                res.json({ success: true, message: 'Acesso revogado com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/stremio-tokens', auth, async (req, res) => {
            try {
                const resTokens = await db.query(`SELECT * FROM stremio_tokens ORDER BY created_at DESC`);
                res.json({ success: true, tokens: resTokens.rows });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/stremio-tokens/generate', auth, async (req, res) => {
            try {
                const { username } = req.body;
                const token = `bf_${require('crypto').randomBytes(12).toString('hex')}`;
                const name = (username || 'VIP').replace(/^@/, '');

                await db.query(`
                    INSERT INTO stremio_tokens (token, username, tipo, ativo)
                    VALUES ($1, $2, 'vitalicio', true)
                `, [token, name]);

                await this.assinaturaManager.loadAssinaturas();
                res.json({ success: true, token, username: name });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/stremio-tokens/:token', auth, async (req, res) => {
            try {
                const token = req.params.token;
                await db.query(`DELETE FROM stremio_tokens WHERE token = $1`, [token]);
                await this.assinaturaManager.loadAssinaturas();
                res.json({ success: true, message: `Token ${token} revogado e excluído com sucesso!` });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.put('/api/admin/stremio-tokens/:token/toggle', auth, async (req, res) => {
            try {
                const token = req.params.token;
                const resTok = await db.query(`UPDATE stremio_tokens SET ativo = NOT ativo WHERE token = $1 RETURNING *`, [token]);
                await this.assinaturaManager.loadAssinaturas();
                res.json({ success: true, token: resTok.rows[0] });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 5. Gerenciamento de Pedidos de Clientes
        this.app.get('/api/admin/pedidos', auth, (req, res) => {
            try {
                res.json({
                    pedidos: this.pedidosManager ? this.pedidosManager.getPedidos() : []
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/pedidos/:id/status', auth, async (req, res) => {
            try {
                const { status } = req.body;
                await this.pedidosManager?.atualizarStatus(req.params.id, status || 'adicionado');
                res.json({ success: true, message: `Status do pedido atualizado para "${status}".` });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/pedidos/:id/enfileirar', auth, async (req, res) => {
            try {
                const pedido = this.pedidosManager?.getPedidoPorId(req.params.id);
                if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado.' });

                const priority = req.body.priority || (pedido.isAssinante ? 1 : 2);
                const isAnime = pedido.tipo === 'anime';
                const isDorama = pedido.tipo === 'dorama';
                const isSerie = pedido.tipo === 'serie' || isAnime || isDorama;

                this.queueManager.addJob(pedido.nome, isSerie ? 'serie' : (pedido.tipo || 'filme'), parseInt(priority, 10), {
                    userId: pedido.userId,
                    username: pedido.username,
                    pedidoId: pedido.id,
                    isPedido: true,
                    tmdbId: pedido.tmdbId,
                    season: isSerie ? 1 : null,
                    episode: isSerie ? 1 : null,
                    isAnime,
                    isDorama,
                    audioPreference: (pedido.idioma && pedido.idioma.toLowerCase().includes('legendado') && !pedido.idioma.toLowerCase().includes('dublado')) ? 'legendado' : 'dublado'
                });

                await this.pedidosManager.atualizarStatus(pedido.id, 'em_processamento');
                res.json({ success: true, message: `Pedido "${pedido.nome}" enviado para a fila!` });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/pedidos/:id', auth, async (req, res) => {
            try {
                await this.pedidosManager?.removerPedido(req.params.id);
                res.json({ success: true, message: 'Pedido removido com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 5.1. Gerenciamento de Tickets de Suporte & Ajuda
        this.app.get('/api/admin/tickets', auth, async (req, res) => {
            try {
                const queryRes = await db.query(`
                    SELECT id, user_id, username, tipo, titulo, mensagem, imagem_url, contato, status, resposta, created_at 
                    FROM feedbacks 
                    ORDER BY created_at DESC 
                    LIMIT 200
                `);
                res.json({ success: true, tickets: queryRes.rows || [] });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/tickets/:id/responder', auth, async (req, res) => {
            try {
                const { status, resposta } = req.body;
                await db.query(`
                    UPDATE feedbacks 
                    SET status = COALESCE($1, status), resposta = COALESCE($2, resposta), updated_at = NOW() 
                    WHERE id = $3
                `, [status || 'resolvido', resposta || null, req.params.id]);
                res.json({ success: true, message: 'Ticket atualizado com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/tickets/:id', auth, async (req, res) => {
            try {
                await db.query(`DELETE FROM feedbacks WHERE id = $1`, [req.params.id]);
                res.json({ success: true, message: 'Ticket excluído com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ═══════════════════════════════════════════════════════════════════════
        // 🛡️ ROTAS DA AUDITORIA DE CLIENTES (ADMIN AUDITORIA)
        // ═══════════════════════════════════════════════════════════════════════
        this.app.get('/api/admin/audit/dashboard', auth, async (req, res) => {
            try {
                const range = req.query.range || 'today';
                const metrics = await auditService.getDashboardMetrics(range, req.query.startDate, req.query.endDate);
                res.json(metrics);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/audit/people', auth, async (req, res) => {
            try {
                const result = await auditService.getPersonList(req.query, { page: req.query.page, limit: req.query.limit });
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/audit/person/:id', auth, async (req, res) => {
            try {
                const profile = await auditService.getPersonProfile(req.params.id, req.query.type);
                res.json(profile);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/audit/person/:id/timeline', auth, async (req, res) => {
            try {
                const timeline = await auditService.getPersonTimeline(req.params.id, req.query.type, req.query, { page: req.query.page, limit: req.query.limit });
                res.json(timeline);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/audit/content', auth, async (req, res) => {
            try {
                const analytics = await auditService.getContentAnalytics(req.query.range, req.query.startDate, req.query.endDate);
                res.json(analytics);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ═══════════════════════════════════════════════════════════════════════
        // 📥 ENDPOINTS DE INGESTÃO DE EVENTOS E HEARTBEAT CLIENT-SIDE
        // ═══════════════════════════════════════════════════════════════════════
        this.app.post('/api/audit/event', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const user = req.user;
                const visitorId = req.headers['x-visitor-id'] || req.body.visitorId || null;
                const sessionId = req.headers['x-session-id'] || req.body.sessionId || null;
                const rawTg = req.body.telegramId || req.headers['x-telegram-id'] || req.headers['x-user-token'];
                const telegramId = user?.telegram_id || (/^\d+$/.test(String(rawTg || '')) ? Number(rawTg) : null);

                await auditService.logEvent({
                    identityType: user?.id ? 'registered' : (telegramId ? 'telegram' : 'anonymous'),
                    userId: user?.id || null,
                    telegramId,
                    visitorId,
                    eventType: req.body.eventType || req.body.event_type || 'PAGE_VIEW',
                    source: req.body.source || 'website',
                    sessionId,
                    mediaId: req.body.mediaId,
                    seriesId: req.body.seriesId,
                    seasonNum: req.body.seasonNum,
                    episodeNum: req.body.episodeNum,
                    title: req.body.title,
                    metadata: req.body.metadata || {},
                    status: req.body.status || 'success',
                    error: req.body.error
                });

                res.json({ success: true });
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        this.app.post('/api/audit/heartbeat', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const user = req.user;
                const visitorId = req.headers['x-visitor-id'] || req.body.visitorId || null;
                const sessionId = req.headers['x-session-id'] || req.body.sessionId || null;
                const rawTg = req.body.telegramId || req.headers['x-telegram-id'] || req.headers['x-user-token'];
                const telegramId = user?.telegram_id || (/^\d+$/.test(String(rawTg || '')) ? Number(rawTg) : null);

                const result = await auditService.recordPlaybackProgress({
                    sessionId,
                    identityType: user?.id ? 'registered' : (telegramId ? 'telegram' : 'anonymous'),
                    userId: user?.id || null,
                    telegramId,
                    visitorId,
                    mediaId: req.body.mediaId,
                    mediaType: req.body.mediaType || 'filme',
                    title: req.body.title,
                    seasonNum: req.body.seasonNum,
                    episodeNum: req.body.episodeNum,
                    currentPosition: req.body.currentPosition || req.body.currentTime,
                    duration: req.body.duration,
                    completed: req.body.completed,
                    platform: req.body.platform || 'website',
                    device: req.body.device || req.headers['user-agent']
                });

                res.json(result);
            } catch (e) {
                res.json({ success: false, error: e.message });
            }
        });

        // 6. Gerenciamento do Catálogo
        this.app.get('/api/admin/catalogo', auth, async (req, res) => {
            try {
                if (this.catalogoManager && typeof this.catalogoManager.getCatalogoDetalhado === 'function') {
                    const data = await this.catalogoManager.getCatalogoDetalhado();
                    return res.json(data);
                }
                res.json(this.catalogoManager?.catalogo || { filmes: [], series: [] });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Edição de episódios
        this.app.post('/api/admin/catalogo/episodio/update', auth, async (req, res) => {
            try {
                const { id, nome, temporada, numero, isDublado, isLegendado, messageId, fileId, audio, qualidade } = req.body;
                if (!id) return res.status(400).json({ error: 'ID do episódio não informado.' });

                await db.query(`
                    UPDATE episodios SET
                        nome = COALESCE($1, nome),
                        temporada_numero = COALESCE($2, temporada_numero),
                        numero = COALESCE($3, numero),
                        is_dublado = COALESCE($4, is_dublado),
                        is_legendado = COALESCE($5, is_legendado),
                        message_id = COALESCE($6, message_id),
                        file_id = COALESCE($7, file_id),
                        audio = COALESCE($8, audio),
                        qualidade = COALESCE($9, qualidade)
                    WHERE id = $10
                `, [nome, temporada, numero, isDublado, isLegendado, messageId, fileId, audio, qualidade, id]);

                if (this.catalogoManager) await this.catalogoManager.loadCatalogo();
                res.json({ success: true, message: 'Episódio atualizado com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Edição de séries
        // Edição de séries
        this.app.post('/api/admin/catalogo/serie/update', auth, async (req, res) => {
            try {
                const { id, nome, tmdbId, imdbId, totalTemporadas, totalEpisodios, posterUrl, exigirTemporadaCompleta } = req.body;
                if (!id) return res.status(400).json({ error: 'ID da série não informado.' });

                await db.query(`
                    UPDATE series SET
                        nome = COALESCE($1, nome),
                        tmdb_id = COALESCE($2, tmdb_id),
                        imdb_id = COALESCE($3, imdb_id),
                        total_temporadas = COALESCE($4, total_temporadas),
                        total_episodios = COALESCE($5, total_episodios),
                        poster_url = COALESCE($6, poster_url),
                        exigir_temporada_completa = COALESCE($7, exigir_temporada_completa),
                        updated_at = NOW()
                    WHERE id = $8
                `, [nome, tmdbId, imdbId, totalTemporadas, totalEpisodios, posterUrl, exigirTemporadaCompleta, id]);

                if (this.catalogoManager) await this.catalogoManager.loadCatalogo();
                res.json({ success: true, message: 'Série atualizada com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Alternar regra de exigir temporada completa por idioma (ocultar incompletas no site)
        this.app.post('/api/admin/catalogo/serie/toggle-regra-temporada', auth, async (req, res) => {
            try {
                const { id, exigirTemporadaCompleta } = req.body;
                if (!id) return res.status(400).json({ error: 'ID da série não informado.' });

                const novoEstado = exigirTemporadaCompleta !== false;
                await db.query(`
                    UPDATE series SET
                        exigir_temporada_completa = $1,
                        updated_at = NOW()
                    WHERE id = $2
                `, [novoEstado, id]);

                if (this.catalogoManager) await this.catalogoManager.loadCatalogo();
                res.json({ 
                    success: true, 
                    message: `Regra de temporadas completas ${novoEstado ? 'ativada' : 'desativada'} com sucesso!`,
                    exigirTemporadaCompleta: novoEstado 
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Edição de filmes
        this.app.post('/api/admin/catalogo/filme/update', auth, async (req, res) => {
            try {
                const { id, nome, tmdbId, imdbId, isDublado, isLegendado, messageId, fileId, posterUrl } = req.body;
                if (!id) return res.status(400).json({ error: 'ID do filme não informado.' });

                await db.query(`
                    UPDATE filmes SET
                        nome = COALESCE($1, nome),
                        tmdb_id = COALESCE($2, tmdb_id),
                        imdb_id = COALESCE($3, imdb_id),
                        is_dublado = COALESCE($4, is_dublado),
                        is_legendado = COALESCE($5, is_legendado),
                        message_id = COALESCE($6, message_id),
                        file_id = COALESCE($7, file_id),
                        poster_url = COALESCE($8, poster_url),
                        updated_at = NOW()
                    WHERE id = $9
                `, [nome, tmdbId, imdbId, isDublado, isLegendado, messageId, fileId, posterUrl, id]);

                if (this.catalogoManager) await this.catalogoManager.loadCatalogo();
                res.json({ success: true, message: 'Filme atualizado com sucesso.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/filme/:id', auth, async (req, res) => {
            try {
                const filmeId = Number(req.params.id) || 0;
                const versao = (req.query.versao || req.body?.versao || '').toLowerCase().trim();
                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;

                // Garante que o RemovalQueueManager tem os managers atualizados
                this.removalQueue.setCatalogoManager(this.catalogoManager);
                this.removalQueue.setQueueManager(this.queueManager);

                const result = await this.removalQueue.removerFilme({ filmeId, versao: versao || null, rebaixar });

                if (!result.success) {
                    return res.status(404).json({ error: result.error || 'Filme não encontrado.' });
                }

                res.json({ success: true, message: result.message });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/serie/:id', auth, async (req, res) => {
            try {
                const serieId = req.params.id;
                const versao = (req.query.versao || req.body?.versao || '').toLowerCase().trim();
                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;

                // Garante que o RemovalQueueManager tem os managers atualizados
                this.removalQueue.setCatalogoManager(this.catalogoManager);
                this.removalQueue.setQueueManager(this.queueManager);

                const result = await this.removalQueue.removerSerie({ serieId, versao: versao || null, rebaixar });

                if (!result.success) {
                    return res.status(404).json({ error: result.error || 'Série não encontrada.' });
                }

                res.json({ success: true, message: result.message, details: {
                    totalEpisodios: result.totalEpisodios,
                    totalReenfileirados: result.totalReenfileirados,
                    totalMensagensAgendadas: result.totalMensagensAgendadas
                }});
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/episodio/:id', auth, async (req, res) => {
            try {
                const episodioId = Number(req.params.id) || 0;
                const versao = (req.query.versao || req.body?.versao || '').toLowerCase().trim();
                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;

                // Garante que o RemovalQueueManager tem os managers atualizados
                this.removalQueue.setCatalogoManager(this.catalogoManager);
                this.removalQueue.setQueueManager(this.queueManager);

                const result = await this.removalQueue.removerEpisodio({ episodioId, versao: versao || null, rebaixar });

                if (!result.success) {
                    return res.status(404).json({ error: result.error || 'Episódio não encontrado.' });
                }

                res.json({ success: true, message: result.message });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Endpoint para monitorar a fila de remoção (painel admin)
        this.app.get('/api/admin/remocoes/stats', auth, async (req, res) => {
            try {
                const stats = await this.removalQueue.getStats();
                res.json({ success: true, ...stats });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // Endpoint para forçar reprocessamento de tarefas com falha
        this.app.post('/api/admin/remocoes/retry-failures', auth, async (req, res) => {
            try {
                const updated = await db.query(`
                    UPDATE remocoes_fila 
                    SET status = 'pendente', tentativas = 0, updated_at = NOW() 
                    WHERE status = 'falha'
                    RETURNING id
                `);
                this.removalQueue.triggerWorker();
                res.json({ success: true, message: `${updated.rows.length} tarefa(s) de remoção com falha reenfileiradas.` });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/admin/catalogo/resync', auth, async (req, res) => {
            try {
                await this.catalogoManager?.loadCatalogo();
                res.json({ success: true, stats: this.catalogoManager?.getEstatisticas() });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 7. TMDB Live Search & Detalhes
        this.app.get('/api/admin/tmdb/search', auth, async (req, res) => {
            try {
                const query = req.query.query || req.query.q;
                const tipo = req.query.tipo || 'multi';
                if (!query || !query.trim()) return res.json({ success: true, results: [] });

                let results = [];
                if (tipo === 'filme') {
                    results = await TMDBService.searchMovie(query.trim());
                } else if (tipo === 'serie') {
                    results = await TMDBService.searchTV(query.trim());
                } else {
                    results = await TMDBService.searchMulti(query.trim());
                }
                res.json({ success: true, results });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/tmdb/details/:id', auth, async (req, res) => {
            try {
                const tmdbId = parseInt(req.params.id, 10);
                const tipo = req.query.tipo || 'filme';
                let details = null;
                if (tipo === 'serie') {
                    details = await TMDBService.getTVDetails(tmdbId);
                } else {
                    details = await TMDBService.getMovieDetails(tmdbId);
                }
                res.json({ success: true, details });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/admin/tmdb/season/:tmdbId/:seasonNumber', auth, async (req, res) => {
            try {
                const tmdbId = parseInt(req.params.tmdbId, 10);
                const sNum = parseInt(req.params.seasonNumber, 10);
                const seasonData = await TMDBService.getSeasonDetails(tmdbId, sNum);
                res.json({ success: true, season: seasonData });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 📺 Consulta Pública de Metadados de Temporada / Episódios TMDB (Para enriquecer títulos e previews)
        this.app.get('/api/tmdb/season/:tmdbId/:seasonNumber', async (req, res) => {
            try {
                const tmdbId = parseInt(req.params.tmdbId, 10);
                const sNum = parseInt(req.params.seasonNumber, 10);
                if (!tmdbId || isNaN(tmdbId)) return res.status(400).json({ error: 'TMDB ID inválido' });
                const seasonData = await TMDBService.getSeasonDetails(tmdbId, sNum);
                res.json({ success: true, season: seasonData });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 📱 Descoberta e Catálogo de Microdramas Chineses / Short Dramas Verticais (短剧 / Duanju)
        const microdramaService = require('./MicrodramaService');
        this.app.get('/api/microdramas/trending', async (req, res) => {
            try {
                const limit = parseInt(req.query.limit || 20, 10);
                const results = await microdramaService.getTrendingMicrodramas(limit);
                res.json({ success: true, count: results.length, results });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/microdramas/search', async (req, res) => {
            try {
                const query = req.query.query || req.query.q || '';
                const results = await microdramaService.searchMicrodramas(query);
                res.json({ success: true, query, results });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 🔍 TMDB Search Unificado para Pedidos de Usuários
        this.app.get('/api/tmdb/search-all', async (req, res) => {
            try {
                const query = (req.query.query || req.query.q || '').trim();
                if (!query || query.length < 2) {
                    return res.json({ success: true, results: [] });
                }
                const results = await this.tmdbService.searchMulti(query);
                res.json({
                    success: true,
                    results: (results || []).slice(0, 12).map(r => ({
                        tmdbId: r.tmdbId,
                        nome: r.nome,
                        nomeOriginal: r.nomeOriginal,
                        tipo: r.tipo || 'filme',
                        ano: r.ano || '',
                        poster: r.posterUrl || r.poster || '',
                        nota: r.nota || 0,
                        sinopse: r.sinopse || ''
                    }))
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 🍿 1. Criação de Pedido de Conteúdo (Filme / Série / Anime / Dorama)
        this.app.post('/api/user/pedidos/create', async (req, res) => {
            try {
                const { nome, tipo, temporada, idioma, tmdb_id, poster_url, ano, detalhes } = req.body;
                if (!nome || !nome.trim()) {
                    return res.status(400).json({ error: 'Nome da obra é obrigatório.' });
                }

                let userId = 0;
                let username = 'Visitante';
                let isAssinante = false;

                const authHeader = req.headers['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.split(' ')[1];
                    const decoded = authService.verifyToken(token);
                    if (decoded) {
                        userId = Number(decoded.id || decoded.telegram_id || 0);
                        username = decoded.username || decoded.email || 'Usuário';
                        isAssinante = decoded.role === 'admin' || !!decoded.is_assinante;
                    }
                }

                const resolvedTipo = (tipo || 'filme').toLowerCase();
                const resolvedTemporada = (temporada || '').trim() || (resolvedTipo !== 'filme' ? 'todas as temporadas' : '');
                const resolvedIdioma = (idioma || '').trim() || 'Dual Áudio (Dublado + Legendado)';

                const pedido = await this.pedidosManager?.adicionarPedidoCompleto({
                    userId,
                    username,
                    nome: nome.trim(),
                    tipo: resolvedTipo,
                    temporada: resolvedTemporada,
                    idioma: resolvedIdioma,
                    tmdbId: tmdb_id || null,
                    posterUrl: poster_url || '',
                    ano: ano || '',
                    detalhes: (detalhes || '').trim(),
                    isAssinante
                });

                auditService.logEvent({
                    identityType: userId ? 'registered' : 'anonymous',
                    userId: userId || null,
                    eventType: 'REQUEST_CREATED',
                    source: 'website',
                    title: nome.trim(),
                    metadata: { tipo: tipo || 'filme', ano, idioma, detalhes }
                }).catch(() => {});

                res.json({
                    success: true,
                    message: `Pedido de "${nome.trim()}" registrado com sucesso!`,
                    pedido
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 💬 2. Criação de Ticket de Ajuda & Suporte
        this.app.post('/api/user/tickets/create', async (req, res) => {
            try {
                const { titulo, mensagem, imagem_url, contato } = req.body;
                if (!titulo || !titulo.trim()) {
                    return res.status(400).json({ error: 'Título / Assunto é obrigatório.' });
                }
                if (!mensagem || !mensagem.trim()) {
                    return res.status(400).json({ error: 'Descrição detalhada é obrigatória.' });
                }

                let userId = null;
                let username = 'Visitante';
                const authHeader = req.headers['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.split(' ')[1];
                    const decoded = authService.verifyToken(token);
                    if (decoded) {
                        userId = String(decoded.id || decoded.telegram_id || '');
                        username = decoded.username || decoded.email || 'Usuário';
                    }
                }

                const result = await db.query(`
                    INSERT INTO feedbacks (user_id, username, tipo, titulo, mensagem, imagem_url, contato, status, created_at)
                    VALUES ($1, $2, 'suporte', $3, $4, $5, $6, 'aberto', NOW())
                    RETURNING id, created_at
                `, [userId, username, titulo.trim(), mensagem.trim(), (imagem_url || '').trim(), (contato || '').trim()]);

                res.json({
                    success: true,
                    message: 'Ticket de suporte enviado com sucesso! Nossa equipe responderá em breve.',
                    ticketId: result.rows?.[0]?.id
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 📷 3. Upload de Imagem / Print para Ticket de Suporte (em memória)
        const uploadTicketImage = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 6 * 1024 * 1024 }
        });

        this.app.post('/api/user/ticket-image-upload', uploadTicketImage.single('image'), (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
                const mime = req.file.mimetype || 'image/jpeg';
                const base64 = req.file.buffer.toString('base64');
                const dataUrl = `data:${mime};base64,${base64}`;
                res.json({ success: true, url: dataUrl });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 💬 Canal Legado de Feedback (Compatibilidade)
        this.app.post('/api/user/feedback', async (req, res) => {
            try {
                const { tipo, titulo, mensagem, contato } = req.body;
                if (!mensagem || !mensagem.trim()) {
                    return res.status(400).json({ error: 'Mensagem é obrigatória' });
                }

                let userId = null;
                let username = 'Visitante';
                const authHeader = req.headers['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    const token = authHeader.split(' ')[1];
                    const decoded = authService.verifyToken(token);
                    if (decoded) {
                        userId = String(decoded.id || decoded.telegram_id || '');
                        username = decoded.username || decoded.email || 'Usuário';
                    }
                }

                await db.query(`
                    INSERT INTO feedbacks (user_id, username, tipo, titulo, mensagem, contato, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, NOW())
                `, [userId, username, tipo || 'sugestao', (titulo || '').trim(), mensagem.trim(), (contato || '').trim()]);

                res.json({ success: true, message: 'Seu pedido/sugestão foi recebido com sucesso! Nossa equipe analisará em breve.' });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ═══════════════════════════════════════════════════════════════════════
        // 👥 ASSISTIR JUNTO (WATCH PARTY) v2.0 — SSE PERSISTENTE
        // ═══════════════════════════════════════════════════════════════════════

        if (!this.watchPartyRooms) this.watchPartyRooms = new Map();

        const DEFAULT_ROOM_PERMISSIONS = {
            canPause: true,
            canResume: false,
            canSeek: false,
            canChangeMedia: false,
            canChangeSpeed: false
        };

        // Helper: broadcast para todos os membros conectados da sala
        const broadcastToRoom = (room, data) => {
            const payload = `data: ${JSON.stringify(data)}\n\n`;
            for (const m of room.members.values()) {
                try { if (m.res && !m.res.writableEnded) m.res.write(payload); } catch(e) {}
            }
        };

        // Helper: lista de membros serializável
        const serializeMembers = (room) =>
            Array.from(room.members.values()).map(m => ({
                id: m.id,
                name: m.name,
                isHost: String(m.id) === String(room.hostId) || !!m.isHost,
                inPlayer: !!m.inPlayer,
                isReady: !!m.isReady,
                isLoading: !!m.isLoading,
                connectionState: m.res && !m.res.writableEnded ? 'connected' : 'disconnected',
                audio: m.audio || null
            }));

        const serializeRoom = (room) => {
            const now = Date.now();
            const computedTime = room.isPlaying
                ? Number(room.currentTime || 0) + (now - Number(room.lastStateChange || now)) / 1000
                : Number(room.currentTime || 0);

            return {
                id: room.id,
                hostId: room.hostId,
                hostName: room.hostName,
                mediaInfo: room.mediaInfo,
                currentTime: Math.max(0, computedTime),
                isPlaying: !!room.isPlaying,
                hostOnlyControls: room.hostOnlyControls !== false,
                permissions: room.permissions || { ...DEFAULT_ROOM_PERMISSIONS },
                lastStateChange: room.lastStateChange || now,
                serverTime: now,
                members: serializeMembers(room),
                wheelItems: room.wheelItems || []
            };
        };

        // Persistência em PostgreSQL para salas de Watch Party
        const saveRoomToDb = async (room) => {
            if (!room || !room.id) return;
            try {
                const membersArr = Array.from(room.members.values()).map(m => ({
                    id: m.id,
                    name: m.name,
                    isHost: m.isHost,
                    inPlayer: m.inPlayer,
                    isReady: m.isReady,
                    isLoading: m.isLoading,
                    audio: m.audio
                }));
                await db.query(
                    `INSERT INTO watch_party_rooms (id, host_id, host_name, host_token, media_info, playback_time, is_playing, host_only_controls, permissions, last_state_change, last_activity, wheel_items, members_data, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                     ON CONFLICT (id) DO UPDATE SET
                         host_id = EXCLUDED.host_id,
                         host_name = EXCLUDED.host_name,
                         host_token = EXCLUDED.host_token,
                         media_info = EXCLUDED.media_info,
                         playback_time = EXCLUDED.playback_time,
                         is_playing = EXCLUDED.is_playing,
                         host_only_controls = EXCLUDED.host_only_controls,
                         permissions = EXCLUDED.permissions,
                         last_state_change = EXCLUDED.last_state_change,
                         last_activity = EXCLUDED.last_activity,
                         wheel_items = EXCLUDED.wheel_items,
                         members_data = EXCLUDED.members_data`,
                    [
                        room.id,
                        room.hostId || null,
                        room.hostName || 'Anfitrião',
                        room.hostToken || null,
                        JSON.stringify(room.mediaInfo || {}),
                        room.currentTime || 0,
                        !!room.isPlaying,
                        room.hostOnlyControls !== false,
                        JSON.stringify(room.permissions || DEFAULT_ROOM_PERMISSIONS),
                        Number(room.lastStateChange) || Date.now(),
                        room.lastActivity || Date.now(),
                        JSON.stringify(room.wheelItems || []),
                        JSON.stringify(membersArr),
                        room.createdAt || Date.now()
                    ]
                );
            } catch (e) {
                // Silencioso
            }
        };

        const deleteRoomFromDb = async (roomId) => {
            if (!roomId) return;
            try {
                await db.query(`DELETE FROM watch_party_rooms WHERE id = $1`, [roomId]);
            } catch (e) {}
        };

        // Timeout de inatividade: fecha sala se inativa por 1 hora
        const scheduleInactivityCheck = (roomCode) => {
            const INACTIVITY_MS = 60 * 60 * 1000; // 1 hora
            setTimeout(async () => {
                const r = this.watchPartyRooms && this.watchPartyRooms.get(roomCode);
                if (!r) return;
                const inactiveFor = Date.now() - r.lastActivity;
                if (inactiveFor >= INACTIVITY_MS) {
                    broadcastToRoom(r, { type: 'room_closed', reason: 'Sala encerrada por inatividade (1 hora).' });
                    this.watchPartyRooms.delete(roomCode);
                    await deleteRoomFromDb(roomCode);
                } else {
                    scheduleInactivityCheck(roomCode); // re-agenda
                }
            }, INACTIVITY_MS);
        };

        // Carrega salas ativas do banco no startup (última hora)
        const loadRoomsFromDb = async () => {
            try {
                const oneHourAgo = Date.now() - (60 * 60 * 1000);
                await db.query(`DELETE FROM watch_party_rooms WHERE last_activity < $1`, [oneHourAgo]);

                const res = await db.query(`SELECT * FROM watch_party_rooms WHERE last_activity >= $1`, [oneHourAgo]);
                for (const row of res.rows) {
                    let mediaInfo = row.media_info;
                    if (typeof mediaInfo === 'string') {
                        try { mediaInfo = JSON.parse(mediaInfo); } catch(e) { mediaInfo = null; }
                    }
                    let wheelItems = row.wheel_items;
                    if (typeof wheelItems === 'string') {
                        try { wheelItems = JSON.parse(wheelItems); } catch(e) { wheelItems = []; }
                    }
                    let permissions = row.permissions;
                    if (typeof permissions === 'string') {
                        try { permissions = JSON.parse(permissions); } catch(e) { permissions = null; }
                    }

                    const room = {
                        id: row.id,
                        hostId: row.host_id,
                        hostName: row.host_name,
                        hostToken: row.host_token,
                        mediaInfo: mediaInfo || null,
                        currentTime: Number(row.playback_time) || 0,
                        isPlaying: !!row.is_playing,
                        hostOnlyControls: row.host_only_controls !== false,
                        permissions: { ...DEFAULT_ROOM_PERMISSIONS, ...(permissions || {}) },
                        lastStateChange: Number(row.last_state_change) || Number(row.last_activity) || Date.now(),
                        lastActivity: Number(row.last_activity) || Date.now(),
                        members: new Map(),
                        wheelItems: Array.isArray(wheelItems) ? wheelItems : [],
                        createdAt: Number(row.created_at) || Date.now()
                    };
                    this.watchPartyRooms.set(row.id, room);
                    scheduleInactivityCheck(row.id);
                }
                if (res.rows.length > 0) {
                    console.log(`[Watch Party] Restauradas ${res.rows.length} salas ativas do banco de dados.`);
                }
            } catch (e) {
                console.warn('[Watch Party] Erro ao restaurar salas do banco:', e.message);
            }
        };

        loadRoomsFromDb();

        // 1. Criar sala
        const ROOM_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
        const generateRoomCode = () => {
            let code = '';
            for (let i = 0; i < 4; i++) {
                code += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
            }
            return code;
        };

        const normalizeRoomCode = (raw) => {
            if (!raw) return '';
            return String(raw).toUpperCase().replace(/^BF[-_]?/, '').replace(/[^A-Z0-9]/g, '').trim();
        };

        const getRoomByCode = (rawCode) => {
            if (!rawCode) return null;
            const rawStr = String(rawCode).trim().toUpperCase();
            const norm = normalizeRoomCode(rawStr);
            if (this.watchPartyRooms.has(norm)) return this.watchPartyRooms.get(norm);
            if (this.watchPartyRooms.has(rawStr)) return this.watchPartyRooms.get(rawStr);
            if (this.watchPartyRooms.has('BF-' + norm)) return this.watchPartyRooms.get('BF-' + norm);

            for (const [key, room] of this.watchPartyRooms.entries()) {
                if (normalizeRoomCode(key) === norm || key.toUpperCase() === rawStr) {
                    return room;
                }
            }
            return null;
        };

        const joinAttemptsByIp = new Map();
        const checkJoinRateLimit = (ip) => {
            const now = Date.now();
            const entry = joinAttemptsByIp.get(ip);
            if (!entry) return { allowed: true };

            if (entry.blockedUntil && now < entry.blockedUntil) {
                const remainingSec = Math.ceil((entry.blockedUntil - now) / 1000);
                return { allowed: false, remainingSec };
            }

            if (now - entry.lastFailedTime > 60000) {
                joinAttemptsByIp.delete(ip);
                return { allowed: true };
            }

            return { allowed: true };
        };

        const recordJoinFailure = (ip) => {
            const now = Date.now();
            const entry = joinAttemptsByIp.get(ip) || { count: 0, lastFailedTime: now, blockedUntil: 0 };
            entry.count += 1;
            entry.lastFailedTime = now;

            if (entry.count >= 5) {
                entry.blockedUntil = now + 30000; // 30s de cooldown após 5 erros
                entry.count = 0;
            }

            joinAttemptsByIp.set(ip, entry);
        };

        const recordJoinSuccess = (ip) => {
            joinAttemptsByIp.delete(ip);
        };

        this.app.post('/api/party/create', async (req, res) => {
            try {
                const { title, sub, streamUrl, mediaInfo, hostName, token, hostUserId } = req.body;

                let roomCode = generateRoomCode();
                while (getRoomByCode(roomCode)) {
                    roomCode = generateRoomCode();
                }
                const actualHostName = (hostName || 'Anfitrião').trim();

                const room = {
                    id: roomCode,
                    hostId: hostUserId ? String(hostUserId) : null,
                    hostName: actualHostName,
                    hostToken: token || null,
                    mediaInfo: (mediaInfo || streamUrl) ? { title: title || 'BrasilFlix', sub: sub || '', streamUrl, ...mediaInfo } : null,
                    currentTime: 0,
                    isPlaying: false,
                    hostOnlyControls: true,
                    permissions: { ...DEFAULT_ROOM_PERMISSIONS },
                    lastStateChange: Date.now(),
                    lastActivity: Date.now(),
                    members: new Map(),
                    wheelItems: [],
                    createdAt: Date.now()
                };

                this.watchPartyRooms.set(roomCode, room);
                await saveRoomToDb(room);
                scheduleInactivityCheck(roomCode);

                const baseUrl = this.getBaseUrl(req);
                res.json({
                    success: true,
                    roomCode,
                    roomId: roomCode,
                    hostName: actualHostName,
                    mediaInfo: room.mediaInfo,
                    permissions: room.permissions,
                    shareUrl: `${baseUrl}/?sala=${roomCode}`
                });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // 2. Consultar sala
        this.app.get('/api/party/room/:roomId', (req, res) => {
            const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
            const rate = checkJoinRateLimit(ip);
            if (!rate.allowed) {
                return res.status(429).json({
                    success: false,
                    error: `Muitas tentativas incorretas. Aguarde ${rate.remainingSec}s para tentar novamente.`,
                    cooldown: rate.remainingSec
                });
            }

            const room = getRoomByCode(req.params.roomId);
            if (!room) {
                recordJoinFailure(ip);
                return res.status(404).json({ success: false, error: 'Sala não encontrada ou expirada.' });
            }

            recordJoinSuccess(ip);
            res.json({
                success: true,
                room: serializeRoom(room)
            });
        });

        // 3. SSE — conexão em tempo real
        this.app.get('/api/party/events/:roomId', (req, res) => {
            const room = getRoomByCode(req.params.roomId);
            if (!room) return res.status(404).send('Sala não encontrada.');
            const roomCode = room.id;

            const userId = String(req.query.userId || ('user_' + Math.random().toString(36).substring(2, 9)));
            const userName = decodeURIComponent(req.query.name || 'Espectador');

            // Se a sala não tem host ainda, o primeiro se torna host
            if (!room.hostId) {
                room.hostId = userId;
                room.hostName = userName;
            }

            const isHost = String(userId) === String(room.hostId);

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const existing = room.members.get(userId);
            const isReconnect = !!existing;

            room.members.set(userId, {
                id: userId,
                name: userName,
                isHost,
                inPlayer: existing ? !!existing.inPlayer : false,
                isReady: existing ? !!existing.isReady : false,
                isLoading: existing ? !!existing.isLoading : false,
                audio: existing ? existing.audio : null,
                res,
                lastSeen: Date.now()
            });

            room.lastActivity = Date.now();
            saveRoomToDb(room);

            const membersList = serializeMembers(room);

            res.write(`data: ${JSON.stringify({
                type: 'init',
                userId,
                isHost,
                room: serializeRoom(room)
            })}\n\n`);

            if (!isReconnect) {
                broadcastToRoom(room, {
                    type: 'member_joined',
                    userId,
                    name: userName,
                    members: membersList,
                    serverTime: Date.now()
                });
            } else {
                broadcastToRoom(room, {
                    type: 'member_reconnected',
                    userId,
                    name: userName,
                    members: membersList,
                    serverTime: Date.now()
                });
            }

            // Heartbeat
            const heartbeat = setInterval(() => {
                try { if (!res.writableEnded) res.write(': heartbeat\n\n'); }
                catch(e) { clearInterval(heartbeat); }
            }, 25000);

            req.on('close', () => {
                clearInterval(heartbeat);
                // Dá 30s de janela para reconexão
                setTimeout(() => {
                    const r = getRoomByCode(roomCode);
                    if (!r) return;
                    const m = r.members.get(userId);
                    if (m && m.res === res) {
                        r.members.delete(userId);
                        const updatedMembers = serializeMembers(r);
                        broadcastToRoom(r, { type: 'member_left', userId, name: userName, members: updatedMembers, serverTime: Date.now() });
                        saveRoomToDb(r);
                    }
                }, 30000);
            });
        });

        // 4. Ações da sala
        this.app.post('/api/party/action/:roomId', async (req, res) => {
            try {
                const room = getRoomByCode(req.params.roomId);
                if (!room) return res.status(404).json({ success: false, error: 'Sala não encontrada.' });
                const roomCode = room.id;

                const { userId, action, currentTime, permissions: newPermsReq, mediaInfo, suggestion, suggestionId, winner, targetId, by, speed } = req.body;
                const isHost = String(userId) === String(room.hostId);
                const member = room.members.get(String(userId)) || { name: by || (isHost ? room.hostName : 'Membro') };
                const roomPermissions = room.permissions || { ...DEFAULT_ROOM_PERMISSIONS };

                room.lastActivity = Date.now();

                switch (action) {
                    case 'play':
                        if (!isHost && !roomPermissions.canResume) {
                            return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode retomar a reprodução.' });
                        }
                        if (typeof currentTime === 'number') room.currentTime = Math.max(0, currentTime);
                        room.isPlaying = true;
                        room.lastStateChange = Date.now();
                        const startPlaybackAt = Date.now() + 500; // Início sincronizado em 500ms
                        broadcastToRoom(room, {
                            type: 'play',
                            userId,
                            by: member.name,
                            currentTime: room.currentTime,
                            startPlaybackAt,
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'pause':
                        if (!isHost && !roomPermissions.canPause) {
                            return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode pausar a reprodução.' });
                        }
                        if (typeof currentTime === 'number') room.currentTime = Math.max(0, currentTime);
                        room.isPlaying = false;
                        room.lastStateChange = Date.now();
                        broadcastToRoom(room, {
                            type: 'pause',
                            userId,
                            by: member.name,
                            currentTime: room.currentTime,
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'seek':
                        if (!isHost && !roomPermissions.canSeek) {
                            return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode avançar ou retroceder o vídeo.' });
                        }
                        if (typeof currentTime === 'number') room.currentTime = Math.max(0, currentTime);
                        room.lastStateChange = Date.now();
                        broadcastToRoom(room, {
                            type: 'seek',
                            userId,
                            by: member.name,
                            currentTime: room.currentTime,
                            isPlaying: room.isPlaying,
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'permissions':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode configurar permissões da sala.' });
                        if (newPermsReq && typeof newPermsReq === 'object') {
                            room.permissions = {
                                canPause: newPermsReq.canPause !== false,
                                canResume: !!newPermsReq.canResume,
                                canSeek: !!newPermsReq.canSeek,
                                canChangeMedia: !!newPermsReq.canChangeMedia,
                                canChangeSpeed: !!newPermsReq.canChangeSpeed
                            };
                            room.hostOnlyControls = !room.permissions.canResume && !room.permissions.canSeek && !room.permissions.canChangeMedia;
                        }
                        broadcastToRoom(room, {
                            type: 'permissions_changed',
                            userId,
                            permissions: room.permissions,
                            hostOnlyControls: room.hostOnlyControls,
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'change_media':
                        if (!isHost && !roomPermissions.canChangeMedia) {
                            return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode trocar de filme ou episódio.' });
                        }
                        if (mediaInfo) {
                            room.mediaInfo = mediaInfo;
                            room.currentTime = 0;
                            room.isPlaying = false;
                            room.lastStateChange = Date.now();
                            for (const m of room.members.values()) {
                                if (String(m.id) === String(userId)) {
                                    m.inPlayer = true;
                                    m.isReady = true;
                                    m.isLoading = false;
                                    if (mediaInfo.audio) m.audio = mediaInfo.audio;
                                } else {
                                    m.inPlayer = false;
                                    m.isReady = false;
                                    m.isLoading = false;
                                }
                            }
                        }
                        broadcastToRoom(room, {
                            type: 'change_media',
                            userId,
                            by: member.name,
                            mediaInfo: room.mediaInfo,
                            members: serializeMembers(room),
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'set_speed':
                        if (!isHost && !roomPermissions.canChangeSpeed) {
                            return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode alterar a velocidade de reprodução da sala.' });
                        }
                        const playSpeed = Number(speed) || 1.0;
                        broadcastToRoom(room, {
                            type: 'set_speed',
                            userId,
                            by: member.name,
                            speed: playSpeed,
                            serverTime: Date.now()
                        });
                        break;

                    case 'stop_media':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode parar a mídia.' });
                        room.mediaInfo = null;
                        room.currentTime = 0;
                        room.isPlaying = false;
                        room.lastStateChange = Date.now();
                        for (const m of room.members.values()) {
                            m.inPlayer = false;
                            m.isReady = false;
                            m.isLoading = false;
                        }
                        broadcastToRoom(room, {
                            type: 'media_stopped',
                            userId,
                            by: member.name,
                            members: serializeMembers(room),
                            serverTime: Date.now()
                        });
                        saveRoomToDb(room);
                        break;

                    case 'suggest_media':
                        if (!suggestion || !suggestion.title) break;
                        suggestion.id = suggestion.id || (Date.now() + '_' + userId);
                        room.wheelItems = room.wheelItems || [];
                        room.wheelItems.push(suggestion);
                        broadcastToRoom(room, { type: 'suggest_media', userId, by: member.name, suggestion, serverTime: Date.now() });
                        break;

                    case 'remove_suggestion':
                        if (room.wheelItems && suggestionId) {
                            const item = room.wheelItems.find(i => i.id === suggestionId);
                            const canRemove = isHost || (item && String(item.byId) === String(userId));
                            if (canRemove) {
                                room.wheelItems = room.wheelItems.filter(i => i.id !== suggestionId);
                                broadcastToRoom(room, { type: 'remove_suggestion', userId, suggestionId, serverTime: Date.now() });
                            }
                        }
                        break;

                    case 'spin_wheel':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode girar a roleta.' });
                        broadcastToRoom(room, { type: 'spin_wheel', userId, by: member.name, winner, durationMs: req.body.durationMs || 3600, serverTime: Date.now() });
                        break;

                    case 'wheel_result':
                        if (!winner) break;
                        broadcastToRoom(room, { type: 'wheel_result', userId, by: member.name, winner, serverTime: Date.now() });
                        break;

                    case 'close_room':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode encerrar a sala.' });
                        broadcastToRoom(room, { type: 'room_closed', reason: 'O anfitrião encerrou a sala.', serverTime: Date.now() });
                        this.watchPartyRooms.delete(roomCode);
                        await deleteRoomFromDb(roomCode);
                        break;

                    case 'transfer_host':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode transferir a liderança.' });
                        if (targetId && room.members.has(String(targetId))) {
                            const newHostMember = room.members.get(String(targetId));
                            room.hostId = String(targetId);
                            room.hostName = newHostMember.name;
                            for (const [mid, m] of room.members.entries()) {
                                m.isHost = (mid === String(targetId));
                            }
                            const updatedMembers = serializeMembers(room);
                            broadcastToRoom(room, {
                                type: 'host_transferred',
                                newHostId: String(targetId),
                                newHostName: newHostMember.name,
                                oldHostId: String(userId),
                                members: updatedMembers,
                                serverTime: Date.now()
                            });
                            saveRoomToDb(room);
                        }
                        break;

                    case 'member_ready_state':
                        if (room.members.has(String(userId))) {
                            const m = room.members.get(String(userId));
                            if (typeof req.body.inPlayer === 'boolean') m.inPlayer = req.body.inPlayer;
                            if (typeof req.body.isReady === 'boolean') m.isReady = req.body.isReady;
                            if (typeof req.body.isLoading === 'boolean') m.isLoading = req.body.isLoading;
                            if (req.body.audio) m.audio = req.body.audio;
                            const updatedMembers = serializeMembers(room);
                            broadcastToRoom(room, {
                                type: 'member_ready_state_changed',
                                userId: String(userId),
                                inPlayer: !!m.inPlayer,
                                isReady: !!m.isReady,
                                isLoading: !!m.isLoading,
                                audio: m.audio,
                                members: updatedMembers,
                                serverTime: Date.now()
                            });
                            saveRoomToDb(room);
                        }
                        break;

                    case 'kick':
                        if (!isHost) return res.status(403).json({ success: false, error: 'Apenas o anfitrião pode remover membros.' });
                        if (targetId) {
                            broadcastToRoom(room, { type: 'kicked', userId: targetId, serverTime: Date.now() });
                            setTimeout(() => {
                                const r = this.watchPartyRooms && this.watchPartyRooms.get(roomCode);
                                if (r) {
                                    r.members.delete(String(targetId));
                                    broadcastToRoom(r, { type: 'member_left', userId: targetId, name: '?', members: serializeMembers(r), serverTime: Date.now() });
                                    saveRoomToDb(r);
                                }
                            }, 1000);
                        }
                        break;

                    default:
                        broadcastToRoom(room, { type: action, userId, by: member.name, serverTime: Date.now(), ...req.body });
                }

                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // 8. Adição Manual de Mídias (Download Automático, Magnet Link ou Cadastro Direto)
        this.app.post('/api/admin/catalogo/manual-add', auth, async (req, res) => {
            try {
                const {
                    action, // 'queue', 'magnet', 'direct'
                    title,
                    type,
                    tmdbId,
                    imdbId,
                    nomeOriginal,
                    ano,
                    sinopse,
                    posterUrl,
                    backdropUrl,
                    generos,
                    nota,
                    audioPreference,
                    priority,
                    magnetUrl,
                    season,
                    episode,
                    allEpisodes,
                    messageId,
                    fileId,
                    qualidade,
                    audio
                } = req.body;

                if (!title || !title.trim()) {
                    return res.status(400).json({ error: 'Título é obrigatório.' });
                }

                const cleanTitle = title.trim();
                const mediaType = type === 'serie' ? 'serie' : 'filme';
                const mediaPriority = parseInt(priority || 1, 10);
                const sNum = parseInt(season || 1, 10);
                const epNum = parseInt(episode || 1, 10);

                // Modo Cadastro Direto (sem download)
                if (action === 'direct') {
                    if (mediaType === 'filme') {
                        const item = await this.catalogoManager.adicionarFilme(
                            cleanTitle,
                            sinopse || '',
                            parseInt(messageId || 0, 10),
                            'filme',
                            true,
                            {
                                nomeOriginal: nomeOriginal || cleanTitle,
                                ano: ano || new Date().getFullYear().toString(),
                                posterUrl: posterUrl || '',
                                backdropUrl: backdropUrl || '',
                                generos: Array.isArray(generos) ? generos : (typeof generos === 'string' ? generos.split(',').map(s => s.trim()) : []),
                                nota: parseFloat(nota || 8.0),
                                tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
                                imdbId: imdbId || null,
                                fileId: fileId || null,
                                qualidade: qualidade || '1080p Full HD',
                                audio: audio || (audioPreference === 'legendado' ? 'Legendado (PT-BR)' : 'Dublado (PT-BR)'),
                                isDublado: audioPreference !== 'legendado',
                                isLegendado: audioPreference === 'legendado'
                            }
                        );
                        return res.json({ success: true, message: `Filme "${cleanTitle}" cadastrado diretamente no catálogo!`, item });
                    } else {
                        const item = await this.catalogoManager.adicionarEpisodioSerie(
                            cleanTitle,
                            sNum,
                            epNum,
                            parseInt(messageId || 0, 10),
                            fileId || null,
                            {
                                nomeOriginal: nomeOriginal || cleanTitle,
                                ano: ano || new Date().getFullYear().toString(),
                                sinopse: sinopse || '',
                                posterUrl: posterUrl || '',
                                backdropUrl: backdropUrl || '',
                                generos: Array.isArray(generos) ? generos : (typeof generos === 'string' ? generos.split(',').map(s => s.trim()) : []),
                                nota: parseFloat(nota || 8.0),
                                tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
                                imdbId: imdbId || null,
                                episodioNome: `Episódio ${epNum}`,
                                qualidade: qualidade || '1080p Full HD',
                                audio: audio || (audioPreference === 'legendado' ? 'Legendado (PT-BR)' : 'Dublado (PT-BR)'),
                                isDublado: audioPreference !== 'legendado',
                                isLegendado: audioPreference === 'legendado'
                            }
                        );
                        return res.json({ success: true, message: `Episódio T${sNum}E${epNum} de "${cleanTitle}" cadastrado diretamente!`, item });
                    }
                }

                // Modo Enfileirar Temporada Completa
                if (mediaType === 'serie' && allEpisodes && tmdbId) {
                    const seasonDetails = await TMDBService.getSeasonDetails(parseInt(tmdbId, 10), sNum);
                    const episodesList = seasonDetails?.episodios || [{ numero: 1 }];
                    const jobsAdded = [];
                    for (const ep of episodesList) {
                        const job = this.queueManager.addJob(cleanTitle, 'serie', mediaPriority, {
                            audioPreference: audioPreference || 'dublado',
                            season: sNum,
                            episode: ep.numero,
                            tmdbId: parseInt(tmdbId, 10),
                            nomeOriginal,
                            customMagnet: magnetUrl || null,
                            isManualAdd: true,
                            metaDetails: {
                                sinopse,
                                posterUrl,
                                backdropUrl,
                                ano,
                                generos,
                                nota
                            },
                            username: 'Admin (Manual Add)'
                        });
                        if (job) jobsAdded.push(job);
                    }
                    return res.json({ 
                        success: true, 
                        message: `Temporada ${sNum} de "${cleanTitle}" (${jobsAdded.length} episódios) enviada para a fila de downloads com Prioridade ${mediaPriority}!`, 
                        jobs: jobsAdded 
                    });
                }

                // Modo Enfileirar Individual (Filme ou Episódio)
                const job = this.queueManager.addJob(cleanTitle, mediaType, mediaPriority, {
                    audioPreference: audioPreference || 'dublado',
                    season: mediaType === 'serie' ? sNum : null,
                    episode: mediaType === 'serie' ? epNum : null,
                    tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
                    nomeOriginal,
                    customMagnet: magnetUrl || null,
                    isManualAdd: true,
                    metaDetails: {
                        sinopse,
                        posterUrl,
                        backdropUrl,
                        ano,
                        generos,
                        nota
                    },
                    username: 'Admin (Manual Add)'
                });

                res.json({
                    success: true,
                    message: `"${cleanTitle}" ${mediaType === 'serie' ? `(T${sNum}E${epNum})` : ''} enfileirado com Prioridade ${mediaPriority}!`,
                    job
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 9. Upload Direto de Arquivos de Vídeo (MP4, MKV, AVI, etc.) com TMDB
        const rawStorageDir = path.resolve('./downloads/raw');
        fs.ensureDirSync(rawStorageDir);

        const chunkUpload = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 30 * 1024 * 1024 } // 30MB por fatia
        });

        this.app.post('/api/admin/catalogo/upload-chunk', auth, chunkUpload.single('chunk'), async (req, res) => {
            try {
                if (!req.file) {
                    return res.status(400).json({ error: 'Nenhum chunk de vídeo enviado.' });
                }

                const {
                    uploadId,
                    chunkIndex,
                    totalChunks,
                    fileName,
                    title,
                    type,
                    tmdbId,
                    imdbId,
                    nomeOriginal,
                    ano,
                    sinopse,
                    posterUrl,
                    backdropUrl,
                    generos,
                    nota,
                    audioPreference,
                    priority,
                    season,
                    episode
                } = req.body;

                if (!uploadId) {
                    return res.status(400).json({ error: 'ID de upload não informado.' });
                }

                const cIdx = parseInt(chunkIndex, 10);
                const tChunks = parseInt(totalChunks, 10);
                const tempFilePath = path.join(rawStorageDir, `temp_${uploadId}.part`);

                // Anexa o chunk recebido ao arquivo temporário
                await fs.appendFile(tempFilePath, req.file.buffer);

                // Se ainda não for o último chunk, confirma recebimento do chunk
                if (cIdx < tChunks - 1) {
                    return res.json({
                        success: true,
                        chunkIndex: cIdx,
                        totalChunks: tChunks,
                        completed: false
                    });
                }

                // Último chunk recebido! Finaliza o arquivo
                const ext = path.extname(fileName || 'video.mp4') || '.mp4';
                const safeName = path.basename(fileName || 'video', ext).replace(/[^a-zA-Z0-9_-]/g, '_');
                const finalFilePath = path.join(rawStorageDir, `${Date.now()}_${safeName}${ext}`);

                await fs.rename(tempFilePath, finalFilePath);

                let cleanTitle = (title || '').trim();
                let mediaType = type === 'serie' ? 'serie' : 'filme';
                let mediaPriority = parseInt(priority || 1, 10);
                let sNum = parseInt(season || 1, 10);
                let epNum = parseInt(episode || 1, 10);

                if (fileName) {
                    const rawFileName = path.basename(fileName, path.extname(fileName));
                    const matchEp = rawFileName.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\s*(?:e|ep|episodio|episódio|x)\s*(\d{1,3})\b/i);
                    const matchTempOnly = rawFileName.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\b/i);
                    const matchYear = rawFileName.match(/\b(19\d{2}|20\d{2})\b/);

                    if (matchEp) {
                        mediaType = 'serie';
                        sNum = parseInt(matchEp[1], 10);
                        epNum = parseInt(matchEp[2], 10);
                        if (!cleanTitle || /comandotorrents|www|\.com/i.test(cleanTitle)) {
                            cleanTitle = rawFileName.substring(0, matchEp.index);
                        }
                    } else if (matchTempOnly) {
                        mediaType = 'serie';
                        sNum = parseInt(matchTempOnly[1], 10);
                        if (!cleanTitle || /comandotorrents|www|\.com/i.test(cleanTitle)) {
                            cleanTitle = rawFileName.substring(0, matchTempOnly.index);
                        }
                    } else if (matchYear && (!cleanTitle || /comandotorrents|www|\.com/i.test(cleanTitle))) {
                        cleanTitle = rawFileName.substring(0, matchYear.index);
                    }
                }

                if (!cleanTitle) {
                    cleanTitle = path.basename(fileName || 'video', ext);
                }

                cleanTitle = cleanTitle
                    .replace(/https?:\/\/\S+/gi, '')
                    .replace(/\b(?:www\.)?[a-zA-Z0-9_-]+\.(?:com|br|to|net|org|site|club|me|tv|io|top|xyz|ws|vip|cc)\b/gi, '')
                    .replace(/[\._]/g, ' ')
                    .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\s*(?:e|ep|episodio|episódio|x)\s*\d{1,3}\b/gi, '')
                    .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\b/gi, '')
                    .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|webrip|dual|dublado|legendado|aac|x264|x265|hevc|ddp5\.1|dvdrip|hdtv|galaxytv|comando|comandotorrents|bludv|lapumia|starck|vizer|wolverdon|ondebaixo|lipeh|cinegaveta|filmesmega|mmfilmes)\b/gi, '')
                    .replace(/[-–—]\s*\d{4}/g, '')
                    .replace(/\b(19\d{2}|20\d{2})\b/g, '')
                    .replace(/\[[^\]]*\]|\([^\)]*\)/g, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                let parsedGeneros = [];
                try {
                    parsedGeneros = typeof generos === 'string' ? JSON.parse(generos) : (Array.isArray(generos) ? generos : []);
                } catch (e) {
                    parsedGeneros = typeof generos === 'string' ? generos.split(',').map(s => s.trim()) : [];
                }

                const TMDBService = require('./TMDBService');
                let enrichedTmdbId = tmdbId ? parseInt(tmdbId, 10) : null;
                let enrichedImdbId = imdbId || null;
                let enrichedPoster = posterUrl || '';
                let enrichedBackdrop = backdropUrl || '';
                let enrichedSinopse = sinopse || '';
                let enrichedOriginal = nomeOriginal || cleanTitle;
                let enrichedAno = ano || new Date().getFullYear().toString();
                let enrichedNota = parseFloat(nota || 8.0);
                let enrichedGeneros = parsedGeneros;

                if (!enrichedTmdbId || !enrichedPoster) {
                    try {
                        if (mediaType === 'serie') {
                            const results = await TMDBService.searchTV(cleanTitle);
                            if (results && results.length > 0) {
                                const top = results[0];
                                enrichedTmdbId = top.tmdbId;
                                enrichedImdbId = top.imdbId || enrichedImdbId;
                                enrichedPoster = top.posterUrl || enrichedPoster;
                                enrichedBackdrop = top.backdropUrl || enrichedBackdrop;
                                enrichedSinopse = top.sinopse || enrichedSinopse;
                                enrichedOriginal = top.nomeOriginal || enrichedOriginal;
                                enrichedAno = top.ano || enrichedAno;
                                enrichedNota = top.nota || enrichedNota;
                                if (top.generos && top.generos.length > 0) enrichedGeneros = top.generos;
                            }
                        } else {
                            const results = await TMDBService.searchMovie(cleanTitle);
                            if (results && results.length > 0) {
                                const top = results[0];
                                enrichedTmdbId = top.tmdbId;
                                enrichedImdbId = top.imdbId || enrichedImdbId;
                                enrichedPoster = top.posterUrl || enrichedPoster;
                                enrichedBackdrop = top.backdropUrl || enrichedBackdrop;
                                enrichedSinopse = top.sinopse || enrichedSinopse;
                                enrichedOriginal = top.nomeOriginal || enrichedOriginal;
                                enrichedAno = top.ano || enrichedAno;
                                enrichedNota = top.nota || enrichedNota;
                                if (top.generos && top.generos.length > 0) enrichedGeneros = top.generos;
                            }
                        }
                    } catch (eTmdb) {
                        console.warn('⚠️ Falha ao auto-completar TMDB para chunk upload:', eTmdb.message);
                    }
                }

                const job = this.queueManager.addJob(cleanTitle, mediaType, mediaPriority, {
                    audioPreference: audioPreference || 'dublado',
                    season: mediaType === 'serie' ? sNum : null,
                    episode: mediaType === 'serie' ? epNum : null,
                    tmdbId: enrichedTmdbId,
                    imdbId: enrichedImdbId,
                    nomeOriginal: enrichedOriginal,
                    rawFilePath: finalFilePath,
                    isManualAdd: true,
                    metaDetails: {
                        sinopse: enrichedSinopse,
                        posterUrl: enrichedPoster,
                        backdropUrl: enrichedBackdrop,
                        ano: enrichedAno,
                        generos: enrichedGeneros,
                        nota: enrichedNota
                    },
                    username: 'Admin (Upload de Arquivo)'
                });

                res.json({
                    success: true,
                    completed: true,
                    message: `Arquivo "${fileName}" recebido com sucesso! "${cleanTitle}" ${mediaType === 'serie' ? `(T${sNum}E${epNum})` : ''} foi adicionado ao topo da fila para processamento e upload.`,
                    job
                });
            } catch (e) {
                console.error('Erro no upload-chunk:', e);
                res.status(500).json({ error: e.message });
            }
        });

        // ═══════════════════════════════════════════════════════════════════════

        // 1.5 Rotas de SEO e Sitemap
        this.app.get('/robots.txt', (req, res) => {
            res.type('text/plain');
            res.sendFile(path.resolve(__dirname, '../../public/robots.txt'));
        });

        this.app.get('/sitemap.xml', (req, res) => {
            res.type('application/xml');
            res.sendFile(path.resolve(__dirname, '../../public/sitemap.xml'));
        });

        // 2. Dashboard Web e Rotas de Navegacao
        this.app.get('/', (req, res) => this.renderLandingPage(req, res, 'public'));
        this.app.get([
            '/status',
            '/fila',
            '/catalogo',
            '/admin',
            '/filme/:id',
            '/filme/:id/assistir',
            '/serie/:id',
            '/serie/:serieId/temporada/:season/episodio/:episode',
            '/serie/:serieId/t/:season/e/:episode',
            '/assistir',
            '/assistir/*',
            '/sala/:id'
        ], (req, res) => this.renderLandingPage(req, res, 'public'));

        // Rota oficial de Checkout e Assinatura Web
        this.app.get('/assinar', (req, res) => {
            const assinarPath = path.resolve(__dirname, '../../public/assinar.html');
            if (fs.existsSync(assinarPath)) {
                return res.sendFile(assinarPath);
            }
            this.renderLandingPage(req, res, 'public');
        });

        // APIs de Pagamento Web e Consumo Gratuito
        this.app.post('/api/pagamentos/pix', async (req, res) => {
            try {
                const { nome, email, plano, telegramUser } = req.body;
                const payment = await this.assinaturaManager.criarPagamentoWeb({ nome, email, plano, telegramUser });
                res.json(payment);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.post('/api/pagamentos/assinatura-recorrente', async (req, res) => {
            try {
                const { nome, email, plano, telegramUser } = req.body;
                const sub = await this.assinaturaManager.criarAssinaturaRecorrenteWeb({ nome, email, plano, telegramUser });
                res.json(sub);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.post('/api/pagamentos/checkout-pro', async (req, res) => {
            try {
                const { nome, email, plano, telegramUser } = req.body;
                const pref = await this.assinaturaManager.criarCheckoutProWeb({ nome, email, plano, telegramUser });
                res.json(pref);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.get('/api/pagamentos/status/:id', async (req, res) => {
            try {
                const resultado = await this.assinaturaManager.processarPagamento(req.params.id);
                res.json({
                    success: true,
                    approved: resultado.success && (resultado.payment?.status === 'approved'),
                    status: resultado.payment?.status || resultado.status,
                    token: resultado.token || null
                });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        // APIs de Usuários Públicos (Cadastro / Login / Favoritos / Notificações)
        this.app.post('/api/user/register', async (req, res) => {
            const { email, username, password, telegramId } = req.body;
            const result = await authService.registerUser(email, username, password, telegramId);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        });

        this.app.post('/api/user/login', async (req, res) => {
            const { identifier, password } = req.body;
            const result = await authService.loginUser(identifier, password);
            if (!result.success) return res.status(401).json(result);
            res.json(result);
        });

        this.app.get('/api/user/me', authService.userAuthMiddleware(), async (req, res) => {
            const user = await authService.getUserProfile(req.user.id);
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
            
            // Verifica status VIP atualizado
            const auth = this.assinaturaManager.verificarAcessoStremio(user.telegram_id || user.id);
            const isVip = auth.authorized || user.is_vip;

            // Busca notificações do usuário da tabela user_notifications
            let notifs = [];
            try {
                const notifRes = await db.query(`
                    SELECT id, title, message AS text, media_id AS "serieId", media_type, link, read, created_at AS "createdAt"
                    FROM user_notifications
                    WHERE user_id = $1 OR user_id = $2
                    ORDER BY created_at DESC
                    LIMIT 20
                `, [String(user.id), String(user.telegram_id || user.id)]);
                notifs = notifRes.rows || [];
            } catch (e) {
                notifs = user.notificacoes || [];
            }

            res.json({
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                    is_vip: isVip,
                    telegram_id: user.telegram_id,
                    avatar_url: user.avatar_url || null,
                    preferencias: user.preferencias || { defaultAudio: 'ask', spoilerBlur: true },
                    favoritos: user.favoritos || [],
                    notificacoes: notifs,
                    has_custom_password: !!user.has_custom_password,
                    is_temp_email: !!(user.email && (user.email.includes('@telegram.') || user.email.endsWith('.user'))),
                    created_at: user.created_at
                }
            });
        });

        // ⚙️ Atualização de Perfil, Nome de Usuário, Email, Avatar e Preferências
        this.app.put('/api/user/profile', authService.userAuthMiddleware(), async (req, res) => {
            const result = await authService.updateUserProfile(req.user.id, req.body);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        });

        // 📸 Upload de Avatar como arquivo (imagem → base64 data URI armazenado no banco)
        const avatarUpload = multer({
            storage: multer.memoryStorage(),
            limits: { fileSize: 2 * 1024 * 1024 }, // 2MB máximo
            fileFilter: (req, file, cb) => {
                if (!file.mimetype.startsWith('image/')) {
                    return cb(new Error('Apenas imagens são aceitas.'), false);
                }
                cb(null, true);
            }
        });
        this.app.post('/api/user/avatar-upload', authService.userAuthMiddleware(), avatarUpload.single('avatar'), async (req, res) => {
            try {
                if (!req.file) return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada.' });
                const base64 = req.file.buffer.toString('base64');
                const dataUri = `data:${req.file.mimetype};base64,${base64}`;
                const result = await authService.updateUserProfile(req.user.id, { avatar_url: dataUri });
                if (!result.success) return res.status(400).json(result);
                res.json({ success: true, avatar_url: dataUri, user: result.user });
            } catch (e) {
                console.error('Erro no upload de avatar:', e.message);
                res.status(500).json({ success: false, message: 'Erro ao processar imagem.' });
            }
        });
        // Trata erros do multer (ex: arquivo muito grande)
        this.app.use((err, req, res, next) => {
            if (err && err.message === 'Apenas imagens são aceitas.') {
                return res.status(400).json({ success: false, message: err.message });
            }
            if (err && err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: 'Imagem muito grande. Máximo: 2MB.' });
            }
            next(err);
        });

        // 🔗 Vinculação de Conta ao Telegram
        this.app.post('/api/user/telegram-link/create', authService.userAuthMiddleware(), (req, res) => {
            const session = authService.createTelegramLinkSession(req.user.id);
            res.json({ success: true, ...session });
        });

        this.app.get('/api/user/telegram-link/check/:code', (req, res) => {
            const status = authService.checkTelegramLinkStatus(req.params.code);
            res.json(status);
        });

        // 📋 Listagem de Pedidos do Usuário
        this.app.get('/api/user/requests', authService.userAuthMiddleware(), async (req, res) => {
            const result = await authService.getUserRequests(req.user.id, req.user.username, req.user.telegram_id);
            res.json(result);
        });

        // ⭐ Listagem de Avaliações e Comentários do Usuário
        this.app.get('/api/user/reviews', authService.userAuthMiddleware(), async (req, res) => {
            const result = await authService.getUserReviews(req.user.id, req.user.username);
            res.json(result);
        });

        this.app.post('/api/user/favoritos/toggle', authService.userAuthMiddleware(), async (req, res) => {
            const { itemId, itemType, title } = req.body;
            if (!itemId) return res.status(400).json({ error: 'ID do item é obrigatório.' });
            const result = await authService.toggleFavorite(req.user.id, itemId, itemType || 'filme');
            if (result.success) {
                const item = (itemType === 'filme') ? this.catalogoManager?.buscarFilmePorId(itemId) : this.catalogoManager?.buscarSeriePorId(itemId);
                const resolvedTitle = title || item?.nome || `Mídia #${itemId}`;
                auditService.logEvent({
                    identityType: req.user.id ? 'registered' : 'telegram',
                    userId: req.user.id || null,
                    telegramId: req.user.telegram_id,
                    eventType: result.isFavorite ? 'FAVORITE_ADDED' : 'FAVORITE_REMOVED',
                    source: 'website',
                    mediaId: String(itemId),
                    title: resolvedTitle,
                    metadata: { itemType: itemType || 'filme' }
                }).catch(() => {});
            }
            res.json(result);
        });

        this.app.get('/api/user/favoritos', authService.userAuthMiddleware(), async (req, res) => {
            const user = await authService.getUserProfile(req.user.id);
            if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

            const favs = user.favoritos || [];
            const resultItems = [];

            for (const fav of favs) {
                if (fav.type === 'serie' || fav.type === 'dorama') {
                    const s = this.catalogoManager.buscarSeriePorId(fav.id);
                    if (s) resultItems.push({ ...s, itemType: 'serie' });
                } else {
                    const f = this.catalogoManager.buscarFilmePorId(fav.id);
                    if (f) resultItems.push({ ...f, itemType: 'filme' });
                }
            }

            res.json({ success: true, favoritos: resultItems });
        });

        this.app.post('/api/user/notificacoes/read', authService.userAuthMiddleware(), async (req, res) => {
            try {
                await db.query(`
                    UPDATE user_notifications SET read = true
                    WHERE user_id = $1 OR user_id = $2
                `, [String(req.user.id), String(req.user.telegram_id || req.user.id)]);

                const user = await authService.getUserProfile(req.user.id);
                if (user) {
                    const notifs = (user.notificacoes || []).map(n => ({ ...n, read: true }));
                    await db.query(`UPDATE usuarios SET notificacoes = $1 WHERE id = $2`, [JSON.stringify(notifs), req.user.id]);
                }
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ── PROGRESSO DE REPRODUÇÃO & EPISÓDIOS ASSISTIDOS ─────────────────
        this.app.post('/api/progress/save', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const userId = req.user ? req.user.id : null;
                const guestToken = req.headers['x-guest-token'] || req.body.guestToken || 'guest_default';
                const { mediaId, mediaType, seasonNum, epNum, epName, currentTime, duration, completed } = req.body;
                
                const result = await this.progressManager.saveProgress({
                    userId,
                    guestToken,
                    mediaId,
                    mediaType,
                    seasonNum,
                    epNum,
                    epName,
                    currentTime,
                    duration,
                    completed
                });
                res.json(result);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.post('/api/progress/toggle-watched', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const userId = req.user ? req.user.id : null;
                const guestToken = req.headers['x-guest-token'] || req.body.guestToken || 'guest_default';
                const { mediaId, mediaType, seasonNum, epNum, completed } = req.body;
                
                const result = await this.progressManager.toggleWatched({
                    userId,
                    guestToken,
                    mediaId,
                    mediaType,
                    seasonNum,
                    epNum,
                    completed
                });
                res.json(result);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.get('/api/progress/media/:mediaId', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const userId = req.user ? req.user.id : null;
                const guestToken = req.headers['x-guest-token'] || req.query.guestToken || 'guest_default';
                const result = await this.progressManager.getMediaProgress(userId, guestToken, req.params.mediaId);
                res.json(result);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.get('/api/progress/all', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const userId = req.user ? req.user.id : null;
                const guestToken = req.headers['x-guest-token'] || req.query.guestToken || 'guest_default';
                const result = await this.progressManager.getAllUserProgress(userId, guestToken);
                res.json(result);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.post('/api/progress/dismiss', authService.userAuthMiddleware(true), async (req, res) => {
            try {
                const userId = req.user ? req.user.id : null;
                const guestToken = req.headers['x-guest-token'] || req.body.guestToken || 'guest_default';
                const result = await this.progressManager.dismissMediaProgress({
                    userId,
                    guestToken,
                    mediaId: req.body.mediaId
                });
                res.json(result);
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
        });

        this.app.get('/api/user/quota-check', async (req, res) => {
            try {
                const token = req.query.token || 'public';
                const type = req.query.type || 'filme';
                const mediaKey = req.query.mediaKey || null;
                const quota = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(token, type, mediaKey);
                res.json(quota);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.post('/api/user/confirm-stream', async (req, res) => {
            try {
                const { token, type } = req.body;
                if (!token) return res.status(400).json({ error: 'Token obrigatório.' });
                
                const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(token, type || 'filme');
                if (!consumo.permitido) {
                    return res.status(403).json({
                        success: false,
                        permitido: false,
                        message: `Limite gratuito de ${type === 'filme' ? '2 filmes' : '4 episódios'} por semana atingido.`
                    });
                }

                await this.assinaturaManager.registrarStreamConsumido(token, type || 'filme');
                res.json({
                    success: true,
                    permitido: true,
                    message: 'Crédito gratuito confirmado com sucesso!',
                    consumo
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // ✈️ Telegram 1-Clique Login API
        this.app.post('/api/auth/telegram/create', (req, res) => {
            try {
                const session = authService.createTelegramLoginSession();
                res.json({ success: true, ...session });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.get('/api/auth/telegram/check/:code', (req, res) => {
            try {
                const result = authService.checkTelegramLoginSession(req.params.code);
                res.json(result);
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        // 💬 APIs de Avaliações & Comentários da Comunidade
        this.app.get('/api/media/:type/:id/comentarios', async (req, res) => {
            const { type, id } = req.params;
            const data = await authService.getMediaReviews(type, id, req.query.season, req.query.episode);
            res.json(data);
        });

        this.app.post('/api/media/:type/:id/comentarios', authService.userAuthMiddleware(true), async (req, res) => {
            const { type, id } = req.params;
            const { rating, comentario, guestName, hasSpoiler, season, episode, title, avatarUrl } = req.body;
            const userId = req.user ? req.user.id : null;
            const username = req.user ? req.user.username : (guestName || 'Usuário Anônimo');

            const result = await authService.addMediaReview(userId, username, type, id, rating, comentario, hasSpoiler, {
                seasonNum: season,
                episodeNum: episode,
                mediaTitle: title,
                avatarUrl: avatarUrl
            });
            if (!result.success) return res.status(400).json(result);

            auditService.logEvent({
                identityType: userId ? 'registered' : 'anonymous',
                userId,
                eventType: 'RATING_SUBMITTED',
                source: 'website',
                mediaId: String(id),
                title: title || `${type} #${id}`,
                metadata: { rating, type, hasComment: !!comentario }
            }).catch(() => {});

            res.json(result);
        });

        this.app.delete('/api/media/comentarios/:reviewId', authService.userAuthMiddleware(true), async (req, res) => {
            const { reviewId } = req.params;
            const userId = req.user ? req.user.id : null;
            const isAdmin = req.user && req.user.role === 'admin';

            if (!userId && !isAdmin) {
                return res.status(401).json({ error: 'Faça login para gerenciar comentários.' });
            }

            const result = await authService.deleteMediaReview(reviewId, userId, isAdmin);
            if (!result.success) return res.status(400).json(result);
            res.json(result);
        });

        // Rota oficial de verificação de integridade e status
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });

        // Rota oficial de configuração do Stremio (compatível com botão "Configure" do aplicativo Stremio)
        this.app.get(['/configure', '/:userToken/configure'], (req, res) => {
            const configPath = path.resolve(__dirname, '../../public/configure.html');
            if (fs.existsSync(configPath)) {
                return res.sendFile(configPath);
            }
            this.renderLandingPage(req, res, req.params.userToken || 'public');
        });

        this.app.get('/:userToken', (req, res, next) => {
            const token = req.params.userToken;
            if (token.includes('.') || token === 'webhook' || token === 'stream' || token === 'install' || token === 'api' || token === 'admin' || token === 'configure' || token === 'assinar' || token === 'health' || token === 'filme' || token === 'serie' || token === 'assistir' || token === 'sala' || token === 'status' || token === 'fila' || token === 'catalogo' || token === 'robots.txt' || token === 'sitemap.xml') {
                return next();
            }
            this.renderLandingPage(req, res, token);
        });

        // 3. Protocolo Stremio v3 - Manifestos
        this.app.get('/manifest.json', (req, res) => {
            res.json(this.stremioService.getManifest('public'));
        });

        this.app.get('/:userToken/manifest.json', (req, res) => {
            const token = req.params.userToken;
            res.json(this.stremioService.getManifest(token));
        });

        // 4. Catalogo Stremio
        this.app.get(['/catalog/:type/:id.json', '/catalog/:type/:id/:extra.json'], (req, res) => {
            const { type, id, extra } = req.params;
            const parsedExtra = extra ? this.parseExtra(extra) : {};
            res.json(this.stremioService.getCatalog(type, id, parsedExtra, 'public'));
        });

        this.app.get(['/:userToken/catalog/:type/:id.json', '/:userToken/catalog/:type/:id/:extra.json'], (req, res) => {
            const { userToken, type, id, extra } = req.params;
            const parsedExtra = extra ? this.parseExtra(extra) : {};
            res.json(this.stremioService.getCatalog(type, id, parsedExtra, userToken));
        });

        // 5. Metadados Stremio
        this.app.get('/meta/:type/:id.json', (req, res) => {
            const { type, id } = req.params;
            res.json(this.stremioService.getMeta(type, id, 'public'));
        });

        this.app.get('/:userToken/meta/:type/:id.json', (req, res) => {
            const { userToken, type, id } = req.params;
            res.json(this.stremioService.getMeta(type, id, userToken));
        });

        // 6. Streams Stremio
        this.app.get('/stream/:type/:id.json', async (req, res) => {
            const { type, id } = req.params;
            const baseUrl = this.getBaseUrl(req);
            const data = await this.stremioService.getStreams(type, id, 'public', baseUrl);

            // Log auditoria Stremio público
            const media = type === 'filme' ? this.catalogoManager?.buscarFilmePorId(id) : this.catalogoManager?.buscarSeriePorId(id);
            auditService.logEvent({
                identityType: 'anonymous',
                eventType: 'TITLE_OPENED',
                source: 'stremio',
                mediaId: String(id),
                title: media?.nome || `${type} #${id}`,
                metadata: { type, client: 'stremio' }
            }).catch(() => {});

            res.json(data);
        });

        this.app.get('/:userToken/stream/:type/:id.json', async (req, res) => {
            const { userToken, type, id } = req.params;
            const baseUrl = this.getBaseUrl(req);
            const data = await this.stremioService.getStreams(type, id, userToken, baseUrl);

            // Log auditoria Stremio com token/usuário
            const strToken = (userToken || '').toString().trim();
            const isTgNumeric = /^\d+$/.test(strToken);
            const tgId = isTgNumeric ? Number(strToken) : null;
            const media = type === 'filme' ? this.catalogoManager?.buscarFilmePorId(id) : this.catalogoManager?.buscarSeriePorId(id);
            auditService.logEvent({
                identityType: tgId ? 'telegram' : (strToken && strToken !== 'public' ? 'registered' : 'anonymous'),
                telegramId: tgId,
                visitorId: strToken !== 'public' ? strToken : null,
                eventType: 'TITLE_OPENED',
                source: 'stremio',
                mediaId: String(id),
                title: media?.nome || `${type} #${id}`,
                metadata: { type, userToken: strToken, client: 'stremio' }
            }).catch(() => {});

            res.json(data);
        });

        // 7. Streaming de Video sob demanda (HTTP Range / 206 Partial Content)
        this.app.get('/stream/video/:userToken/filme/:id/:audio', (req, res) => {
            this.handleStreamFilme(req, res);
        });

        this.app.get('/stream/video/:userToken/serie/:id/:season/:episode/:audio', (req, res) => {
            this.handleStreamSerie(req, res);
        });

        // 8. Webhook do Mercado Pago
        this.app.post('/webhook', async (req, res) => {
            try {
                const { data } = req.body;
                if (data && data.id) {
                    const resultado = await this.assinaturaManager.processarPagamento(data.id);
                    if (resultado.success) {
                        console.log('OK - MercadoPago Pagamento aprovado via Webhook:', resultado.assinatura.username);
                    }
                }
                res.status(200).send('OK');
            } catch (err) {
                console.error('Erro no webhook Mercado Pago:', err.message);
                res.status(500).send('Erro interno');
            }
        });

        // 9. Handler 404 para rotas e arquivos inexistentes
        this.app.use((req, res) => {
            res.status(404).json({ success: false, error: 'Rota não encontrada' });
        });
    }

    parseExtra(extraStr) {
        const extra = {};
        if (!extraStr) return extra;
        const pairs = extraStr.split('&');
        pairs.forEach(pair => {
            const [k, v] = pair.split('=');
            if (k && v) extra[decodeURIComponent(k)] = decodeURIComponent(v);
        });
        return extra;
    }

    async handleStreamFilme(req, res) {
        const { userToken, id, audio } = req.params;

        // 1. Resolve o filme no catálogo
        const filme = this.catalogoManager.buscarFilmePorId(id);
        if (!filme) {
            return res.status(404).send('Filme não encontrado no catálogo.');
        }

        // 2. Valida a versão de áudio solicitada e seu identificador de mídia estrito
        let versaoEscolhida = null;
        if (audio === 'legendado') {
            if (filme.versoes && Object.prototype.hasOwnProperty.call(filme.versoes, 'legendado')) {
                if (filme.versoes.legendado && CatalogoManager.isValidMediaIdentifier(filme.versoes.legendado.messageId, filme.versoes.legendado.fileId)) {
                    versaoEscolhida = filme.versoes.legendado;
                }
            } else if (filme.isLegendado && CatalogoManager.isValidMediaIdentifier(filme.messageId, filme.fileId)) {
                versaoEscolhida = { messageId: filme.messageId, fileId: filme.fileId };
            }
        } else if (audio === 'dublado') {
            if (filme.versoes && Object.prototype.hasOwnProperty.call(filme.versoes, 'dublado')) {
                if (filme.versoes.dublado && CatalogoManager.isValidMediaIdentifier(filme.versoes.dublado.messageId, filme.versoes.dublado.fileId)) {
                    versaoEscolhida = filme.versoes.dublado;
                }
            } else if (filme.isDublado && CatalogoManager.isValidMediaIdentifier(filme.messageId, filme.fileId)) {
                versaoEscolhida = { messageId: filme.messageId, fileId: filme.fileId };
            }
        } else {
            if (filme.versoes && Object.prototype.hasOwnProperty.call(filme.versoes, 'dublado')) {
                if (filme.versoes.dublado && CatalogoManager.isValidMediaIdentifier(filme.versoes.dublado.messageId, filme.versoes.dublado.fileId)) {
                    versaoEscolhida = filme.versoes.dublado;
                }
            } else if (filme.isDublado && CatalogoManager.isValidMediaIdentifier(filme.messageId, filme.fileId)) {
                versaoEscolhida = { messageId: filme.messageId, fileId: filme.fileId };
            }

            if (!versaoEscolhida) {
                if (filme.versoes && Object.prototype.hasOwnProperty.call(filme.versoes, 'legendado')) {
                    if (filme.versoes.legendado && CatalogoManager.isValidMediaIdentifier(filme.versoes.legendado.messageId, filme.versoes.legendado.fileId)) {
                        versaoEscolhida = filme.versoes.legendado;
                    }
                } else if (filme.isLegendado && CatalogoManager.isValidMediaIdentifier(filme.messageId, filme.fileId)) {
                    versaoEscolhida = { messageId: filme.messageId, fileId: filme.fileId };
                }
            }
        }

        if (!versaoEscolhida || !CatalogoManager.isValidMediaIdentifier(versaoEscolhida.messageId, versaoEscolhida.fileId)) {
            return res.status(404).send(`Versão ${audio || 'solicitada'} do filme não disponível.`);
        }

        // 3. APENAS após validação da mídia, verifica e consome cota gratuita
        const mediaKey = `filme_${filme.id}`;
        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        if (!auth.authorized) {
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(userToken, 'filme', mediaKey);
            if (!consumo.permitido) {
                return res.status(403).send('Limite gratuito semanal de 2 filmes atingido. Assine o VIP em https://brasilflix.kapsu.com.br/assinar para acesso ilimitado!');
            }
            if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
                await this.assinaturaManager.registrarStreamConsumido(userToken, 'filme', mediaKey);
            }
        }

        const rawMsgId = Number(versaoEscolhida.messageId);
        const hasValidMsgId = !isNaN(rawMsgId) && rawMsgId > 0;

        if (!hasValidMsgId) {
            return res.status(404).send('Mídia de vídeo sem messageId de armazenamento disponível para streaming.');
        }

        // Se houver Cloudflare Worker configurado e a mídia possuir fileId:
        // Primeiro valida via Telegram Storage para confirmar integridade e correspondência do fileId
        if (config.CLOUDFLARE_STREAM_URL && typeof versaoEscolhida.fileId === 'string' && versaoEscolhida.fileId.trim().length > 0) {
            const uploader = telegramUploader.getInstance();
            const msgInfo = await uploader.getStorageMessage(rawMsgId);
            if (msgInfo.status === 'ERROR') {
                return res.status(503).send('Serviço de streaming temporariamente indisponível.');
            }
            if (msgInfo.status === 'NOT_FOUND' || msgInfo.status === 'INVALID_MEDIA' || !msgInfo.doc) {
                this.autoHealMissingMedia(rawMsgId).catch(() => {});
                return res.status(404).send('Mídia de vídeo não encontrada no servidor de armazenamento.');
            }
            const verifiedFileId = msgInfo.docId || versaoEscolhida.fileId.trim();
            const cloudflareUrl = `${config.CLOUDFLARE_STREAM_URL.replace(/\/$/, '')}/?file_id=${encodeURIComponent(verifiedFileId)}`;
            return res.redirect(302, cloudflareUrl);
        }

        // 4. Registra sessão de reprodução na Auditoria para Stremio / TV
        const isInitialStreamFilme = !req.headers.range || req.headers.range.startsWith('bytes=0-');
        if (isInitialStreamFilme) {
            const strToken = (userToken || '').toString().trim();
            const isTgNumeric = /^\d+$/.test(strToken);
            const tgId = isTgNumeric ? Number(strToken) : null;
            const identityType = tgId ? 'telegram' : (strToken && strToken !== 'public' ? 'registered' : 'anonymous');
            const sessionId = `stremio_${tgId || strToken || 'anon'}_filme_${filme.id}_${Math.floor(Date.now() / 1800000)}`;

            auditService.recordPlaybackProgress({
                sessionId,
                identityType,
                telegramId: tgId,
                visitorId: strToken !== 'public' ? strToken : null,
                mediaId: String(filme.id),
                mediaType: 'filme',
                title: filme.nome,
                currentPosition: 1,
                duration: filme.duracao ? filme.duracao * 60 : 7200,
                platform: 'stremio',
                device: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 100) : 'Stremio TV'
            }).catch(() => {});
        }

        await this.streamTelegramMedia(req, res, { ...versaoEscolhida, messageId: rawMsgId });
    }

    async handleStreamSerie(req, res) {
        const { userToken, id, season, episode, audio } = req.params;
        const seasonNum = parseInt(season, 10);
        const epNum = parseInt(episode, 10);

        // 1. Resolve a série no catálogo
        const serie = this.catalogoManager.buscarSeriePorId(id);
        if (!serie) {
            return res.status(404).send('Série não encontrada no catálogo.');
        }

        // 2. Resolve a temporada (respeitando continuidade e ponto de entrada)
        const temporada = (serie.temporadas || []).find(t => t.numero === seasonNum);
        if (!temporada) {
            return res.status(404).send(`Temporada ${seasonNum} da série não encontrada ou indisponível.`);
        }

        // 3. Resolve o episódio na temporada (garantindo que não está em lacuna de continuidade)
        const ep = (temporada.episodios || []).find(e => e.numero === epNum);
        if (!ep) {
            return res.status(404).send(`Episódio S${seasonNum}E${epNum} não encontrado ou indisponível.`);
        }

        // 4. Valida a versão de áudio solicitada e seu identificador de mídia estrito
        let versaoEscolhida = null;
        if (audio === 'legendado') {
            if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'legendado')) {
                if (ep.versoes.legendado && CatalogoManager.isValidMediaIdentifier(ep.versoes.legendado.messageId, ep.versoes.legendado.fileId)) {
                    versaoEscolhida = ep.versoes.legendado;
                }
            } else if ((ep.isLegendado || ep.is_legendado) && CatalogoManager.isValidMediaIdentifier(ep.messageId, ep.fileId)) {
                versaoEscolhida = { messageId: ep.messageId, fileId: ep.fileId };
            }
        } else if (audio === 'dublado') {
            if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'dublado')) {
                if (ep.versoes.dublado && CatalogoManager.isValidMediaIdentifier(ep.versoes.dublado.messageId, ep.versoes.dublado.fileId)) {
                    versaoEscolhida = ep.versoes.dublado;
                }
            } else if ((ep.isDublado || ep.is_dublado) && CatalogoManager.isValidMediaIdentifier(ep.messageId, ep.fileId)) {
                versaoEscolhida = { messageId: ep.messageId, fileId: ep.fileId };
            }
        } else {
            if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'dublado')) {
                if (ep.versoes.dublado && CatalogoManager.isValidMediaIdentifier(ep.versoes.dublado.messageId, ep.versoes.dublado.fileId)) {
                    versaoEscolhida = ep.versoes.dublado;
                }
            } else if ((ep.isDublado || ep.is_dublado) && CatalogoManager.isValidMediaIdentifier(ep.messageId, ep.fileId)) {
                versaoEscolhida = { messageId: ep.messageId, fileId: ep.fileId };
            }

            if (!versaoEscolhida) {
                if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'legendado')) {
                    if (ep.versoes.legendado && CatalogoManager.isValidMediaIdentifier(ep.versoes.legendado.messageId, ep.versoes.legendado.fileId)) {
                        versaoEscolhida = ep.versoes.legendado;
                    }
                } else if ((ep.isLegendado || ep.is_legendado) && CatalogoManager.isValidMediaIdentifier(ep.messageId, ep.fileId)) {
                    versaoEscolhida = { messageId: ep.messageId, fileId: ep.fileId };
                }
            }
        }

        if (!versaoEscolhida || !CatalogoManager.isValidMediaIdentifier(versaoEscolhida.messageId, versaoEscolhida.fileId)) {
            return res.status(404).send(`Versão ${audio || 'solicitada'} do episódio S${seasonNum}E${epNum} não disponível.`);
        }

        // 5. APENAS após validação da mídia, verifica e consome cota gratuita
        const mediaKey = `serie_${serie.id}_s${seasonNum}_e${epNum}`;
        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        if (!auth.authorized) {
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(userToken, 'serie', mediaKey);
            if (!consumo.permitido) {
                return res.status(403).send('Limite gratuito semanal de 4 episódios atingido. Assine o VIP em https://brasilflix.kapsu.com.br/assinar para maratonar!');
            }
            if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
                await this.assinaturaManager.registrarStreamConsumido(userToken, 'serie', mediaKey);
            }
        }

        const rawMsgId = Number(versaoEscolhida.messageId);
        const hasValidMsgId = !isNaN(rawMsgId) && rawMsgId > 0;

        if (!hasValidMsgId) {
            return res.status(404).send('Mídia de vídeo sem messageId de armazenamento disponível para streaming.');
        }

        // Se houver Cloudflare Worker configurado e a mídia possuir fileId:
        // Primeiro valida via Telegram Storage para confirmar integridade e correspondência do fileId
        if (config.CLOUDFLARE_STREAM_URL && typeof versaoEscolhida.fileId === 'string' && versaoEscolhida.fileId.trim().length > 0) {
            const uploader = telegramUploader.getInstance();
            const msgInfo = await uploader.getStorageMessage(rawMsgId);
            if (msgInfo.status === 'ERROR') {
                return res.status(503).send('Serviço de streaming temporariamente indisponível.');
            }
            if (msgInfo.status === 'NOT_FOUND' || msgInfo.status === 'INVALID_MEDIA' || !msgInfo.doc) {
                this.autoHealMissingMedia(rawMsgId).catch(() => {});
                return res.status(404).send('Mídia de vídeo não encontrada no servidor de armazenamento.');
            }
            const verifiedFileId = msgInfo.docId || versaoEscolhida.fileId.trim();
            const cloudflareUrl = `${config.CLOUDFLARE_STREAM_URL.replace(/\/$/, '')}/?file_id=${encodeURIComponent(verifiedFileId)}`;
            return res.redirect(302, cloudflareUrl);
        }

        // 4. Registra sessão de reprodução na Auditoria para Stremio / TV
        const isInitialStreamSerie = !req.headers.range || req.headers.range.startsWith('bytes=0-');
        if (isInitialStreamSerie) {
            const strToken = (userToken || '').toString().trim();
            const isTgNumeric = /^\d+$/.test(strToken);
            const tgId = isTgNumeric ? Number(strToken) : null;
            const identityType = tgId ? 'telegram' : (strToken && strToken !== 'public' ? 'registered' : 'anonymous');
            const sessionId = `stremio_${tgId || strToken || 'anon'}_serie_${serie.id}_s${seasonNum}e${epNum}_${Math.floor(Date.now() / 1800000)}`;

            auditService.recordPlaybackProgress({
                sessionId,
                identityType,
                telegramId: tgId,
                visitorId: strToken !== 'public' ? strToken : null,
                mediaId: String(serie.id),
                mediaType: 'serie',
                title: `${serie.nome} (T${seasonNum}E${epNum})`,
                seasonNum,
                episodeNum: epNum,
                currentPosition: 1,
                duration: ep.duracao ? ep.duracao * 60 : 3000,
                platform: 'stremio',
                device: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 100) : 'Stremio TV'
            }).catch(() => {});
        }

        await this.streamTelegramMedia(req, res, { ...versaoEscolhida, messageId: rawMsgId });
    }

    async streamTelegramMedia(req, res, midia) {
        try {
            const uploader = telegramUploader.getInstance();
            const rawMsgId = Number(midia.messageId);

            if (isNaN(rawMsgId) || rawMsgId <= 0) {
                return res.status(404).send('Mídia de vídeo sem messageId de armazenamento válido.');
            }

            const msgInfo = await uploader.getStorageMessage(rawMsgId);

            if (msgInfo.status === 'ERROR') {
                return res.status(503).send('Serviço de streaming do Telegram temporariamente indisponível.');
            }

            if (msgInfo.status === 'NOT_FOUND' || msgInfo.status === 'INVALID_MEDIA' || !msgInfo.doc) {
                // Auto-healing ativado apenas para mídias confirmadamente ausentes ou corrompidas no Telegram
                this.autoHealMissingMedia(rawMsgId).catch(() => {});
                return res.status(404).send('Mídia de vídeo não encontrada no servidor de armazenamento.');
            }

            const doc = msgInfo.doc;
            const client = await uploader.getClient();

            const inputFileLocation = new Api.InputDocumentFileLocation({
                id: doc.id,
                accessHash: doc.accessHash,
                fileReference: doc.fileReference,
                thumbSize: ''
            });

            const totalSize = Number(doc.size);
            const mimeType = doc.mimeType || 'video/mp4';
            const range = req.headers.range;

            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                let end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

                if (isNaN(start) || start >= totalSize || start < 0) {
                    res.writeHead(416, {
                        'Content-Range': `bytes */${totalSize}`,
                        'Accept-Ranges': 'bytes'
                    });
                    return res.end();
                }

                if (isNaN(end) || end >= totalSize) {
                    end = totalSize - 1;
                }
                if (end < start) {
                    end = start;
                }

                const chunkSize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mimeType,
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });

                const downloadIter = client.iterDownload({
                    file: inputFileLocation,
                    offset: bigInt(start),
                    limit: chunkSize,
                    chunkSize: 512 * 1024,
                    dcId: doc.dcId
                });

                let isAborted = false;
                const onClose = () => {
                    isAborted = true;
                    try {
                        if (typeof downloadIter.return === 'function') downloadIter.return();
                    } catch (e) {}
                };
                req.on('close', onClose);

                try {
                    for await (const chunk of downloadIter) {
                        if (isAborted || res.writableEnded || res.destroyed) break;
                        const canContinue = res.write(chunk);
                        if (!canContinue && !res.writableEnded && !res.destroyed) {
                            await new Promise(resolve => res.once('drain', resolve));
                        }
                    }
                } catch (iterErr) {
                    if (!isAborted && !res.destroyed) {
                        console.warn('⚠️ Aviso durante iteração do stream de vídeo:', iterErr.message);
                    }
                } finally {
                    req.removeListener('close', onClose);
                    if (!res.writableEnded && !res.destroyed) {
                        res.end();
                    }
                }
            } else {
                res.writeHead(200, {
                    'Content-Length': totalSize,
                    'Content-Type': mimeType,
                    'Accept-Ranges': 'bytes',
                    'Cache-Control': 'no-cache, no-store, must-revalidate'
                });

                const downloadIter = client.iterDownload({
                    file: inputFileLocation,
                    chunkSize: 512 * 1024,
                    dcId: doc.dcId
                });

                let isAborted = false;
                const onClose = () => {
                    isAborted = true;
                    try {
                        if (typeof downloadIter.return === 'function') downloadIter.return();
                    } catch (e) {}
                };
                req.on('close', onClose);

                try {
                    for await (const chunk of downloadIter) {
                        if (isAborted || res.writableEnded || res.destroyed) break;
                        const canContinue = res.write(chunk);
                        if (!canContinue && !res.writableEnded && !res.destroyed) {
                            await new Promise(resolve => res.once('drain', resolve));
                        }
                    }
                } catch (iterErr) {
                    if (!isAborted && !res.destroyed) {
                        console.warn('⚠️ Aviso durante iteração do stream de vídeo:', iterErr.message);
                    }
                } finally {
                    req.removeListener('close', onClose);
                    if (!res.writableEnded && !res.destroyed) {
                        res.end();
                    }
                }
            }
        } catch (error) {
            console.error('Erro no streaming de vídeo Telegram:', error.message);
            if (!res.headersSent) {
                res.status(500).send('Erro ao transmitir vídeo.');
            }
        }
    }

    async autoHealMissingMedia(rawMsgId) {
        try {
            const msgId = Number(rawMsgId);
            if (isNaN(msgId) || msgId <= 0) return;

            console.warn(`🩺 [Auto-Healing] Invalidando versão ausente no PostgreSQL para messageId ${msgId}...`);

            // 1. Filmes
            const filmesRes = await db.query(`
                SELECT * FROM filmes 
                WHERE message_id = $1 
                   OR versoes->'dublado'->>'messageId' = $2 
                   OR versoes->'legendado'->>'messageId' = $2
            `, [msgId, String(msgId)]);
            for (const f of filmesRes.rows) {
                let versoes = f.versoes || {};
                if (typeof versoes === 'string') try { versoes = JSON.parse(versoes); } catch (e) {}

                if (versoes.dublado && String(versoes.dublado.messageId) === String(msgId)) {
                    versoes.dublado = null;
                }
                if (versoes.legendado && String(versoes.legendado.messageId) === String(msgId)) {
                    versoes.legendado = null;
                }

                const finalIsDub = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId));
                const finalIsLeg = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId));
                const primaryMessageId = versoes.dublado?.messageId || versoes.legendado?.messageId || null;
                const primaryFileId = versoes.dublado?.fileId || versoes.legendado?.fileId || null;
                const primaryAudio = (finalIsDub && finalIsLeg)
                    ? 'Dub/Leg (Dublado + Legendado)'
                    : (finalIsDub ? 'Dublado (Áudio PT-BR)' : (finalIsLeg ? 'Legendado (PT-BR)' : null));

                await db.query(`
                    UPDATE filmes SET 
                        versoes = $1, is_dublado = $2, is_legendado = $3, message_id = $4, file_id = $5, audio = $6, updated_at = NOW()
                    WHERE id = $7
                `, [JSON.stringify(versoes), finalIsDub, finalIsLeg, primaryMessageId, primaryFileId, primaryAudio, f.id]);
            }

            // 2. Episódios
            const epsRes = await db.query(`
                SELECT * FROM episodios 
                WHERE message_id = $1 
                   OR versoes->'dublado'->>'messageId' = $2 
                   OR versoes->'legendado'->>'messageId' = $2
            `, [msgId, String(msgId)]);
            const affectedSerieIds = new Set();
            for (const ep of epsRes.rows) {
                affectedSerieIds.add(ep.serie_id);
                let versoes = ep.versoes || {};
                if (typeof versoes === 'string') try { versoes = JSON.parse(versoes); } catch (e) {}

                if (versoes.dublado && Number(versoes.dublado.messageId) === msgId) {
                    versoes.dublado = null;
                }
                if (versoes.legendado && Number(versoes.legendado.messageId) === msgId) {
                    versoes.legendado = null;
                }

                const finalIsDub = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId));
                const finalIsLeg = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId));
                const primaryMessageId = versoes.dublado?.messageId || versoes.legendado?.messageId || null;
                const primaryFileId = versoes.dublado?.fileId || versoes.legendado?.fileId || null;
                const primaryAudio = (finalIsDub && finalIsLeg)
                    ? 'Dub/Leg (Dublado + Legendado)'
                    : (finalIsDub ? 'Dublado (Áudio PT-BR)' : (finalIsLeg ? 'Legendado (PT-BR)' : null));

                await db.query(`
                    UPDATE episodios SET 
                        versoes = $1, is_dublado = $2, is_legendado = $3, message_id = $4, file_id = $5, audio = $6
                    WHERE id = $7
                `, [JSON.stringify(versoes), finalIsDub, finalIsLeg, primaryMessageId, primaryFileId, primaryAudio, ep.id]);
            }

            // 3. Atualiza as estatísticas e flags de áudio das séries afetadas
            for (const sId of affectedSerieIds) {
                await db.query(`
                    UPDATE series SET 
                        total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1 AND (is_dublado = true OR is_legendado = true)),
                        total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1 AND (is_dublado = true OR is_legendado = true)),
                        is_dublado = COALESCE((SELECT bool_or(is_dublado) FROM episodios WHERE serie_id = $1), false),
                        is_legendado = COALESCE((SELECT bool_or(is_legendado) FROM episodios WHERE serie_id = $1), false),
                        updated_at = NOW()
                    WHERE id = $1
                `, [sId]);
            }

            // 4. Recarrega o catálogo em memória
            if (this.catalogoManager) {
                await this.catalogoManager.loadCatalogo();
            }
            console.log(`🩺 [Auto-Healing] Auto-correção concluída com sucesso para messageId ${msgId}.`);
        } catch (e) {
            console.error('❌ Erro no auto-healing:', e.message);
        }
    }

    renderLandingPage(req, res, userToken) {
        const indexPath = path.resolve(__dirname, '../../public/index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            res.setHeader('Content-Type', 'text/html');
            res.send('<h1>BrasilFlix Online</h1>');
        }
    }

    start() {
        return new Promise((resolve) => {
            try {
                this.server = this.app.listen(this.port, () => {
                    console.log(`🌐 [Web Server] Servidor BrasilFlix Web Dashboard + Stremio Addon rodando na porta ${this.port}!`);
                    console.log(`🚀 [Web Server] Dashboard Web acessível: http://localhost:${this.port}/`);
                    console.log(`📦 [Web Server] Addon Stremio ativo: http://localhost:${this.port}/manifest.json`);
                    resolve(this.server);
                });

                this.server.on('error', (err) => {
                    if (err.code === 'EADDRINUSE') {
                        console.warn(`⚠️ [Web Server] Porta ${this.port} já em uso. Mantendo conexão existente.`);
                        resolve(null);
                    } else {
                        console.error('❌ [Web Server] Erro ao iniciar servidor HTTP:', err.message);
                        resolve(null);
                    }
                });
            } catch (e) {
                console.error('❌ [Web Server] Exceção ao abrir porta HTTP:', e.message);
                resolve(null);
            }
        });
    }
}

module.exports = StremioServer;
