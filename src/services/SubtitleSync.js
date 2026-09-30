const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

class SubtitleSync {
    /**
     * Converte timecode SRT (00:01:23,456 ou 00:01:23.456) para milissegundos
     */
    parseTimecodeToMs(tc) {
        if (!tc) return 0;
        const parts = tc.trim().replace('.', ',').split(/[:,]/);
        if (parts.length < 4) return 0;
        const h = parseInt(parts[0], 10) || 0;
        const m = parseInt(parts[1], 10) || 0;
        const s = parseInt(parts[2], 10) || 0;
        const ms = parseInt(parts[3], 10) || 0;
        return (h * 3600 + m * 60 + s) * 1000 + ms;
    }

    /**
     * Converte milissegundos para timecode SRT padronizado (00:01:23,456)
     */
    formatMsToTimecode(totalMs) {
        if (totalMs < 0) totalMs = 0;
        const ms = Math.floor(totalMs % 1000);
        const totalSeconds = Math.floor(totalMs / 1000);
        const s = totalSeconds % 60;
        const totalMinutes = Math.floor(totalSeconds / 60);
        const m = totalMinutes % 60;
        const h = Math.floor(totalMinutes / 60);

        const pad = (n, z = 2) => String(n).padStart(z, '0');
        return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
    }

    /**
     * Ajusta o ritmo e tempo de exibição das legendas (CPS e Duração Mínima)
     * Garante que legendas rápidas não desapareçam em 0.5s/1s, mantendo tempo
     * confortável de leitura (mínimo de 1.8s a 2.0s por fala) sem sobrepor o próximo diálogo.
     */
    adjustSubtitleTimingAndReadability(srtContent) {
        if (!srtContent || typeof srtContent !== 'string') return srtContent;

        const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const rawBlocks = normalized.split(/\n\s*\n/);
        const cues = [];

        const tcRegex = /(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})/;

        for (const block of rawBlocks) {
            const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
            if (lines.length < 2) continue;

            let tcIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (tcRegex.test(lines[i])) {
                    tcIndex = i;
                    break;
                }
            }

            if (tcIndex === -1) continue;

            const match = lines[tcIndex].match(tcRegex);
            const startMs = this.parseTimecodeToMs(match[1]);
            const endMs = this.parseTimecodeToMs(match[2]);
            const textLines = lines.slice(tcIndex + 1);
            const text = textLines.join('\n');

