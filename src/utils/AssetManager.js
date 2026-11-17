const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class AssetManager {
    static getAssetsDir() {
        return path.resolve(__dirname, '../../public/assets');
    }

    static getIndexHtmlPath() {
        return path.resolve(__dirname, '../../public/index.html');
    }

    static computeContentHash(contentOrBuffer) {
        return crypto.createHash('sha256')
            .update(contentOrBuffer)
            .digest('hex')
            .slice(0, 10);
    }

    /**
     * Sincroniza os arquivos de assets:
     * 1. Calcula os hashes SHA-256 reais (10 primeiros chars).
     * 2. Renomeia os arquivos para prefix.<hash>.ext se necessário.
     * 3. Remove arquivos antigos/residuais de hashes anteriores.
     * 4. Atualiza public/index.html em disco.
     * 5. Retorna o mapa de assets resolvidos.
     */
    static syncAssets() {
        const assetsDir = this.getAssetsDir();
        if (!fs.existsSync(assetsDir)) {
            console.warn(`⚠️ [AssetManager] Diretório de assets não encontrado: ${assetsDir}`);
            return null;
        }

        const allFiles = fs.readdirSync(assetsDir);

        const configs = [
            {
                key: 'playerJs',
                prefix: 'brasilflix-player',
                ext: '.js',
                filter: f => f.startsWith('brasilflix-player') && f.endsWith('.js'),
                buildName: hash => `brasilflix-player.${hash}.js`
            },
            {
                key: 'mainJs',
                prefix: 'brasilflix',
                ext: '.js',
                filter: f => f.startsWith('brasilflix.') && f.endsWith('.js') && !f.startsWith('brasilflix-player'),
                buildName: hash => `brasilflix.${hash}.js`
            },
            {
                key: 'css',
                prefix: 'brasilflix',
                ext: '.css',
                filter: f => f.startsWith('brasilflix') && f.endsWith('.css'),
                buildName: hash => `brasilflix.${hash}.css`
            }
        ];

        const resolved = {};

        for (const cfg of configs) {
            const matches = allFiles
                .filter(cfg.filter)
                .map(filename => {
                    const fullPath = path.join(assetsDir, filename);
                    const stat = fs.statSync(fullPath);
                    return { filename, fullPath, mtimeMs: stat.mtimeMs };
                })
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

            if (matches.length === 0) {
                console.warn(`⚠️ [AssetManager] Nenhum arquivo encontrado para ${cfg.key}`);
                continue;
            }

            // O arquivo primário é o mais recentemente modificado
            const primary = matches[0];
            const content = fs.readFileSync(primary.fullPath);
            const hash = this.computeContentHash(content);
            const expectedName = cfg.buildName(hash);
            const targetPath = path.join(assetsDir, expectedName);

            if (primary.filename !== expectedName) {
                if (fs.existsSync(targetPath)) {
                    // Se o target já existe, remove o arquivo primário antigo se for diferente
                    try { fs.unlinkSync(primary.fullPath); } catch (e) {}
                } else {
                    fs.renameSync(primary.fullPath, targetPath);
                }
                console.log(`📦 [AssetManager] ${primary.filename} -> ${expectedName}`);
            }

            // Remove quaisquer arquivos residuais do mesmo tipo com hashes antigos
            for (let i = 1; i < matches.length; i++) {
                const stale = matches[i];
                if (stale.filename !== expectedName && fs.existsSync(stale.fullPath)) {
                    try {
                        fs.unlinkSync(stale.fullPath);
                        console.log(`🧹 [AssetManager] Removido arquivo antigo stale: ${stale.filename}`);
                    } catch (e) {
                        console.warn(`⚠️ [AssetManager] Falha ao remover ${stale.filename}:`, e.message);
                    }
                }
            }

            resolved[cfg.key] = {
                filename: expectedName,
                hash,
                url: `/assets/${expectedName}?v=${hash}`
            };
        }

        this._resolvedAssets = resolved;

        // Atualiza index.html em disco
        this.updateIndexHtmlOnDisk(resolved);

        return resolved;
    }

    /**
     * Resolve os assets atuais em public/assets/.
     * Se não estiverem em cache de memória, busca e detecta dinamicamente.
     */
    static resolveAssets() {
        if (this._resolvedAssets) {
            return this._resolvedAssets;
        }
        return this.syncAssets();
    }

    /**
     * Injeta as URLs versionadas e hashes no HTML fornecido.
     */
    static injectAssets(html, assets = null) {
        const resolved = assets || this.resolveAssets();
        if (!resolved || typeof html !== 'string') return html;

        let result = html;

        if (resolved.css) {
            const cssRegex = /\/assets\/brasilflix(?:\.[a-zA-Z0-9_-]+)?\.css(?:\?[^"'>\s]+)?/g;
            result = result.replace(cssRegex, resolved.css.url);
        }

        if (resolved.playerJs) {
            const playerJsRegex = /\/assets\/brasilflix-player(?:\.[a-zA-Z0-9_-]+)?\.js(?:\?[^"'>\s]+)?/g;
            result = result.replace(playerJsRegex, resolved.playerJs.url);
        }

        if (resolved.mainJs) {
            const mainJsRegex = /\/assets\/brasilflix(?!-player)(?:\.[a-zA-Z0-9_-]+)?\.js(?:\?[^"'>\s]+)?/g;
            result = result.replace(mainJsRegex, resolved.mainJs.url);
        }

        return result;
    }

    /**
     * Atualiza o arquivo public/index.html diretamente no disco.
     */
    static updateIndexHtmlOnDisk(assets = null) {
        const indexPath = this.getIndexHtmlPath();
        if (!fs.existsSync(indexPath)) return;

        try {
            const originalHtml = fs.readFileSync(indexPath, 'utf8');
            const updatedHtml = this.injectAssets(originalHtml, assets);
            if (originalHtml !== updatedHtml) {
                fs.writeFileSync(indexPath, updatedHtml, 'utf8');
                console.log(`📄 [AssetManager] public/index.html atualizado com novos hashes de assets.`);
            }
        } catch (e) {
            console.warn(`⚠️ [AssetManager] Erro ao atualizar public/index.html:`, e.message);
        }
    }
}

module.exports = AssetManager;
