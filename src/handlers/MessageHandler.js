const config = require('../../config');

class MessageHandler {
    constructor(bot, pedidosManager, catalogoManager, assinaturaManager, commandHandler) {
        this.bot = bot;
        this.pedidosManager = pedidosManager;
        this.catalogoManager = catalogoManager;
        this.assinaturaManager = assinaturaManager;
        this.commandHandler = commandHandler; // Referência para o CommandHandler
        this.userStates = new Map(); // Para controlar estados de conversa
    }

    async handleMessage(msg) {
        const chatId = msg.chat.id;
        const chatType = msg.chat.type;
        const messageText = msg.text || msg.caption || '';

        // Ignorar comandos (já tratados pelo CommandHandler)
        if (messageText.startsWith('/')) {
            return;
        }

        // Se for mensagem no grupo de armazenamento
        if (chatId === config.STORAGE_GROUP_ID) {
            await this.handleStorageGroupMessage(msg);
            return;
        }

        // Se for chat privado
        if (chatType === 'private') {
            await this.handlePrivateMessage(msg);
            return;
        }

        // Outros tipos de chat (grupos, supergrupos)
        await this.handleGroupMessage(msg);
    }

    async handleStorageGroupMessage(msg) {
        const messageId = msg.message_id;
        const caption = msg.caption || '';
        const document = msg.document;
        const video = msg.video;
        const audio = msg.audio;

        // Verificar se é um arquivo válido
        if (!document && !video && !audio) {
            return;
        }

        // Se tem caption, pode ser uma adição ao catálogo
        if (caption && caption.trim()) {
            await this.processarAdicaoCatalogo(msg, caption);
        } else {
            // Se não tem caption, sugerir o formato
            await this.sugerirFormato(msg);
        }
    }

    async sugerirFormato(msg) {
        const mensagem = `📝 *Arquivo detectado sem descrição!*\n\n` +
                        `Para adicionar automaticamente ao catálogo, edite a mensagem e adicione uma legenda no formato:\n\n` +
                        `*Nome do filme/série - Ano - Gênero*\n\n` +
                        `*Exemplos:*\n` +
                        `• Harry Potter e a Pedra Filosofal - 2001 - Ação/Fantasia\n` +
                        `• Vingadores Ultimato - 2019 - Ação/Aventura\n` +
                        `• Breaking Bad Temporada 1 - 2008 - Drama/Suspense\n\n` +
                        `💡 *Dica:* Após adicionar a legenda, o sistema detectará automaticamente e adicionará ao catálogo!`;

        await this.bot.sendMessage(config.STORAGE_GROUP_ID, mensagem, { parse_mode: 'Markdown' });
    }

