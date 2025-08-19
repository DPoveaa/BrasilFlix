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
                this.assinaturas = fs.readJsonSync(this.assinaturasFile);
            } else {
                this.assinaturas = [];
                this.saveAssinaturas();
            }
        } catch (error) {
            console.error('❌ Erro ao carregar assinaturas:', error);
            this.assinaturas = [];
        }
    }

    saveAssinaturas() {
        try {
            fs.writeJsonSync(this.assinaturasFile, this.assinaturas, { spaces: 2 });
        } catch (error) {
            console.error('❌ Erro ao salvar assinaturas:', error);
        }
    }



    async criarAssinatura(userId, username, plano = 'mensal') {
        const assinatura = {
            id: Date.now(),
            userId,
            username: username || 'Usuário',
            plano,
            dataInicio: new Date().toISOString(),
            dataVencimento: this.calcularVencimento(plano),
            status: 'ativa',
            pagamentos: []
        };

        this.assinaturas.push(assinatura);
        this.saveAssinaturas();
        
        console.log(`✅ Nova assinatura criada: ${username} - Plano: ${plano}`);
        return assinatura;
    }

    calcularVencimento(plano) {
        const data = new Date();
        if (plano === 'mensal') {
            data.setMonth(data.getMonth() + 1);
        } else if (plano === 'trimestral') {
            data.setMonth(data.getMonth() + 3);
        } else if (plano === 'anual') {
            data.setFullYear(data.getFullYear() + 1);
        }
        return data.toISOString();
    }

    async criarPagamento(userId, username, plano) {
        try {
            const preco = this.getPrecoPlano(plano);
            const dataVencimento = this.calcularVencimento(plano);
            
            console.log(`🔧 Criando pagamento para usuário ${userId} - Plano: ${plano} - Valor: R$ ${preco}`);
            
            // Criar pagamento PIX diretamente
            const payment = {
                transaction_amount: preco,
                description: `BrasilFlix - Plano ${plano}`,
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
            
            // Log detalhado da resposta
            console.log('📋 Dados da resposta:', {
                id: response.body.id,
                status: response.body.status,
                has_point_of_interaction: !!response.body.point_of_interaction,
                has_transaction_data: !!response.body.point_of_interaction?.transaction_data,
                has_qr_code: !!response.body.point_of_interaction?.transaction_data?.qr_code,
                has_qr_code_base64: !!response.body.point_of_interaction?.transaction_data?.qr_code_base64
            });
            
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
            
            console.log('📱 QR Code disponível:', !!result.qr_code);
            console.log('🖼️ QR Code Base64 disponível:', !!result.qr_code_base64);
            
            return result;
        } catch (error) {
            console.error('❌ Erro ao criar pagamento:', error);
            console.error('❌ Detalhes do erro:', {
                message: error.message,
                status: error.status,
                response: error.response?.data
            });
            throw error;
        }
    }

    getPrecoPlano(plano) {
        const precos = {
            'mensal': 19.90,
            'trimestral': 49.90,
            'anual': 159.90
        };
        return precos[plano] || 19.90;
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