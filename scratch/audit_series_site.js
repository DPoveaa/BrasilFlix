const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `
        cd /mnt/ssd500/projetos/BrasilFlix &&
        node -e '
            const db = require("./src/database/db");
            const CatalogoManager = require("./src/managers/CatalogoManager");
            const TMDBService = require("./src/services/TMDBService");

            async function auditSite() {
                const cm = new CatalogoManager();
                await cm.loadCatalogo();
                
                console.log("=== AUDITORIA DE TODAS AS SÉRIES NO CATÁLOGO ===");
                for (const s of cm.catalogo.series) {
                    console.log("\\n📺 SÉRIE:", s.nome, "(ID:", s.id, "| TMDB:", s.tmdbId, "| Em Lançamento:", s.emLancamento, "| Status:", s.statusSerie, ")");
                    for (const t of s.temporadas) {
                        const epNums = t.episodios.map(e => e.numero);
                        console.log("  Temporada", t.numero, "- Total Eps no Catálogo:", t.episodios.length, "| Eps:", epNums.join(", "), "| Dub:", t.isDublado, "| Leg:", t.isLegendado);
                        for (const ep of t.episodios) {
                            if (!ep.isDublado && !ep.isLegendado) {
                                console.log("    🚨 EP SEM ÁUDIO/MÍDIA EXPOSTO:", ep.numero, ep.nome);
                            }
                        }
                    }
                }

                console.log("\\n=== AUDITORIA DIRETA NA TABELA EPISODIOS DO POSTGRESQL ===");
                const allEps = await db.query("SELECT e.*, s.nome as serie_nome FROM episodios e JOIN series s ON s.id = e.serie_id ORDER BY s.id, e.temporada_numero, e.numero");
                let nullMediaEps = [];
                for (const row of allEps.rows) {
                    let v = row.versoes;
                    if (typeof v === "string") try { v = JSON.parse(v); } catch(e) {}
                    const hasDub = (v?.dublado?.messageId || v?.dublado?.fileId || (row.is_dublado && (row.message_id || row.file_id)));
                    const hasLeg = (v?.legendado?.messageId || v?.legendado?.fileId || (row.is_legendado && (row.message_id || row.file_id)));
                    if (!hasDub && !hasLeg) {
                        nullMediaEps.push(row);
                    }
                }

                console.log("Total de episódios sem nenhuma mídia válida no PostgreSQL:", nullMediaEps.length);
                for (const ne of nullMediaEps) {
                    console.log("  - Série:", ne.serie_nome, "(ID:", ne.serie_id, ") | T", ne.temporada_numero, "E", ne.numero, "| msg_id:", ne.message_id, "| versoes:", JSON.stringify(ne.versoes));
                }

                process.exit(0);
            }
            auditSite().catch(e => { console.error(e); process.exit(1); });
        '
    `;

    conn.exec(scriptToRun, (err, stream) => {
        if (err) throw err;
        stream.on('close', () => conn.end());
        stream.on('data', (d) => process.stdout.write(d));
        stream.stderr.on('data', (d) => process.stderr.write(d));
    });
}).connect({
    host: '192.168.68.56',
    port: 22,
    username: 'povea',
    password: 'Daniel123.'
});
