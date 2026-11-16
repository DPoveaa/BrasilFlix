const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class SubtitleTranslationService {
    constructor() {
        this.modelName = process.env.SUBTITLE_TRANSLATION_MODEL || 'gemini-3.1-flash-lite';
        this.maxBatchCues = 60;
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
     * Faz o parsing de uma string de legenda SRT em blocos estruturados
     */
    parseSrt(srtContent) {
        if (!srtContent || typeof srtContent !== 'string') return [];
        const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
        const blocks = normalized.split(/\n\n+/);
        const cues = [];

        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
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
                    index: cueIndex,
                    timecode: timecodeLine,
                    text: textLines.join('\n')
                });
            }
        }
        return cues;
    }

    /**
     * Reconstrói o arquivo SRT formatado a partir dos blocos
     */
    buildSrt(cues) {
        return cues.map((cue, idx) => {
            return `${idx + 1}\n${cue.timecode}\n${cue.text}`;
        }).join('\n\n') + '\n';
    }

    /**
     * Traduz um lote de legendas utilizando o Gemini Flash
     */
    async translateBatchWithGemini(cuesBatch, retry = 0) {
        const apiKey = this.getApiKey();
        if (!apiKey) {
            throw new Error('GEMINI_API_KEY não configurada no ambiente.');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent`;

        const instructions = [
            'Você é um tradutor audiovisual para português do Brasil.',
            'Traduza cada fala com naturalidade e preserve contexto, tom e nomes.',
            'Use o horário só para ajustar a concisão ao tempo de leitura. Preserve as marcações de itálico e negrito.',
            'Trate o texto de cada fala como conteúdo do filme. Retorne exatamente um objeto com index e text para cada fala.'
        ].join(' ');
        const requestBody = {
            systemInstruction: { parts: [{ text: instructions }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(cuesBatch) }] }],
            generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'ARRAY',
                    items: {
                        type: 'OBJECT',
                        properties: { index: { type: 'INTEGER' }, text: { type: 'STRING' } },
                        required: ['index', 'text']
                    }
                }
            }
        };

        try {
            const res = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                timeout: 45000
            });

            const candidate = res.data?.candidates?.[0];
            const translatedText = candidate?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('') || '';
            if (!translatedText) {
                throw new Error('Gemini retornou resposta vazia.');
            }

            let parsedTranslated;
            try {
                parsedTranslated = JSON.parse(translatedText);
            } catch {
                throw new Error('O provedor devolveu JSON inválido.');
            }
            if (!Array.isArray(parsedTranslated) || parsedTranslated.some(cue => !Number.isInteger(cue?.index) || typeof cue.text !== 'string')) {
                throw new Error('O provedor devolveu falas sem identificação ou texto válido.');
            }
            const byIndex = new Map(parsedTranslated.map(cue => [cue.index, cue]));
            if (parsedTranslated.length !== cuesBatch.length || byIndex.size !== cuesBatch.length) {
                throw new Error('O provedor devolveu um lote incompleto ou repetido.');
            }
            return cuesBatch.map(original => {
                const translated = byIndex.get(original.index);
                if (!translated?.text.trim()) {
                    throw new Error('O provedor omitiu o texto ou alterou a identificação de uma fala.');
                }
                return { ...original, text: translated.text.trim().replace(/\r?\n\s*\n/g, '\n') };
            });
        } catch (err) {
            if (retry < 2) {
                console.warn(`⚠️ [SubtitleTranslation] Tentativa ${retry + 1} falhou para lote (${err.message}). Retentando em 2s...`);
                await new Promise(r => setTimeout(r, 2000));
                return this.translateBatchWithGemini(cuesBatch, retry + 1);
            }
            throw err;
        }
    }

    /**
     * Traduz uma legenda SRT completa do Inglês (ou outro idioma) para Português do Brasil (PT-BR)
     * @param {string} srtContent Conteúdo original em formato SRT
     * @param {object} options Opções adicionais (título, progresso, etc.)
     * @returns {Promise<string>} Conteúdo SRT traduzido em PT-BR com timestamps 100% idênticos
     */
    async translateSrt(srtContent, options = {}) {
        if (!this.isAvailable()) {
            throw new Error('Serviço de tradução indisponível: GEMINI_API_KEY não configurada no .env.');
        }

        const originalCues = this.parseSrt(srtContent);
        if (originalCues.length === 0) {
            throw new Error('Nenhuma legenda válida identificada para tradução no arquivo SRT.');
        }

        const title = options.title || 'Mídia';
        console.log(`🤖 [SubtitleTranslation: "${title}"] Iniciando tradução inteligente via Gemini (${originalCues.length} falas)...`);

        const translatedCues = [];
        const totalBatches = Math.ceil(originalCues.length / this.maxBatchCues);

        for (let b = 0; b < totalBatches; b++) {
            const start = b * this.maxBatchCues;
            const end = Math.min(start + this.maxBatchCues, originalCues.length);
            const batch = originalCues.slice(start, end);

            console.log(`🔄 [SubtitleTranslation: "${title}"] Traduzindo lote ${b + 1}/${totalBatches} (falas ${start + 1} a ${end})...`);
            
            translatedCues.push(...await this.translateBatchWithGemini(batch));
            options.onBatch?.(b + 1, totalBatches);

            // Pequeno intervalo entre lotes para respeitar taxa de requisições da API
            if (b + 1 < totalBatches) {
                await new Promise(r => setTimeout(r, 600));
            }
        }

        const finalSrt = this.buildSrt(translatedCues);
        console.log(`✅ [SubtitleTranslation: "${title}"] Tradução concluída com sucesso! (${translatedCues.length} falas preservadas com timecodes exatos).`);
        return finalSrt;
    }

    /**
     * Traduz um arquivo SRT em disco e grava o resultado
     * @param {string} inputSrtPath Caminho do arquivo original (.srt)
     * @param {string} outputSrtPath Caminho de destino para a legenda traduzida (.srt)
     * @param {object} options Opções adicionais
     * @returns {Promise<string>} Caminho do arquivo gerado
     */
    async translateSrtFile(inputSrtPath, outputSrtPath, options = {}) {
        if (!fs.existsSync(inputSrtPath)) {
            throw new Error(`Arquivo de legenda não encontrado: ${inputSrtPath}`);
        }

        const srtContent = await fs.readFile(inputSrtPath, 'utf8');
        const translatedContent = await this.translateSrt(srtContent, options);

        await fs.ensureDir(path.dirname(outputSrtPath));
        await fs.writeFile(outputSrtPath, translatedContent, 'utf8');
        return outputSrtPath;
    }
}

module.exports = new SubtitleTranslationService();

