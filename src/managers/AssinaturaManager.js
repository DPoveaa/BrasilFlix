const fs = require('fs-extra');
const config = require('../../config');
const mercadopago = require('mercadopago');
const db = require('../database/db');

class AssinaturaManager {
    constructor() {
        this.assinaturas = [];
        this.acessosVitalicios = [];
        this.ensureDataDirectory();
        this.loadAssinaturas();
        this.setupMercadoPago();
    }

    setupMercadoPago() {
        if (config.mercadopago?.access_token) {
            mercadopago.configure({
                access_token: config.mercadopago.access_token
            });
        }
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
    }

    async loadAssinaturas() {
        try {
            const assRes = await db.query(`SELECT * FROM assinaturas ORDER BY data_inicio ASC`);
            const tokRes = await db.query(`SELECT * FROM stremio_tokens ORDER BY created_at ASC`);

            this.assinaturas = assRes.rows.map(a => ({
                id: a.user_id,
                userId: a.user_id ? Number(a.user_id) : 0,
                username: a.username || 'Usuário',
                plano: a.plano || 'mensal',
                dataInicio: a.data_inicio,
                dataVencimento: a.data_fim || this.calcularVencimento(a.plano),
                status: a.status || 'ativa',
                pagamentoId: a.pagamento_id
            }));

            this.acessosVitalicios = tokRes.rows.map(t => ({
                token: t.token,
                nome: t.username || 'VIP',
                criadoPor: 'admin',
                dataCriacao: t.created_at,
                status: t.ativo ? 'ativo' : 'revogado'
            }));

            console.log(`📋 Carregadas ${this.assinaturas.length} assinaturas e ${this.acessosVitalicios.length} tokens do PostgreSQL`);
        } catch (error) {
            console.error('❌ Erro ao carregar assinaturas do PostgreSQL:', error.message);
            if (fs.existsSync(config.ASSINATURAS_FILE)) {
                try {
                    const data = fs.readJsonSync(config.ASSINATURAS_FILE);
                    this.assinaturas = Array.isArray(data) ? data : (data.assinaturas || []);
                    this.acessosVitalicios = data.acessosVitalicios || [];
                } catch (e) {}
            }
        }
    }

    async saveAssinaturas() {
        try {
            const dataToSave = {
                assinaturas: this.assinaturas,
                acessosVitalicios: this.acessosVitalicios || []
            };
            fs.writeJsonSync(config.ASSINATURAS_FILE, dataToSave, { spaces: 2 });
        } catch (e) {}
    }

    calcularVencimento(plano) {
        const data = new Date();
        if (plano === 'vitalicio') {
            return '2099-12-31T23:59:59.999Z';
        } else if (plano === 'mensal') {
            data.setMonth(data.getMonth() + 1);
        } else if (plano === 'trimestral') {
            data.setMonth(data.getMonth() + 3);
        } else if (plano === 'semestral') {
            data.setMonth(data.getMonth() + 6);
        } else if (plano === 'anual') {
            data.setFullYear(data.getFullYear() + 1);
        }
        return data.toISOString();
    }

    async criarAssinatura(userId, username, plano = 'mensal', pagamentoId = null) {
        const cleanUser = (username || 'Usuário').replace(/^@/, '');
        const dataVencimento = this.calcularVencimento(plano);

        const assinatura = {
            id: userId,
            userId,
            username: cleanUser,
            plano,
            dataInicio: new Date().toISOString(),
            dataVencimento,
            status: 'ativa',
            pagamentoId
        };

        try {
            await db.query(`
                INSERT INTO assinaturas (user_id, username, plano, data_inicio, data_fim, status, pagamento_id, created_at)
                VALUES ($1, $2, $3, NOW(), $4, $5, $6, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    username = EXCLUDED.username,
                    plano = EXCLUDED.plano,
                    data_fim = EXCLUDED.data_fim,
                    status = EXCLUDED.status,
                    pagamento_id = EXCLUDED.pagamento_id
            `, [userId, cleanUser, plano, new Date(dataVencimento), 'ativa', pagamentoId || '']);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir assinatura no PostgreSQL:', e.message);
        }

        const index = this.assinaturas.findIndex(a => a.userId === userId || (username && a.username?.toLowerCase() === cleanUser.toLowerCase()));
        if (index >= 0) {
            this.assinaturas[index] = assinatura;
        } else {
            this.assinaturas.push(assinatura);
        }

        this.saveAssinaturas();
        console.log(`✅ Nova assinatura criada: ${cleanUser} - Plano: ${plano}`);
        return assinatura;
    }

