const fs = require('fs-extra');
const config = require('../../config');

class CatalogoManager {
    constructor() {
        this.catalogoFile = config.CATALOGO_FILE;
        this.ensureDataDirectory();
        this.loadCatalogo();
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
    }

    loadCatalogo() {
        try {
            if (fs.existsSync(this.catalogoFile)) {
                this.catalogo = fs.readJsonSync(this.catalogoFile);
            } else {
                this.catalogo = {
                    filmes: [],
                    series: []
                };
                this.saveCatalogo();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar catálogo:', error);
            this.catalogo = {
                filmes: [],
                series: []
            };
        }
    }

    saveCatalogo() {
        try {
            fs.writeJsonSync(this.catalogoFile, this.catalogo, { spaces: 2 });
        } catch (error) {
            console.error('❌ Erro ao salvar catálogo:', error);
        }
    }

    async adicionarFilme(nome, descricao, messageId, tipo = 'filme', forcarAdicao = false) {
        // Verificar se já existe no catálogo
        const existente = this.buscarItem(nome);
        
        if (existente.length > 0 && !forcarAdicao) {
            // Verificar se a mensagem anterior ainda existe
            const mensagemExiste = await this.verificarMensagemExiste(existente[0].messageId);
            
            if (mensagemExiste) {
                console.log(`⚠️ ${tipo} já existe no catálogo: ${nome}`);
                return { success: false, message: 'Já existe no catálogo', item: existente[0] };
            } else {
                console.log(`🔄 Mensagem anterior não existe mais, permitindo nova adição: ${nome}`);
                // Remover o item antigo
                this.removerItem(existente[0].id);
            }
        }

        const item = {
            id: Date.now(),
            nome: nome.trim(),
            descricao: descricao.trim(),
            messageId,
            tipo,
            dataAdicionado: new Date().toISOString(),
            tags: this.extrairTags(nome + ' ' + descricao)
        };

        if (tipo === 'filme') {
            this.catalogo.filmes.push(item);
        } else {
            this.catalogo.series.push(item);
        }

        this.saveCatalogo();
        console.log(`✅ ${tipo} adicionado ao catálogo: ${nome}`);
        return { success: true, item: item };
    }

    async verificarMensagemExiste(messageId) {
        try {
            // Como não podemos verificar se a mensagem existe via API,
            // vamos assumir que ela existe se temos um messageId válido
            // e verificar se já temos o item no catálogo
            const item = this.getItemPorMessageId(messageId);
            return item !== null; // Retorna true se o item existe no catálogo
        } catch (error) {
            return false; // Em caso de erro, assume que não existe
        }
    }

    extrairTags(texto) {
        const palavras = texto.toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(palavra => palavra.length > 2);
        
        return [...new Set(palavras)];
    }

    buscarItem(termo) {
        const termoLower = termo.toLowerCase();
        const resultados = [];

        // Verificar se o catálogo está inicializado corretamente
        if (!this.catalogo) {
            console.error('❌ Catálogo não inicializado');
            this.loadCatalogo();
        }

        // Garantir que filmes e séries existam
        if (!this.catalogo.filmes) {
            this.catalogo.filmes = [];
        }
        if (!this.catalogo.series) {
            this.catalogo.series = [];
        }

        // Buscar em filmes
        this.catalogo.filmes.forEach(filme => {
            if (this.itemCorresponde(filme, termoLower)) {
                resultados.push({ ...filme, tipo: 'filme' });
            }
        });

        // Buscar em séries
        this.catalogo.series.forEach(serie => {
            if (this.itemCorresponde(serie, termoLower)) {
                resultados.push({ ...serie, tipo: 'serie' });
            }
        });

        return resultados;
    }

    itemCorresponde(item, termo) {
        return item.nome.toLowerCase().includes(termo) ||
               item.descricao.toLowerCase().includes(termo) ||
               item.tags.some(tag => tag.includes(termo));
    }

    getItemPorId(id) {
        const filme = this.catalogo.filmes.find(f => f.id === id);
        if (filme) return { ...filme, tipo: 'filme' };

        const serie = this.catalogo.series.find(s => s.id === id);
        if (serie) return { ...serie, tipo: 'serie' };

        return null;
    }

    getItemPorMessageId(messageId) {
        const filme = this.catalogo.filmes.find(f => f.messageId === messageId);
        if (filme) return { ...filme, tipo: 'filme' };

        const serie = this.catalogo.series.find(s => s.messageId === messageId);
        if (serie) return { ...serie, tipo: 'serie' };

        return null;
    }

    removerItem(id) {
        let index = this.catalogo.filmes.findIndex(f => f.id === id);
        if (index !== -1) {
            this.catalogo.filmes.splice(index, 1);
            this.saveCatalogo();
            return true;
        }

        index = this.catalogo.series.findIndex(s => s.id === id);
        if (index !== -1) {
            this.catalogo.series.splice(index, 1);
            this.saveCatalogo();
            return true;
        }

        return false;
    }

    getEstatisticas() {
        return {
            totalFilmes: this.catalogo.filmes.length,
            totalSeries: this.catalogo.series.length,
            total: this.catalogo.filmes.length + this.catalogo.series.length
        };
    }

    formatarCatalogo() {
        const stats = this.getEstatisticas();
        let mensagem = `📚 *Catálogo BrasilFlix*\n\n`;
        mensagem += `🎬 *Filmes:* ${stats.totalFilmes}\n`;
        mensagem += `📺 *Séries:* ${stats.totalSeries}\n`;
        mensagem += `📊 *Total:* ${stats.total}\n\n`;
        mensagem += `Use /buscar <nome> para encontrar conteúdo específico.`;

        return mensagem;
    }

    formatarResultadosBusca(resultados) {
        if (resultados.length === 0) {
            return '🔍 Nenhum resultado encontrado para sua busca.';
        }

        let mensagem = `🔍 *Resultados da busca:*\n\n`;
        
        resultados.forEach((item, index) => {
            const icone = item.tipo === 'filme' ? '🎬' : '📺';
            
            // Extrair ano da descrição se disponível
            let ano = '';
            if (item.descricao) {
                const anoMatch = item.descricao.match(/\((\d{4})\)/);
                if (anoMatch) {
                    ano = ` (${anoMatch[1]})`;
                }
            }
            
            mensagem += `${icone} *${index + 1}.* ${item.nome}${ano}\n`;
        });

        mensagem += `\n💡 *Digite o número do item que deseja ver:*\n`;
        mensagem += `Exemplo: 1, 2, 3...`;

        return mensagem;
    }
}

module.exports = CatalogoManager; 