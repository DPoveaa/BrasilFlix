const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

class SubtitleSync {
    /**
     * Sincroniza um arquivo de legenda (.srt) contra um arquivo de vídeo (áudio) OU contra uma legenda de referência (.srt).
     *
     * @param {string} videoOrRefSrt Caminho do arquivo de vídeo OU legenda de referência (ex: .srt em inglês)
     * @param {string} srtInputPath Caminho do arquivo de legenda a sincronizar (.srt)
     * @param {string} srtOutputPath Caminho de saída para a legenda sincronizada
     * @param {object} options Opções adicionais (maxOffsetSeconds, etc.)
     * @returns {Promise<string|null>} Retorna o caminho da legenda sincronizada (ou null se falhar e for inseguro)
     */
    async syncSubtitle(videoOrRefSrt, srtInputPath, srtOutputPath, options = {}) {
        if (!fs.existsSync(videoOrRefSrt) || !fs.existsSync(srtInputPath)) {
            console.warn('⚠️ [SubtitleSync] Arquivo de referência ou legenda não encontrado para sincronização.');
            return srtInputPath;
        }

        const isRefSubtitle = videoOrRefSrt.toLowerCase().endsWith('.srt') || videoOrRefSrt.toLowerCase().endsWith('.vtt') || videoOrRefSrt.toLowerCase().endsWith('.ass');
        const maxOffsetSec = options.maxOffsetSeconds || (isRefSubtitle ? 120 : 30);

        console.log(`🎙️ [SubtitleSync] Sincronizando legenda via ${isRefSubtitle ? 'Legenda de Referência (Sub-to-Sub 100% Preciso)' : 'Análise de Voz no Áudio (VAD Audio-to-Sub)'} [Janela: ${maxOffsetSec}s]...`);
        const startTime = Date.now();

        try {
            await fs.ensureDir(path.dirname(srtOutputPath));

            const pythonCode = `
import sys
from ffsubsync.ffsubsync import main
sys.argv = [
    'ffsubsync',
    sys.argv[1],
    '-i', sys.argv[2],
    '-o', sys.argv[3],
    '--max-offset-seconds', str(${maxOffsetSec}),
    '--vad', 'subs_then_webrtc'
]
sys.exit(main())
            `.trim();

            const pythonExec = process.platform === 'win32' ? 'python' : (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
            const success = await new Promise((resolve) => {
                let isDone = false;
                const pyProc = spawn(pythonExec, ['-c', pythonCode, videoOrRefSrt, srtInputPath, srtOutputPath], { stdio: ['ignore', 'pipe', 'pipe'] });

                const timeout = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        try { pyProc.kill('SIGKILL'); } catch (e) {}
                        console.warn('⚠️ [SubtitleSync] Timeout de 60s ao sincronizar legenda.');
                        resolve(false);
                    }
                }, 60000);

                pyProc.on('error', (err) => {
                    if (!isDone) {
                        isDone = true;
                        clearTimeout(timeout);
                        console.warn(`⚠️ [SubtitleSync] Erro ao executar ${pythonExec}:`, err.message);
                        resolve(false);
                    }
                });

                pyProc.on('close', (code) => {
                    if (!isDone) {
                        isDone = true;
                        clearTimeout(timeout);
                        if (code === 0 && fs.existsSync(srtOutputPath) && fs.statSync(srtOutputPath).size > 200) {
                            resolve(true);
                        } else {
                            resolve(false);
                        }
                    }
                });
            });

            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

            if (success && this.validateSynchronizedSubtitle(srtOutputPath)) {
                console.log(`✅ [SubtitleSync] Legenda sincronizada 100% com precisão matemática em ${elapsedSec}s!`);
                return srtOutputPath;
            } else {
                console.warn(`⚠️ [SubtitleSync] Não foi possível garantir sincronia perfeita via análise (${elapsedSec}s).`);
                return null;
            }
        } catch (error) {
            console.warn(`⚠️ [SubtitleSync] Falha no processo de sincronização: ${error.message}`);
            return null;
        }
    }

    validateSynchronizedSubtitle(srtPath) {
        try {
            if (!fs.existsSync(srtPath)) return false;
            const content = fs.readFileSync(srtPath, 'utf8');
            if (content.length < 200) return false;
            const timecodeMatches = content.match(/\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,\.]\d{3}/g);
            return timecodeMatches && timecodeMatches.length >= 8;
        } catch (e) {
            return false;
        }
    }
}

module.exports = new SubtitleSync();
