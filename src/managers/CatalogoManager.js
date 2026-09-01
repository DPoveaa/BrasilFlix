const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const db = require('../database/db');
const TelegramUploader = require('../services/TelegramUploader');
const TMDBService = require('../services/TMDBService');

class MediaVerificationCache {
    constructor() {
        this.cache = new Map(); // messageId -> { status, docId, docSize, isVideo, duration, fileName, timestamp }
        this.defaultTtl = 60 * 60 * 1000; // 1 hora de TTL
    }

    get(messageId) {
        const id = Number(messageId);
        if (isNaN(id) || id <= 0) return null;
        const entry = this.cache.get(id);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.defaultTtl) {
            return null; // Expirado
        }
        return entry;
    }

    set(messageId, status, details = {}) {
        const id = Number(messageId);
        if (isNaN(id) || id <= 0) return;
        this.cache.set(id, {
            status, // 'VERIFIED_PLAYABLE' | 'MISSING' | 'INVALID_MEDIA' | 'FILE_ID_MISMATCH' | 'UNVERIFIED'
            ...details,
            timestamp: Date.now()
        });
    }

    invalidate(messageId) {
        const id = Number(messageId);
        if (!isNaN(id)) {
            this.cache.delete(id);
        }
    }

    clear() {
        this.cache.clear();
    }
}

class CatalogoManager {
    static mediaVerificationCache = new MediaVerificationCache();
    static allowUnverifiedPlayback = false;

    constructor() {
        this.catalogo = {
            filmes: [],
            series: []
        };
        this.backupDir = config.BACKUP_DIR || './data/backups';
        this.ensureDataDirectory();
    }

    setBot(bot) {
        this.bot = bot;
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
        fs.ensureDirSync(this.backupDir);
    }

    saveCatalogoBackup() {
        try {
            if (this.catalogo && (this.catalogo.filmes || this.catalogo.series)) {
                const catalogoPath = config.CATALOGO_FILE || path.resolve(__dirname, '../../data/catalogo.json');
                fs.ensureDirSync(path.dirname(catalogoPath));
                fs.writeJsonSync(catalogoPath, this.catalogo, { spaces: 2 });
            }
        } catch (e) {
            console.warn('⚠️ Aviso ao salvar backup local do catálogo:', e.message);
        }
    }

