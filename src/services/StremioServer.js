const express = require('express');
const path = require('path');
const config = require('../../config');
const StremioService = require('./StremioService');
const telegramUploader = require('./TelegramUploader');

class StremioServer {
    constructor(catalogoManager, assinaturaManager, port = process.env.PORT || 3000) {
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
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
        const host = req.get('host');
        const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
        return `${protocol}://${host}`;
    }

    setupRoutes() {
        // 1. Página Web de Instalação e Boas-Vindas
        this.app.get('/', (req, res) => this.renderLandingPage(req, res, 'public'));
        this.app.get('/:userToken', (req, res, next) => {
            const token = req.params.userToken;
            if (token.endsWith('.json') || token === 'webhook' || token === 'stream' || token === 'install') {
                return next();
            }
            this.renderLandingPage(req, res, token);
        });

        // 2. Protocolo Stremio v3 - Manifestos
        this.app.get('/manifest.json', (req, res) => {
            res.json(this.stremioService.getManifest('public'));
        });

        this.app.get('/:userToken/manifest.json', (req, res) => {
            const token = req.params.userToken;
            res.json(this.stremioService.getManifest(token));
        });

        // 3. Catálogo
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

        // 4. Metadados
        this.app.get('/meta/:type/:id.json', (req, res) => {
            const { type, id } = req.params;
            res.json(this.stremioService.getMeta(type, id, 'public'));
        });

        this.app.get('/:userToken/meta/:type/:id.json', (req, res) => {
            const { userToken, type, id } = req.params;
            res.json(this.stremioService.getMeta(type, id, userToken));
        });

        // 5. Streams
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

        // 6. Streaming de Vídeo sob demanda (HTTP Range / 206 Partial Content)
        this.app.get('/stream/video/:userToken/filme/:id/:audio', (req, res) => {
            this.handleStreamFilme(req, res);
        });

        this.app.get('/stream/video/:userToken/serie/:id/:season/:episode/:audio', (req, res) => {
            this.handleStreamSerie(req, res);
        });

        // 7. Webhook do Mercado Pago (para rodar tudo na mesma porta)
        this.app.post('/webhook', async (req, res) => {
            try {
                const { data } = req.body;
                if (data && data.id) {
                    const resultado = await this.assinaturaManager.processarPagamento(data.id);
                    if (resultado.success) {
                        console.log('✅ [MercadoPago] Pagamento aprovado via Webhook:', resultado.assinatura.username);
                    }
                }
                res.status(200).send('OK');
            } catch (err) {
                console.error('❌ Erro no webhook Mercado Pago:', err.message);
                res.status(500).send('Erro interno');
            }
        });

        // Rota de status de saúde
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'online',
                service: 'BrasilFlix Stremio Addon Server',
                version: '1.2.0',
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

        const filme = this.catalogoManager.getItemPorId(parseInt(id, 10));
        if (!filme) return res.status(404).send('Filme não encontrado.');

        let messageId = filme.messageId;
        if (audio === 'legendado' && filme.versoes?.legendado?.messageId) {
            messageId = filme.versoes.legendado.messageId;
        } else if (audio === 'dublado' && filme.versoes?.dublado?.messageId) {
            messageId = filme.versoes.dublado.messageId;
        }

        if (!messageId) return res.status(404).send('Mídia de vídeo não disponível.');

        await this.streamTelegramMedia(req, res, messageId);
    }

    async handleStreamSerie(req, res) {
        const { userToken, id, season, episode, audio } = req.params;
        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        if (!auth.authorized) {
            return res.status(403).send('Acesso não autorizado ou assinatura expirada.');
        }

        const serie = this.catalogoManager.getItemPorId(parseInt(id, 10));
        if (!serie) return res.status(404).send('Série não encontrada.');

        const seasonNum = parseInt(season, 10);
        const epNum = parseInt(episode, 10);

        const temporada = (serie.temporadas || []).find(t => t.numero === seasonNum);
        const ep = temporada?.episodios?.find(e => e.numero === epNum);
        if (!ep) return res.status(404).send('Episódio não encontrado.');

        let messageId = ep.messageId;
        if (audio === 'legendado' && ep.versoes?.legendado?.messageId) {
            messageId = ep.versoes.legendado.messageId;
        } else if (audio === 'dublado' && ep.versoes?.dublado?.messageId) {
            messageId = ep.versoes.dublado.messageId;
        }

        if (!messageId) return res.status(404).send('Mídia de episódio não disponível.');

        await this.streamTelegramMedia(req, res, messageId);
    }

