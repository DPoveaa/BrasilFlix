const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class SubtitleTranslationService {
    constructor() {
        this.modelName = 'gemini-1.5-flash';
        this.maxBatchCues = 60; // Lote seguro de 60 legendas por requisição
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

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelName}:generateContent?key=${apiKey}`;

        // Prepara o bloco SRT para envio
        const inputSrtBlock = cuesBatch.map(c => `${c.index}\n${c.timecode}\n${c.text}`).join('\n\n');

        const systemInstruction = 
`Você é um tradutor audiovisual profissional especializado em legendagem para Português do Brasil (PT-BR).
Sua missão é traduzir as falas das legendas a seguir mantendo fidelidade emocional, naturalidade do português falado no Brasil, gírias e coloquialismos adequados ao contexto.

REGRAS CRÍTICAS INVIOLÁVEIS:
1. MANTENHA EXATAMENTE a mesma numeração de índice e a MESMA linha de tempo (timecode "00:00:00,000 --> 00:00:00,000") inalterada.
2. Traduza APENAS o texto das falas.
3. Se houver marcações HTML (como <i>, </i>, <b>, </b>), preserve-as no lugar correto.
4. NUNCA resuma ou elimine legendas. Cada legenda de entrada deve ter sua correspondente exata de saída.
5. Retorne EXCLUSIVAMENTE o texto SRT puro traduzido. Não inclua blocos markdown (como \`\`\`srt), introduções ou notas.`;

        const requestBody = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: `${systemInstruction}\n\nLEGENDA A TRADUZIR:\n\n${inputSrtBlock}` }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.2, // Baixa temperatura para precisão e consistência
                maxOutputTokens: 8192
            }
        };

        try {
            const res = await axios.post(url, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 45000
            });

            const candidate = res.data?.candidates?.[0];
            const translatedText = candidate?.content?.parts?.[0]?.text || '';
            if (!translatedText) {
                throw new Error('Gemini retornou resposta vazia.');
            }

            // Remove eventuais wrappers de markdown caso o modelo tenha adicionado
            const cleanText = translatedText
                .replace(/^```(?:srt)?\s*/i, '')
                .replace(/```\s*$/i, '')
                .trim();

            const parsedTranslated = this.parseSrt(cleanText);

            // Valida correspondência de blocos
            if (parsedTranslated.length === cuesBatch.length) {
                // Sincroniza garantindo timecodes idênticos aos originais
                return cuesBatch.map((orig, i) => ({
                    index: orig.index,
                    timecode: orig.timecode,
                    text: parsedTranslated[i].text || orig.text
                }));
            }

            // Se a quantidade de cues diferir ligeiramente (ex: quebra de linha extra), tenta casar por timecode
            if (parsedTranslated.length > 0) {
                const mapByTime = new Map();
                for (const ptCue of parsedTranslated) {
                    if (ptCue.timecode) {
                        mapByTime.set(ptCue.timecode.trim(), ptCue.text);
                    }
                }
                const result = cuesBatch.map(orig => ({
                    index: orig.index,
                    timecode: orig.timecode,
                    text: mapByTime.get(orig.timecode.trim()) || orig.text
                }));
                return result;
            }

            throw new Error(`Quantidade de cues divergente (${parsedTranslated.length} vs esperado ${cuesBatch.length})`);
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
            
            try {
                const translatedBatch = await this.translateBatchWithGemini(batch);
                translatedCues.push(...translatedBatch);
            } catch (batchErr) {
                console.error(`❌ [SubtitleTranslation: "${title}"] Falha no lote ${b + 1}: ${batchErr.message}`);
                // Em caso de falha irreversível em um lote específico, mantém o texto original para não perder o timecode
                translatedCues.push(...batch);
            }

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

