const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const config = require('../../config');
const StremioService = require('./StremioService');
const telegramUploader = require('./TelegramUploader');

class StremioServer {
    constructor(catalogoManager, assinaturaManager, queueManager = null, port = config.STREMIO_PORT || 7000) {
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
        this.queueManager = queueManager;
        this.stremioService = new StremioService(catalogoManager, assinaturaManager);
        this.port = port;
        this.app = express();
        this.setupMiddlewares();
        this.setupRoutes();
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

        // 2. Dashboard Web e Rotas de Navegacao
        this.app.get('/', (req, res) => this.renderLandingPage(req, res, 'public'));
        this.app.get(['/status', '/fila', '/catalogo'], (req, res) => this.renderLandingPage(req, res, 'public'));

        this.app.get('/:userToken', (req, res, next) => {
            const token = req.params.userToken;
            if (token.endsWith('.json') || token === 'webhook' || token === 'stream' || token === 'install' || token === 'api') {
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
            return res.status(403).send('Acesso não autorizado ou assinatura expirada.');
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
            return res.status(403).send('Acesso não autorizado ou assinatura expirada.');
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
