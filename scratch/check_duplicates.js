const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

printRange(13330, 13450, 'DUPLICATE CHECKS NEAR END OF SCRIPT');
