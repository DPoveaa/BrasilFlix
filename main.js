#!/usr/bin/env node

/**
 * BrasilFlix Bot - Ponto de entrada principal
 * Execução com suporte a PostgreSQL e variáveis de ambiente .env
 */

const path = require('path');
require('dotenv').config();

// Configurar o caminho para os módulos
process.env.NODE_PATH = path.join(__dirname, 'src');

const db = require('./src/database/db');
const { BrasilFlixBot } = require('./src/index.js');

let botInstance = null;

async function bootstrap() {
    console.log('🚀 Iniciando BrasilFlix Engine...');
    
    // 1. Inicializa o banco de dados PostgreSQL
    await db.initDb();

    // 2. Inicializa o Bot e todos os serviços
    botInstance = new BrasilFlixBot();
    await botInstance.init();
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
    if (error?.message?.includes('User-Initiated Abort') || error?.code === 'ERR_DATA_CHANNEL') {
        return;
    }
    console.error('⚠️ Aviso - Exceção assíncrona capturada:', error?.message || error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Aviso - Rejeição assíncrona capturada:', reason?.message || reason);
});