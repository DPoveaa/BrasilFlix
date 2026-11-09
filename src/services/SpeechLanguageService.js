const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { spawn } = require('child_process');

class SpeechLanguageService {
    /**
     * Extrai uma amostra de áudio (25s em PCM 16kHz) de um offset específico e executa Language ID.
     */
    static async _sampleAtOffset(videoPath, audioIndex, seekSec, sampleDuration = 25) {
        const tempWav = path.join(os.tmpdir(), `spoken_lang_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.wav`);
        try {
            const extractSuccess = await new Promise((resolve) => {
                const args = [
                    '-nostdin',
                    '-y',
                    '-ss', `${seekSec}`,
                    '-i', videoPath,
                    '-map', `0:a:${audioIndex}`,
                    '-t', `${sampleDuration}`,
                    '-ar', '16000',
                    '-ac', '1',
                    '-c:a', 'pcm_s16le',
                    tempWav
                ];

                const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
                const timer = setTimeout(() => {
                    proc.kill('SIGKILL');
                    resolve(false);
                }, 15000);

                proc.on('close', code => {
                    clearTimeout(timer);
                    resolve(code === 0 && fs.existsSync(tempWav));
                });
                proc.on('error', () => {
                    clearTimeout(timer);
                    resolve(false);
                });
            });

            if (!extractSuccess) {
                return { error: 'Falha ao extrair amostra via FFmpeg' };
            }

            const pythonScript = path.resolve(__dirname, '../../scripts/detect_audio_language.py');
            if (!fs.existsSync(pythonScript)) {
                return { error: 'Script Python detect_audio_language.py não encontrado' };
            }

            return await new Promise((resolve) => {
                const pyProc = spawn('python3', [pythonScript, tempWav, 'tiny'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';

                const timer = setTimeout(() => {
                    pyProc.kill('SIGKILL');
                    resolve({ error: 'Timeout de 20s no Speech Language ID' });
                }, 20000);

                pyProc.stdout.on('data', d => { stdout += d.toString(); });
                pyProc.stderr.on('data', d => { stderr += d.toString(); });

                pyProc.on('close', code => {
                    clearTimeout(timer);
                    if (code === 0 && stdout.trim()) {
                        try {
                            const parsed = JSON.parse(stdout.trim());
                            resolve(parsed);
                        } catch (e) {
                            resolve({ error: `JSON inválido do Python: ${stdout}` });
                        }
                    } else {
                        resolve({ error: `Python exit ${code}: ${stderr || stdout}` });
                    }
                });

                pyProc.on('error', err => {
                    clearTimeout(timer);
                    resolve({ error: `Falha ao iniciar python3: ${err.message}` });
                });
            });
        } finally {
            if (fs.existsSync(tempWav)) {
                fs.remove(tempWav).catch(() => {});
            }
        }
    }

    /**
     * Extrai amostras de áudio e identifica o idioma real falado, com fallback multi-ponto
     * para evitar falsos positivos causados por silêncio, música de introdução ou pequenas interjeições.
     * 
     * @param {string} videoPath Caminho do arquivo de vídeo local
     * @param {number} audioIndex Índice da trilha de áudio (0:a:index)
     * @param {number} totalDurationSec Duração total do vídeo em segundos
     * @param {string} expectedLanguage Código esperado (ex: 'pt', 'en', 'ko', 'ja')
     * @returns {Promise<{ verified: boolean, detectedLanguage: string|null, probability: number, isMatch: boolean, sampleText: string, reason: string }>}
     */
    static async verifySpokenLanguage(videoPath, audioIndex = 0, totalDurationSec = 3600, expectedLanguage = 'pt') {
        if (!videoPath || !fs.existsSync(videoPath)) {
            return { verified: false, detectedLanguage: null, probability: 0, isMatch: false, sampleText: '', reason: 'Arquivo de vídeo não existe' };
        }

        const safeIndex = parseInt(audioIndex, 10) || 0;
        const dur = Math.max(60, Number(totalDurationSec) || 3600);
        const exp = (expectedLanguage || '').toLowerCase().trim();

        // Mapeamentos de equivalência
        const isPortuguese = (lang) => ['pt', 'pt-br', 'por'].includes(lang);
        const isEnglish = (lang) => ['en', 'eng'].includes(lang);
        const isSpanish = (lang) => ['es', 'spa'].includes(lang);
        const isJapanese = (lang) => ['ja', 'jpn', 'jp'].includes(lang);
        const isKorean = (lang) => ['ko', 'kor'].includes(lang);

        const checkMatch = (detected, expected) => {
            if (!expected || !detected) return false;
            if (isPortuguese(expected)) return isPortuguese(detected);
            if (isEnglish(expected)) return isEnglish(detected);
            if (isSpanish(expected)) return isSpanish(detected);
            if (isJapanese(expected)) return isJapanese(detected);
            if (isKorean(expected)) return isKorean(detected);
            return (detected === expected || detected.startsWith(expected) || expected.startsWith(detected));
        };

        // Amostras estratégicas: 15% (início após abertura), 35% (desenvolvimento do diálogo) e 55% (meio)
        const sampleOffsets = [
            Math.floor(Math.min(dur * 0.15, 1200)),
            Math.floor(Math.min(dur * 0.35, 2400)),
            Math.floor(Math.min(dur * 0.55, 3600))
        ];

        let bestResult = null;
        let lastResult = null;

        for (let i = 0; i < sampleOffsets.length; i++) {
            const seekSec = sampleOffsets[i];
            const pyResult = await this._sampleAtOffset(videoPath, safeIndex, seekSec, 25);

            if (!pyResult || pyResult.error) {
                continue;
            }

            const detected = (pyResult.language || '').toLowerCase().trim();
            const prob = parseFloat(pyResult.probability) || 0;
            const text = (pyResult.sample_text || '').trim();
            const words = text.split(/\s+/).filter(Boolean);
            const isSubstantive = text.length >= 12 && words.length >= 2;
            const isMatch = checkMatch(detected, exp);

            lastResult = { detected, prob, text, isMatch, isSubstantive };

            // Se bateu com o idioma esperado e tem alguma substância (ou alta confiança), aceita imediatamente!
            if (isMatch && (isSubstantive || prob >= 0.85)) {
                console.log(`🎙️ [SpeechLanguage OK] Idioma falado verificado: "${detected.toUpperCase()}" (Esperado: "${exp.toUpperCase()}", Confiança: ${(prob * 100).toFixed(1)}%)${text ? ` ("${text.substring(0, 60)}...")` : ''}`);
                return {
                    verified: true,
                    detectedLanguage: detected,
                    probability: prob,
                    isMatch: true,
                    sampleText: text,
                    reason: 'Idioma conferido com sucesso'
                };
            }

            // Se é substancial, salva como melhor candidato de divergência
            if (isSubstantive) {
                if (!bestResult || prob > bestResult.prob) {
                    bestResult = { detected, prob, text, isMatch };
                }
            }

            // Se não bateu mas o texto é curtíssimo (ex: "Okay." ou ruído), tenta o próximo offset antes de concluir divergência
            if (!isSubstantive && i < sampleOffsets.length - 1) {
                continue;
            }
        }

        // Se após testar os pontos não encontramos diálogo substancial
        if (!bestResult) {
            // Se houve algum resultado mesmo com pouca fala
            if (lastResult && lastResult.isMatch) {
                return {
                    verified: true,
                    detectedLanguage: lastResult.detected,
                    probability: lastResult.prob,
                    isMatch: true,
                    sampleText: lastResult.text,
                    reason: 'Idioma compatível verificado em amostra curta'
                };
            }
            // Pouco diálogo/música: não bloqueia nem aborta
            console.log(`🎙️ [SpeechLanguage Neutro] Diálogo insuficiente nas amostras para confirmar idioma. Mantendo tags do arquivo.`);
            return {
                verified: false,
                detectedLanguage: null,
                probability: 0,
                isMatch: true,
                sampleText: '',
                reason: 'Diálogo insuficiente nas amostras'
            };
        }

        // Se temos um resultado com fala substancial
        const sampleSnippet = bestResult.text ? ` ("${bestResult.text.substring(0, 60)}...")` : '';
        if (!bestResult.isMatch && bestResult.prob >= 0.70) {
            console.warn(`🚨 [SpeechLanguage DIVERGÊNCIA] Esperado: "${exp.toUpperCase()}", mas falado real é: "${bestResult.detected.toUpperCase()}" (Confiança: ${(bestResult.prob * 100).toFixed(1)}%)${sampleSnippet}`);
        } else {
            console.log(`🎙️ [SpeechLanguage OK] Idioma falado verificado: "${bestResult.detected.toUpperCase()}" (Esperado: "${exp.toUpperCase()}", Confiança: ${(bestResult.prob * 100).toFixed(1)}%)${sampleSnippet}`);
        }

        return {
            verified: true,
            detectedLanguage: bestResult.detected,
            probability: bestResult.prob,
            isMatch: bestResult.isMatch,
            sampleText: bestResult.text,
            reason: bestResult.isMatch ? 'Idioma conferido com sucesso' : `Divergência: falado é ${bestResult.detected.toUpperCase()}`
        };
    }
}

module.exports = SpeechLanguageService;
