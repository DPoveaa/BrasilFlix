const db = require('../src/database/db');
const TelegramUploader = require('../src/services/TelegramUploader');
const { execSync } = require('child_process');
const fs = require('fs');

(async () => {
    console.log('=== JUJUTSU DIAG ===');
    const s = await db.query(`SELECT id,nome,total_episodios,is_dublado,is_legendado FROM series WHERE nome ILIKE '%jujutsu%'`);
    console.log('series', JSON.stringify(s.rows, null, 2));
    for (const row of s.rows) {
        const eps = await db.query(
            `SELECT id,temporada_numero,numero,message_id,audio,is_dublado,is_legendado,versoes,qualidade
             FROM episodios WHERE serie_id=$1 ORDER BY temporada_numero,numero`,
            [row.id]
        );
        console.log('eps', JSON.stringify(eps.rows, null, 2));
    }
    const byMsg = await db.query(
        `SELECT e.id,e.serie_id,e.temporada_numero,e.numero,e.message_id,e.audio,e.is_dublado,e.is_legendado,e.versoes,s.nome
         FROM episodios e JOIN series s ON s.id=e.serie_id
         WHERE e.message_id=325266 OR e.versoes::text LIKE '%325266%'`
    );
    console.log('byMsg', JSON.stringify(byMsg.rows, null, 2));

    const q = await db.query(
        `SELECT id,title,type,season,episode,status,audio_preference,progress,progress_details,extra_data,updated_at
         FROM queue_jobs WHERE title ILIKE '%jujutsu%' ORDER BY updated_at DESC LIMIT 40`
    );
    console.log('queue count', q.rows.length);
    for (const j of q.rows) {
        const extra = j.extra_data || {};
        console.log(`#${j.id} T${j.season}E${j.episode} ${j.status} pref=${j.audio_preference} ${j.progress}% :: ${j.progress_details || ''}`);
        if (extra.rawFilePath || extra.bestSource?.title) {
            console.log('  raw=', extra.rawFilePath || '');
            console.log('  src=', extra.bestSource?.title || extra.sourceTitle || '');
        }
    }

    const up = TelegramUploader.getInstance();
    const map = await up.getStorageMessages([325266]);
    const info = map.get(325266);
    console.log('tg325266', info && { status: info.status, duration: info.duration, fileName: info.fileName, docSize: info.docSize });

    try {
        const disk = execSync(`find /mnt/ssd500/projetos/BrasilFlix/downloads -iname '*jujutsu*' 2>/dev/null | head -n 80`, { encoding: 'utf8' });
        console.log('disk:\n' + disk);
    } catch (e) {
        console.log('disk find failed', e.message);
    }

    // Probe any local opt/raw for subtitle streams if present
    const candidates = [];
    try {
        const disk2 = execSync(`find /mnt/ssd500/projetos/BrasilFlix/downloads -iname '*jujutsu*' \\( -name '*.mkv' -o -name '*.mp4' \\) 2>/dev/null | head -n 20`, { encoding: 'utf8' });
        for (const p of disk2.split('\n').map(s => s.trim()).filter(Boolean)) candidates.push(p);
    } catch (_) {}
    for (const j of q.rows) {
        const extra = j.extra_data || {};
        if (extra.optimizedPath && fs.existsSync(extra.optimizedPath)) candidates.push(extra.optimizedPath);
        if (extra.rawFilePath && fs.existsSync(extra.rawFilePath)) candidates.push(extra.rawFilePath);
    }
    const uniq = [...new Set(candidates)].slice(0, 5);
    for (const p of uniq) {
        try {
            const probe = execSync(`ffprobe -v quiet -print_format json -show_streams "${p}"`, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
            const infoP = JSON.parse(probe);
            const aud = (infoP.streams || []).filter(s => s.codec_type === 'audio').map(a => ({
                lang: a.tags?.language, title: a.tags?.title, codec: a.codec_name
            }));
            const subs = (infoP.streams || []).filter(s => s.codec_type === 'subtitle').map(s => ({
                lang: s.tags?.language, title: s.tags?.title, codec: s.codec_name
            }));
            console.log('PROBE', p);
            console.log('  audio', JSON.stringify(aud));
            console.log('  subs', JSON.stringify(subs));
        } catch (e) {
            console.log('probe fail', p, e.message);
        }
    }
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
