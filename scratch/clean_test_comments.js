const { Client } = require('ssh2');

const conn = new Client();

const scriptContent = `
const db = require('/home/povea/BrasilFlix/src/database/db.js');

async function run() {
    try {
        console.log('--- TODOS OS COMENTÁRIOS ATUAIS NO BANCO ---');
        const res = await db.query('SELECT id, media_type, media_id, user_id, username, rating, comentario, has_spoiler, created_at FROM avaliacoes_comentarios ORDER BY id ASC');
        console.log(JSON.stringify(res.rows, null, 2));

        // Deleta comentários de teste criados por nós
        const delRes = await db.query("DELETE FROM avaliacoes_comentarios WHERE comentario ILIKE '%teste%' OR comentario ILIKE '%spoiler%' OR username ILIKE '%teste%' OR comentario ILIKE '%test%' OR username ILIKE '%antigravity%' OR username ILIKE '%daniel%'");
        console.log('✅ Comentários de teste deletados com sucesso:', delRes.rowCount);

        const remaining = await db.query('SELECT id, media_type, media_id, username, comentario, rating, has_spoiler FROM avaliacoes_comentarios');
        console.log('📊 Comentários restantes legítimos no banco (' + remaining.rowCount + '):', remaining.rows);
    } catch(e) {
        console.error('Erro:', e.message);
    } finally {
        process.exit(0);
    }
}
run();
`;

conn.on('ready', () => {
    console.log('SSH connected. Uploading cleaner script...');
    conn.sftp((err, sftp) => {
        if (err) throw err;
        const writeStream = sftp.createWriteStream('/home/povea/clean_comments.js');
        writeStream.end(scriptContent, () => {
            conn.exec('cd /home/povea/BrasilFlix && node /home/povea/clean_comments.js', (err, stream) => {
                if (err) throw err;
                stream.on('close', (code) => {
                    console.log('Finished execution with code:', code);
                    conn.end();
                }).on('data', (data) => {
                    console.log(data.toString());
                }).stderr.on('data', (data) => {
                    console.error(data.toString());
                });
            });
        });
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
