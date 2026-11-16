const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

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
    acquireDedicatedKeyForMovie(movieIdentifier = 'default') {
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

        // Se todas as chaves estiverem em cooldown, seleciona a que tiver o cooldown mais próximo de expirar
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
            console.warn(`⚠️ [Gemini Key Manager] Todas as chaves estão em cooldown. Reutilizando Chave #${chosenIndex + 1}/${total} (${this.maskKey(chosenKey)}).`);
        } else {
            console.log(`🔑 [Gemini Key Manager] Filme "${movieIdentifier}": Chave dedicada atribuída #${chosenIndex + 1}/${total} (${this.maskKey(chosenKey)})`);
        }

        return { key: chosenKey, index: chosenIndex, total };
    }

    /**
     * Executa failover automático quando uma chave sofre 429, 503 ou timeout.
     * Coloca a chave falha em cooldown de 60s e troca para a próxima chave saudável.
     */
    rotateKeyOnFailure(failedKey, movieIdentifier = '', reason = '') {
        const keys = this.getAllKeys();
        const total = keys.length;
        const failedIdx = keys.indexOf(failedKey);

        // Aplica cooldown de 60 segundos na chave com erro
        const cooldownMs = 60000;
        this.cooldowns.set(failedKey, Date.now() + cooldownMs);

        console.warn(`🔄 [Gemini Key Failover] Chave #${failedIdx + 1}/${total} (${this.maskKey(failedKey)}) sofreu falha [${reason}]. Colocada em cooldown de 60s.`);

        if (total === 1) {
            console.warn(`⚠️ [Gemini Key Failover] Pool possui apenas 1 chave. Aguardando 10s antes de retentar com a mesma chave...`);
            return { key: failedKey, index: 0, total: 1, waited: true };
        }

        // Procura a próxima chave saudável
        for (let i = 1; i <= total; i++) {
            const nextIdx = (failedIdx + i) % total;
            const candidate = keys[nextIdx];
            if (!this.isKeyInCooldown(candidate)) {
                console.log(`✅ [Gemini Key Failover] Filme "${movieIdentifier}": Alternando com sucesso para Chave #${nextIdx + 1}/${total} (${this.maskKey(candidate)}).`);
                return { key: candidate, index: nextIdx, total, waited: false };
            }
        }

        // Se todas estiverem em cooldown, pega a chave seguinte
        const nextIdx = (failedIdx + 1) % total;
        const candidate = keys[nextIdx];
        console.warn(`⚠️ [Gemini Key Failover] Todas as chaves do pool estão em cooldown. Alternando para Chave #${nextIdx + 1}/${total} (${this.maskKey(candidate)}).`);
        return { key: candidate, index: nextIdx, total, waited: false };
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
     */
    convertSrtToVtt(srtContent) {
        if (!srtContent) return 'WEBVTT\n\n';
        const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        // Converte vírgula decimal de milissegundos para ponto: 00:01:23,456 -> 00:01:23.456
        const vttBody = normalized.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
        return `WEBVTT\n\n${vttBody}\n`;
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
            '5. COERÊNCIA DE CONTEXTO: Utilize os diálogos anteriores fornecidos em "contexto_anterior" apenas para manter a consistência de gênero dos personagens (ele/ela), pronomes e nomes próprios.',
            '6. FORMATO DE SAÍDA: Retorne estritamente um array JSON contendo exatamente os mesmos IDs recebidos em "falas_para_traduzir", cada qual com seu "id" numérico correspondente e "text" com a tradução em PT-BR.'
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

            // Remonta o lote com o texto traduzido limpo
            return itemsToTranslate.map(orig => {
                const item = byId.get(orig.id);
                const cleanText = item.text.trim().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
                return {
                    id: orig.id,
                    timecode: orig.timecode,
                    text: cleanText
                };
            });
        } catch (err) {
            const statusCode = err.response?.status;
            const isRateLimitOrTimeout = statusCode === 429 || statusCode === 503 || err.code === 'ECONNABORTED' || err.message.includes('timeout') || err.message.includes('Resource has been exhausted');

            if (isRateLimitOrTimeout) {
                if (retry >= 3) {
                    throw new Error(`Limite de retentativas atingido para lote com chave em failover: ${err.message}`);
                }
                const failoverKeyObj = this.rotateKeyOnFailure(apiKey, movieTitle, `Status ${statusCode || err.code || 'timeout'}`);
                if (failoverKeyObj.waited) {
                    await new Promise(r => setTimeout(r, 10000));
                }
                // Retoma exatamente o mesmo lote com a nova chave saudável
                return this.translateBatchWithGemini(itemsToTranslate, previousContext, failoverKeyObj, movieTitle, retry + 1);
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
        console.log(`🔑 [Pool de Chaves] Chave em uso: #${activeKeyObj.index + 1}/${activeKeyObj.total} (${this.maskKey(activeKeyObj.key)}) | Total de falas: ${originalCues.length}...`);

        const translatedCues = [];
        const totalBatches = Math.ceil(originalCues.length / this.batchSize);

        for (let b = 0; b < totalBatches; b++) {
            const start = b * this.batchSize;
            const end = Math.min(start + this.batchSize, originalCues.length);
            const batch = originalCues.slice(start, end);

            // Coleta até 3 falas traduzidas do lote anterior como contexto de leitura
            const prevContext = translatedCues.slice(-this.contextSize);

            console.log(`🔄 [Neural Translation: "${title}"] Lote ${b + 1}/${totalBatches} (falas ${start + 1} a ${end}) | Chave #${activeKeyObj.index + 1}/${activeKeyObj.total} (${this.maskKey(activeKeyObj.key)})...`);

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
