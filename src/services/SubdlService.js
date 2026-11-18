const axios = require('axios');
const AdmZip = require('adm-zip');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../../config');

const execFileAsync = promisify(execFile);

class SubdlService {
    constructor() {
        this.apiBaseUrl = 'https://api.subdl.com/api/v1/subtitles';
        this.downloadBaseUrl = 'https://dl.subdl.com';
        this.currentKeyIndex = 0;
        this.cooldowns = new Map(); // key -> timestamp em ms até quando está em cooldown
    }

    /**
     * Retorna todas as chaves configuradas no pool
     * Suporta SUBDL_API_KEYS=k1,k2,k3 com fallback para SUBDL_API_KEY
     */
    getAllKeys() {
        const raw = config.SUBDL_API_KEYS || process.env.SUBDL_API_KEYS || config.SUBDL_API_KEY || process.env.SUBDL_API_KEY || '';
        if (!raw || typeof raw !== 'string') return [];
        return raw.split(',')
            .map(k => k.trim())
            .filter(k => k.length > 5);
    }

    /**
     * Retorna a chave sanitizada (ex: '...TNVHc')
     */
    maskKey(key) {
        if (!key || typeof key !== 'string') return 'N/A';
        const visible = key.slice(-5);
        return `...${visible}`;
    }

    /**
     * Verifica se o serviço está disponível (pelo menos 1 chave configurada)
     */
    isAvailable() {
        return this.getAllKeys().length > 0;
    }

