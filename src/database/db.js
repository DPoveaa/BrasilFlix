const { Pool, Client } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../../config');

let pool = null;

async function ensureDatabaseExists() {
    const adminClient = new Client({
        host: config.DB_HOST,
        port: config.DB_PORT,
        user: config.DB_USER,
        password: config.DB_PASSWORD,
        database: 'postgres'
    });

    try {
        await adminClient.connect();
        const res = await adminClient.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [config.DB_NAME]);
        if (res.rowCount === 0) {
            console.log(`📦 Criando banco de dados PostgreSQL "${config.DB_NAME}"...`);
            await adminClient.query(`CREATE DATABASE "${config.DB_NAME}"`);
            console.log(`✅ Banco de dados "${config.DB_NAME}" criado com sucesso!`);
        }
    } catch (err) {
        console.warn(`⚠️ Verificação de banco de dados:`, err.message);
    } finally {
        await adminClient.end().catch(() => {});
    }
}

function getPool() {
    if (!pool) {
        pool = new Pool({
            host: config.DB_HOST,
            port: config.DB_PORT,
            database: config.DB_NAME,
            user: config.DB_USER,
            password: config.DB_PASSWORD,
            max: 30,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 20000,
            keepAlive: true,
            keepAliveInitialDelayMillis: 10000
        });

        pool.on('error', (err) => {
            console.error('❌ Erro no Pool PostgreSQL (recuperando):', err.message);
        });
    }
    return pool;
}

async function query(text, params, maxRetries = 3) {
    const p = getPool();
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const res = await p.query(text, params);
            return res;
        } catch (err) {
            const isTransient = err.message && (
                err.message.includes('timeout') ||
                err.message.includes('Connection terminated') ||
                err.message.includes('ECONNRESET') ||
                err.message.includes('closed') ||
                err.message.includes('Connection refused')
            );
            if (isTransient && attempt < maxRetries) {
                const delayMs = attempt * 800;
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            throw err;
        }
    }
}

