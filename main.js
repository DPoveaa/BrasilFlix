#!/usr/bin/env node

/**
 * BrasilFlix Bot - Ponto de entrada principal
 * 
 * Este arquivo é o ponto de entrada principal para o bot,
 * ideal para execução via PM2 ou linha de comando
 */

const path = require('path');

// Configurar o caminho para os módulos
process.env.NODE_PATH = path.join(__dirname, 'src');

// Importar e executar o bot
try {
    console.log('🚀 Iniciando BrasilFlix Bot...');
    
    // Importar a classe principal do bot
    const { BrasilFlixBot } = require('./src/index.js');
    
    // Criar e iniciar a instância do bot
    const bot = new BrasilFlixBot();
    bot.start();
    
    console.log('✅ Bot iniciado com sucesso!');
    
    // Tratamento de sinais para graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Recebido SIGINT, encerrando bot...');
        if (bot && bot.bot) {
            bot.bot.stopPolling();
        }
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('\n🛑 Recebido SIGTERM, encerrando bot...');
        if (bot && bot.bot) {
            bot.bot.stopPolling();
        }
        process.exit(0);
    });
    
    process.on('uncaughtException', (error) => {
        console.error('⚠️ Aviso - Exceção assíncrona capturada:', error?.message || error);
    });
    
    process.on('unhandledRejection', (reason, promise) => {
        console.error('⚠️ Aviso - Rejeição assíncrona capturada:', reason?.message || reason);
    });
    
} catch (error) {
    console.error('❌ Erro ao iniciar o bot:', error);
    process.exit(1);
} 