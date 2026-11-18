"""Align human PT-BR cues to a timestamped PT-BR transcript of this exact audio.

No nearest-speech/onset votes: matches must identify actual dialogue and agree
across the film. Different cuts or insufficient evidence are rejected.
"""
import bisect
import difflib
import json
import math
import re
import statistics
import sys
import unicodedata


def read_srt(filename):
    text = open(filename, encoding='utf-8-sig').read()
    cues = []
    for block in re.split(r'\n\s*\n', text.replace('\r', '').strip()):
        match = re.search(r'(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)', block)
        if not match:
            continue
        def seconds(parts):
            h, m, s, ms = map(int, parts)
            return h * 3600 + m * 60 + s + ms / 1000
        cues.append({'start': seconds(match.groups()[:4]), 'end': seconds(match.groups()[4:]),
                     'text': block[match.end():].strip()})
    return cues


def normalize(text):
    text = re.sub(r'<[^>]+>', '', text).lower()
    text = ''.join(c for c in unicodedata.normalize('NFD', text) if not unicodedata.combining(c))
    return re.findall(r'[a-z0-9]+', text)


def score(left, right):
    a, b = set(left), set(right)
    # Short generic replies cannot establish timing or movie identity.
    if min(len(a), len(b)) < 3:
        return 0
    return 0.7 * (2 * len(a & b) / (len(a) + len(b))) + 0.3 * difflib.SequenceMatcher(None, left, right).ratio()


def align(candidate_file, reference_file, output_file):
    cues, reference = read_srt(candidate_file), read_srt(reference_file)
    if min(len(cues), len(reference)) < 20:
        return {'aligned': False, 'reason': 'Diálogo insuficiente para validar sincronia'}
    groups = []
    for i, cue in enumerate(reference):
        for size in range(1, 4):
            part = reference[i:i + size]
            if len(part) != size or part[-1]['end'] - cue['start'] > 10:
                continue
            groups.append((cue['start'], normalize(' '.join(c['text'] for c in part))))
    starts = [group[0] for group in groups]
    pairs = []
    step = max(1, len(cues) // 400)
    for cue in cues[::step]:
        words = normalize(cue['text'])
        if len(set(words)) < 4:
            continue
        begin, end = bisect.bisect_left(starts, cue['start'] - 180), bisect.bisect_right(starts, cue['start'] + 180)
        ranked = sorted(((score(words, tokens), time) for time, tokens in groups[begin:end]), reverse=True)
        if not ranked or ranked[0][0] < 0.58:
            continue
        best, time = ranked[0]
        distant = next((value for value, other in ranked[1:] if abs(other - time) > 8), 0)
        if best - distant < 0.08:
            continue
        pairs.append((cue['start'], time))
    if len(pairs) < 12:
        return {'aligned': False, 'reason': 'Falas correspondentes insuficientes', 'matches': len(pairs)}

    # Robust affine fit allows a constant offset or a real frame-rate change.
    # A cut-dependent jump must fail rather than invent a piecewise time warp.
    best_inliers = []
    for x1, y1 in pairs:
        for x2, y2 in pairs[::max(1, len(pairs) // 20)]:
            if x2 - x1 < min(300, max(10, cues[-1]['end'] / 4)):
                continue
            slope = (y2 - y1) / (x2 - x1)
            if not 0.94 <= slope <= 1.06:
                continue
            offset = y1 - slope * x1
            inliers = [(x, y) for x, y in pairs if abs(y - (slope * x + offset)) <= 1.0]
            if len(inliers) > len(best_inliers):
                best_inliers = inliers
    if len(best_inliers) < max(12, math.ceil(len(pairs) * 0.65)):
        return {'aligned': False, 'reason': 'Correspondências incompatíveis: corte diferente ou tempos inconsistentes'}
    mean_x, mean_y = (statistics.mean(p[i] for p in best_inliers) for i in (0, 1))
    variance = sum((x - mean_x) ** 2 for x, _ in best_inliers)
    if not variance:
        return {'aligned': False, 'reason': 'Falas concentradas em um único instante'}
    slope = sum((x - mean_x) * (y - mean_y) for x, y in best_inliers) / variance
    offset = mean_y - slope * mean_x
    residuals = sorted(abs(y - (slope * x + offset)) for x, y in best_inliers)
    last = max(c['end'] for c in cues)
    quarters = [sum(1 for x, _ in best_inliers if min(3, int(x / last * 4)) == i) for i in range(4)]
    if min(quarters) < 2 or residuals[int((len(residuals) - 1) * 0.9)] > 0.8:
        return {'aligned': False, 'reason': 'Sincronia sem evidência consistente no início, meio e fim', 'quarters': quarters}

    def timestamp(seconds):
        ms = max(0, round(seconds * 1000))
        hours, ms = divmod(ms, 3600000)
        minutes, ms = divmod(ms, 60000)
        seconds, ms = divmod(ms, 1000)
        return f'{hours:02}:{minutes:02}:{seconds:02},{ms:03}'
    with open(output_file, 'w', encoding='utf-8') as output:
        for i, cue in enumerate(cues, 1):
            start, end = slope * cue['start'] + offset, slope * cue['end'] + offset
            if end <= 0:
                continue
            output.write(f"{i}\n{timestamp(start)} --> {timestamp(end)}\n{cue['text']}\n\n")
    return {'aligned': True, 'method': 'dialogue_content', 'matches': len(best_inliers),
            'quarters': quarters, 'offset_sec': round(offset, 3), 'scale': round(slope, 7),
            'residual_p90_sec': round(residuals[int((len(residuals) - 1) * 0.9)], 3)}


if __name__ == '__main__':
    result = align(*sys.argv[1:4])
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result['aligned'] else 2)
