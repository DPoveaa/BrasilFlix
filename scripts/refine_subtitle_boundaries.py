"""Check suspect cue boundaries against two readings of the actual audio."""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel

from align_subtitle_dialogue import normalize, read_srt
from align_subtitle_semantic import embeddings
from transcribe_subtitle_audio import format_time


def phrases(words):
    for index, word in enumerate(words):
        if index and not re.search(r'[,.!?]$', words[index - 1].word.strip()):
            if word.start - words[index - 1].end < .20:
                continue
        for end in range(index + 1, min(index + 29, len(words) + 1)):
            last = words[end - 1]
            if last.end - word.start > 8:
                break
            if end == len(words) or re.search(r'[,.!?]$', last.word.strip()) or words[end].start - last.end >= .20:
                yield word.start, last.end, ''.join(item.word for item in words[index:end])


def read_words(model, file, language=None):
    segments, info = model.transcribe(str(file), language=language, word_timestamps=True,
                                      vad_filter=True, temperature=0, beam_size=5,
                                      condition_on_previous_text=False, multilingual=language is None)
    words = [word for segment in segments if segment.no_speech_prob < .7 and segment.avg_logprob > -1
             for word in segment.words or () if word.end > word.start]
    return words, info.language


def refine(args):
    cues = read_srt(args.candidate)
    points = json.loads(args.points)
    if not points:
        return dict(boundary_checks=0, refined_starts=0, refined_ends=0)
    turbo = WhisperModel(args.whisper, device='cpu', compute_type='int8', cpu_threads=2)
    medium = None
    accepted = {}
    checks = 0
    with tempfile.TemporaryDirectory(prefix='subtitle-boundaries-') as tmp:
        for point in points:
            window = max(0, point - 5)
            selected = [(i, cue) for i, cue in enumerate(cues)
                        if window + .15 <= cue['start'] < window + 15
                        and cue['end'] <= window + 16]
            if not selected:
                continue
            wav = Path(tmp) / 'clip.wav'
            http = ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
                    '-rw_timeout', '20000000'] if args.video.startswith(('http://', 'https://')) else []
            try:
                subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', *http, '-ss', str(window),
                                '-i', args.video, '-t', '18', '-map', f'0:a:{args.audio}',
                                '-vn', '-ac', '1', '-ar', '16000', str(wav)], check=True,
                               timeout=60, capture_output=True)
            except (subprocess.SubprocessError, OSError):
                continue
            words, language = read_words(turbo, wav)
            spans = list(phrases(words))
            if not spans:
                continue
            checks += 1
            vectors = embeddings([cue['text'] for _, cue in selected] + [span[2] for span in spans], args.model)
            scores = vectors[:len(selected)] @ vectors[len(selected):].T
            proposals = {}
            anchors = {}
            for row, (index, cue) in enumerate(selected):
                eligible = [j for j, (start, end, _) in enumerate(spans)
                            if abs(window + start - cue['start']) <= 1.8
                            and abs(window + end - cue['end']) <= 1.5]
                if not eligible or len(normalize(cue['text'])) < 4:
                    continue
                ordered = sorted(eligible, key=lambda j: scores[row, j], reverse=True)
                best = ordered[0]
                start, end, spoken = spans[best]
                alternative = next((scores[row, j] for j in ordered
                                    if spans[j][1] <= start or spans[j][0] >= end), 0)
                if scores[row, best] < .84 or scores[row, best] - alternative < .08:
                    continue
                anchors[index] = (start, end)
                if abs(window + start - cue['start']) > .12 or abs(window + end - cue['end']) > .45:
                    proposals[index] = (start, end, spoken)
            for index, cue in selected:
                if not 0 < index < len(cues) - 1 or len(normalize(cue['text'])) >= 4:
                    continue
                previous, following = anchors.get(index - 1), anchors.get(index + 1)
                if not previous or not following:
                    continue
                whole = [span for span in spans if previous[1] - .05 <= span[0] and span[1] <= following[0] + .05
                         and re.search(r'[.!?]$', span[2].strip()) and abs(window + span[0] - cue['start']) <= 1.8]
                if len(whole) == 1:
                    proposals[index] = whole[0]
            if not proposals:
                continue
            medium = medium or WhisperModel(args.second, device='cpu', compute_type='int8', cpu_threads=2)
            independent, second_language = read_words(medium, wav, language)
            if second_language != language:
                continue
            tokens = [(token, word.start, word.end) for word in independent for token in normalize(word.word)]
            for index, (start, end, spoken) in proposals.items():
                target = normalize(spoken)
                if len(target) < 3:
                    continue
                hits = [tokens[j:j + len(target)] for j in range(len(tokens) - len(target) + 1)
                        if abs(tokens[j][1] - start) <= .35
                        and [row[0] for row in tokens[j:j + len(target)]] == target]
                if len(hits) != 1 or abs(hits[0][-1][2] - end) > .55:
                    continue
                old = cues[index]
                new_start = window + max(start, hits[0][0][1])
                new_end = old['end']
                spoken_end = window + (end + hits[0][-1][2]) / 2
                if abs(spoken_end - new_end) > .45:
                    new_end = spoken_end + .12
                if index:
                    new_start = max(new_start, accepted.get(index - 1, cues[index - 1])['end'])
                if index + 1 < len(cues):
                    new_end = min(new_end, cues[index + 1]['start'])
                if new_end - new_start >= max(.75, len(old['text']) / 30):
                    if abs(new_start - old['start']) <= .12:
                        new_start = old['start']
                    accepted[index] = dict(old, start=new_start, end=new_end)
    out = [accepted.get(index, cue) for index, cue in enumerate(cues)]
    with open(args.output, 'w', encoding='utf8') as file:
        for index, cue in enumerate(out, 1):
            file.write(f"{index}\n{format_time(cue['start'])} --> {format_time(cue['end'])}\n{cue['text']}\n\n")
    return dict(boundary_checks=checks,
                refined_starts=sum(abs(a['start'] - b['start']) > .01 for a, b in zip(cues, out)),
                refined_ends=sum(abs(a['end'] - b['end']) > .01 for a, b in zip(cues, out)))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for field in ('video', 'candidate', 'output'):
        parser.add_argument(field)
    parser.add_argument('model', type=Path)
    parser.add_argument('audio', type=int)
    parser.add_argument('points')
    parser.add_argument('--whisper', default='turbo')
    parser.add_argument('--second', default='medium')
    print(json.dumps(refine(parser.parse_args())))