    async gerarTokenVitalicio(nomeIdentificador = 'Parente / Convidado', criadoPor = 'admin') {
        const randomPart = Math.random().toString(36).substring(2, 8);
        const timePart = Date.now().toString(36);
        const token = `bf_vit_${randomPart}${timePart}`;

        if (!this.acessosVitalicios) this.acessosVitalicios = [];

        const novoAcesso = {
            token,
            nome: nomeIdentificador.trim(),
            criadoPor,
            dataCriacao: new Date().toISOString(),
            status: 'ativo'
        };

        try {
            await db.query(`
                INSERT INTO stremio_tokens (token, username, tipo, ativo, created_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (token) DO NOTHING
            `, [token, nomeIdentificador.trim(), 'vitalicio', true]);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir token no PostgreSQL:', e.message);
        }

        this.acessosVitalicios.push(novoAcesso);
        this.saveAssinaturas();

        console.log(`🔑 Novo Acesso Vitalício Stremio gerado: "${nomeIdentificador}" [Token: ${token}]`);
        return novoAcesso;
    }

    async autorizarUsernameVitalicio(usernameInput, criadoPor = 'admin') {
        const cleanUser = usernameInput.toString().replace(/^@/, '').trim();
        if (!cleanUser) return null;

        const dummyId = Date.now();
        const assinatura = {
            id: dummyId,
            userId: dummyId,
            username: cleanUser,
            plano: 'vitalicio',
            dataInicio: new Date().toISOString(),
            dataVencimento: '2099-12-31T23:59:59.999Z',
            status: 'ativa',
            criadoPor
        };

        try {
            await db.query(`
                INSERT INTO assinaturas (user_id, username, plano, data_inicio, data_fim, status, created_at)
                VALUES ($1, $2, $3, NOW(), $4, $5, NOW())
                ON CONFLICT (user_id) DO UPDATE SET
                    username = EXCLUDED.username,
                    plano = EXCLUDED.plano,
                    data_fim = EXCLUDED.data_fim,
                    status = EXCLUDED.status
            `, [dummyId, cleanUser, 'vitalicio', new Date('2099-12-31T23:59:59.999Z'), 'ativa']);
        } catch (e) {
            console.warn('⚠️ Erro ao persistir assinatura vitalícia no PostgreSQL:', e.message);
        }

        const index = this.assinaturas.findIndex(a => a.username?.toLowerCase() === cleanUser.toLowerCase());
        if (index >= 0) {
            this.assinaturas[index].status = 'ativa';
            this.assinaturas[index].plano = 'vitalicio';
            this.assinaturas[index].dataVencimento = '2099-12-31T23:59:59.999Z';
        } else {
            this.assinaturas.push(assinatura);
        }

        this.saveAssinaturas();
        console.log(`👑 Acesso Vitalício concedido ao @${cleanUser}!`);
        return assinatura;
    }

    verificarAcessoStremio(tokenOuUser) {
        if (!tokenOuUser) return { authorized: false, reason: 'Token não fornecido' };

        const str = tokenOuUser.toString().trim().replace(/^@/, '');

        // 1. Admin permanente
        if (str === config.ADMIN_ID.toString() || str === 'admin' || str === 'bf_admin') {
            return { authorized: true, user: 'Administrador BrasilFlix', plano: 'vitalicio' };
        }

        // 2. Token vitalício registrado
        if (this.acessosVitalicios && Array.isArray(this.acessosVitalicios)) {
            const tokenFound = this.acessosVitalicios.find(t => t.token === str && t.status === 'ativo');
            if (tokenFound) {
                return { authorized: true, user: tokenFound.nome, plano: 'vitalicio' };
            }
        }

        // 3. Assinatura ativa por username ou userId
        const assinatura = this.assinaturas.find(a => 
            (a.userId?.toString() === str || a.username?.toLowerCase() === str.toLowerCase()) && 
            a.status === 'ativa'
        );

        if (assinatura) {
            const agora = new Date();
            const vencimento = new Date(assinatura.dataVencimento);
            if (agora <= vencimento) {
                return { authorized: true, user: assinatura.username, plano: assinatura.plano };
            } else {
                assinatura.status = 'vencida';
                this.saveAssinaturas();
                return { authorized: false, reason: 'Assinatura vencida' };
            }
        }

        return { authorized: false, reason: 'Usuário ou token não encontrado' };
    }

