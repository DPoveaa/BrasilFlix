const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class PedidosManager {
    constructor() {
        this.pedidosFile = config.PEDIDOS_FILE;
        this.pedidos = []; // Armazenamento em memória
        this.pedidosPendentes = new Map(); // Cache rápido para pedidos pendentes
        this.ensureDataDirectory();
        this.loadPedidos();
        
        // Salvar pedidos periodicamente (a cada 5 minutos)
        setInterval(() => {
            this.savePedidos();
        }, 5 * 60 * 1000);
        
        // Salvar ao sair
        process.on('SIGINT', () => {
            this.savePedidos();
            process.exit(0);
        });
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
    }

    loadPedidos() {
        try {
            if (fs.existsSync(this.pedidosFile)) {
                this.pedidos = fs.readJsonSync(this.pedidosFile);
                // Reconstruir cache de pedidos pendentes
                this.pedidos.forEach(pedido => {
                    if (pedido.status === 'pendente') {
                        this.pedidosPendentes.set(pedido.id, pedido);
                    }
                });
                console.log(`📋 Carregados ${this.pedidos.length} pedidos do arquivo`);
            } else {
                this.pedidos = [];
                this.savePedidos();
                console.log('📋 Arquivo de pedidos criado');
            }
        } catch (error) {
            console.error('❌ Erro ao carregar pedidos:', error);
            this.pedidos = [];
        }
    }

    savePedidos() {
        try {
            fs.writeJsonSync(this.pedidosFile, this.pedidos, { spaces: 2 });
            console.log(`💾 ${this.pedidos.length} pedidos salvos`);
        } catch (error) {
            console.error('❌ Erro ao salvar pedidos:', error);
        }
    }

    adicionarPedido(userId, username, nome, descricao = '', isAssinante = false) {
        const pedido = {
            id: Date.now(),
            userId,
            username: username || 'Usuário',
            nome: nome.trim(),
            descricao: descricao.trim(),
            data: new Date().toISOString(),
            status: 'pendente',
            isAssinante,
            prioridade: isAssinante ? 'alta' : 'normal'
        };

        this.pedidos.push(pedido);
        
        // Adicionar ao cache de pendentes
        this.pedidosPendentes.set(pedido.id, pedido);
        
        this.ordenarPedidos();
        
        console.log(`📝 Novo pedido adicionado: ${nome} por ${username} ${isAssinante ? '(Assinante)' : ''}`);
        return pedido;
    }

    ordenarPedidos() {
        this.pedidos.sort((a, b) => {
            // Primeiro por prioridade (assinantes primeiro)
            if (a.prioridade === 'alta' && b.prioridade !== 'alta') return -1;
            if (a.prioridade !== 'alta' && b.prioridade === 'alta') return 1;
            
            // Depois por data (mais antigo primeiro)
            return new Date(a.data) - new Date(b.data);
        });
    }

    getPedidos() {
        return this.pedidos;
    }

    getPedidosPendentes() {
        // Usar cache em vez de filtrar toda a lista
        return Array.from(this.pedidosPendentes.values());
    }

    marcarComoAdicionado(pedidoId) {
        const pedido = this.pedidos.find(p => p.id === pedidoId);
        if (pedido) {
            pedido.status = 'adicionado';
            pedido.dataAdicionado = new Date().toISOString();
            
            // Remover do cache de pendentes
            this.pedidosPendentes.delete(pedidoId);
            
            this.savePedidos();
            console.log(`✅ Pedido marcado como adicionado: ${pedido.nome}`);
            return true;
        }
        return false;
    }

    removerPedido(pedidoId) {
        const index = this.pedidos.findIndex(p => p.id === pedidoId);
        if (index !== -1) {
            const pedido = this.pedidos[index];
            this.pedidos.splice(index, 1);
            
            // Remover do cache de pendentes se estiver lá
            this.pedidosPendentes.delete(pedidoId);
            
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
        return this.pedidos.find(pedido => pedido.id === pedidoId);
    }

    formatarPedidosParaAdmin() {
        if (this.pedidos.length === 0) {
            return '📝 Nenhum pedido encontrado.';
        }

        let mensagem = '📝 *Lista de Pedidos:*\n\n';
        
        // Adicionar estatísticas no topo (usando cache para pendentes)
        const total = this.pedidos.length;
        const pendentes = this.pedidosPendentes.size; // Usar cache
        const adicionados = this.pedidos.filter(p => p.status === 'adicionado').length;
        const assinantes = this.pedidos.filter(p => p.isAssinante).length;
        
        mensagem += `📊 *Estatísticas:*\n`;
        mensagem += `• Total: ${total}\n`;
        mensagem += `• Pendentes: ${pendentes}\n`;
        mensagem += `• Adicionados: ${adicionados}\n`;
        mensagem += `• Assinantes: ${assinantes}\n\n`;
        
        // Se houver muitos pedidos, mostrar apenas os primeiros e últimos
        const maxExibir = 50;
        
        if (total > maxExibir) {
            const primeiros = this.pedidos.slice(0, 25);
            const ultimos = this.pedidos.slice(-25);
            
            mensagem += `⚠️ *Muitos pedidos (${total}). Mostrando primeiros 25 e últimos 25:*\n\n`;
            
            // Mostrar primeiros
            mensagem += `📋 *Primeiros 25:*\n`;
            primeiros.forEach((pedido, index) => {
                const status = pedido.status === 'pendente' ? '⏳' : '✅';
                const data = new Date(pedido.data).toLocaleDateString('pt-BR');
                const prioridade = pedido.isAssinante ? '🔥 ASSINANTE' : '👤 Usuário';
                
                mensagem += `${status} *${index + 1}.* ${pedido.nome}\n`;
                mensagem += `${prioridade} - ${pedido.username}\n`;
                mensagem += `📅 ${data}\n`;
                if (pedido.descricao) {
                    mensagem += `📝 ${pedido.descricao}\n`;
                }
                mensagem += `🆔 ID: ${pedido.id}\n\n`;
            });
            
            mensagem += `...\n\n`;
            
            // Mostrar últimos
            mensagem += `📋 *Últimos 25:*\n`;
            ultimos.forEach((pedido, index) => {
                const status = pedido.status === 'pendente' ? '⏳' : '✅';
                const data = new Date(pedido.data).toLocaleDateString('pt-BR');
                const prioridade = pedido.isAssinante ? '🔥 ASSINANTE' : '👤 Usuário';
                
                mensagem += `${status} *${index + 1}.* ${pedido.nome}\n`;
                mensagem += `${prioridade} - ${pedido.username}\n`;
                mensagem += `📅 ${data}\n`;
                if (pedido.descricao) {
                    mensagem += `📝 ${pedido.descricao}\n`;
                }
                mensagem += `🆔 ID: ${pedido.id}\n\n`;
            });
            
            mensagem += `📊 *Total de pedidos: ${total}*\n`;
            mensagem += `💡 *Dica:* Use filtros para ver pedidos específicos`;
        } else {
            // Mostrar todos os pedidos normalmente
            this.pedidos.forEach((pedido, index) => {
                const status = pedido.status === 'pendente' ? '⏳' : '✅';
                const data = new Date(pedido.data).toLocaleDateString('pt-BR');
                const prioridade = pedido.isAssinante ? '🔥 ASSINANTE' : '👤 Usuário';
                
                mensagem += `${status} *${index + 1}.* ${pedido.nome}\n`;
                mensagem += `${prioridade} - ${pedido.username}\n`;
                mensagem += `📅 ${data}\n`;
                if (pedido.descricao) {
                    mensagem += `📝 ${pedido.descricao}\n`;
                }
                mensagem += `🆔 ID: ${pedido.id}\n\n`;
            });
        }

        return mensagem;
    }
}

module.exports = PedidosManager; 