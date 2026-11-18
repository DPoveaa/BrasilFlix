#!/usr/bin/env python3
"""
Full-Movie Dense Whisper Anchor Alignment Engine (Non-Destructive Sync Guide)
BrasilFlix Subtitle Pipeline

Human subtitles are the 100% source of truth for text and cue durations.
Whisper speech-onset timestamps are used solely to measure whether the human subtitle
is already in sync with the audio or has an offset/drift:
  - Already in sync (median offset <= 0.35s and negligible drift):
    Preserves 100% of original human timestamps untouched (modified: False).
  - Out of sync (offset > 0.35s, FPS ratio drift, or scene-cut shift):
    Calculates clean offset/drift and shifts cue start times while strictly
    preserving each human cue's original duration (new_end = new_start + orig_duration,
    capped cleanly before next_cue.start - 0.04s).
"""

import sys
import os
import json
import re
import math
import argparse
import statistics

STOPWORDS_EN = {
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'it', 'its', 'he', 'she', 'we', 'they', 'i', 'you', 'me', 'him', 'her', 'us',
    'them', 'that', 'this', 'these', 'those', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'so', 'if', 'as', 'by',
    'from', 'up', 'down', 'out', 'all', 'what', 'who', 'how', 'when', 'where', 'why',
    'will', 'would', 'can', 'could', 'should', 'my', 'your', 'his', 'our', 'their',
    'just', 'then', 'there', 'here', 'now', 'too', 'very', 'well', 'about', 'yeah', 'oh', 'ok', 'okay'
}

STOPWORDS_PT = {
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
    'em', 'no', 'na', 'nos', 'nas', 'por', 'pelo', 'pela', 'pelos', 'pelas', 'para',
    'pra', 'com', 'sem', 'sob', 'sobre', 'que', 'se', 'e', 'ou', 'mas', 'como',
    'ele', 'ela', 'eles', 'elas', 'eu', 'voce', 'voces', 'tu', 'nos', 'meu', 'minha',
    'seu', 'sua', 'este', 'esta', 'esse', 'essa', 'isso', 'isto', 'aquilo', 'foi',
    'era', 'sao', 'somos', 'estou', 'esta', 'estao', 'tem', 'tinha', 'muito', 'nao',
    'ja', 'ne', 'ta', 'sim', 'bem', 'mais', 'tudo', 'vai', 'vou', 'so'
}


def parse_timecode(tc):
    parts = re.split(r'[:,]', tc.strip().replace('.', ','))
    if len(parts) < 4:
        return 0.0
    h, m, s, ms = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
    return h * 3600.0 + m * 60.0 + s + ms / 1000.0


def format_timecode(total_sec):
    if total_sec < 0:
        total_sec = 0.0
    total_ms = int(round(total_sec * 1000.0))
    ms = total_ms % 1000
    s_tot = total_ms // 1000
    s = s_tot % 60
    m_tot = s_tot // 60
    m = m_tot % 60
    h = m_tot // 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(srt_path):
    if not srt_path or not os.path.exists(srt_path):
        return []
    content = ""
    for enc in ['utf-8', 'cp1252', 'latin-1', 'iso-8859-1']:
        try:
            with open(srt_path, 'r', encoding=enc) as f:
                content = f.read()
            break
        except UnicodeDecodeError:
            continue
    if not content:
        with open(srt_path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()

    normalized = re.sub(r'\r\n|\r', '\n', content).strip()
    blocks = re.split(r'\n\s*\n', normalized)
    cues = []
    tc_regex = re.compile(r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})')

    for block in blocks:
        lines = [l.strip() for l in block.split('\n') if l.strip()]
        if len(lines) < 2:
            continue
        tc_idx = -1
        for i, l in enumerate(lines):
            if tc_regex.search(l):
                tc_idx = i
                break
        if tc_idx == -1:
            continue
        m = tc_regex.search(lines[tc_idx])
        start_sec = parse_timecode(m.group(1))
        end_sec = parse_timecode(m.group(2))
        text = ' '.join(lines[tc_idx + 1:])
        text_clean = re.sub(r'<[^>]+>', '', text).strip()
        if text_clean and end_sec > start_sec:
            orig_dur = end_sec - start_sec
            cues.append({
                'index': len(cues) + 1,
                'start': start_sec,
                'end': end_sec,
                'orig_dur': orig_dur,
                'start_ms': int(round(start_sec * 1000.0)),
                'end_ms': int(round(end_sec * 1000.0)),
                'orig_dur_ms': int(round(orig_dur * 1000.0)),
                'start_tc': m.group(1).replace('.', ','),
                'end_tc': m.group(2).replace('.', ','),
                'text': text_clean
            })
    return cues


