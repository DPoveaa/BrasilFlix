"""Timestamp dialogue from distributed clips, keeping original video times."""
import json
import sys

from faster_whisper import WhisperModel
from transcribe_subtitle_audio import build_cues, format_time


def main():
    manifest, output, model_name = sys.argv[1:4]
    clips = json.load(open(manifest, encoding='utf-8'))
    model = WhisperModel(model_name, device='cpu', compute_type='int8', cpu_threads=2)
    try:
        from faster_whisper import BatchedInferencePipeline
        engine = BatchedInferencePipeline(model=model)
        batch_options = {'batch_size': 8}
    except ImportError:
        engine, batch_options = model, {}
    cues = []
    for clip in clips:
        segments, _ = engine.transcribe(
            clip['path'], word_timestamps=True, vad_filter=True,
            condition_on_previous_text=False, beam_size=5, **batch_options,
        )
        segments = [segment for segment in segments if segment.words
                    and segment.no_speech_prob < 0.7 and segment.avg_logprob > -0.9]
        for start, end, text in build_cues(segments):
            cues.append((start + clip['offset'], end + clip['offset'], text))
    if len(cues) < 20:
        raise RuntimeError('Poucas falas confiáveis nos checkpoints')
    with open(output, 'w', encoding='utf-8') as target:
        for index, (start, end, text) in enumerate(cues, 1):
            target.write(f'{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n\n')
    print(json.dumps({'cues': len(cues), 'checkpoints': len(clips)}))


if __name__ == '__main__':
    main()
