/**
 * Inventário seguro dos episódios afetados (Round 6 / HotD / Vinland / Blue Lock).
 * NÃO deleta nada — apenas lista IDs, versões e messageIds para revisão.
 *
 * Uso (no servidor de produção):
 *   node scripts/inventory_affected_media.js
 */
const db = require('../src/database/db');
const TelegramUploader = require('../src/services/TelegramUploader');
const config = require('../config');

const TARGETS = [
    {
        key: 'squid_game',
        reason: 'Áudio original incorreto (inglês em vez de coreano / dublagem inválida)',
        namePatterns: ['%round 6%', '%squid game%', '%el juego del calamar%'],
        action: 'remove_all_versions'
    },
    {
        key: 'house_of_the_dragon',
        reason: 'Duração inválida / arquivo incompleto',
        namePatterns: ['%house of the dragon%', '%a casa do dragão%', '%house of dragon%'],
        action: 'remove_invalid_duration',
        knownBadMessageIds: [325210]
    },
    {
        key: 'vinland_saga',
        reason: 'Legendas hardsub com fonte oversized',
        namePatterns: ['%vinland saga%', '%vinland%'],
        action: 'remove_legendado_only'
    },
    {
        key: 'blue_lock',
        reason: 'Áudio original incorreto (inglês em vez de japonês)',
        namePatterns: ['%blue lock%', '%blue lock%'],
        action: 'remove_legendado_only'
    }
];

async function findSeries(patterns) {
    const clauses = patterns.map((_, i) => `nome ILIKE $${i + 1} OR nome_original ILIKE $${i + 1}`).join(' OR ');
    const res = await db.query(
        `SELECT id, nome, nome_original, tmdb_id, is_anime, is_dorama, is_dublado, is_legendado, total_episodios
         FROM series WHERE ${clauses} ORDER BY id`,
        patterns
    );
    return res.rows;
}

async function listEpisodes(serieId) {
    const res = await db.query(
        `SELECT id, serie_id, temporada_numero, numero, nome, message_id, file_id, qualidade,
                audio, is_dublado, is_legendado, versoes, duracao
         FROM episodios WHERE serie_id = $1
         ORDER BY temporada_numero, numero`,
        [serieId]
    );
    return res.rows.map(r => {
        let versoes = r.versoes || {};
        if (typeof versoes === 'string') {
            try { versoes = JSON.parse(versoes); } catch (_) { versoes = {}; }
        }
        return { ...r, versoes };
    });
}

function collectMessageIds(ep) {
    const ids = [];
    if (ep.message_id) ids.push(Number(ep.message_id));
    if (ep.versoes?.dublado?.messageId) ids.push(Number(ep.versoes.dublado.messageId));
    if (ep.versoes?.legendado?.messageId) ids.push(Number(ep.versoes.legendado.messageId));
    return [...new Set(ids.filter(Boolean))];
}

