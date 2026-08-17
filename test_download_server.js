const DownloaderManager = require('./src/services/DownloaderManager');

async function testDownload() {
    const rawMagnet = 'magnet:?xt=urn:btih:9cfef977702bb9c6726e6d537374897a243a426e&dn=The.Rookie.S01E01.720p.WEB-DL.DUAL.WWW.COMANDOTORRENTS.COM';
    
    // Anexar trackers essenciais diretamente no magnet URI
    const trackers = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://open.stealth.si:80/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://explodie.org:6969/announce',
        'udp://tracker.moeking.me:6969/announce',
        'http://tracker.opentrackr.org:1337/announce',
        'udp://p4p.arenabg.com:1337/announce',
        'udp://tracker.birkenwald.de:6969/announce',
        'udp://tracker.openbittorrent.com:80/announce',
        'udp://tracker.cyberia.is:6969/announce',
        'udp://9.rarbg.to:2920/announce',
        'udp://tracker.coppersurfer.tk:6969/announce',
        'udp://tracker.internetwarriors.net:1337/announce'
    ];

    let fullMagnet = rawMagnet;
    for (const tr of trackers) {
        fullMagnet += `&tr=${encodeURIComponent(tr)}`;
    }

    console.log('🧪 Testando download do magnet com trackers anexados no servidor...');
    console.log('🧲 Magnet completo com trackers:', fullMagnet);

    try {
        const result = await DownloaderManager.downloadTorrent(fullMagnet, (prog) => {
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
