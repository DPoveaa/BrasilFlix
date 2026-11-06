const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const { spawn } = require('child_process');

class SpeechLanguageService {
    /**
     * Extrai uma amostra de áudio (25s em PCM 16kHz) e identifica o idioma real falado.
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
        // Busca um ponto com diálogo ativo: 15% do filme (evita logos e introdução)
        // Se o filme tem 120min, pula para 18min. Se episódio tem 24min, pula para 3.6min.
        const seekSec = Math.floor(Math.min(dur * 0.15, 1200));
        const sampleDuration = 25; // 25 segundos é o sweet spot para Voice Activity Detection

        const tempWav = path.join(os.tmpdir(), `spoken_lang_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.wav`);

        try {
            // 1. Extração ultra-rápida do trecho de áudio via FFmpeg
            const extractSuccess = await new Promise((resolve) => {
                const args = [
                    '-nostdin',
                    '-y',
                    '-ss', `${seekSec}`,
                    '-i', videoPath,
                    '-map', `0:a:${safeIndex}`,
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
                return { verified: false, detectedLanguage: null, probability: 0, isMatch: true, sampleText: '', reason: 'Falha ao extrair amostra de áudio via FFmpeg' };
            }

            // 2. Chama o script Python helper para Language ID com faster-whisper
            const pythonScript = path.resolve(__dirname, '../../scripts/detect_audio_language.py');
            if (!fs.existsSync(pythonScript)) {
                return { verified: false, detectedLanguage: null, probability: 0, isMatch: true, sampleText: '', reason: 'Script Python de detecção não encontrado' };
            }

            const pyResult = await new Promise((resolve) => {
                // Tenta python3 do sistema
                const pyProc = spawn('python3', [pythonScript, tempWav, 'tiny'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let stdout = '';
                let stderr = '';

                const timer = setTimeout(() => {
                    pyProc.kill('SIGKILL');
                    resolve({ error: 'Timeout de 20s ao executar Speech Language ID' });
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

            if (pyResult.error) {
                console.warn(`⚠️ [SpeechLanguage] Detecção de idioma indisponível: ${pyResult.error}. Prosseguindo sem bloqueio.`);
                return { verified: false, detectedLanguage: null, probability: 0, isMatch: true, sampleText: '', reason: pyResult.error };
            }

            const detected = (pyResult.language || '').toLowerCase().trim();
            const prob = parseFloat(pyResult.probability) || 0;
            const exp = (expectedLanguage || '').toLowerCase().trim();

            // Mapeamentos de equivalência (ex: pt / pt-br)
            const isPortuguese = (lang) => ['pt', 'pt-br', 'por'].includes(lang);
            const isEnglish = (lang) => ['en', 'eng'].includes(lang);
            const isSpanish = (lang) => ['es', 'spa'].includes(lang);

            let isMatch = true;
            if (exp) {
                if (isPortuguese(exp)) {
                    isMatch = isPortuguese(detected);
                } else if (isEnglish(exp)) {
                    isMatch = isEnglish(detected);
                } else {
                    isMatch = (detected === exp || detected.startsWith(exp) || exp.startsWith(detected));
                }
            }

            const sampleSnippet = pyResult.sample_text ? ` ("${pyResult.sample_text.substring(0, 60)}...")` : '';
            if (!isMatch && prob >= 0.65) {
                console.warn(`🚨 [SpeechLanguage DIVERGÊNCIA] Esperado: "${exp.toUpperCase()}", mas falado real é: "${detected.toUpperCase()}" (Confiança: ${(prob * 100).toFixed(1)}%)${sampleSnippet}`);
            } else {
                console.log(`🎙️ [SpeechLanguage OK] Idioma falado verificado: "${detected.toUpperCase()}" (Esperado: "${exp.toUpperCase()}", Confiança: ${(prob * 100).toFixed(1)}%)${sampleSnippet}`);
            }

            return {
                verified: true,
                detectedLanguage: detected,
                probability: prob,
                isMatch: isMatch,
                sampleText: pyResult.sample_text || '',
                reason: isMatch ? 'Idioma conferido com sucesso' : `Divergência: falado é ${detected.toUpperCase()}`
            };

        } catch (err) {
            console.warn(`⚠️ [SpeechLanguage] Erro inesperado: ${err.message}`);
            return { verified: false, detectedLanguage: null, probability: 0, isMatch: true, sampleText: '', reason: err.message };
        } finally {
            if (fs.existsSync(tempWav)) {
                fs.remove(tempWav).catch(() => {});
            }
        }
    }
}

module.exports = SpeechLanguageService;
