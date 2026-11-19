const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const db = require('../database/db');
const utils = require('../utils/SubtitleUtils');
const pipeline = require('./SubtitlePipeline');
const slot = require('./SubtitleWorkSlot');
const SchedulerService = require('./SchedulerService');
const config = require('../../config');

const directory = path.resolve(__dirname, '../../public/subtitles');
const cutoff = '2026-11-15T00:00:00-03:00';
const tables = { filme: 'filmes', episodio: 'episodios' };

// One durable, leased queue shared by the watchdog and manual reprocessing.
class SubtitleMaintenance {
    constructor(server) {
        this.server = server;
        this.cursor = { filme: 0, episodio: 0 };
    }

    async init() {
        if (!this.ready) this.ready = db.query(`CREATE TABLE IF NOT EXISTS subtitle_repairs (
            type TEXT NOT NULL, media_id BIGINT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_until TIMESTAMPTZ,
            owner TEXT, last_error TEXT, priority INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0, message TEXT, PRIMARY KEY (type, media_id)
        ); ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS message TEXT;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS outcome JSONB;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS manual BOOLEAN NOT NULL DEFAULT false;
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;`).catch(error => { this.ready = null; throw error; });
        await this.ready;
    }

    async load(type, id) {
        if (!tables[type]) throw new Error('Tipo de mídia inválido.');
        const sql = type === 'filme' ? 'SELECT * FROM filmes WHERE id = $1' : `
            SELECT e.*, s.tmdb_id, s.imdb_id, s.nome AS serie_nome,
                   s.nome_original AS serie_nome_original
            FROM episodios e JOIN series s ON s.id = e.serie_id WHERE e.id = $1`;
        return (await db.query(sql, [id])).rows[0];
    }

    required(row) {
        return !this.hardsub(row) &&
            !!(row.is_legendado || /legendad/i.test(row.audio || '') || row.versoes?.legendado);
    }

    hardsub(row) {
        return row.is_hardsub === true || String(row.versoes?.legendado?.hardsub) === 'true' ||
            new Date(row.created_at).getTime() < new Date(cutoff).getTime();
    }

    fingerprint(row) {
        return String(row.versoes?.legendado?.fileId || row.versoes?.legendado?.file_id ||
            row.file_id || row.versoes?.legendado?.messageId || row.message_id || '');
    }