            if (endMs > startMs && text.length > 0) {
                cues.push({
                    startMs,
                    endMs,
                    text
                });
            }
        }

        if (cues.length === 0) return srtContent;

        // Ordena cronologicamente
        cues.sort((a, b) => a.startMs - b.startMs);

        const GAP_MS = 80; // Espaço limpo mínimo entre legendas consecutivas

        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            const nextCue = cues[i + 1] || null;

            // Remove tags HTML/formatação para contagem real de caracteres
            const cleanText = cue.text.replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
            const charCount = cleanText.length;

            // Cálculo do tempo ideal de leitura:
            // Base mínima de 1800ms (1.8s) + ~65ms por caractere (velocidade confortável de 15.4 CPS)
            const idealDurationMs = Math.min(7000, Math.max(1800, charCount * 65 + 300));
            const targetEndMs = cue.startMs + idealDurationMs;

            let finalEndMs = Math.max(cue.endMs, targetEndMs);

            if (nextCue) {
                const maxAllowedEndMs = nextCue.startMs - GAP_MS;
                if (maxAllowedEndMs > cue.startMs + 500) {
                    finalEndMs = Math.min(finalEndMs, maxAllowedEndMs);
                } else if (nextCue.startMs > cue.startMs) {
                    finalEndMs = Math.min(cue.endMs, nextCue.startMs - 20);
                }
            }

            cue.endMs = Math.max(cue.startMs + 500, finalEndMs);
        }

        // Reconstrói o arquivo SRT padronizado
        const outputBlocks = cues.map((cue, idx) => {
            const num = idx + 1;
            const startTc = this.formatMsToTimecode(cue.startMs);
            const endTc = this.formatMsToTimecode(cue.endMs);
            return `${num}\n${startTc} --> ${endTc}\n${cue.text}`;
        });

        return outputBlocks.join('\n\n') + '\n';
    }

    /**
     * Aplica otimização de legibilidade e tempo de leitura diretamente em um arquivo .srt
     */
    async optimizeSubtitleFile(srtPath) {
        try {
            if (!fs.existsSync(srtPath)) return srtPath;
            const content = await fs.readFile(srtPath, 'utf8');
            const optimized = this.adjustSubtitleTimingAndReadability(content);
            if (optimized && optimized.length > 100) {
                await fs.writeFile(srtPath, optimized, 'utf8');
            }
            return srtPath;
        } catch (e) {
            console.warn(`⚠️ [SubtitleSync] Falha ao otimizar tempo de leitura do SRT "${path.basename(srtPath)}":`, e.message);
            return srtPath;
        }
    }

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
        const isAnime = options.isAnime === true;

        // Janela dinâmica e segura de sincronização:
        // - Sub-to-Sub (Legenda de Referência): 180s (alinhamento em memória super rápido, absorve vinhetas longas da Fox, FX, HBO, etc.)
        // - Audio-to-Sub (VAD): 120s para séries/filmes (absorve vinhetas de canais e emissoras) e 35s para animes (evita falsos picos com J-pop)
        const defaultOffsetSec = isRefSubtitle ? 180 : (isAnime ? 35 : 120);
        const maxOffsetSec = options.maxOffsetSeconds || defaultOffsetSec;

        console.log(`🎙️ [SubtitleSync] Sincronizando legenda via ${isRefSubtitle ? 'Legenda de Referência (Sub-to-Sub 100% Preciso)' : 'Análise de Voz no Áudio (VAD Audio-to-Sub)'} [Janela: ${maxOffsetSec}s, Anime: ${isAnime ? 'SIM' : 'NÃO'}]...`);
        const startTime = Date.now();

        try {
            await fs.ensureDir(path.dirname(srtOutputPath));

            // Permite correção de framerate (23.976 vs 25 fps PAL) por padrão, exceto se expressamente desabilitado
            const fixFramerateArg = options.noFixFramerate ? ["'--no-fix-framerate',"] : [];

            const pythonCode = `
import sys
from ffsubsync.ffsubsync import main
sys.argv = [
    'ffsubsync',
    sys.argv[1],
    '-i', sys.argv[2],
    '-o', sys.argv[3],
    '--max-offset-seconds', str(${maxOffsetSec}),
    ${fixFramerateArg.join('\n    ')}
    '--vad', 'subs_then_webrtc'
]
sys.exit(main())
            `.trim();

            const pythonExec = process.platform === 'win32' ? 'python' : (fs.existsSync('/usr/bin/python3') ? '/usr/bin/python3' : 'python3');
            const timeoutMs = options.timeoutMs || 180000; // 3 minutos para permitir análise completa de voz sem corte prematuro

            const success = await new Promise((resolve) => {
                let isDone = false;
                const pyProc = spawn(pythonExec, ['-c', pythonCode, videoOrRefSrt, srtInputPath, srtOutputPath], { stdio: ['ignore', 'pipe', 'pipe'] });

                const timeout = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        try { pyProc.kill('SIGKILL'); } catch (e) {}
                        console.warn(`⚠️ [SubtitleSync] Timeout de ${(timeoutMs/1000)}s ao sincronizar legenda.`);
                        resolve(false);
                    }
                }, timeoutMs);

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
                // Aplica otimização de tempo de leitura na legenda sincronizada
                await this.optimizeSubtitleFile(srtOutputPath);
                console.log(`✅ [SubtitleSync] Legenda sincronizada e otimizada para leitura confortável em ${elapsedSec}s!`);
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
