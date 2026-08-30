const fs = require('fs');
const path = require('path');

const indexPath = path.resolve('public/index.html');
let html = fs.readFileSync(indexPath, 'utf8');

// 1. UPDATE WATCH PARTY CHANGE_MEDIA HANDLING
const oldChangeMediaHook = "} else if (data.type === 'change_media') {";
const oldChangeMediaIdx = html.indexOf(oldChangeMediaHook);

if (oldChangeMediaIdx !== -1) {
    const nextCaseIdx = html.indexOf("} else if (data.type === 'member_ready_state_changed') {", oldChangeMediaIdx);
    if (nextCaseIdx !== -1) {
        const newChangeMediaCode = `} else if (data.type === 'change_media') {
                if (String(data.userId) !== String(partyMyUserId) && data.mediaInfo) {
                    partyRoomData = { ...partyRoomData, mediaInfo: data.mediaInfo };
                    const m = data.mediaInfo;
                    const isRemembered = localStorage.getItem('bf_audio_pref_remembered') === 'true';
                    const hasBoth = m.hasDub !== false && m.hasLeg !== false;

                    const startPlaybackForMember = (chosenAudio) => {
                        isSyncingFromRemote = true;
                        if (m.type === 'serie') {
                            openPlaybackPageForEpisode(m.id, m.season || 1, m.episode || 1, chosenAudio, true);
                        } else {
                            openPlaybackPageForMovie(m.id, chosenAudio, true);
                        }
                        isSyncingFromRemote = false;
                        showToast('🎬 O anfitrião iniciou: ' + (m.title || 'nova mídia'), 'info');
                    };

                    if (hasBoth && !isRemembered) {
                        openAudioSelectModal({ nome: m.title }, (audio) => {
                            startPlaybackForMember(audio);
                        });
                    } else {
                        const defaultAudio = isRemembered ? getUserPreferredAudio() : (m.audio || 'dublado');
                        startPlaybackForMember(defaultAudio);
                    }
                }
            `;
        html = html.substring(0, oldChangeMediaIdx) + newChangeMediaCode + html.substring(nextCaseIdx);
        console.log('Watch Party change_media updated to use dedicated playback pages!');
    }
}

// 2. UPDATE triggerPlayNextEpisodeNow
const oldTriggerPlayNext = `function triggerPlayNextEpisodeNow() {
            clearTimeout(autoPlayNextTimer);
            hideAutoPlayNextCard();
            if (currentPlayingMedia && currentPlayingMedia.type === 'serie') {
                const nextInfo = getNextEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
                if (nextInfo) {
                    openPlaybackPageForEpisode(nextInfo.serieId, nextInfo.seasonNum, nextInfo.epNum, nextInfo.audio);
                    showToast(\`🎬 Iniciando T\${nextInfo.seasonNum}E\${nextInfo.epNum} - \${nextInfo.epNome}...\`, 'success');
                } else {
                    showToast('🎉 Você chegou ao fim dos episódios disponíveis desta temporada!', 'info');
                }
            }
        }`;

const oldTriggerIdx = html.indexOf('function triggerPlayNextEpisodeNow() {');
if (oldTriggerIdx !== -1) {
    const endTriggerIdx = html.indexOf('function cancelAutoPlayNextEpisode() {', oldTriggerIdx);
    if (endTriggerIdx !== -1) {
        html = html.substring(0, oldTriggerIdx) + oldTriggerPlayNext + '\n\n        ' + html.substring(endTriggerIdx);
        console.log('triggerPlayNextEpisodeNow updated!');
    }
}

// 3. UPDATE playPreviousEpisodeDirectly
const oldPrevEp = `function playPreviousEpisodeDirectly() {
            if (currentPlayingMedia && currentPlayingMedia.type === 'serie') {
                const prevInfo = getPreviousEpisodeInfo(currentPlayingMedia.id, currentPlayingMedia.season, currentPlayingMedia.episode);
                if (prevInfo) {
                    openPlaybackPageForEpisode(prevInfo.serieId, prevInfo.seasonNum, prevInfo.epNum, prevInfo.audio);
                    showToast(\`⏮️ Voltando para T\${prevInfo.seasonNum}E\${prevInfo.epNum}...\`, 'info');
                }
            }
        }`;

const oldPrevIdx = html.indexOf('function playPreviousEpisodeDirectly() {');
if (oldPrevIdx !== -1) {
    const endPrevIdx = html.indexOf('let currentPlayingMedia = null;', oldPrevIdx);
    if (endPrevIdx !== -1) {
        html = html.substring(0, oldPrevIdx) + oldPrevEp + '\n\n        ' + html.substring(endPrevIdx);
        console.log('playPreviousEpisodeDirectly updated!');
    }
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('Watch Party & navigation update complete, total lines:', html.split('\n').length);