    listarAcessosVitalicios() {
        const tokens = (this.acessosVitalicios || []).filter(t => t.status === 'ativo');
        const usernames = (this.assinaturas || []).filter(a => a.plano === 'vitalicio' && a.status === 'ativa');
        return { tokens, usernames };
    }

    async revogarAcessoVitalicio(identificador) {
        const str = identificador.toString().trim().replace(/^@/, '');
        let revogado = false;

        if (this.acessosVitalicios) {
            const t = this.acessosVitalicios.find(item => item.token === str || item.nome?.toLowerCase() === str.toLowerCase());
            if (t) {
                t.status = 'revogado';
                revogado = true;
                try {
                    await db.query(`UPDATE stremio_tokens SET ativo = false WHERE token = $1`, [t.token]);
                } catch (e) {}
            }
        }

        const a = this.assinaturas.find(item => item.username?.toLowerCase() === str.toLowerCase() || item.userId?.toString() === str);
        if (a && a.plano === 'vitalicio') {
            a.status = 'cancelada';
            revogado = true;
            try {
                await db.query(`UPDATE assinaturas SET status = 'cancelada' WHERE user_id = $1`, [a.userId]);
            } catch (e) {}
        }

        if (revogado) this.saveAssinaturas();
        return revogado;
    }

    async criarPagamento(userId, username, plano) {
        try {
            const preco = this.getPrecoPlano(plano);
            const dataVencimento = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            
            const paymentData = {
                transaction_amount: preco,
                description: `BrasilFlix - Plano ${plano.toUpperCase()} (${username || 'Usuário'})`,
                payment_method_id: 'pix',
                payer: {
                    email: `user_${userId}@brasilflix.com.br`,
                    first_name: username || 'Cliente',
                    last_name: 'BrasilFlix'
                },
                notification_url: `https://brasilflix.kapsu.com.br/webhook`,
                external_reference: `assinatura_${userId}_${plano}`
            };

            const response = await mercadopago.payment.create(paymentData);
            console.log('✅ Pagamento PIX criado com sucesso:', response.body.id);
            
            return {
                id: response.body.id,
                init_point: `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${response.body.id}`,
                qr_code: response.body.point_of_interaction?.transaction_data?.qr_code || null,
                qr_code_base64: response.body.point_of_interaction?.transaction_data?.qr_code_base64 || null,
                preco,
                plano,
                dataVencimento,
                paymentId: response.body.id,
                status: response.body.status
            };
        } catch (error) {
            console.error('❌ Erro ao criar pagamento:', error);
            throw error;
        }
    }

    getPrecoPlano(plano) {
        const precos = {
            'mensal': 14.90,
            'trimestral': 34.90,
            'semestral': 59.90,
            'vitalicio': 89.90,
            'anual': 99.90
        };
        return precos[plano] || 14.90;
    }

    async criarPagamentoWeb({ nome, email, plano = 'mensal', telegramUser = '' }) {
        try {
            const preco = this.getPrecoPlano(plano);
            const cleanUser = (nome || telegramUser || 'Cliente').replace(/^@/, '').trim();
            const cleanEmail = email || `cliente_${Date.now()}@brasilflix.com.br`;
            const randomRef = Math.random().toString(36).substring(2, 7);
            const externalRef = `web_${encodeURIComponent(cleanUser)}_${plano}_${randomRef}`;

            const paymentData = {
                transaction_amount: preco,
                description: `BrasilFlix VIP - Plano ${plano.toUpperCase()} (${cleanUser})`,
                payment_method_id: 'pix',
                payer: {
                    email: cleanEmail,
                    first_name: cleanUser,
                    last_name: 'BrasilFlix'
                },
                notification_url: `https://brasilflix.kapsu.com.br/webhook`,
                external_reference: externalRef
            };

            const response = await mercadopago.payment.create(paymentData);
            console.log('✅ Pagamento PIX Web criado com sucesso:', response.body.id);

            return {
                success: true,
                paymentId: response.body.id,
                qr_code: response.body.point_of_interaction?.transaction_data?.qr_code || null,
                qr_code_base64: response.body.point_of_interaction?.transaction_data?.qr_code_base64 || null,
                init_point: response.body.init_point || `https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=${response.body.id}`,
                preco,
                plano,
                status: response.body.status
            };
        } catch (error) {
            console.error('❌ Erro ao criar pagamento Web:', error);
            throw error;
        }
    }

