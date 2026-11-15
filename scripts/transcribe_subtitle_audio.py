"""Generate source-language SRT from the timestamps of recognized speech."""

import argparse
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("output")
    parser.add_argument("--model", default="turbo")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=args.threads)
    segments, info = model.transcribe(
        args.audio, language=args.language, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False, beam_size=5,
    )
    segments = [segment for segment in segments if segment.words]
    total_words = sum(len(segment.words) for segment in segments)
    uncertain = sum(len(segment.words) for segment in segments if segment.avg_logprob < -0.9)
    cues = build_cues(segments)
    if not cues or uncertain > total_words * 0.20:
        raise RuntimeError("Transcrição com confiança insuficiente")
    if info.duration >= 600:
        spans = {min(3, int(start / info.duration * 4)) for start, _, _ in cues}
        if len(spans) < 4 or len(cues) < info.duration / 60:
            raise RuntimeError("Cobertura de falas insuficiente ao longo do vídeo")
    with open(args.output, "w", encoding="utf-8") as output:
        for index, (start, end, text) in enumerate(cues, 1):
            output.write(f"{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n\n")
    print(f"{len(cues)} falas, língua {info.language}", file=sys.stderr)


if __name__ == "__main__":
    main()
