const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');

class BetWatermarkDetectorService {
    constructor() {
        this.isTesseractAvailable = null;

        // Padrões estritos de casas de aposta e scammers (sem chance de falso positivo em filmes reais)
        this.betBrandsRegex = /\b(1x[._ -]?(?:bet|de|et)|xbet|mostbet|melbet|betboom|fonbet|linebet|winline|bet365|betano|blaze|vulkan|vavada|joycasino|pin-up|roobet|stake|esportesdasorte|vaidebet)\b/i;

        // Slogans e termos combinados de apostas frequentes em letreiros de introdução
        this.betSlogansRegex = /(?:encontre\s+1x|ganhe\s+(?:um\s+)?b[oô]nus|primeiro\s+dep[oó]sito|100%\s+no\s+seu\s+primeiro|c[oó]digo\s+promocional|promo\s*code|aposte\s+agora|apostas\s+esportivas)/i;
    }

    /**
     * Verifica se o Tesseract OCR está disponível no sistema
     */
    async checkTesseract() {
        if (this.isTesseractAvailable !== null) return this.isTesseractAvailable;

        return new Promise((resolve) => {
            exec('tesseract --version', { timeout: 3000 }, (err) => {
                this.isTesseractAvailable = !err;
                if (!this.isTesseractAvailable) {
                    console.warn('⚠️ [BetWatermarkDetector] Tesseract OCR não está disponível no sistema. Detecção de marcas visuais de apostas desativada.');
                }
                resolve(this.isTesseractAvailable);
            });
        });
    }

