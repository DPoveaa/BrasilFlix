"""Align a human subtitle to the spoken transcript of the same media."""
import argparse
import json
import random
import re

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from align_subtitle_dialogue import normalize, read_srt
from transcribe_subtitle_audio import format_time


def embeddings(texts, model):
    tokenizer = Tokenizer.from_file(str(model / 'tokenizer.json'))
    tokenizer.enable_truncation(max_length=128)
    tokenizer.enable_padding(pad_id=0, pad_token='[PAD]')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    engine = ort.InferenceSession(str(model / 'onnx/model_quantized.onnx'), options,
                                  providers=['CPUExecutionProvider'])
    names = {value.name for value in engine.get_inputs()}
    batches = []
    for start in range(0, len(texts), 32):
        batch = tokenizer.encode_batch(texts[start:start + 32])
        inputs = {key: np.asarray([getattr(row, field) for row in batch], dtype=np.int64)
                  for key, field in [('input_ids', 'ids'), ('attention_mask', 'attention_mask'),
                                     ('token_type_ids', 'type_ids')] if key in names}
        output = engine.run(None, inputs)[0]
        if output.ndim == 3:
            mask = inputs['attention_mask'][..., None]
            output = (output * mask).sum(1) / mask.sum(1)
        batches.append((output / np.maximum(np.linalg.norm(output, axis=1, keepdims=True), 1e-9))
                       .astype(np.float32))
    return np.concatenate(batches)


