require('dotenv').config();

const BOT_TOKEN = '8219341889:AAEVIszKAi1AWXaho1XyOo8FF6LaCokaCBg';
const STORAGE_GROUP_ID = -4888890416;
const ADMIN_ID = 1689537480;
const NOTIFICATION_GROUP_ID = -1002503446860;
const MercadoPago_TOKEN = "APP_USR-354078817982238-080818-1943e3838d85afaf2e144d30728d5030-215094442";

module.exports = {
    BOT_TOKEN,
    STORAGE_GROUP_ID,
    ADMIN_ID,
    NOTIFICATION_GROUP_ID,
    MercadoPago_TOKEN,
    DATA_DIR: './data',
    BACKUP_DIR: './data/backups',
    DOWNLOAD_DIR: './downloads/temp',
    PEDIDOS_FILE: './data/pedidos.json',
    CATALOGO_FILE: './data/catalogo.json',
    ASSINATURAS_FILE: './data/assinaturas.json',
    QUEUE_FILE: './data/queue.json',
    // TMDB (The Movie Database)
    TMDB_API_KEY: process.env.TMDB_API_KEY || 'a0482b47152e4749ca18f230f04224dd',
    TMDB_LANGUAGE: 'pt-BR',
    // Configurações de Download e Vídeo
    VIDEO_MAX_SIZE_BYTES: 2 * 1024 * 1024 * 1024, // 2GB (Telegram limit)
    TARGET_RESOLUTION: '1080p',
    ALLOW_CINEMA_CAM: true, // Aceita versões gravadas de cinema quando forem dubladas em português
    AUTO_UPGRADE_CAM: true,  // Atualiza automaticamente para 1080p WEB-DL assim que sair versão oficial
    // AutoFeeder settings
    AUTO_FEEDER_ENABLED: true,
    AUTO_FEEDER_INTERVAL_HOURS: 4,
    // Configurações do Mercado Pago
    mercadopago: {
        access_token: MercadoPago_TOKEN,
        public_key: "APP_USR-898300be-472a-4d34-9287-bd7a340df20b",
        environment: 'production'
    }
}; 