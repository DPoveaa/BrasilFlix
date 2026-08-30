const fs = require('fs');
const path = require('path');

const indexPath = path.resolve('public/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

console.log('Read index.html, lines:', html.split('\n').length);

// 1. UPDATE getRouteStateFromUrl() TO HANDLE DEDICATED PLAYBACK URLS
const newGetRouteState = `        function getRouteStateFromUrl() {
            const hash = window.location.hash.replace(/^#\\/?/, '').trim();
            const pathname = window.location.pathname.replace(/^\\//, '').trim();
            
            // Prioridade 1: Hash da URL
            if (hash) {
                const parts = hash.split('/');
                const key = (parts[0] || '').toLowerCase();

                // 1.1 Rota de Reprodução Dedicada de Episódio de Série
                // Exemplos: #serie/123/temporada/1/episodio/2 ou #serie/123/t/1/e/2 ou #assistir/serie/123/1/2
                if (key === 'serie' && parts.length >= 5) {
                    const serieId = parts[1];
                    let seasonNum = 1;
                    let epNum = 1;
                    if ((parts[2] === 'temporada' || parts[2] === 't') && (parts[4] === 'episodio' || parts[4] === 'ep' || parts[4] === 'e')) {
                        seasonNum = parseInt(parts[3], 10) || 1;
                        epNum = parseInt(parts[5], 10) || 1;
                        return { type: 'playback_episode', serieId, season: seasonNum, episode: epNum };
                    } else if (parts[2] === 'temporada' || parts[2] === 't') {
                        seasonNum = parseInt(parts[3], 10) || 1;
                        epNum = parseInt(parts[4], 10) || 1;
                        return { type: 'playback_episode', serieId, season: seasonNum, episode: epNum };
                    }
                }

                if (key === 'assistir' && parts[1] === 'serie' && parts.length >= 5) {
                    const serieId = parts[2];
                    const seasonNum = parseInt(parts[3], 10) || 1;
                    const epNum = parseInt(parts[4], 10) || 1;
                    return { type: 'playback_episode', serieId, season: seasonNum, episode: epNum };
                }

                // 1.2 Rota de Reprodução Dedicada de Filme
                // Exemplos: #filme/123/assistir ou #assistir/filme/123 ou #filme/123
                if (key === 'assistir' && parts[1] === 'filme' && parts[2]) {
                    return { type: 'playback_movie', movieId: parts[2] };
                }

                if (key === 'filme' && parts[1] && (parts[2] === 'assistir' || parts[2] === 'play')) {
                    return { type: 'playback_movie', movieId: parts[1] };
                }

                // 1.3 Rota de Detalhes de Mídia (ex: #filme/123 ou #serie/456 ou #dorama/789)
                if (parts[1] && ['filme', 'serie', 'dorama', 'anime', 'titulo'].includes(key)) {
                    let mediaType = key === 'titulo' ? 'serie' : key;
                    return { type: 'media_detail', mediaType: mediaType, mediaId: parts[1] };
                }

                // 1.4 Categorias de Navegação
                if (['inicio', 'filmes', 'filme', 'series', 'serie', 'doramas', 'dorama', 'animes', 'anime', 'minha-lista', 'favoritos'].includes(key)) {
                    let cat = key;
                    if (cat === 'filmes') cat = 'filme';
                    if (cat === 'series') cat = 'serie';
                    if (cat === 'doramas') cat = 'dorama';
                    if (cat === 'animes') cat = 'anime';
                    if (cat === 'minha-lista') cat = 'favoritos';
                    return { type: 'nav', category: cat };
                }

                if (key === 'admin') {
                    return { type: 'tab', mainTab: 'tab-admin', adminSubTab: parts[1] || 'overview' };
                }

                if (key === 'status' || key === 'fila' || key === 'monitor') {
                    return { type: 'tab', mainTab: 'tab-status' };
                }

                if (key === 'stremio') {
                    return { type: 'tab', mainTab: 'tab-stremio' };
                }

                if (key === 'catalogo') {
                    return { type: 'nav', category: 'inicio' };
                }
            }

            // Prioridade 2: Pathname
            if (pathname) {
                const pathParts = pathname.split('/');
                const pKey = (pathParts[0] || '').toLowerCase();

                if (pKey === 'serie' && pathParts.length >= 5) {
                    const serieId = pathParts[1];
                    const seasonNum = parseInt(pathParts[3], 10) || 1;
                    const epNum = parseInt(pathParts[5], 10) || 1;
                    return { type: 'playback_episode', serieId, season: seasonNum, episode: epNum };
                }

                if (pKey === 'filme' && pathParts[1]) {
                    return { type: 'playback_movie', movieId: pathParts[1] };
                }

                if (pKey === 'admin') {
                    return { type: 'tab', mainTab: 'tab-admin', adminSubTab: 'overview' };
                }
            }

            // Prioridade 3: Salvo no localStorage para F5
            const savedMain = localStorage.getItem('bf_active_tab') || 'tab-catalogo';
            const savedNav = localStorage.getItem('bf_active_nav') || 'inicio';
            if (savedMain === 'tab-playback-page') {
                const pType = localStorage.getItem('bf_playback_type');
                if (pType === 'serie') {
                    const sId = localStorage.getItem('bf_playback_serie_id');
                    const sNum = parseInt(localStorage.getItem('bf_playback_season') || 1, 10);
                    const eNum = parseInt(localStorage.getItem('bf_playback_episode') || 1, 10);
                    if (sId) return { type: 'playback_episode', serieId: sId, season: sNum, episode: eNum };
                } else if (pType === 'filme') {
                    const mId = localStorage.getItem('bf_playback_movie_id');
                    if (mId) return { type: 'playback_movie', movieId: mId };
                }
            }
            if (savedMain === 'tab-media-detail') {
                const savedMediaId = localStorage.getItem('bf_active_media_id');
                const savedMediaType = localStorage.getItem('bf_active_media_type') || 'filme';
                if (savedMediaId) {
                    return { type: 'media_detail', mediaType: savedMediaType, mediaId: savedMediaId };
                }
            }
            if (savedMain === 'tab-admin') {
                return {
                    type: 'tab',
                    mainTab: 'tab-admin',
                    adminSubTab: localStorage.getItem('bf_admin_subtab') || 'overview'
                };
            }
            if (savedMain === 'tab-status') {
                return { type: 'tab', mainTab: 'tab-status' };
            }
            return {
                type: 'nav',
                category: savedNav
            };
        }`;

// Replace getRouteStateFromUrl in html
const origFuncStart = html.indexOf('function getRouteStateFromUrl() {');
if (origFuncStart !== -1) {
    const origFuncEnd = html.indexOf('function initApp() {', origFuncStart);
    if (origFuncEnd !== -1) {
        html = html.substring(0, origFuncStart) + newGetRouteState + '\n\n' + html.substring(origFuncEnd);
        console.log('getRouteStateFromUrl replaced successfully!');
    }
}

// 2. UPDATE initApp() and hashchange handler to route to dedicated playback pages
const initAppRouteHandling = `            // Carrega estado da rota salvo / URL (Preserva no F5)
            const route = getRouteStateFromUrl();
            if (route.type === 'playback_episode') {
                openPlaybackPageForEpisode(route.serieId, route.season, route.episode, null, false);
            } else if (route.type === 'playback_movie') {
                openPlaybackPageForMovie(route.movieId, null, false);
            } else if (route.type === 'media_detail') {
                openMediaDetailPage(route.mediaId, route.mediaType, false);
            } else if (route.type === 'nav') {
                switchNavCategory(route.category, false);
            } else if (route.type === 'tab' && document.getElementById(route.mainTab)) {
                switchTab(route.mainTab, false);
                if (route.mainTab === 'tab-admin' && route.adminSubTab && adminToken) {
                    checkAdminAuth(route.adminSubTab);
                }
            } else {
                switchNavCategory('inicio', false);
            }`;

const hashChangeHandling = `            // Escuta mudanças de hash na URL (botão Voltar/Avançar do navegador e links)
            window.addEventListener('hashchange', () => {
                const currentRoute = getRouteStateFromUrl();
                if (currentRoute.type === 'playback_episode') {
                    openPlaybackPageForEpisode(currentRoute.serieId, currentRoute.season, currentRoute.episode, null, false);
                } else if (currentRoute.type === 'playback_movie') {
                    openPlaybackPageForMovie(currentRoute.movieId, null, false);
                } else if (currentRoute.type === 'media_detail') {
                    openMediaDetailPage(currentRoute.mediaId, currentRoute.mediaType, false);
                } else if (currentRoute.type === 'nav') {
                    switchNavCategory(currentRoute.category, false);
                } else if (currentRoute.type === 'tab' && document.getElementById(currentRoute.mainTab)) {
                    switchTab(currentRoute.mainTab, false);
                    if (currentRoute.mainTab === 'tab-admin' && currentRoute.adminSubTab) {
                        switchAdminSubTab(currentRoute.adminSubTab, false);
                    }
                }
            });`;

// Find where initApp handles route
const initRouteComment = '// Carrega estado da rota salvo / URL (Preserva no F5)';
const initRouteIdx = html.indexOf(initRouteComment);
if (initRouteIdx !== -1) {
    const adminCheckIdx = html.indexOf('if (adminToken && route.mainTab === \'tab-admin\')', initRouteIdx);
    if (adminCheckIdx !== -1) {
        html = html.substring(0, initRouteIdx) + initAppRouteHandling + '\n\n            ' + html.substring(adminCheckIdx);
        console.log('initApp route handling updated!');
    }
}

const hashComment = '// Escuta mudanças de hash na URL (botão Voltar/Avançar do navegador e links)';
const hashIdx = html.indexOf(hashComment);
if (hashIdx !== -1) {
    const hashEndIdx = html.indexOf('});\n        }', hashIdx);
    if (hashEndIdx !== -1) {
        html = html.substring(0, hashIdx) + hashChangeHandling + html.substring(hashEndIdx + 3);
        console.log('hashchange handling updated!');
    }
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Step 1 complete, length:', html.length);
