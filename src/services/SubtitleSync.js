const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

class SubtitleSync {
    /**
     * Sincroniza um arquivo de legenda (.srt) diretamente contra a trilha de áudio do arquivo de vídeo.
     * Utiliza análise de atividade vocal (VAD) e correlação cruzada do ffsubsync para alinhar
     * perfeitamente o tempo da fala com o texto da legenda, eliminando atrasos, adiantamentos e variações de FPS.
     *
     * @param {string} videoPath Caminho absoluto ou relativo do vídeo
     * @param {string} srtInputPath Caminho do arquivo de legenda (.srt)
     * @param {string} srtOutputPath Caminho de saída para a legenda sincronizada
     * @returns {Promise<string>} Retorna o caminho da legenda sincronizada (ou a original se falhar)
     */
    async syncSubtitle(videoPath, srtInputPath, srtOutputPath) {
        if (!fs.existsSync(videoPath) || !fs.existsSync(srtInputPath)) {
            console.warn('⚠️ [SubtitleSync] Arquivo de vídeo ou legenda não encontrado para sincronização.');
            return srtInputPath;
        }

        console.log(`🎙️ [SubtitleSync] Sincronizando legenda com o áudio do vídeo via análise de voz...`);
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
    '--max-offset-seconds', '15',
    '--vad', 'subs_then_webrtc'
]
sys.exit(main())
            `.trim();

            const pythonExec = process.platform === 'win32' ? 'python' : (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
            const success = await new Promise((resolve) => {
                let isDone = false;
                const pyProc = spawn(pythonExec, ['-c', pythonCode, videoPath, srtInputPath, srtOutputPath]);

                const timeout = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        try { pyProc.kill('SIGKILL'); } catch (e) {}
                        console.warn('⚠️ [SubtitleSync] Timeout de 120s ao sincronizar legenda. Usando versão original.');
                        resolve(false);
                    }
                }, 120000);

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

            if (success) {
                console.log(`✅ [SubtitleSync] Legenda sincronizada 100% com o áudio em ${elapsedSec}s!`);
                return srtOutputPath;
            } else {
                console.warn(`⚠️ [SubtitleSync] Não foi possível refinar o sincronismo (${elapsedSec}s), mantendo legenda padrão.`);
                return srtInputPath;
            }
        } catch (error) {
            console.warn(`⚠️ [SubtitleSync] Falha no processo de sincronização: ${error.message}`);
            return srtInputPath;
        }
    }
}

module.exports = new SubtitleSync();
