        function shouldHideBrasilFlixAds() {
            try {
                // 1. Regra estrita: Oculta anúncios apenas e exclusivamente dentro da tela do Admin
                const activeTab = localStorage.getItem('bf_active_tab');
                if (activeTab === 'tab-admin') return true;
                if (window.location.hash.startsWith('#admin')) return true;
                if (window.location.pathname.startsWith('/admin')) return true;

                const adminTabEl = document.getElementById('tab-admin');
                if (adminTabEl && (adminTabEl.classList.contains('active') || adminTabEl.style.display !== 'none')) {
                    return true;
                }

                // 2. Se o usuário for assinante VIP (e NÃO for administrador), oculta anúncios
                // (O Administrador vê anúncios nas páginas comuns para validação e monetização normal)
                if (window.currentUser) {
                    const isAdm = window.currentUser.role === 'admin' || window.currentUser.isAdmin || window.currentUser.is_admin;
                    const isVip = window.currentUser.is_vip || window.currentUser.isVip;
                    if (isVip && !isAdm) return true;
                }
                if (localStorage.getItem('bf_user_is_vip') === 'true' && !localStorage.getItem('bf_admin_token')) {
                    return true;
                }
            } catch (e) { }
            return false;
        }

        function hideBrasilFlixAds() {
            document.body.classList.add('in-admin-tab');
            const wrappers = document.querySelectorAll('.bf-banner-ad-wrapper, .bf-side-col, .bf-native-ad-wrapper');
            wrappers.forEach(w => {
                w.style.display = 'none';
            });
        }

        function loadAdsterraNativeWidget() {
            const container = document.getElementById('container-4120a3d13ce2b8cb6073da3984309212');
            if (!container || container.dataset.loaded === 'true') return;
            container.dataset.loaded = 'true';

            const wrapper = document.getElementById('bf-native-home-wrapper');
            if (wrapper) wrapper.style.display = 'block';

            const script = document.createElement('script');
            script.async = true;
            script.setAttribute('data-cfasync', 'false');
            script.src = 'https://pl31580195.profitableratecpmnetwork.com/4120a3d13ce2b8cb6073da3984309212/invoke.js';
            document.head.appendChild(script);
        }

        function initBrasilFlixAds() {
            if (shouldHideBrasilFlixAds()) {
                hideBrasilFlixAds();
                return;
            }

            document.body.classList.remove('in-admin-tab');

            // Garante exibição dos banners horizontais apropriados
            const activeTab = localStorage.getItem('bf_active_tab') || 'tab-catalogo';
            const navMode = typeof currentNavMode !== 'undefined' ? currentNavMode : (localStorage.getItem('bf_active_nav') || 'inicio');

            const homeAd = document.getElementById('bf-home-bottom-ad');
            const catAd = document.getElementById('bf-catalog-bottom-ad');
            const playerAd = document.getElementById('bf-player-bottom-ad');

            if (activeTab === 'tab-catalogo') {
                if (navMode === 'inicio') {
                    if (homeAd) homeAd.style.display = 'flex';
                    if (catAd) catAd.style.display = 'none';
                    loadAdsterraNativeWidget();
                } else {
                    if (homeAd) homeAd.style.display = 'none';
                    if (catAd) catAd.style.display = 'flex';
                }
            } else {
                if (homeAd) homeAd.style.display = 'none';
                if (catAd) catAd.style.display = 'none';
            }

            if (playerAd) {
                playerAd.style.display = 'flex';
            }
        }

        // Inicializa anúncios de forma segura após o DOM estar pronto
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(initBrasilFlixAds, 200));
        } else {
            setTimeout(initBrasilFlixAds, 200);
        }