    async criarAssinaturaRecorrenteWeb({ nome, email, plano = 'mensal', telegramUser = '' }) {
        try {
            const preco = this.getPrecoPlano(plano);
            const cleanUser = (nome || telegramUser || 'Cliente').replace(/^@/, '').trim();
            const cleanEmail = email || `cliente_${Date.now()}@brasilflix.com.br`;
            const randomRef = Math.random().toString(36).substring(2, 7);
            const externalRef = `sub_${encodeURIComponent(cleanUser)}_${plano}_${randomRef}`;

            const preapprovalData = {
                payer_email: cleanEmail,
                back_url: 'https://brasilflix.kapsu.com.br/assinar?status=aprovado',
                reason: `BrasilFlix VIP - Assinatura Mensal Automática (${cleanUser})`,
                external_reference: externalRef,
                auto_recurring: {
                    frequency: 1,
                    frequency_type: 'months',
                    transaction_amount: preco,
                    currency_id: 'BRL'
                }
            };

            const response = await mercadopago.preapproval.create(preapprovalData);
            console.log('✅ Assinatura Recorrente Automática Mercado Pago criada:', response.body.id);

            return {
                success: true,
                subscriptionId: response.body.id,
                init_point: response.body.init_point,
                preco,
                plano,
                status: response.body.status
            };
        } catch (error) {
            console.error('❌ Erro ao criar assinatura recorrente Mercado Pago:', error);
            return this.criarCheckoutProWeb({ nome, email, plano, telegramUser });
        }
    }

    async criarCheckoutProWeb({ nome, email, plano = 'mensal', telegramUser = '' }) {
        try {
            const preco = this.getPrecoPlano(plano);
            const cleanUser = (nome || telegramUser || 'Cliente').replace(/^@/, '').trim();
            const cleanEmail = email || `cliente_${Date.now()}@brasilflix.com.br`;
            const randomRef = Math.random().toString(36).substring(2, 7);
            const externalRef = `web_${encodeURIComponent(cleanUser)}_${plano}_${randomRef}`;

            const preferenceData = {
                items: [
                    {
                        title: `BrasilFlix VIP - Plano ${plano.toUpperCase()} (${cleanUser})`,
                        unit_price: preco,
                        quantity: 1,
                        currency_id: 'BRL',
                        description: 'Acesso VIP Ilimitado ao Catálogo Oficial BrasilFlix em 1080p'
                    }
                ],
                payer: {
                    name: cleanUser,
                    email: cleanEmail
                },
                back_urls: {
                    success: 'https://brasilflix.kapsu.com.br/assinar?status=aprovado',
                    failure: 'https://brasilflix.kapsu.com.br/assinar?status=falha',
                    pending: 'https://brasilflix.kapsu.com.br/assinar?status=pendente'
                },
                auto_return: 'approved',
                notification_url: 'https://brasilflix.kapsu.com.br/webhook',
                external_reference: externalRef
            };

            const response = await mercadopago.preferences.create(preferenceData);
            console.log('✅ Checkout Pro Mercado Pago criado com sucesso:', response.body.id);

            return {
                success: true,
                preferenceId: response.body.id,
                init_point: response.body.init_point,
                preco,
                plano
            };
        } catch (error) {
            console.error('❌ Erro ao criar Checkout Pro:', error);
            throw error;
        }
    }

