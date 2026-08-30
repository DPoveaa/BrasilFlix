const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

const regex = /rating|comentario|review/gi;
let match;
const lines = [];
while ((match = regex.exec(html)) !== null) {
    const lineNum = html.substring(0, match.index).split('\n').length;
    if (!lines.includes(lineNum)) lines.push(lineNum);
}
console.log('Lines referencing reviews / rating:', lines);
