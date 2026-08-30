const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

printRange(9940, 10450, 'OPEN WEB PLAYER & AUDIO LOGIC');
printRange(10880, 11600, 'WATCH PARTY LOGIC');
printRange(12190, 12450, 'EPISODES & MODAL CLOSE');
