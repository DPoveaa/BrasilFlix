const db = require('../database/db');

class AuditService {
    constructor() {
        // Safe keys sanitization
        this.sensitiveKeys = ['password', 'pass', 'hash', 'token', 'secret', 'cookie', 'authorization', 'card', 'cvv'];
    }

    // Helper: Sanitize metadata objects to prevent leaking secrets
    sanitizeMetadata(meta) {
        if (!meta || typeof meta !== 'object') return {};
        const clean = {};
        for (const [key, val] of Object.entries(meta)) {
            const lowerKey = key.toLowerCase();
            if (this.sensitiveKeys.some(s => lowerKey.includes(s))) {
                clean[key] = '[REDACTED]';
            } else if (val && typeof val === 'object' && !Array.isArray(val)) {
                clean[key] = this.sanitizeMetadata(val);
            } else {
                clean[key] = val;
            }
        }
        return clean;
    }

    // Determine identity type
    determineIdentityType(data) {
        if (data.identityType) return data.identityType;
        if (data.userId || data.user_id) return 'registered';
        if (data.telegramId || data.telegram_id) return 'telegram';
        return 'anonymous';
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 📝 LOG AUDIT EVENT (Fail-safe, non-blocking)
    // ═══════════════════════════════════════════════════════════════════════
    async logEvent(eventData = {}) {
        try {
            const identityType = this.determineIdentityType(eventData);
            const userId = eventData.userId || eventData.user_id ? parseInt(eventData.userId || eventData.user_id, 10) : null;
            const telegramId = eventData.telegramId || eventData.telegram_id ? parseInt(eventData.telegramId || eventData.telegram_id, 10) : null;
            const visitorId = eventData.visitorId || eventData.visitor_id || eventData.guestToken || null;
            const eventType = eventData.eventType || eventData.event_type || 'PAGE_VIEW';
            const source = eventData.source || 'website';
            const sessionId = eventData.sessionId || eventData.session_id || null;
            const mediaId = eventData.mediaId || eventData.media_id ? String(eventData.mediaId || eventData.media_id) : null;
            const seriesId = eventData.seriesId || eventData.series_id ? parseInt(eventData.seriesId || eventData.series_id, 10) : null;
            const seasonNum = eventData.seasonNum !== undefined && eventData.seasonNum !== null ? parseInt(eventData.seasonNum, 10) : (eventData.season !== undefined ? parseInt(eventData.season, 10) : null);
            const episodeNum = eventData.episodeNum !== undefined && eventData.episodeNum !== null ? parseInt(eventData.episodeNum, 10) : (eventData.episode !== undefined ? parseInt(eventData.episode, 10) : null);
            const title = eventData.title ? String(eventData.title).slice(0, 255) : null;
            const metadata = JSON.stringify(this.sanitizeMetadata(eventData.metadata || {}));
            const status = eventData.status || 'success';
            const error = eventData.error ? String(eventData.error).slice(0, 1000) : null;
            const timestamp = eventData.timestamp ? new Date(eventData.timestamp) : new Date();

            await db.query(`
                INSERT INTO audit_events (
                    identity_type, user_id, telegram_id, visitor_id, event_type,
                    timestamp, source, session_id, media_id, series_id,
                    season_num, episode_num, title, metadata, status, error
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            `, [
                identityType, userId, telegramId, visitorId, eventType,
                timestamp, source, sessionId, mediaId, seriesId,
                seasonNum, episodeNum, title, metadata, status, error
            ]);

            return true;
        } catch (err) {
            console.warn('⚠️ [AuditService] Erro ao registrar evento de auditoria (não-bloqueante):', err.message);
            return false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ⏱️ PLAYBACK HEARTBEAT & PROGRESS TRACKING
    // ═══════════════════════════════════════════════════════════════════════
    async recordPlaybackProgress(data = {}) {
        try {
            const sessionId = data.sessionId || `pb_${data.userId || data.telegramId || data.visitorId || 'anon'}_${data.mediaId}_${Date.now()}`;
            const identityType = this.determineIdentityType(data);
            const userId = data.userId ? parseInt(data.userId, 10) : null;
            const telegramId = data.telegramId ? parseInt(data.telegramId, 10) : null;
            const visitorId = data.visitorId || null;
            const mediaId = String(data.mediaId || '');
            const mediaType = String(data.mediaType || 'filme');
            const title = String(data.title || 'Mídia sem título');
            const seasonNum = parseInt(data.seasonNum || data.season || 0, 10);
            const episodeNum = parseInt(data.episodeNum || data.episode || 0, 10);
            const currentPosition = parseFloat(data.currentPosition || data.currentTime || 0);
            const duration = parseFloat(data.duration || 0);
            const isCompleted = Boolean(data.completed || (duration > 60 && currentPosition >= duration * 0.9));
            const platform = String(data.platform || 'website');
            const device = data.device ? String(data.device) : null;
            const ipAddress = data.ipAddress ? String(data.ipAddress) : null;

            // Busca sessão existente para calcular tempo assistido
            const existingRes = await db.query(
                `SELECT current_position, watch_time, completed FROM audit_playback_sessions WHERE id = $1`,
                [sessionId]
            );

            let watchTimeIncrement = 0;
            const isNewSession = existingRes.rows.length === 0;

            if (!isNewSession) {
                const prevPos = parseFloat(existingRes.rows[0].current_position || 0);
                const prevWatchTime = parseFloat(existingRes.rows[0].watch_time || 0);
                if (currentPosition > prevPos) {
                    watchTimeIncrement = Math.min(60, currentPosition - prevPos); // evita saltos bruscos no seek
                }
                const newWatchTime = prevWatchTime + watchTimeIncrement;

                await db.query(`
                    UPDATE audit_playback_sessions
                    SET current_position = $1,
                        duration = CASE WHEN $2 > 0 THEN $2 ELSE duration END,
                        watch_time = $3,
                        completed = completed OR $4,
                        last_heartbeat = NOW()
                    WHERE id = $5
                `, [currentPosition, duration, newWatchTime, isCompleted, sessionId]);
            } else {
                watchTimeIncrement = Math.min(30, currentPosition);
                await db.query(`
                    INSERT INTO audit_playback_sessions (
                        id, identity_type, user_id, telegram_id, visitor_id,
                        media_id, media_type, title, season_num, episode_num,
                        current_position, duration, watch_time, completed,
                        platform, device, ip_address, created_at, last_heartbeat
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), NOW())
                `, [
                    sessionId, identityType, userId, telegramId, visitorId,
                    mediaId, mediaType, title, seasonNum, episodeNum,
                    currentPosition, duration, watchTimeIncrement, isCompleted,
                    platform, device, ipAddress
                ]);

                // Loga evento PLAYBACK_STARTED
                await this.logEvent({
                    identityType, userId, telegramId, visitorId,
                    eventType: 'PLAYBACK_STARTED',
                    source: platform,
                    sessionId, mediaId, seasonNum, episodeNum, title,
                    metadata: { duration, device }
                });
            }

            if (isCompleted && (isNewSession || !existingRes.rows[0].completed)) {
                await this.logEvent({
                    identityType, userId, telegramId, visitorId,
                    eventType: 'EPISODE_COMPLETED',
                    source: platform,
                    sessionId, mediaId, seasonNum, episodeNum, title,
                    metadata: { watchTime: currentPosition, duration }
                });
            }

            return { success: true, sessionId };
        } catch (err) {
            console.warn('⚠️ [AuditService] Erro ao registrar progresso de reprodução:', err.message);
            return { success: false, error: err.message };
        }
    }

    // Helper: Parse time range parameter into SQL date condition
    parseTimeRange(range = 'today', customStart = null, customEnd = null) {
        let condition = "timestamp >= NOW() - INTERVAL '24 hours'";
        let playbackCond = "created_at >= NOW() - INTERVAL '24 hours'";

        switch (range) {
            case 'today':
                condition = "timestamp >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'";
                playbackCond = "created_at >= (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'";
                break;
            case 'yesterday':
                condition = "timestamp >= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo' AND timestamp < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'";
                playbackCond = "created_at >= ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date - INTERVAL '1 day') AT TIME ZONE 'America/Sao_Paulo' AND created_at < (CURRENT_TIMESTAMP AT TIME ZONE 'America/Sao_Paulo')::date AT TIME ZONE 'America/Sao_Paulo'";
                break;
            case '24h':
            case 'last_24h':
                condition = "timestamp >= NOW() - INTERVAL '24 hours'";
                playbackCond = "created_at >= NOW() - INTERVAL '24 hours'";
                break;
            case '7d':
            case 'last_7_days':
                condition = "timestamp >= NOW() - INTERVAL '7 days'";
                playbackCond = "created_at >= NOW() - INTERVAL '7 days'";
                break;
            case '30d':
            case 'last_30_days':
                condition = "timestamp >= NOW() - INTERVAL '30 days'";
                playbackCond = "created_at >= NOW() - INTERVAL '30 days'";
                break;
            case 'all':
            case 'all_time':
                condition = "1=1";
                playbackCond = "1=1";
                break;
            case 'custom':
                if (customStart && customEnd) {
                    condition = `timestamp >= '${new Date(customStart).toISOString()}'::timestamptz AND timestamp <= '${new Date(customEnd).toISOString()}'::timestamptz`;
                    playbackCond = `created_at >= '${new Date(customStart).toISOString()}'::timestamptz AND created_at <= '${new Date(customEnd).toISOString()}'::timestamptz`;
                }
                break;
            default:
                condition = "timestamp >= NOW() - INTERVAL '24 hours'";
                playbackCond = "created_at >= NOW() - INTERVAL '24 hours'";
                break;
        }

        return { condition, playbackCond };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 📊 TOP-LEVEL DASHBOARD METRICS
    // ═══════════════════════════════════════════════════════════════════════
    async getDashboardMetrics(timeRange = 'today', customStart = null, customEnd = null) {
        try {
            const { condition, playbackCond } = this.parseTimeRange(timeRange, customStart, customEnd);

            // Totais de Identidades
            const regUsersRes = await db.query(`SELECT COUNT(*) as count FROM usuarios`);
            const totalRegisteredUsers = parseInt(regUsersRes.rows[0]?.count || 0, 10);

            const anonVisitorsRes = await db.query(`
                SELECT COUNT(DISTINCT visitor_id) as count FROM audit_events
                WHERE visitor_id IS NOT NULL AND identity_type = 'anonymous'
            `);
            const totalAnonymousVisitors = parseInt(anonVisitorsRes.rows[0]?.count || 0, 10);

            const tgUsersRes = await db.query(`
                SELECT COUNT(DISTINCT telegram_id) as count FROM (
                    SELECT telegram_id FROM audit_events WHERE telegram_id IS NOT NULL
                    UNION
                    SELECT telegram_id FROM usuarios WHERE telegram_id IS NOT NULL
                ) u
            `);
            const totalTelegramUsers = parseInt(tgUsersRes.rows[0]?.count || 0, 10);

            // Usuários Ativos Agora (últimos 5 minutos)
            const activeNowRes = await db.query(`
                SELECT COUNT(DISTINCT COALESCE(user_id::text, telegram_id::text, visitor_id)) as count
                FROM audit_events
                WHERE timestamp >= NOW() - INTERVAL '5 minutes'
            `);
            const activeUsersNow = parseInt(activeNowRes.rows[0]?.count || 0, 10);

            // Usuários Assistindo Agora (heartbeat de reprodução nos últimos 2 minutos)
            const watchingNowRes = await db.query(`
                SELECT COUNT(DISTINCT COALESCE(user_id::text, telegram_id::text, visitor_id)) as count
                FROM audit_playback_sessions
                WHERE last_heartbeat >= NOW() - INTERVAL '2 minutes'
            `);
            const usersCurrentlyWatching = parseInt(watchingNowRes.rows[0]?.count || 0, 10);

            // Métricas no Período Selecionado
            const sessionsRes = await db.query(`
                SELECT COUNT(DISTINCT session_id) as count FROM audit_events
                WHERE session_id IS NOT NULL AND ${condition}
            `);
            const sessionsCount = parseInt(sessionsRes.rows[0]?.count || 0, 10);

            const newRegsRes = await db.query(`
                SELECT COUNT(*) as count FROM usuarios WHERE ${playbackCond}
            `);
            const newRegistrationsCount = parseInt(newRegsRes.rows[0]?.count || 0, 10);

            const playbackStartsRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events
                WHERE event_type = 'PLAYBACK_STARTED' AND ${condition}
            `);
            const playbackStartsCount = parseInt(playbackStartsRes.rows[0]?.count || 0, 10);

            const completedEpisRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events
                WHERE event_type IN ('EPISODE_COMPLETED', 'MOVIE_COMPLETED') AND ${condition}
            `);
            const completedEpisodesCount = parseInt(completedEpisRes.rows[0]?.count || 0, 10);

            const favoritesRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events
                WHERE event_type = 'FAVORITE_ADDED' AND ${condition}
            `);
            const favoritesCount = parseInt(favoritesRes.rows[0]?.count || 0, 10);

            const requestsRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events
                WHERE event_type = 'REQUEST_CREATED' AND ${condition}
            `);
            const contentRequestsCount = parseInt(requestsRes.rows[0]?.count || 0, 10);

            const searchesRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events
                WHERE event_type IN ('SEARCH', 'TELEGRAM_SEARCH') AND ${condition}
            `);
            const searchesCount = parseInt(searchesRes.rows[0]?.count || 0, 10);

            const watchTimeRes = await db.query(`
                SELECT COALESCE(SUM(watch_time), 0) as total_seconds FROM audit_playback_sessions
                WHERE ${playbackCond}
            `);
            const totalWatchTimeSeconds = parseFloat(watchTimeRes.rows[0]?.total_seconds || 0);

            const webActivityRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events WHERE source = 'website' AND ${condition}
            `);
            const websiteActivityCount = parseInt(webActivityRes.rows[0]?.count || 0, 10);

            const tgActivityRes = await db.query(`
                SELECT COUNT(*) as count FROM audit_events WHERE source = 'telegram' AND ${condition}
            `);
            const telegramActivityCount = parseInt(tgActivityRes.rows[0]?.count || 0, 10);

            return {
                timeRange,
                totalRegisteredUsers,
                totalAnonymousVisitors,
                totalTelegramUsers,
                activeUsersNow,
                usersCurrentlyWatching,
                sessionsInPeriod: sessionsCount,
                newRegistrationsInPeriod: newRegistrationsCount,
                playbackStartsInPeriod: playbackStartsCount,
                completedEpisodesInPeriod: completedEpisodesCount,
                favoritesInPeriod: favoritesCount,
                requestsInPeriod: contentRequestsCount,
                searchesInPeriod: searchesCount,
                totalWatchTimeSeconds,
                totalWatchTimeFormatted: this.formatDuration(totalWatchTimeSeconds),
                websiteActivity: websiteActivityCount,
                telegramActivity: telegramActivityCount
            };
        } catch (err) {
            console.error('Erro ao buscar métricas de auditoria:', err.message);
            throw err;
        }
    }

    // Helper: Formata segundos em HH:MM:SS
    formatDuration(seconds) {
        const secs = Math.floor(seconds || 0);
        const hours = Math.floor(secs / 3600);
        const mins = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        if (hours > 0) {
            return `${hours}h ${mins}m`;
        }
        return `${mins}m ${s}s`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 👥 CUSTOMER / PERSON LIST
    // ═══════════════════════════════════════════════════════════════════════
    async getPersonList(filters = {}, pagination = { page: 1, limit: 20 }) {
        try {
            const page = Math.max(1, parseInt(pagination.page || 1, 10));
            const limit = Math.max(1, Math.min(100, parseInt(pagination.limit || 20, 10)));
            const offset = (page - 1) * limit;

            const search = (filters.search || '').trim().toLowerCase();
            const platformFilter = filters.platform || 'all'; // 'website' | 'telegram' | 'anonymous' | 'registered'
            const statusFilter = filters.status || 'all'; // 'active_now' | 'watching_now' | 'recent' | 'inactive'

            // Query base de consolidação de identidades no PostgreSQL
            const baseQuery = `
                WITH consolidated_identities AS (
                    -- 1. Usuários Registrados
                    SELECT
                        'registered' AS identity_type,
                        u.id AS user_id,
                        u.telegram_id AS telegram_id,
                        NULL::text AS visitor_id,
                        COALESCE(u.username, u.email, 'Usuário #' || u.id) AS name,
                        u.email AS email,
                        u.username AS username,
                        CASE WHEN u.telegram_id IS NOT NULL THEN 'both' ELSE 'website' END AS platform,
                        u.created_at AS first_seen,
                        COALESCE(e.last_act, u.updated_at, u.created_at) AS last_activity,
                        COALESCE(e.sessions_cnt, 0) AS sessions_count,
                        COALESCE(pb.watch_sec, 0) AS watch_time_sec,
                        COALESCE(pb.plays_cnt, 0) AS plays_count,
                        COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(u.favoritos) = 'array' THEN u.favoritos ELSE '[]'::jsonb END), fav.fav_cnt, 0) AS favorites_count,
                        COALESCE(req.req_cnt, 0) AS requests_count,
                        pb_live.current_title AS current_title,
                        pb_live.current_ep AS current_ep,
                        pb_live.last_heartbeat AS last_heartbeat
                    FROM usuarios u
                    LEFT JOIN (
                        SELECT user_id, MAX(timestamp) as last_act, COUNT(DISTINCT session_id) as sessions_cnt
                        FROM audit_events WHERE user_id IS NOT NULL GROUP BY user_id
                    ) e ON e.user_id = u.id
                    LEFT JOIN (
                        SELECT user_id, SUM(watch_time) as watch_sec, COUNT(*) as plays_cnt
                        FROM audit_playback_sessions WHERE user_id IS NOT NULL GROUP BY user_id
                    ) pb ON pb.user_id = u.id
                    LEFT JOIN (
                        SELECT user_id, COUNT(*) as fav_cnt FROM favoritos GROUP BY user_id
                    ) fav ON fav.user_id = u.id
                    LEFT JOIN (
                        SELECT user_id, COUNT(*) as req_cnt FROM pedidos GROUP BY user_id
                    ) req ON req.user_id = u.id
                    LEFT JOIN (
                        SELECT DISTINCT ON (user_id) user_id, title as current_title,
                               CASE WHEN season_num > 0 THEN 'T' || season_num || 'E' || episode_num ELSE '' END as current_ep,
                               last_heartbeat
                        FROM audit_playback_sessions WHERE user_id IS NOT NULL ORDER BY user_id, last_heartbeat DESC
                    ) pb_live ON pb_live.user_id = u.id

                    UNION ALL

                    -- 2. Usuários Telegram Exclusivos (sem conta no site)
                    SELECT
                        'telegram' AS identity_type,
                        NULL::bigint AS user_id,
                        tg.telegram_id AS telegram_id,
                        NULL::text AS visitor_id,
                        'Telegram @' || COALESCE(tg.tg_username, tg.telegram_id::text) AS name,
                        NULL::text AS email,
                        tg.tg_username AS username,
                        'telegram' AS platform,
                        tg.first_seen AS first_seen,
                        tg.last_act AS last_activity,
                        tg.sessions_cnt AS sessions_count,
                        COALESCE(pb.watch_sec, 0) AS watch_time_sec,
                        COALESCE(pb.plays_cnt, 0) AS plays_count,
                        0 AS favorites_count,
                        COALESCE(req.req_cnt, 0) AS requests_count,
                        pb_live.current_title AS current_title,
                        pb_live.current_ep AS current_ep,
                        pb_live.last_heartbeat AS last_heartbeat
                    FROM (
                        SELECT telegram_id,
                               MAX(metadata->>'username') as tg_username,
                               MIN(timestamp) as first_seen,
                               MAX(timestamp) as last_act,
                               COUNT(DISTINCT session_id) as sessions_cnt
                        FROM audit_events
                        WHERE telegram_id IS NOT NULL
                          AND user_id IS NULL
                        GROUP BY telegram_id
                    ) tg
                    LEFT JOIN (
                        SELECT telegram_id, SUM(watch_time) as watch_sec, COUNT(*) as plays_cnt
                        FROM audit_playback_sessions WHERE telegram_id IS NOT NULL AND user_id IS NULL GROUP BY telegram_id
                    ) pb ON pb.telegram_id = tg.telegram_id
                    LEFT JOIN (
                        SELECT user_id, COUNT(*) as req_cnt FROM pedidos GROUP BY user_id
                    ) req ON req.user_id = tg.telegram_id
                    LEFT JOIN (
                        SELECT DISTINCT ON (telegram_id) telegram_id, title as current_title,
                               CASE WHEN season_num > 0 THEN 'T' || season_num || 'E' || episode_num ELSE '' END as current_ep,
                               last_heartbeat
                        FROM audit_playback_sessions WHERE telegram_id IS NOT NULL AND user_id IS NULL ORDER BY telegram_id, last_heartbeat DESC
                    ) pb_live ON pb_live.telegram_id = tg.telegram_id

                    UNION ALL

                    -- 3. Visitantes Anônimos do Site
                    SELECT
                        'anonymous' AS identity_type,
                        NULL::bigint AS user_id,
                        NULL::bigint AS telegram_id,
                        anon.visitor_id AS visitor_id,
                        'Visitante #' || SUBSTRING(anon.visitor_id, 1, 8) AS name,
                        NULL::text AS email,
                        NULL::text AS username,
                        'website' AS platform,
                        anon.first_seen AS first_seen,
                        anon.last_act AS last_activity,
                        anon.sessions_cnt AS sessions_count,
                        COALESCE(pb.watch_sec, 0) AS watch_time_sec,
                        COALESCE(pb.plays_cnt, 0) AS plays_count,
                        0 AS favorites_count,
                        0 AS requests_count,
                        pb_live.current_title AS current_title,
                        pb_live.current_ep AS current_ep,
                        pb_live.last_heartbeat AS last_heartbeat
                    FROM (
                        SELECT visitor_id,
                               MIN(timestamp) as first_seen,
                               MAX(timestamp) as last_act,
                               COUNT(DISTINCT session_id) as sessions_cnt
                        FROM audit_events
                        WHERE visitor_id IS NOT NULL
                          AND user_id IS NULL
                          AND telegram_id IS NULL
                        GROUP BY visitor_id
                    ) anon
                    LEFT JOIN (
                        SELECT visitor_id, SUM(watch_time) as watch_sec, COUNT(*) as plays_cnt
                        FROM audit_playback_sessions WHERE visitor_id IS NOT NULL AND user_id IS NULL GROUP BY visitor_id
                    ) pb ON pb.visitor_id = anon.visitor_id
                    LEFT JOIN (
                        SELECT DISTINCT ON (visitor_id) visitor_id, title as current_title,
                               CASE WHEN season_num > 0 THEN 'T' || season_num || 'E' || episode_num ELSE '' END as current_ep,
                               last_heartbeat
                        FROM audit_playback_sessions WHERE visitor_id IS NOT NULL AND user_id IS NULL ORDER BY visitor_id, last_heartbeat DESC
                    ) pb_live ON pb_live.visitor_id = anon.visitor_id
                )
            `;

            // Condições de filtro
            let whereClause = [];
            let params = [];
            let pIdx = 1;

            if (search) {
                whereClause.push(`(LOWER(name) LIKE $${pIdx} OR LOWER(COALESCE(email, '')) LIKE $${pIdx} OR LOWER(COALESCE(username, '')) LIKE $${pIdx} OR LOWER(COALESCE(visitor_id, '')) LIKE $${pIdx} OR telegram_id::text LIKE $${pIdx})`);
                params.push(`%${search}%`);
                pIdx++;
            }

            if (platformFilter !== 'all') {
                if (platformFilter === 'website') {
                    whereClause.push(`platform IN ('website', 'both')`);
                } else if (platformFilter === 'telegram') {
                    whereClause.push(`platform IN ('telegram', 'both')`);
                } else if (platformFilter === 'anonymous') {
                    whereClause.push(`identity_type = 'anonymous'`);
                } else if (platformFilter === 'registered') {
                    whereClause.push(`identity_type = 'registered'`);
                }
            }

            if (statusFilter !== 'all') {
                if (statusFilter === 'active_now') {
                    whereClause.push(`last_activity >= NOW() - INTERVAL '5 minutes'`);
                } else if (statusFilter === 'watching_now') {
                    whereClause.push(`last_heartbeat >= NOW() - INTERVAL '2 minutes'`);
                } else if (statusFilter === 'recent') {
                    whereClause.push(`last_activity >= NOW() - INTERVAL '24 hours'`);
                } else if (statusFilter === 'inactive') {
                    whereClause.push(`last_activity < NOW() - INTERVAL '24 hours'`);
                }
            }

            const whereStr = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

            // Contagem total
            const countSql = `${baseQuery} SELECT COUNT(*) as total FROM consolidated_identities ${whereStr}`;
            const countRes = await db.query(countSql, params);
            const totalItems = parseInt(countRes.rows[0]?.total || 0, 10);
            const totalPages = Math.ceil(totalItems / limit) || 1;

            // Busca paginada
            const dataSql = `
                ${baseQuery}
                SELECT * FROM consolidated_identities
                ${whereStr}
                ORDER BY last_activity DESC
                LIMIT $${pIdx++} OFFSET $${pIdx++}
            `;
            params.push(limit, offset);

            const dataRes = await db.query(dataSql, params);

            const now = new Date();
            const items = dataRes.rows.map(r => {
                const lastAct = r.last_activity ? new Date(r.last_activity) : null;
                const lastHb = r.last_heartbeat ? new Date(r.last_heartbeat) : null;

                let status = 'INACTIVE';
                if (lastHb && (now - lastHb) <= 2 * 60 * 1000) {
                    status = 'WATCHING';
                } else if (lastAct && (now - lastAct) <= 5 * 60 * 1000) {
                    status = 'ACTIVE NOW';
                } else if (lastAct && (now - lastAct) <= 24 * 60 * 60 * 1000) {
                    status = 'RECENT';
                } else if (!lastAct) {
                    status = 'NEVER ACTIVE AGAIN';
                }

                const identityKey = r.user_id ? `user_${r.user_id}` : (r.telegram_id ? `tg_${r.telegram_id}` : `anon_${r.visitor_id}`);

                return {
                    identityKey,
                    identityType: r.identity_type,
                    userId: r.user_id ? String(r.user_id) : null,
                    telegramId: r.telegram_id ? String(r.telegram_id) : null,
                    visitorId: r.visitor_id || null,
                    name: r.name,
                    email: r.email,
                    username: r.username,
                    platform: r.platform,
                    firstSeen: r.first_seen,
                    lastActivity: r.last_activity,
                    status,
                    currentActivity: {
                        isWatching: status === 'WATCHING',
                        currentTitle: r.current_title || null,
                        currentEp: r.current_ep || null,
                        lastHeartbeat: r.last_heartbeat || null
                    },
                    sessionsCount: parseInt(r.sessions_count || 0, 10),
                    watchTimeSeconds: parseFloat(r.watch_time_sec || 0),
                    watchTimeFormatted: this.formatDuration(r.watch_time_sec),
                    playsCount: parseInt(r.plays_count || 0, 10),
                    favoritesCount: parseInt(r.favorites_count || 0, 10),
                    requestsCount: parseInt(r.requests_count || 0, 10)
                };
            });

            return {
                items,
                pagination: {
                    page,
                    limit,
                    totalItems,
                    totalPages
                }
            };
        } catch (err) {
            console.error('Erro ao listar pessoas no audit:', err.message);
            return { items: [], pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 1 } };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 👤 INDIVIDUAL AUDIT PROFILE
    // ═══════════════════════════════════════════════════════════════════════
    async getPersonProfile(identityId, identityType = 'registered') {
        try {
            let userId = null;
            let telegramId = null;
            let visitorId = null;

            if (identityId.startsWith('user_')) {
                userId = parseInt(identityId.replace('user_', ''), 10);
            } else if (identityId.startsWith('tg_')) {
                telegramId = parseInt(identityId.replace('tg_', ''), 10);
            } else if (identityId.startsWith('anon_')) {
                visitorId = identityId.replace('anon_', '');
            } else if (identityType === 'registered' && !isNaN(identityId)) {
                userId = parseInt(identityId, 10);
            } else if (identityType === 'telegram' && !isNaN(identityId)) {
                telegramId = parseInt(identityId, 10);
            } else {
                visitorId = identityId;
            }

            // 1. Dados de Identidade
            let identityInfo = {
                identityKey: identityId,
                identityType,
                userId,
                telegramId,
                visitorId,
                name: 'Cliente Desconhecido',
                email: null,
                username: null,
                platform: 'website',
                accountCreation: null,
                firstActivity: null,
                lastActivity: null,
                linkedIdentities: []
            };

            if (userId) {
                const uRes = await db.query(`SELECT * FROM usuarios WHERE id = $1`, [userId]);
                if (uRes.rows.length > 0) {
                    const u = uRes.rows[0];
                    identityInfo.name = u.username || u.email || `Usuário #${u.id}`;
                    identityInfo.email = u.email;
                    identityInfo.username = u.username;
                    identityInfo.telegramId = u.telegram_id;
                    identityInfo.accountCreation = u.created_at;
                    identityInfo.platform = u.telegram_id ? 'both' : 'website';

                    if (u.telegram_id) {
                        identityInfo.linkedIdentities.push({
                            type: 'telegram',
                            id: u.telegram_id,
                            verified: true
                        });
                    }
                }
            } else if (telegramId) {
                identityInfo.name = `Telegram ID ${telegramId}`;
                identityInfo.platform = 'telegram';

                // Verifica se tem conta vinculada na tabela usuarios
                const uTg = await db.query(`SELECT * FROM usuarios WHERE telegram_id = $1`, [telegramId]);
                if (uTg.rows.length > 0) {
                    const u = uTg.rows[0];
                    identityInfo.userId = u.id;
                    identityInfo.linkedIdentities.push({
                        type: 'registered',
                        id: u.id,
                        name: u.username || u.email,
                        verified: true
                    });
                }
            } else if (visitorId) {
                identityInfo.name = `Visitante Anônimo #${visitorId.slice(0, 8)}`;
                identityInfo.platform = 'website';
            }

            // Cláusula SQL para busca por identidades
            let idCond = "1=0";
            let params = [];
            if (userId) {
                idCond = "user_id = $1";
                params.push(userId);
            } else if (telegramId) {
                idCond = "telegram_id = $1";
                params.push(telegramId);
            } else if (visitorId) {
                idCond = "visitor_id = $1";
                params.push(visitorId);
            }

            // Primeiras e Últimas Atividades
            const actDatesRes = await db.query(`
                SELECT MIN(timestamp) as first_act, MAX(timestamp) as last_act, COUNT(DISTINCT session_id) as sessions_cnt
                FROM audit_events WHERE ${idCond}
            `, params);

            identityInfo.firstActivity = actDatesRes.rows[0]?.first_act || identityInfo.accountCreation;
            identityInfo.lastActivity = actDatesRes.rows[0]?.last_act || identityInfo.accountCreation;

            // 2. Resumo de Atividade
            const statsRes = await db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE event_type = 'PLAYBACK_STARTED') as plays_cnt,
                    COUNT(*) FILTER (WHERE event_type IN ('EPISODE_COMPLETED', 'MOVIE_COMPLETED')) as completed_cnt,
                    COUNT(*) FILTER (WHERE event_type = 'FAVORITE_ADDED') as fav_cnt,
                    COUNT(*) FILTER (WHERE event_type IN ('SEARCH', 'TELEGRAM_SEARCH')) as search_cnt,
                    COUNT(*) FILTER (WHERE event_type = 'REQUEST_CREATED') as req_cnt,
                    COUNT(*) FILTER (WHERE event_type = 'RATING_SUBMITTED') as review_cnt,
                    COUNT(*) FILTER (WHERE event_type = 'TITLE_OPENED') as title_open_cnt
                FROM audit_events WHERE ${idCond}
            `, params);

            const st = statsRes.rows[0] || {};

            const watchTimeRes = await db.query(`
                SELECT COALESCE(SUM(watch_time), 0) as total_sec FROM audit_playback_sessions WHERE ${idCond}
            `, params);
            const totalWatchTimeSeconds = parseFloat(watchTimeRes.rows[0]?.total_sec || 0);

            // Último e mais assistido título
            const lastWatchedRes = await db.query(`
                SELECT title FROM audit_playback_sessions WHERE ${idCond} ORDER BY last_heartbeat DESC LIMIT 1
            `, params);
            const lastWatchedTitle = lastWatchedRes.rows[0]?.title || null;

            const mostWatchedRes = await db.query(`
                SELECT title, SUM(watch_time) as total_time FROM audit_playback_sessions
                WHERE ${idCond} GROUP BY title ORDER BY total_time DESC LIMIT 1
            `, params);
            const mostWatchedTitle = mostWatchedRes.rows[0]?.title || null;

            const activitySummary = {
                totalSessions: parseInt(actDatesRes.rows[0]?.sessions_cnt || 0, 10),
                totalWatchTimeSeconds,
                totalWatchTimeFormatted: this.formatDuration(totalWatchTimeSeconds),
                titlesOpened: parseInt(st.title_open_cnt || 0, 10),
                playbackStarts: parseInt(st.plays_cnt || 0, 10),
                completedEpisodes: parseInt(st.completed_cnt || 0, 10),
                favoritesCount: parseInt(st.fav_cnt || 0, 10),
                searchesCount: parseInt(st.search_cnt || 0, 10),
                requestsCount: parseInt(st.req_cnt || 0, 10),
                reviewsCount: parseInt(st.review_cnt || 0, 10),
                lastWatchedTitle,
                mostWatchedTitle
            };

            // 3. Atividade Atual
            const liveRes = await db.query(`
                SELECT title, season_num, episode_num, current_position, duration, last_heartbeat, platform
                FROM audit_playback_sessions WHERE ${idCond} ORDER BY last_heartbeat DESC LIMIT 1
            `, params);

            const liveRow = liveRes.rows[0];
            const now = new Date();
            const lastHb = liveRow?.last_heartbeat ? new Date(liveRow.last_heartbeat) : null;
            const isWatching = lastHb && (now - lastHb) <= 2 * 60 * 1000;

            const currentActivity = {
                onlineStatus: isWatching ? 'WATCHING' : ((lastHb && (now - lastHb) <= 5 * 60 * 1000) ? 'ACTIVE' : 'OFFLINE'),
                currentlyWatching: isWatching,
                title: liveRow?.title || null,
                seasonNum: liveRow?.season_num || 0,
                episodeNum: liveRow?.episode_num || 0,
                currentPosition: liveRow?.current_position || 0,
                duration: liveRow?.duration || 0,
                lastHeartbeat: liveRow?.last_heartbeat || null,
                platform: liveRow?.platform || 'website'
            };

            // 4. Histórico de Reprodução
            const watchHistRes = await db.query(`
                SELECT title, season_num, episode_num, created_at, last_heartbeat, current_position, duration, watch_time, completed, platform
                FROM audit_playback_sessions WHERE ${idCond} ORDER BY last_heartbeat DESC LIMIT 30
            `, params);

            const watchHistory = watchHistRes.rows.map(r => ({
                title: r.title,
                seasonNum: r.season_num,
                episodeNum: r.episode_num,
                startedAt: r.created_at,
                lastWatchedAt: r.last_heartbeat,
                currentPosition: parseFloat(r.current_position || 0),
                duration: parseFloat(r.duration || 0),
                progressPercentage: r.duration > 0 ? Math.min(100, Math.round((r.current_position / r.duration) * 100)) : 0,
                completed: Boolean(r.completed),
                watchTimeFormatted: this.formatDuration(r.watch_time),
                platform: r.platform
            }));

            // 5. Favoritos
            let favorites = [];
            if (userId) {
                const uFavRes = await db.query(`SELECT favoritos FROM usuarios WHERE id = $1`, [userId]);
                if (uFavRes.rows.length > 0 && Array.isArray(uFavRes.rows[0].favoritos)) {
                    favorites = uFavRes.rows[0].favoritos.map(f => ({
                        title: f.title || f.nome || `Mídia #${f.id}`,
                        type: f.type || 'filme',
                        addedAt: f.addedAt || new Date().toISOString(),
                        state: 'active'
                    }));
                }
                if (favorites.length === 0) {
                    const favRes = await db.query(`
                        SELECT f.id, f.item_id, f.tipo, f.created_at,
                               COALESCE(flm.nome, s.nome, f.item_id::text) as title
                        FROM favoritos f
                        LEFT JOIN filmes flm ON f.tipo = 'filme' AND flm.id = f.item_id
                        LEFT JOIN series s ON (f.tipo = 'serie' OR f.tipo = 'dorama' OR f.tipo = 'anime') AND s.id = f.item_id
                        WHERE f.user_id = $1 ORDER BY f.created_at DESC
                    `, [userId]);
                    favorites = favRes.rows.map(r => ({
                        title: r.title,
                        type: r.tipo,
                        addedAt: r.created_at,
                        state: 'active'
                    }));
                }
            }

            // 6. Histórico de Buscas
            const searchesRes = await db.query(`
                SELECT title as query, timestamp, source as platform, metadata->>'resultsCount' as results_count, metadata->>'selectedResult' as selected_result
                FROM audit_events WHERE ${idCond} AND event_type IN ('SEARCH', 'TELEGRAM_SEARCH')
                ORDER BY timestamp DESC LIMIT 30
            `, params);

            const searchHistory = searchesRes.rows.map(r => ({
                query: r.query,
                timestamp: r.timestamp,
                platform: r.platform,
                resultsCount: parseInt(r.results_count || 0, 10),
                selectedResult: r.selected_result || null
            }));

            // 7. Pedidos
            let requests = [];
            if (userId || telegramId) {
                const reqRes = await db.query(`
                    SELECT nome as title, tipo, created_at, status FROM pedidos
                    WHERE user_id = $1 OR user_id = $2 ORDER BY created_at DESC LIMIT 20
                `, [userId || 0, telegramId || 0]);
                requests = reqRes.rows.map(r => ({
                    title: r.title,
                    type: r.tipo,
                    createdAt: r.created_at,
                    status: r.status
                }));
            }

            // 8. Avaliações / Reviews
            let reviews = [];
            if (userId) {
                const revRes = await db.query(`
                    SELECT media_title, rating, comentario, created_at FROM avaliacoes_comentarios
                    WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20
                `, [userId]);
                reviews = revRes.rows.map(r => ({
                    title: r.media_title || 'Mídia',
                    rating: r.rating,
                    comment: r.comentario,
                    createdAt: r.created_at
                }));
            }

            return {
                identity: identityInfo,
                activitySummary,
                currentActivity,
                watchHistory,
                favorites,
                searchHistory,
                requests,
                reviews
            };
        } catch (err) {
            console.error('Erro ao buscar perfil individual do audit:', err.message);
            throw err;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 📜 CHRONOLOGICAL ACTIVITY TIMELINE
    // ═══════════════════════════════════════════════════════════════════════
    async getPersonTimeline(identityId, identityType, filters = {}, pagination = { page: 1, limit: 30 }) {
        try {
            const page = Math.max(1, parseInt(pagination.page || 1, 10));
            const limit = Math.max(1, Math.min(100, parseInt(pagination.limit || 30, 10)));
            const offset = (page - 1) * limit;

            let userId = null;
            let telegramId = null;
            let visitorId = null;

            if (identityId.startsWith('user_')) userId = parseInt(identityId.replace('user_', ''), 10);
            else if (identityId.startsWith('tg_')) telegramId = parseInt(identityId.replace('tg_', ''), 10);
            else if (identityId.startsWith('anon_')) visitorId = identityId.replace('anon_', '');
            else if (identityType === 'registered' && !isNaN(identityId)) userId = parseInt(identityId, 10);
            else if (identityType === 'telegram' && !isNaN(identityId)) telegramId = parseInt(identityId, 10);
            else visitorId = identityId;

            let whereClause = [];
            let params = [];
            let pIdx = 1;

            if (userId) {
                whereClause.push(`user_id = $${pIdx++}`);
                params.push(userId);
            } else if (telegramId) {
                whereClause.push(`telegram_id = $${pIdx++}`);
                params.push(telegramId);
            } else if (visitorId) {
                whereClause.push(`visitor_id = $${pIdx++}`);
                params.push(visitorId);
            }

            if (filters.platform && filters.platform !== 'all') {
                whereClause.push(`source = $${pIdx++}`);
                params.push(filters.platform);
            }

            if (filters.eventType && filters.eventType !== 'all') {
                whereClause.push(`event_type = $${pIdx++}`);
                params.push(filters.eventType);
            }

            if (filters.search) {
                whereClause.push(`LOWER(COALESCE(title, event_type)) LIKE $${pIdx++}`);
                params.push(`%${filters.search.toLowerCase()}%`);
            }

            const whereStr = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';

            // Total
            const countRes = await db.query(`SELECT COUNT(*) as total FROM audit_events ${whereStr}`, params);
            const totalItems = parseInt(countRes.rows[0]?.total || 0, 10);
            const totalPages = Math.ceil(totalItems / limit) || 1;

            // Busca paginada
            const eventsRes = await db.query(`
                SELECT id, identity_type, user_id, telegram_id, visitor_id, event_type, timestamp, source, session_id, media_id, season_num, episode_num, title, metadata, status, error
                FROM audit_events
                ${whereStr}
                ORDER BY timestamp DESC
                LIMIT $${pIdx++} OFFSET $${pIdx++}
            `, [...params, limit, offset]);

            const events = eventsRes.rows.map(r => ({
                id: String(r.id),
                eventType: r.event_type,
                timestamp: r.timestamp,
                source: r.source,
                sessionId: r.session_id,
                mediaId: r.media_id,
                seasonNum: r.season_num,
                episodeNum: r.episode_num,
                title: r.title || r.event_type,
                metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {}),
                status: r.status,
                error: r.error
            }));

            return {
                events,
                pagination: {
                    page,
                    limit,
                    totalItems,
                    totalPages
                }
            };
        } catch (err) {
            console.error('Erro ao buscar linha do tempo do audit:', err.message);
            return { events: [], pagination: { page: 1, limit: 30, totalItems: 0, totalPages: 1 } };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 📈 CONTENT ANALYTICS & SEARCH/NO-RESULT ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════
    async getContentAnalytics(timeRange = 'today', customStart = null, customEnd = null) {
        try {
            const { condition, playbackCond } = this.parseTimeRange(timeRange, customStart, customEnd);

            // 1. Mais Assistidos
            const mostWatchedRes = await db.query(`
                SELECT title, media_id, media_type, COUNT(*) as play_count, SUM(watch_time) as total_watch_time
                FROM audit_playback_sessions
                WHERE ${playbackCond}
                GROUP BY title, media_id, media_type
                ORDER BY total_watch_time DESC LIMIT 15
            `);

            const mostWatched = mostWatchedRes.rows.map(r => ({
                title: r.title,
                mediaId: r.media_id,
                mediaType: r.media_type,
                playCount: parseInt(r.play_count || 0, 10),
                totalWatchTimeFormatted: this.formatDuration(r.total_watch_time)
            }));

            // 2. Termos mais buscados
            const mostSearchedRes = await db.query(`
                SELECT title as query, COUNT(*) as search_count,
                       COUNT(*) FILTER (WHERE metadata->>'resultsCount' = '0') as no_results_count
                FROM audit_events
                WHERE event_type IN ('SEARCH', 'TELEGRAM_SEARCH') AND ${condition}
                GROUP BY title
                ORDER BY search_count DESC LIMIT 15
            `);

            const mostSearched = mostSearchedRes.rows.map(r => ({
                query: r.query,
                searchCount: parseInt(r.search_count || 0, 10),
                noResultsCount: parseInt(r.no_results_count || 0, 10)
            }));

            // 3. Buscas com 0 Resultados (Conteúdo Faltante Demandado)
            const noResultsRes = await db.query(`
                SELECT title as query, COUNT(*) as count,
                       MAX(timestamp) as last_searched,
                       STRING_AGG(DISTINCT source, ', ') as platforms
                FROM audit_events
                WHERE event_type IN ('SEARCH', 'TELEGRAM_SEARCH')
                  AND metadata->>'resultsCount' = '0'
                  AND ${condition}
                GROUP BY title
                ORDER BY count DESC LIMIT 20
            `);

            const noResultSearches = noResultsRes.rows.map(r => ({
                query: r.query,
                count: parseInt(r.count || 0, 10),
                lastSearched: r.last_searched,
                platforms: r.platforms
            }));

            // 4. Mais Favoritados
            const mostFavoritedRes = await db.query(`
                SELECT title, COUNT(*) as fav_count
                FROM audit_events
                WHERE event_type = 'FAVORITE_ADDED' AND ${condition}
                GROUP BY title ORDER BY fav_count DESC LIMIT 10
            `);

            const mostFavorited = mostFavoritedRes.rows.map(r => ({
                title: r.title,
                favCount: parseInt(r.fav_count || 0, 10)
            }));

            // 5. Mais Solicitados (Pedidos)
            const mostRequestedRes = await db.query(`
                SELECT title, COUNT(*) as req_count
                FROM audit_events
                WHERE event_type = 'REQUEST_CREATED' AND ${condition}
                GROUP BY title ORDER BY req_count DESC LIMIT 10
            `);

            const mostRequested = mostRequestedRes.rows.map(r => ({
                title: r.title,
                reqCount: parseInt(r.req_count || 0, 10)
            }));

            // 6. Taxa de Abandono (Iniciados vs Completados)
            const abandonmentRes = await db.query(`
                SELECT title,
                       COUNT(*) as total_starts,
                       COUNT(*) FILTER (WHERE completed = true) as total_completes,
                       ROUND((1.0 - (COUNT(*) FILTER (WHERE completed = true)::numeric / GREATEST(COUNT(*), 1))) * 100, 1) as abandonment_rate
                FROM audit_playback_sessions
                WHERE ${playbackCond}
                GROUP BY title
                HAVING COUNT(*) >= 2
                ORDER BY abandonment_rate DESC LIMIT 10
            `);

            const abandonment = abandonmentRes.rows.map(r => ({
                title: r.title,
                starts: parseInt(r.total_starts || 0, 10),
                completes: parseInt(r.total_completes || 0, 10),
                abandonmentRate: `${r.abandonment_rate}%`
            }));

            return {
                mostWatched,
                mostSearched,
                noResultSearches,
                mostFavorited,
                mostRequested,
                abandonment
            };
        } catch (err) {
            console.error('Erro ao buscar métricas de conteúdo do audit:', err.message);
            throw err;
        }
    }
}

module.exports = new AuditService();
