const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

console.log('--- Tabs in HTML ---');
lines.forEach((l, i) => {
    if (l.includes('tab-content') || /id=["']tab-/.test(l)) {
        console.log(`${i + 1}: ${l.trim()}`);
    }
});

console.log('\n--- Detail & Player functions ---');
lines.forEach((l, i) => {
    if (/function (open|close|render|play|switch|handle|start|toggle|load|check|get)/.test(l)) {
        if (/player|party|modal|detail|stream|route|catalog|season|episode|review|rating|comment|quota/i.test(l)) {
            console.log(`${i + 1}: ${l.trim()}`);
        }
    }
});