    async processarAdicaoCatalogo(msg, caption) {
        const messageId = msg.message_id;
        const lines = caption.split('\n');
        const primeiraLinha = lines[0].trim();

        // Tentar extrair informações da primeira linha com regex mais flexível
        const match = primeiraLinha.match(/^(.+?)(?:\s*[-–—]\s*(\d{4}))?(?:\s*[-–—]\s*(.+))?$/);
        
        if (!match) {
            await this.bot.sendMessage(config.STORAGE_GROUP_ID, 
                '❌ Formato inválido. Use: Nome - Ano - Gênero\n' +
                'Exemplo: Vingadores Ultimato - 2019 - Ação/Aventura\n\n' +
                '💡 *Dica:* O sistema detecta automaticamente quando você envia um arquivo com legenda no formato correto.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const nome = match[1].trim();
        const ano = match[2] || '';
        const genero = match[3] || '';
        
        // Verificar se o nome não está vazio
        if (!nome || nome.length < 2) {
            await this.bot.sendMessage(config.STORAGE_GROUP_ID, 
                '❌ Nome do filme/série muito curto ou inválido.',
                { parse_mode: 'Markdown' }
            );
            return;
        }
        
        // Determinar se é filme ou série baseado no nome ou gênero
        const tipo = this.determinarTipo(nome, genero);
        
        // Criar descrição completa
        let descricao = nome;
        if (ano) descricao += ` (${ano})`;
        if (genero) descricao += ` - ${genero}`;
        
        // Adicionar ao catálogo (permitirá re-adição se mensagem anterior não existir)
        const resultado = await this.catalogoManager.adicionarFilme(nome, descricao, messageId, tipo);
        
        if (!resultado.success) {
            await this.bot.sendMessage(config.STORAGE_GROUP_ID, 
                `⚠️ *Atenção:* "${nome}" já existe no catálogo!\n\n` +
                `💡 *Para forçar a adição, use:* /adicionar_forcar "${nome}"`,
                { parse_mode: 'Markdown' }
            );
            return;
        }
        
        const item = resultado.item;
        
        const mensagemConfirmacao = `✅ *${tipo === 'filme' ? 'Filme' : 'Série'} adicionado automaticamente!*\n\n` +
                                   `🎬 *Nome:* ${item.nome}\n` +
                                   `📝 *Descrição:* ${item.descricao}\n` +
                                   `🆔 *ID:* ${item.id}\n` +
                                   `📅 *Data:* ${new Date(item.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                                   `🎉 *Pronto!* Agora os usuários podem buscar por "${nome}" no bot.`;

        await this.bot.sendMessage(config.STORAGE_GROUP_ID, mensagemConfirmacao, { parse_mode: 'Markdown' });
    }

    determinarTipo(nome, genero) {
        const nomeLower = nome.toLowerCase();
        const generoLower = genero.toLowerCase();
        
        // Palavras que indicam série
        const indicadoresSerie = [
            'temporada', 'season', 'episódio', 'episode', 'série', 'series', 'tv',
            't1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10',
            's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10',
            'temp', 'ep', 'eps'
        ];
        
        // Verificar se contém indicadores de série
        for (const indicador of indicadoresSerie) {
            if (nomeLower.includes(indicador) || generoLower.includes(indicador)) {
                return 'serie';
            }
        }
        
        // Verificar padrões comuns de séries (ex: "Nome S01E01")
        const padraoSerie = /s\d{1,2}e\d{1,2}|temporada\s*\d+|season\s*\d+/i;
        if (padraoSerie.test(nomeLower)) {
            return 'serie';
        }
        
        // Por padrão, assume que é filme
        return 'filme';
    }

    async handlePrivateMessage(msg) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const messageText = msg.text || '';

        // Verificar se é uma seleção de busca (número) - PRIORIDADE ALTA
        const numeroSelecao = parseInt(messageText.trim());
        if (!isNaN(numeroSelecao) && numeroSelecao > 0) {
            console.log(`🔢 Número detectado: ${numeroSelecao} do usuário ${userId}`);
            await this.handleSelecaoBusca(msg, numeroSelecao);
            return;
        }

        // Verificar se o usuário está em algum estado específico
        const userState = this.userStates.get(userId);
        
        if (userState) {
            await this.handleUserState(msg, userState);
            return;
        }

        // Verificar se o usuário está em modo de captura do CommandHandler
        if (this.commandHandler && messageText.trim()) {
            const processado = await this.commandHandler.processarMensagemTexto(msg);
            if (processado) {
                return; // Mensagem foi processada pelo sistema de captura
            }
        }

        // Se não está em estado específico, tratar como mensagem normal
        if (messageText.trim()) {
            const mensagem = `💬 *Mensagem recebida!*\n\n` +
                           `Se você quer solicitar um filme ou série, use:\n` +
                           `📝 /pedido <nome>\n\n` +
                           `Para buscar no catálogo:\n` +
                           `🔍 /buscar <termo>\n\n` +
                           `Para ver ajuda:\n` +
                           `❓ /ajuda`;

            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
        }
    }

    async handleSelecaoBusca(msg, numeroSelecao) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;

        // Verificar se há resultados de busca armazenados para este usuário
        console.log(`🔍 CommandHandler disponível:`, !!this.commandHandler);
        console.log(`🔍 resultadosBuscaTemp disponível:`, !!this.commandHandler?.resultadosBuscaTemp);
        const resultadosBusca = this.commandHandler?.resultadosBuscaTemp?.get(userId);
        console.log(`🔍 Verificando resultados para usuário ${userId}:`, resultadosBusca ? `${resultadosBusca.length} itens` : 'nenhum');
        
        if (!resultadosBusca || !Array.isArray(resultadosBusca)) {
            await this.bot.sendMessage(chatId, 
                '❌ Nenhuma busca recente encontrada. Use /buscar <termo> primeiro.',
                { parse_mode: 'Markdown' }
            );
            return;
        }

        // Verificar se o número é válido
        if (numeroSelecao < 1 || numeroSelecao > resultadosBusca.length) {
            await this.bot.sendMessage(chatId, 
                `❌ Número inválido. Digite um número entre 1 e ${resultadosBusca.length}.`,
                { parse_mode: 'Markdown' }
            );
            return;
        }

        const itemSelecionado = resultadosBusca[numeroSelecao - 1];
        
        // Verificar se é assinante
        const isAssinante = this.assinaturaManager.verificarAssinatura(userId);
        if (!isAssinante) {
            await this.commandHandler.mostrarMensagemConversao(chatId, userId, null);
            return;
        }

        try {
            // Reenviar arquivo do grupo de armazenamento
            await this.bot.forwardMessage(chatId, config.STORAGE_GROUP_ID, itemSelecionado.messageId);
            
            const mensagem = `✅ *${itemSelecionado.nome}*\n\n` +
                           `📝 ${itemSelecionado.descricao || 'Sem descrição'}\n` +
                           `🎬 Tipo: ${itemSelecionado.tipo === 'filme' ? 'Filme' : 'Série'}\n` +
                           `📅 Adicionado em: ${new Date(itemSelecionado.dataAdicionado).toLocaleDateString('pt-BR')}\n\n` +
                           `🎉 *Aproveite o conteúdo!*`;
            
            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
            
            // Limpar resultados de busca temporários
            this.commandHandler.resultadosBuscaTemp.delete(userId);
            
        } catch (error) {
            console.error('❌ Erro ao enviar arquivo:', error);
            await this.bot.sendMessage(chatId, 
                '❌ Erro ao enviar arquivo. A mensagem pode ter sido removida do grupo de armazenamento.',
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleUserState(msg, userState) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const messageText = msg.text || '';

        switch (userState.type) {
            case 'aguardando_descricao':
                // Processar descrição adicional para pedido
                const pedido = this.pedidosManager.getPedidosPorUsuario(userId).pop();
                if (pedido) {
                    pedido.descricao = messageText.trim();
                    this.pedidosManager.savePedidos();
                    
                    await this.bot.sendMessage(chatId, 
                        '✅ Descrição adicionada ao pedido com sucesso!', 
                        { parse_mode: 'Markdown' }
                    );
                }
                this.userStates.delete(userId);
                break;

            default:
                this.userStates.delete(userId);
                break;
        }
    }

    async handleGroupMessage(msg) {
        const chatId = msg.chat.id;
        const messageText = msg.text || '';

        // Em grupos, apenas responder se mencionado ou se for uma mensagem específica
        if (messageText.includes('@BrasilFlixBot') || messageText.startsWith('!')) {
            const mensagem = `🤖 *BrasilFlix Bot*\n\n` +
                           `Para usar o bot, entre em contato privado:\n` +
                           `@BrasilFlixBot\n\n` +
                           `Ou use os comandos:\n` +
                           `📝 /pedido <nome>\n` +
                           `🔍 /buscar <termo>`;

            await this.bot.sendMessage(chatId, mensagem, { parse_mode: 'Markdown' });
        }
    }

    // Método para definir estado do usuário
    setUserState(userId, state) {
        this.userStates.set(userId, state);
    }

    // Método para limpar estado do usuário
    clearUserState(userId) {
        this.userStates.delete(userId);
    }
}

module.exports = MessageHandler; 