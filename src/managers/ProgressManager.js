const db = require('../database/db');

class ProgressManager {
    constructor() {
        this.cache = new Map();
    }

    async init() {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS user_watch_progress (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
                    guest_token VARCHAR(100),
                    media_id VARCHAR(100) NOT NULL,
                    media_type VARCHAR(50) NOT NULL,
                    season_num INTEGER DEFAULT 0,
                    ep_num INTEGER DEFAULT 0,
                    ep_name VARCHAR(255),
                    playback_time NUMERIC DEFAULT 0,
                    duration NUMERIC DEFAULT 0,
                    completed BOOLEAN DEFAULT false,
                    last_watched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_uq_user_watch_prog ON user_watch_progress(user_id, media_id, season_num, ep_num) WHERE user_id IS NOT NULL;
                CREATE UNIQUE INDEX IF NOT EXISTS idx_uq_guest_watch_prog ON user_watch_progress(guest_token, media_id, season_num, ep_num) WHERE guest_token IS NOT NULL;
                CREATE INDEX IF NOT EXISTS idx_watch_prog_media ON user_watch_progress(media_id);
            `);
            console.log('✅ Tabela user_watch_progress inicializada com sucesso no PostgreSQL.');
        } catch (e) {
            console.error('Erro ao inicializar tabela user_watch_progress:', e.message);
        }
    }

    async saveProgress({ userId = null, guestToken = null, mediaId, mediaType, seasonNum = 0, epNum = 0, epName = '', currentTime = 0, duration = 0, completed = false }) {
        if (!mediaId) return { success: false, error: 'mediaId ausente' };
        if (!userId && !guestToken) return { success: false, error: 'Identificador de usuário ou convidado ausente' };

        const sNum = parseInt(seasonNum, 10) || 0;
        const eNum = parseInt(epNum, 10) || 0;
        const cTime = parseFloat(currentTime) || 0;
        const dur = parseFloat(duration) || 0;
        
        // Evita falsos positivos: se o usuário abriu por menos de 30 segundos e fechou, não salva como "em andamento"
        if (!completed && cTime < 30) {
            return { success: true, ignored: true, reason: 'Playback duration too short (< 30s)' };
        }

        // Detecção inteligente de créditos / fim: se assistiu mais de 90% ou faltam menos de 90 segundos para o fim
        let isCompleted = Boolean(completed);
        if (!isCompleted && dur > 60) {
            if (cTime >= (dur * 0.90) || (dur - cTime) <= 90) {
                isCompleted = true;
            }
        }

        try {
            if (userId) {
                await db.query(`
                    INSERT INTO user_watch_progress (user_id, media_id, media_type, season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                    ON CONFLICT (user_id, media_id, season_num, ep_num) WHERE user_id IS NOT NULL
                    DO UPDATE SET
                        media_type = EXCLUDED.media_type,
                        ep_name = COALESCE(NULLIF(EXCLUDED.ep_name, ''), user_watch_progress.ep_name),
                        playback_time = EXCLUDED.playback_time,
                        duration = CASE WHEN EXCLUDED.duration > 0 THEN EXCLUDED.duration ELSE user_watch_progress.duration END,
                        completed = EXCLUDED.completed OR user_watch_progress.completed,
                        last_watched_at = NOW()
                `, [userId, String(mediaId), mediaType || 'filme', sNum, eNum, epName || '', cTime, dur, isCompleted]);
            } else {
                await db.query(`
                    INSERT INTO user_watch_progress (guest_token, media_id, media_type, season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
                    ON CONFLICT (guest_token, media_id, season_num, ep_num) WHERE guest_token IS NOT NULL
                    DO UPDATE SET
                        media_type = EXCLUDED.media_type,
                        ep_name = COALESCE(NULLIF(EXCLUDED.ep_name, ''), user_watch_progress.ep_name),
                        playback_time = EXCLUDED.playback_time,
                        duration = CASE WHEN EXCLUDED.duration > 0 THEN EXCLUDED.duration ELSE user_watch_progress.duration END,
                        completed = EXCLUDED.completed OR user_watch_progress.completed,
                        last_watched_at = NOW()
                `, [guestToken, String(mediaId), mediaType || 'filme', sNum, eNum, epName || '', cTime, dur, isCompleted]);
            }

            return {
                success: true,
                mediaId,
                seasonNum: sNum,
                epNum: eNum,
                currentTime: cTime,
                duration: dur,
                completed: isCompleted
            };
        } catch (e) {
            console.error('Erro ao salvar progresso de vídeo:', e.message);
            return { success: false, error: e.message };
        }
    }

    async toggleWatched({ userId = null, guestToken = null, mediaId, mediaType, seasonNum = 0, epNum = 0, completed = null }) {
        if (!mediaId) return { success: false, error: 'mediaId ausente' };
        const sNum = parseInt(seasonNum, 10) || 0;
        const eNum = parseInt(epNum, 10) || 0;

        try {
            let targetCompleted = completed;
            if (targetCompleted === null) {
                let current = null;
                if (userId) {
                    const r = await db.query(`SELECT completed FROM user_watch_progress WHERE user_id = $1 AND media_id = $2 AND season_num = $3 AND ep_num = $4`, [userId, String(mediaId), sNum, eNum]);
                    current = r.rows[0];
                } else if (guestToken) {
                    const r = await db.query(`SELECT completed FROM user_watch_progress WHERE guest_token = $1 AND media_id = $2 AND season_num = $3 AND ep_num = $4`, [guestToken, String(mediaId), sNum, eNum]);
                    current = r.rows[0];
                }
                targetCompleted = !(current?.completed);
            }

            if (userId) {
                await db.query(`
                    INSERT INTO user_watch_progress (user_id, media_id, media_type, season_num, ep_num, completed, playback_time, last_watched_at)
                    VALUES ($1, $2, $3, $4, $5, $6, 0, NOW())
                    ON CONFLICT (user_id, media_id, season_num, ep_num) WHERE user_id IS NOT NULL
                    DO UPDATE SET
                        completed = $6,
                        last_watched_at = NOW()
                `, [userId, String(mediaId), mediaType || 'filme', sNum, eNum, targetCompleted]);
            } else {
                await db.query(`
                    INSERT INTO user_watch_progress (guest_token, media_id, media_type, season_num, ep_num, completed, playback_time, last_watched_at)
                    VALUES ($1, $2, $3, $4, $5, $6, 0, NOW())
                    ON CONFLICT (guest_token, media_id, season_num, ep_num) WHERE guest_token IS NOT NULL
                    DO UPDATE SET
                        completed = $6,
                        last_watched_at = NOW()
                `, [guestToken, String(mediaId), mediaType || 'filme', sNum, eNum, targetCompleted]);
            }

            return {
                success: true,
                mediaId,
                seasonNum: sNum,
                epNum: eNum,
                completed: targetCompleted
            };
        } catch (e) {
            console.error('Erro ao alternar status assistido:', e.message);
            return { success: false, error: e.message };
        }
    }

    async getMediaProgress(userId = null, guestToken = null, mediaId) {
        if (!mediaId) return { success: false, items: [], lastWatched: null };
        try {
            let res;
            if (userId) {
                res = await db.query(`
                    SELECT season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at
                    FROM user_watch_progress
                    WHERE user_id = $1 AND media_id = $2
                    ORDER BY last_watched_at DESC
                `, [userId, String(mediaId)]);
            } else if (guestToken) {
                res = await db.query(`
                    SELECT season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at
                    FROM user_watch_progress
                    WHERE guest_token = $1 AND media_id = $2
                    ORDER BY last_watched_at DESC
                `, [guestToken, String(mediaId)]);
            } else {
                return { success: true, items: [], lastWatched: null };
            }

            const items = res.rows.map(r => ({
                season: parseInt(r.season_num, 10),
                episode: parseInt(r.ep_num, 10),
                epName: r.ep_name,
                currentTime: parseFloat(r.playback_time) || 0,
                duration: parseFloat(r.duration) || 0,
                completed: Boolean(r.completed),
                lastWatchedAt: r.last_watched_at
            }));

            const lastWatched = items.length > 0 ? items[0] : null;

            return {
                success: true,
                mediaId: String(mediaId),
                items,
                lastWatched
            };
        } catch (e) {
            console.error('Erro ao buscar progresso da mídia:', e.message);
            return { success: false, items: [], lastWatched: null, error: e.message };
        }
    }

    async getAllUserProgress(userId = null, guestToken = null) {
        if (!userId && !guestToken) return { success: true, progress: {} };
        try {
            let res;
            if (userId) {
                res = await db.query(`
                    SELECT media_id, media_type, season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at
                    FROM user_watch_progress
                    WHERE user_id = $1
                    ORDER BY last_watched_at DESC
                `, [userId]);
            } else {
                res = await db.query(`
                    SELECT media_id, media_type, season_num, ep_num, ep_name, playback_time, duration, completed, last_watched_at
                    FROM user_watch_progress
                    WHERE guest_token = $1
                    ORDER BY last_watched_at DESC
                `, [guestToken]);
            }

            const progress = {};
            for (const r of res.rows) {
                const mId = String(r.media_id);
                if (!progress[mId]) {
                    progress[mId] = {
                        mediaId: mId,
                        mediaType: r.media_type,
                        episodes: {},
                        lastWatched: {
                            season: parseInt(r.season_num, 10),
                            episode: parseInt(r.ep_num, 10),
                            epName: r.ep_name,
                            currentTime: parseFloat(r.playback_time) || 0,
                            duration: parseFloat(r.duration) || 0,
                            completed: Boolean(r.completed),
                            lastWatchedAt: r.last_watched_at
                        }
                    };
                }
                const key = `${r.season_num}_${r.ep_num}`;
                progress[mId].episodes[key] = {
                    season: parseInt(r.season_num, 10),
                    episode: parseInt(r.ep_num, 10),
                    currentTime: parseFloat(r.playback_time) || 0,
                    duration: parseFloat(r.duration) || 0,
                    completed: Boolean(r.completed),
                    lastWatchedAt: r.last_watched_at
                };
            }

            return { success: true, progress };
        } catch (e) {
            console.error('Erro ao buscar todo o progresso:', e.message);
            return { success: false, progress: {}, error: e.message };
        }
    }

    async dismissMediaProgress({ userId = null, guestToken = null, mediaId }) {
        if (!mediaId) return { success: false, error: 'mediaId ausente' };
        try {
            if (userId) {
                await db.query(`DELETE FROM user_watch_progress WHERE user_id = $1 AND media_id = $2`, [userId, String(mediaId)]);
            } else if (guestToken) {
                await db.query(`DELETE FROM user_watch_progress WHERE guest_token = $1 AND media_id = $2`, [guestToken, String(mediaId)]);
            }
            return { success: true, mediaId: String(mediaId) };
        } catch (e) {
            console.error('Erro ao remover progresso da mídia:', e.message);
            return { success: false, error: e.message };
        }
    }
}

module.exports = ProgressManager;
