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
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            console.error('❌ Erro inesperado no Pool PostgreSQL:', err.message);
        });
    }
    return pool;
}

async function query(text, params) {
    const p = getPool();
    const res = await p.query(text, params);
    return res;
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
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        -- Garantir tipo BIGINT caso tabela tenha sido criada anteriormente com INTEGER
        ALTER TABLE filmes ALTER COLUMN id TYPE BIGINT;

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
            is_dublado BOOLEAN DEFAULT true,
            is_legendado BOOLEAN DEFAULT false,
            is_cam BOOLEAN DEFAULT false,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        ALTER TABLE series ALTER COLUMN id TYPE BIGINT;

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
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            UNIQUE(serie_id, temporada_numero, numero)
        );

        ALTER TABLE episodios ALTER COLUMN id TYPE BIGINT;
        ALTER TABLE episodios ALTER COLUMN serie_id TYPE BIGINT;

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
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS stremio_tokens (
            token VARCHAR(100) PRIMARY KEY,
            user_id BIGINT,
            username VARCHAR(255),
            tipo VARCHAR(50) DEFAULT 'vitalicio',
            ativo BOOLEAN DEFAULT true,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_filmes_nome ON filmes(nome);
        CREATE INDEX IF NOT EXISTS idx_series_nome ON series(nome);
        CREATE INDEX IF NOT EXISTS idx_episodios_serie_season ON episodios(serie_id, temporada_numero);
        CREATE INDEX IF NOT EXISTS idx_pedidos_user ON pedidos(user_id);
        CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_jobs(status, priority);
    `);

    console.log('✅ Esquemas e tabelas PostgreSQL prontos com chaves BIGINT!');
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
