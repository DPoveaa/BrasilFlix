/**
 * Verificação pós-cleanup das séries afetadas.
 */
const db = require('../src/database/db');
const TelegramUploader = require('../src/services/TelegramUploader');
const config = require('../config');

async function count(sql, params = []) {
    const r = await db.query(sql, params);
    return r.rows;
}

async function main() {
    console.log('=== VERIFICAÇÃO PÓS-CLEANUP ===');
    console.log('STORAGE_GROUP_ID:', config.STORAGE_GROUP_ID);

    const series = await count(`
        SELECT id, nome, total_episodios, is_dublado, is_legendado
        FROM series
        WHERE nome ILIKE ANY($1)
        ORDER BY nome
    `, [[
        '%round 6%', '%squid game%',
        '%casa do drag%', '%house of the dragon%',
        '%vinland%',
        '%blue lock%'
    ]]);

    console.log('\nSéries restantes no DB:');
    if (!series.length) console.log('  (nenhuma das séries-alvo existe mais)');
    for (const s of series) {
        console.log(`  - ${s.nome} id=${s.id} eps=${s.total_episodios} dub=${s.is_dublado} leg=${s.is_legendado}`);
        const eps = await count(`
            SELECT temporada_numero, numero, message_id, is_dublado, is_legendado, versoes, duracao
            FROM episodios WHERE serie_id = $1 ORDER BY temporada_numero, numero
        `, [s.id]);
        console.log(`    episódios reais: ${eps.length}`);
        for (const ep of eps.slice(0, 5)) {
            console.log(`      T${ep.temporada_numero}E${ep.numero} msg=${ep.message_id} dub=${ep.is_dublado} leg=${ep.is_legendado}`);
        }
        if (eps.length > 5) console.log(`      ... +${eps.length - 5} mais`);
    }

    // HotD: garantir que T1E09 e T2E02 sumiram, e restantes existem
    const hotd = series.find(s => /drag/i.test(s.nome));
    if (hotd) {
        const bad = await count(`
            SELECT temporada_numero, numero, message_id FROM episodios
            WHERE serie_id = $1 AND (
                (temporada_numero = 1 AND numero = 9) OR
                (temporada_numero = 2 AND numero = 2) OR
                message_id = ANY($2)
            )
        `, [hotd.id, [325210, 317473]]);
        console.log(`\nHotD episódios inválidos remanescentes: ${bad.length} (esperado 0)`);
        const remain = await count(`SELECT COUNT(*)::int AS c FROM episodios WHERE serie_id = $1`, [hotd.id]);
        console.log(`HotD episódios restantes: ${remain[0].c}`);
    }

    // Blue Lock: dublados E1-E10 devem permanecer; legendados não
    const bl = series.find(s => /blue lock/i.test(s.nome));
    if (bl) {
        const eps = await count(`SELECT temporada_numero, numero, is_dublado, is_legendado, versoes, message_id FROM episodios WHERE serie_id = $1 ORDER BY numero`, [bl.id]);
        const withLeg = eps.filter(e => {
            let v = e.versoes || {};
            if (typeof v === 'string') try { v = JSON.parse(v); } catch { v = {}; }
            return e.is_legendado || v.legendado?.messageId;
        });
        const withDub = eps.filter(e => e.is_dublado);
        console.log(`\nBlue Lock: total=${eps.length} dublados=${withDub.length} com legendado=${withLeg.length} (legendado esperado 0)`);
        const sampleDubMsg = withDub[0]?.message_id;
        if (sampleDubMsg) {
            const uploader = TelegramUploader.getInstance();
            const map = await uploader.getStorageMessages([Number(sampleDubMsg)]);
            const info = map.get(Number(sampleDubMsg));
            console.log(`Blue Lock dublado sample msg ${sampleDubMsg}: status=${info?.status} duration=${info?.duration}s`);
        }
    }

    // Round 6 / Vinland não devem existir
    const gone = await count(`
        SELECT nome FROM series WHERE nome ILIKE ANY($1)
    `, [['%round 6%', '%squid game%', '%vinland%']]);
    console.log(`\nRound6/Vinland ainda no DB: ${gone.length} (esperado 0)`);

    // Confirma messageIds críticos ausentes no Telegram
    const critical = [325210, 324977, 325022, 324754, 324554];
    const uploader = TelegramUploader.getInstance();
    const map = await uploader.getStorageMessages(critical);
    console.log('\nMessageIds críticos no Telegram:');
    for (const id of critical) {
        const info = map.get(id);
        console.log(`  ${id}: ${info?.status || 'UNKNOWN'}`);
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
