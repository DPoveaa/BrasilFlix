const fs = require('fs-extra');
const config = require('../../config');
const db = require('../database/db');
const { randomUUID } = require('node:crypto');
const auditService = require('../services/AuditService');

class PedidosManager {
    constructor() {
        this.pedidos = [];
        this.pedidosPendentes = new Map();
        this.ensureDataDirectory();
        this.loadPedidos();
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
    }

    async loadPedidos() {
        try {
            const res = await db.query(`SELECT * FROM pedidos ORDER BY created_at ASC`);
            this.pedidos = res.rows.map(p => ({
                id: p.id,
                userId: p.user_id ? Number(p.user_id) : 0,
                username: p.username || 'Usuário',
                nome: p.nome,
                tipo: p.tipo || 'filme',
                temporada: p.temporada || '',
                idioma: p.idioma || '',
                tmdbId: p.tmdb_id || null,
                posterUrl: p.poster_url || '',
                ano: p.ano || '',
                detalhes: p.detalhes || '',
                data: p.created_at,
                status: p.status || (p.processado ? 'adicionado' : 'pendente'),
                processado: p.status === 'adicionado',
                isAssinante: p.is_assinante,
                prioridade: p.is_assinante ? 'alta' : 'normal'
            }));

            this.pedidosPendentes.clear();
            this.pedidos.forEach(p => {
                if (p.status === 'pendente' || p.status === 'em_processamento') {
                    this.pedidosPendentes.set(p.id, p);
                }
            });

            console.log(`📋 Carregados ${this.pedidos.length} pedidos do PostgreSQL`);
        } catch (error) {
            console.error('❌ Erro ao carregar pedidos do PostgreSQL:', error.message);
            if (fs.existsSync(config.PEDIDOS_FILE)) {
                try {
                    this.pedidos = fs.readJsonSync(config.PEDIDOS_FILE);
                    this.pedidos.forEach(p => {
                        if (p.status === 'pendente') this.pedidosPendentes.set(p.id, p);
                    });
                } catch (e) {}
            }
        }
    }

    async savePedidos() {
        try {
            fs.writeJsonSync(config.PEDIDOS_FILE, this.pedidos, { spaces: 2 });
        } catch (e) {}
    }

    async adicionarPedido(userId, username, nome, descricao = '', isAssinante = false) {
        return this.adicionarPedidoCompleto({
            userId,
            username,
            nome,
            tipo: 'filme',
            detalhes: descricao,
            isAssinante
        });
    }

    async adicionarPedidoCompleto({ userId, username, nome, tipo = 'filme', temporada = '', idioma = '', tmdbId = null, posterUrl = '', ano = '', detalhes = '', isAssinante = false }, client = null, { deferCache = false } = {}) {
        const id = `ped_${randomUUID()}`;
        const pedido = {
            id,
            userId: userId ? Number(userId) : 0,
            username: username || 'Usuário',
            nome: (nome || '').trim(),
            tipo: tipo || 'filme',
            temporada: (temporada || '').trim(),
            idioma: (idioma || '').trim(),
            tmdbId: tmdbId ? Number(tmdbId) : null,
            posterUrl: (posterUrl || '').trim(),
            ano: (ano || '').trim(),
            detalhes: (detalhes || '').trim(),
            data: new Date().toISOString(),
            status: 'pendente',
            processado: false,
            isAssinante: !!isAssinante,
            prioridade: isAssinante ? 'alta' : 'normal'
        };

        try {
            await (client || db).query(`
                INSERT INTO pedidos (id, user_id, username, nome, tipo, temporada, idioma, tmdb_id, poster_url, ano, detalhes, is_assinante, processado, status, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
            `, [
                id, pedido.userId, pedido.username, pedido.nome,
                pedido.tipo, pedido.temporada, pedido.idioma, pedido.tmdbId,
                pedido.posterUrl, pedido.ano, pedido.detalhes, pedido.isAssinante, false, 'pendente'
            ]);
        } catch (e) {
            if (client) throw e;
            console.warn('⚠️ Erro ao persistir pedido no PostgreSQL:', e.message);
        }

        if (!deferCache) this.rememberPedido(pedido);
        return pedido;
    }

