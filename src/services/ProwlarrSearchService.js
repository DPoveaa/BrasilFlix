const axios = require('axios');
const config = require('../../config');

class ProwlarrSearchService {
    constructor() {
        this.enabled = config.PROWLARR_ENABLED !== false;
        this.baseUrl = config.PROWLARR_URL || 'http://127.0.0.1:9696';
        this.apiKey = config.PROWLARR_API_KEY || '481557c9a7c241a48163642c2d246fef';
        this.lastErrorTime = 0;
    }

    /**
     * Verifica se o Prowlarr está online e acessível
     */
    async isAvailable() {
        if (!this.enabled || !this.apiKey) return false;
        try {
            const res = await axios.get(`${this.baseUrl}/api/v1/system/status`, {
                headers: { 'X-Api-Key': this.apiKey },
                timeout: 3000
            });
            return res.status === 200 && res.data && res.data.appName === 'Prowlarr';
        } catch (err) {
            return false;
        }
    }

    /**
     * Realiza busca agregada no Prowlarr em múltiplos indexers simultaneamente
     * @param {string} query Termo de busca (ex: "The Bear S03E01" ou "Avatar 1080p")
     * @param {string} tipo 'filme' ou 'serie'
     * @param {object} opts Opções adicionais (season, episode, audioPreference, query, originalName, ano)
     */
    async search(query, tipo = 'filme', opts = {}) {
        if (!this.enabled || !this.apiKey) return [];

        try {
            const cleanQuery = query.replace(/[^\w\s\.-]/gi, ' ').trim();
            const url = `${this.baseUrl}/api/v1/search?query=${encodeURIComponent(cleanQuery)}&type=search`;

            const res = await axios.get(url, {
                headers: { 'X-Api-Key': this.apiKey },
                timeout: 25000
            });

            if (!Array.isArray(res.data)) return [];

            const results = [];
            const seenHashes = new Set();

            for (const item of res.data) {
                const name = item.title;
                const infoHash = (item.infoHash || '').toLowerCase();
                const sizeBytes = item.size || 0;
                const seeders = item.seeders || 0;
                const indexerName = item.indexer || 'Prowlarr';

                let magnet = item.magnetUrl;
                if (!magnet && infoHash) {
                    const trackers = [
                        'udp://tracker.opentrackr.org:1337/announce',
                        'udp://open.stealth.si:80/announce',
                        'udp://tracker.torrent.eu.org:451/announce',
                        'udp://tracker.moeking.me:6969/announce',
                        'udp://explodie.org:6969/announce',
                        'udp://exodus.desync.com:6969/announce'
                    ].map(t => `&tr=${encodeURIComponent(t)}`).join('');
                    magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackers}`;
                } else if (!magnet && item.downloadUrl) {
                    magnet = item.downloadUrl;
                }

                const uniqueKey = infoHash || magnet || item.guid;
                if (!name || !uniqueKey || seenHashes.has(uniqueKey)) continue;
                seenHashes.add(uniqueKey);

                // 1. Bloqueia 4K / 2160p / UHD
                if (/\b(2160p|4k|uhd|remux\.2160p)\b/i.test(name)) continue;

                // 2. Bloqueia amostras e trailers
                if (/\b(sample|amostra|trailer|teaser|preview)\b/i.test(name)) continue;

                // 3. Bloqueia propaganda, cassinos e scams
                if (/\b(1xbet|1x_bet|1x-bet|mostbet|pari|melbet|betboom|fonbet|linebet|pin-up|joycasino|vulkan|vavada|winline|apostas|blaze|stake|dcprip|line\.audio)\b/i.test(name)) continue;

                // 4. Detecção de Áudio e Idioma
                const isBrazilianGroup = /yg⭐|dual[._ -]?yg|lapumia|wolverdon|starck|vizer|ondebaixo|cinegaveta|starfilmes|lipeh|comandotorrents|bludv|guanabara|mmfilmes|filmesmega|overdrive|p2p[-_ ]?br|acervo/i.test(name);
                const isPtBrExplicit = /\b(pt[-_]?br|ptbr|pt_br|brazilian|nacional|dublado)\b/i.test(name) || isBrazilianGroup;

                // Bloqueia categoricamente espanhol/latino não dublado em PT-BR
                const isSpanishOrLatino = !isBrazilianGroup && !isPtBrExplicit && /\b(cinecalidad|elitetorrent|estrenos|dontorrent|pctmix|divxatope|latino|castellano|espanol|español|dual[-_ .]?lat|audio[-_ .]?lat|sub[-_ .]?esp)\b/i.test(name);
                if (isSpanishOrLatino) continue;

                const isPtPtExplicit = !isBrazilianGroup && !isPtBrExplicit && /\b(pt[-_]?pt|pt_pt|ptpt|dobrado|european[._ -]?portuguese)\b/i.test(name);
                const isExplicitPtDubInTitle = /\b(dublado|nacional|audio[-_ ]?pt|audio[-_ ]?pt[-_ ]?br|pt[-_ ]?br[-_ ]?dub|dub[-_ ]?pt|dublado[-_ ]?pt[-_ ]?br|ptbr[-_ ]?dual|dual[-_ ]?pt)\b/i.test(name);
                const isDualPtInTitle = /\b(dual)\b/i.test(name) && !isSpanishOrLatino && (isBrazilianGroup || /\b(pt[-_]?br|ptbr|portugues|brasil|brazilian|dub)\b/i.test(name));

                const isDublado = (isExplicitPtDubInTitle || isBrazilianGroup || isDualPtInTitle) && !isPtPtExplicit;
                const isLegendadoPt = /\b(legendado|legendas|legenda|leg[-_ ]?pt|sub[-_ ]?pt|legendado[-_ ]?pt[-_ ]?br|sub[-_ ]?pt[-_ ]?br)\b/i.test(name);
                const isExplicitPtBrSub = /\b(pt[-_]?br|ptbr|pt_br|portugues[a-z]*|brazilian)\b/i.test(name);

                // Áudio original aceito para filmes/séries quando legendado é permitido
                const isOriginalForSub = (opts.audioPreference === 'legendado' || opts.allowOriginalAudio || !isDublado) && !isPtPtExplicit && !/\b(hindi|telugu|tamil|russian|ita|french|german)\b/i.test(name);
                const isLegendado = !isDublado && (isLegendadoPt || isExplicitPtBrSub || isOriginalForSub) && !isPtPtExplicit;

                // Se não tem dublagem nem legenda em PT-BR nem áudio original compatível, ignora
                if (!isDublado && !isLegendado) continue;

                // 5. Validação de Série (temporada e episódio)
                if (tipo === 'serie') {
                    if (opts.season) {
                        const sPad = String(opts.season).padStart(2, '0');
                        const sRegex = new RegExp(`\\b(?:s0*${opts.season}|season\\s*0*${opts.season}|temporada\\s*0*${opts.season})(?:e\\d+|x\\d+|[._ -]|\\b)`, 'i');
                        const hasSeason = sRegex.test(name);
                        const hasAnySeason = /\b(s\\d+|temporada\\s*\\d+|season\\s*\\d+|\\d+x\\d+)\b/i.test(name);
                        if (hasAnySeason && !hasSeason) continue;
                    }

                    if (opts.episode) {
                        const epMatch = name.match(/s\d{1,2}[._ -]?e0*(\d{1,3})/i) ||
                                        name.match(/\b\d{1,2}x0*(\d{1,3})\b/i) ||
                                        name.match(/\b(?:e|ep|episodio|episódio)\s*0*(\d{1,3})\b/i);
                        const rangeMatch = name.match(/\b(?:e|ep|episodio|episódio)\s*0*(\d{1,3})\s*(?:-|~|a|e|to)\s*e?0*(\d{1,3})\b/i);
                        const isPack = /\b(complete|completa|season[._ -]?\d+|temporada[._ -]?\d+|pack|all[._ -]?episodes|s\d{1,2}(?![._ -]?e\d+))\b/i.test(name) && !epMatch && !rangeMatch;

                        if (rangeMatch) {
                            const startEp = parseInt(rangeMatch[1], 10);
                            const endEp = parseInt(rangeMatch[2], 10);
                            if (opts.episode < startEp || opts.episode > endEp) continue;
                        } else if (epMatch) {
                            const foundEp = parseInt(epMatch[1], 10);
                            if (foundEp !== opts.episode) continue;
                        } else if (!isPack) {
                            continue;
                        }
                    }
                }

                // 6. Limites de tamanho
                const sizeMB = sizeBytes / (1024 * 1024);
                if (tipo === 'filme') {
                    if (sizeMB > 5500) continue; // max 5.5 GB para filmes
                    if (sizeMB < 300) continue;  // min 300 MB para filmes
                } else if (tipo === 'serie') {
                    if (sizeBytes > 80 * 1024 * 1024 * 1024) continue; // max 80 GB pack
                    if (sizeMB < 120) continue; // min 120 MB episódio
                }

                const isCam = /\b(cam|camrip|hdcam|hdts|telesync|ts|cinema|som\s*de\s*cinema|clean\s*audio)\b/i.test(name);
                const isWebDl = /\b(web-dl|webrip|bluray|brrip|bdrip|remux|hdrip)\b/i.test(name) && !isCam;
                const is1080p = /\b(1080p|fhd|fullhd|bluray|web-dl|1080)\b/i.test(name) && !isCam;

                results.push({
                    title: name,
                    infoHash: infoHash,
                    source: `Prowlarr (${indexerName})`,
                    magnet: magnet,
                    sizeBytes: sizeBytes,
                    sizeMB: sizeMB.toFixed(1),
                    seeders: seeders,
                    isCam: isCam,
                    isWebDl: isWebDl,
                    quality: isCam ? 'CAM (Cinema)' : (is1080p ? '1080p Full HD' : '720p HD'),
                    audio: isDublado ? 'Dublado (Áudio PT-BR)' : 'Legendado (PT-BR)',
                    isPtBr: true,
                    isPtBrExplicit: isPtBrExplicit || isBrazilianGroup,
                    isPtPt: isPtPtExplicit,
                    isDublado: isDublado,
                    isLegendado: isLegendado,
                    indexer: indexerName
                });
            }

            return results;
        } catch (err) {
            const now = Date.now();
            if (now - this.lastErrorTime > 60000) {
                console.warn(`⚠️ [ProwlarrSearchService] Falha ao consultar Prowlarr (${err.message}). Continuando com outras fontes...`);
                this.lastErrorTime = now;
            }
            return [];
        }
    }
}

module.exports = new ProwlarrSearchService();
