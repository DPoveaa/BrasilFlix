const fs = require('fs-extra');
const config = require('../../config');
const db = require('../database/db');

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
                data: p.created_at,
                status: p.processado ? 'adicionado' : 'pendente',
                isAssinante: p.is_assinante,
                prioridade: p.is_assinante ? 'alta' : 'normal'
            }));

            this.pedidosPendentes.clear();
            this.pedidos.forEach(p => {
                if (p.status === 'pendente') {
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
        const id = `ped_${Date.now()}`;
        const pedido = {
            id: id,
            userId,
            username: username || 'Usuário',
            nome: nome.trim(),
            descricao: descricao.trim(),
            data: new Date().toISOString(),
            status: 'pendente',
            isAssinante,
            prioridade: isAssinante ? 'alta' : 'normal'
        };

        try {
            await db.query(`
                INSERT INTO pedidos (id, user_id, username, nome, tipo, is_assinante, processado, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            `, [
                id, userId, username || 'Usuário', nome.trim(),
                'filme', isAssinante, false
            ]);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir pedido no PostgreSQL:', e.message);
        }

        this.pedidos.push(pedido);
        this.pedidosPendentes.set(pedido.id, pedido);
        this.ordenarPedidos();
        this.savePedidos();

        console.log(`📝 Novo pedido registrado: ${nome} por ${username} ${isAssinante ? '(Assinante VIP)' : ''}`);
        return pedido;
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
                await db.query(`UPDATE pedidos SET processado = true WHERE id = $1`, [pedido.id]);
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
}

module.exports = PedidosManager;