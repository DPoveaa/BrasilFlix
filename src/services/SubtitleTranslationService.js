const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');
const SubtitleUtils = require('../utils/SubtitleUtils');

class SubtitleTranslationService {
    constructor() {
        this.modelName = config.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
        this.batchSize = 90; // Bloco de 80 a 100 falas por requisição
        this.contextSize = 3; // Últimas 3 falas anteriores como contexto de leitura

        // Gerenciamento de Pool de Chaves com Round-Robin e Failover
        this.globalKeyCounter = 0;
        this.cooldowns = new Map(); // key -> timestamp em ms até quando está em cooldown
    }

    /**
     * Retorna todas as chaves de API do Gemini configuradas no pool
     * Suporta GEMINI_API_KEYS=key1,key2,key3 com fallback para GEMINI_API_KEY única
     */
    getAllKeys() {
        const raw = config.GEMINI_API_KEYS || process.env.GEMINI_API_KEYS || config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
        if (!raw || typeof raw !== 'string') return [];
        return raw.split(',')
            .map(k => k.trim())
            .filter(k => k.length > 10);
    }

    /**
     * Retorna uma representação segura da chave mascarando o início (ex: '...ABCD')
     */
    maskKey(key) {
        if (!key || typeof key !== 'string') return 'N/A';
        const visible = key.slice(-4);
        return `...${visible}`;
    }

    /**
     * Verifica se o serviço de IA está disponível (pelo menos uma chave configurada)
     */
    isAvailable() {
        const keys = this.getAllKeys();
        return keys.length > 0;
    }