async function main() {
    console.log('================================================================');
    console.log('📋 INVENTÁRIO DE MÍDIA AFETADA (somente leitura)');
    console.log('================================================================');
    console.log('STORAGE_GROUP_ID:', config.STORAGE_GROUP_ID);

    const uploader = TelegramUploader.getInstance();
    const inventory = { generatedAt: new Date().toISOString(), storageGroupId: config.STORAGE_GROUP_ID, series: [] };

    for (const target of TARGETS) {
        console.log(`\n--- ${target.key.toUpperCase()} ---`);
        console.log('Motivo:', target.reason);
        const series = await findSeries(target.namePatterns);
        if (!series.length) {
            console.log('Nenhuma série encontrada no catálogo.');
            continue;
        }

        for (const serie of series) {
            console.log(`Série: ${serie.nome} (id=${serie.id}, tmdb=${serie.tmdb_id}, eps=${serie.total_episodios})`);
            const eps = await listEpisodes(serie.id);
            const entries = [];

            for (const ep of eps) {
                const msgIds = collectMessageIds(ep);
                const entry = {
                    episodeDbId: ep.id,
                    serieId: serie.id,
                    serieNome: serie.nome,
                    season: ep.temporada_numero,
                    episode: ep.numero,
                    nome: ep.nome,
                    audio: ep.audio,
                    isDublado: ep.is_dublado,
                    isLegendado: ep.is_legendado,
                    duracaoDbMin: ep.duracao,
                    qualidade: ep.qualidade,
                    messageId: ep.message_id ? Number(ep.message_id) : null,
                    versoes: {
                        dublado: ep.versoes?.dublado || null,
                        legendado: ep.versoes?.legendado || null
                    },
                    allMessageIds: msgIds,
                    action: target.action,
                    reason: target.reason,
                    telegramDurationSec: null,
                    flagged: false,
                    flagReason: null
                };

                if (target.action === 'remove_all_versions') {
                    entry.flagged = true;
                    entry.flagReason = 'série inteira afetada por seleção de áudio incorreta';
                } else if (target.action === 'remove_legendado_only') {
                    if (ep.versoes?.legendado?.messageId || (ep.is_legendado && ep.message_id)) {
                        entry.flagged = true;
                        entry.flagReason = 'versão legendada afetada';
                        entry.targetVersion = 'legendado';
                        entry.targetMessageId = ep.versoes?.legendado?.messageId || ep.message_id;
                    }
                } else if (target.action === 'remove_invalid_duration') {
                    const knownBad = (target.knownBadMessageIds || []).some(id => msgIds.includes(Number(id)));
                    if (knownBad) {
                        entry.flagged = true;
                        entry.flagReason = `messageId conhecido inválido (${msgIds.filter(id => target.knownBadMessageIds.includes(id)).join(',')})`;
                    }
                }

                entries.push(entry);
            }

            // Consulta duração real no Telegram para HotD (e qualquer flagged sem duração)
            const idsToProbe = [...new Set(entries.flatMap(e => e.allMessageIds))];
            if (target.action === 'remove_invalid_duration' && idsToProbe.length > 0) {
                console.log(`Consultando ${idsToProbe.length} messageIds no Telegram para duração...`);
                try {
                    const map = await uploader.getStorageMessages(idsToProbe);
                    for (const entry of entries) {
                        for (const mid of entry.allMessageIds) {
                            const info = map.get(Number(mid));
                            if (info) {
                                entry.telegramDurationSec = info.duration || entry.telegramDurationSec;
                                // HotD: episódios típicos ~50-70 min; < 25 min é inválido
                                if (info.duration > 0 && info.duration < 25 * 60) {
                                    entry.flagged = true;
                                    entry.flagReason = `duração Telegram=${info.duration}s (< 25 min)`;
                                    entry.targetMessageId = mid;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('Falha ao consultar Telegram:', e.message);
                }
            }

            const flagged = entries.filter(e => e.flagged);
            console.log(`Episódios totais: ${entries.length} | Marcados para remoção: ${flagged.length}`);
            for (const f of flagged) {
                console.log(
                    `  ⚠ T${f.season}E${String(f.episode).padStart(2, '0')} ` +
                    `msgIds=[${f.allMessageIds.join(',')}] ` +
                    `dub=${!!f.versoes.dublado} leg=${!!f.versoes.legendado} ` +
                    `tgDur=${f.telegramDurationSec ?? '-'}s ` +
                    `| ${f.flagReason}`
                );
            }

            inventory.series.push({
                targetKey: target.key,
                serie,
                episodes: entries,
                flaggedCount: flagged.length,
                flaggedMessageIds: [...new Set(flagged.flatMap(f => {
                    if (f.targetVersion === 'legendado' && f.targetMessageId) return [Number(f.targetMessageId)];
                    if (f.targetMessageId) return [Number(f.targetMessageId)];
                    return f.allMessageIds;
                }))]
            });
        }
    }

    const outPath = require('path').join(__dirname, '..', 'temp_affected_media_inventory.json');
    require('fs').writeFileSync(outPath, JSON.stringify(inventory, null, 2), 'utf8');
    console.log(`\n📄 Inventário salvo em: ${outPath}`);
    console.log('Nenhuma exclusão foi feita. Revise o JSON e execute cleanup_affected_media.js --execute');
    process.exit(0);
}

main().catch(e => {
    console.error('❌ Inventory failed:', e);
    process.exit(1);
});
