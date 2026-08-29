const db = require('../src/database/db');
const TelegramUploader = require('../src/services/TelegramUploader');
const CatalogoManager = require('../src/managers/CatalogoManager');

async function main() {
    console.log('======================================================');
    console.log('🔍 INICIANDO AUDITORIA DIRETA DE PRODUÇÃO (POSTGRESQL + TELEGRAM)');
    console.log('======================================================\n');

    const uploader = new TelegramUploader();
    const startTime = Date.now();

    try {
        const report = await uploader.verifyDatabaseIntegrity(db);
        const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

        // Alimenta o cache de verificação de mídia do CatalogoManager
        for (const item of report.telegramAudit.validos) {
            if (item.messageId) {
                CatalogoManager.mediaVerificationCache.set(item.messageId, 'VERIFIED_PLAYABLE', {
                    docId: item.docId,
                    fileName: item.fileName
                });
            }
        }
        for (const item of report.telegramAudit.ausentes) {
            if (item.messageId) {
                CatalogoManager.mediaVerificationCache.set(item.messageId, 'MISSING', { error: item.motivo });
            }
        }
        for (const item of report.telegramAudit.corrompidos) {
            if (item.messageId) {
                CatalogoManager.mediaVerificationCache.set(item.messageId, 'INVALID_MEDIA', { error: item.motivo });
            }
        }
        for (const item of report.telegramAudit.fileIdMismatches) {
            if (item.messageId) {
                CatalogoManager.mediaVerificationCache.set(item.messageId, 'FILE_ID_MISMATCH', {
                    docId: item.actualDocId,
                    storedFileId: item.storedFileId
                });
            }
        }

        console.log('\n======================================================');
        console.log('📊 RESULTADO DA AUDITORIA DIRETA DE INTEGRIDADE');
        console.log('======================================================');
        console.log(`⏱️ Tempo de execução: ${durationSec}s\n`);
        console.log('--- TOTAIS NO POSTGRESQL ---');
        console.log('Total de Filmes cadastrados:', report.databaseTotals.totalFilmes);
        console.log('Total de Séries cadastradas:', report.databaseTotals.totalSeries);
        console.log('Total de Episódios cadastrados:', report.databaseTotals.totalEpisodios);
        console.log('Total de Referências de Mídia brutas:', report.databaseTotals.totalMediaReferences);

        console.log('\n--- VERIFICAÇÃO NO ARMAZÉM DO TELEGRAM ---');
        console.log('MessageIds únicos consultados no Telegram:', report.telegramAudit.totalUniqueMessageIds);
        console.log('Mídias Válidas (Íntegras e Reproduzíveis):', report.telegramAudit.validos.length);
        console.log('Mídias Ausentes (MessageEmpty / Deletadas):', report.telegramAudit.ausentes.length);
        console.log('Mídias Corrompidas (0 bytes ou não-vídeo):', report.telegramAudit.corrompidos.length);
        console.log('Divergências de fileId vs docId real:', report.telegramAudit.fileIdMismatches.length);
        console.log('Duplicatas de Identificador (messageId/fileId):', report.telegramAudit.duplicates.length);
        console.log('Não Verificadas / Erros Temporários:', report.telegramAudit.unverified.length);

        console.log('\n--- ANOMALIAS DE REGISTROS NO POSTGRESQL ---');
        console.log('Flags inconsistentes (ex: is_dublado sem mídia):', report.anomalousDbRecords.staleFlags.length);
        console.log('Episódios órfãos (serie_id inexistente):', report.anomalousDbRecords.orphanedEpisodes.length);
        console.log('Episódios com números duplicados (mesma série/temp):', report.anomalousDbRecords.duplicateEpisodes.length);
        console.log('IDs conflitantes entre primário e versões:', report.anomalousDbRecords.conflictingPrimaryIds.length);
        console.log('Registros legados ambíguos (LEGACY_AMBIGUOUS):', (report.anomalousDbRecords.legacyAmbiguous || []).length);
        console.log('JSONs malformados:', report.anomalousDbRecords.malformedJson.length);
        console.log('======================================================\n');

        if (report.telegramAudit.fileIdMismatches.length > 0) {
            console.log('⚠️ DETALHES DE FILE_ID MISMATCHES:');
            console.log(JSON.stringify(report.telegramAudit.fileIdMismatches, null, 2));
        }

        if (report.telegramAudit.duplicates.length > 0) {
            console.log('⚠️ DETALHES DE DUPLICATAS:');
            console.log(JSON.stringify(report.telegramAudit.duplicates, null, 2));
        }

        if (report.anomalousDbRecords.staleFlags.length > 0) {
            console.log('⚠️ DETALHES DE FLAGS INCONSISTENTES:');
            console.log(JSON.stringify(report.anomalousDbRecords.staleFlags, null, 2));
        }

        if (report.anomalousDbRecords.duplicateEpisodes.length > 0) {
            console.log('⚠️ DETALHES DE EPISÓDIOS DUPLICADOS:');
            console.log(JSON.stringify(report.anomalousDbRecords.duplicateEpisodes, null, 2));
        }

        if ((report.anomalousDbRecords.legacyAmbiguous || []).length > 0) {
            console.log('⚠️ DETALHES DE REGISTROS LEGADOS AMBÍGUOS (LEGACY_AMBIGUOUS):');
            console.log(JSON.stringify(report.anomalousDbRecords.legacyAmbiguous, null, 2));
        }

        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NA AUDITORIA:', err);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = main;
