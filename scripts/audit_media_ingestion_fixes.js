/**
 * Smoke tests for audio selection, duration gates and hardsub font sizing.
 * Run: node scripts/audit_media_ingestion_fixes.js
 */
const assert = require('assert');
const VideoProcessor = require('../src/services/VideoProcessor');

function stream(lang, title = '', disposition = null) {
    return { language: lang, title, disposition, codec: 'aac', channels: 2 };
}

function section(title) {
    console.log(`\n=== ${title} ===`);
}

section('1. Original language resolution (never assume English)');
assert.strictEqual(VideoProcessor.resolveOriginalLanguage({ idiomaOriginal: 'ko' }, []), 'ko');
assert.strictEqual(VideoProcessor.resolveOriginalLanguage({ isAnime: true }, []), 'ja');
assert.strictEqual(VideoProcessor.resolveOriginalLanguage({ isDorama: true }, []), 'ko');
assert.strictEqual(
    VideoProcessor.resolveOriginalLanguage({}, [stream('eng'), stream('jpn')]),
    'ja',
    'dual JA/EN without metadata must prefer Japanese'
);
assert.strictEqual(
    VideoProcessor.resolveOriginalLanguage({}, [stream('eng'), stream('kor')]),
    'ko',
    'dual KO/EN without metadata must prefer Korean'
);
assert.strictEqual(
    VideoProcessor.resolveOriginalLanguage({}, [stream('eng')]),
    'en',
    'English-only may resolve to en'
);
console.log('OK');

section('2. Squid Game / Round 6 — legendado must pick Korean, not English');
{
    const streams = [stream('eng', 'english'), stream('kor', 'korean')];
    const idx = VideoProcessor.detectTargetAudioIndex(streams, {
        isLegendado: true, isDublado: false, idiomaOriginal: 'ko', nome: 'Round 6'
    }, 'Squid.Game.S01.2160p');
    assert.strictEqual(idx, 1);
    const v = VideoProcessor.validateSelectedAudioTrack(streams[idx], {
        isLegendado: true, isDublado: false, idiomaOriginal: 'ko'
    }, streams);
    assert.strictEqual(v.ok, true);
    console.log('OK idx=', idx);
}

section('3. Blue Lock dual-audio — legendado must pick Japanese');
{
    const streams = [stream('eng'), stream('jpn', 'japanese')];
    const idx = VideoProcessor.detectTargetAudioIndex(streams, {
        isLegendado: true, isDublado: false, isAnime: true, nome: 'Blue Lock'
    }, '[Judas] Blue Lock Dual-Audio');
    assert.strictEqual(idx, 1);
    console.log('OK idx=', idx);
}

section('4. Reacher — legendado correctly keeps English original');
{
    const streams = [stream('eng', 'english'), stream('por', 'português')];
    const idx = VideoProcessor.detectTargetAudioIndex(streams, {
        isLegendado: true, isDublado: false, idiomaOriginal: 'en', nome: 'Reacher'
    }, 'Reacher.S01');
    assert.strictEqual(idx, 0);
    console.log('OK idx=', idx);
}

section('5. Dublado — PT-BR audio, ignore English');
{
    const streams = [stream('eng'), stream('por', 'dublado')];
    const idx = VideoProcessor.detectTargetAudioIndex(streams, {
        isLegendado: false, isDublado: true, idiomaOriginal: 'ko'
    }, 'Round.6.Dublado');
    assert.strictEqual(idx, 1);
    console.log('OK idx=', idx);
}

section('5b. Dual eng+und (HODL-like) — legendado must pick und, not eng');
{
    const streams = [stream('eng', 'english'), stream('und', '')];
    const idx = VideoProcessor.detectTargetAudioIndex(streams, {
        isLegendado: true, isDublado: false, idiomaOriginal: 'ko', isDorama: true, nome: 'Round 6'
    }, 'Squid.Game.S02.Complete.1080p.WEBRip.10bit.Dual.DDP5.1.x265-HODL');
    assert.strictEqual(idx, 1, 'eng+und must pick und as original');
    console.log('OK idx=', idx);
}

section('6. Duration gates — HotD 13min must fail (~60min expected)');
{
    const minSec = VideoProcessor.computeMinAcceptableDurationSec({ type: 'serie', expectedMin: 60 });
    assert.ok(minSec > 13 * 60, `minSec=${minSec} should reject 13min`);
    assert.ok(780 < minSec);
    console.log('OK minSec=', minSec, `(${(minSec / 60).toFixed(1)} min)`);
}

section('7. Duration gates — anime ~24min still allows reasonable floor');
{
    const minSec = VideoProcessor.computeMinAcceptableDurationSec({ type: 'serie', expectedMin: 24 });
    assert.ok(minSec >= 600);
    assert.ok(minSec <= 24 * 60 * 0.7);
    console.log('OK minSec=', minSec);
}

section('8. Hardsub ASS PlayRes scaling');
(async () => {
    const fs = require('fs-extra');
    const path = require('path');
    const os = require('os');
    const srt = path.join(os.tmpdir(), `bf_sub_test_${Date.now()}.srt`);
    await fs.writeFile(srt, `1\n00:00:01,000 --> 00:00:03,000\nTeste de legenda PT-BR\n`);
    const assPath = await VideoProcessor.buildHardsubAssFromSrt(srt, 1920, 1080);
    const ass = await fs.readFile(assPath, 'utf8');
    assert.ok(ass.includes('PlayResX: 1920'));
    assert.ok(ass.includes('PlayResY: 1080'));
    const fontMatch = ass.match(/Style: Default,Arial,(\d+)/);
    assert.ok(fontMatch);
    const fontSize = parseInt(fontMatch[1], 10);
    assert.ok(fontSize >= 28 && fontSize <= 52, `fontSize=${fontSize}`);
    // Must NOT use the old broken FontSize=22 against default PlayRes 288
    assert.ok(!ass.includes('FontSize=22'));
    await fs.remove(srt).catch(() => {});
    await fs.remove(assPath).catch(() => {});
    console.log('OK fontSize=', fontSize, 'with PlayRes 1920x1080');

    console.log('\n✅ All media ingestion fix audits passed.');
})().catch((e) => {
    console.error('❌ Audit failed:', e);
    process.exit(1);
});
