function inspectDialogueCoverage(cues, speech) {
    const intervals = [];
    for (const cue of cues.filter(cue => cue.text?.trim()).sort((a, b) => a.startMs - b.startMs)) {
        const last = intervals.at(-1);
        if (last && cue.startMs <= last[1]) last[1] = Math.max(last[1], cue.endMs);
        else intervals.push([cue.startMs, cue.endMs]);
    }
    const missing = [];
    let cursor = 0;
    let checked = 0;
    for (const cue of [...speech].sort((a, b) => a.startMs - b.startMs)) {
        const words = cue.text.match(/\p{L}+(?:['’]\p{L}+)*/gu) || [];
        const hasDialogue = words.length >= 4 || (words.length >= 2 && /[.!?。！？][”"’']?$/u.test(cue.text.trim())) ||
            (cue.text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length >= 4;
        if (!hasDialogue || cue.endMs - cue.startMs < 800 || /[♪♫]/u.test(cue.text)) continue;
        checked++;
        // Check the core of the spoken line. Leave room for editorial cue boundaries
        // and cues that intentionally share one subtitle across consecutive lines.
        const trim = Math.min(400, (cue.endMs - cue.startMs) * .20);
        const start = cue.startMs + trim;
        const end = cue.endMs - trim;
        while (cursor < intervals.length && intervals[cursor][1] < start - 350) cursor++;
        const covered = intervals[cursor]?.[0] <= end + 350;
        if (!covered) missing.push({ startMs: cue.startMs, endMs: cue.endMs });
    }
    return { checked, missing };
}

function fillDialogueGaps(base, donor, gaps) {
    const cues = [...base];
    for (const cue of donor) {
        if (!gaps.some(gap => Math.min(gap.endMs, cue.endMs) - Math.max(gap.startMs, cue.startMs) >= 500)) continue;
        if (cues.some(placed => placed.startMs < cue.endMs && placed.endMs > cue.startMs)) continue;
        cues.push(cue);
    }
    return cues.sort((a, b) => a.startMs - b.startMs);
}

function sharesTranscriptionTiming(cues, speech) {
    const timings = new Set(speech.map(cue => `${cue.startMs}:${cue.endMs}`));
    return cues.length > 20 && cues.filter(cue => timings.has(`${cue.startMs}:${cue.endMs}`)).length / cues.length >= .85;
}

module.exports = { inspectDialogueCoverage, fillDialogueGaps, sharesTranscriptionTiming };
