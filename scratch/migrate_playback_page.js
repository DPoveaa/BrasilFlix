const fs = require('fs');
const path = require('path');

const indexPath = path.resolve('public/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

console.log('Original index.html length:', html.length);

// 1. ADD CSS FOR DEDICATED PLAYBACK PAGE
const playbackCSS = `
        /* ═══════════════════════════════════════════════════════════════════════
           🎬 PÁGINA DEDICADA DE REPRODUÇÃO (DEDICATED PLAYBACK PAGE)
           ═══════════════════════════════════════════════════════════════════════ */
        #tab-playback-page {
            display: none;
            padding: 0;
            margin: 0 auto;
            max-width: 1400px;
            width: 100%;
            animation: fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        #tab-playback-page.active {
            display: block;
        }

        .playback-header-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 16px 20px 14px 20px;
            background: linear-gradient(180deg, rgba(13, 18, 28, 0.85) 0%, rgba(7, 9, 14, 0.95) 100%);
            border-bottom: 1px solid var(--border-color);
            border-radius: 16px 16px 0 0;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            margin-top: 12px;
        }

        .playback-back-btn {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid var(--border-color);
            color: #f1f5f9;
            padding: 8px 16px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .playback-back-btn:hover {
            background: rgba(16, 185, 129, 0.15);
            border-color: rgba(16, 185, 129, 0.4);
            color: #34d399;
            transform: translateX(-2px);
        }

        .playback-title-info {
            display: flex;
            flex-direction: column;
            min-width: 0;
            flex: 1;
            padding: 0 12px;
        }

        .playback-title-main {
            font-size: 16px;
            font-weight: 900;
            color: #ffffff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.2;
            letter-spacing: -0.3px;
        }

        .playback-title-sub {
            font-size: 12px;
            color: var(--text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-top: 2px;
        }

        .playback-top-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        /* Container do Player de Vídeo */
        .playback-player-stage {
            position: relative;
            width: 100%;
            background: #000;
            overflow: hidden;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8), 0 0 40px rgba(16, 185, 129, 0.08);
            border-left: 1px solid var(--border-color);
            border-right: 1px solid var(--border-color);
        }

        .playback-player-stage #player-card-container {
            width: 100%;
            max-width: 100%;
            border-radius: 0;
            border: none;
            background: #000;
            aspect-ratio: 16 / 9;
            min-height: 240px;
            max-height: 75vh;
            display: flex;
            flex-direction: column;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        .playback-player-stage video {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #000;
        }

        /* Barra de Navegação de Episódios (Estilo Anime/Streaming) */
        .playback-nav-bar {
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            gap: 12px;
            align-items: center;
            padding: 14px 20px;
            background: rgba(13, 18, 28, 0.95);
            border: 1px solid var(--border-color);
            border-top: none;
            border-radius: 0 0 16px 16px;
            margin-bottom: 24px;
        }

        .playback-nav-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #ffffff;
            font-size: 13.5px;
            font-weight: 800;
            padding: 12px 18px;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
            user-select: none;
            white-space: nowrap;
            text-decoration: none;
        }

        .playback-nav-btn:hover:not(:disabled) {
            background: rgba(16, 185, 129, 0.18);
            border-color: rgba(16, 185, 129, 0.45);
            color: #34d399;
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(16, 185, 129, 0.2);
        }

        .playback-nav-btn:disabled {
            opacity: 0.35;
            cursor: not-allowed;
            pointer-events: none;
            filter: grayscale(1);
        }

        .playback-nav-btn-center {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.2) 0%, rgba(37, 99, 235, 0.2) 100%);
            border: 1px solid rgba(59, 130, 246, 0.4);
            color: #93c5fd;
            font-size: 13.5px;
            font-weight: 800;
            padding: 12px 24px;
            border-radius: 12px;
            cursor: pointer;
            transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
            white-space: nowrap;
        }

        .playback-nav-btn-center:hover {
            background: linear-gradient(135deg, rgba(59, 130, 246, 0.35) 0%, rgba(37, 99, 235, 0.35) 100%);
            border-color: #60a5fa;
            color: #ffffff;
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(59, 130, 246, 0.25);
        }

        /* Cartão de Detalhes e Sinopse da Mídia */
        .playback-details-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 24px;
            margin-bottom: 30px;
        }

        .playback-info-card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 18px;
            padding: 24px;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
        }

        .playback-meta-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            flex-wrap: wrap;
            margin-bottom: 16px;
        }

        .playback-main-title {
            font-size: 24px;
            font-weight: 900;
            color: #fff;
            letter-spacing: -0.5px;
            line-height: 1.2;
        }

        .playback-episode-subtitle {
            font-size: 16px;
            font-weight: 700;
            color: #38bdf8;
            margin-top: 4px;
        }

        .playback-badges-row {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
            margin-top: 12px;
        }

        .playback-pill {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #e2e8f0;
            font-size: 12px;
            font-weight: 700;
            padding: 5px 11px;
            border-radius: 8px;
        }

        .playback-pill.pill-rating {
            background: rgba(251, 191, 36, 0.15);
            border-color: rgba(251, 191, 36, 0.4);
            color: #fbbf24;
        }

        .playback-pill.pill-hd {
            background: rgba(16, 185, 129, 0.15);
            border-color: rgba(16, 185, 129, 0.4);
            color: #34d399;
        }

        .playback-pill.pill-audio {
            background: rgba(168, 85, 247, 0.15);
            border-color: rgba(168, 85, 247, 0.4);
            color: #c084fc;
        }

        .playback-synopsis-text {
            font-size: 14.5px;
            line-height: 1.7;
            color: #cbd5e1;
            margin-top: 14px;
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            padding-top: 14px;
        }

        /* Lista de Episódios da Mesma Temporada */
        .playback-section-title {
            font-size: 19px;
            font-weight: 900;
            color: #ffffff;
            letter-spacing: -0.3px;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
        }

        .playback-season-selector-bar {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow-x: auto;
            padding-bottom: 10px;
            margin-bottom: 16px;
            scrollbar-width: thin;
        }

        .playback-season-btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: #94a3b8;
            font-size: 13px;
            font-weight: 800;
            padding: 8px 16px;
            border-radius: 10px;
            cursor: pointer;
            white-space: nowrap;
            transition: all 0.2s ease;
        }

        .playback-season-btn:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }

        .playback-season-btn.active {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            border-color: #34d399;
            color: #ffffff;
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.35);
        }

        .playback-episodes-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 12px;
            margin-bottom: 30px;
        }

        .playback-ep-card {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            background: rgba(13, 18, 28, 0.85);
            border: 1px solid var(--border-color);
            border-radius: 14px;
            padding: 14px 16px;
            cursor: pointer;
            transition: all 0.22s cubic-bezier(0.34, 1.56, 0.64, 1);
            position: relative;
            overflow: hidden;
            text-decoration: none;
        }

        .playback-ep-card:hover {
            background: rgba(20, 29, 44, 0.95);
            border-color: rgba(56, 189, 248, 0.5);
            transform: translateY(-2px);
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
        }

        .playback-ep-card.active-ep {
            background: linear-gradient(135deg, rgba(16, 185, 129, 0.16) 0%, rgba(6, 78, 59, 0.25) 100%);
            border-color: #10b981;
            box-shadow: 0 0 20px rgba(16, 185, 129, 0.25);
        }

        .playback-ep-card.active-ep::before {
            content: '';
            position: absolute;
            left: 0;
            top: 0;
            bottom: 0;
            width: 4px;
            background: #10b981;
            box-shadow: 0 0 10px #10b981;
        }

        .playback-ep-badge {
            background: rgba(59, 130, 246, 0.18);
            border: 1px solid rgba(59, 130, 246, 0.35);
            color: #60a5fa;
            font-size: 11px;
            font-weight: 900;
            padding: 6px 10px;
            border-radius: 8px;
            flex-shrink: 0;
        }

        .playback-ep-card.active-ep .playback-ep-badge {
            background: #10b981;
            border-color: #34d399;
            color: #ffffff;
            box-shadow: 0 0 12px rgba(16, 185, 129, 0.5);
        }

        .playback-ep-info {
            min-width: 0;
            flex: 1;
        }

        .playback-ep-title {
            font-size: 13.5px;
            font-weight: 800;
            color: #fff;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.3;
        }

        .playback-ep-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 11px;
            color: var(--text-muted);
            margin-top: 3px;
        }

        .playback-ep-playing-icon {
            display: inline-flex;
            align-items: center;
            gap: 2px;
            height: 12px;
        }

        .playback-ep-playing-bar {
            width: 2.5px;
            height: 100%;
            background: #34d399;
            border-radius: 2px;
            animation: equalizer 0.8s ease-in-out infinite alternate;
        }

        .playback-ep-playing-bar:nth-child(2) { animation-delay: 0.2s; }
        .playback-ep-playing-bar:nth-child(3) { animation-delay: 0.4s; }

        @keyframes equalizer {
            0% { height: 3px; }
            100% { height: 12px; }
        }

        @media (max-width: 768px) {
            .playback-header-bar {
                padding: 12px 14px;
                border-radius: 0;
                margin-top: 0;
            }
            .playback-nav-bar {
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                padding: 12px 14px;
                border-radius: 0;
            }
            .playback-nav-btn-center {
                grid-column: 1 / -1;
                order: -1;
            }
            .playback-episodes-grid {
                grid-template-columns: 1fr;
            }
            .playback-main-title {
                font-size: 19px;
            }
        }
`;

// Insert CSS right before </style>
if (!html.includes('.playback-header-bar')) {
    html = html.replace('</style>', playbackCSS + '\n</style>');
}

// 2. ADD TAB PLAYBACK PAGE HTML
const playbackPageHTML = `
    <!-- ═══════════════════════════════════════════════════════════════════════
         🎬 PÁGINA DEDICADA DE REPRODUÇÃO (DEDICATED PLAYBACK PAGE)
         ═══════════════════════════════════════════════════════════════════════ -->
    <div id="tab-playback-page" class="tab-content" style="display: none;">
        
        <!-- BARRA SUPERIOR DE NAVEGAÇÃO / BREADCRUMB -->
        <div class="playback-header-bar">
            <button class="playback-back-btn" onclick="handlePlaybackBack()">
                <span style="font-size: 15px;">←</span> <span id="playback-back-label">Voltar</span>
            </button>
            <div class="playback-title-info">
                <h2 class="playback-title-main" id="playback-top-title">BrasilFlix Player</h2>
                <div class="playback-title-sub" id="playback-top-sub">Carregando informações da mídia...</div>
            </div>
            <div class="playback-top-actions">
                <button class="speed-badge-btn desktop-only" onclick="togglePictureInPicture()" title="Janela Flutuante (Picture-in-Picture)">
                    Popout
                </button>
                <button class="speed-badge-btn" onclick="handleShareCurrentMedia()" title="Compartilhar Link">
                    🔗 Compartilhar
                </button>
                <button class="speed-badge-btn" id="playback-party-btn" onclick="toggleWatchPartyModal()" title="Assistir Junto com Amigos" style="background: rgba(168, 85, 247, 0.18); border-color: rgba(168, 85, 247, 0.4); color: #d8b4fe;">
                    👥 Assistir Junto
                </button>
            </div>
        </div>

        <!-- STAGE DO PLAYER DE VÍDEO CINEMATOGRÁFICO -->
        <div class="playback-player-stage">
            <div class="player-card" id="player-card-container" onmousemove="handlePlayerMouseMove()" onclick="closeAllPlayerDropdowns()">
                
                <!-- OVERLAY: BLOQUEIO VIP / LIMITE DE CRÉDITO -->
                <div class="player-overlay-modal" id="player-vip-limit-overlay">
                    <div style="text-align: center; max-width: 420px; padding: 24px;">
                        <div style="font-size: 44px; margin-bottom: 12px;">🔒</div>
                        <h3 style="font-size: 20px; font-weight: 900; color: #fff; margin-bottom: 8px;">Limite Semanal Gratuito Atingido</h3>
                        <p id="player-vip-limit-msg" style="font-size: 13px; color: #cbd5e1; line-height: 1.6; margin-bottom: 20px;">
                            Você utilizou sua cota de transmissões gratuitas da semana. Para assistir sem interrupções e ter acesso ilimitado em 1080p, torne-se VIP!
                        </p>
                        <div style="display: flex; gap: 10px; justify-content: center;">
                            <a href="/assinar" class="btn-modal btn-modal-primary" style="padding: 12px 24px; font-weight: 800; text-decoration: none;">
                                💎 Desbloquear Acesso Ilimitado
                            </a>
                        </div>
                    </div>
                </div>

                <!-- OVERLAY: SALA / WATCH PARTY "TODOS ESTÃO PRONTOS?" -->
                <div class="player-overlay-modal" id="party-ready-overlay">
                    <div style="text-align: center; max-width: 440px; padding: 28px 24px; background: rgba(15, 23, 42, 0.95); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 20px; box-shadow: 0 20px 50px rgba(0,0,0,0.8);">
                        <div style="font-size: 40px; margin-bottom: 10px;">🍿</div>
                        <h3 id="party-ready-title" style="font-size: 18px; font-weight: 900; color: #fff; margin-bottom: 8px;">Todos Estão Prontos?</h3>
                        <p id="party-ready-msg" style="font-size: 13px; color: #cbd5e1; line-height: 1.6; margin-bottom: 20px;">
                            O vídeo foi carregado e está <strong>pausado</strong> para que todo o grupo comece junto. Quando todos estiverem prontos, dê o play!
                        </p>
                        <div id="party-ready-actions">
                            <button class="btn-modal btn-modal-primary" id="party-ready-play-btn" style="width: 100%; padding: 13px; font-size: 14px; font-weight: 800;" onclick="startPartyPlaybackNow()">
                                ▶️ Sim, Começar Para Todos!
                            </button>
                        </div>
                    </div>
                </div>

                <!-- OVERLAY: SINCRONIZAÇÃO DE MÍDIA DA SALA -->
                <div id="party-sync-overlay">
                    <div class="party-sync-spinner"></div>
                    <div class="party-sync-text">🎬 Sincronizando com a Sala...</div>
                    <div class="party-sync-subtext" id="party-sync-overlay-msg">O anfitrião selecionou um novo conteúdo. Aguarde um instante.</div>
                </div>

                <!-- ZONA ESQUERDA (VOLTAR 10S COM 2 CLIQUES / TOQUES) -->
                <div class="seek-tap-zone seek-tap-left" id="zone-tap-left" onclick="handleZoneTap(event, -10)">
                    <div class="seek-ripple" id="ripple-left">
                        <span style="font-size: 18px; font-weight: 900; letter-spacing: -0.5px;">-10s</span>
                    </div>
                </div>

                <!-- ZONA DIREITA (AVANÇAR 10S COM 2 CLIQUES / TOQUES) -->
                <div class="seek-tap-zone seek-tap-right" id="zone-tap-right" onclick="handleZoneTap(event, 10)">
                    <div class="seek-ripple" id="ripple-right">
                        <span style="font-size: 18px; font-weight: 900; letter-spacing: -0.5px;">+10s</span>
                    </div>
                </div>

                <!-- BANNER ELEGANTE DE RETOMAR ONDE PAROU -->
                <div class="resume-toast-banner" id="player-resume-banner" onclick="event.stopPropagation()">
                    <span class="resume-icon">⏱️</span>
                    <span class="resume-text">Continuar de <strong id="resume-time-str">00:00</strong>?</span>
                    <button class="resume-btn-confirm" onclick="confirmResumePlayback(event)">▶ Continuar</button>
                    <button class="resume-btn-dismiss" onclick="dismissResumePlayback(event)" title="Começar do início">✕</button>
                </div>

                <!-- CARD INTELIGENTE DE PRÓXIMO EPISÓDIO (ESTILO NETFLIX) -->
                <div class="next-ep-card" id="player-next-ep-card">
                    <div class="next-ep-counter-ring" id="next-ep-ring">
                        <div class="next-ep-counter-inner" id="next-ep-counter-text">10</div>
                    </div>
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 10px; font-weight: 800; color: #38bdf8; text-transform: uppercase; letter-spacing: 0.5px;">A Seguir</div>
                        <h4 id="next-ep-title" style="font-size: 13px; font-weight: 800; color: #fff; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;">Próximo Episódio</h4>
                        <div style="display: flex; gap: 6px; margin-top: 6px;">
                            <button class="btn-action btn-action-primary" style="padding: 4px 10px; font-size: 11px;" onclick="triggerPlayNextEpisodeNow()">▶️ Assistir Agora</button>
                            <button class="btn-action" style="padding: 4px 8px; font-size: 11px;" onclick="cancelAutoPlayNextEpisode()">✕ Cancelar</button>
                        </div>
                    </div>
                </div>

                <!-- ELEMENTO DE VÍDEO HTML5 NATIVO -->
                <video id="html5-video-player" playsinline preload="metadata" controls></video>
            </div>

            <!-- FOOTER DE CONTROLES: ÁUDIO, VELOCIDADE & ATALHOS -->
            <div class="player-footer-bar" style="padding: 10px 20px; background: rgba(13, 18, 29, 0.98); border-top: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; position: relative; z-index: 10;">
                <div class="desktop-only" style="font-size: 11px; color: var(--text-muted);">
                    <span>Atalhos: [Espaço] Play/Pausa • [F] Tela Cheia • [P] Janela Flutuante • [← / →] 10s • [&lt; / &gt;] Velocidade</span>
                </div>

                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto;">
                    <!-- SELETOR DE ÁUDIO (DUBLADO / LEGENDADO) -->
                    <div style="position: relative;" id="player-audio-box">
                        <button class="speed-badge-btn" id="player-audio-btn" onclick="toggleAudioDropdown(event)" title="Alterar Idioma do Áudio">
                            <span id="player-audio-icon">🎙️</span> <span id="player-audio-label">Idioma</span> ▾
                        </button>
                        <div class="speed-dropdown-menu" id="player-audio-menu">
                            <div style="font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; padding: 4px 8px 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 2px;">
                                Opções de Áudio
                            </div>
                            <button class="speed-opt-btn active" id="opt-audio-dub" onclick="switchPlayerAudio('dublado')">
                                <span>🔊 Dublado (PT-BR)</span>
                                <span class="opt-check">✓</span>
                            </button>
                            <button class="speed-opt-btn" id="opt-audio-leg" onclick="switchPlayerAudio('legendado')">
                                <span>💬 Legendado (PT-BR)</span>
                                <span class="opt-check">✓</span>
                            </button>
                        </div>
                    </div>

                    <!-- VELOCIDADE DE REPRODUÇÃO -->
                    <div style="position: relative;">
                        <button class="speed-badge-btn" id="player-speed-btn" onclick="toggleSpeedDropdown(event)" title="Alterar Velocidade de Reprodução">
                            ⚡ Velocidade: <span id="player-speed-label">1.0x</span> ▾
                        </button>
                        <div class="speed-dropdown-menu" id="player-speed-menu">
                            <div style="font-size: 10px; font-weight: 800; color: #94a3b8; text-transform: uppercase; padding: 4px 8px 6px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); margin-bottom: 2px;">
                                Velocidade
                            </div>
                            <button class="speed-opt-btn" onclick="setPlaybackSpeed(0.5)"><span>0.5x Lento</span><span class="opt-check">✓</span></button>
                            <button class="speed-opt-btn" onclick="setPlaybackSpeed(0.75)"><span>0.75x</span><span class="opt-check">✓</span></button>
                            <button class="speed-opt-btn active" onclick="setPlaybackSpeed(1.0)"><span>1.0x Normal</span><span class="opt-check">✓</span></button>
                            <button class="speed-opt-btn" onclick="setPlaybackSpeed(1.25)"><span>1.25x</span><span class="opt-check">✓</span></button>
                            <button class="speed-opt-btn" onclick="setPlaybackSpeed(1.5)"><span>1.5x Rápido</span><span class="opt-check">✓</span></button>
                            <button class="speed-opt-btn" onclick="setPlaybackSpeed(2.0)"><span>2.0x Dobro</span><span class="opt-check">✓</span></button>
                        </div>
                    </div>

                    <button class="speed-badge-btn" onclick="togglePlayerFullscreen()" title="Tela Cheia (F)">
                        ⛶ Tela Cheia
                    </button>
                </div>
            </div>
        </div>

        <!-- BARRA DE NAVEGAÇÃO DE EPISÓDIOS (ANTERIOR / VER SÉRIE / PRÓXIMO) -->
        <div class="playback-nav-bar" id="playback-nav-controls-bar">
            <button id="playback-btn-prev" class="playback-nav-btn" onclick="playPreviousEpisodeDirectly()" title="Ir para o Episódio Anterior">
                ⏮ Episódio Anterior
            </button>
            <button id="playback-btn-series" class="playback-nav-btn-center" onclick="handleViewFullSeries()">
                📚 Ver Série Completa
            </button>
            <button id="playback-btn-next" class="playback-nav-btn" onclick="playNextEpisodeDirectly()" title="Ir para o Próximo Episódio">
                Próximo Episódio ⏭
            </button>
        </div>

        <!-- DETALHES & SINOPSE DA MÍDIA -->
        <div class="playback-details-grid">
            <div class="playback-info-card">
                <div class="playback-meta-header">
                    <div>
                        <h1 class="playback-main-title" id="playback-meta-title">Título da Mídia</h1>
                        <div class="playback-episode-subtitle" id="playback-meta-sub">Temporada 1 • Episódio 1</div>
                        <div class="playback-badges-row" id="playback-meta-badges">
                            <!-- Badges preenchidos via JS -->
                        </div>
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;" id="playback-meta-actions">
                        <a id="playback-tg-bot-link" href="https://t.me/BrasilFlix_bot" target="_blank" class="btn-modal btn-modal-secondary" style="padding: 8px 14px; font-size: 12px; border-radius: 10px; text-decoration: none;" title="Abrir no Telegram">
                            📱 Assistir no Bot
                        </a>
                    </div>
                </div>

                <div class="playback-synopsis-text" id="playback-meta-synopsis">
                    Sinopse carregando...
                </div>
            </div>
        </div>

        <!-- SEÇÃO: OUTROS EPISÓDIOS DA MESMA TEMPORADA (SÓ PARA SÉRIES) -->
        <div id="playback-episodes-section" style="display: none; margin-bottom: 36px;">
            <div class="playback-section-title">
                <span>📑 Episódios da Temporada</span>
                <span id="playback-season-ep-count" style="font-size: 13px; font-weight: 700; color: var(--text-muted);"></span>
            </div>

            <div class="playback-season-selector-bar" id="playback-season-selector-bar">
                <!-- Botões de Temporada renderizados via JS -->
            </div>

            <div class="playback-episodes-grid" id="playback-episodes-grid">
                <!-- Cards de Episódios renderizados via JS -->
            </div>
        </div>

        <!-- SEÇÃO: AVALIAÇÕES E COMENTÁRIOS DA COMUNIDADE -->
        <div id="playback-reviews-section" style="margin-bottom: 36px;">
            <div class="playback-section-title">
                <span>💬 Avaliações da Comunidade</span>
                <span id="playback-reviews-rating-avg" style="font-size: 14px; font-weight: 800; color: #fbbf24;">★ 10.0</span>
            </div>

            <!-- Formulário de Comentário -->
            <div class="playback-info-card" style="margin-bottom: 18px; padding: 18px 20px;">
                <form id="playback-review-form" onsubmit="handlePlaybackSubmitReview(event)">
                    <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap;">
                        <span style="font-size: 13px; font-weight: 800; color: #fff;">Deixe sua nota para este conteúdo:</span>
                        <div style="display: flex; align-items: center; gap: 6px;">
                            <label style="font-size: 12px; color: var(--text-muted);">Sua Nota:</label>
                            <select id="playback-review-rating-select" style="background: rgba(255,255,255,0.08); border: 1px solid var(--border-color); color: #fbbf24; font-weight: 900; padding: 6px 10px; border-radius: 8px; font-size: 13px;">
                                <option value="10">★ 10 (Obra Prima)</option>
                                <option value="9">★ 9 (Excelente)</option>
                                <option value="8">★ 8 (Muito Bom)</option>
                                <option value="7">★ 7 (Bom)</option>
                                <option value="6">★ 6 (Razoável)</option>
                                <option value="5">★ 5 (Médio)</option>
                                <option value="4">★ 4 (Ruim)</option>
                                <option value="3">★ 3 (Muito Ruim)</option>
                                <option value="2">★ 2 (Péssimo)</option>
                                <option value="1">★ 1 (Horrível)</option>
                            </select>
                        </div>
                    </div>
                    <textarea id="playback-review-text" placeholder="Escreva o que achou deste filme ou episódio... (Sem spoilers)" rows="3" style="width: 100%; background: rgba(0,0,0,0.35); border: 1px solid var(--border-color); border-radius: 10px; color: #fff; padding: 12px; font-size: 13.5px; resize: vertical; margin-bottom: 12px;"></textarea>
                    <div style="display: flex; justify-content: flex-end;">
                        <button type="submit" class="btn-modal btn-modal-primary" style="padding: 9px 20px; font-size: 13px; font-weight: 800; border-radius: 10px;">
                            Publicar Avaliação
                        </button>
                    </div>
                </form>
            </div>

            <!-- Lista de Comentários -->
            <div id="playback-reviews-list" style="display: flex; flex-direction: column; gap: 10px;">
                <div style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 13px;">Nenhuma avaliação ainda. Seja o primeiro a comentar!</div>
            </div>
        </div>

        <!-- SEÇÃO: RECOMENDAÇÕES E TÍTULOS RELACIONADOS -->
        <div id="playback-recommendations-section" style="margin-bottom: 40px;">
            <div class="playback-section-title">
                <span>🔥 Você Também Pode Gostar</span>
            </div>
            <div class="rail-cards-container" id="playback-recommendations-list" style="padding-bottom: 10px;">
                <!-- Cards de recomendação renderizados via JS -->
            </div>
        </div>

    </div>
`;

// Insert the dedicated playback page tab right after tab-media-detail
if (!html.includes('id="tab-playback-page"')) {
    html = html.replace('<div id="tab-media-detail"', playbackPageHTML + '\n    <div id="tab-media-detail"');
}

// Remove old web-player-modal backdrop container if needed, or keep it empty / inert for safety
// In our implementation, player-card-container is now inside #tab-playback-page.
// Let's remove the duplicate modal wrapper lines around `id="web-player-modal"`.
const oldModalStart = html.indexOf('<div class="modal-backdrop" id="web-player-modal"');
if (oldModalStart !== -1) {
    const oldModalEnd = html.indexOf('</div>\n    </div>\n\n    <script>', oldModalStart);
    if (oldModalEnd !== -1) {
        // Replace old web player modal with a small backward-compatibility element
        html = html.substring(0, oldModalStart) + '<!-- Web Player migrado para #tab-playback-page -->' + html.substring(oldModalEnd + 18);
    }
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('HTML and CSS injected successfully! Length:', html.length);
