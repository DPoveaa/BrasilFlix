const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const db = require('../database/db');
const utils = require('../utils/SubtitleUtils');
const pipeline = require('./SubtitlePipeline');

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
            ALTER TABLE subtitle_repairs ADD COLUMN IF NOT EXISTS message TEXT;`).catch(error => { this.ready = null; throw error; });
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
        return new Date(row.created_at).getTime() >= new Date(cutoff).getTime() &&
            !!(row.is_legendado || /legendad/i.test(row.audio || '') || row.versoes?.legendado);
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
            if (/^pt/i.test(language) && !pipeline.isBrazilianPortugueseSubtitle(
                clean, '', '', cues.map(c => c.text))) return false;
            return true;
        } catch (error) {
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
        const fingerprint = String(row.versoes?.legendado?.fileId || row.versoes?.legendado?.file_id || row.file_id || row.versoes?.legendado?.messageId || row.message_id || '');
        const verified = pt && pt.validationVersion === 2 && pt.mediaFingerprint === fingerprint && pt.contentHash === utils.contentHash(
            await fs.readFile(path.join(directory, path.basename(pt.vttUrl.split('?')[0])), 'utf8').catch(() => ''));
        if (this.required(row) && !verified) await this.enqueue(type, row.id, pt ? 0 : 10);
        else if (verified) {
            await this.init();
            await db.query('DELETE FROM subtitle_repairs WHERE type=$1 AND media_id=$2 AND lease_until IS NULL', [type, row.id]);
        }
        return tracks;
    }

    async status(type, id) {
        if (!tables[type]) throw new Error('Tipo de mídia inválido.');
        await this.init();
        const pending = (await db.query('SELECT attempts,lease_until,next_attempt,last_error,progress,message FROM subtitle_repairs WHERE type=$1 AND media_id=$2', [type,id])).rows[0];
        if (pending) return {
            status: pending.lease_until && new Date(pending.lease_until).getTime() > Date.now() ? 'processing' : 'queued',
            progress: pending.progress, message: pending.message || 'Aguardando recuperação automática',
            attempts: pending.attempts, nextAttempt: pending.next_attempt, error: pending.last_error
        };
        const row = await this.load(type,id);
        const tracks = row ? await this.tracks(type,row) : [];
        if (tracks.some(t => t.validationVersion === 2)) return { status: 'completed', progress: 100, tracks, message: 'Legenda verificada contra o áudio desta versão.' };
        if (row && this.required(row)) return { status: 'queued', progress: 0, message: 'Aguardando verificação das falas desta versão.' };
        return { status: 'idle', message: 'Nenhum processamento concluído para esta mídia.' };
    }

    async enqueue(type, id, priority = 0) {
        await this.init();
        await db.query(`INSERT INTO subtitle_repairs (type, media_id, priority) VALUES ($1, $2, $3)
            ON CONFLICT (type, media_id) DO UPDATE SET priority=GREATEST(subtitle_repairs.priority, EXCLUDED.priority)`, [type, id, priority]);
    }

    async repair(type, id, onProgress, force = false) {
        await this.enqueue(type, id);
        const owner = crypto.randomUUID();
        const claim = await db.query(`UPDATE subtitle_repairs SET owner = $3,
            lease_until = NOW() + INTERVAL '5 minutes', attempts = attempts + 1, last_error = NULL
            WHERE type = $1 AND media_id = $2 AND (lease_until IS NULL OR lease_until < NOW())
              AND ($4::boolean OR next_attempt <= NOW()) RETURNING attempts`, [type, id, owner, force]);
        if (!claim.rows.length) throw new Error('Recuperação já em andamento ou aguardando retentativa.');
        const heartbeat = setInterval(() => db.query(`UPDATE subtitle_repairs
            SET lease_until = NOW() + INTERVAL '5 minutes' WHERE type=$1 AND media_id=$2 AND owner=$3`,
        [type, id, owner]).catch(e => console.warn('[Subtitle lease]', e.message)), 60000);
        heartbeat.unref();
        let result;
        let lastProgress = 0;
        const progress = (percent, message) => {
            onProgress?.(percent, message);
            if (Date.now() - lastProgress < 5000 && percent < 90) return;
            lastProgress = Date.now();
            db.query('UPDATE subtitle_repairs SET progress=$4,message=$5 WHERE type=$1 AND media_id=$2 AND owner=$3',
                [type,id,owner,percent,message]).catch(error => console.warn('[Subtitle progress]', error.message));
        };
        try {
            const row = await this.load(type, id);
            if (!row || (!force && !this.required(row))) {
                await db.query('DELETE FROM subtitle_repairs WHERE type=$1 AND media_id=$2 AND owner=$3', [type, id, owner]);
                return { tracks: [], cues: [] };
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
            const mediaFingerprint = String(row.versoes?.legendado?.fileId || row.versoes?.legendado?.file_id || row.file_id || row.versoes?.legendado?.messageId || row.message_id || '');
            result = await pipeline.processSubtitlePipeline(url, {
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
                version: Date.now(), validationVersion: 2, mediaFingerprint, syncProof: result.checkpoints, contentHash: utils.contentHash(utils.sanitizeVtt(content)), sourceMethod: result.sourceMethod };
            // Merge against current DB state rather than the old pre-transcription snapshot.
            const saved = await db.query(`UPDATE ${tables[type]} SET legendas =
                jsonb_build_array($1::jsonb) || COALESCE((SELECT jsonb_agg(t) FROM
                jsonb_array_elements(CASE WHEN jsonb_typeof(legendas)='array' THEN legendas ELSE '[]'::jsonb END) t
                WHERE COALESCE(t->>'lang', '') NOT ILIKE 'pt%'), '[]'::jsonb),
                is_hardsub = false, is_legendado = true${type === 'filme' ? ', updated_at = NOW()' : ''}
                WHERE id=$2 AND EXISTS (SELECT 1 FROM subtitle_repairs
                    WHERE type=$3 AND media_id=$2 AND owner=$4 AND lease_until > NOW())
                RETURNING legendas`, [JSON.stringify(track), id, type, owner]);
            if (!saved.rows.length) throw new Error('Mídia removida durante recuperação.');
            await db.query('DELETE FROM subtitle_repairs WHERE type=$1 AND media_id=$2 AND owner=$3', [type, id, owner]);
            this.server.catalogoManager?.loadCatalogo().catch(e => console.warn('[Subtitle catalog]', e.message));
            return { tracks: saved.rows[0].legendas, cues: utils.parseSrt(content), sourceMethod: result.sourceMethod };
        } catch (error) {
            const delay = Math.min(360, 2 ** Math.min(claim.rows[0].attempts, 9));
            await db.query(`UPDATE subtitle_repairs SET lease_until=NULL, owner=NULL, last_error=$4,
                next_attempt=NOW() + ($5 * INTERVAL '1 minute') WHERE type=$1 AND media_id=$2 AND owner=$3`,
            [type, id, owner, error.message.slice(0, 2000), delay]);
            throw error;
        } finally {
            clearInterval(heartbeat);
            if (result?.srtPath) await fs.remove(result.srtPath).catch(() => {});
        }
    }

    async tick() {
        if (this.scanning) return;
        this.scanning = true;
        try {
            await this.init();
            for (const [type, table] of Object.entries(tables)) {
                const batch = await db.query(`SELECT id FROM ${table} WHERE created_at >= $1
                    AND (is_legendado=true OR audio ILIKE '%legendad%' OR jsonb_typeof(versoes->'legendado') = 'object')
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
                const jobs = await db.query(`SELECT type, media_id FROM subtitle_repairs
                    WHERE next_attempt <= NOW() AND (lease_until IS NULL OR lease_until < NOW())
                    ORDER BY priority DESC, next_attempt LIMIT 1`);
                if (jobs.rows.length) {
                    const job = jobs.rows[0];
                    this.working = this.repair(job.type, job.media_id)
                        .catch(e => console.warn('[Subtitle repair pending]', job.type, job.media_id, e.message))
                        .finally(() => { this.working = null; });
                }
            }
        } finally { this.scanning = false; }
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
        this.cleanDisk().catch(e => console.warn('[Subtitle disk cleanup]', e.message));
        const run = () => this.tick().catch(e => console.warn('[Subtitle watchdog]', e.message));
        this.timer = setInterval(run, 60000);
        this.timer.unref();
        run();
    }
}

module.exports = SubtitleMaintenance;
