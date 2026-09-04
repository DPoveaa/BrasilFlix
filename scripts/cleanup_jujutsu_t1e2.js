/**
 * Remove o T1E2 incorreto do Jujutsu (msg 325266 = arquivo S01E01 dublado com legenda).
 * Mantém T1E1 e T1E3 intactos.
 */
const db = require('../src/database/db');
const CatalogoManager = require('../src/managers/CatalogoManager');
const TelegramUploader = require('../src/services/TelegramUploader');
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const TARGET_MSG = 325266;

(async () => {
    console.log('=== CLEANUP Jujutsu T1E2 errado (msg', TARGET_MSG, ') ===');
    const catalogoManager = new CatalogoManager();
    await catalogoManager.loadCatalogo();

    const byMsg = await db.query(
        `SELECT e.id, e.serie_id, e.temporada_numero, e.numero, e.message_id, e.versoes, s.nome
         FROM episodios e JOIN series s ON s.id=e.serie_id
         WHERE e.message_id = $1 OR e.versoes::text LIKE $2`,
        [TARGET_MSG, `%${TARGET_MSG}%`]
    );
    console.log('matches', byMsg.rows);

    for (const ep of byMsg.rows) {
        // Só remove se for T1E2 (não mexe em E1/E3)
        if (Number(ep.temporada_numero) === 1 && Number(ep.numero) === 2 && Number(ep.message_id) === TARGET_MSG) {
            console.log(`Removendo ${ep.nome} T${ep.temporada_numero}E${ep.numero} id=${ep.id} msg=${ep.message_id}`);
            const ok = await catalogoManager.removerEpisodio(ep.id);
            console.log('removerEpisodio', ok);
        } else {
            console.log('SKIP (não é o alvo exato)', ep);
        }
    }

    // Garante telegram
    const up = TelegramUploader.getInstance();
    const map = await up.getStorageMessages([TARGET_MSG]);
    console.log('tg after', map.get(TARGET_MSG)?.status);

    // Cancela jobs T1E2 dublado completed relacionados a esse erro e limpa raw paths errados S01E01 em jobs E2
    const q = await db.query(
        `SELECT id, season, episode, status, audio_preference, extra_data
         FROM queue_jobs WHERE title ILIKE '%jujutsu%' AND season=1 AND episode=2`
    );
    for (const j of q.rows) {
        const extra = j.extra_data || {};
        const raw = extra.rawFilePath || '';
        if (/S01E01/i.test(raw) || Number(j.status === 'completed')) {
            // limpa path errado; delete job se completed com arquivo E01
            if (/S01E01/i.test(raw)) {
                console.log('Deleting mismatched E2 job', j.id, raw);
                await db.query(`DELETE FROM queue_jobs WHERE id=$1`, [j.id]);
            }
        }
    }

    // Re-enqueue E2 dublado se o arquivo S01E02 existir no pack
    const packDir = '/mnt/ssd500/projetos/BrasilFlix/downloads/temp/Jujutsu Kaisen S01 2020 WEB-DL 1080p x265 DUAL 2.0';
    const e2file = path.join(packDir, 'Jujutsu Kaisen S01E02 WEB-DL 1080p x265 DUAL 2.0.mkv');
    if (fs.existsSync(e2file)) {
        console.log('S01E02 local existe — será reprocessado quando houver job E2 na fila (não crio job automático aqui).');
    }

    // Verificação final
    const left = await db.query(
        `SELECT temporada_numero, numero, message_id FROM episodios e
         JOIN series s ON s.id=e.serie_id WHERE s.nome ILIKE '%jujutsu%' ORDER BY 1,2`
    );
    console.log('eps left', left.rows);
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
