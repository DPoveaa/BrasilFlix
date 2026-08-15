const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const StremioService = require('./StremioService');
const telegramUploader = require('./TelegramUploader');
const authService = require('./AuthService');
const db = require('../database/db');

class StremioServer {
    constructor(catalogoManager, assinaturaManager, queueManager = null, pedidosManager = null, port = config.STREMIO_PORT || 7000) {
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
        this.queueManager = queueManager;
        this.pedidosManager = pedidosManager;
        this.stremioService = new StremioService(catalogoManager, assinaturaManager);
        this.port = port;
        this.app = express();
        this.setupMiddlewares();
        this.setupRoutes();
        authService.initAdminUser().catch(() => {});
    }

    setupMiddlewares() {
        this.app.use(express.json());

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
        // 1. APIs Publicas Seguras (Zero dados sensiveis)
        this.app.get('/api/status', (req, res) => {
            const queueStatus = this.queueManager ? this.queueManager.getPublicStatus() : { isProcessing: false, activeTask: null, queue: [], recentCompleted: [], totalQueued: 0 };
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
            const queueStatus = this.queueManager ? this.queueManager.getPublicStatus() : { isProcessing: false, activeTask: null, queue: [], recentCompleted: [], totalQueued: 0 };
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

        this.app.delete('/api/admin/queue/:id', auth, async (req, res) => {
            try {
                const result = await this.queueManager.cancelJob(req.params.id);
                res.json(result);
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

        this.app.post('/api/admin/pedidos/:id/enfileirar', auth, async (req, res) => {
            try {
                const pedido = this.pedidosManager?.getPedidoPorId(req.params.id);
                if (!pedido) return res.status(404).json({ error: 'Pedido não encontrado.' });

                const priority = req.body.priority || (pedido.isAssinante ? 1 : 2);
                this.queueManager.addJob(pedido.nome, pedido.tipo || 'filme', parseInt(priority, 10), {
                    userId: pedido.userId,
                    username: pedido.username
                });

                await this.pedidosManager.marcarComoProcessado(pedido.id);
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

        // 6. Gerenciamento do Catálogo
        this.app.get('/api/admin/catalogo', auth, (req, res) => {
            try {
                res.json(this.catalogoManager?.catalogo || { filmes: [], series: [] });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/filme/:id', auth, async (req, res) => {
            try {
                const filme = this.catalogoManager?.buscarFilmePorId(req.params.id);
                await this.catalogoManager?.removerItem(req.params.id);

                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;
                if (rebaixar && filme && this.queueManager) {
                    this.queueManager.addJob(filme.nome, 'filme', 1, {
                        audioPreference: filme.isDublado ? 'dublado' : 'legendado',
                        isUpgrade: true
                    });
                }

                res.json({ 
                    success: true, 
                    message: rebaixar 
                        ? `Filme "${filme?.nome || req.params.id}" excluído do Armazém e reenfileirado para download com Prioridade 1!` 
                        : 'Filme removido do catálogo e apagado do Armazém.' 
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/serie/:id', auth, async (req, res) => {
            try {
                const serie = this.catalogoManager?.buscarSeriePorId(req.params.id);
                await this.catalogoManager?.removerItem(req.params.id);

                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;
                if (rebaixar && serie && this.queueManager) {
                    for (const temp of (serie.temporadas || [])) {
                        for (const ep of (temp.episodios || [])) {
                            this.queueManager.addJob(serie.nome, 'serie', 1, {
                                season: temp.numero || 1,
                                episode: ep.numero || 1,
                                audioPreference: ep.isDublado ? 'dublado' : 'legendado'
                            });
                        }
                    }
                }

                res.json({ 
                    success: true, 
                    message: rebaixar 
                        ? `Série "${serie?.nome || req.params.id}" excluída do Armazém e episódios reenfileirados com Prioridade 1!` 
                        : 'Série removida do catálogo e apagada do Armazém.' 
                });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        this.app.delete('/api/admin/catalogo/episodio/:id', auth, async (req, res) => {
            try {
                const epId = req.params.id;
                const epQuery = await db.query(`
                    SELECT e.*, s.nome as serie_nome 
                    FROM episodios e 
                    LEFT JOIN series s ON s.id = e.serie_id 
                    WHERE e.id = $1 OR e.message_id = $1
                `, [Number(epId) || 0]);

                const epInfo = epQuery.rows[0] || null;

                await this.catalogoManager?.removerEpisodio(epId);

                const rebaixar = req.query.rebaixar === 'true' || req.body?.rebaixar === true;
                if (rebaixar && epInfo && this.queueManager) {
                    this.queueManager.addJob(epInfo.serie_nome || 'Série', 'serie', 1, {
                        season: epInfo.temporada_numero || 1,
                        episode: epInfo.numero || 1,
                        audioPreference: epInfo.is_dublado ? 'dublado' : 'legendado'
                    });
                }

                res.json({ 
                    success: true, 
                    message: rebaixar 
                        ? `Episódio ${epInfo ? `T${epInfo.temporada_numero}E${epInfo.numero}` : ''} excluído do Armazém e reenfileirado para download com Prioridade 1!` 
                        : 'Episódio removido do catálogo e apagado do Armazém.' 
                });
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

        // ═══════════════════════════════════════════════════════════════════════

        // 2. Dashboard Web e Rotas de Navegacao
        this.app.get('/', (req, res) => this.renderLandingPage(req, res, 'public'));
        this.app.get(['/status', '/fila', '/catalogo', '/admin'], (req, res) => this.renderLandingPage(req, res, 'public'));

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

        this.app.get('/api/consumo/:token', async (req, res) => {
            try {
                const consumoFilme = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(req.params.token, 'filme');
                res.json({ success: true, consumo: consumoFilme });
            } catch (e) {
                res.status(500).json({ success: false, error: e.message });
            }
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
            if (token.endsWith('.json') || token === 'webhook' || token === 'stream' || token === 'install' || token === 'api' || token === 'admin' || token === 'configure' || token === 'assinar') {
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
        this.app.get('/stream/:type/:id.json', (req, res) => {
            const { type, id } = req.params;
            const baseUrl = this.getBaseUrl(req);
            res.json(this.stremioService.getStreams(type, id, 'public', baseUrl));
        });

        this.app.get('/:userToken/stream/:type/:id.json', (req, res) => {
            const { userToken, type, id } = req.params;
            const baseUrl = this.getBaseUrl(req);
            res.json(this.stremioService.getStreams(type, id, userToken, baseUrl));
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

        // Rota de status de saude
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'online',
                service: 'BrasilFlix Stremio Addon Server',
                version: '2.0.0',
                uptime: process.uptime()
            });
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
        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        if (!auth.authorized) {
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(userToken, 'filme');
            if (!consumo.permitido) {
                return res.status(403).send('Limite gratuito de 1 filme por mês atingido. Assine o VIP em https://brasilflix.kapsu.com.br/assinar para maratonar!');
            }
            if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
                await this.assinaturaManager.registrarStreamConsumido(userToken, 'filme');
            }
        }

        const filme = this.catalogoManager.buscarFilmePorId(id);
        if (!filme) {
            return res.status(404).send('Filme não encontrado no catálogo.');
        }

        let versaoEscolhida = null;
        if (audio === 'legendado' && filme.versoes?.legendado) {
            versaoEscolhida = filme.versoes.legendado;
        } else if (filme.versoes?.dublado) {
            versaoEscolhida = filme.versoes.dublado;
        } else {
            versaoEscolhida = { messageId: filme.messageId, fileId: filme.fileId };
        }

        if (!versaoEscolhida || (!versaoEscolhida.messageId && !versaoEscolhida.fileId)) {
            return res.status(404).send('Arquivo de mídia não disponível.');
        }

        await this.streamTelegramMedia(req, res, versaoEscolhida);
    }

    async handleStreamSerie(req, res) {
        const { userToken, id, season, episode, audio } = req.params;
        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        if (!auth.authorized) {
            const consumo = await this.assinaturaManager.verificarOuRegistrarConsumoGratis(userToken, 'serie');
            if (!consumo.permitido) {
                return res.status(403).send('Limite gratuito de 2 episódios por mês atingido. Assine o VIP em https://brasilflix.kapsu.com.br/assinar para maratonar!');
            }
            if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
                await this.assinaturaManager.registrarStreamConsumido(userToken, 'serie');
            }
        }

        const serie = this.catalogoManager.buscarSeriePorId(id);
        if (!serie) {
            return res.status(404).send('Série não encontrada no catálogo.');
        }

        const ep = this.catalogoManager.buscarEpisodio(id, parseInt(season, 10), parseInt(episode, 10));
        if (!ep) {
            return res.status(404).send(`Episódio S${season}E${episode} não encontrado.`);
        }

        let versaoEscolhida = null;
        if (audio === 'legendado' && ep.versoes?.legendado) {
            versaoEscolhida = ep.versoes.legendado;
        } else if (ep.versoes?.dublado) {
            versaoEscolhida = ep.versoes.dublado;
        } else {
            versaoEscolhida = { messageId: ep.messageId, fileId: ep.fileId };
        }

        if (!versaoEscolhida || (!versaoEscolhida.messageId && !versaoEscolhida.fileId)) {
            return res.status(404).send('Arquivo de mídia do episódio não disponível.');
        }

        await this.streamTelegramMedia(req, res, versaoEscolhida);
    }

    async streamTelegramMedia(req, res, midia) {
        try {
            const client = await telegramUploader.getClient();
            if (!client) {
                return res.status(503).send('Serviço de streaming do Telegram temporariamente indisponível.');
            }

            const storageChannel = config.STORAGE_GROUP_ID;
            let doc = null;

            if (midia.messageId) {
                try {
                    const messages = await client.getMessages(storageChannel, { ids: [midia.messageId] });
                    if (messages && messages.length > 0 && messages[0].media && messages[0].media.document) {
                        doc = messages[0].media.document;
                    }
                } catch (e) {
                    console.warn(`Aviso ao buscar mensagem ${midia.messageId}:`, e.message);
                }
            }

            if (!doc) {
                return res.status(404).send('Mídia de vídeo não encontrada no servidor de armazenamento.');
            }

            const totalSize = Number(doc.size);
            const mimeType = doc.mimeType || 'video/mp4';
            const range = req.headers.range;

            if (range) {
                const parts = range.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
                const chunkSize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${totalSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mimeType,
                    'Cache-Control': 'no-cache'
                });

                const downloadIter = client.iterDownload({
                    file: doc,
                    offset: BigInt(start),
                    limit: chunkSize,
                    chunkSize: 512 * 1024
                });

                for await (const chunk of downloadIter) {
                    if (res.writableEnded || res.destroyed) break;
                    res.write(chunk);
                }
                res.end();
            } else {
                res.writeHead(200, {
                    'Content-Length': totalSize,
                    'Content-Type': mimeType,
                    'Accept-Ranges': 'bytes'
                });

                const downloadIter = client.iterDownload({
                    file: doc,
                    chunkSize: 512 * 1024
                });

                for await (const chunk of downloadIter) {
                    if (res.writableEnded || res.destroyed) break;
                    res.write(chunk);
                }
                res.end();
            }
        } catch (error) {
            console.error('Erro no streaming de vídeo Telegram:', error.message);
            if (!res.headersSent) {
                res.status(500).send('Erro ao transmitir vídeo.');
            }
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
        this.app.listen(this.port, () => {
            console.log(`Servidor BrasilFlix Web Dashboard + Stremio Addon rodando na porta ${this.port}!`);
            console.log(`URL da Dashboard Web: http://localhost:${this.port}/`);
            console.log(`URL do Addon Stremio: http://localhost:${this.port}/manifest.json`);
        });
    }
}

module.exports = StremioServer;
