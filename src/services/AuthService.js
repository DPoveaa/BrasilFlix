const crypto = require('crypto');
const db = require('../database/db');
const config = require('../../config');

class AuthService {
    constructor() {
        this.jwtSecret = process.env.JWT_SECRET || config.JWT_SECRET || this.getOrCreateSecret();
    }

    getOrCreateSecret() {
        // Gera segredo criptográfico aleatório caso não esteja no config/env
        if (!this._cachedSecret) {
            this._cachedSecret = crypto.randomBytes(48).toString('hex');
        }
        return this._cachedSecret;
    }

    hashPassword(password, salt = null) {
        const useSalt = salt || crypto.randomBytes(16).toString('hex');
        const hash = crypto.pbkdf2Sync(password, useSalt, 100000, 64, 'sha512').toString('hex');
        return `${useSalt}:${hash}`;
    }

    verifyPassword(password, storedHash) {
        if (!storedHash || !storedHash.includes(':')) return false;
        const [salt, originalHash] = storedHash.split(':');
        const checkHash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
        return crypto.timingSafeEqual(Buffer.from(checkHash, 'hex'), Buffer.from(originalHash, 'hex'));
    }

    // Geração nativa de JWT HS256 com Node.js Crypto (Zero dependências externas)
    generateToken(payload, expiresInSeconds = 7 * 24 * 3600) {
        const header = {
            alg: 'HS256',
            typ: 'JWT'
        };

        const now = Math.floor(Date.now() / 1000);
        const fullPayload = {
            ...payload,
            iat: now,
            exp: now + expiresInSeconds
        };

        const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
        const b64Payload = Buffer.from(JSON.stringify(fullPayload)).toString('base64url');

        const signature = crypto
            .createHmac('sha256', this.jwtSecret)
            .update(`${b64Header}.${b64Payload}`)
            .digest('base64url');

        return `${b64Header}.${b64Payload}.${signature}`;
    }

    verifyToken(token) {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const [b64Header, b64Payload, signature] = parts;

        const expectedSig = crypto
            .createHmac('sha256', this.jwtSecret)
            .update(`${b64Header}.${b64Payload}`)
            .digest('base64url');

        if (signature !== expectedSig) {
            return null;
        }

        try {
            const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
            const now = Math.floor(Date.now() / 1000);
            if (payload.exp && payload.exp < now) {
                return null; // Token expirado
            }
            return payload;
        } catch (e) {
            return null;
        }
    }

    async initAdminUser(defaultPassword = null) {
        try {
            await db.query(`
                CREATE TABLE IF NOT EXISTS admin_users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(100) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(50) DEFAULT 'admin',
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                )
            `);

            const res = await db.query(`SELECT id, username, password_hash FROM admin_users WHERE username = 'admin'`);
            if (res.rows.length === 0) {
                const pass = defaultPassword || crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, 'x').substr(0, 12) + '@Bflix';
                const hash = this.hashPassword(pass);
                await db.query(`INSERT INTO admin_users (username, password_hash, role) VALUES ('admin', $1, 'admin')`, [hash]);
                console.log(`🔐 [ADMIN SETUP] Usuário admin criado com sucesso! Senha: ${pass}`);
                return { isNew: true, username: 'admin', password: pass };
            }
            return { isNew: false, username: 'admin' };
        } catch (e) {
            console.warn('⚠️ Erro ao inicializar tabela admin_users:', e.message);
            return null;
        }
    }

    async login(username, password) {
        if (!username || !password) return { success: false, message: 'Usuário e senha são obrigatórios.' };

        try {
            const res = await db.query(`SELECT * FROM admin_users WHERE username = $1`, [username.trim().toLowerCase()]);
            if (res.rows.length === 0) {
                return { success: false, message: 'Credenciais inválidas.' };
            }

            const user = res.rows[0];
            const isValid = this.verifyPassword(password, user.password_hash);
            if (!isValid) {
                return { success: false, message: 'Credenciais inválidas.' };
            }

            const token = this.generateToken({
                id: user.id,
                username: user.username,
                role: user.role || 'admin'
            });

            return {
                success: true,
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    role: user.role || 'admin'
                }
            };
        } catch (e) {
            console.error('Erro no login admin:', e.message);
            return { success: false, message: 'Erro interno ao autenticar.' };
        }
    }

    // Middleware Express para rotas protegidas por JWT
    authMiddleware() {
        return (req, res, next) => {
            const authHeader = req.headers.authorization;
            let token = null;

            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.substring(7).trim();
            } else if (req.headers['x-admin-token']) {
                token = req.headers['x-admin-token'];
            } else if (req.query && req.query.admin_token) {
                token = req.query.admin_token;
            }

            if (!token) {
                return res.status(401).json({ error: 'Acesso não autorizado. Token JWT ausente.' });
            }

            const payload = this.verifyToken(token);
            if (!payload) {
                return res.status(403).json({ error: 'Sessão expirada ou token inválido. Faça login novamente.' });
            }

            req.adminUser = payload;
            next();
        };
    }
}

module.exports = new AuthService();
