const fs = require('fs-extra');
const config = require('../../config');
const mercadopago = require('mercadopago');

class AssinaturaManager {
    constructor() {
        this.assinaturasFile = config.ASSINATURAS_FILE;
        this.ensureDataDirectory();
        this.loadAssinaturas();
        this.setupMercadoPago();
    }

    setupMercadoPago() {
        mercadopago.configure({
            access_token: config.MercadoPago_TOKEN
        });
    }

    ensureDataDirectory() {
        fs.ensureDirSync(config.DATA_DIR);
    }

    loadAssinaturas() {
        try {
            if (fs.existsSync(this.assinaturasFile)) {
                const data = fs.readJsonSync(this.assinaturasFile);
                if (Array.isArray(data)) {
                    this.assinaturas = data;
                    this.acessosVitalicios = [];
                } else {
                    this.assinaturas = data.assinaturas || [];
                    this.acessosVitalicios = data.acessosVitalicios || [];
                }
            } else {
                this.assinaturas = [];
                this.acessosVitalicios = [];
                this.saveAssinaturas();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar assinaturas:', error);
            this.assinaturas = [];
            this.acessosVitalicios = [];
        }
    }

    saveAssinaturas() {
        try {
            const dataToSave = {
                assinaturas: this.assinaturas,
                acessosVitalicios: this.acessosVitalicios || []
            };
            fs.writeJsonSync(this.assinaturasFile, dataToSave, { spaces: 2 });
        } catch (error) {
            console.error('❌ Erro ao salvar assinaturas:', error);
        }
    }

    async criarAssinatura(userId, username, plano = 'mensal') {
        const assinatura = {
            id: Date.now(),
            userId,
            username: (username || 'Usuário').replace(/^@/, ''),
            plano,
            dataInicio: new Date().toISOString(),
            dataVencimento: this.calcularVencimento(plano),
            status: 'ativa',
            pagamentos: []
        };

        const index = this.assinaturas.findIndex(a => a.userId === userId || (username && a.username?.toLowerCase() === username.toLowerCase()));
        if (index >= 0) {
            this.assinaturas[index] = assinatura;
        } else {
            this.assinaturas.push(assinatura);
        }

        this.saveAssinaturas();
        console.log(`✅ Nova assinatura criada: ${username} - Plano: ${plano}`);
        return assinatura;
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

    gerarTokenVitalicio(nomeIdentificador = 'Parente / Convidado', criadoPor = 'admin') {
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

        this.acessosVitalicios.push(novoAcesso);
        this.saveAssinaturas();

        console.log(`🔑 Novo Acesso Vitalício Stremio gerado: "${nomeIdentificador}" [Token: ${token}]`);
        return novoAcesso;
    }

    autorizarUsernameVitalicio(usernameInput, criadoPor = 'admin') {
        const cleanUser = usernameInput.toString().replace(/^@/, '').trim();
        if (!cleanUser) return null;

        const dummyId = `vit_${Date.now()}`;
        const assinatura = {
            id: Date.now(),
            userId: dummyId,
            username: cleanUser,
            plano: 'vitalicio',
            dataInicio: new Date().toISOString(),
            dataVencimento: '2099-12-31T23:59:59.999Z',
            status: 'ativa',
            criadoPor,
            pagamentos: []
        };

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

    revogarAcessoVitalicio(identificador) {
        const str = identificador.toString().trim().replace(/^@/, '');
        let revogado = false;

        if (this.acessosVitalicios) {
            const t = this.acessosVitalicios.find(item => item.token === str || item.nome.toLowerCase() === str.toLowerCase());
            if (t) {
                t.status = 'revogado';
                revogado = true;
            }
        }

        const a = this.assinaturas.find(item => item.username?.toLowerCase() === str.toLowerCase() || item.userId?.toString() === str);
        if (a && a.plano === 'vitalicio') {
            a.status = 'cancelada';
            revogado = true;
        }

        if (revogado) this.saveAssinaturas();
        return revogado;
    }

    async criarPagamento(userId, username, plano) {
        try {
            const preco = this.getPrecoPlano(plano);
            const dataVencimento = this.calcularVencimento(plano);
            
            console.log(`🔧 Criando pagamento para usuário ${userId} - Plano: ${plano} - Valor: R$ ${preco}`);
            
            // Criar pagamento PIX diretamente
            const payment = {
                transaction_amount: preco,
                description: `BrasilFlix VIP - Plano ${plano.toUpperCase()}`,
                payment_method_id: 'pix',
                payer: {
                    email: `user${userId}@brasilflix.com`,
                    first_name: username,
                    last_name: 'BrasilFlix'
                },
                external_reference: `assinatura_${userId}_${plano}_${Date.now()}`
            };

            console.log('📤 Enviando pagamento PIX para Mercado Pago...');
            const response = await mercadopago.payment.save(payment);
            console.log('✅ Pagamento PIX criado com sucesso:', response.body.id);
            
            const result = {
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
            
            return result;
        } catch (error) {
            console.error('❌ Erro ao criar pagamento:', error);
            throw error;
        }
    }

    getPrecoPlano(plano) {
        const precos = {
            'mensal': 15.00,
            'trimestral': 38.00, // R$ 12,66/mês (15% OFF)
            'semestral': 69.00,  // R$ 11,50/mês (23% OFF)
            'anual': 120.00      // R$ 10,00/mês (33% OFF)
        };
        return precos[plano] || 15.00;
    }

    verificarAssinatura(userId) {
        const assinatura = this.assinaturas.find(a => 
            a.userId === userId && a.status === 'ativa'
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
        return this.assinaturas.find(a => a.userId === userId);
    }

    renovarAssinatura(userId, plano = 'mensal') {
        const assinatura = this.getAssinatura(userId);
        if (assinatura) {
            assinatura.plano = plano;
            assinatura.dataVencimento = this.calcularVencimento(plano);
            assinatura.status = 'ativa';
            this.saveAssinaturas();
            return assinatura;
        }
        return null;
    }

    cancelarAssinatura(userId) {
        const assinatura = this.getAssinatura(userId);
        if (assinatura) {
            assinatura.status = 'cancelada';
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

    async processarPagamento(paymentId) {
        try {
            const payment = await mercadopago.payment.get(paymentId);
            
            if (payment.body.status === 'approved') {
                const externalRef = payment.body.external_reference;
                const [tipo, userId, plano] = externalRef.split('_');
                
                if (tipo === 'assinatura') {
                    // Criar assinatura diretamente quando o pagamento for aprovado
                    const assinatura = await this.criarAssinatura(
                        parseInt(userId), 
                        `Usuário_${userId}`, 
                        plano
                    );
                    
                    console.log(`✅ Assinatura ativada após pagamento: ${assinatura.username} - Plano: ${assinatura.plano}`);

                    return {
                        success: true,
                        assinatura,
                        payment: payment.body
                    };
                }
            }

            return {
                success: false,
                payment: payment.body
            };
        } catch (error) {
            console.error('❌ Erro ao processar pagamento:', error);
            return { success: false, error };
        }
    }
}

module.exports = AssinaturaManager; 