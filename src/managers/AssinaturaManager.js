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

    setBot(bot) {
        this.bot = bot;
    }

    setupMercadoPago() {
        if (config.mercadopago?.access_token) {
            mercadopago.configure({
                access_token: config.mercadopago.access_token
            });
        }
    }

    async notificarGrupoPagamento(dados = {}) {
        if (!this.bot) return;

        const groupId = config.NOTIFICATION_GROUP_ID || -1002503446860;
        
        try {
            const cliente = dados.cliente || dados.username || 'Cliente';
            const userId = dados.userId || dados.id || 'N/A';
            const metodo = dados.metodo || 'PIX';
            const valor = typeof dados.valor === 'number' ? dados.valor : (parseFloat(dados.valor) || (dados.plano === 'anual' ? 89.90 : (dados.plano === 'trimestral' ? 24.90 : 9.99)));
            
            let planoTexto = '1 meses';
            if (dados.plano === 'trimestral') planoTexto = '3 meses';
            else if (dados.plano === 'semestral') planoTexto = '6 meses';
            else if (dados.plano === 'anual') planoTexto = '12 meses';
            else if (dados.plano === 'vitalicio') planoTexto = 'Vitalício';
            else if (dados.plano === 'mensal') planoTexto = '1 meses';
            else if (dados.plano) planoTexto = String(dados.plano);

            const agora = new Date();
            const dataHora = agora.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

            const notifText = 
`💰 *Novo Pagamento Confirmado!*

👤 *Cliente:* ${cliente}
🆔 *ID:* \`${userId}\`
💳 *Método:* ${metodo}
💵 *Valor:* R$ ${valor.toFixed(2)}
⏱️ *Plano:* ${planoTexto}
🕒 *Data:* ${dataHora}`;

            await this.bot.sendMessage(groupId, notifText, { parse_mode: 'Markdown' });
            console.log(`📢 [NOTIFICAÇÃO PAGAMENTO] Enviada para o grupo ${groupId} (Cliente: ${cliente}, Valor: R$ ${valor.toFixed(2)})`);
        } catch (e) {
            console.warn('⚠️ Erro ao enviar notificação de pagamento para o grupo:', e.message);
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

                // Notifica grupo de pagamentos com formatação oficial
                const paymentAmount = payment.body.transaction_amount || (plano === 'anual' ? 89.90 : (plano === 'trimestral' ? 24.90 : 9.99));
                const paymentMethod = payment.body.payment_method_id ? payment.body.payment_method_id.toUpperCase() : 'PIX';
                this.notificarGrupoPagamento({
                    cliente: username,
                    userId: userId,
                    metodo: paymentMethod,
                    valor: paymentAmount,
                    plano: plano
                }).catch(() => {});

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

    verificarAssinatura(userId) {
        const numId = Number(userId);
        const assinatura = this.assinaturas.find(a => 
            (Number(a.userId) === numId || a.id === numId) && a.status === 'ativa'
        );

        if (!assinatura) return false;

        const agora = new Date();
        const vencimento = new Date(assinatura.dataVencimento);

        if (agora > vencimento) {
            assinatura.status = 'vencida';
            this.saveAssinaturas();
            return false;
        }

        return true;
    }

    getAssinatura(userId) {
        const numId = Number(userId);
        return this.assinaturas.find(a => Number(a.userId) === numId || a.id === numId);
    }

    async cancelarAssinatura(userId) {
        const assinatura = this.getAssinatura(userId);
        if (assinatura) {
            assinatura.status = 'cancelada';
            try {
                await db.query(`UPDATE assinaturas SET status = 'cancelada' WHERE user_id = $1`, [userId]);
            } catch (e) {}
            this.saveAssinaturas();
            return true;
        }
        return false;
    }

    getAssinaturasVencendo(dias = 7) {
        const agora = new Date();
        const limite = new Date();
        limite.setDate(limite.getDate() + dias);

        return this.assinaturas.filter(assinatura => {
            if (assinatura.status !== 'ativa') return false;
            const vencimento = new Date(assinatura.dataVencimento);
            return vencimento <= limite && vencimento >= agora;
        });
    }

    getAssinaturasVencidas() {
        const agora = new Date();
        return this.assinaturas.filter(assinatura => {
            if (assinatura.status !== 'ativa') return false;
            const vencimento = new Date(assinatura.dataVencimento);
            return vencimento < agora;
        });
    }

    formatarAssinatura(assinatura) {
        const vencimento = new Date(assinatura.dataVencimento);
        const agora = new Date();
        const diasRestantes = Math.ceil((vencimento - agora) / (1000 * 60 * 60 * 24));

        let status = '✅ Ativa';
        if (assinatura.status === 'vencida') {
            status = '❌ Vencida';
        } else if (assinatura.status === 'cancelada') {
            status = '🚫 Cancelada';
        } else if (diasRestantes <= 3) {
            status = '⚠️ Vencendo';
        }

        return {
            status,
            diasRestantes: diasRestantes > 0 ? diasRestantes : 0,
            vencimento: vencimento.toLocaleDateString('pt-BR'),
            plano: assinatura.plano
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CONTROLE DE LIMITE GRÁTIS NO STREMIO E SITE (2 Filmes + 4 Episódios / Semana)
    // ─────────────────────────────────────────────────────────────────────────

    getSemanaAtualInfo() {
        const now = new Date();
        const day = now.getDay(); // 0 = Dom, 1 = Seg, ...
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        const monday = new Date(now);
        monday.setDate(now.getDate() + diffToMonday);
        monday.setHours(0, 0, 0, 0);

        const year = monday.getFullYear();
        const month = String(monday.getMonth() + 1).padStart(2, '0');
        const date = String(monday.getDate()).padStart(2, '0');
        const semanaKey = `${year}-W${month}${date}`; // ex: 2026-W0824

        const nextMonday = new Date(monday);
        nextMonday.setDate(monday.getDate() + 7);
        const renovacaoStr = `${String(nextMonday.getDate()).padStart(2, '0')}/${String(nextMonday.getMonth() + 1).padStart(2, '0')}`;
        const renovacaoCompleta = `${String(nextMonday.getDate()).padStart(2, '0')}/${String(nextMonday.getMonth() + 1).padStart(2, '0')}/${nextMonday.getFullYear()}`;

        return { semanaKey, renovacaoStr, renovacaoCompleta, nextMonday };
    }

    normalizeMediaKey(mediaKey, tipo = 'filme') {
        if (!mediaKey) return `${tipo}_${Date.now()}`;
        let str = String(mediaKey).trim().toLowerCase();
        // Remove sufixos de idioma para que Dublado e Legendado compartilhem o mesmo ID
        str = str.replace(/[_:](dublado|legendado|dub|leg)$/i, '');
        // Normaliza formatos de séries para que serie_id_s1_e2 e serie_id_1_2 sejam idênticos
        str = str.replace(/_s(\d+)_e(\d+)/i, '_$1_$2');
        return str;
    }

    async verificarOuRegistrarConsumoGratis(identificador, tipo = 'filme', mediaKey = null) {
        const auth = this.verificarAcessoStremio(identificador);
        const { semanaKey, renovacaoStr, renovacaoCompleta } = this.getSemanaAtualInfo();

        if (auth.authorized) {
            return {
                permitido: true,
                isVip: true,
                restanteFilmes: 999,
                restanteEpisodios: 999,
                limiteFilmes: 999,
                limiteEpisodios: 999,
                renovacaoEm: 'Ilimitado',
                renovacaoCompleta: 'Ilimitado'
            };
        }

        // Modelo Gratuito Aberto com Anúncios Discretos (Sem trava de limite semanal)
        return {
            permitido: true,
            isVip: false,
            restanteFilmes: 999,
            restanteEpisodios: 999,
            limiteFilmes: 999,
            limiteEpisodios: 999,
            renovacaoEm: 'Ilimitado (Com Anúncios)',
            renovacaoCompleta: 'Ilimitado'
        };

        const cleanId = String(identificador || 'public').trim();
        const limiteFilmes = 2;
        const limiteEps = 4;

        let registro = null;
        try {
            const res = await db.query(
                `SELECT * FROM consumo_gratis WHERE identificador = $1 AND mes_ano = $2`,
                [cleanId, semanaKey]
            );
            if (res.rows.length > 0) {
                registro = res.rows[0];
            } else {
                const insRes = await db.query(
                    `INSERT INTO consumo_gratis (identificador, mes_ano, filmes_assistidos, episodios_assistidos, itens_consumidos, created_at, updated_at)
                     VALUES ($1, $2, 0, 0, '{}', NOW(), NOW())
                     ON CONFLICT (identificador, mes_ano) DO UPDATE SET updated_at = NOW()
                     RETURNING *`,
                    [cleanId, semanaKey]
                );
                registro = insRes.rows[0];
            }
        } catch (e) {
            console.warn('⚠️ Erro ao consultar consumo_gratis:', e.message);
            return {
                permitido: true,
                isVip: false,
                limiteFilmes: 2,
                limiteEpisodios: 4,
                restanteFilmes: 2,
                restanteEpisodios: 4,
                renovacaoEm: renovacaoStr,
                renovacaoCompleta: renovacaoCompleta
            };
        }

        let itens = registro?.itens_consumidos || {};
        if (typeof itens === 'string') {
            try { itens = JSON.parse(itens); } catch (e) { itens = {}; }
        }

        const filmesAssistidosList = Array.isArray(itens.filmes) ? itens.filmes : [];
        const epsAssistidosList = Array.isArray(itens.episodios) ? itens.episodios : [];

        const normalizedFilmes = filmesAssistidosList.map(k => this.normalizeMediaKey(k, 'filme'));
        const normalizedEps = epsAssistidosList.map(k => this.normalizeMediaKey(k, 'serie'));

        // Se já consumiu essa mídia específica na semana (mesmo filme ou episódio, Dublado ou Legendado), permite assistir/bufferizar sem gastar crédito novo
        if (mediaKey) {
            const strKey = this.normalizeMediaKey(mediaKey, tipo);
            if (tipo === 'filme' && normalizedFilmes.includes(strKey)) {
                return {
                    permitido: true,
                    isVip: false,
                    filmesAssistidos: normalizedFilmes.length,
                    episodiosAssistidos: normalizedEps.length,
                    limiteFilmes,
                    limiteEpisodios: limiteEps,
                    restanteFilmes: Math.max(0, limiteFilmes - normalizedFilmes.length),
                    restanteEpisodios: Math.max(0, limiteEps - normalizedEps.length),
                    renovacaoEm: renovacaoStr,
                    renovacaoCompleta
                };
            }
            if (tipo === 'serie' && normalizedEps.includes(strKey)) {
                return {
                    permitido: true,
                    isVip: false,
                    filmesAssistidos: normalizedFilmes.length,
                    episodiosAssistidos: normalizedEps.length,
                    limiteFilmes,
                    limiteEpisodios: limiteEps,
                    restanteFilmes: Math.max(0, limiteFilmes - normalizedFilmes.length),
                    restanteEpisodios: Math.max(0, limiteEps - normalizedEps.length),
                    renovacaoEm: renovacaoStr,
                    renovacaoCompleta
                };
            }
        }

        const filmesCount = normalizedFilmes.length;
        const epsCount = normalizedEps.length;

        if (tipo === 'filme') {
            if (filmesCount >= limiteFilmes) {
                return {
                    permitido: false,
                    isVip: false,
                    motivo: `Você atingiu o limite gratuito semanal de 2 filmes. Seus créditos renovam em ${renovacaoStr}. Assine o VIP para acesso ilimitado!`,
                    filmesAssistidos: filmesCount,
                    episodiosAssistidos: epsCount,
                    limiteFilmes,
                    limiteEpisodios: limiteEps,
                    restanteFilmes: 0,
                    restanteEpisodios: Math.max(0, limiteEps - epsCount),
                    renovacaoEm: renovacaoStr,
                    renovacaoCompleta
                };
            }
        } else {
            if (epsCount >= limiteEps) {
                return {
                    permitido: false,
                    isVip: false,
                    motivo: `Você atingiu o limite gratuito semanal de 4 episódios. Seus créditos renovam em ${renovacaoStr}. Assine o VIP para maratonar!`,
                    filmesAssistidos: filmesCount,
                    episodiosAssistidos: epsCount,
                    limiteFilmes,
                    limiteEpisodios: limiteEps,
                    restanteFilmes: Math.max(0, limiteFilmes - filmesCount),
                    restanteEpisodios: 0,
                    renovacaoEm: renovacaoStr,
                    renovacaoCompleta
                };
            }
        }

        return {
            permitido: true,
            isVip: false,
            filmesAssistidos: filmesCount,
            episodiosAssistidos: epsCount,
            limiteFilmes,
            limiteEpisodios: limiteEps,
            restanteFilmes: Math.max(0, limiteFilmes - filmesCount),
            restanteEpisodios: Math.max(0, limiteEps - epsCount),
            renovacaoEm: renovacaoStr,
            renovacaoCompleta
        };
    }

    async registrarStreamConsumido(identificador, tipo = 'filme', mediaKey = null) {
        const auth = this.verificarAcessoStremio(identificador);
        if (auth.authorized) return;

        const { semanaKey } = this.getSemanaAtualInfo();
        const cleanId = String(identificador || 'public').trim();
        const strMediaKey = this.normalizeMediaKey(mediaKey, tipo);

        try {
            const res = await db.query(
                `SELECT * FROM consumo_gratis WHERE identificador = $1 AND mes_ano = $2`,
                [cleanId, semanaKey]
            );

            let itens = {};
            if (res.rows.length > 0 && res.rows[0].itens_consumidos) {
                itens = res.rows[0].itens_consumidos;
                if (typeof itens === 'string') {
                    try { itens = JSON.parse(itens); } catch (e) { itens = {}; }
                }
            }

            if (!Array.isArray(itens.filmes)) itens.filmes = [];
            if (!Array.isArray(itens.episodios)) itens.episodios = [];

            // Normaliza lista existente
            itens.filmes = [...new Set(itens.filmes.map(k => this.normalizeMediaKey(k, 'filme')))];
            itens.episodios = [...new Set(itens.episodios.map(k => this.normalizeMediaKey(k, 'serie')))];

            if (tipo === 'filme') {
                if (!itens.filmes.includes(strMediaKey)) {
                    itens.filmes.push(strMediaKey);
                }
            } else {
                if (!itens.episodios.includes(strMediaKey)) {
                    itens.episodios.push(strMediaKey);
                }
            }

            const filmesCount = itens.filmes.length;
            const epsCount = itens.episodios.length;

            await db.query(
                `INSERT INTO consumo_gratis (identificador, mes_ano, filmes_assistidos, episodios_assistidos, itens_consumidos, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
                 ON CONFLICT (identificador, mes_ano) 
                 DO UPDATE SET filmes_assistidos = $3, episodios_assistidos = $4, itens_consumidos = $5, updated_at = NOW()`,
                [cleanId, semanaKey, filmesCount, epsCount, JSON.stringify(itens)]
            );
        } catch (e) {
            console.warn('⚠️ Erro ao registrar stream consumido:', e.message);
        }
    }
}

module.exports = AssinaturaManager;