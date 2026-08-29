const fs = require('fs-extra');
const path = require('path');
const config = require('../../config');

class SettingsService {
    constructor() {
        this.settingsPath = path.resolve(__dirname, '../../data/settings.json');
        this.loadSettings();
    }

    loadSettings() {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const custom = fs.readJsonSync(this.settingsPath);
                // Aplica configurações salvas sobre o objeto config em memória
                Object.assign(config, custom);
            }
        } catch (e) {
            console.warn('⚠️ [SettingsService] Erro ao carregar custom settings:', e.message);
        }
    }

    getEditableSettings() {
        return {
            MAX_CONCURRENT_JOBS: config.MAX_CONCURRENT_JOBS ?? 10,
            MAX_CONCURRENT_DOWNLOADS: config.MAX_CONCURRENT_DOWNLOADS ?? 3,
            MAX_CONCURRENT_TRANSCODES: config.MAX_CONCURRENT_TRANSCODES ?? 2,
            MAX_CONCURRENT_UPLOADS: config.MAX_CONCURRENT_UPLOADS ?? 2,
            MAX_TORRENT_PEER_CONNECTIONS: config.MAX_TORRENT_PEER_CONNECTIONS ?? 35,
            MAX_TORRENT_UPLOAD_LIMIT_KB: config.MAX_TORRENT_UPLOAD_LIMIT_KB ?? 250,
            TELEGRAM_UPLOAD_MAX_SOCKETS: config.TELEGRAM_UPLOAD_MAX_SOCKETS ?? 4,
            ECO_DOWNLOAD_LIMIT_MB: config.ECO_DOWNLOAD_LIMIT_MB ?? 3.0,
            ECO_UPLOAD_LIMIT_KB: config.ECO_UPLOAD_LIMIT_KB ?? 30,
            ECO_TELEGRAM_SOCKETS: config.ECO_TELEGRAM_SOCKETS ?? 1,
            MAX_TEMP_DISK_GB: config.MAX_TEMP_DISK_GB ?? 100,
            MIN_DOWNLOAD_SPEED_MB: config.MIN_DOWNLOAD_SPEED_MB ?? 1.5,
            TARGET_RESOLUTION: config.TARGET_RESOLUTION ?? '1080p',
            ALLOW_CINEMA_CAM: config.ALLOW_CINEMA_CAM ?? true,
            AUTO_UPGRADE_CAM: config.AUTO_UPGRADE_CAM ?? true,
            AUTO_FEEDER_ENABLED: config.AUTO_FEEDER_ENABLED ?? true,
            AUTO_FEEDER_INTERVAL_HOURS: config.AUTO_FEEDER_INTERVAL_HOURS ?? 4,
            FFMPEG_THREADS_PER_JOB: config.FFMPEG_THREADS_PER_JOB ?? 6,
            SERVER_HOST: config.SERVER_HOST ?? 'brasilflix.kapsu.com.br'
        };
    }

    saveSettings(newSettings = {}) {
        try {
            const current = this.getEditableSettings();
            const toSave = {};

            // Tipagens e validações
            if (newSettings.MAX_CONCURRENT_JOBS !== undefined) toSave.MAX_CONCURRENT_JOBS = Math.max(1, parseInt(newSettings.MAX_CONCURRENT_JOBS, 10));
            if (newSettings.MAX_CONCURRENT_DOWNLOADS !== undefined) toSave.MAX_CONCURRENT_DOWNLOADS = Math.max(1, parseInt(newSettings.MAX_CONCURRENT_DOWNLOADS, 10));
            if (newSettings.MAX_CONCURRENT_TRANSCODES !== undefined) toSave.MAX_CONCURRENT_TRANSCODES = Math.max(1, parseInt(newSettings.MAX_CONCURRENT_TRANSCODES, 10));
            if (newSettings.MAX_CONCURRENT_UPLOADS !== undefined) toSave.MAX_CONCURRENT_UPLOADS = Math.max(1, parseInt(newSettings.MAX_CONCURRENT_UPLOADS, 10));
            if (newSettings.MAX_TORRENT_PEER_CONNECTIONS !== undefined) toSave.MAX_TORRENT_PEER_CONNECTIONS = Math.max(5, parseInt(newSettings.MAX_TORRENT_PEER_CONNECTIONS, 10));
            if (newSettings.MAX_TORRENT_UPLOAD_LIMIT_KB !== undefined) toSave.MAX_TORRENT_UPLOAD_LIMIT_KB = Math.max(0, parseInt(newSettings.MAX_TORRENT_UPLOAD_LIMIT_KB, 10));
            if (newSettings.TELEGRAM_UPLOAD_MAX_SOCKETS !== undefined) toSave.TELEGRAM_UPLOAD_MAX_SOCKETS = Math.min(8, Math.max(1, parseInt(newSettings.TELEGRAM_UPLOAD_MAX_SOCKETS, 10)));
            if (newSettings.ECO_DOWNLOAD_LIMIT_MB !== undefined) toSave.ECO_DOWNLOAD_LIMIT_MB = Math.max(0.5, parseFloat(newSettings.ECO_DOWNLOAD_LIMIT_MB) || 3.0);
            if (newSettings.ECO_UPLOAD_LIMIT_KB !== undefined) toSave.ECO_UPLOAD_LIMIT_KB = Math.max(0, parseInt(newSettings.ECO_UPLOAD_LIMIT_KB, 10));
            if (newSettings.ECO_TELEGRAM_SOCKETS !== undefined) toSave.ECO_TELEGRAM_SOCKETS = Math.min(4, Math.max(1, parseInt(newSettings.ECO_TELEGRAM_SOCKETS, 10)));
            if (newSettings.MAX_TEMP_DISK_GB !== undefined) toSave.MAX_TEMP_DISK_GB = Math.max(10, parseInt(newSettings.MAX_TEMP_DISK_GB, 10));
            if (newSettings.MIN_DOWNLOAD_SPEED_MB !== undefined) toSave.MIN_DOWNLOAD_SPEED_MB = parseFloat(newSettings.MIN_DOWNLOAD_SPEED_MB) || 1.5;
            if (newSettings.TARGET_RESOLUTION !== undefined) toSave.TARGET_RESOLUTION = String(newSettings.TARGET_RESOLUTION);
            if (newSettings.ALLOW_CINEMA_CAM !== undefined) toSave.ALLOW_CINEMA_CAM = Boolean(newSettings.ALLOW_CINEMA_CAM);
            if (newSettings.AUTO_UPGRADE_CAM !== undefined) toSave.AUTO_UPGRADE_CAM = Boolean(newSettings.AUTO_UPGRADE_CAM);
            if (newSettings.AUTO_FEEDER_ENABLED !== undefined) toSave.AUTO_FEEDER_ENABLED = Boolean(newSettings.AUTO_FEEDER_ENABLED);
            if (newSettings.AUTO_FEEDER_INTERVAL_HOURS !== undefined) toSave.AUTO_FEEDER_INTERVAL_HOURS = Math.max(1, parseInt(newSettings.AUTO_FEEDER_INTERVAL_HOURS, 10));
            if (newSettings.FFMPEG_THREADS_PER_JOB !== undefined) toSave.FFMPEG_THREADS_PER_JOB = Math.max(1, parseInt(newSettings.FFMPEG_THREADS_PER_JOB, 10));
            if (newSettings.SERVER_HOST !== undefined && newSettings.SERVER_HOST.trim()) toSave.SERVER_HOST = newSettings.SERVER_HOST.trim();


            const merged = { ...current, ...toSave };
            fs.ensureDirSync(path.dirname(this.settingsPath));
            fs.writeJsonSync(this.settingsPath, merged, { spaces: 2 });
            Object.assign(config, merged);
            console.log('⚙️ [SettingsService] Novas configurações aplicadas e persistidas:', merged);
            return merged;
        } catch (e) {
            console.error('❌ [SettingsService] Erro ao salvar configurações:', e.message);
            throw e;
        }
    }
}

module.exports = new SettingsService();
