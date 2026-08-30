const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const db = require('../src/database/db');
const TelegramUploader = require('../src/services/TelegramUploader');
const CatalogoManager = require('../src/managers/CatalogoManager');
const config = require('../config');

async function runDeepAudit() {
    console.log('================================================================');
    console.log('🔍 BRASILFLIX - RELATÓRIO COMPLETO DE AUDITORIA DE PRODUÇÃO');
    console.log('================================================================');

    // 1. DEPLOYMENT & PM2 STATUS
    console.log('\n--- 1. DEPLOYMENT & PM2 STATUS ---');
    let gitCommit = 'Desconhecido';
    try {
        gitCommit = execSync('git log -n 1 --oneline', { encoding: 'utf-8' }).trim();
    } catch (e) {
        gitCommit = e.message;
    }
    console.log('Git Commit no Servidor:', gitCommit);

    try {
        const pm2Json = execSync('pm2 jlist', { encoding: 'utf-8' });
        const pm2List = JSON.parse(pm2Json);
        const bf = pm2List.find(p => p.name === 'brasilflix');
        if (bf) {
            console.log('PM2 Process Name:', bf.name);
            console.log('PM2 Process ID:', bf.pm_id);
            console.log('PM2 PID:', bf.pid);
            console.log('PM2 Status:', bf.pm2_env.status);
            console.log('PM2 Uptime:', ((Date.now() - bf.pm2_env.pm_uptime) / 1000 / 60).toFixed(2), 'minutos');
            console.log('PM2 Restarts:', bf.pm2_env.restart_time);
            console.log('PM2 Memory:', (bf.monit.memory / 1024 / 1024).toFixed(2), 'MB');
            console.log('PM2 CPU:', bf.monit.cpu, '%');
        } else {
            console.log('⚠️ Processo brasilflix não encontrado no PM2');
        }
    } catch (e) {
        console.warn('Erro ao consultar PM2:', e.message);
    }

    // 2. AUDITORIA POSTGRESQL & TELEGRAM STORAGE
    console.log('\n--- 2. AUDITORIA POSTGRESQL & TELEGRAM STORAGE ---');
    const uploader = TelegramUploader.getInstance();
    const startTime = Date.now();
    const auditReport = await uploader.verifyDatabaseIntegrity(db);
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('⏱️ Tempo de execução da auditoria MTProto:', `${durationSec}s`);
    console.log('Total de Filmes cadastrados no PostgreSQL:', auditReport.databaseTotals.totalFilmes);
    console.log('Total de Séries cadastradas no PostgreSQL:', auditReport.databaseTotals.totalSeries);
    console.log('Total de Episódios cadastrados no PostgreSQL:', auditReport.databaseTotals.totalEpisodios);
    console.log('Total de Referências de Mídia brutas:', auditReport.databaseTotals.totalMediaReferences);

    console.log('\n--- Status de Mídia no Armazém do Telegram ---');
    console.log('MessageIds únicos consultados no Telegram:', auditReport.telegramAudit.totalUniqueMessageIds);
    console.log('Mídias Válidas (Íntegras e Reproduzíveis):', auditReport.telegramAudit.validos.length);
    console.log('Mídias Ausentes (MessageEmpty / Deletadas):', auditReport.telegramAudit.ausentes.length);
    console.log('Mídias Corrompidas (0 bytes ou não-vídeo):', auditReport.telegramAudit.corrompidos.length);
    console.log('Divergências de fileId vs docId real:', auditReport.telegramAudit.fileIdMismatches.length);
    console.log('Duplicatas de Identificador:', auditReport.telegramAudit.duplicates.length);
    console.log('Não Verificadas / Erros Temporários:', auditReport.telegramAudit.unverified.length);

    console.log('\n--- Anomalias de Registros no PostgreSQL ---');
    console.log('Flags inconsistentes:', auditReport.anomalousDbRecords.staleFlags.length);
    console.log('Episódios órfãos:', auditReport.anomalousDbRecords.orphanedEpisodes.length);
    console.log('Episódios com números duplicados:', auditReport.anomalousDbRecords.duplicateEpisodes.length);
    console.log('IDs conflitantes primário/versões:', auditReport.anomalousDbRecords.conflictingPrimaryIds.length);
    console.log('Registros legados ambíguos (LEGACY_AMBIGUOUS):', (auditReport.anomalousDbRecords.legacyAmbiguous || []).length);
    console.log('JSONs malformados:', auditReport.anomalousDbRecords.malformedJson.length);

    // 3. AUDITORIA DO CATÁLOGO PÚBLICO VIA API
    console.log('\n--- 3. AUDITORIA DO CATÁLOGO PÚBLICO (HTTP API) ---');
    try {
        const res = await axios.get(`http://127.0.0.1:${config.STREMIO_PORT}/api/catalogo`);
        const cat = res.data;
        console.log('Filmes Expostos na API:', (cat.filmes || []).length);
        console.log('Séries Expostas na API:', (cat.series || []).length);

        let totalEpsExpostos = 0;
        for (const s of (cat.series || [])) {
            for (const t of (s.temporadas || [])) {
                totalEpsExpostos += (t.episodios || []).length;
            }
        }
        console.log('Total de Episódios Expostos na API:', totalEpsExpostos);

        // 4. DEEP-DIVE STRANGER THINGS
        console.log('\n--- 4. DEEP-DIVE STRANGER THINGS (ID 17 / TMDB 66732) ---');
        const st = (cat.series || []).find(s => s.id == 17 || s.tmdbId == 66732 || /stranger things/i.test(s.nome));
        if (st) {
            console.log('Série encontrada:', st.nome, '| ID:', st.id, '| TMDB:', st.tmdbId);
            for (const t of (st.temporadas || [])) {
                console.log(`Temporada ${t.numero}: ${ (t.episodios || []).length } episódios expostos`);
                if (t.numero === 4) {
                    for (const ep of t.episodios) {
                        console.log(`  - T4E${ep.numero}: ${ep.nome} | Dub: ${ep.isDublado} | Leg: ${ep.isLegendado} | msgId: ${ep.messageId}`);
                    }
                    const hasGhost = t.episodios.some(e => e.messageId == 315641 || e.versoes?.legendado?.messageId == 315641 || e.versoes?.dublado?.messageId == 315641);
                    console.log('Fantasma T4E7 (messageId 315641) exposto no catálogo?:', hasGhost ? 'SIM (ERRO)' : 'NÃO (CORRETO)');
                }
            }
        } else {
            console.log('Série Stranger Things não encontrada na API pública');
        }

        // 5. TESTE DE STREAMING
        console.log('\n--- 5. TESTE DE ROTAS DE STREAMING ---');
        // A. Stream inválido / inexistente (esperado: 404)
        try {
            await axios.get(`http://127.0.0.1:${config.STREMIO_PORT}/stream/video/test_token/filme/999999/dublado`);
            console.log('Stream inexistente: FALHA (não retornou 404)');
        } catch (err404) {
            const st404 = err404.response ? err404.response.status : err404.message;
            console.log(`Stream inexistente: HTTP ${st404} (CORRETO: 404)`);
        }

        // B. Stream válido (filme verificado)
        const primeiroFilme = (cat.filmes || [])[0];
        if (primeiroFilme) {
            try {
                const resStream = await axios.get(`http://127.0.0.1:${config.STREMIO_PORT}/stream/video/admin_token_test/filme/${primeiroFilme.id}/dublado`, {
                    maxRedirects: 0,
                    validateStatus: (status) => status >= 200 && status < 400
                });
                const redirectType = resStream.headers.location ? 'Redirecionamento Cloudflare 302 OK' : `Stream Direto HTTP ${resStream.status} OK`;
                console.log(`Stream filme válido (${primeiroFilme.nome}): ${redirectType}`);
            } catch (sErr) {
                console.log(`Stream filme válido status:`, sErr.response ? sErr.response.status : sErr.message);
            }
        }

    } catch (apiErr) {
        console.error('Erro na chamada da API:', apiErr.message);
    }

    console.log('\n================================================================');
    console.log('🏁 AUDITORIA DIRETA DE PRODUÇÃO CONCLUÍDA');
    console.log('================================================================\n');

    process.exit(0);
}

runDeepAudit().catch(err => {
    console.error('ERRO FATAL NA AUDITORIA:', err);
    process.exit(1);
});