def write_srt(cues, out_path, preserve_original_timecodes=False):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        for idx, cue in enumerate(cues, 1):
            if preserve_original_timecodes and cue.get('start_tc') and cue.get('end_tc'):
                start_tc = cue['start_tc']
                end_tc = cue['end_tc']
            else:
                start_tc = format_timecode(cue['start'])
                end_tc = format_timecode(cue['end'])
            f.write(f"{idx}\n{start_tc} --> {end_tc}\n{cue['text']}\n\n")


def extract_tokens(text, stopwords=STOPWORDS_EN):
    clean = re.sub(r'<[^>]+>', ' ', text)
    clean = re.sub(r'[^a-zA-Z0-9\sáàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]', ' ', clean.lower())
    tokens = set(w for w in clean.split() if len(w) >= 3 and w not in stopwords)
    return tokens


def compute_token_overlap(tokens_a, tokens_b):
    if not tokens_a or not tokens_b:
        return 0.0
    inter = tokens_a & tokens_b
    return len(inter) / max(1, min(len(tokens_a), len(tokens_b)))


def extract_proper_and_numbers(text):
    clean_words = re.findall(r'\b[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ][a-záàâãéêíóôõúç]+\b|\b\d+\b', text)
    return set(w.lower() for w in clean_words if len(w) >= 3)


def compute_char_trigrams(text):
    clean = re.sub(r'[^a-zA-Z0-9]', '', text.lower())
    if len(clean) < 3:
        return {clean} if clean else set()
    return {clean[i:i+3] for i in range(len(clean) - 2)}


def compute_dice_trigram(text_a, text_b):
    tri_a = compute_char_trigrams(text_a)
    tri_b = compute_char_trigrams(text_b)
    if not tri_a or not tri_b:
        return 0.0
    return 2.0 * len(tri_a & tri_b) / (len(tri_a) + len(tri_b))


def compute_cue_anchor_similarity(cue, anchor, is_pt_to_en=False, en_cues=None):
    # 1. If English reference cues exist and anchor is in English:
    if is_pt_to_en and en_cues:
        nearby_en = [ec for ec in en_cues if abs(ec['start'] - cue['start']) <= 4.0]
        if nearby_en:
            best_en = min(nearby_en, key=lambda ec: abs(ec['start'] - cue['start']))
            ov = compute_token_overlap(
                extract_tokens(best_en['text'], STOPWORDS_EN),
                extract_tokens(anchor.get('text', ''), STOPWORDS_EN)
            )
            if ov > 0:
                return ov

    # 2. Direct token overlap (same language or cognate tokens)
    stopwords = STOPWORDS_PT if is_pt_to_en else STOPWORDS_EN
    cue_tokens = extract_tokens(cue['text'], stopwords)
    anchor_tokens = extract_tokens(anchor.get('text', ''), STOPWORDS_EN if is_pt_to_en else stopwords)
    direct_ov = compute_token_overlap(cue_tokens, anchor_tokens)
    if direct_ov >= 0.20:
        return direct_ov

    # 3. Proper names and numbers (e.g. Harry, Potter, 1999, Paris, etc.)
    pn_cue = extract_proper_and_numbers(cue['text'])
    pn_anchor = extract_proper_and_numbers(anchor.get('text', ''))
    if pn_cue and pn_anchor:
        pn_ov = len(pn_cue & pn_anchor) / max(1, min(len(pn_cue), len(pn_anchor)))
        if pn_ov >= 0.5:
            return 0.5 * pn_ov

    # 4. Trigram overlap for cognates (problema / problem, hospital / hospital)
    tri_score = compute_dice_trigram(cue['text'], anchor.get('text', ''))
    if tri_score >= 0.35:
        return tri_score * 0.7

    return 0.0


