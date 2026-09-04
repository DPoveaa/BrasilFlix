/**
 * Diagnóstico Round 6 T2E6 (msg 325264) + limpeza segura da série na fila/SSD/catálogo.
 * Uso:
 *   node scripts/diagnose_round6_t2e6.js
 *   node scripts/diagnose_round6_t2e6.js --cleanup
 */
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const db = require('../src/database/db');
const CatalogoManager = require('../src/managers/CatalogoManager');
const TelegramUploader = require('../src/services/TelegramUploader');
const VideoProcessor = require('../src/services/VideoProcessor');
const config = require('../config');

const DO_CLEANUP = process.argv.includes('--cleanup');
const TARGET_MSG = 325264;

function listDiskMatches() {
    const roots = [
        config.DOWNLOAD_DIR,
        config.TEMP_DIR,
        path.resolve(__dirname, '../downloads'),
        path.resolve(__dirname, '../temp'),
        '/mnt/ssd500/projetos/BrasilFlix/downloads',
        '/mnt/ssd500/projetos/BrasilFlix/temp'
    ].filter(Boolean);

    const patterns = ['*round*6*', '*Round*6*', '*squid*', '*Squid*', '*HODL*'];
    const found = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const pat of patterns) {
            try {
                const out = execSync(`find ${JSON.stringify(root)} -iname ${JSON.stringify(pat)} 2>/dev/null | head -n 200`, {
                    encoding: 'utf8',
                    shell: '/bin/bash'
                });
                for (const line of out.split('\n').map(s => s.trim()).filter(Boolean)) {
                    found.push(line);
                }
            } catch (_) {}
        }
    }
    return [...new Set(found)];
}