    rememberPedido(pedido, backup = true) {
        this.pedidos.push(pedido);
        this.pedidosPendentes.set(pedido.id, pedido);
        this.ordenarPedidos();
        if (backup) this.savePedidos();
        console.log(`📝 Novo pedido registrado: [${pedido.tipo.toUpperCase()}] ${pedido.nome} por ${pedido.username} ${pedido.isAssinante ? '(Assinante VIP)' : ''}`);
    }

    async getRequestAvailability(items, client = db) {
        if (!items.length) return [];
        const { rows } = await client.query(`
            WITH wanted AS (
                SELECT * FROM jsonb_to_recordset($1::jsonb) AS w(n integer, id integer, kind text, name text)
            ), existing AS (
                SELECT tmdb_id, 'filme' AS kind, nome AS title, 'catalog' AS state FROM filmes
                UNION ALL SELECT tmdb_id, 'serie', nome, 'catalog' FROM series
                UNION ALL SELECT tmdb_id, CASE WHEN type = 'filme' THEN 'filme' ELSE 'serie' END, title, 'queued'
                    FROM queue_jobs WHERE status IN ('queued', 'pending', 'searching', 'processing', 'downloading', 'uploading')
                UNION ALL SELECT tmdb_id, CASE WHEN tipo = 'filme' THEN 'filme' ELSE 'serie' END, nome, 'queued'
                    FROM pedidos WHERE status IN ('pendente', 'em_processamento') AND NOT COALESCE(processado, false)
            )
            SELECT w.n, CASE WHEN bool_or(e.state = 'catalog') THEN 'catalog'
                             WHEN bool_or(e.state = 'queued') THEN 'queued' ELSE NULL END AS state
            FROM wanted w LEFT JOIN existing e ON e.kind = w.kind AND
                ((w.id IS NOT NULL AND e.tmdb_id IS NOT NULL AND w.id = e.tmdb_id) OR
                ((w.id IS NULL OR e.tmdb_id IS NULL) AND lower(btrim(e.title)) = lower(btrim(w.name))))
            GROUP BY w.n ORDER BY w.n
        `, [JSON.stringify(items.map((item, n) => ({
            n, id: Number(item.tmdbId || item.tmdb_id) || null,
            kind: !item.tipo || item.tipo === 'filme' ? 'filme' : 'serie', name: item.nome
        })))]);
        return rows.map(row => row.state);
    }

    async addAvailableWebRequest(item) {
        const client = await db.getPool().connect();
        try {
            // Serializa a checagem e a inclusão mesmo quando há mais de um processo web.
            await client.query('SELECT pg_advisory_lock(18489, 1)');
            const [status] = await this.getRequestAvailability([item], client);
            if (status) return { status };
            return { pedido: await this.adicionarPedidoCompleto(item, client) };
        } finally {
            try {
                await client.query('SELECT pg_advisory_unlock(18489, 1)');
                client.release();
            } catch (error) {
                client.release(error);
            }
        }
    }

    async enqueueWebRequestBatch(id, items) {
        await db.query('INSERT INTO web_request_batches (id, items) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING',
            [id, JSON.stringify(items)]);
        return this.getWebRequestBatch(id);
    }

    async getWebRequestBatch(id) {
        const { rows } = await db.query(`
            SELECT id, jsonb_array_length(items) AS total, processed,
                   created_count AS created, skipped_count AS skipped,
                   retry_at > NOW() AS waiting
            FROM web_request_batches WHERE id = $1
        `, [id]);
        return rows[0] || null;
    }

