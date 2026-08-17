const DownloaderManager = require('./src/services/DownloaderManager');

async function testDownload() {
    const magnet = 'magnet:?xt=urn:btih:9cfef977702bb9c6726e6d537374897a243a426e&dn=The.Rookie.S01E01.720p.WEB-DL.DUAL.WWW.COMANDOTORRENTS.COM';
    console.log('🧪 Testando download do magnet no servidor...');
    console.log('🧲 Magnet:', magnet);

    try {
        const result = await DownloaderManager.downloadTorrent(magnet, (prog) => {
            console.log(`📊 Progresso: ${prog.percent}% | ${prog.downloaded} / ${prog.total} | Velocidade: ${prog.speed}`);
        }, { title: 'The Rookie S01E01 Test', type: 'serie', season: 1, episode: 1, audio: 'Dublado' });

        console.log('✅ SUCESSO! Download concluído no servidor:', result);
    } catch (e) {
        console.error('❌ FALHA no download:', e.message);
    } finally {
        process.exit(0);
    }
}

testDownload();
