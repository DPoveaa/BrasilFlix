const express = require('express');
const config = require('./config');
const AssinaturaManager = require('./src/managers/AssinaturaManager');

const app = express();
const assinaturaManager = new AssinaturaManager();

app.use(express.json());

// Webhook do Mercado Pago
app.post('/webhook', async (req, res) => {
    try {
        const { data } = req.body;
        
        if (data && data.id) {
            const resultado = await assinaturaManager.processarPagamento(data.id);
            
            if (resultado.success) {
                console.log('✅ Pagamento processado com sucesso:', resultado.assinatura.username);
                
                // Notificar no grupo de notificações
                const mensagem = `🎉 *Nova Assinatura Ativada!*\n\n` +
                               `👤 *Usuário:* ${resultado.assinatura.username}\n` +
                               `💳 *Plano:* ${resultado.assinatura.plano}\n` +
                               `💰 *Valor:* R$ ${assinaturaManager.getPrecoPlano(resultado.assinatura.plano)}\n` +
                               `📅 *Vencimento:* ${new Date(resultado.assinatura.dataVencimento).toLocaleDateString('pt-BR')}\n` +
                               `🆔 *ID:* ${resultado.assinatura.id}`;
                
                console.log('📢 Notificação:', mensagem);
                console.log('📢 Notificação enviada para o grupo');
            } else {
                console.log('❌ Pagamento não aprovado:', data.id);
            }
        }
        
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ Erro no webhook:', error);
        res.status(500).send('Erro interno');
    }
});

// Rota de teste
app.get('/test', (req, res) => {
    res.json({ status: 'Webhook funcionando!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Webhook rodando na porta ${PORT}`);
    console.log(`🔗 URL: http://localhost:${PORT}/webhook`);
});

module.exports = app; 