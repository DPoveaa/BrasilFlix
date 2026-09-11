const axios = require('axios');

class NyaaSearchService {
    constructor() {
        this.baseUrl = 'https://nyaa.si';
        this.timeout = 8000;
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
        
        // Trackers públicos de alta disponibilidade para animes
        this.trackers = [
            'http://nyaa.tracker.wf:7777/announce',
            'udp://open.stealth.si:80/announce',
            'udp://tracker.opentrackr.org:1337/announce',
            'udp://exodus.desync.com:6969/announce',
            'udp://tracker.torrent.eu.org:451/announce',
            'udp://explodie.org:6969/announce',
            'udp://uploads.game攻.org:2710/announce',
            'udp://tracker.coppersurfer.tk:6969/announce'
        ];
    }

    buildMagnet(infoHash, title) {
        const trStr = this.trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
        return `magnet:?xt=urn:btih:${infoHash.toLowerCase()}&dn=${encodeURIComponent(title || 'anime')}${trStr}`;
    }

    parseSizeMB(str) {
        if (!str) return 0;
        const m = str.match(/([\d\.]+)\s*(GiB|MiB|KiB|GB|MB)/i);
        if (!m) return 0;
        const val = parseFloat(m[1]);
        const unit = m[2].toLowerCase();
        if (unit.includes('g')) return parseFloat((val * 1024).toFixed(1));
        if (unit.includes('m')) return parseFloat(val.toFixed(1));
        return parseFloat((val / 1024).toFixed(1));
    }

    detectQuality(title) {
        const t = (title || '').toLowerCase();
        if (t.includes('2160p') || t.includes('4k')) return '4k';
        if (t.includes('1080p') || t.includes('fhd')) return '1080p';
        if (t.includes('720p') || t.includes('hd')) return '720p';
        if (t.includes('480p') || t.includes('sd')) return '480p';
        return '1080p'; // Default para a grande maioria dos animes no Nyaa
    }

    isDubbed(title) {
        const t = (title || '').toLowerCase();
        
        // Se for explicitamente áudio em japonês puro ou outro idioma sem menção a português, não é dublado PT-BR
        if (/\b(japanese|jap|nihon)\b/i.test(t) && !/\b(multi|dual|tri|dublado|portugu[eê]s)\b/i.test(t)) {
            return false;
        }

        const hasPtIndicator = /\b(pt[-_ ]?br|ptbr|portugu[eê]s|brasil|brazilian)\b/i.test(t);
        const hasDubKeyword = /\b(dublado|dub|nacional)\b/i.test(t);
        const isBrGroup = /\b(p2p[-_ ]?br|dtt|shangri[-_ ]?la|animestc|omda|brazuca|lipeh|animescx)\b/i.test(t);

        if (isBrGroup) return true;
        if (hasDubKeyword && (hasPtIndicator || !/\b(eng|english|ita|french|ger|rus|kor|korean|jap|japanese)\b/i.test(t))) return true;
        if (/\b(dual[-_ ]?audio|multi[-_ ]?audio|tri[-_ ]?audio)\b/i.test(t) && hasPtIndicator) return true;
        if (t.includes('toonshub') && (hasPtIndicator || t.includes('multi-audio') || t.includes('multi-dub'))) return true;

        return false;
    }