    buscarItemExato(nome, tipo = null) {
        if (!nome || typeof nome !== 'string') return null;
        const norm = (s) => (s || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
        const target = norm(nome);

        if (!tipo || tipo === 'filme') {
            const filme = (this.catalogo?.filmes || []).find(f => norm(f.nome) === target || norm(f.nomeOriginal) === target);
            if (filme) return filme;
        }

        if (!tipo || tipo === 'serie') {
            const serie = (this.catalogo?.series || []).find(s => norm(s.nome) === target || norm(s.nomeOriginal) === target);
            if (serie) return serie;
        }

        return null;
    }

    buscarSeriePorTmdb(tmdbId) {
        if (!tmdbId) return null;
        const targetId = Number(tmdbId);
        return (this.catalogo?.series || []).find(s => Number(s.tmdbId) === targetId || Number(s.tmdb_id) === targetId) || null;
    }

    buscarFilmePorTmdb(tmdbId) {
        if (!tmdbId) return null;
        const targetId = Number(tmdbId);
        return (this.catalogo?.filmes || []).find(f => Number(f.tmdbId) === targetId || Number(f.tmdb_id) === targetId) || null;
    }

    /**
     * Retorna o estado de verificação atual de um messageId:
     * - 'VERIFIED_PLAYABLE': Mídia confirmada e reproduzível no Telegram
     * - 'MISSING': Mensagem confirmadamente deletada ou vazia
     * - 'INVALID_MEDIA': Mídia com 0 bytes ou formato não-vídeo
     * - 'FILE_ID_MISMATCH': storedFileId difere do documentId real do Telegram
     * - 'UNVERIFIED': Mídia ainda não verificada ou com erro temporário de rede
     */
    static getMediaVerificationState(messageId, storedFileId = null) {
        const id = Number(messageId);
        if (isNaN(id) || id <= 0) return 'MISSING';
        const cached = CatalogoManager.mediaVerificationCache.get(id);
        if (!cached) return 'UNVERIFIED';

        if (cached.status === 'VERIFIED_PLAYABLE') {
            if (storedFileId && typeof storedFileId === 'string' && storedFileId.trim().length > 0) {
                if (cached.docId && cached.docId !== storedFileId.trim()) {
                    return 'FILE_ID_MISMATCH';
                }
            }
            return 'VERIFIED_PLAYABLE';
        }
        return cached.status;
    }

    /**
     * Valida se um par (messageId, fileId) possui ao menos um identificador real e utilizável:
     * - messageId deve ser um número positivo válido (> 0)
     * - fileId deve ser uma string não-vazia após trim()
     * Valores como null, undefined, 0, "", strings vazias ou apenas espaços retornam false.
     */
    static isValidMediaIdentifier(messageId, fileId) {
        if (messageId !== null && messageId !== undefined && messageId !== '') {
            const num = Number(messageId);
            if (!isNaN(num) && num > 0) return true;
        }
        if (fileId !== null && fileId !== undefined) {
            if (typeof fileId === 'string' && fileId.trim().length > 0) return true;
        }
        return false;
    }

    /**
     * Verifica se a referência de mídia possui identificador verificado e reproduzível.
     * Mídias com status MISSING, INVALID_MEDIA, FILE_ID_MISMATCH ou UNVERIFIED (sem messageId verificado)
     * NÃO são expostas como reproduzíveis no catálogo público.
     */
    static hasPlayableMedia(mediaObj) {
        if (!mediaObj) return false;
        const msgId = mediaObj.messageId ?? mediaObj.message_id;
        if (msgId === null || msgId === undefined || msgId === '') {
            return false;
        }
        const num = Number(msgId);
        if (isNaN(num) || num <= 0) return false;

        const state = CatalogoManager.getMediaVerificationState(num, mediaObj.fileId || mediaObj.file_id);
        if (state === 'VERIFIED_PLAYABLE') {
            return true;
        }
        if (state === 'MISSING' || state === 'INVALID_MEDIA' || state === 'FILE_ID_MISMATCH') {
            return false;
        }

        // Se o cache estiver desabilitado/unverified permitido (apenas em cenários explícitos)
        if (CatalogoManager.allowUnverifiedPlayback) {
            return true;
        }

        return false;
    }

    static _periodicRevalidationTimer = null;
    static _isPeriodicRevalidating = false;

    /**
     * Inicia o verificador periódico em lote de integridade do Telegram.
     * Revalida as mídias em cache respeitando o TTL sem sobreposições ou requisições desnecessárias.
     */
    startPeriodicRevalidation(intervalMs = 10 * 60 * 1000) {
        if (CatalogoManager._periodicRevalidationTimer) {
            return; // Singleton: já ativo
        }

        CatalogoManager._periodicRevalidationTimer = setInterval(() => {
            this.revalidateCachedMedia().catch(err => {
                console.warn('⚠️ [Periodic Revalidation] Erro na revalidação periódica:', err.message);
            });
        }, intervalMs);

        if (CatalogoManager._periodicRevalidationTimer.unref) {
            CatalogoManager._periodicRevalidationTimer.unref();
        }
        console.log(`⏱️ [CatalogoManager] Verificador periódico de integridade do Telegram ativado (intervalo: ${Math.round(intervalMs / 60000)}m).`);
    }

    /**
     * Para o verificador periódico de integridade.
     */
    stopPeriodicRevalidation() {
        if (CatalogoManager._periodicRevalidationTimer) {
            clearInterval(CatalogoManager._periodicRevalidationTimer);
            CatalogoManager._periodicRevalidationTimer = null;
        }
    }

    /**
     * Revalida o lote de mídias em cache diretamente contra o Armazém do Telegram.
     */
    async revalidateCachedMedia() {
        if (CatalogoManager._isPeriodicRevalidating) {
            return; // Evita execuções sobrepostas
        }
        CatalogoManager._isPeriodicRevalidating = true;

        try {
            const idsToCheck = new Set();
            for (const [mid, entry] of CatalogoManager.mediaVerificationCache.cache.entries()) {
                if (entry && entry.status === 'VERIFIED_PLAYABLE') {
                    idsToCheck.add(Number(mid));
                }
            }

            if (this.catalogo) {
                for (const f of (this.catalogo.filmes || [])) {
                    if (f.versoes?.dublado?.messageId) idsToCheck.add(Number(f.versoes.dublado.messageId));
                    if (f.versoes?.legendado?.messageId) idsToCheck.add(Number(f.versoes.legendado.messageId));
                    if (f.messageId) idsToCheck.add(Number(f.messageId));
                }
                for (const s of (this.catalogo.series || [])) {
                    for (const t of (s.temporadas || [])) {
                        for (const ep of (t.episodios || [])) {
                            if (ep.versoes?.dublado?.messageId) idsToCheck.add(Number(ep.versoes.dublado.messageId));
                            if (ep.versoes?.legendado?.messageId) idsToCheck.add(Number(ep.versoes.legendado.messageId));
                            if (ep.messageId) idsToCheck.add(Number(ep.messageId));
                        }
                    }
                }
            }

            const uniqueIds = Array.from(idsToCheck).filter(id => !isNaN(id) && id > 0);
            if (uniqueIds.length === 0) {
                return;
            }

            const uploader = TelegramUploader.getInstance();
            const results = await uploader.getStorageMessages(uniqueIds);
            let hasDefinitiveInvalidation = false;

            for (const [mid, info] of results.entries()) {
                if (info.status === 'FOUND') {
                    CatalogoManager.mediaVerificationCache.set(mid, 'VERIFIED_PLAYABLE', {
                        docId: info.docId,
                        docSize: info.docSize,
                        isVideo: info.isVideo,
                        duration: info.duration,
                        fileName: info.fileName
                    });
                } else if (info.status === 'NOT_FOUND') {
                    const prev = CatalogoManager.mediaVerificationCache.get(mid);
                    CatalogoManager.mediaVerificationCache.set(mid, 'MISSING', { error: 'MessageEmpty' });
                    if (prev && prev.status === 'VERIFIED_PLAYABLE') {
                        console.warn(`🩺 [Periodic Revalidation] Mídia messageId ${mid} foi confirmada como DELETADA no Telegram.`);
                        hasDefinitiveInvalidation = true;
                    }
                } else if (info.status === 'INVALID_MEDIA') {
                    const prev = CatalogoManager.mediaVerificationCache.get(mid);
                    CatalogoManager.mediaVerificationCache.set(mid, 'INVALID_MEDIA', { error: info.error });
                    if (prev && prev.status === 'VERIFIED_PLAYABLE') {
                        console.warn(`🩺 [Periodic Revalidation] Mídia messageId ${mid} foi confirmada como CORROMPIDA/INVÁLIDA.`);
                        hasDefinitiveInvalidation = true;
                    }
                } else if (info.status === 'ERROR') {
                    // Erro temporário de rede: PRESERVA o estado previamente verificado
                }
            }

            // Se houve invalidação definitiva de mídia, reconstrói o catálogo público
            if (hasDefinitiveInvalidation) {
                console.log('🔄 [Periodic Revalidation] Reconstruindo catálogo público após invalidação definitiva de mídia...');
                await this.loadCatalogo();
            }
        } finally {
            CatalogoManager._isPeriodicRevalidating = false;
        }
    }

    /**
     * Verifica se o episódio possui arquivo de mídia real e reproduzível para a versão Dublada.
     * Regra estrita: se versoes.dublado existe explicitamente, APENAS ele determina a disponibilidade
     * e NUNCA faz fallback para o messageId de outra versão.
     */
    static hasValidDubbedMedia(ep) {
        if (!ep) return false;
        if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'dublado')) {
            return CatalogoManager.hasPlayableMedia(ep.versoes.dublado);
        }
        const isDub = !!(ep.isDublado || ep.is_dublado);
        if (isDub) {
            return CatalogoManager.hasPlayableMedia({ messageId: ep.messageId || ep.message_id, fileId: ep.fileId || ep.file_id });
        }
        return false;
    }

    /**
     * Verifica se o episódio possui arquivo de mídia real e reproduzível para a versão Legendada.
     * Regra estrita: se versoes.legendado existe explicitamente, APENAS ele determina a disponibilidade
     * e NUNCA faz fallback para o messageId de outra versão.
     */
    static hasValidSubtitledMedia(ep) {
        if (!ep) return false;
        if (ep.versoes && Object.prototype.hasOwnProperty.call(ep.versoes, 'legendado')) {
            return CatalogoManager.hasPlayableMedia(ep.versoes.legendado);
        }
        const isLeg = !!(ep.isLegendado || ep.is_legendado);
        if (isLeg) {
            return CatalogoManager.hasPlayableMedia({ messageId: ep.messageId || ep.message_id, fileId: ep.fileId || ep.file_id });
        }
        return false;
    }

    /**
     * Normaliza e valida os episódios de uma temporada de acordo com a regra estrita de continuidade
     * sequencial, ponto de entrada obrigatório no Episódio 1 e disponibilidade REAL de mídia (messageId/fileId).
     * @param {Array} rawEps Lista de episódios da temporada
     * @param {number|string} tNum Número da temporada
     * @returns {Object|null} Temporada validada ou null se oculta/sem Ep 1/sem mídia real
     */
    static normalizeSeasonEpisodes(rawEps, tNum, tMeta = null, isEmLancamento = false) {
        if (!Array.isArray(rawEps) || rawEps.length === 0) return null;
        const sortedEps = [...rawEps].sort((a, b) => Number(a.numero) - Number(b.numero));

        // 1. Sequência contínua a partir do Episódio 1 com mídia real utilizável (Dublado ou Legendado)
        let maxDubSeq = 0;
        for (let n = 1; ; n++) {
            const epN = sortedEps.find(e => Number(e.numero) === n);
            if (epN && CatalogoManager.hasValidDubbedMedia(epN)) {
                maxDubSeq = n;
            } else {
                break;
            }
        }

        let maxLegSeq = 0;
        for (let n = 1; ; n++) {
            const epN = sortedEps.find(e => Number(e.numero) === n);
            if (epN && CatalogoManager.hasValidSubtitledMedia(epN)) {
                maxLegSeq = n;
            } else {
                break;
            }
        }

        let maxAnySeq = 0;
        for (let n = 1; ; n++) {
            const epN = sortedEps.find(e => Number(e.numero) === n);
            if (epN && (CatalogoManager.hasValidDubbedMedia(epN) || CatalogoManager.hasValidSubtitledMedia(epN))) {
                maxAnySeq = n;
            } else {
                break;
            }
        }

        // Ponto de Entrada Obrigatório: Episódio 1 DEVE ter mídia real
        if (maxAnySeq === 0) return null;

        const expectedEps = tMeta ? (tMeta.totalEps || tMeta.totalEpisodios || tMeta.episodiosContagem || 0) : 0;
        const isCompleto = expectedEps > 0 ? (maxAnySeq >= expectedEps) : (maxAnySeq > 0);

        // 2. Filtra apenas episódios pertencentes à sequência contínua utilizável
        const episodiosValidos = sortedEps.map(ep => {
            const epNum = Number(ep.numero);
            if (epNum > maxAnySeq) return null;
            if (expectedEps > 0 && epNum > expectedEps) return null; // Clampa ao total real de episódios da temporada no TMDB

            const hasDub = CatalogoManager.hasValidDubbedMedia(ep);
            const hasLeg = CatalogoManager.hasValidSubtitledMedia(ep);

            if (!hasDub && !hasLeg) return null; // Episódio sem mídia real

            const versoesFiltradas = {};
            if (hasDub) {
                const dubObj = ep.versoes?.dublado;
                const msgId = dubObj?.messageId || (dubObj?.fileId ? null : (ep.messageId || ep.message_id || null));
                const fId = dubObj?.fileId || (dubObj?.messageId ? null : (ep.fileId || ep.file_id || null));
                versoesFiltradas.dublado = { 
                    messageId: msgId ? Number(msgId) : null, 
                    fileId: fId || null, 
                    qualidade: dubObj?.qualidade || ep.qualidade || '1080p' 
                };
            }
            if (hasLeg) {
                const legObj = ep.versoes?.legendado;
                const msgId = legObj?.messageId || (legObj?.fileId ? null : (ep.messageId || ep.message_id || null));
                const fId = legObj?.fileId || (legObj?.messageId ? null : (ep.fileId || ep.file_id || null));
                versoesFiltradas.legendado = { 
                    messageId: msgId ? Number(msgId) : null, 
                    fileId: fId || null, 
                    qualidade: legObj?.qualidade || ep.qualidade || '1080p' 
                };
            }

            const primaryMsgId = versoesFiltradas.dublado?.messageId || versoesFiltradas.legendado?.messageId || (ep.message_id ? Number(ep.message_id) : (ep.messageId ? Number(ep.messageId) : null));
            const primaryFileId = versoesFiltradas.dublado?.fileId || versoesFiltradas.legendado?.fileId || ep.file_id || ep.fileId || null;

            return {
                numero: epNum,
                nome: ep.nome || `Episódio ${epNum}`,
                sinopse: ep.sinopse || '',
                stillUrl: ep.stillUrl || ep.still_url || null,
                duracao: ep.duracao || null,
                messageId: primaryMsgId,
                fileId: primaryFileId,
                qualidade: ep.qualidade || '1080p',
                isDublado: !!hasDub,
                isLegendado: !!hasLeg,
                versoes: versoesFiltradas,
                audio: (hasDub && hasLeg ? 'Dub/Leg (Dublado + Legendado)' : (hasDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)')),
                audioBadge: (hasDub && hasLeg ? 'D/L' : (hasDub ? 'D' : (hasLeg ? 'L' : ''))),
                dataAdicionado: ep.created_at || ep.dataAdicionado || new Date().toISOString()
            };
        }).filter(Boolean);

        if (episodiosValidos.length === 0) return null;

        const num = parseInt(tNum, 10);
        return {
            numero: num,
            nome: `Temporada ${num}`,
            totalEpisodios: episodiosValidos.length,
            isDublado: maxDubSeq > 0 || episodiosValidos.some(e => e.isDublado),
            isLegendado: maxLegSeq > 0 || episodiosValidos.some(e => e.isLegendado),
            isDubladoCompleto: expectedEps > 0 ? (maxDubSeq >= expectedEps) : (maxDubSeq > 0),
            isLegendadoCompleto: expectedEps > 0 ? (maxLegSeq >= expectedEps) : (maxLegSeq > 0),
            isCompleto: isCompleto,
            episodios: episodiosValidos
        };
    }

    /**
     * Processa e consolida uma série garantindo que apenas temporadas com Ponto de Entrada (Ep 1)
     * e sequências contínuas sejam computadas.
     */
    static processSerie(s, temporadasObj) {
        let temporadasMeta = s.temporadas_meta || s.temporadasMeta || {};
        if (typeof temporadasMeta === 'string') {
            try { temporadasMeta = JSON.parse(temporadasMeta); } catch (e) { temporadasMeta = {}; }
        }
        const isEmLancamento = !!(s.em_lancamento || s.emLancamento);

        // 1. Coleta os números de temporada disponíveis e ordena de forma estritamente crescente
        const rawSeasonNumbers = Object.keys(temporadasObj || {})
            .map(n => parseInt(n, 10))
            .filter(n => !isNaN(n) && n > 0)
            .sort((a, b) => a - b);

        const temporadas = [];
        for (let i = 0; i < rawSeasonNumbers.length; i++) {
            const seasonNum = rawSeasonNumbers[i];
            const expectedConsecutiveSeason = i + 1;

            // Regra Estrita de Continuidade: Temporadas devem começar na 1 e ser estritamente contínuas (1, 2, 3...)
            // Se houver salto (ex: tem Temporada 1 e Temporada 3, mas falta Temporada 2), a Temporada 3 NÃO é exibida.
            if (seasonNum !== expectedConsecutiveSeason) {
                break;
            }

            const tMeta = temporadasMeta[seasonNum] || temporadasMeta[String(seasonNum)] || null;
            const normSeason = CatalogoManager.normalizeSeasonEpisodes(temporadasObj[seasonNum], seasonNum, tMeta, isEmLancamento);
            if (!normSeason) {
                // Temporada inválida, incompleta ou sem Ep 1 -> interrompe a cadeia de temporadas seguintes
                break;
            }

            temporadas.push(normSeason);

            // Se esta temporada NÃO estiver completa, ela NÃO desbloqueia a exibição de temporadas superiores (ex: T3)
            const isComplete = (normSeason.isDubladoCompleto || normSeason.isLegendadoCompleto);
            if (!isComplete && !isEmLancamento) {
                break;
            }
        }

        if (temporadas.length === 0) return null;

        const totalEps = temporadas.reduce((acc, t) => acc + (t.episodios ? t.episodios.length : 0), 0);
        const hasDub = temporadas.some(t => t.isDublado);
        const hasLeg = temporadas.some(t => t.isLegendado);

        const generosArr = Array.isArray(s.generos) ? s.generos : (typeof s.generos === 'string' ? JSON.parse(s.generos || '[]') : []);
        const hasAnimeGenre = generosArr.some(g => String(g).toLowerCase().includes('anim'));
        const isAnime = s.is_anime || s.isAnime || (hasAnimeGenre && (s.is_dorama || s.isDorama)) || /bleach|one piece|naruto|dragon ball|attack on titan|solo leveling|demon slayer|jujutsu|spy x family/i.test(s.nome);
        const isMicrodrama = s.subtipo === 'microdrama' || !!(s.is_microdrama || s.isMicrodrama) || s.formato === 'vertical' || generosArr.some(g => String(g).toLowerCase().includes('microdrama') || String(g).toLowerCase().includes('duanju'));
        const isDorama = !isAnime && (s.is_dorama || s.isDorama || isMicrodrama || false);
        const tags = (s.nome || '') + ' ' + (s.sinopse || s.descricao || '') + ' ' + generosArr.toString() + (isMicrodrama ? ' microdrama duanju vertical 9:16' : '');

        return {
            id: s.id,
            tmdbId: s.tmdb_id || s.tmdbId || null,
            imdbId: s.imdb_id || s.imdbId || null,
            nome: s.nome,
            nomeOriginal: s.nome_original || s.nomeOriginal || '',
            descricao: s.sinopse || s.descricao || '',
            sinopse: s.sinopse || s.descricao || '',
            posterUrl: s.poster_url || s.posterUrl || null,
            backdropUrl: s.backdrop_url || s.backdropUrl || null,
            ano: s.ano || '',
            nota: parseFloat(s.nota || 8.0),
            generos: generosArr,
            isDorama: isDorama,
            isAnime: isAnime,
            isMicrodrama: isMicrodrama,
            subtipo: isMicrodrama ? 'microdrama' : (isAnime ? 'anime' : (isDorama ? 'dorama' : (s.subtipo || 'serie'))),
            formato: s.formato || (isMicrodrama ? 'vertical' : 'horizontal'),
            origem: s.origem || 'China',
            plataformaOrigem: s.plataforma_origem || s.plataformaOrigem || null,
            trendingScore: parseFloat(s.trending_score || s.trendingScore || 0.0),
            metadataExtra: typeof s.metadata_extra === 'string' ? JSON.parse(s.metadata_extra || '{}') : (s.metadata_extra || {}),
            isDublado: hasDub,
            isLegendado: hasLeg,
            isCam: !!(s.is_cam || s.isCam),
            emLancamento: !!(s.em_lancamento || s.emLancamento),
            statusSerie: s.status_serie || s.statusSerie || 'Ended',
            temporadas_meta: temporadasMeta,
            totalTemporadas: temporadas.length,
            totalEpisodios: totalEps,
            tipo: isAnime ? 'anime' : (isDorama ? 'dorama' : 'serie'),
            temporadas: temporadas,
            dataAdicionado: s.created_at || s.dataAdicionado || new Date().toISOString(),
            audioBadge: (hasDub && hasLeg) ? 'D/L' : (hasDub ? 'D' : (hasLeg ? 'L' : ''))
        };
    }

    async loadCatalogo() {
        if (this._loadingPromise) {
            return this._loadingPromise;
        }

        this._loadingPromise = (async () => {
            try {
                // Limpa registros orfãos e sem mídia para manter integridade
                try {
                    await db.query(`DELETE FROM series WHERE id NOT IN (SELECT DISTINCT serie_id FROM episodios WHERE serie_id IS NOT NULL)`);
                    await db.query(`DELETE FROM filmes WHERE (message_id IS NULL OR message_id = '') AND (file_id IS NULL OR file_id = '') AND (versoes IS NULL OR versoes = '{}'::jsonb)`);
                    await db.query(`DELETE FROM episodios WHERE (message_id IS NULL OR message_id = '') AND (file_id IS NULL OR file_id = '') AND (versoes IS NULL OR versoes = '{}'::jsonb OR ((versoes->'dublado' IS NULL OR (versoes->'dublado'->>'messageId' IS NULL AND versoes->'dublado'->>'fileId' IS NULL)) AND (versoes->'legendado' IS NULL OR (versoes->'legendado'->>'messageId' IS NULL AND versoes->'legendado'->>'fileId' IS NULL))))`);
                } catch (e) {}

                // Carrega Filmes do PostgreSQL (Mais recentes adicionados primeiro)
                const filmesRes = await db.query(`SELECT * FROM filmes ORDER BY id DESC`);
                const seriesRes = await db.query(`SELECT * FROM series ORDER BY id DESC`);
                const epsRes = await db.query(`SELECT * FROM episodios ORDER BY serie_id ASC, temporada_numero ASC, numero ASC`);

                // Mapeia episódios por série e temporada
                const epsPorSerie = {};
                for (const ep of epsRes.rows) {
                    if (!epsPorSerie[ep.serie_id]) epsPorSerie[ep.serie_id] = {};
                    if (!epsPorSerie[ep.serie_id][ep.temporada_numero]) epsPorSerie[ep.serie_id][ep.temporada_numero] = [];

                    let rawVersoes = ep.versoes;
                    let versoes = {};
                    if (typeof rawVersoes === 'string') {
                        try { rawVersoes = JSON.parse(rawVersoes); } catch (e) { rawVersoes = {}; }
                    }
                    if (rawVersoes && typeof rawVersoes === 'object' && Object.keys(rawVersoes).length > 0) {
                        versoes = rawVersoes;
                    } else {
                        // Apenas em registros legados sem objeto de versões nenhum:
                        if (ep.is_dublado && (ep.message_id || ep.file_id)) {
                            versoes.dublado = { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' };
                        }
                        if (ep.is_legendado && (ep.message_id || ep.file_id)) {
                            versoes.legendado = { messageId: ep.message_id ? Number(ep.message_id) : null, fileId: ep.file_id, qualidade: ep.qualidade || '1080p' };
                        }
                    }

                    const hasDub = (versoes && Object.prototype.hasOwnProperty.call(versoes, 'dublado'))
                        ? CatalogoManager.hasPlayableMedia(versoes.dublado)
                        : (ep.is_dublado && CatalogoManager.hasPlayableMedia({ messageId: ep.message_id, fileId: ep.file_id }));
                    const hasLeg = (versoes && Object.prototype.hasOwnProperty.call(versoes, 'legendado'))
                        ? CatalogoManager.hasPlayableMedia(versoes.legendado)
                        : (ep.is_legendado && CatalogoManager.hasPlayableMedia({ messageId: ep.message_id, fileId: ep.file_id }));

                    epsPorSerie[ep.serie_id][ep.temporada_numero].push({
                        numero: ep.numero,
                        nome: ep.nome || `Episódio ${ep.numero}`,
                        sinopse: ep.sinopse || '',
                        stillUrl: ep.still_url || null,
                        duracao: ep.duracao || null,
                        messageId: ep.message_id ? Number(ep.message_id) : null,
                        fileId: ep.file_id,
                        qualidade: ep.qualidade || '1080p',
                        audio: ep.audio || (hasDub && hasLeg ? 'Dub/Leg (Dublado + Legendado)' : (hasDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)')),
                        isDublado: hasDub,
                        isLegendado: hasLeg,
                        versoes: versoes,
                        dataAdicionado: ep.created_at
                    });
                }

                // Coleta todos os messageIds referenciados para verificação preventiva com cache
                const allMessageIds = [];
                for (const f of filmesRes.rows) {
                    let versoes = f.versoes || {};
                    if (typeof versoes === 'string') try { versoes = JSON.parse(versoes); } catch (e) { versoes = {}; }
                    if (f.message_id) allMessageIds.push(Number(f.message_id));
                    if (versoes.dublado?.messageId) allMessageIds.push(Number(versoes.dublado.messageId));
                    if (versoes.legendado?.messageId) allMessageIds.push(Number(versoes.legendado.messageId));
                }
                for (const ep of epsRes.rows) {
                    let versoes = ep.versoes || {};
                    if (typeof versoes === 'string') try { versoes = JSON.parse(versoes); } catch (e) { versoes = {}; }
                    if (ep.message_id) allMessageIds.push(Number(ep.message_id));
                    if (versoes.dublado?.messageId) allMessageIds.push(Number(versoes.dublado.messageId));
                    if (versoes.legendado?.messageId) allMessageIds.push(Number(versoes.legendado.messageId));
                }

                // Identifica messageIds pendentes de verificação no cache
                const unverifiedIds = [...new Set(allMessageIds)]
                    .filter(id => !isNaN(id) && id > 0 && !CatalogoManager.mediaVerificationCache.get(id));

                if (unverifiedIds.length > 0) {
                    try {
                        const TelegramUploader = require('../services/TelegramUploader');
                        const uploader = TelegramUploader.getInstance();
                        const tgResults = await uploader.getStorageMessages(unverifiedIds);
                        for (const [mid, info] of tgResults.entries()) {
                            if (info.status === 'FOUND') {
                                CatalogoManager.mediaVerificationCache.set(mid, 'VERIFIED_PLAYABLE', {
                                    docId: info.docId,
                                    docSize: info.docSize,
                                    isVideo: info.isVideo,
                                    duration: info.duration,
                                    fileName: info.fileName
                                });
                            } else if (info.status === 'NOT_FOUND') {
                                CatalogoManager.mediaVerificationCache.set(mid, 'MISSING', { error: 'MessageEmpty' });
                            } else if (info.status === 'INVALID_MEDIA') {
                                CatalogoManager.mediaVerificationCache.set(mid, 'INVALID_MEDIA', { error: info.error });
                            } else if (info.status === 'ERROR') {
                                CatalogoManager.mediaVerificationCache.set(mid, 'UNVERIFIED', { error: info.error });
                            }
                        }
                    } catch (tgErr) {
                        console.warn('⚠️ Aviso ao verificar status das mídias no Telegram durante carga do catálogo:', tgErr.message);
                    }
                }

                // Mapeia Séries aplicando a Fonte Única de Verdade (Continuidade Sequencial & Ponto de Entrada)
                const series = seriesRes.rows.map(s => {
                    const serieObj = CatalogoManager.processSerie(s, epsPorSerie[s.id] || {});
                    if (serieObj) {
                        serieObj.tags = this.extrairTags((serieObj.nome || '') + ' ' + (serieObj.sinopse || '') + ' ' + (serieObj.generos || []).toString());
                    }
                    return serieObj;
                }).filter(Boolean);

                // Mapeia Filmes
                const filmes = filmesRes.rows.map(f => {
                    let rawVersoes = f.versoes;
                    let versoes = {};
                    if (typeof rawVersoes === 'string') {
                        try { rawVersoes = JSON.parse(rawVersoes); } catch (e) { rawVersoes = {}; }
                    }
                    if (rawVersoes && typeof rawVersoes === 'object' && Object.keys(rawVersoes).length > 0) {
                        versoes = rawVersoes;
                    } else {
                        // Apenas em registros legados sem objeto de versões nenhum:
                        if (f.is_dublado && (f.message_id || f.file_id)) {
                            versoes.dublado = { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam };
                        }
                        if (f.is_legendado && (f.message_id || f.file_id)) {
                            versoes.legendado = { messageId: f.message_id ? Number(f.message_id) : null, fileId: f.file_id, qualidade: f.qualidade || '1080p', isCam: f.is_cam };
                        }
                    }

                    const hasPlayableDub = (versoes && Object.prototype.hasOwnProperty.call(versoes, 'dublado'))
                        ? CatalogoManager.hasPlayableMedia(versoes.dublado)
                        : (f.is_dublado && CatalogoManager.hasPlayableMedia({ messageId: f.message_id, fileId: f.file_id }));

                    const hasPlayableLeg = (versoes && Object.prototype.hasOwnProperty.call(versoes, 'legendado'))
                        ? CatalogoManager.hasPlayableMedia(versoes.legendado)
                        : (f.is_legendado && CatalogoManager.hasPlayableMedia({ messageId: f.message_id, fileId: f.file_id }));

                    const hasAnyPlayable = hasPlayableDub || hasPlayableLeg || (
                        (!versoes || (!Object.prototype.hasOwnProperty.call(versoes, 'dublado') && !Object.prototype.hasOwnProperty.call(versoes, 'legendado')))
                        && CatalogoManager.hasPlayableMedia({ messageId: f.message_id, fileId: f.file_id })
                    );

                    if (!hasAnyPlayable) {
                        return null; // Oculta filme se não possuir nenhuma mídia verificada reproduzível
                    }

                    const generosArr = Array.isArray(f.generos) ? f.generos : (typeof f.generos === 'string' ? JSON.parse(f.generos) : []);
                    const hasAnimeGenre = generosArr.some(g => String(g).toLowerCase().includes('anim'));
                    const isAnime = f.is_anime || (hasAnimeGenre && /anime|dragon ball|one piece|bleach|naruto|demon slayer|jujutsu|suzume|ghibli|your name/i.test(f.nome));

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
                        generos: generosArr,
                        qualidade: f.qualidade || '1080p',
                        isCam: f.is_cam === true || (f.qualidade && f.qualidade.toUpperCase().includes('CAM')) || false,
                        isAnime: isAnime,
                        isDorama: f.is_dorama || false,
                        isDublado: hasPlayableDub,
                        isLegendado: hasPlayableLeg,
                        audio: f.audio || (hasPlayableDub && hasPlayableLeg ? 'Dub/Leg (Dublado + Legendado)' : (hasPlayableDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)')),
                        versoes: versoes,
                        messageId: f.message_id ? Number(f.message_id) : null,
                        fileId: f.file_id,
                        dataAdicionado: f.created_at,
                        tags: this.extrairTags(f.nome + ' ' + (f.sinopse || '') + ' ' + (f.generos || []).toString())
                    };
                }).filter(Boolean);

                this.catalogo = { filmes, series };
                this.saveCatalogoBackup();
                console.log(`📦 Catálogo BrasilFlix carregado: ${filmes.length} filmes, ${series.length} séries ativas.`);

                // Inicia o verificador periódico de integridade (singleton)
                this.startPeriodicRevalidation();

                // Executa enriquecimento automático em segundo plano apenas 1 vez na inicialização ou a cada 4 horas
                const now = Date.now();
                if (!this._lastEnrichTimestamp || (now - this._lastEnrichTimestamp > 4 * 60 * 60 * 1000)) {
                    this._lastEnrichTimestamp = now;
                    setTimeout(() => {
                        this.autoEnrichMissingMetadata().catch(() => {});
                        this.enriquecerEpisodiosPendentes().catch(() => {});
                    }, 5000);
                }
            } catch (error) {
                console.error('❌ Erro ao carregar catálogo do PostgreSQL:', error.message);
                if (fs.existsSync(config.CATALOGO_FILE)) {
                    try {
                        this.catalogo = fs.readJsonSync(config.CATALOGO_FILE);
                    } catch (e) {}
                }
            } finally {
                this._loadingPromise = null;
            }
        })();

        return this._loadingPromise;
    }

    async autoEnrichMissingMetadata() {
        if (!this.catalogo) return;

        // 1. Varre séries sem poster ou sem tmdbId
        for (const s of (this.catalogo.series || [])) {
            if (!s.posterUrl || !s.tmdbId) {
                try {
                    const results = await TMDBService.searchTV(s.nome);
                    if (results && results.length > 0) {
                        const details = (await TMDBService.getTVDetails(results[0].tmdbId)) || results[0];
                        if (details && details.posterUrl) {
                            s.tmdbId = details.tmdbId;
                            s.posterUrl = details.posterUrl;
                            s.backdropUrl = details.backdropUrl || s.backdropUrl;
                            s.sinopse = s.sinopse || details.sinopse || '';
                            s.descricao = s.descricao || details.sinopse || '';
                            s.ano = s.ano || details.ano || '';
                            s.generos = details.generos && details.generos.length > 0 ? details.generos : s.generos;
                            s.nomeOriginal = s.nomeOriginal || details.nomeOriginal || s.nome;

                            await db.query(`
                                UPDATE series SET
                                    tmdb_id = $1,
                                    poster_url = $2,
                                    backdrop_url = $3,
                                    sinopse = $4,
                                    ano = $5,
                                    generos = $6,
                                    nome_original = $7,
                                    updated_at = NOW()
                                WHERE id = $8
                            `, [
                                s.tmdbId, s.posterUrl, s.backdropUrl, s.sinopse,
                                s.ano, JSON.stringify(s.generos || []), s.nomeOriginal, s.id
                            ]);
                            console.log(`🎨 [AUTO-ENRICH] Capa recuperada com sucesso para série: "${s.nome}"`);
                        }
                    }
                } catch (err) {
                    console.warn(`⚠️ [AUTO-ENRICH] Falha ao buscar metadados para série "${s.nome}":`, err.message);
                }
            }
        }

        // 2. Varre filmes sem poster ou sem tmdbId
        for (const f of (this.catalogo.filmes || [])) {
            if (!f.posterUrl || !f.tmdbId) {
                try {
                    const results = await TMDBService.searchMovie(f.nome);
                    if (results && results.length > 0) {
                        const details = (await TMDBService.getMovieDetails(results[0].tmdbId)) || results[0];
                        if (details && details.posterUrl) {
                            f.tmdbId = details.tmdbId;
                            f.posterUrl = details.posterUrl;
                            f.backdropUrl = details.backdropUrl || f.backdropUrl;
                            f.sinopse = f.sinopse || details.sinopse || '';
                            f.descricao = f.descricao || details.sinopse || '';
                            f.ano = f.ano || details.ano || '';
                            f.generos = details.generos && details.generos.length > 0 ? details.generos : f.generos;
                            f.nomeOriginal = f.nomeOriginal || details.nomeOriginal || f.nome;

                            await db.query(`
                                UPDATE filmes SET
                                    tmdb_id = $1,
                                    poster_url = $2,
                                    backdrop_url = $3,
                                    sinopse = $4,
                                    ano = $5,
                                    generos = $6,
                                    nome_original = $7,
                                    updated_at = NOW()
                                WHERE id = $8
                            `, [
                                f.tmdbId, f.posterUrl, f.backdropUrl, f.sinopse,
                                f.ano, JSON.stringify(f.generos || []), f.nomeOriginal, f.id
                            ]);
                            console.log(`🎨 [AUTO-ENRICH] Capa recuperada com sucesso para filme: "${f.nome}"`);
                        }
                    }
                } catch (err) {
                    console.warn(`⚠️ [AUTO-ENRICH] Falha ao buscar metadados para filme "${f.nome}":`, err.message);
                }
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
        return (this.catalogo.filmes || []).filter(f => f.isCam === true || (f.qualidade && f.qualidade.toUpperCase().includes('CAM')) || !!f.versoes?.dublado?.isCam || !!f.versoes?.legendado?.isCam);
    }

    buscarFilmesApenasLegendados() {
        return (this.catalogo.filmes || []).filter(f => {
            const temDub = f.isDublado === true || !!f.versoes?.dublado;
            const temLeg = f.isLegendado === true || !!f.versoes?.legendado || (f.audio && f.audio.toLowerCase().includes('legendado'));
            return temLeg && !temDub;
        });
    }

    buscarFilmesApenasDublados() {
        return (this.catalogo.filmes || []).filter(f => {
            const temDub = f.isDublado === true || !!f.versoes?.dublado || (f.audio && f.audio.toLowerCase().includes('dublado'));
            const temLeg = f.isLegendado === true || !!f.versoes?.legendado;
            return temDub && !temLeg && !f.isCam;
        });
    }

    buscarEpisodiosApenasLegendados() {
        const pendentes = [];
        for (const serie of (this.catalogo.series || [])) {
            for (const temp of (serie.temporadas || [])) {
                const eps = temp.episodios || [];
                const temAlgumLegendado = eps.some(e => !e.isDublado && (e.isLegendado || !!e.versoes?.legendado || (e.audio && e.audio.toLowerCase().includes('legendado'))));

                // Se houver episódios na temporada que não possuem versão Dublada
                if (temAlgumLegendado) {
                    for (const ep of eps) {
                        const isDub = ep.isDublado || !!ep.versoes?.dublado || (ep.audio && ep.audio.toLowerCase().includes('dublado'));
                        if (!isDub) {
                            pendentes.push({
                                serieId: serie.id,
                                serieNome: serie.nome,
                                nomeOriginal: serie.nomeOriginal,
                                tmdbId: serie.tmdbId,
                                imdbId: serie.imdbId,
                                season: temp.numero,
                                episode: ep.numero,
                                epNome: ep.nome,
                                isDorama: serie.isDorama,
                                isAnime: serie.isAnime
                            });
                        }
                    }
                }
            }
        }
        return pendentes;
    }

    buscarEpisodiosApenasDublados() {
        const pendentes = [];
        for (const serie of (this.catalogo.series || [])) {
            for (const temp of (serie.temporadas || [])) {
                const eps = temp.episodios || [];
                for (const ep of eps) {
                    const isDub = ep.isDublado || !!ep.versoes?.dublado || (ep.audio && ep.audio.toLowerCase().includes('dublado'));
                    const isLeg = ep.isLegendado || !!ep.versoes?.legendado;
                    // Se tem dublado mas ainda NÃO tem a versão legendada disponível
                    if (isDub && !isLeg) {
                        pendentes.push({
                            serieId: serie.id,
                            serieNome: serie.nome,
                            nomeOriginal: serie.nomeOriginal,
                            tmdbId: serie.tmdbId,
                            imdbId: serie.imdbId,
                            season: temp.numero,
                            episode: ep.numero,
                            epNome: ep.nome,
                            isDorama: serie.isDorama,
                            isAnime: serie.isAnime
                        });
                    }
                }
            }
        }
        return pendentes;
    }


    async adicionarFilme(nome, descricao, messageId, tipo = 'filme', forcarAdicao = false, metadadosExtras = {}) {
        const existente = this.buscarItemExato(nome, tipo);

        // Se metadados de poster ou TMDB estiverem ausentes, busca no TMDB proativamente
        if (!metadadosExtras.posterUrl || !metadadosExtras.tmdbId) {
            try {
                const tmdbRes = await TMDBService.searchMovie(nome);
                if (tmdbRes && tmdbRes.length > 0) {
                    const det = (await TMDBService.getMovieDetails(tmdbRes[0].tmdbId)) || tmdbRes[0];
                    metadadosExtras.tmdbId = metadadosExtras.tmdbId || det.tmdbId;
                    metadadosExtras.posterUrl = metadadosExtras.posterUrl || det.posterUrl;
                    metadadosExtras.backdropUrl = metadadosExtras.backdropUrl || det.backdropUrl;
                    metadadosExtras.sinopse = metadadosExtras.sinopse || det.sinopse;
                    metadadosExtras.ano = metadadosExtras.ano || det.ano;
                    metadadosExtras.generos = metadadosExtras.generos || det.generos;
                    metadadosExtras.nomeOriginal = metadadosExtras.nomeOriginal || det.nomeOriginal;
                }
            } catch (e) {}
        }

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
            return { success: false, error: e.message };
        }

        await this.loadCatalogo();
        const item = this.buscarFilmePorId(dbId) || {
            id: dbId,
            tmdbId: metadadosExtras.tmdbId || null,
            imdbId: metadadosExtras.imdbId || null,
            nome: nome.trim(),
            qualidade: metadadosExtras.qualidade || '1080p',
            isDublado: isDublado,
            isLegendado: isLegendado
        };

        console.log(`✅ Filme adicionado ao catálogo: ${nome} [ID: ${item.id}, Qualidade: ${item.qualidade}] (MessageId: ${messageId})`);
        this.notificarUsuariosPedidoConcluido(nome, 'filme', item.id).catch(() => {});
        this.notificarPublicoLancamento('filme', item).catch(() => {});
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

        const oldMsgIdsToDelete = [];
        if (isNovaDub && filme.versoes?.dublado?.messageId && Number(filme.versoes.dublado.messageId) !== Number(novaMidia.messageId)) {
            oldMsgIdsToDelete.push(filme.versoes.dublado.messageId);
        }
        if (isNovaLeg && filme.versoes?.legendado?.messageId && Number(filme.versoes.legendado.messageId) !== Number(novaMidia.messageId)) {
            oldMsgIdsToDelete.push(filme.versoes.legendado.messageId);
        }

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
            ? 'Dub/Leg (Dublado + Legendado)'
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
            console.error('❌ Erro ao atualizar filme no PostgreSQL:', e.message);
            return false;
        }

        if (oldMsgIdsToDelete.length > 0) {
            this.deleteStorageMessages(oldMsgIdsToDelete).catch(() => {});
        }

        filme.dataAtualizado = new Date().toISOString();
        this.saveCatalogo();
        console.log(`🔄 Filme atualizado com sucesso no catálogo: "${filme.nome}" [Dublado: ${filme.isDublado}, Legendado: ${filme.isLegendado}]`);
        this.notificarPublicoLancamento('filme', filme).catch(() => {});
        return true;
    }

    async adicionarEpisodioSerie(serieNome, temporadaNum, episodioNum, messageId, fileId = null, metadados = {}) {
        let serie = this.catalogo.series.find(s => 
            s.nome.toLowerCase() === serieNome.toLowerCase() || 
            (s.tmdbId && metadados.tmdbId && s.tmdbId === metadados.tmdbId)
        );

        // Se metadados de poster ou TMDB estiverem ausentes, busca no TMDB proativamente
        if (!metadados.posterUrl || !metadados.tmdbId) {
            try {
                const tmdbRes = await TMDBService.searchTV(serieNome);
                if (tmdbRes && tmdbRes.length > 0) {
                    const det = (await TMDBService.getTVDetails(tmdbRes[0].tmdbId)) || tmdbRes[0];
                    metadados.tmdbId = metadados.tmdbId || det.tmdbId;
                    metadados.posterUrl = metadados.posterUrl || det.posterUrl;
                    metadados.backdropUrl = metadados.backdropUrl || det.backdropUrl;
                    metadados.sinopse = metadados.sinopse || det.sinopse;
                    metadados.ano = metadados.ano || det.ano;
                    metadados.generos = metadados.generos || det.generos;
                    metadados.nomeOriginal = metadados.nomeOriginal || det.nomeOriginal;
                }
            } catch (e) {}
        }

        const isDub = metadados.isDublado ?? (metadados.audio ? !metadados.audio.toLowerCase().includes('legendado') : true);
        const isLeg = metadados.isLegendado ?? (metadados.audio ? metadados.audio.toLowerCase().includes('legendado') : false);

        const isMicro = metadados.subtipo === 'microdrama' || metadados.isMicrodrama || metadados.formato === 'vertical';
        const isDorama = metadados.isDorama || isMicro || false;

        // Se a série não foi encontrada na memória, consulta o banco PostgreSQL antes de criar duplicata
        if (!serie) {
            try {
                let dbCheck = null;
                if (metadados.tmdbId) {
                    dbCheck = await db.query(`SELECT * FROM series WHERE tmdb_id = $1 LIMIT 1`, [metadados.tmdbId]);
                }
                if (!dbCheck || dbCheck.rows.length === 0) {
                    dbCheck = await db.query(`SELECT * FROM series WHERE LOWER(nome) = LOWER($1) LIMIT 1`, [serieNome.trim()]);
                }
                if (dbCheck && dbCheck.rows.length > 0) {
                    const row = dbCheck.rows[0];
                    serie = {
                        id: row.id,
                        tmdbId: row.tmdb_id,
                        imdbId: row.imdb_id,
                        nome: row.nome,
                        nomeOriginal: row.nome_original || '',
                        descricao: row.sinopse || '',
                        sinopse: row.sinopse || '',
                        posterUrl: row.poster_url,
                        backdropUrl: row.backdrop_url,
                        ano: row.ano || '',
                        nota: parseFloat(row.nota || 8.0),
                        generos: typeof row.generos === 'string' ? JSON.parse(row.generos || '[]') : (row.generos || []),
                        isDorama: !!row.is_dorama,
                        isAnime: !!row.is_anime,
                        isMicrodrama: !!row.is_microdrama,
                        subtipo: row.subtipo || 'serie',
                        formato: row.formato || 'horizontal',
                        origem: row.origem || 'China',
                        plataformaOrigem: row.plataforma_origem || null,
                        trendingScore: parseFloat(row.trending_score || 0.0),
                        isDublado: !!row.is_dublado,
                        isLegendado: !!row.is_legendado,
                        tipo: row.is_microdrama ? 'dorama' : (row.is_anime ? 'anime' : (row.is_dorama ? 'dorama' : 'serie')),
                        temporadas: [],
                        dataAdicionado: row.created_at || new Date().toISOString(),
                        tags: this.extrairTags(row.nome)
                    };
                    this.catalogo.series.push(serie);
                }
            } catch (errDbCheck) {
                console.warn('⚠️ Erro ao verificar série existente no banco PostgreSQL:', errDbCheck.message);
            }
        }

        if (!serie) {
            let sId = null;
            try {
                const res = await db.query(`
                    INSERT INTO series (
                        nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                        nota, tmdb_id, imdb_id, total_temporadas, total_episodios, is_dorama,
                        is_dublado, is_legendado, is_cam, is_microdrama, subtipo, formato, origem,
                        plataforma_origem, trending_score, metadata_extra, created_at, updated_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW(), NOW()
                    ) RETURNING id
                `, [
                    serieNome.trim(), metadados.nomeOriginal || serieNome.trim(), metadados.ano || '',
                    JSON.stringify(metadados.generos || []), metadados.sinopse || '',
                    metadados.posterUrl || null, metadados.backdropUrl || null,
                    metadados.nota || 8.0, metadados.tmdbId || null, metadados.imdbId || null,
                    1, 1, isDorama, isDub, isLeg, metadados.isCam || false,
                    isMicro, metadados.subtipo || (isMicro ? 'microdrama' : 'serie'),
                    metadados.formato || (isMicro ? 'vertical' : 'horizontal'),
                    metadados.origem || 'China', metadados.plataformaOrigem || metadados.plataforma_origem || null,
                    parseFloat(metadados.trendingScore || metadados.trending_score || 0.0),
                    JSON.stringify(metadados.metadataExtra || metadados.metadata_extra || {})
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
                isDorama: isDorama,
                isMicrodrama: isMicro,
                subtipo: metadados.subtipo || (isMicro ? 'microdrama' : 'serie'),
                formato: metadados.formato || (isMicro ? 'vertical' : 'horizontal'),
                origem: metadados.origem || 'China',
                plataformaOrigem: metadados.plataformaOrigem || metadados.plataforma_origem || null,
                trendingScore: parseFloat(metadados.trendingScore || metadados.trending_score || 0.0),
                isDublado: isDub,
                isLegendado: isLeg,
                tipo: isMicro ? 'dorama' : 'serie',
                temporadas: [],
                dataAdicionado: new Date().toISOString(),
                tags: this.extrairTags(serieNome + ' ' + (metadados.generos ? metadados.generos.join(' ') : ''))
            };
            this.catalogo.series.push(serie);
        } else {
            if (isDub) serie.isDublado = true;
            if (isLeg) serie.isLegendado = true;
            if (isMicro) {
                serie.isMicrodrama = true;
                serie.subtipo = 'microdrama';
                serie.formato = 'vertical';
            }

            // Se a série existente não tinha poster mas agora temos, atualiza
            if (!serie.posterUrl && metadados.posterUrl) {
                serie.posterUrl = metadados.posterUrl;
                serie.backdropUrl = metadados.backdropUrl || serie.backdropUrl;
                serie.tmdbId = metadados.tmdbId || serie.tmdbId;
                serie.sinopse = metadados.sinopse || serie.sinopse;
                serie.ano = metadados.ano || serie.ano;
                serie.generos = metadados.generos || serie.generos;
                db.query(`UPDATE series SET poster_url = $1, backdrop_url = $2, tmdb_id = $3, sinopse = $4, ano = $5, generos = $6, updated_at = NOW() WHERE id = $7`, [
                    serie.posterUrl, serie.backdropUrl, serie.tmdbId, serie.sinopse, serie.ano, JSON.stringify(serie.generos || []), serie.id
                ]).catch(() => {});
            }
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
        const existingVersoes = existingEp?.versoes || {};
        
        // Se uma versão de mesmo áudio já existia com outro messageId, apaga a versão antiga do Telegram
        const oldMsgIdsToDelete = [];
        if (isDub && existingVersoes.dublado?.messageId && existingVersoes.dublado.messageId !== Number(messageId)) {
            oldMsgIdsToDelete.push(existingVersoes.dublado.messageId);
        }
        if (isLeg && existingVersoes.legendado?.messageId && existingVersoes.legendado.messageId !== Number(messageId)) {
            oldMsgIdsToDelete.push(existingVersoes.legendado.messageId);
        }

        const versoes = {
            dublado: isDub
                ? { messageId: messageId ? Number(messageId) : null, fileId: fileId || null, qualidade: metadados.qualidade || '1080p' }
                : ((existingVersoes.dublado && (existingVersoes.dublado.messageId || existingVersoes.dublado.fileId)) ? existingVersoes.dublado : null),
            legendado: isLeg
                ? { messageId: messageId ? Number(messageId) : null, fileId: fileId || null, qualidade: metadados.qualidade || '1080p' }
                : ((existingVersoes.legendado && (existingVersoes.legendado.messageId || existingVersoes.legendado.fileId)) ? existingVersoes.legendado : null)
        };

        const finalIsDub = !!(versoes.dublado && (versoes.dublado.messageId || versoes.dublado.fileId));
        const finalIsLeg = !!(versoes.legendado && (versoes.legendado.messageId || versoes.legendado.fileId));

        const primaryMessageId = versoes.dublado?.messageId || versoes.legendado?.messageId || (messageId ? Number(messageId) : null);
        const primaryFileId = versoes.dublado?.fileId || versoes.legendado?.fileId || fileId || null;
        const primaryAudio = (finalIsDub && finalIsLeg)
            ? 'Dub/Leg (Dublado + Legendado)'
            : (finalIsDub ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)');

        // Busca metadados detalhados no TMDB (nome oficial, sinopse, stillUrl, duracao)
        if (serie.tmdbId || metadados.tmdbId) {
            try {
                const epTmdb = await TMDBService.getEpisodeDetails(serie.tmdbId || metadados.tmdbId, temporadaNum, episodioNum);
                if (epTmdb) {
                    if (epTmdb.nome) metadados.episodioNome = epTmdb.nome;
                    if (epTmdb.sinopse) metadados.episodioSinopse = epTmdb.sinopse;
                    if (epTmdb.stillUrl) metadados.stillUrl = epTmdb.stillUrl;
                    if (epTmdb.duracaoMinutos || epTmdb.runtime) metadados.duracao = epTmdb.duracaoMinutos || epTmdb.runtime;
                }
            } catch (e) {}
        }

        // Persistência do Episódio no PostgreSQL
        try {
            await db.query(`
                INSERT INTO episodios (
                    serie_id, temporada_numero, numero, nome, sinopse,
                    message_id, file_id, qualidade, audio, is_dublado, is_legendado, versoes, still_url, duracao, created_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW()
                ) ON CONFLICT (serie_id, temporada_numero, numero) DO UPDATE SET
                    nome = COALESCE(NULLIF(EXCLUDED.nome, ''), episodios.nome),
                    sinopse = COALESCE(NULLIF(EXCLUDED.sinopse, ''), episodios.sinopse),
                    still_url = COALESCE(EXCLUDED.still_url, episodios.still_url),
                    duracao = COALESCE(EXCLUDED.duracao, episodios.duracao),
                    message_id = EXCLUDED.message_id,
                    file_id = EXCLUDED.file_id,
                    qualidade = EXCLUDED.qualidade,
                    audio = EXCLUDED.audio,
                    is_dublado = EXCLUDED.is_dublado,
                    is_legendado = EXCLUDED.is_legendado,
                    versoes = EXCLUDED.versoes
            `, [
                serie.id, temporadaNum, episodioNum,
                metadados.episodioNome || `Episódio ${episodioNum}`,
                metadados.episodioSinopse || '',
                primaryMessageId || null, primaryFileId || null,
                metadados.qualidade || '1080p',
                primaryAudio,
                finalIsDub, finalIsLeg,
                JSON.stringify(versoes),
                metadados.stillUrl || null,
                metadados.duracao || null
            ]);

            await db.query(`
                UPDATE series SET 
                    total_temporadas = (SELECT COUNT(DISTINCT temporada_numero) FROM episodios WHERE serie_id = $1),
                    total_episodios = (SELECT COUNT(*) FROM episodios WHERE serie_id = $1),
                    is_dublado = COALESCE((SELECT bool_or(is_dublado) FROM episodios WHERE serie_id = $1), false),
                    is_legendado = COALESCE((SELECT bool_or(is_legendado) FROM episodios WHERE serie_id = $1), false),
                    updated_at = NOW()
                WHERE id = $1
            `, [serie.id]);
        } catch (e) {
            console.error('❌ Erro ao persistir episódio no PostgreSQL:', e.message);
            return { success: false, error: e.message };
        }

        // Apaga mensagens do Telegram apenas após sucesso na persistência do PostgreSQL
        if (oldMsgIdsToDelete.length > 0) {
            this.deleteStorageMessages(oldMsgIdsToDelete).catch(() => {});
        }

        // Recarrega o catálogo em memória usando a regra estrita de continuidade
        await this.loadCatalogo();

        const epData = {
            numero: episodioNum,
            nome: metadados.episodioNome || existingEp?.nome || `Episódio ${episodioNum}`,
            sinopse: metadados.episodioSinopse || existingEp?.sinopse || '',
            stillUrl: metadados.stillUrl || existingEp?.stillUrl || null,
            duracao: metadados.duracao || existingEp?.duracao || null,
            messageId: primaryMessageId,
            fileId: primaryFileId,
            qualidade: metadados.qualidade || existingEp?.qualidade || '1080p',
            audio: primaryAudio,
            isDublado: finalIsDub,
            isLegendado: finalIsLeg,
            versoes: versoes,
            dataAdicionado: existingEp?.dataAdicionado || new Date().toISOString()
        };

        console.log(`✅ Episódio catalogado: ${serieNome} T${temporadaNum}E${episodioNum} [Dub: ${finalIsDub}, Leg: ${finalIsLeg}] (Msg: ${primaryMessageId})`);
        this.notificarUsuariosPedidoConcluido(serieNome, 'serie', serie.id, temporadaNum, episodioNum).catch(() => {});
        this.verificarENotificarTemporadaCompleta(serie, temporadaNum).catch(() => {});
        return { success: true, item: epData, serieId: serie.id };
    }

    /**
     * Alias de conveniência para adicionar episódio por ID ou Nome
     */
    async adicionarEpisodio(serieIdOuNome, seasonNum, epNum, metadados = {}) {
        let serieNome = typeof serieIdOuNome === 'string' && isNaN(Number(serieIdOuNome)) ? serieIdOuNome : null;
        if (!serieNome) {
            const found = (this.catalogo.series || []).find(s => s.id == serieIdOuNome);
            if (found) serieNome = found.nome;
            else {
                try {
                    const dbRes = await db.query(`SELECT nome FROM series WHERE id = $1`, [serieIdOuNome]);
                    if (dbRes.rows.length > 0) serieNome = dbRes.rows[0].nome;
                } catch (e) {}
            }
        }
        if (!serieNome) serieNome = metadados.nome || metadados.serieNome || `Série ${serieIdOuNome}`;
        return this.adicionarEpisodioSerie(serieNome, seasonNum, epNum, metadados.messageId, metadados.fileId, metadados);
    }

    /**
     * Alias de conveniência para adicionar série
     */
    async adicionarSerie(nome, sinopse, seasonNum, epNum, messageId, tipo = 'serie', forcar = false, metadados = {}) {
        return this.adicionarEpisodioSerie(nome, seasonNum, epNum, messageId, metadados.fileId, {
            ...metadados,
            sinopse: sinopse || metadados.sinopse
        });
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
            console.error('❌ Erro ao remover do PostgreSQL:', e.message);
            return false;
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

        // 4. Apaga fisicamente do grupo de Armazenamento do Telegram apenas se o PostgreSQL removeu com sucesso
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
        } catch (e) {
            console.error('❌ Erro ao remover episódio do PostgreSQL:', e.message);
            return false;
        }

        await this.loadCatalogo();

        if (messagesToDelete.length > 0) {
            const uniqueMsgIds = [...new Set(messagesToDelete)];
            await this.deleteStorageMessages(uniqueMsgIds);
        }

        return true;
    }

    getItemPorId(id) {
        if (!id) return null;
        const numId = Number(id);
        const strId = String(id).toLowerCase();
        const filme = (this.catalogo.filmes || []).find(f => 
            (numId && f.id === numId) || 
            String(f.id) === String(id) ||
            f.imdbId === id ||
            (f.tmdbId && (f.tmdbId === numId || `tmdb:${f.tmdbId}` === strId)) ||
            (f.nome && f.nome.toLowerCase() === strId)
        );
        if (filme) return { ...filme, tipo: 'filme' };

        const serie = (this.catalogo.series || []).find(s => 
            (numId && s.id === numId) || 
            String(s.id) === String(id) ||
            s.imdbId === id ||
            (s.tmdbId && (s.tmdbId === numId || `tmdb:${s.tmdbId}` === strId)) ||
            (s.nome && s.nome.toLowerCase() === strId)
        );
        if (serie) return { ...serie, tipo: 'serie' };

        return null;
    }

    buscarSeriePorId(id) {
        if (!id) return null;
        const numId = Number(id);
        const strId = String(id).toLowerCase();
        return (this.catalogo.series || []).find(s => 
            (numId && s.id === numId) || 
            String(s.id) === String(id) ||
            s.imdbId === id ||
            (s.tmdbId && (s.tmdbId === numId || `tmdb:${s.tmdbId}` === strId)) ||
            (s.nome && s.nome.toLowerCase() === strId)
        ) || null;
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
        const strId = String(id).toLowerCase();
        return (this.catalogo.filmes || []).find(f => 
            (numId && f.id === numId) || 
            String(f.id) === String(id) ||
            f.imdbId === id ||
            (f.tmdbId && (f.tmdbId === numId || `tmdb:${f.tmdbId}` === strId)) ||
            (f.nome && f.nome.toLowerCase() === strId)
        ) || null;
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
            const nomeOriginalBruto = (item.nomeOriginal || '').toLowerCase();
            const nomeFonetico = this.normalizarTexto(item.nome || '');
            const nomeOriginalFonetico = this.normalizarTexto(item.nomeOriginal || '');
            const sinopseFonetica = this.normalizarTexto(item.sinopse || item.descricao || '');

            let score = 0;

            // 1. Correspondência Direta (Português ou Original/Inglês)
            if (nomeBruto === termoBruto || nomeOriginalBruto === termoBruto) {
                score += 150;
            } else if (nomeBruto.includes(termoBruto) || nomeOriginalBruto.includes(termoBruto)) {
                score += 100;
            }

            // 2. Correspondência Fonética Exata (ex: 'te ruquie' -> 'te ruki' == 'the rookie')
            if (nomeFonetico === termoFonetico || nomeOriginalFonetico === termoFonetico) {
                score += 120;
            } else if (nomeFonetico.includes(termoFonetico) || nomeOriginalFonetico.includes(termoFonetico)) {
                score += 90;
            }

            // 3. Similaridade Fonética e Levenshtein (calculada sobre o nome em PT e EN)
            const simNome = this.calcularSimilaridade(termoFonetico, nomeFonetico);
            const simOrig = this.calcularSimilaridade(termoFonetico, nomeOriginalFonetico);
            const maxSim = Math.max(simNome, simOrig);

            if (maxSim >= 0.60) {
                score += Math.round(maxSim * 80);
            }

            // 4. Correspondência de Palavras Individuais (Tokens)
            const palavrasItem = [
                ...nomeFonetico.split(' '),
                ...nomeOriginalFonetico.split(' ')
            ].filter(p => p.length > 1);

            let palavrasCorrespondidas = 0;
            for (const pTermo of palavrasTermo) {
                let matched = false;
                for (const pItem of palavrasItem) {
                    if (pTermo === pItem) {
                        score += 35;
                        matched = true;
                        break;
                    } else if (pItem.includes(pTermo) || pTermo.includes(pItem)) {
                        score += 20;
                        matched = true;
                        break;
                    } else {
                        const simP = this.calcularSimilaridade(pTermo, pItem);
                        if (simP >= 0.75) {
                            score += Math.round(simP * 25);
                            matched = true;
                            break;
                        }
                    }
                }
                if (matched) palavrasCorrespondidas++;
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

    async buscarItemComTMDB(termo) {
        let resultados = this.buscarItem(termo);
        if (resultados.length > 0) return resultados;

        // Se a busca direta no catálogo falhar, consulta o TMDB para resolver variações em inglês/português ou nomes alternativos
        try {
            const tmdbRes = await TMDBService.searchMulti(termo);
            if (tmdbRes && tmdbRes.length > 0) {
                const encontrados = new Set();
                const itensTMDB = [];

                for (const t of tmdbRes.slice(0, 5)) {
                    if (!t.tmdbId) continue;
                    const match = this.buscarItemExato(null, t.tipo, t.tmdbId);
                    if (match && !encontrados.has(match.id)) {
                        encontrados.add(match.id);
                        itensTMDB.push({ ...match, tipo: t.tipo });
                    }
                }

                if (itensTMDB.length > 0) {
                    return itensTMDB;
                }
            }
        } catch (e) {}

        return [];
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
            .replace(/th/g, 't')
            .replace(/ck/g, 'k')
            .replace(/qu/g, 'k')
            .replace(/oo/g, 'u')
            .replace(/ee/g, 'i')
            .replace(/ou/g, 'u')
            .replace(/sh/g, 'x')
            .replace(/ch/g, 'x')
            .replace(/ph/g, 'f')
            .replace(/y/g, 'i')
            .replace(/w/g, 'u')
            .replace(/c(?=[eiy])|xc|sc|ss|z/g, 's')
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

        const animes = this.getAnimes();
        const doramas = this.getDoramas();
        const microdramas = this.getMicrodramas();
        const filmes = this.getFilmesNormais();
        const series = this.getSeriesNormais();

        return {
            totalFilmes: filmes.length,
            totalFilmesDublados: filmes.filter(f => f.isDublado || !!f.versoes?.dublado).length,
            totalFilmesLegendados: filmes.filter(f => f.isLegendado || !!f.versoes?.legendado).length,
            totalSeries: series.length,
            totalSeriesDubladas: series.filter(s => s.isDublado).length,
            totalSeriesLegendadas: series.filter(s => s.isLegendado).length,
            totalAnimes: animes.length,
            totalAnimesDublados: animes.filter(a => a.isDublado || !!a.versoes?.dublado).length,
            totalAnimesLegendados: animes.filter(a => a.isLegendado || !!a.versoes?.legendado).length,
            totalDoramas: doramas.length,
            totalDoramasDublados: doramas.filter(d => d.isDublado).length,
            totalDoramasLegendados: doramas.filter(d => d.isLegendado).length,
            totalMicrodramas: microdramas.length,
            totalEpisodios: totalEpisodios,
            total: this.catalogo.filmes.length + this.catalogo.series.length
        };
    }

    getFilmesNormais() {
        return (this.catalogo.filmes || []).filter(f => !f.isAnime);
    }

    getSeriesNormais() {
        return (this.catalogo.series || []).filter(s => !s.isAnime);
    }

    getAnimes() {
        const seriesAnimes = (this.catalogo.series || []).filter(s => s.isAnime);
        const filmesAnimes = (this.catalogo.filmes || []).filter(f => f.isAnime);
        return [...seriesAnimes, ...filmesAnimes];
    }

    getDoramas() {
        return (this.catalogo.series || []).filter(s => s.isDorama && !s.isAnime);
    }

    getMicrodramas() {
        return (this.catalogo.series || []).filter(s => (s.subtipo === 'microdrama' || s.isMicrodrama || s.formato === 'vertical') && !s.isAnime);
    }

    getFilmesDublados() {
        return this.getFilmesNormais().filter(f => !f.audio || f.audio.toLowerCase().includes('dublado') || f.isDublado || !!f.versoes?.dublado);
    }

    getFilmesLegendados() {
        return this.getFilmesNormais().filter(f => (f.audio && f.audio.toLowerCase().includes('legendado')) || f.isLegendado || !!f.versoes?.legendado);
    }

    getSeriesDubladas() {
        return this.getSeriesNormais().filter(s => s.isDublado);
    }

    getSeriesLegendadas() {
        return this.getSeriesNormais().filter(s => s.isLegendado);
    }

    getAnimesDublados() {
        return this.getAnimes().filter(a => a.isDublado || !!a.versoes?.dublado);
    }

    getAnimesLegendados() {
        return this.getAnimes().filter(a => a.isLegendado || !!a.versoes?.legendado);
    }

    getDoramasDublados() {
        return this.getDoramas().filter(d => d.isDublado);
    }

    getDoramasLegendados() {
        return this.getDoramas().filter(d => d.isLegendado);
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
                isAnime: f.isAnime || false,
                isDorama: f.isDorama || false,
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
                isAnime: s.isAnime || false,
                isDorama: s.isDorama || false,
                emLancamento: s.emLancamento || false,
                totalTemporadas: (s.temporadas || []).length,
                totalEpisodios: s.totalEpisodios || 0,
                audioBadge: s.audioBadge || ((s.isDublado && s.isLegendado) ? 'D/L' : (s.isDublado ? 'D' : (s.isLegendado ? 'L' : ''))),
                temporadas: (s.temporadas || []).map(t => ({
                    numero: t.numero,
                    nome: t.nome,
                    totalEpisodios: (t.episodios || []).length,
                    isDublado: t.isDublado,
                    isLegendado: t.isLegendado,
                    isDubladoCompleto: t.isDubladoCompleto,
                    isLegendadoCompleto: t.isLegendadoCompleto,
                    episodios: (t.episodios || []).map(ep => ({
                        numero: ep.numero,
                        nome: ep.nome,
                        sinopse: ep.sinopse,
                        stillUrl: ep.stillUrl,
                        duracao: ep.duracao,
                        qualidade: ep.qualidade || '1080p Full HD',
                        isDublado: ep.isDublado,
                        isLegendado: ep.isLegendado,
                        audio: ep.audio,
                        audioBadge: ep.audioBadge
                    }))
                }))
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

    /**
     * Realiza a auditoria de integridade de todos os vídeos no Telegram.
     * Se autoReparar for true e queueManager fornecido, enfileira automaticamente episódios/filmes ausentes.
     */
    async verificarIntegridadeTelegram(queueManager = null, autoReparar = false) {
        console.log('🛡️ [Auditoria Telegram] Iniciando varredura de integridade de mídia em todo o catálogo...');
        const uploader = telegramUploader.getInstance();
        const relatorio = await uploader.verifyCatalogIntegrity(this.catalogo);

        console.log(`🛡️ [Auditoria Telegram] Resultado: ${relatorio.validos.length} válidos, ${relatorio.ausentes.length} ausentes/nulos, ${relatorio.corrompidos.length} corrompidos.`);

        if (autoReparar && queueManager && (relatorio.ausentes.length > 0 || relatorio.corrompidos.length > 0)) {
            const problemas = [...relatorio.ausentes, ...relatorio.corrompidos];
            console.log(`🔧 [Auto-Reparo Telegram] Auto-reparando ${problemas.length} item(ns) ausente(s)...`);

            for (const item of problemas) {
                if (item.tipo === 'serie') {
                    console.log(`📥 [Auto-Reparo] Reenfileirando: "${item.nome}" T${item.season}E${item.episode}`);
                    queueManager.addJob(item.nome, 'serie', 1, {
                        tmdbId: item.tmdbId,
                        season: item.season,
                        episode: item.episode,
                        audioPreference: item.versao || 'dublado',
                        queueOrder: -999
                    });
                } else if (item.tipo === 'filme') {
                    console.log(`📥 [Auto-Reparo] Reenfileirando: "${item.nome}" (${item.ano})`);
                    queueManager.addJob(item.nome, 'filme', 1, {
                        tmdbId: item.tmdbId,
                        audioPreference: item.versao || 'dublado',
                        queueOrder: -999
                    });
                }
            }
        }

        return relatorio;
    }

    /**
     * Notifica os usuários que solicitaram o filme ou série quando ele for adicionado ao catálogo.
     */
    async notificarUsuariosPedidoConcluido(nome, tipo, mediaId) {
        try {
            if (!nome) return;
            const searchTerms = nome.toLowerCase().trim();
            const res = await db.query(`
                SELECT id, user_id, username, titulo, mensagem, contato
                FROM feedbacks
                WHERE tipo IN ('pedido', 'sugestao')
                  AND notified = false
                  AND (
                    LOWER(titulo) LIKE '%' || $1 || '%' OR
                    LOWER(mensagem) LIKE '%' || $1 || '%' OR
                    $1 LIKE '%' || LOWER(titulo) || '%'
                  )
            `, [searchTerms]);

            if (res.rows && res.rows.length > 0) {
                for (const row of res.rows) {
                    if (row.user_id && row.user_id !== '') {
                        await db.query(`
                            INSERT INTO user_notifications (user_id, title, message, media_id, media_type, link, read, created_at)
                            VALUES ($1, $2, $3, $4, $5, $6, false, NOW())
                        `, [
                            row.user_id,
                            `🎬 Seu pedido chegou: ${nome}!`,
                            `O título "${nome}" que você solicitou já está disponível no catálogo do BrasilFlix. Aproveite!`,
                            mediaId,
                            tipo,
                            `/?ver=${mediaId}`
                        ]);
                    }

                    await db.query(`UPDATE feedbacks SET notified = true, status = 'concluido', media_id = $1 WHERE id = $2`, [mediaId, row.id]);
                    console.log(`🔔 [NOTIFICAÇÃO PEDIDO] Usuário ${row.username || row.user_id} notificado sobre a adição de: "${nome}"`);
                }
            }
        } catch (e) {
            console.warn('⚠️ Erro ao notificar usuários sobre novo pedido concluído:', e.message);
        }
    }

    /**
     * Envia notificação pública para o grupo de lançamentos do Telegram
     */
    async notificarPublicoLancamento(tipo, item, detalhes = {}) {
        if (!this.bot || !item) return;

        const releaseGroupId = config.PUBLIC_RELEASE_GROUP_ID || '-1005359335072';
        const TelegramNotificationFormatter = require('../services/TelegramNotificationFormatter');

        try {
            if (tipo === 'filme') {
                const audioKey = (item.isDublado && item.isLegendado) ? 'dual' : (item.isDublado ? 'dublado' : 'legendado');
                
                // Evita notificação duplicada
                const exists = await db.query(
                    `SELECT id FROM lancamentos_notificados WHERE tipo = 'filme' AND media_id = $1 AND audio = $2`,
                    [String(item.id), audioKey]
                );
                if (exists.rows.length > 0) return;

                const caption = TelegramNotificationFormatter.formatMovieNotification(item);
                const replyMarkup = TelegramNotificationFormatter.buildInlineKeyboard('filme', item.id);

                const posterUrl = item.posterUrl || item.poster_url || null;
                if (posterUrl && posterUrl.startsWith('http')) {
                    try {
                        await this.bot.sendPhoto(releaseGroupId, posterUrl, {
                            caption,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    } catch (errPhoto) {
                        try {
                            await this.bot.sendMessage(releaseGroupId, caption, {
                                parse_mode: 'HTML',
                                reply_markup: replyMarkup
                            });
                        } catch (errHtml) {
                            await this.bot.sendMessage(releaseGroupId, caption.replace(/<[^>]*>/g, ''), {
                                reply_markup: replyMarkup
                            });
                        }
                    }
                } else {
                    try {
                        await this.bot.sendMessage(releaseGroupId, caption, {
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    } catch (errHtml) {
                        await this.bot.sendMessage(releaseGroupId, caption.replace(/<[^>]*>/g, ''), {
                            reply_markup: replyMarkup
                        });
                    }
                }

                await db.query(
                    `INSERT INTO lancamentos_notificados (tipo, media_id, season_num, audio) VALUES ('filme', $1, 0, $2) ON CONFLICT DO NOTHING`,
                    [String(item.id), audioKey]
                );
                console.log(`📢 [AVISO PÚBLICO] Novo filme anunciado no Telegram: "${item.nome}" (${audioKey})`);

            } else if (tipo === 'serie') {
                const seasonNum = detalhes.seasonNum || 1;
                const audio = detalhes.audio || (item.isDublado ? 'dublado' : 'legendado');

                // Evita notificação duplicada desta temporada e áudio
                const exists = await db.query(
                    `SELECT id FROM lancamentos_notificados WHERE tipo = 'serie' AND media_id = $1 AND season_num = $2 AND audio = $3`,
                    [String(item.id), seasonNum, audio]
                );
                if (exists.rows.length > 0) return;

                const caption = TelegramNotificationFormatter.formatCompleteSeasonNotification(item, detalhes);
                const replyMarkup = TelegramNotificationFormatter.buildInlineKeyboard('serie', item.id, seasonNum);

                const posterUrl = item.posterUrl || item.poster_url || null;
                if (posterUrl && posterUrl.startsWith('http')) {
                    try {
                        await this.bot.sendPhoto(releaseGroupId, posterUrl, {
                            caption,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    } catch (errPhoto) {
                        try {
                            await this.bot.sendMessage(releaseGroupId, caption, {
                                parse_mode: 'HTML',
                                reply_markup: replyMarkup
                            });
                        } catch (errHtml) {
                            await this.bot.sendMessage(releaseGroupId, caption.replace(/<[^>]*>/g, ''), {
                                reply_markup: replyMarkup
                            });
                        }
                    }
                } else {
                    try {
                        await this.bot.sendMessage(releaseGroupId, caption, {
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    } catch (errHtml) {
                        await this.bot.sendMessage(releaseGroupId, caption.replace(/<[^>]*>/g, ''), {
                            reply_markup: replyMarkup
                        });
                    }
                }

                await db.query(
                    `INSERT INTO lancamentos_notificados (tipo, media_id, season_num, audio) VALUES ('serie', $1, $2, $3) ON CONFLICT DO NOTHING`,
                    [String(item.id), seasonNum, audio]
                );
                console.log(`📢 [AVISO PÚBLICO] Temporada completa anunciada no Telegram: "${item.nome}" T${seasonNum} (${audio})`);
            }
        } catch (e) {
            console.warn(`⚠️ Erro ao enviar aviso público de lançamento (${tipo}):`, e.message);
        }
    }

    /**
     * Checa se uma temporada foi finalizada com 100% dos episódios em Dublado ou Legendado
     */
    async verificarENotificarTemporadaCompleta(serie, temporadaNum) {
        if (!serie || !temporadaNum) return;
        try {
            const temporada = (serie.temporadas || []).find(t => t.numero === parseInt(temporadaNum, 10));
            if (!temporada || !temporada.episodios || temporada.episodios.length === 0) return;

            let expectedCount = 0;
            if (serie.temporadas_meta && serie.temporadas_meta[String(temporadaNum)]) {
                expectedCount = parseInt(serie.temporadas_meta[String(temporadaNum)], 10);
            } else if (serie.tmdbId) {
                const sDetails = await TMDBService.getSeasonDetails(serie.tmdbId, temporadaNum);
                if (sDetails && sDetails.episodios && sDetails.episodios.length > 0) {
                    expectedCount = sDetails.episodios.length;
                    const currentMeta = serie.temporadas_meta || {};
                    currentMeta[String(temporadaNum)] = expectedCount;
                    await db.query(`UPDATE series SET temporadas_meta = $1 WHERE id = $2`, [JSON.stringify(currentMeta), serie.id]);
                    serie.temporadas_meta = currentMeta;
                }
            }

            if (expectedCount === 0) {
                expectedCount = temporada.episodios.length;
            }

            const epsDub = temporada.episodios.filter(e => e.isDublado || !!e.versoes?.dublado).length;
            const epsLeg = temporada.episodios.filter(e => e.isLegendado || !!e.versoes?.legendado).length;

            const isDubCompleto = (expectedCount > 0 && epsDub >= expectedCount);
            const isLegCompleto = (expectedCount > 0 && epsLeg >= expectedCount);
            const isAnyCompleto = (expectedCount > 0 && temporada.episodios.length >= expectedCount);

            if (isDubCompleto && isLegCompleto) {
                await this.notificarPublicoLancamento('serie', serie, {
                    seasonNum: temporadaNum,
                    audio: 'dual',
                    isDublado: true,
                    isLegendado: true,
                    totalEps: expectedCount
                });
            } else if (isDubCompleto) {
                await this.notificarPublicoLancamento('serie', serie, {
                    seasonNum: temporadaNum,
                    audio: 'dublado',
                    isDublado: true,
                    isLegendado: false,
                    totalEps: expectedCount
                });
            } else if (isLegCompleto) {
                await this.notificarPublicoLancamento('serie', serie, {
                    seasonNum: temporadaNum,
                    audio: 'legendado',
                    isDublado: false,
                    isLegendado: true,
                    totalEps: expectedCount
                });
            } else if (isAnyCompleto) {
                const temAlgumDub = epsDub > 0;
                const temAlgumLeg = epsLeg > 0;
                await this.notificarPublicoLancamento('serie', serie, {
                    seasonNum: temporadaNum,
                    audio: (temAlgumDub && temAlgumLeg) ? 'dual' : (temAlgumDub ? 'dublado' : 'legendado'),
                    isDublado: temAlgumDub,
                    isLegendado: temAlgumLeg,
                    totalEps: expectedCount
                });
            }
        } catch (e) {
            console.warn('⚠️ Erro ao verificar temporada completa para anúncio:', e.message);
        }
    }

    /**
     * Enriquece episódios que ainda estão sem thumbnail (still_url), sinopse ou com nome genérico no PostgreSQL
     */
    async enriquecerEpisodiosPendentes() {
        try {
            const seriesComEpisodios = await db.query(`
                SELECT DISTINCT s.id, s.nome, s.tmdb_id 
                FROM series s
                JOIN episodios e ON e.serie_id = s.id
                WHERE s.tmdb_id IS NOT NULL 
                  AND (e.still_url IS NULL OR e.sinopse IS NULL OR e.sinopse = '' OR e.nome LIKE 'Episódio %')
            `);

            if (!seriesComEpisodios.rows || seriesComEpisodios.rows.length === 0) return;
            console.log(`🎨 [ENRICH-EPS] Enriquecendo metadados de episódios para ${seriesComEpisodios.rows.length} séries...`);

            for (const s of seriesComEpisodios.rows) {
                const temporadasRes = await db.query(`
                    SELECT DISTINCT temporada_numero 
                    FROM episodios 
                    WHERE serie_id = $1
                `, [s.id]);

                for (const tRow of temporadasRes.rows) {
                    const tNum = tRow.temporada_numero;
                    try {
                        const seasonDetails = await TMDBService.getSeasonDetails(s.tmdb_id, tNum);
                        if (!seasonDetails || !seasonDetails.episodios) continue;

                        for (const epTmdb of seasonDetails.episodios) {
                            if (!epTmdb.numero) continue;
                            await db.query(`
                                UPDATE episodios 
                                SET 
                                    nome = CASE WHEN nome IS NULL OR nome LIKE 'Episódio %' THEN $1 ELSE nome END,
                                    sinopse = CASE WHEN sinopse IS NULL OR sinopse = '' THEN $2 ELSE sinopse END,
                                    still_url = COALESCE(still_url, $3),
                                    duracao = COALESCE(duracao, $4)
                                WHERE serie_id = $5 AND temporada_numero = $6 AND numero = $7
                            `, [
                                epTmdb.nome || `Episódio ${epTmdb.numero}`,
                                epTmdb.sinopse || '',
                                epTmdb.stillUrl || null,
                                epTmdb.duracaoMinutos || null,
                                s.id,
                                tNum,
                                epTmdb.numero
                            ]);
                        }
                    } catch (err) {
                        console.warn(`[ENRICH-EPS] Erro na temporada ${tNum} de ${s.nome}:`, err.message);
                    }
                }
            }

            console.log(`✅ [ENRICH-EPS] Metadados de episódios atualizados no PostgreSQL com sucesso.`);
        } catch (e) {
            console.warn('⚠️ [ENRICH-EPS] Erro geral:', e.message);
        }
    }
}

module.exports = CatalogoManager;