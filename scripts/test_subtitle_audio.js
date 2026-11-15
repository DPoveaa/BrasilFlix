const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const axios = require('axios');
const translation = require('../src/services/SubtitleTranslationService');
const { matchesSpokenDialogue } = require('../src/services/SubtitleAudioService');
const videoProcessor = require('../src/services/VideoProcessor');

const time1 = '00:00:03,040 --> 00:00:04,000';
const time2 = '00:00:06,140 --> 00:00:08,200';
const cues = [
    { index: 1, timecode: time1, text: 'Good morning!' },
    { index: 2, timecode: time2, text: 'Good to see you here.' }
];

test('translation validates cue identity, preserving the timestamps from speech', async (t) => {
    t.mock.method(translation, 'getApiKey', () => 'unit-test-key');
    const response = (translated) => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify(translated) }] } }] } });
    const post = t.mock.method(axios, 'post', async () => response([
        { index: 2, text: 'Que bom ver você aqui.', timecode: 'invalid' },
        { index: 1, text: 'Bom dia!' }
    ]));
    const result = await translation.translateBatchWithGemini(cues);
    assert.deepEqual(result, [
        { ...cues[0], text: 'Bom dia!' },
        { ...cues[1], text: 'Que bom ver você aqui.' }
    ]);
    assert.equal(new URL(post.mock.calls[0].arguments[0]).search, '');

    post.mock.mockImplementation(async () => response([{ index: 1, text: 'Bom dia!' }]));
    await assert.rejects(translation.translateBatchWithGemini(cues, 2), /incompleto/);

    post.mock.mockImplementation(async () => response([
        { index: 1, text: 'Bom dia!' }, { index: 3, text: 'Que bom ver você aqui.' }
    ]));
    await assert.rejects(translation.translateBatchWithGemini(cues, 2), /identificação/);

    post.mock.mockImplementation(async () => response([
        { index: 1, text: 'Bom dia!' }, { index: 1, text: 'Que bom ver você aqui.' }
    ]));
    await assert.rejects(translation.translateBatchWithGemini(cues, 2), /repetido/);
});

test('translation fails the whole SRT on a provider error', async (t) => {
    t.mock.method(translation, 'isAvailable', () => true);
    t.mock.method(translation, 'translateBatchWithGemini', async () => {
        throw new Error('provedor indisponível');
    });
    await assert.rejects(translation.translateSrt(translation.buildSrt(cues)), /provedor indisponível/);
});

test('embedded subtitle must match dialogue and timing throughout the footage', () => {
    const series = (shiftLast = 0, wrongDialogue = false) => translation.buildSrt(
        Array.from({ length: 12 }, (_, index) => {
            const start = 2 + index * 4 + (index >= 9 ? shiftLast : 0);
            const format = (second) => `00:00:${String(second).padStart(2, '0')},000`;
            return {
                timecode: `${format(start)} --> ${format(start + 2)}`,
                text: wrongDialogue ? 'Exércitos marcharam pela floresta distante.' : 'Mamute procura rebanho no vale.'
            };
        })
    );
    const reference = series();
    assert.equal(matchesSpokenDialogue(series(), reference), true);
    assert.equal(matchesSpokenDialogue(series(2), reference), false);
    assert.equal(matchesSpokenDialogue(series(0, true), reference), false);
});

test('FFmpeg displays the subtitle only during the selected frames', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-render-test-'));
    let ass;
    try {
        const srt = path.join(workspace, 'test.srt');
        await fs.writeFile(srt, '1\n00:00:01,000 --> 00:00:02,000\nLegenda de teste.\n');
        ass = await videoProcessor.buildHardsubAssFromSrt(srt, 640, 360);
        const frameMd5 = execFileSync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=4:duration=3',
            '-vf', `ass='${videoProcessor.escapeFFmpegFilterPath(ass)}'`, '-f', 'framemd5', 'pipe:1'
        ], { encoding: 'utf8' });
        const frames = frameMd5.split(/\r?\n/).filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1).trim());
        assert.equal(frames.length, 12);
        assert.equal(new Set(frames.slice(0, 4).concat(frames.slice(8))).size, 1);
        assert.equal(new Set(frames.slice(4, 8)).size, 1);
        assert.notEqual(frames[0], frames[4]);
    } finally {
        if (ass) await fs.rm(ass, { force: true });
        await fs.rm(workspace, { recursive: true, force: true });
    }
});
