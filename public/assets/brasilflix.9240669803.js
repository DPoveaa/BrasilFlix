        // ═══════════════════════════════════════════════════════════════════════
        // 🛡️ ANONYMOUS VISITOR & AUDIT TRACKING (CLIENT-SIDE)
        // ═══════════════════════════════════════════════════════════════════════
        function getOrCreateVisitorId() {
            let id = localStorage.getItem('bf_visitor_id');
            if (!id) {
                id = 'v_' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).substring(2)));
                localStorage.setItem('bf_visitor_id', id);
            }
            return id;
        }

        function getOrCreateSessionId() {
            let id = sessionStorage.getItem('bf_session_id');
            if (!id) {
                id = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
                sessionStorage.setItem('bf_session_id', id);
                setTimeout(() => trackAuditEvent('SESSION_STARTED', { userAgent: navigator.userAgent }), 300);
            }
            return id;
        }

        const bfVisitorId = getOrCreateVisitorId();
        const bfSessionId = getOrCreateSessionId();

        let _auditDebounceTimers = {};
        function trackAuditEventDebounced(eventType, data = {}, delay = 400) {
            clearTimeout(_auditDebounceTimers[eventType]);
            _auditDebounceTimers[eventType] = setTimeout(() => {
                trackAuditEvent(eventType, data);
            }, delay);
        }

        async function trackAuditEvent(eventType, data = {}) {
            try {
                const userToken = localStorage.getItem('bf_user_token');
                const userJwt = userAuthToken;
                const rawTg = (currentUser && currentUser.telegram_id) ? currentUser.telegram_id : (userToken && /^\d+$/.test(userToken) ? Number(userToken) : null);
                const authBearer = userJwt || userToken;

                const headers = {
                    'Content-Type': 'application/json',
                    'X-Visitor-Id': bfVisitorId,
                    'X-Session-Id': bfSessionId
                };
                if (rawTg) headers['X-Telegram-Id'] = String(rawTg);
                if (authBearer && authBearer !== 'public') headers['Authorization'] = 'Bearer ' + authBearer;

                await fetch('/api/audit/event', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        eventType,
                        visitorId: bfVisitorId,
                        sessionId: bfSessionId,
                        telegramId: rawTg,
                        mediaId: data.mediaId || data.id,
                        seriesId: data.seriesId,
                        seasonNum: data.seasonNum !== undefined ? data.seasonNum : data.season,
                        episodeNum: data.episodeNum !== undefined ? data.episodeNum : data.episode,
                        title: data.title || data.nome,
                        source: 'website',
                        metadata: data.metadata || data,
                        status: data.status || 'success',
                        error: data.error
                    })
                }).catch(() => { });
            } catch (e) { }
        }

        let lastHeartbeatTime = 0;
        async function sendPlaybackHeartbeat(data = {}) {
            try {
                const now = Date.now();
                if (!data.force && !data.completed && (now - lastHeartbeatTime < 8000)) return; // throttle a 8s
                lastHeartbeatTime = now;

                const userToken = localStorage.getItem('bf_user_token');
                const userJwt = userAuthToken;
                const rawTg = (currentUser && currentUser.telegram_id) ? currentUser.telegram_id : (userToken && /^\d+$/.test(userToken) ? Number(userToken) : null);
                const authBearer = userJwt || userToken;

                const headers = {
                    'Content-Type': 'application/json',
                    'X-Visitor-Id': bfVisitorId,
                    'X-Session-Id': bfSessionId
                };
                if (rawTg) headers['X-Telegram-Id'] = String(rawTg);
                if (authBearer && authBearer !== 'public') headers['Authorization'] = 'Bearer ' + authBearer;

                await fetch('/api/audit/heartbeat', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        sessionId: bfSessionId,
                        visitorId: bfVisitorId,
                        telegramId: rawTg,
                        mediaId: data.mediaId || data.id,
                        mediaType: data.mediaType || data.type || 'filme',
                        title: data.title || data.nome || 'Mídia',
                        seasonNum: data.seasonNum !== undefined ? data.seasonNum : (data.season || 0),
                        episodeNum: data.episodeNum !== undefined ? data.episodeNum : (data.episode || 0),
                        currentPosition: data.currentPosition || data.currentTime || 0,
                        duration: data.duration || 0,
                        completed: data.completed || false,
                        platform: 'website'
                    })
                }).catch(() => { });
            } catch (e) { }
        }

        // Sanitização imediata de parâmetros de autenticação e token da URL
        function sanitizeUrlAuthParams() {
            try {
                const urlObj = new URL(window.location.href);
                let shouldClean = false;
                const tokenParam = urlObj.searchParams.get('token') || urlObj.searchParams.get('auth_token');
                const jwtParam = urlObj.searchParams.get('auth_jwt') || urlObj.searchParams.get('jwt');

                if (jwtParam && jwtParam.trim()) {
                    userAuthToken = jwtParam.trim();
                    shouldClean = true;
                }

                if (tokenParam && tokenParam.trim() && tokenParam.trim() !== 'public') {
                    localStorage.setItem('bf_user_token', tokenParam.trim());
                    if (tokenParam === '1689537480' || tokenParam === 'admin' || tokenParam === 'bf_admin') {
                        adminToken = tokenParam.trim();
                        const adminTabBtn = document.getElementById('tab-btn-admin');
                        if (adminTabBtn) adminTabBtn.style.display = 'inline-flex';
                    }
                    shouldClean = true;
                }

                if (urlObj.searchParams.has('token') || urlObj.searchParams.has('auth_token') || urlObj.searchParams.has('jwt') || urlObj.searchParams.has('auth_jwt')) {
                    urlObj.searchParams.delete('token');
                    urlObj.searchParams.delete('auth_token');
                    urlObj.searchParams.delete('jwt');
                    urlObj.searchParams.delete('auth_jwt');
                    shouldClean = true;
                }

                if (shouldClean) {
                    const newQuery = urlObj.searchParams.toString() ? '?' + urlObj.searchParams.toString() : '';
                    window.history.replaceState({}, document.title, urlObj.pathname + newQuery + urlObj.hash);
                }
            } catch (e) {
                console.warn('⚠️ Erro ao sanitizar parâmetros de autenticação da URL:', e);
            }
        }


        // Helpers de SEO, Slugs e URLs Amigáveis
        function generateSlug(text) {
            if (!text) return '';
            return String(text)
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .substring(0, 90);
        }

        function getMediaSlug(item) {
            if (!item) return '';
            if (item.slug && item.slug.trim()) return item.slug.trim();
            return generateSlug(item.nome || item.nomeOriginal || item.id || '');
        }

        function parseSlugOrId(str) {
            if (!str) return { id: null, slug: null, raw: '' };
            const raw = String(str).trim();
            const match = raw.match(/^(\d+)(?:-(.*))?$/);
            if (match) {
                return { id: match[1], slug: match[2] || null, raw };
            }
            if (/^\d+$/.test(raw)) {
                return { id: raw, slug: null, raw };
            }
            return { id: null, slug: raw, raw };
        }

        function findCatalogMedia(idOrSlug, type = null) {
            if (!idOrSlug) return null;
            const parsed = parseSlugOrId(idOrSlug);
            const filmes = fullCatalog?.filmes || [];
            const series = fullCatalog?.series || [];

            // 1. Busca prioritária por ID numérico
            if (parsed.id) {
                if (type === 'filme') {
                    const f = filmes.find(i => String(i.id) === String(parsed.id));
                    if (f) return { item: f, type: 'filme' };
                } else if (type === 'serie' || type === 'anime' || type === 'dorama') {
                    const s = series.find(i => String(i.id) === String(parsed.id));
                    if (s) return { item: s, type: isItemAnime(s) ? 'anime' : (isItemDorama(s) ? 'dorama' : 'serie') };
                } else {
                    const f = filmes.find(i => String(i.id) === String(parsed.id));
                    if (f) return { item: f, type: 'filme' };
                    const s = series.find(i => String(i.id) === String(parsed.id));
                    if (s) return { item: s, type: isItemAnime(s) ? 'anime' : (isItemDorama(s) ? 'dorama' : 'serie') };
                }
            }

            // 2. Busca por slug
            const targetSlug = (parsed.slug || parsed.raw).toLowerCase();
            if (type !== 'serie' && type !== 'anime' && type !== 'dorama') {
                const f = filmes.find(i => {
                    const s = (i.slug || generateSlug(i.nome || i.nomeOriginal)).toLowerCase();
                    return s === targetSlug || s.startsWith(targetSlug) || targetSlug.startsWith(s);
                });
                if (f) return { item: f, type: 'filme' };
            }

            if (type !== 'filme') {
                const s = series.find(i => {
                    const sl = (i.slug || generateSlug(i.nome || i.nomeOriginal)).toLowerCase();
                    return sl === targetSlug || sl.startsWith(targetSlug) || targetSlug.startsWith(sl);
                });
                if (s) return { item: s, type: isItemAnime(s) ? 'anime' : (isItemDorama(s) ? 'dorama' : 'serie') };
            }

            return null;
        }

        function getMediaCanonicalHash(item, type = null, action = null, season = null, episode = null) {
            if (!item) return '#inicio';
            const isSerie = (type === 'serie' || type === 'anime' || type === 'dorama') ||
                item.itemType === 'serie' || !!item.temporadas || (item.totalEpisodios !== undefined && item.totalEpisodios !== null);
            const mediaType = isSerie ? 'serie' : 'filme';
            const slug = getMediaSlug(item);
            const param = slug ? `${item.id}-${slug}` : String(item.id);

            if (action === 'assistir') {
                if (isSerie && season && episode) {
                    return `#serie/${param}/temporada/${season}/episodio/${episode}`;
                }
                return `#${mediaType}/${param}/assistir`;
            }
            return `#${mediaType}/${param}`;
        }

        function setOrCreateMetaTag(attrName, attrVal, content) {
            if (!content) return;
            let el = document.querySelector(`meta[${attrName}="${attrVal}"]`);
            if (!el) {
                el = document.createElement('meta');
                el.setAttribute(attrName, attrVal);
                document.head.appendChild(el);
            }
            el.setAttribute('content', content);
        }

        function updateSeoMetadata(item, isSerie = false, epMeta = null) {
            if (!item) return;
            const baseUrl = 'https://brasilflix.kapsu.com.br';
            const canonicalHash = getMediaCanonicalHash(item, isSerie ? 'serie' : 'filme', epMeta ? 'assistir' : null, epMeta?.season, epMeta?.episode);
            const canonicalPath = canonicalHash.replace(/^#/, '/');
            const fullCanonicalUrl = `${baseUrl}${canonicalPath}`;

            const titleText = epMeta
                ? `${item.nome}: T${epMeta.season}E${epMeta.episode}${epMeta.epTitle ? ` - ${epMeta.epTitle}` : ''} | BrasilFlix`
                : `${item.nome}${item.ano ? ` (${item.ano})` : ''} - Assistir Online em Full HD | BrasilFlix`;

            document.title = titleText;

            const rawDesc = item.sinopse || item.descricao || `Assista ${item.nome} online completo em full HD com áudio dublado e legendado no BrasilFlix.`;
            const cleanDesc = rawDesc.substring(0, 160);
            const imgUrl = item.backdropUrl || item.posterUrl || `${baseUrl}/assets/logo.png`;

            setOrCreateMetaTag('name', 'description', cleanDesc);
            setOrCreateMetaTag('property', 'og:title', titleText);
            setOrCreateMetaTag('property', 'og:description', cleanDesc);
            setOrCreateMetaTag('property', 'og:image', imgUrl);
            setOrCreateMetaTag('property', 'og:url', fullCanonicalUrl);
            setOrCreateMetaTag('property', 'og:type', isSerie ? 'video.tv_show' : 'video.movie');
            setOrCreateMetaTag('name', 'twitter:title', titleText);
            setOrCreateMetaTag('name', 'twitter:description', cleanDesc);
            setOrCreateMetaTag('name', 'twitter:image', imgUrl);

            let canLink = document.querySelector('link[rel="canonical"]');
            if (!canLink) {
                canLink = document.createElement('link');
                canLink.rel = 'canonical';
                document.head.appendChild(canLink);
            }
            canLink.href = fullCanonicalUrl;

            let schemaScript = document.getElementById('bf-jsonld-schema');
            if (!schemaScript) {
                schemaScript = document.createElement('script');
                schemaScript.id = 'bf-jsonld-schema';
                schemaScript.type = 'application/ld+json';
                document.head.appendChild(schemaScript);
            }
            schemaScript.textContent = JSON.stringify({
                '@context': 'https://schema.org',
                '@type': isSerie ? 'TVSeries' : 'Movie',
                'name': item.nome,
                'alternateName': item.nomeOriginal || undefined,
                'description': cleanDesc,
                'image': imgUrl,
                'datePublished': item.ano || undefined,
                'aggregateRating': item.nota ? {
                    '@type': 'AggregateRating',
                    'ratingValue': String(item.nota),
                    'bestRating': '10',
                    'ratingCount': '150'
                } : undefined
            });
        }

        function updateCategorySeo(category) {
            const titles = {
                'inicio': 'BrasilFlix • Filmes, Séries, Animes e Doramas Online em Full HD',
                'filme': 'Filmes Online Grátis em Full HD • BrasilFlix',
                'serie': 'Séries Online Dublado e Legendado • BrasilFlix',
                'anime': 'Animes Online Grátis e Dublados • BrasilFlix',
                'dorama': 'Doramas e K-Dramas Online Dublados e Legendados • BrasilFlix',
                'favoritos': 'Minha Lista de Filmes e Séries • BrasilFlix'
            };
            if (titles[category]) {
                document.title = titles[category];
            }
        }

        // Evento de visita do website ao inicializar
        setTimeout(() => trackAuditEvent('WEBSITE_VISIT', { hash: window.location.hash, path: window.location.pathname }), 500);

        let fullCatalog = { filmes: [], series: [] };
        let currentCatalogVersion = null;
        let isSyncingCatalog = false;
        let adminCatalogData = { filmes: [], series: [] };
        let currentAdminJobs = [];
        let activeCategory = 'todos';
        let activeGenre = 'todos';
        let adminToken = null;
        let dragSrcEl = null;

        function getRouteStateFromUrl() {
            const hash = window.location.hash.replace(/^#\/?/, '').trim();
            const pathname = window.location.pathname.replace(/^\//, '').trim();

            // Prioridade 1: Hash da URL
            if (hash) {
                const parts = hash.split('/');
                const key = (parts[0] || '').toLowerCase();

                // 1.1 Rota de Reprodução Dedicada de Episódio de Série
                // Exemplos: #serie/123-slug/temporada/1/episodio/2 ou #serie/123/t/1/e/2 ou #assistir/serie/123/1/2
                if ((key === 'serie' || key === 'anime' || key === 'dorama') && parts.length >= 5) {
                    const serieParam = parts[1];
                    const parsed = parseSlugOrId(serieParam);
                    const sId = parsed.id || serieParam;
                    let seasonNum = 1;
                    let epNum = 1;
                    if ((parts[2] === 'temporada' || parts[2] === 't') && (parts[4] === 'episodio' || parts[4] === 'ep' || parts[4] === 'e')) {
                        seasonNum = parseInt(parts[3], 10) || 1;
                        epNum = parseInt(parts[5], 10) || 1;
                        return { type: 'playback_episode', serieId: sId, slugParam: serieParam, season: seasonNum, episode: epNum };
                    } else if (parts[2] === 'temporada' || parts[2] === 't') {
                        seasonNum = parseInt(parts[3], 10) || 1;
                        epNum = parseInt(parts[4], 10) || 1;
                        return { type: 'playback_episode', serieId: sId, slugParam: serieParam, season: seasonNum, episode: epNum };
                    }
                }

                if (key === 'assistir' && (parts[1] === 'serie' || parts[1] === 'anime' || parts[1] === 'dorama') && parts.length >= 5) {
                    const serieParam = parts[2];
                    const parsed = parseSlugOrId(serieParam);
                    const sId = parsed.id || serieParam;
                    const seasonNum = parseInt(parts[3], 10) || 1;
                    const epNum = parseInt(parts[4], 10) || 1;
                    return { type: 'playback_episode', serieId: sId, slugParam: serieParam, season: seasonNum, episode: epNum };
                }

                // 1.2 Rota de Reprodução Dedicada de Filme
                // Exemplos: #filme/123-slug/assistir ou #assistir/filme/123
                if (key === 'assistir' && parts[1] === 'filme' && parts[2]) {
                    const parsed = parseSlugOrId(parts[2]);
                    return { type: 'playback_movie', movieId: parsed.id || parts[2], slugParam: parts[2] };
                }

                if (key === 'filme' && parts[1] && (parts[2] === 'assistir' || parts[2] === 'play')) {
                    const parsed = parseSlugOrId(parts[1]);
                    return { type: 'playback_movie', movieId: parsed.id || parts[1], slugParam: parts[1] };
                }

                // 1.3 Rota de Detalhes de Mídia (ex: #filme/123-slug ou #serie/456-slug ou #filme/123 antigo)
                if (parts[1] && ['filme', 'serie', 'dorama', 'anime', 'titulo'].includes(key)) {
                    let mediaType = key === 'titulo' ? 'serie' : key;
                    const parsed = parseSlugOrId(parts[1]);
                    return { type: 'media_detail', mediaType: mediaType, mediaId: parsed.id || parts[1], slugParam: parts[1] };
                }

                // 1.4 Categorias de Navegação
                if (['inicio', 'filmes', 'filme', 'series', 'serie', 'doramas', 'dorama', 'animes', 'anime', 'minha-lista', 'favoritos'].includes(key)) {
                    if (window.location.pathname.startsWith('/admin')) {
                        history.replaceState(null, '', '/' + window.location.hash);
                    }
                    let cat = key;
                    if (cat === 'filmes') cat = 'filme';
                    if (cat === 'series') cat = 'serie';
                    if (cat === 'doramas') cat = 'dorama';
                    if (cat === 'animes') cat = 'anime';
                    if (cat === 'minha-lista') cat = 'favoritos';
                    return { type: 'nav', category: cat };
                }

                if (key === 'admin') {
                    let sub = (parts[1] || 'overview').toLowerCase();
                    if (sub === 'inicio' || sub === 'home') {
                        if (window.location.pathname.startsWith('/admin')) {
                            history.replaceState(null, '', '/#inicio');
                        } else {
                            history.replaceState(null, '', '#inicio');
                        }
                        return { type: 'nav', category: 'inicio' };
                    }
                    if (sub === 'catalogo') sub = 'catalog';
                    return { type: 'tab', mainTab: 'tab-admin', adminSubTab: sub };
                }

                if (['settings', 'configuracoes', 'configuracao', 'perfil', 'conta'].includes(key)) {
                    return { type: 'tab', mainTab: 'tab-settings', settingsSection: parts[1] || 'profile' };
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

                // Reprodução de série via pathname
                if ((pKey === 'serie' || pKey === 'anime' || pKey === 'dorama') && pathParts.length >= 5) {
                    const parsed = parseSlugOrId(pathParts[1]);
                    const sId = parsed.id || pathParts[1];
                    const seasonNum = parseInt(pathParts[3], 10) || 1;
                    const epNum = parseInt(pathParts[5], 10) || 1;
                    return { type: 'playback_episode', serieId: sId, slugParam: pathParts[1], season: seasonNum, episode: epNum };
                }

                // Reprodução de filme via pathname (/filme/123-slug/assistir)
                if (pKey === 'filme' && pathParts[1] && (pathParts[2] === 'assistir' || pathParts[2] === 'play')) {
                    const parsed = parseSlugOrId(pathParts[1]);
                    return { type: 'playback_movie', movieId: parsed.id || pathParts[1], slugParam: pathParts[1] };
                }

                // Detalhe de mídia via pathname (/filme/123-slug ou /serie/456-slug)
                if (['filme', 'serie', 'anime', 'dorama'].includes(pKey) && pathParts[1]) {
                    const parsed = parseSlugOrId(pathParts[1]);
                    return { type: 'media_detail', mediaType: pKey, mediaId: parsed.id || pathParts[1], slugParam: pathParts[1] };
                }

                if (pKey === 'admin') {
                    return { type: 'tab', mainTab: 'tab-admin', adminSubTab: 'overview' };
                }

                if (['settings', 'configuracoes', 'perfil', 'conta'].includes(pKey)) {
                    return { type: 'tab', mainTab: 'tab-settings', settingsSection: pathParts[1] || 'profile' };
                }

                if (['catalogo', 'inicio', 'filmes', 'series', 'animes', 'doramas'].includes(pKey)) {
                    let cat = pKey;
                    if (cat === 'filmes') cat = 'filme';
                    if (cat === 'series') cat = 'serie';
                    if (cat === 'doramas') cat = 'dorama';
                    if (cat === 'animes') cat = 'anime';
                    if (cat === 'catalogo') cat = 'inicio';
                    return { type: 'nav', category: cat };
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
            if (savedMain === 'tab-settings') {
                return { type: 'tab', mainTab: 'tab-settings', settingsSection: localStorage.getItem('bf_settings_section') || 'profile' };
            }
            if (savedMain === 'tab-status') {
                return { type: 'tab', mainTab: 'tab-status' };
            }
            return {
                type: 'nav',
                category: savedNav
            };
        }

        function initApp() {
            // Sincroniza login vindo do Telegram via link direto (?auth_jwt=...&token=...)
            const urlParams = new URLSearchParams(window.location.search);
            const authJwtFromUrl = urlParams.get('auth_jwt') || urlParams.get('jwt');
            const tokenFromUrl = urlParams.get('token') || urlParams.get('auth_token');
            if (authJwtFromUrl) {
                userAuthToken = authJwtFromUrl;
                if (tokenFromUrl && tokenFromUrl !== 'public') {
                    localStorage.setItem('bf_user_token', tokenFromUrl);
                }
                const cleanUrl = window.location.pathname + window.location.hash;
                window.history.replaceState({}, document.title, cleanUrl);
                showToast('🎉 Login sincronizado via Telegram com sucesso!', 'success');
            } else if (tokenFromUrl && tokenFromUrl !== 'public') {
                localStorage.setItem('bf_user_token', tokenFromUrl);
            }

            if (tokenFromUrl && (tokenFromUrl === '1689537480' || tokenFromUrl === 'admin' || tokenFromUrl === 'bf_admin')) {
                adminToken = tokenFromUrl;
                const adminTabBtn = document.getElementById('tab-btn-admin');
                if (adminTabBtn) adminTabBtn.style.display = 'inline-flex';
            }

            localStorage.removeItem('bf_user_jwt');
            localStorage.removeItem('bf_admin_token');
            clearSearchAutofill();
            setTimeout(clearSearchAutofill, 200);
            setTimeout(clearSearchAutofill, 600);
            fetchStatus();
            fetchUserProfileAndFavorites();
            loadCatalog();

            // Polling inteligente de status (pausa quando aba está oculta)
            let statusPollingTimer = null;
            function startStatusPolling() {
                if (statusPollingTimer) clearInterval(statusPollingTimer);
                statusPollingTimer = setInterval(() => {
                    if (!document.hidden && ['tab-status', 'tab-fila', 'tab-admin'].includes(localStorage.getItem('bf_active_tab'))) {
                        fetchStatus();
                    }
                }, 5000);
            }
            startStatusPolling();
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) {
                    fetchStatus();
                }
            });

            const adminTabBtn = document.getElementById('tab-btn-admin');
            if (adminTabBtn && adminToken) {
                adminTabBtn.style.display = 'inline-flex';
            }

            // Carrega estado da rota salvo / URL (Preserva no F5)
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
                } else if (route.mainTab === 'tab-settings') {
                    switchSettingsSection(route.settingsSection || 'profile');
                    loadSettingsView();
                }
            } else {
                switchNavCategory('inicio', false);
            }

            if (adminToken && route.mainTab === 'tab-admin') {
                checkAdminAuth(route.adminSubTab);
            } else if (route.mainTab === 'tab-admin' && !adminToken) {
                document.getElementById('admin-login-view').style.display = 'block';
                document.getElementById('admin-dashboard-view').style.display = 'none';
            }

            // Escuta mudanças de hash na URL (botão Voltar/Avançar do navegador e links)
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
                    } else if (currentRoute.mainTab === 'tab-settings') {
                        switchSettingsSection(currentRoute.settingsSection || 'profile');
                        loadSettingsView();
                    }
                }
            });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initApp);
        } else {
            initApp();
        }

        function switchTab(tabId, updateUrl = true) {
            if (tabId !== 'tab-playback-page') {
                if (typeof closeWebPlayer === 'function') closeWebPlayer();
            }
            document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => {
                c.classList.remove('active');
                c.style.display = 'none';
            });

            const baseId = tabId.replace('tab-', '');
            const btn = document.getElementById('tab-btn-' + baseId);
            if (btn) btn.classList.add('active');

            // Sincroniza sidebar para tabs especiais
            if (tabId === 'tab-status') {
                document.querySelectorAll('.sidebar-nav-item').forEach(b => b.classList.remove('active'));
                const sbStatus = document.getElementById('sidebar-item-status');
                if (sbStatus) sbStatus.classList.add('active');
            }

            const targetContent = document.getElementById(tabId);
            if (targetContent) {
                targetContent.style.display = 'block';
                targetContent.classList.add('active');
            }

            // Salva no localStorage para persistência em F5
            localStorage.setItem('bf_active_tab', tabId);
            if (tabId === 'tab-status') fetchStatus();

            if (updateUrl) {
                let newHash = '#' + baseId;
                if (tabId === 'tab-admin') {
                    const currentAdminSub = localStorage.getItem('bf_admin_subtab') || 'overview';
                    newHash = `#admin/${currentAdminSub}`;
                } else if (tabId === 'tab-settings') {
                    const currentSetSec = localStorage.getItem('bf_settings_section') || 'profile';
                    newHash = `#settings/${currentSetSec}`;
                }

                if (tabId !== 'tab-admin' && window.location.pathname.startsWith('/admin')) {
                    history.replaceState(null, '', '/' + newHash);
                } else if (window.location.hash !== newHash) {
                    history.replaceState(null, '', newHash);
                }
            }

            if (tabId === 'tab-catalogo') {
                document.body.classList.remove('in-admin-tab');
                renderCatalog();
                if (typeof initBrasilFlixAds === 'function') initBrasilFlixAds();
            } else if (tabId === 'tab-settings') {
                document.body.classList.remove('in-admin-tab');
                loadSettingsView();
                if (typeof initBrasilFlixAds === 'function') initBrasilFlixAds();
            } else if (tabId === 'tab-admin') {
                document.body.classList.add('in-admin-tab');
                if (typeof hideBrasilFlixAds === 'function') hideBrasilFlixAds();
                if (adminToken) {
                    const sub = localStorage.getItem('bf_admin_subtab') || 'overview';
                    checkAdminAuth(sub);
                } else {
                    document.getElementById('admin-login-view').style.display = 'block';
                    document.getElementById('admin-dashboard-view').style.display = 'none';
                }
            } else {
                document.body.classList.remove('in-admin-tab');
                if (typeof initBrasilFlixAds === 'function') initBrasilFlixAds();
            }
        }

        let lastToastMsg = '';
        let lastToastTime = 0;
        function showToast(message, type = 'info') {
            const now = Date.now();
            if (lastToastMsg === message && (now - lastToastTime) < 1200) {
                return; // Evita toasts duplicados no mesmo segundo
            }
            lastToastMsg = message;
            lastToastTime = now;

            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = `toast toast-${type}`;
            const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : 'ℹ️');
            toast.replaceChildren(...[icon, message].map(value => { const span = document.createElement('span'); span.textContent = value; return span; }));
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(100%)';
                toast.style.transition = 'all 0.3s ease';
                setTimeout(() => toast.remove(), 300);
            }, 3500);
        }

        async function fetchStatus() {
            try {
                const tab = localStorage.getItem('bf_active_tab');
                const res = await fetch(tab === 'tab-status' || tab === 'tab-admin' ? '/api/status' : '/api/resumo');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();

                if (data && data.stats) {
                    const fEl = document.getElementById('stat-filmes');
                    const sEl = document.getElementById('stat-series');
                    const tEl = document.getElementById('count-total');

                    const fCount = Number(data.stats.totalFilmes) || 0;
                    const sCount = Number(data.stats.totalSeries) || 0;

                    if (fEl) fEl.innerText = fCount;
                    if (sEl) sEl.innerText = sCount;
                    // Usa o total geral (filmes + séries + animes + doramas) para bater com o rodapé do catálogo
                    if (tEl) tEl.innerText = Number(data.stats.total) || (fCount + sCount);
                }

                if (data && data.catalogVersion) {
                    if (currentCatalogVersion !== null && String(data.catalogVersion) !== String(currentCatalogVersion)) {
                        syncCatalogSilently(data.catalogVersion);
                    } else if (currentCatalogVersion === null) {
                        currentCatalogVersion = data.catalogVersion;
                    }
                }

                if (data && data.queue) {
                    const qCount = Number(data.queue.totalQueued) || 0;
                    const qEl = document.getElementById('stat-fila');
                    const qCounter = document.getElementById('queue-counter');

                    if (qEl) qEl.innerText = qCount;
                    if (qCounter) qCounter.innerText = `${qCount} aguardando`;

                    const activeContainer = document.getElementById('active-task-container');
                    const idleMessage = document.getElementById('idle-message');

                    // Atualiza Card de Live Task público
                    const admActiveContainer = null; // legacy — substituído pelo terminal SSE
                    const admIdleMsg = null;         // legacy — substituído pelo terminal SSE

                    const activeTasks = (data.queue && (data.queue.activeTasks || (data.queue.activeTask ? [data.queue.activeTask] : []))) || [];
                    const maxJobs = data.queue?.maxConcurrentJobs || 10;
                    const maxEl = document.getElementById('active-tasks-max');
                    if (maxEl) maxEl.innerText = maxJobs;

                    if (activeTasks.length > 0) {
                        if (idleMessage) idleMessage.style.display = 'none';
                        if (activeContainer) activeContainer.style.display = 'block';

                        const countEl = document.getElementById('active-tasks-count');
                        if (countEl) countEl.innerText = activeTasks.length;

                        const listEl = document.getElementById('active-tasks-list');
                        if (listEl) {
                            listEl.innerHTML = activeTasks.map((task, idx) => {
                                const epStr = (task.type === 'serie' && (task.season || task.episode)) ? ` (T${task.season || 1}E${task.episode || 1})` : '';
                                const progVal = typeof task.progress === 'number' ? Math.round(task.progress) : 0;
                                const speedStr = task.progressDetails && task.progressDetails.includes('MB/s')
                                    ? task.progressDetails.split('(')[1]?.replace(')', '') || 'Ativo'
                                    : (task.progressDetails && task.progressDetails.includes('x') ? task.progressDetails.split('|')[1]?.trim() || 'Ativo' : 'Ativo');
                                const tipoLabel = task.type === 'serie' ? '📺 Série' : '🎬 Filme';
                                const audioLabel = task.audioPreference === 'legendado' ? '💬 Leg' : '🇧🇷 Dub';
                                const isVip = task.priority === 1 || String(task.priority).includes('VIP');

                                let stageBadge = '📥 Download';
                                if (task.status === 'processing') stageBadge = '⚙️ Otimização';
                                else if (task.status === 'uploading') stageBadge = '🚀 Envio Telegram';

                                return `
                                    <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px;">
                                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                                            <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                                                <span class="live-tag" style="font-size: 10px; padding: 2px 6px;">${tipoLabel}</span>
                                                <span class="live-tag" style="font-size: 10px; padding: 2px 6px; background: rgba(59,130,246,0.15); color: #60a5fa;">${audioLabel}</span>
                                                <span class="live-tag" style="font-size: 10px; padding: 2px 6px; background: rgba(16,185,129,0.15); color: #34d399;">${stageBadge}</span>
                                            </div>
                                            <span class="badge-priority">${isVip ? '🔥 VIP' : '#' + (idx + 1)}</span>
                                        </div>
                                        <h4 style="font-size: 13px; font-weight: 800; color: #fff; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                                            ${task.title}${epStr}
                                        </h4>
                                        <div class="live-progress-container" style="height: 6px; margin: 2px 0;">
                                            <div class="live-progress-bar" style="width: ${progVal}%;"></div>
                                        </div>
                                        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-muted);">
                                            <span style="max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${task.progressDetails || 'Processando 1080p...'}</span>
                                            <span style="color: #34d399; font-weight: 700;">⚡ ${speedStr}</span>
                                            <span style="color: #fff; font-weight: 800;">${progVal}%</span>
                                        </div>
                                    </div>
                                `;
                            }).join('');
                        }
                    } else {
                        const sched = data.queue?.scheduler;
                        const isSchedActive = sched && sched.config?.ativo !== false;
                        const isOutsideHours = isSchedActive && !sched.allowed;

                        let idleHtml = '<span style="font-size: 24px;">🛰️</span> Esteira ociosa. Nenhum download ou otimização ativa no momento.';

                        if (isOutsideHours) {
                            const prox = sched.proximaJanela?.descricao ? `Próxima janela: <strong>${sched.proximaJanela.descricao}</strong>` : 'Janela: <strong>Seg–Sex 01h–05h (SP)</strong>';
                            idleHtml = `<span style="font-size: 24px;">⏰</span> <strong>Downloads e uploads pausados fora do horário</strong> (Seg–Sex 01h–05h SP). ${prox}`;
                        }

                        if (idleMessage) {
                            idleMessage.innerHTML = idleHtml;
                            idleMessage.style.display = 'block';
                        }
                        if (activeContainer) activeContainer.style.display = 'none';
                    }

                    const queueList = document.getElementById('queue-items-container');
                    if (queueList) {
                        if (data.queue.queue && data.queue.queue.length > 0) {
                            queueList.innerHTML = data.queue.queue.map(item => {
                                const epStr = (item.type === 'serie' && (item.season || item.episode)) ? ` (T${item.season || 1}E${item.episode || 1})` : '';
                                const audioStr = item.audioPreference === 'dublado' ? '🇧🇷 Dublado' : '💬 Legendado';
                                const typeStr = item.type === 'filme' ? '🎬 Filme' : '📺 Série';
                                return `
                                    <div class="queue-item">
                                        <div class="queue-item-info">
                                            <h4>${item.title}${epStr}</h4>
                                            <div class="queue-item-meta">
                                                <span class="badge-priority">${item.priority === 1 ? 'VIP' : 'Normal'}</span>
                                                <span>${typeStr}</span>
                                                <span>• ${audioStr}</span>
                                            </div>
                                        </div>
                                        <span style="font-size: 11px; color: var(--text-muted);">Aguardando</span>
                                    </div>
                                `;
                            }).join('');
                        } else {
                            queueList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum pedido pendente na fila no momento.</div>';
                        }
                    }

                    const recentList = document.getElementById('recent-items-container');
                    if (recentList) {
                        if (data.queue.recentCompleted && data.queue.recentCompleted.length > 0) {
                            recentList.innerHTML = data.queue.recentCompleted.map(item => {
                                const epStr = (item.type === 'serie' && (item.season || item.episode)) ? ` (T${item.season || 1}E${item.episode || 1})` : '';
                                const typeStr = item.type === 'filme' ? 'Filme' : 'Série';
                                const isDub = item.isDublado || item.audioBadge?.includes('D');
                                const isLeg = item.isLegendado || item.audioBadge?.includes('L');
                                let audioLabel = 'Áudio';
                                if (isDub && isLeg) audioLabel = 'Dub/Leg';
                                else if (isDub) audioLabel = 'Dublado';
                                else if (isLeg) audioLabel = 'Legendado';

                                const qualLabel = item.isCam ? 'Versão CAM' : (item.qualidade || 'HD');
                                const qualBadgeClass = item.isCam ? 'badge-priority' : 'badge-completed';

                                return `
                                    <div class="queue-item">
                                        <div class="queue-item-info">
                                            <h4>${item.title}${epStr}</h4>
                                            <div class="queue-item-meta">
                                                <span class="${qualBadgeClass}">${qualLabel}</span>
                                                <span style="color: #60a5fa; font-weight: 700;">${audioLabel}</span>
                                                <span>• ${typeStr}</span>
                                            </div>
                                        </div>
                                        <span style="color: #34d399; font-weight: 700; font-size: 12px;">✓ Concluído</span>
                                    </div>
                                `;
                            }).join('');
                        } else {
                            recentList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum título concluído recentemente.</div>';
                        }
                    }
                }
            } catch (e) {
                console.warn('Erro ao consultar status:', e);
            }
        }

        const seriesDetails = new Map();
        async function getSeriesDetails(id) {
            if (!seriesDetails.has(String(id))) {
                const request = fetch('/api/catalogo/serie/' + encodeURIComponent(id)).then(response => {
                    if (!response.ok) throw new Error('Série indisponível');
                    return response.json();
                }).catch(error => {
                    seriesDetails.delete(String(id));
                    throw error;
                });
                seriesDetails.set(String(id), request);
            }
            return seriesDetails.get(String(id));
        }

        async function fetchCatalogIndex() {
            const index = { filmes: [], series: [] };
            let next = 0;
            do {
                const response = await fetch('/api/catalogo/titulos?offset=' + next);
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const page = await response.json();
                index.version = page.version;
                for (const item of page.titles) index[item.itemType === 'serie' ? 'series' : 'filmes'].push(item);
                next = page.next;
            } while (next !== null);
            return index;
        }

        async function loadCatalog() {
            try {
                fullCatalog = await fetchCatalogIndex();
                currentCatalogVersion = fullCatalog.version;

                const currentRoute = getRouteStateFromUrl();
                if (currentRoute.type === 'media_detail') {
                    openMediaDetailPage(currentRoute.mediaId, currentRoute.mediaType, false);
                } else if (currentRoute.type === 'nav') {
                    switchNavCategory(currentRoute.category, false);
                } else if (currentRoute.type === 'tab' && currentRoute.mainTab === 'tab-settings') {
                    switchTab('tab-settings', false);
                    switchSettingsSection(currentRoute.settingsSection || 'profile');
                    loadSettingsView();
                } else if (currentRoute.type === 'tab' && currentRoute.mainTab && document.getElementById(currentRoute.mainTab)) {
                    switchTab(currentRoute.mainTab, false);
                } else {
                    renderHeroBillboard();
                    renderNetflixRails();
                    renderCatalog();
                }

                // Processa parâmetros de link direto (?ver=ID&t=SEG ou ?sala=CODE)
                const urlParams = new URLSearchParams(window.location.search);
                const tokenParam = urlParams.get('token') || urlParams.get('auth_token');
                if (tokenParam && tokenParam.trim()) {
                    localStorage.setItem('bf_user_token', tokenParam.trim());
                }

                const salaParam = urlParams.get('sala') || urlParams.get('party');
                if (salaParam) {
                    try {
                        const cleanUrl = new URL(window.location.href);
                        cleanUrl.searchParams.delete('sala');
                        cleanUrl.searchParams.delete('party');
                        window.history.replaceState({}, document.title, cleanUrl.pathname + (cleanUrl.searchParams.toString() ? '?' + cleanUrl.searchParams.toString() : '') + cleanUrl.hash);
                    } catch (e) { }
                    setTimeout(() => joinWatchPartyByCode(salaParam), 400);
                }

                const verId = urlParams.get('ver') || urlParams.get('midia') || urlParams.get('id');
                const startTimestamp = parseFloat(urlParams.get('t')) || 0;
                if (verId && !salaParam) {
                    openModalById(verId);
                    if (startTimestamp > 0) {
                        setTimeout(() => {
                            const video = document.getElementById('html5-video-player');
                            if (video) video.currentTime = startTimestamp;
                        }, 600);
                    }
                }
            } catch (e) {
                console.warn('Erro ao carregar catálogo:', e);
            }
        }

        async function syncCatalogSilently(newVersion) {
            if (isSyncingCatalog) return;
            isSyncingCatalog = true;
            try {
                const freshCatalog = await fetchCatalogIndex();
                seriesDetails.clear();
                if (!freshCatalog || (!Array.isArray(freshCatalog.filmes) && !Array.isArray(freshCatalog.series))) {
                    return;
                }

                fullCatalog = freshCatalog;
                currentCatalogVersion = newVersion || freshCatalog.version || Date.now();

                updateCatalogViewsSilently();
            } catch (e) {
            } finally {
                isSyncingCatalog = false;
            }
        }

        async function updateCatalogViewsSilently() {
            try {
                // 1. Se estiver no player assistindo filme/série, NÃO interfere nem fecha
                const playbackPage = document.getElementById('tab-playback-page');
                const isPlaying = playbackPage && playbackPage.style.display !== 'none';
                if (isPlaying) {
                    if (typeof currentPlaybackSerie !== 'undefined' && currentPlaybackSerie && currentPlaybackSerie.id) {
                        const updatedSerie = (fullCatalog.series || []).find(s => String(s.id) === String(currentPlaybackSerie.id));
                        if (updatedSerie) {
                            if (!updatedSerie.temporadas) Object.assign(updatedSerie, await getSeriesDetails(updatedSerie.id));
                            currentPlaybackSerie = updatedSerie;
                            if (typeof renderPlaybackSeasonEpisodes === 'function' && typeof currentPlaybackSeasonNum !== 'undefined') {
                                renderPlaybackSeasonEpisodes(currentPlaybackSerie, currentPlaybackSeasonNum, typeof currentPlaybackEpNum !== 'undefined' ? currentPlaybackEpNum : 1);
                            }
                        }
                    }
                    return;
                }

                // 2. Se a página de detalhes da mídia estiver aberta, sincroniza episódios se mudaram
                const detailTab = document.getElementById('tab-media-detail');
                const isDetailActive = detailTab && detailTab.style.display !== 'none';
                if (isDetailActive && typeof currentDetailMedia !== 'undefined' && currentDetailMedia && currentDetailMedia.id) {
                    const updated = (fullCatalog.series || []).find(i => String(i.id) === String(currentDetailMedia.id)) ||
                        (fullCatalog.filmes || []).find(i => String(i.id) === String(currentDetailMedia.id));
                    if (updated) {
                        const oldEpCount = currentDetailMedia.totalEpisodios || 0;
                        const newEpCount = updated.totalEpisodios || 0;
                        if (currentDetailType === 'serie' && !updated.temporadas) Object.assign(updated, await getSeriesDetails(updated.id));
                        currentDetailMedia = updated;
                        if (oldEpCount !== newEpCount && typeof openMediaDetailPage === 'function') {
                            openMediaDetailPage(updated.id, typeof currentDetailType !== 'undefined' ? currentDetailType : 'serie', false);
                        }
                    }
                }

                // 3. Atualiza os trilhos e a grade do catálogo silenciosamente
                if (typeof renderNetflixRails === 'function') {
                    renderNetflixRails();
                }
                if (typeof renderCatalog === 'function') {
                    renderCatalog();
                }

                // 4. Se a aba de catálogo do admin estiver aberta, sincroniza os dados do admin automaticamente
                const adminCatalogTab = document.getElementById('admin-subtab-catalog');
                if (adminCatalogTab && adminCatalogTab.style.display !== 'none' && typeof loadAdminCatalog === 'function' && adminToken) {
                    loadAdminCatalog();
                }
            } catch (e) { }
        }

        let catalogFilters = {
            type: 'todos',
            audio: 'todos',
            quality: 'todos',
            genre: 'todos',
            sort: 'default'
        };

        function setCatalogFilter(key, val, btn) {
            catalogFilters[key] = val;

            // Atualiza botões ativos na seção correspondente
            if (btn) {
                const section = btn.closest('.filter-section');
                if (section) {
                    section.querySelectorAll('.filter-link, .genre-tag-btn').forEach(l => l.classList.remove('active'));
                    btn.classList.add('active');
                }
            }

            // Fecha sidebar no mobile se estiver aberta
            const sidebar = document.getElementById('catalog-sidebar');
            const backdrop = document.getElementById('sidebar-backdrop');
            if (sidebar && sidebar.classList.contains('mobile-open')) {
                sidebar.classList.remove('mobile-open');
                if (backdrop) backdrop.classList.remove('active');
            }

            renderCatalog();
        }

        const GENRE_TRANSLATIONS = {
            'action': 'Ação',
            'action & adventure': 'Ação & Aventura',
            'action and adventure': 'Ação & Aventura',
            'adventure': 'Aventura',
            'animation': 'Animação',
            'anime': 'Anime',
            'comedy': 'Comédia',
            'crime': 'Crime',
            'documentary': 'Documentário',
            'drama': 'Drama',
            'family': 'Família',
            'fantasy': 'Fantasia',
            'history': 'História',
            'historical': 'Histórico',
            'horror': 'Terror',
            'kids': 'Infantil',
            'music': 'Música',
            'musical': 'Musical',
            'mystery': 'Mistério',
            'news': 'Notícias',
            'reality': 'Reality Show',
            'romance': 'Romance',
            'romantic': 'Romance',
            'science fiction': 'Ficção Científica',
            'sci-fi': 'Ficção Científica',
            'sci-fi & fantasy': 'Ficção & Fantasia',
            'sci-fi and fantasy': 'Ficção & Fantasia',
            'soap': 'Novela',
            'talk': 'Entrevistas',
            'thriller': 'Suspense',
            'tv movie': 'Cinema TV',
            'war': 'Guerra',
            'war & politics': 'Guerra & Política',
            'war and politics': 'Guerra & Política',
            'western': 'Faroeste',
            'short': 'Curta',
            'biography': 'Biografia',
            'sport': 'Esporte',
            'sports': 'Esporte',
            'dorama': 'Dorama',
            'k-drama': 'Dorama',
            'kdrama': 'Dorama'
        };

        function translateGenre(g) {
            if (!g) return '';
            const clean = String(g).trim();
            const lower = clean.toLowerCase();
            return GENRE_TRANSLATIONS[lower] || clean;
        }

        function isItemDorama(i) {
            if (!i) return false;
            // Flag explícita no banco de dados
            if (i.isDorama || i.is_dorama || i.tipo === 'dorama') return true;
            // Nunca classificar anime como dorama
            if (i.isAnime || i.is_anime || i.tipo === 'anime') return false;

            const gStr = (i.generos || []).join(' ').toLowerCase();
            const text = ((i.nome || '') + ' ' + (i.nomeOriginal || '')).toLowerCase();

            // K-Drama, C-Drama, J-Drama, Dorama — tag explícita no gênero ou título
            if (/dorama|k-drama|kdrama|c-drama|cdrama|j-drama|jdrama/i.test(gStr)) return true;
            if (/dorama|k-drama|kdrama|c-drama|cdrama|j-drama|jdrama/i.test(text)) return true;

            // Séries coreanas, chinesas, tailandesas, taiwanesas (live-action asiáticas)
            if (/corean|korean|chinese|china|thailand|thai|taiwanese|taiwan|asian drama/i.test(gStr)) return true;

            return false;
        }

        function isItemAnime(i) {
            if (!i) return false;
            // Live-actions de animes (ex: ONE PIECE: A Série) NUNCA são animes — são séries live-action
            const nameLower = (i.nome || '').toLowerCase();
            if (/live[- ]action|a série/i.test(nameLower) && !/anima/i.test(nameLower)) return false;

            // Flag explícita no banco de dados
            if (i.isAnime || i.is_anime || i.tipo === 'anime') return true;

            const gStr = (i.generos || []).join(' ').toLowerCase();
            const text = ((i.nome || '') + ' ' + (i.nomeOriginal || '')).toLowerCase();

            // Gênero explícito 'anime'
            if (gStr.includes('anime')) return true;

            // Nome/título contém 'anime'
            if (/\banime\b/i.test(text)) return true;

            // Séries animadas (Ranma 1/2, Blue Lock, Vinland Saga, Bleach, etc.)
            if (i.itemType === 'serie' && (gStr.includes('animação') || gStr.includes('animacao') || gStr.includes('animation') || gStr.includes('animated'))) {
                return true;
            }

            // Filmes de animação japonesa
            if ((gStr.includes('animação') || gStr.includes('animacao') || gStr.includes('animation')) && (/japon|japan/i.test(gStr) || i.origem === 'Japão' || i.origem === 'Japan')) {
                return true;
            }

            return false;
        }

        function getSerieSubtitleMeta(item) {
            if (!item) return '';
            const isSerie = (item.itemType === 'serie' || !!item.temporadas || item.tipo === 'serie');
            if (!isSerie) {
                return item.ano || '2026';
            }

            const tempCount = (item.temporadas && item.temporadas.length > 0)
                ? item.temporadas.length
                : (item.totalTemporadas || 1);

            let epCount = 0;
            if (item.temporadas && item.temporadas.length > 0) {
                epCount = item.temporadas.reduce((a, t) => {
                    const available = (t.episodios || []).filter(e => !e._isPending);
                    return a + available.length;
                }, 0);
            }
            if (epCount === 0) {
                epCount = 1;
            }

            const tempStr = `${tempCount} temp${tempCount > 1 ? 's' : ''}`;
            const epStr = `${epCount} ep${epCount > 1 ? 's' : ''}`;

            return `${tempStr} • ${epStr}`;
        }

        function resetAllCatalogFilters() {
            const defaultType = (currentNavMode && currentNavMode !== 'inicio')
                ? (currentNavMode === 'favoritos' ? 'favoritos' : currentNavMode)
                : 'todos';

            catalogFilters = {
                type: defaultType,
                audio: 'todos',
                quality: 'todos',
                genre: 'todos',
                sort: 'default'
            };

            const searchInput = document.getElementById('catalog-search');
            if (searchInput) searchInput.value = '';

            // Reseta visual dos botões no menu lateral
            document.querySelectorAll('.catalog-sidebar .filter-link, .catalog-sidebar .genre-tag-btn').forEach(link => {
                const val = link.getAttribute('data-val') || '';
                const filterKey = link.getAttribute('data-filter');
                if (filterKey === 'type') {
                    link.classList.toggle('active', val === defaultType || (defaultType === 'todos' && val === 'todos'));
                } else {
                    link.classList.toggle('active', val === 'todos');
                }
            });

            // Reseta sub-filtro de doramas
            activeDoramaSubtype = 'todos';
            document.querySelectorAll('#sidebar-filter-section-dorama .filter-link').forEach(link => {
                const val = link.getAttribute('data-dorama-subtype');
                link.classList.toggle('active', val === 'todos');
            });

            renderCatalog();
        }

        function toggleMobileSidebar() {
            const sidebar = document.getElementById('catalog-sidebar');
            const backdrop = document.getElementById('sidebar-backdrop');
            if (sidebar) {
                const isOpen = sidebar.classList.toggle('mobile-open');
                if (backdrop) backdrop.classList.toggle('active', isOpen);
            }
        }

        function filterByGenreDirect(genre) {
            closeModalDirect();
            switchTab('tab-catalogo');

            catalogFilters.genre = genre;

            // Destaca a tag correspondente na barra lateral
            document.querySelectorAll('#sidebar-genre-list .genre-tag-btn').forEach(link => {
                const val = link.getAttribute('data-val') || '';
                link.classList.toggle('active', val.toLowerCase() === genre.toLowerCase());
            });

            renderCatalog();

            const catElem = document.getElementById('tab-catalogo');
            if (catElem) {
                const _mainArea = document.getElementById('app-main-area');
                if (_mainArea) _mainArea.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        function filterCatalog() {
            renderCatalog();
        }

        function updateFilterCounts(baseList) {
            // Contagem por Tipo
            const countAll = baseList.length;
            const countAnimes = baseList.filter(i => isItemAnime(i)).length;
            const countDoramas = baseList.filter(i => isItemDorama(i) && !isItemAnime(i)).length;
            const countFilmes = baseList.filter(i => i.itemType === 'filme' && !isItemAnime(i)).length;
            const countSeries = baseList.filter(i => i.itemType === 'serie' && !isItemAnime(i) && !isItemDorama(i)).length;

            const elAll = document.getElementById('count-type-all');
            const elF = document.getElementById('count-type-filme');
            const elS = document.getElementById('count-type-serie');
            const elA = document.getElementById('count-type-anime');
            const elD = document.getElementById('count-type-dorama');
            if (elAll) elAll.innerText = countAll;
            if (elF) elF.innerText = countFilmes;
            if (elS) elS.innerText = countSeries;
            if (elA) elA.innerText = countAnimes;
            if (elD) elD.innerText = countDoramas;

            // Escopo para contagens secundárias (Áudio, Qualidade, Gêneros)
            // Se o usuário está em Doramas, as contagens de gênero e áudio são calculadas estritamente para Doramas
            let scopedItems = baseList;
            if (catalogFilters.type === 'filme') scopedItems = baseList.filter(i => i.itemType === 'filme' && !isItemAnime(i));
            else if (catalogFilters.type === 'serie') scopedItems = baseList.filter(i => i.itemType === 'serie' && !isItemAnime(i) && !isItemDorama(i));
            else if (catalogFilters.type === 'anime') scopedItems = baseList.filter(i => isItemAnime(i));
            else if (catalogFilters.type === 'dorama') scopedItems = baseList.filter(i => isItemDorama(i) && !isItemAnime(i));
            else if (catalogFilters.type === 'favoritos') scopedItems = baseList.filter(i => userFavorites.some(f => String(f.id) === String(i.id)));

            // Contagem por Áudio
            const countDub = scopedItems.filter(i => i.isDublado).length;
            const countLeg = scopedItems.filter(i => i.isLegendado).length;
            const elDub = document.getElementById('count-audio-dub');
            const elLeg = document.getElementById('count-audio-leg');
            if (elDub) elDub.innerText = countDub;
            if (elLeg) elLeg.innerText = countLeg;

            // Contagem por Qualidade
            const countCam = scopedItems.filter(i => i.isCam).length;
            const count1080 = scopedItems.filter(i => !i.isCam).length;
            const el1080 = document.getElementById('count-qual-1080');
            const elCam = document.getElementById('count-qual-cam');
            if (el1080) el1080.innerText = count1080;
            if (elCam) elCam.innerText = countCam;

            // Contagem por Gêneros
            const genreMap = {
                'Ação': 'count-genre-acao',
                'Comédia': 'count-genre-comedia',
                'Drama': 'count-genre-drama',
                'Ficção': 'count-genre-ficcao',
                'Terror': 'count-genre-terror',
                'Romance': 'count-genre-romance',
                'Suspense': 'count-genre-suspense',
                'Animação': 'count-genre-animacao',
                'Aventura': 'count-genre-aventura',
                'Crime': 'count-genre-crime',
                'Fantasia': 'count-genre-fantasia',
                'Documentário': 'count-genre-doc'
            };

            for (const [genreName, elemId] of Object.entries(genreMap)) {
                const count = scopedItems.filter(i => (i.generos || []).some(g => {
                    const ptG = translateGenre(g);
                    return ptG.toLowerCase().includes(genreName.toLowerCase()) || String(g).toLowerCase().includes(genreName.toLowerCase());
                })).length;
                const el = document.getElementById(elemId);
                if (el) el.innerText = count;
            }
        }

        function renderActiveChips(totalMatches) {
            const chipsBox = document.getElementById('catalog-active-chips');
            if (!chipsBox) return;

            let activeCountTotal = 0;
            let chipsHtml = '';

            if (catalogFilters.sort === 'em-alta') {
                activeCountTotal++;
                chipsHtml += `<span class="active-chip-tag" onclick="catalogFilters.sort='default';renderCatalog();">🔥 Em Alta ✕</span>`;
            }

            // Se o usuário está em uma aba do cabeçalho (ex: doramas), não mostra chip redundante de tipo,
            // a não ser que esteja no modo geral
            if (catalogFilters.type !== 'todos' && currentNavMode === 'inicio') {
                activeCountTotal++;
                const labels = { filme: 'Filmes', serie: 'Séries', anime: 'Animes', dorama: 'Doramas', favoritos: 'Minha Lista' };
                const icons = { filme: '🎬', serie: '📺', anime: '⛩️', dorama: '🌸', favoritos: '📌' };
                const icon = icons[catalogFilters.type] || '🎬';
                chipsHtml += `<span class="active-chip-tag" onclick="setCatalogFilter('type', 'todos')">${icon} ${labels[catalogFilters.type] || catalogFilters.type} ✕</span>`;
            }

            if (catalogFilters.audio !== 'todos') {
                activeCountTotal++;
                const labels = { dublado: 'Dublado', legendado: 'Legendado' };
                chipsHtml += `<span class="active-chip-tag" onclick="setCatalogFilter('audio', 'todos')">${labels[catalogFilters.audio] || catalogFilters.audio} ✕</span>`;
            }

            if (catalogFilters.quality !== 'todos') {
                activeCountTotal++;
                const labels = { '1080p': 'Alta Definição', cam: 'Versão CAM' };
                chipsHtml += `<span class="active-chip-tag" onclick="setCatalogFilter('quality', 'todos')">${labels[catalogFilters.quality] || catalogFilters.quality} ✕</span>`;
            }

            if (catalogFilters.genre !== 'todos') {
                activeCountTotal++;
                chipsHtml += `<span class="active-chip-tag" onclick="setCatalogFilter('genre', 'todos')">${catalogFilters.genre} ✕</span>`;
            }

            if (catalogFilters.type === 'dorama' && activeDoramaSubtype !== 'todos') {
                activeCountTotal++;
                const subLabels = { kdrama: '🇰🇷 K-Drama', cdrama: '🇨🇳 C-Drama', jdrama: '🇯🇵 J-Drama', microdrama: '📱 Micro-Séries' };
                chipsHtml += `<span class="active-chip-tag" onclick="filterDoramasSubtype('todos')">${subLabels[activeDoramaSubtype] || activeDoramaSubtype} ✕</span>`;
            }

            chipsBox.innerHTML = chipsHtml;

            const badge = document.getElementById('mobile-filter-badge');
            if (badge) badge.innerText = activeCountTotal;
        }


        let activeDoramaSubtype = 'todos';

        function filterDoramasSubtype(subtype, btn) {
            activeDoramaSubtype = subtype;
            document.querySelectorAll('#sidebar-filter-section-dorama .genre-tag-btn, #sidebar-filter-section-dorama .filter-link').forEach(p => p.classList.remove('active'));
            if (btn) {
                btn.classList.add('active');
            } else {
                const target = document.querySelector(`#sidebar-filter-section-dorama [data-dorama-subtype="${subtype}"]`);
                if (target) target.classList.add('active');
            }

            // Fecha sidebar no mobile se estiver aberta
            const sidebar = document.getElementById('catalog-sidebar');
            const backdrop = document.getElementById('sidebar-backdrop');
            if (sidebar && sidebar.classList.contains('mobile-open')) {
                sidebar.classList.remove('mobile-open');
                if (backdrop) backdrop.classList.remove('active');
            }

            renderCatalog();
        }

        function renderCatalog() {
            const searchInput = document.getElementById('catalog-search');
            const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
            const grid = document.getElementById('catalog-grid-container');
            const countText = document.getElementById('catalog-count-text');
            if (!grid) return;

            // Seção de sub-filtro de Doramas na sidebar aparece apenas na categoria Doramas
            const doramaSidebar = document.getElementById('sidebar-filter-section-dorama');
            if (doramaSidebar) {
                doramaSidebar.style.display = (catalogFilters.type === 'dorama') ? 'block' : 'none';
            }

            const baseList = [
                ...(fullCatalog.filmes || []).map(f => ({ ...f, itemType: 'filme' })),
                ...(fullCatalog.series || []).map(s => ({ ...s, itemType: 'serie' }))
            ];

            // Ordenação: se sort === 'em-alta', ordena por nota decrescente
            baseList.sort((a, b) => {
                if (catalogFilters.sort === 'em-alta') {
                    return (Number(b.nota) || 0) - (Number(a.nota) || 0);
                }
                const idA = Number(a.id) || 0;
                const idB = Number(b.id) || 0;
                if (idA && idB && idA !== idB) return idB - idA;
                const dateA = a.createdAt || a.dataAdicionado ? new Date(a.createdAt || a.dataAdicionado).getTime() : 0;
                const dateB = b.createdAt || b.dataAdicionado ? new Date(b.createdAt || b.dataAdicionado).getTime() : 0;
                return dateB - dateA;
            });

            // Atualiza contadores numéricos da barra lateral
            updateFilterCounts(baseList);

            let allItems = [...baseList];

            // 1. Filtro de Tipo
            if (catalogFilters.type === 'favoritos') {
                allItems = allItems.filter(i => userFavorites.some(f => String(f.id) === String(i.id)));
            } else if (catalogFilters.type === 'filme') {
                allItems = allItems.filter(i => i.itemType === 'filme' && !isItemAnime(i));
            } else if (catalogFilters.type === 'serie') {
                // Séries: exclui animes E doramas para evitar duplicatas entre abas
                allItems = allItems.filter(i => i.itemType === 'serie' && !isItemAnime(i) && !isItemDorama(i));
            } else if (catalogFilters.type === 'anime') {
                allItems = allItems.filter(i => isItemAnime(i));
            } else if (catalogFilters.type === 'dorama') {
                allItems = allItems.filter(i => isItemDorama(i) && !isItemAnime(i));
                if (activeDoramaSubtype === 'microdrama') {
                    allItems = allItems.filter(s => s.subtipo === 'microdrama' || s.isMicrodrama || s.formato === 'vertical' || (s.totalEpisodios >= 35 && s.tipo === 'dorama'));
                } else if (activeDoramaSubtype === 'kdrama') {
                    allItems = allItems.filter(s => s.origem === 'Coreia' || (!s.isMicrodrama && s.subtipo !== 'microdrama' && (s.generos || []).some(g => /coreia|kdrama|korean/i.test(g))));
                } else if (activeDoramaSubtype === 'cdrama') {
                    allItems = allItems.filter(s => (s.origem === 'China' || (s.generos || []).some(g => /china|cdrama|chinese/i.test(g))) && !s.isMicrodrama && s.subtipo !== 'microdrama');
                } else if (activeDoramaSubtype === 'jdrama') {
                    // J-Drama: séries live-action japonesas (não-anime, não-coreanas)
                    allItems = allItems.filter(s => {
                        const gStr = (s.generos || []).join(' ').toLowerCase();
                        return (s.origem === 'Japão' || s.origem === 'Japan' || /japan|japão/i.test(gStr)) &&
                            !gStr.includes('anime') && !(s.isAnime || s.is_anime);
                    });
                }
            }

            // 2. Filtro de Áudio
            if (catalogFilters.audio === 'dublado') allItems = allItems.filter(i => i.isDublado);
            else if (catalogFilters.audio === 'legendado') allItems = allItems.filter(i => i.isLegendado);

            // 3. Filtro de Qualidade
            if (catalogFilters.quality === '1080p') allItems = allItems.filter(i => !i.isCam);
            else if (catalogFilters.quality === 'cam') allItems = allItems.filter(i => i.isCam);

            // 4. Filtro de Gênero
            if (catalogFilters.genre && catalogFilters.genre !== 'todos') {
                allItems = allItems.filter(i => {
                    const generos = i.generos || [];
                    return generos.some(g => {
                        const ptG = translateGenre(g);
                        return ptG.toLowerCase().includes(catalogFilters.genre.toLowerCase()) || String(g).toLowerCase().includes(catalogFilters.genre.toLowerCase());
                    });
                });
            }

            // 5. Filtro de Busca por Texto
            if (query) {
                allItems = allItems.filter(i =>
                    (i.nome && i.nome.toLowerCase().includes(query)) ||
                    (i.nomeOriginal && i.nomeOriginal.toLowerCase().includes(query)) ||
                    (i.sinopse && i.sinopse.toLowerCase().includes(query)) ||
                    (i.generos && i.generos.some(g => String(g).toLowerCase().includes(query)))
                );

                // Registra busca na auditoria com debounce de 600ms
                if (query.length >= 2) {
                    trackAuditEventDebounced('SEARCH', {
                        title: query,
                        metadata: {
                            query,
                            resultsCount: String(allItems.length)
                        }
                    }, 600);
                }
            }

            // Renderiza chips ativos
            renderActiveChips(allItems.length);

            if (countText) {
                if (catalogFilters.sort === 'em-alta') {
                    countText.innerHTML = `Mostrando <strong>${allItems.length}</strong> títulos em alta (mais bem avaliados)`;
                } else {
                    const categoryNames = {
                        filme: 'filme(s)',
                        serie: 'série(s)',
                        anime: 'anime(s)',
                        dorama: 'dorama(s)',
                        favoritos: 'título(s) salvo(s)',
                        todos: 'título(s)'
                    };
                    const catLabel = categoryNames[catalogFilters.type] || 'título(s)';
                    countText.innerHTML = `Mostrando <strong>${allItems.length}</strong> ${catLabel}`;
                }
            }

            if (allItems.length === 0) {
                // Detecta se é uma busca por texto
                const _searchQ = (document.getElementById('catalog-search')?.value || '').trim();
                const _headerQ = (document.getElementById('header-search-input')?.value || '').trim();
                const _searchTerm = _searchQ || _headerQ;
                const _isSearch = !!_searchTerm;

                let emptyIcon = '🔍';
                let emptyTitle = _isSearch
                    ? `Ops, "${_searchTerm.length > 28 ? _searchTerm.substring(0, 28) + '…' : _searchTerm}" não está no catálogo ainda`
                    : 'Nenhum título encontrado';
                let emptyMsg = _isSearch
                    ? `Sentimos muito! Não encontramos <strong>"${_searchTerm.length > 40 ? _searchTerm.substring(0, 40) + '…' : _searchTerm}"</strong> no nosso catálogo.<br>Mas você pode pedir que a gente adicione — é rápido e fácil!`
                    : 'Não encontramos títulos com os filtros aplicados. Tente ajustar os filtros ou usar a busca.';
                let showRequestBtn = true;
                let requestPrefill = _searchTerm;
                let requestType = 'filme';

                if (catalogFilters.type === 'dorama') {
                    emptyIcon = '🌸';
                    if (!_isSearch) emptyTitle = 'Nenhum Dorama no momento';
                    if (!_isSearch) emptyMsg = 'Ainda não temos doramas ou K-dramas neste catálogo.<br>Que tal pedir o seu favorito?';
                    requestType = 'serie';
                } else if (catalogFilters.type === 'anime') {
                    emptyIcon = '⛩️';
                    if (!_isSearch) emptyTitle = 'Nenhum Anime encontrado';
                    if (!_isSearch) emptyMsg = 'Ainda não temos esse anime no catálogo.<br>Solicite e adicionamos pra você!';
                    requestType = 'serie';
                } else if (catalogFilters.type === 'favoritos') {
                    emptyIcon = '💜';
                    emptyTitle = 'Sua lista está vazia';
                    emptyMsg = 'Explore o catálogo e adicione filmes e séries à sua lista com o botão <strong>♡ Minha Lista</strong>!';
                    showRequestBtn = false;
                } else if (catalogFilters.type === 'filme') {
                    emptyIcon = '🎬';
                    if (!_isSearch) emptyTitle = 'Nenhum Filme encontrado';
                    if (!_isSearch) emptyMsg = 'Não encontramos filmes com esses filtros.<br>Que tal pedir um título novo?';
                    requestType = 'filme';
                } else if (catalogFilters.type === 'serie') {
                    emptyIcon = '📺';
                    if (!_isSearch) emptyTitle = 'Nenhuma Série encontrada';
                    if (!_isSearch) emptyMsg = 'Não encontramos séries com esses filtros.<br>Quer solicitar uma série nova?';
                    requestType = 'serie';
                }

                const _requestBtnHtml = showRequestBtn ? `
                        <button class="catalog-empty-btn-request" onclick="openRequestMediaModal('${requestPrefill.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', '${requestType}')">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Pedir este título
                        </button>` : '';

                const _clearBtnHtml = `<button class="catalog-empty-btn-clear" onclick="resetAllCatalogFilters()">Limpar filtros e voltar ao início</button>`;

                grid.innerHTML = `
                    <div class="catalog-empty-state">
                        <div class="catalog-empty-icon-wrap">
                            <div class="catalog-empty-icon-bg"></div>
                            <span class="catalog-empty-icon">${emptyIcon}</span>
                        </div>
                        <h3 class="catalog-empty-title">${emptyTitle}</h3>
                        <p class="catalog-empty-msg">${emptyMsg}</p>
                        <div class="catalog-empty-actions">
                            ${_requestBtnHtml}
                            ${_clearBtnHtml}
                        </div>
                    </div>
                    `;
                return;
            }

            grid.innerHTML = allItems.map((item) => {
                const poster = item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const isDub = item.isDublado || !!item.versoes?.dublado;
                const isLeg = item.isLegendado || !!item.versoes?.legendado;
                const badgeClass = item.isCam ? 'badge-cam-tag' : (isDub && isLeg ? 'badge-dual-tag' : (isDub ? 'badge-dub-tag' : 'badge-leg-tag'));
                const badgeText = item.isCam ? 'CAM' : (isDub && isLeg ? 'DUB/LEG' : (isDub ? 'DUB' : 'LEG'));
                const rating = item.nota ? Number(item.nota).toFixed(1) : '8.0';

                // Badge de categoria (só exibido na página Início, não em vistas filtradas)
                let catBadge = '';
                const _showCatBadge = (currentNavMode === 'inicio' || catalogFilters.type === 'todos');
                if (_showCatBadge) {
                    if (isItemAnime(item)) {
                        catBadge = `<div class="cat-badge cat-badge-anime">Anime</div>`;
                    } else if (isItemDorama(item)) {
                        catBadge = `<div class="cat-badge cat-badge-dorama">Dorama</div>`;
                    } else if (item.itemType === 'serie') {
                        catBadge = `<div class="cat-badge cat-badge-serie">Série</div>`;
                    } else {
                        catBadge = `<div class="cat-badge cat-badge-filme">Filme</div>`;
                    }
                }

                const isFav = userFavorites.some(f => String(f.id) === String(item.id));
                const favBtn = `<button class="btn-fav-card ${isFav ? 'active' : ''}" onclick="toggleUserFavorite('${item.id}', '${item.itemType}', event)" title="${isFav ? 'Remover da Minha Lista' : 'Adicionar à Minha Lista'}">${isFav ? '❤️' : '🤍'}</button>`;

                const isSerie = (item.itemType === 'serie' || !!item.temporadas);
                const subText = isSerie ? getSerieSubtitleMeta(item) : (item.itemType === 'filme' ? 'Filme' : (item.ano || '2026'));
                const genresPills = (item.generos || []).slice(0, 2).map(g => `<span class="genre-pill">${translateGenre(g)}</span>`).join('');

                return `
                    <div class="media-card" onclick="openModalById('${item.id}', '${item.itemType}')">
                        <div class="poster-wrapper">
                            <img class="poster-img" src="${poster}" alt="${escapeHtml(item.nome)}" loading="lazy" onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80'">
                            <span class="badge-overlay ${badgeClass}">${badgeText}</span>
                            ${catBadge}
                            ${favBtn}
                        </div>
                        <div class="media-content">
                            <h4 class="media-title" title="${item.nome}">${item.nome}</h4>
                            <div class="media-sub">
                                <span style="color: #fbbf24; font-weight: 700;">★ ${rating}</span>
                                <span>${item.ano || '2026'}</span>
                                <span>${subText}</span>
                            </div>
                            <div class="media-genres">
                                ${genresPills}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }

        /* ═══════════════════════════════════════════════════════════════════════
           🎬 OTT NETFLIX DESIGN SYSTEM & CAROUSEL RAILS
           ═══════════════════════════════════════════════════════════════════════ */

        let currentUser = null;
        let userAuthToken = null;
        let userFavorites = [];
        let userNotifs = [];
        let currentNavMode = 'inicio';

        function switchNavCategory(cat, updateUrl = true) {
            if (typeof closeWebPlayer === 'function') closeWebPlayer();
            currentNavMode = cat;
            currentDetailMedia = null;
            trackAuditEventDebounced('CATEGORY_VIEW', { title: `Categoria: ${cat}`, metadata: { category: cat } }, 500);
            document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));

            const tabMap = {
                inicio: 'tab-nav-inicio',
                filme: 'tab-nav-filmes',
                serie: 'tab-nav-series',
                dorama: 'tab-nav-doramas',
                anime: 'tab-nav-animes',
                favoritos: 'tab-nav-favoritos'
            };
            const targetBtn = document.getElementById(tabMap[cat]);
            if (targetBtn) targetBtn.classList.add('active');

            // Sincroniza sidebar esquerda do Mockup
            document.querySelectorAll('.sidebar-nav-item').forEach(b => b.classList.remove('active'));
            const sidebarBtn = document.getElementById('sidebar-item-' + cat);
            if (sidebarBtn) sidebarBtn.classList.add('active');

            // Fecha menu mobile ao navegar
            const mNav = document.getElementById('sidebar-nav');
            const mOverlay = document.getElementById('sidebar-mobile-overlay');
            if (mNav) mNav.classList.remove('mobile-open');
            if (mOverlay) mOverlay.classList.remove('active');
            document.body.style.overflow = '';

            localStorage.setItem('bf_active_nav', cat);
            localStorage.setItem('bf_active_tab', 'tab-catalogo');

            if (updateUrl) {
                const hashMap = {
                    inicio: '#inicio',
                    filme: '#filmes',
                    serie: '#series',
                    dorama: '#doramas',
                    anime: '#animes',
                    favoritos: '#minha-lista'
                };
                const targetHash = hashMap[cat] || '#inicio';
                if (window.location.pathname.startsWith('/admin')) {
                    history.replaceState(null, '', '/' + targetHash);
                } else if (window.location.hash !== targetHash) {
                    history.replaceState(null, '', targetHash);
                }
            }

            switchTab('tab-catalogo', false);

            const heroBox = document.getElementById('hero-billboard-container');
            const railsBox = document.getElementById('netflix-rails-container');
            const homeAdBox = document.getElementById('bf-home-bottom-ad');
            const homeNativeBox = document.getElementById('bf-native-home-wrapper');
            const gridLayout = document.getElementById('catalog-layout-grid');
            const typeFilterSection = document.getElementById('sidebar-filter-section-type');

            if (cat === 'inicio') {
                if (heroBox) heroBox.style.display = 'block';
                if (railsBox) railsBox.style.display = 'block';
                if (homeAdBox && typeof shouldHideBrasilFlixAds === 'function' && !shouldHideBrasilFlixAds()) homeAdBox.style.display = 'flex';
                if (homeNativeBox && typeof shouldHideBrasilFlixAds === 'function' && !shouldHideBrasilFlixAds()) homeNativeBox.style.display = 'block';
                if (gridLayout) gridLayout.style.display = 'none';
                if (typeFilterSection) typeFilterSection.style.display = 'block';
                catalogFilters.sort = 'default';
                renderHeroBillboard();
                renderNetflixRails();
            } else {
                if (heroBox) heroBox.style.display = 'none';
                if (railsBox) railsBox.style.display = 'none';
                if (homeAdBox) homeAdBox.style.display = 'none';
                if (homeNativeBox) homeNativeBox.style.display = 'none';
                if (gridLayout) gridLayout.style.display = 'flex';
                if (typeFilterSection) typeFilterSection.style.display = (cat === 'em-alta' || cat === 'todos') ? 'block' : 'none';
                const doramaSection = document.getElementById('sidebar-filter-section-dorama');
                if (doramaSection) doramaSection.style.display = (cat === 'dorama') ? 'block' : 'none';

                // Reseta filtros residuais para a nova categoria
                if (cat === 'em-alta') {
                    catalogFilters.type = 'todos';
                    catalogFilters.sort = 'em-alta';
                } else {
                    catalogFilters.type = (cat === 'favoritos') ? 'favoritos' : cat;
                    catalogFilters.sort = 'default';
                }
                catalogFilters.genre = 'todos';
                catalogFilters.audio = 'todos';
                catalogFilters.quality = 'todos';

                // Reseta sub-filtro de doramas
                activeDoramaSubtype = 'todos';
                document.querySelectorAll('#sidebar-filter-section-dorama .genre-tag-btn, #sidebar-filter-section-dorama .filter-link').forEach(p => p.classList.remove('active'));
                const todoDoramaLink = document.querySelector('#sidebar-filter-section-dorama [data-dorama-subtype="todos"]');
                if (todoDoramaLink) todoDoramaLink.classList.add('active');

                const searchInput = document.getElementById('catalog-search');
                if (searchInput) searchInput.value = '';

                // Sincroniza visual dos botões no menu lateral
                document.querySelectorAll('.catalog-sidebar .filter-link').forEach(link => {
                    const val = link.getAttribute('data-val') || '';
                    if (link.getAttribute('data-filter') === 'type') {
                        link.classList.toggle('active', val === cat || (cat === 'favoritos' && val === 'todos') || (cat === 'em-alta' && val === 'todos'));
                    } else {
                        link.classList.toggle('active', val === 'todos');
                    }
                });
                document.querySelectorAll('#sidebar-genre-list .genre-tag-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.getAttribute('data-val') === 'todos');
                });

                renderCatalog();
                const _mainAreaScroll = document.getElementById('app-main-area');
                if (_mainAreaScroll) _mainAreaScroll.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        function openRailSeeAll(railId) {
            if (railId === 'em-alta') {
                switchNavCategory('em-alta');
            } else if (railId === 'series-novas') {
                switchNavCategory('serie');
            } else if (railId === 'filmes-destaque') {
                switchNavCategory('filme');
            } else if (railId === 'doramas') {
                switchNavCategory('dorama');
            } else if (railId === 'animes') {
                switchNavCategory('anime');
            } else if (railId === 'minha-lista') {
                switchNavCategory('favoritos');
            } else {
                switchNavCategory('serie');
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 🎬 HERO BILLBOARD CAROUSEL & MODERN NETFLIX RAILS (MOCKUP ACCURATE)
        // ═══════════════════════════════════════════════════════════════════════

        let heroBillboardPool = [];
        let currentHeroIndex = 0;
        let currentSlidePosition = 1; // Posição virtual na esteira infinita (1 a N, 0 = clone do último, N+1 = clone do primeiro)
        let lastActiveRealIndex = -1;
        let heroIsPaused = false;
        const HERO_DURATION_MS = 10000; // 10 segundos por banner
        let heroTimer = null;
        let heroStartTime = 0;
        let heroRemainingMs = HERO_DURATION_MS;

        // FÍSICA E INTERAÇÃO DE ARRASTE (PC MOUSE E CELULAR TOUCH)
        let isHeroDragging = false;
        let heroDragStartX = 0;
        let heroDragStartY = 0;
        let heroDragDeltaX = 0;
        let heroDragDeltaY = 0;
        let heroWasDragged = false;
        let heroTrackEl = null;
        let heroViewportEl = null;

        function buildHeroSlideHtml(item, realIdx, isClone = false) {
            const backdrop = item.backdropUrl || item.posterUrl || '';
            const isFav = userFavorites.some(f => String(f.id) === String(item.id));
            const synopsis = item.sinopse || item.descricao || 'Assista agora com a melhor qualidade e áudio em português no BrasilFlix.';

            return `
                <div class="hero-slide hero-billboard" data-index="${realIdx}" ${isClone ? 'data-clone="true"' : ''}>
                    <div class="hero-billboard-bg" style="background-image: url('${backdrop}');"></div>
                    <div class="hero-content">
                        <h1 class="hero-title">${item.nome}</h1>
                        <p class="hero-synopsis">${synopsis}</p>
                        <div class="hero-actions">
                            <button class="hero-btn-play" onclick="handleHeroButtonClick(event, () => openModalById('${item.id}', '${item.itemType}'))">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                                <span>Assistir</span>
                            </button>
                            <button class="hero-btn-fav ${isFav ? 'active' : ''}" id="hero-fav-btn-${item.id}${isClone ? '-clone' : ''}" onclick="handleHeroButtonClick(event, () => toggleUserFavorite('${item.id}', '${item.itemType}', event))" title="${isFav ? 'Remover da Minha Lista' : 'Adicionar à Minha Lista'}">
                                <span class="hero-fav-icon">
                                    ${isFav ? `
                                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                                    ` : `
                                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                    `}
                                </span>
                                <span>${isFav ? 'Na Minha Lista' : 'Minha Lista'}</span>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }

        function renderHeroBillboard(customItem = null) {
            const container = document.getElementById('hero-billboard-container');
            if (!container) return;

            const allSeries = (fullCatalog.series || []).map(s => ({ ...s, itemType: 'serie' }));
            const allFilmes = (fullCatalog.filmes || []).map(f => ({ ...f, itemType: 'filme' }));
            const pool = [...allSeries, ...allFilmes];
            if (pool.length === 0) { container.innerHTML = ''; return; }

            const poolWithBackdrops = pool.filter(i => i.backdropUrl);
            heroBillboardPool = poolWithBackdrops.sort((a, b) => (Number(b.nota) || 0) - (Number(a.nota) || 0)).slice(0, 8);
            if (heroBillboardPool.length === 0) heroBillboardPool = pool.slice(0, 5);

            if (customItem) {
                const fIdx = heroBillboardPool.findIndex(i => String(i.id) === String(customItem.id));
                if (fIdx >= 0) currentHeroIndex = fIdx;
                else { heroBillboardPool.unshift(customItem); currentHeroIndex = 0; }
            }

            if (currentHeroIndex >= heroBillboardPool.length) currentHeroIndex = 0;

            const N = heroBillboardPool.length;
            currentSlidePosition = N > 1 ? (currentHeroIndex + 1) : 0;
            lastActiveRealIndex = -1;

            // Renderiza slides com clones virtuais nas pontas para looping infinito 100% contínuo
            let slidesHtml = '';
            if (N > 1) {
                const cloneLast = buildHeroSlideHtml(heroBillboardPool[N - 1], N - 1, true);
                const realSlides = heroBillboardPool.map((item, idx) => buildHeroSlideHtml(item, idx, false)).join('');
                const cloneFirst = buildHeroSlideHtml(heroBillboardPool[0], 0, true);
                slidesHtml = cloneLast + realSlides + cloneFirst;
            } else {
                slidesHtml = heroBillboardPool.map((item, idx) => buildHeroSlideHtml(item, idx, false)).join('');
            }

            // Barras de progresso do carrossel (segmentos reais)
            const barsHtml = heroBillboardPool.map((_, idx) => `
                <div class="hero-progress-seg ${idx < currentHeroIndex ? 'done' : (idx === currentHeroIndex ? 'active' : '')}"
                     onclick="goToHeroSlide(${idx}, event)" title="${heroBillboardPool[idx].nome}">
                    <div class="hero-progress-fill" id="hero-prog-fill-${idx}"></div>
                </div>
            `).join('');

            container.innerHTML = `
                <div class="hero-wrapper" id="hero-wrapper" onmouseenter="pauseHeroCarousel()" onmouseleave="resumeHeroCarousel()">
                    <!-- BOTÕES DE NAVEGAÇÃO LATERAL (DESKTOP: FORA DO BANNER) -->
                    <button class="hero-arrow-btn hero-arrow-left" onclick="prevHeroSlide(event)" title="Anterior" aria-label="Anterior">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="15 18 9 12 15 6"/></svg>
                    </button>
                    <button class="hero-arrow-btn hero-arrow-right" onclick="nextHeroSlide(event)" title="Próximo" aria-label="Próximo">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>

                    <!-- JANELA DO CARROSSEL COM ARRASTE SUAVE (PC + CELULAR) -->
                    <div class="hero-viewport" id="hero-viewport"
                         onmousedown="handleHeroDragStart(event)"
                         ontouchstart="handleHeroDragStart(event)">
                        <div class="hero-slider-track" id="hero-slider-track">
                            ${slidesHtml}
                        </div>

                        <!-- BARRAS DE PROGRESSO DO CARROSSEL (FLUIDAS A 60FPS VIA GPU) -->
                        <div class="hero-bottom-controls">
                            <div class="hero-progress-bar-row" id="hero-progress-bar-row">
                                ${barsHtml}
                            </div>
                        </div>
                    </div>
                </div>
            `;

            heroTrackEl = document.getElementById('hero-slider-track');
            heroViewportEl = document.getElementById('hero-viewport');

            if (heroTrackEl) {
                heroTrackEl.removeEventListener('transitionend', handleHeroTransitionEnd);
                heroTrackEl.addEventListener('transitionend', handleHeroTransitionEnd);
            }

            updateHeroSliderPosition(false);
        }

        function handleHeroTransitionEnd(e) {
            if (e && e.propertyName !== 'transform') return;
            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N <= 1) return;

            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');
            if (!heroTrackEl) return;

            // Se navegou para frente do último para o clone do primeiro (posição N + 1):
            // Salta instantaneamente sem transição para a posição 1 real (mesmo slide exato)
            if (currentSlidePosition >= N + 1) {
                heroTrackEl.style.transition = 'none';
                currentSlidePosition = 1;
                heroTrackEl.style.transform = `translateX(-100%)`;
                void heroTrackEl.offsetWidth; // Força reflow no browser
            }
            // Se retrocedeu antes do primeiro para o clone do último (posição 0):
            // Salta instantaneamente sem transição para a posição N real (mesmo slide exato)
            else if (currentSlidePosition <= 0) {
                heroTrackEl.style.transition = 'none';
                currentSlidePosition = N;
                heroTrackEl.style.transform = `translateX(-${N * 100}%)`;
                void heroTrackEl.offsetWidth; // Força reflow no browser
            }
        }

        function updateHeroSliderPosition(smooth = true) {
            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');
            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N === 0) return;

            if (heroTrackEl) {
                heroTrackEl.style.transition = smooth ? 'transform 0.45s cubic-bezier(0.25, 1, 0.5, 1)' : 'none';
                const pos = N > 1 ? currentSlidePosition : 0;
                heroTrackEl.style.transform = `translateX(-${pos * 100}%)`;
            }

            // Calcula o índice real (0 a N-1) correspondente à posição atual para as barras de progresso
            let activeRealIndex = 0;
            if (N > 1) {
                if (currentSlidePosition === 0) {
                    activeRealIndex = N - 1;
                } else if (currentSlidePosition >= N + 1) {
                    activeRealIndex = 0;
                } else {
                    activeRealIndex = currentSlidePosition - 1;
                }
            } else {
                activeRealIndex = 0;
            }
            currentHeroIndex = activeRealIndex;

            // Atualiza as barras de progresso apenas se o índice real mudou (evita reset ao pular clones)
            const realIndexChanged = (activeRealIndex !== lastActiveRealIndex);
            lastActiveRealIndex = activeRealIndex;

            if (realIndexChanged) {
                const segs = document.querySelectorAll('.hero-progress-seg');
                segs.forEach((seg, idx) => {
                    const fill = seg.querySelector('.hero-progress-fill');
                    seg.classList.remove('done', 'active');
                    if (fill) {
                        fill.style.animation = 'none';
                        fill.style.transform = '';
                        void fill.offsetWidth; // Força reflow limpo
                    }
                    if (idx < activeRealIndex) {
                        seg.classList.add('done');
                    } else if (idx === activeRealIndex) {
                        seg.classList.add('active');
                        if (fill) {
                            fill.style.animation = `heroProgressAnim ${HERO_DURATION_MS}ms linear forwards`;
                        }
                    }
                });

                heroRemainingMs = HERO_DURATION_MS;
                startHeroCarouselTimer();
            }
        }

        function startHeroCarouselTimer() {
            clearTimeout(heroTimer);
            if (heroIsPaused) return;

            heroStartTime = Date.now();

            heroTimer = setTimeout(() => {
                if (!heroIsPaused && !isHeroDragging) {
                    nextHeroSlide();
                }
            }, heroRemainingMs);
        }

        function pauseHeroCarousel() {
            if (heroIsPaused) return;
            heroIsPaused = true;
            clearTimeout(heroTimer);
            const elapsed = Date.now() - heroStartTime;
            heroRemainingMs = Math.max(800, heroRemainingMs - elapsed);
            const wrapper = document.getElementById('hero-wrapper');
            if (wrapper) wrapper.classList.add('is-paused');
        }

        function resumeHeroCarousel() {
            if (!heroIsPaused) return;
            heroIsPaused = false;
            const wrapper = document.getElementById('hero-wrapper');
            if (wrapper) wrapper.classList.remove('is-paused');

            clearTimeout(heroTimer);
            heroStartTime = Date.now();
            heroTimer = setTimeout(() => {
                if (!heroIsPaused && !isHeroDragging) {
                    nextHeroSlide();
                }
            }, heroRemainingMs);
        }

        // FÍSICA DO CARROSSEL: ARRASTAR NO PC (MOUSE) E CELULAR (TOUCH) COM MOVIMENTO REAL E LOOP INFINITO
        function handleHeroDragStart(e) {
            const target = e.target;
            if (target && target.closest('.hero-progress-seg')) {
                return; // Clique direto nas barras não inicia arraste
            }

            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N <= 1) return;

            isHeroDragging = true;
            heroWasDragged = false;
            pauseHeroCarousel();

            const pt = e.touches ? e.touches[0] : e;
            heroDragStartX = pt.clientX;
            heroDragStartY = pt.clientY;
            heroDragDeltaX = 0;
            heroDragDeltaY = 0;

            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');
            if (heroTrackEl) {
                // Antes de arrastar, se estava em clone, reseta silenciosamente para o slide real equivalente
                if (currentSlidePosition >= N + 1) {
                    heroTrackEl.style.transition = 'none';
                    currentSlidePosition = 1;
                    heroTrackEl.style.transform = `translateX(-100%)`;
                    void heroTrackEl.offsetWidth;
                } else if (currentSlidePosition <= 0) {
                    heroTrackEl.style.transition = 'none';
                    currentSlidePosition = N;
                    heroTrackEl.style.transform = `translateX(-${N * 100}%)`;
                    void heroTrackEl.offsetWidth;
                }
                heroTrackEl.style.transition = 'none';
            }

            if (!e.touches) {
                // Previne arraste fantasma nativo do browser em imagens/textos
                if (target && !target.closest('button') && !target.closest('a')) {
                    e.preventDefault();
                }
                window.addEventListener('mousemove', handleHeroDragMove);
                window.addEventListener('mouseup', handleHeroDragEnd);
            } else {
                window.addEventListener('touchmove', handleHeroDragMove, { passive: false });
                window.addEventListener('touchend', handleHeroDragEnd);
            }
        }

        function handleHeroDragMove(e) {
            if (!isHeroDragging) return;
            const pt = e.touches ? e.touches[0] : e;
            heroDragDeltaX = pt.clientX - heroDragStartX;
            heroDragDeltaY = pt.clientY - heroDragStartY;

            // Se for movimento primordialmente vertical no touch, permite scroll normal da tela
            if (e.touches && Math.abs(heroDragDeltaY) > Math.abs(heroDragDeltaX) && Math.abs(heroDragDeltaX) < 12) {
                return;
            }

            if (Math.abs(heroDragDeltaX) > 6) {
                heroWasDragged = true;
                if (e.cancelable && e.touches) {
                    e.preventDefault();
                }
            }

            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');
            if (heroTrackEl) {
                // Arraste contínuo infinito: o usuário pode arrastar suavemente em qualquer direção
                heroTrackEl.style.transform = `translateX(calc(-${currentSlidePosition * 100}% + ${heroDragDeltaX}px))`;
            }
        }

        function handleHeroDragEnd(e) {
            if (!isHeroDragging) return;
            isHeroDragging = false;

            window.removeEventListener('mousemove', handleHeroDragMove);
            window.removeEventListener('mouseup', handleHeroDragEnd);
            window.removeEventListener('touchmove', handleHeroDragMove);
            window.removeEventListener('touchend', handleHeroDragEnd);

            const threshold = 50; // Sensibilidade do arraste em pixels
            if (heroDragDeltaX < -threshold) {
                nextHeroSlide();
            } else if (heroDragDeltaX > threshold) {
                prevHeroSlide();
            } else {
                updateHeroSliderPosition(true);
            }

            setTimeout(() => {
                heroWasDragged = false;
                resumeHeroCarousel();
            }, 80);
        }

        function handleHeroButtonClick(e, fn) {
            if (e) e.stopPropagation();
            if (heroWasDragged) return; // Se arrastou, não clica no botão acidentalmente
            if (typeof fn === 'function') fn(e);
        }

        function nextHeroSlide(e) {
            if (e) e.stopPropagation();
            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N <= 1) return;

            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');

            // Se já estava no clone do primeiro (slide N+1), salta instantaneamente para o slide 1 real
            if (currentSlidePosition >= N + 1) {
                if (heroTrackEl) {
                    heroTrackEl.style.transition = 'none';
                    heroTrackEl.style.transform = 'translateX(-100%)';
                    void heroTrackEl.offsetWidth;
                }
                currentSlidePosition = 1;
            }

            currentSlidePosition++;
            updateHeroSliderPosition(true);
        }

        function prevHeroSlide(e) {
            if (e) e.stopPropagation();
            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N <= 1) return;

            if (!heroTrackEl) heroTrackEl = document.getElementById('hero-slider-track');

            // Se já estava no clone do último (slide 0), salta instantaneamente para o slide N real
            if (currentSlidePosition <= 0) {
                if (heroTrackEl) {
                    heroTrackEl.style.transition = 'none';
                    heroTrackEl.style.transform = `translateX(-${N * 100}%)`;
                    void heroTrackEl.offsetWidth;
                }
                currentSlidePosition = N;
            }

            currentSlidePosition--;
            updateHeroSliderPosition(true);
        }

        function goToHeroSlide(index, e) {
            if (e) e.stopPropagation();
            const N = heroBillboardPool ? heroBillboardPool.length : 0;
            if (N <= 1) return;
            if (index >= 0 && index < N) {
                currentSlidePosition = index + 1;
                updateHeroSliderPosition(true);
            }
        }

        function createRailHtml(railId, title, items, badgeType = null) {
            if (!items || items.length === 0) return '';

            const cardsHtml = items.map(item => {
                const poster = item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const rating = item.nota ? Number(item.nota).toFixed(1) : '8.5';
                const isFav = userFavorites.some(f => String(f.id) === String(item.id));
                const isDub = item.isDublado;
                const isAnime = isItemAnime(item);
                const isDorama = isItemDorama(item);
                const isSerie = (item.itemType === 'serie' || !!item.temporadas);
                const sub = isSerie ? getSerieSubtitleMeta(item) : (item.ano || '2024');

                // Badge de tipo no poster conforme mockup
                let typeBadgeText = 'FILME';
                let typeBadgeClass = 'badge-type-filme';
                if (isAnime) {
                    typeBadgeText = 'ANIME';
                    typeBadgeClass = 'badge-type-anime';
                } else if (isDorama) {
                    typeBadgeText = 'DORAMA';
                    typeBadgeClass = 'badge-type-dorama';
                } else if (isSerie) {
                    typeBadgeText = 'SÉRIE';
                    typeBadgeClass = 'badge-type-serie';
                }

                let badgeHtml = `<span class="rail-type-badge ${typeBadgeClass}">${typeBadgeText}</span>`;
                if (badgeType === 'new_ep') {
                    badgeHtml = '<div class="badge-new-ep">Novo Ep</div>';
                } else if (item.isCam) {
                    badgeHtml = '<div class="badge-new-ep" style="background: #f59e0b;">CAM</div>';
                }

                return `
                    <div class="rail-card" onclick="openModalById('${item.id}', '${item.itemType}')">
                        <div class="rail-poster-wrapper">
                            <img src="${poster}" class="rail-poster-img" loading="lazy" alt="${escapeHtml(item.nome)}">
                            ${badgeHtml}
                            <button class="btn-fav-card ${isFav ? 'active' : ''}" onclick="toggleUserFavorite('${item.id}', '${item.itemType}', event)" title="${isFav ? 'Remover dos Favoritos' : 'Adicionar aos Favoritos'}">
                                ${isFav ? '❤️' : '🤍'}
                            </button>
                        </div>
                        <div class="rail-content">
                            <h4 class="rail-card-title">${item.nome}</h4>
                            <div class="rail-card-sub">
                                <span style="color: #fbbf24; font-weight: 800;">★ ${rating}</span>
                                <span>${sub}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="netflix-rail-section" id="rail-section-${railId}">
                    <div class="rail-header">
                        <h3 class="rail-title">${title}</h3>
                        <span class="rail-see-all" onclick="openRailSeeAll('${railId}')">Ver tudo →</span>
                    </div>
                    <div class="rail-slider-container">
                        <button class="rail-arrow-btn rail-arrow-left" onclick="slideRail('${railId}', -1)" aria-label="Anterior">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                        <div class="rail-slider-track" id="track-${railId}">
                            ${cardsHtml}
                        </div>
                        <button class="rail-arrow-btn rail-arrow-right" onclick="slideRail('${railId}', 1)" aria-label="Próximo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }

        function slideRail(railId, direction) {
            const track = document.getElementById(`track-${railId}`);
            if (track) {
                const scrollAmount = track.clientWidth * 0.75 * direction;
                track.scrollBy({ left: scrollAmount, behavior: 'smooth' });
            }
        }

        function getContinueWatchingItems() {
            if (!userWatchProgress || Object.keys(userWatchProgress).length === 0) return [];
            const allFilmes = (fullCatalog.filmes || []).map(f => ({ ...f, itemType: 'filme' }));
            const allSeries = (fullCatalog.series || []).map(s => ({ ...s, itemType: 'serie' }));
            const allItems = [...allSeries, ...allFilmes];

            const continueList = [];

            for (const mediaId of Object.keys(userWatchProgress)) {
                const item = allItems.find(i => String(i.id) === String(mediaId));
                if (!item) continue;

                const mProg = userWatchProgress[mediaId];
                const isSerie = (item.itemType === 'serie' || !!item.temporadas);

                if (isSerie) {
                    if (!item.temporadas || item.temporadas.length === 0) continue;
                    const allEps = [];
                    for (const t of item.temporadas) {
                        for (const ep of (t.episodios || [])) {
                            allEps.push({ season: t.numero, episode: ep.numero, name: ep.nome || `Episódio ${ep.numero}` });
                        }
                    }

                    // 1. Procura se há algum episódio em andamento
                    let inProg = null;
                    for (const ep of allEps) {
                        const epP = mProg.episodes ? mProg.episodes[`${ep.season}_${ep.episode}`] : null;
                        if (epP && !epP.completed && epP.currentTime >= 30) {
                            if (epP.duration > 60 && (epP.currentTime >= (epP.duration * 0.90) || (epP.duration - epP.currentTime <= 90))) {
                                continue;
                            }
                            inProg = { ...ep, currentTime: epP.currentTime, duration: epP.duration, lastWatchedAt: epP.lastWatchedAt };
                            break;
                        }
                    }

                    if (inProg) {
                        const dur = inProg.duration || 45 * 60;
                        const pct = dur > 0 ? Math.min(99, Math.max(5, Math.round((inProg.currentTime / dur) * 100))) : 50;
                        const remainSec = Math.max(0, dur - inProg.currentTime);
                        const remainMin = Math.max(1, Math.round(remainSec / 60));
                        const sub = `T${inProg.season} • Ep. ${inProg.episode}`;

                        continueList.push({
                            ...item,
                            isContinueSerie: true,
                            targetSeason: inProg.season,
                            targetEp: inProg.episode,
                            pct,
                            subText: sub,
                            badgeTime: `T${inProg.season}:E${inProg.episode}`,
                            lastWatchedAt: inProg.lastWatchedAt || new Date().toISOString()
                        });
                    } else {
                        // 2. Se o último assistido foi concluído, sugere o próximo episódio
                        let lastCompIdx = -1;
                        let lastWatchedTime = null;
                        for (let i = 0; i < allEps.length; i++) {
                            const ep = allEps[i];
                            const epP = mProg.episodes ? mProg.episodes[`${ep.season}_${ep.episode}`] : null;
                            if (epP && epP.completed) {
                                lastCompIdx = i;
                                lastWatchedTime = epP.lastWatchedAt;
                            }
                        }

                        if (lastCompIdx >= 0 && (lastCompIdx + 1 < allEps.length)) {
                            const nextEp = allEps[lastCompIdx + 1];
                            continueList.push({
                                ...item,
                                isContinueSerie: true,
                                targetSeason: nextEp.season,
                                targetEp: nextEp.episode,
                                pct: 0,
                                subText: `T${nextEp.season} • Ep. ${nextEp.episode}`,
                                badgeTime: `T${nextEp.season}:E${nextEp.episode}`,
                                lastWatchedAt: lastWatchedTime || new Date().toISOString()
                            });
                        }
                    }
                } else {
                    // Filme
                    const fProg = (mProg.episodes ? mProg.episodes['0_0'] : null) || mProg.lastWatched;
                    if (fProg && !fProg.completed && fProg.currentTime >= 30) {
                        const dur = fProg.duration || 100 * 60;
                        if (dur > 60 && (fProg.currentTime >= (dur * 0.90) || (dur - fProg.currentTime <= 90))) {
                            continue;
                        }
                        const pct = dur > 0 ? Math.min(99, Math.max(5, Math.round((fProg.currentTime / dur) * 100))) : 50;
                        const remainSec = Math.max(0, dur - fProg.currentTime);
                        const remainMin = Math.max(1, Math.round(remainSec / 60));
                        const sub = `${remainMin} min restantes`;

                        continueList.push({
                            ...item,
                            isContinueSerie: false,
                            targetSeason: 0,
                            targetEp: 0,
                            pct,
                            subText: sub,
                            badgeTime: `${Math.floor(fProg.currentTime / 60)}m`,
                            lastWatchedAt: fProg.lastWatchedAt || new Date().toISOString()
                        });
                    }
                }
            }

            return continueList.sort((a, b) => new Date(b.lastWatchedAt).getTime() - new Date(a.lastWatchedAt).getTime()).slice(0, 16);
        }

        function createContinueWatchingRailHtml(items) {
            if (!items || items.length === 0) return '';

            const cardsHtml = items.map(item => {
                const thumb = item.backdropUrl || item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const isSerie = item.isContinueSerie;
                const clickAction = isSerie
                    ? `openWebPlayerEpisode('${item.id}', ${item.targetSeason}, ${item.targetEp})`
                    : `openWebPlayerForMovie('${item.id}')`;

                return `
                    <div class="rail-card rail-card-continue" onclick="${clickAction}">
                        <div class="rail-continue-thumb-box">
                            <img src="${thumb}" class="rail-continue-img" loading="lazy" alt="${escapeHtml(item.nome)}">
                            <div class="rail-continue-play-circle">▶</div>
                            <button class="btn-dismiss-continue" onclick="dismissContinueWatchingItem('${item.id}', event)" title="Remover de Continuar Assistindo">✕</button>
                        </div>
                        <div class="rail-continue-body">
                            <h4 class="rail-continue-title" title="${item.nome}">${item.nome}</h4>
                            <div class="rail-continue-ep">${item.subText}</div>
                            <div class="rail-continue-progress-row">
                                <div class="rail-continue-bar-bg">
                                    <div class="rail-continue-bar-fill" style="width: ${item.pct}%;"></div>
                                </div>
                                <span class="rail-continue-pct-text">${item.pct}%</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="netflix-rail-section" id="rail-section-continue-watching" style="margin-bottom: 30px;">
                    <div class="rail-header">
                        <h3 class="rail-title">
                            <span style="color: #10b981;">▶</span> Continuar Assistindo
                        </h3>
                        <span class="rail-see-all" onclick="openRailSeeAll('continue-watching')">Ver tudo →</span>
                    </div>
                    <div class="rail-slider-container">
                        <button class="rail-arrow-btn rail-arrow-left" onclick="slideRail('continue-watching', -1)" aria-label="Anterior">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                        <div class="rail-slider-track" id="track-continue-watching">
                            ${cardsHtml}
                        </div>
                        <button class="rail-arrow-btn rail-arrow-right" onclick="slideRail('continue-watching', 1)" aria-label="Próximo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                    </div>
                </div>
            `;
        }

        async function dismissContinueWatchingItem(mediaId, event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }

            const mId = String(mediaId);
            delete userWatchProgress[mId];

            renderNetflixRails();
            showToast('Item removido de "Continuar Assistindo".', 'info');

            try {
                const headers = { 'Content-Type': 'application/json', 'x-guest-token': getGuestToken() };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;
                await fetch('/api/progress/dismiss', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ mediaId: mId })
                });
            } catch (err) { }
        }

        function renderNetflixRails() {
            const container = document.getElementById('netflix-rails-container');
            if (!container) return;

            const allFilmes = (fullCatalog.filmes || []).map(f => ({ ...f, itemType: 'filme' }));
            const allSeries = (fullCatalog.series || []).map(s => ({ ...s, itemType: 'serie' }));
            const allCombined = [...allSeries, ...allFilmes];

            // 1. Em Alta (Mais Populares / Maiores Notas) - Topo do carrossel no mockup!
            const emAlta = [...allCombined].sort((a, b) => (Number(b.nota) || 0) - (Number(a.nota) || 0)).slice(0, 16);

            // 2. Continue de onde parou (Filmes e Séries em andamento)
            const continueItems = getContinueWatchingItems();

            // 3. Novos Lançamentos
            const novosLancamentos = [...allCombined].sort((a, b) => (Number(b.ano) || 0) - (Number(a.ano) || 0)).slice(0, 16);

            // 4. Séries em Destaque (exclui animes e doramas)
            const seriesRecentes = allSeries.filter(s => !isItemAnime(s) && !isItemDorama(s)).slice(0, 16);

            // 5. Filmes em Destaque
            const filmesDestaque = allFilmes.filter(f => !f.isCam && !isItemAnime(f)).slice(0, 16);

            // 6. Doramas & Séries Asiáticas (K-Drama, C-Drama, J-Drama)
            const doramas = allSeries.filter(s => isItemDorama(s) && !isItemAnime(s)).slice(0, 16);

            // 7. Animes (somente animações japonesas)
            const animes = allSeries.filter(s => isItemAnime(s)).slice(0, 16);

            // 8. Minha Lista
            const meusFavoritos = allCombined.filter(i => userFavorites.some(f => String(f.id) === String(i.id)));

            let railsHtml = '';

            // 1. Em Alta no topo absoluto (conforme Mockup)
            railsHtml += createRailHtml('em-alta', '🔥 Em Alta', emAlta);

            // 2. Continuar Assistindo (logo após Em Alta, conforme Mockup)
            if (continueItems.length > 0) {
                railsHtml += createContinueWatchingRailHtml(continueItems);
            }

            // 3. Novos Lançamentos (conforme Mockup)
            railsHtml += createRailHtml('novos-lancamentos', 'Novos Lançamentos', novosLancamentos);

            // 4. Séries em Destaque
            if (seriesRecentes.length > 0) {
                railsHtml += createRailHtml('series-novas', 'Séries Populares', seriesRecentes, 'new_ep');
            }

            // 5. Filmes Populares
            if (filmesDestaque.length > 0) {
                railsHtml += createRailHtml('filmes-destaque', 'Filmes Populares', filmesDestaque);
            }

            // 6. Doramas
            if (doramas.length > 0) {
                railsHtml += createRailHtml('doramas', 'Doramas & Séries Asiáticas', doramas);
            }

            // 7. Animes
            if (animes.length > 0) {
                railsHtml += createRailHtml('animes', 'Animes em Destaque', animes);
            }

            // 8. Minha Lista (se tiver)
            if (meusFavoritos.length > 0) {
                railsHtml += createRailHtml('minha-lista', 'Minha Lista', meusFavoritos);
            }

            container.innerHTML = railsHtml;
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 🔍 HEADER SEARCH & SIDEBAR FILTERS (MOCKUP ACCURATE)
        // ═══════════════════════════════════════════════════════════════════════

        // ─── PALAVRAS-CHAVE DE CATEGORIA que a busca do header reconhece ───
        const _searchCategoryKeywords = {
            'anime': 'anime', 'animes': 'anime',
            'dorama': 'dorama', 'doramas': 'dorama', 'kdrama': 'dorama', 'k-drama': 'dorama',
            'serie': 'serie', 'series': 'serie', 'séries': 'serie', 'série': 'serie',
            'filme': 'filme', 'filmes': 'filme',
            'favoritos': 'favoritos', 'minha lista': 'favoritos',
            'em alta': 'em-alta', 'alta': 'em-alta', 'populares': 'em-alta'
        };

        // Gêneros reconhecidos na busca do header (sem acento e com acento)
        const _searchGenreKeywords = [
            { terms: ['acao', 'ação', 'action'], genre: 'Ação' },
            { terms: ['comedia', 'comédia', 'comedy'], genre: 'Comédia' },
            { terms: ['drama'], genre: 'Drama' },
            { terms: ['terror', 'horror'], genre: 'Terror' },
            { terms: ['romance'], genre: 'Romance' },
            { terms: ['suspense', 'thriller'], genre: 'Suspense' },
            { terms: ['aventura', 'adventure'], genre: 'Aventura' },
            { terms: ['fantasia', 'fantasy'], genre: 'Fantasia' },
            { terms: ['crime', 'policial'], genre: 'Crime' },
            { terms: ['ficcao', 'ficção', 'sci-fi', 'scifi', 'ficcão'], genre: 'Ficção' },
            { terms: ['documentario', 'documentário', 'doc'], genre: 'Documentário' },
            { terms: ['animacao', 'animação', 'cartoon'], genre: 'Animação' },
        ];

        let _headerSearchTimer = null;
        function onHeaderSearchInput(query) {
            clearTimeout(_headerSearchTimer);
            const q = (query || '').trim();

            // ⛔ Não interrompe o player: se o player está ativo, não navega
            const isPlayerActive = document.getElementById('tab-playback-page')?.classList.contains('active') || !!currentPlayingMedia;
            if (isPlayerActive && q) {
                // Apenas sincroniza o campo lateral sem navegar
                const sideSearch = document.getElementById('sidebar-search-input');
                if (sideSearch && sideSearch.value !== (query || '')) {
                    sideSearch.value = query || '';
                }
                return;
            }

            const sideSearch = document.getElementById('sidebar-search-input');
            if (sideSearch && sideSearch.value !== (query || '')) {
                sideSearch.value = query || '';
            }

            // Bloqueia autofill do navegador que tenta preencher 'admin' sem foco do usuário
            if (q.toLowerCase() === 'admin' && document.activeElement !== document.getElementById('header-search-input')) {
                const searchEl = document.getElementById('header-search-input');
                if (searchEl) searchEl.value = '';
                return;
            }

            if (!q) {
                // Campo vazio — volta para o estado anterior
                if (currentNavMode === 'inicio') {
                    switchNavCategory('inicio');
                } else {
                    catalogFilters.searchQuery = '';
                    const searchInput = document.getElementById('catalog-search');
                    if (searchInput) searchInput.value = '';
                    renderCatalog();
                }
                return;
            }

            _headerSearchTimer = setTimeout(() => {
                const lq = q.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

                // 1. Verifica palavra-chave de CATEGORIA (navega direto)
                const catMatch = _searchCategoryKeywords[lq] || _searchCategoryKeywords[q.toLowerCase()];
                if (catMatch) {
                    switchNavCategory(catMatch);
                    return;
                }

                // 2. Verifica palavra-chave de GÊNERO
                let genreMatch = null;
                for (const g of _searchGenreKeywords) {
                    if (g.terms.some(t => lq === t || lq.startsWith(t))) {
                        genreMatch = g.genre;
                        break;
                    }
                }
                if (genreMatch) {
                    filterBySidebarGenre(genreMatch);
                    return;
                }

                // 3. Busca de texto livre em tempo real
                const heroBox = document.getElementById('hero-billboard-container');
                const railsBox = document.getElementById('netflix-rails-container');
                const gridLayout = document.getElementById('catalog-layout-grid');
                const homeAdBox = document.getElementById('bf-home-bottom-ad');
                const homeNativeBox = document.getElementById('bf-native-home-wrapper');
                if (heroBox) heroBox.style.display = 'none';
                if (railsBox) railsBox.style.display = 'none';
                if (homeAdBox) homeAdBox.style.display = 'none';
                if (homeNativeBox) homeNativeBox.style.display = 'none';
                if (gridLayout) gridLayout.style.display = 'flex';

                // Busca global: não filtra por categoria, mostra todos os tipos
                catalogFilters.type = 'todos';

                switchTab('tab-catalogo', false);
                const searchInput = document.getElementById('catalog-search');
                if (searchInput) searchInput.value = q;
                filterCatalog();
            }, 250);
        }

        function filterBySidebarGenre(genre) {
            // Fecha sidebar em mobile
            const sNav = document.getElementById('sidebar-nav');
            const sOv = document.getElementById('sidebar-mobile-overlay');
            if (sNav) sNav.classList.remove('mobile-open');
            if (sOv) sOv.classList.remove('active');
            document.body.style.overflow = '';

            if (genre === 'todos') {
                // Limpa o filtro de gênero mas permanece na categoria/tipo atual
                catalogFilters.genre = 'todos';

                if (currentNavMode === 'inicio' || currentNavMode === 'todos') {
                    // Se estiver em início, vai para início normalmente
                    switchNavCategory('inicio');
                } else {
                    // Fica na categoria atual, só remove o filtro de gênero
                    switchTab('tab-catalogo', false);
                    const heroBox = document.getElementById('hero-billboard-container');
                    const railsBox = document.getElementById('netflix-rails-container');
                    const gridLayout = document.getElementById('catalog-layout-grid');
                    if (heroBox) heroBox.style.display = 'none';
                    if (railsBox) railsBox.style.display = 'none';
                    if (gridLayout) gridLayout.style.display = 'flex';

                    // Mantém o tipo de acordo com a navegação atual
                    const typeFromNav = { filme: 'filme', serie: 'serie', anime: 'anime', dorama: 'dorama', favoritos: 'favoritos' };
                    catalogFilters.type = typeFromNav[currentNavMode] || 'todos';
                    catalogFilters.sort = 'default';

                    // Marca visualmente o item do sidebar e o botão Todos como ativo
                    document.querySelectorAll('.sidebar-nav-item:not(.sidebar-genre-item)').forEach(b => b.classList.remove('active'));
                    const sidebarNavBtn = document.getElementById('sidebar-item-' + currentNavMode);
                    if (sidebarNavBtn) sidebarNavBtn.classList.add('active');

                    renderCatalog();
                    const _mainA = document.getElementById('app-main-area');
                    if (_mainA) _mainA.scrollTo({ top: 0, behavior: 'smooth' });
                }

                document.querySelectorAll('.sidebar-genre-item').forEach(b => b.classList.remove('active'));
                const allBtn = document.getElementById('sidebar-genre-todos');
                if (allBtn) allBtn.classList.add('active');
                return;
            }

            // Preserva o tipo do currentNavMode (anime, dorama, etc.) ao filtrar por gênero
            const typeFromNav = { filme: 'filme', serie: 'serie', anime: 'anime', dorama: 'dorama', favoritos: 'favoritos' };
            const scopedType = typeFromNav[currentNavMode] || 'todos';

            switchTab('tab-catalogo', false);

            const heroBox = document.getElementById('hero-billboard-container');
            const railsBox = document.getElementById('netflix-rails-container');
            const gridLayout = document.getElementById('catalog-layout-grid');
            if (heroBox) heroBox.style.display = 'none';
            if (railsBox) railsBox.style.display = 'none';
            if (gridLayout) gridLayout.style.display = 'flex';

            catalogFilters.type = scopedType;
            catalogFilters.genre = genre;
            catalogFilters.sort = 'default';

            document.querySelectorAll('.sidebar-nav-item:not(.sidebar-genre-item)').forEach(b => b.classList.remove('active'));
            const sidebarNavBtn = document.getElementById('sidebar-item-' + currentNavMode);
            if (sidebarNavBtn) sidebarNavBtn.classList.add('active');

            const genreIdMap = {
                'Ação': 'sidebar-genre-acao',
                'Aventura': 'sidebar-genre-aventura',
                'Comédia': 'sidebar-genre-comedia',
                'Drama': 'sidebar-genre-drama',
                'Fantasia': 'sidebar-genre-fantasia',
                'Terror': 'sidebar-genre-terror',
                'Documentário': 'sidebar-genre-doc',
                'Crime': 'sidebar-genre-crime',
                'Ficção': 'sidebar-genre-ficcao',
                'Romance': 'sidebar-genre-romance',
                'Suspense': 'sidebar-genre-suspense'
            };
            document.querySelectorAll('.sidebar-genre-item').forEach(b => b.classList.remove('active'));
            const btnId = genreIdMap[genre];
            if (btnId) {
                const btn = document.getElementById(btnId);
                if (btn) btn.classList.add('active');
            }

            // Sincroniza botões na barra de filtros lateral do catálogo
            document.querySelectorAll('#sidebar-genre-list .genre-tag-btn').forEach(btn => {
                btn.classList.toggle('active', btn.getAttribute('data-val') === genre);
            });

            renderCatalog();
            const _mainAreaG = document.getElementById('app-main-area');
            if (_mainAreaG) _mainAreaG.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function toggleMobileSidebar() {
            const nav = document.getElementById('sidebar-nav');
            const overlay = document.getElementById('sidebar-mobile-overlay');
            if (nav) nav.classList.toggle('mobile-open');
            if (overlay) overlay.classList.toggle('active');
        }

        function toggleHeaderBell(event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            if (typeof toggleNotifDropdown === 'function') {
                toggleNotifDropdown(event);
            }
        }

        // Atalho de teclado global Ctrl+K para focar busca do header
        window.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                const searchInput = document.getElementById('header-search-input');
                if (searchInput) {
                    searchInput.focus();
                    searchInput.select();
                }
            }
        });

        // (Funções onHeaderSearchInput e filterBySidebarGenre definidas acima — sem duplicatas)

        // ═══════════════════════════════════════════════════════════════════════
        // 📱 SIDEBAR TOGGLE (DESKTOP COLLAPSE + MOBILE DRAWER)
        // ═══════════════════════════════════════════════════════════════════════

        function openMobileSearchDrawer() {
            const nav = document.getElementById('sidebar-nav');
            const overlay = document.getElementById('sidebar-mobile-overlay');
            if (nav) nav.classList.add('mobile-open');
            if (overlay) overlay.classList.add('active');
            setTimeout(() => {
                const sideSearch = document.getElementById('sidebar-search-input');
                if (sideSearch) sideSearch.focus();
            }, 180);
        }

        function onSidebarSearchInput(val) {
            // ⛔ Não interrompe o player: se o player está ativo, não navega
            const isPlayerActive = document.getElementById('tab-playback-page')?.classList.contains('active') || !!currentPlayingMedia;
            if (isPlayerActive && (val || '').trim()) return;
            const desktopSearch = document.getElementById('header-search-input');
            if (desktopSearch) desktopSearch.value = val;
            onHeaderSearchInput(val);
        }

        function onSidebarSearchKeyDown(e) {
            if (e.key === 'Enter') {
                const nav = document.getElementById('sidebar-nav');
                const overlay = document.getElementById('sidebar-mobile-overlay');
                if (nav) nav.classList.remove('mobile-open');
                if (overlay) overlay.classList.remove('active');
                document.body.style.overflow = '';
                e.target.blur();
                const _mainAreaM = document.getElementById('app-main-area');
                if (_mainAreaM) _mainAreaM.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }

        function toggleSidebar() {
            const nav = document.getElementById('sidebar-nav');
            const overlay = document.getElementById('sidebar-mobile-overlay');
            if (!nav) return;
            if (window.innerWidth <= 900) {
                nav.classList.remove('collapsed');
                nav.classList.toggle('mobile-open');
                const isOpen = nav.classList.contains('mobile-open');
                if (overlay) overlay.classList.toggle('active', isOpen);
                document.body.style.overflow = isOpen ? 'hidden' : '';
            } else {
                nav.classList.remove('mobile-open');
                document.body.style.overflow = '';
                if (overlay) overlay.classList.remove('active');
                nav.classList.toggle('collapsed');
                const isCollapsed = nav.classList.contains('collapsed');
                document.body.classList.toggle('sidebar-is-collapsed', isCollapsed);
                try {
                    localStorage.setItem('brasilflix_sidebar_collapsed', isCollapsed ? '1' : '0');
                } catch (e) { }
            }
        }

        function toggleMobileSidebar() {
            toggleSidebar();
        }

        // Restaura estado colapsado no desktop e garante estado limpo e funcional no mobile
        try {
            document.addEventListener('DOMContentLoaded', () => {
                const nav = document.getElementById('sidebar-nav');
                if (!nav) return;
                if (window.innerWidth > 900) {
                    if (localStorage.getItem('brasilflix_sidebar_collapsed') === '1') {
                        nav.classList.add('collapsed');
                        document.body.classList.add('sidebar-is-collapsed');
                    }
                } else {
                    nav.classList.remove('collapsed');
                    document.body.classList.remove('sidebar-is-collapsed');
                }
            });
            window.addEventListener('resize', () => {
                const nav = document.getElementById('sidebar-nav');
                const overlay = document.getElementById('sidebar-mobile-overlay');
                if (window.innerWidth > 900) {
                    if (nav) nav.classList.remove('mobile-open');
                    if (overlay) overlay.classList.remove('active');
                    document.body.style.overflow = '';
                    if (localStorage.getItem('brasilflix_sidebar_collapsed') === '1') {
                        nav?.classList.add('collapsed');
                        document.body.classList.add('sidebar-is-collapsed');
                    }
                } else {
                    if (nav) nav.classList.remove('collapsed');
                    document.body.classList.remove('sidebar-is-collapsed');
                }
            });
        } catch (e) { }

        // ═══════════════════════════════════════════════════════════════════════
        // 🔔 NOTIFICATION BELL DROPDOWN
        // ═══════════════════════════════════════════════════════════════════════

        function toggleHeaderBell(event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            closeProfileDropdown();
            const drop = document.getElementById('header-notif-dropdown');
            if (!drop) return;
            const isVisible = drop.classList.contains('visible');
            if (isVisible) {
                drop.classList.remove('visible');
            } else {
                drop.classList.add('visible');
                renderHeaderNotifications();
            }
        }

        function renderHeaderNotifications() {
            const list = document.getElementById('header-notif-items-list');
            const clearBtn = document.getElementById('header-notif-clear-btn');
            const badge = document.getElementById('header-bell-badge');
            if (!list) return;

            const notifs = (typeof userNotifs !== 'undefined' && Array.isArray(userNotifs)) ? userNotifs : [];
            const unreadCount = notifs.filter(n => !n.read).length;

            if (clearBtn) clearBtn.style.display = unreadCount > 0 ? 'inline-block' : 'none';
            if (badge) {
                if (unreadCount > 0) {
                    badge.style.display = 'flex';
                    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
                } else {
                    badge.style.display = 'none';
                }
            }

            if (notifs.length === 0) {
                list.innerHTML = `
                    <div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 24px 12px;">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 auto 8px auto; opacity: 0.5; display: block;"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                        Nenhuma notificação no momento.
                    </div>
                `;
                return;
            }

            list.innerHTML = notifs.map(n => `
                <div class="notif-item ${!n.read ? 'unread' : ''}" onclick="if (n.serieId) { openModalById('${n.serieId}', '${n.media_type || 'filme'}'); } else if (n.link) { window.location.href = n.link; } closeHeaderNotifDropdown();">
                    <div style="display: flex; align-items: center; justify-content: space-between;">
                        <div style="font-size: 12px; font-weight: 800; color: #fff;">${n.title}</div>
                        ${!n.read ? '<span style="font-size: 9px; font-weight: 900; color: #38bdf8; background: rgba(56, 189, 248, 0.2); padding: 1px 5px; border-radius: 4px;">NOVO</span>' : ''}
                    </div>
                    <div style="font-size: 11px; color: #cbd5e1; margin-top: 2px;">${n.text}</div>
                    <div style="font-size: 10px; color: var(--text-muted); margin-top: 4px;">${n.createdAt ? new Date(n.createdAt).toLocaleDateString('pt-BR') : 'Hoje'}</div>
                </div>
            `).join('');
        }

        function closeHeaderNotifDropdown() {
            const drop = document.getElementById('header-notif-dropdown');
            if (drop) drop.classList.remove('visible');
        }

        document.addEventListener('click', (e) => {
            const drop = document.getElementById('header-notif-dropdown');
            const btn = document.getElementById('header-bell-btn');
            if (drop && drop.classList.contains('visible')) {
                if (!drop.contains(e.target) && (!btn || !btn.contains(e.target))) {
                    drop.classList.remove('visible');
                }
            }
        });

        function clearSearchAutofill() {
            const h = document.getElementById('header-search-input');
            if (h && (h.value || '').trim().toLowerCase() === 'admin' && document.activeElement !== h) {
                h.value = '';
            }
            const c = document.getElementById('catalog-search');
            if (c && (c.value || '').trim().toLowerCase() === 'admin') {
                c.value = '';
            }
            const a = document.getElementById('admin-catalog-search');
            if (a && (a.value || '').trim().toLowerCase() === 'admin' && document.activeElement !== a) {
                a.value = '';
            }
        }

        window.addEventListener('beforeunload', () => {
            const h = document.getElementById('header-search-input');
            if (h && (h.value || '').trim().toLowerCase() === 'admin') h.value = '';
            const c = document.getElementById('catalog-search');
            if (c) c.value = '';
        });
        window.addEventListener('pageshow', clearSearchAutofill);
        window.addEventListener('load', clearSearchAutofill);

        // Vigia ativamente nos primeiros 2.5 segundos contra autofill ou restauração tardia do navegador
        const _autofillGuard = setInterval(clearSearchAutofill, 80);
        setTimeout(() => clearInterval(_autofillGuard), 2500);

        /* ═══════════════════════════════════════════════════════════════════════
                   👤 AUTENTICAÇÃO DE USUÁRIOS & FAVORITOS & NOTIFICAÇÕES
                   ═══════════════════════════════════════════════════════════════════════ */

        async function fetchUserProfileAndFavorites() {
            loadUserWatchProgress();
            try {
                const res = await fetch('/api/user/me', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.user) {
                        userAuthToken = 'session';
                        currentUser = data.user;
                        if (data.user.role === 'admin' || data.user.isAdmin) adminToken = 'session';
                        userFavorites = data.user.favoritos || [];
                        userNotifs = data.user.notificacoes || [];
                        updateUserHeaderUI(currentUser);
                        renderUserNotifications(userNotifs);
                        loadUserWatchProgress();
                        if (currentUser.telegram_id) {
                            localStorage.setItem('bf_user_token', String(currentUser.telegram_id));
                        }

                        // Se tiver notificação nova não lida sobre pedido concluído, avisa com toast
                        const unreadOrderNotifs = (userNotifs || []).filter(n => !n.read && n.title?.includes('pedido'));
                        if (unreadOrderNotifs.length > 0) {
                            setTimeout(() => {
                                showToast(`🎉 ${unreadOrderNotifs[0].title}`, 'success');
                            }, 1200);
                        }

                        // Se a aba de configurações estiver ativa, atualiza a interface com os dados do usuário
                        const settingsTab = document.getElementById('tab-settings');
                        if (settingsTab && (settingsTab.classList.contains('active') || settingsTab.style.display !== 'none')) {
                            loadSettingsView();
                        }
                    }
                } else if (res.status === 401 || res.status === 403) {
                    localStorage.removeItem('bf_user_jwt');
                    userAuthToken = null;
                    currentUser = null;
                    updateUserHeaderUI(null);
                }
            } catch (e) {
                console.warn('Erro ao consultar perfil do usuário:', e);
            }
        }

        let lastMouseDownTarget = null;
        document.addEventListener('mousedown', (e) => {
            lastMouseDownTarget = e.target;
        }, true);

        function isSafeModalBackdropClick(e, backdropId) {
            if (!e) return true;
            if (e.target.id !== backdropId) return false;
            if (lastMouseDownTarget !== e.currentTarget) return false;
            return true;
        }

        function updateUserHeaderUI(user) {
            const box = document.getElementById('user-header-profile-box');
            const sideBox = document.getElementById('user-sidebar-profile-box');

            const isUserAdmin = user && (user.role === 'admin' || user.username === 'admin' || !!adminToken);
            const unreadNotifs = (userNotifs || []).filter(n => !n.read).length;

            const headerBadge = document.getElementById('header-bell-badge');
            if (headerBadge) {
                if (unreadNotifs > 0) {
                    headerBadge.style.display = 'flex';
                    headerBadge.textContent = unreadNotifs > 9 ? '9+' : unreadNotifs;
                } else {
                    headerBadge.style.display = 'none';
                }
            }

            const sidebarNotifBadge = document.getElementById('sidebar-notif-badge');
            if (sidebarNotifBadge) {
                if (unreadNotifs > 0) {
                    sidebarNotifBadge.style.display = 'inline-flex';
                    sidebarNotifBadge.textContent = unreadNotifs > 9 ? '9+' : unreadNotifs;
                } else {
                    sidebarNotifBadge.style.display = 'none';
                }
            }

            if (user) {
                const isVip = user.is_vip || isUserAdmin;

                // 1. DESKTOP HEADER DROPDOWN (100% Padronizado, cores uniformes e elegantes)
                if (box) {
                    box.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <div style="position: relative;">
                                <button class="user-profile-btn" onclick="toggleProfileDropdown(event)" style="position: relative;">
                                    ${user.avatar_url ? `<img src="${safeImageUrl(user.avatar_url)}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;flex-shrink:0;border:1px solid rgba(255,255,255,0.2);" alt="${escapeHtml(user.username)}">` : `<div class="user-avatar-circle" style="${isUserAdmin ? 'background: linear-gradient(135deg, #3b82f6, #8b5cf6);' : (isVip ? 'background: linear-gradient(135deg, #f59e0b, #d97706);' : '')}"><span>${(user.username || 'U')[0].toUpperCase()}</span></div>`}
                                    <span style="max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${user.username}</span>
                                    ${isUserAdmin ? '<span style="color: #60a5fa; font-size: 11px; font-weight: 900;">Admin</span>' : (isVip ? '<span style="color: #fbbf24; font-size: 11px; font-weight: 900;">VIP</span>' : '')}
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.7;"><path d="M6 9l6 6 6-6"/></svg>
                                </button>

                                <div class="profile-dropdown-menu" id="user-profile-dropdown" onclick="event.stopPropagation()">
                                    <div class="profile-menu-header">
                                        <div style="display: flex; align-items: center; justify-content: space-between;">
                                            <div style="font-size: 14px; font-weight: 900; color: #fff;">${user.username}</div>
                                            ${isUserAdmin ? '<div class="profile-badge-pill admin">Administrador</div>' : (isVip ? '<div class="profile-badge-pill vip">Assinante VIP</div>' : '')}
                                        </div>
                                        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${user.email || 'Conta vinculada'}</div>
                                    </div>

                                    <div class="profile-menu-item" onclick="switchTab('tab-settings'); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>
                                        <span>Configurações</span>
                                    </div>

                                    ${isUserAdmin ? `
                                    <a href="#admin" class="profile-menu-item" onclick="event.preventDefault(); switchTab('tab-admin'); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg></span>
                                        <span>Painel Admin</span>
                                    </a>` : ''}

                                    <div class="profile-menu-item" onclick="switchNavCategory('favoritos'); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></span>
                                        <span>Minha Lista (${(userFavorites || []).length})</span>
                                    </div>

                                    <div class="profile-menu-item" onclick="openRequestMediaModal(); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg></span>
                                        <span>Pedir Filme ou Série</span>
                                    </div>

                                    <div class="profile-menu-item" onclick="openSupportTicketModal(); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>
                                        <span>Ajuda &amp; Suporte</span>
                                    </div>

                                    <div class="profile-menu-item logout-item" onclick="handleUserLogout(); closeProfileDropdown();">
                                        <span class="profile-menu-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>
                                        <span>Sair da Conta</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;
                }

                // 2. MOBILE DRAWER USER CARD (Totalmente integrado no menu lateral, ultra prático)
                if (sideBox) {
                    sideBox.innerHTML = `
                        <div class="sidebar-user-card">
                            <div class="sidebar-user-info">
                                ${user.avatar_url ? `<img src="${safeImageUrl(user.avatar_url)}" class="sidebar-user-avatar" alt="${escapeHtml(user.username)}">` : `<div class="user-avatar-circle" style="width:34px;height:34px;font-size:13px;${isUserAdmin ? 'background: linear-gradient(135deg, #3b82f6, #8b5cf6);' : (isVip ? 'background: linear-gradient(135deg, #f59e0b, #d97706);' : '')}"><span>${(user.username || 'U')[0].toUpperCase()}</span></div>`}
                                <div class="sidebar-user-names">
                                    <span class="sidebar-user-name">${user.username}</span>
                                    <span class="sidebar-user-badge ${isVip && !isUserAdmin ? 'vip' : ''}">${isUserAdmin ? 'Administrador' : (isVip ? 'Assinante VIP' : 'Membro')}</span>
                                </div>
                            </div>
                            <div class="sidebar-user-actions">
                                <button class="sidebar-user-action-btn" onclick="switchTab('tab-settings'); toggleSidebar();">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                                    <span>Configurações</span>
                                </button>
                                ${isUserAdmin ? `
                                <a href="#admin" class="sidebar-user-action-btn" onclick="event.preventDefault(); switchTab('tab-admin'); toggleSidebar();">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                                    <span>Painel Admin</span>
                                </a>` : ''}
                                <button class="sidebar-user-action-btn" onclick="openRequestMediaModal(); toggleSidebar();">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                                    <span>Pedir Filme ou Série</span>
                                </button>
                                <button class="sidebar-user-action-btn" onclick="openSupportTicketModal(); toggleSidebar();">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                                    <span>Ajuda &amp; Suporte</span>
                                </button>
                                <button class="sidebar-user-action-btn logout" onclick="handleUserLogout(); toggleSidebar();">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                                    <span>Sair da Conta</span>
                                </button>
                            </div>
                        </div>
                    `;
                }
            } else {
                // DESLOGADO: Minimalista e elegante
                if (box) {
                    box.innerHTML = `
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <button class="user-profile-btn" onclick="openAuthUserModal('login')" title="Entrar na conta">
                                <div class="user-avatar-circle">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                </div>
                                <span>Entrar</span>
                            </button>
                        </div>
                    `;
                }
                if (sideBox) {
                    sideBox.innerHTML = `
                        <div class="sidebar-auth-card">
                            <div class="sidebar-auth-title">Minha Conta</div>
                            <div class="sidebar-auth-desc">Entre para salvar seus favoritos, continuar assistindo e pedir filmes ou séries.</div>
                            <button class="sidebar-login-btn" onclick="openAuthUserModal('login'); toggleSidebar();">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                                <span>Entrar na Conta</span>
                            </button>
                        </div>
                    `;
                }
            }
        }

        function toggleProfileDropdown(e) {
            if (e) e.stopPropagation();
            closeNotifDropdown();
            const drop = document.getElementById('user-profile-dropdown');
            if (drop) drop.classList.toggle('visible');
        }

        function closeProfileDropdown() {
            const drop = document.getElementById('user-profile-dropdown');
            if (drop) drop.classList.remove('visible');
        }

        function toggleNotifDropdown(e) {
            if (e) e.stopPropagation();
            closeProfileDropdown();
            const drop = document.getElementById('user-notif-dropdown');
            if (drop) drop.classList.toggle('visible');
        }

        function closeNotifDropdown() {
            const drop = document.getElementById('user-notif-dropdown');
            if (drop) drop.classList.remove('visible');
        }

        function openFeedbackModal(defaultType = 'sugestao', defaultTitle = '') {
            const modal = document.getElementById('feedback-modal');
            const typeSelect = document.getElementById('feedback-type');
            const titleInput = document.getElementById('feedback-title');
            const msgInput = document.getElementById('feedback-msg');

            if (typeSelect && defaultType) typeSelect.value = defaultType;
            if (titleInput && defaultTitle) titleInput.value = defaultTitle;
            if (msgInput) msgInput.value = '';

            if (modal) modal.classList.add('active');
        }

        function closeFeedbackModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'feedback-modal')) return;
            const modal = document.getElementById('feedback-modal');
            if (modal) modal.classList.remove('active');
        }

        async function submitUserFeedback(event) {
            event.preventDefault();
            const type = document.getElementById('feedback-type')?.value || 'sugestao';
            const title = document.getElementById('feedback-title')?.value || '';
            const msg = document.getElementById('feedback-msg')?.value || '';
            const contact = document.getElementById('feedback-contact')?.value || '';
            const btn = document.getElementById('btn-submit-feedback');

            if (!msg.trim()) {
                showToast('Por favor, digite sua mensagem ou solicitação.', 'error');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerText = 'Enviando...';
            }

            try {
                const headers = { 'Content-Type': 'application/json' };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

                const res = await fetch('/api/user/feedback', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        tipo: type,
                        titulo: title,
                        mensagem: msg,
                        contato: contact
                    })
                });

                const data = await res.json();
                if (res.ok && data.success) {
                    showToast(data.message || 'Mensagem enviada com sucesso!', 'success');
                    closeFeedbackModal();
                } else {
                    showToast(data.error || 'Erro ao enviar mensagem.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao enviar mensagem.', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = 'Enviar Mensagem';
                }
            }
        }

        window.addEventListener('click', () => {
            closeProfileDropdown();
            closeNotifDropdown();
        });

        function renderUserNotifications(notifs) {
            updateUserHeaderUI(currentUser);
        }

        async function markAllNotifsRead() {
            if (!userAuthToken) return;
            try {
                await fetch('/api/user/notificacoes/read', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                if (userNotifs) {
                    userNotifs.forEach(n => n.read = true);
                }
                updateUserHeaderUI(currentUser);
                showToast('Todas as notificações foram marcadas como lidas.', 'info');
            } catch (e) { }
        }

        let telegramLoginPollInterval = null;

        async function startTelegramLoginFlow() {
            const originalForm = document.getElementById('auth-forms-wrapper');
            const waitingView = document.getElementById('auth-telegram-waiting-view');
            const botLinkBtn = document.getElementById('auth-telegram-bot-link');

            try {
                showToast('Gerando link seguro de conexão com o Telegram...', 'info');
                const res = await fetch('/api/auth/telegram/create', { method: 'POST' });
                const data = await res.json();
                if (!data || !data.success || !data.code) {
                    showToast('Não foi possível iniciar o login do Telegram.', 'error');
                    return;
                }

                const code = data.code;
                const botUrl = data.botUrl || `https://t.me/BrasilFlix_bot?start=login_${code}`;

                // Abre o bot do Telegram em nova aba
                window.open(botUrl, '_blank');

                if (originalForm) originalForm.style.display = 'none';
                if (waitingView) waitingView.style.display = 'block';
                if (botLinkBtn) botLinkBtn.href = botUrl;

                // Inicia polling para detectar quando o usuário clicar em "Iniciar" no Telegram
                if (telegramLoginPollInterval) clearInterval(telegramLoginPollInterval);

                telegramLoginPollInterval = setInterval(async () => {
                    try {
                        const checkRes = await fetch(`/api/auth/telegram/check/${code}`);
                        const checkData = await checkRes.json();
                        if (checkData && checkData.status === 'completed') {
                            clearInterval(telegramLoginPollInterval);
                            telegramLoginPollInterval = null;

                            userAuthToken = 'session';
                            currentUser = checkData.user;
                            userFavorites = checkData.user?.favoritos || [];
                            userNotifs = checkData.user?.notificacoes || [];

                            if (checkData.user?.telegram_id) {
                                localStorage.setItem('bf_user_token', String(checkData.user.telegram_id));
                            }

                            if (checkData.isAdmin || checkData.user?.role === 'admin') {
                                adminToken = 'session';
                                const adminTabBtn = document.getElementById('tab-btn-admin');
                                if (adminTabBtn) adminTabBtn.style.display = 'inline-flex';
                            }

                            closeAuthUserModal();
                            closeAuthLinkModal();
                            cancelTelegramLoginFlow();
                            updateUserHeaderUI(currentUser);
                            showToast(`🎉 Bem-vindo, ${currentUser.username || 'Usuário'}! Login via Telegram concluído com sucesso.`, 'success');
                            renderNetflixRails();
                            renderHeroBillboard();
                            if (currentNavMode === 'favoritos') renderCatalog();
                        } else if (checkData && checkData.status === 'expired') {
                            clearInterval(telegramLoginPollInterval);
                            telegramLoginPollInterval = null;
                            showToast('A sessão de login no Telegram expirou. Tente novamente.', 'error');
                            cancelTelegramLoginFlow();
                        }
                    } catch (e) { }
                }, 1500);

            } catch (err) {
                showToast('Erro ao conectar com servidor para login do Telegram.', 'error');
            }
        }

        function cancelTelegramLoginFlow() {
            if (telegramLoginPollInterval) {
                clearInterval(telegramLoginPollInterval);
                telegramLoginPollInterval = null;
            }
            const originalForm = document.getElementById('auth-forms-wrapper');
            const waitingView = document.getElementById('auth-telegram-waiting-view');
            if (originalForm) originalForm.style.display = 'block';
            if (waitingView) waitingView.style.display = 'none';
        }

        function openAuthUserModal(tab = 'login') {
            cancelTelegramLoginFlow();
            const modal = document.getElementById('auth-user-modal');
            if (modal) {
                switchAuthTab(tab);
                modal.classList.add('active');
            }
        }

        function closeAuthUserModal() {
            cancelTelegramLoginFlow();
            const modal = document.getElementById('auth-user-modal');
            if (modal) modal.classList.remove('active');
        }

        function closeAuthUserModalOnClick(e) {
            if (isSafeModalBackdropClick(e, 'auth-user-modal')) closeAuthUserModal();
        }

        function switchAuthTab(tab) {
            const btnLogin = document.getElementById('auth-tab-login');
            const btnReg = document.getElementById('auth-tab-register');
            const formLogin = document.getElementById('form-user-login');
            const formReg = document.getElementById('form-user-register');

            if (tab === 'login') {
                if (btnLogin) btnLogin.classList.add('active');
                if (btnReg) btnReg.classList.remove('active');
                if (formLogin) formLogin.style.display = 'block';
                if (formReg) formReg.style.display = 'none';
            } else {
                if (btnLogin) btnLogin.classList.remove('active');
                if (btnReg) btnReg.classList.add('active');
                if (formLogin) formLogin.style.display = 'none';
                if (formReg) formReg.style.display = 'block';
            }
        }

        async function handleUserLogin(e) {
            e.preventDefault();
            const identifier = (document.getElementById('login-identifier')?.value || '').trim();
            const password = (document.getElementById('user-login-password') || document.getElementById('login-password'))?.value || '';

            try {
                const res = await fetch('/api/user/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ identifier, password })
                });
                const data = await res.json();
                if (data.success) {
                    userAuthToken = 'session';
                    currentUser = data.user;
                    userFavorites = data.user.favoritos || [];
                    userNotifs = data.user.notificacoes || [];

                    if (data.isAdmin || data.adminToken || data.user?.role === 'admin') {
                        adminToken = 'session';
                    }

                    closeAuthUserModal();
                    updateUserHeaderUI(currentUser);
                    showToast(`Bem-vindo, ${currentUser.username}!`, 'success');
                    renderNetflixRails();
                } else {
                    showToast(data.message || 'Erro ao autenticar.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao realizar login.', 'error');
            }
        }

        async function handleUserRegister(e) {
            e.preventDefault();
            const email = document.getElementById('reg-email').value;
            const username = document.getElementById('reg-username').value;
            const password = document.getElementById('reg-password').value;

            try {
                const res = await fetch('/api/user/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, username, password })
                });
                const data = await res.json();
                if (data.success) {
                    userAuthToken = 'session';
                    currentUser = data.user;
                    userFavorites = [];
                    userNotifs = [];
                    closeAuthUserModal();
                    updateUserHeaderUI(currentUser);
                    showToast('Conta criada com sucesso! Bem-vindo ao BrasilFlix.', 'success');
                    renderNetflixRails();
                } else {
                    showToast(data.message || 'Erro ao criar conta.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao criar conta.', 'error');
            }
        }

        async function handleUserLogout() {
            await fetch('/api/user/logout', { method: 'POST' });
            localStorage.removeItem('bf_user_token');
            localStorage.removeItem('bf_user_jwt');
            localStorage.removeItem('bf_admin_token');
            adminToken = null;
            userAuthToken = null;
            currentUser = null;
            userFavorites = [];
            userNotifs = [];
            const adminTabBtn = document.getElementById('tab-btn-admin');
            if (adminTabBtn) adminTabBtn.style.display = 'none';
            updateUserHeaderUI(null);
            showToast('Você saiu da sua conta.', 'info');
            renderNetflixRails();
            if (currentNavMode === 'favoritos' || localStorage.getItem('bf_active_tab') === 'tab-admin') {
                switchNavCategory('inicio');
            }
        }

        async function toggleUserFavorite(itemId, itemType = 'filme', event = null) {
            if (event) event.stopPropagation();
            if (!userAuthToken) {
                openAuthUserModal('login');
                showToast('Faça login ou crie sua conta para salvar em Minha Lista!', 'info');
                return;
            }

            try {
                const res = await fetch('/api/user/favoritos/toggle', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userAuthToken}`
                    },
                    body: JSON.stringify({ itemId, itemType })
                });
                const data = await res.json();
                if (data && data.success) {
                    userFavorites = data.favoritos || [];
                    showToast(data.isFavorite ? '❤️ Adicionado à Minha Lista!' : 'Removido da Minha Lista.', 'success');
                    renderNetflixRails();
                    renderHeroBillboard();
                    if (currentNavMode === 'favoritos') renderCatalog();
                }
            } catch (e) {
                showToast('Erro ao atualizar favoritos.', 'error');
            }
        }

        /* ═══════════════════════════════════════════════════════════════════════
           ⚙️ CONTROLADOR DA PÁGINA DE CONFIGURAÇÕES & PERFIL DO USUÁRIO
           ═══════════════════════════════════════════════════════════════════════ */

        let telegramLinkCheckInterval = null;

        function updateUsernameCounter(input) {
            const counter = document.getElementById('username-char-counter');
            if (counter && input) {
                counter.innerText = `${(input.value || '').length}/15`;
            }
        }

        function previewAvatarUrl(url) {
            const trimmed = (url || '').trim();
            const username = document.getElementById('settings-input-username')?.value || currentUser?.username || 'U';
            renderAvatarPreview(trimmed, username);
        }

        function renderAvatarPreview(avatarUrl, username) {
            const previewEl = document.getElementById('settings-avatar-preview');
            const removeBtn = document.getElementById('btn-remove-avatar');
            if (!previewEl) return;

            const initial = ((username || currentUser?.username || 'U')[0] || 'U').toUpperCase();

            if (avatarUrl && avatarUrl.trim()) {
                previewEl.innerHTML = `<img src="${avatarUrl}" alt="Avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.onerror=null;this.parentElement.innerText='${initial}';">`;
                if (removeBtn) removeBtn.style.display = 'block';
            } else {
                previewEl.innerHTML = initial;
                if (removeBtn) removeBtn.style.display = 'none';
            }
        }

        function removeCustomAvatar() {
            const input = document.getElementById('settings-input-avatar-url');
            if (input) input.value = '';
            const fileInput = document.getElementById('settings-avatar-file');
            if (fileInput) fileInput.value = '';
            renderAvatarPreview('', document.getElementById('settings-input-username')?.value);
        }

        async function handleAvatarFileUpload(input) {
            if (!input.files || !input.files[0]) return;
            const file = input.files[0];
            if (!file.type.startsWith('image/')) {
                showToast('Apenas imagens são aceitas.', 'error');
                return;
            }
            if (file.size > 2 * 1024 * 1024) {
                showToast('Imagem muito grande. Máximo: 2MB.', 'error');
                return;
            }

            // Pré-visualização instantânea via FileReader
            const reader = new FileReader();
            reader.onload = (e) => {
                renderAvatarPreview(e.target.result, document.getElementById('settings-input-username')?.value);
                const urlInput = document.getElementById('settings-input-avatar-url');
                if (urlInput) urlInput.value = '';
            };
            reader.readAsDataURL(file);

            if (!userAuthToken) return;

            // Upload para o servidor
            const formData = new FormData();
            formData.append('avatar', file);
            try {
                const res = await fetch('/api/user/avatar-upload', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${userAuthToken}` },
                    body: formData
                });
                const data = await res.json();
                if (data && data.success) {
                    currentUser = { ...currentUser, avatar_url: data.avatar_url, ...(data.user || {}) };
                    updateUserHeaderUI(currentUser);
                    showToast('✨ Foto de perfil atualizada!', 'success');
                } else {
                    showToast(data.message || 'Erro ao salvar imagem.', 'error');
                }
            } catch (e) {
                showToast('Erro de conexão ao enviar imagem.', 'error');
            }
        }

        function openSettingsTab(section = 'profile') {
            if (!userAuthToken) {
                openAuthUserModal('login');
                showToast('Faça login para acessar as configurações da sua conta.', 'info');
                return;
            }
            switchTab('tab-settings');
            switchSettingsSection(section);
        }

        function switchSettingsSection(section = 'profile') {
            const sections = ['profile', 'preferences', 'requests', 'reviews'];
            const activeSec = sections.includes(section) ? section : 'profile';

            localStorage.setItem('bf_settings_section', activeSec);

            sections.forEach(sec => {
                const btn = document.getElementById(`btn-set-tab-${sec}`);
                const panel = document.getElementById(`settings-section-${sec}`);
                if (btn) {
                    if (sec === activeSec) btn.classList.add('active');
                    else btn.classList.remove('active');
                }
                if (panel) {
                    if (sec === activeSec) {
                        panel.style.display = 'block';
                        panel.classList.add('active');
                    } else {
                        panel.style.display = 'none';
                        panel.classList.remove('active');
                    }
                }
            });

            if (window.location.hash !== `#settings/${activeSec}`) {
                history.replaceState(null, '', `#settings/${activeSec}`);
            }

            if (activeSec === 'profile') {
                populateProfileFields();
            } else if (activeSec === 'preferences') {
                loadPreferencesFields();
            } else if (activeSec === 'requests') {
                loadUserRequests();
            } else if (activeSec === 'reviews') {
                loadUserReviews();
            }
        }

        function loadPreferencesFields() {
            const audioSelect = document.getElementById('settings-pref-audio');
            const spoilerCheck = document.getElementById('settings-pref-spoiler');
            const savedAudio = localStorage.getItem('bf_pref_default_audio') || currentUser?.preferencias?.defaultAudio || 'ask';
            const savedSpoiler = localStorage.getItem('bf_pref_spoiler_blur') !== null
                ? localStorage.getItem('bf_pref_spoiler_blur') === 'true'
                : (currentUser?.preferencias?.spoilerBlur !== false);

            if (audioSelect) audioSelect.value = savedAudio;
            if (spoilerCheck) spoilerCheck.checked = savedSpoiler;
        }

        async function loadSettingsView() {
            if (!userAuthToken) {
                switchNavCategory('inicio');
                openAuthUserModal('login');
                showToast('Faça login para acessar suas configurações.', 'info');
                return;
            }

            try {
                const res = await fetch('/api/user/me', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.success && data.user) {
                        currentUser = { ...currentUser, ...data.user };
                        updateUserHeaderUI(currentUser);
                    }
                }
            } catch (e) {
                console.warn('Erro ao atualizar dados do usuário:', e);
            }

            const badgeEl = document.getElementById('settings-header-badge');
            if (badgeEl && currentUser) {
                const isUserAdmin = currentUser.role === 'admin' || (adminToken && !!adminToken);
                const isVip = currentUser.is_vip;
                badgeEl.innerHTML = `
                    <div style="font-size: 11px; font-weight: 800; padding: 4px 12px; border-radius: 99px; background: ${isUserAdmin ? 'rgba(59, 130, 246, 0.2)' : (isVip ? 'rgba(245, 158, 11, 0.2)' : 'rgba(59, 130, 246, 0.15)')}; color: ${isUserAdmin ? '#60a5fa' : (isVip ? '#fbbf24' : '#60a5fa')}; border: 1px solid ${isUserAdmin ? 'rgba(59, 130, 246, 0.4)' : (isVip ? 'rgba(245, 158, 11, 0.4)' : 'rgba(59, 130, 246, 0.3)')};">
                        ${isUserAdmin ? '🛡️ Administrador' : (isVip ? '👑 Assinante VIP' : '🎁 Conta Gratuita')}
                    </div>
                `;
            }

            populateProfileFields();
            loadPreferencesFields();
            updateTelegramStatusUI();
            loadUserRequestsCount();
            loadUserReviewsCount();

            const currentSec = localStorage.getItem('bf_settings_section') || 'profile';
            switchSettingsSection(currentSec);
        }

        function populateProfileFields() {
            if (!currentUser) return;

            const uInput = document.getElementById('settings-input-username');
            const eInput = document.getElementById('settings-input-email');
            const avatarUrlInput = document.getElementById('settings-input-avatar-url');

            if (uInput) {
                uInput.value = currentUser.username || '';
                updateUsernameCounter(uInput);
            }

            const isTempEmail = !!(currentUser.is_temp_email || (currentUser.email && (currentUser.email.includes('@telegram.') || currentUser.email.endsWith('.user'))));

            if (eInput) {
                eInput.value = isTempEmail ? '' : (currentUser.email || '');
                eInput.placeholder = isTempEmail ? 'Digite seu e-mail real (ex: seuemail@gmail.com)' : 'seuemail@exemplo.com';
            }

            const noticeBox = document.getElementById('settings-telegram-email-notice');
            const tempEmailSpan = document.getElementById('settings-current-temp-email');
            if (noticeBox) {
                if (isTempEmail) {
                    noticeBox.style.display = 'block';
                    if (tempEmailSpan) tempEmailSpan.innerText = currentUser.email || 'telegram_temp';
                } else {
                    noticeBox.style.display = 'none';
                }
            }

            const passHeading = document.getElementById('settings-password-heading');
            const passDesc = document.getElementById('settings-password-desc');
            const passBadge = document.getElementById('settings-password-badge');
            const currPassGroup = document.getElementById('settings-group-current-pass');
            const newPassLabel = document.getElementById('settings-label-new-pass');

            const hasPassword = !!currentUser.has_custom_password && !isTempEmail;

            if (isTempEmail) {
                if (passHeading) passHeading.innerText = 'Cadastrar Senha de Acesso';
                if (passDesc) passDesc.innerHTML = '<strong style="color: #fbbf24;">Obrigatório:</strong> Escolha uma senha para poder fazer login diretamente com seu e-mail no BrasilFlix em qualquer aparelho, sem depender do Telegram.';
                if (passBadge) {
                    passBadge.innerText = 'Obrigatório p/ Login Direto';
                    passBadge.style.background = 'rgba(245, 158, 11, 0.2)';
                    passBadge.style.color = '#fbbf24';
                }
                if (currPassGroup) currPassGroup.style.display = 'none';
                if (newPassLabel) newPassLabel.innerText = 'Cadastrar Nova Senha:';
            } else if (hasPassword) {
                if (passHeading) passHeading.innerText = 'Alterar Senha de Acesso (Opcional)';
                if (passDesc) passDesc.innerText = 'Se desejar mudar sua senha de acesso, informe sua senha atual e a nova senha desejada abaixo.';
                if (passBadge) {
                    passBadge.innerText = 'Opcional';
                    passBadge.style.background = 'rgba(148, 163, 184, 0.2)';
                    passBadge.style.color = '#94a3b8';
                }
                if (currPassGroup) currPassGroup.style.display = 'block';
                if (newPassLabel) newPassLabel.innerText = 'Nova Senha:';
            } else {
                if (passHeading) passHeading.innerText = 'Cadastrar Senha de Acesso';
                if (passDesc) passDesc.innerText = 'Defina uma senha para acessar sua conta diretamente no site usando seu e-mail.';
                if (passBadge) {
                    passBadge.innerText = 'Recomendado';
                    passBadge.style.background = 'rgba(52, 211, 153, 0.2)';
                    passBadge.style.color = '#34d399';
                }
                if (currPassGroup) currPassGroup.style.display = 'none';
                if (newPassLabel) newPassLabel.innerText = 'Cadastrar Nova Senha:';
            }

            const currPassInput = document.getElementById('settings-input-current-pass');
            const newPassInput = document.getElementById('settings-input-new-pass');
            const confPassInput = document.getElementById('settings-input-confirm-pass');
            if (currPassInput) currPassInput.value = '';
            if (newPassInput) newPassInput.value = '';
            if (confPassInput) confPassInput.value = '';

            if (avatarUrlInput) avatarUrlInput.value = currentUser.avatar_url || '';
            renderAvatarPreview(currentUser.avatar_url, currentUser.username);
        }

        async function saveProfileChanges() {
            if (!userAuthToken) return;

            const username = document.getElementById('settings-input-username')?.value?.trim();
            const email = document.getElementById('settings-input-email')?.value?.trim();
            const avatar_url = document.getElementById('settings-input-avatar-url')?.value?.trim() || null;

            const currentPass = document.getElementById('settings-input-current-pass')?.value || '';
            const newPass = document.getElementById('settings-input-new-pass')?.value || '';
            const confPass = document.getElementById('settings-input-confirm-pass')?.value || '';

            if (!username) {
                showToast('Informe um nome de usuário válido.', 'error');
                return;
            }

            const isTempEmail = !!(currentUser.is_temp_email || (currentUser.email && (currentUser.email.includes('@telegram.') || currentUser.email.endsWith('.user'))));
            const hasPassword = !!currentUser.has_custom_password && !isTempEmail;

            if (isTempEmail) {
                if (!email) {
                    showToast('Por favor, informe seu endereço de e-mail real.', 'error');
                    return;
                }
                if (!newPass) {
                    showToast('Cadastre uma senha de acesso para poder fazer login diretamente com seu e-mail.', 'error');
                    return;
                }
            }

            if (newPass || confPass) {
                if (newPass.length < 6) {
                    showToast('A senha deve conter pelo menos 6 caracteres.', 'error');
                    return;
                }
                if (newPass !== confPass) {
                    showToast('As senhas digitadas não coincidem. Verifique a confirmação.', 'error');
                    return;
                }
                if (hasPassword && !currentPass) {
                    showToast('Informe sua senha atual para autorizar a troca de senha.', 'error');
                    return;
                }
            }

            const btn = document.getElementById('btn-save-profile');
            if (btn) {
                btn.disabled = true;
                btn.innerText = 'Salvando...';
            }

            try {
                const payload = {
                    username,
                    avatar_url
                };

                if (email) payload.email = email;
                if (newPass) {
                    payload.new_password = newPass;
                    if (hasPassword) payload.current_password = currentPass;
                }

                const res = await fetch('/api/user/profile', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userAuthToken}`
                    },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();
                if (data && data.success) {
                    if (data.token) {
                        userAuthToken = 'session';
                    }
                    currentUser = { ...currentUser, ...data.user };
                    updateUserHeaderUI(currentUser);
                    populateProfileFields();
                    showToast(data.message || '✨ Dados da conta atualizados com sucesso!', 'success');
                } else {
                    showToast(data.message || 'Erro ao atualizar dados.', 'error');
                }
            } catch (e) {
                showToast('Erro de conexão ao atualizar perfil.', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = '💾 Salvar Alterações';
                }
            }
        }

        async function savePreferencesDirectly() {
            const defaultAudio = document.getElementById('settings-pref-audio')?.value || 'ask';
            const spoilerBlur = !!document.getElementById('settings-pref-spoiler')?.checked;

            localStorage.setItem('bf_pref_default_audio', defaultAudio);
            localStorage.setItem('bf_pref_spoiler_blur', String(spoilerBlur));

            if (userAuthToken) {
                try {
                    const res = await fetch('/api/user/profile', {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${userAuthToken}`
                        },
                        body: JSON.stringify({
                            preferencias: {
                                defaultAudio,
                                spoilerBlur
                            }
                        })
                    });
                    const data = await res.json();
                    if (data && data.success) {
                        currentUser.preferencias = data.user.preferencias;
                    }
                } catch (e) {
                    console.warn('Erro ao sincronizar preferências com servidor:', e);
                }
            }

            showToast('Preferências atualizadas!', 'success');
        }

        function updateTelegramStatusUI() {
            const descEl = document.getElementById('settings-telegram-status-text');
            const actionEl = document.getElementById('settings-telegram-action-box');
            if (!descEl || !actionEl) return;

            if (currentUser?.telegram_id) {
                descEl.innerHTML = `
                    <span style="color: #34d399; font-weight: 800;">✅ Conta Vinculada com Sucesso!</span><br>
                    Seu ID Telegram <code>${currentUser.telegram_id}</code> está sincronizado com o BrasilFlix.
                `;
                actionEl.innerHTML = `
                    <div style="display: flex; gap: 8px;">
                        <a href="https://t.me/BrasilFlix_bot" target="_blank" class="btn-telegram-link">
                            🤖 Abrir Bot
                        </a>
                    </div>
                `;
            } else {
                descEl.innerText = 'Conecte seu Telegram oficial ao BrasilFlix para receber avisos de novos episódios, atualizações dos seus pedidos e sincronização VIP.';
                actionEl.innerHTML = `
                    <button type="button" class="btn-telegram-link" onclick="startTelegramLinking()">
                        🔗 Vincular ao Telegram
                    </button>
                `;
            }
        }

        async function startTelegramLinking() {
            if (!userAuthToken) return;

            const actionEl = document.getElementById('settings-telegram-action-box');
            if (actionEl) actionEl.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">Gerando código seguro...</span>';

            try {
                const res = await fetch('/api/user/telegram-link/create', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${userAuthToken}`
                    }
                });

                const data = await res.json();
                if (data && data.success && data.botUrl) {
                    window.open(data.botUrl, '_blank');

                    if (actionEl) {
                        actionEl.innerHTML = `
                            <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">
                                <a href="${data.botUrl}" target="_blank" class="btn-telegram-link">
                                    🚀 Abrir Bot no Telegram
                                </a>
                                <span style="font-size: 11px; color: #fbbf24;">⏳ Aguardando confirmação no bot...</span>
                            </div>
                        `;
                    }

                    if (telegramLinkCheckInterval) clearInterval(telegramLinkCheckInterval);
                    telegramLinkCheckInterval = setInterval(async () => {
                        try {
                            const cRes = await fetch(`/api/user/telegram-link/check/${data.code}`);
                            const cData = await cRes.json();
                            if (cData.status === 'completed') {
                                clearInterval(telegramLinkCheckInterval);
                                telegramLinkCheckInterval = null;
                                if (currentUser) {
                                    currentUser.telegram_id = cData.telegramUser?.id || true;
                                }
                                updateTelegramStatusUI();
                                showToast('🎉 Conta vinculada ao Telegram com sucesso!', 'success');
                            } else if (cData.status === 'expired') {
                                clearInterval(telegramLinkCheckInterval);
                                telegramLinkCheckInterval = null;
                                updateTelegramStatusUI();
                            }
                        } catch (e) { }
                    }, 2500);
                }
            } catch (e) {
                showToast('Erro ao iniciar vinculação ao Telegram.', 'error');
                updateTelegramStatusUI();
            }
        }

        async function loadUserRequestsCount() {
            if (!userAuthToken) return;
            try {
                const res = await fetch('/api/user/requests', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                const badge = document.getElementById('settings-requests-badge');
                if (badge && data && data.requests) {
                    badge.innerText = data.requests.length;
                }
            } catch (e) { }
        }

        async function loadUserRequests() {
            const listEl = document.getElementById('settings-requests-list');
            if (!listEl || !userAuthToken) return;

            listEl.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">Carregando pedidos...</div>';

            try {
                const res = await fetch('/api/user/requests', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                const requests = data.requests || [];

                const badge = document.getElementById('settings-requests-badge');
                if (badge) badge.innerText = requests.length;

                if (requests.length === 0) {
                    listEl.innerHTML = `
                        <div style="text-align: center; padding: 32px 16px; color: var(--text-muted);">
                            <div style="font-size: 32px; margin-bottom: 8px;">🎬</div>
                            <div style="font-weight: 700; color: #fff;">Você ainda não fez nenhum pedido de filme ou série.</div>
                            <div style="font-size: 12px; margin-top: 4px;">Clique em "+ Fazer Novo Pedido" para solicitar títulos ao catálogo.</div>
                        </div>
                    `;
                    return;
                }

                listEl.innerHTML = requests.map(req => {
                    const status = req.status || (req.processado ? 'adicionado' : 'pendente');
                    let statusClass = 'pendente';
                    let statusLabel = '⏳ Pendente';

                    if (status === 'adicionado' || req.processado) {
                        statusClass = 'atendido';
                        statusLabel = '✓ Atendido';
                    } else if (status === 'em_processamento' || status === 'na_fila') {
                        statusClass = 'processando';
                        statusLabel = '⚡ Na Fila / Baixando';
                    } else if (status === 'recusado') {
                        statusClass = 'recusado';
                        statusLabel = '✕ Recusado';
                    }
                    const dateStr = req.created_at ? new Date(req.created_at).toLocaleDateString('pt-BR') : '';

                    return `
                        <div class="settings-request-row">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <span style="font-size: 20px;">${req.tipo === 'serie' ? '📺' : (req.tipo === 'anime' ? '🌸' : (req.tipo === 'dorama' ? '🇰🇷' : '🎬'))}</span>
                                <div>
                                    <div style="font-size: 14px; font-weight: 800; color: #ffffff;">${req.nome}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">${req.tipo === 'serie' ? 'Série' : (req.tipo === 'anime' ? 'Anime' : (req.tipo === 'dorama' ? 'Dorama' : 'Filme'))} • Solicitado em ${dateStr}</div>
                                </div>
                            </div>
                            <span class="settings-badge-status ${statusClass}">${statusLabel}</span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                listEl.innerHTML = '<div style="text-align: center; padding: 20px; color: #f87171;">Erro ao carregar lista de pedidos.</div>';
            }
        }

        async function loadUserReviewsCount() {
            if (!userAuthToken) return;
            try {
                const res = await fetch('/api/user/reviews', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                const badge = document.getElementById('settings-reviews-badge');
                if (badge && data) {
                    badge.innerText = data.total || 0;
                }
            } catch (e) { }
        }

        async function loadUserReviews() {
            const listEl = document.getElementById('settings-reviews-list');
            if (!listEl || !userAuthToken) return;

            listEl.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">Carregando avaliações...</div>';

            try {
                const res = await fetch('/api/user/reviews', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                const filmes = data.filmes || [];
                const series = data.series || [];

                const badge = document.getElementById('settings-reviews-badge');
                if (badge) badge.innerText = data.total || 0;

                if (filmes.length === 0 && series.length === 0) {
                    listEl.innerHTML = `
                        <div style="text-align: center; padding: 32px 16px; color: var(--text-muted);">
                            <div style="font-size: 32px; margin-bottom: 8px;">⭐</div>
                            <div style="font-weight: 700; color: #fff;">Você ainda não publicou nenhuma avaliação.</div>
                            <div style="font-size: 12px; margin-top: 4px;">Avalie seus filmes e episódios favoritos para vê-los organizados aqui!</div>
                        </div>
                    `;
                    return;
                }

                let html = '';

                // Filmes
                if (filmes.length > 0) {
                    html += `
                        <div style="font-size: 14px; font-weight: 900; color: #60a5fa; margin-bottom: 10px; display: flex; align-items: center; gap: 6px;">
                            <span>🎬</span> Filmes Avaliados (${filmes.length})
                        </div>
                    `;
                    html += filmes.map(r => {
                        const dateStr = new Date(r.created_at).toLocaleDateString('pt-BR');
                        const poster = r.poster_url || '';
                        return `
                            <div class="settings-review-group" style="margin-bottom: 12px;">
                                <div class="settings-review-group-header">
                                    ${poster ? `<img src="${poster}" class="settings-review-group-img" alt="${r.computed_title}">` : ''}
                                    <div style="flex: 1;">
                                        <div style="font-size: 15px; font-weight: 800; color: #fff;">${r.computed_title}</div>
                                        <div style="font-size: 11px; color: var(--text-muted);">${dateStr ? `Filme • Avaliado em ${dateStr}` : 'Filme'}</div>
                                    </div>
                                    <span style="font-size: 12px; font-weight: 900; color: #fbbf24; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.3); padding: 4px 8px; border-radius: 8px;">★ ${r.rating}/10</span>
                                </div>
                                <div class="settings-review-item">
                                    <div style="font-size: 13px; color: #e2e8f0; line-height: 1.4;">${escapeHtml(r.comentario)}</div>
                                    <div style="display: flex; justify-content: flex-end; margin-top: 6px;">
                                        <button type="button" class="btn-action" style="color: #f87171; font-size: 11px; padding: 2px 8px;" onclick="deleteUserReviewFromSettings(${r.id})">Excluir</button>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }

                // Séries
                if (series.length > 0) {
                    html += `
                        <div style="font-size: 14px; font-weight: 900; color: #34d399; margin: 18px 0 10px 0; display: flex; align-items: center; gap: 6px;">
                            <span>📺</span> Séries & Episódios Avaliados (${series.length})
                        </div>
                    `;
                    html += series.map(s => {
                        const poster = s.posterUrl || '';
                        return `
                            <div class="settings-review-group" style="margin-bottom: 14px;">
                                <div class="settings-review-group-header">
                                    ${poster ? `<img src="${poster}" class="settings-review-group-img" alt="${s.title}">` : ''}
                                    <div style="flex: 1;">
                                        <div style="font-size: 15px; font-weight: 800; color: #fff;">${s.title}</div>
                                        <div style="font-size: 11px; color: var(--text-muted);">${(s.generalReviews.length + s.episodeReviews.length)} comentários registrados</div>
                                    </div>
                                </div>

                                ${s.generalReviews.map(r => `
                                    <div class="settings-review-item">
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                            <span style="font-size: 11px; font-weight: 800; color: #60a5fa;">💬 Avaliação Geral da Série</span>
                                            <span style="font-size: 11px; font-weight: 800; color: #fbbf24;">★ ${r.rating}/10</span>
                                        </div>
                                        <div style="font-size: 13px; color: #e2e8f0;">${escapeHtml(r.comentario)}</div>
                                        <div style="display: flex; justify-content: flex-end; margin-top: 6px;">
                                            <button type="button" class="btn-action" style="color: #f87171; font-size: 11px; padding: 2px 8px;" onclick="deleteUserReviewFromSettings(${r.id})">Excluir</button>
                                        </div>
                                    </div>
                                `).join('')}

                                ${s.episodeReviews.map(r => `
                                    <div class="settings-review-item">
                                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                                            <span style="font-size: 11px; font-weight: 800; color: #34d399;">🎬 Temporada ${r.season_num || 1} • Episódio ${r.episode_num || 1}</span>
                                            <span style="font-size: 11px; font-weight: 800; color: #fbbf24;">★ ${r.rating}/10</span>
                                        </div>
                                        <div style="font-size: 13px; color: #e2e8f0;">${escapeHtml(r.comentario)}</div>
                                        <div style="display: flex; justify-content: flex-end; margin-top: 6px;">
                                            <button type="button" class="btn-action" style="color: #f87171; font-size: 11px; padding: 2px 8px;" onclick="deleteUserReviewFromSettings(${r.id})">Excluir</button>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        `;
                    }).join('');
                }

                listEl.innerHTML = html;
            } catch (e) {
                listEl.innerHTML = '<div style="text-align: center; padding: 20px; color: #f87171;">Erro ao carregar avaliações.</div>';
            }
        }

        async function deleteUserReviewFromSettings(reviewId) {
            if (!confirm('Deseja realmente excluir este comentário?')) return;
            try {
                const res = await fetch(`/api/media/comentarios/${reviewId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                if (data && data.success) {
                    showToast('Comentário excluído com sucesso.', 'info');
                    loadUserReviews();
                } else {
                    showToast(data.message || 'Erro ao excluir comentário.', 'error');
                }
            } catch (e) {
                showToast('Erro de conexão ao excluir comentário.', 'error');
            }
        }

        /* ═══════════════════════════════════════════════════════════════════════
           🎁 CONFIRMAÇÃO DE CONSUMO DE COTA GRATUITA
           ═══════════════════════════════════════════════════════════════════════ */

        let pendingStreamAction = null;

        async function showQuotaConfirmationModal(title, type, onConfirm, mediaKey = null) {
            // Acesso 100% gratuito e ilimitado para assistir com anúncios discretos
            if (typeof onConfirm === 'function') {
                onConfirm();
            }
        }

        function showQuotaLimitExceededModal(type, customMsg) {
            const desc = document.getElementById('quota-limit-modal-desc');
            if (desc) {
                desc.innerHTML = customMsg
                    ? `${escapeHtml(customMsg)}<br><br>Para maratonar todos os filmes, séries e animes <strong>sem limites e sem anúncios</strong>, assine o VIP por apenas <strong>R$ 15,00/mês</strong>!`
                    : `Você está na versão gratuita com anúncios discretos.<br><br>Assine o VIP por apenas <strong>R$ 15,00/mês</strong> para assistir com zero anúncios e velocidade máxima!`;
            }
            const modal = document.getElementById('quota-limit-modal');
            if (modal) modal.classList.add('active');
        }

        function closeQuotaLimitModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'quota-limit-modal')) return;
            const modal = document.getElementById('quota-limit-modal');
            if (modal) modal.classList.remove('active');
        }

        async function updateDetailQuotaPill(type) {
            const pill = document.getElementById('detail-quota-pill');
            const text = document.getElementById('detail-quota-pill-text');
            if (!pill || !text) return;

            const isVip = isBfVipUser();
            if (isVip) {
                pill.className = 'detail-quota-pill vip';
                text.innerText = '👑 VIP Ativo • Zero Anúncios';
                return;
            }

            pill.className = 'detail-quota-pill';
            text.innerHTML = '🎁 Grátis • Ilimitado (Com Anúncios)';
        }

        function closeQuotaConfirmModal() {
            const modal = document.getElementById('quota-confirm-modal');
            if (modal) modal.classList.remove('active');
            pendingStreamAction = null;
        }

        document.getElementById('btn-confirm-spend-credit')?.addEventListener('click', async () => {
            const action = pendingStreamAction;
            closeQuotaConfirmModal();
            if (action) action();
        });

        let currentDetailMedia = null;
        let currentDetailType = 'filme';
        let composerRatingValue = 10;

        function openModalById(id, type) {
            openMediaDetailPage(id, type, true);
        }

        async function openMediaDetailPage(id, type, updateUrl = true, retryCount = 0) {
            if (typeof closeWebPlayer === 'function') closeWebPlayer();
            let item = null;
            if (type === 'serie' || type === 'dorama' || type === 'anime') {
                item = (fullCatalog.series || []).find(i => String(i.id) === String(id));
            } else if (type === 'filme') {
                item = (fullCatalog.filmes || []).find(i => String(i.id) === String(id));
            }
            if (!item) {
                item = (fullCatalog.series || []).find(i => String(i.id) === String(id)) ||
                    (fullCatalog.filmes || []).find(i => String(i.id) === String(id));
            }
            if (!item) {
                if (retryCount < 3) {
                    setTimeout(() => {
                        openMediaDetailPage(id, type, updateUrl, retryCount + 1);
                    }, 400);
                    return;
                }
                showToast('Título não encontrado ou temporariamente indisponível no catálogo.', 'info');
                switchNavCategory('inicio', true);
                return;
            }

            const isSerie = (type === 'serie' || type === 'dorama' || type === 'anime') ||
                item.itemType === 'serie' ||
                item.tipo === 'serie' ||
                !!item.temporadas ||
                (item.totalEpisodios !== undefined && item.totalEpisodios !== null);

            if (isSerie && !item.temporadas) {
                try {
                    Object.assign(item, await getSeriesDetails(item.id));
                } catch (error) {
                    showToast(error.message, 'error');
                    return;
                }
            }
            currentDetailMedia = item;
            currentDetailType = isSerie ? 'serie' : 'filme';
            trackAuditEvent('TITLE_OPENED', { mediaId: item.id, title: item.nome || item.title, metadata: { type: currentDetailType } });

            // Guarda estado para F5
            localStorage.setItem('bf_active_tab', 'tab-media-detail');
            localStorage.setItem('bf_active_media_id', String(item.id));
            localStorage.setItem('bf_active_media_type', currentDetailType);

            if (updateUrl) {
                const _slug = getMediaSlug(item);
                const _slugParam = _slug ? `${item.id}-${_slug}` : String(item.id);
                const newHash = `#${currentDetailType}/${_slugParam}`;
                if (window.location.hash !== newHash) {
                    history.pushState(null, '', newHash);
                }
            }

            // Oculta abas e ativa tab-media-detail
            switchTab('tab-media-detail', false);
            document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));

            // Fecha modal antigo se estiver aberto
            document.getElementById('media-modal')?.classList.remove('active');

            renderMediaDetailView(item, isSerie);
            const _mainAreaDetail = document.getElementById('app-main-area');
            if (_mainAreaDetail) _mainAreaDetail.scrollTo({ top: 0, behavior: 'smooth' });

            // Carrega avaliações da comunidade
            loadMediaReviews(currentDetailType, item.id);
        }

        function returnToCatalog() {
            const savedNav = localStorage.getItem('bf_active_nav') || 'inicio';
            switchNavCategory(savedNav, true);
        }

        // ── GERENCIADOR DE PROGRESSO DE REPRODUÇÃO & EPISÓDIOS ASSISTIDOS ──
        let userWatchProgress = {};

        function getGuestToken() {
            let token = localStorage.getItem('bf_guest_token');
            if (!token) {
                token = 'gst_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
                localStorage.setItem('bf_guest_token', token);
            }
            return token;
        }

        async function loadUserWatchProgress() {
            try {
                const headers = { 'x-guest-token': getGuestToken() };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;
                const res = await fetch('/api/progress/all', { headers });
                const data = await res.json();
                if (data && data.success && data.progress) {
                    userWatchProgress = data.progress;
                    if (currentNavMode === 'inicio') {
                        renderNetflixRails();
                    }
                }
            } catch (e) {
                console.warn('Aviso ao carregar progresso do servidor:', e);
            }
        }

        function getEpisodeProgress(mediaId, seasonNum, epNum) {
            const m = userWatchProgress[String(mediaId)];
            if (!m || !m.episodes) return null;
            return m.episodes[`${seasonNum}_${epNum}`] || null;
        }

        function isEpisodeCompleted(mediaId, seasonNum, epNum) {
            const prog = getEpisodeProgress(mediaId, seasonNum, epNum);
            return prog?.completed || false;
        }

        function getMovieProgress(mediaId) {
            const m = userWatchProgress[String(mediaId)];
            if (!m || !m.episodes) return null;
            return m.episodes['0_0'] || m.lastWatched || null;
        }

        function getResumeInfoForSerie(serie) {
            if (!serie || !serie.temporadas || serie.temporadas.length === 0) {
                return { label: 'Assistir 1º Episódio', season: 1, episode: 1, isResume: false, isNext: false, isAllCompleted: false };
            }

            const mProgress = userWatchProgress[String(serie.id)];
            if (!mProgress || !mProgress.episodes) {
                const t1 = serie.temporadas[0];
                const ep1 = (t1.episodios && t1.episodios[0]) ? t1.episodios[0].numero : 1;
                return { label: 'Assistir 1º Episódio', season: t1.numero, episode: ep1, isResume: false, isNext: false, isAllCompleted: false };
            }

            const allEps = [];
            for (const t of serie.temporadas) {
                for (const ep of (t.episodios || [])) {
                    allEps.push({ season: t.numero, episode: ep.numero, name: ep.nome || `Episódio ${ep.numero}` });
                }
            }

            if (allEps.length === 0) {
                return { label: 'Assistir 1º Episódio', season: 1, episode: 1, isResume: false, isNext: false, isAllCompleted: false };
            }

            // 1. Procura se há algum episódio em andamento (iniciado e não concluído)
            let inProgressEp = null;
            for (const ep of allEps) {
                const prog = mProgress.episodes[`${ep.season}_${ep.episode}`];
                if (prog && !prog.completed && prog.currentTime > 15) {
                    inProgressEp = { ...ep, currentTime: prog.currentTime, duration: prog.duration };
                    break;
                }
            }

            if (inProgressEp) {
                const timeMin = Math.floor(inProgressEp.currentTime / 60);
                return {
                    label: `Continuar T${inProgressEp.season}:E${inProgressEp.episode} (${timeMin}m)`,
                    season: inProgressEp.season,
                    episode: inProgressEp.episode,
                    isResume: true,
                    currentTime: inProgressEp.currentTime
                };
            }

            // 2. Procura o último episódio concluído para sugerir o próximo
            let lastCompletedIndex = -1;
            for (let i = 0; i < allEps.length; i++) {
                const ep = allEps[i];
                const prog = mProgress.episodes[`${ep.season}_${ep.episode}`];
                if (prog && prog.completed) {
                    lastCompletedIndex = i;
                }
            }

            if (lastCompletedIndex >= 0) {
                if (lastCompletedIndex + 1 < allEps.length) {
                    const nextEp = allEps[lastCompletedIndex + 1];
                    return {
                        label: `Continuar T${nextEp.season}:E${nextEp.episode}`,
                        season: nextEp.season,
                        episode: nextEp.episode,
                        isNext: true
                    };
                } else {
                    return {
                        label: '🔄 Assistir Novamente',
                        season: allEps[0].season,
                        episode: allEps[0].episode,
                        isAllCompleted: true
                    };
                }
            }

            const firstEp = allEps[0];
            return {
                label: 'Assistir 1º Episódio',
                season: firstEp.season,
                episode: firstEp.episode,
                isResume: false,
                isNext: false
            };
        }

        async function toggleEpisodeWatched(serieId, seasonNum, epNum, event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }

            const isComp = isEpisodeCompleted(serieId, seasonNum, epNum);
            const targetCompleted = !isComp;

            const sId = String(serieId);
            if (!userWatchProgress[sId]) {
                userWatchProgress[sId] = { mediaId: sId, mediaType: 'serie', episodes: {} };
            }
            const key = `${seasonNum}_${epNum}`;
            if (!userWatchProgress[sId].episodes[key]) {
                userWatchProgress[sId].episodes[key] = { season: seasonNum, episode: epNum, currentTime: 0, duration: 0, completed: targetCompleted };
            } else {
                userWatchProgress[sId].episodes[key].completed = targetCompleted;
            }

            if (currentDetailMedia && String(currentDetailMedia.id) === sId) {
                renderDetailSeasonsHtmlOnly(currentDetailMedia, currentSelectedSeasonNum);
                updateDetailPlayButtonHtml(currentDetailMedia, true);
            }

            showToast(targetCompleted ? `✓ Episódio ${epNum} marcado como assistido!` : `Episódio ${epNum} desmarcado.`, 'info');

            try {
                const headers = { 'Content-Type': 'application/json', 'x-guest-token': getGuestToken() };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;
                await fetch('/api/progress/toggle-watched', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        mediaId: sId,
                        mediaType: 'serie',
                        seasonNum,
                        epNum,
                        completed: targetCompleted
                    })
                });
            } catch (err) {
                console.error('Erro ao salvar toggle no servidor:', err);
            }
        }

        async function toggleMovieWatched(movieId, event) {
            if (event) {
                event.stopPropagation();
                event.preventDefault();
            }
            const prog = getMovieProgress(movieId);
            const targetCompleted = !(prog?.completed);

            const mId = String(movieId);
            if (!userWatchProgress[mId]) {
                userWatchProgress[mId] = { mediaId: mId, mediaType: 'filme', episodes: {} };
            }
            userWatchProgress[mId].episodes['0_0'] = { season: 0, episode: 0, currentTime: 0, duration: 0, completed: targetCompleted };
            userWatchProgress[mId].lastWatched = { season: 0, episode: 0, currentTime: 0, duration: 0, completed: targetCompleted };

            if (currentDetailMedia && String(currentDetailMedia.id) === mId) {
                renderMediaDetailView(currentDetailMedia, false);
            }

            showToast(targetCompleted ? '✓ Filme marcado como assistido!' : 'Filme desmarcado.', 'info');

            try {
                const headers = { 'Content-Type': 'application/json', 'x-guest-token': getGuestToken() };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;
                await fetch('/api/progress/toggle-watched', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        mediaId: mId,
                        mediaType: 'filme',
                        seasonNum: 0,
                        epNum: 0,
                        completed: targetCompleted
                    })
                });
            } catch (err) {
                console.error('Erro ao alternar filme assistido:', err);
            }
        }

        let lastProgressSaveTime = 0;
        async function saveVideoProgressToServer(currentPlayingMedia, currentTime, duration, forceCompleted = false) {
            if (!currentPlayingMedia || !currentPlayingMedia.id) return;
            const now = Date.now();
            if (!forceCompleted && (now - lastProgressSaveTime < 5000)) return;
            lastProgressSaveTime = now;

            const mediaId = String(currentPlayingMedia.id);
            const mediaType = currentPlayingMedia.type || 'filme';
            const seasonNum = parseInt(currentPlayingMedia.season, 10) || 0;
            const epNum = parseInt(currentPlayingMedia.episode, 10) || 0;
            const epName = currentPlayingMedia.epName || currentPlayingMedia.title || '';
            const cTime = Math.floor(currentTime);
            const dur = Math.floor(duration);

            let isCompleted = forceCompleted;
            if (!isCompleted && dur > 30 && cTime >= (dur * 0.85)) {
                isCompleted = true;
            }

            if (!userWatchProgress[mediaId]) {
                userWatchProgress[mediaId] = { mediaId, mediaType, episodes: {} };
            }
            const key = `${seasonNum}_${epNum}`;
            userWatchProgress[mediaId].episodes[key] = {
                season: seasonNum,
                episode: epNum,
                epName,
                currentTime: cTime,
                duration: dur,
                completed: isCompleted,
                lastWatchedAt: new Date().toISOString()
            };
            userWatchProgress[mediaId].lastWatched = {
                season: seasonNum,
                episode: epNum,
                epName,
                currentTime: cTime,
                duration: dur,
                completed: isCompleted,
                lastWatchedAt: new Date().toISOString()
            };

            try {
                const headers = { 'Content-Type': 'application/json', 'x-guest-token': getGuestToken() };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;
                fetch('/api/progress/save', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        mediaId,
                        mediaType,
                        seasonNum,
                        epNum,
                        epName,
                        currentTime: cTime,
                        duration: dur,
                        completed: isCompleted
                    })
                }).catch(() => { });
            } catch (err) { }
        }

        function updateDetailPlayButtonHtml(item, isSerie) {
            const container = document.getElementById('detail-play-actions-slot');
            if (!container) return;

            if (isSerie) {
                const resumeInfo = getResumeInfoForSerie(item);
                container.innerHTML = `
                    <button class="btn-play-primary" id="detail-main-play-btn" onclick="openWebPlayerEpisode('${item.id}', ${resumeInfo.season}, ${resumeInfo.episode})">
                        <span>▶</span>
                        <span>${resumeInfo.label}</span>
                    </button>
                `;
            } else {
                const movieProg = getMovieProgress(item.id);
                const isCompleted = movieProg?.completed || false;
                const curTime = movieProg?.currentTime || 0;
                let btnLabel = 'Assistir Filme';
                if (isCompleted) {
                    btnLabel = '🔄 Assistir Novamente';
                } else if (curTime > 30) {
                    const timeMin = Math.floor(curTime / 60);
                    btnLabel = `Continuar Filme (${timeMin}m)`;
                }

                container.innerHTML = `
                    <button class="btn-play-primary" id="detail-main-play-btn" onclick="openWebPlayerForMovie('${item.id}')">
                        <span>${isCompleted ? '🔄' : '▶'}</span>
                        <span>${btnLabel}</span>
                    </button>
                `;
            }
        }

        function renderMediaDetailView(item, isSerie) {
            const container = document.getElementById('media-detail-view-content');
            if (!container) return;

            const poster = item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
            const backdrop = item.backdropUrl || item.posterUrl || '';
            const rating = item.nota ? Number(item.nota).toFixed(1) : '8.0';
            const isFav = (userFavorites || []).some(f => String(f.id) === String(item.id));
            const isDub = item.isDublado || !!item.versoes?.dublado;
            const isLeg = item.isLegendado || !!item.versoes?.legendado;
            const audioText = isDub && isLeg ? '🔊 Dub/Leg' : (isDub ? '🔊 Dublado' : (isLeg ? '💬 Legendado' : (item.audioBadge || '🔊 Português')));
            const qualText = item.qualidade || (item.isCam ? 'CAM' : '1080p Full HD');

            // Gêneros (tags visuais traduzidas)
            const genresList = (item.generos || []).map(g => translateGenre(g));
            const genresPills = genresList.map(g => `<span class="genre-pill" style="font-size: 12px; padding: 4px 10px; cursor: default;">${g}</span>`).join('');

            // Ação de Play Principal Dinâmica (Continuar Ep X / Assistir)
            let playBtnHtml = '';
            if (isSerie) {
                const resumeInfo = getResumeInfoForSerie(item);
                playBtnHtml = `
                    <button class="btn-play-primary" id="detail-main-play-btn" onclick="openWebPlayerEpisode('${item.id}', ${resumeInfo.season}, ${resumeInfo.episode})">
                        <span>▶</span>
                        <span>${resumeInfo.label}</span>
                    </button>
                `;
            } else {
                const movieProg = getMovieProgress(item.id);
                const isCompleted = movieProg?.completed || false;
                const curTime = movieProg?.currentTime || 0;
                let btnLabel = 'Assistir Filme';
                if (isCompleted) {
                    btnLabel = '🔄 Assistir Novamente';
                } else if (curTime > 30) {
                    const timeMin = Math.floor(curTime / 60);
                    btnLabel = `Continuar Filme (${timeMin}m)`;
                }

                playBtnHtml = `
                    <button class="btn-play-primary" id="detail-main-play-btn" onclick="openWebPlayerForMovie('${item.id}')">
                        <span>${isCompleted ? '🔄' : '▶'}</span>
                        <span>${btnLabel}</span>
                    </button>
                `;
            }

            // Títulos semelhantes
            const allItems = [...(fullCatalog.series || []), ...(fullCatalog.filmes || [])];
            const primaryGenre = genresList[0] || '';
            const recs = allItems
                .filter(i => String(i.id) !== String(item.id) && (primaryGenre ? (i.generos || []).includes(primaryGenre) : true))
                .slice(0, 8);

            container.innerHTML = `
                <!-- BACKDROP & HERO COM INFORMAÇÕES COMPLETAS -->
                <div class="media-detail-backdrop">
                    <div class="media-detail-bg-image" style="background-image: ${backdrop ? `url('${backdrop}')` : 'none'};"></div>
                    <div class="backdrop-overlay-gradient"></div>

                    <!-- BARRA SUPERIOR DA PÁGINA (VOLTAR & COMPARTILHAR) -->
                    <div class="media-detail-topbar">
                        <button class="btn-back-catalog" onclick="returnToCatalog()" title="Voltar ao Catálogo">
                            <span class="btn-icon">←</span>
                            <span class="btn-text">Voltar ao Catálogo</span>
                        </button>

                        <div style="display: flex; align-items: center; gap: 8px;">
                            <button class="btn-back-catalog" onclick="handleShareCurrentMediaDirect('${item.nome.replace(/'/g, "\\'")}', '${currentDetailType}', '${item.id}')" title="Compartilhar Link">
                                <span class="btn-icon">🔗</span>
                                <span class="btn-text">Compartilhar</span>
                            </button>
                        </div>
                    </div>

                    <!-- CONTEÚDO PRINCIPAL DO HERO -->
                    <div class="media-detail-hero-content">
                        <div class="detail-poster-wrapper">
                            <img src="${poster}" class="detail-poster-img" alt="${escapeHtml(item.nome)}">
                            ${item.isCam ? '<div class="badge-overlay badge-cam-tag">CAM</div>' : ''}
                        </div>

                        <div class="detail-main-info">
                            <div style="font-size: 13px; font-weight: 800; color: #38bdf8; text-transform: uppercase; letter-spacing: 1px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                <span>${isSerie ? (item.isAnime ? 'Anime' : (item.isDorama ? 'Dorama' : 'Série')) : 'Filme'}</span>
                                ${(isSerie && (item.emLancamento || item.isLancamento)) ? `
                                    <span class="season-launching-badge" style="font-size: 10px; padding: 2px 7px;">
                                        <span class="season-launching-dot"></span> Em Lançamento
                                    </span>
                                ` : ''}
                            </div>

                            <h1 class="detail-title">${item.nome}</h1>
                            ${item.nomeOriginal && item.nomeOriginal !== item.nome ? `<div style="font-size: 14px; color: #94a3b8; margin-top: -6px;">Título Original: <em>${item.nomeOriginal}</em></div>` : ''}

                            <div class="detail-meta-row">
                                <div class="rating-badge-gold">★ ${rating} TMDB</div>
                                <div id="community-avg-badge" style="display: none; background: rgba(59, 130, 246, 0.2); border: 1px solid rgba(59, 130, 246, 0.4); color: #60a5fa; font-weight: 800; padding: 4px 10px; border-radius: 8px;">★ <span id="community-avg-val">-</span> Comunidade</div>
                                <span>${item.ano || '2026'}</span>
                                <span style="color: #60a5fa; font-weight: 700;">${audioText}</span>
                                <span>${qualText}</span>
                                ${isSerie ? `<span>${(item.temporadas && item.temporadas.length > 0) ? item.temporadas.length : (item.totalTemporadas || 1)} Temporada${((item.temporadas && item.temporadas.length > 0) ? item.temporadas.length : (item.totalTemporadas || 1)) > 1 ? 's' : ''} • ${(item.temporadas ? item.temporadas.reduce((a, t) => a + (t.episodios ? t.episodios.filter(e => !e._isPending).length : 0), 0) : 1)} Episódio${(item.temporadas ? item.temporadas.reduce((a, t) => a + (t.episodios ? t.episodios.filter(e => !e._isPending).length : 0), 0) : 1) > 1 ? 's' : ''}</span>` : ''}
                            </div>

                            ${genresPills ? `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0;">${genresPills}</div>` : ''}

                            <div class="detail-actions-row">
                                <div id="detail-play-actions-slot" style="display: contents;">
                                    ${playBtnHtml}
                                </div>

                                <button class="btn-detail-action" onclick="startPartyFromDetailMedia('${item.id}', '${currentDetailType}')" title="Assistir em grupo com amigos sincronizados">
                                    <span class="btn-action-icon">👥</span>
                                    <span class="btn-action-label">Assistir Junto</span>
                                </button>

                                <button class="btn-detail-action ${isFav ? 'active' : ''}" id="detail-fav-btn" onclick="toggleUserFavorite('${item.id}', '${currentDetailType}'); updateDetailFavButton(event);" title="Salvar na Minha Lista">
                                    <span class="btn-action-icon">${isFav ? '❤️' : '🤍'}</span>
                                    <span id="detail-fav-text" class="btn-action-label">${isFav ? 'Salvo' : 'Minha Lista'}</span>
                                </button>

                                <a href="https://t.me/BrasilFlix_bot?start=ver_${item.id}" target="_blank" class="btn-detail-action" style="text-decoration: none;" title="Assistir diretamente no Telegram">
                                    <span class="btn-action-icon">📱</span>
                                    <span class="btn-action-label">Telegram</span>
                                </a>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- SINOPSE & DETALHES -->
                <div class="detail-synopsis-box">
                    <div class="detail-synopsis-title">
                        <span>📖</span>
                        <span>Sinopse & Enredo</span>
                    </div>
                    <div class="detail-synopsis-text">
                        ${item.sinopse || item.descricao || 'Sinopse oficial em português disponível em breve.'}
                    </div>
                </div>

                <!-- SE FOR SÉRIE: ACORDEÃO DE TEMPORADAS -->
                ${isSerie ? `
                <div class="seasons-section" id="detail-seasons-section">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">
                        <h2 style="font-size: 18px; font-weight: 900; color: #fff; display: flex; align-items: center; gap: 8px;">
                            <span>📺</span> Temporadas &amp; Episódios
                        </h2>
                    </div>
                    <div class="seasons-accordion" id="detail-seasons-accordion"></div>
                </div>
                ` : ''}

                <!-- SEÇÃO DE AVALIAÇÕES E COMENTÁRIOS DA COMUNIDADE -->
                <div class="reviews-section" id="detail-reviews-section">
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
                        <h2 style="font-size: 18px; font-weight: 900; color: #fff; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0;">
                            <span>💬</span> <span>Avaliações da Comunidade (<span id="reviews-total-count">0</span>)</span>
                        </h2>
                        <div id="reviews-avg-badge-box" style="font-size: 13px; font-weight: 800; color: #fbbf24; flex-shrink: 0;"></div>
                    </div>

                    <!-- FORMULÁRIO DE NOVA AVALIAÇÃO -->
                    <div class="review-composer-card">
                        <div style="font-size: 14px; font-weight: 800; color: #fff; margin-bottom: 6px;">O que você achou deste título?</div>
                        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">Selecione sua nota e deixe sua opinião para ajudar outros membros da comunidade.</p>

                        <div class="star-rating-picker" id="star-picker-container">
                            <span style="font-size: 12px; font-weight: 700; color: #cbd5e1; margin-right: 6px;">Sua Nota:</span>
                            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(s => `
                                <button type="button" class="star-rating-btn ${s <= 10 ? 'active' : ''}" data-star="${s}" onclick="setReviewComposerRating(${s})" title="${s} de 10">★</button>
                            `).join('')}
                            <span id="star-picker-label" style="font-size: 13px; font-weight: 900; color: #fbbf24; margin-left: 8px;">10 / 10 ⭐</span>
                        </div>

                        <form onsubmit="handleUserSubmitReview(event, '${currentDetailType}', '${item.id}')">
                            ${!currentUser ? `
                            <div style="margin-bottom: 10px;">
                                <input type="text" id="review-guest-name" class="admin-input" style="margin-bottom: 0;" placeholder="Seu nome (ou faça login para comentar com seu perfil)">
                            </div>
                            ` : ''}

                            <textarea id="review-comment-input" class="review-textarea" minlength="3" maxlength="1000" placeholder="Escreva seu comentário sobre este filme ou série..." required></textarea>

                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; flex-wrap: wrap;">
                                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                                    <label class="spoiler-toggle-label">
                                        <input type="checkbox" id="review-has-spoiler" class="party-toggle-switch" style="width: 30px; height: 16px;">
                                        <span>⚠️ Marcar como Spoiler</span>
                                    </label>
                                    <button type="button" class="btn-timestamp-mark" onclick="insertCurrentTimestampToReview('review-comment-input')" title="Inserir tempo atual do vídeo no comentário">
                                        ⏱️ Marcar Tempo
                                    </button>
                                </div>
                                <button type="submit" class="btn-modal btn-modal-primary" style="padding: 10px 22px; font-size: 13px; font-weight: 800; border-radius: 10px;">
                                    🚀 Publicar Avaliação
                                </button>
                            </div>
                        </form>
                    </div>

                    <!-- FEED DE COMENTÁRIOS -->
                    <div id="reviews-feed-container">
                        <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 13px;">
                            Carregando comentários...
                        </div>
                    </div>
                </div>

                <!-- TÍTULOS RECOMENDADOS (CARROSSEL COM DESLIZAMENTO LATERAL) -->
                ${recs.length > 0 ? `
                <div class="netflix-rail-section" id="rail-section-detail-recs" style="margin-top: 24px; margin-bottom: 40px;">
                    <div class="rail-header">
                        <h3 class="rail-title" style="font-size: 20px;">Títulos Semelhantes</h3>
                    </div>
                    <div class="rail-slider-container">
                        <button class="rail-arrow-btn rail-arrow-left" onclick="slideRail('detail-recs', -1)" aria-label="Anterior">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
                        </button>
                        <div class="rail-slider-track" id="track-detail-recs">
                            ${recs.map(rec => {
                const recPoster = rec.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const recRating = rec.nota ? Number(rec.nota).toFixed(1) : '8.0';
                const recType = rec.itemType || (rec.temporadas ? 'serie' : 'filme');
                const isFav = userFavorites.some(f => String(f.id) === String(rec.id));
                const isRecSerie = (recType === 'serie' || !!rec.temporadas);
                const sub = isRecSerie ? getSerieSubtitleMeta(rec) : (rec.ano || '2026');

                return `
                                    <div class="rail-card" onclick="openMediaDetailPage('${rec.id}', '${recType}')">
                                        <div class="rail-poster-wrapper">
                                            <img src="${recPoster}" class="rail-poster-img" loading="lazy" alt="${rec.nome}">
                                            <button class="btn-fav-card ${isFav ? 'active' : ''}" onclick="toggleUserFavorite('${rec.id}', '${recType}', event)" title="${isFav ? 'Remover dos Favoritos' : 'Adicionar aos Favoritos'}">
                                                ${isFav ? '❤️' : '🤍'}
                                            </button>
                                        </div>
                                        <div class="rail-content">
                                            <h4 class="rail-card-title">${rec.nome}</h4>
                                            <div class="rail-card-sub">
                                                <span style="color: #fbbf24; font-weight: 800;">★ ${recRating}</span>
                                                <span>${sub}</span>
                                            </div>
                                        </div>
                                    </div>
                                `;
            }).join('')}
                        </div>
                        <button class="rail-arrow-btn rail-arrow-right" onclick="slideRail('detail-recs', 1)" aria-label="Próximo">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
                        </button>
                    </div>
                </div>
                ` : ''}
            `;

            if (isSerie) {
                renderDetailSeasonsAccordion(item);
            }
        }

        function updateDetailFavButton(event) {
            if (event) event.stopPropagation();
            const btn = document.getElementById('detail-fav-btn');
            const text = document.getElementById('detail-fav-text');
            if (!btn || !text || !currentDetailMedia) return;
            const isFav = userFavorites.some(f => String(f.id) === String(currentDetailMedia.id));
            btn.classList.toggle('active', isFav);
            btn.querySelector('span:first-child').innerText = isFav ? '❤️' : '🤍';
            text.innerText = isFav ? 'Salvo' : 'Minha Lista';
        }

        function scrollToReviewsSection() {
            const el = document.getElementById('detail-reviews-section');
            if (el) el.scrollIntoView({ behavior: 'smooth' });
        }

        function startPartyFromDetailMedia(mediaId, mediaType) {
            if (currentPartyRoom) {
                togglePartyPanel();
                showToast('Você já está em uma sala ativa!', 'info');
                return;
            }
            onPartyHeaderBtnClick();
        }

        function handleShareCurrentMediaDirect(title, type, id) {
            const url = `${window.location.origin}/#${type}/${id}`;
            navigator.clipboard.writeText(url).then(() => {
                showToast(`🔗 Link de "${title}" copiado para a área de transferência!`, 'success');
            }).catch(() => {
                showToast(url, 'info');
            });
        }

        function setReviewComposerRating(stars) {
            composerRatingValue = stars;
            const label = document.getElementById('star-picker-label');
            if (label) label.innerText = `${stars} / 10 ⭐`;
            document.querySelectorAll('.star-rating-btn').forEach(btn => {
                const s = Number(btn.getAttribute('data-star'));
                btn.classList.toggle('active', s <= stars);
            });
        }

        function parseTimestampToSeconds(timeStr) {
            if (!timeStr) return 0;
            const parts = timeStr.trim().split(':').map(Number);
            if (parts.some(isNaN)) return 0;
            if (parts.length === 3) {
                return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
            } else if (parts.length === 2) {
                return (parts[0] * 60) + parts[1];
            }
            return parts[0] || 0;
        }

        function formatSecondsToTimestamp(sec) {
            sec = Math.max(0, Math.floor(sec || 0));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const sPad = s < 10 ? '0' + s : s;
            const mPad = m < 10 ? '0' + m : m;
            if (h > 0) {
                return `${h}:${mPad}:${sPad}`;
            }
            return `${mPad}:${sPad}`;
        }

        function insertCurrentTimestampToReview(textareaId) {
            const textarea = document.getElementById(textareaId);
            if (!textarea) return;
            const video = document.getElementById('html5-video-player');
            const curTime = (video && video.currentTime > 0) ? video.currentTime : 0;
            const formatted = formatSecondsToTimestamp(curTime);

            const start = textarea.selectionStart ?? textarea.value.length;
            const end = textarea.selectionEnd ?? textarea.value.length;
            const before = textarea.value.substring(0, start);
            const after = textarea.value.substring(end);

            const prefix = (before.length > 0 && !before.endsWith(' ') && !before.endsWith('\n')) ? ' ' : '';
            const suffix = (after.length > 0 && !after.startsWith(' ') && !after.startsWith('\n')) ? ' ' : ' ';
            const insertText = `${prefix}${formatted}${suffix}`;

            textarea.value = before + insertText + after;
            textarea.focus();
            const newPos = start + insertText.length;
            textarea.setSelectionRange(newPos, newPos);
            showToast(`⏱️ Horário ${formatted} adicionado!`, 'info');
        }

        let pendingTimestampJump = null;

        function handleCommentTimestampClick(event, timeStr) {
            if (event) {
                event.preventDefault();
                event.stopPropagation();
            }
            const seconds = parseTimestampToSeconds(timeStr);
            const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || window.matchMedia('(pointer: coarse)').matches;

            if (isTouch) {
                // No mobile/touch: exige confirmação prévia para evitar toques acidentais durante rolagem
                pendingTimestampJump = { seconds, timeStr };
                const timeLabel = document.getElementById('timestamp-confirm-time');
                if (timeLabel) timeLabel.innerText = timeStr;
                const modal = document.getElementById('timestamp-confirm-modal');
                if (modal) modal.classList.add('active');
            } else {
                executeSeekToTimestamp(seconds, timeStr);
            }
        }

        function closeTimestampConfirmModal(e) {
            if (e) e.stopPropagation();
            const modal = document.getElementById('timestamp-confirm-modal');
            if (modal) modal.classList.remove('active');
            pendingTimestampJump = null;
        }

        function confirmTimestampJump() {
            const data = pendingTimestampJump;
            closeTimestampConfirmModal();
            if (data) {
                executeSeekToTimestamp(data.seconds, data.timeStr);
            }
        }

        function executeSeekToTimestamp(seconds, timeStr) {
            const video = document.getElementById('html5-video-player');
            const isPlayerActive = document.getElementById('tab-playback-page')?.classList.contains('active');

            if (!isPlayerActive || !currentPlayingMedia) {
                if (currentDetailMedia && currentDetailType === 'filme') {
                    openWebPlayerForMovie(currentDetailMedia.id);
                } else if (currentDetailMedia && currentDetailType === 'serie') {
                    openWebPlayerEpisode(currentDetailMedia.id, 1, 1);
                }
            }

            if (typeof switchTab === 'function') {
                switchTab('tab-playback-page', false);
            }

            setTimeout(() => {
                const v = document.getElementById('html5-video-player');
                if (v) {
                    v.currentTime = seconds;
                    v.play().catch(() => {});
                    const stage = document.getElementById('playback-player-stage');
                    if (stage) stage.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    showToast(`⏱️ Reprodução avançada para ${timeStr}!`, 'success');
                }
            }, 300);
        }

        function renderReviewCommentHtml(comentario, hasSpoiler) {
            let safeText = (comentario || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            // Converte timestamps formatados em botões clicáveis
            const timestampRegex = /\b(?:([0-9]{1,2}):)?([0-5]?[0-9]):([0-5][0-9])\b/g;
            safeText = safeText.replace(timestampRegex, (match) => {
                return `<button type="button" class="comment-time-tag" onclick="handleCommentTimestampClick(event, '${match}')" title="Pular vídeo para ${match}">⏱️ ${match}</button>`;
            });

            if (hasSpoiler) {
                return `
                    <div class="spoiler-container" onclick="this.classList.toggle('revealed')" title="Clique para revelar ou ocultar o spoiler">
                        <div class="spoiler-reveal-badge">
                            <span>⚠️ Este comentário contém spoiler. Clique para revelar.</span>
                        </div>
                        <div class="spoiler-text-blur">${safeText}</div>
                    </div>
                `;
            }
            return `<div style="font-size: 13.5px; color: #cbd5e1; line-height: 1.5;">${safeText}</div>`;
        }

        async function loadMediaReviews(mediaType, mediaId) {
            const feed = document.getElementById('reviews-feed-container');
            const countEl = document.getElementById('reviews-total-count');
            const avgBadge = document.getElementById('community-avg-badge');
            const avgVal = document.getElementById('community-avg-val');
            if (!feed) return;

            try {
                const res = await fetch(`/api/media/${mediaType}/${mediaId}/comentarios`);
                const data = await res.json();
                if (data && data.success) {
                    const reviews = data.reviews || [];
                    if (countEl) countEl.innerText = data.total || reviews.length;

                    if (data.avgRating && avgBadge && avgVal) {
                        avgVal.innerText = `${data.avgRating}/10`;
                        avgBadge.style.display = 'inline-flex';
                    }

                    if (reviews.length === 0) {
                        feed.innerHTML = `
                            <div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 13px;">
                                ✨ Seja o primeiro a avaliar e comentar sobre este título!
                            </div>
                        `;
                        return;
                    }

                    feed.innerHTML = reviews.map(r => {
                        const isOwner = currentUser && (String(currentUser.id) === String(r.user_id) || currentUser.role === 'admin');
                        const delBtn = isOwner ? `<button class="btn-action" style="padding: 2px 8px; font-size: 11px; color: #f87171;" onclick="deleteReviewDirect(${r.id}, '${mediaType}', '${mediaId}')">Excluir</button>` : '';
                        const dateStr = new Date(r.created_at).toLocaleDateString('pt-BR');
                        const initial = (r.username || 'U')[0].toUpperCase();
                        const hasSpoiler = !!(r.has_spoiler || r.hasSpoiler || r.spoiler);
                        const spoilerTag = hasSpoiler ? `<span class="spoiler-badge-tag">⚠️ Spoiler</span>` : '';

                        return `
                            <div class="review-item-card">
                                <div class="review-item-header">
                                    <div class="review-author">
                                        ${r.avatar_url ? `<img src="${safeImageUrl(r.avatar_url)}" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover; border: 1px solid rgba(255,255,255,0.15);" alt="${escapeHtml(r.username)}">` : `<div class="user-avatar-circle" style="width: 22px; height: 22px; font-size: 10px;">${initial}</div>`}
                                        <span>${escapeHtml(r.username)}</span>
                                        <span style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 2px 6px; border-radius: 6px; font-size: 11px; font-weight: 900;">★ ${r.rating}/10</span>
                                        ${spoilerTag}
                                    </div>
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <span style="font-size: 11px; color: var(--text-muted);">${dateStr}</span>
                                        ${delBtn}
                                    </div>
                                </div>
                                <div style="padding-left: 30px; margin-top: 4px;">
                                    ${renderReviewCommentHtml(r.comentario, hasSpoiler)}
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            } catch (e) {
                feed.innerHTML = `<div style="color: var(--text-muted); font-size: 12px; text-align: center;">Não foi possível carregar as avaliações no momento.</div>`;
            }
        }

        async function handleUserSubmitReview(e, mediaType, mediaId) {
            e.preventDefault();
            const commentInput = document.getElementById('review-comment-input');
            const guestInput = document.getElementById('review-guest-name');
            const spoilerChk = document.getElementById('review-has-spoiler');
            const comentario = commentInput?.value?.trim();
            const guestName = guestInput?.value?.trim();
            const hasSpoiler = !!(spoilerChk?.checked);

            if (!comentario) return;

            try {
                const headers = { 'Content-Type': 'application/json' };
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

                const res = await fetch(`/api/media/${mediaType}/${mediaId}/comentarios`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        rating: composerRatingValue,
                        comentario,
                        guestName,
                        hasSpoiler
                    })
                });

                const data = await res.json();
                if (data && data.success) {
                    showToast('Avaliação enviada com sucesso! Obrigado pela contribuição.', 'success');
                    if (commentInput) commentInput.value = '';
                    if (spoilerChk) spoilerChk.checked = false;
                    loadMediaReviews(mediaType, mediaId);
                } else {
                    showToast(data.message || 'Erro ao publicar avaliação.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao enviar avaliação.', 'error');
            }
        }

        async function deleteReviewDirect(reviewId, mediaType, mediaId) {
            if (!confirm('Deseja realmente excluir este comentário?')) return;
            try {
                const headers = {};
                if (userAuthToken) headers['Authorization'] = `Bearer ${userAuthToken}`;

                const res = await fetch(`/api/media/comentarios/${reviewId}`, {
                    method: 'DELETE',
                    headers
                });
                const data = await res.json();
                if (data && data.success) {
                    showToast('Comentário removido.', 'info');
                    loadMediaReviews(mediaType, mediaId);
                } else {
                    showToast(data.message || 'Erro ao excluir.', 'error');
                }
            } catch (e) {
                showToast('Erro ao excluir comentário.', 'error');
            }
        }

        const tmdbSeasonCache = new Map();

        async function enrichSeasonEpisodesWithTmdb(serie, seasonNum) {
            if (!serie) return;
            if (!serie.tmdbId || Number(serie.tmdbId) <= 0) {
                try {
                    const cleanName = (serie.nome || '').replace(/\[.*?\]/g, '').trim();
                    if (cleanName) {
                        const sRes = await fetch(`/api/tmdb/search-all?q=${encodeURIComponent(cleanName)}`);
                        const sJson = await sRes.json();
                        const found = (sJson.results || []).find(r => r.tipo === 'serie' || r.media_type === 'tv');
                        if (found && found.tmdbId) {
                            serie.tmdbId = found.tmdbId;
                        }
                    }
                } catch (e) { }
            }
            if (!serie.tmdbId || Number(serie.tmdbId) <= 0) return;
            const cacheKey = `${serie.tmdbId}_${seasonNum}`;

            try {
                let seasonData = tmdbSeasonCache.get(cacheKey);
                if (!seasonData) {
                    const res = await fetch(`/api/tmdb/season/${serie.tmdbId}/${seasonNum}`);
                    const json = await res.json();
                    if (json && json.success && json.season) {
                        seasonData = json.season;
                        tmdbSeasonCache.set(cacheKey, seasonData);
                    }
                }

                if (seasonData && seasonData.episodios) {
                    const temp = (serie.temporadas || []).find(t => t.numero === seasonNum);
                    if (temp) {
                        if (!temp.episodios) temp.episodios = [];
                        let hasChanges = false;
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);

                        // Enrich existing (available) episodes with TMDB metadata
                        for (const ep of temp.episodios) {
                            if (ep._isPending) continue; // skip ghost eps
                            const tmdbEp = seasonData.episodios.find(e => e.numero === ep.numero);
                            if (tmdbEp) {
                                if (tmdbEp.nome && tmdbEp.nome !== `Episódio ${ep.numero}` && ep.nome !== tmdbEp.nome) {
                                    ep.nome = tmdbEp.nome;
                                    hasChanges = true;
                                }
                                if (tmdbEp.sinopse && (!ep.sinopse || ep.sinopse.length < 10)) {
                                    ep.sinopse = tmdbEp.sinopse;
                                    hasChanges = true;
                                }
                                if (tmdbEp.stillUrl && ep.stillUrl !== tmdbEp.stillUrl) {
                                    ep.stillUrl = tmdbEp.stillUrl;
                                    hasChanges = true;
                                }
                                if (tmdbEp.duracaoMinutos || tmdbEp.runtime) {
                                    ep.duracao = tmdbEp.duracaoMinutos || tmdbEp.runtime;
                                    hasChanges = true;
                                }
                                if (tmdbEp.dataLancamento && !ep.dataLancamento) {
                                    ep.dataLancamento = tmdbEp.dataLancamento;
                                    hasChanges = true;
                                }
                            }
                        }

                        // Filtro fiel: uma temporada só está em lançamento se ainda tiver episódios futuros agendados (air_date > hoje)
                        const hasFutureEps = seasonData.episodios.some(e => {
                            if (!e.dataLancamento) return false;
                            const d = new Date(e.dataLancamento + 'T12:00:00');
                            return !isNaN(d.getTime()) && d > today;
                        });

                        const existingNums = new Set(temp.episodios.map(e => e.numero));

                        if (hasFutureEps) {
                            // Adiciona como pendente apenas episódios com data de lançamento futura (ainda a estrear)
                            for (const tmdbEp of seasonData.episodios) {
                                if (existingNums.has(tmdbEp.numero)) continue;

                                const airDateStr = tmdbEp.dataLancamento || '';
                                const airDate = airDateStr ? new Date(airDateStr + 'T12:00:00') : null;
                                const isFuture = airDate && airDate > today;

                                if (isFuture) {
                                    temp.episodios.push({
                                        numero: tmdbEp.numero,
                                        nome: tmdbEp.nome || `Episódio ${tmdbEp.numero}`,
                                        sinopse: tmdbEp.sinopse || '',
                                        stillUrl: tmdbEp.stillUrl || null,
                                        duracao: tmdbEp.duracaoMinutos || tmdbEp.runtime || 0,
                                        dataLancamento: airDateStr,
                                        _isPending: true,
                                        _isFutureAir: true
                                    });
                                    hasChanges = true;
                                }
                            }
                            temp._isLaunching = true;
                            serie.emLancamento = true;
                        } else {
                            // Se todos os episódios do TMDB já foram lançados (ex: Neagley onde todos lançaram no mesmo dia):
                            // Não adiciona episódios fantasmas e remove a tag de em lançamento
                            const prevLen = temp.episodios.length;
                            temp.episodios = temp.episodios.filter(e => !e._isPending);
                            if (temp.episodios.length !== prevLen) hasChanges = true;
                            temp._isLaunching = false;

                            // Verifica se alguma OUTRA temporada da série ainda tem episódios pendentes
                            const anySeasonLaunching = (serie.temporadas || []).some(t =>
                                (t.episodios || []).some(e => e._isPending)
                            );
                            if (!anySeasonLaunching) {
                                serie.emLancamento = false;
                                if (currentDetailMedia && String(currentDetailMedia.id) === String(serie.id)) {
                                    currentDetailMedia.emLancamento = false;
                                    const heroBadge = document.querySelector('.detail-main-info .season-launching-badge');
                                    if (heroBadge) heroBadge.remove();
                                }
                            }
                        }

                        // Mantém episódios ordenados por número
                        if (hasChanges) {
                            temp.episodios.sort((a, b) => Number(a.numero) - Number(b.numero));
                        }

                        if (currentDetailMedia && String(currentDetailMedia.id) === String(serie.id)) {
                            renderDetailSeasonsHtmlOnly(serie, seasonNum);
                        }
                    }
                }
            } catch (err) { }
        }

        let currentMovieDetailAudio = 'dublado';

        function getUserPreferredAudio() {
            return localStorage.getItem('brasilflix_user_audio_pref') || 'dublado';
        }

        function setUserPreferredAudio(audio) {
            const val = audio === 'legendado' ? 'legendado' : 'dublado';
            localStorage.setItem('brasilflix_user_audio_pref', val);
        }

        function getUserMediaAudioPref(mediaType, mediaId) {
            if (mediaId) {
                const key = `bf_audio_pref_${mediaType}_${mediaId}`;
                const saved = localStorage.getItem(key);
                if (saved === 'dublado' || saved === 'legendado') return saved;
            }
            return null;
        }

        function setUserMediaAudioPref(mediaType, mediaId, audio, rememberForMedia = true, rememberGlobal = false) {
            const val = audio === 'legendado' ? 'legendado' : 'dublado';
            if (mediaId && rememberForMedia) {
                localStorage.setItem(`bf_audio_pref_${mediaType}_${mediaId}`, val);
            }
            if (rememberGlobal) {
                setUserPreferredAudio(val);
            }
        }

        let currentSelectedSeasonNum = 1;

        function formatEpisodeAirDate(dateStr) {
            if (!dateStr) return '';
            try {
                const parts = dateStr.split('-');
                if (parts.length !== 3) return dateStr;
                const year = parseInt(parts[0], 10);
                const month = parseInt(parts[1], 10) - 1;
                const day = parseInt(parts[2], 10);
                const epDate = new Date(year, month, day);
                if (isNaN(epDate.getTime())) return dateStr;

                const today = new Date();
                today.setHours(0, 0, 0, 0);

                const diffTime = epDate.getTime() - today.getTime();
                const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));

                const monthsPt = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
                const formattedDate = `${day} de ${monthsPt[month]}. de ${year}`;

                if (diffDays === 0) return 'Lança Hoje!';
                if (diffDays === 1) return `Lança amanhã (${day} de ${monthsPt[month]}. de ${year})`;
                if (diffDays > 1 && diffDays <= 7) return `Em ${diffDays} dias (${day} de ${monthsPt[month]}. de ${year})`;
                if (diffDays > 7) return `Lança em ${formattedDate}`;

                return formattedDate;
            } catch (e) {
                return dateStr;
            }
        }

        function buildEpisodesHtml(serie, temporada) {
            const episodios = temporada.episodios || [];
            if (episodios.length === 0) {
                return '<div style="color: var(--text-muted); padding: 16px; text-align: center; font-size: 13px;">Episódios desta temporada estarão disponíveis em breve.</div>';
            }
            return episodios.map(ep => {
                let cleanEpTitle = (ep.nome || '').trim();
                cleanEpTitle = cleanEpTitle.replace(/^(?:(?:Epis[oó]dio|Cap[íi]tulo|Ep\.?|E)\s*\d+[\.\:\-\s]+|\d+[\.\:\-\s]+)/i, '').trim();
                if (!cleanEpTitle) cleanEpTitle = `Episódio ${ep.numero}`;

                const epThumb = ep.stillUrl || ep.thumbUrl || serie.backdropUrl || serie.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const epDesc = (ep.sinopse || ep.overview || ep.descricao || '').trim();
                const epDuration = (ep.duracao && Number(ep.duracao) > 0) ? `${ep.duracao} min` : '';

                // CASO 1: EPISÓDIO EM LANÇAMENTO (FUTURO OU AINDA NÃO DISPONÍVEL NO BRASILFLIX)
                if (ep._isPending) {
                    const airDateFormatted = formatEpisodeAirDate(ep.dataLancamento);
                    let releaseTitle = 'Em Breve';
                    if (airDateFormatted) {
                        releaseTitle = airDateFormatted.startsWith('Lança') ? airDateFormatted : `Lança em ${airDateFormatted}`;
                    }

                    return `
                        <div class="episode-cascade-row ep-pending">
                            <div class="episode-cascade-num ep-pending-num">${ep.numero}</div>
                            <div class="episode-preview-wrapper" style="filter: grayscale(0.25) brightness(0.65);">
                                <img src="${epThumb}" class="episode-preview-img" loading="lazy" alt="${releaseTitle}" onerror="this.src='${serie.backdropUrl || serie.posterUrl}'">
                                <div class="ep-pending-clock-overlay" title="Episódio em fase de lançamento">⏳</div>
                                ${epDuration ? `<span class="episode-duration-badge">${epDuration}</span>` : ''}
                            </div>
                            <div class="episode-cascade-info">
                                <div class="episode-cascade-title-row">
                                    <div class="episode-cascade-title" style="color: #c4b5fd; font-weight: 800;">${releaseTitle}</div>
                                </div>
                                ${epDesc ? `<div class="episode-cascade-desc" style="color: #64748b;">${epDesc}</div>` : ''}
                            </div>
                        </div>
                    `;
                }

                // CASO 2: EPISÓDIO DISPONÍVEL PARA ASSISTIR
                const hasDub = !!(ep.isDublado || ep.versoes?.dublado);
                const hasLeg = !!(ep.isLegendado || ep.versoes?.legendado);
                let audioBadgeHtml = '';
                if (hasDub && hasLeg) {
                    audioBadgeHtml = `<span class="badge-ep-audio badge-ep-audio-dual"><span style="color:#34d399;">Dublado</span> <span style="opacity:0.6; color:#cbd5e1;">&amp;</span> <span style="color:#60a5fa;">Legendado</span></span>`;
                } else if (hasDub) {
                    audioBadgeHtml = `<span class="badge-ep-audio badge-ep-audio-dub">Dublado</span>`;
                } else if (hasLeg) {
                    audioBadgeHtml = `<span class="badge-ep-audio badge-ep-audio-leg">Legendado</span>`;
                }

                const prog = getEpisodeProgress(serie.id, temporada.numero, ep.numero);
                const isCompleted = prog?.completed || false;
                const curTime = prog?.currentTime || 0;
                const isStarted = !isCompleted && curTime > 10;
                const isWatchedOrStarted = isCompleted || isStarted;
                const dur = prog?.duration || (ep.duracao ? ep.duracao * 60 : 0);
                const pct = (dur > 0 && curTime > 0) ? Math.min(100, Math.round((curTime / dur) * 100)) : 0;
                const userWantsBlur = (currentUser?.preferencias?.spoilerBlur !== false) && (localStorage.getItem('bf_pref_spoiler_blur') !== 'false');
                const spoilerBlurClass = (!isWatchedOrStarted && userWantsBlur) ? 'episode-preview-spoiler-blur' : '';
                const airDateStr = ep.dataLancamento ? formatEpisodeAirDate(ep.dataLancamento) : '';

                return `
                    <div class="episode-cascade-row ${isCompleted ? 'is-completed' : ''}" onclick="event.stopPropagation(); openWebPlayerEpisode('${serie.id}', ${temporada.numero}, ${ep.numero})">
                        <div class="episode-cascade-num">${ep.numero}</div>
                        <div class="episode-preview-wrapper">
                            <img src="${epThumb}" class="episode-preview-img ${spoilerBlurClass}" loading="lazy" alt="${cleanEpTitle}" onerror="this.src='${serie.backdropUrl || serie.posterUrl}'">
                            <div class="episode-play-overlay-icon">▶</div>
                            ${isCompleted ? '<div class="episode-watched-badge">✓ Assistido</div>' : ''}
                            ${isStarted && pct > 0 ? `<div class="episode-progress-bar-bg"><div class="episode-progress-bar-fill" style="width: ${pct}%;"></div></div>` : ''}
                            ${epDuration ? `<span class="episode-duration-badge">${epDuration}</span>` : ''}
                        </div>
                        <div class="episode-cascade-info">
                            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 2px; flex-wrap: wrap; gap: 6px;">
                                <div>${audioBadgeHtml}</div>
                                ${airDateStr ? `<span class="ep-air-date" style="font-size: 11px; font-weight: 700; color: #94a3b8;" title="Data de Lançamento Original">${airDateStr}</span>` : ''}
                            </div>
                            <div class="episode-cascade-title-row">
                                <div class="episode-cascade-title">${cleanEpTitle}</div>
                            </div>
                            ${epDesc ? `<div class="episode-cascade-desc">${epDesc}</div>` : ''}
                        </div>
                    </div>
                `;
            }).join('');
        }

        function toggleSeasonAccordion(itemEl, serieId) {
            const serie = currentDetailMedia;
            const accordion = document.getElementById('detail-seasons-accordion');
            if (!accordion || !serie) return;

            const isOpen = itemEl.classList.contains('is-open');

            // Close all
            accordion.querySelectorAll('.season-accordion-item').forEach(el => el.classList.remove('is-open'));

            if (!isOpen) {
                itemEl.classList.add('is-open');
                const seasonNum = Number(itemEl.getAttribute('data-season-num'));
                currentSelectedSeasonNum = seasonNum;

                // Lazy-render episodes if not already rendered
                const body = itemEl.querySelector('.season-accordion-episodes');
                if (body && !body.dataset.rendered) {
                    const temporada = (serie.temporadas || []).find(t => t.numero === seasonNum);
                    if (temporada) {
                        body.innerHTML = buildEpisodesHtml(serie, temporada);
                        body.dataset.rendered = '1';
                        // TMDB enrichment
                        if (serie.tmdbId) enrichSeasonEpisodesWithTmdb(serie, seasonNum);
                    }
                }
            }
        }

        function renderDetailSeasonsAccordion(serie) {
            const accordion = document.getElementById('detail-seasons-accordion');
            if (!accordion || !serie.temporadas) return;

            const temporadas = serie.temporadas || [];
            if (temporadas.length === 0) {
                accordion.innerHTML = '<div style="color: var(--text-muted); padding: 20px; text-align: center;">Nenhum episódio cadastrado para esta série ainda.</div>';
                return;
            }

            accordion.innerHTML = temporadas.map((t, idx) => {
                const eps = t.episodios || [];
                const availableEps = eps.filter(e => !e._isPending);
                const pendingEps = eps.filter(e => !!e._isPending);
                const isSeasonLaunching = pendingEps.length > 0;
                const isFirst = idx === 0;

                return `
                    <div class="season-accordion-item ${isFirst ? 'is-open' : ''}" data-season-num="${t.numero}">
                        <div class="season-accordion-header" onclick="toggleSeasonAccordion(this.closest('.season-accordion-item'), '${serie.id}')">
                            <div class="season-accordion-left">
                                <div class="season-accordion-number">${t.numero}</div>
                                <div>
                                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                                        <div class="season-accordion-label">Temporada ${t.numero}</div>
                                        ${isSeasonLaunching ? `
                                            <span class="season-launching-badge">
                                                <span class="season-launching-dot"></span> Em Lançamento
                                            </span>
                                        ` : ''}
                                    </div>
                                    <div class="season-accordion-eps-count">
                                        ${pendingEps.length > 0
                        ? `${eps.length} episódios (${availableEps.length} disponíveis • ${pendingEps.length} em lançamento)`
                        : `${eps.length} episódio${eps.length !== 1 ? 's' : ''}`
                    }
                                    </div>
                                </div>
                            </div>
                            <div class="season-accordion-right">
                                <div class="season-accordion-chevron">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
                                </div>
                            </div>
                        </div>
                        <div class="season-accordion-body">
                            <div class="season-accordion-episodes" ${isFirst ? `data-rendered="1"` : ''}>
                                ${isFirst ? buildEpisodesHtml(serie, t) : '<div style="height:1px"></div>'}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');

            currentSelectedSeasonNum = temporadas[0].numero;

            // Enrich first season
            if (serie.tmdbId) enrichSeasonEpisodesWithTmdb(serie, temporadas[0].numero);
        }

        // Compat shim: renderDetailSeasons still called by some code paths
        function renderDetailSeasons(serie, activeSeasonNum = null) {
            renderDetailSeasonsAccordion(serie);
            if (activeSeasonNum !== null) {
                // Open the specified season
                const accordion = document.getElementById('detail-seasons-accordion');
                if (accordion) {
                    const target = accordion.querySelector(`[data-season-num="${activeSeasonNum}"]`);
                    if (target) {
                        accordion.querySelectorAll('.season-accordion-item').forEach(el => el.classList.remove('is-open'));
                        target.classList.add('is-open');
                        const body = target.querySelector('.season-accordion-episodes');
                        if (body && !body.dataset.rendered) {
                            const temporada = (serie.temporadas || []).find(t => t.numero === activeSeasonNum);
                            if (temporada) { body.innerHTML = buildEpisodesHtml(serie, temporada); body.dataset.rendered = '1'; }
                        }
                    }
                }
            }
        }

        function renderDetailSeasonsHtmlOnly(serie, currentSeason) {
            // Re-render the open accordion season's episodes (e.g. after marking watched or TMDB enrichment)
            const accordion = document.getElementById('detail-seasons-accordion');
            if (!accordion) return;
            const target = accordion.querySelector(`[data-season-num="${currentSeason}"]`);
            if (!target) return;
            const temporada = (serie.temporadas || []).find(t => t.numero === currentSeason);
            if (!temporada) return;

            // Update body episodes
            const body = target.querySelector('.season-accordion-episodes');
            if (body) {
                body.innerHTML = buildEpisodesHtml(serie, temporada);
                body.dataset.rendered = '1';
            }

            // Update header count and launch badge
            const eps = temporada.episodios || [];
            const availableEps = eps.filter(e => !e._isPending);
            const pendingEps = eps.filter(e => !!e._isPending);
            const isSeasonLaunching = pendingEps.length > 0;

            const left = target.querySelector('.season-accordion-left');
            if (left) {
                left.innerHTML = `
                    <div class="season-accordion-number">${temporada.numero}</div>
                    <div>
                        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                            <div class="season-accordion-label">Temporada ${temporada.numero}</div>
                            ${isSeasonLaunching ? `
                                <span class="season-launching-badge">
                                    <span class="season-launching-dot"></span> Em Lançamento
                                </span>
                            ` : ''}
                        </div>
                        <div class="season-accordion-eps-count">
                            ${pendingEps.length > 0
                        ? `${eps.length} episódios (${availableEps.length} disponíveis • ${pendingEps.length} em lançamento)`
                        : `${eps.length} episódio${eps.length !== 1 ? 's' : ''}`
                    }
                        </div>
                    </div>
                `;
            }

            // Sincroniza badge de lançamento no hero da série
            const anySeasonLaunching = (serie.temporadas || []).some(t => (t.episodios || []).some(e => e._isPending));
            const heroCategoryRow = document.querySelector('.detail-main-info > div:first-child');
            const heroBadge = document.querySelector('.detail-main-info .season-launching-badge');
            if (anySeasonLaunching) {
                serie.emLancamento = true;
                if (heroCategoryRow && !heroBadge) {
                    heroCategoryRow.innerHTML += `
                        <span class="season-launching-badge" style="font-size: 10px; padding: 2px 7px;">
                            <span class="season-launching-dot"></span> Em Lançamento
                        </span>
                    `;
                }
            } else {
                serie.emLancamento = false;
                if (heroBadge) {
                    heroBadge.remove();
                }
            }

            currentSelectedSeasonNum = currentSeason;
        }

        let pendingAudioChoiceMedia = null;


        /* ═══════════════════════════════════════════════════════════════════════
           🎬 CONTROLADORES DA PÁGINA DEDICADA DE REPRODUÇÃO (PLAYBACK PAGE)
           ═══════════════════════════════════════════════════════════════════════ */

        let currentPlaybackSerie = null;
        let currentPlaybackMovie = null;
        let currentPlaybackSeasonNum = 1;
        let currentPlaybackEpNum = 1;

        function resolveSerieMedia(serieOrId) {
            if (serieOrId && typeof serieOrId === 'object' && serieOrId.temporadas) {
                return serieOrId;
            }
            const sId = (serieOrId && typeof serieOrId === 'object') ? serieOrId.id : serieOrId;
            if (!sId) return null;
            const all = [
                ...(fullCatalog.series || []),
                ...(fullCatalog.doramas || []),
                ...(fullCatalog.animes || []),
                ...(fullCatalog.destaques || []),
                ...(fullCatalog.todos || [])
            ];
            let found = all.find(s => String(s.id) === String(sId));
            if (!found && currentPlaybackSerie && String(currentPlaybackSerie.id) === String(sId)) {
                found = currentPlaybackSerie;
            }
            if (!found && currentDetailMedia && String(currentDetailMedia.id) === String(sId)) {
                found = currentDetailMedia;
            }
            return found;
        }

        function getNextEpisodeInfo(serieOrId, currentSeasonNum, currentEpNum) {
            const serie = resolveSerieMedia(serieOrId);
            if (!serie || !serie.temporadas || serie.temporadas.length === 0) return null;

            const temps = [...serie.temporadas].sort((a, b) => Number(a.numero) - Number(b.numero));
            const currentTempIndex = temps.findIndex(t => Number(t.numero) === Number(currentSeasonNum));
            if (currentTempIndex < 0) return null;

            const currentTemp = temps[currentTempIndex];
            const eps = [...(currentTemp.episodios || [])].sort((a, b) => Number(a.numero) - Number(b.numero));
            const currentEpIndex = eps.findIndex(e => Number(e.numero) === Number(currentEpNum));

            // 1. Próximo episódio na mesma temporada
            if (currentEpIndex >= 0 && currentEpIndex + 1 < eps.length) {
                const nextEp = eps[currentEpIndex + 1];
                return {
                    seasonNum: Number(currentTemp.numero),
                    epNum: Number(nextEp.numero),
                    epNome: nextEp.nome || `Episódio ${nextEp.numero}`,
                    isNewSeason: false,
                    buttonLabel: `Próximo (E${nextEp.numero}) ⏭`
                };
            }

            // 2. Último episódio da temporada -> Próxima temporada!
            if (currentTempIndex + 1 < temps.length) {
                const nextTemp = temps[currentTempIndex + 1];
                const nextTempEps = [...(nextTemp.episodios || [])].sort((a, b) => Number(a.numero) - Number(b.numero));
                if (nextTempEps.length > 0) {
                    const firstEpNextSeason = nextTempEps[0];
                    return {
                        seasonNum: Number(nextTemp.numero),
                        epNum: Number(firstEpNextSeason.numero),
                        epNome: firstEpNextSeason.nome || `Episódio ${firstEpNextSeason.numero}`,
                        isNewSeason: true,
                        buttonLabel: `Próxima Temp (T${nextTemp.numero}:E${firstEpNextSeason.numero}) ⏭`
                    };
                }
            }

            return null;
        }

        function getPreviousEpisodeInfo(serieOrId, currentSeasonNum, currentEpNum) {
            const serie = resolveSerieMedia(serieOrId);
            if (!serie || !serie.temporadas || serie.temporadas.length === 0) return null;

            const temps = [...serie.temporadas].sort((a, b) => Number(a.numero) - Number(b.numero));
            const currentTempIndex = temps.findIndex(t => Number(t.numero) === Number(currentSeasonNum));
            if (currentTempIndex < 0) return null;

            const currentTemp = temps[currentTempIndex];
            const eps = [...(currentTemp.episodios || [])].sort((a, b) => Number(a.numero) - Number(b.numero));
            const currentEpIndex = eps.findIndex(e => Number(e.numero) === Number(currentEpNum));

            // 1. Episódio anterior na mesma temporada
            if (currentEpIndex > 0) {
                const prevEp = eps[currentEpIndex - 1];
                return {
                    seasonNum: Number(currentTemp.numero),
                    epNum: Number(prevEp.numero),
                    epNome: prevEp.nome || `Episódio ${prevEp.numero}`,
                    isPrevSeason: false,
                    buttonLabel: `⏮ Anterior (E${prevEp.numero})`
                };
            }

            // 2. Primeiro episódio da temporada -> Temporada anterior!
            if (currentTempIndex > 0) {
                const prevTemp = temps[currentTempIndex - 1];
                const prevTempEps = [...(prevTemp.episodios || [])].sort((a, b) => Number(a.numero) - Number(b.numero));
                if (prevTempEps.length > 0) {
                    const lastEpPrevSeason = prevTempEps[prevTempEps.length - 1];
                    return {
                        seasonNum: Number(prevTemp.numero),
                        epNum: Number(lastEpPrevSeason.numero),
                        epNome: lastEpPrevSeason.nome || `Episódio ${lastEpPrevSeason.numero}`,
                        isPrevSeason: true,
                        buttonLabel: `⏮ Temp Anterior (T${prevTemp.numero}:E${lastEpPrevSeason.numero})`
                    };
                }
            }

            return null;
        }

        async function openPlaybackPageForMovie(movieId, explicitAudio = null, updateUrl = true, retryCount = 0) {
            // Se o catálogo ainda não foi carregado (ex: F5 direto na URL), aguarda até 5 segundos
            if ((!fullCatalog.filmes || fullCatalog.filmes.length === 0) && retryCount < 10) {
                setTimeout(() => openPlaybackPageForMovie(movieId, explicitAudio, updateUrl, retryCount + 1), 300);
                return;
            }

            const movie = (fullCatalog.filmes || []).find(f => String(f.id) === String(movieId));
            if (!movie) {
                showToast('❌ Filme não encontrado no catálogo.', 'error');
                switchNavCategory('filme');
                return;
            }

            if (currentPartyRoom && !isSyncingFromRemote) {
                const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                if (!partyIsHost && !perms.canChangeMedia) {
                    showToast('⚠️ Apenas o anfitrião pode trocar de filme nesta sala.', 'info');
                    return;
                }
            }

            currentPlaybackMovie = movie;
            currentPlaybackSerie = null;

            localStorage.setItem('bf_playback_type', 'filme');
            localStorage.setItem('bf_playback_movie_id', String(movieId));
            localStorage.setItem('bf_active_tab', 'tab-playback-page');

            const token = getUserStreamingToken();
            const isVip = localStorage.getItem('bf_user_is_vip') === 'true' || (currentUser && currentUser.is_vip) || token !== 'public';
            // hasDub/hasLeg: usa APENAS os campos de disponibilidade real de mídia do backend (isDublado/isLegendado)
            // NÃO usa audioBadge/audioText como proxy pois esses campos podem estar desatualizados
            const hasDub = (!!movie.versoes?.dublado && !!(movie.versoes.dublado.messageId || movie.versoes.dublado.fileId))
                || (!!movie.isDublado && !!(movie.messageId || movie.fileId) && !movie.versoes?.legendado && !movie.versoes?.dublado);
            const hasLeg = (!!movie.versoes?.legendado && !!(movie.versoes.legendado.messageId || movie.versoes.legendado.fileId))
                || (!!movie.isLegendado && !!(movie.messageId || movie.fileId) && !movie.versoes?.legendado && !movie.versoes?.dublado && !hasDub);
            const isDualAudio = hasDub && hasLeg;

            // ── PASSO 1: CONFIRMAÇÃO DE CONSUMO DE CRÉDITOS (PRIMEIRO) ──
            const mediaKey = `filme_${movie.id}`;
            if (!isVip) {
                try {
                    const qRes = await fetch(`/api/user/quota-check?token=${encodeURIComponent(token)}&type=filme&mediaKey=${encodeURIComponent(mediaKey)}`);
                    const quota = await qRes.json();
                    if (!quota.permitido) {
                        showQuotaLimitExceededModal('filme', quota.motivo || quota.mensagem);
                        return;
                    }
                    if (quota.requerConfirmacao) {
                        showQuotaConfirmationModal(movie.nome, 'filme', () => {
                            proceedMovieAudioAndPlayback(movie, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio);
                        }, mediaKey);
                        return;
                    }
                } catch (e) {
                    console.warn('Falha na validação de cota:', e);
                }
            }

            proceedMovieAudioAndPlayback(movie, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio);
        }

        function proceedMovieAudioAndPlayback(movie, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio) {
            const savedAudioPref = getUserMediaAudioPref('filme', movie.id);
            const userPrefAudio = currentUser?.preferencias?.defaultAudio || localStorage.getItem('bf_pref_default_audio');

            // Seleciona áudio automaticamente: preferência salva > preferência do usuário > default inteligente
            // Default inteligente: prefere 'dublado' se disponível, senão 'legendado'
            const defaultAudio = hasDub ? 'dublado' : (hasLeg ? 'legendado' : 'dublado');
            let chosenAudio = explicitAudio || savedAudioPref || (userPrefAudio === 'dublado' || userPrefAudio === 'legendado' ? userPrefAudio : null) || getUserPreferredAudio('filme', movie.id) || defaultAudio;
            // Sanitiza: se escolheu dublado mas não existe, cai para legendado (e vice-versa)
            if (chosenAudio === 'dublado' && !hasDub) chosenAudio = hasLeg ? 'legendado' : 'dublado';
            else if (chosenAudio === 'legendado' && !hasLeg) chosenAudio = hasDub ? 'dublado' : 'legendado';

            finalizeMoviePlaybackPage(movie, chosenAudio, updateUrl, token, hasDub, hasLeg);
        }

        function finalizeMoviePlaybackPage(movie, chosenAudio, updateUrl, token, hasDub, hasLeg) {
            const streamUrl = `/stream/video/${encodeURIComponent(token)}/filme/${encodeURIComponent(movie.id)}/${chosenAudio}`;

            // Atualiza URL no navegador
            if (updateUrl) {
                const _mSlug = getMediaSlug(movie);
                const _mParam = _mSlug ? `${movie.id}-${_mSlug}` : String(movie.id);
                window.history.pushState({}, '', `#filme/${_mParam}/assistir`);
                updateSeoMetadata(movie, false);
            }

            // Atualiza elementos visuais da página
            const titleEl = document.getElementById('playback-top-title');
            const subEl = document.getElementById('playback-top-sub');
            if (titleEl) titleEl.innerText = movie.nome;
            const movieGenres = Array.isArray(movie.generos) ? movie.generos.slice(0, 2).join(', ') : (movie.genero || '');
            if (subEl) subEl.innerText = `Filme • ${movie.ano || ''}${movieGenres ? ' • ' + movieGenres : ''}`;

            // Oculta barra de navegação de episódios para filmes
            const navBar = document.getElementById('playback-nav-controls-bar');
            if (navBar) navBar.style.display = 'none';
            const prevBtn = document.getElementById('playback-btn-prev');
            const nextBtn = document.getElementById('playback-btn-next');
            const seriesBtn = document.getElementById('playback-btn-series');

            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (seriesBtn) seriesBtn.style.display = 'none';

            // Oculta lista de episódios para filmes
            const epSection = document.getElementById('playback-episodes-section');
            if (epSection) epSection.style.display = 'none';

            // Carrega Avaliações e Recomendações
            loadPlaybackReviews('filme', movie.id);
            renderPlaybackRecommendations(movie);

            // Abre a aba de reprodução dedicada
            switchTab('tab-playback-page', false);
            const _mainAreaMoviePb = document.getElementById('app-main-area');
            if (_mainAreaMoviePb) _mainAreaMoviePb.scrollTo({ top: 0, behavior: 'smooth' });

            // Abre o player armado com a Capa + Botão de Play (NÃO começa sozinho)
            openWebPlayer(movie.nome, `Filme • ${movie.ano || ''}`, streamUrl, {
                type: 'filme',
                id: movie.id,
                title: movie.nome,
                sub: `Filme • ${movie.ano || ''}`,
                audio: chosenAudio,
                hasDub,
                hasLeg,
                posterUrl: movie.backdropUrl || movie.posterUrl,
                qualidade: movie.qualidade || '1080p Full HD',
                streamUrl,
                autoPlay: false
            });
        }

        async function openPlaybackPageForEpisode(serieId, seasonNum, epNum, explicitAudio = null, updateUrl = true, retryCount = 0) {
            // Se o catálogo ainda não foi carregado, aguarda
            if ((!fullCatalog.series || fullCatalog.series.length === 0) && retryCount < 10) {
                setTimeout(() => openPlaybackPageForEpisode(serieId, seasonNum, epNum, explicitAudio, updateUrl, retryCount + 1), 300);
                return;
            }

            const serie = (fullCatalog.series || []).find(s => String(s.id) === String(serieId));
            if (!serie) {
                showToast('❌ Série não encontrada no catálogo.', 'error');
                switchNavCategory('serie');
                return;
            }

            const sNum = parseInt(seasonNum, 10) || 1;
            const eNum = parseInt(epNum, 10) || 1;

            if (currentPartyRoom && !isSyncingFromRemote) {
                const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                if (!partyIsHost && !perms.canChangeMedia) {
                    showToast('⚠️ Apenas o anfitrião pode trocar de episódio nesta sala.', 'info');
                    return;
                }
            }

            currentPlaybackSerie = serie;
            currentPlaybackMovie = null;
            currentPlaybackSeasonNum = sNum;
            currentPlaybackEpNum = eNum;
            currentPlaybackBatchIndex = null;

            localStorage.setItem('bf_playback_type', 'serie');
            localStorage.setItem('bf_playback_serie_id', String(serieId));
            localStorage.setItem('bf_playback_season', String(sNum));
            localStorage.setItem('bf_playback_episode', String(eNum));
            localStorage.setItem('bf_active_tab', 'tab-playback-page');

            const season = (serie.temporadas || []).find(t => t.numero === sNum) || serie.temporadas?.[0];
            if (!season) {
                showToast(`❌ Temporada ${sNum} indisponível.`, 'error');
                return;
            }

            const episode = (season.episodios || []).find(e => e.numero === eNum) || season.episodios?.[0];
            if (!episode) {
                showToast(`❌ Episódio ${eNum} indisponível.`, 'error');
                return;
            }

            if (episode._isPending) {
                showToast(`O Episódio ${eNum} ainda não foi disponibilizado porque está em fase de lançamento.`, 'info');
                openMediaDetailPage(serie.id, 'serie');
                return;
            }

            const token = getUserStreamingToken();
            const isVip = localStorage.getItem('bf_user_is_vip') === 'true' || (currentUser && currentUser.is_vip) || token !== 'public';
            const dubPermitido = season.isDublado !== false;
            const legPermitido = season.isLegendado !== false;
            const hasDub = dubPermitido && (!!episode.versoes?.dublado || !!episode.isDublado || episode.audio === 'dual');
            const hasLeg = legPermitido && (!!episode.versoes?.legendado || !!episode.isLegendado || episode.audio === 'dual');
            const isDualAudio = (hasDub && hasLeg);

            // ── PASSO 1: CONFIRMAÇÃO DE CONSUMO DE CRÉDITOS (PRIMEIRO) ──
            const mediaKey = `serie_${serie.id}_s${sNum}_e${eNum}`;
            if (!isVip) {
                try {
                    const qRes = await fetch(`/api/user/quota-check?token=${encodeURIComponent(token)}&type=serie&mediaKey=${encodeURIComponent(mediaKey)}`);
                    const quota = await qRes.json();
                    if (!quota.permitido) {
                        showQuotaLimitExceededModal('serie', quota.motivo || quota.mensagem);
                        return;
                    }
                    if (quota.requerConfirmacao) {
                        showQuotaConfirmationModal(`${serie.nome} (T${sNum}E${eNum})`, 'serie', () => {
                            proceedEpisodeAudioAndPlayback(serie, season, episode, sNum, eNum, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio);
                        }, mediaKey);
                        return;
                    }
                } catch (e) {
                    console.warn('Falha na validação de cota:', e);
                }
            }

            proceedEpisodeAudioAndPlayback(serie, season, episode, sNum, eNum, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio);
        }

        function proceedEpisodeAudioAndPlayback(serie, season, episode, sNum, eNum, explicitAudio, updateUrl, token, hasDub, hasLeg, isDualAudio) {
            const savedAudioPref = getUserMediaAudioPref('serie', serie.id);
            const userPrefAudio = currentUser?.preferencias?.defaultAudio || localStorage.getItem('bf_pref_default_audio');

            // Seleciona áudio automaticamente sem interrupção por modal (preferência do usuário > dublado > legendado)
            let chosenAudio = explicitAudio || savedAudioPref || (userPrefAudio === 'dublado' || userPrefAudio === 'legendado' ? userPrefAudio : null) || getUserPreferredAudio('serie', serie.id) || (hasDub ? 'dublado' : 'legendado');
            if (chosenAudio === 'dublado' && !hasDub && hasLeg) chosenAudio = 'legendado';
            else if (chosenAudio === 'legendado' && !hasLeg && hasDub) chosenAudio = 'dublado';
            else if (!hasDub && !hasLeg) chosenAudio = serie.isDublado ? 'dublado' : 'legendado';

            finalizeEpisodePlaybackPage(serie, season, episode, sNum, eNum, chosenAudio, updateUrl, token, hasDub, hasLeg);
        }

        function finalizeEpisodePlaybackPage(serie, season, episode, sNum, eNum, chosenAudio, updateUrl, token, hasDub, hasLeg) {
            const streamUrl = `/stream/video/${encodeURIComponent(token)}/serie/${encodeURIComponent(serie.id)}/${sNum}/${eNum}/${chosenAudio}`;

            // Atualiza URL no navegador com a rota canônica
            if (updateUrl) {
                const _sSlug = getMediaSlug(serie);
                const _sParam = _sSlug ? `${serie.id}-${_sSlug}` : String(serie.id);
                window.history.pushState({}, '', `#serie/${_sParam}/temporada/${sNum}/episodio/${eNum}`);
                updateSeoMetadata(serie, true, { season: sNum, episode: eNum, epTitle: episode?.nome });
            }

            const epTitleStr = episode.nome && !episode.nome.toLowerCase().startsWith('epis') ? episode.nome : `Episódio ${eNum}`;
            const breadcrumbSub = `Temporada ${sNum} • Episódio ${eNum} - ${epTitleStr}`;

            // Atualiza breadcrumb no topo
            const titleEl = document.getElementById('playback-top-title');
            const subEl = document.getElementById('playback-top-sub');
            if (titleEl) titleEl.innerText = serie.nome;
            if (subEl) subEl.innerText = breadcrumbSub;

            // Configura botões da barra de navegação
            const navBar = document.getElementById('playback-nav-controls-bar');
            if (navBar) navBar.style.display = 'flex';
            const prevBtn = document.getElementById('playback-btn-prev');
            const nextBtn = document.getElementById('playback-btn-next');
            const seriesBtn = document.getElementById('playback-btn-series');

            const prevInfo = getPreviousEpisodeInfo(serie, sNum, eNum);
            const nextInfo = getNextEpisodeInfo(serie, sNum, eNum);

            if (prevBtn) {
                prevBtn.style.display = 'inline-flex';
                if (prevInfo) {
                    prevBtn.disabled = false;
                    const pLabel = prevInfo.buttonLabel ? prevInfo.buttonLabel.replace('⏮', '').trim() : (prevInfo.isPrevSeason ? 'Temporada Anterior' : 'Episódio Anterior');
                    prevBtn.innerHTML = `<span class="nav-icon">⏮</span> <span class="nav-text">${pLabel}</span>`;
                    prevBtn.title = `Ir para T${prevInfo.seasonNum}E${prevInfo.epNum} - ${prevInfo.epNome}`;
                    prevBtn.onclick = () => openPlaybackPageForEpisode(serie.id, prevInfo.seasonNum, prevInfo.epNum);
                } else {
                    prevBtn.disabled = true;
                    prevBtn.innerHTML = '<span class="nav-icon">⏮</span> <span class="nav-text">Episódio Anterior</span>';
                    prevBtn.title = 'Você está no primeiro episódio desta série.';
                    prevBtn.onclick = null;
                }
            }

            if (nextBtn) {
                nextBtn.style.display = 'inline-flex';
                if (nextInfo) {
                    nextBtn.disabled = false;
                    const nLabel = nextInfo.buttonLabel ? nextInfo.buttonLabel.replace('⏭', '').trim() : (nextInfo.isNextSeason ? 'Próxima Temporada' : 'Próximo Episódio');
                    nextBtn.innerHTML = `<span class="nav-text">${nLabel}</span> <span class="nav-icon">⏭</span>`;
                    nextBtn.title = `Ir para T${nextInfo.seasonNum}E${nextInfo.epNum} - ${nextInfo.epNome}`;
                    nextBtn.onclick = () => openPlaybackPageForEpisode(serie.id, nextInfo.seasonNum, nextInfo.epNum);
                } else {
                    nextBtn.disabled = true;
                    nextBtn.innerHTML = '<span class="nav-text">Próximo Episódio</span> <span class="nav-icon">⏭</span>';
                    nextBtn.title = 'Você está no último episódio disponível desta série.';
                    nextBtn.onclick = null;
                }
            }

            if (seriesBtn) {
                seriesBtn.style.display = 'inline-flex';
                seriesBtn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;
                seriesBtn.title = 'Ver todos os episódios da série';
                seriesBtn.setAttribute('aria-label', 'Ver todos os episódios da série');
                seriesBtn.onclick = () => openMediaDetailPage(serie.id, 'serie');
            }

            // Renderiza lista de episódios da mesma temporada abaixo do player
            const epSection = document.getElementById('playback-episodes-section');
            if (epSection) {
                epSection.style.display = 'block';
                renderPlaybackSeasonEpisodes(serie, sNum, eNum);
            }

            // Carrega Avaliações e Recomendações
            loadPlaybackReviews('serie', serie.id);
            renderPlaybackRecommendations(serie);

            // Abre a aba de reprodução dedicada
            switchTab('tab-playback-page', false);
            const _mainAreaPb = document.getElementById('app-main-area');
            if (_mainAreaPb) _mainAreaPb.scrollTo({ top: 0, behavior: 'smooth' });

            const isMicro = serie.subtipo === 'microdrama' || serie.isMicrodrama || serie.formato === 'vertical';

            // Abre o player armado com a Capa + Botão de Play (NÃO começa sozinho)
            openWebPlayer(serie.nome, `T${sNum}E${eNum} • ${epTitleStr}`, streamUrl, {
                type: 'serie',
                id: serie.id,
                season: sNum,
                episode: eNum,
                title: serie.nome,
                sub: `T${sNum}E${eNum} • ${epTitleStr}`,
                audio: chosenAudio,
                formato: serie.formato || (isMicro ? 'vertical' : 'horizontal'),
                subtipo: serie.subtipo || (isMicro ? 'microdrama' : 'serie'),
                hasDub,
                hasLeg,
                posterUrl: episode.stillUrl || episode.thumbUrl || serie.backdropUrl || serie.posterUrl,
                qualidade: episode.qualidade || '1080p Full HD',
                streamUrl,
                autoPlay: false
            });
        }

        let currentPlaybackBatchIndex = null;

        function renderPlaybackSeasonEpisodes(serie, currentSeasonNum, currentEpNum) {
            const seasonSelector = document.getElementById('playback-season-selector-bar');
            let batchSelector = document.getElementById('playback-batch-selector-bar');
            const epGrid = document.getElementById('playback-episodes-grid');
            const countLabel = document.getElementById('playback-season-ep-count');

            if (!serie || !serie.temporadas) return;

            const temporadas = serie.temporadas || [];
            const activeSeason = temporadas.find(t => t.numero === currentSeasonNum) || temporadas[0];
            const eps = activeSeason?.episodios || [];

            if (countLabel) {
                countLabel.innerHTML = '';
            }

            // Barra seletora de temporadas (se houver mais de 1 temporada)
            if (seasonSelector) {
                if (temporadas.length > 1) {
                    seasonSelector.style.display = 'flex';
                    seasonSelector.innerHTML = temporadas.map(t => {
                        const isActive = t.numero === activeSeason?.numero;
                        return `
                            <button class="playback-season-btn ${isActive ? 'active' : ''}" onclick="selectPlaybackSeason(${t.numero}, ${isActive ? currentEpNum : 1})">
                                Temporada ${t.numero} (${t.episodios?.length || 0} eps)
                            </button>
                        `;
                    }).join('');
                } else {
                    seasonSelector.style.display = 'none';
                }
            }

            if (!epGrid) return;

            // Se o container de lotes não existir no DOM por algum motivo, insere antes do grid
            if (!batchSelector && epGrid.parentNode) {
                batchSelector = document.createElement('div');
                batchSelector.id = 'playback-batch-selector-bar';
                batchSelector.className = 'playback-batch-tabs-bar';
                epGrid.parentNode.insertBefore(batchSelector, epGrid);
            }

            if (eps.length === 0) {
                if (batchSelector) {
                    batchSelector.style.display = 'none';
                    batchSelector.innerHTML = '';
                }
                epGrid.innerHTML = '<div style="color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhum episódio cadastrado nesta temporada.</div>';
                return;
            }

            // Suporte a Paginação em Lotes de 25 para séries/microdramas longos (ex: 1-25, 26-50, etc.)
            const BATCH_SIZE = 25;
            let displayEps = eps;

            if (eps.length > BATCH_SIZE) {
                const totalBatches = Math.ceil(eps.length / BATCH_SIZE);
                // Auto-ajusta para o lote que contém o episódio ativo se não estiver definido ou fora do range
                if (currentPlaybackBatchIndex === null || currentPlaybackBatchIndex === undefined || currentPlaybackBatchIndex < 0 || currentPlaybackBatchIndex >= totalBatches) {
                    const targetBatch = Math.floor(Math.max(0, (currentEpNum - 1)) / BATCH_SIZE);
                    currentPlaybackBatchIndex = Math.min(targetBatch, totalBatches - 1);
                }

                let batchButtonsHtml = '';
                for (let b = 0; b < totalBatches; b++) {
                    const startEp = b * BATCH_SIZE + 1;
                    const endEp = Math.min((b + 1) * BATCH_SIZE, eps.length);
                    const isBatchActive = b === currentPlaybackBatchIndex;
                    batchButtonsHtml += `
                        <button class="playback-batch-btn ${isBatchActive ? 'active' : ''}" onclick="setPlaybackBatch(${b})">
                            Eps ${startEp}-${endEp}
                        </button>
                    `;
                }

                if (batchSelector) {
                    batchSelector.style.display = 'flex';
                    batchSelector.innerHTML = batchButtonsHtml;
                }

                const startIdx = currentPlaybackBatchIndex * BATCH_SIZE;
                const endIdx = startIdx + BATCH_SIZE;
                displayEps = eps.slice(startIdx, endIdx);

                epGrid.innerHTML = renderEpisodeCardsList(displayEps, serie, activeSeason, currentSeasonNum, currentEpNum);
            } else {
                if (batchSelector) {
                    batchSelector.style.display = 'none';
                    batchSelector.innerHTML = '';
                }
                epGrid.innerHTML = renderEpisodeCardsList(displayEps, serie, activeSeason, currentSeasonNum, currentEpNum);
            }
        }

        function selectPlaybackSeason(seasonNum, epNum = 1) {
            currentPlaybackSeasonNum = seasonNum;
            currentPlaybackBatchIndex = null;
            if (currentPlaybackSerie) {
                renderPlaybackSeasonEpisodes(currentPlaybackSerie, seasonNum, epNum);
            }
        }

        function setPlaybackBatch(batchIdx) {
            currentPlaybackBatchIndex = batchIdx;
            if (currentPlaybackSerie) {
                renderPlaybackSeasonEpisodes(currentPlaybackSerie, currentPlaybackSeasonNum, currentPlaybackEpNum);
            }
        }

        function renderEpisodeCardsList(eps, serie, activeSeason, currentSeasonNum, currentEpNum) {
            return eps.map(ep => {
                const isCurrent = (activeSeason.numero === currentSeasonNum && ep.numero === currentEpNum);
                const epTitleStr = ep.nome && !ep.nome.toLowerCase().startsWith('epis') ? ep.nome : `Episódio ${ep.numero}`;
                const temDub = ep.isDublado || (ep.audio && ep.audio.includes('Dublado'));
                const temLeg = ep.isLegendado || (ep.audio && ep.audio.includes('Legendado'));
                const audioBadge = (temDub && temLeg) ? 'Dub/Leg' : (temDub ? 'Dublado' : 'Legendado');

                const prog = getEpisodeProgress(serie.id, activeSeason.numero, ep.numero);
                const isWatched = prog?.completed || false;

                return `
                    <div class="playback-ep-card ${isCurrent ? 'active-ep' : ''}" onclick="openPlaybackPageForEpisode('${serie.id}', ${activeSeason.numero}, ${ep.numero})">
                        <div class="playback-ep-badge">
                            ${isCurrent ? '▶ ' : ''}EP ${ep.numero}
                        </div>
                        <div class="playback-ep-info">
                            <div class="playback-ep-title" title="${epTitleStr}">${epTitleStr}</div>
                            <div class="playback-ep-meta">
                                <span>🔊 ${audioBadge}</span>
                                ${isWatched ? '<span style="color: #34d399; font-weight: 800;">• ✓ Visto</span>' : ''}
                            </div>
                        </div>
                        ${isCurrent ? `
                            <div class="playback-ep-playing-icon" title="Assistindo Agora">
                                <div class="playback-ep-playing-bar"></div>
                                <div class="playback-ep-playing-bar"></div>
                                <div class="playback-ep-playing-bar"></div>
                            </div>
                        ` : ''}
                    </div>
                `;
            }).join('');
        }

        function handlePlaybackBack() {
            if (currentPlaybackSerie) {
                openMediaDetailPage(currentPlaybackSerie.id, 'serie');
            } else if (currentPlaybackMovie) {
                openMediaDetailPage(currentPlaybackMovie.id, 'filme');
            } else {
                switchNavCategory('inicio');
            }
        }

        function handleViewFullSeries() {
            if (currentPlaybackSerie) {
                openMediaDetailPage(currentPlaybackSerie.id, 'serie');
            } else if (currentPlaybackMovie) {
                switchNavCategory('filme');
            }
        }

        async function loadPlaybackReviews(mediaType, mediaId) {
            const listEl = document.getElementById('playback-reviews-list');
            const avgEl = document.getElementById('playback-reviews-rating-avg');
            if (!listEl) return;

            try {
                const res = await fetch(`/api/media/${mediaType}/${mediaId}/comentarios`);
                const data = await res.json();

                if (avgEl && data.avgRating) {
                    avgEl.innerText = `★ ${data.avgRating} (${data.total} avaliações)`;
                }

                if (!data.reviews || data.reviews.length === 0) {
                    listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhuma avaliação ainda. Seja o primeiro a avaliar!</div>';
                    return;
                }

                listEl.innerHTML = data.reviews.map(r => {
                    const hasSpoiler = !!(r.has_spoiler || r.hasSpoiler || r.spoiler);
                    const spoilerTag = hasSpoiler ? `<span class="spoiler-badge-tag">⚠️ Spoiler</span>` : '';
                    const dateStr = new Date(r.created_at).toLocaleDateString('pt-BR');

                    return `
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px 16px;">
                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
                                <div style="display: flex; align-items: center; gap: 8px;">
                                    ${r.avatar_url ? `<img src="${safeImageUrl(r.avatar_url)}" style="width: 22px; height: 22px; border-radius: 50%; object-fit: cover; border: 1px solid rgba(255,255,255,0.15);" alt="${escapeHtml(r.username)}">` : `<div class="user-avatar-circle" style="width: 22px; height: 22px; font-size: 10px;">${(r.username || 'U')[0].toUpperCase()}</div>`}
                                    <span style="font-weight: 800; font-size: 13px; color: #fff;">${r.username || 'Usuário'}</span>
                                    <span style="font-size: 11px; color: #fbbf24; font-weight: 800;">★ ${r.rating}/10</span>
                                    ${spoilerTag}
                                </div>
                                <span style="font-size: 11px; color: var(--text-muted);">${dateStr}</span>
                            </div>
                            <div style="margin-top: 4px;">
                                ${renderReviewCommentHtml(r.comentario, hasSpoiler)}
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                console.warn('Erro ao carregar avaliações:', e);
            }
        }

        async function handlePlaybackSubmitReview(e) {
            e.preventDefault();
            const ratingSelect = document.getElementById('playback-review-rating-select');
            const textInput = document.getElementById('playback-review-text');
            const spoilerChk = document.getElementById('playback-review-has-spoiler');

            const rating = ratingSelect?.value || 10;
            const text = (textInput?.value || '').trim();
            const hasSpoiler = !!(spoilerChk?.checked);

            if (!text || text.length < 3) {
                showToast('Escreva um comentário com pelo menos 3 letras.', 'error');
                return;
            }

            const mediaType = currentPlaybackSerie ? 'serie' : 'filme';
            const mediaId = currentPlaybackSerie ? currentPlaybackSerie.id : currentPlaybackMovie?.id;

            if (!mediaId) return;

            const headers = { 'Content-Type': 'application/json' };
            const jwt = userAuthToken;
            if (jwt) headers['Authorization'] = `Bearer ${jwt}`;

            try {
                const res = await fetch(`/api/media/${mediaType}/${mediaId}/comentarios`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        rating: parseInt(rating, 10),
                        comentario: text,
                        guestName: localStorage.getItem('bf_party_name') || 'Visitante',
                        hasSpoiler
                    })
                });
                const data = await res.json();
                if (data.success) {
                    showToast('🎉 Avaliação publicada com sucesso!', 'success');
                    if (textInput) textInput.value = '';
                    if (spoilerChk) spoilerChk.checked = false;
                    loadPlaybackReviews(mediaType, mediaId);
                } else {
                    showToast(data.message || 'Erro ao publicar avaliação.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao enviar avaliação.', 'error');
            }
        }

        function renderPlaybackRecommendations(item) {
            const trackEl = document.getElementById('track-playback-recs');
            const sectionEl = document.getElementById('rail-section-playback-recs');
            if (!trackEl || !item) return;

            const isSerie = !!item.temporadas;
            const pool = isSerie ? (fullCatalog.series || []) : (fullCatalog.filmes || []);

            // Filtra mídias do mesmo gênero excluindo a atual
            let recs = pool.filter(p => String(p.id) !== String(item.id));
            if (item.generos && item.generos.length > 0) {
                const mainGenre = item.generos[0];
                const genreMatches = recs.filter(p => (p.generos || []).includes(mainGenre));
                if (genreMatches.length >= 4) recs = genreMatches;
            }

            recs = recs.slice(0, 12);

            if (recs.length === 0) {
                if (sectionEl) sectionEl.style.display = 'none';
                return;
            }
            if (sectionEl) sectionEl.style.display = 'block';

            trackEl.innerHTML = recs.map(rec => {
                const recType = (rec.temporadas || rec.itemType === 'serie' || rec.tipo === 'serie') ? 'serie' : 'filme';
                const poster = rec.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=500&q=80';
                const rating = rec.nota ? Number(rec.nota).toFixed(1) : '8.5';
                const isFav = (userFavorites || []).some(f => String(f.id) === String(rec.id));
                const sub = rec.temporadas ? getSerieSubtitleMeta(rec) : (rec.ano || '2026');

                return `
                    <div class="rail-card" onclick="openMediaDetailPage('${rec.id}', '${recType}')">
                        <div class="rail-poster-wrapper">
                            <img src="${poster}" class="rail-poster-img" loading="lazy" alt="${rec.nome}" onerror="this.src='/assets/logos/logo_horizontal.jpg'">
                            <button class="btn-fav-card ${isFav ? 'active' : ''}" onclick="toggleUserFavorite('${rec.id}', '${recType}', event)" title="${isFav ? 'Remover dos Favoritos' : 'Adicionar aos Favoritos'}">
                                ${isFav ? '❤️' : '🤍'}
                            </button>
                        </div>
                        <div class="rail-content">
                            <h4 class="rail-card-title">${rec.nome}</h4>
                            <div class="rail-card-sub">
                                <span style="color: #fbbf24; font-weight: 800;">★ ${rating}</span>
                                <span>${sub}</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }


        function openAudioSelectModal(mediaItem, onSelect) {
            // Modal desativado a pedido do usuário para evitar interrupções
            const userPrefAudio = currentUser?.preferencias?.defaultAudio || localStorage.getItem('bf_pref_default_audio');
            const chosen = (userPrefAudio === 'dublado' || userPrefAudio === 'legendado') ? userPrefAudio : 'dublado';
            if (typeof onSelect === 'function') {
                onSelect(chosen);
            }
        }

        function closeAudioSelectModal(e) {
            if (e && e.target && !isSafeModalBackdropClick(e, 'audio-select-modal')) return;
            const modal = document.getElementById('audio-select-modal');
            if (modal) modal.classList.remove('active');
            pendingAudioChoiceMedia = null;
        }

        function confirmAudioSelection(audio) {
            const chk = document.getElementById('chk-remember-audio-choice');
            const shouldRemember = chk ? chk.checked : true;
            if (pendingAudioChoiceMedia?.item) {
                const item = pendingAudioChoiceMedia.item;
                setUserMediaAudioPref(item.type || 'midia', item.id, audio, shouldRemember, false);
                if (shouldRemember) {
                    showToast(`Preferência salva para este título: ${audio === 'dublado' ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)'}`, 'info');
                }
            }
            const modal = document.getElementById('audio-select-modal');
            if (modal) modal.classList.remove('active');

            if (pendingAudioChoiceMedia && typeof pendingAudioChoiceMedia.onSelect === 'function') {
                pendingAudioChoiceMedia.onSelect(audio);
            }
            pendingAudioChoiceMedia = null;
        }

        async function playFirstAvailableEpisode(serieId, explicitAudio = null) {
            const serie = (fullCatalog.series || []).find(s => String(s.id) === String(serieId));
            if (serie && !serie.temporadas) {
                try { Object.assign(serie, await getSeriesDetails(serieId)); }
                catch (error) { showToast(error.message, 'error'); return; }
            }
            if (!serie || !serie.temporadas || serie.temporadas.length === 0) return;
            const t1 = serie.temporadas[0];
            if (!t1.episodios || t1.episodios.length === 0) return;
            const ep1 = t1.episodios[0];
            openWebPlayerEpisode(serie.id, t1.numero, ep1.numero, explicitAudio);
        }

        async function playEpisodeDirect(serieId, seasonNum, epNum, audio, serieNome, epNome) {
            const userToken = getUserStreamingToken();
            const mediaKey = `serie_${serieId}_${seasonNum}_${epNum}`;
            const serie = (fullCatalog.series || []).find(s => String(s.id) === String(serieId)) || currentModalSerie || currentDetailMedia;
            if (serie && !serie.temporadas) {
                try { Object.assign(serie, await getSeriesDetails(serieId)); }
                catch (error) { showToast(error.message, 'error'); return; }
            }
            const ep = serie?.temporadas?.find(t => t.numero === Number(seasonNum))?.episodios?.find(e => e.numero === Number(epNum));
            const sName = serieNome || serie?.nome || 'Série';
            const eName = epNome || ep?.nome || `Episódio ${epNum}`;
            const hasDub = !!(ep?.versoes?.dublado || ep?.isDublado || serie?.isDublado);
            const hasLeg = !!(ep?.versoes?.legendado || ep?.isLegendado || serie?.isLegendado);

            showQuotaConfirmationModal(`${sName} - T${seasonNum}E${epNum}`, 'serie', () => {
                const streamUrl = `/stream/video/${encodeURIComponent(userToken)}/serie/${encodeURIComponent(serieId)}/${seasonNum}/${epNum}/${audio || 'dublado'}`;
                openWebPlayer(`${sName} - T${seasonNum}E${epNum}`, eName, streamUrl, {
                    type: 'serie',
                    id: serieId,
                    season: Number(seasonNum),
                    episode: Number(epNum),
                    audio: audio || 'dublado',
                    hasDub: hasDub,
                    hasLeg: hasLeg,
                    serieNome: sName,
                    epNome: eName
                });
                updatePlayerNextEpisodeButton();
            }, mediaKey);
        }

        function openWebPlayerForMovie(movieId, explicitAudio = null) {
            openPlaybackPageForMovie(movieId, explicitAudio, true);
        }

        function updatePlayerNextEpisodeButton() {
            const nextBtn = document.getElementById('player-header-next-ep-btn');
            const prevBtn = document.getElementById('player-header-prev-ep-btn');
            if (currentPlayingMedia && currentPlayingMedia.type === 'serie') {
                const nextEp = getNextEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
                if (nextBtn) {
                    if (nextEp) {
                        nextBtn.style.display = 'inline-flex';
                        nextBtn.title = `Próximo: T${nextEp.seasonNum}E${nextEp.epNum} - ${nextEp.epNome}`;
                    } else {
                        nextBtn.style.display = 'none';
                    }
                }

                const prevEp = getPreviousEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
                if (prevBtn) {
                    if (prevEp) {
                        prevBtn.style.display = 'inline-flex';
                        prevBtn.title = `Anterior: T${prevEp.seasonNum}E${prevEp.epNum} - ${prevEp.epNome}`;
                    } else {
                        prevBtn.style.display = 'none';
                    }
                }
            } else {
                if (nextBtn) nextBtn.style.display = 'none';
                if (prevBtn) prevBtn.style.display = 'none';
            }
        }

        function playNextEpisodeDirectly() {
            if (currentPlayingMedia && currentPlayingMedia.type === 'serie') {
                triggerPlayNextEpisodeNow();
            }
        }

        function playPreviousEpisodeDirectly() {
            if (currentPlayingMedia && currentPlayingMedia.type === 'serie') {
                const prevInfo = getPreviousEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
                if (prevInfo) {
                    openPlaybackPageForEpisode(prevInfo.serieId, prevInfo.seasonNum, prevInfo.epNum, prevInfo.audio);
                    showToast(`⏮️ Voltando para T${prevInfo.seasonNum}E${prevInfo.epNum}...`, 'info');
                }
            }
        }

        let currentPlayingMedia = null;
        let autoPlayNextTimer = null;
        let autoPlayNextSeconds = 10;
        let autoPlayCancelled = false;
        let controlsHideTimeout = null;
        let lastTapTimes = { left: 0, right: 0 };
        let isTheaterMode = false;
        let savedResumeTime = 0;

        function getUserStreamingToken() {
            const saved = localStorage.getItem('bf_user_token');
            if (saved && saved.trim()) return saved.trim();
            const urlParams = new URLSearchParams(window.location.search);
            const fromUrl = urlParams.get('token') || urlParams.get('auth_token');
            if (fromUrl && fromUrl.trim()) {
                localStorage.setItem('bf_user_token', fromUrl.trim());
                return fromUrl.trim();
            }
            return 'public';
        }

        function openAuthLinkModal() {
            const modal = document.getElementById('auth-link-modal');
            const input = document.getElementById('manual-user-token-input');
            const currentToken = getUserStreamingToken();
            if (input && currentToken && currentToken !== 'public') {
                input.value = currentToken;
            }
            if (modal) modal.classList.add('active');
        }

        function closeAuthLinkModal() {
            const modal = document.getElementById('auth-link-modal');
            if (modal) modal.classList.remove('active');
        }

        function closeAuthLinkModalOnClick(e) {
            if (isSafeModalBackdropClick(e, 'auth-link-modal')) closeAuthLinkModal();
        }

        function saveManualUserToken() {
            const input = document.getElementById('manual-user-token-input');
            const val = (input?.value || '').trim();
            if (!val) {
                showToast('Informe seu ID do Telegram ou clique no botão do bot.', 'error');
                return;
            }
            localStorage.setItem('bf_user_token', val);
            closeAuthLinkModal();
            showToast('Conta vinculada com sucesso!', 'success');
            setTimeout(() => window.location.reload(), 600);
        }

        function showVipLimitOverlay(customMsg = null) {
            const overlay = document.getElementById('player-vip-limit-overlay');
            const msgEl = document.getElementById('player-vip-limit-msg');
            const video = document.getElementById('html5-video-player');
            if (video) video.pause();
            if (msgEl && customMsg) {
                msgEl.innerText = customMsg;
            }
            if (overlay) overlay.classList.add('visible');
        }

        function hideVipLimitOverlay() {
            const overlay = document.getElementById('player-vip-limit-overlay');
            if (overlay) overlay.classList.remove('visible');
        }

        function closeAllPlayerDropdowns() {
            document.getElementById('player-audio-menu')?.classList.remove('visible');
            document.getElementById('player-speed-menu')?.classList.remove('visible');
        }

        function toggleAudioDropdown(e) {
            if (e) e.stopPropagation();
            const speedMenu = document.getElementById('player-speed-menu');
            if (speedMenu) speedMenu.classList.remove('visible');
            const menu = document.getElementById('player-audio-menu');
            if (menu) menu.classList.toggle('visible');
        }

        function toggleMobilePlayerControls() {
            const card = document.getElementById('player-card-container');
            if (card) {
                card.classList.remove('controls-hidden');
                resetControlsAutoHide();
            }
        }

        // Listener global para fechar menus do player ao clicar ou tocar fora (funciona no PC e mobile)
        ['click', 'touchstart', 'pointerdown'].forEach(evtName => {
            document.addEventListener(evtName, (e) => {
                const audioBox = document.getElementById('player-audio-box');
                const speedBox = document.getElementById('player-speed-box');
                const audioMenu = document.getElementById('player-audio-menu');
                const speedMenu = document.getElementById('player-speed-menu');

                if (audioMenu && audioMenu.classList.contains('visible')) {
                    if (!audioBox || !audioBox.contains(e.target)) {
                        audioMenu.classList.remove('visible');
                    }
                }

                if (speedMenu && speedMenu.classList.contains('visible')) {
                    if (!speedBox || !speedBox.contains(e.target)) {
                        speedMenu.classList.remove('visible');
                    }
                }
            }, { passive: true });
        });

        function updatePlayerAudioUI(activeAudio, hasDub = true, hasLeg = true) {
            const label = document.getElementById('player-audio-label');
            const icon = document.getElementById('player-audio-icon');
            const optDub = document.getElementById('opt-audio-dub');
            const optLeg = document.getElementById('opt-audio-leg');
            const audioBox = document.getElementById('player-audio-box');

            const isDub = activeAudio === 'dublado';
            if (label) label.innerText = 'Idioma';
            if (icon) icon.innerText = isDub ? '🔊' : '💬';

            if (optDub) {
                optDub.classList.toggle('active', isDub);
                optDub.disabled = !hasDub;
                optDub.style.opacity = hasDub ? '1' : '0.35';
                optDub.style.cursor = hasDub ? 'pointer' : 'not-allowed';
            }
            if (optLeg) {
                optLeg.classList.toggle('active', !isDub);
                optLeg.disabled = !hasLeg;
                optLeg.style.opacity = hasLeg ? '1' : '0.35';
                optLeg.style.cursor = hasLeg ? 'pointer' : 'not-allowed';
            }

            if (audioBox) {
                audioBox.style.display = 'block';
            }
        }

        function switchPlayerAudio(newAudio) {
            const menu = document.getElementById('player-audio-menu');
            if (menu) menu.classList.remove('visible');

            if (!currentPlayingMedia || currentPlayingMedia.audio === newAudio) return;

            const video = document.getElementById('html5-video-player');
            const curTime = video ? video.currentTime : 0;
            const wasPlaying = video ? !video.paused : false;

            currentPlayingMedia.audio = newAudio;
            const token = getUserStreamingToken();
            let newStreamUrl = '';
            if (currentPlayingMedia.type === 'serie') {
                newStreamUrl = `/stream/video/${encodeURIComponent(token)}/serie/${encodeURIComponent(currentPlayingMedia.id)}/${currentPlayingMedia.season}/${currentPlayingMedia.episode}/${newAudio}`;
            } else {
                newStreamUrl = `/stream/video/${encodeURIComponent(token)}/filme/${encodeURIComponent(currentPlayingMedia.id)}/${newAudio}`;
            }
            currentPlayingMedia.streamUrl = newStreamUrl;

            // Salva preferência no storage para este título
            setUserMediaAudioPref(currentPlayingMedia.type || 'midia', currentPlayingMedia.id, newAudio, true, true);

            if (video) {
                video.pause();
                video.src = newStreamUrl;
                video.load();

                const onMetaLoaded = () => {
                    video.currentTime = Math.max(0, curTime);
                    if (wasPlaying) {
                        video.play().catch(() => { });
                    }
                    video.removeEventListener('loadedmetadata', onMetaLoaded);
                };
                video.addEventListener('loadedmetadata', onMetaLoaded);
            }

            updatePlayerAudioUI(newAudio, !!currentPlayingMedia.hasDub, !!currentPlayingMedia.hasLeg);
            showToast(`🔊 Áudio alterado para ${newAudio === 'dublado' ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)'}`, 'success');
        }

        function openWebPlayerForMovie(movieId, explicitAudio = null) {
            openPlaybackPageForMovie(movieId, explicitAudio, true);
        }

        function openWebPlayerEpisode(serieId, seasonNum, epNum, explicitAudio = null) {
            openPlaybackPageForEpisode(serieId, seasonNum, epNum, explicitAudio, true);
        }

        let pendingPlaybackMedia = null;

        function updatePlayerAuxControlsState(isPlaying) {
            const popoutBtn = document.getElementById('playback-btn-popout');
            const speedBtn = document.getElementById('player-speed-btn');

            if (popoutBtn) {
                if (isPlaying) {
                    popoutBtn.removeAttribute('disabled');
                    popoutBtn.style.opacity = '1';
                    popoutBtn.style.cursor = 'pointer';
                    popoutBtn.title = 'Janela Flutuante (Picture-in-Picture)';
                } else {
                    popoutBtn.setAttribute('disabled', 'true');
                    popoutBtn.style.opacity = '0.45';
                    popoutBtn.style.cursor = 'not-allowed';
                    popoutBtn.title = 'Inicie o vídeo para usar o Popout';
                }
            }

            if (speedBtn) {
                if (isPlaying) {
                    speedBtn.removeAttribute('disabled');
                    speedBtn.style.opacity = '1';
                    speedBtn.style.cursor = 'pointer';
                    speedBtn.title = 'Alterar Velocidade de Reprodução';
                } else {
                    speedBtn.setAttribute('disabled', 'true');
                    speedBtn.style.opacity = '0.45';
                    speedBtn.style.cursor = 'not-allowed';
                    speedBtn.title = 'Inicie o vídeo para alterar a velocidade';
                }
            }
        }

        function showPlaybackPosterOverlay(mediaInfo) {
            const overlay = document.getElementById('playback-poster-overlay');
            if (!overlay) return;

            updatePlayerAuxControlsState(false);

            // Se for convidado de uma sala ativa, bloqueia a reprodução direta e mostra a tela de espera do anfitrião
            if (currentPartyRoom && !partyIsHost) {
                overlay.style.display = 'none';
                overlay.classList.remove('visible');
                showPartyReadyOverlay(false);
                sendPartyAction('member_ready_state', { inPlayer: true, isReady: true, audio: mediaInfo.audio || 'dublado' });
                return;
            }

            const poster = mediaInfo.posterUrl || mediaInfo.backdropUrl || '/assets/logos/logo_horizontal.jpg';
            overlay.style.backgroundImage = `url('${poster}')`;

            const ctaTextEl = document.getElementById('playback-poster-cta-text');
            if (ctaTextEl) {
                if (currentPartyRoom && partyIsHost) {
                    ctaTextEl.innerHTML = `👥 Assistir com o Grupo (Sala ${currentPartyRoom})`;
                } else {
                    ctaTextEl.innerText = 'Clique para dar o play';
                }
            }

            overlay.style.display = 'flex';
            overlay.classList.add('visible');
        }

        function handlePosterPlayClick() {
            if (currentPartyRoom && partyIsHost) {
                startPartySyncAndShowReadyOverlay();
            } else {
                startPlaybackStreamNow();
            }
        }

        async function startPartySyncAndShowReadyOverlay() {
            hidePlaybackPosterOverlay();
            await syncCurrentMediaToParty();
            showPartyReadyOverlay(true);
            sendPartyAction('member_ready_state', { inPlayer: true, isReady: true, audio: currentPlayingMedia?.audio || 'dublado' });
        }

        function hidePlaybackPosterOverlay() {
            const overlay = document.getElementById('playback-poster-overlay');
            if (overlay) {
                overlay.style.display = 'none';
                overlay.classList.remove('visible');
            }
            updatePlayerAuxControlsState(true);
        }

        let isPartyPlaybackActive = false;

        function startPlaybackStreamNow(forcePlay = false) {
            hidePlaybackPosterOverlay();
            updatePlayerAuxControlsState(true);

            if (!currentPlayingMedia) return;

            const video = document.getElementById('html5-video-player');
            if (!video) return;

            if (!video.src || video.src === '' || !video.src.includes(currentPlayingMedia.streamUrl)) {
                video.preload = 'auto';
                video.src = currentPlayingMedia.streamUrl;
                video.load();
            }

            // MediaSession API para controles no teclado e fones Bluetooth
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: currentPlayingMedia.title || 'BrasilFlix',
                    artist: 'BrasilFlix 1080p',
                    album: currentPlayingMedia.sub || 'Streaming Oficial'
                });
                navigator.mediaSession.setActionHandler('play', () => video.play().catch(() => { }));
                navigator.mediaSession.setActionHandler('pause', () => video.pause());
                navigator.mediaSession.setActionHandler('seekforward', () => { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); });
                navigator.mediaSession.setActionHandler('seekbackward', () => { video.currentTime = Math.max(0, video.currentTime - 10); });
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    if (currentPlayingMedia?.type === 'serie') triggerPlayNextEpisodeNow();
                });
            }

            // ── AUTO-SYNC & INÍCIO PAUSADO WATCH PARTY ─────────────────────────
            if (currentPartyRoom && !forcePlay && !isPartyPlaybackActive) {
                video.pause();
                showPartyReadyOverlay(partyIsHost);
                sendPartyAction('member_ready_state', { inPlayer: true, isReady: true, audio: currentPlayingMedia.audio || 'dublado' });
            } else {
                hidePartyReadyOverlay();
                video.play().catch(err => {
                    console.warn('Autoplay com áudio pausado pelo navegador (requer interação):', err);
                });
            }

            // Se o host está em sala, sincroniza imediatamente a nova mídia com todos da sala
            if (currentPartyRoom && partyIsHost && !isSyncingFromRemote) {
                autoSyncMediaToParty();
            }
        }

        function openWebPlayer(title, subTitle, streamUrl, mediaInfo = {}) {
            const card = document.getElementById('player-card-container');
            const video = document.getElementById('html5-video-player');
            const titleEl = document.getElementById('player-media-title');
            const subEl = document.getElementById('player-media-sub');
            const badgeEl = document.getElementById('player-auth-badge');

            if (!video) return;

            hideVipLimitOverlay();

            currentPlayingMedia = {
                title,
                sub: subTitle,
                streamUrl,
                ...mediaInfo
            };
            pendingPlaybackMedia = currentPlayingMedia;

            // Registra evento de início de reprodução e heartbeat inicial na Auditoria
            trackAuditEvent('PLAYBACK_STARTED', {
                mediaId: mediaInfo.mediaId || mediaInfo.id,
                seriesId: mediaInfo.seriesId,
                seasonNum: mediaInfo.seasonNum !== undefined ? mediaInfo.seasonNum : mediaInfo.season,
                episodeNum: mediaInfo.episodeNum !== undefined ? mediaInfo.episodeNum : mediaInfo.episode,
                title,
                metadata: { type: mediaInfo.type, audio: mediaInfo.audio }
            });
            sendPlaybackHeartbeat({
                force: true,
                mediaId: mediaInfo.mediaId || mediaInfo.id,
                mediaType: mediaInfo.type || 'filme',
                title,
                seasonNum: mediaInfo.seasonNum || mediaInfo.season || 0,
                episodeNum: mediaInfo.episodeNum || mediaInfo.episode || 0,
                currentPosition: 1,
                duration: 100
            });

            autoPlayCancelled = false;
            hideAutoPlayNextCard();

            const token = getUserStreamingToken();
            const isAuth = token && token !== 'public';
            if (badgeEl) {
                badgeEl.innerText = isAuth ? 'VIP Conectado' : 'Conta Gratuita';
                badgeEl.style.background = isAuth ? 'rgba(245, 158, 11, 0.2)' : 'rgba(59, 130, 246, 0.2)';
                badgeEl.style.color = isAuth ? '#fbbf24' : '#60a5fa';
            }

            if (titleEl) titleEl.innerText = title;
            if (subEl) subEl.innerText = subTitle || 'BrasilFlix Streaming';

            // Configura UI de áudio no player
            // Usa !!hasDub/!!hasLeg: false quando undefined, ao invés de !==false que trata undefined como true
            updatePlayerAudioUI(mediaInfo.audio || 'dublado', !!mediaInfo.hasDub, !!mediaInfo.hasLeg);

            // Configura velocidade salva
            const savedSpeed = parseFloat(localStorage.getItem('bf_player_speed')) || 1.0;
            video.playbackRate = savedSpeed;
            const speedLabel = document.getElementById('player-speed-label');
            if (speedLabel) speedLabel.innerText = `${savedSpeed}x`;

            video.pause();

            // Intercepta erros de cota (403 Limite Gratuito)
            video.onerror = () => {
                fetch(streamUrl).then(async (res) => {
                    if (res.status === 403) {
                        const txt = await res.text();
                        showVipLimitOverlay(txt);
                    } else if (res.status === 404) {
                        showToast('Arquivo de mídia em processamento ou não encontrado.', 'error');
                    }
                }).catch(() => { });
            };

            // Configura controles nativos limpos para mobile/PC
            video.controls = true;
            try {
                video.controlsList = 'nodownload noplaybackrate';
            } catch (_) { }
            closeAllPlayerDropdowns();

            if (!video._cleanKeyListeners) {
                video._cleanKeyListeners = true;
                video.addEventListener('keydown', (e) => {
                    if ([' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                        e.preventDefault();
                    }
                });
            }

            video.onclick = () => {
                closeAllPlayerDropdowns();
                dismissResumePlayback();
                toggleMobilePlayerControls();
            };

            if (card && !card._touchBound) {
                card._touchBound = true;
                card.addEventListener('touchstart', () => {
                    toggleMobilePlayerControls();
                }, { passive: true });
            }

            // Escurecer e ocultar controles automaticamente durante reprodução
            video.onplay = () => {
                hidePlaybackPosterOverlay();
                closeAllPlayerDropdowns();
                resetControlsAutoHide();
                if (currentPartyRoom) {
                    const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                    const canPlay = partyIsHost || perms.canResume;
                    if (!canPlay && !isSyncingFromRemote) {
                        if (!partyRoomData?.isPlaying) {
                            video.pause();
                        }
                        showToast('⚠️ Apenas o anfitrião pode iniciar ou retomar a reprodução.', 'info');
                        return;
                    }
                    if (!isSyncingFromRemote) {
                        sendPartyAction('play', video.currentTime);
                    }
                }
            };

            video.onpause = () => {
                closeAllPlayerDropdowns();
                if (card) card.classList.remove('controls-hidden');
                if (currentPartyRoom) {
                    const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                    const canPause = partyIsHost || perms.canPause;
                    if (!canPause && !isSyncingFromRemote) {
                        if (partyRoomData?.isPlaying) {
                            video.play().catch(() => { });
                        }
                        showToast('⚠️ O anfitrião não permitiu pausar a reprodução.', 'info');
                        return;
                    }
                    if (!isSyncingFromRemote) {
                        sendPartyAction('pause', video.currentTime);
                    }
                }
            };

            video.onseeked = () => {
                dismissResumePlayback();
                if (currentPartyRoom) {
                    const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                    const canSeek = partyIsHost || perms.canSeek;
                    if (!canSeek && !isSyncingFromRemote) {
                        if (typeof partyRoomData?.currentTime === 'number') {
                            isSyncingFromRemote = true;
                            video.currentTime = partyRoomData.currentTime;
                            setTimeout(() => isSyncingFromRemote = false, 300);
                        }
                        showToast('⚠️ Apenas o anfitrião pode avançar ou retroceder o vídeo.', 'info');
                        return;
                    }
                    if (!isSyncingFromRemote) {
                        sendPartyAction('seek', video.currentTime);
                    }
                }
            };

            video.onended = () => {
                if (currentPlayingMedia) {
                    saveVideoProgressToServer(currentPlayingMedia, video.duration || 100, video.duration || 100, true);
                    const isSerie = currentPlayingMedia.type === 'serie' || currentPlayingMedia.type === 'dorama' || currentPlayingMedia.type === 'anime';
                    trackAuditEvent(isSerie ? 'EPISODE_COMPLETED' : 'MOVIE_COMPLETED', {
                        mediaId: currentPlayingMedia.id,
                        seriesId: currentPlayingMedia.seriesId,
                        seasonNum: currentPlayingMedia.season,
                        episodeNum: currentPlayingMedia.episode,
                        title: currentPlayingMedia.title,
                        metadata: { duration: video.duration }
                    });
                    sendPlaybackHeartbeat({
                        force: true,
                        mediaId: currentPlayingMedia.id,
                        mediaType: currentPlayingMedia.type || 'filme',
                        title: currentPlayingMedia.title,
                        seasonNum: currentPlayingMedia.season || 0,
                        episodeNum: currentPlayingMedia.episode || 0,
                        currentPosition: video.duration || 100,
                        duration: video.duration || 100,
                        completed: true
                    });
                }
                if (currentPlayingMedia?.type === 'serie') {
                    triggerPlayNextEpisodeNow();
                }
            };

            // Checa se há progresso salvo para sugerir retorno
            const progKey = `bf_prog_${mediaInfo.type || 'midia'}_${mediaInfo.id || 0}_${mediaInfo.season || 0}_${mediaInfo.episode || 0}`;
            const prevSaved = parseFloat(localStorage.getItem(progKey)) || 0;
            savedResumeTime = prevSaved;

            video.onloadedmetadata = () => {
                // Auto-detecta proporção vertical 9:16 ou horizontal 16:9
                const isVertical = (video.videoHeight > video.videoWidth * 1.05) || mediaInfo.formato === 'vertical' || mediaInfo.subtipo === 'microdrama';
                const stage = document.getElementById('playback-player-stage') || document.querySelector('.playback-player-stage');
                if (stage) {
                    if (isVertical) {
                        stage.classList.add('is-vertical-video');
                    } else {
                        stage.classList.remove('is-vertical-video');
                    }
                }

                if (savedResumeTime > 15 && savedResumeTime < (video.duration - 60)) {
                    showResumeBanner(savedResumeTime);
                } else {
                    dismissResumePlayback();
                }

                if (currentPartyRoom) {
                    sendPartyAction('member_ready_state', { inPlayer: true, isReady: true, isLoading: false, audio: mediaInfo.audio });
                }
            };

            // Se autoPlay for explicitamente true, inicia imediatamente
            if (mediaInfo.autoPlay === true) {
                startPlaybackStreamNow();
            } else {
                // Pré-arma a fonte em segundo plano com preload auto para handshake e buffer inicial instantâneos
                if (!currentPartyRoom || partyIsHost) {
                    if (!video.src || video.src === '' || !video.src.includes(streamUrl)) {
                        video.preload = 'auto';
                        video.src = streamUrl;
                        video.load();
                    }
                }
                // Exibe a capa com o botão de play no player (NÃO inicia reprodução com áudio até o usuário clicar)
                showPlaybackPosterOverlay(mediaInfo);
            }
        }

        function closeWebPlayer() {
            const card = document.getElementById('player-card-container');
            const video = document.getElementById('html5-video-player');

            if (currentPartyRoom) {
                if (partyIsHost) {
                    sendPartyAction('stop_media');
                } else {
                    sendPartyAction('member_ready_state', { inPlayer: false, isReady: false, isLoading: false });
                }
            }

            if (video) {
                // Salva progresso ao fechar
                if (currentPlayingMedia && video.currentTime > 10) {
                    const progKey = `bf_prog_${currentPlayingMedia.type || 'midia'}_${currentPlayingMedia.id || 0}_${currentPlayingMedia.season || 0}_${currentPlayingMedia.episode || 0}`;
                    localStorage.setItem(progKey, video.currentTime);
                }
                video.pause();
                video.removeAttribute('src');
                video.load();
            }
            if (card) card.classList.remove('controls-hidden');
            hideAutoPlayNextCard();
            dismissResumePlayback();
            currentPlayingMedia = null;
        }

        /* ── Unified Fullscreen Controller ─────────────────────────────── */
        function getActiveFullscreenElement() {
            return document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement ||
                document.msFullscreenElement ||
                null;
        }

        function isPlayerInFullscreen() {
            const video = document.getElementById('html5-video-player');
            return !!getActiveFullscreenElement() || !!(video && video.webkitDisplayingFullscreen);
        }

        function syncFullscreenState() {
            const isFs = isPlayerInFullscreen();
            const btn = document.getElementById('player-fullscreen-btn');
            const label = document.getElementById('player-fullscreen-label');
            const icon = document.getElementById('player-fullscreen-icon');
            if (label) label.textContent = isFs ? ' Sair da Tela Cheia' : ' Tela Cheia';
            if (icon) icon.textContent = isFs ? '🗗' : '⛶';
            if (btn) btn.title = isFs ? 'Sair da Tela Cheia (F)' : 'Tela Cheia (F)';
        }

        if (!window._fullscreenListenersBound) {
            window._fullscreenListenersBound = true;
            ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(evt => {
                document.addEventListener(evt, syncFullscreenState);
            });
            window.addEventListener('resize', syncFullscreenState);
        }

        async function togglePlayerFullscreen() {
            const video = document.getElementById('html5-video-player');
            const card = document.getElementById('player-card-container');
            const target = video || card;
            if (!target) return;

            try {
                const activeFs = getActiveFullscreenElement();
                const isVideoFs = !!(video && video.webkitDisplayingFullscreen);

                if (activeFs || isVideoFs) {
                    if (document.exitFullscreen) {
                        await document.exitFullscreen().catch(() => { });
                    } else if (document.webkitExitFullscreen) {
                        await document.webkitExitFullscreen().catch(() => { });
                    } else if (document.mozCancelFullScreen) {
                        await document.mozCancelFullScreen().catch(() => { });
                    } else if (document.msExitFullscreen) {
                        await document.msExitFullscreen().catch(() => { });
                    }
                    if (video && video.webkitExitFullscreen && isVideoFs) {
                        try { video.webkitExitFullscreen(); } catch (e) { }
                    }
                } else {
                    if (target.requestFullscreen) {
                        await target.requestFullscreen();
                    } else if (target.webkitRequestFullscreen) {
                        await target.webkitRequestFullscreen();
                    } else if (target.mozRequestFullScreen) {
                        await target.mozRequestFullScreen();
                    } else if (target.msRequestFullscreen) {
                        await target.msRequestFullscreen();
                    } else if (video && video.webkitEnterFullscreen) {
                        video.webkitEnterFullscreen();
                    }
                }
            } catch (err) {
                console.warn('[Player] Alternando fullscreen fallback:', err);
                if (video && video.webkitEnterFullscreen) {
                    try { video.webkitEnterFullscreen(); } catch (e) { }
                }
            }
            setTimeout(syncFullscreenState, 150);
        }

        async function togglePictureInPicture() {
            const overlay = document.getElementById('playback-poster-overlay');
            const isPosterVisible = overlay && (overlay.style.display !== 'none' || overlay.classList.contains('visible'));
            const video = document.getElementById('html5-video-player');

            if (isPosterVisible || !video || !video.src || video.src === '' || video.readyState === 0) {
                showToast('⚠️ Inicie a reprodução do vídeo para abrir a Janela Flutuante (Popout).', 'info');
                return;
            }

            try {
                if (document.pictureInPictureElement) {
                    await document.exitPictureInPicture();
                } else if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
                    await video.requestPictureInPicture();
                } else {
                    showToast('Popout (PiP) não suportado neste navegador.', 'error');
                }
            } catch (err) {
                showToast('Popout (PiP) indisponível no momento.', 'error');
            }
        }

        function toggleTheaterMode() {
            const stage = document.getElementById('playback-player-stage') || document.querySelector('.playback-player-stage');
            if (!stage) return;
            isTheaterMode = !isTheaterMode;
            stage.classList.toggle('theater-mode', isTheaterMode);
            const btn = document.getElementById('player-theater-btn');
            if (btn) {
                btn.style.background = isTheaterMode ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.08)';
                btn.style.color = isTheaterMode ? '#60a5fa' : '#fff';
                btn.innerText = isTheaterMode ? '💡 Janela Padrão' : '💡 Modo Cinema';
            }
            showToast(isTheaterMode ? '💡 Modo Cinema Imersivo (Tela Expandida)' : '💡 Modo Janela Padrão', 'info');
        }

        function toggleSpeedDropdown(e) {
            if (e) e.stopPropagation();

            const overlay = document.getElementById('playback-poster-overlay');
            const isPosterVisible = overlay && (overlay.style.display !== 'none' || overlay.classList.contains('visible'));
            const video = document.getElementById('html5-video-player');

            if (isPosterVisible || !video || !video.src || video.src === '' || video.readyState === 0) {
                showToast('⚠️ Inicie a reprodução do vídeo para alterar a velocidade.', 'info');
                return;
            }

            const audioMenu = document.getElementById('player-audio-menu');
            if (audioMenu) audioMenu.classList.remove('visible');
            const menu = document.getElementById('player-speed-menu');
            if (menu) menu.classList.toggle('visible');
        }

        function setPlaybackSpeed(speed) {
            const overlay = document.getElementById('playback-poster-overlay');
            const isPosterVisible = overlay && (overlay.style.display !== 'none' || overlay.classList.contains('visible'));
            const video = document.getElementById('html5-video-player');

            if (isPosterVisible || !video || !video.src || video.src === '' || video.readyState === 0) {
                showToast('⚠️ Inicie a reprodução do vídeo para alterar a velocidade.', 'info');
                return;
            }

            if (currentPartyRoom) {
                const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                const canSpeed = partyIsHost || perms.canChangeSpeed;
                if (!canSpeed) {
                    showToast('⚠️ Velocidade de reprodução sincronizada com o anfitrião.', 'info');
                    return;
                }
            }
            if (video) video.playbackRate = speed;
            const label = document.getElementById('player-speed-label');
            if (label) label.innerText = `${speed}x`;
            document.querySelectorAll('.speed-opt-btn').forEach(btn => {
                btn.classList.toggle('active', btn.innerText.includes(`${speed}x`));
            });
            localStorage.setItem('bf_player_speed', speed);
            const menu = document.getElementById('player-speed-menu');
            if (menu) menu.classList.remove('visible');
            showToast(`⚡ Velocidade ajustada para ${speed}x`, 'info');
            if (currentPartyRoom && partyIsHost) {
                sendPartyAction('set_speed', { speed });
            }
        }

        function handleZoneTap(e, seconds) {
            closeAllPlayerDropdowns();
            dismissResumePlayback();
            toggleMobilePlayerControls();

            const now = Date.now();
            const zoneKey = seconds < 0 ? 'left' : 'right';
            const lastTap = lastTapTimes[zoneKey] || 0;

            if (now - lastTap < 350) {
                // Duplo toque real: avança/retrocede 10s e consome o evento
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                if (currentPartyRoom) {
                    const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
                    const canSeek = partyIsHost || perms.canSeek;
                    if (!canSeek) {
                        showToast('⚠️ Apenas o anfitrião pode avançar ou retroceder o vídeo.', 'info');
                        return;
                    }
                }
                const video = document.getElementById('html5-video-player');
                if (video) {
                    video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + seconds));
                    const ripple = document.getElementById(seconds < 0 ? 'ripple-left' : 'ripple-right');
                    if (ripple) {
                        ripple.classList.remove('active');
                        void ripple.offsetWidth;
                        ripple.classList.add('active');
                        setTimeout(() => ripple.classList.remove('active'), 450);
                    }
                }
                lastTapTimes[zoneKey] = 0;
            } else {
                // Toque simples: NÃO chama preventDefault para permitir que o clique alcance o vídeo/controles
                lastTapTimes[zoneKey] = now;
            }
        }

        function handlePlayerMouseMove() {
            const card = document.getElementById('player-card-container');
            if (card) card.classList.remove('controls-hidden');
            resetControlsAutoHide();
        }

        function handlePlayerMouseLeave() {
            const video = document.getElementById('html5-video-player');
            if (video && !video.paused) {
                const card = document.getElementById('player-card-container');
                if (card) card.classList.add('controls-hidden');
            }
        }

        function resetControlsAutoHide() {
            clearTimeout(controlsHideTimeout);
            const video = document.getElementById('html5-video-player');
            if (video && !video.paused) {
                controlsHideTimeout = setTimeout(() => {
                    const card = document.getElementById('player-card-container');
                    if (card && !video.paused) card.classList.add('controls-hidden');
                }, 3000);
            }
        }

        function onVideoTimeUpdate() {
            const video = document.getElementById('html5-video-player');
            if (!video || !currentPlayingMedia) return;

            const timeHintEl = document.getElementById('playback-current-time-hint');
            if (timeHintEl && typeof formatSecondsToTimestamp === 'function') {
                timeHintEl.innerText = formatSecondsToTimestamp(video.currentTime);
            }

            // Salva progresso no localStorage e no PostgreSQL
            if (video.currentTime > 5 && video.duration > 15) {
                const key = `bf_prog_${currentPlayingMedia.type || 'midia'}_${currentPlayingMedia.id || 0}_${currentPlayingMedia.season || 0}_${currentPlayingMedia.episode || 0}`;
                localStorage.setItem(key, Math.floor(video.currentTime));
                saveVideoProgressToServer(currentPlayingMedia, video.currentTime, video.duration);
                sendPlaybackHeartbeat({
                    mediaId: currentPlayingMedia.id,
                    mediaType: currentPlayingMedia.type,
                    title: currentPlayingMedia.title || currentPlayingMedia.serieNome || 'Mídia',
                    seasonNum: currentPlayingMedia.season || 0,
                    episodeNum: currentPlayingMedia.episode || 0,
                    currentPosition: video.currentTime,
                    duration: video.duration,
                    completed: video.ended || (video.duration > 60 && video.currentTime >= video.duration * 0.9)
                });
            }

            // Auto-Play inteligente estilo Netflix para séries
            if (currentPlayingMedia.type === 'serie' && !autoPlayCancelled && video.duration > 60) {
                const timeLeft = video.duration - video.currentTime;
                if (timeLeft <= 35 && timeLeft > 0) {
                    showAutoPlayNextCard(timeLeft);
                } else if (timeLeft > 35) {
                    hideAutoPlayNextCard();
                }
            }
        }

        function formatSecondsToTime(sec) {
            sec = Math.max(0, Math.floor(sec || 0));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const s = sec % 60;
            const sPad = s < 10 ? '0' + s : s;
            if (h > 0) {
                const mPad = m < 10 ? '0' + m : m;
                return `${h}:${mPad}:${sPad}`;
            }
            return `${m}:${sPad}`;
        }

        let resumeBannerTimer = null;

        function showResumeBanner(seconds) {
            const banner = document.getElementById('player-resume-banner');
            const timeStr = document.getElementById('resume-time-str');
            if (banner && timeStr) {
                timeStr.innerText = formatSecondsToTime(seconds);
                banner.classList.add('visible');

                // Desaparece automaticamente após 10 segundos de reprodução
                clearTimeout(resumeBannerTimer);
                resumeBannerTimer = setTimeout(() => {
                    dismissResumePlayback();
                }, 10000);
            }
        }

        function confirmResumePlayback(e) {
            if (e) e.stopPropagation();
            const video = document.getElementById('html5-video-player');
            if (video && savedResumeTime > 0) {
                video.currentTime = savedResumeTime;
                video.play().catch(() => { });
                showToast(`▶ Continuando em ${formatSecondsToTime(savedResumeTime)}...`, 'success');
            }
            dismissResumePlayback();
        }

        function dismissResumePlayback(e) {
            if (e) e.stopPropagation();
            clearTimeout(resumeBannerTimer);
            const banner = document.getElementById('player-resume-banner');
            if (banner) banner.classList.remove('visible');
        }

        function getNextEpisodeInfo(serieOrId, currentSeasonNum, currentEpNum) {
            let serie = null;
            if (serieOrId && typeof serieOrId === 'object' && serieOrId.id) {
                serie = serieOrId;
            } else if (serieOrId) {
                serie = (fullCatalog.series || []).find(s => String(s.id) === String(serieOrId));
            }
            if (!serie && typeof currentPlaybackSerie !== 'undefined' && currentPlaybackSerie) {
                serie = currentPlaybackSerie;
            }
            if (!serie || !serie.temporadas || !Array.isArray(serie.temporadas)) return null;

            const cSeason = Number(currentSeasonNum);
            const cEp = Number(currentEpNum);
            const prefAudio = typeof getUserPreferredAudio === 'function' ? getUserPreferredAudio() : 'dublado';

            // 1. Procura próximo episódio na mesma temporada
            const tempAtual = serie.temporadas.find(t => Number(t.numero) === cSeason);
            if (tempAtual && Array.isArray(tempAtual.episodios) && tempAtual.episodios.length > 0) {
                const sortedEps = [...tempAtual.episodios].sort((a, b) => Number(a.numero) - Number(b.numero));
                const proxEp = sortedEps.find(e => Number(e.numero) === cEp + 1);
                if (proxEp) {
                    const hasDub = !!proxEp.versoes?.dublado || proxEp.isDublado;
                    const hasLeg = !!proxEp.versoes?.legendado || proxEp.isLegendado;
                    let epAudio = prefAudio;
                    if (epAudio === 'dublado' && !hasDub && hasLeg) epAudio = 'legendado';
                    else if (epAudio === 'legendado' && !hasLeg && hasDub) epAudio = 'dublado';
                    else if (!hasDub && !hasLeg) epAudio = currentPlayingMedia?.audio || (serie.isDublado ? 'dublado' : 'legendado');

                    return {
                        serieId: serie.id,
                        serieNome: serie.nome,
                        seasonNum: cSeason,
                        epNum: Number(proxEp.numero),
                        epNome: proxEp.nome || `Episódio ${proxEp.numero}`,
                        audio: epAudio,
                        isNextSeason: false,
                        buttonLabel: 'Próximo Episódio ⏭'
                    };
                }
            }

            // 2. Se não encontrou na mesma temporada, procura na próxima temporada disponível
            const proxTemps = [...serie.temporadas]
                .filter(t => Number(t.numero) > cSeason && Array.isArray(t.episodios) && t.episodios.length > 0)
                .sort((a, b) => Number(a.numero) - Number(b.numero));

            if (proxTemps.length > 0) {
                const proxTemp = proxTemps[0];
                const sortedEps = [...proxTemp.episodios].sort((a, b) => Number(a.numero) - Number(b.numero));
                const proxEp = sortedEps[0];
                if (proxEp) {
                    const hasDub = !!proxEp.versoes?.dublado || proxEp.isDublado;
                    const hasLeg = !!proxEp.versoes?.legendado || proxEp.isLegendado;
                    let epAudio = prefAudio;
                    if (epAudio === 'dublado' && !hasDub && hasLeg) epAudio = 'legendado';
                    else if (epAudio === 'legendado' && !hasLeg && hasDub) epAudio = 'dublado';
                    else if (!hasDub && !hasLeg) epAudio = currentPlayingMedia?.audio || (serie.isDublado ? 'dublado' : 'legendado');

                    return {
                        serieId: serie.id,
                        serieNome: serie.nome,
                        seasonNum: Number(proxTemp.numero),
                        epNum: Number(proxEp.numero),
                        epNome: proxEp.nome || `Episódio ${proxEp.numero}`,
                        audio: epAudio,
                        isNextSeason: true,
                        buttonLabel: 'Próxima Temporada ⏭'
                    };
                }
            }

            return null;
        }

        function getPreviousEpisodeInfo(serieOrId, currentSeasonNum, currentEpNum) {
            let serie = null;
            if (serieOrId && typeof serieOrId === 'object' && serieOrId.id) {
                serie = serieOrId;
            } else if (serieOrId) {
                serie = (fullCatalog.series || []).find(s => String(s.id) === String(serieOrId));
            }
            if (!serie && typeof currentPlaybackSerie !== 'undefined' && currentPlaybackSerie) {
                serie = currentPlaybackSerie;
            }
            if (!serie || !serie.temporadas || !Array.isArray(serie.temporadas)) return null;

            const cSeason = Number(currentSeasonNum);
            const cEp = Number(currentEpNum);

            // 1. Episódio anterior na mesma temporada
            const tempAtual = serie.temporadas.find(t => Number(t.numero) === cSeason);
            if (tempAtual && Array.isArray(tempAtual.episodios) && tempAtual.episodios.length > 0) {
                const sortedEps = [...tempAtual.episodios].sort((a, b) => Number(a.numero) - Number(b.numero));
                const prevEp = sortedEps.find(e => Number(e.numero) === cEp - 1);
                if (prevEp) {
                    return {
                        serieId: serie.id,
                        serieNome: serie.nome,
                        seasonNum: cSeason,
                        epNum: Number(prevEp.numero),
                        epNome: prevEp.nome || `Episódio ${prevEp.numero}`,
                        audio: currentPlayingMedia?.audio || (prevEp.isDublado ? 'dublado' : 'legendado'),
                        isPrevSeason: false,
                        buttonLabel: '⏮ Episódio Anterior'
                    };
                }
            }

            // 2. Temporada anterior: último episódio da temporada anterior mais próxima
            const prevTemps = [...serie.temporadas]
                .filter(t => Number(t.numero) < cSeason && Array.isArray(t.episodios) && t.episodios.length > 0)
                .sort((a, b) => Number(b.numero) - Number(a.numero)); // Decrescente para pegar a imediatamente anterior

            if (prevTemps.length > 0) {
                const prevTemp = prevTemps[0];
                const sortedEps = [...prevTemp.episodios].sort((a, b) => Number(a.numero) - Number(b.numero));
                const prevEp = sortedEps[sortedEps.length - 1];
                if (prevEp) {
                    return {
                        serieId: serie.id,
                        serieNome: serie.nome,
                        seasonNum: Number(prevTemp.numero),
                        epNum: Number(prevEp.numero),
                        epNome: prevEp.nome || `Episódio ${prevEp.numero}`,
                        audio: currentPlayingMedia?.audio || (prevEp.isDublado ? 'dublado' : 'legendado'),
                        isPrevSeason: true,
                        buttonLabel: '⏮ Temporada Anterior'
                    };
                }
            }

            return null;
        }

        function showAutoPlayNextCard(timeLeft) {
            if (!currentPlayingMedia || currentPlayingMedia.type !== 'serie') return;
            const nextInfo = getNextEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
            if (!nextInfo) return;

            const card = document.getElementById('player-next-ep-card');
            const titleEl = document.getElementById('next-ep-title');
            const countText = document.getElementById('next-ep-counter-text');
            const ring = document.getElementById('next-ep-ring');

            const countdownSec = Math.max(0, Math.ceil(Math.min(10, timeLeft)));

            if (card && titleEl && countText && ring) {
                titleEl.innerText = `T${nextInfo.seasonNum}E${nextInfo.epNum} - ${nextInfo.epNome}`;
                countText.innerText = countdownSec;
                ring.style.setProperty('--next-progress', (countdownSec / 10));
                card.classList.add('visible');
            }

            if (countdownSec <= 0) {
                triggerPlayNextEpisodeNow();
            }
        }

        function hideAutoPlayNextCard() {
            const card = document.getElementById('player-next-ep-card');
            if (card) card.classList.remove('visible');
        }

        function cancelAutoPlayNextEpisode() {
            autoPlayCancelled = true;
            hideAutoPlayNextCard();
            showToast('Auto-Play cancelado. O episódio continuará até o fim.', 'info');
        }

        function triggerPlayNextEpisodeNow() {
            if (!currentPlayingMedia || currentPlayingMedia.type !== 'serie') return;
            const nextInfo = getNextEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
            if (!nextInfo) return;

            hideAutoPlayNextCard();
            openWebPlayerEpisode(nextInfo.serieId, nextInfo.seasonNum, nextInfo.epNum, nextInfo.audio);
            showToast(`⏩ Iniciando T${nextInfo.seasonNum}E${nextInfo.epNum}...`, 'success');
        }

        function formatTimeSeconds(seconds) {
            if (!seconds || isNaN(seconds)) return '00:00';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            if (mins >= 60) {
                const hrs = Math.floor(mins / 60);
                const remMins = mins % 60;
                return `${hrs}:${remMins < 10 ? '0' : ''}${remMins}:${secs < 10 ? '0' : ''}${secs}`;
            }
            return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`;
        }

        function handleShareCurrentMedia() {
            if (!currentPlayingMedia) return;
            const video = document.getElementById('html5-video-player');
            const curTime = Math.floor(video?.currentTime || 0);

            const timeFormatted = formatTimeSeconds(curTime);
            const timeLabel = document.getElementById('share-modal-cur-time');
            if (timeLabel) timeLabel.innerText = timeFormatted;

            const modal = document.getElementById('share-choice-modal');
            if (modal) modal.classList.add('active');
        }

        function closeShareChoiceModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'share-choice-modal')) return;
            const modal = document.getElementById('share-choice-modal');
            if (modal) modal.classList.remove('active');
        }

        function executeCopyShareLink(mode) {
            if (!currentPlayingMedia) return;
            const video = document.getElementById('html5-video-player');
            const curTime = Math.floor(video?.currentTime || 0);
            const token = getUserStreamingToken();
            const title = currentPlayingMedia.title || 'BrasilFlix';

            let url = `https://brasilflix.kapsu.com.br/?ver=${currentPlayingMedia.id}`;
            if (token && token !== 'public') url += `&token=${token}`;
            if (mode === 'current' && curTime > 5) {
                url += `&t=${curTime}`;
            }

            closeShareChoiceModal();

            if (navigator.clipboard) {
                navigator.clipboard.writeText(url).then(() => {
                    showToast(mode === 'current' ? `Link copiado no tempo ${formatTimeSeconds(curTime)}!` : 'Link do início copiado!', 'success');
                }).catch(() => {
                    prompt('Copie o link do vídeo:', url);
                });
            } else {
                prompt('Copie o link do vídeo:', url);
            }
        }

        /* ═══════════════════════════════════════════════════════════════════════
           👥 SISTEMA ASSISTIR JUNTO (WATCH PARTY) v2.0 — PAINEL PERSISTENTE
           ═══════════════════════════════════════════════════════════════════════ */

        /* --- Estado global da sala --- */
        let currentPartyRoom = null;      // código da sala (null = sem sala)
        let partyEventSource = null;      // conexão SSE
        let isSyncingFromRemote = false;  // evita loop de sync
        let partyIsHost = false;          // é anfitrião?
        let partyPanelVisible = false;    // painel flutuante visível?
        let partyMyUserId = localStorage.getItem('bf_party_uid') || ('user_' + Math.random().toString(36).substring(2, 9));
        localStorage.setItem('bf_party_uid', partyMyUserId);
        let partyPendingMedia = null;
        let partyRoomData = null;
        let partyWheelItems = [];         // itens da roleta
        let partyWheelSpinning = false;

        /* --- Persistência: reconecta sala ao recarregar página --- */
        (function restorePartySession() {
            const savedRoom = localStorage.getItem('bf_party_room');
            const savedName = localStorage.getItem('bf_party_name') || 'Amigo';
            if (savedRoom) {
                // Aguarda catálogo carregar antes de reconectar
                setTimeout(async () => {
                    try {
                        const res = await fetch('/api/party/room/' + savedRoom);
                        if (!res.ok) { localStorage.removeItem('bf_party_room'); return; }
                        const data = await res.json();
                        if (!data.room) { localStorage.removeItem('bf_party_room'); return; }
                        const room = data.room;
                        currentPartyRoom = room.id;
                        partyRoomData = room;
                        partyIsHost = String(partyMyUserId) === String(room.hostId);
                        connectToPartyEventSource(room.id, savedName);
                        updatePartyHeaderState();
                        // Não reabre o player automaticamente — apenas reativa o painel
                        showToast('👥 Reconectado à sala ' + room.id + '!', 'success');
                        // Mostra painel flutuante
                        showPartyPanel(partyIsHost);
                    } catch (e) { localStorage.removeItem('bf_party_room'); }
                }, 1800);
            }
        })();

        /* ── UI: Header Button & Status Bar ─────────────────────────────────── */

        function updatePartyHeaderState() {
            const btn = document.getElementById('party-header-btn');
            const badge = document.getElementById('party-member-badge');
            const header = document.getElementById('main-header');

            if (!btn) return;

            if (currentPartyRoom) {
                btn.classList.add('in-room');
                const memberCount = (partyRoomData?.members || []).length;
                if (badge) {
                    badge.innerText = memberCount || 1;
                    badge.style.display = 'flex';
                }
                btn.title = `Sala Ativa: ${currentPartyRoom} (${memberCount || 1} online) - Clique para gerenciar`;
                localStorage.setItem('bf_party_room', currentPartyRoom);
            } else {
                btn.classList.remove('in-room');
                if (badge) {
                    badge.innerText = '0';
                    badge.style.display = 'none';
                }
                btn.title = 'Modo Grupo / Assistir Junto - Criar ou entrar em uma sala';
                if (header) header.style.top = '';
                localStorage.removeItem('bf_party_room');
                const panel = document.getElementById('party-floating-panel');
                if (panel) {
                    panel.classList.remove('visible');
                    panel.classList.remove('collapsed');
                }
                partyPanelVisible = false;
            }
        }

        /* ── UI: Painel Flutuante ─────────────────────────────────────────── */

        function showPartyPanel(isHost) {
            const panel = document.getElementById('party-floating-panel');
            const hostControls = document.getElementById('panel-host-controls');
            const closeBtn = document.getElementById('panel-close-room-btn');
            const codeEl = document.getElementById('panel-room-code');
            const headerCodeEl = document.getElementById('panel-header-room-code');
            if (codeEl) codeEl.innerText = currentPartyRoom || '------';
            if (headerCodeEl) headerCodeEl.innerText = currentPartyRoom || '----';
            if (hostControls) hostControls.style.display = isHost ? 'block' : 'none';
            if (closeBtn) closeBtn.style.display = isHost ? 'block' : 'none';
            if (panel) {
                panel.classList.add('visible');
                panel.classList.remove('collapsed');
                partyPanelVisible = true;
            }
            renderPartyWheelModal();
            updatePartyHeaderState();
        }

        function togglePartyPanel() {
            if (!currentPartyRoom) { onPartyHeaderBtnClick(); return; }
            togglePanelBody();
        }

        function handlePartyPanelContainerClick(e) {
            const panel = document.getElementById('party-floating-panel');
            if (panel && panel.classList.contains('collapsed')) {
                panel.classList.remove('collapsed');
            }
        }

        function togglePanelBody(e) {
            if (e) e.stopPropagation();
            const panel = document.getElementById('party-floating-panel');
            if (!panel) return;
            panel.classList.toggle('collapsed');
        }

        /* ── Helper de Apelido Padrão ─────────────────────────────────────── */
        function getDefaultUserNickname() {
            return localStorage.getItem('bf_party_name') ||
                currentUser?.nome ||
                currentUser?.username ||
                currentUser?.first_name ||
                'Membro';
        }

        /* ── Overlay: Todos Estão Prontos? ────────────────────────────────── */
        function showPartyReadyOverlay(isHost) {
            if (isPartyPlaybackActive) return; // Não exibe o overlay se a transmissão já foi iniciada na sala

            const overlay = document.getElementById('party-ready-overlay');
            const video = document.getElementById('html5-video-player');
            if (video && !video.paused) video.pause();
            if (!overlay) return;

            const title = document.getElementById('party-ready-title');
            const msg = document.getElementById('party-ready-msg');
            const actions = document.getElementById('party-ready-actions');

            // Garante que o usuário atual (local) está marcado como no player e pronto
            if (partyMyUserId && partyRoomData && Array.isArray(partyRoomData.members)) {
                const me = partyRoomData.members.find(m => String(m.id) === String(partyMyUserId));
                if (me) {
                    me.inPlayer = true;
                    me.isReady = true;
                }
            }

            const members = partyRoomData?.members || [];
            const total = Math.max(1, members.length);
            const readyCount = members.filter(m => (String(m.id) === String(partyMyUserId)) || (m.inPlayer && m.isReady)).length;
            const otherMembers = members.filter(m => !m.isHost && String(m.id) !== String(partyMyUserId));
            const otherReadyCount = otherMembers.filter(m => m.inPlayer && m.isReady).length;
            const allReady = total > 1 ? (otherReadyCount === otherMembers.length) : true;

            const membersListHtml = members.length > 0 ? `
                <div style="margin: 12px 0 16px 0; background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 10px; max-height: 130px; overflow-y: auto; text-align: left;">
                    <div style="font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; margin-bottom: 6px; letter-spacing: 0.5px;">Status dos Participantes:</div>
                    ${members.map(m => {
                const isMe = String(m.id) === String(partyMyUserId);
                const isMReady = isMe || (m.inPlayer && m.isReady);
                return `
                            <div style="display: flex; align-items: center; justify-content: space-between; padding: 4px 2px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px;">
                                <span style="display: flex; align-items: center; gap: 6px; color: ${isMReady ? '#fff' : 'var(--text-muted)'}; font-weight: ${isMReady ? '700' : '500'};">
                                    <span>${m.isHost ? '👑' : '👤'}</span>
                                    <span>${escapeHtml(m.name)}${isMe ? ' <span style="color:#38bdf8;font-size:10px;">(você)</span>' : ''}</span>
                                </span>
                                <span style="font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 4px; ${isMReady ? 'background: rgba(16,185,129,0.2); color: #34d399; border: 1px solid rgba(16,185,129,0.4);' : 'background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.3);'}">
                                    ${isMReady ? '✓ Player Pronto' : '⏳ No Lobby'}
                                </span>
                            </div>
                        `;
            }).join('')}
                </div>
            ` : '';

            if (isHost) {
                if (title) title.innerText = `👥 Transmitindo para a Sala (${readyCount}/${total} no Player)`;
                if (msg) {
                    let descHtml = '';
                    if (total === 1) {
                        descHtml = `Você é o único na sala no momento. Convide seus amigos com o link de convite ou clique abaixo para iniciar a reprodução.`;
                    } else if (allReady) {
                        descHtml = `🎉 <strong>Todos os ${total} membros</strong> da sala já estão com o player aberto e prontos para rodar! Clique abaixo para iniciar a transmissão simultânea.`;
                    } else {
                        descHtml = `A página foi enviada para todos da sala. Aguardando os membros carregarem o vídeo (<strong>${otherReadyCount}/${otherMembers.length}</strong> amigos prontos no player).`;
                    }
                    msg.innerHTML = descHtml + membersListHtml;
                }
                if (actions) {
                    actions.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
                            <button class="btn-modal btn-modal-primary" style="width: 100%; padding: 13px; font-size: 14px; font-weight: 800; background: linear-gradient(135deg, #10b981, #059669); border-color: #34d399; box-shadow: 0 0 24px rgba(16,185,129,0.45);" onclick="startPartyPlaybackNow()">
                                ▶️ ${allReady ? 'Todos Estão Prontos! Iniciar Para Todos' : 'Iniciar Agora Para Todos'} (${readyCount}/${total})
                            </button>
                            <button class="btn-modal btn-modal-secondary" style="padding: 9px; font-size: 12px; font-weight: 700; width: 100%; border-radius: 8px;" onclick="syncCurrentMediaToParty()">
                                🔄 Reenviar Página para os Membros
                            </button>
                        </div>
                    `;
                }
            } else {
                if (title) title.innerText = `⏳ Aguardando o Anfitrião Começar (${readyCount}/${total} no Player)`;
                if (msg) {
                    const hostName = partyRoomData?.hostName || 'Anfitrião';
                    msg.innerHTML = `O anfitrião (${escapeHtml(hostName)}) está no comando da transmissão. Seu player está conectado e pronto! Assim que o anfitrião der o play, o vídeo começará para todos os <strong>${total} membros</strong> ao mesmo tempo.` + membersListHtml;
                }
                if (actions) {
                    actions.innerHTML = `
                        <div style="display: flex; flex-direction: column; gap: 8px; width: 100%;">
                            <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.3); border-radius: 10px; padding: 12px; color: #34d399; font-size: 13px; font-weight: 800; text-align: center;">
                                ✅ Player Conectado • Aguardando o play do anfitrião...
                            </div>
                            <button class="btn-modal btn-modal-secondary" style="padding: 10px; font-size: 12px; font-weight: 700; width: 100%; border-radius: 8px;" onclick="confirmLeaveParty(); startPlaybackStreamNow(true);">
                                🚪 Sair da Sala e Assistir Sozinho
                            </button>
                        </div>
                    `;
                }
            }

            overlay.classList.add('visible');
        }

        function hidePartyReadyOverlay() {
            const overlay = document.getElementById('party-ready-overlay');
            if (overlay) overlay.classList.remove('visible');
        }

        function startPartyPlaybackNow() {
            isPartyPlaybackActive = true;
            hidePartyReadyOverlay();
            hidePlaybackPosterOverlay();
            startPlaybackStreamNow(true);
            const video = document.getElementById('html5-video-player');
            if (video) {
                video.play().catch(() => { });
            }
            if (currentPartyRoom && partyIsHost) {
                sendPartyAction('play', video?.currentTime || 0);
            }
        }

        /* ── Botão Header & Modal de Criação / Entrada ───────────────────── */

        function onPartyHeaderBtnClick() {
            if (currentPartyRoom) {
                togglePartyPanel();
            } else {
                const modal = document.getElementById('party-join-modal');
                if (modal) {
                    const nickInput = document.getElementById('party-join-nickname-input');
                    if (nickInput) nickInput.value = getDefaultUserNickname();

                    const previewBox = document.getElementById('party-modal-media-preview');
                    const previewTitle = document.getElementById('party-modal-media-title');

                    const isVideoPlaying = (document.getElementById('tab-playback-page')?.classList.contains('active') || currentPlayingMedia);
                    const isDetailActive = document.getElementById('tab-media-detail')?.classList.contains('active') && currentDetailMedia;

                    let targetMedia = null;
                    if (isVideoPlaying && currentPlayingMedia) {
                        targetMedia = currentPlayingMedia.title + (currentPlayingMedia.sub ? ' (' + currentPlayingMedia.sub + ')' : '');
                    } else if (isDetailActive) {
                        targetMedia = currentDetailMedia.nome;
                    }

                    if (targetMedia && previewBox && previewTitle) {
                        previewTitle.innerText = targetMedia;
                        previewBox.style.display = 'block';
                    } else if (previewBox) {
                        previewBox.style.display = 'none';
                    }

                    switchPartyModalTab('create');
                    modal.classList.add('active');
                }
            }
        }

        function switchPartyModalTab(tab) {
            const btnCreate = document.getElementById('btn-tab-party-create');
            const btnJoin = document.getElementById('btn-tab-party-join');
            const viewCreate = document.getElementById('party-modal-create-content');
            const viewJoin = document.getElementById('party-modal-join-content');

            if (tab === 'create') {
                if (btnCreate) btnCreate.classList.add('active');
                if (btnJoin) btnJoin.classList.remove('active');
                if (viewCreate) viewCreate.style.display = 'block';
                if (viewJoin) viewJoin.style.display = 'none';
            } else {
                if (btnCreate) btnCreate.classList.remove('active');
                if (btnJoin) btnJoin.classList.add('active');
                if (viewCreate) viewCreate.style.display = 'none';
                if (viewJoin) viewJoin.style.display = 'block';
            }
        }

        function closePartyJoinModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'party-join-modal')) return;
            const modal = document.getElementById('party-join-modal');
            if (modal) modal.classList.remove('active');
        }

        async function createWatchPartyFromHeaderModal() {
            const nickInput = document.getElementById('party-join-nickname-input');
            const nick = (nickInput?.value || '').trim() || getDefaultUserNickname();
            localStorage.setItem('bf_party_name', nick);

            const isVideoPlaying = (document.getElementById('tab-playback-page')?.classList.contains('active') || currentPlayingMedia);
            const isDetailActive = document.getElementById('tab-media-detail')?.classList.contains('active') && currentDetailMedia;

            if (isVideoPlaying) {
                partyPendingMedia = {
                    id: currentPlayingMedia.id,
                    type: currentPlayingMedia.type,
                    title: currentPlayingMedia.title,
                    seasonNum: currentPlayingMedia.season || 1,
                    epNum: currentPlayingMedia.episode || 1,
                    isDublado: currentPlayingMedia.audio?.includes('dublado') || false
                };
            } else if (isDetailActive) {
                partyPendingMedia = {
                    id: currentDetailMedia.id,
                    type: currentDetailMedia.tipo || (currentDetailMedia.temporadas ? 'serie' : 'filme'),
                    title: currentDetailMedia.nome,
                    seasonNum: 1,
                    epNum: 1,
                    isDublado: currentDetailMedia.isDublado || false
                };
            } else {
                partyPendingMedia = null;
            }

            const modal = document.getElementById('party-join-modal');
            if (modal) modal.classList.remove('active');

            await executeCreateWatchParty();
        }

        async function joinViaHeaderModal() {
            const nickInput = document.getElementById('party-join-nickname-input');
            const nick = (nickInput?.value || '').trim() || getDefaultUserNickname();
            localStorage.setItem('bf_party_name', nick);

            const input = document.getElementById('party-join-code-input');
            let code = (input?.value || '').trim().toUpperCase();
            if (!code) { showToast('Digite o código da sala.', 'error'); return; }

            const modal = document.getElementById('party-join-modal');
            if (modal) modal.classList.remove('active');
            await joinWatchPartyByCode(code);
        }

        /* ── Criar Sala ──────────────────────────────────────────────────── */

        function startWatchPartyForMedia(mediaId, type, seasonNum = 1, epNum = 1) {
            const item = (type === 'serie') ?
                (fullCatalog.series || []).find(s => String(s.id) === String(mediaId)) :
                (fullCatalog.filmes || []).find(f => String(f.id) === String(mediaId));
            if (!item) { showToast('Mídia não encontrada.', 'error'); return; }

            partyPendingMedia = {
                id: item.id, type, title: item.nome,
                seasonNum, epNum, isDublado: item.isDublado
            };

            const modal = document.getElementById('watch-party-modal');
            const createView = document.getElementById('party-create-view');
            const activeView = document.getElementById('party-active-view');
            const nameInput = document.getElementById('party-host-name-input');
            if (modal) {
                if (createView) createView.style.display = 'block';
                if (activeView) activeView.style.display = 'none';
                if (nameInput) nameInput.value = getDefaultUserNickname();
                modal.classList.add('active');
            } else {
                executeCreateWatchParty();
            }
        }

        function toggleWatchPartyModal() {
            if (currentPartyRoom) { togglePartyPanel(); return; }
            if (currentPlayingMedia) {
                startWatchPartyForMedia(currentPlayingMedia.id, currentPlayingMedia.type, currentPlayingMedia.season || 1, currentPlayingMedia.episode || 1);
            } else {
                onPartyHeaderBtnClick();
            }
        }

        function closeWatchPartyModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'watch-party-modal')) return;
            const modal = document.getElementById('watch-party-modal');
            if (modal) modal.classList.remove('active');
        }

        async function executeCreateWatchParty() {
            const nameInput = document.getElementById('party-host-name-input');
            const hostName = (nameInput?.value || localStorage.getItem('bf_party_name') || getDefaultUserNickname()).trim();
            localStorage.setItem('bf_party_name', hostName);
            const token = getUserStreamingToken();

            let streamUrl = '', subTitle = '', mediaInfoObj = null;

            if (partyPendingMedia?.type === 'serie') {
                const audio = partyPendingMedia.isDublado ? 'dublado' : 'legendado';
                streamUrl = '/stream/video/' + token + '/serie/' + partyPendingMedia.id + '/' + partyPendingMedia.seasonNum + '/' + partyPendingMedia.epNum + '/' + audio;
                subTitle = 'T' + partyPendingMedia.seasonNum + 'E' + partyPendingMedia.epNum + ' • ' + partyPendingMedia.title;
                mediaInfoObj = { type: 'serie', id: partyPendingMedia.id, season: partyPendingMedia.seasonNum, episode: partyPendingMedia.epNum, audio, title: partyPendingMedia.title, sub: subTitle, streamUrl };
            } else if (partyPendingMedia?.type === 'filme') {
                const audio = partyPendingMedia.isDublado ? 'dublado' : 'legendado';
                streamUrl = '/stream/video/' + token + '/filme/' + partyPendingMedia.id + '/' + audio;
                subTitle = 'Filme • ' + partyPendingMedia.title;
                mediaInfoObj = { type: 'filme', id: partyPendingMedia.id, audio, title: partyPendingMedia.title, sub: subTitle, streamUrl };
            } else if (currentPlayingMedia && currentPlayingMedia.streamUrl) {
                streamUrl = currentPlayingMedia.streamUrl;
                subTitle = currentPlayingMedia.sub;
                mediaInfoObj = { ...currentPlayingMedia };
            }

            try {
                const res = await fetch('/api/party/create', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        title: mediaInfoObj?.title || 'BrasilFlix Lobby',
                        sub: subTitle || '',
                        streamUrl: streamUrl || null,
                        mediaInfo: mediaInfoObj,
                        hostName,
                        token,
                        hostUserId: partyMyUserId
                    })
                });
                const data = await res.json();
                if (!res.ok || !data.success) { showToast(data.error || 'Erro ao criar sala.', 'error'); return; }

                currentPartyRoom = data.roomCode;
                partyRoomData = data;
                partyIsHost = true;

                const modal1 = document.getElementById('watch-party-modal');
                if (modal1) modal1.classList.remove('active');
                const modal2 = document.getElementById('party-join-modal');
                if (modal2) modal2.classList.remove('active');

                connectToPartyEventSource(data.roomCode, hostName);
                updatePartyHeaderState();
                showPartyPanel(true);

                if (data.mediaInfo && (data.mediaInfo.streamUrl || data.mediaInfo.id)) {
                    const m = data.mediaInfo;
                    if (m.type === 'serie') {
                        openPlaybackPageForEpisode(m.id, m.season || 1, m.episode || 1, m.audio || 'dublado', true);
                    } else if (m.type === 'filme') {
                        openPlaybackPageForMovie(m.id, m.audio || 'dublado', true);
                    }
                } else {
                    showToast('🎉 Sala ' + data.roomCode + ' criada! Escolha um filme ou série.', 'success');
                }
            } catch (e) {
                showToast('Erro de conexão ao criar sala.', 'error');
            }
        }

        /* ── Entrar na Sala ──────────────────────────────────────────────── */

        async function joinWatchPartyByCode(roomCode) {
            try {
                const cleanCode = (roomCode || '').trim().toUpperCase();
                const res = await fetch('/api/party/room/' + encodeURIComponent(cleanCode));
                if (res.status === 429) {
                    const errData = await res.json().catch(() => ({}));
                    showToast(errData.error || 'Muitas tentativas. Aguarde 30s para tentar novamente.', 'error');
                    return;
                }
                if (!res.ok) {
                    localStorage.removeItem('bf_party_room');
                    try {
                        const cleanUrl = new URL(window.location.href);
                        cleanUrl.searchParams.delete('sala');
                        cleanUrl.searchParams.delete('party');
                        window.history.replaceState({}, document.title, cleanUrl.pathname + (cleanUrl.searchParams.toString() ? '?' + cleanUrl.searchParams.toString() : '') + cleanUrl.hash);
                    } catch (e) { }
                    showToast('Código incorreto ou sala não encontrada.', 'error');
                    return;
                }
                const data = await res.json();
                const room = data.room;
                if (!room) {
                    localStorage.removeItem('bf_party_room');
                    return;
                }

                let myName = localStorage.getItem('bf_party_name') || getDefaultUserNickname();
                currentPartyRoom = room.id;
                partyRoomData = room;
                partyIsHost = String(partyMyUserId) === String(room.hostId);

                connectToPartyEventSource(room.id, myName);
                updatePartyHeaderState();
                showPartyPanel(partyIsHost);
                showToast('👥 Você entrou na sala ' + room.id + '!', 'success');

                if (room.mediaInfo && (room.mediaInfo.streamUrl || room.mediaInfo.id)) {
                    const m = room.mediaInfo;
                    const isRemembered = localStorage.getItem('bf_audio_pref_remembered') === 'true';
                    const hasBoth = m.hasDub !== false && m.hasLeg !== false;

                    const startPlaybackForMember = (chosenAudio) => {
                        isSyncingFromRemote = true;
                        if (m.type === 'serie') {
                            openPlaybackPageForEpisode(m.id, m.season || 1, m.episode || 1, chosenAudio, true);
                        } else {
                            openPlaybackPageForMovie(m.id, chosenAudio, true);
                        }
                        isSyncingFromRemote = false;
                    };

                    const defaultAudio = isRemembered ? getUserPreferredAudio() : (m.audio || 'dublado');
                    startPlaybackForMember(defaultAudio);
                }
            } catch (e) {
                localStorage.removeItem('bf_party_room');
                showToast('Erro de conexão ao entrar na sala.', 'error');
            }
        }

        /* ── SSE ─────────────────────────────────────────────────────────── */

        function connectToPartyEventSource(roomCode, userName) {
            if (partyEventSource) partyEventSource.close();
            partyEventSource = new EventSource('/api/party/events/' + roomCode + '?userId=' + partyMyUserId + '&name=' + encodeURIComponent(userName));
            partyEventSource.onmessage = (e) => {
                try { handlePartyRemoteEvent(JSON.parse(e.data)); } catch (err) { }
            };
            partyEventSource.onerror = () => console.warn('[Party] SSE reconectando...');
        }

        function updatePartyPermissionCheckboxes() {
            const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };
            const pPause = document.getElementById('party-perm-pause');
            const pResume = document.getElementById('party-perm-resume');
            const pSeek = document.getElementById('party-perm-seek');
            const pMedia = document.getElementById('party-perm-change-media');
            const pSpeed = document.getElementById('party-perm-speed');

            if (pPause) pPause.checked = perms.canPause !== false;
            if (pResume) pResume.checked = !!perms.canResume;
            if (pSeek) pSeek.checked = !!perms.canSeek;
            if (pMedia) pMedia.checked = !!perms.canChangeMedia;
            if (pSpeed) pSpeed.checked = !!perms.canChangeSpeed;
        }

        async function onPartyPermissionCheckboxChange() {
            if (!currentPartyRoom || !partyIsHost) return;
            const permissions = {
                canPause: document.getElementById('party-perm-pause')?.checked ?? true,
                canResume: document.getElementById('party-perm-resume')?.checked ?? false,
                canSeek: document.getElementById('party-perm-seek')?.checked ?? false,
                canChangeMedia: document.getElementById('party-perm-change-media')?.checked ?? false,
                canChangeSpeed: document.getElementById('party-perm-speed')?.checked ?? false
            };
            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'permissions', permissions })
                });
                showToast('👑 Permissões dos participantes atualizadas!', 'success');
            } catch (e) {
                showToast('Erro ao atualizar permissões.', 'error');
            }
        }

        function handlePartyRemoteEvent(data) {
            const video = document.getElementById('html5-video-player');

            if (data.type === 'init') {
                if (data.room) {
                    partyRoomData = data.room;
                    partyIsHost = String(partyMyUserId) === String(data.room.hostId);
                    if (data.room.wheelItems) partyWheelItems = data.room.wheelItems;
                    renderPartyPanelMembers(data.room.members || []);
                    renderPartyWheelList();
                    updatePartyPermissionCheckboxes();

                    if (video && typeof data.room.currentTime === 'number' && Math.abs(video.currentTime - data.room.currentTime) > 1.5) {
                        isSyncingFromRemote = true;
                        video.currentTime = data.room.currentTime;
                        if (data.room.isPlaying) {
                            isPartyPlaybackActive = true;
                            hidePlaybackPosterOverlay();
                            hidePartyReadyOverlay();
                            startPlaybackStreamNow(true);
                            video.play().catch(() => { });
                        } else {
                            video.pause();
                        }
                        setTimeout(() => isSyncingFromRemote = false, 300);
                    }
                }
            } else if (data.type === 'play') {
                isPartyPlaybackActive = true;
                hidePartyReadyOverlay();
                hidePlaybackPosterOverlay();
                if (partyRoomData) {
                    partyRoomData.isPlaying = true;
                    partyRoomData.lastStateChange = Date.now();
                    if (typeof data.currentTime === 'number') partyRoomData.currentTime = data.currentTime;
                }
                if (video && String(data.userId) !== String(partyMyUserId)) {
                    isSyncingFromRemote = true;
                    if (typeof data.currentTime === 'number' && Math.abs(video.currentTime - data.currentTime) > 1.5) {
                        video.currentTime = data.currentTime;
                    }
                    const startAt = Number(data.startPlaybackAt) || 0;
                    const delayMs = startAt > 0 ? (startAt - Date.now()) : 0;

                    if (delayMs > 0 && delayMs < 1200) {
                        setTimeout(() => {
                            startPlaybackStreamNow(true);
                            video.play().catch(() => { });
                            setTimeout(() => isSyncingFromRemote = false, 300);
                        }, delayMs);
                    } else {
                        startPlaybackStreamNow(true);
                        video.play().catch(() => { });
                        setTimeout(() => isSyncingFromRemote = false, 300);
                    }
                    showToast('▶️ ' + data.by + ' iniciou a reprodução', 'info');
                }
            } else if (data.type === 'pause') {
                if (partyRoomData) {
                    partyRoomData.isPlaying = false;
                    partyRoomData.lastStateChange = Date.now();
                    if (typeof data.currentTime === 'number') partyRoomData.currentTime = data.currentTime;
                }
                if (video && String(data.userId) !== String(partyMyUserId)) {
                    isSyncingFromRemote = true;
                    if (typeof data.currentTime === 'number' && Math.abs(video.currentTime - data.currentTime) > 1.5) {
                        video.currentTime = data.currentTime;
                    }
                    video.pause();
                    setTimeout(() => isSyncingFromRemote = false, 300);
                    showToast('⏸️ ' + data.by + ' pausou', 'info');
                }
            } else if (data.type === 'seek') {
                if (partyRoomData) {
                    partyRoomData.currentTime = data.currentTime;
                    partyRoomData.lastStateChange = Date.now();
                }
                if (video && String(data.userId) !== String(partyMyUserId)) {
                    isSyncingFromRemote = true;
                    video.currentTime = data.currentTime;
                    setTimeout(() => isSyncingFromRemote = false, 300);
                    showToast('⏩ ' + data.by + ' pulou para ' + formatTimeSeconds(data.currentTime), 'info');
                }
            } else if (data.type === 'permissions_changed') {
                if (data.permissions) {
                    partyRoomData = { ...partyRoomData, permissions: data.permissions, hostOnlyControls: data.hostOnlyControls };
                    updatePartyPermissionCheckboxes();
                    if (!partyIsHost) {
                        showToast('👑 As permissões da sala foram atualizadas pelo anfitrião.', 'info');
                    }
                }
            } else if (data.type === 'set_speed') {
                if (data.speed) {
                    if (video) video.playbackRate = data.speed;
                    const label = document.getElementById('player-speed-label');
                    if (label) label.innerText = `${data.speed}x`;
                    document.querySelectorAll('.speed-opt-btn').forEach(btn => {
                        btn.classList.toggle('active', btn.innerText.includes(`${data.speed}x`));
                    });
                    showToast(`⚡ Velocidade ajustada para ${data.speed}x por ${data.by}`, 'info');
                }
            } else if (data.type === 'media_stopped') {
                isPartyPlaybackActive = false;
                partyRoomData = { ...partyRoomData, mediaInfo: null, isPlaying: false, currentTime: 0, members: data.members || partyRoomData?.members };
                if (data.members) renderPartyPanelMembers(data.members);
                if (!partyIsHost) {
                    if (document.getElementById('tab-playback-page')?.classList.contains('active') || currentPlayingMedia) {
                        closeWebPlayer();
                        handlePlaybackBack();
                        showToast('🎬 O anfitrião saiu do player e retornou ao catálogo.', 'info');
                    }
                }
            } else if (data.type === 'change_media') {
                isPartyPlaybackActive = false;
                if (String(data.userId) !== String(partyMyUserId) && data.mediaInfo) {
                    partyRoomData = { ...partyRoomData, mediaInfo: data.mediaInfo, isPlaying: false, currentTime: 0 };
                    const m = data.mediaInfo;
                    const isRemembered = localStorage.getItem('bf_audio_pref_remembered') === 'true';
                    const hasBoth = m.hasDub !== false && m.hasLeg !== false;

                    const startPlaybackForMember = (chosenAudio) => {
                        isSyncingFromRemote = true;
                        if (m.type === 'serie') {
                            openPlaybackPageForEpisode(m.id, m.season || 1, m.episode || 1, chosenAudio, true);
                        } else {
                            openPlaybackPageForMovie(m.id, chosenAudio, true);
                        }
                        isSyncingFromRemote = false;
                        showToast('🎬 O anfitrião iniciou: ' + (m.title || 'nova mídia'), 'info');
                    };

                    const defaultAudio = isRemembered ? getUserPreferredAudio() : (m.audio || 'dublado');
                    startPlaybackForMember(defaultAudio);
                }
            } else if (data.type === 'member_ready_state_changed') {
                if (data.members) {
                    partyRoomData = { ...partyRoomData, members: data.members };
                    renderPartyPanelMembers(data.members);
                    if (document.getElementById('tab-playback-page')?.classList.contains('active') || currentPlayingMedia) {
                        showPartyReadyOverlay(partyIsHost);
                    }
                }
            } else if (data.type === 'host_transferred') {
                partyRoomData = { ...partyRoomData, hostId: data.newHostId, hostName: data.newHostName, members: data.members || partyRoomData?.members };
                partyIsHost = String(partyMyUserId) === String(data.newHostId);
                showPartyPanel(partyIsHost);
                renderPartyPanelMembers(data.members || partyRoomData.members);
                updatePartyHeaderState();
                updatePartyPermissionCheckboxes();

                if (partyIsHost) {
                    showToast('👑 Você agora é o novo anfitrião da sala!', 'success');
                } else {
                    showToast(`👑 ${data.newHostName} agora é o anfitrião da sala.`, 'info');
                }

                if (document.getElementById('tab-playback-page')?.classList.contains('active') || currentPlayingMedia) {
                    showPartyReadyOverlay(partyIsHost);
                }
            } else if (data.type === 'suggest_media') {
                if (data.suggestion) {
                    if (!partyWheelItems.some(i => String(i.id) === String(data.suggestion.id))) {
                        partyWheelItems.push(data.suggestion);
                    }
                    renderPartyWheelModal();
                    if (String(data.userId) !== String(partyMyUserId)) {
                        showToast('💡 ' + data.by + ' sugeriu: ' + data.suggestion.title, 'info');
                    }
                }
            } else if (data.type === 'remove_suggestion') {
                partyWheelItems = partyWheelItems.filter(item => item.id !== data.suggestionId);
                renderPartyWheelModal();
            } else if (data.type === 'spin_wheel') {
                if (data.winner) {
                    openPartyWheelModal();
                    runSlotMachineAnimation(data.winner, data.durationMs || 3500);
                }
            } else if (data.type === 'wheel_result') {
                if (data.winner && !partyWheelSpinning) {
                    showWheelResult(data.winner, String(data.userId) !== String(partyMyUserId));
                }
            } else if (data.type === 'room_closed') {
                showToast('🚪 O anfitrião encerrou a sala.', 'info');
                _doLeaveParty(false);
            } else if (data.type === 'kicked') {
                if (String(data.userId) === String(partyMyUserId)) {
                    showToast('⚠️ Você foi removido da sala pelo anfitrião.', 'error');
                    _doLeaveParty(false);
                }
            } else if (data.type === 'member_joined') {
                if (data.name && String(data.userId) !== String(partyMyUserId)) {
                    showToast('👋 ' + data.name + ' entrou na sala!', 'success');
                }
                if (data.members) {
                    partyRoomData = { ...partyRoomData, members: data.members };
                    renderPartyPanelMembers(data.members);
                    updatePartyHeaderState();
                }
            } else if (data.type === 'member_left') {
                if (data.name) showToast('🚪 ' + data.name + ' saiu da sala.', 'info');
                if (data.members) {
                    partyRoomData = { ...partyRoomData, members: data.members };
                    renderPartyPanelMembers(data.members);
                    updatePartyHeaderState();
                }
            }
        }

        async function sendPartyAction(action, payload) {
            if (!currentPartyRoom) return;
            try {
                let bodyObj = { userId: partyMyUserId, action, by: localStorage.getItem('bf_party_name') || getDefaultUserNickname() };
                if (typeof payload === 'number') {
                    bodyObj.currentTime = Math.floor(payload);
                } else if (typeof payload === 'object' && payload !== null) {
                    bodyObj = { ...bodyObj, ...payload };
                }
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(bodyObj)
                });
            } catch (e) { }
        }

        /* ── Sincronizar Mídia Nova ───────────────────────────────────────── */

        async function syncCurrentMediaToParty() {
            if (!currentPartyRoom || !currentPlayingMedia || !partyIsHost) return;
            const token = getUserStreamingToken();
            const mi = currentPlayingMedia;
            let mediaInfo = null;

            if (mi.type === 'serie') {
                mediaInfo = {
                    type: 'serie', id: mi.id, season: mi.season, episode: mi.episode, audio: mi.audio,
                    title: mi.title, sub: mi.sub, streamUrl: '/stream/video/' + token + '/serie/' + mi.id + '/' + mi.season + '/' + mi.episode + '/' + mi.audio
                };
            } else if (mi.type === 'filme') {
                mediaInfo = {
                    type: 'filme', id: mi.id, audio: mi.audio,
                    title: mi.title, sub: mi.sub, streamUrl: '/stream/video/' + token + '/filme/' + mi.id + '/' + mi.audio
                };
            }
            if (!mediaInfo) return;

            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'change_media', mediaInfo, by: localStorage.getItem('bf_party_name') || 'Anfitrião' })
                });
                showToast('✅ Mídia sincronizada com todos!', 'success');
                const syncBtn = document.getElementById('panel-sync-media-btn');
                if (syncBtn) syncBtn.style.display = 'none';
            } catch (e) { showToast('Erro ao sincronizar.', 'error'); }
        }

        function notifyHostMediaChanged() {
            // Agora a sincronização é automática via openWebPlayer → autoSyncMediaToParty
            // Esta função mantida como stub para compatibilidade
        }

        // Sincroniza a mídia atual com todos na sala (chamado automaticamente)
        async function autoSyncMediaToParty() {
            if (!currentPartyRoom || !partyIsHost || !currentPlayingMedia) return;
            const mi = currentPlayingMedia;
            const mediaInfo = {
                type: mi.type,
                id: mi.id,
                season: mi.season || 1,
                episode: mi.episode || 1,
                audio: mi.audio || 'dublado',
                hasDub: mi.hasDub !== false,
                hasLeg: mi.hasLeg !== false,
                title: mi.title,
                sub: mi.sub
            };

            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: partyMyUserId,
                        action: 'change_media',
                        mediaInfo,
                        by: localStorage.getItem('bf_party_name') || 'Anfitrião'
                    })
                });
            } catch (e) {
                console.warn('[Party] Erro ao auto-sincronizar mídia:', e);
            }
        }

        /* ── Fuzzy Search do Catálogo para a Roleta ───────────────────────── */

        function normalizeSearchStr(str) {
            return (str || '')
                .toLowerCase()
                .normalize('NFD')
                .replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9\s]/g, '')
                .trim();
        }

        function levenshteinDistance(s1, s2) {
            if (!s1 || !s2) return (s1 || '').length + (s2 || '').length;
            const a = s1.toLowerCase();
            const b = s2.toLowerCase();
            const m = a.length, n = b.length;
            const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
            for (let i = 0; i <= m; i++) dp[i][0] = i;
            for (let j = 0; j <= n; j++) dp[0][j] = j;
            for (let i = 1; i <= m; i++) {
                for (let j = 1; j <= n; j++) {
                    const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                    dp[i][j] = Math.min(
                        dp[i - 1][j] + 1,
                        dp[i][j - 1] + 1,
                        dp[i - 1][j - 1] + cost
                    );
                }
            }
            return dp[m][n];
        }

        function fuzzyCatalogSearch(query) {
            if (!query || !query.trim()) return [];
            const q = normalizeSearchStr(query);
            const tokens = q.split(/\s+/).filter(t => t.length > 0);

            const allItems = [
                ...(fullCatalog.series || []).map(s => ({ ...s, tipo: s.isAnime ? 'anime' : (s.isDorama ? 'dorama' : 'serie') })),
                ...(fullCatalog.filmes || []).map(f => ({ ...f, tipo: f.isAnime ? 'anime' : 'filme' }))
            ];

            const results = [];

            for (const item of allItems) {
                const titleNorm = normalizeSearchStr(item.nome || '');
                const origNorm = normalizeSearchStr(item.nomeOriginal || '');

                let score = 0;

                // Match exato / substring direta
                if (titleNorm.includes(q) || origNorm.includes(q)) {
                    score += 120;
                }

                // Match de tokens com tolerância a erros (ex: "te ruquie" -> "the rookie")
                let tokenHits = 0;
                for (const t of tokens) {
                    if (titleNorm.includes(t) || origNorm.includes(t)) {
                        tokenHits += 1;
                    } else {
                        const words = titleNorm.split(/\s+/);
                        for (const w of words) {
                            const dist = levenshteinDistance(t, w);
                            if (dist <= 2 || (t.length >= 4 && w.length >= 4 && (w.startsWith(t.substring(0, 3)) || t.startsWith(w.substring(0, 3))))) {
                                tokenHits += 0.85;
                                break;
                            }
                        }
                    }
                }

                if (tokenHits > 0) {
                    score += tokenHits * 35;
                }

                const lev = levenshteinDistance(q, titleNorm);
                if (lev <= 3) {
                    score += (25 - lev * 5);
                }

                if (score > 15) {
                    results.push({ item, score });
                }
            }

            results.sort((a, b) => b.score - a.score);
            return results.slice(0, 4).map(r => r.item);
        }

        function openPartyWheelModal() {
            if (!currentPartyRoom) { showToast('Entre em uma sala para acessar a roleta.', 'info'); return; }
            const modal = document.getElementById('party-wheel-modal');
            if (modal) {
                modal.classList.add('active');
                renderPartyWheelModal();
            }
        }

        function closePartyWheelModal(event) {
            if (event && !isSafeModalBackdropClick(event, 'party-wheel-modal')) return;
            const modal = document.getElementById('party-wheel-modal');
            if (modal) modal.classList.remove('active');
            const dropdown = document.getElementById('party-suggest-fuzzy-dropdown');
            if (dropdown) dropdown.style.display = 'none';
        }

        function onPartySuggestInputChange(val) {
            const dropdown = document.getElementById('party-suggest-fuzzy-dropdown');
            if (!dropdown) return;
            if (!val || val.trim().length < 2) {
                dropdown.style.display = 'none';
                dropdown.innerHTML = '';
                return;
            }

            const matches = fuzzyCatalogSearch(val);
            if (matches.length === 0) {
                dropdown.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-muted);text-align:center;">Nenhum título compatível no catálogo.</div>';
                dropdown.style.display = 'block';
                return;
            }

            dropdown.innerHTML = matches.map(item => {
                const poster = item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=80';
                const tipoBadge = item.tipo === 'serie' ? '📺 Série' : (item.tipo === 'dorama' ? '🌸 Dorama' : (item.tipo === 'anime' ? '⛩️ Anime' : '🎬 Filme'));
                const anoStr = item.ano ? `(${item.ano})` : '';
                return `
                    <div class="party-fuzzy-item" onclick="selectFuzzySuggestion('${item.id}', '${item.tipo}')">
                        <img src="${poster}" alt="${escapeHtml(item.nome)}" onerror="this.src='https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=80'">
                        <div style="flex:1;overflow:hidden;">
                            <div style="font-size:13px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                                ${escapeHtml(item.nome)} <span style="font-size:11px;color:var(--text-muted);">${anoStr}</span>
                            </div>
                            <div style="font-size:10px;color:#38bdf8;font-weight:700;margin-top:2px;">${tipoBadge}</div>
                        </div>
                        <button class="btn-modal btn-modal-primary" style="padding:5px 10px;font-size:11px;white-space:nowrap;">+ Sugerir</button>
                    </div>
                `;
            }).join('');
            dropdown.style.display = 'block';
        }

        async function selectFuzzySuggestion(mediaId, tipo) {
            const dropdown = document.getElementById('party-suggest-fuzzy-dropdown');
            const input = document.getElementById('party-suggest-input');
            if (dropdown) dropdown.style.display = 'none';
            if (input) input.value = '';

            const allItems = [
                ...(fullCatalog.series || []).map(s => ({ ...s, tipo: 'serie' })),
                ...(fullCatalog.filmes || []).map(f => ({ ...f, tipo: 'filme' }))
            ];
            const item = allItems.find(i => String(i.id) === String(mediaId));
            if (!item) return;

            if (partyWheelItems.some(w => String(w.mediaId) === String(mediaId))) {
                showToast('Este título já está na roleta!', 'info');
                return;
            }

            const suggestion = {
                id: Date.now() + '_' + partyMyUserId,
                mediaId: item.id,
                title: item.nome,
                posterUrl: item.posterUrl || null,
                tipo: item.tipo,
                isDublado: item.isDublado ?? true,
                by: localStorage.getItem('bf_party_name') || getDefaultUserNickname(),
                byId: partyMyUserId
            };

            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'suggest_media', suggestion, by: suggestion.by })
                });
                showToast('💡 Adicionado à roleta: ' + item.nome, 'success');
            } catch (e) {
                showToast('Erro ao enviar sugestão.', 'error');
            }
        }

        function addFirstFuzzyMatch() {
            const input = document.getElementById('party-suggest-input');
            const val = input?.value || '';
            const matches = fuzzyCatalogSearch(val);
            if (matches.length > 0) {
                selectFuzzySuggestion(matches[0].id, matches[0].tipo);
            } else {
                showToast('Digite e selecione um título válido do catálogo.', 'error');
            }
        }

        async function removeSuggestion(suggestionId) {
            if (!currentPartyRoom) return;
            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'remove_suggestion', suggestionId })
                });
            } catch (e) { }
        }

        function renderPartyWheelModal() {
            const list = document.getElementById('party-wheel-list');
            const countBadge = document.getElementById('party-wheel-items-count');
            const spinBtn = document.getElementById('party-spin-btn');
            const summary = document.getElementById('panel-wheel-summary');

            if (countBadge) countBadge.innerText = partyWheelItems.length;
            if (summary) summary.innerText = `${partyWheelItems.length} sugestão${partyWheelItems.length !== 1 ? 'ões' : ''} adicionada${partyWheelItems.length !== 1 ? 's' : ''}`;

            if (spinBtn) {
                if (!partyIsHost) {
                    spinBtn.disabled = true;
                    spinBtn.innerText = '🔒 Aguardando o anfitrião girar a roleta';
                } else if (partyWheelItems.length < 2) {
                    spinBtn.disabled = true;
                    spinBtn.innerText = '🎰 Adicione pelo menos 2 títulos para girar';
                } else {
                    spinBtn.disabled = partyWheelSpinning;
                    spinBtn.innerText = '🎰 Girar a Roleta da Sorte';
                }
            }

            if (!list) return;

            if (partyWheelItems.length === 0) {
                list.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:24px 10px;">Nenhuma sugestão adicionada ainda. Busque e adicione acima!</div>';
            } else {
                list.innerHTML = partyWheelItems.map((item) => {
                    const isOwner = String(item.byId) === String(partyMyUserId);
                    const canRemove = isOwner || partyIsHost;
                    const poster = item.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=100&q=80';
                    return `
                        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;">
                            <img src="${poster}" style="width:28px;height:40px;object-fit:cover;border-radius:4px;flex-shrink:0;" alt="${escapeHtml(item.title)}">
                            <div style="flex:1;overflow:hidden;">
                                <div style="font-size:12px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.title)}</div>
                                <div style="font-size:10px;color:var(--text-muted);">sugerido por <span style="color:#c084fc;font-weight:700;">${escapeHtml(item.by)}</span></div>
                            </div>
                            ${canRemove ? `<button onclick="removeSuggestion('${item.id}')" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#f87171;cursor:pointer;font-size:11px;padding:4px 8px;border-radius:6px;" title="Remover">✕</button>` : ''}
                        </div>
                    `;
                }).join('');
            }
        }

        const renderPartyWheelList = renderPartyWheelModal;

        async function spinTheWheel() {
            if (!currentPartyRoom || !partyIsHost) return;
            if (partyWheelItems.length < 2) {
                showToast('Adicione pelo menos 2 sugestões para sortear!', 'error');
                return;
            }
            if (partyWheelSpinning) return;

            const winner = partyWheelItems[Math.floor(Math.random() * partyWheelItems.length)];
            const durationMs = 3600;

            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'spin_wheel', winner, durationMs })
                });
            } catch (e) {
                runSlotMachineAnimation(winner, durationMs);
            }
        }

        function runSlotMachineAnimation(winner, durationMs = 3600) {
            if (partyWheelSpinning) return;
            partyWheelSpinning = true;

            const placeholder = document.getElementById('party-slot-placeholder');
            const content = document.getElementById('party-slot-content');
            const img = document.getElementById('party-slot-img');
            const titleEl = document.getElementById('party-slot-title');
            const byEl = document.getElementById('party-slot-by');
            const badgeEl = document.getElementById('party-slot-badge');
            const backdrop = document.getElementById('party-slot-backdrop');
            const slotCard = document.getElementById('party-slot-card');
            const spinBtn = document.getElementById('party-spin-btn');
            const watchBtn = document.getElementById('party-watch-winner-btn');

            if (placeholder) placeholder.style.display = 'none';
            if (content) content.style.display = 'flex';
            if (watchBtn) watchBtn.style.display = 'none';
            if (badgeEl) badgeEl.innerText = '🎰 Sorteando...';
            if (spinBtn) spinBtn.disabled = true;

            const items = partyWheelItems.length > 0 ? partyWheelItems : [winner];
            let startTime = Date.now();
            let currentDelay = 50;

            function tick() {
                const elapsed = Date.now() - startTime;
                const progress = Math.min(1, elapsed / durationMs);

                const rndItem = items[Math.floor(Math.random() * items.length)];
                const poster = rndItem.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=80';

                if (img) img.src = poster;
                if (titleEl) titleEl.innerText = rndItem.title;
                if (byEl) byEl.innerText = 'sugerido por ' + rndItem.by;
                if (backdrop) {
                    backdrop.style.backgroundImage = `url('${poster}')`;
                    backdrop.style.opacity = '0.9';
                }

                if (slotCard) {
                    slotCard.style.transform = 'translateY(-3px)';
                    setTimeout(() => { if (slotCard) slotCard.style.transform = ''; }, currentDelay / 2);
                }

                if (progress < 1) {
                    currentDelay = 50 + Math.pow(progress, 2.5) * 270;
                    setTimeout(tick, currentDelay);
                } else {
                    finishWinner();
                }
            }

            function finishWinner() {
                const winnerPoster = winner.posterUrl || 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=200&q=80';
                if (img) img.src = winnerPoster;
                if (titleEl) titleEl.innerText = winner.title;
                if (byEl) byEl.innerText = 'sugerido por ' + winner.by;
                if (badgeEl) badgeEl.innerText = '🏆 Vencedor da Roleta!';
                if (backdrop) {
                    backdrop.style.backgroundImage = `url('${winnerPoster}')`;
                    backdrop.style.opacity = '1';
                }

                if (slotCard) {
                    slotCard.style.borderColor = 'rgba(251, 191, 36, 0.6)';
                    slotCard.style.boxShadow = '0 0 30px rgba(251, 191, 36, 0.35)';
                    slotCard.style.transform = 'scale(1.03)';
                    setTimeout(() => { if (slotCard) slotCard.style.transform = 'scale(1)'; }, 300);
                }

                if (watchBtn) {
                    watchBtn.style.display = partyIsHost ? 'block' : 'none';
                    watchBtn.dataset.title = winner.title;
                    watchBtn.dataset.mediaId = winner.mediaId || '';
                    watchBtn.dataset.mediaType = winner.tipo || '';
                }

                partyWheelSpinning = false;
                renderPartyWheelModal();
                showToast('🎉 Vencedor: ' + winner.title, 'success');
            }

            tick();
        }

        function showWheelResult(winner, fromRemote) {
            runSlotMachineAnimation(winner, fromRemote ? 2000 : 3600);
        }

        function watchWheelWinner() {
            const btn = document.getElementById('party-watch-winner-btn');
            const mediaId = btn?.dataset?.mediaId;
            const mediaType = btn?.dataset?.mediaType;
            const title = btn?.dataset?.title;

            closePartyWheelModal();

            const allMedia = [...(fullCatalog.filmes || []), ...(fullCatalog.series || [])];
            let found = null;
            if (mediaId) {
                found = allMedia.find(m => String(m.id) === String(mediaId));
            }
            if (!found && title) {
                found = allMedia.find(m => m.nome && m.nome.toLowerCase() === title.toLowerCase()) || allMedia.find(m => m.nome && m.nome.toLowerCase().includes(title.toLowerCase()));
            }

            if (found) {
                const tipo = found.tipo || mediaType || (fullCatalog.filmes.some(f => String(f.id) === String(found.id)) ? 'filme' : 'serie');
                if (tipo === 'serie') {
                    openWebPlayerEpisode(found.id, 1, 1, found.isDublado ? 'dublado' : 'legendado');
                } else {
                    openWebPlayerForMovie(found.id);
                }
                showToast(`🎬 Iniciando reprodução de "${found.nome}" com o grupo!`, 'success');
            } else {
                showToast('Mídia não encontrada no catálogo.', 'error');
            }
        }

        function openWebPlayerForParty(item, tipo) {
            if (tipo === 'filme') {
                const audio = item.isDublado ? 'dublado' : 'legendado';
                openPlaybackPageForMovie(item.id, audio, true);
            } else {
                const temp = item.temporadas?.[0];
                const ep = temp?.episodios?.[0];
                const sNum = temp ? temp.numero : 1;
                const eNum = ep ? ep.numero : 1;
                const audio = item.isDublado ? 'dublado' : 'legendado';
                openPlaybackPageForEpisode(item.id, sNum, eNum, audio, true);
            }
        }

        /* ── Overlay de Sincronização ────────────────────────────────────────── */

        function showPartySyncOverlay(msg) {
            const overlay = document.getElementById('party-sync-overlay');
            const msgEl = document.getElementById('party-sync-overlay-msg');
            if (msgEl) msgEl.innerText = msg || 'O anfitrião selecionou um novo conteúdo.\nAguarde um instante.';
            if (overlay) overlay.classList.add('active');
        }

        function hidePartySyncOverlay() {
            const overlay = document.getElementById('party-sync-overlay');
            if (overlay) overlay.classList.remove('active');
        }

        function safeImageUrl(value) {
            try {
                const url = new URL(value, location.origin);
                if (url.protocol === 'https:' || url.origin === location.origin) return escapeHtml(url.href);
            } catch {}
            return '';
        }

        function escapeHtml(str) {
            if (!str) return '';
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function escapeJsStr(str) {
            if (!str) return '';
            return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
        }

        /* ── Fechar Sala (Host) ───────────────────────────────────────────── */

        async function hostCloseRoom() {
            if (!currentPartyRoom || !partyIsHost) return;
            if (!confirm('Encerrar a sala para todos? Os membros serão desconectados.')) return;
            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'close_room' })
                });
            } catch (e) { }
            _doLeaveParty(true);
        }

        /* ── Sair da Sala ────────────────────────────────────────────────── */

        function confirmLeaveParty() {
            if (!currentPartyRoom) return;
            if (!confirm('Tem certeza que deseja sair da sala "' + currentPartyRoom + '"?\n\nOs outros membros continuarão assistindo.')) return;
            leaveWatchPartyRoom();
        }

        function leaveWatchPartyRoom() { _doLeaveParty(true); }

        function _doLeaveParty(shouldNotify) {
            if (partyEventSource) { partyEventSource.close(); partyEventSource = null; }
            const wasRoom = currentPartyRoom;
            currentPartyRoom = null;
            partyRoomData = null;
            partyIsHost = false;
            partyWheelItems = [];
            localStorage.removeItem('bf_party_room');

            const panel = document.getElementById('party-floating-panel');
            if (panel) panel.classList.remove('visible');
            partyPanelVisible = false;

            const modal = document.getElementById('watch-party-modal');
            if (modal) modal.classList.remove('active');

            updatePartyHeaderState();
            if (shouldNotify && wasRoom) showToast('Você saiu da sala de Assistir Junto.', 'info');
        }

        /* ── Compatibilidade: setupActivePartyView ────────────────────────── */

        function setupActivePartyView(roomCode, hostName, isHost) {
            currentPartyRoom = roomCode;
            partyIsHost = isHost;
            updatePartyHeaderState();
            showPartyPanel(isHost);
        }

        function renderPartyMembersList(members) { renderPartyPanelMembers(members); }

        function renderPartyPanelMembers(members) {
            const list = document.getElementById('panel-members-list');
            const countBadge = document.getElementById('panel-members-count-badge');
            const headerBadge = document.getElementById('party-member-badge');
            if (countBadge) countBadge.innerText = members.length;
            if (headerBadge) headerBadge.innerText = members.length;

            if (!list) return;
            list.innerHTML = members.map(m => {
                const isMe = String(m.id) === String(partyMyUserId);
                const canManage = partyIsHost && !isMe;

                const isInPlayer = isMe ? (!!currentPlayingMedia || (document.getElementById('tab-playback-page')?.classList.contains('active')) || !!m.inPlayer) : !!m.inPlayer;
                const isReady = isMe ? isInPlayer : !!m.isReady;

                let inPlayerState = '⏳ No Lobby';
                let statusBadgeStyle = 'background:rgba(255,255,255,0.06);color:var(--text-muted);border:1px solid rgba(255,255,255,0.1);';
                let dotColor = 'background:rgba(255,255,255,0.2);';

                if (m.connectionState === 'disconnected') {
                    inPlayerState = '🔌 Desconectado';
                    statusBadgeStyle = 'background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);';
                    dotColor = 'background:#ef4444;box-shadow:0 0 6px #ef4444;';
                } else if (m.isLoading) {
                    inPlayerState = '⏳ Carregando...';
                    statusBadgeStyle = 'background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);';
                    dotColor = 'background:#f59e0b;box-shadow:0 0 6px #f59e0b;';
                } else if (isInPlayer && isReady) {
                    inPlayerState = '✅ Player Pronto';
                    statusBadgeStyle = 'background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);';
                    dotColor = 'background:#10b981;box-shadow:0 0 8px #10b981;';
                } else if (isInPlayer) {
                    inPlayerState = '🎬 No Player';
                    statusBadgeStyle = 'background:rgba(56,189,248,0.15);color:#38bdf8;border:1px solid rgba(56,189,248,0.3);';
                    dotColor = 'background:#38bdf8;box-shadow:0 0 6px #38bdf8;';
                }

                return `<div class="party-member-item" style="position:relative;display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.03);margin-bottom:6px;border:1px solid rgba(255,255,255,0.06);">
                    <div class="party-member-left" style="display:flex;align-items:center;gap:10px;min-width:0;flex:1;">
                        <span class="party-member-dot" style="${dotColor}"></span>
                        <div style="min-width:0;flex:1;">
                            <div class="party-member-name" style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(m.name)}">
                                ${escapeHtml(m.name)}${isMe ? ' <span class="party-member-you" style="color:#38bdf8;font-size:11px;">(você)</span>' : ''}
                            </div>
                            <div style="font-size:10px;margin-top:2px;">
                                <span style="display:inline-block;padding:1px 6px;border-radius:4px;font-weight:700;font-size:9px;${statusBadgeStyle}">${inPlayerState}</span>
                                ${m.audio ? `<span style="display:inline-block;padding:1px 5px;margin-left:4px;border-radius:4px;font-weight:700;font-size:8.5px;background:rgba(168,85,247,0.15);color:#c084fc;border:1px solid rgba(168,85,247,0.3);">${m.audio === 'dublado' ? '🔊 DUB' : '💬 LEG'}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex;gap:6px;align-items:center;margin-left:8px;">
                        ${m.isHost ? '<span class="party-host-badge" style="background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid rgba(251,191,36,0.35);padding:2px 7px;border-radius:6px;font-size:10px;font-weight:800;white-space:nowrap;">👑 Anfitrião</span>' : ''}
                        ${canManage ? `
                            <div style="position:relative;">
                                <button type="button" onclick="toggleMemberActionDropdown('${m.id}', event)" class="btn-member-action-menu" style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#cbd5e1;width:28px;height:28px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:15px;font-weight:900;transition:all 0.15s;" title="Mais opções">
                                    ⋮
                                </button>
                                <div id="member-dropdown-${m.id}" class="member-action-dropdown-menu" style="display:none;position:absolute;right:0;top:32px;background:rgba(15,23,42,0.98);border:1px solid rgba(255,255,255,0.15);border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,0.6);z-index:9999;min-width:170px;padding:4px;backdrop-filter:blur(12px);">
                                    <button type="button" onclick="transferPartyHost('${m.id}','${escapeHtml(m.name)}'); closeAllMemberDropdowns();" style="width:100%;display:flex;align-items:center;gap:8px;padding:8px 10px;background:transparent;border:none;color:#fbbf24;font-size:11px;font-weight:700;border-radius:6px;cursor:pointer;text-align:left;transition:background 0.15s;" onmouseover="this.style.background='rgba(251,191,36,0.12)'" onmouseout="this.style.background='transparent'">
                                        <span>👑</span> <span>Passar Anfitrião</span>
                                    </button>
                                    <div style="height:1px;background:rgba(255,255,255,0.08);margin:2px 0;"></div>
                                    <button type="button" onclick="kickPartyMember('${m.id}','${escapeHtml(m.name)}'); closeAllMemberDropdowns();" style="width:100%;display:flex;align-items:center;gap:8px;padding:8px 10px;background:transparent;border:none;color:#f87171;font-size:11px;font-weight:700;border-radius:6px;cursor:pointer;text-align:left;transition:background 0.15s;" onmouseover="this.style.background='rgba(239,68,68,0.12)'" onmouseout="this.style.background='transparent'">
                                        <span>✕</span> <span>Remover da Sala</span>
                                    </button>
                                </div>
                            </div>
                        ` : ''}
                    </div>
                </div>`;
            }).join('');

            const statusText = document.getElementById('party-status-bar-text');
            if (statusText && currentPartyRoom) {
                statusText.innerText = '👥 Assistindo Junto · Sala ' + currentPartyRoom + ' · ' + members.length + ' membro' + (members.length !== 1 ? 's' : '') + ' — clique para gerenciar';
            }
        }

        function setupPlayerKeyboardShortcuts() {
            if (window._playerShortcutsInitialized) return;
            window._playerShortcutsInitialized = true;

            // useCapture = true: Intercepta no início da fase de captura, evitando conflito com o controle nativo do navegador
            window.addEventListener('keydown', (e) => {
                const tag = (e.target.tagName || '').toUpperCase();
                if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
                if (document.querySelector('.modal-backdrop.active')) return;

                const isPlayerActive = document.getElementById('tab-playback-page')?.classList.contains('active') || !!currentPlayingMedia;
                if (!isPlayerActive) return;

                const video = document.getElementById('html5-video-player');
                if (!video) return;

                const perms = partyRoomData?.permissions || { canPause: true, canResume: false, canSeek: false, canChangeMedia: false, canChangeSpeed: false };

                switch (e.key) {
                    case ' ':
                    case 'k':
                    case 'K':
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                        // Desfoca qualquer botão ou elemento focado para evitar que o navegador dispare clique duplo no Space
                        if (document.activeElement && document.activeElement !== document.body && tag !== 'BODY') {
                            try { document.activeElement.blur(); } catch (_) { }
                        }
                        if (video.paused) {
                            if (currentPartyRoom && !partyIsHost && !perms.canResume) {
                                showToast('⚠️ Apenas o anfitrião pode iniciar ou retomar a reprodução.', 'info');
                                return;
                            }
                            video.play().catch(() => { });
                        } else {
                            if (currentPartyRoom && !partyIsHost && !perms.canPause) {
                                showToast('⚠️ O anfitrião não permitiu pausar a reprodução.', 'info');
                                return;
                            }
                            video.pause();
                        }
                        break;

                    case 'f':
                    case 'F':
                        e.preventDefault();
                        e.stopPropagation();
                        togglePlayerFullscreen();
                        break;

                    case 'p':
                    case 'P':
                    case 'i':
                    case 'I':
                        e.preventDefault();
                        e.stopPropagation();
                        togglePictureInPicture();
                        break;

                    case 'ArrowLeft':
                    case 'j':
                    case 'J':
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                        if (document.activeElement && document.activeElement !== document.body && tag !== 'BODY') {
                            try { document.activeElement.blur(); } catch (_) { }
                        }
                        if (currentPartyRoom && !partyIsHost && !perms.canSeek) {
                            showToast('⚠️ Apenas o anfitrião pode avançar ou retroceder o vídeo.', 'info');
                            return;
                        }
                        video.currentTime = Math.max(0, video.currentTime - 10);
                        break;

                    case 'ArrowRight':
                    case 'l':
                    case 'L':
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                        if (document.activeElement && document.activeElement !== document.body && tag !== 'BODY') {
                            try { document.activeElement.blur(); } catch (_) { }
                        }
                        if (currentPartyRoom && !partyIsHost && !perms.canSeek) {
                            showToast('⚠️ Apenas o anfitrião pode avançar ou retroceder o vídeo.', 'info');
                            return;
                        }
                        video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
                        break;

                    case 'ArrowUp':
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                        if (document.activeElement && document.activeElement !== document.body && tag !== 'BODY') {
                            try { document.activeElement.blur(); } catch (_) { }
                        }
                        video.volume = Math.min(1, Math.round((video.volume + 0.1) * 10) / 10);
                        if (video.muted && video.volume > 0) video.muted = false;
                        showToast(`🔊 Volume: ${Math.round(video.volume * 100)}%`, 'info');
                        break;

                    case 'ArrowDown':
                        e.preventDefault();
                        e.stopPropagation();
                        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
                        if (document.activeElement && document.activeElement !== document.body && tag !== 'BODY') {
                            try { document.activeElement.blur(); } catch (_) { }
                        }
                        video.volume = Math.max(0, Math.round((video.volume - 0.1) * 10) / 10);
                        if (video.volume === 0) video.muted = true;
                        showToast(video.volume === 0 ? '🔇 Mudo' : `🔉 Volume: ${Math.round(video.volume * 100)}%`, 'info');
                        break;

                    case '<':
                    case ',':
                        e.preventDefault();
                        e.stopPropagation();
                        if (currentPartyRoom && !partyIsHost && !perms.canChangeSpeed) {
                            showToast('⚠️ Velocidade de reprodução sincronizada com o anfitrião.', 'info');
                            return;
                        }
                        const speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
                        const curIdx = speeds.indexOf(video.playbackRate);
                        if (curIdx > 0) setPlaybackSpeed(speeds[curIdx - 1]);
                        break;

                    case '>':
                    case '.':
                        e.preventDefault();
                        e.stopPropagation();
                        if (currentPartyRoom && !partyIsHost && !perms.canChangeSpeed) {
                            showToast('⚠️ Velocidade de reprodução sincronizada com o anfitrião.', 'info');
                            return;
                        }
                        const speedsUp = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
                        const curIdxUp = speedsUp.indexOf(video.playbackRate);
                        if (curIdxUp >= 0 && curIdxUp < speedsUp.length - 1) setPlaybackSpeed(speedsUp[curIdxUp + 1]);
                        break;

                    case 'm':
                    case 'M':
                        e.preventDefault();
                        e.stopPropagation();
                        video.muted = !video.muted;
                        showToast(video.muted ? '🔇 Mudo' : '🔊 Som Ativado', 'info');
                        break;
                }
            }, true);
        }
        setupPlayerKeyboardShortcuts();

        function closeAllMemberDropdowns() {
            document.querySelectorAll('.member-action-dropdown-menu').forEach(el => {
                el.style.display = 'none';
            });
        }

        function toggleMemberActionDropdown(memberId, event) {
            if (event) event.stopPropagation();
            const targetDropdown = document.getElementById('member-dropdown-' + memberId);
            const isCurrentlyOpen = targetDropdown && targetDropdown.style.display === 'block';
            closeAllMemberDropdowns();
            if (targetDropdown && !isCurrentlyOpen) {
                targetDropdown.style.display = 'block';
            }
        }

        function closeAllPlayerDropdowns() {
            const audioMenu = document.getElementById('player-audio-menu');
            const speedMenu = document.getElementById('player-speed-menu');
            if (audioMenu) audioMenu.classList.remove('visible');
            if (speedMenu) speedMenu.classList.remove('visible');
        }

        window.addEventListener('click', () => {
            closeAllMemberDropdowns();
            closeAllPlayerDropdowns();
        });

        async function transferPartyHost(newHostId, newHostName) {
            if (!currentPartyRoom || !partyIsHost) return;
            if (!confirm(`Deseja transferir a liderança da sala para "${newHostName}"?\n\nEle(a) terá o controle total sobre a reprodução e seleção de mídias para todo o grupo.`)) return;

            try {
                const res = await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: partyMyUserId,
                        action: 'transfer_host',
                        targetId: newHostId
                    })
                });
                if (res.ok) {
                    showToast(`👑 Liderança transferida com sucesso para ${newHostName}!`, 'success');
                } else {
                    showToast('Não foi possível transferir o anfitrião.', 'error');
                }
            } catch (e) {
                showToast('Erro ao transferir anfitrião.', 'error');
            }
        }

        async function kickPartyMember(memberId, memberName) {
            if (!currentPartyRoom || !partyIsHost) return;
            if (!confirm('Remover ' + memberName + ' da sala?')) return;
            try {
                await fetch('/api/party/action/' + currentPartyRoom, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userId: partyMyUserId, action: 'kick', targetId: memberId })
                });
            } catch (e) { }
        }

        /* ── Compartilhar ────────────────────────────────────────────────── */

        function copyPartyShareLink(event) {
            if (event) event.stopPropagation();
            if (!currentPartyRoom) return;
            const url = 'https://brasilflix.kapsu.com.br/?sala=' + currentPartyRoom;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(url).then(() => showToast('Link de convite copiado!', 'success')).catch(() => prompt('Copie:', url));
            } else { prompt('Copie:', url); }
        }

        function sharePartyViaWhatsApp(event) {
            if (event) event.stopPropagation();
            if (!currentPartyRoom) return;
            const url = 'https://brasilflix.kapsu.com.br/?sala=' + currentPartyRoom;
            const msg = encodeURIComponent('🍿 Vamos assistir juntos no BrasilFlix! Entre na minha sala: ' + url);
            window.open('https://api.whatsapp.com/send?text=' + msg, '_blank');
        }

        function openWebPlayerCurrentMovie() {
            if (!currentModalMovie) return;
            openWebPlayerForMovie(currentModalMovie.id);
        }

        function openWebPlayerEpisode(serieId, seasonNum, epNum, explicitAudio = null) {
            openPlaybackPageForEpisode(serieId, seasonNum, epNum, explicitAudio, true);
        }

        function renderSeriesSeasonsInModal(serie, activeSeasonNum = null) {
            const seasonsTabs = document.getElementById('modal-seasons-tabs');
            const episodesList = document.getElementById('modal-episodes-list');
            const totalBadge = document.getElementById('modal-total-eps-badge');

            if (!serie) return;

            if (totalBadge) {
                totalBadge.innerText = `${serie.totalEpisodios || 0} episódio(s) no catálogo`;
            }

            const temporadas = serie.temporadas || [];
            if (temporadas.length === 0) {
                if (seasonsTabs) seasonsTabs.innerHTML = '';
                if (episodesList) episodesList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 16px;">Nenhum episódio cadastrado ainda.</div>';
                return;
            }

            const selectedSeason = activeSeasonNum
                ? (temporadas.find(t => t.numero === activeSeasonNum) || temporadas[0])
                : temporadas[0];

            if (seasonsTabs) {
                seasonsTabs.innerHTML = temporadas.map(t => {
                    const isActive = t.numero === selectedSeason.numero;
                    const epCount = (t.episodios || []).length;
                    return `
                        <button class="season-btn ${isActive ? 'active' : ''}" onclick="renderSeriesSeasonsInModal(currentModalSerie, ${t.numero})">
                            Temporada ${t.numero} <span style="opacity: 0.7; font-size: 11px;">(${epCount} eps)</span>
                        </button>
                    `;
                }).join('');
            }

            if (episodesList) {
                const eps = selectedSeason.episodios || [];
                if (eps.length === 0) {
                    episodesList.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhum episódio cadastrado nesta temporada.</div>';
                } else {
                    episodesList.innerHTML = eps.map(ep => {
                        const hasCustomName = ep.nome && !ep.nome.trim().toLowerCase().startsWith('episódio') && !ep.nome.trim().toLowerCase().startsWith('episode');
                        const displayTitle = hasCustomName ? ep.nome : `Episódio ${ep.numero}`;

                        const temDub = ep.isDublado || (ep.audio && ep.audio.includes('Dublado'));
                        const temLeg = ep.isLegendado || (ep.audio && ep.audio.includes('Legendado'));
                        let audioBadge = 'Dub/Leg';
                        if (temDub && !temLeg) audioBadge = 'Dublado (PT-BR)';
                        else if (temLeg && !temDub) audioBadge = 'Legendado (PT-BR)';

                        const qualBadge = ep.qualidade || '1080p Full HD';
                        const tgLink = `https://t.me/BrasilFlix_bot?start=serie_${serie.id}_${selectedSeason.numero}_${ep.numero}`;
                        const audioPref = temDub ? 'dublado' : 'legendado';

                        return `
                            <div class="episode-card-item">
                                <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                                    <div style="background: rgba(59, 130, 246, 0.15); border: 1px solid rgba(59, 130, 246, 0.35); color: #60a5fa; font-weight: 900; font-size: 11px; padding: 6px 10px; border-radius: 8px; flex-shrink: 0;">
                                        EP ${ep.numero}
                                    </div>
                                    <div style="min-width: 0; flex: 1;">
                                        <h5 style="font-size: 13.5px; font-weight: 800; color: #fff; margin-bottom: 2px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayTitle}</h5>
                                        <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted);">
                                            <span style="color: #34d399; font-weight: 700;">✨ ${qualBadge}</span>
                                            <span>•</span>
                                            <span style="color: #93c5fd; font-weight: 700;">🔊 ${audioBadge}</span>
                                        </div>
                                    </div>
                                </div>
                                <div style="display: flex; gap: 6px; flex-shrink: 0;">
                                    <button class="btn-modal btn-modal-primary" style="padding: 7px 14px; font-size: 12px; min-width: unset; border-radius: 8px;" onclick="openWebPlayerEpisode('${serie.id}', ${selectedSeason.numero}, ${ep.numero}, '${audioPref}')">
                                        ▶️ Assistir
                                    </button>
                                    <a href="${tgLink}" target="_blank" class="btn-modal btn-modal-secondary" style="padding: 7px 10px; font-size: 11px; min-width: unset; border-radius: 8px;" title="Ver no Telegram">
                                        📱 Bot
                                    </a>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
        }

        function closeModal(e) {
            if (e.target.id === 'media-modal') {
                document.getElementById('media-modal')?.classList.remove('active');
            }
        }

        function closeModalDirect() {
            document.getElementById('media-modal')?.classList.remove('active');
        }

        /* ═══════════════════════════════════════════════════════════════════════
           🛡️ CONTROLADORES JAVASCRIPT DO PAINEL ADMIN
           ═══════════════════════════════════════════════════════════════════════ */

        function getAuthHeaders() {
            const token = adminToken;
            return {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token || ''}`,
                'x-admin-token': token || ''
            };
        }

        async function handleAdminLogin(e) {
            e.preventDefault();
            const u = (document.getElementById('admin-login-username') || document.getElementById('login-username'))?.value?.trim() || '';
            const p = (document.getElementById('admin-login-password') || document.getElementById('login-password'))?.value || '';

            try {
                const res = await fetch('/api/admin/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: u, password: p })
                });
                const data = await res.json();

                if (!res.ok || !data.success) {
                    showToast(data.message || 'Credenciais inválidas.', 'error');
                    return;
                }

                adminToken = 'session';
                showToast('Login de Administrador realizado com sucesso!', 'success');
                const rState = getRouteStateFromUrl();
                const targetSub = (rState.mainTab === 'tab-admin' && rState.adminSubTab) ? rState.adminSubTab : null;
                checkAdminAuth(targetSub);
            } catch (err) {
                showToast('Erro de conexão com o servidor.', 'error');
            }
        }

        async function handleAdminLogout() {
            await fetch('/api/user/logout', { method: 'POST' });
            adminToken = null;
            localStorage.removeItem('bf_admin_token');
            document.getElementById('admin-login-view').style.display = 'block';
            document.getElementById('admin-dashboard-view').style.display = 'none';
            showToast('Sessão de admin encerrada.', 'info');
        }

        async function checkAdminAuth(initialSubTab) {

            try {
                const res = await fetch('/api/admin/me', { headers: getAuthHeaders() });
                if (res.ok) adminToken = 'session';
                if (!res.ok) {
                    handleAdminLogout();
                    return;
                }
                const data = await res.json();
                document.getElementById('admin-login-view').style.display = 'none';
                document.getElementById('admin-dashboard-view').style.display = 'block';
                document.getElementById('admin-user-display').innerText = `@${data.user?.username || 'admin'}`;

                const targetSubTab = initialSubTab || localStorage.getItem('bf_admin_subtab') || 'overview';
                switchAdminSubTab(targetSubTab, false);
            } catch (e) {
                console.warn('Erro auth admin:', e);
            }
        }

        function toggleAdminSidebar(e) {
            if (e) e.stopPropagation();
            const sidebar = document.querySelector('.admin-sidebar');
            const backdrop = document.getElementById('admin-sidebar-backdrop');
            if (!sidebar) return;
            const isOpen = sidebar.classList.contains('open');
            if (isOpen) {
                closeAdminSidebar();
            } else {
                sidebar.classList.add('open');
                if (backdrop) backdrop.classList.add('active');
            }
        }

        function closeAdminSidebar() {
            const sidebar = document.querySelector('.admin-sidebar');
            const backdrop = document.getElementById('admin-sidebar-backdrop');
            if (sidebar) sidebar.classList.remove('open');
            if (backdrop) backdrop.classList.remove('active');
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 📟 TERMINAL DE LOGS SSE — PAINEL ADMIN
        // ═══════════════════════════════════════════════════════════════════════

        let _admLogES = null;           // EventSource ativo
        let _admLogAutoScroll = true;   // true = rola para baixo em cada nova linha
        let _admLogLineCount = 0;       // total de linhas no terminal
        const ADM_LOG_MAX_LINES = 500;  // limite visual para não crashar o DOM

        /** Converte texto a HTML seguro (evita XSS nos logs). */
        function _admEscHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        /** Adiciona uma linha ao terminal visual. */
        function _admTerminalAppend(entry) {
            const container = document.getElementById('adm-terminal-lines');
            if (!container) return;

            // Descarta linhas mais antigas se ultrapassar o limite visual
            if (_admLogLineCount >= ADM_LOG_MAX_LINES) {
                const first = container.firstElementChild;
                if (first) { container.removeChild(first); _admLogLineCount--; }
            }

            const line = document.createElement('div');
            line.className = `adm-log-line adm-log-level-${entry.level || 'log'}`;
            line.innerHTML =
                `<span class="adm-log-ts">${_admEscHtml(entry.ts || '')}</span>` +
                `<span>${_admEscHtml(entry.text || '')}</span>`;
            container.appendChild(line);
            _admLogLineCount++;

            // Atualiza contador
            const badge = document.getElementById('adm-log-count-badge');
            if (badge) badge.textContent = `${_admLogLineCount} linha${_admLogLineCount !== 1 ? 's' : ''}`;

            // Auto-scroll
            if (_admLogAutoScroll) {
                const body = document.getElementById('adm-terminal-body');
                if (body) body.scrollTop = body.scrollHeight;
            }
        }

        /** Limpa o terminal visualmente (não afeta o buffer do servidor). */
        function admTerminalClear() {
            const container = document.getElementById('adm-terminal-lines');
            if (container) container.innerHTML = '';
            _admLogLineCount = 0;
            const badge = document.getElementById('adm-log-count-badge');
            if (badge) badge.textContent = '0 linhas';
        }

        /** Alterna o auto-scroll (pausa/retoma). */
        function admTerminalToggleScroll() {
            _admLogAutoScroll = !_admLogAutoScroll;
            const btn = document.getElementById('adm-log-scroll-btn');
            const wrapper = document.getElementById('adm-terminal-wrapper');
            if (btn) btn.textContent = _admLogAutoScroll ? '⏸ Auto-scroll' : '▶ Auto-scroll';
            if (wrapper) {
                if (_admLogAutoScroll) {
                    wrapper.classList.remove('adm-log-scroll-paused');
                } else {
                    wrapper.classList.add('adm-log-scroll-paused');
                }
            }
            if (_admLogAutoScroll) {
                const body = document.getElementById('adm-terminal-body');
                if (body) body.scrollTop = body.scrollHeight;
            }
        }

        /** Inicia a conexão SSE de logs (chamada ao entrar na aba queue). */
        function admTerminalConnect() {
            if (_admLogES && _admLogES.readyState !== EventSource.CLOSED) return; // já conectado
            if (!adminToken) return;

            const url = '/api/admin/logs/stream';
            _admLogES = new EventSource(url);

            _admLogES.onmessage = (e) => {
                try {
                    const entry = JSON.parse(e.data);
                    _admTerminalAppend(entry);
                } catch (_) { }
            };

            _admLogES.onerror = () => {
                // Reconecta automaticamente após 4 s se a aba ainda estiver visível
                if (_admLogES) { _admLogES.close(); _admLogES = null; }
                const queueTab = document.getElementById('admin-subtab-queue');
                if (queueTab && queueTab.style.display !== 'none') {
                    setTimeout(admTerminalConnect, 4000);
                }
            };
        }

        /** Encerra a conexão SSE (chamada ao sair da aba queue). */
        function admTerminalDisconnect() {
            if (_admLogES) {
                _admLogES.close();
                _admLogES = null;
            }
        }

        function switchAdminSubTab(subTabId, updateUrl = true) {
            document.querySelectorAll('.admin-sub-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.admin-subtab-content').forEach(c => c.style.display = 'none');

            const btn = document.getElementById('admin-sub-btn-' + subTabId);
            const content = document.getElementById('admin-subtab-' + subTabId);

            if (btn) btn.classList.add('active');
            if (content) content.style.display = 'block';

            // Atualiza rótulo no cabeçalho do mobile
            const activeLabel = document.getElementById('admin-mobile-active-label');
            if (activeLabel && btn) {
                activeLabel.innerHTML = btn.innerHTML;
            }
            closeAdminSidebar();

            // Salva sub-aba no localStorage e na URL
            localStorage.setItem('bf_admin_subtab', subTabId);
            if (updateUrl) {
                const newHash = `#admin/${subTabId}`;
                if (window.location.hash !== newHash) {
                    history.replaceState(null, '', newHash);
                }
            }

            // Gerencia conexão SSE: conecta ao entrar na aba queue, desconecta ao sair
            if (subTabId === 'queue') {
                admTerminalConnect();
            } else {
                admTerminalDisconnect();
            }

            // Gerencia sincronização da fila de remoção e auto-resync do catálogo
            if (subTabId === 'catalog') {
                startRemovalQueuePolling();
            } else {
                stopRemovalQueuePolling();
                stopCatalogAutoSync();
            }

            if (subTabId === 'overview') loadAdminStats();
            else if (subTabId === 'queue') loadAdminQueue();
            else if (subTabId === 'scheduler') loadAdminScheduler();
            else if (subTabId === 'priorities') loadAdminPriorities();
            else if (subTabId === 'settings') loadAdminSettings();
            else if (subTabId === 'subs') { loadAdminSubs(); loadAdminTokens(); }
            else if (subTabId === 'requests') loadAdminRequests();
            else if (subTabId === 'tickets') loadAdminTickets();
            else if (subTabId === 'catalog') loadAdminCatalog();
            else if (subTabId === 'audit') loadAuditDashboard();
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 🛡️ ADMIN AUDITORIA & MONITORAMENTO DE CLIENTES
        // ═══════════════════════════════════════════════════════════════════════
        let currentAuditPeoplePage = 1;
        let currentAuditProfileData = null;
        let auditSearchDebounceTimer = null;

        async function loadAuditDashboard() {
            try {
                const rangeSelect = document.getElementById('audit-time-range');
                const range = rangeSelect ? rangeSelect.value : 'today';

                const res = await fetch(`/api/admin/audit/dashboard?range=${range}`, {
                    headers: getAuthHeaders()
                });
                if (!res.ok) return;

                const data = await res.json();

                const elReg = document.getElementById('adm-audit-reg-users');
                const elAnon = document.getElementById('adm-audit-anon-visitors');
                const elTg = document.getElementById('adm-audit-tg-users');
                const elAct = document.getElementById('adm-audit-active-now');
                const elWatch = document.getElementById('adm-audit-watching-now');
                const elPlays = document.getElementById('adm-audit-plays');
                const elComp = document.getElementById('adm-audit-completed');
                const elFavs = document.getElementById('adm-audit-favs');
                const elSearch = document.getElementById('adm-audit-searches');
                const elWTime = document.getElementById('adm-audit-watchtime');

                if (elReg) elReg.innerText = data.totalRegisteredUsers || 0;
                if (elAnon) elAnon.innerText = data.totalAnonymousVisitors || 0;
                if (elTg) elTg.innerText = data.totalTelegramUsers || 0;
                if (elAct) elAct.innerText = data.activeUsersNow || 0;
                if (elWatch) elWatch.innerText = data.usersCurrentlyWatching || 0;
                if (elPlays) elPlays.innerText = data.playbackStartsInPeriod || 0;
                if (elComp) elComp.innerText = data.completedEpisodesInPeriod || 0;
                if (elFavs) elFavs.innerText = data.favoritesInPeriod || 0;
                if (elSearch) elSearch.innerText = data.searchesInPeriod || 0;
                if (elWTime) elWTime.innerText = data.totalWatchTimeFormatted || '0m';

                loadAuditPeople(currentAuditPeoplePage);
                loadAuditContentAnalytics();
                loadAuditSearches();
            } catch (e) {
                console.warn('Erro ao carregar dashboard de auditoria:', e);
            }
        }

        function switchAuditView(viewName) {
            document.querySelectorAll('.audit-inner-view').forEach(v => v.style.display = 'none');
            const targetView = document.getElementById('audit-view-' + viewName);
            if (targetView) targetView.style.display = 'block';

            document.getElementById('btn-audit-view-people')?.classList.remove('active');
            document.getElementById('btn-audit-view-content')?.classList.remove('active');
            document.getElementById('btn-audit-view-searches')?.classList.remove('active');

            document.getElementById(`btn-audit-view-${viewName}`)?.classList.add('active');

            if (viewName === 'people') loadAuditPeople(1);
            else if (viewName === 'content') loadAuditContentAnalytics();
            else if (viewName === 'searches') loadAuditSearches();
        }

        function debouncedSearchPeople() {
            clearTimeout(auditSearchDebounceTimer);
            auditSearchDebounceTimer = setTimeout(() => {
                loadAuditPeople(1);
            }, 300);
        }

        async function loadAuditPeople(page = 1) {
            currentAuditPeoplePage = page;
            const tbody = document.getElementById('audit-people-tbody');
            if (!tbody) return;

            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px; color: var(--text-muted);">Buscando identidades de clientes...</td></tr>';

            try {
                const search = document.getElementById('audit-people-search')?.value || '';
                const platform = document.getElementById('audit-people-platform-filter')?.value || 'all';
                const status = document.getElementById('audit-people-status-filter')?.value || 'all';

                const url = `/api/admin/audit/people?page=${page}&limit=15&search=${encodeURIComponent(search)}&platform=${platform}&status=${status}`;
                const res = await fetch(url, { headers: getAuthHeaders() });
                if (!res.ok) throw new Error('Falha ao buscar clientes.');

                const data = await res.json();
                const items = data.items || [];
                const pg = data.pagination || { page: 1, totalPages: 1, totalItems: 0 };

                if (items.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhum cliente encontrado com os filtros selecionados.</td></tr>';
                    renderAuditPeoplePagination(pg);
                    return;
                }

                tbody.innerHTML = items.map(p => {
                    let badgeClass = 'rgba(168, 85, 247, 0.2)';
                    let badgeColor = '#c084fc';
                    let badgeLabel = '👻 Anônimo';

                    if (p.identityType === 'registered') {
                        badgeClass = 'rgba(59, 130, 246, 0.2)';
                        badgeColor = '#60a5fa';
                        badgeLabel = '👤 Registrado';
                    } else if (p.identityType === 'telegram') {
                        badgeClass = 'rgba(14, 165, 233, 0.2)';
                        badgeColor = '#38bdf8';
                        badgeLabel = '✈️ Telegram';
                    }

                    let statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; background: rgba(148, 163, 184, 0.15); color: #94a3b8;">💤 Inativo</span>`;

                    if (p.status === 'WATCHING') {
                        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; background: rgba(245, 158, 11, 0.2); color: #fbbf24;">🍿 WATCHING (${escapeHtml(p.currentActivity?.currentTitle || 'Mídia')})</span>`;
                    } else if (p.status === 'ACTIVE NOW') {
                        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; background: rgba(16, 185, 129, 0.2); color: #34d399;">🟢 ACTIVE NOW</span>`;
                    } else if (p.status === 'RECENT') {
                        statusBadge = `<span style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 700; background: rgba(59, 130, 246, 0.15); color: #60a5fa;">🕒 Recente</span>`;
                    }

                    return `
                        <tr>
                            <td>
                                <div style="font-weight: 800; color: #fff; font-size: 13px;">${escapeHtml(p.name)}</div>
                                <div style="font-size: 11px; color: var(--text-muted);">${escapeHtml(p.email || p.username || 'Sem e-mail')}</div>
                            </td>
                            <td>
                                <span style="padding: 3px 8px; border-radius: 6px; font-size: 10px; font-weight: 700; background: ${badgeClass}; color: ${badgeColor};">
                                    ${badgeLabel}
                                </span>
                            </td>
                            <td>${statusBadge}</td>
                            <td style="font-weight: 700; color: #fff;">${p.sessionsCount}</td>
                            <td style="font-weight: 700; color: #38bdf8;">${p.watchTimeFormatted}</td>
                            <td style="font-weight: 700; color: #fff;">${p.playsCount}</td>
                            <td>${p.favoritesCount}</td>
                            <td>${p.requestsCount}</td>
                            <td style="text-align: right;">
                                <button class="btn-action" style="padding: 4px 10px; font-size: 11px;" onclick="openAuditPersonProfile('${p.identityKey}', '${p.identityType}')">
                                    🔍 Ver Perfil
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');

                renderAuditPeoplePagination(pg);
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="9" style="text-align: center; color: #f87171;">Erro ao carregar clientes: ${escapeHtml(e.message)}</td></tr>`;
            }
        }

        function renderAuditPeoplePagination(pg) {
            const container = document.getElementById('audit-people-pagination');
            if (!container) return;

            if (pg.totalPages <= 1) {
                container.innerHTML = `<span>Total: ${pg.totalItems} identidades</span>`;
                return;
            }

            container.innerHTML = `
                <span>Exibindo página ${pg.page} de ${pg.totalPages} (${pg.totalItems} clientes)</span>
                <div style="display: flex; gap: 6px;">
                    <button class="btn-action" style="padding: 4px 10px; font-size: 11px;" ${pg.page <= 1 ? 'disabled' : ''} onclick="loadAuditPeople(${pg.page - 1})">⬅️ Anterior</button>
                    <button class="btn-action" style="padding: 4px 10px; font-size: 11px;" ${pg.page >= pg.totalPages ? 'disabled' : ''} onclick="loadAuditPeople(${pg.page + 1})">Próxima ➡️</button>
                </div>
            `;
        }

        async function openAuditPersonProfile(identityKey, identityType) {
            const modal = document.getElementById('audit-person-modal');
            if (!modal) return;

            modal.classList.add('active');

            try {
                const res = await fetch(`/api/admin/audit/person/${encodeURIComponent(identityKey)}?type=${identityType}`, {
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error('Falha ao obter perfil.');

                const data = await res.json();
                currentAuditProfileData = data;

                const identity = data.identity || {};
                const summary = data.activitySummary || {};
                const live = data.currentActivity || {};

                document.getElementById('audit-profile-name').innerText = identity.name || 'Cliente';

                const badgeEl = document.getElementById('audit-profile-badge');
                if (badgeEl) {
                    badgeEl.innerText = identity.identityType === 'registered' ? '👤 Registrado' : (identity.identityType === 'telegram' ? '✈️ Telegram' : '👻 Anônimo');
                }

                document.getElementById('audit-profile-ids').innerText = `User ID: ${identity.userId || '-'} | Telegram ID: ${identity.telegramId || '-'} | Visitor ID: ${identity.visitorId || '-'}`;

                const liveText = document.getElementById('audit-profile-live-text');
                const liveBanner = document.getElementById('audit-profile-live-banner');
                if (live.currentlyWatching) {
                    if (liveBanner) liveBanner.style.background = 'rgba(245, 158, 11, 0.15)';
                    if (liveText) liveText.innerText = `🍿 Assistindo agora: ${live.title || 'Mídia'} ${live.seasonNum ? `(T${live.seasonNum}E${live.episodeNum})` : ''}`;
                } else if (live.onlineStatus === 'ACTIVE') {
                    if (liveBanner) liveBanner.style.background = 'rgba(16, 185, 129, 0.15)';
                    if (liveText) liveText.innerText = '🟢 Ativo no site / Telegram neste momento';
                } else {
                    if (liveBanner) liveBanner.style.background = 'rgba(148, 163, 184, 0.1)';
                    if (liveText) liveText.innerText = '💤 Offline / Inativo no momento';
                }

                document.getElementById('audit-prof-sessions').innerText = summary.totalSessions || 0;
                document.getElementById('audit-prof-watchtime').innerText = summary.totalWatchTimeFormatted || '0m';
                document.getElementById('audit-prof-plays').innerText = summary.playbackStarts || 0;
                document.getElementById('audit-prof-completed').innerText = summary.completedEpisodes || 0;
                document.getElementById('audit-prof-favs').innerText = summary.favoritesCount || 0;
                document.getElementById('audit-prof-searches').innerText = summary.searchesCount || 0;

                switchAuditProfileTab('timeline');
            } catch (e) {
                showToast('Erro ao carregar perfil do audit: ' + e.message, 'error');
            }
        }

        function closeAuditPersonModal() {
            const modal = document.getElementById('audit-person-modal');
            if (modal) modal.classList.remove('active');
        }

        function switchAuditProfileTab(tabName) {
            document.querySelectorAll('.audit-prof-tab-content').forEach(c => c.style.display = 'none');
            const target = document.getElementById('audit-prof-content-' + tabName);
            if (target) target.style.display = 'block';

            document.getElementById('btn-audit-prof-tab-timeline')?.classList.remove('active');
            document.getElementById('btn-audit-prof-tab-history')?.classList.remove('active');
            document.getElementById('btn-audit-prof-tab-favs')?.classList.remove('active');
            document.getElementById('btn-audit-prof-tab-searches')?.classList.remove('active');
            document.getElementById('btn-audit-prof-tab-requests')?.classList.remove('active');

            document.getElementById(`btn-audit-prof-tab-${tabName}`)?.classList.add('active');

            if (!currentAuditProfileData) return;

            if (tabName === 'timeline') renderProfileTimeline(currentAuditProfileData.identity?.identityKey, currentAuditProfileData.identity?.identityType);
            else if (tabName === 'history') renderProfileHistory(currentAuditProfileData.watchHistory || []);
            else if (tabName === 'favs') renderProfileFavorites(currentAuditProfileData.favorites || []);
            else if (tabName === 'searches') renderProfileSearches(currentAuditProfileData.searchHistory || []);
            else if (tabName === 'requests') renderProfileRequests(currentAuditProfileData.requests || []);
        }

        async function renderProfileTimeline(identityKey, identityType) {
            const container = document.getElementById('audit-prof-timeline-container');
            if (!container) return;

            container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">Carregando eventos cronológicos...</div>';

            try {
                const res = await fetch(`/api/admin/audit/person/${encodeURIComponent(identityKey)}/timeline?type=${identityType}&page=1&limit=30`, {
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error('Erro na requisição da linha do tempo.');

                const data = await res.json();
                const events = data.events || [];

                if (events.length === 0) {
                    container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; text-align: center; padding: 20px;">Nenhum evento registrado nesta linha do tempo.</div>';
                    return;
                }

                container.innerHTML = events.map(ev => {
                    const dt = new Date(ev.timestamp).toLocaleString('pt-BR');
                    const plat = ev.source === 'telegram' ? '✈️ Telegram' : (ev.source === 'stremio' || ev.platform === 'stremio' ? '📺 TV / Stremio' : '🌐 Website');

                    let icon = '📌';
                    if (ev.eventType.includes('PLAYBACK') || ev.eventType.includes('START')) icon = '▶️';
                    else if (ev.eventType.includes('SEARCH')) icon = '🔍';
                    else if (ev.eventType.includes('FAVORITE')) icon = '⭐';
                    else if (ev.eventType.includes('LOGIN')) icon = '🔐';
                    else if (ev.eventType.includes('REQUEST')) icon = '🍿';
                    else if (ev.eventType.includes('COMPLETED')) icon = '✅';

                    return `
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; padding: 10px 14px; display: flex; align-items: flex-start; gap: 12px;">
                            <div style="font-size: 16px; margin-top: 2px;">${icon}</div>
                            <div style="flex: 1;">
                                <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
                                    <div style="font-size: 12px; font-weight: 800; color: #fff;">${escapeHtml(ev.eventType)}</div>
                                    <div style="font-size: 11px; color: var(--text-muted);">${dt} • ${plat}</div>
                                </div>
                                <div style="font-size: 12px; color: #38bdf8; margin-top: 2px; font-weight: 700;">${escapeHtml(ev.title)}</div>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                container.innerHTML = `<div style="color: #f87171; font-size: 12px; padding: 10px;">Erro: ${escapeHtml(e.message)}</div>`;
            }
        }

        function renderProfileHistory(history) {
            const tbody = document.getElementById('audit-prof-history-tbody');
            if (!tbody) return;

            if (history.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Nenhum histórico de reprodução.</td></tr>';
                return;
            }

            tbody.innerHTML = history.map(h => {
                const prog = h.progressPercentage || 0;
                const dt = h.lastWatchedAt ? new Date(h.lastWatchedAt).toLocaleDateString('pt-BR') : '-';
                const platLabel = h.platform === 'telegram' ? '✈️ TG' : (h.platform === 'stremio' ? '📺 TV' : '🌐 Web');
                return `
                    <tr>
                        <td style="font-weight: 700; color: #fff;">${escapeHtml(h.title)} ${h.seasonNum ? `(T${h.seasonNum}E${h.episodeNum})` : ''}</td>
                        <td style="color: var(--text-muted);">${new Date(h.startedAt).toLocaleDateString('pt-BR')}</td>
                        <td style="color: var(--text-muted);">${dt}</td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <div style="flex: 1; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden;">
                                    <div style="width: ${prog}%; height: 100%; background: #38bdf8;"></div>
                                </div>
                                <span>${prog}%</span>
                            </div>
                        </td>
                        <td style="color: #38bdf8; font-weight: 700;">${h.watchTimeFormatted}</td>
                        <td>${platLabel}</td>
                    </tr>
                `;
            }).join('');
        }

        function renderProfileFavorites(favs) {
            const container = document.getElementById('audit-prof-favs-container');
            if (!container) return;

            if (favs.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 10px;">Nenhum favorito adicionado.</div>';
                return;
            }

            container.innerHTML = favs.map(f => `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 13px; font-weight: 800; color: #fff;">⭐ ${escapeHtml(f.title)}</div>
                    <div style="font-size: 11px; color: var(--text-muted);">${new Date(f.addedAt).toLocaleDateString('pt-BR')}</div>
                </div>
            `).join('');
        }

        function renderProfileSearches(searches) {
            const container = document.getElementById('audit-prof-searches-container');
            if (!container) return;

            if (searches.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 10px;">Nenhuma busca recente.</div>';
                return;
            }

            container.innerHTML = searches.map(s => `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 13px; font-weight: 700; color: #fff;">🔍 "${escapeHtml(s.query)}"${s.resultsCount === 0 ? ' <span style="color:#f87171;font-size:11px;">(0 resultados)</span>' : ''}</div>
                    <div style="font-size: 11px; color: var(--text-muted);">${new Date(s.timestamp).toLocaleString('pt-BR')} • ${s.platform}</div>
                </div>
            `).join('');
        }

        function renderProfileRequests(requests) {
            const container = document.getElementById('audit-prof-requests-container');
            if (!container) return;

            if (requests.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 10px;">Nenhum pedido solicitado.</div>';
                return;
            }

            container.innerHTML = requests.map(r => `
                <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 13px; font-weight: 800; color: #fff;">🍿 ${escapeHtml(r.title)}</div>
                    <div style="font-size: 11px; color: #34d399; font-weight: 700;">${escapeHtml(r.status || 'pendente')}</div>
                </div>
            `).join('');
        }

        async function loadAuditContentAnalytics() {
            try {
                const range = document.getElementById('audit-time-range')?.value || 'today';
                const res = await fetch(`/api/admin/audit/content?range=${range}`, { headers: getAuthHeaders() });
                if (!res.ok) return;

                const data = await res.json();

                const elWatched = document.getElementById('audit-content-most-watched');
                if (elWatched) {
                    const list = data.mostWatched || [];
                    if (list.length === 0) elWatched.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Sem reproduções no período.</div>';
                    else elWatched.innerHTML = list.map(item => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="font-weight:700;color:#fff;">${escapeHtml(item.title)}</span>
                            <span style="color:#38bdf8;font-weight:800;">${item.totalWatchTimeFormatted} (${item.playCount}x)</span>
                        </div>
                    `).join('');
                }

                const elSearched = document.getElementById('audit-content-most-searched');
                if (elSearched) {
                    const list = data.mostSearched || [];
                    if (list.length === 0) elSearched.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Sem buscas no período.</div>';
                    else elSearched.innerHTML = list.map(item => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="font-weight:700;color:#fff;">"${escapeHtml(item.query)}"</span>
                            <span style="color:#fbbf24;font-weight:800;">${item.searchCount} pesquisas</span>
                        </div>
                    `).join('');
                }

                const elFavs = document.getElementById('audit-content-most-favorited');
                if (elFavs) {
                    const list = data.mostFavorited || [];
                    if (list.length === 0) elFavs.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Sem favoritos no período.</div>';
                    else elFavs.innerHTML = list.map(item => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="font-weight:700;color:#fff;">${escapeHtml(item.title)}</span>
                            <span style="color:#f87171;font-weight:800;">${item.favCount}x ⭐</span>
                        </div>
                    `).join('');
                }

                const elAbandon = document.getElementById('audit-content-abandonment');
                if (elAbandon) {
                    const list = data.abandonment || [];
                    if (list.length === 0) elAbandon.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Sem dados de abandono suficientes.</div>';
                    else elAbandon.innerHTML = list.map(item => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
                            <span style="font-weight:700;color:#fff;">${escapeHtml(item.title)}</span>
                            <span style="color:#f87171;font-weight:800;">Taxa: ${item.abandonmentRate} (${item.starts} inícios)</span>
                        </div>
                    `).join('');
                }
            } catch (e) {
                console.warn('Erro ao carregar estatísticas de conteúdo do audit:', e);
            }
        }

        async function loadAuditSearches() {
            const tbody = document.getElementById('audit-searches-tbody');
            if (!tbody) return;

            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Analisando buscas sem resultado...</td></tr>';

            try {
                const range = document.getElementById('audit-time-range')?.value || 'today';
                const res = await fetch(`/api/admin/audit/content?range=${range}`, { headers: getAuthHeaders() });
                if (!res.ok) return;

                const data = await res.json();
                const list = data.noResultSearches || [];

                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: #34d399;">✅ Nenhuma busca com zero resultados registrada neste período! Todas as pesquisas encontraram conteúdo.</td></tr>';
                    return;
                }

                tbody.innerHTML = list.map(item => `
                    <tr>
                        <td style="font-weight: 800; color: #f87171; font-size: 13px;">"${escapeHtml(item.query)}"</td>
                        <td style="font-weight: 700; color: #fff;">${item.count} buscas</td>
                        <td style="color: var(--text-muted);">${new Date(item.lastSearched).toLocaleString('pt-BR')}</td>
                        <td>${escapeHtml(item.platforms || 'website')}</td>
                        <td style="text-align: right;">
                            <button class="btn-action btn-action-primary" style="padding: 4px 10px; font-size: 11px;" onclick="quickRequestFromSearch('${escapeJsStr(item.query)}')">
                                + Adicionar / Enfileirar
                            </button>
                        </td>
                    </tr>
                `).join('');
            } catch (e) {
                tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #f87171;">Erro: ${escapeHtml(e.message)}</td></tr>`;
            }
        }

        function quickRequestFromSearch(query) {
            switchAdminSubTab('queue');
            setTimeout(() => {
                const input = document.getElementById('manual-job-title-input');
                if (input) input.value = query;
            }, 300);
        }

        async function loadAdminStats() {
            if (!adminToken) return;
            try {
                const res = await fetch('/api/admin/stats', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();

                const metricBox = document.getElementById('adm-ingestion-metrics');
                if (metricBox && data.ingestao) {
                    const { jobs, published, timings, discardedBytes, failures } = data.ingestao;
                    const labels = { queue: 'fila', search: 'busca', firstByte: 'primeiro byte', transfer: 'transferência', optimization: 'otimização', upload: 'upload' };
                    const times = Object.entries(timings).map(([key, sample]) => labels[key] + ' ' + (sample.totalMs / sample.samples / 60000).toFixed(1) + ' min');
                    const discarded = Object.entries(discardedBytes).map(([key, bytes]) => (key === 'noSubtitle' ? 'sem legenda' : key) + ' ' + (bytes / 1048576).toFixed(0) + ' MB');
                    const errors = Object.entries(failures).map(([key, count]) => key + ' ' + count);
                    metricBox.textContent = [published + ' publicações em ' + jobs + ' execuções desde o reinício', ...times, ...discarded, ...errors].join(' · ');
                }
                document.getElementById('adm-stat-queue').innerText = data.fila?.queued || 0;
                document.getElementById('adm-stat-subs').innerText = data.assinaturasAtivas || 0;
                document.getElementById('adm-stat-pedidos').innerText = data.pedidosPendentes || 0;
                // Usa o total geral do catálogo (filmes + séries + animes + doramas)
                const totCat = Number(data.catalogo?.total) || ((data.catalogo?.totalFilmes || 0) + (data.catalogo?.totalSeries || 0));
                document.getElementById('adm-stat-catalogo').innerText = totCat;

                const uptimeMin = Math.floor((data.uptime || 0) / 60);
                const uptimeHoras = Math.floor(uptimeMin / 60);
                document.getElementById('adm-server-uptime').innerText = `${uptimeHoras}h ${uptimeMin % 60}m online`;
            } catch (e) { }
        }

        async function loadAdminQueue() {
            if (!adminToken) return;
            const tbody = document.getElementById('admin-queue-tbody');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/queue', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                currentAdminJobs = data.jobs || [];

                if (currentAdminJobs.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhum trabalho na fila no momento.</td></tr>';
                    return;
                }

                tbody.innerHTML = currentAdminJobs.map((j, idx) => {
                    const epStr = (j.type === 'serie' && (j.season || j.episode)) ? ` (T${j.season || 1}E${j.episode || 1})` : '';
                    const statusColors = {
                        'downloading': '#3b82f6',
                        'processing': '#f59e0b',
                        'uploading': '#a855f7',
                        'queued': '#9ca3af',
                        'completed': '#10b981',
                        'failed': '#ef4444'
                    };
                    const statusColor = statusColors[j.status] || '#9ca3af';
                    const isManual = j.isManualAdd || !!j.rawFilePath;
                    const typeBadge = isManual
                        ? `<span style="background: rgba(168, 85, 247, 0.15); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">📁 Upload Manual</span>`
                        : `<span style="background: rgba(59, 130, 246, 0.15); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.4); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">🤖 Auto Torrent</span>`;

                    return `
                        <tr class="draggable-row" draggable="true" data-id="${j.id}" data-index="${idx}"
                            ondragstart="handleDragStart(event)" ondragover="handleDragOver(event)"
                            ondragenter="handleDragEnter(event)" ondragleave="handleDragLeave(event)"
                            ondrop="handleDrop(event)" ondragend="handleDragEnd(event)">
                            <td style="text-align: center; color: var(--text-muted); cursor: grab;">
                                <span class="drag-handle" title="Arraste para reordenar">⠿</span>
                            </td>
                            <td>
                                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                                    <strong>${j.title}${epStr}</strong>
                                    ${typeBadge}
                                </div>
                                <div style="font-size: 10px; color: var(--text-muted);">${j.id}</div>
                            </td>
                            <td>${j.type === 'filme' ? '🎬 Filme' : '📺 Série'}</td>
                            <td>
                                <select class="admin-select" onchange="handleChangeJobPriority('${j.id}', this.value)">
                                    <option value="1" ${j.priority === 1 ? 'selected' : ''}>🔥 1 - VIP</option>
                                    <option value="2" ${j.priority === 2 ? 'selected' : ''}>📺 2 - Série</option>
                                    <option value="3" ${j.priority === 3 ? 'selected' : ''}>🍿 3 - Normal</option>
                                    <option value="5" ${j.priority === 5 || j.priority === 4 ? 'selected' : ''}>🤖 5 - Feeder</option>
                                </select>
                            </td>
                            <td>${j.audioPreference === 'dublado' ? '🇧🇷 Dublado' : '💬 Legendado'}</td>
                            <td>
                                <span style="display: inline-block; padding: 2px 8px; border-radius: 4px; font-weight: 800; font-size: 11px; background: rgba(255,255,255,0.06); color: ${statusColor}; border: 1px solid ${statusColor}44;">
                                    ${(j.status || 'queued').toUpperCase()}
                                </span>
                            </td>
                            <td>
                                <div style="font-size: 11px; font-weight: 700; color: #fff;">${j.progress || 0}%</div>
                                <div style="font-size: 10px; color: var(--text-muted); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${j.progressDetails || j.error || ''}</div>
                            </td>
                            <td style="text-align: right; white-space: nowrap;">
                                <div style="display: inline-flex; gap: 4px;">
                                    <button class="btn-action" style="padding: 4px 7px;" onclick="openEditJobModal('${j.id}')" title="Editar Título, Temporada/Episódio, TMDB ou Prioridade">✏️</button>
                                    <button class="btn-action" style="padding: 4px 7px;" onclick="handleMoveJobStep('${j.id}', 'up')" title="Subir 1 posição na fila">⬆️</button>
                                    <button class="btn-action" style="padding: 4px 7px;" onclick="handleMoveJobStep('${j.id}', 'down')" title="Descer 1 posição na fila">⬇️</button>
                                    <button class="btn-action btn-action-primary" style="padding: 4px 8px;" onclick="handleMoveJobTop('${j.id}')" title="Mover para o Topo Absoluto (Próximo)">🔝 Topo</button>
                                    ${j.status === 'failed' ? `<button class="btn-action btn-action-success" style="padding: 4px 8px;" onclick="handleRetryJob('${j.id}')" title="Tentar Novamente">🔄</button>` : ''}
                                    <button class="btn-action btn-action-danger" style="padding: 4px 8px;" onclick="handleDeleteJob('${j.id}', '${(j.title || '').replace(/'/g, "\\'")}')" title="Cancelar e Excluir">🗑️</button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #ef4444; padding: 20px;">Falha ao carregar fila.</td></tr>';
            }
        }

        async function handleMoveJobStep(jobId, direction) {
            try {
                const res = await fetch(`/api/admin/queue/${jobId}/move-step`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ direction })
                });
                if (!res.ok) throw new Error();
                showToast(`Trabalho movido para ${direction === 'up' ? 'cima' : 'baixo'}!`, 'success');
                loadAdminQueue();
            } catch (e) {
                showToast('Erro ao movimentar item na fila.', 'error');
            }
        }

        /* DRAG AND DROP REORDERING */
        function handleDragStart(e) {
            dragSrcEl = e.currentTarget;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', e.currentTarget.getAttribute('data-id'));
            e.currentTarget.classList.add('dragging');
        }

        function handleDragOver(e) {
            if (e.preventDefault) e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            return false;
        }

        function handleDragEnter(e) {
            e.currentTarget.classList.add('drag-over');
        }

        function handleDragLeave(e) {
            e.currentTarget.classList.remove('drag-over');
        }

        async function handleDrop(e) {
            if (e.stopPropagation) e.stopPropagation();
            e.currentTarget.classList.remove('drag-over');

            const sourceId = e.dataTransfer.getData('text/plain');
            const targetId = e.currentTarget.getAttribute('data-id');

            if (sourceId === targetId) return false;

            const fromIndex = currentAdminJobs.findIndex(j => j.id === sourceId);
            const toIndex = currentAdminJobs.findIndex(j => j.id === targetId);

            if (fromIndex < 0 || toIndex < 0) return false;

            const [movedItem] = currentAdminJobs.splice(fromIndex, 1);
            currentAdminJobs.splice(toIndex, 0, movedItem);

            const jobIds = currentAdminJobs.map(j => j.id);

            try {
                const res = await fetch('/api/admin/queue/reorder', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ jobIds })
                });
                if (!res.ok) throw new Error();
                showToast('Fila reordenada com sucesso!', 'success');
                loadAdminQueue();
            } catch (err) {
                showToast('Erro ao reordenar fila.', 'error');
                loadAdminQueue();
            }

            return false;
        }

        function handleDragEnd(e) {
            document.querySelectorAll('.draggable-row').forEach(row => {
                row.classList.remove('dragging');
                row.classList.remove('drag-over');
            });
        }

        async function handleMoveJobTop(jobId) {
            try {
                const res = await fetch(`/api/admin/queue/${jobId}/move-top`, {
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro');
                showToast(data.message || 'Trabalho movido para o topo da fila!', 'success');
                loadAdminQueue();
            } catch (e) {
                showToast('Erro ao mover trabalho para o topo.', 'error');
            }
        }

        async function handleChangeJobPriority(jobId, priority) {
            try {
                const res = await fetch(`/api/admin/queue/${jobId}/priority`, {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ priority: newPriority })
                });
                if (!res.ok) throw new Error();
                showToast(`Prioridade atualizada para ${newPriority}!`, 'success');
                loadAdminQueue();
            } catch (e) {
                showToast('Erro ao atualizar prioridade.', 'error');
            }
        }

        async function handleRetryJob(jobId) {
            try {
                const res = await fetch(`/api/admin/queue/${jobId}/retry`, {
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Trabalho reenfileirado para download com sucesso!', 'success');
                loadAdminQueue();
            } catch (e) {
                showToast('Erro ao reprocessar trabalho.', 'error');
            }
        }

        async function handleDeleteJob(jobId, title = '') {
            const name = title ? `"${title}"` : 'este trabalho';
            if (!confirm(`Deseja realmente CANCELAR e EXCLUIR ${name} da fila? (Arquivos locais associados também serão removidos)`)) return;

            try {
                const res = await fetch(`/api/admin/queue/${jobId}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Falha ao excluir.');

                showToast(data.message || 'Trabalho cancelado e excluído com sucesso!', 'success');
                loadAdminQueue();
                loadAdminStats();
            } catch (e) {
                showToast(e.message || 'Erro ao excluir trabalho.', 'error');
            }
        }

        function toggleEditSeriesFields() {
            const type = document.getElementById('edit-type').value;
            const fields = document.getElementById('edit-series-fields');
            if (fields) {
                fields.style.display = type === 'serie' ? 'block' : 'none';
            }
        }

        async function openEditJobModal(jobId) {
            const job = (currentAdminJobs || []).find(j => j.id === jobId);
            if (!job) {
                showToast('Trabalho não encontrado na memória.', 'error');
                return;
            }

            document.getElementById('edit-job-id').value = job.id;
            document.getElementById('edit-title').value = job.title || '';
            document.getElementById('edit-year').value = job.metaDetails?.ano || job.ano || '';
            document.getElementById('edit-type').value = job.type || 'filme';
            document.getElementById('edit-audio-pref').value = job.audioPreference || 'dublado';
            document.getElementById('edit-season').value = job.season || 1;
            document.getElementById('edit-episode').value = job.episode || 1;
            document.getElementById('edit-priority').value = job.priority || 1;
            document.getElementById('edit-synopsis').value = job.metaDetails?.sinopse || '';
            document.getElementById('edit-tmdb-id').value = job.metaDetails?.tmdbId || job.tmdbId || '';
            document.getElementById('edit-imdb-id').value = job.metaDetails?.imdbId || job.imdbId || '';
            document.getElementById('edit-poster-url').value = job.metaDetails?.posterUrl || '';
            document.getElementById('edit-backdrop-url').value = job.metaDetails?.backdropUrl || '';
            document.getElementById('edit-original-title').value = job.metaDetails?.nomeOriginal || job.nomeOriginal || '';
            document.getElementById('edit-genres-json').value = JSON.stringify(job.metaDetails?.generos || []);
            document.getElementById('edit-rating').value = job.metaDetails?.nota || 8.0;
            document.getElementById('edit-requeue').checked = (job.status === 'failed');

            document.getElementById('edit-tmdb-query').value = job.title || '';
            document.getElementById('edit-tmdb-results').style.display = 'none';

            toggleEditSeriesFields();
            openAdminModal('admin-modal-edit-job');
        }

        async function triggerEditTmdbSearch() {
            const q = document.getElementById('edit-tmdb-query')?.value?.trim();
            if (!q) return;

            const resultsContainer = document.getElementById('edit-tmdb-results');
            if (!resultsContainer) return;

            resultsContainer.style.display = 'flex';
            resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 12px;">🔍 Buscando no TMDB...</div>';

            try {
                const res = await fetch(`/api/admin/tmdb/search?query=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
                const data = await res.json();
                const list = data.results || [];

                if (list.length === 0) {
                    resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 12px;">Nenhum resultado encontrado no TMDB.</div>';
                    return;
                }

                resultsContainer.innerHTML = list.slice(0, 8).map(item => {
                    const poster = item.posterUrl || 'https://via.placeholder.com/92x138/111827/9ca3af?text=Sem+Capa';
                    const ano = item.ano || (item.dataLancamento ? item.dataLancamento.split('-')[0] : '');
                    const tipoBadge = item.tipo === 'serie' ? '📺 Série' : '🎬 Filme';

                    return `
                        <div class="tmdb-result-card" onclick='selectEditTmdbResult(${JSON.stringify(item).replace(/'/g, "&#39;")})'>
                            <img class="tmdb-result-thumb" src="${poster}" alt="${escapeHtml(item.nome)}">
                            <div class="tmdb-result-info">
                                <div class="tmdb-result-title">${item.nome}</div>
                                <div class="tmdb-result-meta">
                                    <span style="background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px;">${tipoBadge}</span>
                                    <span>${ano}</span>
                                    <span>⭐ ${(item.nota || 8.0).toFixed(1)}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                resultsContainer.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 12px;">Erro ao consultar TMDB.</div>';
            }
        }

        function selectEditTmdbResult(item) {
            document.getElementById('edit-tmdb-results').style.display = 'none';
            document.getElementById('edit-title').value = item.nome || '';
            document.getElementById('edit-year').value = item.ano || (item.dataLancamento ? item.dataLancamento.split('-')[0] : '2026');
            document.getElementById('edit-type').value = item.tipo === 'serie' ? 'serie' : 'filme';
            document.getElementById('edit-synopsis').value = item.sinopse || item.descricao || '';
            document.getElementById('edit-tmdb-id').value = item.tmdbId || '';
            document.getElementById('edit-imdb-id').value = item.imdbId || '';
            document.getElementById('edit-poster-url').value = item.posterUrl || '';
            document.getElementById('edit-backdrop-url').value = item.backdropUrl || '';
            document.getElementById('edit-original-title').value = item.nomeOriginal || item.nome || '';
            document.getElementById('edit-genres-json').value = JSON.stringify(item.generos || []);
            document.getElementById('edit-rating').value = item.nota || 8.0;

            toggleEditSeriesFields();
            showToast(`Dados vinculados ao TMDB: "${item.nome}"!`, 'success');
        }

        async function handleEditJobFormSubmit(e) {
            e.preventDefault();

            const jobId = document.getElementById('edit-job-id').value;
            const title = document.getElementById('edit-title').value;
            const ano = document.getElementById('edit-year').value;
            const type = document.getElementById('edit-type').value;
            const audioPref = document.getElementById('edit-audio-pref').value;
            const season = document.getElementById('edit-season').value;
            const episode = document.getElementById('edit-episode').value;
            const priority = document.getElementById('edit-priority').value;
            const synopsis = document.getElementById('edit-synopsis').value;
            const requeue = document.getElementById('edit-requeue').checked;

            const tmdbId = document.getElementById('edit-tmdb-id').value;
            const imdbId = document.getElementById('edit-imdb-id').value;
            const posterUrl = document.getElementById('edit-poster-url').value;
            const backdropUrl = document.getElementById('edit-backdrop-url').value;
            const nomeOriginal = document.getElementById('edit-original-title').value;
            const rating = document.getElementById('edit-rating').value;

            let generos = [];
            try { generos = JSON.parse(document.getElementById('edit-genres-json').value || '[]'); } catch (err) { }

            const payload = {
                title,
                type,
                audioPreference: audioPref,
                priority: parseInt(priority, 10),
                season: type === 'serie' ? parseInt(season || 1, 10) : null,
                episode: type === 'serie' ? parseInt(episode || 1, 10) : null,
                requeue: requeue,
                metaDetails: {
                    sinopse: synopsis,
                    ano: ano || new Date().getFullYear().toString(),
                    tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
                    imdbId: imdbId || null,
                    posterUrl: posterUrl || '',
                    backdropUrl: backdropUrl || '',
                    nomeOriginal: nomeOriginal || title,
                    generos: generos,
                    nota: parseFloat(rating || 8.0)
                }
            };

            try {
                const res = await fetch(`/api/admin/queue/${jobId}`, {
                    method: 'PUT',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok || !data.success) throw new Error(data.error || 'Falha ao salvar edição.');

                showToast(data.message || 'Trabalho atualizado com sucesso!', 'success');
                closeAdminModal('admin-modal-edit-job');
                loadAdminQueue();
                loadAdminCatalog();
                loadAdminStats();
            } catch (err) {
                showToast(err.message || 'Erro ao editar trabalho.', 'error');
            }
        }

        async function handleClearFailedJobs() {
            if (!confirm('Deseja limpar todos os trabalhos com status Falhou?')) return;
            try {
                const res = await fetch('/api/admin/queue/clear-failed', {
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Trabalhos com falha removidos com sucesso!', 'success');
                loadAdminQueue();
            } catch (e) {
                showToast('Erro ao limpar falhas.', 'error');
            }
        }

        let currentManualActionMode = 'queue';
        let tmdbSearchTimeout = null;

        function switchManualActionMode(mode) {
            currentManualActionMode = mode;
            ['queue', 'magnet', 'upload', 'direct'].forEach(m => {
                const btn = document.getElementById('btn-mode-' + m);
                if (btn) btn.classList.toggle('active', m === mode);
            });

            const magnetFields = document.getElementById('mode-magnet-fields');
            const uploadFields = document.getElementById('mode-upload-fields');
            const directFields = document.getElementById('mode-direct-fields');
            const priorityBox = document.getElementById('manual-priority-box');
            const allEpsBox = document.getElementById('manual-all-eps-box');
            const submitBtn = document.getElementById('manual-submit-btn');

            if (magnetFields) magnetFields.style.display = mode === 'magnet' ? 'block' : 'none';
            if (uploadFields) uploadFields.style.display = mode === 'upload' ? 'block' : 'none';
            if (directFields) directFields.style.display = mode === 'direct' ? 'block' : 'none';
            if (priorityBox) priorityBox.style.display = mode === 'direct' ? 'none' : 'block';
            if (allEpsBox) allEpsBox.style.display = (mode === 'direct' || mode === 'upload') ? 'none' : 'flex';

            if (submitBtn) {
                if (mode === 'queue') {
                    submitBtn.innerText = '🚀 Enfileirar para Download Automático';
                    submitBtn.className = 'btn-modal btn-modal-primary';
                } else if (mode === 'magnet') {
                    submitBtn.innerText = '🧲 Baixar via Magnet Link Personalizado';
                    submitBtn.className = 'btn-modal btn-modal-vip';
                } else if (mode === 'upload') {
                    submitBtn.innerText = '📁 Enviar Arquivo e Processar no Robô';
                    submitBtn.className = 'btn-modal btn-modal-primary';
                } else {
                    submitBtn.innerText = '📥 Salvar Diretamente no Catálogo';
                    submitBtn.className = 'btn-modal btn-modal-primary';
                }
            }
        }

        async function handleManualFileSelected(input) {
            const file = input.files?.[0];
            const infoBox = document.getElementById('upload-file-info');
            if (!file) return;

            const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
            const sizeGB = (file.size / (1024 * 1024 * 1024)).toFixed(2);
            const displaySize = file.size > 1024 * 1024 * 1024 ? `${sizeGB} GB` : `${sizeMB} MB`;

            // 1. Extração inteligente do nome do arquivo
            let rawName = file.name.replace(/\.[a-zA-Z0-9]{2,4}$/, '');

            // Detecta temporada e episódio (ex: S01E01, T1 Ep 2, 1x03)
            const matchEp = rawName.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\s*(?:e|ep|episodio|episódio|x)\s*(\d{1,3})\b/i);
            const matchTempOnly = rawName.match(/\b(?:s|temporada|temp|t)\s*(\d{1,2})\b/i);
            const matchYear = rawName.match(/\b(19\d{2}|20\d{2})\b/);

            let isSerie = !!matchEp || !!matchTempOnly;
            let sNum = matchEp ? parseInt(matchEp[1], 10) : (matchTempOnly ? parseInt(matchTempOnly[1], 10) : 1);
            let epNum = matchEp ? parseInt(matchEp[2], 10) : 1;
            let ano = matchYear ? matchYear[1] : '';

            // Detecta preferência de áudio do arquivo
            let audioPref = 'dublado';
            if (/\b(dublado|dual|nacional|audio[-_ ]?pt)\b/i.test(rawName)) {
                audioPref = 'dublado';
            } else if (/\b(legendado|legendas|sub[-_ ]?pt|subbed)\b/i.test(rawName)) {
                audioPref = 'legendado';
            }

            // Pega o título antes do marcador de episódio ou ano para descartar todas as tags do release group/site
            let cleanTitle = '';
            if (matchEp) {
                cleanTitle = rawName.substring(0, matchEp.index);
            } else if (matchTempOnly) {
                cleanTitle = rawName.substring(0, matchTempOnly.index);
            } else if (matchYear) {
                cleanTitle = rawName.substring(0, matchYear.index);
            } else {
                cleanTitle = rawName;
            }

            // Remove resquícios de links, domínios, sites e tags técnicas
            cleanTitle = cleanTitle
                .replace(/https?:\/\/\S+/gi, '')
                .replace(/\b(?:www\.)?[a-zA-Z0-9_-]+\.(?:com|br|to|net|org|site|club|me|tv|io|top|xyz|ws|vip|cc)\b/gi, '')
                .replace(/[\._]/g, ' ')
                .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\s*(?:e|ep|episodio|episódio|x)\s*\d{1,3}\b/gi, '')
                .replace(/\b(?:s|temporada|temp|t)\s*\d{1,2}\b/gi, '')
                .replace(/\b(1080p|720p|2160p|4k|bluray|web-dl|webrip|dual|dublado|legendado|aac|x264|x265|hevc|ddp5\.1|dvdrip|hdtv|galaxytv|comando|comandotorrents|bludv|lapumia|starck|vizer|wolverdon|ondebaixo|lipeh|cinegaveta|filmesmega|mmfilmes)\b/gi, '')
                .replace(/[-–—]\s*\d{4}/g, '')
                .replace(/\b(19\d{2}|20\d{2})\b/g, '')
                .replace(/\[[^\]]*\]|\([^\)]*\)/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (!cleanTitle) cleanTitle = rawName;

            // Preenche os campos do formulário
            document.getElementById('manual-title').value = cleanTitle;
            if (ano) document.getElementById('manual-year').value = ano;
            document.getElementById('manual-type').value = isSerie ? 'serie' : 'filme';
            document.getElementById('manual-audio-pref').value = audioPref;
            if (isSerie) {
                document.getElementById('manual-season').value = sNum;
                document.getElementById('manual-episode').value = epNum;
            }
            toggleManualSeriesFields();

            if (infoBox) {
                infoBox.innerHTML = `✓ <strong>${file.name}</strong> (${displaySize})<br><span style="color:#a78bfa;">Identificado: "${cleanTitle}" ${isSerie ? `(T${sNum}E${epNum})` : ''} • Buscando no TMDB...</span>`;
            }

            // Dispara busca automática no TMDB
            document.getElementById('manual-tmdb-query').value = cleanTitle;
            await triggerTmdbSearchWithQuery(cleanTitle, true);
        }

        function toggleManualSeriesFields() {
            const type = document.getElementById('manual-type').value;
            const fields = document.getElementById('manual-series-fields');
            if (fields) {
                fields.style.display = type === 'serie' ? 'block' : 'none';
            }
        }

        function toggleAllEpisodesCheck(isChecked) {
            const epBox = document.getElementById('manual-ep-box');
            if (epBox) {
                epBox.style.opacity = isChecked ? '0.4' : '1';
                epBox.style.pointerEvents = isChecked ? 'none' : 'auto';
            }
        }

        function handleTmdbInput(val) {
            if (tmdbSearchTimeout) clearTimeout(tmdbSearchTimeout);
            if (!val || val.trim().length < 2) {
                document.getElementById('tmdb-search-results').style.display = 'none';
                return;
            }
            tmdbSearchTimeout = setTimeout(() => triggerTmdbSearch(), 350);
        }

        async function triggerTmdbSearch() {
            const q = document.getElementById('manual-tmdb-query')?.value?.trim();
            if (!q) return;
            await triggerTmdbSearchWithQuery(q, false);
        }

        async function triggerTmdbSearchWithQuery(q, autoSelectFirst = false) {
            if (!q) return;

            const resultsContainer = document.getElementById('tmdb-search-results');
            if (resultsContainer) {
                resultsContainer.style.display = 'flex';
                resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 12px;">🔍 Buscando no TMDB...</div>';
            }

            try {
                const res = await fetch(`/api/admin/tmdb/search?query=${encodeURIComponent(q)}`, { headers: getAuthHeaders() });
                const data = await res.json();
                const list = data.results || [];

                if (list.length === 0) {
                    if (resultsContainer) resultsContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 12px;">Nenhum resultado encontrado no TMDB. Você pode preencher manualmente.</div>';
                    return;
                }

                if (resultsContainer) {
                    resultsContainer.innerHTML = list.slice(0, 10).map(item => {
                        const poster = item.posterUrl || 'https://via.placeholder.com/92x138/111827/9ca3af?text=Sem+Capa';
                        const ano = item.ano || (item.dataLancamento ? item.dataLancamento.split('-')[0] : '');
                        const tipoBadge = item.tipo === 'serie' ? '📺 Série' : '🎬 Filme';

                        return `
                            <div class="tmdb-result-card" onclick='selectTmdbResult(${JSON.stringify(item).replace(/'/g, "&#39;")})'>
                                <img class="tmdb-result-thumb" src="${poster}" alt="${escapeHtml(item.nome)}">
                                <div class="tmdb-result-info">
                                    <div class="tmdb-result-title">${item.nome}</div>
                                    <div class="tmdb-result-meta">
                                        <span style="background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px;">${tipoBadge}</span>
                                        <span>${ano}</span>
                                        <span>⭐ ${(item.nota || 8.0).toFixed(1)}</span>
                                    </div>
                                </div>
                            </div>
                        `;
                    }).join('');
                }

                if (autoSelectFirst && list.length > 0) {
                    await selectTmdbResult(list[0]);
                }
            } catch (e) {
                if (resultsContainer) resultsContainer.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 12px;">Erro ao consultar TMDB.</div>';
            }
        }

        async function selectTmdbResult(item) {
            document.getElementById('tmdb-search-results').style.display = 'none';

            // Auto preenchimento dos campos principais
            document.getElementById('manual-title').value = item.nome || '';
            document.getElementById('manual-year').value = item.ano || (item.dataLancamento ? item.dataLancamento.split('-')[0] : '2026');
            document.getElementById('manual-type').value = item.tipo === 'serie' ? 'serie' : 'filme';
            document.getElementById('manual-synopsis').value = item.sinopse || item.descricao || '';
            document.getElementById('manual-tmdb-id').value = item.tmdbId || '';
            document.getElementById('manual-imdb-id').value = item.imdbId || '';
            document.getElementById('manual-poster-url').value = item.posterUrl || '';
            document.getElementById('manual-backdrop-url').value = item.backdropUrl || '';
            document.getElementById('manual-original-title').value = item.nomeOriginal || item.nome || '';
            document.getElementById('manual-genres-json').value = JSON.stringify(item.generos || []);
            document.getElementById('manual-rating').value = item.nota || 8.0;

            toggleManualSeriesFields();

            // Exibe card visual do item selecionado
            const card = document.getElementById('tmdb-selected-card');
            if (card) {
                card.style.display = 'flex';
                document.getElementById('sel-poster').src = item.posterUrl || 'https://via.placeholder.com/92x138/111827/9ca3af?text=Capa';
                document.getElementById('sel-title').innerText = item.nome;
                document.getElementById('sel-meta').innerText = `${item.ano || '2026'} • ⭐ ${(item.nota || 8.0).toFixed(1)} • ${item.tipo === 'serie' ? 'Série / Dorama' : 'Filme'}`;
                document.getElementById('sel-overview').innerText = item.sinopse || item.descricao || 'Sem sinopse disponível.';

                const gBox = document.getElementById('sel-genres');
                if (gBox) {
                    gBox.innerHTML = (item.generos || []).map(g => `<span class="genre-pill" style="font-size: 10px;">${g}</span>`).join('');
                }
            }

            // Se for série, busca detalhes de temporadas e episódios
            if (item.tipo === 'serie' && item.tmdbId) {
                try {
                    const res = await fetch(`/api/admin/tmdb/details/${item.tmdbId}?tipo=serie`, { headers: getAuthHeaders() });
                    const det = await res.json();
                    if (det?.details?.imdbId) {
                        document.getElementById('manual-imdb-id').value = det.details.imdbId;
                    }
                } catch (e) { }
            }

            showToast(`Dados de "${item.nome}" preenchidos pelo bot!`, 'success');
        }

        function resetTmdbSelection() {
            document.getElementById('tmdb-selected-card').style.display = 'none';
            document.getElementById('manual-tmdb-query').value = '';
            document.getElementById('manual-tmdb-query').focus();
        }

        async function handleManualMediaFormSubmit(e) {
            e.preventDefault();

            let title = document.getElementById('manual-title').value;
            const ano = document.getElementById('manual-year').value;
            const type = document.getElementById('manual-type').value;
            const audioPref = document.getElementById('manual-audio-pref').value;
            const season = document.getElementById('manual-season').value;
            const episode = document.getElementById('manual-episode').value;
            const allEpisodes = document.getElementById('manual-all-episodes')?.checked || false;
            const priority = document.getElementById('manual-priority').value;
            const synopsis = document.getElementById('manual-synopsis').value;

            const tmdbId = document.getElementById('manual-tmdb-id').value;
            const imdbId = document.getElementById('manual-imdb-id').value;
            const posterUrl = document.getElementById('manual-poster-url').value;
            const backdropUrl = document.getElementById('manual-backdrop-url').value;
            const nomeOriginal = document.getElementById('manual-original-title').value;
            const rating = document.getElementById('manual-rating').value;

            let generos = [];
            try { generos = JSON.parse(document.getElementById('manual-genres-json').value || '[]'); } catch (err) { }

            const magnetUrl = document.getElementById('manual-magnet-url').value;
            const messageId = document.getElementById('manual-message-id').value;
            const fileId = document.getElementById('manual-file-id').value;
            const qualidade = document.getElementById('manual-qualidade').value;
            const audioDirect = document.getElementById('manual-audio-direct').value;

            // Se o modo for UPLOAD DE ARQUIVO LOCAL
            if (currentManualActionMode === 'upload') {
                const fileInput = document.getElementById('manual-video-file');
                const file = fileInput?.files?.[0];
                if (!file) {
                    showToast('Selecione um arquivo de vídeo do seu computador.', 'error');
                    return;
                }

                if (!title || !title.trim()) {
                    title = file.name.replace(/\.[a-zA-Z0-9]{2,4}$/, '');
                }

                const token = adminToken || adminToken;
                const progressBox = document.getElementById('upload-progress-box');
                const progressBar = document.getElementById('upload-progress-bar');
                const progressPct = document.getElementById('upload-progress-pct');
                const progressText = document.getElementById('upload-progress-text');
                const submitBtn = document.getElementById('manual-submit-btn');

                if (progressBox) progressBox.style.display = 'block';
                if (progressText) progressText.innerText = 'Iniciando upload em fatias seguras...';
                if (submitBtn) {
                    submitBtn.disabled = true;
                    submitBtn.innerText = '⏳ Enviando arquivo em partes...';
                }

                const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB por fatia (Bypassa limites de 100MB do Cloudflare e proxies)
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                const uploadId = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

                try {
                    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
                        const start = chunkIndex * CHUNK_SIZE;
                        const end = Math.min(file.size, start + CHUNK_SIZE);
                        const chunkBlob = file.slice(start, end);

                        const formData = new FormData();
                        formData.append('chunk', chunkBlob, file.name);
                        formData.append('uploadId', uploadId);
                        formData.append('chunkIndex', chunkIndex);
                        formData.append('totalChunks', totalChunks);
                        formData.append('fileName', file.name);

                        // No último chunk, anexa todos os metadados
                        if (chunkIndex === totalChunks - 1) {
                            formData.append('title', title);
                            formData.append('ano', ano || '2026');
                            formData.append('type', type);
                            formData.append('audioPreference', audioPref);
                            formData.append('priority', priority || '1');
                            formData.append('season', season || '1');
                            formData.append('episode', episode || '1');
                            formData.append('sinopse', synopsis || '');
                            if (tmdbId) formData.append('tmdbId', tmdbId);
                            if (imdbId) formData.append('imdbId', imdbId);
                            formData.append('posterUrl', posterUrl || '');
                            formData.append('backdropUrl', backdropUrl || '');
                            formData.append('nomeOriginal', nomeOriginal || title);
                            formData.append('generos', JSON.stringify(generos));
                            formData.append('nota', rating || '8.0');
                        }

                        const pct = Math.round(((chunkIndex + 1) / totalChunks) * 100);
                        if (progressText) {
                            if (pct >= 100) {
                                progressText.innerText = '⏳ Finalizando montagem e indexando metadados no servidor...';
                            } else {
                                progressText.innerText = `Enviando parte ${chunkIndex + 1} de ${totalChunks} (${pct}%)...`;
                            }
                        }
                        if (progressBar) progressBar.style.width = `${pct}%`;
                        if (progressPct) progressPct.innerText = `${pct}%`;

                        const res = await fetch('/api/admin/catalogo/upload-chunk', {
                            method: 'POST',
                            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
                            body: formData
                        });

                        if (!res.ok) {
                            let errJson = {};
                            try { errJson = await res.json(); } catch (e) { }
                            throw new Error(errJson.error || `Erro HTTP ${res.status} ao enviar parte ${chunkIndex + 1}`);
                        }

                        const data = await res.json();
                        if (data.completed) {
                            if (progressText) progressText.innerText = '✅ Upload 100% concluído com sucesso!';
                            if (progressBar) progressBar.style.background = '#10b981';
                            showToast(data.message || 'Arquivo enviado com sucesso e adicionado ao topo da fila!', 'success');

                            setTimeout(() => {
                                if (progressBox) progressBox.style.display = 'none';
                                if (submitBtn) {
                                    submitBtn.disabled = false;
                                    submitBtn.innerText = '📁 Enviar Arquivo e Processar no Robô';
                                }
                                closeAdminModal('admin-modal-add-job');
                                switchAdminSubTab('queue');
                                loadAdminQueue();
                                loadAdminCatalog();
                                loadAdminStats();
                            }, 1000);
                            return;
                        }
                    }
                } catch (err) {
                    console.error('Falha no upload chunked:', err);
                    if (progressBox) progressBox.style.display = 'none';
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerText = '📁 Enviar Arquivo e Processar no Robô';
                    }
                    showToast(err.message || 'Falha ao enviar arquivo em partes.', 'error');
                }
                return;
            }

            const payload = {
                action: currentManualActionMode,
                title,
                ano,
                type,
                audioPreference: audioPref,
                priority: parseInt(priority, 10),
                season: parseInt(season || 1, 10),
                episode: parseInt(episode || 1, 10),
                allEpisodes,
                sinopse: synopsis,
                tmdbId: tmdbId ? parseInt(tmdbId, 10) : null,
                imdbId,
                posterUrl,
                backdropUrl,
                nomeOriginal,
                generos,
                nota: parseFloat(rating || 8.0),
                magnetUrl,
                messageId: messageId ? parseInt(messageId, 10) : null,
                fileId,
                qualidade,
                audio: audioDirect
            };

            try {
                const res = await fetch('/api/admin/catalogo/manual-add', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Mídia cadastrada/enfileirada com sucesso!', 'success');
                closeAdminModal('admin-modal-add-job');
                loadAdminQueue();
                loadAdminCatalog();
                loadAdminStats();
            } catch (err) {
                showToast(err.message || 'Erro ao processar mídia.', 'error');
            }
        }

        async function loadAdminSubs() {
            if (!adminToken) return;
            const tbody = document.getElementById('admin-subs-tbody');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/assinaturas', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const list = data.assinaturas || [];

                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhuma assinatura cadastrada.</td></tr>';
                    return;
                }

                tbody.innerHTML = list.map(a => {
                    const isAtiva = a.status === 'ativa';
                    const venc = a.dataVencimento ? new Date(a.dataVencimento).toLocaleDateString('pt-BR') : 'Vitalício';
                    const ini = a.dataInicio ? new Date(a.dataInicio).toLocaleDateString('pt-BR') : '-';

                    return `
                        <tr>
                            <td>
                                <strong>@${a.username || 'Usuário'}</strong>
                                <div style="font-size: 11px; color: var(--text-muted);">ID: ${a.userId || a.id}</div>
                            </td>
                            <td><span class="badge-priority" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border-color: rgba(245, 158, 11, 0.4);">${(a.plano || 'mensal').toUpperCase()}</span></td>
                            <td>${ini}</td>
                            <td>${venc}</td>
                            <td>
                                <span style="color: ${isAtiva ? '#34d399' : '#ef4444'}; font-weight: 800; font-size: 11px;">
                                    ${isAtiva ? '✓ ATIVA' : '✕ EXPIRADA'}
                                </span>
                            </td>
                            <td style="text-align: right;">
                                <button class="btn-action btn-action-danger" onclick="handleRevokeSub('${a.userId || a.username}')">
                                    Revogar
                                </button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 20px;">Falha ao carregar assinaturas.</td></tr>';
            }
        }

        async function handleAdminGrantSub(e) {
            e.preventDefault();
            const user = document.getElementById('grant-user').value;
            const plano = document.getElementById('grant-plan').value;
            const dias = document.getElementById('grant-days').value;

            try {
                const isId = /^\d+$/.test(user.trim());
                const res = await fetch('/api/admin/assinaturas/grant', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        userId: isId ? user.trim() : null,
                        username: !isId ? user.trim() : null,
                        plano,
                        dias
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Assinatura concedida com sucesso!', 'success');
                closeAdminModal('admin-modal-grant-sub');
                loadAdminSubs();
            } catch (err) {
                showToast(err.message || 'Erro ao conceder assinatura.', 'error');
            }
        }

        async function handleRevokeSub(identificador) {
            if (!confirm(`Revogar acesso VIP de "${identificador}"?`)) return;
            try {
                const res = await fetch('/api/admin/assinaturas/revoke', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ identifier: identificador })
                });
                if (!res.ok) throw new Error();
                showToast('Acesso revogado.', 'info');
                loadAdminSubs();
            } catch (e) {
                showToast('Erro ao revogar acesso.', 'error');
            }
        }

        async function loadAdminTokens() {
            if (!adminToken) return;
            const tbody = document.getElementById('admin-tokens-tbody');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/stremio-tokens', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const list = data.tokens || [];

                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhum token ou link do Stremio gerado ainda.</td></tr>';
                    return;
                }

                tbody.innerHTML = list.map(t => {
                    const isAtivo = t.ativo;
                    const dataStr = t.created_at ? new Date(t.created_at).toLocaleDateString('pt-BR') : '-';
                    const fullLink = `https://${window.location.host}/${t.token}/manifest.json`;

                    return `
                        <tr>
                            <td>
                                <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #38bdf8;">${t.token}</div>
                                <div style="font-size: 11px; color: var(--text-muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${fullLink}</div>
                            </td>
                            <td><strong>${t.username || 'VIP / Convidado'}</strong></td>
                            <td><span class="badge-priority" style="background: rgba(168, 85, 247, 0.2); color: #c084fc; border-color: rgba(168, 85, 247, 0.4);">${(t.tipo || 'vitalicio').toUpperCase()}</span></td>
                            <td>${dataStr}</td>
                            <td>
                                <span style="color: ${isAtivo ? '#34d399' : '#ef4444'}; font-weight: 800; font-size: 11px;">
                                    ${isAtivo ? '✓ ATIVO' : '✕ INATIVO'}
                                </span>
                            </td>
                            <td style="text-align: right; white-space: nowrap;">
                                <div style="display: inline-flex; gap: 4px;">
                                    <button class="btn-action" onclick="copyTokenLink('${t.token}')" title="Copiar Link do Addon">📋 Copiar</button>
                                    <button class="btn-action" onclick="handleToggleToken('${t.token}')" title="Alternar Ativo/Inativo">${isAtivo ? '⏸️ Pausar' : '▶️ Ativar'}</button>
                                    <button class="btn-action btn-action-danger" onclick="handleRevokeToken('${t.token}')" title="Revogar e Excluir Link">🗑️ Revogar</button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 20px;">Falha ao carregar tokens do Stremio.</td></tr>';
            }
        }

        function copyTokenLink(token) {
            const link = `https://${window.location.host}/${token}/manifest.json`;
            navigator.clipboard.writeText(link).then(() => {
                showToast('Link do Addon copiado com sucesso!', 'success');
            }).catch(() => {
                prompt('Copie o link do Addon abaixo:', link);
            });
        }

        async function handleToggleToken(token) {
            try {
                const res = await fetch(`/api/admin/stremio-tokens/${token}/toggle`, {
                    method: 'PUT',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Status do token atualizado!', 'success');
                loadAdminTokens();
            } catch (e) {
                showToast('Erro ao alternar status do token.', 'error');
            }
        }

        async function handleRevokeToken(token) {
            if (!confirm(`Deseja realmente revogar e excluir o link do token "${token}"? O acesso será bloqueado imediatamente.`)) return;
            try {
                const res = await fetch(`/api/admin/stremio-tokens/${token}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Token e link revogados com sucesso!', 'info');
                loadAdminTokens();
                loadAdminSubs();
            } catch (e) {
                showToast('Erro ao revogar token.', 'error');
            }
        }

        async function handleAdminGenerateToken(e) {
            e.preventDefault();
            const username = document.getElementById('token-username').value;

            try {
                const res = await fetch('/api/admin/stremio-tokens/generate', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ username })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                const fullUrl = `https://${window.location.host}/${data.token}/manifest.json`;
                navigator.clipboard.writeText(fullUrl).catch(() => { });
                prompt('✅ Token Stremio VIP gerado com sucesso! Copie o link do Addon:', fullUrl);
                closeAdminModal('admin-modal-token');
                loadAdminTokens();
            } catch (err) {
                showToast('Erro ao gerar token.', 'error');
            }
        }

        function updatePublicStremioUrls() {
            const tokenInput = document.getElementById('public-stremio-token');
            const urlText = document.getElementById('public-manifest-url-text');
            const installBtn = document.getElementById('public-btn-install-stremio');
            if (!tokenInput || !urlText || !installBtn) return;

            const rawToken = tokenInput.value.trim();
            const host = window.location.host;
            const tokenPart = rawToken ? `${rawToken}/` : '';

            const httpUrl = `https://${host}/${tokenPart}manifest.json`;
            const stremioUrl = `stremio://${host}/${tokenPart}manifest.json`;

            urlText.innerText = httpUrl;
            installBtn.href = stremioUrl;
        }

        function copyPublicManifestUrl() {
            const urlText = document.getElementById('public-manifest-url-text');
            if (!urlText) return;
            const text = urlText.innerText;
            navigator.clipboard.writeText(text).then(() => {
                showToast('Link do Addon copiado com sucesso!', 'success');
            }).catch(() => {
                prompt('Copie o link do Addon abaixo:', text);
            });
        }

        async function loadAdminRequests() {
            if (!adminToken) return;
            const tbody = document.getElementById('admin-requests-tbody');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/pedidos', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const list = data.pedidos || [];

                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhum pedido de usuário registrado.</td></tr>';
                    return;
                }

                tbody.innerHTML = list.slice(-50).reverse().map(p => {
                    const status = p.status || (p.processado ? 'adicionado' : 'pendente');
                    const isProc = status === 'adicionado';
                    const isProcessing = status === 'em_processamento' || status === 'na_fila';
                    const dataStr = p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '-';

                    let statusLabel = '⏳ PENDENTE';
                    let statusColor = '#f59e0b';
                    if (isProc) {
                        statusLabel = '✓ ATENDIDO';
                        statusColor = '#34d399';
                    } else if (isProcessing) {
                        statusLabel = '⚡ NA FILA';
                        statusColor = '#38bdf8';
                    } else if (status === 'recusado') {
                        statusLabel = '✕ RECUSADO';
                        statusColor = '#f87171';
                    }

                    return `
                        <tr>
                            <td>
                                <strong>${p.nome}</strong>
                                <div style="font-size: 10px; color: var(--text-muted);">${p.tipo === 'serie' ? '📺 Série' : (p.tipo === 'anime' ? '🌸 Anime' : (p.tipo === 'dorama' ? '🇰🇷 Dorama' : '🎬 Filme'))}</div>
                            </td>
                            <td>
                                <div>@${p.username || 'Usuário'}</div>
                                <span style="font-size: 10px; color: ${p.isAssinante ? '#fbbf24' : '#9ca3af'}; font-weight: 700;">
                                    ${p.isAssinante ? '👑 VIP Assinante' : '👤 Usuário Grátis'}
                                </span>
                            </td>
                            <td>
                                <span style="color: ${statusColor}; font-weight: 800; font-size: 11px;">
                                    ${statusLabel}
                                </span>
                            </td>
                            <td>${dataStr}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                ${!isProc && !isProcessing ? `<button class="btn-action btn-action-primary" onclick="handleEnqueueRequest('${p.id}')">🚀 Baixar Agora</button>` : ''}
                                <button class="btn-action btn-action-danger" onclick="handleDeleteRequest('${p.id}')">✕</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #ef4444; padding: 20px;">Falha ao carregar pedidos.</td></tr>';
            }
        }

        async function handleEnqueueRequest(pedidoId) {
            try {
                const res = await fetch(`/api/admin/pedidos/${pedidoId}/enfileirar`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ priority: 1 })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Pedido enviado para a fila!', 'success');
                loadAdminRequests();
                loadAdminQueue();
            } catch (err) {
                showToast('Erro ao enfileirar pedido.', 'error');
            }
        }

        async function handleDeleteRequest(pedidoId) {
            if (!confirm('Remover este pedido?')) return;
            try {
                const res = await fetch(`/api/admin/pedidos/${pedidoId}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Pedido removido.', 'info');
                loadAdminRequests();
            } catch (e) {
                showToast('Erro ao remover pedido.', 'error');
            }
        }

        function formatCatalogDate(dateStr) {
            if (!dateStr) return '—';
            try {
                const d = new Date(dateStr);
                if (isNaN(d.getTime())) return '—';
                return d.toLocaleDateString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });
            } catch (e) {
                return '—';
            }
        }

        let adminRemovalPollingTimer = null;
        let adminCatalogPollingTimer = null;
        let adminCatalogLastVersion = null;

        function startRemovalQueuePolling() {
            if (adminRemovalPollingTimer) clearInterval(adminRemovalPollingTimer);
            loadRemovalQueueStats();
            adminRemovalPollingTimer = setInterval(() => {
                if (!document.hidden && adminToken) {
                    const content = document.getElementById('admin-subtab-catalog');
                    if (content && content.style.display !== 'none') {
                        loadRemovalQueueStats();
                    }
                }
            }, 3500);
        }

        function startCatalogAutoSync() {
            if (adminCatalogPollingTimer) clearInterval(adminCatalogPollingTimer);
            adminCatalogPollingTimer = setInterval(async () => {
                if (document.hidden || !adminToken) return;
                const content = document.getElementById('admin-subtab-catalog');
                if (!content || content.style.display === 'none') return;
                try {
                    const r = await fetch('/api/catalogo/version', { headers: getAuthHeaders() });
                    if (!r.ok) return;
                    const { version } = await r.json();
                    if (version && adminCatalogLastVersion !== null && String(version) !== String(adminCatalogLastVersion)) {
                        console.log('[AdminCatalog] Vers\u00e3o alterada, recarregando cat\u00e1logo automaticamente...');
                        adminCatalogLastVersion = String(version);
                        await loadAdminCatalogSilent();
                    } else if (adminCatalogLastVersion === null) {
                        adminCatalogLastVersion = String(version);
                    }
                } catch (_) { }
            }, 30000); // Verifica a cada 30s
        }

        async function loadAdminCatalogSilent() {
            if (!adminToken) return;
            try {
                const res = await fetch('/api/admin/catalogo', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const newData = await res.json();
                adminCatalogData = newData;
                renderAdminCatalog();
                if (currentModalSerieId) renderAdminSerieModalContent();
            } catch (_) { }
        }

        function stopRemovalQueuePolling() {
            if (adminRemovalPollingTimer) {
                clearInterval(adminRemovalPollingTimer);
                adminRemovalPollingTimer = null;
            }
        }

        function stopCatalogAutoSync() {
            if (adminCatalogPollingTimer) {
                clearInterval(adminCatalogPollingTimer);
                adminCatalogPollingTimer = null;
            }
        }

        async function loadRemovalQueueStats() {
            try {
                const res = await fetch('/api/admin/remocoes/stats', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const stats = await res.json();
                const card = document.getElementById('admin-removal-queue-status-card');
                const text = document.getElementById('admin-removal-queue-stats-text');
                const retryBtn = document.getElementById('admin-removal-retry-btn');
                if (!card || !text) return;

                const total = Number(stats.total || 0);
                const pendentes = Number(stats.pendentes || 0);
                const processando = Number(stats.processando || 0);
                const falhas = Number(stats.falhas || 0);

                if (total > 0 && (pendentes > 0 || processando > 0 || falhas > 0)) {
                    card.style.display = 'flex';
                    text.innerHTML = `<strong>${processando + pendentes}</strong> aguardando exclusão remota (${processando} em lote, ${pendentes} na fila)${falhas > 0 ? ` • <span style="color:#ef4444; font-weight:700;">${falhas} com falha</span>` : ''}`;
                    if (retryBtn) retryBtn.style.display = falhas > 0 ? 'inline-flex' : 'none';
                } else {
                    card.style.display = 'none';
                }
            } catch (_) { }
        }

        async function handleRetryRemovalFailures() {
            try {
                const res = await fetch('/api/admin/remocoes/retry-failures', { method: 'POST', headers: getAuthHeaders() });
                const d = await res.json();
                showToast(d.message || 'Falhas reenfileiradas para nova tentativa.', 'info');
                loadRemovalQueueStats();
            } catch (e) {
                showToast('Erro ao reenfileirar falhas.', 'error');
            }
        }

        async function loadAdminCatalog() {
            if (!adminToken) return;
            startRemovalQueuePolling();
            startCatalogAutoSync();
            adminCatalogLastVersion = null; // reseta versão para detectar mudanças futuras
            const container = document.getElementById('admin-catalog-cards-container') || document.getElementById('admin-catalog-tbody');
            if (container && (!adminCatalogData?.filmes?.length && !adminCatalogData?.series?.length)) {
                container.innerHTML = '<div style="text-align: center; padding: 36px 16px; color: var(--text-muted);"><div class="spinner" style="margin: 0 auto 12px; width: 28px; height: 28px; border: 3px solid rgba(255,255,255,0.1); border-top-color: #10b981; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>Carregando catálogo detalhado...</div>';
            }
            try {
                const res = await fetch('/api/admin/catalogo', { headers: getAuthHeaders() });
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    if (container) container.innerHTML = `<div style="text-align: center; padding: 32px 16px; color: #ef4444;">⚠️ Falha ao obter dados do catálogo: ${err.error || res.statusText}</div>`;
                    return;
                }
                adminCatalogData = await res.json();
                renderAdminCatalog();
                if (currentModalSerieId) {
                    renderAdminSerieModalContent();
                }
            } catch (e) {
                console.error('Erro ao carregar catálogo:', e);
                if (container) container.innerHTML = `<div style="text-align: center; padding: 32px 16px; color: #ef4444;">⚠️ Erro de conexão com o servidor ao carregar catálogo.</div>`;
            }
        }

        let currentModalSerieId = null;
        let currentModalSeasonFilter = 'all';

        function openAdminSerieEpisodesModal(serieId) {
            const s = (adminCatalogData.series || []).find(item => String(item.id) === String(serieId));
            if (!s) {
                showToast('Série não encontrada.', 'error');
                return;
            }
            currentModalSerieId = serieId;
            currentModalSeasonFilter = 'all';

            const modal = document.getElementById('admin-modal-serie-episodes');
            const posterEl = document.getElementById('admin-modal-serie-poster');
            const titleEl = document.getElementById('admin-modal-serie-title');
            const subEl = document.getElementById('admin-modal-serie-subtitle');
            const searchInput = document.getElementById('admin-modal-serie-search');

            if (posterEl) posterEl.src = s.posterUrl || '/logo.jpg';
            if (titleEl) titleEl.innerText = s.nome;

            const totalEps = (s.temporadas || []).reduce((acc, t) => acc + (t.episodios || []).length, 0);
            if (subEl) subEl.innerHTML = `${(s.temporadas || []).length} temporadas • ${totalEps} episódios cadastrados • TMDB: ${s.tmdbId || '-'}`;
            if (searchInput) searchInput.value = '';

            renderAdminSerieModalContent();
            if (modal) modal.classList.add('active');
        }

        function setAdminModalSeasonFilter(seasonNum) {
            currentModalSeasonFilter = String(seasonNum);
            document.querySelectorAll('.admin-serie-season-pill').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-season') === currentModalSeasonFilter);
            });
            renderAdminSerieModalContent();
        }

        function filterAdminSerieModalEpisodes() {
            renderAdminSerieModalContent();
        }

        function renderAdminSerieModalContent() {
            const s = (adminCatalogData.series || []).find(item => String(item.id) === String(currentModalSerieId));
            const list = document.getElementById('admin-modal-serie-episodes-list');
            const pillsContainer = document.getElementById('admin-modal-serie-season-pills');
            const searchInput = document.getElementById('admin-modal-serie-search');
            if (!s || !list) {
                if (!s && currentModalSerieId) {
                    closeAdminModal('admin-modal-serie-episodes');
                }
                return;
            }

            const q = (searchInput?.value || '').toLowerCase().trim();

            // Monta as pills de temporadas
            if (pillsContainer) {
                let pillsHtml = `<button class="admin-serie-season-pill ${currentModalSeasonFilter === 'all' ? 'active' : ''}" data-season="all" onclick="setAdminModalSeasonFilter('all')">Todas</button>`;
                (s.temporadas || []).forEach(t => {
                    const count = (t.episodios || []).length;
                    pillsHtml += `<button class="admin-serie-season-pill ${currentModalSeasonFilter === String(t.numero) ? 'active' : ''}" data-season="${t.numero}" onclick="setAdminModalSeasonFilter('${t.numero}')">T${t.numero} (${count})</button>`;
                });
                pillsContainer.innerHTML = pillsHtml;
            }

            let episodesToShow = [];
            (s.temporadas || []).forEach(t => {
                if (currentModalSeasonFilter !== 'all' && String(t.numero) !== currentModalSeasonFilter) return;
                (t.episodios || []).forEach(e => {
                    if (q) {
                        const nameMatch = (e.nome || '').toLowerCase().includes(q);
                        const numMatch = `t${t.numero}e${e.numero}`.includes(q) || `e${e.numero}` === q || String(e.numero) === q;
                        const idMatch = String(e.id) === q || String(e.messageId) === q;
                        if (!nameMatch && !numMatch && !idMatch) return;
                    }
                    episodesToShow.push({ ...e, temporadaNumero: t.numero });
                });
            });

            if (episodesToShow.length === 0) {
                list.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 24px;">Nenhum episódio localizado com os filtros selecionados.</div>';
                return;
            }

            list.innerHTML = episodesToShow.map(e => {
                const epDub = !!e.isDublado || !!(e.versoes?.dublado?.messageId || e.versoes?.dublado?.fileId);
                const epLeg = !!e.isLegendado || !!(e.versoes?.legendado?.messageId || e.versoes?.legendado?.fileId);
                const epAudBadge = (epDub && epLeg) ? '<span class="badge-completed" style="font-size:10px; padding:2px 6px;">Dual (Dub+Leg)</span>' : (epDub ? '<span class="badge-completed" style="font-size:10px; padding:2px 6px;">🔊 Dublado</span>' : (epLeg ? '<span class="badge-processing" style="font-size:10px; padding:2px 6px;">💬 Legendado</span>' : ''));

                let epRebaixarBtns = '';
                if (epDub && epLeg) {
                    epRebaixarBtns = `
                            <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${e.id || e.messageId}', true, 'dublado')" title="Rebaixar apenas Dublado">
                                🔄 Dub
                            </button>
                            <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${e.id || e.messageId}', true, 'legendado')" title="Rebaixar apenas Legendado">
                                🔄 Leg
                            </button>
                        `;
                } else if (epLeg && !epDub) {
                    epRebaixarBtns = `
                            <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${e.id || e.messageId}', true, 'legendado')" title="Rebaixar Legendado">
                                🔄 Leg
                            </button>
                        `;
                } else {
                    epRebaixarBtns = `
                            <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${e.id || e.messageId}', true, 'dublado')" title="Rebaixar Dublado">
                                🔄 Dub
                            </button>
                        `;
                }

                return `
                        <div class="admin-modal-episode-row">
                            <div style="display:flex; align-items:center; gap:8px; overflow:hidden; flex:1; min-width:240px; flex-wrap:wrap;">
                                <strong style="color:#fbbf24; font-size:13px; white-space:nowrap;">T${e.temporadaNumero}E${e.numero}</strong>
                                <span style="color:#fff; font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${e.nome || `Episódio ${e.numero}`}</span>
                                ${epAudBadge}
                                <span class="admin-catalog-meta-pill" style="color:#94a3b8;" title="Data de inclusão do episódio">🕒 ${formatCatalogDate(e.dataAdicionado || e.createdAt)}</span>
                                <span style="font-size:11px; color:var(--text-muted); white-space:nowrap;">(Msg: ${e.messageId || '-'})</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:4px; flex-shrink:0;">
                                ${epRebaixarBtns}
                                <button class="btn-action btn-action-danger btn-icon-compact" onclick="handleDeleteEpisode('${e.id || e.messageId}', false)" title="Excluir Episódio Definitivo">
                                    🗑️
                                </button>
                            </div>
                        </div>
                    `;
            }).join('');
        }

        function renderAdminCatalog() {
            const container = document.getElementById('admin-catalog-cards-container') || document.getElementById('admin-catalog-tbody');
            if (!container) return;

            const searchEl = document.getElementById('admin-catalog-search');
            if (searchEl && searchEl.value.trim().toLowerCase() === 'admin') {
                searchEl.value = '';
            }
            const q = (searchEl?.value || '').toLowerCase().trim();
            const typeFilter = document.getElementById('admin-catalog-type-filter')?.value || 'all';
            const statusFilter = document.getElementById('admin-catalog-status-filter')?.value || 'all';
            const audioFilter = document.getElementById('admin-catalog-audio-filter')?.value || 'all';
            const dateFilter = document.getElementById('admin-catalog-date-filter')?.value || 'all';

            // SE O USUÁRIO FILTROU POR DATA: Exibe adições detalhadas por episódio e filme!
            if (dateFilter !== 'all') {
                renderAdminCatalogRecentAdditions(container, { q, typeFilter, statusFilter, audioFilter, dateFilter });
                return;
            }

            // CASO CONTRÁRIO (Todas as datas): Exibe catálogo agrupado em cards fluidos
            renderAdminCatalogGroupedCards(container, { q, typeFilter, statusFilter, audioFilter });
        }

        function renderAdminCatalogRecentAdditions(container, { q, typeFilter, statusFilter, audioFilter, dateFilter }) {
            const now = new Date();
            let cutoff = new Date(0);
            let labelPeriodo = 'Período Selecionado';
            if (dateFilter === 'today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                labelPeriodo = 'Adicionados Hoje';
            } else if (dateFilter === 'yesterday_today') {
                cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
                labelPeriodo = 'Ontem e Hoje';
            } else if (dateFilter === '7days') {
                cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                labelPeriodo = 'Últimos 7 dias';
            } else if (dateFilter === '30days') {
                cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
                labelPeriodo = 'Últimos 30 dias';
            }

            const additions = [];

            // 1. Filmes adicionados no período
            (adminCatalogData.filmes || []).forEach(f => {
                const fDate = f.dataAdicionado || f.createdAt;
                const fTime = fDate ? new Date(fDate).getTime() : 0;
                if (fTime >= cutoff.getTime()) {
                    additions.push({
                        kind: 'filme',
                        id: f.id,
                        nome: f.nome,
                        nomeOriginal: f.nomeOriginal,
                        poster: f.posterUrl || '/logo.jpg',
                        ano: f.ano || '2026',
                        qualidade: f.qualidade || '1080p',
                        dataAdicionado: fDate,
                        timestamp: fTime,
                        isAnime: !!f.isAnime,
                        isDorama: !!f.isDorama,
                        isDublado: !!(f.isDublado || f.versoes?.dublado),
                        isLegendado: !!(f.isLegendado || f.versoes?.legendado),
                        versoes: f.versoes || {},
                        messageId: f.messageId || f.versoes?.dublado?.messageId || f.versoes?.legendado?.messageId || null,
                        hasTelegramLink: !!f.hasTelegramLink
                    });
                }
            });

            // 2. Episódios específicos adicionados no período
            (adminCatalogData.series || []).forEach(s => {
                (s.temporadas || []).forEach(t => {
                    (t.episodios || []).forEach(e => {
                        const epDate = e.dataAdicionado || e.createdAt;
                        const epTime = epDate ? new Date(epDate).getTime() : 0;
                        if (epTime >= cutoff.getTime()) {
                            additions.push({
                                kind: 'episodio',
                                id: e.id || e.messageId,
                                serieId: s.id,
                                serieNome: s.nome,
                                temporadaNum: t.numero,
                                episodioNum: e.numero,
                                episodioNome: e.nome || `Episódio ${e.numero}`,
                                poster: s.posterUrl || '/logo.jpg',
                                ano: s.ano || '2026',
                                qualidade: e.qualidade || s.qualidade || '1080p',
                                dataAdicionado: epDate,
                                timestamp: epTime,
                                isAnime: !!s.isAnime,
                                isDorama: !!s.isDorama,
                                isMicrodrama: !!s.isMicrodrama,
                                isDublado: !!(e.isDublado || e.versoes?.dublado),
                                isLegendado: !!(e.isLegendado || e.versoes?.legendado),
                                versoes: e.versoes || {},
                                messageId: e.messageId || e.versoes?.dublado?.messageId || e.versoes?.legendado?.messageId || null,
                                hasTelegramLink: !!e.hasTelegramLink
                            });
                        }
                    });
                });
            });

            // Filtros adicionais
            let filtered = additions;

            if (typeFilter !== 'all') {
                if (typeFilter === 'filme') {
                    filtered = filtered.filter(i => i.kind === 'filme' && !i.isAnime);
                } else if (typeFilter === 'serie') {
                    filtered = filtered.filter(i => i.kind === 'episodio' && !i.isAnime && !i.isDorama && !i.isMicrodrama);
                } else if (typeFilter === 'anime') {
                    filtered = filtered.filter(i => i.isAnime);
                } else if (typeFilter === 'dorama') {
                    filtered = filtered.filter(i => i.isDorama);
                } else if (typeFilter === 'microdrama') {
                    filtered = filtered.filter(i => i.isMicrodrama);
                }
            }

            if (audioFilter !== 'all') {
                if (audioFilter === 'dublado') {
                    filtered = filtered.filter(i => i.isDublado);
                } else if (audioFilter === 'legendado') {
                    filtered = filtered.filter(i => i.isLegendado);
                }
            }

            if (q) {
                filtered = filtered.filter(i => {
                    if (i.kind === 'filme') {
                        return (i.nome || '').toLowerCase().includes(q) || String(i.id) === q;
                    } else {
                        return (i.serieNome || '').toLowerCase().includes(q) ||
                            (i.episodioNome || '').toLowerCase().includes(q) ||
                            `t${i.temporadaNum}e${i.episodioNum}`.toLowerCase().includes(q) ||
                            String(i.id) === q;
                    }
                });
            }

            // Ordena pelo timestamp mais recente
            filtered.sort((a, b) => b.timestamp - a.timestamp);

            if (filtered.length === 0) {
                container.innerHTML = `
                        <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 12px; padding: 14px 18px; margin-bottom: 12px; font-size: 13px; color: #93c5fd; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                            <span>📅 <strong>${labelPeriodo}</strong>: Nenhum episódio ou filme novo adicionado neste período.</span>
                            <button class="btn-action btn-icon-compact" style="font-size: 11px;" onclick="document.getElementById('admin-catalog-date-filter').value='all'; renderAdminCatalog();">Ver Catálogo Completo</button>
                        </div>
                    `;
                return;
            }

            let html = `
                    <div style="background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 12px; padding: 12px 18px; margin-bottom: 12px; font-size: 13px; color: #93c5fd; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
                        <span>📅 <strong>${labelPeriodo}</strong>: Encontrados <strong>${filtered.length}</strong> itens/episódios incluídos no catálogo recentemente.</span>
                        <span style="font-size: 11px; color: #cbd5e1;">Ordenado pelo mais recente</span>
                    </div>
                `;

            html += filtered.map(item => {
                const poster = item.poster || '/logo.jpg';
                const hasDub = item.isDublado;
                const hasLeg = item.isLegendado;
                const versaoBadge = (hasDub && hasLeg)
                    ? '<span class="badge-completed">Dual (Dub+Leg)</span>'
                    : (hasDub
                        ? '<span class="badge-completed">🔊 Dublado</span>'
                        : (hasLeg ? '<span class="badge-processing">💬 Legendado</span>' : '<span style="color:var(--text-muted); font-size:11px;">Nacional</span>'));

                const tgBadge = item.hasTelegramLink || item.messageId
                    ? `<span class="admin-catalog-meta-pill" style="color:#10b981;">📱 Msg #${item.messageId || 'OK'}</span>`
                    : `<span class="admin-catalog-meta-pill" style="color:#f59e0b;">⚠️ Sem TG</span>`;

                let rebaixarBtns = '';
                if (item.kind === 'filme') {
                    if (hasDub && hasLeg) {
                        rebaixarBtns = `
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${item.id}', 'filme', true, 'dublado')" title="Rebaixar apenas Dublado">🔄 Dub</button>
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${item.id}', 'filme', true, 'legendado')" title="Rebaixar apenas Legendado">🔄 Leg</button>
                            `;
                    } else if (hasLeg && !hasDub) {
                        rebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${item.id}', 'filme', true, 'legendado')" title="Rebaixar Legendado">🔄 Leg</button>`;
                    } else {
                        rebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${item.id}', 'filme', true, 'dublado')" title="Rebaixar Dublado">🔄 Dub</button>`;
                    }
                } else {
                    if (hasDub && hasLeg) {
                        rebaixarBtns = `
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${item.id}', true, 'dublado')" title="Rebaixar apenas Dublado">🔄 Dub</button>
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${item.id}', true, 'legendado')" title="Rebaixar apenas Legendado">🔄 Leg</button>
                            `;
                    } else if (hasLeg && !hasDub) {
                        rebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${item.id}', true, 'legendado')" title="Rebaixar Legendado">🔄 Leg</button>`;
                    } else {
                        rebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteEpisode('${item.id}', true, 'dublado')" title="Rebaixar Dublado">🔄 Dub</button>`;
                    }
                }

                const deleteBtn = item.kind === 'filme'
                    ? `<button class="btn-action btn-action-danger btn-icon-compact" onclick="handleDeleteCatalogItem('${item.id}', 'filme', false)" title="Excluir Filme Completo">🗑️</button>`
                    : `<button class="btn-action btn-action-danger btn-icon-compact" onclick="handleDeleteEpisode('${item.id}', false)" title="Excluir Apenas Este Episódio">🗑️</button>`;

                const openSerieBtn = item.kind === 'episodio'
                    ? `<button class="btn-action btn-action-primary btn-icon-compact" onclick="openAdminSerieEpisodesModal('${item.serieId}')" title="Ver todos os episódios desta série">📂 Ver Série</button>`
                    : '';

                const titleHtml = item.kind === 'episodio'
                    ? `<span style="color:#60a5fa; font-weight:700;">${item.serieNome}</span> <span style="color:var(--text-muted); font-size:12px;">•</span> <span style="background:rgba(59,130,246,0.18); color:#93c5fd; padding:1px 6px; border-radius:5px; font-weight:800; font-size:12px; border:1px solid rgba(59,130,246,0.35);">T${item.temporadaNum}E${item.episodioNum}</span> <span style="color:#fff; font-weight:800;">${item.episodioNome}</span>`
                    : `<span style="color:#fff; font-weight:800;">${item.nome}</span> <span style="color:var(--text-muted); font-size:12px;">(${item.ano})</span>`;

                const tipoBadge = item.kind === 'episodio'
                    ? `<span class="badge-processing" style="font-size:11px; padding:2px 7px;">📺 Episódio</span>`
                    : `<span class="badge-completed" style="font-size:11px; padding:2px 7px;">🎬 Filme</span>`;

                return `
                        <div class="admin-catalog-card">
                            <div class="admin-catalog-card-header">
                                <div class="admin-catalog-card-media">
                                    <img src="${poster}" class="admin-catalog-card-poster" onerror="this.src='/logo.jpg'">
                                    <div class="admin-catalog-card-title-box">
                                        <div class="admin-catalog-card-title">
                                            ${titleHtml}
                                        </div>
                                        <div class="admin-catalog-card-sub">
                                            ${item.kind === 'episodio' ? `Série ID: ${item.serieId} • Ep ID: ${item.id}` : `ID: ${item.id} • ${item.nomeOriginal || item.nome}`}
                                        </div>
                                    </div>
                                </div>
                                <div class="admin-catalog-card-actions">
                                    ${openSerieBtn}
                                    ${rebaixarBtns}
                                    ${deleteBtn}
                                </div>
                            </div>
                            <div class="admin-catalog-card-meta">
                                ${tipoBadge}
                                <div>${versaoBadge}</div>
                                <span class="admin-catalog-meta-pill">⚡ ${item.qualidade}</span>
                                <span class="admin-catalog-meta-pill" style="color:#34d399; font-weight:700;" title="Data exata de inclusão">🕒 ${formatCatalogDate(item.dataAdicionado)}</span>
                                ${tgBadge}
                            </div>
                        </div>
                    `;
            }).join('');

            container.innerHTML = html;
        }

        function renderAdminCatalogGroupedCards(container, { q, typeFilter, statusFilter, audioFilter }) {
            const filmes = (adminCatalogData.filmes || []).map(f => ({ ...f, itemType: 'filme' }));
            const series = (adminCatalogData.series || []).map(s => ({ ...s, itemType: 'serie' }));
            let items = [...filmes, ...series];

            if (typeFilter !== 'all') {
                if (typeFilter === 'filme') {
                    items = items.filter(i => i.itemType === 'filme' && !i.isAnime);
                } else if (typeFilter === 'serie') {
                    items = items.filter(i => i.itemType === 'serie' && !i.isAnime && !i.isDorama && !i.isMicrodrama);
                } else if (typeFilter === 'anime') {
                    items = items.filter(i => i.isAnime);
                } else if (typeFilter === 'dorama') {
                    items = items.filter(i => i.isDorama);
                } else if (typeFilter === 'microdrama') {
                    items = items.filter(i => i.isMicrodrama);
                }
            }

            if (audioFilter !== 'all') {
                if (audioFilter === 'dublado') {
                    items = items.filter(i => i.isDublado || !!i.versoes?.dublado);
                } else if (audioFilter === 'legendado') {
                    items = items.filter(i => i.isLegendado || !!i.versoes?.legendado);
                }
            }

            if (statusFilter !== 'all') {
                if (statusFilter === 'missing_eps') {
                    items = items.filter(i => i.itemType === 'serie' && (i.temporadas || []).some(t => t.episodiosFaltantes && t.episodiosFaltantes.length > 0));
                } else if (statusFilter === 'missing_dub') {
                    items = items.filter(i => {
                        if (i.itemType === 'filme') return !i.isDublado && !i.versoes?.dublado;
                        return (i.temporadas || []).some(t => (t.episodios || []).some(e => !e.isDublado && !e.versoes?.dublado));
                    });
                } else if (statusFilter === 'no_telegram') {
                    items = items.filter(i => {
                        if (i.itemType === 'filme') return !i.hasTelegramLink && !i.messageId;
                        return (i.temporadas || []).some(t => (t.episodios || []).some(e => !e.hasTelegramLink));
                    });
                } else if (statusFilter === 'complete') {
                    items = items.filter(i => {
                        if (i.itemType === 'filme') return i.hasTelegramLink || i.messageId;
                        return (i.temporadas || []).every(t => !t.episodiosFaltantes || t.episodiosFaltantes.length === 0);
                    });
                }
            }

            if (q) {
                items = items.filter(i => {
                    const nameMatch = (i.nome || '').toLowerCase().includes(q) || (i.nomeOriginal || '').toLowerCase().includes(q);
                    const idMatch = String(i.id) === q || String(i.tmdbId) === q || String(i.imdbId || '').toLowerCase().includes(q);
                    if (nameMatch || idMatch) return true;
                    if (i.itemType === 'serie') {
                        return (i.temporadas || []).some(t => (t.episodios || []).some(e => (e.nome || '').toLowerCase().includes(q) || String(e.id) === q));
                    }
                    return false;
                });
            }

            // Ordena por data mais recente
            items.sort((a, b) => {
                const getLatestTime = (item) => {
                    let maxT = item.dataAdicionado || item.createdAt ? new Date(item.dataAdicionado || item.createdAt).getTime() : 0;
                    if (item.itemType === 'serie' && item.temporadas) {
                        for (const t of item.temporadas) {
                            for (const e of (t.episodios || [])) {
                                const epT = e.dataAdicionado || e.createdAt ? new Date(e.dataAdicionado || e.createdAt).getTime() : 0;
                                if (epT > maxT) maxT = epT;
                            }
                        }
                    }
                    return maxT;
                };
                return getLatestTime(b) - getLatestTime(a);
            });

            if (items.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 36px 16px; color: var(--text-muted);">Nenhum título localizado com os filtros selecionados.</div>';
                return;
            }

            container.innerHTML = items.map(i => {
                const poster = i.posterUrl || '/logo.jpg';
                const catBadge = i.isAnime ? '⛩️ Anime' : (i.isDorama ? '🌸 Dorama' : (i.isMicrodrama ? '⚡ Mini Série' : (i.itemType === 'filme' ? '🎬 Filme' : '📺 Série')));

                if (i.itemType === 'filme') {
                    const tgBadge = i.hasTelegramLink || i.messageId
                        ? `<span class="admin-catalog-meta-pill" style="color:#10b981;">📱 Msg #${i.messageId || 'OK'}</span>`
                        : `<span class="admin-catalog-meta-pill" style="color:#f59e0b;">⚠️ Sem TG</span>`;

                    const hasDub = !!i.isDublado || !!(i.versoes?.dublado?.messageId || i.versoes?.dublado?.fileId);
                    const hasLeg = !!i.isLegendado || !!(i.versoes?.legendado?.messageId || i.versoes?.legendado?.fileId);

                    let rebaixarButtons = '';
                    if (hasDub && hasLeg) {
                        rebaixarButtons = `
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'filme', true, 'dublado')" title="Rebaixar apenas Dublado">🔄 Dub</button>
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'filme', true, 'legendado')" title="Rebaixar apenas Legendado">🔄 Leg</button>
                            `;
                    } else if (hasLeg && !hasDub) {
                        rebaixarButtons = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'filme', true, 'legendado')" title="Rebaixar Legendado">🔄 Leg</button>`;
                    } else {
                        rebaixarButtons = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'filme', true, 'dublado')" title="Rebaixar Dublado">🔄 Dub</button>`;
                    }

                    const audPill = (hasDub && hasLeg) ? '<span class="badge-completed">Dual (Dub+Leg)</span>' : (hasDub ? '<span class="badge-completed">🔊 Dublado</span>' : (hasLeg ? '<span class="badge-processing">💬 Legendado</span>' : '<span style="color:var(--text-muted); font-size:11px;">Nacional</span>'));

                    return `
                            <div class="admin-catalog-card">
                                <div class="admin-catalog-card-header">
                                    <div class="admin-catalog-card-media">
                                        <img src="${poster}" class="admin-catalog-card-poster" onerror="this.src='/logo.jpg'">
                                        <div class="admin-catalog-card-title-box">
                                            <div class="admin-catalog-card-title">
                                                <span>${i.nome}</span>
                                                <span style="font-size:11px; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; color:#cbd5e1;">${catBadge}</span>
                                                <span style="font-size:11px; color:var(--text-muted);">(${i.ano || '2026'})</span>
                                            </div>
                                            <div class="admin-catalog-card-sub">
                                                ID: ${i.id} • ${i.nomeOriginal || i.nome} • TMDB: ${i.tmdbId || '-'}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="admin-catalog-card-actions">
                                        ${rebaixarButtons}
                                        <button class="btn-action btn-action-danger btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'filme', false)" title="Excluir Filme Completo">
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                                <div class="admin-catalog-card-meta">
                                    <div>${audPill}</div>
                                    <span class="admin-catalog-meta-pill">⚡ ${i.qualidade || '1080p'}</span>
                                    <span class="admin-catalog-meta-pill">🕒 ${formatCatalogDate(i.dataAdicionado || i.createdAt)}</span>
                                    ${tgBadge}
                                </div>
                            </div>
                        `;
                } else {
                    // SÉRIE
                    const totalEps = (i.temporadas || []).reduce((acc, t) => acc + (t.episodios || []).length, 0);
                    const totalEpsEsperados = (i.temporadas || []).reduce((acc, t) => acc + (t.expectedEpisodios || t.episodios?.length || 0), 0);
                    const missingCount = (i.temporadas || []).reduce((acc, t) => acc + (t.episodiosFaltantes?.length || 0), 0);
                    const missingBadge = missingCount > 0
                        ? `<span style="color: #ef4444; font-weight: 700;">⚠️ Faltam ${missingCount} ep${missingCount > 1 ? 's' : ''}</span>`
                        : `<span style="color: #10b981; font-weight: 700;">✅ Completo</span>`;

                    const epsComTelegram = (i.temporadas || []).reduce((acc, t) => acc + (t.episodios || []).filter(e => !!e.hasTelegramLink).length, 0);
                    const tgBadge = totalEps > 0 && epsComTelegram === totalEps
                        ? `<span class="admin-catalog-meta-pill" style="color:#10b981;">📱 ${epsComTelegram}/${totalEps} OK</span>`
                        : (epsComTelegram > 0
                            ? `<span class="admin-catalog-meta-pill" style="color:#f59e0b;">⚠️ ${epsComTelegram}/${totalEps} TG</span>`
                            : `<span class="admin-catalog-meta-pill" style="color:#ef4444;">❌ Sem TG</span>`);

                    const isRegraAtiva = i.exigirTemporadaCompleta !== false;
                    const regraBtn = `
                            <button class="btn-action btn-icon-compact"
                                style="${isRegraAtiva ? 'background: rgba(16, 185, 129, 0.18); border-color: rgba(16, 185, 129, 0.45); color: #34d399; font-weight: 700; font-size: 11px; padding: 5px 8px;' : 'background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #f87171; font-weight: 700; font-size: 11px; padding: 5px 8px;'}"
                                onclick="handleToggleRegraTemporada('${i.id}', ${!isRegraAtiva})"
                                title="${isRegraAtiva ? 'Regra ATIVA: Temporadas incompletas são ocultadas. Clique para liberar exibição parcial.' : 'Regra DESATIVADA: Exibe parciais. Clique para exigir 100% completas.'}">
                                ${isRegraAtiva ? '🔒 100%' : '🔓 Livre'}
                            </button>
                        `;

                    const sDub = !!i.isDublado;
                    const sLeg = !!i.isLegendado;
                    let serieRebaixarBtns = '';
                    if (sDub && sLeg) {
                        serieRebaixarBtns = `
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'serie', true, 'dublado')" title="Rebaixar todos os eps Dublados">🔄 Dub</button>
                                <button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'serie', true, 'legendado')" title="Rebaixar todos os eps Legendados">🔄 Leg</button>
                            `;
                    } else if (sLeg && !sDub) {
                        serieRebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'serie', true, 'legendado')" title="Rebaixar série Legendada">🔄 Leg</button>`;
                    } else {
                        serieRebaixarBtns = `<button class="btn-action btn-action-rebaixar btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'serie', true, 'dublado')" title="Rebaixar série Dublada">🔄 Dub</button>`;
                    }

                    const epsComDub = (i.temporadas || []).reduce((acc, t) => acc + (t.episodios || []).filter(e => !!e.isDublado || !!(e.versoes?.dublado?.messageId || e.versoes?.dublado?.fileId)).length, 0);
                    const epsComLeg = (i.temporadas || []).reduce((acc, t) => acc + (t.episodios || []).filter(e => !!e.isLegendado || !!(e.versoes?.legendado?.messageId || e.versoes?.legendado?.fileId)).length, 0);

                    let audPill = '';
                    if (totalEps > 0 && epsComDub === totalEps && epsComLeg === totalEps) {
                        audPill = '<span class="badge-completed">Dual (100%)</span>';
                    } else if (totalEps > 0 && epsComDub === totalEps) {
                        audPill = '<span class="badge-completed">🔊 Dub (100%)</span>';
                    } else if (totalEps > 0 && epsComLeg === totalEps && epsComDub === 0) {
                        audPill = '<span class="badge-processing">💬 Leg (100%)</span>';
                    } else if (epsComDub > 0 && epsComLeg > 0) {
                        audPill = `<span class="admin-catalog-meta-pill" style="color:#fbbf24;">Dual Misto (Dub ${epsComDub}/${totalEps} • Leg ${epsComLeg}/${totalEps})</span>`;
                    } else if (epsComDub > 0) {
                        audPill = `<span class="admin-catalog-meta-pill" style="color:#fbbf24;">Dub (${epsComDub}/${totalEps})</span>`;
                    } else if (epsComLeg > 0) {
                        audPill = `<span class="admin-catalog-meta-pill" style="color:#60a5fa;">Leg (${epsComLeg}/${totalEps})</span>`;
                    } else {
                        audPill = '<span style="color:var(--text-muted); font-size:11px;">Nacional</span>';
                    }

                    return `
                            <div class="admin-catalog-card">
                                <div class="admin-catalog-card-header">
                                    <div class="admin-catalog-card-media">
                                        <img src="${poster}" class="admin-catalog-card-poster" onerror="this.src='/logo.jpg'">
                                        <div class="admin-catalog-card-title-box">
                                            <div class="admin-catalog-card-title">
                                                <span>${i.nome}</span>
                                                <span style="font-size:11px; background:rgba(255,255,255,0.06); padding:2px 6px; border-radius:4px; color:#cbd5e1;">${catBadge}</span>
                                                <span style="font-size:11px; color:var(--text-muted);">(${i.ano || '2026'})</span>
                                            </div>
                                            <div class="admin-catalog-card-sub">
                                                ID: ${i.id} • ${i.nomeOriginal || i.nome} • TMDB: ${i.tmdbId || '-'}
                                            </div>
                                        </div>
                                    </div>
                                    <div class="admin-catalog-card-actions">
                                        <button class="btn-action btn-action-primary btn-icon-compact" onclick="openAdminSerieEpisodesModal('${i.id}')" title="Abrir gerenciador de episódios da série">
                                            📋 Episódios (${totalEps})
                                        </button>
                                        ${regraBtn}
                                        ${serieRebaixarBtns}
                                        <button class="btn-action btn-action-danger btn-icon-compact" onclick="handleDeleteCatalogItem('${i.id}', 'serie', false)" title="Excluir Série Completa">
                                            🗑️
                                        </button>
                                    </div>
                                </div>
                                <div class="admin-catalog-card-meta">
                                    <span class="admin-catalog-meta-pill" style="color:#fff; font-weight:700;">📺 ${(i.temporadas || []).length} temp • ${totalEps} eps</span>
                                    <div>${missingBadge}</div>
                                    <div>${audPill}</div>
                                    <span class="admin-catalog-meta-pill">🕒 ${formatCatalogDate(i.dataAdicionado || i.createdAt)}</span>
                                    ${tgBadge}
                                </div>
                            </div>
                        `;
                }
            }).join('');
        }

        function toggleSerieEpisodes(accordionId, btn) {
            // Mantido para compatibilidade retroativa
        }

        async function handleToggleRegraTemporada(serieId, newState) {
            try {
                const res = await fetch('/api/admin/catalogo/serie/toggle-regra-temporada', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ id: serieId, exigirTemporadaCompleta: newState })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Regra de temporadas atualizada com sucesso!', 'success');
                if (adminCatalogData && adminCatalogData.series) {
                    const s = adminCatalogData.series.find(item => String(item.id) === String(serieId));
                    if (s) s.exigirTemporadaCompleta = newState;
                }
                renderAdminCatalog();
                loadCatalog();
            } catch (e) {
                showToast(e.message || 'Erro ao alternar regra da série.', 'error');
            }
        }

        async function handleMergeSeriesDuplicate(sourceId, sourceNome) {
            const srcSerie = adminCatalogData?.series?.find(s => String(s.id) === String(sourceId));
            const nomeOrigem = sourceNome || (srcSerie ? srcSerie.nome : `Série #${sourceId}`);
            const targetIdStr = prompt(
                `🔗 FUNDIR DUPLICATA\n\nVocê vai mover todos os episódios de "${nomeOrigem}" (ID: ${sourceId}) para outra série.\n\nDigite o ID da série PRINCIPAL (destino) onde os episódios devem ficar:`
            );
            if (!targetIdStr || !targetIdStr.trim()) return;
            const targetId = Number(targetIdStr.trim());
            if (isNaN(targetId) || targetId <= 0) {
                showToast('ID inválido. Digite apenas o número do ID da série destino.', 'error');
                return;
            }
            if (String(targetId) === String(sourceId)) {
                showToast('A série de destino não pode ser a mesma que a de origem.', 'error');
                return;
            }

            const targetSerie = adminCatalogData?.series?.find(s => String(s.id) === String(targetId));
            const targetNome = targetSerie ? `"${targetSerie.nome}"` : `ID ${targetId}`;

            if (!confirm(`Confirmar:\n\nMover todos os episódios de "${nomeOrigem}" (ID: ${sourceId}) para ${targetNome} (ID: ${targetId}) e excluir a duplicata?\n\nEsta operação não pode ser desfeita.`)) return;

            try {
                const res = await fetch('/api/admin/catalogo/serie/merge-duplicate', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ sourceId, targetId })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao fundir séries.');
                showToast(data.message || 'Séries fundidas com sucesso!', 'success');
                loadAdminCatalog();
                loadCatalog();
            } catch (e) {
                showToast(e.message || 'Erro ao fundir séries duplicadas.', 'error');
            }
        }

        async function handleDeleteCatalogItem(id, type, rebaixar = false, versao = null) {
            let actionText = '';
            if (rebaixar) {
                if (versao) {
                    actionText = `excluir e REBAIXAR apenas a versão ${versao.toUpperCase()} (mantendo a outra intacta)`;
                } else {
                    actionText = 'excluir do Armazém e REBAIXAR imediatamente';
                }
            } else {
                actionText = 'excluir permanentemente';
            }

            if (!confirm(`Deseja ${actionText} este ${type}?`)) return;

            try {
                const endpoint = type === 'filme' ? `/api/admin/catalogo/filme/${id}` : `/api/admin/catalogo/serie/${id}`;
                const versaoParam = versao ? `&versao=${versao}` : '';
                const res = await fetch(`${endpoint}?rebaixar=${rebaixar}${versaoParam}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Item processado com sucesso!', 'success');
                loadAdminCatalog();
                loadAdminQueue();
                loadCatalog();
            } catch (e) {
                showToast(e.message || 'Erro ao processar item do catálogo.', 'error');
            }
        }

        async function handleDeleteEpisode(id, rebaixar = false, versao = null) {
            let actionText = '';
            if (rebaixar) {
                if (versao) {
                    actionText = `excluir e REBAIXAR apenas a versão ${versao.toUpperCase()} deste episódio`;
                } else {
                    actionText = 'excluir do Armazém e REBAIXAR este episódio';
                }
            } else {
                actionText = 'excluir permanentemente este episódio';
            }

            if (!confirm(`Deseja ${actionText}?`)) return;

            try {
                const versaoParam = versao ? `&versao=${versao}` : '';
                const res = await fetch(`/api/admin/catalogo/episodio/${id}?rebaixar=${rebaixar}${versaoParam}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                showToast(data.message || 'Episódio processado com sucesso!', 'success');
                loadAdminCatalog();
                loadAdminQueue();
                loadCatalog();
            } catch (e) {
                showToast(e.message || 'Erro ao processar episódio.', 'error');
            }
        }

        async function handleResyncCatalog() {
            try {
                const res = await fetch('/api/admin/catalogo/resync', {
                    method: 'POST',
                    headers: getAuthHeaders()
                });
                if (!res.ok) throw new Error();
                showToast('Catálogo sincronizado com o banco de dados!', 'success');
                loadAdminCatalog();
                loadCatalog();
            } catch (e) {
                showToast('Erro ao sincronizar catálogo.', 'error');
            }
        }

        async function handleAdminChangePassword(e) {
            e.preventDefault();
            const cur = document.getElementById('pass-current').value;
            const nw = document.getElementById('pass-new').value;

            try {
                const res = await fetch('/api/admin/change-password', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ currentPassword: cur, newPassword: nw })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao alterar senha.');

                showToast('Senha de Administrador alterada com sucesso!', 'success');
                closeAdminModal('admin-modal-password');
                document.getElementById('pass-current').value = '';
                document.getElementById('pass-new').value = '';
            } catch (err) {
                showToast(err.message || 'Erro ao alterar senha.', 'error');
            }
        }

        function openAdminModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.add('active');
        }

        function closeAdminModal(modalId) {
            const modal = document.getElementById(modalId);
            if (modal) modal.classList.remove('active');
            if (modalId === 'admin-modal-serie-episodes') {
                currentModalSerieId = null;
            }
        }

        function closeAdminModalOnClick(e, modalId) {
            if (e.target.id === modalId) {
                closeAdminModal(modalId);
            }
        }

        // ─── MODAIS DE TRANSPARÊNCIA DE PUBLICIDADE & AVISO LEGAL (DMCA) ──────
        function openAdTransparencyModal() {
            const m = document.getElementById('modal-ad-transparency');
            if (m) m.classList.add('active');
        }

        function closeAdTransparencyModal(e) {
            if (e && e.target && e.target.id !== 'modal-ad-transparency' && !e.target.closest('button') && !e.target.closest('a')) {
                return;
            }
            const m = document.getElementById('modal-ad-transparency');
            if (m) m.classList.remove('active');
        }

        function openDmcaModal() {
            const m = document.getElementById('modal-dmca-disclaimer');
            if (m) m.classList.add('active');
        }

        function closeDmcaModal(e) {
            if (e && e.target && e.target.id !== 'modal-dmca-disclaimer' && !e.target.closest('button')) {
                return;
            }
            const m = document.getElementById('modal-dmca-disclaimer');
            if (m) m.classList.remove('active');
        }

        // ─── AGENDADOR DE HORÁRIOS & QOS DE REDE (SCHEDULER) ───────────────────

        let currentSchedulerData = null;

        const SCHED_DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

        function toggleOverrideHours() {
            const tipo = document.getElementById('sched-ov-tipo')?.value;
            const colIni = document.getElementById('sched-ov-col-inicio');
            const colFim = document.getElementById('sched-ov-col-fim');
            const colFora = document.getElementById('sched-ov-col-fora');
            const isBlocked = tipo === 'blocked';
            if (colIni) colIni.style.display = isBlocked ? 'none' : 'block';
            if (colFim) colFim.style.display = isBlocked ? 'none' : 'block';
            if (colFora) colFora.style.display = isBlocked ? 'none' : 'block';
        }

        async function loadAdminScheduler() {
            if (!adminToken) return;

            const dateInput = document.getElementById('sched-ov-date');
            if (dateInput && !dateInput.value) {
                const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
                dateInput.value = tomorrow.toISOString().slice(0, 10);
            }

            try {
                const res = await fetch('/api/admin/scheduler', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                currentSchedulerData = data;

                // 1. Banner de Status e Badges
                const badge = document.getElementById('adm-sched-badge');
                const motivo = document.getElementById('adm-sched-motivo');
                const horaAtual = document.getElementById('adm-sched-hora-atual');
                const politica = document.getElementById('adm-sched-politica');

                if (motivo) motivo.innerText = data.motivo || 'Agendador ativo';

                if (horaAtual) {
                    horaAtual.innerText = `${data.horaAtualBRT || '--:--'} (${data.diaNomeAtual || 'São Paulo'})`;
                }

                if (politica) {
                    if (data.mode === 'eco') {
                        politica.innerText = '🍃 Modo Econômico (Zero Impacto na Rede/Wi-Fi)';
                        politica.style.color = '#34d399';
                    } else if (data.mode === 'performance') {
                        politica.innerText = '⚡ Desempenho Máximo (Velocidade Total)';
                        politica.style.color = '#60a5fa';
                    } else {
                        politica.innerText = '⏸️ Pausado (Sem tráfego de rede)';
                        politica.style.color = '#f87171';
                    }
                }

                if (badge) {
                    if (!data.config?.ativo) {
                        badge.style.background = 'rgba(59, 130, 246, 0.2)';
                        badge.style.color = '#60a5fa';
                        badge.innerHTML = '⚡ 24h Desempenho Máximo';
                    } else if (data.forceState === 'performance' || data.forceState === 'start') {
                        badge.style.background = 'rgba(59, 130, 246, 0.25)';
                        badge.style.color = '#60a5fa';
                        badge.innerHTML = `⚡ Forçado Desempenho ${data.forceExpiresAtDesc ? `(até ${data.forceExpiresAtDesc})` : ''}`;
                    } else if (data.forceState === 'eco') {
                        badge.style.background = 'rgba(52, 211, 153, 0.25)';
                        badge.style.color = '#34d399';
                        badge.innerHTML = `🍃 Forçado Econômico ${data.forceExpiresAtDesc ? `(até ${data.forceExpiresAtDesc})` : ''}`;
                    } else if (data.forceState === 'stop') {
                        badge.style.background = 'rgba(239, 68, 68, 0.2)';
                        badge.style.color = '#f87171';
                        badge.innerHTML = '⏹️ Pausado Manualmente';
                    } else if (data.mode === 'eco') {
                        badge.style.background = 'rgba(52, 211, 153, 0.2)';
                        badge.style.color = '#34d399';
                        badge.innerHTML = '🍃 Modo Econômico Ativo';
                    } else if (data.mode === 'performance') {
                        badge.style.background = 'rgba(59, 130, 246, 0.2)';
                        badge.style.color = '#60a5fa';
                        badge.innerHTML = '⚡ Desempenho Máximo Ativo';
                    } else {
                        badge.style.background = 'rgba(245, 158, 11, 0.2)';
                        badge.style.color = '#fbbf24';
                        badge.innerHTML = '⏸️ Fora do Horário (Pausado)';
                    }
                }

                // 2. Preenche Toggles Globais
                const ativoEl = document.getElementById('sched-cfg-ativo');
                if (ativoEl) ativoEl.checked = data.config?.ativo !== false;

                const foraPadrao = document.getElementById('sched-cfg-fora-padrao');
                if (foraPadrao && data.config?.modoPadraoForaHorario) {
                    foraPadrao.value = data.config.modoPadraoForaHorario;
                }

                // 3. Renderiza Tabela Grade Dia a Dia
                const daysTbody = document.getElementById('sched-days-tbody');
                if (daysTbody) {
                    const diasMap = data.config?.dias || {
                        "0": { "ativo": true, "modo": "eco", "horaInicio": "00:00", "horaFim": "23:59", "modoFora": "paused" },
                        "1": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco" },
                        "2": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco" },
                        "3": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco" },
                        "4": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco" },
                        "5": { "ativo": true, "modo": "performance", "horaInicio": "01:00", "horaFim": "05:30", "modoFora": "eco" },
                        "6": { "ativo": true, "modo": "eco", "horaInicio": "00:00", "horaFim": "23:59", "modoFora": "paused" }
                    };

                    daysTbody.innerHTML = [1, 2, 3, 4, 5, 6, 0].map(d => {
                        const dayCfg = diasMap[String(d)] || { ativo: true, modo: (d === 0 || d === 6 ? 'eco' : 'performance'), horaInicio: '01:00', horaFim: '05:30', modoFora: 'eco' };
                        const dayName = SCHED_DAY_NAMES[d];
                        const isWeekend = (d === 0 || d === 6);
                        const isToday = data.diaAtualBRT === d;

                        return `
                            <tr style="${isToday ? 'background: rgba(59, 130, 246, 0.08);' : ''}">
                                <td>
                                    <strong>${dayName}</strong>
                                    ${isToday ? '<span style="font-size: 10px; color: #60a5fa; margin-left: 6px; font-weight: 800;">(HOJE)</span>' : ''}
                                    ${isWeekend ? '<div style="font-size: 10px; color: var(--text-muted);">Fim de semana</div>' : ''}
                                </td>
                                <td>
                                    <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                                        <input type="checkbox" id="sched-day-ativo-${d}" ${dayCfg.ativo !== false ? 'checked' : ''} style="width: 16px; height: 16px;">
                                        <span style="font-size: 12px; font-weight: 700; color: #fff;">Ativo</span>
                                    </label>
                                </td>
                                <td>
                                    <select id="sched-day-modo-${d}" class="admin-select" style="width: 100%;">
                                        <option value="performance" ${dayCfg.modo === 'performance' ? 'selected' : ''}>⚡ Desempenho</option>
                                        <option value="eco" ${dayCfg.modo === 'eco' ? 'selected' : ''}>🍃 Econômico (Residencial)</option>
                                        <option value="paused" ${dayCfg.modo === 'paused' ? 'selected' : ''}>⏸️ Pausado</option>
                                    </select>
                                </td>
                                <td>
                                    <input type="time" id="sched-day-inicio-${d}" class="admin-input" value="${dayCfg.horaInicio || '01:00'}" style="margin: 0; padding: 6px 10px; width: 100%;">
                                </td>
                                <td>
                                    <input type="time" id="sched-day-fim-${d}" class="admin-input" value="${dayCfg.horaFim || '05:30'}" style="margin: 0; padding: 6px 10px; width: 100%;">
                                </td>
                                <td>
                                    <select id="sched-day-off-${d}" class="admin-select" style="width: 100%;">
                                        <option value="eco" ${(dayCfg.modoFora || 'eco') === 'eco' ? 'selected' : ''}>🍃 Modo Econômico</option>
                                        <option value="paused" ${(dayCfg.modoFora || 'eco') === 'paused' ? 'selected' : ''}>⏸️ Pausado</option>
                                    </select>
                                </td>
                            </tr>
                        `;
                    }).join('');
                }

                // 4. Renderiza tabela de Overrides por Data
                const ovTbody = document.getElementById('adm-sched-overrides-tbody');
                if (ovTbody) {
                    const entries = Object.entries(data.overrides || {});
                    if (entries.length === 0) {
                        ovTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">Nenhuma exceção cadastrada.</td></tr>';
                    } else {
                        const rows = [];
                        entries.sort(([a], [b]) => a.localeCompare(b)).forEach(([dt, ov]) => {
                            if (ov === false) {
                                rows.push(`
                                    <tr>
                                        <td style="font-weight: 800; color: #fff;">${dt}</td>
                                        <td><span style="color: #f87171; font-weight: 800;">🚫 Bloqueado o Dia Inteiro</span></td>
                                        <td style="font-size: 12px; color: var(--text-muted);">00:00 às 23:59</td>
                                        <td style="text-align: right;">
                                            <button class="btn-action btn-action-danger" style="padding: 4px 8px; font-size: 11px;" onclick="handleDeleteSchedulerOverride('${dt}')">
                                                🗑️ Excluir
                                            </button>
                                        </td>
                                    </tr>
                                `);
                            } else {
                                const rules = Array.isArray(ov) ? ov : (ov ? [ov] : []);
                                rules.forEach(rule => {
                                    const isPerf = rule.modo === 'performance';
                                    const modoBadge = isPerf
                                        ? '<span style="color: #60a5fa; font-weight: 800;">⚡ Modo Desempenho</span>'
                                        : '<span style="color: #34d399; font-weight: 800;">🍃 Modo Econômico</span>';
                                    const horaStr = `🕒 ${rule.horaInicio || '00:00'} às ${rule.horaFim || '23:59'}`;
                                    const ruleId = rule.id || '';

                                    rows.push(`
                                        <tr>
                                            <td style="font-weight: 800; color: #fff;">${dt}</td>
                                            <td>${modoBadge}</td>
                                            <td style="font-size: 12px; color: var(--text-muted);">${horaStr}</td>
                                            <td style="text-align: right;">
                                                <button class="btn-action btn-action-danger" style="padding: 4px 8px; font-size: 11px;" onclick="handleDeleteSchedulerOverride('${dt}', '${ruleId}')">
                                                    🗑️ Excluir
                                                </button>
                                            </td>
                                        </tr>
                                    `);
                                });
                            }
                        });
                        ovTbody.innerHTML = rows.join('');
                    }
                }

            } catch (e) {
                console.warn('Erro ao carregar scheduler:', e);
            }
        }

        async function handleSchedulerForce(action, mode = 'performance') {
            if (!adminToken) return;
            const endpoints = {
                start: '/api/admin/scheduler/force-start',
                stop: '/api/admin/scheduler/force-stop',
                clear: '/api/admin/scheduler/clear-force'
            };
            const endpoint = endpoints[action];
            if (!endpoint) return;

            try {
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        reason: `Acionado manualmente no painel (${action})`,
                        mode: mode,
                        durationHours: 6
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao executar ação.');
                showToast(data.message || 'Comando executado com sucesso!', 'success');
                loadAdminScheduler();
            } catch (err) {
                showToast(err.message || 'Erro na requisição.', 'error');
            }
        }

        async function handleSaveSchedulerConfig(e) {
            e.preventDefault();
            if (!adminToken) return;

            const ativo = document.getElementById('sched-cfg-ativo')?.checked ?? true;
            const modoPadraoForaHorario = document.getElementById('sched-cfg-fora-padrao')?.value || 'eco';

            const diasPayload = {};
            for (let d = 0; d <= 6; d++) {
                const isAtivo = document.getElementById(`sched-day-ativo-${d}`)?.checked ?? true;
                const modo = document.getElementById(`sched-day-modo-${d}`)?.value || (d === 0 || d === 6 ? 'eco' : 'performance');
                const horaInicio = document.getElementById(`sched-day-inicio-${d}`)?.value || '01:00';
                const horaFim = document.getElementById(`sched-day-fim-${d}`)?.value || '05:30';
                const modoFora = document.getElementById(`sched-day-off-${d}`)?.value || 'eco';

                diasPayload[String(d)] = {
                    ativo: isAtivo,
                    modo: modo,
                    horaInicio: horaInicio,
                    horaFim: horaFim,
                    modoFora: modoFora,
                    nome: SCHED_DAY_NAMES[d]
                };
            }

            try {
                const res = await fetch('/api/admin/scheduler/config', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        ativo,
                        modoPadraoForaHorario,
                        dias: diasPayload
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao salvar grade.');
                showToast(data.message || 'Grade semanal salva com sucesso!', 'success');
                loadAdminScheduler();
            } catch (err) {
                showToast(err.message || 'Erro ao salvar.', 'error');
            }
        }

        async function handleAddSchedulerOverride(e) {
            e.preventDefault();
            if (!adminToken) return;

            const data = document.getElementById('sched-ov-date')?.value;
            const tipo = document.getElementById('sched-ov-tipo')?.value;
            const horaInicio = document.getElementById('sched-ov-inicio-time')?.value || '01:00';
            const horaFim = document.getElementById('sched-ov-fim-time')?.value || '05:30';

            if (!data) {
                showToast('Informe a data para a programação especial.', 'error');
                return;
            }

            const payloadConfig = tipo === 'blocked' ? false : {
                modo: tipo,
                horaInicio,
                horaFim
            };

            try {
                const res = await fetch('/api/admin/scheduler/override', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ data, config: payloadConfig })
                });
                const resData = await res.json();
                if (!res.ok) throw new Error(resData.error || 'Erro ao salvar exceção.');
                showToast(resData.message || 'Data especial configurada com sucesso!', 'success');
                loadAdminScheduler();
            } catch (err) {
                showToast(err.message || 'Erro ao salvar.', 'error');
            }
        }

        async function handleDeleteSchedulerOverride(dt, ruleId = '') {
            if (!adminToken) return;
            if (!confirm(`Remover esta regra da programação especial do dia ${dt}?`)) return;

            try {
                const url = ruleId ? `/api/admin/scheduler/override/${dt}?ruleId=${encodeURIComponent(ruleId)}` : `/api/admin/scheduler/override/${dt}`;
                const res = await fetch(url, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao remover exceção.');
                showToast(data.message || 'Exceção removida com sucesso!', 'success');
                loadAdminScheduler();
            } catch (err) {
                showToast(err.message || 'Erro ao remover.', 'error');
            }
        }

        // ─── CONFIGURAÇÕES GERAIS DO SISTEMA (SETTINGS SERVICE) ──────────────────

        async function loadAdminSettings() {
            if (!adminToken) return;
            try {
                const res = await fetch('/api/admin/settings', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const s = data.settings || {};

                if (document.getElementById('cfg-max-downloads')) document.getElementById('cfg-max-downloads').value = s.MAX_CONCURRENT_DOWNLOADS ?? 3;
                if (document.getElementById('cfg-max-transcodes')) document.getElementById('cfg-max-transcodes').value = s.MAX_CONCURRENT_TRANSCODES ?? 2;
                if (document.getElementById('cfg-max-uploads')) document.getElementById('cfg-max-uploads').value = s.MAX_CONCURRENT_UPLOADS ?? 2;
                if (document.getElementById('cfg-max-jobs')) document.getElementById('cfg-max-jobs').value = s.MAX_CONCURRENT_JOBS ?? 10;
                if (document.getElementById('cfg-eco-download-limit')) document.getElementById('cfg-eco-download-limit').value = s.ECO_DOWNLOAD_LIMIT_MB ?? 3.0;
                if (document.getElementById('cfg-eco-upload-limit')) document.getElementById('cfg-eco-upload-limit').value = s.ECO_UPLOAD_LIMIT_KB ?? 30;
                if (document.getElementById('cfg-max-peers')) document.getElementById('cfg-max-peers').value = s.MAX_TORRENT_PEER_CONNECTIONS ?? 35;
                if (document.getElementById('cfg-upload-limit-kb')) document.getElementById('cfg-upload-limit-kb').value = s.MAX_TORRENT_UPLOAD_LIMIT_KB ?? 250;
                if (document.getElementById('cfg-tg-sockets')) document.getElementById('cfg-tg-sockets').value = s.TELEGRAM_UPLOAD_MAX_SOCKETS ?? 4;
                if (document.getElementById('cfg-min-speed-mb')) document.getElementById('cfg-min-speed-mb').value = s.MIN_DOWNLOAD_SPEED_MB ?? 1.5;
                if (document.getElementById('cfg-max-disk-gb')) document.getElementById('cfg-max-disk-gb').value = s.MAX_TEMP_DISK_GB ?? 100;
                if (document.getElementById('cfg-ffmpeg-threads')) document.getElementById('cfg-ffmpeg-threads').value = s.FFMPEG_THREADS_PER_JOB ?? 6;
                if (document.getElementById('cfg-feeder-hours')) document.getElementById('cfg-feeder-hours').value = s.AUTO_FEEDER_INTERVAL_HOURS ?? 4;
                if (document.getElementById('cfg-server-host')) document.getElementById('cfg-server-host').value = s.SERVER_HOST ?? 'brasilflix.kapsu.com.br';

                if (document.getElementById('cfg-feeder-enabled')) document.getElementById('cfg-feeder-enabled').checked = s.AUTO_FEEDER_ENABLED !== false;
                if (document.getElementById('cfg-allow-cam')) document.getElementById('cfg-allow-cam').checked = s.ALLOW_CINEMA_CAM !== false;
                if (document.getElementById('cfg-auto-upgrade-cam')) document.getElementById('cfg-auto-upgrade-cam').checked = s.AUTO_UPGRADE_CAM !== false;
            } catch (e) {
                console.warn('Erro ao carregar settings:', e);
            }
        }

        async function handleSaveSettings(e) {
            e.preventDefault();
            if (!adminToken) return;

            const payload = {
                MAX_CONCURRENT_DOWNLOADS: parseInt(document.getElementById('cfg-max-downloads')?.value || 3, 10),
                MAX_CONCURRENT_TRANSCODES: parseInt(document.getElementById('cfg-max-transcodes')?.value || 2, 10),
                MAX_CONCURRENT_UPLOADS: parseInt(document.getElementById('cfg-max-uploads')?.value || 2, 10),
                MAX_CONCURRENT_JOBS: parseInt(document.getElementById('cfg-max-jobs')?.value || 10, 10),
                ECO_DOWNLOAD_LIMIT_MB: parseFloat(document.getElementById('cfg-eco-download-limit')?.value || 3.0),
                ECO_UPLOAD_LIMIT_KB: parseInt(document.getElementById('cfg-eco-upload-limit')?.value || 30, 10),
                MAX_TORRENT_PEER_CONNECTIONS: parseInt(document.getElementById('cfg-max-peers')?.value || 35, 10),
                MAX_TORRENT_UPLOAD_LIMIT_KB: parseInt(document.getElementById('cfg-upload-limit-kb')?.value || 250, 10),
                TELEGRAM_UPLOAD_MAX_SOCKETS: parseInt(document.getElementById('cfg-tg-sockets')?.value || 4, 10),
                MIN_DOWNLOAD_SPEED_MB: parseFloat(document.getElementById('cfg-min-speed-mb')?.value || 1.5),
                MAX_TEMP_DISK_GB: parseInt(document.getElementById('cfg-max-disk-gb')?.value || 100, 10),
                FFMPEG_THREADS_PER_JOB: parseInt(document.getElementById('cfg-ffmpeg-threads')?.value || 6, 10),
                AUTO_FEEDER_INTERVAL_HOURS: parseInt(document.getElementById('cfg-feeder-hours')?.value || 4, 10),
                SERVER_HOST: document.getElementById('cfg-server-host')?.value || 'brasilflix.kapsu.com.br',
                AUTO_FEEDER_ENABLED: document.getElementById('cfg-feeder-enabled')?.checked ?? true,
                ALLOW_CINEMA_CAM: document.getElementById('cfg-allow-cam')?.checked ?? true,
                AUTO_UPGRADE_CAM: document.getElementById('cfg-auto-upgrade-cam')?.checked ?? true
            };


            try {
                const res = await fetch('/api/admin/settings', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao salvar configurações.');
                showToast(data.message || 'Configurações atualizadas com sucesso!', 'success');
                loadAdminSettings();
            } catch (err) {
                showToast(err.message || 'Erro ao salvar configurações.', 'error');
            }
        }


        // ─── PESOS & PRIORIDADES DA FILA ──────────────────────────────────────────
        const PRIORITY_META = {
            VIP_USER: { icon: '👑', desc: 'Pedidos feitos por clientes com assinatura VIP ativa (Fura-Fila Máximo).', color: '#eab308' },
            CAM_UPGRADE: { icon: '🎬', desc: 'Upgrade automático de filmes de Cinema (CAM) para qualidade 1080p Oficial assim que disponíveis.', color: '#ef4444' },
            SERIES: { icon: '📺', desc: 'Continuação de temporadas e episódios de séries e doramas já iniciados no catálogo.', color: '#3b82f6' },
            UPGRADE_DUB: { icon: '🎙️', desc: 'Upgrade de títulos disponíveis apenas com legenda para áudio Dublado (PT-BR).', color: '#10b981' },
            FREE_USER: { icon: '🍿', desc: 'Pedidos de filmes e séries feitos por visitantes e usuários do plano gratuito.', color: '#06b6d4' },
            ANIME: { icon: '⛩️', desc: 'Séries e episódios de animes (produções contínuas com muitos episódios).', color: '#a855f7' },
            FEEDER: { icon: '🤖', desc: 'Sugestões automáticas do Auto-Feeder para títulos populares em alta no TMDB.', color: '#64748b' }
        };

        async function loadAdminPriorities() {
            if (!adminToken) return;
            const container = document.getElementById('admin-priorities-cards-container');
            if (!container) return;

            try {
                const res = await fetch('/api/admin/priorities', { headers: getAuthHeaders() });
                if (!res.ok) throw new Error('Falha ao carregar prioridades.');
                const data = await res.json();

                const items = data.items || [];
                if (items.length === 0) {
                    container.innerHTML = '<div style="color: var(--text-muted); text-align: center;">Nenhuma prioridade encontrada.</div>';
                    return;
                }

                container.innerHTML = items.map(item => {
                    const meta = PRIORITY_META[item.key] || { icon: '📌', desc: 'Item da esteira', color: '#60a5fa' };
                    return `
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; border-left: 4px solid ${meta.color};">
                            <div>
                                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                                    <div style="font-size: 14px; font-weight: 800; color: #fff; display: flex; align-items: center; gap: 8px;">
                                        <span>${meta.icon}</span> ${item.label}
                                    </div>
                                    <span style="font-size: 11px; font-weight: 700; color: ${meta.color}; background: rgba(255,255,255,0.05); padding: 2px 8px; border-radius: 6px;">
                                        Nível ${item.value}
                                    </span>
                                </div>
                                <div style="font-size: 12px; color: var(--text-muted); line-height: 1.4;">
                                    ${meta.desc}
                                </div>
                            </div>

                            <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.04);">
                                <label style="font-size: 12px; font-weight: 700; color: #cbd5e1;">Peso (1 a 10):</label>
                                <select id="prio-val-${item.key}" name="${item.key}" class="search-input" style="width: 110px; font-weight: 800; font-size: 13px; text-align: center;">
                                    ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `
                                        <option value="${n}" ${n === item.value ? 'selected' : ''}>
                                            ${n} ${n === 1 ? '⚡ Mais Alto' : (n === 10 ? '💤 Mais Baixo' : '')}
                                        </option>
                                    `).join('')}
                                </select>
                            </div>
                        </div>
                    `;
                }).join('');

            } catch (err) {
                console.warn('Erro ao carregar prioridades:', err);
                container.innerHTML = `<div style="color: #f87171; text-align: center;">Erro ao carregar prioridades: ${err.message}</div>`;
            }
        }

        async function handleSavePriorities(e) {
            e.preventDefault();
            if (!adminToken) return;

            const payload = {};
            const keys = ['VIP_USER', 'CAM_UPGRADE', 'SERIES', 'UPGRADE_DUB', 'FREE_USER', 'ANIME', 'FEEDER'];
            for (const key of keys) {
                const el = document.getElementById(`prio-val-${key}`);
                if (el) {
                    payload[key] = parseInt(el.value, 10);
                }
            }

            try {
                const res = await fetch('/api/admin/priorities', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(payload)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao salvar prioridades.');
                showToast(data.message || 'Pesos de prioridade atualizados com sucesso!', 'success');
                loadAdminPriorities();
            } catch (err) {
                showToast(err.message || 'Erro ao salvar.', 'error');
            }
        }

        async function handleResetPriorities() {
            if (!adminToken) return;
            if (!confirm('Deseja restaurar as prioridades para os valores padrão de fábrica?\n\n- VIP: 1\n- Upgrade Cinema: 2\n- Séries: 3\n- Upgrade Dublagem: 4\n- Grátis: 5\n- Animes: 6\n- Auto-Feeder: 7')) return;

            const defaults = {
                VIP_USER: 1,
                CAM_UPGRADE: 2,
                SERIES: 3,
                UPGRADE_DUB: 4,
                FREE_USER: 5,
                ANIME: 6,
                FEEDER: 7
            };

            try {
                const res = await fetch('/api/admin/priorities', {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify(defaults)
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao restaurar padrões.');
                showToast('Prioridades restauradas aos valores de fábrica!', 'success');
                loadAdminPriorities();
            } catch (err) {
                showToast(err.message || 'Erro ao restaurar.', 'error');
            }
        }

        /* ═══════════════════════════════════════════════════════════════════════
           🍿 SISTEMA 1: PEDIDOS DE FILMES & SÉRIES COM BUSCA TMDB EM TEMPO REAL
           ═══════════════════════════════════════════════════════════════════════ */

        let tmdbSearchDebounceTimer = null;
        let reqMediaBasket = [];
        let _lastTMDBResults = [];

        function openRequestMediaModal(prefillTitle = '') {
            const modal = document.getElementById('request-media-modal');
            if (!modal) return;
            modal.style.display = 'flex';

            const input = document.getElementById('req-media-input');
            const resultsArea = document.getElementById('req-results-area');
            const initialTip = document.getElementById('req-initial-tip');

            if (input) {
                input.value = prefillTitle || '';
                setTimeout(() => input.focus(), 120);
                if (prefillTitle) {
                    handleTMDBAutocomplete(prefillTitle);
                } else {
                    if (resultsArea) resultsArea.style.display = 'none';
                    if (initialTip) initialTip.style.display = 'block';
                }
            }
            renderReqBasket();
        }

        function closeRequestMediaModal(e) {
            if (e && !isSafeModalBackdropClick(e, 'request-media-modal')) return;
            const modal = document.getElementById('request-media-modal');
            if (modal) modal.style.display = 'none';
        }

        function handleTMDBAutocomplete(query) {
            const q = (query || '').trim();
            const resultsArea = document.getElementById('req-results-area');
            const initialTip = document.getElementById('req-initial-tip');
            const franchiseBox = document.getElementById('req-franchise-container');
            const listEl = document.getElementById('req-results-list');

            if (q.length < 2) {
                if (resultsArea) resultsArea.style.display = 'none';
                if (initialTip) initialTip.style.display = 'block';
                return;
            }

            clearTimeout(tmdbSearchDebounceTimer);
            tmdbSearchDebounceTimer = setTimeout(async () => {
                try {
                    const res = await fetch('/api/tmdb/search-all?query=' + encodeURIComponent(q));
                    const data = await res.json();
                    const results = data.results || [];
                    _lastTMDBResults = results;

                    if (initialTip) initialTip.style.display = 'none';
                    if (resultsArea) resultsArea.style.display = 'block';

                    if (results.length === 0) {
                        if (franchiseBox) franchiseBox.innerHTML = '';
                        if (listEl) {
                            listEl.innerHTML = `
                                <div style="padding: 24px 16px; text-align: center; color: #94a3b8; font-size: 13px;">
                                    <div>Nenhum filme ou série encontrado com esse nome no TMDB.</div>
                                    <button type="button" onclick="addManualTitle('${q.replace(/'/g, "\\'")}')" class="btn-modal btn-modal-primary" style="margin-top: 12px; padding: 8px 16px; font-size: 12px; border-radius: 8px;">
                                        + Pedir "${q}" como título avulso
                                    </button>
                                </div>
                            `;
                        }
                        return;
                    }

                    // 1. Destaque Especial da Franquia (se existir)
                    const collectionItem = results.find(r => r.isCollection);
                    if (collectionItem && Array.isArray(collectionItem.filmes) && collectionItem.filmes.length > 1 && franchiseBox) {
                        const totalF = collectionItem.filmes.length;
                        const allSelected = collectionItem.filmes.every(f => reqMediaBasket.some(b => isSameMedia(b, f)));

                        franchiseBox.innerHTML = `
                            <div class="req-franchise-card">
                                <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                                    <img src="${collectionItem.poster || '/assets/no-poster.png'}" alt="Poster" style="width: 44px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" onerror="this.src='/assets/no-poster.png'">
                                    <div style="min-width: 0;">
                                        <div style="display: inline-block; background: #eab308; color: #000; font-size: 10px; font-weight: 900; padding: 2px 6px; border-radius: 4px; text-transform: uppercase;">
                                            ⭐ FRANQUIA COMPLETA
                                        </div>
                                        <h4 style="color: #fff; font-size: 14.5px; font-weight: 800; margin: 3px 0 2px 0; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                            ${collectionItem.nome}
                                        </h4>
                                        <div style="font-size: 11.5px; color: #fde047; font-weight: 600;">
                                            ${totalF} filmes disponíveis (${collectionItem.ano || 'Saga completa'})
                                        </div>
                                    </div>
                                </div>
                                <button type="button" class="req-franchise-btn ${allSelected ? 'selected' : ''}" onclick="toggleFranchiseAll()">
                                    ${allSelected ? '✓ Franquia Toda Selecionada' : `+ Selecionar Franquia Toda (${totalF})`}
                                </button>
                            </div>
                        `;
                    } else if (franchiseBox) {
                        franchiseBox.innerHTML = '';
                    }

                    // 2. Lista dos Filmes Encontrados
                    const movieItems = results.filter(r => !r.isCollection);
                    if (listEl) {
                        listEl.innerHTML = movieItems.map((item, idx) => {
                            const isSel = reqMediaBasket.some(b => isSameMedia(b, item));
                            let typeTag = '🎬 Filme';
                            if (item.tipo === 'anime') typeTag = '🌸 Anime';
                            else if (item.tipo === 'dorama') typeTag = '🇰🇷 Dorama';
                            else if (item.tipo === 'serie' || item.tipo === 'tv') typeTag = '📺 Série';

                            return `
                                <div class="req-result-item ${isSel ? 'is-selected' : ''}" id="req-item-row-${idx}">
                                    <div style="display: flex; align-items: center; gap: 10px; min-width: 0;">
                                        <img src="${item.poster || '/assets/no-poster.png'}" alt="${escapeHtml(item.nome)}" style="width: 36px; height: 50px; object-fit: cover; border-radius: 5px; flex-shrink: 0;" onerror="this.src='/assets/no-poster.png'">
                                        <div style="min-width: 0;">
                                            <div style="font-size: 13.5px; font-weight: 800; color: #fff; line-height: 1.2; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">
                                                ${item.nome} ${item.ano ? `<span style="color: #94a3b8; font-weight: 500;">(${item.ano})</span>` : ''}
                                            </div>
                                            <div style="font-size: 11px; color: #94a3b8; margin-top: 2px;">
                                                ${typeTag} ${item.nota ? '• ⭐ ' + Number(item.nota).toFixed(1) : ''}
                                            </div>
                                        </div>
                                    </div>
                                    <button type="button" class="req-btn-add ${isSel ? 'selected' : ''}" onclick="toggleMovieItem(${idx})">
                                        ${isSel ? '✓ Adicionado' : '+ Adicionar'}
                                    </button>
                                </div>
                            `;
                        }).join('');
                    }

                } catch (e) {
                    if (listEl) listEl.innerHTML = '<div style="padding: 15px; text-align: center; color: #ef4444; font-size: 12px;">Erro ao buscar sugestões. Tente novamente.</div>';
                }
            }, 220);
        }

        function isSameMedia(a, b) {
            if (a.tmdbId && b.tmdbId) return a.tmdbId === b.tmdbId;
            if (a.tmdbId || b.tmdbId) return false; // um tem id e o outro não → diferentes
            return a.nome.toLowerCase() === b.nome.toLowerCase();
        }

        function toggleMovieItem(idx) {
            const movieItems = _lastTMDBResults.filter(r => !r.isCollection);
            const item = movieItems[idx];
            if (!item) return;

            const existingIdx = reqMediaBasket.findIndex(b => isSameMedia(b, item));
            if (existingIdx >= 0) {
                reqMediaBasket.splice(existingIdx, 1);
            } else {
                reqMediaBasket.push({
                    tmdbId: item.tmdbId,
                    nome: item.nome,
                    nomeOriginal: item.nomeOriginal || item.nome,
                    ano: item.ano || '',
                    poster: item.poster || '',
                    tipo: item.tipo || 'filme'
                });
            }

            renderReqBasket();
            refreshResultsSelectionVisuals();
        }

        function toggleFranchiseAll() {
            const col = _lastTMDBResults.find(r => r.isCollection);
            if (!col || !Array.isArray(col.filmes)) return;

            const allSelected = col.filmes.every(f => reqMediaBasket.some(b => isSameMedia(b, f)));

            if (allSelected) {
                // Desmarca todos da franquia
                reqMediaBasket = reqMediaBasket.filter(b => !col.filmes.some(f => isSameMedia(f, b)));
                showToast(`Franquia "${col.nome}" removida da seleção.`, 'info');
            } else {
                // Marca todos os filmes da franquia
                let added = 0;
                for (const f of col.filmes) {
                    if (!reqMediaBasket.some(b => isSameMedia(b, f))) {
                        reqMediaBasket.push({
                            tmdbId: f.tmdbId,
                            nome: f.nome,
                            nomeOriginal: f.nomeOriginal || f.nome,
                            ano: f.ano || '',
                            poster: f.poster || '',
                            tipo: 'filme'
                        });
                        added++;
                    }
                }
                showToast(`🎉 ${added} filmes da franquia "${col.nome}" adicionados ao pedido!`, 'success');
            }

            renderReqBasket();
            refreshResultsSelectionVisuals();
        }

        function addManualTitle(title) {
            if (!title) return;
            if (!reqMediaBasket.some(b => b.nome.toLowerCase() === title.toLowerCase())) {
                reqMediaBasket.push({
                    tmdbId: null,
                    nome: title,
                    nomeOriginal: title,
                    ano: '',
                    poster: '/assets/no-poster.png',
                    tipo: 'filme'
                });
                renderReqBasket();
                refreshResultsSelectionVisuals();
                showToast(`✅ "${title}" adicionado ao pedido!`, 'success');
            }
        }

        function removeBasketItem(idx) {
            if (idx >= 0 && idx < reqMediaBasket.length) {
                const removed = reqMediaBasket.splice(idx, 1);
                renderReqBasket();
                refreshResultsSelectionVisuals();
                if (removed[0]) showToast(`Removido: "${removed[0].nome}"`, 'info');
            }
        }

        function clearReqBasket() {
            if (reqMediaBasket.length === 0) return;
            reqMediaBasket = [];
            renderReqBasket();
            refreshResultsSelectionVisuals();
            showToast('Seleção limpa.', 'info');
        }

        function refreshResultsSelectionVisuals() {
            // Atualiza botões da lista de filmes
            const movieItems = _lastTMDBResults.filter(r => !r.isCollection);
            movieItems.forEach((item, idx) => {
                const row = document.getElementById(`req-item-row-${idx}`);
                if (!row) return;
                const isSel = reqMediaBasket.some(b => isSameMedia(b, item));
                if (isSel) row.classList.add('is-selected');
                else row.classList.remove('is-selected');

                const btn = row.querySelector('.req-btn-add');
                if (btn) {
                    if (isSel) {
                        btn.classList.add('selected');
                        btn.textContent = '✓ Adicionado';
                    } else {
                        btn.classList.remove('selected');
                        btn.textContent = '+ Adicionar';
                    }
                }
            });

            // Atualiza botão da franquia
            const col = _lastTMDBResults.find(r => r.isCollection);
            const franchiseBtn = document.querySelector('.req-franchise-btn');
            if (col && Array.isArray(col.filmes) && franchiseBtn) {
                const allSelected = col.filmes.every(f => reqMediaBasket.some(b => isSameMedia(b, f)));
                if (allSelected) {
                    franchiseBtn.classList.add('selected');
                    franchiseBtn.textContent = '✓ Franquia Toda Selecionada';
                } else {
                    franchiseBtn.classList.remove('selected');
                    franchiseBtn.textContent = `+ Selecionar Franquia Toda (${col.filmes.length})`;
                }
            }
        }

        function renderReqBasket() {
            const label = document.getElementById('req-selected-count-label');
            const chips = document.getElementById('req-selected-chips');
            const btnClear = document.getElementById('btn-clear-selection');
            const btnSubmit = document.getElementById('btn-submit-req-media');

            const total = reqMediaBasket.length;

            if (total === 0) {
                if (label) label.textContent = '🛒 Nenhum título selecionado';
                if (btnClear) btnClear.style.display = 'none';
                if (chips) {
                    chips.innerHTML = '<span style="color: #64748b; font-size: 12px; font-style: italic;">Clique em "+ Adicionar" nos filmes acima ou na franquia toda para montar seu pedido.</span>';
                }
                if (btnSubmit) {
                    btnSubmit.textContent = 'Pedir 0 Título(s)';
                    btnSubmit.disabled = true;
                    btnSubmit.style.opacity = '0.45';
                    btnSubmit.style.cursor = 'not-allowed';
                    btnSubmit.style.background = '#e50914';
                }
            } else {
                if (label) label.textContent = `🛒 ${total} título(s) selecionado(s):`;
                if (btnClear) btnClear.style.display = 'block';
                if (chips) {
                    chips.innerHTML = reqMediaBasket.map((item, idx) => `
                        <div class="req-chip">
                            <span>${item.nome} ${item.ano ? `(${item.ano})` : ''}</span>
                            <button type="button" class="req-chip-del" onclick="removeBasketItem(${idx})" title="Remover">✕</button>
                        </div>
                    `).join('');
                }
                if (btnSubmit) {
                    btnSubmit.textContent = total > 1
                        ? `🚀 Confirmar Pedido de ${total} Filmes`
                        : `🚀 Confirmar Pedido (${reqMediaBasket[0].nome})`;
                    btnSubmit.disabled = false;
                    btnSubmit.style.opacity = '1';
                    btnSubmit.style.cursor = 'pointer';
                    btnSubmit.style.background = '#16a34a'; // Verde vibrante de confirmação
                }
            }
        }

        async function handleRequestMediaSubmitDirect() {
            const btn = document.getElementById('btn-submit-req-media');
            const total = reqMediaBasket.length;

            if (total === 0) {
                showToast('Selecione ao menos 1 título acima para fazer o pedido.', 'warning');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerText = `Enviando ${total} pedido(s)...`;
            }

            try {
                const res = await fetch('/api/user/pedidos/create', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(userAuthToken ? { 'Authorization': 'Bearer ' + userAuthToken } : {})
                    },
                    body: JSON.stringify({
                        itens: reqMediaBasket.map(item => ({
                            nome: item.nome,
                            tipo: item.tipo || 'filme',
                            temporada: item.tipo !== 'filme' ? 'todas as temporadas' : '',
                            idioma: 'Dual Áudio (Dublado + Legendado)',
                            tmdb_id: item.tmdbId ? Number(item.tmdbId) : null,
                            poster_url: item.poster,
                            ano: item.ano,
                            detalhes: ''
                        }))
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao enviar pedido(s)');

                showToast(data.message || `🎉 ${total} pedido(s) registrado(s) com sucesso!`, 'success');
                reqMediaBasket = [];
                renderReqBasket();
                closeRequestMediaModal();

                if (typeof loadUserRequests === 'function' && userAuthToken) {
                    loadUserRequests();
                }
            } catch (err) {
                showToast(err.message || 'Erro ao enviar pedido.', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    renderReqBasket();
                }
            }
        }


        /* ═══════════════════════════════════════════════════════════════════════
           💬 SISTEMA 2: CENTRAL DE AJUDA & SUPORTE / TICKETS (SEM CATEGORIAS)
           ═══════════════════════════════════════════════════════════════════════ */

        let currentTicketAttachedImageUrl = '';

        function openSupportTicketModal(prefillTitle = '') {
            const modal = document.getElementById('support-ticket-modal');
            if (!modal) return;
            modal.style.display = 'flex';

            const titleInput = document.getElementById('ticket-title-input');
            const msgInput = document.getElementById('ticket-msg-input');
            const contactInput = document.getElementById('ticket-contact-input');

            if (titleInput) titleInput.value = prefillTitle || '';
            if (msgInput) msgInput.value = '';
            if (contactInput && currentUser) {
                contactInput.value = currentUser.email || (currentUser.username ? '@' + currentUser.username : '');
            }

            clearTicketImage();
            setTimeout(() => {
                if (titleInput) titleInput.focus();
            }, 100);
        }

        function closeSupportTicketModal(e) {
            if (e && e.target && e.target !== e.currentTarget && !e.target.classList.contains('modal-close')) return;
            const modal = document.getElementById('support-ticket-modal');
            if (modal) modal.style.display = 'none';
        }

        function previewTicketImageUrl(url) {
            currentTicketAttachedImageUrl = (url || '').trim();
            const box = document.getElementById('ticket-image-preview-box');
            const img = document.getElementById('ticket-preview-img');
            if (box && img) {
                if (currentTicketAttachedImageUrl) {
                    img.src = currentTicketAttachedImageUrl;
                    box.style.display = 'inline-block';
                } else {
                    box.style.display = 'none';
                }
            }
        }

        async function handleTicketImageUpload(input) {
            if (!input.files || !input.files[0]) return;
            const file = input.files[0];
            if (file.size > 5 * 1024 * 1024) {
                showToast('Imagem muito grande. Máximo 5MB.', 'error');
                return;
            }

            const formData = new FormData();
            formData.append('image', file);

            try {
                showToast('Carregando imagem...', 'info');
                const res = await fetch('/api/user/ticket-image-upload', {
                    method: 'POST',
                    body: formData
                });
                const data = await res.json();
                if (data.success && data.url) {
                    previewTicketImageUrl(data.url);
                    const urlInput = document.getElementById('ticket-img-url-input');
                    if (urlInput) urlInput.value = data.url;
                    showToast('Print anexado com sucesso!', 'success');
                } else {
                    showToast('Erro ao subir imagem.', 'error');
                }
            } catch (e) {
                showToast('Erro ao enviar print.', 'error');
            }
        }

        function clearTicketImage() {
            currentTicketAttachedImageUrl = '';
            const box = document.getElementById('ticket-image-preview-box');
            const urlInput = document.getElementById('ticket-img-url-input');
            const fileInput = document.getElementById('ticket-file-input');
            if (box) box.style.display = 'none';
            if (urlInput) urlInput.value = '';
            if (fileInput) fileInput.value = '';
        }

        async function handleSupportTicketSubmit(e) {
            e.preventDefault();
            const btn = document.getElementById('btn-submit-support-ticket');
            const title = document.getElementById('ticket-title-input').value.trim();
            const msg = document.getElementById('ticket-msg-input').value.trim();
            const contact = document.getElementById('ticket-contact-input').value.trim();
            const imageUrl = currentTicketAttachedImageUrl || document.getElementById('ticket-img-url-input')?.value.trim() || '';

            if (!title || !msg) {
                showToast('Preencha o título e a mensagem do chamado.', 'warning');
                return;
            }

            if (btn) {
                btn.disabled = true;
                btn.innerText = 'Enviando chamado...';
            }

            try {
                const res = await fetch('/api/user/tickets/create', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(userAuthToken ? { 'Authorization': 'Bearer ' + userAuthToken } : {})
                    },
                    body: JSON.stringify({
                        titulo: title,
                        mensagem: msg,
                        imagem_url: imageUrl,
                        contato: contact
                    })
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Erro ao enviar chamado');

                showToast('💬 Chamado de suporte enviado com sucesso! Responderemos em breve.', 'success');
                closeSupportTicketModal();
            } catch (err) {
                showToast(err.message || 'Erro ao abrir ticket de suporte.', 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = '📨 Enviar Chamado de Suporte';
                }
            }
        }


        /* ═══════════════════════════════════════════════════════════════════════
           📋 LISTAGEM APRIMORADA: MEUS PEDIDOS (USUÁRIO) & ADMIN TICKETS
           ═══════════════════════════════════════════════════════════════════════ */

        async function loadUserRequests() {
            const listEl = document.getElementById('settings-requests-list');
            if (!listEl || !userAuthToken) return;

            listEl.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">Carregando pedidos...</div>';

            try {
                const res = await fetch('/api/user/requests', {
                    headers: { 'Authorization': `Bearer ${userAuthToken}` }
                });
                const data = await res.json();
                const requests = data.requests || [];

                const badge = document.getElementById('settings-requests-badge');
                if (badge) badge.innerText = requests.length;

                if (requests.length === 0) {
                    listEl.innerHTML = `
                        <div style="text-align: center; padding: 32px 16px; color: var(--text-muted);">
                            <div style="font-size: 36px; margin-bottom: 8px;">🍿</div>
                            <div style="font-weight: 800; color: #fff; font-size: 15px;">Você ainda não fez nenhum pedido de filme ou série.</div>
                            <div style="font-size: 12px; margin-top: 4px;">Clique em "🍿 Fazer Pedido de Filme/Série" para solicitar qualquer título ao catálogo.</div>
                        </div>
                    `;
                    return;
                }

                listEl.innerHTML = requests.map(req => {
                    const status = req.status || (req.processado ? 'adicionado' : 'pendente');
                    let statusLabel = '⏳ Pendente';
                    let statusColor = '#f59e0b';
                    let statusBg = 'rgba(245, 158, 11, 0.15)';

                    if (status === 'adicionado' || req.processado) {
                        statusLabel = '✓ Adicionado ao Catálogo';
                        statusColor = '#34d399';
                        statusBg = 'rgba(52, 211, 153, 0.15)';
                    } else if (status === 'na_fila') {
                        statusLabel = '🚀 Na Fila de Download';
                        statusColor = '#60a5fa';
                        statusBg = 'rgba(96, 165, 250, 0.15)';
                    } else if (status === 'recusado') {
                        statusLabel = '✕ Não Encontrado / Recusado';
                        statusColor = '#f87171';
                        statusBg = 'rgba(248, 113, 113, 0.15)';
                    }

                    const dateStr = req.created_at ? new Date(req.created_at).toLocaleDateString('pt-BR') : '';
                    const posterHtml = req.poster_url
                        ? `<img src="${req.poster_url}" alt="${req.nome}" style="width: 44px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.5);">`
                        : `<div style="width: 44px; height: 60px; border-radius: 6px; background: rgba(255,255,255,0.06); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0;">${req.tipo === 'serie' ? '📺' : '🎬'}</div>`;

                    return `
                        <div class="settings-request-row" style="display: flex; align-items: center; justify-content: space-between; padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); margin-bottom: 10px; gap: 12px;">
                            <div style="display: flex; align-items: center; gap: 12px; min-width: 0;">
                                ${posterHtml}
                                <div style="min-width: 0;">
                                    <div style="font-size: 14.5px; font-weight: 800; color: #ffffff; line-height: 1.2;">${req.nome} ${req.ano ? '(' + req.ano + ')' : ''}</div>
                                    <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 3px;">
                                        ${req.tipo === 'serie' ? '📺 Série' : '🎬 Filme'} ${req.temporada ? '• ' + req.temporada : ''} ${req.idioma ? '• ' + req.idioma : ''}
                                    </div>
                                    <div style="font-size: 10.5px; color: rgba(255,255,255,0.4); margin-top: 2px;">Solicitado em ${dateStr}</div>
                                </div>
                            </div>
                            <span style="font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 99px; background: ${statusBg}; color: ${statusColor}; white-space: nowrap;">
                                ${statusLabel}
                            </span>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                listEl.innerHTML = '<div style="text-align: center; padding: 20px; color: #f87171;">Erro ao carregar lista de pedidos.</div>';
            }
        }

        async function loadAdminRequests() {
            if (!adminToken) return;
            const tbody = document.getElementById('admin-requests-tbody');
            if (!tbody) return;

            try {
                const res = await fetch('/api/admin/pedidos', { headers: getAuthHeaders() });
                if (!res.ok) return;
                const data = await res.json();
                const list = data.pedidos || [];

                if (list.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: var(--text-muted);">Nenhum pedido de usuário registrado.</td></tr>';
                    return;
                }

                tbody.innerHTML = list.slice(-80).reverse().map(p => {
                    const status = p.status || (p.processado ? 'adicionado' : 'pendente');
                    const isProc = status === 'adicionado';
                    const isProcessing = status === 'em_processamento' || status === 'na_fila';
                    const dataStr = p.data ? new Date(p.data).toLocaleDateString('pt-BR') : '-';

                    let statusLabel = '⏳ PENDENTE';
                    let statusColor = '#f59e0b';
                    if (isProc) {
                        statusLabel = '✓ ATENDIDO';
                        statusColor = '#34d399';
                    } else if (isProcessing) {
                        statusLabel = '⚡ NA FILA / PROCESSANDO';
                        statusColor = '#38bdf8';
                    } else if (status === 'recusado') {
                        statusLabel = '✕ RECUSADO';
                        statusColor = '#f87171';
                    }

                    const posterImg = p.posterUrl
                        ? `<img src="${p.posterUrl}" style="width: 32px; height: 44px; object-fit: cover; border-radius: 4px; vertical-align: middle; margin-right: 8px;">`
                        : '';

                    let tipoDesc = '🎬 Filme';
                    if (p.tipo === 'anime') tipoDesc = '🌸 Anime';
                    else if (p.tipo === 'dorama') tipoDesc = '🇰🇷 Dorama';
                    else if (p.tipo === 'serie') tipoDesc = '📺 Série';

                    return `
                        <tr>
                            <td>
                                <div style="display: flex; align-items: center;">
                                    ${posterImg}
                                    <div>
                                        <strong>${p.nome} ${p.ano ? '(' + p.ano + ')' : ''}</strong>
                                        <div style="font-size: 11px; color: var(--text-muted);">
                                            ${tipoDesc} ${p.temporada ? '• ' + p.temporada : ''} ${p.idioma ? '• ' + p.idioma : ''}
                                        </div>
                                    </div>
                                </div>
                            </td>
                            <td>
                                <div>@${p.username || 'Usuário'}</div>
                                <span style="font-size: 10px; color: ${p.isAssinante ? '#fbbf24' : '#9ca3af'}; font-weight: 700;">
                                    ${p.isAssinante ? '👑 VIP Assinante' : '👤 Grátis'}
                                </span>
                            </td>
                            <td>
                                <span style="font-size: 11px; font-weight: 800; color: ${statusColor};">
                                    ${statusLabel}
                                </span>
                            </td>
                            <td>${dataStr}</td>
                            <td style="text-align: right; white-space: nowrap;">
                                ${!isProc && !isProcessing ? `<button class="btn-action btn-action-primary" onclick="handleEnqueueRequest('${p.id}')" title="Adicionar à fila de downloads">🚀 Baixar</button>` : ''}
                                <button class="btn-action" onclick="handleAdminSetPedidoStatus('${p.id}', '${isProc ? 'pendente' : 'adicionado'}')" title="Alternar status">
                                    ${isProc ? '🔄 Reabrir' : '✅ Concluir'}
                                </button>
                                ${isProc ? `<button class="btn-action" onclick="handleAdminReavaliarPedidos('${p.id}')" title="Reavaliar entregáveis contra o catálogo">🔍 Auditar</button>` : ''}
                                <button class="btn-action btn-action-danger" onclick="handleDeleteRequest('${p.id}')" title="Excluir pedido">✕</button>
                            </td>
                        </tr>
                    `;
                }).join('');
            } catch (e) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 20px;">Falha ao carregar pedidos.</td></tr>';
            }
        }

        async function handleAdminReavaliarPedidos(pedidoId = null) {
            try {
                showToast('Verificando integridade de pedidos no catálogo...', 'info');
                const url = pedidoId ? `/api/admin/pedidos/${pedidoId}/reavaliar` : '/api/admin/pedidos/reavaliar';
                const res = await fetch(url, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ pedidoId })
                });
                const data = await res.json();
                if (data.success) {
                    if (data.totalReabertos > 0) {
                        showToast(`${data.totalReabertos} pedido(s) reaberto(s) por falta de entregáveis solicitados.`, 'warning');
                    } else {
                        showToast('Todos os pedidos atendidos possuem as versões solicitadas no catálogo.', 'success');
                    }
                    loadAdminRequests();
                } else {
                    showToast(data.error || 'Falha ao reavaliar pedidos.', 'error');
                }
            } catch (e) {
                showToast('Erro ao reavaliar pedidos.', 'error');
            }
        }

        async function handleAdminSetPedidoStatus(pedidoId, status) {
            try {
                const res = await fetch(`/api/admin/pedidos/${pedidoId}/status`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({ status })
                });
                if (res.ok) {
                    showToast('Status do pedido atualizado.', 'success');
                    loadAdminRequests();
                }
            } catch (e) {
                showToast('Erro ao atualizar status.', 'error');
            }
        }

        async function loadAdminTickets() {
            if (!adminToken) return;
            const container = document.getElementById('admin-tickets-container');
            if (!container) return;

            container.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);">Carregando chamados...</div>';

            try {
                const res = await fetch('/api/admin/tickets', { headers: getAuthHeaders() });
                if (!res.ok) throw new Error();
                const data = await res.json();
                const tickets = data.tickets || [];

                if (tickets.length === 0) {
                    container.innerHTML = `
                        <div style="text-align: center; padding: 40px 20px; color: var(--text-muted);">
                            <div style="font-size: 36px; margin-bottom: 8px;">🎉</div>
                            <div style="font-weight: 800; color: #fff;">Nenhum ticket de suporte em aberto!</div>
                        </div>
                    `;
                    return;
                }

                container.innerHTML = tickets.map(t => {
                    const dateStr = t.created_at ? new Date(t.created_at).toLocaleString('pt-BR') : '-';
                    let statusBadge = '<span style="color: #f59e0b; background: rgba(245, 158, 11, 0.15); padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 800;">⏳ Aberto</span>';
                    if (t.status === 'resolvido') {
                        statusBadge = '<span style="color: #34d399; background: rgba(52, 211, 153, 0.15); padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 800;">✓ Resolvido</span>';
                    } else if (t.status === 'em_atendimento') {
                        statusBadge = '<span style="color: #60a5fa; background: rgba(96, 165, 250, 0.15); padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: 800;">💬 Em Atendimento</span>';
                    }

                    const imgHtml = t.imagem_url
                        ? `
                            <div style="margin-top: 10px;">
                                <a href="${t.imagem_url}" target="_blank" title="Clique para abrir imagem em tamanho real">
                                    <img src="${t.imagem_url}" alt="Print Anexado" style="max-width: 240px; max-height: 140px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); object-fit: contain; background: #000;">
                                </a>
                            </div>
                          `
                        : '';

                    const responseHtml = t.resposta
                        ? `<div class="admin-ticket-response-box"><strong>Resposta da Equipe:</strong> ${t.resposta}</div>`
                        : '';

                    return `
                        <div class="admin-ticket-card">
                            <div class="admin-ticket-header">
                                <div>
                                    <h4 class="admin-ticket-title">${t.titulo || 'Chamado de Suporte #' + t.id}</h4>
                                    <div class="admin-ticket-meta">
                                        Por: <strong>@${t.username || 'Visitante'}</strong> (ID: ${t.user_id || 'N/A'}) ${t.contato ? '• Contato: <span style="color: #38bdf8;">' + t.contato + '</span>' : ''} • ${dateStr}
                                    </div>
                                </div>
                                <div>${statusBadge}</div>
                            </div>
                            <div class="admin-ticket-body">${t.mensagem}</div>
                            ${imgHtml}
                            ${responseHtml}
                            <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px;">
                                <button class="btn-action btn-action-primary" onclick="handleAdminReplyTicket('${t.id}', '${t.status}')">
                                    📝 Responder / Mudar Status
                                </button>
                                <button class="btn-action btn-action-danger" onclick="handleAdminDeleteTicket('${t.id}')">
                                    🗑️ Excluir
                                </button>
                            </div>
                        </div>
                    `;
                }).join('');
            } catch (e) {
                container.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 20px;">Erro ao carregar tickets de suporte.</div>';
            }
        }

        async function handleAdminReplyTicket(ticketId, currentStatus) {
            const resposta = prompt('Digite sua resposta / observação para este ticket (ou deixe em branco para apenas mudar status):');
            if (resposta === null) return;

            const novoStatus = confirm('Deseja marcar este ticket como RESOLVIDO? (Clique Cancelar para manter Em Atendimento)')
                ? 'resolvido'
                : 'em_atendimento';

            try {
                const res = await fetch(`/api/admin/tickets/${ticketId}/responder`, {
                    method: 'POST',
                    headers: getAuthHeaders(),
                    body: JSON.stringify({
                        status: novoStatus,
                        resposta: resposta.trim() || undefined
                    })
                });
                if (res.ok) {
                    showToast('Ticket atualizado com sucesso!', 'success');
                    loadAdminTickets();
                }
            } catch (e) {
                showToast('Erro ao responder ticket.', 'error');
            }
        }

        async function handleAdminDeleteTicket(ticketId) {
            if (!confirm('Tem certeza que deseja excluir este ticket de suporte?')) return;
            try {
                const res = await fetch(`/api/admin/tickets/${ticketId}`, {
                    method: 'DELETE',
                    headers: getAuthHeaders()
                });
                if (res.ok) {
                    showToast('Ticket excluído.', 'info');
                    loadAdminTickets();
                }
            } catch (e) {
                showToast('Erro ao excluir ticket.', 'error');
            }
        }
