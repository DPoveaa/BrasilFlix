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

        const fileName = (video && video.file_name) || (document && document.file_name) || '';
        const textToProcess = caption.trim() || fileName.trim();

        if (textToProcess) {
            await this.processarAdicaoCatalogo(msg, textToProcess);
        } else {
            await this.sugerirFormato(msg);
        }
    }

    async sugerirFormato(msg) {
        const mensagem = `📝 *Arquivo detectado sem descrição!*\n\n` +
                        `O sistema tenta reconhecer automaticamente. Você também pode adicionar uma legenda:\n\n` +
                        `*Nome do filme/série/dorama - Ano*\n\n` +
                        `*Exemplos:*\n` +
                        `• Pousando no Amor S01E01 - 2019\n` +
                        `• Harry Potter e a Pedra Filosofal - 2001\n` +
                        `• Breaking Bad S01E01 - 2008`;

        await this.bot.sendMessage(config.STORAGE_GROUP_ID, mensagem, { parse_mode: 'Markdown' });
    }

    async processarAdicaoCatalogo(msg, rawText) {
        const messageId = msg.message_id;
        const TMDBService = require('../services/TMDBService');
        
        // 1. Limpar e extrair nome base
        let cleanText = rawText
            .replace(/\.[a-zA-Z0-9]{2,4}$/, '') // remove extensão
            .replace(/[\._]/g, ' ') // substitui pontos e underlines por espaço
            .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|webrip|dual|dublado|legendado|aac|x264|x265|hevc)\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();

        // Detectar temporada e episódio (ex: S01E05, T1 Ep 5, Temp 1)
        const matchEp = cleanText.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\s*(?:e|ep|episodio|episódio|x)\s*(\d{1,3})\b/i);
        const matchTempOnly = cleanText.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\b/i);

        let isSerie = !!matchEp || !!matchTempOnly || this.determinarTipo(cleanText, '') === 'serie';
        let seasonNum = matchEp ? parseInt(matchEp[1], 10) : (matchTempOnly ? parseInt(matchTempOnly[1], 10) : 1);
        let epNum = matchEp ? parseInt(matchEp[2], 10) : 1;

        // Remove marcações de temporada/episódio do nome de busca
        let searchTitle = cleanText
            .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\s*(?:e|ep|episodio|episódio|x)\s*\d{1,3}\b/gi, '')
            .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\b/gi, '')
            .replace(/[-–—]\s*\d{4}/, '')
            .trim();

        if (!searchTitle || searchTitle.length < 2) {
            searchTitle = cleanText;
        }

        console.log(`🔍 Auto-indexador TMDB procurando por: "${searchTitle}" (Série: ${isSerie})`);

        let tmdbData = null;
        try {
            if (isSerie) {
                const results = await TMDBService.searchTV(searchTitle);
                if (results.length > 0) {
                    tmdbData = await TMDBService.getTVDetails(results[0].tmdbId);
                }
            } else {
                const results = await TMDBService.searchMovie(searchTitle);
                if (results.length > 0) {
                    tmdbData = await TMDBService.getMovieDetails(results[0].tmdbId);
                }
            }
        } catch (e) {
            console.warn('⚠️ Falha ao buscar no TMDB:', e.message);
        }

        const nomeFinal = tmdbData?.nome || searchTitle;
        const anoFinal = tmdbData?.ano || this.catalogoManager.extrairAno(rawText) || '';
        const sinopseFinal = tmdbData?.sinopse || rawText;

        if (isSerie) {
            const res = await this.catalogoManager.adicionarEpisodioSerie(
                nomeFinal,
                seasonNum,
                epNum,
                messageId,
                msg.video?.file_id || msg.document?.file_id || null,
                {
                    ...tmdbData,
                    ano: anoFinal,
                    sinopse: sinopseFinal,
                    episodioNome: `Episódio ${epNum}`
                }
            );

            const msgConfirm = `✅ *Episódio de Série/Dorama Catalogado!*\n\n` +
                               `📺 *Série:* ${nomeFinal}\n` +
                               `🔢 *Temporada:* ${seasonNum} | *Episódio:* ${epNum}\n` +
                               `⭐ *Nota TMDB:* ${tmdbData?.nota || 'N/A'}/10\n` +
                               `🆔 *Message ID:* ${messageId}\n\n` +
                               `🍿 *Disponível para assinantes!*`;

            await this.bot.sendMessage(config.STORAGE_GROUP_ID, msgConfirm, { parse_mode: 'Markdown' });
        } else {
            const res = await this.catalogoManager.adicionarFilme(
                nomeFinal,
                sinopseFinal,
                messageId,
                'filme',
                true,
                {
                    ...tmdbData,
                    ano: anoFinal,
                    sinopse: sinopseFinal,
                    fileId: msg.video?.file_id || msg.document?.file_id || null
                }
            );

            const msgConfirm = `✅ *Filme Catalogado com Sucesso!*\n\n` +
                               `🎬 *Título:* ${nomeFinal}${anoFinal ? ` (${anoFinal})` : ''}\n` +
                               `⭐ *Nota TMDB:* ${tmdbData?.nota || 'N/A'}/10\n` +
                               `🎭 *Gêneros:* ${(tmdbData?.generos || []).join(', ') || 'Geral'}\n` +
                               `🆔 *Message ID:* ${messageId}\n\n` +
                               `🍿 *Disponível para assinantes!*`;

            await this.bot.sendMessage(config.STORAGE_GROUP_ID, msgConfirm, { parse_mode: 'Markdown' });
        }
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