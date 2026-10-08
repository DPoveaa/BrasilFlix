const db = require('../database/db');
const TelegramUploader = require('../services/TelegramUploader');

/**
 * RemovalQueueManager
 * Gerencia a fila persistente no PostgreSQL de remoção e reprocessamento/rebaixamento
 * de mídias, séries, episódios e mensagens no canal de Armazenamento do Telegram.
 * 
 * Suporta alta carga (até centenas/milhares de episódios, ex: One Piece),
 * executa de forma assíncrona desacoplada de requisições HTTP,
 * e é 100% resiliente a reinícios de processo (PM2), quedas de energia ou quedas de conexão.
 */
class RemovalQueueManager {
    constructor(catalogoManager = null, queueManager = null) {
        this.catalogoManager = catalogoManager;
        this.queueManager = queueManager;
        this.isProcessing = false;
        this.workerTimer = null;
        this.checkIntervalMs = 30000; // Varredura periódica a cada 30 segundos
    }

    setCatalogoManager(cm) {
        this.catalogoManager = cm;
    }

    setQueueManager(qm) {
        this.queueManager = qm;
    }

    /**
     * Inicializa a fila: recupera tarefas que estavam no meio do processamento
     * quando o processo foi interrompido e inicia o worker.
     */
    async init() {
        try {
            // Recupera tarefas interrompidas (queda de luz ou restart PM2)
            const recovered = await db.query(`
                UPDATE remocoes_fila 
                SET status = 'pendente', updated_at = NOW() 
                WHERE status = 'processando'
                RETURNING id
            `);

            if (recovered.rows.length > 0) {
                console.log(`🔄 [RemovalQueue] ${recovered.rows.length} tarefa(s) de remoção recuperada(s) após reinício do sistema.`);
            }

            // Limpa tarefas concluídas com mais de 7 dias para manter a tabela enxuta
            try {
                await db.query(`DELETE FROM remocoes_fila WHERE status = 'concluido' AND updated_at < NOW() - INTERVAL '7 days'`);
            } catch (_) {}

            // Inicia worker periódico de segurança
            if (this.workerTimer) clearInterval(this.workerTimer);
            this.workerTimer = setInterval(() => {
                this.triggerWorker();
            }, this.checkIntervalMs);

            // Dispara worker inicial
            this.triggerWorker();
            console.log('✅ [RemovalQueue] Fila persistente de remoção e reprocessamento online!');
        } catch (e) {
            console.warn('⚠️ [RemovalQueue] Aviso ao inicializar RemovalQueueManager:', e.message);
        }
    }

    /**
     * Dispara o processamento da fila sem bloquear o chamador
     */
    triggerWorker() {
        if (this.isProcessing) return;
        this.processQueue().catch(err => {
            console.error('❌ [RemovalQueue] Erro inesperado no worker:', err.message);
        });
    }

    /**
     * Extrai com segurança todos os messageIds (vídeo e notificações) de um episódio
     * @param {Object} ep Registro do episódio vindo do banco
     * @param {string} versao 'dublado', 'legendado', ou null/todas
     */
    extractEpisodeMessageIds(ep, versao = null) {
        const ids = new Set();
        const vKey = String(versao || '').toLowerCase().trim();

        let versoes = ep.versoes || {};
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
        }

        const dub = versoes.dublado;
        const leg = versoes.legendado;

        if (vKey === 'dublado') {
            if (dub?.messageId) ids.add(Number(dub.messageId));
            if (dub?.notifMessageId) ids.add(Number(dub.notifMessageId));
            if (ep.is_dublado && ep.message_id && !dub?.messageId) ids.add(Number(ep.message_id));
            if (ep.is_dublado && ep.notif_message_id && !dub?.notifMessageId) ids.add(Number(ep.notif_message_id));
        } else if (vKey === 'legendado') {
            if (leg?.messageId) ids.add(Number(leg.messageId));
            if (leg?.notifMessageId) ids.add(Number(leg.notifMessageId));
            if (ep.is_legendado && ep.message_id && !leg?.messageId) ids.add(Number(ep.message_id));
            if (ep.is_legendado && ep.notif_message_id && !leg?.notifMessageId) ids.add(Number(ep.notif_message_id));
        } else {
            // Todas as versões
            if (dub?.messageId) ids.add(Number(dub.messageId));
            if (dub?.notifMessageId) ids.add(Number(dub.notifMessageId));
            if (leg?.messageId) ids.add(Number(leg.messageId));
            if (leg?.notifMessageId) ids.add(Number(leg.notifMessageId));
            if (ep.message_id) ids.add(Number(ep.message_id));
            if (ep.notif_message_id) ids.add(Number(ep.notif_message_id));
        }

