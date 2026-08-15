const config = require('../../config');

class CommandHandler {
    constructor(bot, pedidosManager, catalogoManager, assinaturaManager, queueManager = null, favoritosManager = null) {
        this.bot = bot;
        this.pedidosManager = pedidosManager;
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
        this.queueManager = queueManager;
        this.favoritosManager = favoritosManager;
        this.pagamentosTemp = {}; // Inicializar o objeto de pagamentos temporários
        this.estadosTemporarios = {}; // Estados temporários para captura de mensagens
        this.testesGratuitos = {}; // Usuários que já usaram o teste gratuito
        this.resultadosBuscaTemp = new Map(); // Resultados temporários de busca por usuário
        this.carregarTestesGratuitos(); // Carregar dados salvos
        
        // Configurar comandos do bot
        this.setupBotCommands();
        
        // Limpar estados expirados a cada 5 minutos
        setInterval(() => {
            this.limparEstadosExpirados();
        }, 5 * 60 * 1000);
    }

    setFavoritosManager(favoritosManager) {
        this.favoritosManager = favoritosManager;
    }

    async setupBotCommands() {
        try {
            await this.bot.setMyCommands([
                { command: 'start', description: '🍿 Início / Menu Principal' },
                { command: 'buscar', description: '🔍 Buscar Filme ou Série' },
                { command: 'catalogo', description: '📚 Ver Catálogo' },
                { command: 'favoritos', description: '⭐ Meus Favoritos' },
                { command: 'pedido', description: '🎬 Pedir Filme ou Série' },
                { command: 'stremio', description: '📺 Assistir na TV (Stremio)' },
                { command: 'fila', description: '⚡ Status de Downloads' },
                { command: 'assinar', description: '💎 Assinar VIP' },
                { command: 'ajuda', description: '❓ Dúvidas e Ajuda' }
            ]);
            console.log('✅ Comandos do bot configurados com sucesso!');
        } catch (error) {
            console.error('❌ Erro ao configurar comandos do bot:', error);
        }
    }

    async handleStart(msg, callbackQuery = null) {
        const userId = msg.from.id;
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;
        if (isAssinante) {
            await this.handleAssinanteStart(msg, callbackQuery);
        } else {
            await this.handleNaoAssinanteStart(msg, callbackQuery);
        }
    }

    async handleRemoverAdmin(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Apenas o administrador pode remover títulos do catálogo.');
            return;
        }

