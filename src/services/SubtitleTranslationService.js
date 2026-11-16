const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class SubtitleTranslationService {
    constructor() {
        this.modelName = config.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
        this.batchSize = 90; // Bloco de 80 a 100 falas por requisição
        this.contextSize = 3; // Últimas 3 falas anteriores como contexto de leitura
    }

    /**
     * Retorna a chave de API do Gemini configurada no ambiente
     */
    getApiKey() {
        return config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
    }

    /**
     * Verifica se o serviço de IA está disponível (chave configurada)
     */
    isAvailable() {
        const key = this.getApiKey();
        return typeof key === 'string' && key.trim().length > 10;
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
     * Traduz um lote de falas via API do Google Gemini com saída estruturada.
     * ZERO envio de timecodes para a IA: envia estritamente array de { id, text }.
     * Envia também até 3 falas anteriores apenas como contexto estático de leitura.
     */
    async translateBatchWithGemini(itemsToTranslate, previousContext = [], retry = 0) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY não configurada no ambiente.');
        }

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
            if (retry < 2) {
                const backoffMs = (retry + 1) * 2500;
                console.warn(`⚠️ [SubtitleTranslation] Tentativa ${retry + 1} falhou para lote (${err.message}). Retentando em ${backoffMs / 1000}s...`);
                await new Promise(r => setTimeout(r, backoffMs));
                return this.translateBatchWithGemini(itemsToTranslate, previousContext, retry + 1);
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
            throw new Error('Serviço de tradução neural indisponível: GEMINI_API_KEY não configurada no .env.');
        }

        const originalCues = this.parseSrt(srtContent);
        if (originalCues.length === 0) {
            throw new Error('Nenhuma fala válida identificada no arquivo SRT em inglês para tradução.');
        }

        const title = options.title || options.nome || 'Mídia';
        console.log(`🤖 [Neural Subtitle Translation: "${title}"] Iniciando tradução via Gemini API (${this.modelName}) | Total: ${originalCues.length} falas...`);

        const translatedCues = [];
        const totalBatches = Math.ceil(originalCues.length / this.batchSize);

        for (let b = 0; b < totalBatches; b++) {
            const start = b * this.batchSize;
            const end = Math.min(start + this.batchSize, originalCues.length);
            const batch = originalCues.slice(start, end);

            // Coleta até 3 falas traduzidas do lote anterior como contexto de leitura
            const prevContext = translatedCues.slice(-this.contextSize);

            console.log(`🔄 [Neural Translation: "${title}"] Processando lote ${b + 1}/${totalBatches} (falas ${start + 1} a ${end})...`);
            
            const translatedBatch = await this.translateBatchWithGemini(batch, prevContext);
            translatedCues.push(...translatedBatch);

            if (options.onBatch && typeof options.onBatch === 'function') {
                options.onBatch(b + 1, totalBatches);
            }

            // Intervalo suave entre requisições para evitar rate-limiting de RPM/TPM
            if (b + 1 < totalBatches) {
                await new Promise(r => setTimeout(r, 800));
            }
        }

        const finalSrt = this.buildSrt(translatedCues);
        console.log(`✅ [Neural Translation: "${title}"] Tradução concluída com sucesso! (${translatedCues.length} falas em PT-BR com timecodes idênticos à âncora).`);
        return finalSrt;
    }

    /**
     * Traduz um arquivo SRT em disco e grava o resultado preservando timecodes exatos.
     * @param {string} inputSrtPath Caminho do SRT em inglês (.srt)
     * @param {string} outputSrtPath Caminho de saída para o SRT traduzido em PT-BR (.srt)
     * @param {object} options Opções adicionais
     * @returns {Promise<string>} Caminho do arquivo SRT gerado
     */
    async translateSrtFile(inputSrtPath, outputSrtPath, options = {}) {
        if (!fs.existsSync(inputSrtPath)) {
            throw new Error(`Arquivo de legenda em inglês não encontrado: ${inputSrtPath}`);
        }

        const srtContent = await fs.readFile(inputSrtPath, 'utf8');
        const translatedContent = await this.translateSrt(srtContent, options);

        await fs.ensureDir(path.dirname(outputSrtPath));
        await fs.writeFile(outputSrtPath, translatedContent, 'utf8');
        return outputSrtPath;
    }
}

module.exports = new SubtitleTranslationService();