    /**
     * Extrai um frame de cena inteira (redimensionado para 1280px para OCR rápido e nítido)
     */
    async extractFullFrame(videoPath, timestampSec, outputPath) {
        return new Promise((resolve, reject) => {
            const args = [
                '-ss', timestampSec.toFixed(2),
                '-nostdin',
                '-i', videoPath,
                '-map', '0:v:0',
                '-vframes', '1',
                '-vf', 'scale=1280:-2',
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
                    reject(new Error(`Falha ao extrair frame no segundo ${timestampSec}: ${stderr.slice(-200)}`));
                }
            });

            proc.on('error', (err) => reject(err));
        });
    }

    /**
     * Executa OCR no frame usando Tesseract com PSM otimizado para texto esparso/sobreposto
     */
    async runOcr(imagePath, psm = '11') {
        return new Promise((resolve) => {
            const proc = spawn('tesseract', [imagePath, 'stdout', '-l', 'por+eng', '--psm', String(psm)], {
                timeout: 5000,
                stdio: ['ignore', 'pipe', 'pipe']
            });

            let stdout = '';

            proc.stdout.on('data', (d) => { stdout += d.toString(); });

            proc.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout.trim());
                } else {
                    resolve('');
                }
            });

            proc.on('error', () => resolve(''));
        });
    }

    /**
     * Analisa o texto extraído à procura de marcas ou slogans de apostas
     */
    checkTextForBet(text) {
        if (!text || text.length < 3) return null;

        // Normalização simples (remove quebras de linha excessivas e acentos)
        const cleanText = text.replace(/[\r\n]+/g, ' ');

        // 1. Marca de aposta direta (ex: 1XBET, 1XDE, MELBET, MOSTBET)
        const brandMatch = cleanText.match(this.betBrandsRegex);
        if (brandMatch) {
            return {
                matched: true,
                type: 'brand',
                keyword: brandMatch[0],
                snippet: cleanText.substring(Math.max(0, brandMatch.index - 20), Math.min(cleanText.length, brandMatch.index + brandMatch[0].length + 20))
            };
        }

        // 2. Slogan de aposta / bônus de boas-vindas
        const sloganMatch = cleanText.match(this.betSlogansRegex);
        if (sloganMatch) {
            return {
                matched: true,
                type: 'slogan',
                keyword: sloganMatch[0],
                snippet: cleanText.substring(Math.max(0, sloganMatch.index - 20), Math.min(cleanText.length, sloganMatch.index + sloganMatch[0].length + 20))
            };
        }

        return null;
    }

    /**
     * Executa a inspeção visual completa em múltiplos frames (início e miolo do vídeo)
     * Retorna { checked: boolean, detected: boolean, reason?: string, details?: string, hits: Array }
     */
    async detectBetWatermark(videoPath, durationSec) {
        const canRun = await this.checkTesseract();
        if (!canRun) {
            return {
                checked: false,
                detected: false,
                reason: 'Tesseract OCR indisponível'
            };
        }

        const duration = Math.max(10, parseFloat(durationSec) || 0);
        if (duration < 15) {
            return {
                checked: false,
                detected: false,
                reason: 'Duração muito curta para amostragem'
            };
        }

        // Monta os pontos estratégicos de amostragem:
        // 1. Segundo 6 a 8 (onde banners gigantes de patrocínio inicial são exibidos sobre logos de estúdio)
        // 2. Segundo 20 a 25 (segundo ponto inicial comum)
        // 3. Miolo do vídeo: 15%, 30%, 50%, 70%, 85% (onde a marca d'água flutuante se mexe)
        const sampleTimestamps = [];
        
        // Ponto de início (6s)
        if (duration > 15) sampleTimestamps.push(Math.min(7.0, duration * 0.1));
        // Ponto de início secundário (20s)
        if (duration > 40) sampleTimestamps.push(22.0);

        // Pontos proporcionais no restante da obra
        const ratios = [0.15, 0.30, 0.50, 0.70, 0.85];
        for (const r of ratios) {
            const ts = r * duration;
            if (!sampleTimestamps.some(existing => Math.abs(existing - ts) < 10)) {
                sampleTimestamps.push(ts);
            }
        }

        const tempDir = path.join(os.tmpdir(), `brasilflix_bet_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
        await fs.ensureDir(tempDir);

        const hits = [];

        try {
            for (let i = 0; i < sampleTimestamps.length; i++) {
                const ts = sampleTimestamps[i];
                const framePath = path.join(tempDir, `sample_bet_${i}.jpg`);

                try {
                    await this.extractFullFrame(videoPath, ts, framePath);

                    // Executa OCR com PSM 11 (texto esparso/marca d'água sobre imagem)
                    let ocrText = await this.runOcr(framePath, '11');
                    let match = this.checkTextForBet(ocrText);

                    // Se for frame do início (primeiros 30s) e não detectou com PSM 11, testa PSM 3 (texto em blocos/banner)
                    if (!match && ts <= 30) {
                        const ocrBlockText = await this.runOcr(framePath, '3');
                        match = this.checkTextForBet(ocrBlockText);
                        if (match) ocrText = ocrBlockText;
                    }

                    if (match) {
                        hits.push({
                            timeSec: Math.round(ts),
                            keyword: match.keyword,
                            type: match.type,
                            snippet: match.snippet
                        });
                        console.warn(`🚨 [BetWatermarkDetector] Marca d'água/banner de aposta detectado no segundo ${Math.round(ts)}: "${match.keyword}" (trecho: "${match.snippet}")`);

                        // Se encontrou no banner de abertura (<= 30s), já é 100% definitivo, não precisa checar mais frames
                        if (ts <= 30) {
                            break;
                        }
                    }
                } catch (frameErr) {
                    // Ignora falha de extração em frame pontual e continua
                } finally {
                    if (fs.existsSync(framePath)) {
                        await fs.remove(framePath).catch(() => {});
                    }
                }
            }
        } finally {
            await fs.remove(tempDir).catch(() => {});
        }

        const detected = hits.length > 0;
        const details = detected
            ? `Detectado ${hits.length} ocorrência(s) de marca de apostas: ${hits.map(h => `[${h.timeSec}s: "${h.keyword}"]`).join(', ')}`
            : 'Nenhuma marca de aposta visual detectada na imagem';

        return {
            checked: true,
            detected,
            hits,
            details
        };
    }
}

module.exports = new BetWatermarkDetectorService();