    /**
     * Verifica se uma chave está atualmente em cooldown ativo
     */
    isKeyInCooldown(key) {
        const availableAt = this.cooldowns.get(key);
        if (!availableAt) return false;
        if (Date.now() >= availableAt) {
            this.cooldowns.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Atribui uma chave dedicada para um filme específico via Round-Robin.
     * Garante que filmes em paralelo usem chaves distintas para evitar esgotamento de RPM.
     */
    acquireDedicatedKeyForMovie() {
        const keys = this.getAllKeys();
        if (keys.length === 0) {
            throw new Error('Nenhuma chave GEMINI_API_KEY ou GEMINI_API_KEYS configurada no ambiente.');
        }

        // Tenta encontrar uma chave saudável a partir do índice de round-robin
        const total = keys.length;
        let chosenKey = null;
        let chosenIndex = -1;

        for (let attempt = 0; attempt < total; attempt++) {
            const idx = (this.globalKeyCounter + attempt) % total;
            const candidate = keys[idx];
            if (!this.isKeyInCooldown(candidate)) {
                chosenKey = candidate;
                chosenIndex = idx;
                this.globalKeyCounter = (idx + 1) % total;
                break;
            }
        }

        if (!chosenKey) {
            throw this.providerError('Chaves do Gemini temporariamente em espera.', Math.min(...keys.map(key => this.cooldowns.get(key))));
        }
        return { key: chosenKey, index: chosenIndex, total };
    }

    providerError(message, retryAt) {
        return Object.assign(new Error(message), { code: 'SUBTITLE_PROVIDER_UNAVAILABLE', retryAt });
    }

    /**
     * Faz o parsing de uma string de legenda SRT em blocos estruturados.
     * Separa rigorosamente os metadados de tempo (index, timecode) do conteúdo textual.
     */
    parseSrt(srtContent) {
        if (!srtContent || typeof srtContent !== 'string') return [];
        const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const blocks = normalized.split(/\n\n+/);
        const cues = [];

        for (let i = 0; i < blocks.length; i++) {
            const lines = blocks[i].split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            let cueIndex = null;
            let timecodeLine = null;
            let textLines = [];

            if (/^\d+$/.test(lines[0]) && lines[1].includes('-->')) {
                cueIndex = parseInt(lines[0], 10);
                timecodeLine = lines[1];
                textLines = lines.slice(2);
            } else if (lines[0].includes('-->')) {
                cueIndex = cues.length + 1;
                timecodeLine = lines[0];
                textLines = lines.slice(1);
            }

            if (timecodeLine && textLines.length > 0) {
                cues.push({
                    id: cueIndex || (cues.length + 1),
                    timecode: timecodeLine,
                    text: textLines.join('\n')
                });
            }
        }
        return cues;
    }

    /**
     * Reconstrói o arquivo SRT formatado reinsirindo os textos traduzidos nos timecodes originais.
     */
    buildSrt(cues) {
        return cues.map((cue, idx) => {
            return `${idx + 1}\n${cue.timecode}\n${cue.text}`;
        }).join('\n\n') + '\n';
    }

    /**
     * Converte conteúdo de SRT para WebVTT (.vtt) padronizado para o player web
     * com validação estrita de timecodes, pontuação decimal e line:85%
     */
    convertSrtToVtt(srtContent) {
        if (!srtContent) return 'WEBVTT\n\n';
        const parsed = SubtitleUtils.parseSubtitles(srtContent);
        if (parsed && parsed.length > 0) {
            return SubtitleUtils.cuesToVtt(parsed);
        }
        return SubtitleUtils.sanitizeVtt(srtContent);
    }

    /**
     * Traduz um lote de falas via API do Google Gemini com saída estruturada.
     * ZERO envio de timecodes para a IA: envia estritamente array de { id, text }.
     * Envia também até 3 falas anteriores apenas como contexto estático de leitura.
     */
    async translateBatchWithGemini(itemsToTranslate, previousContext = [], activeKeyObj, movieTitle = '', retry = 0) {
        if (!activeKeyObj) {
            activeKeyObj = this.acquireDedicatedKeyForMovie(movieTitle || 'default');
        }
        const apiKey = activeKeyObj.key;
        const keyIndex = activeKeyObj.index;
        const totalKeys = activeKeyObj.total;

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`;

        const systemPrompt = [
            'Você é um tradutor audiovisual sênior especializado em localização para Português Brasileiro (PT-BR) de produções cinematográficas e plataformas de streaming (Netflix, HBO Max, Disney+).',
            '',
            'DIRETRIZES DE LOCALIZAÇÃO OBRIGATÓRIAS:',
            '1. REGISTRO E LINGUAGEM: Traduza com naturalidade, fluidez e espontaneidade do Brasil. Adapte gírias, expressões idiomáticas e referências culturais para o contexto brasileiro.',
            '2. PROIBIÇÃO ABSOLUTA DE PORTUGUÊS DE PORTUGAL (PT-PT):',
            '   - NUNCA utilize formulações da 2ª pessoa do singular (PROIBIDO: tu, viste, fizeste, estás, vais, queres). Use SEMPRE: você, viu, fez, está, vai, quer.',
            '   - NUNCA utilize ênclises ou construções lusitanas (PROIBIDO: "-lhe a ele", "-mo", "não me batas", "dei-lhe a ele", "estou a fazer"). Use próclise brasileira ("não me bata", "dei pra ele", "estou fazendo").',
            '   - NUNCA use vocabulário europeu (PROIBIDO: ecrã, comboio, autocarro, telemóvel, casa de banho, frigorífico, fato, miúdo, gajo). Use: tela, trem, ônibus, celular, banheiro, geladeira, terno, garoto, cara.',
            '3. PRESERVAÇÃO DE TAGS: Mantenha rigorosamente quaisquer tags de formatação como <i>...</i>, <b>...</b>, <u>...</u>.',
            '4. QUEBRA DE LINHAS: Falas longas devem ser divididas em no máximo 2 linhas breves (idealmente até ~42 caracteres por linha, separadas por \\n). Falas curtas devem ficar em linha única.',
            '5. PROIBIÇÃO DE ASPAS EXTERNAS: NUNCA envolva as falas traduzidas em aspas adicionais (como "..." ou “...”). Retorne diretamente o texto puro da fala.',
            '6. COERÊNCIA DE CONTEXTO: Utilize os diálogos anteriores fornecidos em "contexto_anterior" apenas para manter a consistência de gênero dos personagens (ele/ela), pronomes e nomes próprios.',
            '7. FORMATO DE SAÍDA: Retorne estritamente um array JSON contendo exatamente os mesmos IDs recebidos em "falas_para_traduzir", cada qual com seu "id" numérico correspondente e "text" com a tradução em PT-BR.'
        ].join('\n');

        const payloadObj = {
            contexto_anterior_apenas_leitura: previousContext.length > 0 ? previousContext.map(c => ({ id: c.id, text_ptbr: c.text })) : undefined,
            falas_para_traduzir: itemsToTranslate.map(c => ({ id: c.id, text: c.text }))
        };

        const requestBody = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(payloadObj) }] }],
            generationConfig: {
                temperature: 0.25,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: {
                            id: { type: 'INTEGER' },
                            text: { type: 'STRING' }
                        },
                        required: ['id', 'text']
                    }
                }
            }
        };

        try {
            const res = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                timeout: 50000
            });

            const candidate = res.data?.candidates?.[0];
            const translatedJsonText = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
            if (!translatedJsonText) {
                throw new Error('Gemini retornou resposta vazia.');
            }

            let parsedList;
            try {
                parsedList = JSON.parse(translatedJsonText);
            } catch (jsonErr) {
                throw new Error(`Resposta do Gemini não é um JSON válido: ${jsonErr.message}`);
            }

            if (!Array.isArray(parsedList) || parsedList.length === 0) {
                throw new Error('O Gemini retornou um array vazio ou inválido.');
            }

            const byId = new Map(parsedList.map(item => [item.id, item]));

            // Valida correspondência 1:1 de todos os IDs do lote
            const missingIds = itemsToTranslate.filter(orig => !byId.has(orig.id) || !byId.get(orig.id).text?.trim());
            if (missingIds.length > 0) {
                throw new Error(`Gemini omitiu ${missingIds.length} falas do lote (ex: IDs ${missingIds.slice(0, 3).map(m => m.id).join(', ')}).`);
            }

            // Remonta o lote com o texto traduzido limpo e sem aspas externas
            return itemsToTranslate.map(orig => {
                const item = byId.get(orig.id);
                const rawText = (item.text || '').trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                const cleanText = SubtitleUtils.stripOuterQuotes(rawText);
                return {
                    id: orig.id,
                    timecode: orig.timecode,
                    text: cleanText
                };
            });
        } catch (err) {
            const status = err.response?.status;
            if (status >= 500 || err.code === 'ECONNABORTED') {
                const retryAfter = Number(err.response?.headers?.['retry-after']);
                if (retry === 0 && !retryAfter) {
                    await new Promise(resolve => setTimeout(resolve, 2500));
                    return this.translateBatchWithGemini(itemsToTranslate, previousContext, activeKeyObj, movieTitle, retry + 1);
                }
                this.providerRetryAt = Date.now() + Math.max(90, Number.isFinite(retryAfter) ? retryAfter : 0) * 1000;
                throw this.providerError(`Gemini temporariamente indisponível (${status || 'timeout'}).`, this.providerRetryAt);
            }
            if ([401, 403, 429].includes(status)) {
                const retryAfter = Number(err.response?.headers?.['retry-after']);
                const wait = status === 429 ? Math.max(60, Number.isFinite(retryAfter) ? retryAfter : 0) : 900;
                const retryAt = Date.now() + wait * 1000;
                this.cooldowns.set(apiKey, retryAt);
                if (retry < 1) {
                    Object.assign(activeKeyObj, this.acquireDedicatedKeyForMovie(movieTitle));
                    return this.translateBatchWithGemini(itemsToTranslate, previousContext, activeKeyObj, movieTitle, retry + 1);
                }
                const reason = status === 429 ? 'Limite de requisições do Gemini' : 'Gemini recusou a credencial ou a permissão';
                throw this.providerError(`${reason} (${status}).`, retryAt);
            }
            if (status >= 400) {
                this.providerRetryAt = Date.now() + 5 * 60 * 1000;
                throw this.providerError(`Gemini recusou a requisição (${status}).`, this.providerRetryAt);
            }

            if (retry < 2) {
                const backoffMs = (retry + 1) * 2000;
                console.warn(`⚠️ [SubtitleTranslation] Tentativa ${retry + 1} falhou para lote com Chave #${keyIndex + 1}/${totalKeys} (${err.message}). Retentando em ${backoffMs / 1000}s...`);
                await new Promise(r => setTimeout(r, backoffMs));
                return this.translateBatchWithGemini(itemsToTranslate, previousContext, activeKeyObj, movieTitle, retry + 1);
            }
            throw err;
        }
    }

