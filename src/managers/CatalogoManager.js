const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class CatalogoManager {
    constructor() {
        this.catalogoFile = config.CATALOGO_FILE;
        this.backupDir = config.BACKUP_DIR || './data/backups';
        this.ensureDataDirectory();
        this.loadCatalogo();
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
        fs.ensureDirSync(this.backupDir);
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

            // Garante integridade das coleções
            if (!Array.isArray(this.catalogo.filmes)) this.catalogo.filmes = [];
            if (!Array.isArray(this.catalogo.series)) this.catalogo.series = [];
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
            // Escrita Atômica: salva primeiro em temp e renomeia
            const tempFile = `${this.catalogoFile}.tmp`;
            fs.writeJsonSync(tempFile, this.catalogo, { spaces: 2 });
            fs.moveSync(tempFile, this.catalogoFile, { overwrite: true });

            // Criar backup rotativo
            this.createBackup();
        } catch (error) {
            console.error('❌ Erro ao salvar catálogo:', error);
        }
    }

    createBackup() {
        try {
            const today = new Date().toISOString().split('T')[0];
            const backupFile = path.join(this.backupDir, `catalogo_backup_${today}.json`);
            // Cria backup diário se ainda não existir hoje ou a cada salvamento crítico
            fs.writeJsonSync(backupFile, this.catalogo, { spaces: 2 });
        } catch (e) {
            // Silencioso para não interromper fluxo principal
        }
    }

    async adicionarFilme(nome, descricao, messageId, tipo = 'filme', forcarAdicao = false, metadadosExtras = {}) {
        const existente = this.buscarItemExato(nome, tipo);

        if (existente && !forcarAdicao) {
            console.log(`⚠️ ${tipo} já existe no catálogo: ${nome}`);
            return { success: false, message: 'Já existe no catálogo', item: existente };
        }

        const item = {
            id: metadadosExtras.id || Date.now(),
            tmdbId: metadadosExtras.tmdbId || null,
            nome: nome.trim(),
            nomeOriginal: metadadosExtras.nomeOriginal || '',
            descricao: descricao ? descricao.trim() : '',
            sinopse: metadadosExtras.sinopse || descricao || '',
            posterUrl: metadadosExtras.posterUrl || null,
            backdropUrl: metadadosExtras.backdropUrl || null,
            ano: metadadosExtras.ano || this.extrairAno(descricao),
            nota: metadadosExtras.nota || 0,
            generos: metadadosExtras.generos || [],
            qualidade: metadadosExtras.qualidade || '1080p',
            isCam: metadadosExtras.isCam || false,
            isDublado: metadadosExtras.isDublado ?? (metadadosExtras.audio ? !metadadosExtras.audio.toLowerCase().includes('legendado') : true),
            isLegendado: metadadosExtras.isLegendado ?? (metadadosExtras.audio ? metadadosExtras.audio.toLowerCase().includes('legendado') : false),
            audio: metadadosExtras.audio || 'Dublado',
            messageId,
            fileId: metadadosExtras.fileId || null,
            tipo: 'filme',
            dataAdicionado: new Date().toISOString(),
            tags: this.extrairTags(nome + ' ' + (descricao || '') + ' ' + (metadadosExtras.generos ? metadadosExtras.generos.join(' ') : ''))
        };

        this.catalogo.filmes.push(item);
        this.saveCatalogo();
        console.log(`✅ Filme adicionado ao catálogo: ${nome} [Qualidade: ${item.qualidade}, Áudio: ${item.audio}] (MessageId: ${messageId})`);
        return { success: true, item: item };
    }

    buscarFilmesCam() {
        return (this.catalogo.filmes || []).filter(f => f.isCam === true);
    }

    buscarFilmesLegendados() {
        return (this.catalogo.filmes || []).filter(f => f.isLegendado === true || (f.audio && f.audio.toLowerCase().includes('legendado')));
    }

    atualizarMidiaFilme(idOuNome, novaMidia = {}) {
        const filme = (this.catalogo.filmes || []).find(f => 
            f.id === idOuNome || 
            f.nome.toLowerCase() === idOuNome.toString().toLowerCase() ||
            (f.tmdbId && novaMidia.tmdbId && f.tmdbId === novaMidia.tmdbId)
        );

        if (!filme) return false;

        if (novaMidia.messageId) filme.messageId = novaMidia.messageId;
        if (novaMidia.fileId) filme.fileId = novaMidia.fileId;
        if (novaMidia.qualidade) filme.qualidade = novaMidia.qualidade;
        if (typeof novaMidia.isCam === 'boolean') filme.isCam = novaMidia.isCam;
        if (typeof novaMidia.isDublado === 'boolean') filme.isDublado = novaMidia.isDublado;
        if (typeof novaMidia.isLegendado === 'boolean') filme.isLegendado = novaMidia.isLegendado;
        if (novaMidia.audio) filme.audio = novaMidia.audio;
        filme.dataAtualizado = new Date().toISOString();

        this.saveCatalogo();
        console.log(`🔄 Filme atualizado com sucesso no catálogo: "${filme.nome}" [Nova Qualidade: ${filme.qualidade}, Áudio: ${filme.audio}]`);
        return true;
    }

    async adicionarEpisodioSerie(serieNome, temporadaNum, episodioNum, messageId, fileId = null, metadados = {}) {
        let serie = this.catalogo.series.find(s => 
            s.nome.toLowerCase() === serieNome.toLowerCase() || 
            (s.tmdbId && metadados.tmdbId && s.tmdbId === metadados.tmdbId)
        );

        if (!serie) {
            serie = {
                id: Date.now(),
                tmdbId: metadados.tmdbId || null,
                nome: serieNome.trim(),
                nomeOriginal: metadados.nomeOriginal || '',
                descricao: metadados.sinopse || metadados.descricao || '',
                sinopse: metadados.sinopse || '',
                posterUrl: metadados.posterUrl || null,
                backdropUrl: metadados.backdropUrl || null,
                ano: metadados.ano || '',
                nota: metadados.nota || 0,
                generos: metadados.generos || [],
                isDorama: metadados.isDorama || false,
                tipo: 'serie',
                temporadas: [],
                dataAdicionado: new Date().toISOString(),
                tags: this.extrairTags(serieNome + ' ' + (metadados.generos ? metadados.generos.join(' ') : ''))
            };
            this.catalogo.series.push(serie);
        }

        // Encontrar ou criar temporada
        let temporada = serie.temporadas.find(t => t.numero === temporadaNum);
        if (!temporada) {
            temporada = {
                numero: temporadaNum,
                nome: `Temporada ${temporadaNum}`,
                episodios: []
            };
            serie.temporadas.push(temporada);
            serie.temporadas.sort((a, b) => a.numero - b.numero);
        }

        // Verificar se episódio já existe
        const epIndex = temporada.episodios.findIndex(e => e.numero === episodioNum);
        const epData = {
            numero: episodioNum,
            nome: metadados.episodioNome || `Episódio ${episodioNum}`,
            sinopse: metadados.episodioSinopse || '',
            messageId: messageId,
            fileId: fileId,
            qualidade: metadados.qualidade || '1080p',
            audio: metadados.audio || 'Dublado',
            dataAdicionado: new Date().toISOString()
        };

        if (epIndex >= 0) {
            temporada.episodios[epIndex] = epData;
        } else {
            temporada.episodios.push(epData);
            temporada.episodios.sort((a, b) => a.numero - b.numero);
        }

        this.saveCatalogo();
        console.log(`✅ Episódio adicionado: ${serieNome} T${temporadaNum}E${episodioNum} (Msg: ${messageId})`);
        return { success: true, serie, temporada, episodio: epData };
    }

    buscarItemExato(nome, tipo) {
        const nomeLower = nome.toLowerCase().trim();
        if (tipo === 'filme') {
            return this.catalogo.filmes.find(f => f.nome.toLowerCase() === nomeLower);
        }
        return this.catalogo.series.find(s => s.nome.toLowerCase() === nomeLower);
    }

    buscarItem(termo) {
        const termoLower = termo.toLowerCase().trim();
        const resultados = [];

        this.catalogo.filmes.forEach(filme => {
            if (this.itemCorresponde(filme, termoLower)) {
                resultados.push({ ...filme, tipo: 'filme' });
            }
        });

        this.catalogo.series.forEach(serie => {
            if (this.itemCorresponde(serie, termoLower)) {
                resultados.push({ ...serie, tipo: 'serie' });
            }
        });

        return resultados;
    }

    itemCorresponde(item, termo) {
        return (item.nome && item.nome.toLowerCase().includes(termo)) ||
               (item.nomeOriginal && item.nomeOriginal.toLowerCase().includes(termo)) ||
               (item.descricao && item.descricao.toLowerCase().includes(termo)) ||
               (item.tags && item.tags.some(tag => tag.includes(termo)));
    }

    getItemPorId(id) {
        const numId = Number(id);
        const filme = this.catalogo.filmes.find(f => f.id === numId);
        if (filme) return { ...filme, tipo: 'filme' };

        const serie = this.catalogo.series.find(s => s.id === numId);
        if (serie) return { ...serie, tipo: 'serie' };

        return null;
    }

    getItemPorMessageId(messageId) {
        const filme = this.catalogo.filmes.find(f => f.messageId === messageId);
        if (filme) return { ...filme, tipo: 'filme' };

        for (const serie of this.catalogo.series) {
            for (const temp of (serie.temporadas || [])) {
                const ep = (temp.episodios || []).find(e => e.messageId === messageId);
                if (ep) {
                    return { ...serie, temporada: temp.numero, episodio: ep, tipo: 'serie' };
                }
            }
        }
        return null;
    }

    removerItem(id) {
        const numId = Number(id);
        let index = this.catalogo.filmes.findIndex(f => f.id === numId);
        if (index !== -1) {
            this.catalogo.filmes.splice(index, 1);
            this.saveCatalogo();
            return true;
        }

        index = this.catalogo.series.findIndex(s => s.id === numId);
        if (index !== -1) {
            this.catalogo.series.splice(index, 1);
            this.saveCatalogo();
            return true;
        }

        return false;
    }

    extrairAno(texto) {
        if (!texto) return '';
        const match = texto.match(/\b(19\d\d|20\d\d)\b/);
        return match ? match[1] : '';
    }

    extrairTags(texto) {
        if (!texto) return [];
        const palavras = texto.toLowerCase()
            .replace(/[^\w\s\u00C0-\u00FF]/g, '')
            .split(/\s+/)
            .filter(palavra => palavra.length > 2);
        
        return [...new Set(palavras)];
    }

    getEstatisticas() {
        let totalEpisodios = 0;
        this.catalogo.series.forEach(s => {
            (s.temporadas || []).forEach(t => {
                totalEpisodios += (t.episodios || []).length;
            });
        });

        return {
            totalFilmes: this.catalogo.filmes.length,
            totalFilmesDublados: this.getFilmesDublados().length,
            totalFilmesLegendados: this.getFilmesLegendados().length,
            totalSeries: this.catalogo.series.length,
            totalSeriesDubladas: this.getSeriesDubladas().length,
            totalSeriesLegendadas: this.getSeriesLegendadas().length,
            totalEpisodios: totalEpisodios,
            total: this.catalogo.filmes.length + this.catalogo.series.length
        };
    }

    getFilmesDublados() {
        return this.catalogo.filmes.filter(f => !f.audio || f.audio.toLowerCase().includes('dublado') || f.isDublado);
    }

    getFilmesLegendados() {
        return this.catalogo.filmes.filter(f => f.audio && f.audio.toLowerCase().includes('legendado'));
    }

    getSeriesDubladas() {
        return this.catalogo.series.filter(s => !s.audio || s.audio.toLowerCase().includes('dublado') || s.isDublado);
    }

    getSeriesLegendadas() {
        return this.catalogo.series.filter(s => s.audio && s.audio.toLowerCase().includes('legendado'));
    }

    formatarCatalogo() {
        const stats = this.getEstatisticas();
        let mensagem = `📚 *Catálogo BrasilFlix*\n\n`;
        mensagem += `🎬 *Filmes:* ${stats.totalFilmes}\n`;
        mensagem += `📺 *Séries e Doramas:* ${stats.totalSeries} (${stats.totalEpisodios} episódios)\n`;
        mensagem += `📊 *Total de Títulos:* ${stats.total}\n\n`;
        mensagem += `Use /buscar <nome> para encontrar qualquer filme ou dorama.`;

        return mensagem;
    }

    formatarResultadosBusca(resultados) {
        if (resultados.length === 0) {
            return '🔍 Nenhum resultado encontrado para sua busca.';
        }

        let mensagem = `🔍 *Resultados da busca:*\n\n`;
        
        resultados.slice(0, 10).forEach((item, index) => {
            const icone = item.tipo === 'filme' ? '🎬' : (item.isDorama ? '🎎' : '📺');
            const ano = item.ano ? ` (${item.ano})` : '';
            const nota = item.nota ? ` ⭐ ${item.nota}` : '';
            
            mensagem += `${icone} *${index + 1}.* ${item.nome}${ano}${nota}\n`;
        });

        mensagem += `\n💡 *Clique ou digite o número do item que deseja assistir!*`;
        return mensagem;
    }
}

module.exports = CatalogoManager;