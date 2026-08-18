const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const db = require('../database/db');
const telegramUploader = require('../services/TelegramUploader');

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
            // Limpa séries sem episódios e filmes sem arquivo no PostgreSQL para manter integridade
            try {
                await db.query(`DELETE FROM series WHERE id NOT IN (SELECT DISTINCT serie_id FROM episodios WHERE serie_id IS NOT NULL)`);
                await db.query(`DELETE FROM filmes WHERE (message_id IS NULL OR message_id = '') AND (file_id IS NULL OR file_id = '')`);
            } catch (e) {}

            // Carrega Filmes do PostgreSQL
            const filmesRes = await db.query(`SELECT * FROM filmes ORDER BY id ASC`);
            const seriesRes = await db.query(`SELECT * FROM series ORDER BY id ASC`);
            const epsRes = await db.query(`SELECT * FROM episodios ORDER BY serie_id ASC, temporada_numero ASC, numero ASC`);

            // Mapeia episódios por série e temporada
            const epsPorSerie = {};
            for (const ep of epsRes.rows) {
                if (!epsPorSerie[ep.serie_id]) epsPorSerie[ep.serie_id] = {};
                if (!epsPorSerie[ep.serie_id][ep.temporada_numero]) epsPorSerie[ep.serie_id][ep.temporada_numero] = [];

                let versoes = ep.versoes || {};
                if (typeof versoes === 'string') {
                    try { versoes = JSON.parse(versoes); } catch (e) { versoes = {}; }
                }
                if (!versoes.dublado && ep.is_dublado) {
                    versoes.dublado = { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' };
                }
                if (!versoes.legendado && ep.is_legendado) {
                    versoes.legendado = { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' };
                }

                const hasDub = ep.is_dublado || !!versoes.dublado;
                const hasLeg = ep.is_legendado || !!versoes.legendado;

                epsPorSerie[ep.serie_id][ep.temporada_numero].push({
                    numero: ep.numero,
                    nome: ep.nome || `Episódio ${ep.numero}`,
                    sinopse: ep.sinopse || '',
                    messageId: ep.message_id ? Number(ep.message_id) : null,
                    fileId: ep.file_id,
                    qualidade: ep.qualidade || '1080p',
                    audio: ep.audio || (hasDub && hasLeg ? 'Dual Áudio (Dublado + Legendado)' : (hasDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)')),
                    isDublado: hasDub,
                    isLegendado: hasLeg,
                    versoes: versoes,
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

                const totalEps = temporadas.reduce((acc, t) => acc + (t.episodios ? t.episodios.length : 0), 0);
                const hasDub = s.is_dublado || temporadas.some(t => (t.episodios || []).some(e => e.isDublado || !!e.versoes?.dublado));
                const hasLeg = s.is_legendado || temporadas.some(t => (t.episodios || []).some(e => e.isLegendado || !!e.versoes?.legendado));

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
                    isDublado: hasDub,
                    isLegendado: hasLeg,
                    isCam: s.is_cam,
                    totalTemporadas: temporadas.length,
                    totalEpisodios: totalEps,
                    tipo: 'serie',
                    temporadas: temporadas,
                    dataAdicionado: s.created_at,
                    tags: this.extrairTags(s.nome + ' ' + (s.sinopse || '') + ' ' + (s.generos || []).toString())
                };
            }).filter(s => s.totalEpisodios > 0);

            // Mapeia Filmes
            const filmes = filmesRes.rows.map(f => {
                let versoes = f.versoes || {};
                if (typeof versoes === 'string') {
                    try { versoes = JSON.parse(versoes); } catch (e) { versoes = {}; }
                }
                if (!versoes.dublado && f.is_dublado) {
                    versoes.dublado = { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam };
                }
                if (!versoes.legendado && f.is_legendado) {
                    versoes.legendado = { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam };
                }
                const hasDub = f.is_dublado || !!versoes.dublado;
                const hasLeg = f.is_legendado || !!versoes.legendado;

                return {
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
                    isDublado: hasDub,
                    isLegendado: hasLeg,
                    audio: f.audio || (hasDub && hasLeg ? 'Dual Áudio (Dublado + Legendado)' : (hasDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)')),
                    versoes: versoes,
                    messageId: f.message_id ? Number(f.message_id) : null,
                    fileId: f.file_id,
                    tipo: 'filme',
                    dataAdicionado: f.created_at,
                    tags: this.extrairTags(f.nome + ' ' + (f.sinopse || '') + ' ' + (f.generos || []).toString())
                };
            }).filter(f => !!f.messageId || !!f.fileId || !!f.versoes?.dublado || !!f.versoes?.legendado);

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

    // Recarrega o catálogo completo do PostgreSQL para a memória
    async reloadCatalogo() {
        await this.loadCatalogo();
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

        const versoes = {
            dublado: isDublado ? { messageId: messageId ? Number(messageId) : null, fileId: metadadosExtras.fileId || null, qualidade: metadadosExtras.qualidade || '1080p', isCam: metadadosExtras.isCam || false } : null,
            legendado: isLegendado ? { messageId: messageId ? Number(messageId) : null, fileId: metadadosExtras.fileId || null, qualidade: metadadosExtras.qualidade || '1080p', isCam: metadadosExtras.isCam || false } : null
        };

        // Persistência no PostgreSQL
        let dbId = metadadosExtras.id;
        try {
            const res = await db.query(`
                INSERT INTO filmes (
                    nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                    nota, tmdb_id, imdb_id, message_id, file_id, qualidade, audio,
                    is_dublado, is_legendado, is_cam, versoes, created_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, NOW(), NOW()
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
                isDublado, isLegendado, metadadosExtras.isCam || false,
                JSON.stringify(versoes)
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
            versoes: versoes,
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

        if (!filme.versoes) filme.versoes = {};

        if (isNovaDub) {
            filme.isDublado = true;
            filme.versoes.dublado = {
                messageId: novaMidia.messageId ? Number(novaMidia.messageId) : filme.versoes?.dublado?.messageId || filme.messageId,
                fileId: novaMidia.fileId || filme.versoes?.dublado?.fileId || filme.fileId,
                qualidade: novaMidia.qualidade || filme.qualidade,
                isCam: typeof novaMidia.isCam === 'boolean' ? novaMidia.isCam : filme.isCam
            };
            filme.messageId = novaMidia.messageId || filme.messageId;
            filme.fileId = novaMidia.fileId || filme.fileId;
            filme.qualidade = novaMidia.qualidade || filme.qualidade;
            if (typeof novaMidia.isCam === 'boolean') filme.isCam = novaMidia.isCam;
        }

        if (isNovaLeg) {
            filme.isLegendado = true;
            filme.versoes.legendado = {
                messageId: novaMidia.messageId ? Number(novaMidia.messageId) : filme.versoes?.legendado?.messageId || filme.messageId,
                fileId: novaMidia.fileId || filme.versoes?.legendado?.fileId || filme.fileId,
                qualidade: novaMidia.qualidade || filme.qualidade,
                isCam: typeof novaMidia.isCam === 'boolean' ? novaMidia.isCam : filme.isCam
            };
            if (!filme.isDublado) {
                filme.messageId = novaMidia.messageId || filme.messageId;
                filme.fileId = novaMidia.fileId || filme.fileId;
            }
        }

        const audioTexto = (filme.isDublado && filme.isLegendado)
            ? 'Dual Áudio (Dublado + Legendado)'
            : (filme.isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)');
        filme.audio = audioTexto;

        try {
            await db.query(`
                UPDATE filmes SET 
                    message_id = $1, file_id = $2, qualidade = $3, audio = $4,
                    is_dublado = $5, is_legendado = $6, is_cam = $7, versoes = $8, updated_at = NOW()
                WHERE id = $9
            `, [
                filme.messageId, filme.fileId, filme.qualidade, filme.audio,
                filme.isDublado, filme.isLegendado, filme.isCam, JSON.stringify(filme.versoes), filme.id
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

        const existingEp = temporada.episodios.find(e => e.numero === episodioNum);
        const finalIsDub = isDub || (existingEp ? existingEp.isDublado : false);
        const finalIsLeg = isLeg || (existingEp ? existingEp.isLegendado : false);

        const existingVersoes = existingEp?.versoes || {};
        const versoes = {
            dublado: isDub
                ? { messageId: messageId ? Number(messageId) : null, fileId: fileId || null, qualidade: metadados.qualidade || '1080p' }
                : (existingVersoes.dublado || null),
            legendado: isLeg
                ? { messageId: messageId ? Number(messageId) : null, fileId: fileId || null, qualidade: metadados.qualidade || '1080p' }
                : (existingVersoes.legendado || null)
        };

        const primaryMessageId = versoes.dublado?.messageId || versoes.legendado?.messageId || messageId;
        const primaryFileId = versoes.dublado?.fileId || versoes.legendado?.fileId || fileId;
        const primaryAudio = (finalIsDub && finalIsLeg)
            ? 'Dual Áudio (Dublado + Legendado)'
            : (finalIsDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)');

        // Persistência do Episódio no PostgreSQL
        try {
            await db.query(`
                INSERT INTO episodios (
                    serie_id, temporada_numero, numero, nome, sinopse,
                    message_id, file_id, qualidade, audio, is_dublado, is_legendado, versoes, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
                ) ON CONFLICT (serie_id, temporada_numero, numero) DO UPDATE SET
                    nome = COALESCE(EXCLUDED.nome, episodios.nome),
                    sinopse = COALESCE(EXCLUDED.sinopse, episodios.sinopse),
                    message_id = COALESCE(EXCLUDED.message_id, episodios.message_id),
                    file_id = COALESCE(EXCLUDED.file_id, episodios.file_id),
                    qualidade = EXCLUDED.qualidade,
                    audio = EXCLUDED.audio,
                    is_dublado = (episodios.is_dublado OR EXCLUDED.is_dublado),
                    is_legendado = (episodios.is_legendado OR EXCLUDED.is_legendado),
                    versoes = COALESCE(episodios.versoes, '{}'::jsonb) || EXCLUDED.versoes
            `, [
                serie.id, temporadaNum, episodioNum,
                metadados.episodioNome || `Episódio ${episodioNum}`,
                metadados.episodioSinopse || '',
                primaryMessageId || null, primaryFileId || null,
                metadados.qualidade || '1080p',
                primaryAudio,
                finalIsDub, finalIsLeg,
                JSON.stringify(versoes)
            ]);

            await db.query(`
                UPDATE series SET 
                    total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1),
                    total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1),
                    is_dublado = (SELECT bool_or(is_dublado) FROM episodios WHERE serie_id = $1),
                    is_legendado = (SELECT bool_or(is_legendado) FROM episodios WHERE serie_id = $1),
                    updated_at = NOW()
                WHERE id = $1
            `, [serie.id]);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir episódio no PostgreSQL:', e.message);
        }

        const epData = {
            numero: episodioNum,
            nome: metadados.episodioNome || existingEp?.nome || `Episódio ${episodioNum}`,
            sinopse: metadados.episodioSinopse || existingEp?.sinopse || '',
            messageId: primaryMessageId,
            fileId: primaryFileId,
            qualidade: metadados.qualidade || existingEp?.qualidade || '1080p',
            audio: primaryAudio,
            isDublado: finalIsDub,
            isLegendado: finalIsLeg,
            versoes: versoes,
            dataAdicionado: existingEp?.dataAdicionado || new Date().toISOString()
        };

        const epIndex = temporada.episodios.findIndex(e => e.numero === episodioNum);
        if (epIndex >= 0) {
            temporada.episodios[epIndex] = epData;
        } else {
            temporada.episodios.push(epData);
            temporada.episodios.sort((a, b) => a.numero - b.numero);
        }

        this.saveCatalogo();
        console.log(`✅ Episódio catalogado: ${serieNome} T${temporadaNum}E${episodioNum} [Dub: ${finalIsDub}, Leg: ${finalIsLeg}] (Msg: ${primaryMessageId})`);
        return { success: true, serie, temporada, episodio: epData };
    }

    async deleteStorageMessages(messageIds) {
        if (!messageIds || messageIds.length === 0) return;
        try {
            await TelegramUploader.deleteStorageMessages(messageIds);
        } catch (e) {
            console.warn('⚠️ Aviso ao deletar mensagens do Armazém:', e.message);
        }
    }

    async removerItem(id) {
        const numId = Number(id);
        const messagesToDelete = [];

        // 1. Localiza no catálogo em memória para coletar message_ids
        const filme = (this.catalogo.filmes || []).find(f => f.id === numId || String(f.id) === String(id));
        if (filme) {
            if (filme.messageId) messagesToDelete.push(filme.messageId);
            if (filme.versoes?.dublado?.messageId) messagesToDelete.push(filme.versoes.dublado.messageId);
            if (filme.versoes?.legendado?.messageId) messagesToDelete.push(filme.versoes.legendado.messageId);
        }

        const serie = (this.catalogo.series || []).find(s => s.id === numId || String(s.id) === String(id));
        if (serie) {
            if (serie.messageId) messagesToDelete.push(serie.messageId);
            for (const temp of (serie.temporadas || [])) {
                for (const ep of (temp.episodios || [])) {
                    if (ep.messageId) messagesToDelete.push(ep.messageId);
                    if (ep.versoes?.dublado?.messageId) messagesToDelete.push(ep.versoes.dublado.messageId);
                    if (ep.versoes?.legendado?.messageId) messagesToDelete.push(ep.versoes.legendado.messageId);
                }
            }
        }

        // 2. Busca também no PostgreSQL para garantir que nenhum message_id fique para trás
        try {
            const fRes = await db.query(`SELECT message_id FROM filmes WHERE id = $1`, [numId]);
            for (const r of fRes.rows) {
                if (r.message_id) messagesToDelete.push(r.message_id);
            }
            const epRes = await db.query(`SELECT message_id FROM episodios WHERE serie_id = $1`, [numId]);
            for (const r of epRes.rows) {
                if (r.message_id) messagesToDelete.push(r.message_id);
            }

            await db.query(`DELETE FROM episodios WHERE serie_id = $1`, [numId]);
            await db.query(`DELETE FROM filmes WHERE id = $1`, [numId]);
            await db.query(`DELETE FROM series WHERE id = $1`, [numId]);
        } catch (e) {
            console.warn('⚠️ Erro ao remover do PostgreSQL:', e.message);
        }

        // 3. Remove do array em memória
        let index = this.catalogo.filmes.findIndex(f => f.id === numId || String(f.id) === String(id));
        if (index !== -1) {
            this.catalogo.filmes.splice(index, 1);
        }

        index = this.catalogo.series.findIndex(s => s.id === numId || String(s.id) === String(id));
        if (index !== -1) {
            this.catalogo.series.splice(index, 1);
        }

        this.saveCatalogo();

        // 4. Apaga fisicamente do grupo de Armazenamento do Telegram
        if (messagesToDelete.length > 0) {
            const uniqueMsgIds = [...new Set(messagesToDelete)];
            await this.deleteStorageMessages(uniqueMsgIds);
        }

        return true;
    }

    async removerEpisodio(idOrMessageId) {
        const messagesToDelete = [];
        const target = Number(idOrMessageId) || 0;
        let serieId = null;

        try {
            const epRes = await db.query(`SELECT id, serie_id, message_id FROM episodios WHERE id = $1 OR message_id = $1`, [target]);
            for (const r of epRes.rows) {
                if (r.serie_id) serieId = r.serie_id;
                if (r.message_id) messagesToDelete.push(r.message_id);
            }
            await db.query(`DELETE FROM episodios WHERE id = $1 OR message_id = $1`, [target]);

            if (serieId) {
                const countRes = await db.query(`SELECT COUNT(*) as total FROM episodios WHERE serie_id = $1`, [serieId]);
                const totalRestante = parseInt(countRes.rows[0]?.total || '0', 10);
                if (totalRestante === 0) {
                    console.log(`🧹 Série ID ${serieId} ficou sem episódios. Removendo série do catálogo PostgreSQL automaticamente.`);
                    await db.query(`DELETE FROM series WHERE id = $1`, [serieId]);
                }
            }
        } catch (e) {
            console.warn('⚠️ Erro ao remover episódio do PostgreSQL:', e.message);
        }

        await this.loadCatalogo();

        if (messagesToDelete.length > 0) {
            const uniqueMsgIds = [...new Set(messagesToDelete)];
            await this.deleteStorageMessages(uniqueMsgIds);
        }

        return true;
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

    buscarEpisodio(serieId, seasonNum, epNum) {
        const serie = this.buscarSeriePorId(serieId);
        if (!serie) return null;
        const temp = (serie.temporadas || []).find(t => t.numero === Number(seasonNum));
        if (!temp) return null;
        return (temp.episodios || []).find(e => e.numero === Number(epNum)) || null;
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

    buscarItemExato(termo, tipo = null, tmdbId = null, imdbId = null) {
        if (!termo && !tmdbId && !imdbId) return null;
        const normTermo = termo ? this.normalizarTexto(termo) : '';

        const lista = tipo === 'serie' 
            ? (this.catalogo.series || [])
            : (tipo === 'filme' ? (this.catalogo.filmes || []) : [...(this.catalogo.filmes || []), ...(this.catalogo.series || [])]);

        return lista.find(item => {
            if (tmdbId && item.tmdbId && (item.tmdbId == tmdbId || item.tmdbId === parseInt(tmdbId, 10))) return true;
            if (imdbId && item.imdbId && item.imdbId === imdbId) return true;
            if (normTermo) {
                const normNome = this.normalizarTexto(item.nome || '');
                const normOrig = this.normalizarTexto(item.nomeOriginal || '');
                if (normNome === normTermo || normOrig === normTermo) return true;
            }
            return false;
        }) || null;
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
                audioBadge: this.getAudioBadge(s),
                temporadas: (s.temporadas || []).map(t => ({
                    numero: t.numero,
                    nome: t.nome,
                    totalEpisodios: (t.episodios || []).length,
                    episodios: (t.episodios || []).map(ep => {
                        const hasDub = ep.isDublado || !!ep.versoes?.dublado;
                        const hasLeg = ep.isLegendado || !!ep.versoes?.legendado;
                        return {
                            numero: ep.numero,
                            nome: ep.nome || `Episódio ${ep.numero}`,
                            sinopse: ep.sinopse || '',
                            qualidade: ep.qualidade || '1080p Full HD',
                            isDublado: hasDub,
                            isLegendado: hasLeg,
                            audio: ep.audio || (hasDub && hasLeg ? 'Dual Áudio (Dublado + Legendado)' : (hasDub ? 'Dublado' : 'Legendado')),
                            audioBadge: hasDub && hasLeg ? 'D/L' : (hasDub ? 'D' : (hasLeg ? 'L' : ''))
                        };
                    }).sort((a, b) => a.numero - b.numero)
                })).sort((a, b) => a.numero - b.numero)
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