    /**
     * Traduz uma legenda SRT completa a partir da legenda âncora em inglês para PT-BR genuíno.
     * Zero alteração de timestamps: preserva os timecodes originais milissegundo a milissegundo.
     * @param {string} srtContent Conteúdo original em inglês (.srt)
     * @param {object} options Opções adicionais (título, onBatch, etc.)
     * @returns {Promise<string>} Conteúdo SRT completo traduzido em Português Brasileiro
     */
    async translateSrt(srtContent, options = {}) {
        if (this.providerRetryAt > Date.now()) {
            throw this.providerError('Gemini em espera após indisponibilidade.', this.providerRetryAt);
        }
        if (!this.isAvailable()) {
            throw new Error('Serviço de tradução neural indisponível: nenhuma chave GEMINI_API_KEY ou GEMINI_API_KEYS configurada no .env.');
        }

        const originalCues = this.parseSrt(srtContent);
        if (originalCues.length === 0) {
            throw new Error('Nenhuma fala válida identificada no arquivo SRT em inglês para tradução.');
        }

        const title = options.title || options.nome || 'Mídia';

        // 1. Atribui 1 chave dedicada por filme via round-robin
        let activeKeyObj = this.acquireDedicatedKeyForMovie(title);

        console.log(`🤖 [Neural Subtitle Translation: "${title}"] Iniciando tradução via Gemini API (${this.modelName})`);

        const translatedCues = [];
        const totalBatches = Math.ceil(originalCues.length / this.batchSize);

        for (let b = 0; b < totalBatches; b++) {
            const start = b * this.batchSize;
            const end = Math.min(start + this.batchSize, originalCues.length);
            const batch = originalCues.slice(start, end);

            // Coleta até 3 falas traduzidas do lote anterior como contexto de leitura
            const prevContext = translatedCues.slice(-this.contextSize);

            console.log(`🔄 [Neural Translation: "${title}"] Lote ${b + 1}/${totalBatches} (falas ${start + 1} a ${end})...`);

            const translatedBatch = await this.translateBatchWithGemini(batch, prevContext, activeKeyObj, title);
            translatedCues.push(...translatedBatch);

            if (options.onBatch && typeof options.onBatch === 'function') {
                options.onBatch(b + 1, totalBatches);
            }

            // Intervalo suave entre requisições para respeitar RPM
            if (b + 1 < totalBatches) {
                await new Promise(r => setTimeout(r, 600));
            }
        }

        const finalSrt = this.buildSrt(translatedCues);
        console.log(`✅ [Neural Translation: "${title}"] Tradução concluída com sucesso! (${translatedCues.length} falas em PT-BR com timecodes idênticos à âncora).`);
        return finalSrt;
    }