    async processarPagamento(paymentId) {
        try {
            const payment = await mercadopago.payment.get(paymentId);
            
            if (payment.body.status === 'approved') {
                const externalRef = payment.body.external_reference || '';
                const parts = externalRef.split('_');
                const tipo = parts[0]; // 'assinatura' ou 'web'

                let username = 'Cliente VIP';
                let plano = 'mensal';
                let userId = Date.now();

                if (tipo === 'assinatura') {
                    userId = parseInt(parts[1], 10) || Date.now();
                    plano = parts[2] || 'mensal';
                    username = `Usuário_${userId}`;
                } else if (tipo === 'web') {
                    username = decodeURIComponent(parts[1] || 'Cliente Web');
                    plano = parts[2] || 'mensal';
                }

                // Cria ou renova assinatura
                const assinatura = await this.criarAssinatura(
                    userId, 
                    username, 
                    plano,
                    paymentId
                );

                // Gera também um Token Stremio VIP automático para o cliente
                const token = `bf_${require('crypto').randomBytes(12).toString('hex')}`;
                await db.query(`
                    INSERT INTO stremio_tokens (token, username, tipo, ativo)
                    VALUES ($1, $2, $3, true)
                    ON CONFLICT DO NOTHING
                `, [token, username, plano]);

                await this.loadAssinaturas();

                console.log(`✅ Pagamento Aprovado e Token Stremio Gerado: ${username} [Plano: ${plano}, Token: ${token}]`);
                return { success: true, token, assinatura, payment: payment.body };
            }

            return { success: false, status: payment.body.status, payment: payment.body };
        } catch (error) {
            console.error('❌ Erro ao processar pagamento:', error);
            return { success: false, error: error.message };
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONTROLE DE LIMITE GRÁTIS NO STREMIO E SITE (1 Filme + 2 Episódios / Mês)
    // ─────────────────────────────────────────────────────────────────────────

    async verificarOuRegistrarConsumoGratis(identificador, tipo = 'filme') {
        const auth = this.verificarAcessoStremio(identificador);
        if (auth.authorized) {
            return { permitido: true, isVip: true, restanteFilmes: 999, restanteEpisodios: 999 };
        }

        const d = new Date();
        const mesAno = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const cleanId = String(identificador || 'public').trim();

        let registro = null;
        try {
            const res = await db.query(
                `SELECT * FROM consumo_gratis WHERE identificador = $1 AND mes_ano = $2`,
                [cleanId, mesAno]
            );
            if (res.rows.length > 0) {
                registro = res.rows[0];
            } else {
                const insRes = await db.query(
                    `INSERT INTO consumo_gratis (identificador, mes_ano, filmes_assistidos, episodios_assistidos, created_at, updated_at)
                     VALUES ($1, $2, 0, 0, NOW(), NOW())
                     RETURNING *`,
                    [cleanId, mesAno]
                );
                registro = insRes.rows[0];
            }
        } catch (e) {
            console.warn('⚠️ Erro ao consultar consumo_gratis:', e.message);
            return { permitido: true, isVip: false, restanteFilmes: 1, restanteEpisodios: 2 };
        }

        const limiteFilmes = 1;
        const limiteEps = 2;
        const filmesAssistidos = Number(registro?.filmes_assistidos || 0);
        const epsAssistidos = Number(registro?.episodios_assistidos || 0);

        if (tipo === 'filme') {
            if (filmesAssistidos >= limiteFilmes) {
                return {
                    permitido: false,
                    isVip: false,
                    motivo: 'Você atingiu o limite gratuito mensal de 1 filme. Assine o VIP para acesso ilimitado!',
                    filmesAssistidos,
                    episodiosAssistidos: epsAssistidos,
                    restanteFilmes: 0,
                    restanteEpisodios: Math.max(0, limiteEps - epsAssistidos)
                };
            }
        } else {
            if (epsAssistidos >= limiteEps) {
                return {
                    permitido: false,
                    isVip: false,
                    motivo: 'Você atingiu o limite gratuito mensal de 2 episódios de séries. Assine o VIP para maratonar!',
                    filmesAssistidos,
                    episodiosAssistidos: epsAssistidos,
                    restanteFilmes: Math.max(0, limiteFilmes - filmesAssistidos),
                    restanteEpisodios: 0
                };
            }
        }

        return {
            permitido: true,
            isVip: false,
            filmesAssistidos,
            episodiosAssistidos: epsAssistidos,
            restanteFilmes: Math.max(0, limiteFilmes - filmesAssistidos),
            restanteEpisodios: Math.max(0, limiteEps - epsAssistidos)
        };
    }

    async registrarStreamConsumido(identificador, tipo = 'filme') {
        const auth = this.verificarAcessoStremio(identificador);
        if (auth.authorized) return;

        const d = new Date();
        const mesAno = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const cleanId = String(identificador || 'public').trim();

        try {
            if (tipo === 'filme') {
                await db.query(
                    `UPDATE consumo_gratis 
                     SET filmes_assistidos = filmes_assistidos + 1, updated_at = NOW() 
                     WHERE identificador = $1 AND mes_ano = $2`,
                    [cleanId, mesAno]
                );
            } else {
                await db.query(
                    `UPDATE consumo_gratis 
                     SET episodios_assistidos = episodios_assistidos + 1, updated_at = NOW() 
                     WHERE identificador = $1 AND mes_ano = $2`,
                    [cleanId, mesAno]
                );
            }
        } catch (e) {
            console.warn('⚠️ Erro ao registrar stream consumido:', e.message);
        }
    }
}

module.exports = AssinaturaManager;