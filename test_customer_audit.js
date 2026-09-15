const path = require('path');
const db = require('./src/database/db');
const auditService = require('./src/services/AuditService');
const authService = require('./src/services/AuthService');

function assert(condition, message) {
    if (!condition) {
        console.error(`❌ ASSERTION FAILED: ${message}`);
        process.exit(1);
    } else {
        console.log(`✅ PASS: ${message}`);
    }
}

console.log('====================================================');
console.log('🧪 INICIANDO SUÍTE DE TESTES DO CUSTOMER AUDIT');
console.log('====================================================\n');

(async () => {
    try {
        // Mock in-memory PostgreSQL store for audit tests
        const mockAuditEvents = [];
        const mockPlaybackSessions = [];
        const mockUsuarios = [
            { id: 1, email: 'user1@brasilflix.com', username: 'user1', telegram_id: 1001, created_at: new Date() },
            { id: 2, email: 'user2@brasilflix.com', username: 'user2', telegram_id: null, created_at: new Date() }
        ];

        const originalQuery = db.query;
        db.query = async (sql, params = []) => {
            const cleanSql = sql.replace(/\s+/g, ' ').trim();

            if (cleanSql.includes('INSERT INTO audit_events')) {
                const ev = {
                    id: mockAuditEvents.length + 1,
                    identity_type: params[0],
                    user_id: params[1],
                    telegram_id: params[2],
                    visitor_id: params[3],
                    event_type: params[4],
                    timestamp: params[5] || new Date(),
                    source: params[6],
                    session_id: params[7],
                    media_id: params[8],
                    series_id: params[9],
                    season_num: params[10],
                    episode_num: params[11],
                    title: params[12],
                    metadata: params[13],
                    status: params[14],
                    error: params[15]
                };
                mockAuditEvents.push(ev);
                return { rows: [ev], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT current_position, watch_time, completed FROM audit_playback_sessions')) {
                const found = mockPlaybackSessions.find(s => s.id === params[0]);
                return { rows: found ? [{ ...found }] : [], rowCount: found ? 1 : 0 };
            }

            if (cleanSql.includes('INSERT INTO audit_playback_sessions')) {
                const sess = {
                    id: params[0],
                    identity_type: params[1],
                    user_id: params[2],
                    telegram_id: params[3],
                    visitor_id: params[4],
                    media_id: params[5],
                    media_type: params[6],
                    title: params[7],
                    season_num: params[8],
                    episode_num: params[9],
                    current_position: params[10],
                    duration: params[11],
                    watch_time: params[12],
                    completed: params[13],
                    platform: params[14],
                    device: params[15],
                    ip_address: params[16],
                    created_at: new Date(),
                    last_heartbeat: new Date()
                };
                mockPlaybackSessions.push(sess);
                return { rows: [sess], rowCount: 1 };
            }

            if (cleanSql.includes('UPDATE audit_playback_sessions')) {
                const found = mockPlaybackSessions.find(s => s.id === params[4]);
                if (found) {
                    found.current_position = params[0];
                    found.duration = params[1] > 0 ? params[1] : found.duration;
                    found.watch_time = params[2];
                    found.completed = found.completed || params[3];
                    found.last_heartbeat = new Date();
                }
                return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM usuarios')) {
                return { rows: [{ count: mockUsuarios.length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(DISTINCT visitor_id)')) {
                const uniqueAnons = new Set(mockAuditEvents.filter(e => e.visitor_id && e.identity_type === 'anonymous').map(e => e.visitor_id));
                return { rows: [{ count: uniqueAnons.size }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(DISTINCT telegram_id)')) {
                const uniqueTgs = new Set(mockAuditEvents.filter(e => e.telegram_id).map(e => e.telegram_id));
                return { rows: [{ count: uniqueTgs.size }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(DISTINCT COALESCE(user_id::text, telegram_id::text, visitor_id)) as count FROM audit_events')) {
                return { rows: [{ count: mockAuditEvents.length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(DISTINCT COALESCE(user_id::text, telegram_id::text, visitor_id)) as count FROM audit_playback_sessions')) {
                return { rows: [{ count: mockPlaybackSessions.length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(DISTINCT session_id)')) {
                const sessions = new Set(mockAuditEvents.filter(e => e.session_id).map(e => e.session_id));
                return { rows: [{ count: sessions.size }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE event_type = \'PLAYBACK_STARTED\'')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.event_type === 'PLAYBACK_STARTED').length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE event_type IN (\'EPISODE_COMPLETED\', \'MOVIE_COMPLETED\')')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.event_type.includes('COMPLETED')).length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE event_type = \'FAVORITE_ADDED\'')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.event_type === 'FAVORITE_ADDED').length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE event_type = \'REQUEST_CREATED\'')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.event_type === 'REQUEST_CREATED').length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE event_type IN (\'SEARCH\', \'TELEGRAM_SEARCH\')')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.event_type.includes('SEARCH')).length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COALESCE(SUM(watch_time), 0) as total_seconds')) {
                const total = mockPlaybackSessions.reduce((acc, s) => acc + (s.watch_time || 0), 0);
                return { rows: [{ total_seconds: total }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE source = \'website\'')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.source === 'website').length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT COUNT(*) as count FROM audit_events WHERE source = \'telegram\'')) {
                return { rows: [{ count: mockAuditEvents.filter(e => e.source === 'telegram').length }], rowCount: 1 };
            }

            if (cleanSql.includes('SELECT * FROM usuarios WHERE id =')) {
                const found = mockUsuarios.find(u => u.id === params[0]);
                return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
            }

            if (cleanSql.includes('FROM audit_events') && cleanSql.includes('ORDER BY timestamp DESC')) {
                let filtered = [...mockAuditEvents];
                if (params[0]) {
                    filtered = filtered.filter(e => e.user_id === params[0] || e.telegram_id === params[0] || e.visitor_id === params[0]);
                }
                return { rows: filtered, rowCount: filtered.length };
            }

            if (cleanSql.includes('FROM audit_playback_sessions')) {
                return { rows: mockPlaybackSessions, rowCount: mockPlaybackSessions.length };
            }

            return { rows: [], rowCount: 0 };
        };

        // ---------------------------------------------------------------------
        // Teste 1: Anonymous visitor identity creation & event logging
        // ---------------------------------------------------------------------
        console.log('--- Teste 1: Anonymous Visitor Identity & Events ---');
        const anonRes = await auditService.logEvent({
            visitorId: 'anon_uuid_12345',
            eventType: 'WEBSITE_VISIT',
            source: 'website',
            title: '/catalogo',
            metadata: { userAgent: 'Mozilla/5.0' }
        });
        assert(anonRes === true, 'Evento de visitante anônimo registrado com sucesso');
        assert(mockAuditEvents.length === 1 && mockAuditEvents[0].identity_type === 'anonymous', 'Identidade anônima determinada corretamente');

        // ---------------------------------------------------------------------
        // Teste 2: Registered user identity event
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 2: Registered User Identity & Events ---');
        await auditService.logEvent({
            userId: 1,
            eventType: 'LOGIN',
            source: 'website',
            title: 'user1'
        });
        assert(mockAuditEvents[1].identity_type === 'registered' && mockAuditEvents[1].user_id === 1, 'Identidade registrada determinada corretamente');

        // ---------------------------------------------------------------------
        // Teste 3: Telegram user identity event
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 3: Telegram User Identity & Events ---');
        await auditService.logEvent({
            telegramId: 987654321,
            eventType: 'TELEGRAM_SEARCH',
            source: 'telegram',
            title: 'Solo Leveling',
            metadata: { resultsCount: 10 }
        });
        assert(mockAuditEvents[2].identity_type === 'telegram' && mockAuditEvents[2].telegram_id === 987654321, 'Identidade Telegram determinada corretamente');

        // ---------------------------------------------------------------------
        // Teste 4: Website events (PAGE_VIEW, TITLE_OPENED)
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 4: Website Events ---');
        await auditService.logEvent({ visitorId: 'anon_uuid_12345', eventType: 'PAGE_VIEW', title: 'Home' });
        await auditService.logEvent({ visitorId: 'anon_uuid_12345', eventType: 'TITLE_OPENED', mediaId: '101', title: 'One Piece' });
        assert(mockAuditEvents.filter(e => e.source === 'website').length >= 4, 'Eventos do website registrados com source=website');

        // ---------------------------------------------------------------------
        // Teste 5: Telegram events
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 5: Telegram Events ---');
        await auditService.logEvent({ telegramId: 987654321, eventType: 'TELEGRAM_BUTTON_CLICK', source: 'telegram', title: 'ver_serie_88' });
        assert(mockAuditEvents.filter(e => e.source === 'telegram').length === 2, 'Eventos do Telegram registrados com source=telegram');

        // ---------------------------------------------------------------------
        // Teste 6: Account creation event
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 6: Account Creation Event ---');
        await auditService.logEvent({ userId: 2, eventType: 'ACCOUNT_CREATED', source: 'website', title: 'user2' });
        assert(mockAuditEvents.some(e => e.event_type === 'ACCOUNT_CREATED'), 'Evento ACCOUNT_CREATED registrado');

        // ---------------------------------------------------------------------
        // Teste 7: Search event & Zero-result search
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 7: Search Events (com e sem resultado) ---');
        await auditService.logEvent({ visitorId: 'anon_uuid_12345', eventType: 'SEARCH', title: 'naruto shippuden', metadata: { resultsCount: '0' } });
        assert(mockAuditEvents.some(e => e.event_type === 'SEARCH' && e.metadata.includes('"resultsCount":"0"')), 'Busca com 0 resultados registrada com metadata');

        // ---------------------------------------------------------------------
        // Teste 8: Favorite event
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 8: Favorite Events ---');
        await auditService.logEvent({ userId: 1, eventType: 'FAVORITE_ADDED', mediaId: '101', title: 'One Piece' });
        assert(mockAuditEvents.some(e => e.event_type === 'FAVORITE_ADDED'), 'Evento FAVORITE_ADDED registrado');

        // ---------------------------------------------------------------------
        // Teste 9: Request event
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 9: Request Event ---');
        await auditService.logEvent({ userId: 1, eventType: 'REQUEST_CREATED', title: 'Interstellar', metadata: { tipo: 'filme' } });
        assert(mockAuditEvents.some(e => e.event_type === 'REQUEST_CREATED'), 'Evento REQUEST_CREATED registrado');

        // ---------------------------------------------------------------------
        // Teste 10: Playback start, progress heartbeat & completion
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 10: Playback Start, Progress Heartbeat & Completion ---');
        const pbSession = await auditService.recordPlaybackProgress({
            visitorId: 'anon_uuid_12345',
            mediaId: '101',
            mediaType: 'serie',
            title: 'One Piece',
            seasonNum: 1,
            episodeNum: 1,
            currentPosition: 10,
            duration: 1400,
            platform: 'website'
        });
        assert(pbSession.success === true && pbSession.sessionId, 'Início de reprodução registrou sessão');

        // Progress heartbeat
        await auditService.recordPlaybackProgress({
            sessionId: pbSession.sessionId,
            visitorId: 'anon_uuid_12345',
            mediaId: '101',
            mediaType: 'serie',
            title: 'One Piece',
            seasonNum: 1,
            episodeNum: 1,
            currentPosition: 300,
            duration: 1400,
            platform: 'website'
        });

        // Completion heartbeat
        await auditService.recordPlaybackProgress({
            sessionId: pbSession.sessionId,
            visitorId: 'anon_uuid_12345',
            mediaId: '101',
            mediaType: 'serie',
            title: 'One Piece',
            seasonNum: 1,
            episodeNum: 1,
            currentPosition: 1350,
            duration: 1400,
            completed: true,
            platform: 'website'
        });

        assert(mockPlaybackSessions.length === 1 && mockPlaybackSessions[0].completed === true, 'Sessão de reprodução atualizada para concluída');
        assert(mockAuditEvents.some(e => e.event_type === 'EPISODE_COMPLETED' || e.event_type === 'MOVIE_COMPLETED'), 'Evento EPISODE_COMPLETED gerado');

        // ---------------------------------------------------------------------
        // Teste 11: Dashboard Metrics calculation
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 11: Dashboard Metrics Aggregation ---');
        const metrics = await auditService.getDashboardMetrics('today');
        assert(metrics.totalRegisteredUsers === 2, 'Métrica totalRegisteredUsers correta');
        assert(metrics.totalAnonymousVisitors === 1, 'Métrica totalAnonymousVisitors correta');
        assert(metrics.playbackStartsInPeriod >= 1, 'Métrica playbackStartsInPeriod correta');
        assert(metrics.completedEpisodesInPeriod >= 1, 'Métrica completedEpisodesInPeriod correta');

        // ---------------------------------------------------------------------
        // Teste 12: Individual User Profile & Timeline
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 12: Individual User Profile & Timeline ---');
        const profile = await auditService.getPersonProfile('user_1', 'registered');
        assert(profile.identity.userId === 1, 'Perfil do usuário resolvido corretamente');
        assert(profile.activitySummary.totalWatchTimeFormatted !== undefined, 'Resumo de tempo assistido calculado');

        const timeline = await auditService.getPersonTimeline('user_1', 'registered', {}, { page: 1, limit: 10 });
        assert(Array.isArray(timeline.events) && timeline.pagination.page === 1, 'Linha do tempo paginada retornada com sucesso');

        // ---------------------------------------------------------------------
        // Teste 13: Content Analytics & Zero-Result Searches
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 13: Content Analytics & Zero-Result Searches ---');
        const contentAnalytics = await auditService.getContentAnalytics('today');
        assert(Array.isArray(contentAnalytics.mostWatched), 'Análise de mais assistidos retornada');
        assert(Array.isArray(contentAnalytics.noResultSearches), 'Análise de buscas sem resultado retornada');

        // ---------------------------------------------------------------------
        // Teste 14: Non-blocking Fail-Safe behavior on DB error
        // ---------------------------------------------------------------------
        console.log('\n--- Teste 14: Fail-Safe Isolation na Falha de Banco ---');
        db.query = async () => { throw new Error('DB CONNECTION LOST'); };
        const failSafeLog = await auditService.logEvent({ visitorId: 'test', eventType: 'TEST_FAIL' });
        assert(failSafeLog === false, 'Auditoria falhou graciosamente sem lançar exceção');

        db.query = originalQuery;

        console.log('\n====================================================');
        console.log('🎉 TODOS OS TESTES DO CUSTOMER AUDIT PASSARAM COM SUCESSO!');
        console.log('====================================================\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ ERRO NO TESTE DE AUDITORIA:', err);
        process.exit(1);
    }
})();