    async atomicWrite(file, content) {
        const temporary = `${file}.${crypto.randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, content, 'utf8'); await fs.rename(temporary, file); }
        finally { await fs.remove(temporary).catch(() => {}); }
    }

    async validFile(filename, language = 'pt-BR', duration = 0) {
        const file = path.join(directory, path.basename(filename));
        try {
            const raw = await fs.readFile(file, 'utf8');
            const clean = utils.sanitizeVtt(raw);
            const cues = utils.parseVtt(clean);
            if (clean !== raw) await this.atomicWrite(file, clean);
            if (!pipeline.validateCandidateCoverageAndDensity(cues, duration).valid) return false;
            if (/^pt/i.test(language) && !await pipeline.isBrazilianPortugueseSubtitle(
                clean, language, filename, cues.map(c => c.text))) return false;
            return true;
        } catch (error) {
            if (error.code === 'SUBTITLE_LOCALE_UNAVAILABLE') throw error;
            if (error.code !== 'ENOENT') console.warn('[Subtitle validation]', file, error.message);
            return false;
        }
    }

    async tracks(type, row) {
        let previous = row.legendas || [];
        if (typeof previous === 'string') { try { previous = JSON.parse(previous); } catch (_) { previous = []; } }
        if (!Array.isArray(previous)) previous = [];
        const tracks = [];
        for (const track of previous) {
            if (!track?.vttUrl?.startsWith('/subtitles/') || !/\.vtt(?:\?|$)/i.test(track.vttUrl)) continue;
            if (await this.validFile(track.vttUrl.split('?')[0], track.lang, (row.duracao || 0) * 60)) tracks.push(track);
        }
        if (!tracks.some(t => /^pt/i.test(t.lang))) {
            const suffix = type === 'filme' ? 'movie' : `s${row.temporada_numero}e${row.numero}`;
            const base = row.tmdb_id || row.imdb_id || `${type}_${row.id}`;
            const prefixes = [...new Set([base, type === 'filme' ? row.id : row.serie_id])].map(id => `${id}_${suffix}_ptbr_`);
            const files = await fs.readdir(directory).catch(() => []);
            for (const name of files.filter(f => prefixes.some(prefix => f.startsWith(prefix)) && f.endsWith('.vtt')).sort().reverse()) {
                if (!await this.validFile(name, 'pt-BR', (row.duracao || 0) * 60)) continue;
                tracks.unshift({ lang: 'pt-BR', label: 'Português (Brasil)', default: true,
                    vttUrl: `/subtitles/${name}`, version: (await fs.stat(path.join(directory, name))).mtimeMs });
                break;
            }
        }
        if (JSON.stringify(previous) !== JSON.stringify(tracks)) {
            // Avoid overwriting tracks published concurrently after this snapshot.
            await db.query(`UPDATE ${tables[type]} SET legendas = $1${type === 'filme' ? ', updated_at = NOW()' : ''}
                WHERE id = $2 AND COALESCE(legendas, '[]'::jsonb) = $3::jsonb`,
            [JSON.stringify(tracks), row.id, JSON.stringify(previous)]);
        }
        const pt = tracks.find(t => /^pt/i.test(t.lang));
        const fingerprint = this.fingerprint(row);
        const verified = pt && (pt.manualReview || pt.validationVersion === slot.revision) && pt.mediaFingerprint === fingerprint && pt.contentHash === utils.contentHash(
            await fs.readFile(path.join(directory, path.basename(pt.vttUrl.split('?')[0])), 'utf8').catch(() => ''));
        if (this.required(row) && !verified) await this.enqueue(type, row.id, pt ? 0 : 10);
        else if (verified) {
            await this.init();
            await this.recordAvailable(type, row.id, pt);
        }
        return tracks;
    }

    async recordAvailable(type, id, track) {
        await this.init();
        await db.query(`INSERT INTO subtitle_repairs (type,media_id,completed_at,progress,message,outcome,revision)
            VALUES ($1,$2,NOW(),100,'Legenda disponível',$3,$4)
            ON CONFLICT (type,media_id) DO UPDATE SET completed_at=NOW(), progress=100, last_error=NULL,
                outcome=$3, message='Legenda disponível', updated_at=NOW(), revision=$4
            WHERE subtitle_repairs.completed_at IS NULL
                AND (subtitle_repairs.lease_until IS NULL OR subtitle_repairs.lease_until < NOW()) AND NOT subtitle_repairs.manual`,
        [type, id, JSON.stringify({ method: track.manualReview ? 'Revisão manual' : track.sourceMethod, proof: track.syncProof }), slot.revision]);
    }

    async dashboard(state, offset) {
        await this.init();
        const active = await slot.active();
        const classified = `SELECT r.*, CASE
            WHEN completed_at IS NOT NULL THEN 'completed'
            WHEN lease_until > NOW() AND type=$2 AND media_id=$3 THEN 'processing'
            WHEN last_error IS NOT NULL THEN 'retry'
            ELSE 'queued' END AS status
            FROM subtitle_repairs r WHERE revision=$1`;
        const params = [slot.revision, active?.media_type || null, active?.media_id || null];
        const [counts, jobs] = await Promise.all([
            db.query(`SELECT status, COUNT(*)::int AS count FROM (${classified}) q GROUP BY status`, params),
            db.query(`SELECT q.type,q.media_id,q.status,q.progress,q.message,q.attempts,q.next_attempt,
                q.last_error,q.updated_at,q.started_at,q.completed_at,q.outcome->>'method' AS method,
                COALESCE(f.nome, CONCAT(s.nome, ' · T', e.temporada_numero, ' E', e.numero), q.media_id::text) AS title
                FROM (${classified}) q
                LEFT JOIN filmes f ON q.type='filme' AND f.id=q.media_id
                LEFT JOIN episodios e ON q.type='episodio' AND e.id=q.media_id
                LEFT JOIN series s ON s.id=e.serie_id
                WHERE ($4='' OR q.status=$4)
                ORDER BY CASE q.status WHEN 'processing' THEN 0 WHEN 'retry' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
                CASE WHEN q.completed_at IS NULL THEN q.priority END DESC,
                CASE WHEN q.completed_at IS NULL THEN q.next_attempt END,
                q.completed_at DESC, q.type, q.media_id LIMIT 30 OFFSET $5`, [...params, state, offset])
        ]);
        const totals = Object.fromEntries(counts.rows.map(row => [row.status, row.count]));
        return { counts: totals, processingTotal: active ? 1 : totals.processing || 0, jobs: jobs.rows, active,
            enabled: await fs.pathExists(path.resolve(__dirname, '../../data/subtitle_queue.enabled')) };
    }

    async status(type, id) {
        if (!tables[type]) throw new Error('Tipo de mídia inválido.');
        await this.init();
        const pending = (await db.query('SELECT * FROM subtitle_repairs WHERE type=$1 AND media_id=$2', [type,id])).rows[0];
        if (pending?.revision === slot.revision && pending.completed_at) {
            const row = await this.load(type,id);
            return { status: 'completed', progress: 100, tracks: row?.legendas || [], message: pending.message,
                outcome: pending.outcome, completedAt: pending.completed_at };
        }
        if (pending?.revision === slot.revision) {
            const active = pending.lease_until && new Date(pending.lease_until).getTime() > Date.now() ? await slot.active() : null;
            const processing = active?.media_type === type && String(active?.media_id) === String(id);
            return {
                status: processing ? 'processing' : 'queued',
                progress: processing ? pending.progress : 0,
                message: processing || pending.last_error ? pending.message : 'Aguardando recuperação automática',
                attempts: pending.attempts, nextAttempt: pending.next_attempt, error: pending.last_error
            };
        }
        const row = await this.load(type,id);
        const tracks = Array.isArray(row?.legendas) ? row.legendas : [];
        if (tracks.some(t => t.validationVersion === slot.revision)) return { status: 'completed', progress: 100, tracks, message: 'Legenda verificada contra o áudio desta versão.' };
        if (row && this.required(row)) return { status: 'queued', progress: 0, message: 'Aguardando verificação das falas desta versão.' };
        return { status: 'idle', message: 'Nenhum processamento concluído para esta mídia.' };
    }

    async enqueue(type, id, priority = 0, manual = false) {
        await this.init();
        const result = await db.query(`INSERT INTO subtitle_repairs (type, media_id, priority, manual, revision) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (type, media_id) DO UPDATE SET
                priority=CASE WHEN subtitle_repairs.revision<>$5 AND NOT subtitle_repairs.manual
                    THEN EXCLUDED.priority ELSE GREATEST(subtitle_repairs.priority, EXCLUDED.priority) END, revision=$5,
                manual=subtitle_repairs.manual OR $4, completed_at=NULL,
                next_attempt=CASE WHEN $4 OR subtitle_repairs.completed_at IS NOT NULL OR subtitle_repairs.revision<>$5 THEN NOW() ELSE subtitle_repairs.next_attempt END,
                progress=CASE WHEN $4 OR subtitle_repairs.completed_at IS NOT NULL THEN 0 ELSE subtitle_repairs.progress END,
                last_error=CASE WHEN $4 OR subtitle_repairs.revision<>$5 THEN NULL ELSE subtitle_repairs.last_error END,
                message=CASE WHEN $4 OR subtitle_repairs.completed_at IS NOT NULL THEN NULL ELSE subtitle_repairs.message END
            WHERE (subtitle_repairs.lease_until IS NULL OR subtitle_repairs.lease_until < NOW())
                AND ($4 OR subtitle_repairs.completed_at IS NOT NULL OR subtitle_repairs.revision<>$5 OR subtitle_repairs.priority<$3)`, [type, id, priority, manual, slot.revision]);
        if (result.rowCount && (priority > 0 || manual)) {
            this.server.catalogoManager?.loadCatalogo().catch(e => console.warn('[Subtitle catalog]', e.message));
        }
    }

    async repair(type, id) {
        const row = await this.load(type, id);
        const title = row?.serie_nome ? `${row.serie_nome} · T${row.temporada_numero} E${row.numero}` : row?.nome;
        const qm = this.server?.queueManager;
        const slotId = `sub_${type}_${id}`;
        let slotAcquiredHere = false;
        if (qm && !qm.downloadSlots.has(slotId)) {
            while (!qm.acquireDownloadSlot(slotId)) {
                await new Promise(r => setTimeout(r, 4000));
            }
            slotAcquiredHere = true;
        }
        try {
            return await slot.run(title || `${type} #${id}`, progress => this.repairWithSlot(type, id, progress),
                true, 'catalog', { type, id });
        } finally {
            if (slotAcquiredHere && qm) {
                qm.releaseDownloadSlot(slotId);
                setImmediate(() => qm.processNext());
            }
        }
    }

    async repairWithSlot(type, id, slotProgress) {
        const owner = crypto.randomUUID();
        const claim = await db.query(`UPDATE subtitle_repairs SET owner = $3,
            lease_until = NOW() + INTERVAL '5 minutes', attempts = attempts + 1, last_error = NULL,
            progress=0, message='Preparando análise do áudio', started_at=NOW(), updated_at=NOW()
            WHERE type = $1 AND media_id = $2 AND (lease_until IS NULL OR lease_until < NOW())
              AND completed_at IS NULL AND next_attempt <= NOW() RETURNING attempts, manual`, [type, id, owner]);
        if (!claim.rows.length) return null;
        const heartbeat = setInterval(() => db.query(`UPDATE subtitle_repairs
            SET lease_until = NOW() + INTERVAL '5 minutes' WHERE type=$1 AND media_id=$2 AND owner=$3`,
        [type, id, owner]).catch(e => console.warn('[Subtitle lease]', e.message)), 60000);
        heartbeat.unref();
        let result;
        const progress = (percent, message) => {
            slotProgress(percent, message);
            db.query('UPDATE subtitle_repairs SET progress=GREATEST(progress,$4),message=$5,updated_at=NOW() WHERE type=$1 AND media_id=$2 AND owner=$3',
                [type,id,owner,percent,message]).catch(error => console.warn('[Subtitle progress]', error.message));
        };
        try {
            const row = await this.load(type, id);
            if (!row || this.hardsub(row) || (!claim.rows[0].manual && !this.required(row))) {
                await db.query('DELETE FROM subtitle_repairs WHERE type=$1 AND media_id=$2 AND owner=$3', [type, id, owner]);
                return { tracks: [], cues: [] };
            }
            const manualTrack = row.legendas?.find?.(track => /^pt/i.test(track.lang || '') && track.manualReview &&
                track.mediaFingerprint === this.fingerprint(row));
            if (manualTrack?.vttUrl && !claim.rows[0].manual &&
                await this.validFile(manualTrack.vttUrl, manualTrack.lang, (row.duracao || 0) * 60) &&
                manualTrack.contentHash === utils.contentHash(await fs.readFile(
                path.join(directory, path.basename(manualTrack.vttUrl)), 'utf8').catch(() => ''))) {
                await db.query(`UPDATE subtitle_repairs SET completed_at=NOW(),updated_at=NOW(),owner=NULL,lease_until=NULL,
                    progress=100,message='Revisão manual preservada',outcome='{"method":"Revisão manual"}'::jsonb
                    WHERE type=$1 AND media_id=$2 AND owner=$3`, [type, id, owner]);
                return null;
            }
            const season = row.temporada_numero;
            const episode = row.numero;
            const audio = row.versoes?.legendado ? 'legendado' : row.versoes?.dublado ? 'dublado' : 'legendado';
            const root = `http://127.0.0.1:${this.server.port}/stream/video/internal_admin`;
            const url = type === 'filme' ? `${root}/filme/${id}/${audio}` : `${root}/serie/${row.serie_id}/${season}/${episode}/${audio}`;
            let oldTracks = row.legendas || [];
            if (typeof oldTracks === 'string') { try { oldTracks = JSON.parse(oldTracks); } catch (_) { oldTracks = []; } }
            const existing = Array.isArray(oldTracks) ? oldTracks.find(t => /^pt/i.test(t.lang || '') && t.vttUrl) : null;
            const existingSubtitlePath = existing ? path.join(directory, path.basename(existing.vttUrl.split('?')[0])) : null;
            const mediaFingerprint = this.fingerprint(row);
            result = await pipeline.processWithSubtitleSlot(url, {
                mediaFingerprint,
                existingSubtitlePath: existingSubtitlePath && await fs.pathExists(existingSubtitlePath) ? existingSubtitlePath : null,
                tipo: type === 'filme' ? 'filme' : 'serie', title: row.serie_nome || row.nome,
                nomeOriginal: row.serie_nome_original || row.nome_original,
                tmdbId: row.tmdb_id, imdbId: row.imdb_id, season, episode, year: row.ano,
                duration: (row.duracao || 0) * 60
            }, progress);
            await pipeline.validateAndFinalizeSubtitle(result.srtPath);
            const content = await fs.readFile(result.srtPath, 'utf8');
            const base = row.tmdb_id || row.imdb_id || `${type}_${id}`;
            const suffix = type === 'filme' ? 'movie' : `s${season}e${episode}`;
            const name = `${base}_${suffix}_ptbr_${Date.now()}`;
            await fs.ensureDir(directory);
            const lease = await db.query('SELECT owner FROM subtitle_repairs WHERE type=$1 AND media_id=$2 AND owner=$3 AND lease_until > NOW()', [type, id, owner]);
            if (!lease.rows.length) throw new Error('Lease de recuperação perdida.');
            await this.atomicWrite(path.join(directory, `${name}.srt`), content);
            await this.atomicWrite(path.join(directory, `${name}.vtt`), utils.sanitizeVtt(content));
            const track = { lang: 'pt-BR', label: 'Português (Brasil)', default: true,
                srtUrl: `/subtitles/${name}.srt`, vttUrl: `/subtitles/${name}.vtt`,
                version: Date.now(), validationVersion: result.syncValidationVersion, mediaFingerprint, syncProof: result.checkpoints, contentHash: utils.contentHash(utils.sanitizeVtt(content)), sourceMethod: result.sourceMethod };
            // Merge against current DB state rather than the old pre-transcription snapshot.
            const saved = await db.query(`UPDATE ${tables[type]} SET legendas =
                jsonb_build_array($1::jsonb) || COALESCE((SELECT jsonb_agg(t) FROM
                jsonb_array_elements(CASE WHEN jsonb_typeof(legendas)='array' THEN legendas ELSE '[]'::jsonb END) t
                WHERE COALESCE(t->>'lang', '') NOT ILIKE 'pt%'), '[]'::jsonb),
                is_hardsub = false, is_legendado = true${type === 'filme' ? ', updated_at = NOW()' : ''}
                WHERE id=$2 AND is_hardsub IS DISTINCT FROM true AND versoes IS NOT DISTINCT FROM $5::jsonb
                    AND legendas IS NOT DISTINCT FROM $6::jsonb AND EXISTS (SELECT 1 FROM subtitle_repairs
                    WHERE type=$3 AND media_id=$2 AND owner=$4 AND lease_until > NOW())
                RETURNING legendas`, [JSON.stringify(track), id, type, owner, row.versoes == null ? null : JSON.stringify(row.versoes),
                row.legendas == null ? null : JSON.stringify(row.legendas)]);
            if (!saved.rows.length) {
                await Promise.all(['srt', 'vtt'].map(ext => fs.remove(path.join(directory, `${name}.${ext}`))));
                throw new Error('A mídia ou a legenda foi alterada durante a recuperação.');
            }
            await db.query(`UPDATE subtitle_repairs SET completed_at=NOW(), updated_at=NOW(), owner=NULL,
                lease_until=NULL, progress=100, manual=false, message='Legenda disponível', outcome=$4
                WHERE type=$1 AND media_id=$2 AND owner=$3`, [type, id, owner,
                JSON.stringify({ method: result.sourceMethod, proof: result.checkpoints, previousTracks: oldTracks })]);
            this.server.catalogoManager?.loadCatalogo().catch(e => console.warn('[Subtitle catalog]', e.message));
            return { tracks: saved.rows[0].legendas, cues: utils.parseSrt(content), sourceMethod: result.sourceMethod };
        } catch (error) {
            const backoff = Math.min(360, 2 ** Math.min(claim.rows[0].attempts, 9));
            const delay = Math.max(backoff, Math.ceil(((error.retryAt || 0) - Date.now()) / 60000));
            await db.query(`UPDATE subtitle_repairs SET lease_until=NULL, owner=NULL, last_error=$4,
                updated_at=NOW(), message='Aguardando nova tentativa',
                next_attempt=NOW() + ($5 * INTERVAL '1 minute') WHERE type=$1 AND media_id=$2 AND owner=$3`,
            [type, id, owner, error.message.slice(0, 2000), delay]);
            throw error;
        } finally {
            clearInterval(heartbeat);
            if (result?.srtPath) await fs.remove(result.srtPath).catch(() => {});
        }
    }

    async tick() {
        if (this.scanning || !await fs.pathExists(path.resolve(__dirname, '../../data/subtitle_queue.enabled'))) return;
        this.scanning = true;
        try {
            await this.init();
            for (const [type, table] of Object.entries(tables)) {
                const batch = await db.query(`SELECT id FROM ${table} WHERE created_at >= $1
                    AND (is_legendado=true OR audio ILIKE '%legendad%' OR jsonb_typeof(versoes->'legendado') = 'object')
                    AND is_hardsub IS DISTINCT FROM true AND COALESCE(versoes->'legendado'->>'hardsub','false') <> 'true'
                    AND id > $2 ORDER BY id LIMIT 25`, [cutoff, this.cursor[type]]);
                for (const { id } of batch.rows) {
                    try {
                        const row = await this.load(type, id);
                        if (row) await this.tracks(type, row);
                    } catch (error) {
                        console.warn('[Subtitle scan]', type, id, error.message);
                    }
                    this.cursor[type] = id;
                }
                if (batch.rows.length < 25) this.cursor[type] = 0;
            }
            if (!this.working) {
                // Integração com a esteira de downloads: respeita agendamento e concorrência máxima de download
                if (!SchedulerService.isAllowedToRun()) return;

                const qm = this.server?.queueManager;
                if (qm) {
                    const limit = SchedulerService.getActiveMode() === 'eco' ? 1 : (config.PERFORMANCE_MAX_DOWNLOADS || qm.maxConcurrentDownloads || 3);
                    if (qm.downloadSlots.size >= limit) {
                        return; // Slot de download já ocupado na esteira (por download de mídia do catálogo)
                    }
                }

                const jobs = await db.query(`SELECT type, media_id FROM subtitle_repairs
                    WHERE revision=$1 AND completed_at IS NULL AND next_attempt <= NOW() AND (lease_until IS NULL OR lease_until < NOW())
                    ORDER BY priority DESC, next_attempt LIMIT 1`, [slot.revision]);
                if (jobs.rows.length) {
                    const job = jobs.rows[0];
                    const slotId = `sub_${job.type}_${job.media_id}`;
                    if (qm && !qm.acquireDownloadSlot(slotId)) {
                        return; // Não conseguiu vaga exclusiva de download
                    }
                    console.log(`🍃 [Fila de Legendas] Slot de download reservado na esteira para ${job.type} #${job.media_id}`);
                    this.working = (async () => {
                        try {
                            await this.repair(job.type, job.media_id);
                        } finally {
                            if (qm) {
                                qm.releaseDownloadSlot(slotId);
                                console.log(`🍃 [Fila de Legendas] Slot de download liberado (${job.type} #${job.media_id})`);
                                setImmediate(() => qm.processNext());
                            }
                        }
                    })()
                    .catch(e => console.warn('[Subtitle repair pending]', job.type, job.media_id, e.message))
                    .finally(() => { this.working = null; });
                }
            }
        } finally { this.scanning = false; }
    }

    async seed() {
        await this.init();
        const counts = {};
        for (const [type, table] of Object.entries(tables)) {
            const { rows } = await db.query(`SELECT * FROM ${table} WHERE created_at >= $1 AND is_hardsub IS DISTINCT FROM true
                AND COALESCE(versoes->'legendado'->>'hardsub','false') <> 'true'
                AND (is_legendado=true OR audio ILIKE '%legendad%' OR jsonb_typeof(versoes->'legendado')='object')`, [cutoff]);
            counts[type] = rows.length;
            for (const row of rows) await this.tracks(type, row);
        }
        return counts;
    }

    async cleanDisk() {
        await fs.ensureDir(directory);
        for (const name of await fs.readdir(directory)) {
            if (!name.endsWith('.vtt')) continue;
            const file = path.join(directory, name);
            const content = await fs.readFile(file, 'utf8');
            const clean = utils.sanitizeVtt(content);
            if (clean !== content) await this.atomicWrite(file, clean);
        }
    }

    start() {
        if (this.timer) return;
        const run = () => this.tick().catch(e => console.warn('[Subtitle watchdog]', e.message));
        this.timer = setInterval(run, 15000);
        this.timer.unref();
        run();
    }
}

module.exports = SubtitleMaintenance;
