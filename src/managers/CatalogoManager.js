const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const db = require('../database/db');

class CatalogoManager {
    constructor() {
        this.catalogo = {
            filmes: [],
            series: []
        };
        this.backupDir = config.BACKUP_DIR || './data/backups';
        this.ensureDataDirectory();
        this.loadCatalogo();
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
        fs.ensureDirSync(this.backupDir);
    }

    async loadCatalogo() {
        try {
            // Carrega Filmes do PostgreSQL
            const filmesRes = await db.query(`SELECT * FROM filmes ORDER BY id ASC`);
            const seriesRes = await db.query(`SELECT * FROM series ORDER BY id ASC`);
            const epsRes = await db.query(`SELECT * FROM episodios ORDER BY serie_id ASC, temporada_numero ASC, numero ASC`);

            // Mapeia episódios por série e temporada
            const epsPorSerie = {};
            for (const ep of epsRes.rows) {
                if (!epsPorSerie[ep.serie_id]) epsPorSerie[ep.serie_id] = {};
                if (!epsPorSerie[ep.serie_id][ep.temporada_numero]) epsPorSerie[ep.serie_id][ep.temporada_numero] = [];

                epsPorSerie[ep.serie_id][ep.temporada_numero].push({
                    numero: ep.numero,
                    nome: ep.nome || `Episódio ${ep.numero}`,
                    sinopse: ep.sinopse || '',
                    messageId: ep.message_id ? Number(ep.message_id) : null,
                    fileId: ep.file_id,
                    qualidade: ep.qualidade || '1080p',
                    audio: ep.audio || (ep.is_dublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
                    isDublado: ep.is_dublado,
                    isLegendado: ep.is_legendado,
                    versoes: {
                        dublado: ep.is_dublado ? { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' } : null,
                        legendado: ep.is_legendado ? { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' } : null
                    },
                    dataAdicionado: ep.created_at
                });
            }

            // Mapeia Séries com suas Temporadas
            const series = seriesRes.rows.map(s => {
                const temporadasObj = epsPorSerie[s.id] || {};
                const temporadas = Object.keys(temporadasObj).map(tNum => ({
                    numero: parseInt(tNum, 10),
                    nome: `Temporada ${tNum}`,
                    episodios: temporadasObj[tNum]
                })).sort((a, b) => a.numero - b.numero);

                return {
                    id: s.id,
                    tmdbId: s.tmdb_id,
                    imdbId: s.imdb_id,
                    nome: s.nome,
                    nomeOriginal: s.nome_original,
                    descricao: s.sinopse || '',
                    sinopse: s.sinopse || '',
                    posterUrl: s.poster_url,
                    backdropUrl: s.backdrop_url,
                    ano: s.ano || '',
                    nota: parseFloat(s.nota || 8.0),
                    generos: Array.isArray(s.generos) ? s.generos : (typeof s.generos === 'string' ? JSON.parse(s.generos) : []),
                    isDorama: s.is_dorama,
                    isDublado: s.is_dublado,
                    isLegendado: s.is_legendado,
                    isCam: s.is_cam,
                    totalTemporadas: s.total_temporadas || temporadas.length || 1,
                    totalEpisodios: s.total_episodios || temporadas.reduce((acc, t) => acc + t.episodios.length, 0),
                    tipo: 'serie',
                    temporadas: temporadas,
                    dataAdicionado: s.created_at,
                    tags: this.extrairTags(s.nome + ' ' + (s.sinopse || '') + ' ' + (s.generos || []).toString())
                };
            });

            // Mapeia Filmes
            const filmes = filmesRes.rows.map(f => ({
                id: f.id,
                tmdbId: f.tmdb_id,
                imdbId: f.imdb_id,
                nome: f.nome,
                nomeOriginal: f.nome_original,
                descricao: f.sinopse || '',
                sinopse: f.sinopse || '',
                posterUrl: f.poster_url,
                backdropUrl: f.backdrop_url,
                ano: f.ano || '',
                nota: parseFloat(f.nota || 8.0),
                generos: Array.isArray(f.generos) ? f.generos : (typeof f.generos === 'string' ? JSON.parse(f.generos) : []),
                qualidade: f.qualidade || '1080p',
                isCam: f.is_cam,
                isDublado: f.is_dublado,
                isLegendado: f.is_legendado,
                audio: f.audio || (f.is_dublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
                versoes: {
                    dublado: f.is_dublado ? { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam } : null,
                    legendado: f.is_legendado ? { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam } : null
                },
                messageId: f.message_id ? Number(f.message_id) : null,
                fileId: f.file_id,
                tipo: 'filme',
                dataAdicionado: f.created_at,
                tags: this.extrairTags(f.nome + ' ' + (f.sinopse || '') + ' ' + (f.generos || []).toString())
            }));

            this.catalogo = { filmes, series };
            console.log(`📚 Catálogo carregado do PostgreSQL: ${filmes.length} filmes, ${series.length} séries.`);
        } catch (error) {
            console.error('❌ Erro ao carregar catálogo do PostgreSQL:', error.message);
            // Fallback para arquivo JSON caso BD esteja temporariamente offline
            if (fs.existsSync(config.CATALOGO_FILE)) {
                try {
                    this.catalogo = fs.readJsonSync(config.CATALOGO_FILE);
                } catch (e) {}
            }
        }
    }

    async saveCatalogo() {
        try {
            // Salva espelho de backup em disco JSON
            const tempFile = `${config.CATALOGO_FILE}.tmp`;
            fs.writeJsonSync(tempFile, this.catalogo, { spaces: 2 });
            fs.moveSync(tempFile, config.CATALOGO_FILE, { overwrite: true });
        } catch (e) {}
    }

    getAudioBadge(item) {
        if (!item) return '';
        const temDub = item.isDublado || !!item.versoes?.dublado || (item.audio && !item.audio.toLowerCase().includes('legendado'));
        const temLeg = item.isLegendado || !!item.versoes?.legendado || (item.audio && item.audio.toLowerCase().includes('legendado'));

        let audioCode = '';
        if (temDub && temLeg) audioCode = 'D/L';
        else if (temDub) audioCode = 'D';
        else if (temLeg) audioCode = 'L';

        if (item.isCam) {
            return audioCode ? `[CAM/${audioCode}]` : '[CAM]';
        }
        return audioCode ? `[${audioCode}]` : '';
    }

    buscarFilmesCam() {
        return (this.catalogo.filmes || []).filter(f => f.isCam === true);
    }

    buscarFilmesApenasLegendados() {
        return (this.catalogo.filmes || []).filter(f => {
            const temDub = f.isDublado === true || !!f.versoes?.dublado;
            const temLeg = f.isLegendado === true || !!f.versoes?.legendado || (f.audio && f.audio.toLowerCase().includes('legendado'));
            return temLeg && !temDub;
        });
    }


    async adicionarFilme(nome, descricao, messageId, tipo = 'filme', forcarAdicao = false, metadadosExtras = {}) {
        const existente = this.buscarItemExato(nome, tipo);

        const isDublado = metadadosExtras.isDublado ?? (metadadosExtras.audio ? !metadadosExtras.audio.toLowerCase().includes('legendado') : true);
        const isLegendado = metadadosExtras.isLegendado ?? (metadadosExtras.audio ? metadadosExtras.audio.toLowerCase().includes('legendado') : false);

        if (existente && !forcarAdicao) {
            console.log(`⚠️ ${tipo} já existe no catálogo: ${nome}. Atualizando versões de áudio...`);
            await this.atualizarMidiaFilme(existente.id, {
                messageId,
                fileId: metadadosExtras.fileId,
                qualidade: metadadosExtras.qualidade || '1080p',
                isCam: metadadosExtras.isCam || false,
                isDublado,
                isLegendado,
                audio: metadadosExtras.audio
            });
            return { success: true, message: 'Versão atualizada no catálogo', item: existente };
        }

        // Persistência no PostgreSQL
        let dbId = metadadosExtras.id;
        try {
            const res = await db.query(`
                INSERT INTO filmes (
                    nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                    nota, tmdb_id, imdb_id, message_id, file_id, qualidade, audio,
                    is_dublado, is_legendado, is_cam, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW()
                ) RETURNING id
            `, [
                nome.trim(), metadadosExtras.nomeOriginal || nome.trim(),
                metadadosExtras.ano || this.extrairAno(descricao),
                JSON.stringify(metadadosExtras.generos || []),
                metadadosExtras.sinopse || descricao || '',
                metadadosExtras.posterUrl || null,
                metadadosExtras.backdropUrl || null,
                metadadosExtras.nota || 8.0,
                metadadosExtras.tmdbId || null,
                metadadosExtras.imdbId || null,
                messageId || null,
                metadadosExtras.fileId || null,
                metadadosExtras.qualidade || '1080p',
                metadadosExtras.audio || (isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
                isDublado, isLegendado, metadadosExtras.isCam || false
            ]);
            dbId = res.rows[0]?.id;
        } catch (e) {
            console.error('❌ Erro ao inserir filme no PostgreSQL:', e.message);
        }

        const item = {
            id: dbId || Date.now(),
            tmdbId: metadadosExtras.tmdbId || null,
            imdbId: metadadosExtras.imdbId || null,
            nome: nome.trim(),
            nomeOriginal: metadadosExtras.nomeOriginal || '',
            descricao: descricao ? descricao.trim() : '',
            sinopse: metadadosExtras.sinopse || descricao || '',
            posterUrl: metadadosExtras.posterUrl || null,
            backdropUrl: metadadosExtras.backdropUrl || null,
            ano: metadadosExtras.ano || this.extrairAno(descricao),
            nota: metadadosExtras.nota || 8.0,
            generos: metadadosExtras.generos || [],
            qualidade: metadadosExtras.qualidade || '1080p',
            isCam: metadadosExtras.isCam || false,
            isDublado: isDublado,
            isLegendado: isLegendado,
            audio: metadadosExtras.audio || (isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
            versoes: {
                dublado: isDublado ? { messageId, fileId: metadadosExtras.fileId || null, qualidade: metadadosExtras.qualidade || '1080p', isCam: metadadosExtras.isCam || false } : null,
                legendado: isLegendado ? { messageId, fileId: metadadosExtras.fileId || null, qualidade: metadadosExtras.qualidade || '1080p', isCam: metadadosExtras.isCam || false } : null
            },
            messageId,
            fileId: metadadosExtras.fileId || null,
            tipo: 'filme',
            dataAdicionado: new Date().toISOString(),
            tags: this.extrairTags(nome + ' ' + (descricao || '') + ' ' + (metadadosExtras.generos ? metadadosExtras.generos.join(' ') : ''))
        };

        this.catalogo.filmes.push(item);
        this.saveCatalogo();
        console.log(`✅ Filme adicionado ao catálogo: ${nome} [ID: ${item.id}, Qualidade: ${item.qualidade}] (MessageId: ${messageId})`);
        return { success: true, item: item };
    }

    async atualizarMidiaFilme(idOuNome, novaMidia = {}) {
        const filme = (this.catalogo.filmes || []).find(f => 
            f.id === idOuNome || 
            f.nome.toLowerCase() === idOuNome.toString().toLowerCase() ||
            (f.tmdbId && novaMidia.tmdbId && f.tmdbId === novaMidia.tmdbId)
        );

        if (!filme) return false;

        const isNovaDub = novaMidia.isDublado ?? (novaMidia.audio ? !novaMidia.audio.toLowerCase().includes('legendado') : false);
        const isNovaLeg = novaMidia.isLegendado ?? (novaMidia.audio ? novaMidia.audio.toLowerCase().includes('legendado') : false);

        if (isNovaDub) {
            filme.isDublado = true;
            filme.messageId = novaMidia.messageId || filme.messageId;
            filme.fileId = novaMidia.fileId || filme.fileId;
            filme.qualidade = novaMidia.qualidade || filme.qualidade;
            if (typeof novaMidia.isCam === 'boolean') filme.isCam = novaMidia.isCam;
        }

        if (isNovaLeg) {
            filme.isLegendado = true;
            if (!filme.isDublado) {
                filme.messageId = novaMidia.messageId || filme.messageId;
                filme.fileId = novaMidia.fileId || filme.fileId;
            }
        }

        try {
            await db.query(`
                UPDATE filmes SET 
                    message_id = $1, file_id = $2, qualidade = $3, audio = $4,
                    is_dublado = $5, is_legendado = $6, is_cam = $7, updated_at = NOW()
                WHERE id = $8
            `, [
                filme.messageId, filme.fileId, filme.qualidade, filme.audio,
                filme.isDublado, filme.isLegendado, filme.isCam, filme.id
            ]);
        } catch (e) {
            console.warn('⚠️ Erro ao atualizar filme no PostgreSQL:', e.message);
        }

        filme.dataAtualizado = new Date().toISOString();
        this.saveCatalogo();
        console.log(`🔄 Filme atualizado com sucesso no catálogo: "${filme.nome}" [Dublado: ${filme.isDublado}, Legendado: ${filme.isLegendado}]`);
        return true;
    }

    async adicionarEpisodioSerie(serieNome, temporadaNum, episodioNum, messageId, fileId = null, metadados = {}) {
        let serie = this.catalogo.series.find(s => 
            s.nome.toLowerCase() === serieNome.toLowerCase() || 
            (s.tmdbId && metadados.tmdbId && s.tmdbId === metadados.tmdbId)
        );

        const isDub = metadados.isDublado ?? (metadados.audio ? !metadados.audio.toLowerCase().includes('legendado') : true);
        const isLeg = metadados.isLegendado ?? (metadados.audio ? metadados.audio.toLowerCase().includes('legendado') : false);

        if (!serie) {
            let sId = null;
            try {
                const res = await db.query(`
                    INSERT INTO series (
                        nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                        nota, tmdb_id, imdb_id, total_temporadas, total_episodios, is_dorama,
                        is_dublado, is_legendado, is_cam, created_at, updated_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW()
                    ) RETURNING id
                `, [
                    serieNome.trim(), metadados.nomeOriginal || serieNome.trim(), metadados.ano || '',
                    JSON.stringify(metadados.generos || []), metadados.sinopse || '',
                    metadados.posterUrl || null, metadados.backdropUrl || null,
                    metadados.nota || 8.0, metadados.tmdbId || null, metadados.imdbId || null,
                    1, 1, metadados.isDorama || false, isDub, isLeg, metadados.isCam || false
                ]);
                sId = res.rows[0]?.id;
            } catch (e) {
                console.warn('⚠️ Erro ao inserir série no PostgreSQL:', e.message);
            }

            serie = {
                id: sId || Date.now(),
                tmdbId: metadados.tmdbId || null,
                imdbId: metadados.imdbId || null,
                nome: serieNome.trim(),
                nomeOriginal: metadados.nomeOriginal || '',
                descricao: metadados.sinopse || metadados.descricao || '',
                sinopse: metadados.sinopse || '',
                posterUrl: metadados.posterUrl || null,
                backdropUrl: metadados.backdropUrl || null,
                ano: metadados.ano || '',
                nota: metadados.nota || 8.0,
                generos: metadados.generos || [],
                isDorama: metadados.isDorama || false,
                isDublado: isDub,
                isLegendado: isLeg,
                tipo: 'serie',
                temporadas: [],
                dataAdicionado: new Date().toISOString(),
                tags: this.extrairTags(serieNome + ' ' + (metadados.generos ? metadados.generos.join(' ') : ''))
            };
            this.catalogo.series.push(serie);
        } else {
            if (isDub) serie.isDublado = true;
            if (isLeg) serie.isLegendado = true;
        }

        // Persistência do Episódio no PostgreSQL
        try {
            await db.query(`
                INSERT INTO episodios (
                    serie_id, temporada_numero, numero, nome, sinopse,
                    message_id, file_id, qualidade, audio, is_dublado, is_legendado, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
                ) ON CONFLICT (serie_id, temporada_numero, numero) DO UPDATE SET
                    message_id = EXCLUDED.message_id,
                    file_id = EXCLUDED.file_id,
                    qualidade = EXCLUDED.qualidade,
                    audio = EXCLUDED.audio,
                    is_dublado = EXCLUDED.is_dublado,
                    is_legendado = EXCLUDED.is_legendado
            `, [
                serie.id, temporadaNum, episodioNum,
                metadados.episodioNome || `Episódio ${episodioNum}`,
                metadados.episodioSinopse || '',
                messageId || null, fileId || null,
                metadados.qualidade || '1080p',
                metadados.audio || (isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
                isDub, isLeg
            ]);

            await db.query(`
                UPDATE series SET 
                    total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1),
                    total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1),
                    updated_at = NOW()
                WHERE id = $1
            `, [serie.id]);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir episódio no PostgreSQL:', e.message);
        }

        // Encontrar ou criar temporada no cache
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

        const epIndex = temporada.episodios.findIndex(e => e.numero === episodioNum);
        const epData = {
            numero: episodioNum,
            nome: metadados.episodioNome || `Episódio ${episodioNum}`,
            sinopse: metadados.episodioSinopse || '',
            messageId: messageId,
            fileId: fileId,
            qualidade: metadados.qualidade || '1080p',
            audio: metadados.audio || (isDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)'),
            versoes: {
                dublado: isDub ? { messageId, fileId, qualidade: metadados.qualidade || '1080p' } : null,
                legendado: isLeg ? { messageId, fileId, qualidade: metadados.qualidade || '1080p' } : null
            },
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

    async removerItem(id) {
        const numId = Number(id);
        
        try {
            await db.query(`DELETE FROM filmes WHERE id = $1`, [numId]);
            await db.query(`DELETE FROM series WHERE id = $1`, [numId]);
        } catch (e) {
            console.warn('⚠️ Erro ao remover do PostgreSQL:', e.message);
        }

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

    buscarItemExato(nome, tipo) {
        if (!nome) return null;
        const nomeLower = nome.toLowerCase().trim();
        if (tipo === 'filme') {
            return this.catalogo.filmes.find(f => f.nome.toLowerCase() === nomeLower);
        }
        return this.catalogo.series.find(s => s.nome.toLowerCase() === nomeLower);
    }

    getItemPorId(id) {
        if (!id) return null;
        const numId = Number(id);
        const filme = (this.catalogo.filmes || []).find(f => f.id === numId || String(f.id) === String(id));
        if (filme) return { ...filme, tipo: 'filme' };

        const serie = (this.catalogo.series || []).find(s => s.id === numId || String(s.id) === String(id));
        if (serie) return { ...serie, tipo: 'serie' };

        return null;
    }

    buscarSeriePorId(id) {
        if (!id) return null;
        const numId = Number(id);
        return (this.catalogo.series || []).find(s => s.id === numId || String(s.id) === String(id)) || null;
    }

    buscarFilmePorId(id) {
        if (!id) return null;
        const numId = Number(id);
        return (this.catalogo.filmes || []).find(f => f.id === numId || String(f.id) === String(id)) || null;
    }

    getItemPorMessageId(messageId) {
        const numMsg = Number(messageId);
        const filme = this.catalogo.filmes.find(f => f.messageId === numMsg || f.versoes?.dublado?.messageId === numMsg || f.versoes?.legendado?.messageId === numMsg);
        if (filme) return { ...filme, tipo: 'filme' };

        for (const serie of this.catalogo.series) {
            for (const temp of (serie.temporadas || [])) {
                const ep = (temp.episodios || []).find(e => e.messageId === numMsg || e.versoes?.dublado?.messageId === numMsg || e.versoes?.legendado?.messageId === numMsg);
                if (ep) {
                    return { ...serie, temporada: temp.numero, episodio: ep, tipo: 'serie' };
                }
            }
        }
        return null;
    }

    buscarItem(termo) {
        if (!termo || termo.trim().length === 0) return [];
        const termoBruto = termo.toLowerCase().trim();
        const termoFonetico = this.normalizarTexto(termo);
        const palavrasTermo = termoFonetico.split(' ').filter(p => p.length > 1);

        const todosItens = [
            ...(this.catalogo.filmes || []).map(f => ({ ...f, tipo: 'filme' })),
            ...(this.catalogo.series || []).map(s => ({ ...s, tipo: 'serie' }))
        ];

        const pontuados = [];

        for (const item of todosItens) {
            const nomeBruto = (item.nome || '').toLowerCase();
            const nomeFonetico = this.normalizarTexto(item.nome || '');
            const nomeOriginalFonetico = this.normalizarTexto(item.nomeOriginal || '');
            const sinopseFonetica = this.normalizarTexto(item.sinopse || item.descricao || '');

            let score = 0;

            if (nomeBruto.includes(termoBruto)) {
                score += 100;
            } else if (nomeFonetico.includes(termoFonetico)) {
                score += 90;
            } else if (nomeOriginalFonetico.includes(termoFonetico)) {
                score += 80;
            }

            const simFonetica = this.calcularSimilaridade(termoFonetico, nomeFonetico);
            if (simFonetica >= 0.70) {
                score += Math.round(simFonetica * 70);
            }

            const palavrasItem = nomeFonetico.split(' ').filter(p => p.length > 1);
            let palavrasCorrespondidas = 0;

            for (const pTermo of palavrasTermo) {
                for (const pItem of palavrasItem) {
                    if (pTermo === pItem) {
                        score += 30;
                        palavrasCorrespondidas++;
                        break;
                    } else if (pItem.includes(pTermo) || pTermo.includes(pItem)) {
                        score += 20;
                        palavrasCorrespondidas++;
                        break;
                    }
                }
            }

            if (sinopseFonetica.includes(termoFonetico)) {
                score += 15;
            }

            if (score >= 20 || (palavrasTermo.length > 0 && palavrasCorrespondidas === palavrasTermo.length)) {
                pontuados.push({ item, score });
            }
        }

        pontuados.sort((a, b) => b.score - a.score);
        return pontuados.map(p => p.item);
    }

    normalizarTexto(texto) {
        if (!texto) return '';
        return texto.toLowerCase()
            .replace(/ç/g, 's')
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/c(?=[eiy])|xc|sc|ss|z/g, 's')
            .replace(/ch/g, 'x')
            .replace(/ph/g, 'f')
            .replace(/y/g, 'i')
            .replace(/w/g, 'u')
            .replace(/(.)\1+/g, '$1')
            .replace(/[^a-z0-9]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    calcularDistanciaLevenshtein(a, b) {
        const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
        for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
        for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
        for (let i = 1; i <= a.length; i++) {
            for (let j = 1; j <= b.length; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                matrix[i][j] = Math.min(
                    matrix[i - 1][j] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j - 1] + cost
                );
            }
        }
        return matrix[a.length][b.length];
    }

    calcularSimilaridade(s1, s2) {
        if (!s1 || !s2) return 0;
        const longer = s1.length > s2.length ? s1 : s2;
        const shorter = s1.length > s2.length ? s2 : s1;
        if (longer.length === 0) return 1.0;
        return (longer.length - this.calcularDistanciaLevenshtein(longer, shorter)) / longer.length;
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
        return this.catalogo.series.filter(s => s.isDublado);
    }

    getSeriesLegendadas() {
        return this.catalogo.series.filter(s => s.isLegendado);
    }

    getPublicCatalogo() {
        return {
            filmes: (this.catalogo.filmes || []).map(f => ({
                id: f.id,
                nome: f.nome,
                nomeOriginal: f.nomeOriginal,
                ano: f.ano,
                generos: f.generos,
                sinopse: f.sinopse,
                posterUrl: f.posterUrl,
                backdropUrl: f.backdropUrl,
                nota: f.nota,
                qualidade: f.qualidade,
                isDublado: f.isDublado,
                isLegendado: f.isLegendado,
                isCam: f.isCam,
                audioBadge: this.getAudioBadge(f)
            })),
            series: (this.catalogo.series || []).map(s => ({
                id: s.id,
                nome: s.nome,
                nomeOriginal: s.nomeOriginal,
                ano: s.ano,
                generos: s.generos,
                sinopse: s.sinopse,
                posterUrl: s.posterUrl,
                backdropUrl: s.backdropUrl,
                nota: s.nota,
                isDublado: s.isDublado,
                isLegendado: s.isLegendado,
                isDorama: s.isDorama,
                totalTemporadas: s.totalTemporadas,
                totalEpisodios: s.totalEpisodios,
                audioBadge: this.getAudioBadge(s)
            }))
        };
    }

    getGenerosDisponiveis() {
        const generoCounts = {};
        const todosItens = [...(this.catalogo.filmes || []), ...(this.catalogo.series || [])];

        todosItens.forEach(item => {
            if (item.generos && Array.isArray(item.generos)) {
                item.generos.forEach(g => {
                    const gFormatado = g.trim();
                    if (gFormatado && gFormatado.toLowerCase() !== 'geral') {
                        generoCounts[gFormatado] = (generoCounts[gFormatado] || 0) + 1;
                    }
                });
            }
        });

        return Object.entries(generoCounts)
            .map(([nome, count]) => ({ nome, count }))
            .sort((a, b) => b.count - a.count);
    }

    getItemsPorGenero(generoNome) {
        const gBusca = generoNome.toLowerCase().trim();
        const filmes = (this.catalogo.filmes || []).filter(f => 
            (f.generos || []).some(g => g.toLowerCase().trim() === gBusca)
        );
        const series = (this.catalogo.series || []).filter(s => 
            (s.generos || []).some(g => g.toLowerCase().trim() === gBusca)
        );
        return [...filmes, ...series];
    }
}

module.exports = CatalogoManager;