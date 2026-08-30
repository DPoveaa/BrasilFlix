const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

let startOpenWeb = 0;
lines.forEach((l, i) => {
    if (l.includes('function openWebPlayer(')) startOpenWeb = i + 1;
});

console.log('openWebPlayer starts at line:', startOpenWeb);
printRange(startOpenWeb - 5, startOpenWeb + 250, 'OPEN WEB PLAYER CURRENT IMPLEMENTATION');