async function main() {
    console.log('=== DIAGNÓSTICO Round 6 / msg', TARGET_MSG, '===');
    console.log('STORAGE_GROUP_ID:', config.STORAGE_GROUP_ID);
    console.log('Mode:', DO_CLEANUP ? 'CLEANUP' : 'DIAGNOSE_ONLY');

    // 1) Simular seleção de áudio do release Dual HODL
    const fakeStreamsTagged = [
        { language: 'eng', title: 'english', codec: 'eac3', channels: 6 },
        { language: 'kor', title: 'korean', codec: 'eac3', channels: 6 }
    ];
    const fakeStreamsUnd = [
        { language: 'und', title: '', codec: 'eac3', channels: 6 },
        { language: 'und', title: '', codec: 'eac3', channels: 6 }
    ];
    const metaLeg = {
        isLegendado: true,
        isDublado: false,
        idiomaOriginal: 'ko',
        isDorama: true,
        nome: 'Round 6'
    };
    const idxTagged = VideoProcessor.detectTargetAudioIndex(fakeStreamsTagged, metaLeg, 'Squid.Game.S02.Complete.1080p.WEBRip.10bit.Dual.DDP5.1.x265-HODL');
    const idxUnd = VideoProcessor.detectTargetAudioIndex(fakeStreamsUnd, metaLeg, 'Squid.Game.S02.Complete.1080p.WEBRip.10bit.Dual.DDP5.1.x265-HODL');
    console.log('\n[Simulação código atual]');
    console.log('  Dual eng+kor tagged → index', idxTagged, '(esperado 1=kor)');
    console.log('  Dual und+und → index', idxUnd, '(heurística não-inglesa; und+und pode falhar)');

    // 2) DB série/eps
    const series = await db.query(
        `SELECT id, nome, total_episodios, is_dublado, is_legendado FROM series
         WHERE nome ILIKE '%round 6%' OR nome ILIKE '%squid%' OR nome_original ILIKE '%squid%'`
    );
    console.log('\n[Séries DB]', series.rows);

    let allEps = [];
    for (const s of series.rows) {
        const eps = await db.query(
            `SELECT id, serie_id, temporada_numero, numero, message_id, audio, is_dublado, is_legendado, versoes, qualidade
             FROM episodios WHERE serie_id = $1 ORDER BY temporada_numero, numero`,
            [s.id]
        );
        allEps = allEps.concat(eps.rows.map(r => ({ ...r, serieNome: s.nome })));
        console.log(`  ${s.nome} eps=${eps.rows.length}`);
        for (const ep of eps.rows) {
            console.log(`    T${ep.temporada_numero}E${ep.numero} msg=${ep.message_id} audio=${ep.audio} dub=${ep.is_dublado} leg=${ep.is_legendado}`);
        }
    }

    const byMsg = await db.query(
        `SELECT e.id, e.serie_id, e.temporada_numero, e.numero, e.message_id, e.audio, e.versoes, s.nome
         FROM episodios e JOIN series s ON s.id = e.serie_id
         WHERE e.message_id = $1 OR e.versoes::text LIKE $2`,
        [TARGET_MSG, `%${TARGET_MSG}%`]
    );
    console.log('\n[Ep por messageId 325264]', byMsg.rows);

    // 3) Fila
    const queue = await db.query(
        `SELECT id, title, type, season, episode, status, audio_preference, progress, progress_details,
                extra_data, created_at, updated_at
         FROM queue_jobs
         WHERE title ILIKE '%round 6%' OR title ILIKE '%squid%'
         ORDER BY id DESC LIMIT 80`
    );
    console.log('\n[Fila Round 6]', queue.rows.length, 'jobs');
    for (const j of queue.rows) {
        const extra = j.extra_data || {};
        console.log(`  #${j.id} T${j.season}E${j.episode} ${j.status} ${j.audio_preference || ''} ${j.progress || 0}% :: ${j.progress_details || ''}`);
        if (extra.rawFilePath) console.log('     raw:', extra.rawFilePath);
        if (extra.optimizedPath) console.log('     opt:', extra.optimizedPath);
        j.raw_file_path = extra.rawFilePath || extra.raw_file_path || null;
        j.optimized_path = extra.optimizedPath || extra.optimized_path || null;
    }

    // 4) Telegram
    const uploader = TelegramUploader.getInstance();
    const map = await uploader.getStorageMessages([TARGET_MSG]);
    const tg = map.get(TARGET_MSG);
    console.log('\n[Telegram 325264]', tg ? {
        status: tg.status,
        duration: tg.duration,
        fileName: tg.fileName,
        docSize: tg.docSize
    } : null);

    // 5) Disco
    const disk = listDiskMatches();
    console.log('\n[SSD matches Round6/Squid/HODL]', disk.length);
    for (const p of disk.slice(0, 50)) console.log('  ', p);
    if (disk.length > 50) console.log(`  ... +${disk.length - 50}`);

    // 6) Conclusão diagnóstica
    const labelSaysKorean = (byMsg.rows[0]?.audio || '').toLowerCase().includes('coreano') ||
        (byMsg.rows[0]?.audio || '').toLowerCase().includes('korean');
    console.log('\n[Conclusão]');
    console.log('  Catálogo label coreano?', labelSaysKorean || '(ver audio field)');
    console.log('  Código atual com tags eng+kor escolhe KO?', idxTagged === 1);
    console.log('  Se o arquivo Dual HODL tinha tags corretas, código NOVO deveria pegar KO.');
    console.log('  Se usuário ouviu inglês, ou (a) job antigo em voo, ou (b) tags und/ordem errada ainda falhou.');

    if (!DO_CLEANUP) {
        console.log('\nDry-run only. Para limpar catálogo+telegram+fila+ssd:');
        console.log('  node scripts/diagnose_round6_t2e6.js --cleanup');
        process.exit(0);
    }

    console.log('\n=== CLEANUP Round 6 ===');
    const catalogoManager = new CatalogoManager();
    await catalogoManager.loadCatalogo();

    // Remover episódios/série Round 6 do catálogo + telegram
    for (const s of series.rows) {
        console.log(`Removendo série id=${s.id} ${s.nome}...`);
        const ok = await catalogoManager.removerItem(s.id);
        console.log('  removerItem:', ok);
    }
    // Também remove pelo messageId isolado se sobrou
    if (byMsg.rows.length) {
        for (const ep of byMsg.rows) {
            await catalogoManager.removerEpisodio(ep.id).catch(() => {});
            await catalogoManager.removerEpisodio(TARGET_MSG).catch(() => {});
        }
    } else if (tg && tg.status === 'FOUND') {
        console.log('Ep não está no DB mas msg existe no Telegram — apagando msg 325264');
        await TelegramUploader.deleteStorageMessages([TARGET_MSG]);
    }

    // Cancelar/limpar jobs da fila
    const activeStatuses = ['queued', 'downloading', 'processing', 'uploading', 'searching', 'pending', 'running'];
    for (const j of queue.rows) {
        const paths = [j.raw_file_path, j.optimized_path].filter(Boolean);
        for (const p of paths) {
            try {
                if (fs.existsSync(p)) {
                    await fs.remove(p);
                    console.log('  removed job file:', p);
                }
                // se for pasta do episódio
                const dir = path.dirname(p);
                if (/round|squid|hodl/i.test(dir) && fs.existsSync(dir)) {
                    // não apaga download root inteiro
                }
            } catch (e) {
                console.warn('  fail remove', p, e.message);
            }
        }
        if (activeStatuses.includes(String(j.status || '').toLowerCase()) || j.status === 'completed' || j.status === 'failed') {
            await db.query(`DELETE FROM queue_jobs WHERE id = $1`, [j.id]);
            console.log(`  deleted queue job #${j.id} (${j.status} T${j.season}E${j.episode})`);
        }
    }

    // Limpa arquivos SSD restantes
    for (const p of disk) {
        try {
            if (!fs.existsSync(p)) continue;
            await fs.remove(p);
            console.log('  removed disk:', p);
        } catch (e) {
            console.warn('  fail disk', p, e.message);
        }
    }

    // Verificação final
    const leftS = await db.query(
        `SELECT id,nome FROM series WHERE nome ILIKE '%round 6%' OR nome ILIKE '%squid%'`
    );
    const leftQ = await db.query(
        `SELECT id,status,season,episode FROM queue_jobs WHERE title ILIKE '%round 6%' OR title ILIKE '%squid%'`
    );
    const leftMap = await uploader.getStorageMessages([TARGET_MSG]);
    console.log('\n[Pós-cleanup]');
    console.log('  series left:', leftS.rows);
    console.log('  queue left:', leftQ.rows);
    console.log('  telegram 325264:', leftMap.get(TARGET_MSG)?.status);
    console.log('  disk left:', listDiskMatches().length);
    process.exit(0);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