async function createTables() {
    console.log('🔄 Inicializando esquemas e tabelas PostgreSQL...');

    await query(`
        CREATE TABLE IF NOT EXISTS filmes (
            id BIGSERIAL PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            nome_original VARCHAR(255),
            ano VARCHAR(10),
            generos JSONB DEFAULT '[]',
            sinopse TEXT,
            poster_url TEXT,
            backdrop_url TEXT,
            nota NUMERIC(3,1) DEFAULT 8.0,
            tmdb_id INTEGER,
            imdb_id VARCHAR(50),
            message_id BIGINT,
            file_id TEXT,
            qualidade VARCHAR(50),
            audio VARCHAR(100),
            is_dublado BOOLEAN DEFAULT true,
            is_legendado BOOLEAN DEFAULT false,
            is_cam BOOLEAN DEFAULT false,
            versoes JSONB DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Garantir tipo BIGINT caso tabela tenha sido criada anteriormente com INTEGER
        ALTER TABLE filmes ALTER COLUMN id TYPE BIGINT;
        ALTER TABLE filmes ADD COLUMN IF NOT EXISTS versoes JSONB DEFAULT '{}';
        ALTER TABLE filmes ADD COLUMN IF NOT EXISTS is_anime BOOLEAN DEFAULT false;
        ALTER TABLE filmes ADD COLUMN IF NOT EXISTS is_dorama BOOLEAN DEFAULT false;

        CREATE TABLE IF NOT EXISTS series (
            id BIGSERIAL PRIMARY KEY,
            nome VARCHAR(255) NOT NULL,
            nome_original VARCHAR(255),
            ano VARCHAR(10),
            generos JSONB DEFAULT '[]',
            sinopse TEXT,
            poster_url TEXT,
            backdrop_url TEXT,
            nota NUMERIC(3,1) DEFAULT 8.0,
            tmdb_id INTEGER,
            imdb_id VARCHAR(50),
            total_temporadas INTEGER DEFAULT 1,
            total_episodios INTEGER DEFAULT 0,
            is_dorama BOOLEAN DEFAULT false,
            is_anime BOOLEAN DEFAULT false,
            is_dublado BOOLEAN DEFAULT true,
            is_legendado BOOLEAN DEFAULT false,
            is_cam BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE series ALTER COLUMN id TYPE BIGINT;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS is_dorama BOOLEAN DEFAULT false;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS is_anime BOOLEAN DEFAULT false;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS is_microdrama BOOLEAN DEFAULT false;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS subtipo VARCHAR(50) DEFAULT 'serie';
        ALTER TABLE series ADD COLUMN IF NOT EXISTS formato VARCHAR(50) DEFAULT 'horizontal';
        ALTER TABLE series ADD COLUMN IF NOT EXISTS origem VARCHAR(50) DEFAULT 'China';
        ALTER TABLE series ADD COLUMN IF NOT EXISTS plataforma_origem VARCHAR(100);
        ALTER TABLE series ADD COLUMN IF NOT EXISTS trending_score NUMERIC(5,2) DEFAULT 0.0;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS metadata_extra JSONB DEFAULT '{}';
        ALTER TABLE series ADD COLUMN IF NOT EXISTS em_lancamento BOOLEAN DEFAULT false;
        ALTER TABLE series ADD COLUMN IF NOT EXISTS status_serie VARCHAR(50) DEFAULT 'Ended';
        ALTER TABLE series ADD COLUMN IF NOT EXISTS temporadas_meta JSONB DEFAULT '{}';

        CREATE TABLE IF NOT EXISTS episodios (
            id BIGSERIAL PRIMARY KEY,
            serie_id BIGINT REFERENCES series(id) ON DELETE CASCADE,
            temporada_numero INTEGER NOT NULL,
            numero INTEGER NOT NULL,
            nome VARCHAR(255),
            sinopse TEXT,
            message_id BIGINT,
            file_id TEXT,
            qualidade VARCHAR(50),
            audio VARCHAR(100),
            is_dublado BOOLEAN DEFAULT true,
            is_legendado BOOLEAN DEFAULT false,
            versoes JSONB DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(serie_id, temporada_numero, numero)
        );

        ALTER TABLE episodios ALTER COLUMN id TYPE BIGINT;
        ALTER TABLE episodios ALTER COLUMN serie_id TYPE BIGINT;
        ALTER TABLE episodios ADD COLUMN IF NOT EXISTS versoes JSONB DEFAULT '{}';
        ALTER TABLE episodios ADD COLUMN IF NOT EXISTS still_url TEXT;
        ALTER TABLE episodios ADD COLUMN IF NOT EXISTS duracao INTEGER;
        ALTER TABLE episodios ADD COLUMN IF NOT EXISTS formato VARCHAR(50);

        CREATE TABLE IF NOT EXISTS pedidos (
            id VARCHAR(50) PRIMARY KEY,
            user_id BIGINT NOT NULL,
            username VARCHAR(255),
            nome VARCHAR(255) NOT NULL,
            tipo VARCHAR(50) DEFAULT 'filme',
            is_assinante BOOLEAN DEFAULT false,
            processado BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS temporada VARCHAR(100);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS idioma VARCHAR(100);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS tmdb_id INTEGER;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS poster_url TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS ano VARCHAR(20);
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS detalhes TEXT;
        ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pendente';

        CREATE TABLE IF NOT EXISTS feedbacks (
            id BIGSERIAL PRIMARY KEY,
            user_id VARCHAR(100),
            username VARCHAR(255),
            tipo VARCHAR(50) DEFAULT 'suporte',
            titulo VARCHAR(255),
            mensagem TEXT NOT NULL,
            contato VARCHAR(255),
            status VARCHAR(50) DEFAULT 'aberto',
            notified BOOLEAN DEFAULT false,
            media_id BIGINT,
            imagem_url TEXT,
            resposta TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS notified BOOLEAN DEFAULT false;
        ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS media_id BIGINT;
        ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS imagem_url TEXT;
        ALTER TABLE feedbacks ADD COLUMN IF NOT EXISTS resposta TEXT;

        CREATE TABLE IF NOT EXISTS user_notifications (
            id BIGSERIAL PRIMARY KEY,
            user_id VARCHAR(100) NOT NULL,
            title VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            media_id BIGINT,
            media_type VARCHAR(50),
            link TEXT,
            read BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS assinaturas (
            user_id BIGINT PRIMARY KEY,
            username VARCHAR(255),
            plano VARCHAR(50) DEFAULT 'mensal',
            data_inicio TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            data_fim TIMESTAMP WITH TIME ZONE,
            status VARCHAR(50) DEFAULT 'ativa',
            pagamento_id VARCHAR(100),
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS testes_gratuitos (
            user_id BIGINT PRIMARY KEY,
            username VARCHAR(255),
            data_inicio TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            data_fim TIMESTAMP WITH TIME ZONE,
            ativo BOOLEAN DEFAULT true
        );

        CREATE TABLE IF NOT EXISTS favoritos (
            id BIGSERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL,
            item_id BIGINT NOT NULL,
            tipo VARCHAR(50) NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(user_id, item_id, tipo)
        );

        ALTER TABLE favoritos ALTER COLUMN id TYPE BIGINT;
        ALTER TABLE favoritos ALTER COLUMN item_id TYPE BIGINT;

        CREATE TABLE IF NOT EXISTS queue_jobs (
            id VARCHAR(100) PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            type VARCHAR(50) NOT NULL,
            priority INTEGER DEFAULT 4,
            audio_preference VARCHAR(50) DEFAULT 'dublado',
            season INTEGER,
            episode INTEGER,
            status VARCHAR(50) DEFAULT 'queued',
            progress INTEGER DEFAULT 0,
            progress_details TEXT,
            user_id BIGINT,
            username VARCHAR(255),
            tmdb_id INTEGER,
            extra_data JSONB DEFAULT '{}',
            error TEXT,
            queue_order BIGINT DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE queue_jobs ADD COLUMN IF NOT EXISTS queue_order BIGINT DEFAULT 0;

        CREATE TABLE IF NOT EXISTS stremio_tokens (
            token VARCHAR(100) PRIMARY KEY,
            user_id BIGINT,
            username VARCHAR(255),
            tipo VARCHAR(50) DEFAULT 'vitalicio',
            ativo BOOLEAN DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS swarm_watchlist (
            id BIGSERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            type VARCHAR(50) DEFAULT 'filme',
            tmdb_id INTEGER,
            imdb_id VARCHAR(50),
            season INTEGER,
            episode INTEGER,
            audio_preference VARCHAR(50) DEFAULT 'dublado',
            user_id BIGINT,
            username VARCHAR(255),
            reason VARCHAR(100) DEFAULT 'no_seeders',
            last_checked TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            check_count INTEGER DEFAULT 0,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE swarm_watchlist ALTER COLUMN id TYPE BIGINT;

        CREATE TABLE IF NOT EXISTS consumo_gratis (
            id SERIAL PRIMARY KEY,
            identificador VARCHAR(150) NOT NULL,
            mes_ano VARCHAR(10) NOT NULL,
            filmes_assistidos INTEGER DEFAULT 0,
            episodios_assistidos INTEGER DEFAULT 0,
            itens_consumidos JSONB DEFAULT '{}',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(identificador, mes_ano)
        );

        ALTER TABLE consumo_gratis ADD COLUMN IF NOT EXISTS itens_consumidos JSONB DEFAULT '{}';

        CREATE TABLE IF NOT EXISTS admin_users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'admin',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS usuarios (
            id SERIAL PRIMARY KEY,
            email VARCHAR(255) UNIQUE NOT NULL,
            username VARCHAR(100) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            telegram_id BIGINT,
            is_vip BOOLEAN DEFAULT false,
            vip_expira TIMESTAMP WITH TIME ZONE,
            favoritos JSONB DEFAULT '[]',
            historico JSONB DEFAULT '[]',
            notificacoes JSONB DEFAULT '[]',
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE usuarios ALTER COLUMN email DROP NOT NULL;
        ALTER TABLE usuarios ALTER COLUMN password_hash DROP NOT NULL;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS avatar_url TEXT;
        ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS preferencias JSONB DEFAULT '{"defaultAudio": "ask", "spoilerBlur": true}'::jsonb;
        CREATE INDEX IF NOT EXISTS idx_usuarios_telegram_id ON usuarios(telegram_id);
        CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username);

        CREATE TABLE IF NOT EXISTS avaliacoes_comentarios (
            id SERIAL PRIMARY KEY,
            media_id VARCHAR(100) NOT NULL,
            media_type VARCHAR(50) NOT NULL,
            user_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
            username VARCHAR(100) NOT NULL,
            rating SMALLINT DEFAULT 10,
            comentario TEXT NOT NULL,
            has_spoiler BOOLEAN DEFAULT false,
            season_num INTEGER DEFAULT 0,
            episode_num INTEGER DEFAULT 0,
            media_title VARCHAR(255),
            avatar_url TEXT,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE avaliacoes_comentarios ADD COLUMN IF NOT EXISTS has_spoiler BOOLEAN DEFAULT false;
        ALTER TABLE avaliacoes_comentarios ADD COLUMN IF NOT EXISTS season_num INTEGER DEFAULT 0;
        ALTER TABLE avaliacoes_comentarios ADD COLUMN IF NOT EXISTS episode_num INTEGER DEFAULT 0;
        ALTER TABLE avaliacoes_comentarios ADD COLUMN IF NOT EXISTS media_title VARCHAR(255);
        ALTER TABLE avaliacoes_comentarios ADD COLUMN IF NOT EXISTS avatar_url TEXT;

        CREATE TABLE IF NOT EXISTS watch_party_rooms (
            id VARCHAR(50) PRIMARY KEY,
            host_id VARCHAR(100),
            host_name VARCHAR(255),
            host_token VARCHAR(255),
            media_info JSONB,
            playback_time NUMERIC DEFAULT 0,
            is_playing BOOLEAN DEFAULT false,
            host_only_controls BOOLEAN DEFAULT true,
            permissions JSONB DEFAULT '{"canPause":true,"canResume":false,"canSeek":false,"canChangeMedia":false,"canChangeSpeed":false}',
            last_state_change BIGINT,
            last_activity BIGINT,
            wheel_items JSONB DEFAULT '[]',
            members_data JSONB DEFAULT '[]',
            created_at BIGINT
        );

        ALTER TABLE watch_party_rooms ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{"canPause":true,"canResume":false,"canSeek":false,"canChangeMedia":false,"canChangeSpeed":false}';
        ALTER TABLE watch_party_rooms ADD COLUMN IF NOT EXISTS last_state_change BIGINT;

        CREATE TABLE IF NOT EXISTS lancamentos_notificados (
            id SERIAL PRIMARY KEY,
            tipo VARCHAR(50) NOT NULL,
            media_id VARCHAR(100) NOT NULL,
            season_num INTEGER DEFAULT 0,
            audio VARCHAR(50) NOT NULL,
            notified_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(tipo, media_id, season_num, audio)
        );

        CREATE INDEX IF NOT EXISTS idx_watch_party_activity ON watch_party_rooms(last_activity);
        CREATE INDEX IF NOT EXISTS idx_lancamentos_media ON lancamentos_notificados(tipo, media_id);
        CREATE INDEX IF NOT EXISTS idx_comentarios_media ON avaliacoes_comentarios(media_type, media_id);

        CREATE INDEX IF NOT EXISTS idx_filmes_nome ON filmes(nome);
        CREATE INDEX IF NOT EXISTS idx_series_nome ON series(nome);
        CREATE INDEX IF NOT EXISTS idx_episodios_serie_season ON episodios(serie_id, temporada_numero);
        CREATE INDEX IF NOT EXISTS idx_pedidos_user ON pedidos(user_id);
        CREATE INDEX IF NOT EXISTS idx_pedidos_username ON pedidos(username);
        CREATE INDEX IF NOT EXISTS idx_comentarios_user ON avaliacoes_comentarios(user_id);
        CREATE INDEX IF NOT EXISTS idx_comentarios_username ON avaliacoes_comentarios(username);
        CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_jobs(status, priority);
        CREATE INDEX IF NOT EXISTS idx_admin_username ON admin_users(username);
        CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email);
        CREATE INDEX IF NOT EXISTS idx_usuarios_username ON usuarios(username);
        CREATE INDEX IF NOT EXISTS idx_usuarios_telegram ON usuarios(telegram_id);
    `);

    console.log('✅ Esquemas e tabelas PostgreSQL prontos com chaves BIGINT!');

    // Migração de reclassificação automática de animes e doramas (executa após criação das tabelas)
    try {
        await query(`UPDATE series SET is_anime = true, is_dorama = false
            WHERE nome ILIKE '%Bleach%' OR nome ILIKE '%One Piece%' OR nome ILIKE '%Dragon Ball%'
            OR nome ILIKE '%Naruto%' OR nome ILIKE '%Attack on Titan%' OR nome ILIKE '%Solo Leveling%'
            OR nome ILIKE '%Demon Slayer%' OR nome ILIKE '%Jujutsu Kaisen%' OR nome ILIKE '%Spy x Family%'
            OR (generos::text ILIKE '%Anima%' AND (nome ILIKE '%Sword Art%' OR nome ILIKE '%Fullmetal%' OR nome ILIKE '%Death Note%'))`);

        await query(`UPDATE series SET is_dorama = true, is_anime = false
            WHERE (nome ILIKE '%Loja Para Assassinos%' OR nome ILIKE '%Grude de Amor%'
            OR nome ILIKE '%Advogada Extraordinária%' OR nome ILIKE '%Pousando no Amor%')
            AND is_anime = false`);

        console.log('✅ Reclassificação anime/dorama aplicada no banco.');
    } catch (migErr) {
        console.warn('⚠️ Aviso migração de classificação:', migErr.message);
    }
}

