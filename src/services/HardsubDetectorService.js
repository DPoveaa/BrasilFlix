const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

class HardsubDetectorService {
    constructor() {
        this.tesseractPath = 'tesseract';
        this.isTesseractAvailable = null;
    }

    /**
     * Verifica se o binário tesseract está instalado e acessível no sistema
     */
    async checkTesseract() {
        if (this.isTesseractAvailable !== null) return this.isTesseractAvailable;

        return new Promise((resolve) => {
            exec('tesseract --version', { timeout: 3000 }, (err) => {
                this.isTesseractAvailable = !err;
                if (!this.isTesseractAvailable) {
                    console.warn('⚠️ [HardsubDetector] Tesseract OCR não está disponível no sistema. Detecção de hardsub desativada.');
                }
                resolve(this.isTesseractAvailable);
            });
        });
    }

    /**
     * Extrai um frame cortado na região inferior (bottom 22%) onde legendas costumam ficar
     */
    async extractBottomCrop(videoPath, timestampSec, outputPath) {
        return new Promise((resolve, reject) => {
            // -ss antes de -i para busca rápida (fast seek)
            // -map 0:v:0 garante que pegamos apenas os pixels do vídeo bruto (ignora softsubs)
            // crop bottom 22%: crop=in_w:in_h*0.22:0:in_h*0.78
            // scale=1280:-2 padroniza a resolução para OCR nítido e rápido
            const args = [
                '-ss', timestampSec.toFixed(2),
                '-nostdin',
                '-i', videoPath,
                '-map', '0:v:0',
                '-vframes', '1',
                '-vf', 'crop=in_w:in_h*0.22:0:in_h*0.78,scale=1280:-2',
                '-q:v', '2',
                '-y',
                outputPath
            ];

            const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';

            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            proc.on('close', (code) => {
                if (code === 0 && fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    reject(new Error(`Falha ao extrair crop no segundo ${timestampSec}: ${stderr.slice(-200)}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }

    /**
     * Executa OCR no frame recortado usando Tesseract
     */
    async runOcr(imagePath) {
        return new Promise((resolve) => {
            // Suporta português, inglês, russo, chinês e coreano
            // Usa segmentação de página padrão (sem forçar bloco de texto psm 6 para não alucinar em granulação/letterbox)
            const proc = spawn('tesseract', [imagePath, 'stdout', '-l', 'por+eng+rus+chi_sim+kor', '--psm', '3'], {
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    // Fallback se faltar algum pacote de idioma no tesseract local
                    this.runOcrFallback(imagePath).then(resolve);
                }
            });

            proc.on('error', () => {
                resolve('');
            });
        });
    }

    async runOcrFallback(imagePath) {
        return new Promise((resolve) => {
            const proc = spawn('tesseract', [imagePath, 'stdout', '-l', 'eng+por', '--psm', '3'], {
                timeout: 4000,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.on('close', () => resolve(stdout.trim()));
            proc.on('error', () => resolve(''));
        });
    }

    /**
     * Analisa o texto extraído pelo OCR e classifica tipo de caracteres
     */
    analyzeText(text) {
        if (!text || text.length < 5) {
            return { hasText: false, cyrillicCount: 0, asianCount: 0, latinCount: 0, text: '' };
        }

        const cleanText = text.replace(/[\r\n]+/g, ' ').trim();

        // 1. Rejeição de ruído de símbolos/pontuação aleatória típica de falsos positivos do OCR (ex: |, ~, », `, =, >, @, —, etc.)
        const symbolsOnly = cleanText.replace(/[\p{L}\p{N}\s]/gu, '');
        const nonSpaceCount = cleanText.replace(/\s/g, '').length;
        if (nonSpaceCount > 0 && (symbolsOnly.length / nonSpaceCount) > 0.20) {
            return { hasText: false, cyrillicCount: 0, asianCount: 0, latinCount: 0, text: cleanText };
        }

        // 2. Extrai palavras reais com pelo menos 3 letras
        const realWords = cleanText.split(/\s+/).map(w => w.replace(/[^\p{L}]/gu, '')).filter(w => w.length >= 3);

        const cyrillicMatches = cleanText.match(/[\u0400-\u04FF]/g) || [];
        const asianMatches = cleanText.match(/[\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || [];
        const latinMatches = cleanText.match(/[A-Za-zÀ-ÿ]/g) || [];

        // Legenda cirílica real: pelo menos 6 caracteres cirílicos e pelo menos 2 palavras de 3+ letras
        const isCyrillicReal = cyrillicMatches.length >= 6 && realWords.filter(w => /[\u0400-\u04FF]/.test(w)).length >= 2;

        // Legenda asiática real: pelo menos 4 caracteres ideográficos CJK
        const isAsianReal = asianMatches.length >= 4;

        // Legenda latina real: pelo menos 14 letras latinas E pelo menos 3 palavras reais com 3+ letras
        const latinWords = realWords.filter(w => /^[A-Za-zÀ-ÿ]+$/.test(w));
        const isLatinReal = latinMatches.length >= 14 && latinWords.length >= 3;

        const hasText = isCyrillicReal || isAsianReal || isLatinReal;

        return {
            hasText,
            cyrillicCount: isCyrillicReal ? cyrillicMatches.length : 0,
            asianCount: isAsianReal ? asianMatches.length : 0,
            latinCount: isLatinReal ? latinMatches.length : 0,
            wordCount: realWords.length,
            text: cleanText
        };
    }

    /**
     * Executa amostragem em múltiplos pontos do vídeo para detectar presença de hardsub fixo na imagem.
     * Retorna:
     * {
     *   hasHardsub: boolean,
     *   isForeignHardsub: boolean,
     *   cyrillicHits: number,
     *   asianHits: number,
     *   latinHits: number,
     *   samples: Array<{ timeSec, text, script }>,
     *   details: string
     * }
     */
    async detectHardsub(videoPath, durationSec, options = {}) {
        const canRun = await this.checkTesseract();
        if (!canRun) {
            return {
                checked: false,
                hasHardsub: false,
                isForeignHardsub: false,
                reason: 'Tesseract OCR indisponível'
            };
        }

        const duration = Math.max(10, parseFloat(durationSec) || 0);
        if (duration < 20) {
            return {
                checked: false,
                hasHardsub: false,
                isForeignHardsub: false,
                reason: 'Duração muito curta para amostragem multiponto'
            };
        }

        // 5 pontos estratégicos espaçados no miolo do filme/episódio (evita intro e créditos finais)
        // [20%, 35%, 50%, 65%, 80%]
        const ratios = [0.20, 0.35, 0.50, 0.65, 0.80];
        const sampleTimestamps = ratios.map(r => r * duration);

        const tempDir = path.join(os.tmpdir(), `brasilflix_ocr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
        await fs.ensureDir(tempDir);

        const results = [];
        let cyrillicHits = 0;
        let asianHits = 0;
        let latinHits = 0;

        try {
            for (let i = 0; i < sampleTimestamps.length; i++) {
                const ts = sampleTimestamps[i];
                const framePath = path.join(tempDir, `sample_${i}.jpg`);

                try {
                    await this.extractBottomCrop(videoPath, ts, framePath);
                    const rawOcr = await this.runOcr(framePath);
                    const analysis = this.analyzeText(rawOcr);

                    let script = 'none';
                    if (analysis.cyrillicCount >= 3) {
                        script = 'cyrillic';
                        cyrillicHits++;
                    } else if (analysis.asianCount >= 2) {
                        script = 'asian';
                        asianHits++;
                    } else if (analysis.latinCount >= 8 && analysis.wordCount >= 2) {
                        script = 'latin';
                        latinHits++;
                    }

                    results.push({
                        timeSec: Math.round(ts),
                        ratio: ratios[i],
                        hasText: analysis.hasText,
                        script,
                        text: analysis.text.slice(0, 80)
                    });
                } catch (frameErr) {
                    // Ignora falha de extração em frame específico
                } finally {
                    if (fs.existsSync(framePath)) {
                        await fs.remove(framePath).catch(() => {});
                    }
                }
            }
        } finally {
            await fs.remove(tempDir).catch(() => {});
        }

        // Regras de decisão:
        // 1. Hardsub Estrangeiro Crítico: Russo/Cirílico em >= 2 frames OU Asiático em >= 2 frames
        const isForeignHardsub = cyrillicHits >= 2 || asianHits >= 2;

        // 2. Hardsub Geral Persistente: Texto latino em >= 3 dos 5 frames (indica legenda embutida)
        const isLatinHardsub = latinHits >= 3;

        const hasHardsub = isForeignHardsub || isLatinHardsub;

        let detectedScript = 'none';
        if (cyrillicHits >= 2) detectedScript = 'cirílico (russo/eslavo)';
        else if (asianHits >= 2) detectedScript = 'asiático (chinês/coreano/japonês)';
        else if (isLatinHardsub) detectedScript = 'latino (inglês/espanhol/outros)';

        const textSamples = results
            .filter(r => r.script !== 'none')
            .map(r => `[${r.timeSec}s]: "${r.text}"`)
            .join(' | ');

        return {
            checked: true,
            hasHardsub,
            isForeignHardsub,
            isLatinHardsub,
            detectedScript,
            cyrillicHits,
            asianHits,
            latinHits,
            totalSampled: results.length,
            samples: results,
            textSamples,
            details: hasHardsub
                ? `Hardsub detectado (${detectedScript}): ${textSamples || 'sem amostra'}`
                : 'Nenhum hardsub persistente detectado na imagem'
        };
    }
}

module.exports = new HardsubDetectorService();

