const fs = require('fs');

const content = fs.readFileSync('public/index.html', 'utf8');
const lines = content.split('\n');

function printRange(start, end, label) {
    console.log(`\n=================== ${label} (lines ${start}-${end}) ===================\n`);
    console.log(lines.slice(start - 1, end).join('\n'));
}

lines.forEach((l, i) => {
    if (l.includes('function playNextEpisodeDirectly') || l.includes('case \'change_media\':') || l.includes('data.type === \'change_media\'')) {
        console.log(`Found at line ${i + 1}: ${l.trim()}`);
    }
});

let lineNext = 0;
lines.forEach((l, i) => {
    if (l.includes('function playNextEpisodeDirectly(')) lineNext = i + 1;
});
if (lineNext > 0) printRange(lineNext - 5, lineNext + 40, 'PLAY NEXT PREVIOUS DIRECTLY');

let lineChangeMedia = 0;
lines.forEach((l, i) => {
    if (l.includes('data.type === \'change_media\'')) lineChangeMedia = i + 1;
});
if (lineChangeMedia > 0) printRange(lineChangeMedia - 5, lineChangeMedia + 50, 'WATCH PARTY CHANGE MEDIA');
