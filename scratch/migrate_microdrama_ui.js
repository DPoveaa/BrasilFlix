const fs = require('fs');
const path = require('path');

const indexPath = path.resolve('public/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

console.log('Read index.html, lines:', html.split('\n').length);

// 1. ADD CSS FOR VERTICAL 9:16 PLAYER & EPISODE BATCH PAGINATION
const verticalPlayerCSS = `
        /* ═══════════════════════════════════════════════════════════════════════
           📱 SUPORTE A REPRODUTOR VERTICAL 9:16 (MICRODRAMAS / DUANJU)
           ═══════════════════════════════════════════════════════════════════════ */
        .playback-player-stage.is-vertical-video {
            display: flex;
            justify-content: center;
            align-items: center;
            background: radial-gradient(circle at center, rgba(13, 18, 28, 0.98) 0%, rgba(5, 7, 10, 1) 100%);
            padding: 16px 0;
            min-height: 480px;
        }

        .playback-player-stage.is-vertical-video #player-card-container {
            width: auto;
            aspect-ratio: 9 / 16;
            height: 75vh;
            max-height: 780px;
            max-width: 440px;
            border-radius: 18px;
            border: 1px solid rgba(56, 189, 248, 0.35);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9), 0 0 35px rgba(56, 189, 248, 0.18);
            background: #000;
            overflow: hidden;
            margin: 0 auto;
        }

        .playback-player-stage.is-vertical-video video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
        }

        .playback-player-stage.is-vertical-video .player-footer-bar {
            border-radius: 0 0 16px 16px;
        }

        .playback-pill.pill-vertical {
            background: rgba(56, 189, 248, 0.15);
            border-color: rgba(56, 189, 248, 0.45);
            color: #38bdf8;
            font-weight: 800;
        }

        /* Paginação em Lote de Episódios para Séries Longas (40-100+ eps) */
        .playback-batch-tabs-bar {
            display: flex;
            align-items: center;
            gap: 6px;
            overflow-x: auto;
            padding-bottom: 8px;
            margin-bottom: 12px;
            scrollbar-width: thin;
        }

        .playback-batch-btn {
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.08);
            color: #94a3b8;
            font-size: 12px;
            font-weight: 700;
            padding: 6px 12px;
            border-radius: 8px;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.18s ease;
        }

        .playback-batch-btn:hover {
            background: rgba(255, 255, 255, 0.08);
            color: #fff;
        }

        .playback-batch-btn.active {
            background: rgba(56, 189, 248, 0.2);
            border-color: #38bdf8;
            color: #38bdf8;
            box-shadow: 0 0 10px rgba(56, 189, 248, 0.25);
        }

        /* Sub-filtros da Seção Doramas */
        .dorama-filter-pills-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow-x: auto;
            padding: 10px 0 16px 0;
            margin-bottom: 8px;
            scrollbar-width: none;
        }

        .dorama-filter-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.09);
            color: #94a3b8;
            font-size: 12.5px;
            font-weight: 700;
            padding: 7px 14px;
            border-radius: 20px;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.2s ease;
        }

        .dorama-filter-pill:hover {
            background: rgba(255, 255, 255, 0.09);
            color: #ffffff;
        }

        .dorama-filter-pill.active {
            background: linear-gradient(135deg, rgba(16, 185, 129, 0.25) 0%, rgba(5, 150, 105, 0.35) 100%);
            border-color: #10b981;
            color: #34d399;
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.25);
        }

        @media (max-width: 768px) {
            .playback-player-stage.is-vertical-video {
                padding: 0;
                min-height: 380px;
            }
            .playback-player-stage.is-vertical-video #player-card-container {
                height: 70vh;
                max-width: 100%;
                border-radius: 0;
                border-left: none;
                border-right: none;
            }
        }
`;

// Insert CSS right before </style>
if (!html.includes('.playback-player-stage.is-vertical-video')) {
    html = html.replace('</style>', verticalPlayerCSS + '\n</style>');
    console.log('Vertical Player & Batch CSS injected!');
}

// 2. UPDATE renderPlaybackSeasonEpisodes TO SUPPORT BATCH PAGINATION FOR 40-100+ EPISODES
const updatedRenderEpisodes = `        let currentPlaybackBatchIndex = 0;

        function renderPlaybackSeasonEpisodes(serie, currentSeasonNum, currentEpNum) {
            const seasonSelector = document.getElementById('playback-season-selector-bar');
            const epGrid = document.getElementById('playback-episodes-grid');
            const countLabel = document.getElementById('playback-season-ep-count');

            if (!serie || !serie.temporadas) return;

            const temporadas = serie.temporadas || [];
            const activeSeason = temporadas.find(t => t.numero === currentSeasonNum) || temporadas[0];
            const eps = activeSeason?.episodios || [];

            const isMicro = serie.subtipo === 'microdrama' || serie.isMicrodrama || serie.formato === 'vertical' || eps.length >= 30;

            if (countLabel) {
                countLabel.innerHTML = \`\${isMicro ? '📱 Microdrama (9:16) • ' : ''}\${eps.length} episódios na Temporada \${activeSeason?.numero || 1}\`;
            }

            // Barra seletora de temporadas (se houver mais de 1 temporada)
            if (seasonSelector) {
                if (temporadas.length > 1) {
                    seasonSelector.style.display = 'flex';
                    seasonSelector.innerHTML = temporadas.map(t => {
                        const isActive = t.numero === activeSeason?.numero;
                        return \`
                            <button class="playback-season-btn \${isActive ? 'active' : ''}" onclick="renderPlaybackSeasonEpisodes(currentPlaybackSerie, \${t.numero}, \${isActive ? currentEpNum : 1})">
                                Temporada \${t.numero} (\${t.episodios?.length || 0} eps)
                            </button>
                        \`;
                    }).join('');
                } else {
                    seasonSelector.style.display = 'none';
                }
            }

            if (!epGrid) return;
            if (eps.length === 0) {
                epGrid.innerHTML = '<div style="color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhum episódio cadastrado nesta temporada.</div>';
                return;
            }

            // Suporte a Paginação em Lotes de 25 para séries/microdramas longos (ex: 1-25, 26-50, etc.)
            const BATCH_SIZE = 25;
            let displayEps = eps;

            if (eps.length > 25) {
                // Auto-ajusta para o lote que contém o episódio ativo
                const targetBatch = Math.floor((currentEpNum - 1) / BATCH_SIZE);
                if (currentPlaybackBatchIndex === null || currentPlaybackBatchIndex === undefined || currentPlaybackBatchIndex < 0) {
                    currentPlaybackBatchIndex = targetBatch;
                }

                const totalBatches = Math.ceil(eps.length / BATCH_SIZE);
                let batchTabsHtml = '<div class="playback-batch-tabs-bar">';
                for (let b = 0; b < totalBatches; b++) {
                    const startEp = b * BATCH_SIZE + 1;
                    const endEp = Math.min((b + 1) * BATCH_SIZE, eps.length);
                    const isBatchActive = b === currentPlaybackBatchIndex;
                    batchTabsHtml += \`
                        <button class="playback-batch-btn \${isBatchActive ? 'active' : ''}" onclick="setPlaybackBatch(\${b})">
                            Eps \${startEp}-\${endEp}
                        </button>
                    \`;
                }
                batchTabsHtml += '</div>';

                const startIdx = currentPlaybackBatchIndex * BATCH_SIZE;
                const endIdx = startIdx + BATCH_SIZE;
                displayEps = eps.slice(startIdx, endIdx);

                epGrid.innerHTML = batchTabsHtml + '<div class="playback-episodes-grid" style="margin-bottom: 0;">' + renderEpisodeCardsList(displayEps, serie, activeSeason, currentSeasonNum, currentEpNum) + '</div>';
            } else {
                epGrid.innerHTML = renderEpisodeCardsList(displayEps, serie, activeSeason, currentSeasonNum, currentEpNum);
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
                const epTitleStr = ep.nome && !ep.nome.toLowerCase().startsWith('epis') ? ep.nome : \`Episódio \${ep.numero}\`;
                const temDub = ep.isDublado || (ep.audio && ep.audio.includes('Dublado'));
                const temLeg = ep.isLegendado || (ep.audio && ep.audio.includes('Legendado'));
                const audioBadge = (temDub && temLeg) ? 'Dub/Leg' : (temDub ? 'Dublado' : 'Legendado');

                const prog = getEpisodeProgress(serie.id, activeSeason.numero, ep.numero);
                const isWatched = prog?.completed || false;

                return \`
                    <div class="playback-ep-card \${isCurrent ? 'active-ep' : ''}" onclick="openPlaybackPageForEpisode('\${serie.id}', \${activeSeason.numero}, \${ep.numero})">
                        <div class="playback-ep-badge">
                            \${isCurrent ? '▶ ' : ''}EP \${ep.numero}
                        </div>
                        <div class="playback-ep-info">
                            <div class="playback-ep-title" title="\${epTitleStr}">\${epTitleStr}</div>
                            <div class="playback-ep-meta">
                                <span>✨ \${ep.qualidade || '1080p'}</span>
                                <span>•</span>
                                <span>🔊 \${audioBadge}</span>
                                \${isWatched ? '<span style="color: #34d399; font-weight: 800;">✓ Visto</span>' : ''}
                            </div>
                        </div>
                        \${isCurrent ? \`
                            <div class="playback-ep-playing-icon" title="Assistindo Agora">
                                <div class="playback-ep-playing-bar"></div>
                                <div class="playback-ep-playing-bar"></div>
                                <div class="playback-ep-playing-bar"></div>
                            </div>
                        \` : ''}
                    </div>
                \`;
            }).join('');
        }`;

// Replace renderPlaybackSeasonEpisodes
const oldRenderEpStart = html.indexOf('function renderPlaybackSeasonEpisodes(');
if (oldRenderEpStart !== -1) {
    const oldRenderEpEnd = html.indexOf('function handlePlaybackBack() {', oldRenderEpStart);
    if (oldRenderEpEnd !== -1) {
        html = html.substring(0, oldRenderEpStart) + updatedRenderEpisodes + '\n\n        ' + html.substring(oldRenderEpEnd);
        console.log('renderPlaybackSeasonEpisodes with batch pagination injected!');
    }
}

// 3. AUTO-DETECT VERTICAL ASPECT RATIO IN openWebPlayer()
const oldLoadedMetadata = `video.onloadedmetadata = () => {
                if (savedResumeTime > 15 && savedResumeTime < (video.duration - 60)) {
                    showResumeBanner(savedResumeTime);
                } else {
                    dismissResumePlayback();
                }
            };`;

const newLoadedMetadata = `video.onloadedmetadata = () => {
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
            };`;

if (html.includes(oldLoadedMetadata)) {
    html = html.replace(oldLoadedMetadata, newLoadedMetadata);
    console.log('Video loadedmetadata auto-detect vertical aspect ratio injected!');
}

// 4. ADD VERTICAL BADGE & DORAMAS FILTER IN CATALOG RENDER
const doramaFilterPillHTML = `
                <!-- Sub-filtro de Doramas / Microdramas -->
                <div class="dorama-filter-pills-bar" id="dorama-filter-bar" style="display: none;">
                    <button class="dorama-filter-pill active" id="dorama-filter-todos" onclick="filterDoramasSubtype('todos')">
                        ✨ Todos os Doramas
                    </button>
                    <button class="dorama-filter-pill" id="dorama-filter-microdramas" onclick="filterDoramasSubtype('microdrama')">
                        📱 Microdramas 9:16 (Duanju)
                    </button>
                    <button class="dorama-filter-pill" id="dorama-filter-kdramas" onclick="filterDoramasSubtype('kdrama')">
                        🇰🇷 K-Dramas Coreanos
                    </button>
                    <button class="dorama-filter-pill" id="dorama-filter-cdramas" onclick="filterDoramasSubtype('cdrama')">
                        🇨🇳 C-Dramas Tradicionais
                    </button>
                </div>
`;

// Insert doramaFilterPillHTML before media-grid in tab-catalogo
const mediaGridMarker = '<div class="media-grid" id="media-grid">';
if (html.includes(mediaGridMarker) && !html.includes('id="dorama-filter-bar"')) {
    html = html.replace(mediaGridMarker, doramaFilterPillHTML + '\n        ' + mediaGridMarker);
    console.log('Dorama filter bar injected into tab-catalogo!');
}

// 5. ADD filterDoramasSubtype JS FUNCTION
const doramaFilterJS = `
        let activeDoramaSubtype = 'todos';

        function filterDoramasSubtype(subtype) {
            activeDoramaSubtype = subtype;
            document.querySelectorAll('.dorama-filter-pill').forEach(p => p.classList.remove('active'));
            const activeBtn = document.getElementById('dorama-filter-' + (subtype === 'microdrama' ? 'microdramas' : (subtype === 'kdrama' ? 'kdramas' : (subtype === 'cdrama' ? 'cdramas' : 'todos'))));
            if (activeBtn) activeBtn.classList.add('active');
            renderCatalog();
        }
`;

// Insert doramaFilterJS before renderCatalog
const renderCatMarker = 'function renderCatalog() {';
if (html.includes(renderCatMarker) && !html.includes('function filterDoramasSubtype(')) {
    html = html.replace(renderCatMarker, doramaFilterJS + '\n        ' + renderCatMarker);
    console.log('filterDoramasSubtype function injected!');
}

// 6. UPDATE renderCatalog TO HONOR activeDoramaSubtype AND SHOW 9:16 VERTICAL BADGES
const oldFilterDoramaCheck = `if (activeCategory === 'dorama') {
                filtered = (fullCatalog.series || []).filter(s => s.isDorama);
            }`;

const newFilterDoramaCheck = `if (activeCategory === 'dorama') {
                const doramaBar = document.getElementById('dorama-filter-bar');
                if (doramaBar) doramaBar.style.display = 'flex';

                filtered = (fullCatalog.series || []).filter(s => s.isDorama);
                if (activeDoramaSubtype === 'microdrama') {
                    filtered = filtered.filter(s => s.subtipo === 'microdrama' || s.isMicrodrama || s.formato === 'vertical' || s.totalEpisodios >= 35);
                } else if (activeDoramaSubtype === 'kdrama') {
                    filtered = filtered.filter(s => s.origem === 'Coreia' || (!s.isMicrodrama && (s.generos || []).some(g => /coreia|kdrama|korean/i.test(g))));
                } else if (activeDoramaSubtype === 'cdrama') {
                    filtered = filtered.filter(s => !s.isMicrodrama && (s.origem === 'China' || (s.generos || []).some(g => /china|cdrama|chinese/i.test(g))));
                }
            } else {
                const doramaBar = document.getElementById('dorama-filter-bar');
                if (doramaBar) doramaBar.style.display = 'none';
            }`;

if (html.includes(oldFilterDoramaCheck)) {
    html = html.replace(oldFilterDoramaCheck, newFilterDoramaCheck);
    console.log('renderCatalog dorama filter check updated!');
}

// 7. ADD VERTICAL BADGE TO MEDIA CARDS
const oldCardBadge = `<span class="media-card-badge">\${item.qualidade || '1080p'}</span>`;
const newCardBadge = `\${(item.formato === 'vertical' || item.subtipo === 'microdrama' || item.isMicrodrama) ? '<span class="media-card-badge" style="background: rgba(56, 189, 248, 0.85); color: #fff; font-weight: 900;">📱 9:16</span>' : ''}<span class="media-card-badge">\${item.qualidade || '1080p'}</span>`;

if (html.includes(oldCardBadge)) {
    html = html.replace(oldCardBadge, newCardBadge);
    console.log('Media card badge updated to show 9:16 vertical badge!');
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Microdrama UI and Vertical Player migration written! Total lines:', html.split('\n').length);