async function migrateJsonData() {
    try {
        // 1. Migrar Catalogo (Filmes e Séries)
        const catRes = await query(`SELECT COUNT(*) as count FROM filmes`);
        if (parseInt(catRes.rows[0].count, 10) === 0 && fs.existsSync(config.CATALOGO_FILE)) {
            const rawCat = fs.readFileSync(config.CATALOGO_FILE, 'utf8');
            const catalogo = JSON.parse(rawCat);

            console.log('🔄 Migrando catálogo existente para PostgreSQL...');
            
            // Filmes
            for (const f of catalogo.filmes || []) {
                const midia = f.midias?.[0] || f.versoes?.dublado || f.versoes?.legendado || {};
                await query(`
                    INSERT INTO filmes (
                        id, nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                        nota, tmdb_id, imdb_id, message_id, file_id, qualidade, audio,
                        is_dublado, is_legendado, is_cam, created_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
                    ) ON CONFLICT (id) DO NOTHING
                `, [
                    f.id, f.nome, f.nomeOriginal || f.nome, f.ano || '2026', JSON.stringify(f.generos || []),
                    f.sinopse || f.descricao || '', f.posterUrl || '', f.backdropUrl || '',
                    f.nota || 8.0, f.tmdbId || null, f.imdbId || null,
                    midia.messageId || f.messageId || null, midia.fileId || f.fileId || null,
                    midia.qualidade || f.qualidade || '1080p',
                    midia.audio || f.audio || 'Dublado (PT-BR)',
                    f.isDublado ?? true, f.isLegendado ?? false,
                    f.isCam ?? false, f.dataAdicionado ? new Date(f.dataAdicionado) : (f.dataAdicao ? new Date(f.dataAdicao) : new Date())
                ]);
            }

            // Séries
            for (const s of catalogo.series || []) {
                const sInsert = await query(`
                    INSERT INTO series (
                        id, nome, nome_original, ano, generos, sinopse, poster_url, backdrop_url,
                        nota, tmdb_id, imdb_id, total_temporadas, total_episodios, is_dorama,
                        is_dublado, is_legendado, is_cam, created_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
                    ) ON CONFLICT (id) DO UPDATE SET updated_at = NOW() RETURNING id
                `, [
                    s.id, s.nome, s.nomeOriginal || s.nome, s.ano || '2026', JSON.stringify(s.generos || []),
                    s.sinopse || s.descricao || '', s.posterUrl || '', s.backdropUrl || '',
                    s.nota || 8.0, s.tmdbId || null, s.imdbId || null,
                    (s.temporadas || []).length || 1, s.totalEpisodios || 0, s.isDorama ?? false,
                    s.isDublado ?? true, s.isLegendado ?? false, s.isCam ?? false,
                    s.dataAdicionado ? new Date(s.dataAdicionado) : (s.dataAdicao ? new Date(s.dataAdicao) : new Date())
                ]);

                const serieId = s.id || sInsert.rows[0]?.id;

                for (const t of s.temporadas || []) {
                    for (const ep of t.episodios || []) {
                        await query(`
                            INSERT INTO episodios (
                                serie_id, temporada_numero, numero, nome, sinopse,
                                message_id, file_id, qualidade, audio, is_dublado, is_legendado
                            ) VALUES (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
                            ) ON CONFLICT (serie_id, temporada_numero, numero) DO NOTHING
                        `, [
                            serieId, t.numero, ep.numero, ep.nome || `Episódio ${ep.numero}`,
                            ep.sinopse || '', ep.messageId || null, ep.fileId || null,
                            ep.qualidade || '1080p', ep.audio || 'Dublado (PT-BR)',
                            ep.isDublado ?? true, ep.isLegendado ?? false
                        ]);
                    }
                }
            }

            console.log('✅ Catálogo migrado com sucesso para PostgreSQL!');
        }

        // 2. Migrar Pedidos
        const pedRes = await query(`SELECT COUNT(*) as count FROM pedidos`);
        if (parseInt(pedRes.rows[0].count, 10) === 0 && fs.existsSync(config.PEDIDOS_FILE)) {
            const raw = fs.readFileSync(config.PEDIDOS_FILE, 'utf8');
            const pedidos = JSON.parse(raw);
            for (const p of pedidos || []) {
                await query(`
                    INSERT INTO pedidos (id, user_id, username, nome, tipo, is_assinante, processado, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (id) DO NOTHING
                `, [
                    String(p.id), p.userId || p.chatId || 0, p.username || '', p.nome || '',
                    p.tipo || 'filme', p.isAssinante ?? false, p.processado ?? false,
                    p.data ? new Date(p.data) : new Date()
                ]);
            }
            console.log('✅ Pedidos migrados para PostgreSQL!');
        }

        // 3. Migrar Assinaturas
        const assRes = await query(`SELECT COUNT(*) as count FROM assinaturas`);
        if (parseInt(assRes.rows[0].count, 10) === 0 && fs.existsSync(config.ASSINATURAS_FILE)) {
            const raw = fs.readFileSync(config.ASSINATURAS_FILE, 'utf8');
            const assinaturas = JSON.parse(raw);
            for (const a of (Array.isArray(assinaturas) ? assinaturas : (assinaturas.assinaturas || []))) {
                if (!a.userId) continue;
                await query(`
                    INSERT INTO assinaturas (user_id, username, plano, data_inicio, data_fim, status, pagamento_id, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (user_id) DO NOTHING
                `, [
                    a.userId, a.username || '', a.plano || 'mensal',
                    a.dataInicio ? new Date(a.dataInicio) : new Date(),
                    a.dataVencimento ? new Date(a.dataVencimento) : (a.dataFim ? new Date(a.dataFim) : null),
                    a.status || 'ativa', a.pagamentoId || '',
                    a.createdAt ? new Date(a.createdAt) : new Date()
                ]);
            }

            for (const tok of (assinaturas.acessosVitalicios || [])) {
                await query(`
                    INSERT INTO stremio_tokens (token, username, tipo, ativo, created_at)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (token) DO NOTHING
                `, [
                    tok.token, tok.nome || 'VIP', 'vitalicio', tok.status === 'ativo',
                    tok.dataCriacao ? new Date(tok.dataCriacao) : new Date()
                ]);
            }
            console.log('✅ Assinaturas e tokens migrados para PostgreSQL!');
        }
    } catch (e) {
        console.warn('⚠️ Aviso na migração JSON para PostgreSQL:', e.message);
    }
}

async function initDb() {
    try {
        await ensureDatabaseExists();
        await createTables();
        await migrateJsonData();
        console.log('🚀 Banco de dados PostgreSQL BrasilFlix 100% conectado e operacional!');
        return true;
    } catch (error) {
        console.error('❌ Falha crítica ao inicializar PostgreSQL:', error.message);
        throw error;
    }
}

module.exports = {
    getPool,
    query,
    initDb
};
