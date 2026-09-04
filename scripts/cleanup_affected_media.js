/**
 * Cleanup seguro de mídia afetada (Round 6 / HotD / Vinland / Blue Lock).
 *
 * Fluxo:
 *  1. Carrega temp_affected_media_inventory.json (gerado por inventory_affected_media.js)
 *  2. Revalida cada item no PostgreSQL (serie + season + episode + messageId)
 *  3. Só então remove catalogo + Telegram
 *
 * Uso:
 *   node scripts/cleanup_affected_media.js              # dry-run
 *   node scripts/cleanup_affected_media.js --execute     # executa
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/database/db');
const CatalogoManager = require('../src/managers/CatalogoManager');
const config = require('../config');

const EXECUTE = process.argv.includes('--execute');
const INVENTORY_PATH = path.join(__dirname, '..', 'temp_affected_media_inventory.json');

function collectMessageIds(ep) {
    const ids = [];
    if (ep.message_id) ids.push(Number(ep.message_id));
    if (ep.versoes?.dublado?.messageId) ids.push(Number(ep.versoes.dublado.messageId));
    if (ep.versoes?.legendado?.messageId) ids.push(Number(ep.versoes.legendado.messageId));
    return [...new Set(ids.filter(Boolean))];
}

async function revalidateEpisode(entry) {
    const res = await db.query(
        `SELECT id, serie_id, temporada_numero, numero, message_id, versoes, is_dublado, is_legendado
         FROM episodios
         WHERE serie_id = $1 AND temporada_numero = $2 AND numero = $3`,
        [entry.serieId, entry.season, entry.episode]
    );
    if (!res.rows.length) return { ok: false, reason: 'episodio_ausente_no_db' };
    const row = res.rows[0];
    let versoes = row.versoes || {};
    if (typeof versoes === 'string') {
        try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
    }

    const currentIds = collectMessageIds({ ...row, versoes });
    const expectedIds = entry.allMessageIds || [];
    const overlap = expectedIds.filter(id => currentIds.includes(Number(id)));

    if (expectedIds.length && overlap.length === 0) {
        return { ok: false, reason: `messageIds_divergentes expected=[${expectedIds}] current=[${currentIds}]` };
    }

    return { ok: true, row: { ...row, versoes }, currentIds };
}

async function main() {
    console.log('================================================================');
    console.log(EXECUTE ? '🗑️  CLEANUP AFETADOS (EXECUTE)' : '🔎 CLEANUP AFETADOS (DRY-RUN)');
    console.log('================================================================');
    console.log('STORAGE_GROUP_ID:', config.STORAGE_GROUP_ID);

    if (!fs.existsSync(INVENTORY_PATH)) {
        console.error(`❌ Inventário não encontrado: ${INVENTORY_PATH}`);
        console.error('Execute antes: node scripts/inventory_affected_media.js');
        process.exit(1);
    }

    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
    if (inventory.storageGroupId && Number(inventory.storageGroupId) !== Number(config.STORAGE_GROUP_ID)) {
        console.error(`❌ STORAGE_GROUP_ID do inventário (${inventory.storageGroupId}) != config (${config.STORAGE_GROUP_ID}). Abortando.`);
        process.exit(1);
    }

    const catalogoManager = new CatalogoManager();
    await catalogoManager.loadCatalogo();

    const report = {
        mode: EXECUTE ? 'execute' : 'dry-run',
        startedAt: new Date().toISOString(),
        removed: [],
        skipped: [],
        errors: []
    };

    for (const block of (inventory.series || [])) {
        const flagged = (block.episodes || []).filter(e => e.flagged);
        console.log(`\n--- ${block.targetKey} / ${block.serie?.nome} (id=${block.serie?.id}) — ${flagged.length} marcados ---`);

        for (const entry of flagged) {
            const label = `${entry.serieNome} T${entry.season}E${entry.episode}`;
            try {
                const check = await revalidateEpisode(entry);
                if (!check.ok) {
                    console.log(`⏭  SKIP ${label}: ${check.reason}`);
                    report.skipped.push({ ...entry, skipReason: check.reason });
                    continue;
                }

                const action = entry.action;
                let plan = { type: null, messageIds: [] };

                if (action === 'remove_all_versions') {
                    plan = { type: 'episode_full', messageIds: check.currentIds };
                } else if (action === 'remove_legendado_only') {
                    const legMsg = check.row.versoes?.legendado?.messageId ||
                        (check.row.is_legendado && !check.row.versoes?.dublado ? check.row.message_id : null);
                    const expected = entry.targetMessageId || legMsg;
                    if (!legMsg && !expected) {
                        report.skipped.push({ ...entry, skipReason: 'sem_versao_legendada' });
                        console.log(`⏭  SKIP ${label}: sem versão legendada`);
                        continue;
                    }
                    // Prova forte: messageId da versão legendada deve bater
                    if (expected && check.row.versoes?.legendado?.messageId &&
                        Number(check.row.versoes.legendado.messageId) !== Number(expected) &&
                        Number(check.row.message_id) !== Number(expected)) {
                        report.skipped.push({ ...entry, skipReason: `legendado_msg_mismatch expected=${expected}` });
                        console.log(`⏭  SKIP ${label}: messageId legendado não confere`);
                        continue;
                    }
                    plan = {
                        type: 'version_legendado',
                        messageIds: [Number(expected || legMsg)].filter(Boolean),
                        expectedMessageId: Number(expected || legMsg)
                    };
                } else if (action === 'remove_invalid_duration') {
                    const targetMsg = entry.targetMessageId || entry.messageId;
                    if (!targetMsg || !check.currentIds.includes(Number(targetMsg))) {
                        report.skipped.push({ ...entry, skipReason: `msg_invalida_nao_encontrada=${targetMsg}` });
                        console.log(`⏭  SKIP ${label}: messageId inválido não está no episódio`);
                        continue;
                    }
                    // Se só há uma versão, remove episódio inteiro; se há duas, remove a versão cujo msgId bate
                    const dubId = check.row.versoes?.dublado?.messageId ? Number(check.row.versoes.dublado.messageId) : null;
                    const legId = check.row.versoes?.legendado?.messageId ? Number(check.row.versoes.legendado.messageId) : null;
                    if (dubId && Number(targetMsg) === dubId && legId) {
                        plan = { type: 'version_dublado', messageIds: [dubId], expectedMessageId: dubId };
                    } else if (legId && Number(targetMsg) === legId && dubId) {
                        plan = { type: 'version_legendado', messageIds: [legId], expectedMessageId: legId };
                    } else {
                        plan = { type: 'episode_full', messageIds: check.currentIds };
                    }
                } else {
                    report.skipped.push({ ...entry, skipReason: `action_desconhecida=${action}` });
                    continue;
                }

                console.log(
                    `${EXECUTE ? '🗑' : '🔎'} ${label} → ${plan.type} ` +
                    `msgIds=[${plan.messageIds.join(',')}] chat=${config.STORAGE_GROUP_ID} ` +
                    `| ${entry.flagReason || entry.reason}`
                );

                if (!EXECUTE) {
                    report.removed.push({ dryRun: true, label, plan, entry });
                    continue;
                }

                let result;
                if (plan.type === 'episode_full') {
                    // Preferir remover pelo messageId primário revalidado
                    const primary = check.row.message_id || plan.messageIds[0];
                    result = await catalogoManager.removerEpisodio(primary);
                    if (!result) {
                        // fallback por id do episódio
                        result = await catalogoManager.removerEpisodio(check.row.id);
                    }
                } else if (plan.type === 'version_legendado') {
                    result = await catalogoManager.removerVersaoEpisodio({
                        serieId: entry.serieId,
                        temporada: entry.season,
                        episodio: entry.episode,
                        versao: 'legendado',
                        expectedMessageId: plan.expectedMessageId
                    });
                    if (!result.success) throw new Error(result.reason || 'falha_remover_legendado');
                } else if (plan.type === 'version_dublado') {
                    result = await catalogoManager.removerVersaoEpisodio({
                        serieId: entry.serieId,
                        temporada: entry.season,
                        episodio: entry.episode,
                        versao: 'dublado',
                        expectedMessageId: plan.expectedMessageId
                    });
                    if (!result.success) throw new Error(result.reason || 'falha_remover_dublado');
                }

                report.removed.push({ label, plan, result, entry });
            } catch (e) {
                console.error(`❌ ERRO ${label}:`, e.message);
                report.errors.push({ entry, error: e.message });
            }
        }
    }

    report.finishedAt = new Date().toISOString();
    const reportPath = path.join(__dirname, '..', `temp_cleanup_report_${EXECUTE ? 'exec' : 'dry'}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log('\n================================================================');
    console.log(`Removidos/planejados: ${report.removed.length}`);
    console.log(`Skipped: ${report.skipped.length}`);
    console.log(`Erros: ${report.errors.length}`);
    console.log(`Relatório: ${reportPath}`);
    if (!EXECUTE) {
        console.log('\nDry-run concluído. Para executar de verdade:');
        console.log('  node scripts/cleanup_affected_media.js --execute');
    }
    process.exit(report.errors.length ? 1 : 0);
}

main().catch(e => {
    console.error('❌ Cleanup failed:', e);
    process.exit(1);
});