        return Array.from(ids).filter(id => !isNaN(id) && id > 0);
    }

    /**
     * Extrai messageIds de um filme
     */
    extractFilmMessageIds(filme, versao = null) {
        const ids = new Set();
        const vKey = String(versao || '').toLowerCase().trim();

        let versoes = filme.versoes || {};
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
        }

        const dub = versoes.dublado;
        const leg = versoes.legendado;

        if (vKey === 'dublado') {
            if (dub?.messageId) ids.add(Number(dub.messageId));
            if (dub?.notifMessageId) ids.add(Number(dub.notifMessageId));
            if (filme.is_dublado && filme.message_id && !dub?.messageId) ids.add(Number(filme.message_id));
            if (filme.is_dublado && filme.notif_message_id && !dub?.notifMessageId) ids.add(Number(filme.notif_message_id));
        } else if (vKey === 'legendado') {
            if (leg?.messageId) ids.add(Number(leg.messageId));
            if (leg?.notifMessageId) ids.add(Number(leg.notifMessageId));
            if (filme.is_legendado && filme.message_id && !leg?.messageId) ids.add(Number(filme.message_id));
            if (filme.is_legendado && filme.notif_message_id && !leg?.notifMessageId) ids.add(Number(filme.notif_message_id));
        } else {
            if (dub?.messageId) ids.add(Number(dub.messageId));
            if (dub?.notifMessageId) ids.add(Number(dub.notifMessageId));
            if (leg?.messageId) ids.add(Number(leg.messageId));
            if (leg?.notifMessageId) ids.add(Number(leg.notifMessageId));
            if (filme.message_id) ids.add(Number(filme.message_id));
            if (filme.notif_message_id) ids.add(Number(filme.notif_message_id));
        }

        return Array.from(ids).filter(id => !isNaN(id) && id > 0);
    }

    /**
     * Remove ou rebaixa uma SÉRIE COMPLETA (ou uma versão específica de todos os seus episódios).
     * O catálogo no banco é atualizado imediatamente, os jobs de rebaixamento são enfileirados,
     * e a limpeza física das mensagens no Telegram entra na fila persistente em segundo plano.
     */
    async removerSerie({ serieId, versao = null, rebaixar = false }) {
        const vKey = String(versao || '').toLowerCase().trim();
        const isVersaoEspecifica = (vKey === 'dublado' || vKey === 'legendado');

        // 1. Identificar a série no PostgreSQL
        let serieRow = null;
        const sNumId = Number(serieId);

        if (!isNaN(sNumId) && sNumId > 0) {
            const sRes = await db.query(
                `SELECT id, nome, is_anime, tmdb_id, message_id, notif_message_id FROM series WHERE id = $1`,
                [sNumId]
            );
            if (sRes.rows.length > 0) serieRow = sRes.rows[0];
        }

        if (!serieRow && this.catalogoManager) {
            const memSerie = this.catalogoManager.buscarSeriePorId(serieId);
            if (memSerie?.id) {
                const sRes = await db.query(
                    `SELECT id, nome, is_anime, tmdb_id, message_id, notif_message_id FROM series WHERE id = $1`,
                    [Number(memSerie.id)]
                );
                if (sRes.rows.length > 0) serieRow = sRes.rows[0];
            }
        }

        if (!serieRow) {
            return { success: false, error: `Série não encontrada para o identificador "${serieId}".` };
        }

        const realSerieId = Number(serieRow.id);
        const serieNome = serieRow.nome;
        const isAnime = !!serieRow.is_anime;

        // 2. Buscar TODOS os episódios no PostgreSQL
        const epsRes = await db.query(
            `SELECT id, serie_id, temporada_numero, numero, message_id, notif_message_id, versoes, is_dublado, is_legendado, audio 
             FROM episodios WHERE serie_id = $1 ORDER BY temporada_numero ASC, numero ASC`,
            [realSerieId]
        );

        const episodios = epsRes.rows;
        console.log(`🧹 [RemovalQueue] Iniciando ${rebaixar ? 'rebaixamento' : 'remoção'} da série "${serieNome}" (${episodios.length} episódios encontrados no DB, versão: ${vKey || 'todas'})...`);

        let totalEnfileirados = 0;
        let totalMensagensAgendadas = 0;

        // 3. Processar cada episódio
        for (const ep of episodios) {
            let versoes = ep.versoes || {};
            if (typeof versoes === 'string') {
                try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
            }

            const epMessageIds = this.extractEpisodeMessageIds(ep, isVersaoEspecifica ? vKey : null);
            totalMensagensAgendadas += epMessageIds.length;

            const hasDubBefore = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId)) || ep.is_dublado;
            const hasLegBefore = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId)) || ep.is_legendado;

            if (isVersaoEspecifica) {
                // Remove apenas uma versão
                if (vKey === 'dublado') versoes.dublado = null;
                if (vKey === 'legendado') versoes.legendado = null;

                const hasDubRemaining = (vKey === 'dublado') ? false : hasDubBefore;
                const hasLegRemaining = (vKey === 'legendado') ? false : hasLegBefore;

                if (!hasDubRemaining && !hasLegRemaining) {
                    // Sem nenhuma versão restante: exclui o registro do episódio do banco
                    await db.query(`DELETE FROM episodios WHERE id = $1`, [ep.id]);
                } else {
                    // Mantém a versão remanescente no banco
                    const primaryMsg = (hasDubRemaining && versoes.dublado?.messageId) 
                        || (hasLegRemaining && versoes.legendado?.messageId) 
                        || ep.message_id;
                    const primaryAudio = (hasDubRemaining && hasLegRemaining)
                        ? 'Dub/Leg (Dublado + Legendado)'
                        : (hasDubRemaining ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)');

                    await db.query(`
                        UPDATE episodios SET
                            versoes = $1,
                            is_dublado = $2,
                            is_legendado = $3,
                            message_id = $4,
                            audio = $5
                        WHERE id = $6
                    `, [
                        JSON.stringify(versoes),
                        hasDubRemaining,
                        hasLegRemaining,
                        primaryMsg,
                        primaryAudio,
                        ep.id
                    ]);
                }
            } else {
                // Remove o episódio completamente do banco
                await db.query(`DELETE FROM episodios WHERE id = $1`, [ep.id]);
            }

            // Grava na tabela persistente de remoção do Telegram
            if (epMessageIds.length > 0) {
                await db.query(`
                    INSERT INTO remocoes_fila (
                        tipo, origem_id, serie_id, nome, temporada, episodio, versao, rebaixar, is_anime, message_ids, status, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendente', NOW(), NOW())
                `, [
                    'episodio',
                    ep.id,
                    realSerieId,
                    serieNome,
                    ep.temporada_numero,
                    ep.numero,
                    vKey || null,
                    rebaixar,
                    isAnime,
                    JSON.stringify(epMessageIds)
                ]);
            }

            // Se solicitado rebaixar, adiciona o job imediatamente na fila de download
            if (rebaixar && this.queueManager) {
                if (isVersaoEspecifica) {
                    this.queueManager.addJob(serieNome, 'serie', 1, {
                        season: ep.temporada_numero || 1,
                        episode: ep.numero || 1,
                        audioPreference: vKey,
                        isAnime: isAnime,
                        isUpgrade: true
                    });
                    totalEnfileirados++;
                } else {
                    const hasDub = ep.is_dublado || !!versoes.dublado?.messageId || !!versoes.dublado?.fileId;
                    const hasLeg = ep.is_legendado || !!versoes.legendado?.messageId || !!versoes.legendado?.fileId;
                    if (hasDub && hasLeg) {
                        this.queueManager.addJob(serieNome, 'serie', 1, {
                            season: ep.temporada_numero || 1,
                            episode: ep.numero || 1,
                            audioPreference: 'dublado',
                            isAnime: isAnime,
                            isUpgrade: true
                        });
                        this.queueManager.addJob(serieNome, 'serie', 1, {
                            season: ep.temporada_numero || 1,
                            episode: ep.numero || 1,
                            audioPreference: 'legendado',
                            isAnime: isAnime,
                            isUpgrade: true
                        });
                        totalEnfileirados += 2;
                    } else {
                        const targetAudio = hasLeg && !hasDub ? 'legendado' : 'dublado';
                        this.queueManager.addJob(serieNome, 'serie', 1, {
                            season: ep.temporada_numero || 1,
                            episode: ep.numero || 1,
                            audioPreference: targetAudio,
                            isAnime: isAnime,
                            isUpgrade: true
                        });
                        totalEnfileirados++;
                    }
                }
            }
        }

        // 4. Atualizar registro da série no PostgreSQL
        const countRes = await db.query(`SELECT COUNT(*) as total FROM episodios WHERE serie_id = $1`, [realSerieId]);
        const totalRestante = parseInt(countRes.rows[0]?.total || '0', 10);

        if (totalRestante === 0) {
            // Se não restou nenhum episódio, agenda exclusão das mensagens do card/notificação da série no Telegram
            const serieMsgIds = [];
            if (serieRow.message_id) serieMsgIds.push(Number(serieRow.message_id));
            if (serieRow.notif_message_id) serieMsgIds.push(Number(serieRow.notif_message_id));

            if (serieMsgIds.length > 0) {
                await db.query(`
                    INSERT INTO remocoes_fila (
                        tipo, origem_id, serie_id, nome, versao, rebaixar, is_anime, message_ids, status, created_at, updated_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), NOW())
                `, [
                    'serie',
                    realSerieId,
                    realSerieId,
                    serieNome,
                    null,
                    rebaixar,
                    isAnime,
                    JSON.stringify(serieMsgIds)
                ]);
            }
            await db.query(`DELETE FROM series WHERE id = $1`, [realSerieId]);
        } else {
            // Ainda existem episódios (ex: apagou legendado e sobrou dublado)
            await db.query(`
                UPDATE series SET
                    total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1),
                    total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1),
                    is_dublado = COALESCE((SELECT bool_or(is_dublado) FROM episodios WHERE serie_id = $1), false),
                    is_legendado = COALESCE((SELECT bool_or(is_legendado) FROM episodios WHERE serie_id = $1), false),
                    updated_at = NOW()
                WHERE id = $1
            `, [realSerieId]);
        }

        // 5. Recarrega o catálogo em memória uma única vez
        if (this.catalogoManager) {
            await this.catalogoManager.loadCatalogo();
        }

        // 6. Aciona o worker em segundo plano para limpar o Telegram
        this.triggerWorker();

        const msgRetorno = rebaixar
            ? `Versão ${isVersaoEspecifica ? vKey.toUpperCase() : 'COMPLETA'} de "${serieNome}" (${episodios.length} episódios) desmarcada do catálogo e colocada na fila de downloads com Prioridade 1! ${totalMensagensAgendadas} mensagens do Telegram estão sendo apagadas em segundo plano.`
            : `Série "${serieNome}" (${episodios.length} episódios) removida do catálogo com sucesso! ${totalMensagensAgendadas} mensagens do Telegram agendadas para exclusão em segundo plano.`;

        console.log(`✅ [RemovalQueue] ${msgRetorno}`);

        return {
            success: true,
            serieId: realSerieId,
            serieNome,
            totalEpisodios: episodios.length,
            totalReenfileirados: totalEnfileirados,
            totalMensagensAgendadas,
            rebaixar,
            versao: vKey || 'todas',
            message: msgRetorno
        };
    }

    /**
     * Remove ou rebaixa um EPISÓDIO INDIVIDUAL
     */
    async removerEpisodio({ episodioId, versao = null, rebaixar = false }) {
        const target = Number(episodioId) || 0;
        const vKey = String(versao || '').toLowerCase().trim();
        const isVersaoEspecifica = (vKey === 'dublado' || vKey === 'legendado');

        const epRes = await db.query(`
            SELECT e.*, s.nome as serie_nome, s.is_anime 
            FROM episodios e 
            LEFT JOIN series s ON s.id = e.serie_id 
            WHERE e.id = $1 OR e.message_id = $1 OR e.notif_message_id = $1
        `, [target]);

        if (!epRes.rows.length) {
            return { success: false, error: 'Episódio não encontrado no banco de dados.' };
        }

        const ep = epRes.rows[0];
        const serieId = ep.serie_id;
        const serieNome = ep.serie_nome || 'Série';
        const isAnime = !!ep.is_anime;
        const tempNum = ep.temporada_numero || 1;
        const epNum = ep.numero || 1;

        let versoes = ep.versoes || {};
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
        }

        const epMessageIds = this.extractEpisodeMessageIds(ep, isVersaoEspecifica ? vKey : null);

        const hasDubBefore = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId)) || ep.is_dublado;
        const hasLegBefore = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId)) || ep.is_legendado;

        if (isVersaoEspecifica) {
            if (vKey === 'dublado') versoes.dublado = null;
            if (vKey === 'legendado') versoes.legendado = null;

            const hasDubRemaining = (vKey === 'dublado') ? false : hasDubBefore;
            const hasLegRemaining = (vKey === 'legendado') ? false : hasLegBefore;

            if (!hasDubRemaining && !hasLegRemaining) {
                await db.query(`DELETE FROM episodios WHERE id = $1`, [ep.id]);
            } else {
                const primaryMsg = (hasDubRemaining && versoes.dublado?.messageId) 
                    || (hasLegRemaining && versoes.legendado?.messageId) 
                    || ep.message_id;
                const primaryAudio = (hasDubRemaining && hasLegRemaining)
                    ? 'Dub/Leg (Dublado + Legendado)'
                    : (hasDubRemaining ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)');

                await db.query(`
                    UPDATE episodios SET
                        versoes = $1,
                        is_dublado = $2,
                        is_legendado = $3,
                        message_id = $4,
                        audio = $5
                    WHERE id = $6
                `, [
                    JSON.stringify(versoes),
                    hasDubRemaining,
                    hasLegRemaining,
                    primaryMsg,
                    primaryAudio,
                    ep.id
                ]);
            }
        } else {
            await db.query(`DELETE FROM episodios WHERE id = $1`, [ep.id]);
        }

        // Atualiza contadores da série
        if (serieId) {
            const countRes = await db.query(`SELECT COUNT(*) as total FROM episodios WHERE serie_id = $1`, [serieId]);
            if (totalRestante === 0) {
                const sRow = await db.query(`SELECT message_id, notif_message_id FROM series WHERE id = $1`, [serieId]);
                const serieMsgIds = [];
                if (sRow.rows[0]?.message_id) serieMsgIds.push(Number(sRow.rows[0].message_id));
                if (sRow.rows[0]?.notif_message_id) serieMsgIds.push(Number(sRow.rows[0].notif_message_id));
                if (serieMsgIds.length > 0) {
                    await db.query(`
                        INSERT INTO remocoes_fila (
                            tipo, origem_id, serie_id, nome, versao, rebaixar, is_anime, message_ids, status, created_at, updated_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), NOW())
                    `, [
                        'serie',
                        serieId,
                        serieId,
                        serieNome,
                        null,
                        rebaixar,
                        isAnime,
                        JSON.stringify(serieMsgIds)
                    ]);
                }
                await db.query(`DELETE FROM series WHERE id = $1`, [serieId]);
            } else {
                await db.query(`
                    UPDATE series SET
                        total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1),
                        total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1),
                        is_dublado = COALESCE((SELECT bool_or(is_dublado) FROM episodios WHERE serie_id = $1), false),
                        is_legendado = COALESCE((SELECT bool_or(is_legendado) FROM episodios WHERE serie_id = $1), false),
                        updated_at = NOW()
                    WHERE id = $1
                `, [serieId]);
            }
        }

        // Agenda remoção no Telegram
        if (epMessageIds.length > 0) {
            await db.query(`
                INSERT INTO remocoes_fila (
                    tipo, origem_id, serie_id, nome, temporada, episodio, versao, rebaixar, is_anime, message_ids, status, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pendente', NOW(), NOW())
            `, [
                'episodio',
                ep.id,
                serieId,
                serieNome,
                tempNum,
                epNum,
                vKey || null,
                rebaixar,
                isAnime,
                JSON.stringify(epMessageIds)
            ]);
        }

        // Reenfileira para download se solicitado
        if (rebaixar && this.queueManager) {
            const targetAudio = isVersaoEspecifica ? vKey : (ep.is_dublado ? 'dublado' : 'legendado');
            this.queueManager.addJob(serieNome, 'serie', 1, {
                season: tempNum,
                episode: epNum,
                audioPreference: targetAudio,
                isAnime: isAnime,
                isUpgrade: true
            });
        }

        if (this.catalogoManager) {
            await this.catalogoManager.loadCatalogo();
        }

        this.triggerWorker();

        const msgRetorno = rebaixar
            ? `Episódio T${tempNum}E${epNum} (${isVersaoEspecifica ? vKey.toUpperCase() : 'padrão'}) de "${serieNome}" desmarcado e enviado para reprocessamento na fila com Prioridade 1!`
            : `Episódio T${tempNum}E${epNum} de "${serieNome}" removido do catálogo com sucesso!`;

        return {
            success: true,
            episodioId: ep.id,
            serieNome,
            temporada: tempNum,
            episodio: epNum,
            rebaixar,
            message: msgRetorno
        };
    }

    /**
     * Remove ou rebaixa um FILME
     */
    async removerFilme({ filmeId, versao = null, rebaixar = false }) {
        const target = Number(filmeId) || 0;
        const vKey = String(versao || '').toLowerCase().trim();
        const isVersaoEspecifica = (vKey === 'dublado' || vKey === 'legendado');

        const fRes = await db.query(`SELECT * FROM filmes WHERE id = $1`, [target]);
        if (!fRes.rows.length) {
            return { success: false, error: 'Filme não encontrado no banco de dados.' };
        }

        const filme = fRes.rows[0];
        const filmeNome = filme.nome;

        let versoes = filme.versoes || {};
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
        }

        const filmMessageIds = this.extractFilmMessageIds(filme, isVersaoEspecifica ? vKey : null);

        const hasDubBefore = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId)) || filme.is_dublado;
        const hasLegBefore = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId)) || filme.is_legendado;

        if (isVersaoEspecifica) {
            if (vKey === 'dublado') versoes.dublado = null;
            if (vKey === 'legendado') versoes.legendado = null;

            const hasDubRemaining = (vKey === 'dublado') ? false : hasDubBefore;
            const hasLegRemaining = (vKey === 'legendado') ? false : hasLegBefore;

            if (!hasDubRemaining && !hasLegRemaining) {
                await db.query(`DELETE FROM filmes WHERE id = $1`, [filme.id]);
            } else {
                const primaryMsg = (hasDubRemaining && versoes.dublado?.messageId) 
                    || (hasLegRemaining && versoes.legendado?.messageId) 
                    || filme.message_id;
                const primaryAudio = (hasDubRemaining && hasLegRemaining)
                    ? 'Dual (Dub+Leg)'
                    : (hasDubRemaining ? 'Dublado' : 'Legendado');

                await db.query(`
                    UPDATE filmes SET
                        versoes = $1,
                        is_dublado = $2,
                        is_legendado = $3,
                        message_id = $4,
                        audio = $5,
                        updated_at = NOW()
                    WHERE id = $6
                `, [
                    JSON.stringify(versoes),
                    hasDubRemaining,
                    hasLegRemaining,
                    primaryMsg,
                    primaryAudio,
                    filme.id
                ]);
            }
        } else {
            await db.query(`DELETE FROM filmes WHERE id = $1`, [filme.id]);
        }

        // Agenda remoção no Telegram
        if (filmMessageIds.length > 0) {
            await db.query(`
                INSERT INTO remocoes_fila (
                    tipo, origem_id, serie_id, nome, versao, rebaixar, is_anime, message_ids, status, created_at, updated_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendente', NOW(), NOW())
            `, [
                'filme',
                filme.id,
                null,
                filmeNome,
                vKey || null,
                rebaixar,
                false,
                JSON.stringify(filmMessageIds)
            ]);
        }

        // Reenfileira para download se solicitado
        if (rebaixar && this.queueManager) {
            const targetAudio = isVersaoEspecifica ? vKey : (filme.is_dublado ? 'dublado' : 'legendado');
            this.queueManager.addJob(filmeNome, 'filme', 1, {
                audioPreference: targetAudio,
                isUpgrade: true
            });
        }

        if (this.catalogoManager) {
            await this.catalogoManager.loadCatalogo();
        }

        this.triggerWorker();

        const msgRetorno = rebaixar
            ? `Filme "${filmeNome}" (${isVersaoEspecifica ? vKey.toUpperCase() : 'padrão'}) excluído do catálogo e colocado na fila com Prioridade 1!`
            : `Filme "${filmeNome}" removido do catálogo com sucesso!`;

        return {
            success: true,
            filmeId: filme.id,
            filmeNome,
            rebaixar,
            message: msgRetorno
        };
    }

    /**
     * Worker em segundo plano que processa itens da fila de remoção.
     * Suporta alta carga, batching MTProto e resiliência contra falhas.
     */
    async processQueue() {
        if (this.isProcessing) return;
        this.isProcessing = true;

        try {
            while (true) {
                // Busca até 25 tarefas pendentes por ciclo
                const pendentesRes = await db.query(`
                    SELECT * FROM remocoes_fila 
                    WHERE status = 'pendente' 
                    ORDER BY id ASC 
                    LIMIT 25
                `);

                if (pendentesRes.rows.length === 0) {
                    break;
                }

                for (const job of pendentesRes.rows) {
                    try {
                        // Marca como em processamento
                        await db.query(`UPDATE remocoes_fila SET status = 'processando', updated_at = NOW() WHERE id = $1`, [job.id]);

                        let rawIds = job.message_ids || [];
                        if (typeof rawIds === 'string') {
                            try { rawIds = JSON.parse(rawIds); } catch (_) { rawIds = []; }
                        }

                        const msgIds = (Array.isArray(rawIds) ? rawIds : [rawIds])
                            .map(id => Number(id))
                            .filter(id => !isNaN(id) && id > 0);

                        if (msgIds.length > 0) {
                            console.log(`🗑️ [RemovalQueue] [Job #${job.id}] Apagando ${msgIds.length} mensagem(ns) no Telegram para "${job.nome}" ${job.temporada ? `T${job.temporada}E${job.episodio}` : ''}...`);
                            await TelegramUploader.deleteStorageMessages(msgIds, { checkConfirmations: true });
                        }

                        // Concluído com sucesso
                        await db.query(`
                            UPDATE remocoes_fila 
                            SET status = 'concluido', updated_at = NOW() 
                            WHERE id = $1
                        `, [job.id]);

                    } catch (jobErr) {
                        console.error(`❌ [RemovalQueue] Erro ao processar Job #${job.id} ("${job.nome}"):`, jobErr.message);
                        const novasTentativas = (job.tentativas || 0) + 1;
                        const novoStatus = novasTentativas >= 3 ? 'falha' : 'pendente';
                        await db.query(`
                            UPDATE remocoes_fila 
                            SET status = $1, tentativas = $2, erro = $3, updated_at = NOW() 
                            WHERE id = $4
                        `, [novoStatus, novasTentativas, jobErr.message, job.id]);
                    }

                    // Pausa suave de 250ms entre itens para manter o MTProto estável
                    await new Promise(r => setTimeout(r, 250));
                }
            }
        } catch (e) {
            console.error('❌ [RemovalQueue] Erro crítico no loop da fila de remoções:', e.message);
        } finally {
            this.isProcessing = false;
        }
    }

    /**
     * Retorna estatísticas da fila de remoção para o painel admin
     */
    async getStats() {
        try {
            const res = await db.query(`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
                    COUNT(*) FILTER (WHERE status = 'processando') as processando,
                    COUNT(*) FILTER (WHERE status = 'concluido') as concluidos,
                    COUNT(*) FILTER (WHERE status = 'falha') as falhas
                FROM remocoes_fila
            `);
            return res.rows[0] || { total: 0, pendentes: 0, processando: 0, concluidos: 0, falhas: 0 };
        } catch (e) {
            return { total: 0, pendentes: 0, processando: 0, concluidos: 0, falhas: 0, error: e.message };
        }
    }
}

module.exports = RemovalQueueManager;
