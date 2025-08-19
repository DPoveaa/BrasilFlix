class FileUtils {
    static isValidFileType(file) {
        if (!file) return false;

        const validTypes = [
            'video/mp4', 'video/avi', 'video/mkv', 'video/mov', 'video/wmv',
            'audio/mp3', 'audio/wav', 'audio/flac', 'audio/aac',
            'application/pdf', 'text/plain'
        ];

        return validTypes.includes(file.mime_type);
    }

    static getFileSizeInMB(fileSize) {
        return (fileSize / (1024 * 1024)).toFixed(2);
    }

    static formatFileInfo(file) {
        const size = this.getFileSizeInMB(file.file_size);
        const name = file.file_name || 'Arquivo sem nome';
        
        return {
            name,
            size: `${size} MB`,
            type: file.mime_type,
            id: file.file_id
        };
    }

    static sanitizeFileName(fileName) {
        return fileName
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 100);
    }

    static extractFileExtension(fileName) {
        const match = fileName.match(/\.([^.]+)$/);
        return match ? match[1].toLowerCase() : '';
    }

    static isVideoFile(file) {
        if (!file || !file.mime_type) return false;
        return file.mime_type.startsWith('video/');
    }

    static isAudioFile(file) {
        if (!file || !file.mime_type) return false;
        return file.mime_type.startsWith('audio/');
    }

    static isDocumentFile(file) {
        if (!file || !file.mime_type) return false;
        return file.mime_type.startsWith('application/') || file.mime_type.startsWith('text/');
    }

    static validateFileSize(fileSize, maxSizeMB = 2000) {
        const sizeInMB = fileSize / (1024 * 1024);
        return sizeInMB <= maxSizeMB;
    }

    static getFileTypeIcon(file) {
        if (this.isVideoFile(file)) return '🎬';
        if (this.isAudioFile(file)) return '🎵';
        if (this.isDocumentFile(file)) return '📄';
        return '📁';
    }
}

module.exports = FileUtils; 