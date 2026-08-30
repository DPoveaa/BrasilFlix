const { Client } = require('ssh2');

const conn = new Client();

conn.on('ready', () => {
    const scriptToRun = `
        cd /mnt/ssd500/projetos/BrasilFlix &&
        node -e '
            const db = require("./src/database/db");
            const TMDBService = require("./src/services/TMDBService");
            const CatalogoManager = require("./src/managers/CatalogoManager");

            async function syncAllSeriesMeta() {
                const cm = new CatalogoManager();
                const res = await db.query("SELECT id, nome, tmdb_id, temporadas_meta, em_lancamento FROM series");
                for (const s of res.rows) {
                    if (!s.tmdb_id) continue;
                    console.log("Checking TMDB for series:", s.nome, "(TMDB:", s.tmdb_id, ")");
                    const tvDet = await TMDBService.getTVDetails(s.tmdb_id);
                    if (tvDet && tvDet.temporadas) {
                        const metaObj = {};
                        for (const t of tvDet.temporadas) {
                            metaObj[t.numero] = {
                                totalEps: t.episodiosContagem || 0,
                                nome: t.nome,
                                poster: t.poster
                            };
                        }
                        console.log("  -> Meta:", JSON.stringify(metaObj));
                        await db.query("UPDATE series SET temporadas_meta = $1 WHERE id = $2", [JSON.stringify(metaObj), s.id]);
                    }
                }
                console.log("Recarregando catalogo...");
                await cm.loadCatalogo();
                console.log("=== APÓS SINCRONIZAÇÃO DE METADADOS TMDB E REGRA DE TEMPORADA COMPLETA ===");
                for (const s of cm.catalogo.series) {
                    console.log("Série:", s.nome);
                    for (const t of s.temporadas) {
                        console.log("  Temporada", t.numero, "- Total Eps:", t.episodios.length, "| DubCompleto:", t.isDubladoCompleto, "| LegCompleto:", t.isLegendadoCompleto);
                    }
                }
                process.exit(0);
            }
            syncAllSeriesMeta().catch(e => { console.error(e); process.exit(1); });
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
