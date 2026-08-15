require('dotenv').config();

module.exports = {
    // Database Configuration
    DB_HOST: process.env.DB_HOST || 'localhost',
    DB_PORT: parseInt(process.env.DB_PORT || '5432', 10),
    DB_NAME: process.env.DB_NAME || 'brasilflix',
    DB_USER: process.env.DB_USER || 'postgres',
    DB_PASSWORD: process.env.DB_PASSWORD || 'admin',

    // Telegram Bot
    BOT_TOKEN: process.env.BOT_TOKEN || '8219341889:AAEVIszKAi1AWXaho1XyOo8FF6LaCokaCBg',
    STORAGE_GROUP_ID: parseInt(process.env.STORAGE_GROUP_ID || '-4888890416', 10),
    ADMIN_ID: parseInt(process.env.ADMIN_ID || '1689537480', 10),
    NOTIFICATION_GROUP_ID: parseInt(process.env.NOTIFICATION_GROUP_ID || '-1002503446860', 10),

    // Autenticação JWT Admin
    JWT_SECRET: process.env.JWT_SECRET || 'bf_jwt_sec_8f93a02bc91e77d5421a980e_prod_safe',

    // Mercado Pago
    MERCADOPAGO_TOKEN: process.env.MERCADOPAGO_TOKEN || 'APP_USR-354078817982238-080818-1943e3838d85afaf2e144d30728d5030-215094442',
    MERCADOPAGO_PUBLIC_KEY: process.env.MERCADOPAGO_PUBLIC_KEY || 'APP_USR-898300be-472a-4d34-9287-bd7a340df20b',
    mercadopago: {
        access_token: process.env.MERCADOPAGO_TOKEN || 'APP_USR-354078817982238-080818-1943e3838d85afaf2e144d30728d5030-215094442',
        public_key: process.env.MERCADOPAGO_PUBLIC_KEY || 'APP_USR-898300be-472a-4d34-9287-bd7a340df20b',
        environment: 'production'
    },

    // TMDB (The Movie Database)
    TMDB_API_KEY: process.env.TMDB_API_KEY || 'a0482b47152e4749ca18f230f04224dd',
    TMDB_LANGUAGE: process.env.TMDB_LANGUAGE || 'pt-BR',

    // Telegram MTProto Premium Session (Uploads até 4GB)
    TELEGRAM_API_ID: parseInt(process.env.TELEGRAM_API_ID || '2040', 10),
    TELEGRAM_API_HASH: process.env.TELEGRAM_API_HASH || 'b18441a1ff607e10a989891a5462e627',
    TELEGRAM_SESSION: process.env.TELEGRAM_SESSION || '',

    // Web & Stremio
    STREMIO_PORT: parseInt(process.env.STREMIO_PORT || '7000', 10),
    SERVER_HOST: process.env.SERVER_HOST || 'brasilflix.kapsu.com.br',

    // Diretórios Locais
    DATA_DIR: './data',
    BACKUP_DIR: './data/backups',
    DOWNLOAD_DIR: './downloads/temp',
    PEDIDOS_FILE: './data/pedidos.json',
    CATALOGO_FILE: './data/catalogo.json',
    ASSINATURAS_FILE: './data/assinaturas.json',
    QUEUE_FILE: './data/queue.json',

    // Configurações de Mídia & Automação
    VIDEO_MAX_SIZE_BYTES: Math.floor(3.95 * 1024 * 1024 * 1024),
    TARGET_RESOLUTION: process.env.TARGET_RESOLUTION || '1080p',
    ALLOW_CINEMA_CAM: process.env.ALLOW_CINEMA_CAM !== 'false',
    AUTO_UPGRADE_CAM: process.env.AUTO_UPGRADE_CAM !== 'false',
    AUTO_FEEDER_ENABLED: process.env.AUTO_FEEDER_ENABLED !== 'false',
    AUTO_FEEDER_INTERVAL_HOURS: parseInt(process.env.AUTO_FEEDER_INTERVAL_HOURS || '4', 10)
};