const fs = require('fs');
const path = require('path');

const indexPath = path.resolve('public/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

// Build the complete dedicated playback controller code
const playbackCoreJS = `
        /* ═══════════════════════════════════════════════════════════════════════
           🎬 CONTROLADORES DA PÁGINA DEDICADA DE REPRODUÇÃO (PLAYBACK PAGE)
           ═══════════════════════════════════════════════════════════════════════ */

        let currentPlaybackSerie = null;
        let currentPlaybackMovie = null;
        let currentPlaybackSeasonNum = 1;
        let currentPlaybackEpNum = 1;

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

            currentPlaybackMovie = movie;
            currentPlaybackSerie = null;

            localStorage.setItem('bf_playback_type', 'filme');
            localStorage.setItem('bf_playback_movie_id', String(movieId));
            localStorage.setItem('bf_active_tab', 'tab-playback-page');

            const token = getUserStreamingToken();
            const prefAudio = explicitAudio || getUserPreferredAudio();
            const hasDub = !!movie.versoes?.dublado || movie.isDublado;
            const hasLeg = !!movie.versoes?.legendado || movie.isLegendado;

            let chosenAudio = prefAudio;
            if (chosenAudio === 'dublado' && !hasDub && hasLeg) chosenAudio = 'legendado';
            else if (chosenAudio === 'legendado' && !hasLeg && hasDub) chosenAudio = 'dublado';
            else if (!hasDub && !hasLeg) chosenAudio = 'dublado';

            // Verificação de cota semanal gratuita
            const isVip = localStorage.getItem('bf_user_is_vip') === 'true' || token !== 'public';
            if (!isVip) {
                try {
                    const qRes = await fetch(\`/api/user/quota-check?token=\${encodeURIComponent(token)}&type=filme&mediaKey=filme_\${movie.id}\`);
                    const quota = await qRes.json();
                    if (!quota.permitido) {
                        showQuotaLimitExceededModal('filme', quota.mensagem);
                        return;
                    }
                    if (quota.requerConfirmacao) {
                        showQuotaConfirmationModal(movie.nome, 'filme', () => {
                            openPlaybackPageForMovie(movieId, chosenAudio, updateUrl);
                        }, \`filme_\${movie.id}\`);
                        return;
                    }
                } catch (e) {
                    console.warn('Falha na validação de cota:', e);
                }
            }

            const streamUrl = \`/stream/video/\${encodeURIComponent(token)}/filme/\${encodeURIComponent(movie.id)}/\${chosenAudio}\`;

            // Atualiza URL no navegador
            if (updateUrl) {
                window.history.pushState({}, '', \`#filme/\${movie.id}/assistir\`);
            }

            // Atualiza elementos visuais da página
            document.getElementById('playback-back-label').innerText = 'Voltar aos Filmes';
            document.getElementById('playback-top-title').innerText = movie.nome;
            document.getElementById('playback-top-sub').innerText = \`Filme • \${movie.ano || ''} • \${movie.generos?.slice(0, 2).join(', ') || 'HD'}\`;

            // Configura botões de Anterior / Próximo (ocultos ou desabilitados para filmes)
            const navBar = document.getElementById('playback-nav-controls-bar');
            const prevBtn = document.getElementById('playback-btn-prev');
            const nextBtn = document.getElementById('playback-btn-next');
            const seriesBtn = document.getElementById('playback-btn-series');

            if (prevBtn) prevBtn.style.display = 'none';
            if (nextBtn) nextBtn.style.display = 'none';
            if (seriesBtn) {
                seriesBtn.innerHTML = '📚 Ver Detalhes do Filme';
                seriesBtn.onclick = () => openMediaDetailPage(movie.id, 'filme');
            }

            // Metadados do Filme
            document.getElementById('playback-meta-title').innerText = movie.nome;
            document.getElementById('playback-meta-sub').innerText = \`Filme Completo (\${movie.ano || 'Lançamento'})\`;
            document.getElementById('playback-meta-synopsis').innerText = movie.sinopse || 'Sinopse não disponível no momento.';

            const badgesBox = document.getElementById('playback-meta-badges');
            if (badgesBox) {
                const ratingStr = movie.nota ? \`★ \${parseFloat(movie.nota).toFixed(1)}\` : '★ 8.5';
                const audioStr = (hasDub && hasLeg) ? 'Dublado & Legendado' : (hasDub ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)');
                badgesBox.innerHTML = \`
                    <span class="playback-pill pill-rating">\${ratingStr}</span>
                    <span class="playback-pill pill-hd">✨ \${movie.qualidade || '1080p Full HD'}</span>
                    <span class="playback-pill pill-audio">🔊 \${audioStr}</span>
                    <span class="playback-pill">📅 \${movie.ano || '2024'}</span>
                    \${(movie.generos || []).slice(0, 3).map(g => \`<span class="playback-pill">\${g}</span>\`).join('')}
                \`;
            }

            const tgLink = document.getElementById('playback-tg-bot-link');
            if (tgLink) {
                tgLink.href = \`https://t.me/BrasilFlix_bot?start=filme_\${movie.id}\`;
            }

            // Oculta lista de episódios para filmes
            const epSection = document.getElementById('playback-episodes-section');
            if (epSection) epSection.style.display = 'none';

            // Carrega Avaliações e Recomendações
            loadPlaybackReviews('filme', movie.id);
            renderPlaybackRecommendations(movie);

            // Abre a aba de reprodução dedicada
            switchTab('tab-playback-page', false);

            // Inicia o player de vídeo nativo
            openWebPlayer(movie.nome, \`Filme • \${movie.ano || ''}\`, streamUrl, {
                type: 'filme',
                id: movie.id,
                title: movie.nome,
                sub: \`Filme • \${movie.ano || ''}\`,
                audio: chosenAudio,
                hasDub,
                hasLeg,
                streamUrl
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

            currentPlaybackSerie = serie;
            currentPlaybackMovie = null;
            currentPlaybackSeasonNum = sNum;
            currentPlaybackEpNum = eNum;

            localStorage.setItem('bf_playback_type', 'serie');
            localStorage.setItem('bf_playback_serie_id', String(serieId));
            localStorage.setItem('bf_playback_season', String(sNum));
            localStorage.setItem('bf_playback_episode', String(eNum));
            localStorage.setItem('bf_active_tab', 'tab-playback-page');

            const season = (serie.temporadas || []).find(t => t.numero === sNum) || serie.temporadas?.[0];
            if (!season) {
                showToast(\`❌ Temporada \${sNum} indisponível.\`, 'error');
                return;
            }

            const episode = (season.episodios || []).find(e => e.numero === eNum) || season.episodios?.[0];
            if (!episode) {
                showToast(\`❌ Episódio \${eNum} indisponível.\`, 'error');
                return;
            }

            const token = getUserStreamingToken();
            const prefAudio = explicitAudio || getUserPreferredAudio();
            const hasDub = !!episode.versoes?.dublado || episode.isDublado;
            const hasLeg = !!episode.versoes?.legendado || episode.isLegendado;

            let chosenAudio = prefAudio;
            if (chosenAudio === 'dublado' && !hasDub && hasLeg) chosenAudio = 'legendado';
            else if (chosenAudio === 'legendado' && !hasLeg && hasDub) chosenAudio = 'dublado';
            else if (!hasDub && !hasLeg) chosenAudio = serie.isDublado ? 'dublado' : 'legendado';

            // Validação de cota semanal gratuita
            const isVip = localStorage.getItem('bf_user_is_vip') === 'true' || token !== 'public';
            if (!isVip) {
                try {
                    const mediaKey = \`serie_\${serie.id}_s\${sNum}_e\${eNum}\`;
                    const qRes = await fetch(\`/api/user/quota-check?token=\${encodeURIComponent(token)}&type=serie&mediaKey=\${encodeURIComponent(mediaKey)}\`);
                    const quota = await qRes.json();
                    if (!quota.permitido) {
                        showQuotaLimitExceededModal('serie', quota.mensagem);
                        return;
                    }
                    if (quota.requerConfirmacao) {
                        showQuotaConfirmationModal(\`\${serie.nome} (T\${sNum}E\${eNum})\`, 'serie', () => {
                            openPlaybackPageForEpisode(serieId, sNum, eNum, chosenAudio, updateUrl);
                        }, mediaKey);
                        return;
                    }
                } catch (e) {
                    console.warn('Falha na validação de cota:', e);
                }
            }

            const streamUrl = \`/stream/video/\${encodeURIComponent(token)}/serie/\${encodeURIComponent(serie.id)}/\${sNum}/\${eNum}/\${chosenAudio}\`;

            // Atualiza URL no navegador com a rota canônica
            if (updateUrl) {
                window.history.pushState({}, '', \`#serie/\${serie.id}/temporada/\${sNum}/episodio/\${eNum}\`);
            }

            const epTitleStr = episode.nome && !episode.nome.toLowerCase().startsWith('epis') ? episode.nome : \`Episódio \${eNum}\`;
            const breadcrumbSub = \`Temporada \${sNum} • Episódio \${eNum} - \${epTitleStr}\`;

            // Atualiza breadcrumb no topo
            document.getElementById('playback-back-label').innerText = 'Voltar para a Série';
            document.getElementById('playback-top-title').innerText = serie.nome;
            document.getElementById('playback-top-sub').innerText = breadcrumbSub;

            // Configura botões da barra de navegação (Anterior / Ver Série Completa / Próximo)
            const prevBtn = document.getElementById('playback-btn-prev');
            const nextBtn = document.getElementById('playback-btn-next');
            const seriesBtn = document.getElementById('playback-btn-series');

            const prevInfo = getPreviousEpisodeInfo(serie.id, sNum, eNum);
            const nextInfo = getNextEpisodeInfo(serie.id, sNum, eNum);

            if (prevBtn) {
                prevBtn.style.display = 'inline-flex';
                if (prevInfo) {
                    prevBtn.disabled = false;
                    prevBtn.title = \`Ir para T\${prevInfo.seasonNum}E\${prevInfo.epNum} - \${prevInfo.epNome}\`;
                    prevBtn.onclick = () => openPlaybackPageForEpisode(serie.id, prevInfo.seasonNum, prevInfo.epNum);
                } else {
                    prevBtn.disabled = true;
                    prevBtn.title = 'Você está no primeiro episódio desta série.';
                }
            }

            if (nextBtn) {
                nextBtn.style.display = 'inline-flex';
                if (nextInfo) {
                    nextBtn.disabled = false;
                    nextBtn.title = \`Ir para T\${nextInfo.seasonNum}E\${nextInfo.epNum} - \${nextInfo.epNome}\`;
                    nextBtn.onclick = () => openPlaybackPageForEpisode(serie.id, nextInfo.seasonNum, nextInfo.epNum);
                } else {
                    nextBtn.disabled = true;
                    nextBtn.title = 'Você está no último episódio disponível desta série.';
                }
            }

            if (seriesBtn) {
                seriesBtn.innerHTML = '📚 Ver Série Completa';
                seriesBtn.onclick = () => openMediaDetailPage(serie.id, 'serie');
            }

            // Metadados do Episódio
            document.getElementById('playback-meta-title').innerText = serie.nome;
            document.getElementById('playback-meta-sub').innerText = \`Temporada \${sNum} • \${epTitleStr}\`;
            document.getElementById('playback-meta-synopsis').innerText = episode.sinopse || serie.sinopse || 'Sinopse não disponível.';

            const badgesBox = document.getElementById('playback-meta-badges');
            if (badgesBox) {
                const ratingStr = serie.nota ? \`★ \${parseFloat(serie.nota).toFixed(1)}\` : '★ 8.8';
                const audioStr = (hasDub && hasLeg) ? 'Dublado & Legendado' : (hasDub ? 'Dublado (PT-BR)' : 'Legendado (PT-BR)');
                badgesBox.innerHTML = \`
                    <span class="playback-pill pill-rating">\${ratingStr}</span>
                    <span class="playback-pill pill-hd">✨ \${episode.qualidade || '1080p Full HD'}</span>
                    <span class="playback-pill pill-audio">🔊 \${audioStr}</span>
                    <span class="playback-pill">T\${sNum}:E\${eNum}</span>
                    <span class="playback-pill">📅 \${serie.ano || '2024'}</span>
                    \${(serie.generos || []).slice(0, 3).map(g => \`<span class="playback-pill">\${g}</span>\`).join('')}
                \`;
            }

            const tgLink = document.getElementById('playback-tg-bot-link');
            if (tgLink) {
                tgLink.href = \`https://t.me/BrasilFlix_bot?start=serie_\${serie.id}_\${sNum}_\${eNum}\`;
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

            // Inicia a reprodução do vídeo
            openWebPlayer(serie.nome, \`T\${sNum}E\${eNum} • \${epTitleStr}\`, streamUrl, {
                type: 'serie',
                id: serie.id,
                season: sNum,
                episode: eNum,
                title: serie.nome,
                sub: \`T\${sNum}E\${eNum} • \${epTitleStr}\`,
                audio: chosenAudio,
                hasDub,
                hasLeg,
                streamUrl
            });
        }

        function renderPlaybackSeasonEpisodes(serie, currentSeasonNum, currentEpNum) {
            const seasonSelector = document.getElementById('playback-season-selector-bar');
            const epGrid = document.getElementById('playback-episodes-grid');
            const countLabel = document.getElementById('playback-season-ep-count');

            if (!serie || !serie.temporadas) return;

            const temporadas = serie.temporadas || [];
            const activeSeason = temporadas.find(t => t.numero === currentSeasonNum) || temporadas[0];
            const eps = activeSeason?.episodios || [];

            if (countLabel) {
                countLabel.innerText = \`\${eps.length} episódios na Temporada \${activeSeason?.numero || 1}\`;
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

            // Grid de cards de episódios
            if (epGrid) {
                if (eps.length === 0) {
                    epGrid.innerHTML = '<div style="color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhum episódio cadastrado nesta temporada.</div>';
                    return;
                }

                epGrid.innerHTML = eps.map(ep => {
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
            }
        }

        function handlePlaybackBack() {
            if (currentPlaybackSerie) {
                openMediaDetailPage(currentPlaybackSerie.id, 'serie');
            } else if (currentPlaybackMovie) {
                switchNavCategory('filme');
            } else {
                switchNavCategory('inicio');
            }
        }

        function handleViewFullSeries() {
            if (currentPlaybackSerie) {
                openMediaDetailPage(currentPlaybackSerie.id, 'serie');
            } else if (currentPlaybackMovie) {
                openMediaDetailPage(currentPlaybackMovie.id, 'filme');
            }
        }

        async function loadPlaybackReviews(mediaType, mediaId) {
            const listEl = document.getElementById('playback-reviews-list');
            const avgEl = document.getElementById('playback-reviews-rating-avg');
            if (!listEl) return;

            try {
                const res = await fetch(\`/api/media/\${mediaType}/\${mediaId}/comentarios\`);
                const data = await res.json();

                if (avgEl && data.avgRating) {
                    avgEl.innerText = \`★ \${data.avgRating} (\${data.total} avaliações)\`;
                }

                if (!data.reviews || data.reviews.length === 0) {
                    listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhuma avaliação ainda. Seja o primeiro a avaliar!</div>';
                    return;
                }

                listEl.innerHTML = data.reviews.map(r => \`
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid var(--border-color); border-radius: 12px; padding: 12px 16px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-weight: 800; font-size: 13px; color: #fff;">\${r.username || 'Usuário'}</span>
                                <span style="font-size: 11px; color: #fbbf24; font-weight: 800;">★ \${r.rating}/10</span>
                            </div>
                            <span style="font-size: 11px; color: var(--text-muted);">\${new Date(r.created_at).toLocaleDateString('pt-BR')}</span>
                        </div>
                        <p style="font-size: 13px; color: #cbd5e1; line-height: 1.5; margin: 0;">\${r.comentario}</p>
                    </div>
                \`).join('');
            } catch (e) {
                console.warn('Erro ao carregar avaliações:', e);
            }
        }

        async function handlePlaybackSubmitReview(e) {
            e.preventDefault();
            const ratingSelect = document.getElementById('playback-review-rating-select');
            const textInput = document.getElementById('playback-review-text');

            const rating = ratingSelect?.value || 10;
            const text = (textInput?.value || '').trim();

            if (!text || text.length < 3) {
                showToast('Escreva um comentário com pelo menos 3 letras.', 'error');
                return;
            }

            const mediaType = currentPlaybackSerie ? 'serie' : 'filme';
            const mediaId = currentPlaybackSerie ? currentPlaybackSerie.id : currentPlaybackMovie?.id;

            if (!mediaId) return;

            const headers = { 'Content-Type': 'application/json' };
            const jwt = localStorage.getItem('bf_user_jwt');
            if (jwt) headers['Authorization'] = \`Bearer \${jwt}\`;

            try {
                const res = await fetch(\`/api/media/\${mediaType}/\${mediaId}/comentarios\`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        rating: parseInt(rating, 10),
                        comentario: text,
                        guestName: localStorage.getItem('bf_party_name') || 'Visitante'
                    })
                });
                const data = await res.json();
                if (data.success) {
                    showToast('🎉 Avaliação publicada com sucesso!', 'success');
                    if (textInput) textInput.value = '';
                    loadPlaybackReviews(mediaType, mediaId);
                } else {
                    showToast(data.message || 'Erro ao publicar avaliação.', 'error');
                }
            } catch (err) {
                showToast('Erro de conexão ao enviar avaliação.', 'error');
            }
        }

        function renderPlaybackRecommendations(item) {
            const listEl = document.getElementById('playback-recommendations-list');
            if (!listEl || !item) return;

            const isSerie = !!item.temporadas;
            const pool = isSerie ? (fullCatalog.series || []) : (fullCatalog.filmes || []);
            
            // Filtra mídias do mesmo gênero excluindo a atual
            let recs = pool.filter(p => String(p.id) !== String(item.id));
            if (item.generos && item.generos.length > 0) {
                const mainGenre = item.generos[0];
                const genreMatches = recs.filter(p => (p.generos || []).includes(mainGenre));
                if (genreMatches.length >= 4) recs = genreMatches;
            }

            recs = recs.slice(0, 10);

            if (recs.length === 0) {
                listEl.innerHTML = '<div style="color: var(--text-muted); padding: 10px;">Nenhuma recomendação no momento.</div>';
                return;
            }

            listEl.innerHTML = recs.map(rec => {
                const recType = isSerie ? 'serie' : 'filme';
                const poster = rec.posterUrl || '/assets/logos/logo_horizontal.jpg';
                return \`
                    <div class="rail-card" onclick="openMediaDetailPage('\${rec.id}', '\${recType}')">
                        <div class="rail-card-poster-box">
                            <img class="rail-card-poster" src="\${poster}" alt="\${rec.nome}" loading="lazy" onerror="this.src='/assets/logos/logo_horizontal.jpg'">
                            <span class="media-card-badge">\${rec.qualidade || '1080p'}</span>
                        </div>
                        <div class="rail-card-info">
                            <h4 class="rail-card-title">\${rec.nome}</h4>
                            <div class="rail-card-meta">
                                <span>★ \${rec.nota || '8.5'}</span>
                                <span>•</span>
                                <span>\${rec.ano || '2024'}</span>
                            </div>
                        </div>
                    </div>
                \`;
            }).join('');
        }
`;

// Insert the playbackCoreJS right before `function openAudioSelectModal`
const hookPos = html.indexOf('function openAudioSelectModal(');
if (hookPos !== -1) {
    html = html.substring(0, hookPos) + playbackCoreJS + '\n\n        ' + html.substring(hookPos);
    console.log('Playback core JS injected successfully!');
}

// Update openWebPlayerForMovie & openWebPlayerEpisode to delegate to openPlaybackPage
const newOpenMovie = `function openWebPlayerForMovie(movieId, explicitAudio = null) {
            openPlaybackPageForMovie(movieId, explicitAudio, true);
        }`;

const newOpenEpisode = `function openWebPlayerEpisode(serieId, seasonNum, epNum, explicitAudio = null) {
            openPlaybackPageForEpisode(serieId, seasonNum, epNum, explicitAudio, true);
        }`;

// Replace openWebPlayerForMovie
const oldMovieStart = html.indexOf('function openWebPlayerForMovie(');
if (oldMovieStart !== -1) {
    const oldMovieEnd = html.indexOf('function updatePlayerNextEpisodeButton() {', oldMovieStart);
    if (oldMovieEnd !== -1) {
        html = html.substring(0, oldMovieStart) + newOpenMovie + '\n\n        ' + html.substring(oldMovieEnd);
        console.log('openWebPlayerForMovie updated!');
    }
}

// Replace openWebPlayerEpisode
const oldEpStart = html.indexOf('function openWebPlayerEpisode(');
if (oldEpStart !== -1) {
    const oldEpEnd = html.indexOf('function renderSeriesSeasonsInModal(', oldEpStart);
    if (oldEpEnd !== -1) {
        html = html.substring(0, oldEpStart) + newOpenEpisode + '\n\n        ' + html.substring(oldEpEnd);
        console.log('openWebPlayerEpisode updated!');
    }
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Playback Core migration written! Total lines:', html.split('\n').length);