# ==============================================================================
# 1. TRANSCRIBE: 100% Video Audio -> Spoken Anchor Map
# ==============================================================================
def run_transcribe(audio_path, output_json_path, duration_sec=0.0, model_name='tiny'):
    print(f"🎙️ [Whisper Dense Anchor] Carregando modelo faster_whisper ({model_name}, int8, cpu_threads=4)...")
    from faster_whisper import WhisperModel

    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4)

    print(f"🎙️ [Whisper Dense Anchor] Transcrevendo áudio com VAD ({audio_path})...")
    segments, info = model.transcribe(
        audio_path,
        beam_size=1,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500),
        word_timestamps=True,
        condition_on_previous_text=False
    )

    total_dur = info.duration if (info.duration and info.duration > 0) else duration_sec
    last_reported_pct = -1
    whisper_anchors = []

    for segment in segments:
        words = []
        if segment.words:
            for w in segment.words:
                if w.word and w.start is not None and w.end is not None:
                    words.append({
                        'word': w.word.strip(),
                        'startMs': int(round(w.start * 1000.0)),
                        'endMs': int(round(w.end * 1000.0))
                    })

        start_ms = int(round(segment.start * 1000.0))
        end_ms = int(round(segment.end * 1000.0))
        whisper_anchors.append({
            'startMs': start_ms,
            'endMs': end_ms,
            'text': segment.text.strip(),
            'words': words
        })

        if total_dur > 0:
            pct = int((segment.end / total_dur) * 100)
            pct = max(0, min(100, pct))
            if pct != last_reported_pct:
                last_reported_pct = pct
                print(f"PROGRESS:{pct}:{segment.end:.1f}:{total_dur:.1f}", flush=True)

    result_data = {
        'duration_sec': round(total_dur, 2),
        'language': info.language,
        'language_probability': round(info.language_probability, 3),
        'anchor_count': len(whisper_anchors),
        'anchors': whisper_anchors
    }

    os.makedirs(os.path.dirname(os.path.abspath(output_json_path)), exist_ok=True)
    with open(output_json_path, 'w', encoding='utf-8') as f:
        json.dump(result_data, f, ensure_ascii=False)

    print(f"TRANSCRIPTION_COMPLETE:{len(whisper_anchors)}:{info.language}", flush=True)
    print(f"✅ [Whisper Dense Anchor] {len(whisper_anchors)} âncoras salvas com sucesso em {output_json_path}!")
    return result_data


# ==============================================================================
# 2. ALIGN: Non-Destructive Sync Guide (Preserve Human Timings & Text)
# ==============================================================================
def run_align(anchors_json_path, input_srt_path, output_srt_path, duration_sec=0.0, ref_en_path=None):
    with open(anchors_json_path, encoding='utf-8') as source:
        data = json.load(source)
    reference = data.get('ptbr_reference')
    if not reference:
        return {'aligned': False, 'reason': 'Âncoras acústicas sem correspondência textual não comprovam sincronia'}
    from align_subtitle_dialogue import align
    return align(input_srt_path, reference, output_srt_path)


def main():
    parser = argparse.ArgumentParser(description="Full-Movie Dense Whisper Anchor Alignment (Non-Destructive)")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Subcommand: transcribe
    p_trans = subparsers.add_parser("transcribe")
    p_trans.add_argument("audio_path", help="Path to 16kHz mono WAV audio")
    p_trans.add_argument("output_json", help="Path to output anchors JSON")
    p_trans.add_argument("duration_sec", type=float, nargs="?", default=0.0)
    p_trans.add_argument("--model", default="tiny", help="Whisper model (tiny/base)")

    # Subcommand: align
    p_align = subparsers.add_parser("align")
    p_align.add_argument("anchors_json", help="Path to anchors JSON")
    p_align.add_argument("input_srt", help="Path to candidate human SRT")
    p_align.add_argument("output_srt", help="Path to output aligned SRT")
    p_align.add_argument("duration_sec", type=float, nargs="?", default=0.0)
    p_align.add_argument("ref_en_srt", nargs="?", default=None)

    args = parser.parse_args()

    if args.command == "transcribe":
        res = run_transcribe(args.audio_path, args.output_json, args.duration_sec, args.model)
        sys.exit(0)
    elif args.command == "align":
        res = run_align(args.anchors_json, args.input_srt, args.output_srt, args.duration_sec, args.ref_en_srt)
        print("\n" + "=" * 60)
        print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
        sys.exit(0 if res.get('aligned') else 2)


if __name__ == '__main__':
    main()
