const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

console.log('Total lines:', lines.length);

// Find where <style> ends or key CSS sections
lines.forEach((l, i) => {
    if (l.includes('/* WEB PLAYER MODAL') || l.includes('/* MODAL DE DETALHES') || l.includes('/* WATCH PARTY') || l.includes('</style>')) {
        console.log(`CSS marker at line ${i + 1}: ${l.trim()}`);
    }
    if (l.includes('<div id="tab-media-detail"') || l.includes('<div id="tab-catalogo"') || l.includes('id="web-player-modal"')) {
        console.log(`HTML marker at line ${i + 1}: ${l.trim()}`);
    }
    if (l.includes('function openMediaDetailPage') || l.includes('function openWebPlayer(') || l.includes('function getRouteStateFromUrl')) {
        console.log(`JS marker at line ${i + 1}: ${l.trim()}`);
    }
});
