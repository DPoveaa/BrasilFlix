"""Generate source-language SRT from the timestamps of recognized speech."""

import argparse
import re
import sys


def format_time(seconds):
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3600000)
    minutes, millis = divmod(millis, 60000)
    seconds, millis = divmod(millis, 1000)
    return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"


def build_cues(segments):
    cues = []
    for segment in segments:
        words = []
        for word in segment.words or ():
            if word.start is None or word.end is None or not word.word.strip():
                continue
            if words and (
                word.start - words[-1].end > 0.65
                or word.end - words[0].start > 5.5
                or len("".join(w.word for w in words) + word.word) > 76
            ):
                cues.append(words)
                words = []
            words.append(word)
            if word.word.strip().endswith((".", "?", "!", "。", "！", "？")):
                cues.append(words)
                words = []
        if words:
            cues.append(words)

    readable = []
    for words in cues:
        previous = readable[-1] if readable else []
        if (
            previous
            and words[0].start - previous[-1].end <= 0.30
            and (previous[-1].end - previous[0].start < 0.85 or words[-1].end - words[0].start < 0.85)
            and words[-1].end - previous[0].start <= 4
            and len("".join(w.word for w in previous + words)) <= 64
        ):
            previous.extend(words)
        else:
            readable.append(words)

    timed = []
    for index, words in enumerate(readable):
        start = max(0, words[0].start, timed[-1][1] if timed else 0)
        end = max(start + 0.75, words[-1].end + 0.12)
        if index + 1 < len(readable):
            end = min(end, readable[index + 1][0].start)
        if round(end * 1000) > round(start * 1000):
            timed.append((start, end, "".join(w.word for w in words).strip()))
    return timed


def recover_cues(engine, audio, cues, language, batch_size):
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    rate = 16000
    speech = get_speech_timestamps(audio, VadOptions(
        threshold=0.25, min_speech_duration_ms=180, min_silence_duration_ms=250, speech_pad_ms=120
    ))
    gaps = [(left, right) for left, right in zip(
        [0, *(end for _, end, _ in cues)],
        [*(start for start, _, _ in cues), len(audio) / rate]
    ) if right - left >= 1.4]
    clips = []
    for left, right in gaps:
        start = left
        while start < right:
            end = min(right, start + 18)
            if any(min(end, segment["end"] / rate) - max(start, segment["start"] / rate) >= 0.32
                   for segment in speech):
                clips.append({"start": max(0, start - 4.5), "end": min(len(audio) / rate, end + 4.5)})
            start = end
    if not clips:
        return cues, 0
    segments, _ = engine.transcribe(
        audio, language=language, clip_timestamps=clips, vad_filter=False, without_timestamps=False,
        word_timestamps=True, condition_on_previous_text=False, beam_size=4, batch_size=batch_size,
    )
    decoded = sorted(cue for segment in segments
                     if segment.avg_logprob >= -0.75 and segment.no_speech_prob < 0.5
                     for cue in build_cues([segment]))
    recovered = []
    for start, end, text in decoded:
        if len(re.findall(r"\w+", text)) < 2 and not re.search(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{4}", text):
            continue
        middle = (start + end) / 2
        gap = next(((left, right) for left, right in gaps if left <= middle <= right), None)
        if gap is None:
            continue
        start, end = max(start, gap[0]), min(end, gap[1])
        if end - start >= 0.72 and (not recovered or start >= recovered[-1][1] - 0.06):
            recovered.append((start, end, text))
    return sorted([*cues, *recovered]), len(recovered)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--language")
    parser.add_argument("--recover-gaps", action="store_true")
    args = parser.parse_args()

    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
    try:
        from faster_whisper import BatchedInferencePipeline
        engine = BatchedInferencePipeline(model=model)
        batch_options = {'batch_size': max(1, args.batch_size)}
    except ImportError:
        engine, batch_options = model, {}
    audio = decode_audio(args.audio) if args.recover_gaps else args.audio
    segments, info = engine.transcribe(
        audio, language=args.language, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False, beam_size=5, **batch_options
    )
    segments = [segment for segment in segments if segment.words and segment.no_speech_prob < 0.7]
    total_words = sum(len(segment.words) for segment in segments)
    uncertain = sum(len(segment.words) for segment in segments if segment.avg_logprob < -0.9)
    cues = build_cues(segments)
    if not cues or uncertain > total_words * 0.20:
        raise RuntimeError("Transcrição com confiança insuficiente")
    recovered = 0
    if args.recover_gaps:
        if not batch_options:
            raise RuntimeError("Motor de transcrição em blocos indisponível para revisar as lacunas")
        cues, recovered = recover_cues(engine, audio, cues, args.language or info.language, batch_options["batch_size"])
    if info.duration >= 600:
        spans = {min(3, int(start / info.duration * 4)) for start, _, _ in cues}
        if len(spans) < 4 or len(cues) < info.duration / 60:
            raise RuntimeError("Cobertura de falas insuficiente ao longo do vídeo")
    with open(args.output, "w", encoding="utf-8") as output:
        for index, (start, end, text) in enumerate(cues, 1):
            output.write(f"{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n\n")
    print(f"{len(cues)} falas, língua {info.language}, {recovered} recuperadas nas lacunas", file=sys.stderr)


if __name__ == "__main__":
    main()