        const query = match && match[1] ? match[1].trim() : '';
        if (!query) {
            await this.bot.sendMessage(chatId, 
                '🗑️ *Como remover um título do catálogo:*\n\n' +
                '• `/remover Nome do Filme`\n' +
                '• `/remover ID_DO_FILME`\n\n' +
                '💡 *Dica:* O robô apagará o registro do catálogo e também excluirá o arquivo de vídeo do canal de armazenamento do Telegram!',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        try {
            // 1. Tentar encontrar por ID
            let item = !isNaN(parseInt(query)) ? this.catalogoManager.getItemPorId(parseInt(query)) : null;

            // 2. Se não achou por ID, busca por nome
            if (!item) {
                const resultados = this.catalogoManager.buscarItem(query);
                if (resultados.length > 0) {
                    item = resultados[0];
                }
            }

            if (!item) {
                await this.bot.sendMessage(chatId, `❌ Título *"${query}"* não foi encontrado no catálogo.`, { parse_mode: 'Markdown' });
                return;
            }

            // 3. Excluir mensagens do Telegram no Storage Group
            let mensagensApagadas = 0;
            if (item.tipo === 'filme' && item.messageId) {
                try {
                    await this.bot.deleteMessage(config.STORAGE_GROUP_ID, item.messageId);
                    mensagensApagadas++;
                } catch (e) {
                    console.warn(`⚠️ Não foi possível apagar mensagem ${item.messageId} no canal:`, e.message);
                }
            } else if (item.tipo === 'serie') {
                for (const temp of (item.temporadas || [])) {
                    for (const ep of (temp.episodios || [])) {
                        if (ep.messageId) {
                            try {
                                await this.bot.deleteMessage(config.STORAGE_GROUP_ID, ep.messageId);
                                mensagensApagadas++;
                            } catch (e) {}
                        }
                    }
                }
            }

            // 4. Remover do catálogo JSON
            const removido = this.catalogoManager.removerItem(item.id);

            if (removido) {
                await this.bot.sendMessage(chatId,
                    `🗑️ *Título removido com sucesso!*\n\n` +
                    `🎬 *Nome:* ${item.nome}\n` +
                    `📦 *Tipo:* ${item.tipo === 'filme' ? 'Filme' : 'Série'}\n` +
                    `🆔 *ID:* ${item.id}\n` +
                    `📤 *Mídias excluídas do canal de armazenamento:* ${mensagensApagadas}\n\n` +
                    `✅ *Remoção permanente concluída.*`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                await this.bot.sendMessage(chatId, '❌ Erro ao remover do catálogo.');
            }
        } catch (error) {
            console.error('❌ Erro no comando /remover:', error);
            await this.bot.sendMessage(chatId, `❌ Erro ao processar remoção: ${error.message}`);
        }
    }

    getNomeUsuario(msg, callbackQuery = null) {
        const from = callbackQuery?.from || msg?.from;
        if (!from) return 'Visitante';
        if (from.first_name) {
            return from.first_name;
        }
        if (from.username) {
            return from.username;
        }
        return 'Visitante';
    }

    async handleAssinanteStart(msg, callbackQuery = null) {
        const chatId = msg.chat?.id || callbackQuery?.message?.chat?.id;
        const userId = callbackQuery?.from?.id || msg?.from?.id;
        const nomeUsuario = this.getNomeUsuario(msg, callbackQuery);
        const stats = this.catalogoManager.getEstatisticas();
        
        // Assinatura & Vencimento
        const assinatura = this.assinaturaManager.getAssinatura(userId);
        let vencimentoTexto = '👑 Acesso Vitalício Permanente';
        if (assinatura && assinatura.plano !== 'vitalicio' && assinatura.dataVencimento) {
            const dataVenc = new Date(assinatura.dataVencimento);
            vencimentoTexto = `📅 Renovação: *${dataVenc.toLocaleDateString('pt-BR')}*`;
        }

        // Novidades desde a última visita
        let novidadesTexto = '';
        if (this.favoritosManager) {
            const novidades = this.favoritosManager.registrarVisitaECalcularNovidades(userId, stats.total);
            if (novidades > 0) {
                novidadesTexto = `🔥 *Novidades:* +${novidades} novo(s) título(s) adicionado(s) desde sua última visita!\n\n`;
            }
        }

        const mensagem = `🍿 *BrasilFlix VIP*\n\n` +
                        `Olá, *${nomeUsuario}*!\n\n` +
                        `📚 *Catálogo:* ${stats.totalFilmes} Filmes | ${stats.totalSeries} Séries\n` +
                        `⭐ *Status:* 🟢 VIP Ativo • ${vencimentoTexto}\n\n` +
                        `${novidadesTexto}` +
                        `O que você deseja assistir hoje?`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📚 Ver Catálogo', callback_data: 'catalogo' },
                    { text: '🔍 Buscar', callback_data: 'buscar' }
                ],
                [
                    { text: '⭐ Meus Favoritos', callback_data: 'meus_favoritos' },
                    { text: '🎬 Fazer Pedido', callback_data: 'pedido' }
                ],
                [
                    { text: '📺 Assistir na TV (Stremio)', callback_data: 'stremio_info' },
                    { text: '⚡ Fila de Download', callback_data: 'menu_fila' }
                ],
                [
                    { text: '💳 Minha Assinatura', callback_data: 'minha_assinatura' },
                    { text: '💬 Suporte', callback_data: 'suporte' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleNaoAssinanteStart(msg, callbackQuery = null) {
        const chatId = msg.chat?.id || callbackQuery?.message?.chat?.id;
        const userId = callbackQuery?.from?.id || msg?.from?.id;
        const nomeUsuario = this.getNomeUsuario(msg, callbackQuery);
        const stats = this.catalogoManager.getEstatisticas();
        const cota = this.getCotaGratuita(userId);

        let statusText = '';
        if (cota.filmesRestantes === 0 && cota.epsRestantes === 0) {
            statusText = `⭐ *Status:* 🔴 Plano Gratuito (Cota deste mês esgotada)\n💡 _Renova automaticamente no dia 1º!_`;
        } else {
            statusText = `⭐ *Status:* 🎁 Plano Gratuito (${cota.filmesRestantes} Filme & ${cota.epsRestantes} Eps restantes este mês)`;
        }

        const mensagem = `🍿 *BrasilFlix Oficial*\n\n` +
                        `Olá, *${nomeUsuario}*! Assista aos melhores filmes, séries e doramas dublados em 1080p direto no Telegram.\n\n` +
                        `📚 *Catálogo:* ${stats.totalFilmes} Filmes | ${stats.totalSeries} Séries\n` +
                        `${statusText}\n\n` +
                        `💡 *Navegue pelo catálogo ou busque o que deseja assistir!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📚 Ver Catálogo', callback_data: 'catalogo' },
                    { text: '🔍 Buscar Título', callback_data: 'buscar' }
                ],
                [
                    { text: '📝 Meus Pedidos', callback_data: 'ver_pedidos' },
                    { text: '💎 Planos VIP - R$ 15', callback_data: 'ver_planos' }
                ],
                [
                    { text: '❓ Como Funciona', callback_data: 'como_funciona' },
                    { text: '💬 Suporte', callback_data: 'suporte' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleAdminStart(msg, callbackQuery = null) {
        const chatId = msg.chat?.id || callbackQuery?.message?.chat?.id;
        const nomeUsuario = this.getNomeUsuario(msg, callbackQuery);
        
        const pedidos = this.pedidosManager.getPedidos();
        const pedidosPendentes = pedidos.filter(p => !p.processado);
        const stats = this.catalogoManager.getEstatisticas();
        const camCount = (this.catalogoManager.buscarFilmesCam() || []).length;
        const filaRestante = this.queueManager ? this.queueManager.queue.filter(j => j.status === 'queued').length : 0;
        
        const mensagem = `👑 *Painel Administrativo — BrasilFlix*\n\n` +
                        `Olá, *${nomeUsuario}*!\n\n` +
                        `📊 *Catálogo:* ${stats.totalFilmes} Filmes | ${stats.totalSeries} Séries\n` +
                        `📹 *Qualidade Cinema (CAM):* ${camCount} filme(s)\n` +
                        `⚡ *Fila Ativa:* ${filaRestante} downloads aguardando\n` +
                        `🔔 *Pedidos Pendentes:* ${pedidosPendentes.length}`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `📝 Pedidos (${pedidosPendentes.length})`, callback_data: 'admin_pedidos' },
                    { text: '💳 Assinaturas', callback_data: 'admin_assinaturas' }
                ],
                [
                    { text: '📺 Stremio & Acessos VIP', callback_data: 'admin_stremio' },
                    { text: '⚡ Fila de Download', callback_data: 'menu_fila' }
                ],
                [
                    { text: '➕ Adicionar Mídia', callback_data: 'admin_adicionar' },
                    { text: '🗑️ Catálogo', callback_data: 'admin_gerenciar_catalogo' }
                ],
                [
                    { text: '📊 Estatísticas', callback_data: 'admin_stats' },
                    { text: '🔄 Re-baixar Mídia', callback_data: 'admin_rebaixar_prompt' }
                ],
                [
                    { text: '🧪 Testar Menu Cliente', callback_data: 'admin_testar_cliente' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleRebaixar(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Comando exclusivo para administradores.');
            return;
        }

        if (!match || !match[1]) {
            await this.bot.sendMessage(chatId, 
                'ℹ️ *Como usar:* `/rebaixar <nome do filme ou série>`\n' +
                'Exemplo: `/rebaixar Homem-Aranha`\n\n' +
                '💡 *Função:* Força a busca por uma nova versão em alta definição (1080p WEB-DL / BluRay), baixa com prioridade máxima e substitui o arquivo no catálogo.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const nome = match[1].trim();
        await this.bot.sendMessage(chatId, `🔄 Buscando nova versão em alta qualidade para: *${nome}*...`, { parse_mode: 'Markdown' });

        if (this.queueManager) {
            this.queueManager.addJob(nome, 'filme', 1, {
                userId: userId,
                username: 'Admin',
                isUpgrade: true,
                allowCam: false
            });
            await this.bot.sendMessage(chatId, `✅ *"${nome}"* foi adicionado ao topo da fila de downloads com [Prioridade Máxima]!\n\nUse /fila para acompanhar.`, { parse_mode: 'Markdown' });
        }
    }

    async handleHelp(msg) {
        const chatId = msg.chat.id;
        
        const mensagem = `❓ *Ajuda - BrasilFlix*\n\n` +
                        `*Comandos principais:*\n\n` +
                        `📝 */pedido <nome>*\n` +
                        `Solicita um filme ou série\n` +
                        `Exemplo: /pedido Vingadores Ultimato\n\n` +
                        `🔍 */buscar <termo>*\n` +
                        `Busca no catálogo existente\n` +
                        `Exemplo: /buscar vingadores\n\n` +
                        `📚 */catalogo*\n` +
                        `Mostra estatísticas do catálogo\n\n` +
                        `*Dicas:*\n` +
                        `• Seja específico nos pedidos\n` +
                        `• Use /buscar antes de pedir\n` +
                        `• Aguarde a confirmação do seu pedido`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handlePedido(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name;
        
        if (!match || !match[1]) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* Use o formato /pedido <nome do filme/série>\n' +
                'Exemplo: /pedido Vingadores Ultimato', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const nome = match[1].trim();
        
        if (nome.length < 3) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* O nome deve ter pelo menos 3 caracteres.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Verificar se já existe no catálogo
        const existente = this.catalogoManager.buscarItem(nome);
        if (existente.length > 0) {
            let mensagem = `✅ *Já temos no catálogo!*\n\n`;
            mensagem += this.catalogoManager.formatarResultadosBusca(existente);
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            return;
        }

        // Verificar similaridade com itens existentes
        const similares = this.buscarSimilares(nome);
        
        if (similares.length > 0) {
            await this.mostrarVerificacaoSimilaridade(chatId, userId, nome, similares);
            return;
        }

        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;

        // Adicionar pedido
        const pedido = this.pedidosManager.adicionarPedido(userId, username, nome, '', isAssinante);
        
        // Se temos QueueManager, enfileira o download inteligente com prioridade alta para assinantes
        if (this.queueManager) {
            const { PRIORITIES } = require('../managers/QueueManager');
            this.queueManager.addJob(nome, 'filme', isAssinante ? PRIORITIES.VIP_USER : PRIORITIES.FREE_USER, {
                userId,
                username
            });
        }
        
        const prioridade = isAssinante ? '🔥 *PRIORIDADE MÁXIMA (Assinante VIP)*' : '📝 *Fila Normal (Plano Gratuito)*';
        
        const mensagemConfirmacao = `📝 *Pedido registrado com sucesso!*\n\n` +
                                   `🎬 *Título:* ${pedido.nome}\n` +
                                   `👤 *Solicitante:* ${pedido.username}\n` +
                                   `📅 *Data:* ${new Date(pedido.data).toLocaleDateString('pt-BR')}\n` +
                                   `🆔 *ID:* ${pedido.id}\n` +
                                   `⭐ *Status:* ${prioridade}\n\n` +
                                   `🚀 *O motor automatizado BrasilFlix já iniciou a busca e o download em 1080p Full HD!* Assim que for concluído, você receberá a notificação aqui. Use /fila para acompanhar.`;

        await this.bot.sendMessage(chatId, mensagemConfirmacao, { parse_mode: 'Markdown' });

        // Notificar administradores
        console.log(`📝 Novo pedido: ${nome} por ${username} ${isAssinante ? '(Assinante)' : ''} (ID: ${pedido.id})`);
    }

    async handleFila(msg) {
        const chatId = msg.chat.id;
        if (!this.queueManager) {
            await this.bot.sendMessage(chatId, 'ℹ️ Sistema de fila em inicialização.');
            return;
        }

        const status = this.queueManager.getStatus();
        let mensagem = `⚡ *Status da Fila de Downloads BrasilFlix*\n\n`;
        
        if (status.activeTask) {
            mensagem += `🚀 *Processando Agora (1080p):*\n` +
                        `🎬 *Título:* ${status.activeTask.title}\n` +
                        `📊 *Progresso:* ${status.activeTask.progress}%\n` +
                        `ℹ️ *Detalhes:* ${status.activeTask.progressDetails || 'Processando...'}\n\n`;
        } else {
            mensagem += `💤 *Fila Ociosa:* Nenhum download ativo no momento.\n\n`;
        }

        mensagem += `📋 *Estatísticas:* Total: ${status.total} | Na Fila: ${status.queued} | Concluídos: ${status.completed}\n\n` +
                    `💡 *Dica:* Seus pedidos entram automaticamente com Prioridade Alta!`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    buscarSimilares(nome) {
        const nomeLower = nome.toLowerCase();
        const palavras = nomeLower.split(/\s+/);
        const similares = [];

        // Buscar em filmes e séries
        const todosItens = [
            ...this.catalogoManager.catalogo.filmes.map(f => ({ ...f, tipo: 'filme' })),
            ...this.catalogoManager.catalogo.series.map(s => ({ ...s, tipo: 'serie' }))
        ];

        todosItens.forEach(item => {
            const itemNomeLower = item.nome.toLowerCase();
            let score = 0;

            // Verificar palavras em comum
            palavras.forEach(palavra => {
                if (palavra.length > 2 && itemNomeLower.includes(palavra)) {
                    score += 1;
                }
            });

            // Verificar similaridade por caracteres
            const similaridade = this.calcularSimilaridade(nomeLower, itemNomeLower);
            if (similaridade > 0.7) {
                score += 2;
            }

            if (score >= 1) {
                similares.push({ ...item, score });
            }
        });

        // Ordenar por score e retornar os mais similares
        return similares
            .sort((a, b) => b.score - a.score)
            .slice(0, 3); // Máximo 3 resultados
    }

    calcularSimilaridade(str1, str2) {
        const longer = str1.length > str2.length ? str1 : str2;
        const shorter = str1.length > str2.length ? str2 : str1;
        
        if (longer.length === 0) return 1.0;
        
        const distance = this.levenshteinDistance(longer, shorter);
        return (longer.length - distance) / longer.length;
    }

    levenshteinDistance(str1, str2) {
        const matrix = [];
        
        for (let i = 0; i <= str2.length; i++) {
            matrix[i] = [i];
        }
        
        for (let j = 0; j <= str1.length; j++) {
            matrix[0][j] = j;
        }
        
        for (let i = 1; i <= str2.length; i++) {
            for (let j = 1; j <= str1.length; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j] + 1
                    );
                }
            }
        }
        
        return matrix[str2.length][str1.length];
    }

    async mostrarVerificacaoSimilaridade(chatId, userId, nome, similares) {
        const mensagem = `🔍 *Encontramos títulos similares no catálogo!*\n\n` +
                        `🎬 *Você pediu:* ${nome}\n\n` +
                        `📋 *Títulos similares encontrados:*\n\n`;

        similares.forEach((item, index) => {
            const icone = item.tipo === 'filme' ? '🎬' : '📺';
            mensagem += `${icone} *${index + 1}.* ${item.nome}\n`;
            if (item.descricao) {
                mensagem += `📝 ${item.descricao}\n`;
            }
            mensagem += `🆔 ID: ${item.id}\n\n`;
        });

        mensagem += `❓ *O que você gostaria de fazer?*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Sim, é um desses', callback_data: `confirmar_similar_${nome}` },
                    { text: '❌ Não, é diferente', callback_data: `confirmar_pedido_${nome}` }
                ],
                [
                    { text: '🔍 Buscar no Catálogo', callback_data: 'buscar' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleBuscar(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (!match || !match[1]) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* Use o formato /buscar <termo>\n' +
                'Exemplo: /buscar vingadores', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const termo = match[1].trim();
        await this.mostrarResultadosBusca(chatId, userId, termo);
    }

    async mostrarResultadosBusca(chatId, userId, termo, callbackQuery = null) {
        if (!termo || termo.length < 2) {
            await this.bot.sendMessage(chatId, '❌ O termo de busca deve ter pelo menos 2 caracteres.');
            return;
        }

        const resultados = this.catalogoManager.buscarItem(termo);

        if (resultados.length > 0) {
            this.resultadosBuscaTemp.set(userId, resultados);
        }

        if (resultados.length === 0) {
            const msgVazia = `🔍 *Busca:* "${termo}"\n\n❌ Nenhum título encontrado no catálogo.\n\n💡 *Deseja solicitar este lançamento?*`;
            const kbVazio = {
                inline_keyboard: [
                    [{ text: '📝 Fazer Pedido', callback_data: `confirmar_pedido_${termo}` }],
                    [{ text: '🔍 Buscar Outro', callback_data: 'buscar' }],
                    [{ text: '🔙 Menu Principal', callback_data: 'voltar_menu' }]
                ]
            };
            await this.sendOrEdit(chatId, msgVazia, { parse_mode: 'Markdown', reply_markup: kbVazio }, callbackQuery);
            return;
        }

        let mensagem = `🔍 *Resultados para:* "${termo}" (${resultados.length})\n\n💡 *Selecione o título para ver a sinopse e assistir:*`;
        const keyboard = { inline_keyboard: [] };

        resultados.slice(0, 8).forEach((item, index) => {
            const icone = item.tipo === 'filme' ? '🎬' : '📺';
            const ano = item.ano ? ` (${item.ano})` : '';
            const nota = item.nota ? ` ⭐ ${item.nota}` : '';
            const nomeExibicao = `${icone} ${index + 1}. ${item.nome}${ano}${nota}`;
            const callbackData = item.tipo === 'filme' ? `info_filme_${item.id}` : `info_serie_${item.id}`;

            keyboard.inline_keyboard.push([
                { text: nomeExibicao.length > 35 ? nomeExibicao.substring(0, 32) + '...' : nomeExibicao, callback_data: callbackData }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: '🔍 Nova Busca', callback_data: 'buscar' },
            { text: '🔙 Menu Principal', callback_data: 'voltar_menu' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleCatalogo(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;
        await this.mostrarMenuCatalogo(chatId, userId, null);
    }

    async handleCatalogoFilmes(chatId, userId, callbackQuery, audioFiltro = 'todos', pagina = 0) {
        let filmes = this.catalogoManager.catalogo.filmes || [];
        let tituloCategoria = '🎬 *Filmes Disponíveis*';

        if (audioFiltro === 'dublado') {
            filmes = this.catalogoManager.getFilmesDublados();
            tituloCategoria = '🎬 *Filmes Dublados*';
        } else if (audioFiltro === 'legendado') {
            filmes = this.catalogoManager.getFilmesLegendados();
            tituloCategoria = '💬 *Filmes Legendados*';
        }
        
        if (filmes.length === 0) {
            await this.sendOrEdit(chatId, 
                `📭 Nenhum filme encontrado no catálogo no momento.`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔍 Fazer Busca', callback_data: 'buscar' }],
                            [{ text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }]
                        ]
                    }
                },
                callbackQuery
            );
            return;
        }

        const filmesPorPagina = 8;
        const paginas = Math.ceil(filmes.length / filmesPorPagina);
        const paginaAtual = Math.max(0, Math.min(pagina, paginas - 1));
        
        const inicio = paginaAtual * filmesPorPagina;
        const fim = Math.min(inicio + filmesPorPagina, filmes.length);
        const filmesPagina = filmes.slice(inicio, fim);

        const mensagem = `${tituloCategoria}\n` +
                        `💡 _[D] Dublado | [L] Legendado | [D/L] Ambos_\n\n` +
                        `📊 Mostrando ${inicio + 1}-${fim} de ${filmes.length} filmes\n\n` +
                        `Selecione um filme para ver a sinopse e assistir:`;

        const keyboard = {
            inline_keyboard: []
        };

        filmesPagina.forEach(filme => {
            const ano = filme.ano ? ` (${filme.ano})` : '';
            const nota = filme.nota ? ` ⭐ ${filme.nota}` : '';
            const badge = this.catalogoManager.getAudioBadge(filme);
            const badgeStr = badge ? ` ${badge}` : '';
            const nomeExibicao = `${filme.nome}${ano}${badgeStr}${nota}`;
            
            keyboard.inline_keyboard.push([
                { text: `🎬 ${nomeExibicao.length > 34 ? nomeExibicao.substring(0, 31) + '...' : nomeExibicao}`, callback_data: `info_filme_${filme.id}` }
            ]);
        });

        const botoesNavegacao = [];
        if (paginas > 1) {
            if (paginaAtual > 0) {
                botoesNavegacao.push({ text: '⬅️ Anterior', callback_data: `filmes_pagina_${paginaAtual - 1}` });
            }
            if (paginaAtual < paginas - 1) {
                botoesNavegacao.push({ text: 'Próxima ➡️', callback_data: `filmes_pagina_${paginaAtual + 1}` });
            }
        }
        
        if (botoesNavegacao.length > 0) {
            keyboard.inline_keyboard.push(botoesNavegacao);
        }

        keyboard.inline_keyboard.push([
            { text: '🔍 Buscar Filme', callback_data: 'buscar' },
            { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleCatalogoSeries(chatId, userId, callbackQuery, audioFiltro = 'todos', pagina = 0) {
        let series = this.catalogoManager.catalogo.series || [];
        let tituloCategoria = '📺 *Séries & Doramas Disponíveis*';

        if (audioFiltro === 'dublado') {
            series = this.catalogoManager.getSeriesDubladas();
            tituloCategoria = '📺 *Séries Dubladas*';
        } else if (audioFiltro === 'legendado') {
            series = this.catalogoManager.getSeriesLegendadas();
            tituloCategoria = '💬 *Séries Legendadas*';
        }
        
        if (series.length === 0) {
            await this.sendOrEdit(chatId, 
                `📭 Nenhuma série encontrada no catálogo no momento.`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔍 Fazer Busca', callback_data: 'buscar' }],
                            [{ text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }]
                        ]
                    }
                },
                callbackQuery
            );
            return;
        }

        const seriesPorPagina = 8;
        const paginas = Math.ceil(series.length / seriesPorPagina);
        const paginaAtual = Math.max(0, Math.min(pagina, paginas - 1));
        
        const inicio = paginaAtual * seriesPorPagina;
        const fim = Math.min(inicio + seriesPorPagina, series.length);
        const seriesPagina = series.slice(inicio, fim);

        const mensagem = `${tituloCategoria}\n` +
                        `💡 _[D] Dublado | [L] Legendado | [D/L] Ambos_\n\n` +
                        `📊 Mostrando ${inicio + 1}-${fim} de ${series.length} séries\n\n` +
                        `Selecione uma série para ver episódios e assistir:`;

        const keyboard = {
            inline_keyboard: []
        };

        seriesPagina.forEach(serie => {
            const ano = serie.ano ? ` (${serie.ano})` : '';
            const nota = serie.nota ? ` ⭐ ${serie.nota}` : '';
            const badge = this.catalogoManager.getAudioBadge(serie);
            const badgeStr = badge ? ` ${badge}` : '';
            const nomeExibicao = `${serie.nome}${ano}${badgeStr}${nota}`;
            
            keyboard.inline_keyboard.push([
                { text: `📺 ${nomeExibicao.length > 34 ? nomeExibicao.substring(0, 31) + '...' : nomeExibicao}`, callback_data: `info_serie_${serie.id}` }
            ]);
        });

        const botoesNavegacao = [];
        if (paginas > 1) {
            if (paginaAtual > 0) {
                botoesNavegacao.push({ text: '⬅️ Anterior', callback_data: `series_pagina_${paginaAtual - 1}` });
            }
            if (paginaAtual < paginas - 1) {
                botoesNavegacao.push({ text: 'Próxima ➡️', callback_data: `series_pagina_${paginaAtual + 1}` });
            }
        }
        
        if (botoesNavegacao.length > 0) {
            keyboard.inline_keyboard.push(botoesNavegacao);
        }

        keyboard.inline_keyboard.push([
            { text: '🔍 Buscar Série', callback_data: 'buscar' },
            { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleInfoFilme(chatId, userId, filmeId, callbackQuery) {
        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
            return;
        }

        const ano = filme.ano ? ` (${filme.ano})` : '';
        const nota = filme.nota ? `⭐ *Avaliação:* ${filme.nota}/10\n` : '';
        const generos = (filme.generos && filme.generos.length > 0) ? `🎭 *Gêneros:* ${filme.generos.join(', ')}\n` : '';
        const qualidade = filme.isCam ? '📹 Versão Cinema (Provisória)' : (filme.qualidade || '1080p Full HD');
        
        const temDub = filme.isDublado || !!filme.versoes?.dublado;
        const temLeg = filme.isLegendado || !!filme.versoes?.legendado;

        let audioTexto = 'Dublado (Áudio PT-BR)';
        if (temDub && temLeg) {
            audioTexto = '🇧🇷 Dublado & 💬 Legendado (PT-BR)';
        } else if (temLeg) {
            audioTexto = '💬 Legendado (PT-BR)';
        }

        const sinopse = (filme.sinopse || filme.descricao || 'Disponível no catálogo com máxima qualidade.').trim();

        const mensagem = `🎬 *${filme.nome}*${ano}\n\n` +
                        `${nota}` +
                        `${generos}` +
                        `✨ *Qualidade:* ${qualidade} | 🔊 *Áudio:* ${audioTexto}\n\n` +
                        `📝 *Sinopse:*\n_${sinopse}_`;

        const keyboard = { inline_keyboard: [] };

        if (temDub && temLeg) {
            keyboard.inline_keyboard.push([
                { text: '🎬 Assistir Dublado', callback_data: `assistir_filme_${filme.id}_dublado` },
                { text: '💬 Assistir Legendado', callback_data: `assistir_filme_${filme.id}_legendado` }
            ]);
        } else if (temLeg) {
            keyboard.inline_keyboard.push([
                { text: '💬 Assistir Legendado (PT-BR)', callback_data: `assistir_filme_${filme.id}_legendado` }
            ]);
        } else {
            keyboard.inline_keyboard.push([
                { text: '🎬 Assistir Dublado (PT-BR)', callback_data: `assistir_filme_${filme.id}_dublado` }
            ]);
        }

        const isFav = this.favoritosManager ? this.favoritosManager.isFavorito(userId, filme.id, 'filme') : false;
        const favBtn = { 
            text: isFav ? '🌟 Em Favoritos (Remover)' : '⭐ Salvar nos Favoritos', 
            callback_data: `toggle_fav_filme_${filme.id}` 
        };

        keyboard.inline_keyboard.push([favBtn]);
        keyboard.inline_keyboard.push([
            { text: '🔍 Fazer Busca', callback_data: 'buscar' },
            { text: '🔙 Voltar à Lista', callback_data: 'catalogo_filmes' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleInfoSerie(chatId, userId, serieId, callbackQuery) {
        const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
        if (!serie) {
            await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
            return;
        }

        const temporadas = serie.temporadas || [];
        const totalEpisodios = temporadas.reduce((acc, t) => acc + (t.episodios ? t.episodios.length : 0), 0);
        const ano = serie.ano ? ` (${serie.ano})` : '';
        const nota = serie.nota ? `⭐ *Avaliação:* ${serie.nota}/10\n` : '';
        const generos = (serie.generos && serie.generos.length > 0) ? `🎭 *Gêneros:* ${serie.generos.join(', ')}\n` : '';
        const sinopse = (serie.sinopse || serie.descricao || 'Disponível no catálogo BrasilFlix.').trim();

        const badge = this.catalogoManager.getAudioBadge(serie);
        const badgeTexto = badge === '[D/L]' ? '🇧🇷 Dublado & 💬 Legendado' : (badge === '[L]' ? '💬 Legendado' : '🇧🇷 Dublado');

        const isFav = this.favoritosManager ? this.favoritosManager.isFavorito(userId, serie.id, 'serie') : false;
        const favBtn = { 
            text: isFav ? '🌟 Em Favoritos (Remover)' : '⭐ Favoritar (Avisar novos eps)', 
            callback_data: `toggle_fav_serie_${serie.id}` 
        };

        const mensagem = `📺 *${serie.nome}*${ano}\n\n` +
                        `${nota}` +
                        `${generos}` +
                        `📊 *Temporadas:* ${temporadas.length} | *Episódios:* ${totalEpisodios}\n` +
                        `🔊 *Áudios:* ${badgeTexto}\n\n` +
                        `📝 *Sinopse:*\n_${sinopse}_\n\n` +
                        `🍿 *Selecione a temporada:*`;

        const keyboard = { inline_keyboard: [] };
        let row = [];
        temporadas.forEach(t => {
            row.push({ text: `Temporada ${t.numero}`, callback_data: `temp_${serie.id}_${t.numero}` });
            if (row.length === 2) {
                keyboard.inline_keyboard.push(row);
                row = [];
            }
        });
        if (row.length > 0) keyboard.inline_keyboard.push(row);

        keyboard.inline_keyboard.push([favBtn]);
        keyboard.inline_keyboard.push([
            { text: '🔍 Fazer Busca', callback_data: 'buscar' },
            { text: '🔙 Voltar à Lista', callback_data: 'catalogo_series' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async entregarVideoAoUsuario(chatId, messageId, fileId, caption = '') {
        // 1. Tenta copyMessage (entrega direta limpa)
        if (messageId && config.STORAGE_GROUP_ID) {
            try {
                await this.bot.copyMessage(chatId, config.STORAGE_GROUP_ID, messageId, {
                    caption: caption || undefined,
                    parse_mode: 'Markdown'
                });
                return true;
            } catch (err1) {
                console.warn(`⚠️ copyMessage falhou (MessageId ${messageId}): ${err1.message}. Tentando fallback...`);
            }

            // 2. Tenta forwardMessage
            try {
                await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, messageId);
                return true;
            } catch (err2) {
                console.warn(`⚠️ forwardMessage falhou: ${err2.message}`);
            }
        }

        // 3. Fallback com file_id direto (apenas se for formato string válido do Bot API)
        if (fileId && typeof fileId === 'string' && !/^\d+$/.test(fileId)) {
            try {
                await this.bot.sendVideo(chatId, fileId, { caption, parse_mode: 'Markdown' });
                return true;
            } catch (err3) {
                try {
                    await this.bot.sendDocument(chatId, fileId, { caption, parse_mode: 'Markdown' });
                    return true;
                } catch (err4) {
                    console.error(`❌ Falha na entrega por file_id:`, err4.message);
                }
            }
        }

        return false;
    }

    async handleAssistirFilme(chatId, userId, filmeId, callbackQuery, versaoAudio = 'dublado') {
        const username = callbackQuery?.from?.username || callbackQuery?.from?.first_name || 'Usuário';
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;
        const cota = this.getCotaGratuita(userId);

        if (!isAssinante && !cota.podeFilme) {
            await this.handleVerPlanosButton(chatId, userId, callbackQuery);
            return;
        }

        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Arquivo de vídeo indisponível no momento.');
            return;
        }

        let targetMessageId = filme.messageId;
        let targetFileId = filme.fileId;

        if (versaoAudio === 'legendado' && filme.versoes?.legendado) {
            targetMessageId = filme.versoes.legendado.messageId || targetMessageId;
            targetFileId = filme.versoes.legendado.fileId || targetFileId;
        } else if (versaoAudio === 'dublado' && filme.versoes?.dublado) {
            targetMessageId = filme.versoes.dublado.messageId || targetMessageId;
            targetFileId = filme.versoes.dublado.fileId || targetFileId;
        }

        if (!targetMessageId && !targetFileId) {
            await this.bot.sendMessage(chatId, '❌ Arquivo de vídeo indisponível no momento.');
            return;
        }

        try {
            const entregue = await this.entregarVideoAoUsuario(chatId, targetMessageId, targetFileId, `🎬 *${filme.nome}* (${versaoAudio === 'legendado' ? 'Legendado' : 'Dublado'}) 🍿 BrasilFlix`);

            if (!entregue) {
                await this.bot.sendMessage(chatId, '❌ Não foi possível entregar o vídeo neste momento. O suporte já foi notificado.');
                return;
            }

            if (!isAssinante) {
                this.consumirCotaGratis(userId, username, 'filme');
                const novaCota = this.getCotaGratuita(userId);
                const msgTeste = `🎁 *Você utilizou seu filme gratuito deste mês!*\n\n` +
                                `📊 *Seu saldo restante no mês:* 0 filmes e ${novaCota.epsRestantes} episódio(s) de séries.\n\n` +
                                `💡 *Para assistir a filmes e séries ilimitados, assine por apenas R$ 15,00/mês!*`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '💎 Ver Planos VIP - R$ 15', callback_data: 'ver_planos' }],
                        [{ text: '🍿 Menu Principal', callback_data: 'voltar_menu' }]
                    ]
                };
                await this.bot.sendMessage(chatId, msgTeste, { parse_mode: 'Markdown', reply_markup: keyboard });
            } else {
                await this.bot.sendMessage(chatId, `🍿 *Bom filme, assinante VIP! Aproveite!*`, { parse_mode: 'Markdown' });
            }
        } catch (error) {
            console.error('❌ Erro ao enviar filme:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao entregar o vídeo. Contate o suporte.');
        }
    }

    async handleToggleFavorito(chatId, userId, itemId, tipo, callbackQuery) {
        if (!this.favoritosManager) return;

        const item = this.catalogoManager.getItemPorId(parseInt(itemId));
        if (!item) return;

        const result = this.favoritosManager.toggleFavorito(userId, item);
        const alertMsg = result.action === 'adicionado' 
            ? '⭐ Adicionado aos seus Favoritos! Você será avisado quando sair novo episódio.' 
            : '🗑️ Removido dos seus Favoritos.';

        if (callbackQuery && callbackQuery.id) {
            await this.bot.answerCallbackQuery(callbackQuery.id, { text: alertMsg, show_alert: true }).catch(() => {});
        }

        // Atualiza a ficha técnica
        if (tipo === 'filme') {
            await this.handleInfoFilme(chatId, userId, itemId, callbackQuery);
        } else {
            await this.handleInfoSerie(chatId, userId, itemId, callbackQuery);
        }
    }

    async handleMeusFavoritos(chatId, userId, pagina = 1, callbackQuery = null) {
        if (!this.favoritosManager) return;

        const favs = this.favoritosManager.getFavoritos(userId) || [];

        if (favs.length === 0) {
            const mensagem = `⭐ *Seus Favoritos*\n\n` +
                            `Você ainda não favoritou nenhum filme ou série.\n\n` +
                            `💡 _Ao favoritar uma série, você receberá notificações automáticas quando novos episódios chegarem ao catálogo!_`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '📚 Explorar Catálogo', callback_data: 'catalogo' }],
                    [{ text: '🔙 Menu Principal', callback_data: 'voltar_menu' }]
                ]
            };

            await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
            return;
        }

        const porPagina = 8;
        const totalPaginas = Math.ceil(favs.length / porPagina);
        pagina = Math.max(1, Math.min(pagina, totalPaginas));
        const inicio = (pagina - 1) * porPagina;
        const favsPagina = favs.slice(inicio, inicio + porPagina);

        let mensagem = `⭐ *Meus Favoritos*\n\n` +
                        `📊 *Total de Favoritos:* ${favs.length}\n` +
                        `Mostrando página ${pagina} de ${totalPaginas}:\n\n` +
                        `Selecione para abrir e assistir:`;

        const keyboard = { inline_keyboard: [] };

        favsPagina.forEach(fav => {
            const icone = fav.tipo === 'filme' ? '🎬' : '📺';
            const callback = fav.tipo === 'filme' ? `info_filme_${fav.id}` : `info_serie_${fav.id}`;
            keyboard.inline_keyboard.push([
                { text: `${icone} ${fav.nome}${fav.ano ? ` (${fav.ano})` : ''}`, callback_data: callback }
            ]);
        });

        // Paginação
        const navRow = [];
        if (pagina > 1) {
            navRow.push({ text: '⬅️ Anterior', callback_data: `favs_pagina_${pagina - 1}` });
        }
        if (pagina < totalPaginas) {
            navRow.push({ text: 'Próxima ➡️', callback_data: `favs_pagina_${pagina + 1}` });
        }
        if (navRow.length > 0) keyboard.inline_keyboard.push(navRow);

        keyboard.inline_keyboard.push([
            { text: '📚 Ver Catálogo', callback_data: 'catalogo' },
            { text: '🔙 Menu Principal', callback_data: 'voltar_menu' }
        ]);

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleAdicionar(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Verificar se é admin ou se está no grupo de armazenamento
        if (userId !== config.ADMIN_ID && chatId !== config.STORAGE_GROUP_ID) {
            await this.bot.sendMessage(chatId, 
                '❌ Este comando só pode ser usado por administradores ou no grupo de armazenamento.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Se estiver no grupo de armazenamento, verificar se há uma mensagem anterior com arquivo
        if (chatId === config.STORAGE_GROUP_ID) {
            await this.processarAdicaoManual(msg);
            return;
        }

        const mensagem = `📤 *Como adicionar conteúdo:*\n\n` +
                        `*Método 1 - Automático (Recomendado):*\n` +
                        `1️⃣ Envie o arquivo para o grupo de armazenamento\n` +
                        `2️⃣ Adicione uma descrição na legenda\n` +
                        `3️⃣ O sistema detectará automaticamente e adicionará ao catálogo\n\n` +
                        `*Método 2 - Manual:*\n` +
                        `1️⃣ Envie o arquivo para o grupo de armazenamento\n` +
                        `2️⃣ Use /adicionar no grupo (se não detectar automaticamente)\n\n` +
                        `*Método 3 - Sem arquivo (Admin):*\n` +
                        `Use: /adicionar_manual "Nome - Ano - Gênero"\n\n` +
                        `*Formato da descrição:*\n` +
                        `Nome do filme/série - Ano - Gênero\n` +
                        `Exemplo: Vingadores Ultimato - 2019 - Ação/Aventura\n\n` +
                        `💡 *Dica:* O sistema detecta automaticamente quando você envia um arquivo com legenda no formato correto!`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async processarAdicaoManual(msg) {
        const chatId = msg.chat.id;
        
        // Verificar se a mensagem atual tem um arquivo anexado
        try {
            if (msg.document || msg.video || msg.audio) {
                const caption = msg.caption || '';
                if (caption.trim()) {
                    await this.messageHandler.processarAdicaoCatalogo(msg, caption);
                } else {
                    await this.bot.sendMessage(chatId, 
                        '❌ Esta mensagem não possui descrição. Adicione uma legenda ao arquivo e tente novamente.',
                        { parse_mode: 'Markdown' }
                    );
                }
            } else {
                await this.bot.sendMessage(chatId, 
                    '❌ Esta mensagem não contém um arquivo. Envie o arquivo com uma legenda e use /adicionar.',
                    { parse_mode: 'Markdown' }
                );
            }
        } catch (error) {
            console.error('❌ Erro ao processar adição manual:', error);
            await this.bot.sendMessage(chatId, 
                '❌ Erro ao processar adição. Verifique se há um arquivo válido na mensagem.',
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleAdicionarManual(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Verificar se é admin
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, 
                '❌ Acesso negado. Apenas administradores podem usar este comando.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (!match || !match[1]) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* Use o formato /adicionar_manual <descrição>\n' +
                'Exemplo: /adicionar_manual "Harry Potter e a Pedra Filosofal - 2001 - Ação/Fantasia"', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const descricao = match[1].trim();
        
        // Criar uma mensagem simulada para processar
        const mensagemSimulada = {
            message_id: Date.now(),
            caption: descricao
        };

        try {
            await this.messageHandler.processarAdicaoCatalogo(mensagemSimulada, descricao);
        } catch (error) {
            console.error('❌ Erro ao adicionar manualmente:', error);
            await this.bot.sendMessage(chatId, 
                '❌ Erro ao adicionar ao catálogo. Verifique o formato da descrição.',
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleAdicionarForcar(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Verificar se é admin
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, 
                '❌ Acesso negado. Apenas administradores podem usar este comando.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        if (!match || !match[1]) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* Use o formato /adicionar_forcar <nome>\n' +
                'Exemplo: /adicionar_forcar "Vingadores Ultimato"', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const nome = match[1].trim();
        
        // Buscar item existente no catálogo
        const existente = this.catalogoManager.buscarItem(nome);
        
        if (existente.length === 0) {
            await this.bot.sendMessage(chatId, 
                '❌ Item não encontrado no catálogo. Use /adicionar_manual para adicionar um novo item.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const item = existente[0];
        
        // Forçar adição (substituir o item existente)
        const resultado = await this.catalogoManager.adicionarFilme(
            item.nome, 
            item.descricao, 
            Date.now(), // Novo messageId
            item.tipo, 
            true // forcarAdicao = true
        );

        if (resultado.success) {
            await this.bot.sendMessage(chatId, 
                `✅ *Item forçado ao catálogo!*\n\n` +
                `🎬 *${item.tipo === 'filme' ? 'Filme' : 'Série'}:* ${resultado.item.nome}\n` +
                `📝 *Descrição:* ${resultado.item.descricao}\n` +
                `🆔 *Novo ID:* ${resultado.item.id}\n` +
                `📅 *Data:* ${new Date(resultado.item.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                `🔄 *Item anterior substituído com sucesso!*`,
                { parse_mode: 'Markdown' }
            );
        } else {
            await this.bot.sendMessage(chatId, 
                '❌ Erro ao forçar adição do item.',
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleAdminPedidos(msg) {
        const chatId = msg.chat.id;
        const mensagem = this.pedidosManager.formatarPedidosParaAdmin();
        
        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleEnviarArquivo(msg, itemId) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        if (!isAssinante) {
            await this.mostrarMensagemConversao(chatId, userId, null);
            return;
        }

        const item = this.catalogoManager.getItemPorId(parseInt(itemId));
        
        if (!item) {
            await this.bot.sendMessage(chatId, '❌ Item não encontrado no catálogo.');
            return;
        }

        try {
            // Reenviar arquivo do grupo de armazenamento
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, item.messageId);
            
            const mensagem = `✅ *${item.nome}*\n\n` +
                           `📝 ${item.descricao || 'Sem descrição'}\n` +
                           `🎬 Tipo: ${item.tipo === 'filme' ? 'Filme' : 'Série'}\n` +
                           `📅 Adicionado em: ${new Date(item.dataAdicionado).toLocaleDateString('pt-BR')}`;
            
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('❌ Erro ao enviar arquivo:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar arquivo. Tente novamente.');
        }
    }

    // Comandos de Assinatura
    async handleAssinar(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name;

        // Usar o mesmo método do botão de assinatura
        await this.handleAssinaturaButton(chatId, userId, null);
    }

    async handleAssinarPlano(msg, plano) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name;

        try {
            const pagamento = await this.assinaturaManager.criarPagamento(userId, username, plano);
            
            const mensagem = `💳 *Pagamento - Plano ${plano}*\n\n` +
                           `Clique no link abaixo para pagar:\n\n` +
                           `🔗 [Pagar no Mercado Pago](${pagamento.init_point})\n\n` +
                           `Após o pagamento, sua assinatura será ativada automaticamente!`;

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        } catch (error) {
            await this.bot.sendMessage(chatId, '❌ Erro ao criar pagamento. Tente novamente.');
        }
    }

    async handleMinhaAssinatura(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name;

        const assinatura = this.assinaturaManager.getAssinatura(userId);
        
        if (!assinatura) {
            const mensagem = `📋 *Minha Assinatura*\n\n` +
                           `Você ainda não tem uma assinatura ativa.\n\n` +
                           `Use /assinar para assinar o BrasilFlix!`;
            
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            return;
        }

        const info = this.assinaturaManager.formatarAssinatura(assinatura);
        
        const mensagem = `📋 *Minha Assinatura*\n\n` +
                        `👤 *Usuário:* ${assinatura.username}\n` +
                        `📅 *Plano:* ${info.plano}\n` +
                        `⭐ *Status:* ${info.status}\n` +
                        `📅 *Vencimento:* ${info.vencimento}\n` +
                        `⏰ *Dias restantes:* ${info.diasRestantes}`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    // Comandos de Admin
    async handleAdminPedidos(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const mensagem = this.pedidosManager.formatarPedidosParaAdmin();
        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleAdminAssinaturas(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const assinaturas = this.assinaturaManager.assinaturas;
        const vencendo = this.assinaturaManager.getAssinaturasVencendo();
        const vencidas = this.assinaturaManager.getAssinaturasVencidas();

        let mensagem = `📊 *Relatório de Assinaturas*\n\n`;
        mensagem += `📈 *Total:* ${assinaturas.length}\n`;
        mensagem += `⚠️ *Vencendo (7 dias):* ${vencendo.length}\n`;
        mensagem += `❌ *Vencidas:* ${vencidas.length}\n\n`;

        if (vencendo.length > 0) {
            mensagem += `*Vencendo em breve:*\n`;
            vencendo.forEach(assinatura => {
                const info = this.assinaturaManager.formatarAssinatura(assinatura);
                mensagem += `• ${assinatura.username} - ${info.diasRestantes} dias\n`;
            });
        }

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleAdminStats(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedidos = this.pedidosManager.getPedidos();
        const catalogo = this.catalogoManager.getEstatisticas();
        const assinaturas = this.assinaturaManager.assinaturas;

        const mensagem = `📊 *Estatísticas do BrasilFlix*\n\n` +
                        `📝 *Pedidos:* ${pedidos.length}\n` +
                        `📚 *Catálogo:* ${catalogo.total} (${catalogo.totalFilmes} filmes, ${catalogo.totalSeries} séries)\n` +
                        `💳 *Assinaturas:* ${assinaturas.length}\n` +
                        `🔥 *Assinantes ativos:* ${assinaturas.filter(a => a.status === 'ativa').length}`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    // Handler para callbacks dos botões
    async handleCallbackQuery(callbackQuery) {
        const chatId = callbackQuery.message.chat.id;
        const userId = callbackQuery.from.id;
        const data = callbackQuery.data;
        
        try {
            // Cancelar operação em andamento se não for o botão de cancelar
            if (data !== 'cancelar_operacao' && this.estadosTemporarios[userId]) {
                delete this.estadosTemporarios[userId];
                console.log(`🔄 Operação cancelada para usuário ${userId} - botão ${data} clicado`);
                
                // Enviar mensagem informando que a operação foi cancelada
                try {
                    await this.bot.sendMessage(chatId, 
                        '🔄 *Operação cancelada*\n\n' +
                        'Você clicou em outro botão, cancelando a operação em andamento.',
                        { parse_mode: 'Markdown' }
                    );
                } catch (error) {
                    console.log('❌ Erro ao enviar mensagem de cancelamento:', error);
                }
            }

            // Verificar callbacks de forma de pagamento primeiro (usando startsWith)
            if (data.startsWith('link_')) {
                console.log('🔗 Processando link de pagamento...');
                const planoLink = data.replace('link_', '');
                await this.handleLinkPagamento(chatId, userId, planoLink, callbackQuery);
                return;
            }
            
            if (data.startsWith('pix_')) {
                console.log('📱 Processando PIX...');
                const planoPix = data.replace('pix_', '');
                await this.handlePixPagamento(chatId, userId, planoPix, callbackQuery);
                return;
            }

            // Callbacks de Temporadas e Episódios de Séries / Doramas
            if (data.startsWith('temp_')) {
                const parts = data.split('_');
                const serieId = parts[1];
                const seasonNum = parseInt(parts[2], 10);
                await this.handleTemporadaSelect(chatId, userId, serieId, seasonNum, callbackQuery);
                return;
            }

            if (data.startsWith('ep_')) {
                const parts = data.split('_');
                const serieId = parts[1];
                const seasonNum = parseInt(parts[2], 10);
                const epNum = parseInt(parts[3], 10);
                await this.handleEpisodioSelect(chatId, userId, serieId, seasonNum, epNum, callbackQuery);
                return;
            }

            if (data.startsWith('ver_')) {
                const messageId = parseInt(data.replace('ver_', ''), 10);
                await this.handleVerDireto(chatId, userId, messageId, callbackQuery);
                return;
            }

            switch (data) {
                case 'fila':
                case 'fila_status':
                    await this.handleFila({ chat: { id: chatId } });
                    break;
                case 'pedido':
                    await this.handlePedidoButton(chatId, userId, callbackQuery);
                    break;
                case 'buscar':
                    await this.handleBuscarButton(chatId, userId, callbackQuery);
                    break;
                case 'catalogo':
                    await this.handleCatalogoButton(chatId, userId, callbackQuery);
                    break;
                case 'ver_pedidos':
                    await this.handleVerPedidosButton(chatId, userId, callbackQuery);
                    break;
                case 'assinatura':
                    await this.handleAssinaturaButton(chatId, userId, callbackQuery);
                    break;
                case 'minha_assinatura':
                    await this.handleMinhaAssinaturaButton(chatId, userId, callbackQuery);
                    break;
                case 'renovar_assinatura':
                    await this.handleRenovarAssinatura(chatId, userId, callbackQuery);
                    break;
                case 'estender_assinatura':
                    await this.handleEstenderAssinatura(chatId, userId, callbackQuery);
                    break;
                case 'ajuda':
                    await this.handleAjudaButton(chatId, userId, callbackQuery);
                    break;
                case 'ver_planos':
                    await this.handleVerPlanosButton(chatId, userId, callbackQuery);
                    break;
                case 'como_funciona':
                    await this.handleComoFuncionaButton(chatId, userId, callbackQuery);
                    break;
                case 'suporte':
                    await this.handleSuporteButton(chatId, userId, callbackQuery);
                    break;
                // Callbacks de navegação do catálogo
                case 'catalogo_filmes':
                    await this.handleCatalogoFilmes(chatId, userId, callbackQuery, 'todos', 0);
                    break;
                case 'catalogo_filmes_dublados':
                    await this.handleCatalogoFilmes(chatId, userId, callbackQuery, 'dublado', 0);
                    break;
                case 'catalogo_filmes_legendados':
                    await this.handleCatalogoFilmes(chatId, userId, callbackQuery, 'legendado', 0);
                    break;
                case 'catalogo_series':
                    await this.handleCatalogoSeries(chatId, userId, callbackQuery, 'todos', 0);
                    break;
                case 'catalogo_series_dubladas':
                    await this.handleCatalogoSeries(chatId, userId, callbackQuery, 'dublado', 0);
                    break;
                case 'catalogo_series_legendadas':
                    await this.handleCatalogoSeries(chatId, userId, callbackQuery, 'legendado', 0);
                    break;
                case 'catalogo_categorias':
                    await this.handleCatalogoCategorias(chatId, userId, callbackQuery);
                    break;
                case data.match(/^filmes_pagina_(\d+)$/)?.input: {
                    const pag = parseInt(data.match(/^filmes_pagina_(\d+)$/)?.[1] || 0, 10);
                    await this.handleCatalogoFilmes(chatId, userId, callbackQuery, 'todos', pag);
                    break;
                }
                case data.match(/^series_pagina_(\d+)$/)?.input: {
                    const pag = parseInt(data.match(/^series_pagina_(\d+)$/)?.[1] || 0, 10);
                    await this.handleCatalogoSeries(chatId, userId, callbackQuery, 'todos', pag);
                    break;
                }
                case data.match(/^filmes_(dublado|legendado)_pagina_(\d+)$/)?.input: {
                    const match = data.match(/^filmes_(dublado|legendado)_pagina_(\d+)$/);
                    if (match) {
                        const audio = match[1];
                        const pag = parseInt(match[2], 10) || 0;
                        await this.handleCatalogoFilmes(chatId, userId, callbackQuery, audio, pag);
                    }
                    break;
                }
                case data.match(/^series_(dublado|legendado)_pagina_(\d+)$/)?.input: {
                    const match = data.match(/^series_(dublado|legendado)_pagina_(\d+)$/);
                    if (match) {
                        const audio = match[1];
                        const pag = parseInt(match[2], 10) || 0;
                        await this.handleCatalogoSeries(chatId, userId, callbackQuery, audio, pag);
                    }
                    break;
                }
                case data.match(/^genero_(.+)_(\d+)$/)?.input: {
                    const match = data.match(/^genero_(.+)_(\d+)$/);
                    if (match) {
                        const genero = match[1];
                        const pag = parseInt(match[2], 10) || 0;
                        await this.handleCategoriaFiltrada(chatId, userId, genero, pag, callbackQuery);
                    }
                    break;
                }
                case 'voltar_menu':
                    await this.handleVoltarMenu(chatId, userId, callbackQuery);
                    break;
                case 'voltar_menu_admin':
                    await this.handleVoltarMenuAdmin(chatId, userId, callbackQuery);
                    break;
                case 'meus_favoritos':
                    await this.handleMeusFavoritos(chatId, userId, 1, callbackQuery);
                    break;
                case 'stremio_info':
                    await this.handleStremioCommand({ chat: { id: chatId }, from: { id: userId, username: callbackQuery?.from?.username, first_name: callbackQuery?.from?.first_name } });
                    break;
                case data.match(/^favs_pagina_(\d+)$/)?.input: {
                    const pag = parseInt(data.match(/^favs_pagina_(\d+)$/)?.[1] || 1, 10);
                    await this.handleMeusFavoritos(chatId, userId, pag, callbackQuery);
                    break;
                }
                case data.match(/^toggle_fav_filme_(\d+)$/)?.input: {
                    const id = data.match(/^toggle_fav_filme_(\d+)$/)?.[1];
                    if (id) await this.handleToggleFavorito(chatId, userId, id, 'filme', callbackQuery);
                    break;
                }
                case data.match(/^toggle_fav_serie_(\d+)$/)?.input: {
                    const id = data.match(/^toggle_fav_serie_(\d+)$/)?.[1];
                    if (id) await this.handleToggleFavorito(chatId, userId, id, 'serie', callbackQuery);
                    break;
                }
                // Callbacks para ficha técnica e assistir
                case data.match(/^info_filme_(\d+)$/)?.input: {
                    const id = data.match(/^info_filme_(\d+)$/)?.[1];
                    if (id) await this.handleInfoFilme(chatId, userId, id, callbackQuery);
                    break;
                }
                case data.match(/^info_serie_(\d+)$/)?.input: {
                    const id = data.match(/^info_serie_(\d+)$/)?.[1];
                    if (id) await this.handleInfoSerie(chatId, userId, id, callbackQuery);
                    break;
                }
                case data.match(/^assistir_filme_(\d+)_(dublado|legendado)$/)?.input: {
                    const match = data.match(/^assistir_filme_(\d+)_(dublado|legendado)$/);
                    if (match) {
                        const id = match[1];
                        const audio = match[2];
                        await this.handleAssistirFilme(chatId, userId, id, callbackQuery, audio);
                    }
                    break;
                }
                case data.match(/^assistir_filme_(\d+)$/)?.input: {
                    const id = data.match(/^assistir_filme_(\d+)$/)?.[1];
                    if (id) await this.handleAssistirFilme(chatId, userId, id, callbackQuery, 'dublado');
                    break;
                }
                case data.match(/^assistir_serie_(\d+)$/)?.input: {
                    const id = data.match(/^assistir_serie_(\d+)$/)?.[1];
                    if (id) await this.handleAssistirSerie(chatId, userId, id, callbackQuery);
                    break;
                }
                // Callbacks para enviar conteúdo (legado)
                case data.match(/^enviar_filme_(\d+)$/)?.input:
                    const filmeId = data.match(/^enviar_filme_(\d+)$/)?.[1];
                    if (filmeId) {
                        await this.handleInfoFilme(chatId, userId, filmeId, callbackQuery);
                    }
                    break;
                case data.match(/^enviar_serie_(\d+)$/)?.input:
                    const serieId = data.match(/^enviar_serie_(\d+)$/)?.[1];
                    if (serieId) {
                        await this.handleInfoSerie(chatId, userId, serieId, callbackQuery);
                    }
                    break;
                // Callbacks para confirmar pedidos
                case data.match(/^confirmar_pedido_(\d+)$/)?.input:
                    const pedidoIdConfirmar = data.match(/^confirmar_pedido_(\d+)$/)?.[1];
                    if (pedidoIdConfirmar) {
                        await this.handleConfirmarPedido(chatId, userId, pedidoIdConfirmar, callbackQuery);
                    }
                    break;
                case data.match(/^cancelar_pedido_(\d+)$/)?.input:
                    const pedidoIdCancelar = data.match(/^cancelar_pedido_(\d+)$/)?.[1];
                    if (pedidoIdCancelar) {
                        await this.handleCancelarPedido(chatId, userId, pedidoIdCancelar, callbackQuery);
                    }
                    break;
                case data.match(/^confirmar_similar_(.+)$/)?.input:
                    const nomeSimilar = data.match(/^confirmar_similar_(.+)$/)?.[1];
                    if (nomeSimilar) {
                        await this.handleConfirmarSimilar(chatId, userId, nomeSimilar, callbackQuery);
                    }
                    break;
                // Callbacks de planos
                case 'plano_mensal':
                    await this.handlePlanoEscolhido(chatId, userId, 'mensal', callbackQuery);
                    break;
                case 'plano_trimestral':
                    await this.handlePlanoEscolhido(chatId, userId, 'trimestral', callbackQuery);
                    break;
                case 'plano_semestral':
                    await this.handlePlanoEscolhido(chatId, userId, 'semestral', callbackQuery);
                    break;
                case 'plano_anual':
                    await this.handlePlanoEscolhido(chatId, userId, 'anual', callbackQuery);
                    break;
                // Callbacks de renovação
                case 'renovar_plano':
                    await this.handleRenovarPlano(chatId, userId, callbackQuery);
                    break;
                case 'mudar_plano':
                    await this.handleMudarPlano(chatId, userId, callbackQuery);
                    break;
                case 'menu_fila':
                    await this.handleFila({ chat: { id: chatId }, from: { id: userId } });
                    break;
                case 'admin_rebaixar_prompt':
                    await this.bot.sendMessage(chatId, 
                        '🔄 *Re-baixar / Atualizar Mídia*\n\n' +
                        'Envie o comando no seguinte formato:\n' +
                        '`/rebaixar <nome do filme ou série>`\n\n' +
                        '*Exemplo:* `/rebaixar Homem-Aranha`\n\n' +
                        '✨ O bot buscará a melhor versão oficial 1080p WEB-DL / BluRay e substituirá automaticamente no catálogo!',
                        { parse_mode: 'Markdown' }
                    );
                    break;
                case 'admin_pedidos':
                    await this.handleAdminPedidosButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_assinaturas':
                    await this.handleAdminAssinaturasButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_stremio':
                    await this.handleAdminStremioButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_gerar_token_vitalicio':
                    await this.handleAdminGerarTokenVitalicio(chatId, userId, callbackQuery);
                    break;
                case 'admin_autorizar_user_prompt':
                    await this.handleAdminAutorizarUserPrompt(chatId, userId, callbackQuery);
                    break;
                case 'admin_listar_vitalicios':
                    await this.handleAdminListarVitalicios(chatId, userId, callbackQuery);
                    break;
                case 'admin_revogar_prompt':
                    await this.handleAdminRevogarPrompt(chatId, userId, callbackQuery);
                    break;
                case 'admin_stats':
                    await this.handleAdminStatsButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_adicionar':
                    await this.handleAdminAdicionarButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_verificar':
                    await this.handleAdminVerificarButton(chatId, userId, callbackQuery);
                    break;
                case 'admin_testar_cliente':
                    await this.handleAdminTestarCliente(chatId, userId, callbackQuery);
                    break;
                case 'admin_criar_assinatura_teste':
                    await this.handleAdminCriarAssinaturaTeste(chatId, userId, callbackQuery);
                    break;
                case 'admin_remover_assinatura_teste':
                    await this.handleAdminRemoverAssinaturaTeste(chatId, userId, callbackQuery);
                    break;
                case 'admin_gerenciar_catalogo':
                    await this.handleAdminGerenciarCatalogo(chatId, userId, callbackQuery);
                    break;

                case 'admin_gerenciar_filmes':
                    await this.handleAdminGerenciarFilmes(chatId, userId, callbackQuery);
                    break;
                case 'admin_gerenciar_series':
                    await this.handleAdminGerenciarSeries(chatId, userId, callbackQuery);
                    break;
                // Callbacks para gerenciamento de pedidos admin
                case data.match(/^admin_pedido_detalhes_(\d+)$/)?.input:
                    const pedidoIdDetalhes = data.match(/^admin_pedido_detalhes_(\d+)$/)?.[1];
                    if (pedidoIdDetalhes) {
                        await this.handleAdminPedidoDetalhes(chatId, userId, pedidoIdDetalhes, callbackQuery);
                    }
                    break;
                case data.match(/^admin_pedidos_pagina_(\d+)$/)?.input:
                    const paginaPedidos = data.match(/^admin_pedidos_pagina_(\d+)$/)?.[1];
                    if (paginaPedidos) {
                        await this.mostrarPedidosAdmin(chatId, userId, parseInt(paginaPedidos));
                    }
                    break;
                case 'admin_pedidos_todos':
                    await this.handleAdminPedidosTodos(chatId, userId, callbackQuery);
                    break;
                case data.match(/^admin_pedido_processar_(\d+)$/)?.input:
                    const pedidoIdProcessar = data.match(/^admin_pedido_processar_(\d+)$/)?.[1];
                    if (pedidoIdProcessar) {
                        await this.handleAdminPedidoProcessar(chatId, userId, pedidoIdProcessar, callbackQuery);
                    }
                    break;
                case data.match(/^admin_pedido_cancelar_(\d+)$/)?.input:
                    const pedidoIdCancelarAdmin = data.match(/^admin_pedido_cancelar_(\d+)$/)?.[1];
                    if (pedidoIdCancelarAdmin) {
                        await this.handleAdminPedidoCancelar(chatId, userId, pedidoIdCancelarAdmin, callbackQuery);
                    }
                    break;
                case 'cancelar_operacao':
                    await this.handleCancelarOperacao(chatId, userId, callbackQuery);
                    break;
                case 'teste_gratuito':
                    await this.handleTesteGratuito(chatId, userId, callbackQuery);
                    break;
                case 'teste_catalogo':
                    await this.handleTesteCatalogo(chatId, userId, callbackQuery);
                    break;
                case 'teste_filmes':
                    await this.handleTesteFilmes(chatId, userId, callbackQuery);
                    break;
                case 'teste_series':
                    await this.handleTesteSeries(chatId, userId, callbackQuery);
                    break;
                case 'teste_buscar':
                    await this.handleTesteBuscar(chatId, userId, callbackQuery);
                    break;
                case 'teste_pedido':
                    await this.handleTestePedido(chatId, userId, callbackQuery);
                    break;
                // Callbacks para selecionar itens para exclusão
                case data.match(/^selecionar_filme_(\d+)$/)?.input:
                    const filmeIdSelecionar = data.match(/^selecionar_filme_(\d+)$/)?.[1];
                    if (filmeIdSelecionar) {
                        await this.handleAdminSelecionarFilme(chatId, userId, filmeIdSelecionar, callbackQuery);
                    }
                    break;
                case data.match(/^selecionar_serie_(\d+)$/)?.input:
                    const serieIdSelecionar = data.match(/^selecionar_serie_(\d+)$/)?.[1];
                    if (serieIdSelecionar) {
                        await this.handleAdminSelecionarSerie(chatId, userId, serieIdSelecionar, callbackQuery);
                    }
                    break;
                // Callbacks para confirmar exclusão
                case data.match(/^confirmar_excluir_filme_(\d+)$/)?.input:
                    const filmeIdConfirmar = data.match(/^confirmar_excluir_filme_(\d+)$/)?.[1];
                    if (filmeIdConfirmar) {
                        await this.handleAdminExcluirFilme(chatId, userId, filmeIdConfirmar, callbackQuery);
                    }
                    break;
                case data.match(/^confirmar_excluir_serie_(\d+)$/)?.input:
                    const serieIdConfirmar = data.match(/^confirmar_excluir_serie_(\d+)$/)?.[1];
                    if (serieIdConfirmar) {
                        await this.handleAdminExcluirSerie(chatId, userId, serieIdConfirmar, callbackQuery);
                    }
                    break;
                // Callbacks para teste gratuito
                case data.match(/^confirmar_teste_filme_(\d+)$/)?.input:
                    const filmeIdTeste = data.match(/^confirmar_teste_filme_(\d+)$/)?.[1];
                    if (filmeIdTeste) {
                        await this.handleConfirmarTesteFilme(chatId, userId, filmeIdTeste, callbackQuery);
                    }
                    break;
                case data.match(/^confirmar_teste_serie_(\d+)$/)?.input:
                    const serieIdTeste = data.match(/^confirmar_teste_serie_(\d+)$/)?.[1];
                    if (serieIdTeste) {
                        await this.handleConfirmarTesteSerie(chatId, userId, serieIdTeste, callbackQuery);
                    }
                    break;
                case data.match(/^executar_teste_filme_(\d+)$/)?.input:
                    const filmeIdExecutar = data.match(/^executar_teste_filme_(\d+)$/)?.[1];
                    if (filmeIdExecutar) {
                        await this.handleExecutarTesteFilme(chatId, userId, filmeIdExecutar, callbackQuery);
                    }
                    break;
                case data.match(/^executar_teste_serie_(\d+)$/)?.input:
                    const serieIdExecutar = data.match(/^executar_teste_serie_(\d+)$/)?.[1];
                    if (serieIdExecutar) {
                        await this.handleExecutarTesteSerie(chatId, userId, serieIdExecutar, callbackQuery);
                    }
                    break;

                default:
                    console.log(`❌ Callback não reconhecido: ${data}`);
                    // Comando não reconhecido - sem notificação
            }
        } catch (error) {
            console.error('❌ Erro no callback:', error);
            // Erro interno - sem notificação
        }
    }

    async handlePedidoButton(chatId, userId, callbackQuery) {
        this.estadosTemporarios[userId] = {
            tipo: 'pedido',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `🎬 *Fazer Pedido de Filme ou Série*\n\n` +
                        `Não encontrou o que queria no catálogo? Envie o nome do título para o robô localizar e baixar em 1080p Full HD!\n\n` +
                        `💡 *Exemplos:*\n` +
                        `• \`Avatar: Fogo e Cinzas (2025)\`\n` +
                        `• \`Round 6 - Temporada 2\`\n` +
                        `• \`Divertida Mente 2\`\n\n` +
                        `✨ _Assinantes VIP têm prioridade máxima na fila de download!_`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '❌ Cancelar', callback_data: 'cancelar_operacao' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleBuscarButton(chatId, userId, callbackQuery) {
        this.estadosTemporarios[userId] = {
            tipo: 'busca',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `🔍 *Pesquisar no Catálogo BrasilFlix*\n\n` +
                        `Digite o nome do filme, série ou dorama que deseja encontrar:\n\n` +
                        `💡 *Exemplos:*\n` +
                        `• \`Obsessão\`\n` +
                        `• \`Supergirl\`\n` +
                        `• \`Harry Potter\`\n\n` +
                        `_O robô aceita buscas fonéticas e variações ortográficas!_`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '❌ Cancelar', callback_data: 'cancelar_operacao' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleCatalogoButton(chatId, userId, callbackQuery) {
        await this.mostrarMenuCatalogo(chatId, userId, callbackQuery);
    }

    async mostrarMenuCatalogo(chatId, userId, callbackQuery) {
        const stats = this.catalogoManager.getEstatisticas();
        
        const mensagem = `📚 *Catálogo BrasilFlix*\n\n` +
                        `🎬 *Filmes:* ${stats.totalFilmes}\n` +
                        `📺 *Séries & Doramas:* ${stats.totalSeries}\n` +
                        `📊 *Total de Títulos:* ${stats.total}\n\n` +
                        `💡 _[D] Dublado | [L] Legendado | [D/L] Ambos_\n\n` +
                        `Escolha uma opção para navegar:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `🎬 Filmes (${stats.totalFilmes})`, callback_data: 'catalogo_filmes' },
                    { text: `📺 Séries (${stats.totalSeries})`, callback_data: 'catalogo_series' }
                ],
                [
                    { text: '🎭 Explorar por Categorias', callback_data: 'catalogo_categorias' }
                ],
                [
                    { text: '🔍 Buscar no Catálogo', callback_data: 'buscar' }
                ],
                [
                    { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleCatalogoCategorias(chatId, userId, callbackQuery) {
        const generos = this.catalogoManager.getGenerosDisponiveis();

        if (!generos || generos.length === 0) {
            await this.sendOrEdit(chatId, 
                `📭 Nenhuma categoria encontrada no catálogo no momento.`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🔍 Fazer Busca', callback_data: 'buscar' }],
                            [{ text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }]
                        ]
                    }
                },
                callbackQuery
            );
            return;
        }

        const iconesGeneros = {
            'ação': '💥', 'aventura': '🏹', 'animação': '🎨', 'comédia': '😂',
            'crime': '🕵️', 'documentário': '📽️', 'drama': '🎭', 'família': '👨‍👩‍👧',
            'fantasia': '🧙', 'ficção científica': '🚀', 'guerra': '⚔️', 'história': '📜',
            'mistério': '🔍', 'música': '🎵', 'romance': '💖', 'suspense': '😱',
            'terror': '👻', 'faroeste': '🤠'
        };

        const keyboard = { inline_keyboard: [] };
        let row = [];

        generos.forEach(g => {
            const icone = iconesGeneros[g.nome.toLowerCase()] || '🎬';
            row.push({
                text: `${icone} ${g.nome} (${g.count})`,
                callback_data: `genero_${encodeURIComponent(g.nome)}_0`
            });
            if (row.length === 2) {
                keyboard.inline_keyboard.push(row);
                row = [];
            }
        });
        if (row.length > 0) keyboard.inline_keyboard.push(row);

        keyboard.inline_keyboard.push([
            { text: '🔍 Fazer Busca', callback_data: 'buscar' },
            { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
        ]);

        const mensagem = `🎭 *Categorias & Gêneros BrasilFlix*\n\n` +
                        `Escolha um gênero para ver todos os filmes e séries disponíveis:`;

        await this.sendOrEdit(chatId, mensagem, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleCategoriaFiltrada(chatId, userId, generoNome, pagina = 0, callbackQuery = null) {
        const generoDecodificado = decodeURIComponent(generoNome);
        const itens = this.catalogoManager.getItemsPorGenero(generoDecodificado);

        if (!itens || itens.length === 0) {
            await this.sendOrEdit(chatId, 
                `📭 Nenhum título encontrado na categoria *${generoDecodificado}*.`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '🎭 Outras Categorias', callback_data: 'catalogo_categorias' }],
                            [{ text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }]
                        ]
                    }
                },
                callbackQuery
            );
            return;
        }

        const itensPorPagina = 8;
        const totalPaginas = Math.ceil(itens.length / itensPorPagina);
        const paginaAtual = Math.max(0, Math.min(pagina, totalPaginas - 1));

        const inicio = paginaAtual * itensPorPagina;
        const fim = Math.min(inicio + itensPorPagina, itens.length);
        const itensPagina = itens.slice(inicio, fim);

        const mensagem = `🎭 *Categoria:* ${generoDecodificado}\n` +
                        `💡 _[D] Dublado | [L] Legendado | [D/L] Ambos_\n\n` +
                        `📊 Mostrando ${inicio + 1}-${fim} de ${itens.length} título(s)\n\n` +
                        `Selecione para ver a sinopse e assistir:`;

        const keyboard = { inline_keyboard: [] };

        itensPagina.forEach(item => {
            const icone = item.tipo === 'filme' ? '🎬' : '📺';
            const ano = item.ano ? ` (${item.ano})` : '';
            const nota = item.nota ? ` ⭐ ${item.nota}` : '';
            const badge = this.catalogoManager.getAudioBadge(item);
            const badgeStr = badge ? ` ${badge}` : '';
            const nomeExibicao = `${icone} ${item.nome}${ano}${badgeStr}${nota}`;
            const callbackData = item.tipo === 'filme' ? `info_filme_${item.id}` : `info_serie_${item.id}`;

            keyboard.inline_keyboard.push([
                { text: nomeExibicao.length > 34 ? nomeExibicao.substring(0, 31) + '...' : nomeExibicao, callback_data: callbackData }
            ]);
        });

        const botoesNavegacao = [];
        if (totalPaginas > 1) {
            if (paginaAtual > 0) {
                botoesNavegacao.push({ text: '⬅️ Anterior', callback_data: `genero_${encodeURIComponent(generoDecodificado)}_${paginaAtual - 1}` });
            }
            if (paginaAtual < totalPaginas - 1) {
                botoesNavegacao.push({ text: 'Próxima ➡️', callback_data: `genero_${encodeURIComponent(generoDecodificado)}_${paginaAtual + 1}` });
            }
        }
        if (botoesNavegacao.length > 0) {
            keyboard.inline_keyboard.push(botoesNavegacao);
        }

        keyboard.inline_keyboard.push([
            { text: '🎭 Outras Categorias', callback_data: 'catalogo_categorias' },
            { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
        ]);

        await this.sendOrEdit(chatId, mensagem, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleAssinaturaButton(chatId, userId, callbackQuery) {
        console.log(`💎 handleAssinaturaButton chamado para usuário ${userId}`);
        
        const assinatura = this.assinaturaManager.getAssinatura(userId);
        
        if (!assinatura) {
            // Usuário sem assinatura - mostrar planos com foco em vendas
            const mensagem = `💎 *Planos VIP BrasilFlix*\n\n` +
                           `🍿 *Acesso Ilimitado a Todos os Filmes e Séries em 1080p Full HD!*\n\n` +
                           `• 🥉 *Mensal:* R$ 15,00 / mês\n` +
                           `• 🥈 *Trimestral (3 meses):* R$ 38,00 _(R$ 12,66/mês - 15% OFF)_\n` +
                           `• 🥇 *Semestral (6 meses):* R$ 69,00 _(R$ 11,50/mês - 23% OFF)_\n` +
                           `• 👑 *Anual (12 meses):* R$ 120,00 _(R$ 10,00/mês - 33% OFF)_\n\n` +
                           `⚡ *Liberação instantânea via PIX automático!*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🥉 Mensal - R$ 15', callback_data: 'plano_mensal' },
                        { text: '🥈 Trimestral - R$ 38', callback_data: 'plano_trimestral' }
                    ],
                    [
                        { text: '🥇 Semestral - R$ 69', callback_data: 'plano_semestral' },
                        { text: '👑 Anual - R$ 120', callback_data: 'plano_anual' }
                    ],
                    [
                        { text: '❓ Como Funciona', callback_data: 'como_funciona' },
                        { text: '📞 Suporte', callback_data: 'suporte' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.sendOrEdit(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            }, callbackQuery);
        } else {
            // Usuário com assinatura - mostrar status e opções de renovação
            const info = this.assinaturaManager.formatarAssinatura(assinatura);
            
            const mensagem = `📋 *Minha Assinatura VIP*\n\n` +
                           `👤 *Usuário:* ${assinatura.username}\n` +
                           `📅 *Plano:* ${info.plano}\n` +
                           `⭐ *Status:* 🟢 Ativa\n` +
                           `📅 *Vencimento:* ${info.vencimento}\n` +
                           `⏰ *Dias restantes:* ${info.diasRestantes}\n\n` +
                           `Deseja estender ou alterar seu plano?`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Renovar Plano', callback_data: 'renovar_plano' },
                        { text: '💎 Ver Planos', callback_data: 'ver_planos' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.sendOrEdit(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            }, callbackQuery);
        }
        
        // Responder ao callback query se existir
        if (callbackQuery) {
            try {
                await this.bot.answerCallbackQuery(callbackQuery.id);
            } catch (error) {
                console.error('❌ Erro ao responder callback query:', error);
            }
        }
    }

    async handleMinhaAssinaturaButton(chatId, userId, callbackQuery) {
        const assinatura = this.assinaturaManager.getAssinatura(userId);
        
        if (!assinatura) {
            const mensagem = `📋 *Minha Assinatura*\n\n` +
                           `Você ainda não tem uma assinatura ativa.\n\n` +
                           `Use o botão "💳 Assinar" para assinar o BrasilFlix!`;
            
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
        } else {
            const info = this.assinaturaManager.formatarAssinatura(assinatura);
            
            const mensagem = `📋 *Minha Assinatura*\n\n` +
                           `👤 *Usuário:* ${assinatura.username}\n` +
                           `📅 *Plano:* ${info.plano}\n` +
                           `⭐ *Status:* ${info.status}\n` +
                           `📅 *Vencimento:* ${info.vencimento}\n` +
                           `⏰ *Dias restantes:* ${info.diasRestantes}\n\n` +
                           `💡 *Gerencie sua assinatura:*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Renovar Assinatura', callback_data: 'renovar_assinatura' },
                        { text: '⏰ Estender Plano', callback_data: 'estender_assinatura' }
                    ],
                    [
                        { text: '📋 Ver Planos', callback_data: 'ver_planos' },
                        { text: '🔙 Voltar', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    async handleRenovarAssinatura(chatId, userId, callbackQuery) {
        const assinatura = this.assinaturaManager.getAssinatura(userId);
        
        if (!assinatura) {
            await this.bot.sendMessage(chatId, '❌ Você não tem uma assinatura ativa para renovar.');
            return;
        }

        const mensagem = `🔄 *Renovar Assinatura*\n\n` +
                        `📅 *Plano Atual:* ${assinatura.plano}\n` +
                        `📅 *Vencimento:* ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n\n` +
                        `💡 *Escolha como renovar sua assinatura:*\n\n` +
                        `💎 *Renovar mesmo plano:*\n` +
                        `• Mantém seu plano atual\n` +
                        `• Renova a partir do vencimento\n\n` +
                        `💎 *Mudar de plano:*\n` +
                        `• Escolha um novo plano\n` +
                        `• Inicia imediatamente`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔄 Renovar Mesmo Plano', callback_data: 'renovar_mesmo_plano' },
                    { text: '💎 Mudar de Plano', callback_data: 'ver_planos' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'minha_assinatura' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleVerPedidosButton(chatId, userId, callbackQuery) {
        const pedidos = this.pedidosManager.getPedidosPorUsuario(userId);
        
        if (pedidos.length === 0) {
            const mensagem = `📝 *Meus Pedidos*\n\n` +
                           `Você ainda não fez nenhum pedido no BrasilFlix.\n\n` +
                           `💡 *Use o botão abaixo para solicitar qualquer título!*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🎬 Fazer Novo Pedido', callback_data: 'pedido' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.sendOrEdit(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            }, callbackQuery);
            return;
        }

        let mensagem = `📝 *Meus Pedidos*\n\n`;
        
        // Mostrar apenas os últimos 5 pedidos para não sobrecarregar
        const pedidosRecentes = pedidos.slice(-5).reverse();
        
        pedidosRecentes.forEach((pedido, index) => {
            const status = pedido.processado ? '✅ No Catálogo' : '⏳ Na Fila de Download';
            const data = new Date(pedido.data).toLocaleDateString('pt-BR');
            
            mensagem += `${index + 1}. *${pedido.nome}*\n` +
                       `   📅 ${data} | ${status}\n\n`;
        });

        if (pedidos.length > 5) {
            mensagem += `📊 *Total de pedidos:* ${pedidos.length}\n`;
            mensagem += `💡 *Mostrando os 5 mais recentes*\n\n`;
        }

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🎬 Fazer Novo Pedido', callback_data: 'pedido' }
                ],
                [
                    { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleEstenderAssinatura(chatId, userId, callbackQuery) {
        const assinatura = this.assinaturaManager.getAssinatura(userId);
        
        if (!assinatura) {
            await this.bot.sendMessage(chatId, '❌ Você não tem uma assinatura ativa para estender.');
            return;
        }

        const mensagem = `⏰ *Estender Assinatura*\n\n` +
                        `📅 *Plano Atual:* ${assinatura.plano}\n` +
                        `📅 *Vencimento:* ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n\n` +
                        `💡 *Adicione tempo extra à sua assinatura:*\n\n` +
                        `💎 *Extensões disponíveis:*\n` +
                        `• +1 mês: R$ 19,90\n` +
                        `• +3 meses: R$ 49,90\n` +
                        `• +6 meses: R$ 89,90\n\n` +
                        `✨ *Extensões se somam ao tempo atual!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '⏰ +1 Mês', callback_data: 'estender_1_mes' },
                    { text: '⏰ +3 Meses', callback_data: 'estender_3_meses' }
                ],
                [
                    { text: '⏰ +6 Meses', callback_data: 'estender_6_meses' },
                    { text: '🔙 Voltar', callback_data: 'minha_assinatura' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleVerPlanosButton(chatId, userId, callbackQuery) {
        const mensagem = `💎 *Planos VIP BrasilFlix*\n\n` +
                        `Assista a filmes e séries ilimitados em 1080p Full HD direto no Telegram!\n\n` +
                        `• 🥉 *Mensal:* R$ 15,00 / mês\n` +
                        `• 🥈 *Trimestral (3 meses):* R$ 38,00 _(R$ 12,66/mês - 15% OFF)_\n` +
                        `• 🥇 *Semestral (6 meses):* R$ 69,00 _(R$ 11,50/mês - 23% OFF)_\n` +
                        `• 👑 *Anual (12 meses):* R$ 120,00 _(R$ 10,00/mês - 33% OFF)_\n\n` +
                        `⚡ *Liberação instantânea via PIX automático!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🥉 Mensal - R$ 15', callback_data: 'plano_mensal' },
                    { text: '🥈 Trimestral - R$ 38', callback_data: 'plano_trimestral' }
                ],
                [
                    { text: '🥇 Semestral - R$ 69', callback_data: 'plano_semestral' },
                    { text: '👑 Anual - R$ 120', callback_data: 'plano_anual' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async handleComoFuncionaButton(chatId, userId, callbackQuery) {
        // Verificar se é assinante para mostrar conteúdo diferente
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        
        if (isAssinante) {
            const mensagem = `❓ *Como Funciona o BrasilFlix*\n\n` +
                            `🎬 *1. Navegue pelo Catálogo*\n` +
                            `Explore milhares de filmes e séries organizados\n\n` +
                            `🔍 *2. Use a Busca*\n` +
                            `Encontre rapidamente o que procura\n\n` +
                            `📝 *3. Faça Seus Pedidos*\n` +
                            `Solicite qualquer filme ou série que não esteja no catálogo\n\n` +
                            `🚀 *4. Receba Instantaneamente*\n` +
                            `Entrega rápida e segura\n\n` +
                            `⭐ *5. Aproveite com Prioridade*\n` +
                            `Você tem acesso exclusivo a todo conteúdo\n\n` +
                            `💡 *É simples assim! Aproveite seu acesso premium.*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📚 Ir ao Catálogo', callback_data: 'catalogo' },
                        { text: '🔍 Fazer Busca', callback_data: 'buscar' }
                    ],
                    [
                        { text: '🔙 Voltar', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } else {
            const mensagem = `❓ *Como Funciona o BrasilFlix*\n\n` +
                            `🎬 *1. Navegue Livremente*\n` +
                            `Explore o catálogo e descubra conteúdo\n\n` +
                            `🔍 *2. Faça Seus Pedidos*\n` +
                            `Solicite qualquer filme ou série\n\n` +
                            `💎 *3. Assine para Receber*\n` +
                            `Para receber o conteúdo, assine um plano\n\n` +
                            `🚀 *4. Receba Instantaneamente*\n` +
                            `Entrega rápida e segura\n\n` +
                            `⭐ *5. Aproveite com Prioridade*\n` +
                            `Assinantes têm acesso completo\n\n` +
                            `💡 *É simples assim! Navegue agora e assine quando quiser.*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📚 Ir ao Catálogo', callback_data: 'catalogo' },
                        { text: '🔍 Fazer Busca', callback_data: 'buscar' }
                    ],
                    [
                        { text: '💎 Ver Planos', callback_data: 'ver_planos' }
                    ],
                    [
                        { text: '🔙 Voltar', callback_data: 'voltar_menu' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    async handleSuporteButton(chatId, userId, callbackQuery) {
        // Ativar modo de captura para receber a mensagem de suporte do usuário
        this.estadosTemporarios[userId] = {
            tipo: 'suporte',
            ativo: true,
            timestamp: Date.now(),
            chatId: chatId
        };

        const mensagem = `📞 *Central de Atendimento BrasilFlix*\n\n` +
                        `Olá! Como podemos ajudar você hoje?\n\n` +
                        `💬 *Contato direto:* @DPovea\n\n` +
                        `✍️ *Envie sua mensagem agora mesmo:*\n` +
                        `Basta digitar sua dúvida, problema ou sugestão aqui abaixo no chat. Nossa equipe receberá sua solicitação e entrará em contato com você!`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '❌ Cancelar / Voltar ao Menu', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }, callbackQuery);
    }

    async mostrarMenuNaoAssinante(chatId, userId, callbackQuery) {
        const mensagem = `🔒 *Acesso Restrito*\n\n` +
                        `Esta funcionalidade é exclusiva para assinantes!\n\n` +
                        `✨ *Benefícios da Assinatura:*\n` +
                        `• 🎭 Acesso a milhares de filmes e séries\n` +
                        `• 🚀 Entrega instantânea e segura\n` +
                        `• ⭐ Prioridade total nos pedidos\n` +
                        `• 📱 Suporte 24/7 exclusivo\n\n` +
                        `💡 *Assine agora e desbloqueie todo o conteúdo!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💎 ASSINAR AGORA', callback_data: 'assinatura' }
                ],
                [
                    { text: '📋 Ver Planos', callback_data: 'ver_planos' },
                    { text: '❓ Como Funciona', callback_data: 'como_funciona' }
                ],
                [
                    { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async mostrarMensagemConversao(chatId, userId, callbackQuery) {
        const mensagem = `💎 *Conteúdo Exclusivo para Assinantes*\n\n` +
                        `🎬 *Você encontrou o que procurava!*\n\n` +
                        `✨ *Para manter nossos servidores e oferecer:*\n` +
                        `• 🎭 Milhares de filmes e séries\n` +
                        `• 🚀 Entrega instantânea e segura\n` +
                        `• ⭐ Qualidade premium garantida\n` +
                        `• 📱 Suporte 24/7 exclusivo\n` +
                        `• 🔄 Atualizações constantes\n\n` +
                        `💡 *É barato, rápido e você pode cancelar quando quiser!*\n\n` +
                        `🔥 *Assine agora e receba o conteúdo imediatamente!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '💎 ASSINAR AGORA - R$ 19,90/mês', callback_data: 'assinatura' }
                ],
                [
                    { text: '📋 Ver Todos os Planos', callback_data: 'ver_planos' },
                    { text: '❓ Como Funciona', callback_data: 'como_funciona' }
                ],
                [
                    { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }



    async handleVoltarMenu(chatId, userId, callbackQuery) {
        if (this.estadosTemporarios[userId]) {
            delete this.estadosTemporarios[userId];
        }
        
        const username = callbackQuery?.from?.username || callbackQuery?.from?.first_name || 'Usuário';
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;
        if (isAssinante) {
            await this.handleAssinanteStart({ chat: { id: chatId }, from: { id: userId, username } }, callbackQuery);
        } else {
            await this.handleNaoAssinanteStart({ chat: { id: chatId }, from: { id: userId, username } }, callbackQuery);
        }
    }

    async handleVoltarMenuAdmin(chatId, userId, callbackQuery) {
        if (this.estadosTemporarios[userId]) {
            delete this.estadosTemporarios[userId];
        }
        
        await this.handleAdminStart({ chat: { id: chatId }, from: { id: userId, username: 'Admin' } }, callbackQuery);
    }

    async sendOrEdit(chatId, text, options = {}, callbackQuery = null) {
        if (callbackQuery && callbackQuery.message) {
            try {
                return await this.bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    parse_mode: options.parse_mode || 'Markdown',
                    reply_markup: options.reply_markup,
                    disable_web_page_preview: options.disable_web_page_preview
                });
            } catch (err) {
                // Se a mensagem for idêntica ou não puder ser editada, continua
                if (err.message && err.message.includes('message is not modified')) {
                    return callbackQuery.message;
                }
            }
        }
        return await this.bot.sendMessage(chatId, text, options);
    }

    async handleEnviarFilme(chatId, userId, filmeId, callbackQuery) {
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        const jaUsouTeste = this.verificarTesteGratuitoUsado(userId);

        // Se não for assinante
        if (!isAssinante) {
            if (!jaUsouTeste) {
                // Consome o teste gratuito
                this.marcarTesteGratuitoUsado(userId);
                console.log(`🎁 Usuário ${userId} utilizou seu teste gratuito no filme ID ${filmeId}`);
            } else {
                // Já usou o teste, pede para assinar
                await this.mostrarMensagemConversao(chatId, userId, callbackQuery);
                return;
            }
        }

        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
            return;
        }

        try {
            // Reenviar arquivo do grupo de armazenamento
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, filme.messageId);
            
            let mensagem = `✅ *${filme.nome}*\n\n` +
                           `📝 ${filme.descricao || filme.sinopse || 'Disponível em alta qualidade'}\n` +
                           `✨ Qualidade: ${filme.qualidade || '1080p Full HD'} | 🔊 Áudio: ${filme.audio || 'Dublado'}\n\n`;

            if (!isAssinante) {
                mensagem += `🎁 *Você utilizou seu Teste Gratuito de 1 filme!*\n` +
                            `Esperamos que aproveite a experiência BrasilFlix.\n\n` +
                            `💡 *Assine agora para ter acesso ilimitado a todos os filmes e séries!*`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '💎 Assinar BrasilFlix', callback_data: 'assinatura' }],
                        [{ text: '🍿 Menu Principal', callback_data: 'voltar_menu' }]
                    ]
                };
                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard });
            } else {
                mensagem += `🎉 *Bom filme, assinante VIP!*`;
                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            }
            
        } catch (error) {
            console.error('❌ Erro ao enviar filme:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar filme. Tente novamente ou contate o suporte.');
        }
    }

    async handleEnviarSerie(chatId, userId, serieId, callbackQuery) {
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        const jaUsouTeste = this.verificarTesteGratuitoUsado(userId);

        if (!isAssinante) {
            if (!jaUsouTeste) {
                this.marcarTesteGratuitoUsado(userId);
                console.log(`🎁 Usuário ${userId} utilizou seu teste gratuito na série ID ${serieId}`);
            } else {
                await this.mostrarMensagemConversao(chatId, userId, callbackQuery);
                return;
            }
        }

        const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
        
        if (!serie) {
            await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
            return;
        }

        try {
            if (serie.messageId) {
                await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, serie.messageId);
            }
            
            const mensagem = `✅ *${serie.nome}*\n\n` +
                           `📝 ${serie.descricao || serie.sinopse || 'Disponível em alta qualidade'}\n` +
                           `📺 Tipo: Série / Dorama\n\n` +
                           `🎉 *Aproveite os episódios!*`;
            
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            
        } catch (error) {
            console.error('❌ Erro ao enviar série:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar série. Tente novamente.');
        }
    }

    async handleAjudaButton(chatId, userId, callbackQuery) {
        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        
        if (isAssinante) {
            const mensagem = `❓ *Ajuda - BrasilFlix*\n\n` +
                            `*Comandos principais:*\n\n` +
                            `📝 *Fazer Pedido*\n` +
                            `\`/pedido Nome do Filme\`\n\n` +
                            `🔍 *Buscar*\n` +
                            `\`/buscar Termo\`\n\n` +
                            `📚 *Catálogo*\n` +
                            `Navegue pelos filmes e séries disponíveis\n\n` +
                            `💳 *Minha Assinatura*\n` +
                            `Veja o status da sua assinatura\n\n` +
                            `*Dicas:*\n` +
                            `• Seja específico nos pedidos\n` +
                            `• Use /buscar antes de pedir\n` +
                            `• Navegue pelo catálogo para descobrir conteúdo\n\n` +
                            `📞 *Precisa de ajuda?*\n` +
                            `Entre em contato: @DPovea`;

            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
        } else {
            const mensagem = `❓ *Ajuda - BrasilFlix*\n\n` +
                            `🎬 *Como Funciona:*\n\n` +
                            `1️⃣ *Navegue Livremente*\n` +
                            `Explore o catálogo e faça pedidos\n\n` +
                            `2️⃣ *Assine para Receber*\n` +
                            `Para receber o conteúdo, assine um plano\n\n` +
                            `3️⃣ *Aproveite o Conteúdo*\n` +
                            `Entrega rápida e segura\n\n` +
                            `✨ *Benefícios da Assinatura:*\n` +
                            `• Acesso completo a milhares de filmes e séries\n` +
                            `• Prioridade total nos pedidos\n` +
                            `• Suporte 24/7 exclusivo\n\n` +
                            `💡 *Navegue agora e assine quando quiser!*\n\n` +
                            `📞 *Suporte:* @DPovea`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📚 Ir ao Catálogo', callback_data: 'catalogo' },
                        { text: '🔍 Fazer Busca', callback_data: 'buscar' }
                    ],
                    [
                        { text: '💎 Ver Planos', callback_data: 'ver_planos' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        }
    }

    // Métodos para planos e pagamentos
    async handlePlanoEscolhido(chatId, userId, plano, callbackQuery) {
        try {
            console.log(`💳 Processando plano escolhido: ${plano} para usuário ${userId}`);
            
            const username = 'Usuário'; // Será obtido do callback
            const pagamento = await this.assinaturaManager.criarPagamento(userId, username, plano);
            
            console.log('✅ Pagamento criado:', {
                id: pagamento.id,
                has_qr_code: !!pagamento.qr_code,
                has_qr_code_base64: !!pagamento.qr_code_base64
            });
            
            const mensagem = `💳 *Pagamento - Plano ${plano}*\n\n` +
                           `💰 *Valor:* R$ ${pagamento.preco.toFixed(2)}\n` +
                           `📅 *Vencimento:* ${new Date(pagamento.dataVencimento).toLocaleDateString('pt-BR')}\n\n` +
                           `Escolha sua forma de pagamento:`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔗 Link de Pagamento', callback_data: `link_${plano}` },
                        { text: '📱 PIX QR Code', callback_data: `pix_${plano}` }
                    ],
                    [
                        { text: '🔙 Voltar', callback_data: 'assinatura' }
                    ]
                ]
            };

            // Armazenar dados do pagamento temporariamente
            const pagamentoKey = `${userId}_${plano}`;
            this.pagamentosTemp[pagamentoKey] = pagamento;
            
            console.log(`💾 Pagamento armazenado com chave: ${pagamentoKey}`);
            console.log('📋 Pagamentos temporários atuais:', Object.keys(this.pagamentosTemp));

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
            // Responder ao callback query
            try {
                await this.bot.answerCallbackQuery(callbackQuery.id);
            } catch (error) {
                console.error('❌ Erro ao responder callback query:', error);
            }

        } catch (error) {
            console.error('❌ Erro ao processar plano:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao processar pagamento. Tente novamente.');
            
            // Responder ao callback query em caso de erro
            try {
                await this.bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Erro ao processar pagamento' });
            } catch (callbackError) {
                console.error('❌ Erro ao responder callback query:', callbackError);
            }
        }
    }

    async handleRenovarPlano(chatId, userId, callbackQuery) {
        const mensagem = `🔄 *Renovar Plano*\n\n` +
                        `Escolha como renovar sua assinatura:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔄 Renovar Mesmo Plano', callback_data: 'renovar_mesmo' },
                    { text: '📅 Mudar Plano', callback_data: 'mudar_plano' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'assinatura' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        

    }

    async handleMudarPlano(chatId, userId, callbackQuery) {
        const mensagem = `📅 *Mudar Plano*\n\n` +
                        `Escolha seu novo plano:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📅 Mensal - R$ 19,90', callback_data: 'plano_mensal' },
                    { text: '📅 Trimestral - R$ 49,90', callback_data: 'plano_trimestral' }
                ],
                [
                    { text: '📅 Anual - R$ 159,90', callback_data: 'plano_anual' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'assinatura' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
        

    }

    async handleLinkPagamento(chatId, userId, plano, callbackQuery) {
        console.log(`🔗 Buscando link de pagamento para usuário ${userId}, plano ${plano}`);
        
        const pagamento = this.pagamentosTemp?.[`${userId}_${plano}`];
        
        if (!pagamento) {
            console.log('❌ Pagamento não encontrado no cache temporário');
            await this.bot.sendMessage(chatId, '❌ Dados do pagamento não encontrados. Tente novamente.');
            return;
        }

        console.log('✅ Link de pagamento encontrado:', pagamento.init_point);

        const mensagem = `🔗 *Link de Pagamento*\n\n` +
                        `💰 *Plano:* ${plano}\n` +
                        `💵 *Valor:* R$ ${pagamento.preco.toFixed(2)}\n` +
                        `📅 *Vencimento:* ${new Date(pagamento.dataVencimento).toLocaleDateString('pt-BR')}\n\n` +
                        `Clique no link abaixo para pagar:\n` +
                        `🔗 [Pagar no Mercado Pago](${pagamento.init_point})\n\n` +
                        `Após o pagamento, sua assinatura será ativada automaticamente!`;

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        
        // Responder ao callback query
        try {
            await this.bot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            console.error('❌ Erro ao responder callback query:', error);
        }
    }

    async handlePixPagamento(chatId, userId, plano, callbackQuery) {
        console.log(`🔍 Buscando pagamento PIX para usuário ${userId}, plano ${plano}`);
        console.log('📋 Pagamentos temporários:', Object.keys(this.pagamentosTemp));
        
        const pagamento = this.pagamentosTemp?.[`${userId}_${plano}`];
        
        if (!pagamento) {
            console.log('❌ Pagamento não encontrado no cache temporário');
            await this.bot.sendMessage(chatId, '❌ Dados do pagamento não encontrados. Tente novamente.');
            return;
        }

        console.log('✅ Pagamento encontrado:', {
            id: pagamento.id,
            has_qr_code: !!pagamento.qr_code,
            has_qr_code_base64: !!pagamento.qr_code_base64,
            preco: pagamento.preco
        });

        let mensagem = `📱 *Pagamento PIX*\n\n` +
                      `💰 *Plano:* ${plano}\n` +
                      `💵 *Valor:* R$ ${pagamento.preco.toFixed(2)}\n` +
                      `📅 *Vencimento:* ${new Date(pagamento.dataVencimento).toLocaleDateString('pt-BR')}\n\n`;

        if (pagamento.qr_code) {
            mensagem += `📱 *QR Code PIX:*\n` +
                       `Escaneie o QR Code abaixo com seu app bancário\n\n` +
                       `📋 *Código PIX:*\n` +
                       `\`${pagamento.qr_code}\`\n\n` +
                       `💡 *Dica:* Copie o código acima e cole no seu app bancário`;

            // Enviar QR Code se disponível
            if (pagamento.qr_code_base64) {
                try {
                    console.log('🖼️ Tentando enviar QR Code como imagem...');
                    const qrBuffer = Buffer.from(pagamento.qr_code_base64, 'base64');
                    await this.bot.sendPhoto(chatId, qrBuffer, {
                        caption: mensagem,
                        parse_mode: 'Markdown'
                    });
                    console.log('✅ QR Code enviado com sucesso!');
                } catch (error) {
                    console.error('❌ Erro ao enviar QR Code como imagem:', error);
                    // Se não conseguir enviar a foto, envia só a mensagem
                    await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
                }
            } else {
                console.log('📝 Enviando apenas mensagem com código PIX');
                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            }
        } else {
            console.log('❌ QR Code não disponível, enviando mensagem de erro');
            mensagem += `❌ QR Code PIX não disponível no momento.\n` +
                       `Use o link de pagamento como alternativa.\n\n` +
                       `🔗 [Pagar no Mercado Pago](${pagamento.init_point})`;
            
            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                disable_web_page_preview: true
            });
        }
        
        // Responder ao callback query para remover o loading
        try {
            await this.bot.answerCallbackQuery(callbackQuery.id);
        } catch (error) {
            console.error('❌ Erro ao responder callback query:', error);
        }
    }

    // Métodos Admin para callbacks
    async handleAdminPedidosButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        await this.mostrarPedidosAdmin(chatId, userId, 0); // Página 0
    }

    async mostrarPedidosAdmin(chatId, userId, pagina = 0) {
        const pedidos = this.pedidosManager.getPedidos();
        const pedidosPendentes = pedidos.filter(p => !p.processado);
        
        if (pedidosPendentes.length === 0) {
            const mensagem = `📝 *Gerenciamento de Pedidos*\n\n` +
                           `✅ *Todos os pedidos foram processados!*\n\n` +
                           `🎉 *Parabéns! Você está em dia com todos os pedidos.*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '🔄 Atualizar', callback_data: 'admin_pedidos' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            return;
        }

        // Configurar paginação
        const pedidosPorPagina = 5;
        const totalPaginas = Math.ceil(pedidosPendentes.length / pedidosPorPagina);
        const inicio = pagina * pedidosPorPagina;
        const fim = Math.min(inicio + pedidosPorPagina, pedidosPendentes.length);
        const pedidosPagina = pedidosPendentes.slice(inicio, fim);

        const mensagem = `📝 *Gerenciamento de Pedidos*\n\n` +
                        `📊 *Pedidos pendentes:* ${pedidosPendentes.length}\n` +
                        `📄 *Página:* ${pagina + 1}/${totalPaginas}\n` +
                        `📋 *Mostrando:* ${inicio + 1}-${fim} de ${pedidosPendentes.length}\n\n` +
                        `💡 *Clique em um pedido para ver detalhes e gerenciar:*`;

        const keyboard = {
            inline_keyboard: []
        };

        // Adicionar botões dos pedidos
        pedidosPagina.forEach((pedido, index) => {
            const prioridade = pedido.isAssinante ? '🔥' : '📝';
            const nomeExibicao = pedido.nome.length > 25 ? 
                pedido.nome.substring(0, 22) + '...' : pedido.nome;
            
            keyboard.inline_keyboard.push([
                { 
                    text: `${prioridade} ${nomeExibicao}`, 
                    callback_data: `admin_pedido_detalhes_${pedido.id}` 
                }
            ]);
        });

        // Adicionar botões de navegação
        const botoesNavegacao = [];
        if (totalPaginas > 1) {
            if (pagina > 0) {
                botoesNavegacao.push({ text: '⬅️ Anterior', callback_data: `admin_pedidos_pagina_${pagina - 1}` });
            }
            if (pagina < totalPaginas - 1) {
                botoesNavegacao.push({ text: 'Próxima ➡️', callback_data: `admin_pedidos_pagina_${pagina + 1}` });
            }
        }
        
        if (botoesNavegacao.length > 0) {
            keyboard.inline_keyboard.push(botoesNavegacao);
        }

        // Adicionar botões de ação
        keyboard.inline_keyboard.push([
            { text: '🔄 Atualizar', callback_data: 'admin_pedidos' },
            { text: '📊 Ver Todos', callback_data: 'admin_pedidos_todos' }
        ]);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminAssinaturasButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const assinaturas = this.assinaturaManager.assinaturas;
        const vencendo = this.assinaturaManager.getAssinaturasVencendo();
        const vencidas = this.assinaturaManager.getAssinaturasVencidas();
        const ativas = assinaturas.filter(a => a.status === 'ativa');
        const pendentes = assinaturas.filter(a => a.status === 'pendente');
        const canceladas = assinaturas.filter(a => a.status === 'cancelada');

        let mensagem = `📊 *Relatório de Assinaturas*\n\n`;
        mensagem += `📈 *Total:* ${assinaturas.length}\n`;
        mensagem += `✅ *Ativas:* ${ativas.length}\n`;
        mensagem += `⏳ *Pendentes:* ${pendentes.length}\n`;
        mensagem += `⚠️ *Vencendo (7 dias):* ${vencendo.length}\n`;
        mensagem += `❌ *Vencidas:* ${vencidas.length}\n`;
        mensagem += `🚫 *Canceladas:* ${canceladas.length}\n\n`;

        // Se houver muitas assinaturas, mostrar apenas estatísticas e as mais importantes
        if (assinaturas.length > 50) {
            mensagem += `⚠️ *Muitas assinaturas (${assinaturas.length}). Mostrando apenas estatísticas e as mais importantes:*\n\n`;
            
            if (vencendo.length > 0) {
                mensagem += `⚠️ *Vencendo em breve (máx. 10):*\n`;
                vencendo.slice(0, 10).forEach(assinatura => {
                    const info = this.assinaturaManager.formatarAssinatura(assinatura);
                    mensagem += `• ${assinatura.username} - ${info.diasRestantes} dias\n`;
                });
                if (vencendo.length > 10) {
                    mensagem += `... e mais ${vencendo.length - 10} assinaturas vencendo\n`;
                }
                mensagem += `\n`;
            }

            if (vencidas.length > 0) {
                mensagem += `❌ *Vencidas (máx. 10):*\n`;
                vencidas.slice(0, 10).forEach(assinatura => {
                    mensagem += `• ${assinatura.username} - Venceu em ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n`;
                });
                if (vencidas.length > 10) {
                    mensagem += `... e mais ${vencidas.length - 10} assinaturas vencidas\n`;
                }
                mensagem += `\n`;
            }

            mensagem += `💡 *Dica:* Use filtros para ver assinaturas específicas\n`;
        } else {
            // Mostrar todas as assinaturas normalmente
            if (vencendo.length > 0) {
                mensagem += `⚠️ *Vencendo em breve:*\n`;
                vencendo.forEach(assinatura => {
                    const info = this.assinaturaManager.formatarAssinatura(assinatura);
                    mensagem += `• ${assinatura.username} - ${info.diasRestantes} dias\n`;
                });
                mensagem += `\n`;
            }

            if (vencidas.length > 0) {
                mensagem += `❌ *Vencidas:*\n`;
                vencidas.forEach(assinatura => {
                    mensagem += `• ${assinatura.username} - Venceu em ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n`;
                });
                mensagem += `\n`;
            }

            if (pendentes.length > 0) {
                mensagem += `⏳ *Pendentes:*\n`;
                pendentes.forEach(assinatura => {
                    mensagem += `• ${assinatura.username} - Criada em ${new Date(assinatura.dataInicio).toLocaleDateString('pt-BR')}\n`;
                });
                mensagem += `\n`;
            }
        }

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleAdminStremioButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const { tokens, usernames } = this.assinaturaManager.listarAcessosVitalicios();
        const stats = this.catalogoManager.getEstatisticas();

        const mensagem = `📺 *Central Stremio & Acessos VIP — BrasilFlix*\n\n` +
                        `O addon do Stremio permite assistir ao catálogo em *1080p Full HD* com áudio Dublado e Legendado em Smart TVs, TV Box, Celulares e PCs!\n\n` +
                        `👑 *Acessos Vitalícios Ativos:*\n` +
                        `• 🔑 Chaves/Tokens gerados: *${tokens.length}*\n` +
                        `• 👤 Usuários @username autorizados: *${usernames.length}*\n\n` +
                        `🎬 *Títulos Disponíveis no Stremio:* ${stats.total}\n\n` +
                        `Escolha uma opção de gerenciamento:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔗 Gerar Link Vitalício (Token)', callback_data: 'admin_gerar_token_vitalicio' }
                ],
                [
                    { text: '👤 Autorizar por @Username ou ID', callback_data: 'admin_autorizar_user_prompt' }
                ],
                [
                    { text: '📋 Listar Acessos Vitalícios', callback_data: 'admin_listar_vitalicios' },
                    { text: '🗑️ Revogar Acesso', callback_data: 'admin_revogar_prompt' }
                ],
                [
                    { text: '🔙 Voltar ao Painel Admin', callback_data: 'voltar_menu_admin' }
                ]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleAdminGerarTokenVitalicio(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) return;

        const acesso = this.assinaturaManager.gerarTokenVitalicio('Parente / Amigo VIP');
        const token = acesso.token;

        const hostIp = config.SERVER_HOST || '192.168.15.50:7000';
        const manifestUrl = `http://${hostIp}/${token}/manifest.json`;
        const webStremio = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
        const stremioApp = `stremio://${hostIp}/${token}/manifest.json`;

        const mensagem = `🎉 *Novo Acesso Vitalício Gerado!*\n\n` +
                        `🔑 *Token de Acesso:* \`${token}\`\n\n` +
                        `📲 *Links para enviar ao seu parente / amigo:*\n\n` +
                        `1️⃣ *Instalar no App do Stremio (1 clique):*\n` +
                        `\`${stremioApp}\`\n\n` +
                        `2️⃣ *Abrir no Stremio Web:*\n` +
                        `[Abrir Stremio Web](${webStremio})\n\n` +
                        `3️⃣ *Página Web com Botões de Instalação:*\n` +
                        `\`http://${hostIp}/${token}\`\n\n` +
                        `✨ _Esse link dá acesso vitalício e ilimitado a todos os filmes e séries sem expirar!_`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '➕ Gerar Outro Token', callback_data: 'admin_gerar_token_vitalicio' }],
                [{ text: '🔙 Menu Stremio', callback_data: 'admin_stremio' }]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleAdminAutorizarUserPrompt(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) return;

        this.estadosTemporarios[userId] = {
            tipo: 'admin_autorizar_user',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `👤 *Autorizar Acesso Vitalício por @Username ou ID*\n\n` +
                        `Digite o *@username* (ex: \`@primo_daniel\`) ou o ID numérico da pessoa que você deseja liberar para sempre no Stremio e no Bot:`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '❌ Cancelar', callback_data: 'admin_stremio' }]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async processarAutorizarUserCapturado(msg, texto) {
        const chatId = msg.chat.id;
        const cleanUser = texto.replace(/^@/, '').trim();

        if (!cleanUser) {
            await this.bot.sendMessage(chatId, '❌ Nome de usuário inválido.');
            return;
        }

        const assinatura = this.assinaturaManager.autorizarUsernameVitalicio(cleanUser);
        const hostIp = config.SERVER_HOST || '192.168.15.50:7000';
        const manifestUrl = `http://${hostIp}/${cleanUser}/manifest.json`;
        const webStremio = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;
        const stremioApp = `stremio://${hostIp}/${cleanUser}/manifest.json`;

        const mensagem = `👑 *Acesso Vitalício Liberado com Sucesso!*\n\n` +
                        `👤 *Usuário:* @${cleanUser}\n` +
                        `💎 *Plano:* Vitalício Permanente (2099)\n\n` +
                        `📲 *Links do Stremio para ele:*\n` +
                        `• *Link do Addon:* \`${manifestUrl}\`\n` +
                        `• *App Stremio:* \`${stremioApp}\`\n` +
                        `• *Página de Instalação:* \`http://${hostIp}/${cleanUser}\``;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔙 Menu Stremio', callback_data: 'admin_stremio' }]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async handleAdminListarVitalicios(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) return;

        const { tokens, usernames } = this.assinaturaManager.listarAcessosVitalicios();

        let mensagem = `📋 *Acessos Vitalícios Cadastrados*\n\n`;

        if (tokens.length === 0 && usernames.length === 0) {
            mensagem += `_Nenhum acesso vitalício ativo no momento._\n`;
        } else {
            if (tokens.length > 0) {
                mensagem += `🔑 *Chaves/Tokens Gerados:*\n`;
                tokens.forEach((t, i) => {
                    mensagem += `${i + 1}. \`${t.token}\` (${t.nome || 'Parente'})\n`;
                });
                mensagem += `\n`;
            }
            if (usernames.length > 0) {
                mensagem += `👤 *Usuários @ Liberados:*\n`;
                usernames.forEach((u, i) => {
                    mensagem += `${i + 1}. @${u.username} (Criado em: ${new Date(u.dataInicio).toLocaleDateString('pt-BR')})\n`;
                });
            }
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔗 Gerar Novo Token', callback_data: 'admin_gerar_token_vitalicio' }],
                [{ text: '🔙 Menu Stremio', callback_data: 'admin_stremio' }]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async handleAdminRevogarPrompt(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) return;

        this.estadosTemporarios[userId] = {
            tipo: 'admin_revogar_acesso',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `🗑️ *Revogar Acesso Vitalício*\n\n` +
                        `Envie o *@username* ou a *chave token* que deseja revogar:`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '❌ Cancelar', callback_data: 'admin_stremio' }]
            ]
        };

        await this.sendOrEdit(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard }, callbackQuery);
    }

    async processarRevogarAcessoCapturado(msg, texto) {
        const chatId = msg.chat.id;
        const revogado = this.assinaturaManager.revogarAcessoVitalicio(texto);

        if (revogado) {
            await this.bot.sendMessage(chatId, `✅ *Acesso "${texto}" revogado com sucesso!*`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Menu Stremio', callback_data: 'admin_stremio' }]]
                }
            });
        } else {
            await this.bot.sendMessage(chatId, `⚠️ Nenhum acesso ativo encontrado para "${texto}".`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🔙 Menu Stremio', callback_data: 'admin_stremio' }]]
                }
            });
        }
    }

    async handleStremioCommand(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name || userId.toString();

        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;

        const token = msg.from.username || userId.toString();
        const hostIp = config.SERVER_HOST || '192.168.15.50:7000';
        const manifestUrl = `http://${hostIp}/${token}/manifest.json`;
        const stremioApp = `stremio://${hostIp}/${token}/manifest.json`;
        const webStremio = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(manifestUrl)}`;

        let mensagem = `📺 *BrasilFlix no Stremio (Smart TV & Celular)*\n\n` +
                       `Assista a todos os filmes e séries do nosso catálogo em *1080p Full HD* direto no Stremio!\n\n`;

        if (isAssinante) {
            mensagem += `✨ *Sua conta VIP está ativa!* Seus links personalizados de instalação:\n\n` +
                        `🚀 *Instalar no App Stremio:* [Clique aqui](${stremioApp})\n` +
                        `🌐 *Abrir no Stremio Web:* [Clique aqui](${webStremio})\n` +
                        `🔗 *URL do Addon:* \`${manifestUrl}\``;
        } else {
            mensagem += `💡 *Disponível para Assinantes VIP!*\n` +
                        `Assine por apenas R$ 15,00/mês para liberar a reprodução ilimitada no Stremio na sua TV de casa!`;
        }

        const keyboard = {
            inline_keyboard: [
                isAssinante ? 
                    [{ text: '🚀 Instalar no Stremio', url: webStremio }] :
                    [{ text: '💎 Assinar VIP - R$ 15', callback_data: 'ver_planos' }],
                [{ text: '🍿 Menu Principal', callback_data: 'voltar_menu' }]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async handleAdminStatsButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedidos = this.pedidosManager.getPedidos();
        const catalogo = this.catalogoManager.getEstatisticas();
        const assinaturas = this.assinaturaManager.assinaturas;
        const testesGratuitos = this.getEstatisticasTestesGratuitos();

        const mensagem = `📊 *Estatísticas do BrasilFlix*\n\n` +
                        `📝 *Pedidos:* ${pedidos.length}\n` +
                        `📚 *Catálogo:* ${catalogo.total} (${catalogo.totalFilmes} filmes, ${catalogo.totalSeries} séries)\n` +
                        `💳 *Assinaturas:* ${assinaturas.length}\n` +
                        `🔥 *Assinantes ativos:* ${assinaturas.filter(a => a.status === 'ativa').length}\n\n` +
                        `🎁 *Testes Gratuitos:*\n` +
                        `📊 Total: ${testesGratuitos.total}\n` +
                        `📅 Hoje: ${testesGratuitos.hoje}\n` +
                        `📅 Esta semana: ${testesGratuitos.estaSemana}\n` +
                        `📅 Este mês: ${testesGratuitos.esteMes}`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });

    }

    async handleAdminAdicionarButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const mensagem = `➕ *Adicionar Novo Conteúdo*\n\n` +
                        `*Método 1 - Automático (Recomendado):*\n` +
                        `1️⃣ Envie o arquivo para o grupo de armazenamento\n` +
                        `2️⃣ Adicione uma descrição na legenda\n` +
                        `3️⃣ O sistema detectará automaticamente\n\n` +
                        `*Método 2 - Manual:*\n` +
                        `1️⃣ Envie o arquivo para o grupo de armazenamento\n` +
                        `2️⃣ Use /adicionar no grupo\n\n` +
                        `*Método 3 - Sem arquivo:*\n` +
                        `Use: /adicionar_manual "Nome - Ano - Gênero"\n\n` +
                        `*Formato da descrição:*\n` +
                        `Nome do filme/série - Ano - Gênero\n` +
                        `Exemplo: Vingadores Ultimato - 2019 - Ação/Aventura\n\n` +
                        `💡 *Dica:* O sistema detecta automaticamente quando você envia um arquivo com legenda no formato correto!`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });

    }

    async handleAdminVerificarButton(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const vencendo = this.assinaturaManager.getAssinaturasVencendo();
        const vencidas = this.assinaturaManager.getAssinaturasVencidas();

        let mensagem = `🔄 *Verificação de Vencimentos*\n\n`;

        if (vencendo.length > 0) {
            mensagem += `⚠️ *Vencendo em breve:*\n`;
            vencendo.forEach(assinatura => {
                const info = this.assinaturaManager.formatarAssinatura(assinatura);
                mensagem += `• ${assinatura.username} - ${info.diasRestantes} dias\n`;
            });
        } else {
            mensagem += `✅ Nenhuma assinatura vencendo em breve\n`;
        }

        mensagem += `\n`;

        if (vencidas.length > 0) {
            mensagem += `❌ *Vencidas:*\n`;
            vencidas.forEach(assinatura => {
                mensagem += `• ${assinatura.username} - Venceu em ${new Date(assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n`;
            });
        } else {
            mensagem += `✅ Nenhuma assinatura vencida\n`;
        }

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });

    }