    async processWebRequestBatches() {
        if (this.processingWebBatches) return;
        this.processingWebBatches = true;
        try {
            for (let index = 0; index < 25; index++) {
                const client = await db.getPool().connect();
                let batch;
                try {
                    await client.query('BEGIN');
                    const { rows } = await client.query(`
                        SELECT id, items->processed AS item FROM web_request_batches
                        WHERE processed < jsonb_array_length(items) AND retry_at <= NOW()
                        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
                    `);
                    batch = rows[0];
                    if (!batch) {
                        await client.query('COMMIT');
                        return;
                    }
                    await client.query('SELECT pg_advisory_xact_lock(18489, 1)');
                    const [status] = await this.getRequestAvailability([batch.item], client);
                    if (!status) batch.pedido = await this.adicionarPedidoCompleto(batch.item, client, { deferCache: true });
                    await client.query(`
                        UPDATE web_request_batches SET processed = processed + 1,
                            created_count = created_count + $2, skipped_count = skipped_count + $3
                        WHERE id = $1
                    `, [batch.id, status ? 0 : 1, status ? 1 : 0]);
                    await client.query('COMMIT');
                    if (batch.pedido) {
                        const pedido = batch.pedido;
                        this.rememberPedido(pedido, false);
                        auditService.logEvent({
                            identityType: pedido.userId ? 'registered' : 'anonymous',
                            userId: pedido.userId || null,
                            eventType: 'REQUEST_CREATED',
                            source: 'website',
                            title: pedido.nome,
                            metadata: { tipo: pedido.tipo, ano: pedido.ano, idioma: pedido.idioma }
                        }).catch(() => {});
                    }
                } catch (error) {
                    await client.query('ROLLBACK').catch(() => {});
                    if (batch) await client.query("UPDATE web_request_batches SET retry_at = NOW() + INTERVAL '30 seconds' WHERE id = $1", [batch.id]);
                    throw error;
                } finally {
                    client.release();
                }
            }
        } finally {
            this.processingWebBatches = false;
        }
    }

    async atualizarStatus(pedidoId, novoStatus) {
        const pedido = this.pedidos.find(p => String(p.id) === String(pedidoId));
        if (pedido) {
            pedido.status = novoStatus;
            pedido.processado = novoStatus === 'adicionado';
            if (novoStatus === 'pendente' || novoStatus === 'em_processamento') {
                this.pedidosPendentes.set(pedido.id, pedido);
            } else {
                this.pedidosPendentes.delete(pedido.id);
            }

            try {
                await db.query(`UPDATE pedidos SET status = $1, processado = $2 WHERE id = $3`, [novoStatus, pedido.processado, pedido.id]);
            } catch (e) {
                console.warn('⚠️ Erro ao atualizar status do pedido no PostgreSQL:', e.message);
            }

            this.savePedidos();
            return true;
        }
        return false;
    }

    ordenarPedidos() {
        this.pedidos.sort((a, b) => {
            if (a.prioridade === 'alta' && b.prioridade !== 'alta') return -1;
            if (a.prioridade !== 'alta' && b.prioridade === 'alta') return 1;
            return new Date(a.data) - new Date(b.data);
        });
    }

    getPedidos() {
        return this.pedidos;
    }

    getPedidosPendentes() {
        return Array.from(this.pedidosPendentes.values());
    }

    async marcarComoAdicionado(pedidoId) {
        return this.marcarComoProcessado(pedidoId);
    }

    async marcarComoProcessado(pedidoId) {
        const pedido = this.pedidos.find(p => String(p.id) === String(pedidoId));
        if (pedido) {
            pedido.status = 'adicionado';
            pedido.processado = true;
            pedido.dataAdicionado = new Date().toISOString();
            this.pedidosPendentes.delete(pedido.id);

            try {
                await db.query(`UPDATE pedidos SET status = 'adicionado', processado = true WHERE id = $1`, [pedido.id]);
            } catch (e) {
                console.warn('⚠️ Erro ao atualizar pedido no PostgreSQL:', e.message);
            }

            this.savePedidos();
            console.log(`✅ Pedido marcado como processado: ${pedido.nome}`);
            return true;
        }
        return false;
    }

    async removerPedido(pedidoId) {
        const index = this.pedidos.findIndex(p => String(p.id) === String(pedidoId));
        if (index !== -1) {
            const pedido = this.pedidos[index];
            this.pedidos.splice(index, 1);
            this.pedidosPendentes.delete(pedido.id);

            try {
                await db.query(`DELETE FROM pedidos WHERE id = $1`, [pedido.id]);
            } catch (e) {
                console.warn('⚠️ Erro ao deletar pedido no PostgreSQL:', e.message);
            }

            this.savePedidos();
            console.log(`🗑️ Pedido removido: ${pedido.nome}`);
            return true;
        }
        return false;
    }

