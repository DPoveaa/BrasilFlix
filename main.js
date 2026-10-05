#!/usr/bin/env node

/**
 * BrasilFlix Bot - Ponto de entrada principal
 * Execução com suporte a PostgreSQL e variáveis de ambiente .env
 */

const path = require('path');
require('dotenv').config();

// ⚡ LogBroadcaster: deve ser instalado ANTES de qualquer outro require
// para interceptar todos os console.log/warn/error desde o boot.
const logBroadcaster = require('./src/utils/LogBroadcaster');
logBroadcaster.install();

// Configurar o caminho para os módulos
process.env.NODE_PATH = path.join(__dirname, 'src');

const db = require('./src/database/db');
const { BrasilFlixBot } = require('./src/index.js');

let botInstance = null;

async function bootstrap() {
    console.log('🚀 Iniciando BrasilFlix Engine...');
    
    // 1. Instancia o Bot e os serviços
    botInstance = new BrasilFlixBot();

    // 2. Sobe o site IMEDIATAMENTE no ar, depois carrega banco, catálogo e inicia esteira
    await botInstance.init();

    // 3. Inicializa polling e handlers do bot
    botInstance.start();

    console.log('✅ BrasilFlix 100% online com PostgreSQL e MTProto!');
}

bootstrap().catch(err => {
    console.error('❌ Falha crítica na inicialização do BrasilFlix:', err);
    process.exit(1);
});

// Tratamento de sinais para graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Recebido SIGINT, encerrando bot...');
    if (botInstance && botInstance.bot) {
        botInstance.bot.stopPolling();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Recebido SIGTERM, encerrando bot...');
    if (botInstance && botInstance.bot) {
        botInstance.bot.stopPolling();
    }
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    if (error?.message?.includes('User-Initiated Abort') || 
        error?.code === 'ERR_DATA_CHANNEL' ||
        error?.message === 'TIMEOUT' ||
        error?.stack?.includes('updates.js') ||
        error?.stack?.includes('telegram/client')) {
        return;
    }
    console.error('⚠️ Aviso - Exceção assíncrona capturada:', error?.message || error);
});

process.on('unhandledRejection', (reason, promise) => {
    if (reason?.message === 'TIMEOUT' || 
        reason?.code === 'ERR_DATA_CHANNEL' ||
        reason?.message?.includes('User-Initiated Abort') ||
        reason?.message?.includes('Close called') ||
        reason?.stack?.includes('updates.js') || 
        reason?.stack?.includes('telegram/client') ||
        reason?.stack?.includes('webrtc-polyfill')) {
        return;
    }
    console.error('⚠️ Aviso - Rejeição assíncrona capturada:', reason?.message || reason);
});