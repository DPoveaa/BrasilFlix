const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

printRange(10880, 11220, 'WATCH PARTY PANEL & READY OVERLAY');
