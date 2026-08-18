const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class DiskCleaner {
    constructor() {
        this.downloadDir = config.DOWNLOAD_DIR;
        this.tempDir = config.TEMP_DIR;
        this.minAgeMs = 30 * 60 * 1000; // 30 minutos de inatividade mínima para considerar arquivo órfão
        this.isRunning = false;
    }

    /**
     * Formata bytes para string legível
     */
    formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * Obtém informações de espaço livre e total do disco
     */
    async getDiskSpaceInfo(dirPath = this.downloadDir) {
        try {
            const checkvfs = async () => {
                if (process.platform === 'linux' || process.platform === 'darwin') {
                    const { execSync } = require('child_process');
                    const out = execSync(`df -k "${dirPath}" | tail -1`, { encoding: 'utf-8' });
                    const parts = out.trim().split(/\s+/);
                    if (parts.length >= 4) {
                        const totalKb = parseInt(parts[1], 10);
                        const usedKb = parseInt(parts[2], 10);
                        const freeKb = parseInt(parts[3], 10);
                        return {
                            totalBytes: totalKb * 1024,
                            usedBytes: usedKb * 1024,
                            freeBytes: freeKb * 1024,
                            freeGB: (freeKb / (1024 * 1024)).toFixed(1),
                            totalGB: (totalKb / (1024 * 1024)).toFixed(1),
                            usedGB: (usedKb / (1024 * 1024)).toFixed(1),
                            usedPercent: Math.round((usedKb / totalKb) * 100)
                        };
                    }
                }
                return null;
            };

            const info = await checkvfs();
            return info;
        } catch (e) {
            return null;
        }
    }

    /**
     * Executa varredura profunda e remoção de arquivos órfãos
     * @param {Array<string>} activeFilePaths - Caminhos de arquivos atualmente em uso/download/processamento
     */
    async scanAndClean(activeFilePaths = []) {
        if (this.isRunning) return { cleanedCount: 0, freedBytes: 0 };
        this.isRunning = true;

        const normalizedActive = (activeFilePaths || [])
            .filter(Boolean)
            .map(p => path.resolve(p).toLowerCase());

        let totalFreedBytes = 0;
        let totalCleanedCount = 0;
        const now = Date.now();

        const cleanFolder = async (folderPath) => {
            if (!fs.existsSync(folderPath)) return;

            let entries = [];
            try {
                entries = await fs.readdir(folderPath);
            } catch (e) {
                return;
            }

            for (const entry of entries) {
                const fullPath = path.join(folderPath, entry);
                const resolved = path.resolve(fullPath).toLowerCase();

                // Ignora se estiver na lista de arquivos ativos
                const isActive = normalizedActive.some(act => resolved.startsWith(act) || act.startsWith(resolved));
                if (isActive) continue;

                try {
                    const stat = await fs.stat(fullPath);
                    const ageMs = now - stat.mtimeMs;

                    if (stat.isDirectory()) {
                        // Varre subdiretório recursivamente
                        await cleanFolder(fullPath);
                        // Se a pasta ficou vazia e tem mais de 30 min, remove a pasta
                        const subEntries = await fs.readdir(fullPath);
                        if (subEntries.length === 0 && ageMs >= this.minAgeMs) {
                            await fs.remove(fullPath);
                            console.log(`🧹 [Auto-Cleaner] Pasta residual vazia removida: "${entry}"`);
                        }
                    } else if (stat.isFile()) {
                        // Se o arquivo tiver mais de 30 min sem modificação e não for ativo
                        if (ageMs >= this.minAgeMs) {
                            const fileSize = stat.size;
                            await fs.unlink(fullPath);
                            totalFreedBytes += fileSize;
                            totalCleanedCount++;
                            console.log(`🧹 [Auto-Cleaner] Arquivo órfão removido: "${entry}" (${this.formatBytes(fileSize)})`);
                        }
                    }
                } catch (errFile) {
                    // Arquivo bloqueado ou já removido por outro processo
                }
            }
        };

        try {
            await cleanFolder(this.downloadDir);
            await cleanFolder(this.tempDir);

            if (totalCleanedCount > 0) {
                console.log(`✨ [Auto-Cleaner] Limpeza concluída! ${totalCleanedCount} arquivo(s) residual(is) removido(s). Total liberado em disco: ${this.formatBytes(totalFreedBytes)}`);
            }

            // Checa saúde geral do disco
            const space = await this.getDiskSpaceInfo();
            if (space) {
                if (parseFloat(space.freeGB) < 15) {
                    console.warn(`⚠️ [ALERTA DE DISCO] Espaço livre crítico no servidor: ${space.freeGB} GB restantes (${space.usedPercent}% em uso)!`);
                }
            }
        } catch (err) {
            console.warn('⚠️ [Auto-Cleaner] Aviso durante limpeza:', err.message);
        } finally {
            this.isRunning = false;
        }

        return { cleanedCount: totalCleanedCount, freedBytes: totalFreedBytes };
    }

    /**
     * Inicia monitoramento periódico de limpeza em background
     * @param {Function} getActiveFilesCallback - Função que retorna array de arquivos ativos da fila
     * @param {number} intervalMs - Intervalo entre checagens (padrão: 45 min)
     */
    startAutoCleanup(getActiveFilesCallback, intervalMs = 45 * 60 * 1000) {
        console.log(`🧹 [Auto-Cleaner] Monitor de limpeza inteligente de disco ativado (Intervalo: ${Math.round(intervalMs / 60000)} min)!`);
        
        // Executa limpeza inicial após 15 segundos do boot
        setTimeout(() => {
            const active = getActiveFilesCallback ? getActiveFilesCallback() : [];
            this.scanAndClean(active).catch(() => {});
        }, 15000);

        setInterval(() => {
            const active = getActiveFilesCallback ? getActiveFilesCallback() : [];
            this.scanAndClean(active).catch(() => {});
        }, intervalMs);
    }
}

module.exports = new DiskCleaner();
