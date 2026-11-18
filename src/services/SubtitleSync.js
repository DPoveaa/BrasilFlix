const SubtitlePipeline = require('./SubtitlePipeline');

class SubtitleSync {
    parseTimecodeToMs(tc) {
        return SubtitlePipeline.parseTimecodeToMs(tc);
    }

    formatMsToTimecode(totalMs) {
        return SubtitlePipeline.formatMsToTimecode(totalMs);
    }

    parseSrt(srtContent) {
        return SubtitlePipeline.parseSrt(srtContent);
    }

    buildSrt(cues) {
        return SubtitlePipeline.buildSrt(cues);
    }

    normalizeSrtFormat(srtContent) {
        const cues = SubtitlePipeline.parseSrt(srtContent);
        if (!cues || cues.length === 0) return srtContent;
        return SubtitlePipeline.buildSrt(cues);
    }

    async optimizeSubtitleFile(srtPath) {
        await SubtitlePipeline.validateAndFinalizeSubtitle(srtPath, 0);
        return srtPath;
    }

    async syncSubtitle(videoOrRefSrt, srtInputPath, srtOutputPath, options = {}) {
        const isRefSubtitle = typeof videoOrRefSrt === 'string' && (
            videoOrRefSrt.toLowerCase().endsWith('.srt') ||
            videoOrRefSrt.toLowerCase().endsWith('.vtt') ||
            videoOrRefSrt.toLowerCase().endsWith('.ass')
        );

        if (isRefSubtitle) {
            return SubtitlePipeline.alignSubtitle(options.videoPath || videoOrRefSrt, srtInputPath, srtOutputPath, {
                refSubPath: videoOrRefSrt,
                ...options
            });
        } else {
            return SubtitlePipeline.alignSubtitle(videoOrRefSrt, srtInputPath, srtOutputPath, options);
        }
    }

    async validateSynchronizedSubtitle(srtPath, proof = null) {
        if (!proof || !['dialogue_content', 'asr_word_timestamps'].includes(proof.method)) return false;
        try {
            const fs = require('fs-extra');
            if (!fs.existsSync(srtPath)) return false;
            const content = fs.readFileSync(srtPath, 'utf8');
            const cues = SubtitlePipeline.parseSrt(content);
            return cues && cues.length >= 20 && await SubtitlePipeline.isBrazilianPortugueseSubtitle(content);
        } catch (e) {
            return false;
        }
    }

    async refineWithAudioSpeech(videoPath, srtPath) {
        const outPath = `${srtPath}.synced.srt`;
        const res = await SubtitlePipeline.alignSubtitle(videoPath, srtPath, outPath);
        if (res) {
            const fs = require('fs-extra');
            await fs.move(outPath, srtPath, { overwrite: true });
        }
    }

    async processSubtitlePipeline(videoPath, metadata = {}) {
        return SubtitlePipeline.processSubtitlePipeline(videoPath, metadata);
    }
}

module.exports = new SubtitleSync();