    isBatch(title) {
        const t = (title || '').toLowerCase();
        return /\b(batch|complete|completo|temporada|season)\b/i.test(t) ||
               /\(\d{1,3}-\d{1,3}\)|\[\d{1,3}-\d{1,3}\]/.test(t) ||
               /\b(s\d{1,2}\s*\(|s\d{1,2}\s*\[)/i.test(t);
    }

    isEpisodeMatch(itemTitle, season, episode) {
        const t = (itemTitle || '').toLowerCase();
        const epNum = parseInt(episode, 10);
        const seasonNum = parseInt(season, 10);
        const epPadded = String(epNum).padStart(2, '0');
        const sPadded = String(seasonNum).padStart(2, '0');

        // Se for um pacote completo (batch), contém o episódio desejado
        if (this.isBatch(itemTitle)) {
            // Se o batch especifica intervalo de episódios, e.g. (01-12)
            const rangeMatch = t.match(/[\[\(](\d{1,3})\s*-\s*(\d{1,3})[\]\)]/);
            if (rangeMatch) {
                const start = parseInt(rangeMatch[1], 10);
                const end = parseInt(rangeMatch[2], 10);
                return epNum >= start && epNum <= end;
            }
            // Se especifica temporada, verifica se é a mesma
            const sMatch = t.match(/\b(?:s|season|temporada)\s*0*(\d{1,2})\b/i);
            if (sMatch) {
                return parseInt(sMatch[1], 10) === seasonNum;
            }
            return true;
        }

        // Padrões estritos de episódio:
        // S01E05, S1E5, 1x05
        const sRegex = new RegExp(`s0*${seasonNum}[._ -]*e0*${epNum}(?:\\D|$)`, 'i');
        if (sRegex.test(t)) return true;

        // Formatos comuns de animes: " - 05", " - 05 ", " - 05v2", " 05 "
        // Evita confundir com resolução (1080p, 720p) ou ano (2024)
        const epStrictRegex = new RegExp(`(?:-|\\b)0*${epNum}(?:v\\d+)?\\s*(?:\\[|\\(|\\b)(?:1080p|720p|480p|hevc|x264|x265|cr|fun|web|bd|dvd)`, 'i');
        if (epStrictRegex.test(t)) {
            // Verifica se não pertence a outra temporada
            const otherSMatch = t.match(/\b(?:s|season|temporada)\s*0*(\d{1,2})\b/i);
            if (otherSMatch && parseInt(otherSMatch[1], 10) !== seasonNum) {
                return false;
            }
            return true;
        }

        // Formato simples " - 05 "
        const dashEpRegex = new RegExp(`\\s+-\\s+0*${epNum}\\s+`, 'i');
        if (dashEpRegex.test(t)) {
            return true;
        }

        // Se especificou outro episódio qualquer (ex: - 02 quando queremos 05), descarta
        const anyEpMatch = t.match(/(?:s\d+[._ -]*)?e0*(\d{1,4})\b/i) || t.match(/\s+-\s+0*(\d{1,4})\s+/);
        if (anyEpMatch) {
            const found = parseInt(anyEpMatch[1], 10);
            if (found !== epNum && found !== 1080 && found !== 720 && found !== 480) {
                return false;
            }
        }

        return false;
    }

    async queryRss(query, category = '1_2') {
        const cleanQ = (query || '').trim();
        if (!cleanQ) return [];

        const url = `${this.baseUrl}/?page=rss&q=${encodeURIComponent(cleanQ)}&c=${category}&f=0&s=seeders&o=desc`;
        try {
            const res = await axios.get(url, {
                timeout: this.timeout,
                headers: { 'User-Agent': this.userAgent }
            });

            const items = res.data.match(/<item>[\s\S]*?<\/item>/g) || [];
            return items.map(xml => {
                const title = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1] || xml.match(/<title>(.*?)<\/title>/)?.[1] || '';
                const link = xml.match(/<link>(.*?)<\/link>/)?.[1] || '';
                const seeders = parseInt(xml.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)?.[1] || '0', 10);
                const leechers = parseInt(xml.match(/<nyaa:leechers>(\d+)<\/nyaa:leechers>/)?.[1] || '0', 10);
                const sizeStr = xml.match(/<nyaa:size>(.*?)<\/nyaa:size>/)?.[1] || '';
                const infoHash = (xml.match(/<nyaa:infoHash>(.*?)<\/nyaa:infoHash>/)?.[1] || '').toLowerCase();
                const categoryId = xml.match(/<nyaa:categoryId>(.*?)<\/nyaa:categoryId>/)?.[1] || category;

                return {
                    title,
                    link,
                    seeders,
                    leechers,
                    sizeMB: this.parseSizeMB(sizeStr),
                    infoHash,
                    categoryId
                };
            }).filter(item => item.infoHash && item.infoHash.length === 40);
        } catch (e) {
            return [];
        }
    }

