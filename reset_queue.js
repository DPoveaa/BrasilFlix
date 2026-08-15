const fs = require('fs');
const qPath = './data/queue.json';
if (fs.existsSync(qPath)) {
    const queue = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    queue.forEach(j => {
        if (j.title && j.title.toLowerCase().includes('reacher')) {
            j.season = 1;
            j.episode = 1;
            j.status = 'queued';
            j.rawFilePath = null;
            j.optimizedPath = null;
            j.bestSource = null;
            j.progress = 0;
            j.progressDetails = '';
        }
    });
    fs.writeFileSync(qPath, JSON.stringify(queue, null, 2));
    console.log('✅ Queue reset for Reacher S01E01!');
}
