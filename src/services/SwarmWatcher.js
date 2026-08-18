const db = require('../database/db');
const MediaSearchService = require('./MediaSearchService');
const PRIORITIES = {
    VIP_USER: 1,
    USER: 2,
    NEW_RELEASE: 3,
    FEEDER: 4
};

class SwarmWatcher {
    constructor() {
        this.queueManager = null;
        this.catalogoManager = null;
        this.isChecking = false;
    }

    init(queueManager, catalogoManager) {
        this.queueManager = queueManager;
        this.catalogoManager = catalogoManager;
    }

    /**
     * Adiciona ou atualiza um item na lista de observação de sementes (watchlist)
     */
    async addToWatchlist(item = {}) {
        const title = (item.title || item.nome || '').trim();
        if (!title) return false;

        const type = item.type || 'filme';
        const season = item.season || null;
        const episode = item.episode || null;
        const audioPreference = item.audioPreference || 'dublado';
        const tmdbId = item.tmdbId || null;
        const imdbId = item.imdbId || null;
        const userId = item.userId ? Number(item.userId) : null;
        const username = item.username || null;
        const reason = item.reason || 'no_seeders';

        try {
            // Verifica se já existe um registro idêntico na watchlist
            const checkQuery = `
                SELECT id FROM swarm_watchlist 
                WHERE LOWER(title) = LOWER($1) 
                  AND type = $2 
                  AND (season = $3 OR (season IS NULL AND $3 IS NULL))
                  AND (episode = $4 OR (episode IS NULL AND $4 IS NULL))
                  AND audio_preference = $5
            `;
            const checkRes = await db.query(checkQuery, [title, type, season, episode, audioPreference]);

            if (checkRes.rows.length > 0) {
                // Atualiza contagem e última verificação
                await db.query(`
                    UPDATE swarm_watchlist 
                    SET check_count = check_count + 1, last_checked = NOW()
                    WHERE id = $1
                `, [checkRes.rows[0].id]);
            } else {
                // Insere novo monitoramento
                await db.query(`
                    INSERT INTO swarm_watchlist (title, type, tmdb_id, imdb_id, season, episode, audio_preference, user_id, username, reason, last_checked, check_count, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), 1, NOW())
                `, [title, type, tmdbId, imdbId, season, episode, audioPreference, userId, username, reason]);

                const epTag = type === 'serie' && season && episode ? ` (T${season}E${episode})` : '';
                console.log(`👀 [SWARM WATCHER] Adicionado ao monitoramento de seeders: "${title}"${epTag} [Áudio: ${audioPreference}, Motivo: ${reason}]`);
            }
            return true;
        } catch (e) {
            console.warn('⚠️ [SWARM WATCHER] Erro ao registrar item na watchlist:', e.message);
            return false;
        }
    }

    /**
     * Remove um item da lista de observação
     */
    async removeFromWatchlist(title, type, season = null, episode = null, audioPreference = null) {
        if (!title) return;
        try {
            let q = `DELETE FROM swarm_watchlist WHERE LOWER(title) = LOWER($1) AND type = $2`;
            const params = [title.trim(), type];

            if (season) {
                params.push(season);
                q += ` AND season = $${params.length}`;
            }
            if (episode) {
                params.push(episode);
                q += ` AND episode = $${params.length}`;
            }
            if (audioPreference) {
                params.push(audioPreference);
                q += ` AND audio_preference = $${params.length}`;
            }

            await db.query(q, params);
        } catch (e) {
            console.warn('⚠️ [SWARM WATCHER] Erro ao remover item da watchlist:', e.message);
        }
    }