def align(args):
    cues = []
    last_seen = {}
    for cue in read_srt(args.candidate):
        key = tuple(normalize(cue['text']))
        last = last_seen.get(key)
        if last and cue['start'] - last['start'] <= 1.5 and cue['start'] < last['end']:
            continue
        cues.append(cue)
        last_seen[key] = cue
    speech = read_srt(args.reference)
    if min(len(cues), len(speech)) < 20 or max(len(cues), len(speech)) > 5000:
        raise ValueError('Quantidade de falas fora dos limites de validação')
    groups = []
    for index, cue in enumerate(speech):
        for count in range(1, 4):
            part = speech[index:index + count]
            if len(part) == count and part[-1]['end'] - cue['start'] <= 12:
                groups.append((cue['start'], part[-1]['end'], ' '.join(row['text'] for row in part)))
    vectors = embeddings([re.sub(r'<[^>]+>|\n', ' ', row['text']) for row in cues] +
                         [group[2] for group in groups], args.model)
    similarity = vectors[:len(cues)] @ vectors[len(cues):].T
    starts = np.asarray([group[0] for group in groups])

    def matches(scale, offset, window):
        result = []
        for index, cue in enumerate(cues):
            if len(normalize(cue['text'])) < 4:
                continue
            nearby = np.flatnonzero(np.abs(starts - (scale * cue['start'] + offset)) <= window)
            if not len(nearby):
                continue
            order = nearby[np.argsort(similarity[index, nearby])[::-1]]
            best = order[0]
            start, end, words = groups[best]
            score = float(similarity[index, best])
            alternate = next((float(similarity[index, j]) for j in order
                              if abs(starts[j] - start) > 8), 0)
            if score >= .80 and score - alternate >= .12 and len(normalize(words)) >= 5:
                length = max(.1, cue['end'] - cue['start'])
                if .4 <= (end - start) / length <= 2.2:
                    result.append((index, cue['start'], start, end, score))
        return result

    seed = [row for row in matches(1, 0, 180) if row[0] % 5]
    if len(seed) < 12:
        raise ValueError('Poucas correspondências distintas de diálogo')
    x, y = (np.asarray([row[column] for row in seed]) for column in (1, 2))
    rng = random.Random(42)
    best = []
    duration = args.duration or speech[-1]['end']
    for _ in range(1500):
        i, j = rng.sample(range(len(x)), 2)
        if abs(x[i] - x[j]) < min(600, duration * .22):
            continue
        scale = (y[j] - y[i]) / (x[j] - x[i])
        if .90 <= scale <= 1.10:
            inliers = np.flatnonzero(np.abs(y - (scale * (x - x[i]) + y[i])) <= 1.2)
            if len(inliers) > len(best):
                best = inliers
    if len(best) < 12:
        raise ValueError('Velocidade sem evidência suficiente no áudio')
    scale, offset = np.polyfit(x[best], y[best], 1)
    anchors = matches(scale, offset, 60)
    train = [row for row in anchors if row[0] % 5]
    held = [row for row in anchors if not row[0] % 5]
    quarters = [sum(q * duration / 4 <= row[2] < (q + 1) * duration / 4
                    for row in anchors) for q in range(4)]
    if len(held) < 8 or min(quarters) < 2 or len(train) < 12:
        raise ValueError('Amostras insuficientes ao longo do vídeo')

    times = np.asarray([row[1] for row in train])
    residuals = np.asarray([row[2] for row in train]) - (scale * times + offset)
    cost = [float('inf')] * (len(train) + 1)
    previous = {}
    cost[0] = -18
    for end in range(4, len(train) + 1):
        for start in range(end - 4, -1, -1):
            if not np.isfinite(cost[start]):
                continue
            values = residuals[start:end]
            median = np.median(values)
            total = cost[start] + np.minimum(np.abs(values - median), 5).sum() + 18
            if total < cost[end]:
                cost[end] = total
                previous[end] = (start, median)
    regions = []
    end = len(train)
    while end:
        start, median = previous[end]
        indexes = np.arange(start, end)
        kept = indexes[np.abs(residuals[indexes] - median) < 2]
        if len(kept) < 4:
            raise ValueError('Trecho sem falas suficientes para corrigir o corte')
        regions.append((start, end, kept))
        end = start
    regions.reverse()
    boundaries = [(times[left[1] - 1] + times[right[0]]) / 2
                  for left, right in zip(regions, regions[1:])]

    def adjustment(time):
        kept = regions[np.searchsorted(boundaries, time, side='right')][2]
        near = kept[np.argsort(np.abs(times[kept] - time))[:7]]
        return float(offset + np.median(residuals[near]))

    def errors(transform):
        values = [abs(transform(row[1]) - row[2]) for row in held]
        return float(np.median(values)), float(np.quantile(values, .9))

    before = errors(lambda t: t)
    after = errors(lambda t: scale * t + adjustment(t))
    improved = ((before[0] - after[0] >= .20 or before[1] - after[1] >= .30)
                and after[0] <= before[0] + .05 and after[1] <= before[1] + .10)
    effective = after if improved else before
    if effective[0] > .65 or effective[1] > 1.50:
        raise ValueError('Desvio residual acima do limite; é necessário testar outra fonte')

    uncertain = 0
    last_start = -1
    output = []
    for cue in cues:
        start, end = cue['start'], cue['end']
        if improved:
            shift = adjustment(start)
            for left, right in zip(regions, regions[1:]):
                if times[left[1] - 1] < start < times[right[0]]:
                    uncertain += 1
                    break
            start, end = scale * start + shift, scale * end + shift
        if start < last_start - .05:
            raise ValueError('Mudança de corte inverte a ordem das falas')
        last_start = start
        if start >= 0 and end > start:
            output.append((start, end, cue['text']))
    if uncertain > max(8, len(cues) * .10):
        raise ValueError('Há muitos diálogos entre cortes sem confirmação')
    with open(args.output, 'w', encoding='utf8') as file:
        for index, (start, end, text) in enumerate(output, 1):
            file.write(f'{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n\n')
    dialogue_start = next((start for start, _, text in output if len(normalize(text)) >= 3), output[0][0])
    points = [dialogue_start]
    for point in [*(scale * boundary + adjustment(boundary) for boundary in boundaries),
                  *(row[2] for row in sorted(held, key=lambda row: abs(
                      row[2] - (scale * row[1] + adjustment(row[1]) if improved else row[1])), reverse=True))]:
        if all(abs(point - other) >= 16 for other in points):
            points.append(float(point))
        if len(points) >= 4:
            break
    return dict(aligned=True, method='semantic_dialogue', matches=len(anchors), quarters=quarters,
                held_out=len(held), median_sec=round(effective[0], 3), residual_p90_sec=round(effective[1], 3),
                adjusted=bool(improved), scale=round(float(scale), 8), regions=len(regions),
                uncertain_cues=uncertain, boundary_points=points)


if __name__ == '__main__':
    from pathlib import Path
    parser = argparse.ArgumentParser()
    for field in ('candidate', 'reference', 'output'):
        parser.add_argument(field)
    parser.add_argument('model', type=Path)
    parser.add_argument('duration', type=float)
    try:
        print(json.dumps(align(parser.parse_args())))
    except ValueError as error:
        print(json.dumps(dict(aligned=False, reason=str(error))))