    async searchAnime(query, tipo = 'serie', options = {}) {
        const titlePt = (query || '').replace(/\s*\(\d{4}\)$/, '').trim();
        const origName = (options.originalName || '').trim();
        const season = options.season || 1;
        const episode = options.episode || 1;
        const pref = options.audioPreference || 'legendado';
        const sPadded = String(season).padStart(2, '0');
        const epPadded = String(episode).padStart(2, '0');

        console.log(`⛩️ [Nyaa.si] Buscando anime: "${titlePt}"${origName && origName !== titlePt ? ` / "${origName}"` : ''} ${tipo === 'serie' ? `(S${season}E${episode})` : ''} [${pref}]...`);

        const searches = [];

        // 1. Buscas em Categoria 1_3 (Non-English / PT-BR)
        // Para dublado ou legendado PT-BR de grupos de fansub brasileiros
        if (tipo === 'serie') {
            searches.push({ q: `${titlePt} PT-BR`, cat: '1_3' });
            searches.push({ q: `${titlePt} Dublado`, cat: '1_3' });
            searches.push({ q: `${titlePt} ${epPadded}`, cat: '1_3' });
            if (origName && origName !== titlePt) {
                searches.push({ q: `${origName} PT-BR`, cat: '1_3' });
                searches.push({ q: `${origName} ${epPadded}`, cat: '1_3' });
            }
        } else {
            searches.push({ q: `${titlePt} PT-BR`, cat: '1_3' });
            searches.push({ q: `${titlePt} Dublado`, cat: '1_3' });
            searches.push({ q: `${titlePt}`, cat: '1_3' });
            if (origName && origName !== titlePt) {
                searches.push({ q: `${origName} PT-BR`, cat: '1_3' });
            }
        }

        // 2. Buscas em Categoria 1_2 (English-translated / Multi-sub releases de altíssima qualidade e seeds)
        // Ideal para hardsub PT-BR automatizado com sincronia de estúdio perfeita
        if (tipo === 'serie') {
            searches.push({ q: `${titlePt} ${epPadded}`, cat: '1_2' });
            searches.push({ q: `${titlePt} S${sPadded}E${epPadded}`, cat: '1_2' });
            searches.push({ q: `${titlePt} - ${epPadded}`, cat: '1_2' });
            searches.push({ q: `SubsPlease ${titlePt} ${epPadded}`, cat: '1_2' });
            searches.push({ q: `Erai-raws ${titlePt} ${epPadded}`, cat: '1_2' });

            // Batch / Season packs (permite ao Downloader extrair o episódio localmente)
            searches.push({ q: `${titlePt} Season ${season}`, cat: '1_2' });
            searches.push({ q: `${titlePt} S${sPadded}`, cat: '1_2' });

            if (origName && origName !== titlePt) {
                searches.push({ q: `${origName} ${epPadded}`, cat: '1_2' });
                searches.push({ q: `${origName} S${sPadded}E${epPadded}`, cat: '1_2' });
                searches.push({ q: `SubsPlease ${origName} ${epPadded}`, cat: '1_2' });
            }
        } else {
            searches.push({ q: `${titlePt} 1080p`, cat: '1_2' });
            searches.push({ q: `${titlePt}`, cat: '1_2' });
            if (origName && origName !== titlePt) {
                searches.push({ q: `${origName} 1080p`, cat: '1_2' });
                searches.push({ q: `${origName}`, cat: '1_2' });
            }
        }

        // Executa as consultas com paralelismo controlado
        const rawResults = [];
        const seenQueries = new Set();
        const uniqueSearches = searches.filter(s => {
            const key = `${s.cat}:${s.q.toLowerCase()}`;
            if (seenQueries.has(key)) return false;
            seenQueries.add(key);
            return true;
        });

        // Limita a até 6 buscas simultâneas para não estressar o RSS
        const queryPromises = uniqueSearches.slice(0, 8).map(s => this.queryRss(s.q, s.cat));
        const queryOutputs = await Promise.allSettled(queryPromises);

        for (const out of queryOutputs) {
            if (out.status === 'fulfilled' && Array.isArray(out.value)) {
                for (const item of out.value) {
                    rawResults.push(item);
                }
            }
        }

        // Deduplicação e filtragem de integridade
        const candidates = [];
        const seenHashes = new Set();

        for (const item of rawResults) {
            if (seenHashes.has(item.infoHash)) continue;
            seenHashes.add(item.infoHash);

            // Rejeita releases sem seeders
            if (item.seeders < 1) continue;

            // Se for série, valida se o release corresponde ao episódio ou temporada
            if (tipo === 'serie') {
                const matches = this.isEpisodeMatch(item.title, season, episode);
                if (!matches) continue;
            }

            // Descarta arquivos absurdamente gigantes (> 90 GB para séries, > 25 GB para filmes)
            const maxMB = tipo === 'serie' ? 90000 : 25000;
            if (item.sizeMB > maxMB) continue;

            // Identifica áudio e formato
            const isDub = this.isDubbed(item.title);
            const isBatch = this.isBatch(item.title);
            const quality = this.detectQuality(item.title);

            // Determina adequação com base na preferência do usuário
            let audioScore = 0;
            if (pref === 'dublado') {
                // Se o usuário quer dublado:
                // Releases dubladas no Nyaa com bom número de seeds ganham prioridade máxima!
                if (isDub) {
                    audioScore = 100 + (item.seeders * 2);
                } else {
                    // Se não for dublado no Nyaa, deixa com pontuação baixa (fallback caso Torrentio também não tenha)
                    if (options.ignorarFallbackLegendado) continue;
                    audioScore = 10 + Math.min(item.seeders, 30);
                }
            } else {
                // Se o usuário quer legendado:
                // Prioriza PT-BR direto da 1_3, ou release de alta qualidade (SubsPlease / Erai-raws) da 1_2
                const isPtBrDirect = item.categoryId === '1_3' || /\[pt[-_ ]?br\]|legendado|português/i.test(item.title);
                if (isPtBrDirect) {
                    audioScore = 90 + (item.seeders * 2);
                } else {
                    // Release com subs em inglês/multi-subs com muitos seeders
                    audioScore = 70 + Math.min(item.seeders, 50);
                }
            }

            candidates.push({
                title: item.title,
                infoHash: item.infoHash,
                seeders: item.seeders,
                sizeMB: item.sizeMB,
                audio: isDub ? 'dublado' : 'legendado',
                isDublado: isDub,
                isLegendado: !isDub,
                isPtBr: true, // Nyaa animes são processados pelo VideoProcessor com hardsub oficial PT-BR quando não dublados
                quality,
                source: 'Nyaa.si',
                provider: 'Nyaa.si',
                magnetUri: this.buildMagnet(item.infoHash, item.title),
                isDirect: false,
                isBatch,
                audioScore
            });
        }

        // Ordena por audioScore e seeders
        candidates.sort((a, b) => b.audioScore - a.audioScore || b.seeders - a.seeders);

        return candidates;
    }
}

module.exports = new NyaaSearchService();