    /**
     * Verifica se uma chave está em cooldown ativo
     */
    isKeyInCooldown(key) {
        const until = this.cooldowns.get(key);
        if (!until) return false;
        if (Date.now() >= until) {
            this.cooldowns.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Marca uma chave em cooldown (ex: 429, limite diário ou timeout)
     */
    markKeyCooldown(key, reason = 'Erro ou cota excedida', cooldownMs = 3600000) {
        const keys = this.getAllKeys();
        const idx = keys.indexOf(key);
        const idxStr = idx >= 0 ? `#${idx + 1}/${keys.length}` : '';
        this.cooldowns.set(key, Date.now() + cooldownMs);
        console.warn(`⚠️ [SubDL Pool] Chave ${idxStr} (${this.maskKey(key)}) colocada em cooldown por ${(cooldownMs / 60000).toFixed(0)}m (${reason}).`);
    }

    /**
     * Adquire a próxima chave saudável via Round-Robin
     */
    acquireKey(contextIdentifier = '') {
        const keys = this.getAllKeys();
        if (keys.length === 0) return null;

        const total = keys.length;
        let chosenKey = null;
        let chosenIndex = -1;

        for (let attempt = 0; attempt < total; attempt++) {
            const idx = (this.currentKeyIndex + attempt) % total;
            const candidate = keys[idx];
            if (!this.isKeyInCooldown(candidate)) {
                chosenKey = candidate;
                chosenIndex = idx;
                this.currentKeyIndex = (idx + 1) % total;
                break;
            }
        }

        if (!chosenKey) {
            let earliestTime = Infinity;
            keys.forEach((k, idx) => {
                const t = this.cooldowns.get(k) || 0;
                if (t < earliestTime) {
                    earliestTime = t;
                    chosenKey = k;
                    chosenIndex = idx;
                }
            });
            console.warn(`⚠️ [SubDL Pool] Todas as ${total} chaves estão em cooldown. Tentando chave mais próxima do reset #${chosenIndex + 1}/${total} (${this.maskKey(chosenKey)}).`);
        } else {
            console.log(`🔑 [SubDL Pool] Chave #${chosenIndex + 1}/${total} (${this.maskKey(chosenKey)}) selecionada para "${contextIdentifier}".`);
        }

        return { key: chosenKey, index: chosenIndex, total };
    }

    /**
     * Verifica se o erro ou resposta indica esgotamento de cota diária ou rate limit
     */
    isQuotaOrRateLimitError(errOrData) {
        if (!errOrData) return false;
        if (errOrData.response) {
            const status = errOrData.response.status;
            if (status === 429 || status === 402 || status === 403) return true;
            const body = errOrData.response.data;
            if (body && typeof body === 'object') {
                const msg = JSON.stringify(body).toLowerCase();
                if (/quota|limit|download|exceed|429|reach/i.test(msg)) return true;
            }
        }
        if (typeof errOrData === 'object' && errOrData.status === false) {
            const msg = (errOrData.error || errOrData.message || '').toLowerCase();
            if (/quota|limit|download|exceed|429|reach/i.test(msg)) return true;
        }
        if (errOrData.code === 'ECONNABORTED' || errOrData.code === 'ETIMEDOUT') {
            return true;
        }
        return false;
    }

    /**
     * Executa chamada com rotação e failover automático de chaves
     */
    async executeWithFailover(actionFn, contextName = '') {
        const keys = this.getAllKeys();
        if (keys.length === 0) {
            throw new Error('Nenhuma chave SubDL configurada no pool.');
        }

        let lastError = null;
        const maxAttempts = keys.length;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const keyInfo = this.acquireKey(contextName);
            if (!keyInfo || !keyInfo.key) {
                break;
            }

            try {
                const result = await actionFn(keyInfo.key, keyInfo);
                return result;
            } catch (err) {
                lastError = err;
                // A missing subtitle is candidate-specific, not an exhausted API key.
                if (err.response?.status === 404) throw err;
                const isQuota = this.isQuotaOrRateLimitError(err);
                const reason = isQuota ? 'Limite diário de downloads ou rate-limit 429 atingido' : `Erro na requisição: ${err.message}`;
                this.markKeyCooldown(keyInfo.key, reason, isQuota ? 3600000 : 300000);

                if (attempt < maxAttempts - 1) {
                    console.log(`🔄 [SubDL Pool] Alternando imediatamente para a próxima chave saudável do pool...`);
                }
            }
        }

        throw lastError || new Error(`Todas as ${keys.length} chaves do pool SubDL falharam ou estão em cooldown.`);
    }

    /**
     * Busca metadados de legendas na API oficial do SubDL com suporte a múltiplos identificadores,
     * título original em inglês, título traduzido em português e tolerância de ano ±1.
     * @param {object} params - { imdbId, tmdbId, type, season, episode, title, originalTitle, year, languages }
     */
    async searchSubtitles(params = {}) {
        const { imdbId, tmdbId, type, season, episode, title, originalTitle, year, languages, onIncomplete } = params;
        const searchLang = languages || 'BR_PT';

        const doQuery = async (querySpecifics, label) => {
            try {
                return await this.executeWithFailover(async (apiKey, keyInfo) => {
                    const queryParams = {
                        api_key: apiKey,
                        languages: searchLang,
                        subs_per_page: 30,
                        type: type === 'serie' ? 'tv' : 'movie',
                        ...(onIncomplete && { unpack: 1 }),
                        ...querySpecifics
                    };

                    if (type === 'serie' && season && episode) {
                        queryParams.type = 'tv';
                        queryParams.season_number = season;
                        queryParams.episode_number = episode;
                    }

                    console.log(`🌐 [SubDL API] Consultando [${label}] [Chave #${keyInfo.index + 1}/${keyInfo.total} (${this.maskKey(apiKey)})] lang: ${searchLang}...`);
                    try {
                        const res = await axios.get(this.apiBaseUrl, {
                            params: queryParams,
                            timeout: 10000,
                            headers: { 'User-Agent': 'BrasilFlix/1.0.0' }
                        });

                        if (res.data?.status === false) {
                            if (this.isQuotaOrRateLimitError(res.data)) {
                                const err = new Error(res.data.error || res.data.message || 'SubDL Quota Exceeded');
                                err.response = { status: 429, data: res.data };
                                throw err;
                            }
                            const reason = String(res.data.error || res.data.message || '');
                            if (!/not found|no (results?|subtitles?|films?|series|matches)|nenhum/i.test(reason)) {
                                onIncomplete?.('SubDL recusou uma consulta');
                            }
                            return [];
                        }
                        if (!Array.isArray(res.data?.subtitles)) onIncomplete?.('SubDL retornou uma resposta inválida');
                        // The v1 docs specify the response size but no page cursor.
                        // A full response cannot prove that the API exposed every result.
                        if (res.data?.subtitles?.length >= 30) onIncomplete?.('SubDL atingiu o limite de resultados por consulta');
                        return res.data?.subtitles || [];
                    } catch (err) {
                        if (this.isQuotaOrRateLimitError(err)) throw err;
                        if (![404, 410].includes(err.response?.status)) onIncomplete?.('SubDL indisponível');
                        console.warn(`⚠️ [SubDL API] Erro na consulta [${label}]:`, err.message);
                        return [];
                    }
                }, label);
            } catch (error) {
                if (!onIncomplete) throw error;
                onIncomplete('Consulta do SubDL indisponível ou limitada');
                return [];
            }
        };

        let subtitles = [];

        // 1. Busca por IMDb ID (se disponível)
        if (imdbId) {
            subtitles = await doQuery({ imdb_id: imdbId }, `imdb_id: ${imdbId}`);
        }

        // 2. Fallback por TMDB ID (se disponível e sem resultados)
        if ((onIncomplete || !subtitles.length) && tmdbId) {
            subtitles.push(...await doQuery({ tmdb_id: tmdbId }, `tmdb_id: ${tmdbId}`));
        }

        // 3. Fallback por Título Original em Inglês (ex: "Ice Age", "Harry Potter and the Goblet of Fire")
        const cleanEngTitle = (originalTitle || '').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
        if ((onIncomplete || !subtitles.length) && cleanEngTitle.length >= 2) {
            subtitles.push(...await doQuery({ film_name: cleanEngTitle }, `film_name (EN): "${cleanEngTitle}"`));
        }

        // 4. Fallback por Título Localizado em Português (ex: "A Era do Gelo")
        const cleanPtTitle = (title || '').replace(/[^\w\s-]/g, ' ').replace(/\s+/g, ' ').trim();
        if ((onIncomplete || !subtitles.length) && cleanPtTitle.length >= 2 && cleanPtTitle.toLowerCase() !== cleanEngTitle.toLowerCase()) {
            subtitles.push(...await doQuery({ film_name: cleanPtTitle }, `film_name (PT): "${cleanPtTitle}"`));
        }

        if (onIncomplete) {
            const expanded = subtitles.flatMap(sub => {
                const files = (Array.isArray(sub.unpack_files) ? sub.unpack_files : []).filter(file => file.url &&
                    (type !== 'serie' || (Number(file.season) === Number(season) && Number(file.episode) === Number(episode))));
                if (files.length) return files.map(file => ({ ...sub, ...file, rawFile: true }));
                if (type === 'serie' && sub.season != null && Number(sub.season) !== Number(season)) return [];
                if (type === 'serie' && sub.episode != null && Number(sub.episode) !== Number(episode) &&
                    !(Number(sub.episode_from) <= Number(episode) && Number(sub.episode_end) >= Number(episode))) return [];
                return [{ ...sub, targetSeason: season, targetEpisode: episode }];
            });
            return [...new Map(expanded.filter(sub => sub.url).map(sub => [sub.url, sub])).values()];
        }

        // Filtragem por tolerância de ano ±1 se o ano for conhecido
        if (year && subtitles.length > 0) {
            const targetYear = parseInt(year, 10);
            if (!isNaN(targetYear) && targetYear > 1900) {
                const yearFiltered = subtitles.filter(s => {
                    const rel = (s.release_name || s.name || '').toLowerCase();
                    const m = rel.match(/\b(19\d{2}|20\d{2})\b/);
                    if (!m) return true; // Mantém se não tiver ano no nome
                    const subYear = parseInt(m[1], 10);
                    return Math.abs(subYear - targetYear) <= 1;
                });
                if (yearFiltered.length > 0) {
                    subtitles = yearFiltered;
                }
            }
        }

        return subtitles;
    }

    /**
     * Ranqueia os candidatos retornados pelo SubDL baseado nos tokens do release do vídeo
     * Economiza downloads ao ordenar estritamente antes de baixar
     */
    rankCandidates(subtitles = [], videoFileName = '', metadata = {}) {
        if (!Array.isArray(subtitles) || subtitles.length === 0) return [];

        const tokenize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(t => t.length > 2);
        const fileTokens = tokenize(videoFileName);

        const qualityTokens = ['1080p', '720p', '2160p', '4k', 'bluray', 'bdrip', 'brrip', 'webrip', 'webdl', 'web', 'hdtv', 'yts', 'yify', 'rarbg', 'psa', 'x264', 'x265', 'hevc'];

        const scored = subtitles.map(sub => {
            const rel = (sub.release_name || sub.name || '').toLowerCase();
            const subTokens = tokenize(rel);

            let score = 0;

            // Tokens comuns com o nome do arquivo do torrent/vídeo
            const commonTokens = subTokens.filter(t => fileTokens.includes(t));
            score += commonTokens.length * 15;

            // Bônus especial para correspondência exata de tokens de qualidade/fonte
            for (const qt of qualityTokens) {
                if (fileTokens.includes(qt) && subTokens.includes(qt)) {
                    score += 25;
                }
            }

            // Bônus para marcação inequívoca de Português Brasileiro
            const lang = (sub.language || sub.lang || '').toLowerCase();
            if (lang === 'br_pt' || lang === 'br-pt' || lang.includes('brazilian') || lang.includes('pob') || lang.includes('pt-br')) {
                score += 50;
            }

            // Bônus para correspondência de ano de lançamento (tolerância ±1 ano)
            const targetYear = parseInt(metadata.year || metadata.ano, 10);
            if (!isNaN(targetYear) && targetYear > 1900) {
                const ym = rel.match(/\b(19\d{2}|20\d{2})\b/);
                if (ym) {
                    const subYear = parseInt(ym[1], 10);
                    if (Math.abs(subYear - targetYear) <= 1) {
                        score += 60;
                    } else {
                        score -= 80;
                    }
                }
            }

            // Penalidade severa para releases divididos em múltiplos CDs (CD1, CD2, etc.) em mídias de arquivo único
            if (/\b(cd1|cd2|2cd|part1|part2|dis[ck]1|dis[ck]2)\b/i.test(rel)) {
                score -= 200;
            }

            // Bônus para edições estendidas / completas
            if (/\b(extended|ee|remastered|unrated|director)\b/i.test(rel)) {
                score += 45;
            }

            // Penalidade para qualquer tag de Portugal
            if (/\b(pt[-.]?pt|portugal)\b/.test(rel) || lang.includes('pt-pt')) {
                score -= 300;
            }

            // Para séries: validação de temporada e episódio
            if (metadata.tipo === 'serie') {
                const targetSeason = parseInt(metadata.season || 1, 10);
                const targetEpisode = parseInt(metadata.episode || 1, 10);
                if (sub.season === targetSeason && sub.episode === targetEpisode) {
                    score += 100;
                } else if (sub.season && sub.season !== targetSeason) {
                    score -= 200;
                }
            }

            return { sub, score };
        });

        // Ordena por score decrescente
        scored.sort((a, b) => b.score - a.score);
        return scored.map(item => item.sub);
    }

    /**
     * Baixa o pacote .zip do candidato selecionado e extrai o arquivo .srt completo
     * @param {object} sub - Objeto de metadados da legenda retornado pelo SubDL
     * @param {string} tempDir - Diretório temporário para extração
     */
    async downloadAndExtractSubtitle(sub, tempDir = os.tmpdir(), allFiles = false) {
        if (!sub || !sub.url) {
            throw new Error('URL de download da legenda ausente nos metadados do SubDL.');
        }

        return await this.executeWithFailover(async (apiKey, keyInfo) => {
            // Garante que a URL use a chave ativa do pool
            let rawUrl = sub.url;
            if (!rawUrl.startsWith('http')) {
                rawUrl = `${this.downloadBaseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;
            }

            // Atualiza/injeta api_key na URL
            const parsedUrl = new URL(rawUrl);
            if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== new URL(this.downloadBaseUrl).hostname) {
                throw new Error('Origem de download do SubDL inválida.');
            }
            parsedUrl.searchParams.set('api_key', apiKey);
            const downloadUrl = parsedUrl.toString();

            console.log(`📥 [SubDL Download] Baixando pacote .zip [Chave #${keyInfo.index + 1}/${keyInfo.total} (${this.maskKey(apiKey)})]: "${sub.release_name || sub.name}"...`);

            const dlRes = await axios.get(downloadUrl, {
                timeout: 15000,
                responseType: 'arraybuffer',
                headers: { 'User-Agent': 'BrasilFlix/1.0.0' }
            });

            if (dlRes.status !== 200) {
                const err = new Error(`Download falhou com HTTP ${dlRes.status}`);
                err.response = dlRes;
                throw err;
            }

            // Extrai o conteúdo do ZIP usando AdmZip
            const zipBuffer = Buffer.from(dlRes.data);
            const entries = sub.rawFile && zipBuffer.subarray(0, 2).toString() !== 'PK'
                ? [{ entryName: sub.name || `subtitle.${sub.format || 'srt'}`, header: { size: zipBuffer.length }, getData: () => zipBuffer }]
                : new AdmZip(zipBuffer).getEntries();

            // Filtra entradas válidas (ignora pastas, __MACOSX e arquivos de sistema)
            const validEntries = entries.filter(e => {
                if (e.isDirectory) return false;
                const name = e.entryName.toLowerCase();
                if (name.includes('__macosx') || path.basename(name).startsWith('._')) return false;
                return name.endsWith('.srt') || name.endsWith('.vtt') || name.endsWith('.ass');
            });

            if (validEntries.length === 0) {
                throw new Error(`Nenhum arquivo de legenda (.srt, .vtt, .ass) encontrado dentro do .zip do SubDL.`);
            }

            // Se houver múltiplos arquivos, seleciona o arquivo completo principal
            // Ignora arquivos marcados como forced, signs, sample se houver opção normal
            const nonForced = validEntries.filter(e => {
                const n = e.entryName.toLowerCase();
                return !/(forced|for[cç]ad|signs|sample)/i.test(n);
            });

            let candidateEntries = nonForced.length > 0 ? nonForced : validEntries;
            if (sub.targetEpisode && candidateEntries.length > 1) {
                const matchEpisode = candidateEntries.filter(entry => {
                    const name = path.basename(entry.entryName, path.extname(entry.entryName));
                    const pair = name.match(/(?:^|[^a-z0-9])(?:s(\d{1,2})[ ._-]*e(\d{1,3})|(\d{1,2})x(\d{1,3}))(?!\d)/i);
                    return pair && Number(pair[1] || pair[3]) === Number(sub.targetSeason) &&
                        Number(pair[2] || pair[4]) === Number(sub.targetEpisode);
                });
                if (matchEpisode.length) candidateEntries = matchEpisode;
                else if (sub.full_season || Number(sub.episode_end) > Number(sub.episode_from)) {
                    throw new Error('Pacote SubDL sem arquivo identificável para o episódio solicitado.');
                }
            }

            // Prioriza arquivos .srt maiores (que representam o filme inteiro, não split CD1/CD2 ou partes curtas)
            candidateEntries.sort((a, b) => b.header.size - a.header.size);
            const files = allFiles ? candidateEntries : candidateEntries.slice(0, 1);
            const outputs = [];
            for (const entry of files) {
                const ext = path.extname(entry.entryName).toLowerCase();
                const token = require('node:crypto').randomUUID();
                const outSrtPath = path.join(tempDir, `subdl_${token}.srt`);
                if (ext === '.srt') {
                    await fs.writeFile(outSrtPath, entry.getData());
                } else {
                    const input = path.join(tempDir, `subdl_${token}${ext}`);
                    try {
                        await fs.writeFile(input, entry.getData());
                        await execFileAsync('ffmpeg', [
                            '-nostdin', '-v', 'error', '-y', '-i', input, '-c:s', 'srt', outSrtPath
                        ], { timeout: 30000 });
                    } finally {
                        await fs.remove(input).catch(() => {});
                    }
                }
                outputs.push(outSrtPath);
            }
            return allFiles ? outputs : outputs[0];
        }, sub.release_name || sub.name || 'Download SubDL');
    }
}

module.exports = new SubdlService();
