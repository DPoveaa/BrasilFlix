const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

lines.forEach((l, i) => {
    if (l.includes('dorama') && (l.includes('filter') || l.includes('activeCategory'))) {
        console.log(`${i + 1}: ${l.trim()}`);
    }
});
