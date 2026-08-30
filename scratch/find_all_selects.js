const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

const selectRegex = /<select[\s\S]*?<\/select>/gi;
let match;
let count = 0;
while ((match = selectRegex.exec(html)) !== null) {
    count++;
    const start = match.index;
    const line = html.substring(0, start).split('\n').length;
    console.log(`Select #${count} at line ${line}:\n`, match[0].substring(0, 150), '\n---');
}
