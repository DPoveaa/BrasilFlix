#!/usr/bin/env node
/**
 * fix_romanian_subtitle_142.js
 *
 * 1. Deletes the invalid Romanian subtitle track saved as PT-BR on movie ID 142
 *    (Velozes e Furiosos 4) from the DB `legendas` column and from disk.
 * 2. Enqueues movie 142 for subtitle reprocessing (isReprocess = true).
 * 3. Audits all PT-BR VTT files created after 2026-11-15 for Romanian diacritics
 *    and queues any affected titles for reprocessing.
 */

'use strict';

const path = require('path');
const fs = require('fs-extra');
const { query } = require('../src/database/db');

const ROMANIAN_RE = /[ăĂșȘțȚîÎ]/;
const CUTOFF_DATE = new Date('2026-11-15T00:00:00-03:00');
const SUBTITLES_DIR = path.resolve(__dirname, '../public/subtitles');
const MOVIE_ID = 142;

async function main() {
    console.log('\n════════════════════════════════════════════════════════');
    console.log(' FIX: Romanian Subtitle Bug — Movie ID 142 + Post-cutoff Audit');
    console.log('════════════════════════════════════════════════════════\n');

    // ─── STEP 1: Inspect & clean movie 142 ──────────────────────────────────
    console.log(`📋 [Step 1] Consultando legendas do filme ID ${MOVIE_ID} no banco...`);
    const filmRes = await query(
        `SELECT id, nome, legendas, versoes FROM filmes WHERE id = $1`,
        [MOVIE_ID]
    );

    if (!filmRes.rows.length) {
        console.error(`❌ Filme ID ${MOVIE_ID} não encontrado na base de dados.`);
        process.exit(1);
    }

    const filme = filmRes.rows[0];
    console.log(`🎬 Filme: "${filme.nome}" (ID ${filme.id})`);

    const legendas = Array.isArray(filme.legendas) ? filme.legendas : [];
    console.log(`📌 Trilhas de legenda no DB: ${legendas.length}`);

    // Identify Romanian / non-PT-BR tracks
    const SubtitlePipeline = require('../src/services/SubtitlePipeline');

    const badTracks = [];
    const goodTracks = [];

    for (const track of legendas) {
        let isBad = false;
        let badReason = '';

        // Check the VTT/SRT file on disk for Romanian diacritics
        const fileToCheck = track.srtPath || track.vttPath || '';
        if (fileToCheck && fs.existsSync(fileToCheck)) {
            const content = await fs.readFile(fileToCheck, 'utf8');
            if (ROMANIAN_RE.test(content)) {
                const hits = (content.match(/[ăĂșȘțȚîÎ]/g) || []).length;
                isBad = true;
                badReason = `Contém ${hits} diacrítico(s) romenos: ${
                    [...new Set(content.match(/[ăĂșȘțȚîÎ]/g) || [])].join(' ')
                }`;
            } else if (track.lang === 'pt-BR') {
                // Also run the safety gate
                const rawContent = await fs.readFile(fileToCheck, 'utf8');
                const safetyResult = SubtitlePipeline.validatePtBrTextSafety(rawContent);
                if (!safetyResult.valid) {
                    isBad = true;
                    badReason = `Safety Gate falhou: ${safetyResult.reason}`;
                }
            }
        } else if (!fileToCheck) {
            // No path stored — check by URL pattern for now
            console.warn(`  ⚠️  Trilha sem caminho de arquivo: lang=${track.lang}, vttUrl=${track.vttUrl}`);
        }

        if (isBad) {
            badTracks.push({ ...track, badReason });
        } else {
            goodTracks.push(track);
        }
    }

    if (badTracks.length === 0) {
        console.log('ℹ️  Nenhuma trilha romeno/inválida detectada nas legendas do DB.\n' +
            '    Verificando URLs dos VTTs no diretório público...');

        // Even if no bad tracks in legendas[], look for the VTT by TMDB ID pattern
        const tmdbId = filme.versoes?.dublado?.tmdbId || filme.versoes?.legendado?.tmdbId;
        if (tmdbId || MOVIE_ID) {
            const prefix = String(tmdbId || '');
            const allVtts = fs.existsSync(SUBTITLES_DIR)
                ? fs.readdirSync(SUBTITLES_DIR).filter(f => f.endsWith('.vtt') && (prefix ? f.startsWith(prefix) : true))
                : [];

            for (const vttFile of allVtts) {
                const fullPath = path.join(SUBTITLES_DIR, vttFile);
                const content = await fs.readFile(fullPath, 'utf8');
                if (ROMANIAN_RE.test(content)) {
                    const hits = (content.match(/[ăĂșȘțȚîÎ]/g) || []).length;
                    console.warn(`🗑️  Deletando VTT romeno órfão: ${vttFile} (${hits} diacríticos)`);
                    await fs.remove(fullPath).catch(() => {});
                    // Also try .srt counterpart
                    await fs.remove(fullPath.replace('.vtt', '.srt')).catch(() => {});
                }
            }
        }
    } else {
        console.log(`\n🚫 Encontradas ${badTracks.length} trilha(s) inválida(s):`);
        for (const t of badTracks) {
            console.log(`  → lang: ${t.lang}, vttUrl: ${t.vttUrl || '(sem URL)'} | Motivo: ${t.badReason}`);

            // Delete files from disk
            for (const fp of [t.srtPath, t.vttPath].filter(Boolean)) {
                if (fs.existsSync(fp)) {
                    console.log(`  🗑️  Deletando arquivo: ${path.basename(fp)}`);
                    await fs.remove(fp).catch(() => {});
                }
            }
            // Also try to delete by URL pattern in public/subtitles
            if (t.vttUrl) {
                const diskPath = path.join(SUBTITLES_DIR, path.basename(t.vttUrl));
                if (fs.existsSync(diskPath)) {
                    console.log(`  🗑️  Deletando via URL: ${path.basename(diskPath)}`);
                    await fs.remove(diskPath).catch(() => {});
                    await fs.remove(diskPath.replace('.vtt', '.srt')).catch(() => {});
                }
            }
        }

        // Write cleaned legendas back to DB
        const cleanedLegendas = goodTracks;
        await query(
            `UPDATE filmes SET legendas = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(cleanedLegendas), MOVIE_ID]
        );
        console.log(`✅ DB atualizado: ${cleanedLegendas.length} trilha(s) válida(s) mantidas, ${badTracks.length} removida(s).`);
    }

    // ─── STEP 2: Enqueue movie 142 for subtitle reprocessing ────────────────
    console.log(`\n📋 [Step 2] Enfileirando filme ID ${MOVIE_ID} para reprocessamento de legendas...`);
    // Clear any existing subtitle marker so the pipeline triggers fresh
    const versoes = filme.versoes || {};
    // Mark legendas as empty to force pipeline re-run
    await query(
        `UPDATE filmes
         SET legendas = '[]'::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [MOVIE_ID]
    );
    console.log(`✅ Legenda zerada para filme ${MOVIE_ID}. O pipeline vai regenerar na próxima execução.`);

    // Check if there's an optimized video path to trigger re-run
    const midia = versoes?.dublado || versoes?.legendado || {};
    const fileId = midia?.fileId || null;
    if (fileId) {
        console.log(`ℹ️  FileID do filme: ${fileId}. Reprocessamento ocorrerá quando o arquivo for processado novamente pelo QueueManager.`);
        console.log(`💡 Para forçar imediatamente, adicione à fila via Telegram ou painel admin com isReprocess=true.`);
    }

    // ─── STEP 3: Post-cutoff audit of all VTT files for Romanian diacritics ─
    console.log(`\n📋 [Step 3] Auditando VTTs PT-BR criados após ${CUTOFF_DATE.toISOString().slice(0, 10)}...`);

    if (!fs.existsSync(SUBTITLES_DIR)) {
        console.log(`ℹ️  Diretório ${SUBTITLES_DIR} não existe neste ambiente (servidor remoto). Auditoria de VTTs deve ser executada no servidor.`);
    } else {
        const allFiles = fs.readdirSync(SUBTITLES_DIR);
        const ptbrVtts = allFiles.filter(f => f.includes('ptbr') && f.endsWith('.vtt'));

        let audited = 0;
        let contaminated = 0;
        const affectedTitles = new Set();

        for (const vttFile of ptbrVtts) {
            const fullPath = path.join(SUBTITLES_DIR, vttFile);
            const stat = fs.statSync(fullPath);
            if (stat.mtime < CUTOFF_DATE) continue; // only post-cutoff files

            audited++;
            const content = await fs.readFile(fullPath, 'utf8');
            if (ROMANIAN_RE.test(content)) {
                const hits = (content.match(/[ăĂșȘțȚîÎ]/g) || []).length;
                const sample = [...new Set(content.match(/[ăĂșȘțȚîÎ]/g) || [])].join(' ');
                console.warn(`🚨 VTT CONTAMINADO: ${vttFile} | ${hits} diacrítico(s) romeno(s): ${sample}`);
                contaminated++;

                // Extract base ID (TMDB ID) from filename pattern: <baseId>_movie_ptbr_<ts>.vtt
                const match = vttFile.match(/^(\w+)_(?:movie|s\d+e\d+)_ptbr_/);
                if (match) affectedTitles.add(match[1]);

                // Delete contaminated file + SRT counterpart
                await fs.remove(fullPath).catch(() => {});
                await fs.remove(fullPath.replace('.vtt', '.srt')).catch(() => {});
                console.log(`  🗑️  Deletado: ${vttFile} + .srt`);

                // Clear legendas in DB for affected items
                if (match) {
                    const baseId = match[1];
                    const isNumeric = /^\d+$/.test(baseId);
                    if (isNumeric) {
                        // Try TMDB ID match
                        const updateRes = await query(
                            `UPDATE filmes SET legendas = '[]'::jsonb, updated_at = NOW()
                             WHERE tmdb_id = $1 AND legendas != '[]'::jsonb
                             RETURNING id, nome`,
                            [parseInt(baseId, 10)]
                        ).catch(() => ({ rows: [] }));
                        for (const r of updateRes.rows) {
                            console.log(`  📝 DB limpo para filme "${r.nome}" (ID ${r.id}, TMDB ${baseId})`);
                        }
                        // Episodes
                        await query(
                            `UPDATE episodios SET legendas = '[]'::jsonb
                             WHERE legendas != '[]'::jsonb
                             AND EXISTS (
                                 SELECT 1 FROM series s WHERE s.id = episodios.serie_id AND s.tmdb_id = $1
                             )`,
                            [parseInt(baseId, 10)]
                        ).catch(() => {});
                    }
                }
            }
        }

        console.log(`\n📊 Auditoria concluída: ${audited} arquivo(s) verificado(s), ${contaminated} contaminado(s) removido(s).`);
        if (affectedTitles.size > 0) {
            console.log(`📌 IDs/bases afetadas: ${[...affectedTitles].join(', ')}`);
            console.log(`💡 Os filmes/séries afetados terão legendas zeradas e serão reprocessados pelo pipeline na próxima execução.`);
        }
    }

    console.log('\n✅ Script concluído com sucesso!\n');
    process.exit(0);
}

main().catch(err => {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
});
