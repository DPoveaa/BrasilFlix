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
     * Busca metadados de legendas na API oficial do SubDL com estrito filtro BR_PT
     * @param {object} params - { imdbId, tmdbId, type, season, episode, title }
     */
    async searchSubtitles(params = {}) {
        const { imdbId, tmdbId, type, season, episode, title } = params;

        return await this.executeWithFailover(async (apiKey, keyInfo) => {
            const queryParams = {
                api_key: apiKey,
                languages: 'BR_PT',
                subs_per_page: 30
            };

            if (imdbId) {
                queryParams.imdb_id = imdbId;
            } else if (tmdbId) {
                queryParams.tmdb_id = tmdbId;
            }

            if (type === 'serie' && season && episode) {
                queryParams.type = 'tv';
                queryParams.season = season;
                queryParams.episode = episode;
            }

            console.log(`🌐 [SubDL API] Consultando legendas PT-BR [Chave #${keyInfo.index + 1}/${keyInfo.total} (${this.maskKey(apiKey)})] id: ${queryParams.imdb_id || queryParams.tmdb_id}...`);
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
                console.warn(`⚠️ [SubDL API] Resposta negativa da API:`, res.data.error || res.data.message || 'Sem resultados');
                return [];
            }

            let subtitles = res.data?.subtitles || [];

            // Se a busca por imdb_id não retornou legendas e temos tmdb_id, tenta fallback por tmdb_id
            if (subtitles.length === 0 && imdbId && tmdbId) {
                console.log(`🌐 [SubDL API] Nenhuma legenda por imdb_id (${imdbId}). Tentando fallback por tmdb_id (${tmdbId})...`);
                const fallbackParams = {
                    api_key: apiKey,
                    tmdb_id: tmdbId,
                    languages: 'BR_PT',
                    subs_per_page: 30
                };
                if (type === 'serie' && season && episode) {
                    fallbackParams.type = 'tv';
                    fallbackParams.season = season;
                    fallbackParams.episode = episode;
                }
                const fallbackRes = await axios.get(this.apiBaseUrl, {
                    params: fallbackParams,
                    timeout: 10000,
                    headers: { 'User-Agent': 'BrasilFlix/1.0.0' }
                });
                if (fallbackRes.data?.status !== false) {
                    subtitles = fallbackRes.data?.subtitles || [];
                }
            }

            return subtitles;
        }, title || imdbId || 'Busca SubDL');
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
    async downloadAndExtractSubtitle(sub, tempDir = os.tmpdir()) {
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
            const zip = new AdmZip(zipBuffer);
            const entries = zip.getEntries();

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
            let selectedEntry = null;
            const nonForced = validEntries.filter(e => {
                const n = e.entryName.toLowerCase();
                return !/(forced|for[cç]ad|signs|sample)/i.test(n);
            });

            const candidateEntries = nonForced.length > 0 ? nonForced : validEntries;

            // Prioriza arquivos .srt maiores (que representam o filme inteiro, não split CD1/CD2 ou partes curtas)
            candidateEntries.sort((a, b) => b.header.size - a.header.size);
            selectedEntry = candidateEntries[0];

            console.log(`📦 [SubDL Extract] Arquivo selecionado no .zip: "${selectedEntry.entryName}" (${(selectedEntry.header.size / 1024).toFixed(1)} KB).`);

            const entryBuffer = selectedEntry.getData();
            const ext = path.extname(selectedEntry.entryName).toLowerCase();
            const outSrtPath = path.join(tempDir, `subdl_${Date.now()}_extracted.srt`);

            if (ext === '.srt') {
                await fs.writeFile(outSrtPath, entryBuffer);
                return outSrtPath;
            } else if (ext === '.vtt' || ext === '.ass') {
                // Converte via ffmpeg para SRT padronizado
                const tempIn = path.join(tempDir, `subdl_temp_${Date.now()}${ext}`);
                await fs.writeFile(tempIn, entryBuffer);
                try {
                    await execFileAsync('ffmpeg', [
                        '-nostdin', '-v', 'error', '-y',
                        '-i', tempIn,
                        '-c:s', 'srt',
                        outSrtPath
                    ], { timeout: 30000 });
                    await fs.remove(tempIn).catch(() => { });
                    return outSrtPath;
                } catch (convErr) {
                    await fs.remove(tempIn).catch(() => { });
                    throw new Error(`Falha ao converter ${ext} para SRT: ${convErr.message}`);
                }
            }

            return outSrtPath;
        }, sub.release_name || sub.name || 'Download SubDL');
    }
}

module.exports = new SubdlService();