    /**
     * Traduz um arquivo SRT em disco e grava os resultados em SRT e VTT preservando timecodes exatos.
     * @param {string} inputSrtPath Caminho do SRT em inglês (.srt)
     * @param {string} outputSrtPath Caminho de saída para o SRT traduzido em PT-BR (.srt)
     * @param {object} options Opções adicionais
     * @returns {Promise<{ srtPath: string, vttPath: string }>} Caminhos dos arquivos gerados
     */
    async translateSrtFile(inputSrtPath, outputSrtPath, options = {}) {
        if (!fs.existsSync(inputSrtPath)) {
            throw new Error(`Arquivo de legenda em inglês não encontrado: ${inputSrtPath}`);
        }

        const srtContent = await fs.readFile(inputSrtPath, 'utf8');
        const translatedSrtContent = await this.translateSrt(srtContent, options);

        await fs.ensureDir(path.dirname(outputSrtPath));
        await fs.writeFile(outputSrtPath, translatedSrtContent, 'utf8');

        // Gera e salva automaticamente o formato .vtt lado a lado para o player web
        const outputVttPath = outputSrtPath.replace(/\.srt$/i, '.vtt');
        const vttContent = this.convertSrtToVtt(translatedSrtContent);
        await fs.writeFile(outputVttPath, vttContent, 'utf8');

        return {
            srtPath: outputSrtPath,
            vttPath: outputVttPath
        };
    }
}

module.exports = new SubtitleTranslationService();