    async handleAdminTestarCliente(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        // Verificar se o admin tem assinatura de teste
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        
        if (isAssinante) {
            // Simular o menu /start de um cliente assinante usando o método correto
            console.log(`🧪 Admin testando menu de cliente assinante`);
            await this.handleAssinanteStart({ 
                chat: { id: chatId }, 
                from: { id: userId, username: 'Admin Teste' } 
            });
        } else {
            // Simular o menu /start de um cliente não-assinante usando o método correto
            console.log(`🧪 Admin testando menu de cliente não assinante`);
            await this.handleNaoAssinanteStart({ 
                chat: { id: chatId }, 
                from: { id: userId, username: 'Admin Teste' } 
            });
        }
    }

    async handleAdminCriarAssinaturaTeste(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        try {
            // Verificar se já tem assinatura
            const assinaturaExistente = this.assinaturaManager.getAssinatura(userId);
            if (assinaturaExistente) {
                await this.bot.sendMessage(chatId, 
                    '⚠️ *Você já possui uma assinatura ativa!*\n\n' +
                    'Use o botão "❌ Remover Assinatura Teste" para remover e criar uma nova.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // Criar assinatura de teste (simulando pagamento)
            const username = 'Admin Teste';
            const plano = 'mensal';
            const dataInicio = new Date();
            const dataVencimento = new Date();
            dataVencimento.setMonth(dataVencimento.getMonth() + 1); // 1 mês

            const assinatura = {
                userId: userId,
                username: username,
                plano: plano,
                status: 'ativa',
                dataInicio: dataInicio.toISOString(),
                dataVencimento: dataVencimento.toISOString(),
                pagamentoId: 'TESTE_ADMIN_' + Date.now(),
                metodoPagamento: 'teste_admin'
            };

            // Adicionar à lista de assinaturas
            this.assinaturaManager.assinaturas.push(assinatura);
            this.assinaturaManager.saveAssinaturas();

            const mensagem = `✅ *Assinatura de Teste Criada com Sucesso!*\n\n` +
                           `👤 *Usuário:* ${username}\n` +
                           `📅 *Plano:* Mensal\n` +
                           `⭐ *Status:* Ativa\n` +
                           `📅 *Vencimento:* ${dataVencimento.toLocaleDateString('pt-BR')}\n` +
                           `🆔 *ID Pagamento:* ${assinatura.pagamentoId}\n\n` +
                           `🎉 *Agora você pode testar o menu de assinante!*\n\n` +
                           `💡 Use o botão "🧪 Testar Menu Cliente" para ver como fica.`;

            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error('❌ Erro ao criar assinatura de teste:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao criar assinatura de teste. Tente novamente.');
        }
    }

    async handleAdminRemoverAssinaturaTeste(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        try {
            // Verificar se tem assinatura
            const assinatura = this.assinaturaManager.getAssinatura(userId);
            if (!assinatura) {
                await this.bot.sendMessage(chatId, 
                    '⚠️ *Você não possui uma assinatura ativa!*\n\n' +
                    'Use o botão "✅ Criar Assinatura Teste" para criar uma.',
                    { parse_mode: 'Markdown' }
                );
                return;
            }

            // Remover assinatura
            const index = this.assinaturaManager.assinaturas.findIndex(a => a.userId === userId);
            if (index !== -1) {
                this.assinaturaManager.assinaturas.splice(index, 1);
                this.assinaturaManager.saveAssinaturas();

                const mensagem = `❌ *Assinatura de Teste Removida com Sucesso!*\n\n` +
                               `👤 *Usuário:* ${assinatura.username}\n` +
                               `📅 *Plano:* ${assinatura.plano}\n` +
                               `🆔 *ID Pagamento:* ${assinatura.pagamentoId}\n\n` +
                               `🎉 *Agora você pode testar o menu de não-assinante!*\n\n` +
                               `💡 Use o botão "🧪 Testar Menu Cliente" para ver como fica.`;

                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            } else {
                await this.bot.sendMessage(chatId, '❌ Erro ao remover assinatura. Tente novamente.');
            }

        } catch (error) {
            console.error('❌ Erro ao remover assinatura de teste:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao remover assinatura de teste. Tente novamente.');
        }
    }

    async handleAdminGerenciarCatalogo(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const stats = this.catalogoManager.getEstatisticas();
        
        const mensagem = `🗑️ *Gerenciar Catálogo*\n\n` +
                        `📊 *Estatísticas:*\n` +
                        `🎬 *Filmes:* ${stats.totalFilmes}\n` +
                        `📺 *Séries:* ${stats.totalSeries}\n` +
                        `📈 *Total:* ${stats.total}\n\n` +
                        `Escolha uma categoria para gerenciar:`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `🎬 Gerenciar Filmes (${stats.totalFilmes})`, callback_data: 'admin_gerenciar_filmes' },
                    { text: `📺 Gerenciar Séries (${stats.totalSeries})`, callback_data: 'admin_gerenciar_series' }
                ],
                [
                    { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminGerenciarFilmes(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const filmes = this.catalogoManager.catalogo.filmes;
        
        if (filmes.length === 0) {
            await this.bot.sendMessage(chatId, 
                '📭 Nenhum filme encontrado no catálogo.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const mensagem = `🎬 *Gerenciar Filmes*\n\n` +
                        `📊 Total: ${filmes.length} filmes\n\n` +
                        `Clique em um filme para selecioná-lo para exclusão:`;

        const keyboard = {
            inline_keyboard: []
        };

        // Adicionar botões dos filmes (máximo 10 por página)
        const filmesPorPagina = 10;
        const filmesPagina = filmes.slice(0, filmesPorPagina);

        filmesPagina.forEach(filme => {
            const nomeExibicao = filme.nome.length > 25 ? 
                filme.nome.substring(0, 22) + '...' : filme.nome;
            
            keyboard.inline_keyboard.push([
                { text: `🎬 ${nomeExibicao}`, callback_data: `selecionar_filme_${filme.id}` }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar', callback_data: 'admin_gerenciar_catalogo' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminGerenciarSeries(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const series = this.catalogoManager.catalogo.series;
        
        if (series.length === 0) {
            await this.bot.sendMessage(chatId, 
                '📭 Nenhuma série encontrada no catálogo.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const mensagem = `📺 *Gerenciar Séries*\n\n` +
                        `📊 Total: ${series.length} séries\n\n` +
                        `Clique em uma série para selecioná-la para exclusão:`;

        const keyboard = {
            inline_keyboard: []
        };

        // Adicionar botões das séries (máximo 10 por página)
        const seriesPorPagina = 10;
        const seriesPagina = series.slice(0, seriesPorPagina);

        seriesPagina.forEach(serie => {
            const nomeExibicao = serie.nome.length > 25 ? 
                serie.nome.substring(0, 22) + '...' : serie.nome;
            
            keyboard.inline_keyboard.push([
                { text: `📺 ${nomeExibicao}`, callback_data: `selecionar_serie_${serie.id}` }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar', callback_data: 'admin_gerenciar_catalogo' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminSelecionarFilme(chatId, userId, filmeId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
            return;
        }

        const mensagem = `🗑️ *Confirmar Exclusão de Filme*\n\n` +
                        `🎬 *${filme.nome}*\n` +
                        `📝 ${filme.descricao || 'Sem descrição'}\n` +
                        `📅 Adicionado em: ${new Date(filme.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                        `⚠️ *ATENÇÃO:* Esta ação não pode ser desfeita!\n\n` +
                        `Tem certeza que deseja excluir este filme?`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Sim, Excluir', callback_data: `confirmar_excluir_filme_${filmeId}` },
                    { text: '❌ Cancelar', callback_data: 'admin_gerenciar_filmes' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminExcluirFilme(chatId, userId, filmeId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        try {
            const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
            
            if (!filme) {
                await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
                return;
            }

            // Excluir filme
            const sucesso = this.catalogoManager.removerItem(parseInt(filmeId));
            
            if (sucesso) {
                const mensagem = `✅ *Filme excluído com sucesso!*\n\n` +
                               `🎬 *Nome:* ${filme.nome}\n` +
                               `📝 *Descrição:* ${filme.descricao}\n` +
                               `🆔 *ID:* ${filme.id}\n\n` +
                               `🗑️ *Filme removido do catálogo permanentemente.*`;

                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            } else {
                await this.bot.sendMessage(chatId, '❌ Erro ao excluir filme. Tente novamente.');
            }

        } catch (error) {
            console.error('❌ Erro ao excluir filme:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao excluir filme. Tente novamente.');
        }
    }

    async handleAdminSelecionarSerie(chatId, userId, serieId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
        
        if (!serie) {
            await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
            return;
        }

        const mensagem = `🗑️ *Confirmar Exclusão de Série*\n\n` +
                        `📺 *${serie.nome}*\n` +
                        `📝 ${serie.descricao || 'Sem descrição'}\n` +
                        `📅 Adicionado em: ${new Date(serie.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                        `⚠️ *ATENÇÃO:* Esta ação não pode ser desfeita!\n\n` +
                        `Tem certeza que deseja excluir esta série?`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Sim, Excluir', callback_data: `confirmar_excluir_serie_${serieId}` },
                    { text: '❌ Cancelar', callback_data: 'admin_gerenciar_series' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminExcluirSerie(chatId, userId, serieId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        try {
            const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
            
            if (!serie) {
                await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
                return;
            }

            // Excluir série
            const sucesso = this.catalogoManager.removerItem(parseInt(serieId));
            
            if (sucesso) {
                const mensagem = `✅ *Série excluída com sucesso!*\n\n` +
                               `📺 *Nome:* ${serie.nome}\n` +
                               `📝 *Descrição:* ${serie.descricao}\n` +
                               `🆔 *ID:* ${serie.id}\n\n` +
                               `🗑️ *Série removida do catálogo permanentemente.*`;

                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            } else {
                await this.bot.sendMessage(chatId, '❌ Erro ao excluir série. Tente novamente.');
            }

        } catch (error) {
            console.error('❌ Erro ao excluir série:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao excluir série. Tente novamente.');
        }
    }

    async handleConfirmarPedido(chatId, userId, nome, callbackQuery) {
        const username = 'Usuário'; // Será obtido do callback
        
        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);

        // Adicionar pedido
        const pedido = this.pedidosManager.adicionarPedido(userId, username, nome, '', isAssinante);
        
        const prioridade = isAssinante ? '🔥 *PRIORIDADE ALTA (Assinante)*' : '📝 *Pedido Normal*';
        
        const mensagem = `📝 *Pedido confirmado e registrado!*\n\n` +
                        `🎬 *Título:* ${pedido.nome}\n` +
                        `👤 *Solicitante:* ${pedido.username}\n` +
                        `📅 *Data:* ${new Date(pedido.data).toLocaleDateString('pt-BR')}\n` +
                        `🆔 *ID:* ${pedido.id}\n` +
                        `⭐ *Status:* ${prioridade}\n\n` +
                        `✅ *Pedido enviado para processamento!*`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });

        // Notificar administradores
        console.log(`📝 Novo pedido confirmado: ${nome} por ${username} ${isAssinante ? '(Assinante)' : ''} (ID: ${pedido.id})`);
    }

    async handleCancelarPedido(chatId, userId, nome, callbackQuery) {
        const mensagem = `❌ *Pedido cancelado*\n\n` +
                        `🎬 *Título:* ${nome}\n\n` +
                        `💡 *Dica:* Use /buscar para encontrar o que procura no catálogo.`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleConfirmarSimilar(chatId, userId, nome, callbackQuery) {
        const mensagem = `✅ *Entendido!*\n\n` +
                        `🎬 *Você confirmou que:* ${nome}\n\n` +
                        `💡 *Dica:* Use /buscar para encontrar o título correto no catálogo.\n\n` +
                        `🔍 *Exemplo:* /buscar ${nome.split(' ')[0]}`;

        await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
    }

    async handleCancelarOperacao(chatId, userId, callbackQuery) {
        if (this.estadosTemporarios[userId]) {
            delete this.estadosTemporarios[userId];
        }
        await this.handleVoltarMenu(chatId, userId, callbackQuery);
    }

    // Método para processar mensagens de texto quando em modo de captura
    async processarMensagemTexto(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const texto = msg.text;

        // Verificar se o usuário está em modo de captura
        const estado = this.estadosTemporarios[userId];
        if (!estado || !estado.ativo) {
            return false; // Não está em modo de captura
        }

        // Verificar se o estado não expirou (5 minutos)
        const agora = Date.now();
        if (agora - estado.timestamp > 5 * 60 * 1000) {
            delete this.estadosTemporarios[userId];
            return false;
        }

        // Processar baseado no tipo de estado
        if (estado.tipo === 'pedido') {
            await this.processarPedidoCapturado(msg, texto);
        } else if (estado.tipo === 'busca') {
            await this.processarBuscaCapturada(msg, texto);
        } else if (estado.tipo === 'suporte') {
            await this.processarSuporteCapturado(msg, texto);
        } else if (estado.tipo === 'teste_busca') {
            await this.processarTesteBuscaCapturada(msg, texto);
        } else if (estado.tipo === 'teste_pedido') {
            await this.processarTestePedidoCapturado(msg, texto);
        } else if (estado.tipo === 'admin_autorizar_user') {
            await this.processarAutorizarUserCapturado(msg, texto);
        } else if (estado.tipo === 'admin_revogar_acesso') {
            await this.processarRevogarAcessoCapturado(msg, texto);
        }

        // Limpar estado após processamento
        delete this.estadosTemporarios[userId];
        return true; // Mensagem foi processada
    }

    async processarSuporteCapturado(msg, texto) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const nome = msg.from.first_name || 'Usuário';
        const username = msg.from.username ? `@${msg.from.username}` : 'Não informado';
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;
        const statusVip = isAssinante ? '🟢 Assinante VIP' : '⚪ Visitante';

        // 1. Notificar no privado do Admin (config.ADMIN_ID)
        const msgAdmin = `📩 *NOVA MENSAGEM DE SUPORTE*\n\n` +
                        `👤 *Cliente:* ${nome} (${username})\n` +
                        `🆔 *ID:* \`${userId}\`\n` +
                        `⭐ *Status:* ${statusVip}\n\n` +
                        `📝 *Mensagem:*\n"${texto}"\n\n` +
                        `💡 _Responda diretamente ao cliente via @ ou chat privado._`;

        try {
            await this.bot.sendMessage(config.ADMIN_ID, msgAdmin, { parse_mode: 'Markdown' });
        } catch (e) {
            console.error('❌ Erro ao repassar mensagem de suporte ao admin:', e.message);
        }

        // 2. Responder confirmação ao cliente
        const respostaUser = `✅ *Mensagem enviada com sucesso ao Suporte!*\n\n` +
                            `Nossa equipe já recebeu o seu chamado e entrará em contato com você em breve.\n\n` +
                            `Obrigado pelo contato! 🍿`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🍿 Menu Principal', callback_data: 'voltar_menu' }]
            ]
        };

        await this.bot.sendMessage(chatId, respostaUser, { parse_mode: 'Markdown', reply_markup: keyboard });
    }

    async processarPedidoCapturado(msg, nome) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        // Obter username da mensagem
        const username = msg.from.username || msg.from.first_name || 'Usuário';
        
        if (nome.length < 3) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* O nome deve ter pelo menos 3 caracteres.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Verificar se já existe no catálogo
        try {
            const existente = this.catalogoManager.buscarItem(nome);
            if (existente && existente.length > 0) {
                let mensagem = `✅ *Já temos no catálogo!*\n\n`;
                mensagem += this.catalogoManager.formatarResultadosBusca(existente);
                await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
                return;
            }
        } catch (error) {
            console.error('❌ Erro ao verificar catálogo:', error);
            // Continuar com o pedido mesmo se houver erro na verificação
        }

        // Verificar similaridade com itens existentes
        const similares = this.buscarSimilares(nome);
        
        if (similares.length > 0) {
            await this.mostrarVerificacaoSimilaridade(chatId, userId, nome, similares);
            return;
        }

        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;

        // Adicionar pedido
        const pedido = this.pedidosManager.adicionarPedido(userId, username, nome, '', isAssinante);
        
        // Se temos QueueManager, enfileira o download com a prioridade adequada
        if (this.queueManager) {
            const { PRIORITIES } = require('../managers/QueueManager');
            this.queueManager.addJob(nome, 'filme', isAssinante ? PRIORITIES.VIP_USER : PRIORITIES.FREE_USER, {
                userId,
                username
            });
        }
        
        const prioridade = isAssinante ? '🔥 *PRIORIDADE MÁXIMA (Assinante VIP)*' : '📝 *Fila Normal (Plano Gratuito)*';
        
        const mensagemConfirmacao = `📝 *Pedido registrado com sucesso!*\n\n` +
                                   `🎬 *Título:* ${pedido.nome}\n` +
                                   `👤 *Solicitante:* ${pedido.username}\n` +
                                   `📅 *Data:* ${new Date(pedido.data).toLocaleDateString('pt-BR')}\n` +
                                   `🆔 *ID:* ${pedido.id}\n` +
                                   `⭐ *Prioridade:* ${prioridade}\n\n` +
                                   `🚀 *O robô BrasilFlix já agendou o download em 1080p Full HD!* Você será notificado assim que o arquivo estiver no catálogo.`;

        await this.bot.sendMessage(chatId, mensagemConfirmacao, { parse_mode: 'Markdown' });

        // Notificar administradores
        console.log(`📝 Novo pedido: ${nome} por ${username} ${isAssinante ? '(VIP)' : '(Gratuito)'} (ID: ${pedido.id})`);
    }

    async processarBuscaCapturada(msg, termo) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        await this.mostrarResultadosBusca(chatId, userId, termo);
    }

    async processarTesteBuscaCapturada(msg, termo) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        
        if (termo.length < 2) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* O termo de busca deve ter pelo menos 2 caracteres.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

                try {
            const resultados = this.catalogoManager.buscarItem(termo);
            
            if (resultados.length === 0) {
                const mensagem = `🔍 *Teste Gratuito - Busca*\n\n` +
                               `❌ *Nenhum resultado encontrado para:* "${termo}"\n\n` +
                               `💡 *Tente outros termos ou use "Fazer Pedido" para solicitar este conteúdo.*`;

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '🔍 Buscar Outro Termo', callback_data: 'teste_buscar' },
                            { text: '📝 Fazer Pedido', callback_data: 'teste_pedido' }
                        ],
                        [
                            { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                        ]
                    ]
                };

                await this.bot.sendMessage(chatId, mensagem, { 
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
                return;
            }

            // Se encontrou resultados, mostrar para escolha
            let mensagem = `🎁 *Teste Gratuito - Resultados da Busca*\n\n` +
                          `🔍 *Termo:* "${termo}"\n` +
                          `📊 *Encontrados:* ${resultados.length} resultado(s)\n\n` +
                          `⚠️ *ATENÇÃO:* Você pode escolher apenas 1 item para o teste gratuito!\n\n` +
                          `*Resultados:*\n\n`;

            const keyboard = {
                inline_keyboard: []
            };

            // Mostrar apenas os primeiros 8 resultados para não sobrecarregar
            const resultadosLimitados = resultados.slice(0, 8);
            
            resultadosLimitados.forEach((item, index) => {
                const icone = item.tipo === 'filme' ? '🎬' : '📺';
                const nomeExibicao = item.nome.length > 30 ? 
                    item.nome.substring(0, 27) + '...' : item.nome;
                
                keyboard.inline_keyboard.push([
                    { text: `${icone} ${nomeExibicao}`, callback_data: `confirmar_teste_${item.tipo}_${item.id}` }
                ]);
            });

            if (resultados.length > 8) {
                mensagem += `📝 *Mostrando os primeiros 8 resultados*\n`;
                mensagem += `💡 *Use termos mais específicos para encontrar o que procura*\n\n`;
            }

            keyboard.inline_keyboard.push([
                { text: '🔍 Buscar Outro Termo', callback_data: 'teste_buscar' },
                { text: '📝 Fazer Pedido', callback_data: 'teste_pedido' }
            ]);

            keyboard.inline_keyboard.push([
                { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
            ]);

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
        } catch (error) {
            console.error('❌ Erro ao buscar no catálogo:', error);
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* Não foi possível buscar no catálogo no momento. Tente novamente.', 
                { parse_mode: 'Markdown' }
            );
        }

        // Se encontrou resultados, mostrar para escolha
        let mensagem = `🎁 *Teste Gratuito - Resultados da Busca*\n\n` +
                      `🔍 *Termo:* "${termo}"\n` +
                      `📊 *Encontrados:* ${resultados.length} resultado(s)\n\n` +
                      `⚠️ *ATENÇÃO:* Você pode escolher apenas 1 item para o teste gratuito!\n\n` +
                      `*Resultados:*\n\n`;

        const keyboard = {
            inline_keyboard: []
        };

        // Mostrar apenas os primeiros 8 resultados para não sobrecarregar
        const resultadosLimitados = resultados.slice(0, 8);
        
        resultadosLimitados.forEach((item, index) => {
            const icone = item.tipo === 'filme' ? '🎬' : '📺';
            const nomeExibicao = item.nome.length > 30 ? 
                item.nome.substring(0, 27) + '...' : item.nome;
            
            keyboard.inline_keyboard.push([
                { text: `${icone} ${nomeExibicao}`, callback_data: `confirmar_teste_${item.tipo}_${item.id}` }
            ]);
        });

        if (resultados.length > 8) {
            mensagem += `📝 *Mostrando os primeiros 8 resultados*\n`;
            mensagem += `💡 *Use termos mais específicos para encontrar o que procura*\n\n`;
        }

        keyboard.inline_keyboard.push([
            { text: '🔍 Buscar Outro Termo', callback_data: 'teste_buscar' },
            { text: '📝 Fazer Pedido', callback_data: 'teste_pedido' }
        ]);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async processarTestePedidoCapturado(msg, texto) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const username = msg.from.username || msg.from.first_name || 'Usuário';
        
        if (texto.length < 3) {
            await this.bot.sendMessage(chatId, 
                '❌ *Erro:* O nome deve ter pelo menos 3 caracteres.', 
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Verificar se já existe no catálogo
        try {
            const existente = this.catalogoManager.buscarItem(texto);
            if (existente && existente.length > 0) {
                let mensagem = `🎁 *Teste Gratuito - Já Disponível!*\n\n` +
                              `✅ *Encontramos no catálogo:*\n\n`;
                mensagem += this.catalogoManager.formatarResultadosBusca(existente);
                mensagem += `\n💡 *Use "Ver Catálogo" para escolher um destes para o teste gratuito!*`;

                const keyboard = {
                    inline_keyboard: [
                        [
                            { text: '📚 Ver Catálogo', callback_data: 'teste_catalogo' },
                            { text: '🔍 Buscar Outro', callback_data: 'teste_buscar' }
                        ],
                        [
                            { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                        ]
                    ]
                };

                await this.bot.sendMessage(chatId, mensagem, { 
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                });
                return;
            }
        } catch (error) {
            console.error('❌ Erro ao verificar catálogo:', error);
            // Continuar com o pedido mesmo se houver erro na verificação
        }

        // Verificar similaridade com itens existentes
        const similares = this.buscarSimilares(texto);
        
        if (similares.length > 0) {
            let mensagem = `🎁 *Teste Gratuito - Títulos Similares*\n\n` +
                          `🔍 *Você pediu:* ${texto}\n\n` +
                          `📋 *Títulos similares encontrados no catálogo:*\n\n`;

            similares.forEach((item, index) => {
                const icone = item.tipo === 'filme' ? '🎬' : '📺';
                mensagem += `${icone} *${index + 1}.* ${item.nome}\n`;
                if (item.descricao) {
                    mensagem += `📝 ${item.descricao}\n`;
                }
                mensagem += `🆔 ID: ${item.id}\n\n`;
            });

            mensagem += `💡 *Use "Ver Catálogo" para escolher um destes para o teste gratuito!*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '📚 Ver Catálogo', callback_data: 'teste_catalogo' },
                        { text: '🔍 Buscar Outro', callback_data: 'teste_buscar' }
                    ],
                    [
                        { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                    ]
                ]
            };

            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            return;
        }

        // Se não encontrou similar, criar pedido normal
        const pedido = this.pedidosManager.adicionarPedido(userId, username, texto, '', false);
        
        const mensagemConfirmacao = `🎁 *Teste Gratuito - Pedido Registrado!*\n\n` +
                                   `📝 *Título:* ${pedido.nome}\n` +
                                   `👤 *Solicitante:* ${pedido.username}\n` +
                                   `📅 *Data:* ${new Date(pedido.data).toLocaleDateString('pt-BR')}\n` +
                                   `🆔 *ID:* ${pedido.id}\n` +
                                   `⭐ *Status:* 📝 Pedido Normal\n\n` +
                                   `💡 *Seu pedido foi registrado e será processado em breve!*\n\n` +
                                   `⚠️ *Importante:* Este pedido NÃO consome seu teste gratuito.\n` +
                                   `Use o teste gratuito para assistir conteúdo que já está no catálogo.`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📚 Ver Catálogo', callback_data: 'teste_catalogo' },
                    { text: '🔍 Buscar Filme', callback_data: 'teste_buscar' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagemConfirmacao, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });

        // Notificar administradores
        console.log(`📝 Pedido de teste gratuito: ${texto} por ${username} (ID: ${pedido.id})`);
    }

    // Método para obter estatísticas de testes gratuitos (para admin)
    getEstatisticasTestesGratuitos() {
        const totalUsuarios = Object.keys(this.testesGratuitos).length;
        const hoje = new Date();
        const hojeStr = hoje.toISOString().split('T')[0];
        
        let hojeUsuarios = 0;
        let estaSemana = 0;
        let esteMes = 0;
        
        Object.values(this.testesGratuitos).forEach(teste => {
            const dataTeste = new Date(teste.dataUso);
            const dataTesteStr = dataTeste.toISOString().split('T')[0];
            
            if (dataTesteStr === hojeStr) {
                hojeUsuarios++;
            }
            
            const diffDias = Math.floor((hoje - dataTeste) / (1000 * 60 * 60 * 24));
            if (diffDias <= 7) {
                estaSemana++;
            }
            
            if (diffDias <= 30) {
                esteMes++;
            }
        });
        
        return {
            total: totalUsuarios,
            hoje: hojeUsuarios,
            estaSemana: estaSemana,
            esteMes: esteMes
        };
    }

    // Método para limpar estados expirados
    limparEstadosExpirados() {
        const agora = Date.now();
        const usuariosParaRemover = [];
        
        for (const [userId, estado] of Object.entries(this.estadosTemporarios)) {
            if (agora - estado.timestamp > 5 * 60 * 1000) { // 5 minutos
                usuariosParaRemover.push(userId);
            }
        }
        
        usuariosParaRemover.forEach(userId => {
            delete this.estadosTemporarios[userId];
        });
        
        if (usuariosParaRemover.length > 0) {
            console.log(`🧹 Limpos ${usuariosParaRemover.length} estados expirados`);
        }
    }

    // Métodos para gerenciar testes gratuitos
    carregarTestesGratuitos() {
        try {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.join(__dirname, '../../data/testes_gratuitos.json');
            
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                this.testesGratuitos = JSON.parse(data);
                console.log(`📋 Testes gratuitos carregados: ${Object.keys(this.testesGratuitos).length} usuários`);
            } else {
                this.testesGratuitos = {};
                console.log('📋 Arquivo de testes gratuitos não encontrado, criando novo');
            }
        } catch (error) {
            console.error('❌ Erro ao carregar testes gratuitos:', error);
            this.testesGratuitos = {};
        }
    }

    salvarTestesGratuitos() {
        try {
            const fs = require('fs');
            const path = require('path');
            const filePath = path.join(__dirname, '../../data/testes_gratuitos.json');
            
            // Criar diretório se não existir
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(filePath, JSON.stringify(this.testesGratuitos, null, 2));
            console.log('💾 Testes gratuitos salvos com sucesso');
        } catch (error) {
            console.error('❌ Erro ao salvar testes gratuitos:', error);
        }
    }

    getMesAtual() {
        return new Date().toISOString().substring(0, 7); // ex: '2026-08'
    }

    getCotaGratuita(userId) {
        const idStr = userId.toString();
        const mesAtual = this.getMesAtual();
        const registro = this.testesGratuitos[idStr];

        if (!registro || registro.mes !== mesAtual) {
            return {
                filmesRestantes: 1,
                epsRestantes: 2,
                filmesUsados: 0,
                epsUsados: 0,
                podeFilme: true,
                podeEpisodio: true,
                mes: mesAtual
            };
        }

        const filmesUsados = registro.filmesUsados || 0;
        const epsUsados = registro.epsUsados || 0;
        const filmesRestantes = Math.max(0, 1 - filmesUsados);
        const epsRestantes = Math.max(0, 2 - epsUsados);

        return {
            filmesRestantes,
            epsRestantes,
            filmesUsados,
            epsUsados,
            podeFilme: filmesRestantes > 0,
            podeEpisodio: epsRestantes > 0,
            mes: mesAtual
        };
    }

    consumirCotaGratis(userId, username, tipo = 'filme') {
        const idStr = userId.toString();
        const mesAtual = this.getMesAtual();
        const cota = this.getCotaGratuita(userId);

        if (tipo === 'filme') {
            cota.filmesUsados += 1;
        } else {
            cota.epsUsados += 1;
        }

        this.testesGratuitos[idStr] = {
            username: username || 'Usuário',
            mes: mesAtual,
            filmesUsados: cota.filmesUsados,
            epsUsados: cota.epsUsados,
            ultimaAtualizacao: new Date().toISOString()
        };

        this.salvarTestesGratuitos();
        console.log(`🎁 Cota gratuita consumida por ${userId} (${username}): Tipo=${tipo}, Filmes=${cota.filmesUsados}/1, Eps=${cota.epsUsados}/2`);
    }

    verificarTesteGratuitoUsado(userId) {
        const cota = this.getCotaGratuita(userId);
        return !cota.podeFilme && !cota.podeEpisodio;
    }

    marcarTesteGratuitoUsado(userId, username) {
        this.consumirCotaGratis(userId, username, 'filme');
    }

    async handleTesteGratuito(chatId, userId, callbackQuery) {
        // Verificar se ainda tem teste disponível
        if (this.verificarTesteGratuitoUsado(userId)) {
            await this.bot.sendMessage(chatId, 
                '❌ *Teste Gratuito Já Utilizado*\n\n' +
                'Você já utilizou seu teste gratuito.\n\n' +
                '💡 *Assine agora para acessar todo o conteúdo!*',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const mensagem = `🎁 *Teste Gratuito - 1 Filme*\n\n` +
                        `✨ *Como funciona:*\n` +
                        `• Você pode escolher 1 filme para assistir gratuitamente\n` +
                        `• Após assistir, precisará assinar para ver mais conteúdo\n` +
                        `• O teste é válido apenas uma vez por usuário\n\n` +
                        `🎬 *Escolha o que deseja fazer:*\n\n` +
                        `1️⃣ *Navegar pelo catálogo* - Veja filmes disponíveis\n` +
                        `2️⃣ *Buscar um filme específico* - Encontre o que procura\n` +
                        `3️⃣ *Fazer um pedido* - Solicite um filme que não está no catálogo\n\n` +
                        `💡 *Dica:* Use o teste para conhecer a qualidade do nosso serviço!`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📚 Ver Catálogo', callback_data: 'teste_catalogo' },
                    { text: '🔍 Buscar Filme', callback_data: 'teste_buscar' }
                ],
                [
                    { text: '📝 Fazer Pedido', callback_data: 'teste_pedido' }
                ],
                [
                    { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTesteCatalogo(chatId, userId, callbackQuery) {
        const stats = this.catalogoManager.getEstatisticas();
        
        const mensagem = `🎁 *Teste Gratuito - Catálogo*\n\n` +
                        `📊 *Disponível:* ${stats.total} títulos\n` +
                        `🎬 *Filmes:* ${stats.totalFilmes}\n` +
                        `📺 *Séries:* ${stats.totalSeries}\n\n` +
                        `💡 *Escolha uma categoria para navegar e selecionar seu filme de teste:*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `🎬 Filmes (${stats.totalFilmes})`, callback_data: 'teste_filmes' },
                    { text: `📺 Séries (${stats.totalSeries})`, callback_data: 'teste_series' }
                ],
                [
                    { text: '🔍 Buscar Filme', callback_data: 'teste_buscar' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTesteFilmes(chatId, userId, callbackQuery) {
        const filmes = this.catalogoManager.catalogo.filmes;
        
        if (filmes.length === 0) {
            await this.bot.sendMessage(chatId, 
                '❌ Nenhum filme disponível no catálogo no momento.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Mostrar apenas os primeiros 10 filmes para o teste
        const filmesParaTeste = filmes.slice(0, 10);
        
        let mensagem = `🎁 *Teste Gratuito - Filmes Disponíveis*\n\n` +
                      `🎬 *Escolha um filme para seu teste gratuito:*\n\n`;

        const keyboard = {
            inline_keyboard: []
        };

        filmesParaTeste.forEach((filme, index) => {
            const nomeExibicao = filme.nome.length > 30 ? filme.nome.substring(0, 30) + '...' : filme.nome;
            keyboard.inline_keyboard.push([
                { text: `${index + 1}. ${nomeExibicao}`, callback_data: `confirmar_teste_filme_${filme.id}` }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: '🔍 Buscar Filme', callback_data: 'teste_buscar' }
        ]);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar', callback_data: 'teste_catalogo' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTesteSeries(chatId, userId, callbackQuery) {
        const series = this.catalogoManager.catalogo.series;
        
        if (series.length === 0) {
            await this.bot.sendMessage(chatId, 
                '❌ Nenhuma série disponível no catálogo no momento.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Mostrar apenas as primeiras 10 séries para o teste
        const seriesParaTeste = series.slice(0, 10);
        
        let mensagem = `🎁 *Teste Gratuito - Séries Disponíveis*\n\n` +
                      `📺 *Escolha uma série para seu teste gratuito:*\n\n`;

        const keyboard = {
            inline_keyboard: []
        };

        seriesParaTeste.forEach((serie, index) => {
            const nomeExibicao = serie.nome.length > 30 ? serie.nome.substring(0, 30) + '...' : serie.nome;
            keyboard.inline_keyboard.push([
                { text: `${index + 1}. ${nomeExibicao}`, callback_data: `confirmar_teste_serie_${serie.id}` }
            ]);
        });

        keyboard.inline_keyboard.push([
            { text: '🔍 Buscar Série', callback_data: 'teste_buscar' }
        ]);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar', callback_data: 'teste_catalogo' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTesteBuscar(chatId, userId, callbackQuery) {
        // Ativar modo de busca para teste gratuito
        this.estadosTemporarios[userId] = {
            tipo: 'teste_buscar',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `🎁 *Teste Gratuito - Buscar Filme*\n\n` +
                        `🔍 *Digite o nome do filme que deseja assistir no teste:*\n\n` +
                        `*Exemplos:*\n` +
                        `• Vingadores Ultimato\n` +
                        `• Harry Potter\n` +
                        `• Interestelar\n\n` +
                        `💡 *Dica:* Seja específico no nome para facilitar a busca!\n\n` +
                        `⚠️ *Atenção:* Clique em qualquer outro botão para cancelar esta operação.`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTestePedido(chatId, userId, callbackQuery) {
        // Ativar modo de pedido para teste gratuito
        this.estadosTemporarios[userId] = {
            tipo: 'teste_pedido',
            ativo: true,
            timestamp: Date.now()
        };

        const mensagem = `🎁 *Teste Gratuito - Fazer Pedido*\n\n` +
                        `📝 *Digite o nome do filme que deseja solicitar para o teste:*\n\n` +
                        `*Exemplos:*\n` +
                        `• Vingadores Ultimato\n` +
                        `• Harry Potter e a Pedra Filosofal\n` +
                        `• Interestelar\n\n` +
                        `💡 *Dica:* Seja específico no nome para facilitar a busca!\n\n` +
                        `⚠️ *Atenção:* Clique em qualquer outro botão para cancelar esta operação.`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '🔙 Voltar', callback_data: 'teste_gratuito' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleConfirmarTesteFilme(chatId, userId, filmeId, callbackQuery) {
        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
            return;
        }

        const mensagem = `🎁 *Confirmar Teste Gratuito*\n\n` +
                        `🎬 *Filme:* ${filme.nome}\n` +
                        `📝 *Descrição:* ${filme.descricao || 'Sem descrição'}\n` +
                        `📅 *Adicionado em:* ${new Date(filme.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                        `⚠️ *Atenção:* Este teste é válido apenas uma vez!\n\n` +
                        `💡 *Confirma que deseja usar seu teste gratuito neste filme?*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Confirmar Teste', callback_data: `executar_teste_filme_${filmeId}` },
                    { text: '❌ Cancelar', callback_data: 'teste_filmes' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'teste_catalogo' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleConfirmarTesteSerie(chatId, userId, serieId, callbackQuery) {
        const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
        
        if (!serie) {
            await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
            return;
        }

        const mensagem = `🎁 *Confirmar Teste Gratuito*\n\n` +
                        `📺 *Série:* ${serie.nome}\n` +
                        `📝 *Descrição:* ${serie.descricao || 'Sem descrição'}\n` +
                        `📅 *Adicionado em:* ${new Date(serie.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                        `⚠️ *Atenção:* Este teste é válido apenas uma vez!\n\n` +
                        `💡 *Confirma que deseja usar seu teste gratuito nesta série?*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '✅ Confirmar Teste', callback_data: `executar_teste_serie_${serieId}` },
                    { text: '❌ Cancelar', callback_data: 'teste_series' }
                ],
                [
                    { text: '🔙 Voltar', callback_data: 'teste_catalogo' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleExecutarTesteFilme(chatId, userId, filmeId, callbackQuery) {
        // Verificar se ainda tem teste disponível
        if (this.verificarTesteGratuitoUsado(userId)) {
            await this.bot.sendMessage(chatId, 
                '❌ *Teste Gratuito Já Utilizado*\n\n' +
                'Você já utilizou seu teste gratuito.\n\n' +
                '💡 *Assine agora para acessar todo o conteúdo!*',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const filme = this.catalogoManager.getItemPorId(parseInt(filmeId));
        
        if (!filme) {
            await this.bot.sendMessage(chatId, '❌ Filme não encontrado no catálogo.');
            return;
        }

        try {
            // Marcar teste como usado
            const username = callbackQuery.from.username || callbackQuery.from.first_name;
            this.marcarTesteGratuitoUsado(userId, username);

            // Reenviar arquivo do grupo de armazenamento
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, filme.messageId);
            
            const mensagem = `🎁 *Teste Gratuito Executado com Sucesso!*\n\n` +
                           `✅ *${filme.nome}*\n\n` +
                           `📝 ${filme.descricao || 'Sem descrição'}\n` +
                           `🎬 Tipo: Filme\n` +
                           `📅 Adicionado em: ${new Date(filme.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                           `🎉 *Aproveite o filme!*\n\n` +
                           `💡 *Para assistir mais filmes, assine agora!*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💎 Assinar', callback_data: 'assinatura' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                    ]
                ]
            };
            
            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
        } catch (error) {
            console.error('❌ Erro ao executar teste gratuito:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar filme. Tente novamente.');
        }
    }

    async handleExecutarTesteSerie(chatId, userId, serieId, callbackQuery) {
        // Verificar se ainda tem teste disponível
        if (this.verificarTesteGratuitoUsado(userId)) {
            await this.bot.sendMessage(chatId, 
                '❌ *Teste Gratuito Já Utilizado*\n\n' +
                'Você já utilizou seu teste gratuito.\n\n' +
                '💡 *Assine agora para acessar todo o conteúdo!*',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const serie = this.catalogoManager.getItemPorId(parseInt(serieId));
        
        if (!serie) {
            await this.bot.sendMessage(chatId, '❌ Série não encontrada no catálogo.');
            return;
        }

        try {
            // Marcar teste como usado
            const username = callbackQuery.from.username || callbackQuery.from.first_name;
            this.marcarTesteGratuitoUsado(userId, username);

            // Reenviar arquivo do grupo de armazenamento
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, serie.messageId);
            
            const mensagem = `🎁 *Teste Gratuito Executado com Sucesso!*\n\n` +
                           `✅ *${serie.nome}*\n\n` +
                           `📝 ${serie.descricao || 'Sem descrição'}\n` +
                           `📺 Tipo: Série\n` +
                           `📅 Adicionado em: ${new Date(serie.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                           `🎉 *Aproveite a série!*\n\n` +
                           `💡 *Para assistir mais séries, assine agora!*`;

            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '💎 Assinar', callback_data: 'assinatura' }
                    ],
                    [
                        { text: '🔙 Voltar ao Menu', callback_data: 'voltar_menu' }
                    ]
                ]
            };
            
            await this.bot.sendMessage(chatId, mensagem, { 
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            
        } catch (error) {
            console.error('❌ Erro ao executar teste gratuito:', error);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar série. Tente novamente.');
        }
    }

    // Métodos para gerenciamento de pedidos admin
    async handleAdminPedidoDetalhes(chatId, userId, pedidoId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedido = this.pedidosManager.getPedidoPorId(parseInt(pedidoId));
        
        if (!pedido) {
            await this.bot.sendMessage(chatId, '❌ Pedido não encontrado.');
            return;
        }

        const data = new Date(pedido.data).toLocaleDateString('pt-BR');
        const hora = new Date(pedido.data).toLocaleTimeString('pt-BR');
        const prioridade = pedido.isAssinante ? '🔥 *PRIORIDADE ALTA (Assinante)*' : '📝 *Pedido Normal*';
        const status = pedido.processado ? '✅ Processado' : '⏳ Pendente';

        const mensagem = `📋 *Detalhes do Pedido*\n\n` +
                        `🎬 *Título:* ${pedido.nome}\n` +
                        `👤 *Solicitante:* ${pedido.username}\n` +
                        `🆔 *ID:* ${pedido.id}\n` +
                        `📅 *Data:* ${data} às ${hora}\n` +
                        `⭐ *Status:* ${status}\n` +
                        `💎 *Prioridade:* ${prioridade}\n\n` +
                        `💡 *Escolha uma ação:*`;

        const keyboard = {
            inline_keyboard: []
        };

        if (!pedido.processado) {
            keyboard.inline_keyboard.push([
                { text: '✅ Marcar como Processado', callback_data: `admin_pedido_processar_${pedido.id}` }
            ]);
        }

        keyboard.inline_keyboard.push([
            { text: '❌ Cancelar Pedido', callback_data: `admin_pedido_cancelar_${pedido.id}` }
        ]);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar aos Pedidos', callback_data: 'admin_pedidos' }
        ]);

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminPedidoProcessar(chatId, userId, pedidoId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedido = this.pedidosManager.getPedidoPorId(parseInt(pedidoId));
        
        if (!pedido) {
            await this.bot.sendMessage(chatId, '❌ Pedido não encontrado.');
            return;
        }

        if (pedido.processado) {
            await this.bot.sendMessage(chatId, '⚠️ Este pedido já foi processado.');
            return;
        }

        // Marcar como processado
        pedido.processado = true;
        pedido.dataProcessamento = new Date().toISOString();
        this.pedidosManager.savePedidos();

        const mensagem = `✅ *Pedido Processado com Sucesso!*\n\n` +
                        `🎬 *Título:* ${pedido.nome}\n` +
                        `👤 *Solicitante:* ${pedido.username}\n` +
                        `🆔 *ID:* ${pedido.id}\n` +
                        `📅 *Processado em:* ${new Date().toLocaleDateString('pt-BR')} às ${new Date().toLocaleTimeString('pt-BR')}\n\n` +
                        `🎉 *O pedido foi removido da lista de pendentes!*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📝 Ver Próximos Pedidos', callback_data: 'admin_pedidos' }
                ],
                [
                    { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminPedidoCancelar(chatId, userId, pedidoId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedido = this.pedidosManager.getPedidoPorId(parseInt(pedidoId));
        
        if (!pedido) {
            await this.bot.sendMessage(chatId, '❌ Pedido não encontrado.');
            return;
        }

        // Remover o pedido
        this.pedidosManager.removerPedido(parseInt(pedidoId));

        const mensagem = `❌ *Pedido Cancelado*\n\n` +
                        `🎬 *Título:* ${pedido.nome}\n` +
                        `👤 *Solicitante:* ${pedido.username}\n` +
                        `🆔 *ID:* ${pedido.id}\n\n` +
                        `🗑️ *O pedido foi removido da lista.*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📝 Ver Próximos Pedidos', callback_data: 'admin_pedidos' }
                ],
                [
                    { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleAdminPedidosTodos(chatId, userId, callbackQuery) {
        if (userId !== config.ADMIN_ID) {
            await this.bot.sendMessage(chatId, '❌ Acesso negado. Apenas administradores.');
            return;
        }

        const pedidos = this.pedidosManager.getPedidos();
        const pedidosPendentes = pedidos.filter(p => !p.processado);
        const pedidosProcessados = pedidos.filter(p => p.processado);

        const mensagem = `📊 *Relatório Completo de Pedidos*\n\n` +
                        `📝 *Total de Pedidos:* ${pedidos.length}\n` +
                        `⏳ *Pendentes:* ${pedidosPendentes.length}\n` +
                        `✅ *Processados:* ${pedidosProcessados.length}\n\n` +
                        `💡 *Use "Ver Pedidos" para gerenciar os pendentes.*`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📝 Ver Pedidos Pendentes', callback_data: 'admin_pedidos' }
                ],
                [
                    { text: '🔙 Voltar ao Menu Admin', callback_data: 'voltar_menu_admin' }
                ]
            ]
        };

        await this.bot.sendMessage(chatId, mensagem, { 
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleTemporadaSelect(chatId, userId, serieId, seasonNum, callbackQuery) {
        const serie = this.catalogoManager.getItemPorId(serieId);
        if (!serie || !serie.temporadas) {
            await this.bot.sendMessage(chatId, '❌ Série/Dorama não encontrado no catálogo.');
            return;
        }

        const temporada = serie.temporadas.find(t => t.numero === seasonNum);
        if (!temporada || !temporada.episodios || temporada.episodios.length === 0) {
            await this.bot.sendMessage(chatId, `❌ Nenhum episódio disponível ainda para a Temporada ${seasonNum}.`);
            return;
        }

        const keyboard = {
            inline_keyboard: []
        };

        let row = [];
        temporada.episodios.forEach((ep) => {
            row.push({
                text: `Ep ${ep.numero}`,
                callback_data: `ep_${serieId}_${seasonNum}_${ep.numero}`
            });
            if (row.length === 4) {
                keyboard.inline_keyboard.push(row);
                row = [];
            }
        });
        if (row.length > 0) keyboard.inline_keyboard.push(row);

        keyboard.inline_keyboard.push([
            { text: '🔙 Voltar ao Catálogo', callback_data: 'catalogo' }
        ]);

        const mensagem = `📺 *${serie.nome}* - *Temporada ${seasonNum}*\n\n` +
                        `🍿 *Selecione o episódio que deseja assistir:*`;

        await this.bot.sendMessage(chatId, mensagem, {
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    }

    async handleEpisodioSelect(chatId, userId, serieId, seasonNum, epNum, callbackQuery) {
        const username = callbackQuery?.from?.username || callbackQuery?.from?.first_name || 'Usuário';
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId) || userId === config.ADMIN_ID;
        const cota = this.getCotaGratuita(userId);

        if (!isAssinante && !cota.podeEpisodio) {
            await this.handleVerPlanosButton(chatId, userId, callbackQuery);
            return;
        }

        const serie = this.catalogoManager.getItemPorId(serieId);
        const temporada = serie?.temporadas?.find(t => t.numero === seasonNum);
        const ep = temporada?.episodios?.find(e => e.numero === epNum);

        if (!ep || (!ep.messageId && !ep.fileId)) {
            await this.bot.sendMessage(chatId, '❌ Episódio não disponível no momento.');
            return;
        }

        try {
            const entregue = await this.entregarVideoAoUsuario(chatId, ep.messageId, ep.fileId, `📺 *${serie.nome}* - T${seasonNum}E${epNum} 🍿 BrasilFlix`);

            if (!entregue) {
                await this.bot.sendMessage(chatId, '❌ Não foi possível entregar o episódio neste momento. O suporte já foi notificado.');
                return;
            }

            if (!isAssinante) {
                this.consumirCotaGratis(userId, username, 'serie');
                const novaCota = this.getCotaGratuita(userId);
                const msg = `✅ *${serie.nome}* (T${seasonNum}E${epNum})\n` +
                            `🎬 *${ep.nome || `Episódio ${epNum}`}*\n\n` +
                            `🎁 *Você utilizou 1 episódio gratuito!*\n` +
                            `📊 *Seu saldo restante no mês:* ${novaCota.filmesRestantes} filme e ${novaCota.epsRestantes} episódio(s).\n\n` +
                            `💡 *Assine por R$ 15,00/mês para assistir a episódios e temporadas ilimitadas!*`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '💎 Ver Planos VIP - R$ 15', callback_data: 'ver_planos' }],
                        [{ text: '🍿 Menu Principal', callback_data: 'voltar_menu' }]
                    ]
                };
                await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown', reply_markup: keyboard });
            } else {
                const msg = `✅ *${serie.nome}* (T${seasonNum}E${epNum})\n` +
                            `🎬 *${ep.nome || `Episódio ${epNum}`}*\n` +
                            `✨ *Qualidade:* 1080p | 🔊 *Áudio:* ${ep.audio || 'Dublado'}\n\n` +
                            `🍿 *Bom episódio, assinante VIP!*`;
                await this.bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            }
        } catch (e) {
            console.error('Erro ao enviar episódio:', e.message);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar arquivo do episódio.');
        }
    }

    async handleVerDireto(chatId, userId, messageId, callbackQuery) {
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        if (!isAssinante) {
            await this.mostrarMensagemConversao(chatId, userId, null);
            return;
        }

        try {
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, messageId);
        } catch (e) {
            console.error('Erro ao enviar vídeo direto:', e.message);
            await this.bot.sendMessage(chatId, '❌ Erro ao enviar vídeo.');
        }
    }
}

module.exports = CommandHandler; 