    /**
     * Varredura periódica de todos os itens monitorados
     */
    async checkWatchlist() {
        if (this.isChecking || !this.queueManager) return;
        this.isChecking = true;

        try {
            // Pega até 12 itens monitorados que não foram verificados recentemente (mais antigos primeiro)
            const res = await db.query(`
                SELECT * FROM swarm_watchlist 
                ORDER BY last_checked ASC NULLS FIRST 
                LIMIT 12
            `);

            const items = res.rows;
            if (items.length === 0) return;

            console.log(`🔍 [SWARM WATCHER] Verificando sementes e novas fontes para ${items.length} item(ns) em espera...`);

            for (const it of items) {
                const title = it.title;
                const type = it.type;
                const season = it.season;
                const episode = it.episode;
                const pref = it.audio_preference || 'dublado';

                // Verifica se já foi satisfeito no catálogo
                if (this.catalogoManager) {
                    if (type === 'filme') {
                        const f = this.catalogoManager.buscarItemExato(title, 'filme', it.tmdb_id, it.imdb_id);
                        const satisfied = pref === 'dublado' ? (f?.isDublado || f?.audio?.includes('Dublado')) : (f?.isLegendado || f?.audio?.includes('Legendado'));
                        if (satisfied) {
                            await this.removeFromWatchlist(title, type, null, null, pref);
                            continue;
                        }
                    } else if (type === 'serie') {
                        const s = this.catalogoManager.buscarItemExato(title, 'serie', it.tmdb_id, it.imdb_id);
                        const tempS = (s?.temporadas || []).find(t => t.numero === (season || 1));
                        const epS = (tempS?.episodios || []).find(e => e.numero === (episode || 1));
                        const satisfied = pref === 'dublado' ? (epS?.isDublado || epS?.audio?.includes('Dublado')) : (epS?.isLegendado || epS?.audio?.includes('Legendado'));
                        if (satisfied) {
                            await this.removeFromWatchlist(title, type, season, episode, pref);
                            continue;
                        }
                    }
                }

                // Verifica se já está na fila de downloads ativa
                const alreadyInQueue = this.queueManager.queue.some(j => 
                    j.title.toLowerCase() === title.toLowerCase() && 
                    j.type === type &&
                    j.season === season &&
                    j.episode === episode &&
                    j.status !== 'failed'
                );

                if (alreadyInQueue) {
                    await db.query(`UPDATE swarm_watchlist SET last_checked = NOW() WHERE id = $1`, [it.id]);
                    continue;
                }

                // Faz busca de fontes para checar se surgiram sementes saudáveis
                try {
                    const sources = await MediaSearchService.search(title, type, {
                        tmdbId: it.tmdb_id,
                        imdbId: it.imdb_id,
                        season: season || 1,
                        episode: episode || 1,
                        audioPreference: pref,
                        allowOriginalAudio: pref === 'legendado'
                    });

                    // Filtra fontes viáveis com sementes ativas (>= 3 seeders)
                    const viableSources = sources.filter(s => {
                        const seeds = s.seeders || 0;
                        if (pref === 'dublado') {
                            return s.isDublado && seeds >= 3;
                        } else {
                            return (s.isLegendado || s.hasPtSub || s.isOriginal) && seeds >= 3;
                        }
                    });

                    if (viableSources.length > 0) {
                        const best = viableSources[0];
                        const epTag = type === 'serie' ? ` - T${season || 1}E${episode || 1}` : '';
                        console.log(`🌟 [SWARM WATCHER] Novas sementes ativas detectadas para "${title}"${epTag}! Fonte: "${best.title}" (${best.seeders} seeds, ${best.audio || pref}). Enfileirando download imediatamente...`);

                        // Enfileira na frente da esteira
                        this.queueManager.addJob(title, type, PRIORITIES.VIP_USER, {
                            tmdbId: it.tmdb_id,
                            imdbId: it.imdb_id,
                            season: season || (type === 'serie' ? 1 : null),
                            episode: episode || (type === 'serie' ? 1 : null),
                            audioPreference: pref,
                            userId: it.user_id,
                            username: it.username,
                            queueOrder: -1
                        });

                        // Remove da watchlist pois já foi enfileirado com sucesso
                        await db.query(`DELETE FROM swarm_watchlist WHERE id = $1`, [it.id]);
                    } else {
                        // Atualiza timestamp para retestar no próximo ciclo
                        await db.query(`UPDATE swarm_watchlist SET last_checked = NOW(), check_count = check_count + 1 WHERE id = $1`, [it.id]);
                    }
                } catch (errSearch) {
                    await db.query(`UPDATE swarm_watchlist SET last_checked = NOW() WHERE id = $1`, [it.id]);
                }

                // Pequeno intervalo entre buscas para não saturar APIs
                await new Promise(r => setTimeout(r, 1500));
            }
        } catch (e) {
            console.warn('⚠️ [SWARM WATCHER] Erro durante verificação da watchlist:', e.message);
        } finally {
            this.isChecking = false;
        }
    }

    /**
     * Inicia o cron do monitor de sementes em background
     * @param {number} intervalMs - Intervalo entre checagens (padrão: 30 minutos)
     */
    startWatchCycle(intervalMs = 30 * 60 * 1000) {
        console.log(`👀 [SWARM WATCHER] Monitor de sementes e upgrades automáticos ativado (Intervalo: ${Math.round(intervalMs / 60000)} min)!`);
        
        // Primeira checagem 2 minutos após o boot
        setTimeout(() => {
            this.checkWatchlist().catch(() => {});
        }, 120000);

        setInterval(() => {
            this.checkWatchlist().catch(() => {});
        }, intervalMs);
    }
}

module.exports = new SwarmWatcher();
