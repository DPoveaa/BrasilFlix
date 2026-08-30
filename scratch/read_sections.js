const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

printRange(4550, 4600, 'END OF STYLE');
printRange(5105, 5130, 'TAB MEDIA DETAIL');
printRange(6700, 6740, 'WEB PLAYER MODAL START');
printRange(6840, 6880, 'WEB PLAYER MODAL END');
printRange(10210, 10460, 'OPEN WEB PLAYER & CLOSE WEB PLAYER');
