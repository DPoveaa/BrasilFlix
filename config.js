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
    PUBLIC_RELEASE_GROUP_ID: process.env.PUBLIC_RELEASE_GROUP_ID || '-1003935080262',

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

    // Web & Stremio & Cloudflare Edge Stream
    STREMIO_PORT: parseInt(process.env.STREMIO_PORT || '7000', 10),
    SERVER_HOST: process.env.SERVER_HOST || 'brasilflix.kapsu.com.br',
    CLOUDFLARE_STREAM_URL: process.env.CLOUDFLARE_STREAM_URL || '',

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
    AUTO_FEEDER_INTERVAL_HOURS: parseInt(process.env.AUTO_FEEDER_INTERVAL_HOURS || '4', 10),
    ENABLE_ANIME_DIRECT: process.env.ENABLE_ANIME_DIRECT === 'true', // Desativado por padrão para evitar streams com marca d'água (ex: animesonline)

    // Concorrência Paralela Desacoplada (Esteira Contínua)
    MAX_CONCURRENT_JOBS: parseInt(process.env.MAX_CONCURRENT_JOBS || '13', 10),
    MAX_CONCURRENT_DOWNLOADS: parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || '6', 10),
    MAX_CONCURRENT_TRANSCODES: parseInt(process.env.MAX_CONCURRENT_TRANSCODES || '4', 10),
    MAX_CONCURRENT_UPLOADS: parseInt(process.env.MAX_CONCURRENT_UPLOADS || '3', 10),
    PERFORMANCE_MAX_DOWNLOADS: 6,
    PERFORMANCE_MAX_TRANSCODES: 4,
    PERFORMANCE_MAX_UPLOADS: 3,
    MAX_TEMP_DISK_GB: parseInt(process.env.MAX_TEMP_DISK_GB || '100', 10),
    MIN_DOWNLOAD_SPEED_MB: parseFloat(process.env.MIN_DOWNLOAD_SPEED_MB || '1.5'),
    FFMPEG_THREADS_PER_JOB: parseInt(process.env.FFMPEG_THREADS_PER_JOB || '5', 10),

    // Otimizações de Rede, QoS e Proteção de Roteador Residencial
    MAX_TORRENT_PEER_CONNECTIONS: parseInt(process.env.MAX_TORRENT_PEER_CONNECTIONS || '35', 10),
    MAX_TORRENT_UPLOAD_LIMIT_KB: parseInt(process.env.MAX_TORRENT_UPLOAD_LIMIT_KB || '250', 10),
    TELEGRAM_UPLOAD_MAX_SOCKETS: parseInt(process.env.TELEGRAM_UPLOAD_MAX_SOCKETS || '4', 10),
    ECO_DOWNLOAD_LIMIT_MB: parseFloat(process.env.ECO_DOWNLOAD_LIMIT_MB || '3.0'),
    ECO_UPLOAD_LIMIT_KB: parseInt(process.env.ECO_UPLOAD_LIMIT_KB || '30', 10),
    ECO_TELEGRAM_SOCKETS: parseInt(process.env.ECO_TELEGRAM_SOCKETS || '1', 10)
};