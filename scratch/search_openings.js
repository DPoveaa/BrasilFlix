const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

lines.forEach((l, i) => {
    if (l.includes('openModalById(') || l.includes('openWebPlayer(') || l.includes('openWebPlayerForMovie(') || l.includes('openWebPlayerEpisode(')) {
        console.log(`${i + 1}: ${l.trim()}`);
    }
});