    async streamTelegramMedia(req, res, messageId) {
        try {
            const client = await telegramUploader.getClient();
            const channelPeer = await client.getInputEntity(config.STORAGE_GROUP_ID);

            const messages = await client.getMessages(channelPeer, { ids: [messageId] });
            const message = messages?.[0];

            if (!message || !message.media || !message.media.document) {
                return res.status(404).send('Arquivo de mídia não encontrado no armazenamento.');
            }

            const doc = message.media.document;
            const fileSize = Number(doc.size);
            const mimeType = doc.mimeType || 'video/mp4';

            const rangeHeader = req.headers.range;

            if (rangeHeader) {
                // Requisição com Range (Streaming / Seeking no player)
                const parts = rangeHeader.replace(/bytes=/, '').split('-');
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
                const chunkSize = (end - start) + 1;

                res.writeHead(206, {
                    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': chunkSize,
                    'Content-Type': mimeType
                });

                // Stream dos blocos do Telegram diretamente para o player
                const downloadIter = client.iterDownload({
                    file: doc,
                    offset: BigInt(start),
                    limit: chunkSize,
                    chunkSize: 512 * 1024 // Chunks de 512 KB
                });

                for await (const chunk of downloadIter) {
                    if (res.writableEnded || res.destroyed) break;
                    res.write(chunk);
                }
                res.end();
            } else {
                // Requisição sem Range
                res.writeHead(200, {
                    'Content-Length': fileSize,
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
            console.error('❌ Erro no streaming de vídeo Telegram:', error.message);
            if (!res.headersSent) {
                res.status(500).send('Erro ao transmitir vídeo.');
            }
        }
    }

    renderLandingPage(req, res, userToken) {
        const baseUrl = this.getBaseUrl(req);
        const manifestUrl = `${baseUrl}/${userToken}/manifest.json`;
        const stremioDeepLink = `stremio://${req.get('host')}/${userToken}/manifest.json`;
        const webStremioLink = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;

        const auth = this.assinaturaManager.verificarAcessoStremio(userToken);
        const stats = this.catalogoManager.getEstatisticas();

        const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BrasilFlix VIP • Stremio Addon</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; }
        body {
            background: #090d16;
            color: #f3f4f6;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
            background-image: radial-gradient(circle at top, rgba(239, 68, 68, 0.15) 0%, transparent 60%), radial-gradient(circle at bottom, rgba(59, 130, 246, 0.12) 0%, transparent 60%);
        }
        .card {
            background: rgba(17, 24, 39, 0.85);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 24px;
            padding: 40px;
            max-width: 580px;
            width: 100%;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
        }
        .logo {
            font-size: 32px;
            font-weight: 800;
            background: linear-gradient(135deg, #ef4444 0%, #f97316 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            margin-bottom: 8px;
            letter-spacing: -0.5px;
        }
        .badge {
            display: inline-block;
            background: rgba(239, 68, 68, 0.2);
            color: #f87171;
            padding: 4px 12px;
            border-radius: 9999px;
            font-size: 13px;
            font-weight: 700;
            margin-bottom: 20px;
            border: 1px solid rgba(239, 68, 68, 0.3);
        }
        .stats {
            display: flex;
            justify-content: space-around;
            background: rgba(31, 41, 55, 0.6);
            border-radius: 16px;
            padding: 16px;
            margin: 24px 0;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }
        .stat-item h4 { font-size: 20px; color: #fff; font-weight: 800; }
        .stat-item p { font-size: 12px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
        .btn-group { display: flex; flex-direction: column; gap: 12px; margin-top: 28px; }
        .btn {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            padding: 16px 24px;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 700;
            text-decoration: none;
            transition: all 0.2s ease;
            cursor: pointer;
        }
        .btn-primary {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            color: white;
            box-shadow: 0 10px 25px -5px rgba(239, 68, 68, 0.5);
        }
        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 15px 30px -5px rgba(239, 68, 68, 0.6);
        }
        .btn-secondary {
            background: rgba(31, 41, 55, 0.8);
            color: #e5e7eb;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .btn-secondary:hover {
            background: rgba(55, 65, 81, 0.9);
            color: white;
        }
        .manifest-box {
            background: #030712;
            border-radius: 12px;
            padding: 12px 16px;
            margin-top: 24px;
            font-family: monospace;
            font-size: 12px;
            color: #9ca3af;
            word-break: break-all;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            border: 1px solid rgba(255, 255, 255, 0.08);
        }
        .user-status {
            padding: 8px 16px;
            border-radius: 10px;
            font-size: 13px;
            margin-bottom: 12px;
        }
        .status-ok { background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.25); }
        .status-warn { background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.25); }
    </style>
</head>
<body>
    <div class="card">
        <div class="logo">🍿 BRASILFLIX VIP</div>
        <div class="badge">OFFICIAL STREMIO ADDON v1.2</div>

        <div class="user-status ${auth.authorized ? 'status-ok' : 'status-warn'}">
            ${auth.authorized ? `✨ Conectado como: <b>${auth.user}</b> (${auth.plano === 'vitalicio' ? 'Acesso Vitalício 👑' : 'VIP Ativo 💎'})` : '⚠️ Acesso Público • Solicite seu link VIP com o Admin para liberar reprodução'}
        </div>

        <p style="color: #9ca3af; font-size: 14px; line-height: 1.6;">
            Assista a todo o catálogo em <b>1080p Full HD</b> diretamente na sua <b>Smart TV, TV Box, Computador ou Celular</b> pelo Stremio com áudio Dublado e Legendado!
        </p>

        <div class="stats">
            <div class="stat-item">
                <h4>${stats.totalFilmes}</h4>
                <p>Filmes</p>
            </div>
            <div class="stat-item">
                <h4>${stats.totalSeries}</h4>
                <p>Séries</p>
            </div>
            <div class="stat-item">
                <h4>1080p</h4>
                <p>Full HD</p>
            </div>
        </div>

        <div class="btn-group">
            <a href="${stremioDeepLink}" class="btn btn-primary">
                🚀 Instalar no App Stremio
            </a>
            <a href="${webStremioLink}" target="_blank" class="btn btn-secondary">
                🌐 Abrir no Stremio Web
            </a>
        </div>

        <div class="manifest-box">
            <span>${manifestUrl}</span>
            <button onclick="navigator.clipboard.writeText('${manifestUrl}'); alert('Link copiado!');" style="background: #374151; border: none; color: white; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">Copiar</button>
        </div>
    </div>
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(html);
    }

    start() {
        this.app.listen(this.port, () => {
            console.log(`🌐 Servidor Stremio Addon + Webhook rodando com sucesso na porta ${this.port}!`);
            console.log(`📺 URL do Addon: http://localhost:${this.port}/manifest.json`);
        });
    }
}

module.exports = StremioServer;