    getPedidosPorUsuario(userId) {
        return this.pedidos.filter(pedido => pedido.userId === userId);
    }

    getPedidoPorId(pedidoId) {
        return this.pedidos.find(pedido => String(pedido.id) === String(pedidoId));
    }

    formatarPedidosParaAdmin() {
        if (this.pedidos.length === 0) {
            return '📝 Nenhum pedido encontrado.';
        }

        let mensagem = '📝 *Lista de Pedidos:*\n\n';
        const total = this.pedidos.length;
        const pendentes = this.pedidosPendentes.size;
        const adicionados = this.pedidos.filter(p => p.status === 'adicionado').length;
        const assinantes = this.pedidos.filter(p => p.isAssinante).length;
        
        mensagem += `📊 *Estatísticas:*\n`;
        mensagem += `• Total: ${total}\n`;
        mensagem += `• Pendentes: ${pendentes}\n`;
        mensagem += `• Adicionados: ${adicionados}\n`;
        mensagem += `• Assinantes: ${assinantes}\n\n`;
        
        const ultimos = this.pedidos.slice(-30).reverse();
        ultimos.forEach((pedido, index) => {
            const status = pedido.status === 'pendente' ? '⏳' : '✅';
            const data = new Date(pedido.data).toLocaleDateString('pt-BR');
            const prioridade = pedido.isAssinante ? '🔥 ASSINANTE' : '👤 Usuário';
            
            mensagem += `${status} *${index + 1}.* ${pedido.nome}\n`;
            mensagem += `${prioridade} - ${pedido.username}\n`;
            mensagem += `📅 ${data} | 🆔 \`${pedido.id}\`\n\n`;
        });

        return mensagem;
    }

    /**
     * Reavalia de forma segura pedidos marcados como concluídos/atendidos contra o estado real do catálogo.
     * Caso os entregáveis solicitados não estejam genuinamente disponíveis (ex: Stitch com pedido Dual Áudio,
     * onde apenas a versão Legendada existe), reabre o pedido com status 'em_processamento', preservando
     * rigorosamente ID, usuário solicitante e histórico.
     *
     * @param {Object} catalogoManager
     * @param {Object} options { pedidoId = null }
     * @returns {Promise<{ success: boolean, totalAvaliados: number, reabertos: Array }>}
     */
    async reavaliarPedidosAtendidos(catalogoManager, { pedidoId = null } = {}) {
        if (!catalogoManager) {
            return { success: false, error: 'catalogoManager não fornecido' };
        }

        const candidatos = this.pedidos.filter(p => {
            if (pedidoId && String(p.id) !== String(pedidoId)) return false;
            return p.status === 'adicionado' || p.processado;
        });

        const reabertos = [];

        for (const p of candidatos) {
            const check = catalogoManager.verificarAtendimentoPedido(p);
            if (!check.fulfilled) {
                console.log(`🔄 [REABRIR PEDIDO] Pedido "${p.nome}" (ID: ${p.id}) [${p.idioma || 'padrão'}] reaberto: ${check.reason}`);
                p.status = 'em_processamento';
                p.processado = false;
                delete p.dataAdicionado;
                this.pedidosPendentes.set(p.id, p);

                try {
                    await db.query(`UPDATE pedidos SET status = 'em_processamento', processado = false WHERE id = $1`, [p.id]);
                } catch (e) {
                    console.warn(`⚠️ Erro ao atualizar status do pedido ${p.id} no PostgreSQL:`, e.message);
                }

                reabertos.push({
                    id: p.id,
                    nome: p.nome,
                    idioma: p.idioma,
                    motivo: check.reason,
                    missingAudio: check.missingAudio
                });
            }
        }

        if (reabertos.length > 0) {
            this.savePedidos();
        }

        return {
            success: true,
            totalAvaliados: candidatos.length,
            totalReabertos: reabertos.length,
            reabertos
        };
    }
}

module.exports = PedidosManager;
