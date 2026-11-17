#!/usr/bin/env python3
"""
Full-Movie Dense Whisper Anchor Alignment Engine
BrasilFlix Subtitle Pipeline

1. Transcribes 100% of video audio using faster-whisper (tiny/base, int8, vad_filter=True)
   to build a dense map of spoken anchors ({ startMs, endMs, text, words }).
   Streams real-time progress (PROGRESS:<pct>:<cur_sec>:<tot_sec>) to stdout.

2. Dense Multi-Anchor Synchronization of Human Subtitles:
   - Global Offset & Cut Compatibility Check (10-minute windows across 0% to 100%):
     Rejects candidate if match coverage collapses or offset jumps > 4.5s (Theatrical vs Extended cut).
   - Piecewise / Local Anchor Refinement:
     Computes rolling 5-minute median offsets across the timeline to eliminate mid-movie drift,
     locking speech-onset with sub-150ms accuracy while preserving 100% human-authored text.
   - Clamping smooth transitions: zero overlaps, monotonic ordering, >= 30ms gap.
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
    return h * 3600 + m * 60 + s + ms / 1000.0


def format_timecode(total_sec):
    if total_sec < 0:
        total_sec = 0.0
    total_ms = int(round(total_sec * 1000))
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
            cues.append({
                'index': len(cues) + 1,
                'start': start_sec,
                'end': end_sec,
                'start_ms': int(round(start_sec * 1000)),
                'end_ms': int(round(end_sec * 1000)),
                'start_tc': m.group(1).replace('.', ','),
                'end_tc': m.group(2).replace('.', ','),
                'text': text_clean
            })
    return cues


def write_srt(cues, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        for idx, cue in enumerate(cues, 1):
            start_tc = cue.get('start_tc') or format_timecode(cue['start'])
            end_tc = cue.get('end_tc') or format_timecode(cue['end'])
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
                extract_tokens(anchor['text'], STOPWORDS_EN)
            )
            if ov > 0:
                return ov

    # 2. Direct token overlap (same language or cognate tokens)
    stopwords = STOPWORDS_PT if is_pt_to_en else STOPWORDS_EN
    cue_tokens = extract_tokens(cue['text'], stopwords)
    anchor_tokens = extract_tokens(anchor['text'], STOPWORDS_EN if is_pt_to_en else stopwords)
    direct_ov = compute_token_overlap(cue_tokens, anchor_tokens)
    if direct_ov >= 0.20:
        return direct_ov

    # 3. Proper names and numbers (e.g. John, Sarah, 1999, Paris, etc.)
    pn_cue = extract_proper_and_numbers(cue['text'])
    pn_anchor = extract_proper_and_numbers(anchor['text'])
    if pn_cue and pn_anchor:
        pn_ov = len(pn_cue & pn_anchor) / max(1, min(len(pn_cue), len(pn_anchor)))
        if pn_ov >= 0.5:
            return 0.5 * pn_ov

    # 4. Trigram overlap for cognates (problema / problem, hospital / hospital)
    tri_score = compute_dice_trigram(cue['text'], anchor['text'])
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

    print(f"🎙️ [Whisper Dense Anchor] Transcrevendo 100% do áudio ({audio_path})...")
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

    # Iterate over segment generator, streaming real-time progress
    for segment in segments:
        words = []
        if segment.words:
            for w in segment.words:
                if w.word and w.start is not None and w.end is not None:
                    words.append({
                        'word': w.word.strip(),
                        'startMs': int(round(w.start * 1000)),
                        'endMs': int(round(w.end * 1000))
                    })

        start_ms = int(round(segment.start * 1000))
        end_ms = int(round(segment.end * 1000))
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
# 2. ALIGN: Candidate Human Subtitle -> Dense Multi-Anchor Sync
# ==============================================================================
def run_align(anchors_json_path, input_srt_path, output_srt_path, duration_sec=0.0, ref_en_path=None):
    if not os.path.exists(anchors_json_path):
        return {'aligned': False, 'reason': f"Arquivo de âncoras não encontrado: {anchors_json_path}"}
    if not os.path.exists(input_srt_path):
        return {'aligned': False, 'reason': f"Arquivo de legenda candidata não encontrado: {input_srt_path}"}

    with open(anchors_json_path, 'r', encoding='utf-8') as f:
        anchor_data = json.load(f)

    anchors = anchor_data.get('anchors', [])
    audio_lang = anchor_data.get('language', 'en')
    total_dur_sec = float(anchor_data.get('duration_sec') or duration_sec or 0.0)

    if len(anchors) < 15:
        return {'aligned': False, 'reason': f"Poucas âncoras de fala detectadas ({len(anchors)})"}

    cues = parse_srt(input_srt_path)
    if len(cues) < 20:
        return {'aligned': False, 'reason': f"Legenda candidata com poucas falas ({len(cues)})"}

    if not duration_sec or duration_sec < 60:
        duration_sec = max(total_dur_sec, cues[-1]['end'], anchors[-1]['endMs'] / 1000.0)

    en_cues = parse_srt(ref_en_path) if ref_en_path and os.path.exists(ref_en_path) else []
    is_pt_to_en = (audio_lang == 'en')

    print(f"🔍 [Dense Whisper Sync] Alinhando {len(cues)} falas humanas contra {len(anchors)} âncoras Whisper (áudio: {audio_lang})...")

    # Step 1: Global Coarse Offset Search (±60s window across timeline)
    offset_votes = []
    # Sample every cue that has reasonable text length
    sample_cues = [c for c in cues if len(c['text'].split()) >= 2]
    for c in sample_cues:
        c_start_ms = c['start_ms']
        # Find anchors in ±60s
        nearby = [a for a in anchors if abs(a['startMs'] - c_start_ms) <= 60000]
        for a in nearby:
            sim = compute_cue_anchor_similarity(c, a, is_pt_to_en, en_cues)
            if sim >= 0.25:
                offset_votes.append(a['startMs'] - c_start_ms)

    if offset_votes:
        bins = {}
        for off in offset_votes:
            b = round(off / 500) * 500
            bins[b] = bins.get(b, 0) + 1
        best_bin = max(bins.keys(), key=lambda b: bins[b])
        close_votes = [o for o in offset_votes if abs(o - best_bin) <= 2500]
        global_offset_ms = statistics.median(close_votes) if close_votes else best_bin
    else:
        global_offset_ms = 0

    global_offset_ms = int(round(global_offset_ms))
    print(f"🎯 [Dense Whisper Sync] Deslocamento global inicial estimado: {global_offset_ms:+d}ms ({len(offset_votes)} votos coincidentes)")

    # Step 2: Dense Anchor Matching Pass with Global Offset Guidance
    for c in cues:
        c_start_ms = c['start_ms']
        expected_ms = c_start_ms + global_offset_ms

        # Candidate anchors within ±4000ms of expected
        candidates = [a for a in anchors if abs(a['startMs'] - expected_ms) <= 4000]
        best_match = None
        best_score = -1.0

        for a in candidates:
            sim = compute_cue_anchor_similarity(c, a, is_pt_to_en, en_cues)
            proximity = 1.0 - (abs(a['startMs'] - expected_ms) / 4000.0)
            dur_c = (c['end'] - c['start']) * 1000.0
            dur_a = float(a['endMs'] - a['startMs'])
            dur_ratio = min(dur_c, dur_a) / max(1.0, max(dur_c, dur_a))

            score = sim * 0.50 + proximity * 0.30 + dur_ratio * 0.20
            if sim >= 0.15 or (proximity >= 0.70 and dur_ratio >= 0.60):
                if score > best_score:
                    best_score = score
                    best_match = a

        if best_match:
            anchor_start_ms = best_match['startMs']
            # If word-level timestamps exist, use first word onset
            if best_match.get('words') and len(best_match['words']) > 0:
                first_w = best_match['words'][0]
                if first_w.get('startMs'):
                    anchor_start_ms = first_w['startMs']

            c['matched_anchor'] = best_match
            c['offset_ms'] = anchor_start_ms - c_start_ms
            c['has_match'] = True
        else:
            c['matched_anchor'] = None
            c['offset_ms'] = None
            c['has_match'] = False

    # Step 3: Global Offset & Cut Compatibility Check (Every 10-Minute Window)
    window_sec = 600.0  # 10 minutes
    num_windows = int(math.ceil(duration_sec / window_sec))
    window_stats = []
    cut_failed = False
    fail_reason = ""
    prev_win_median = None

    for w in range(num_windows):
        w_start_ms = int(w * window_sec * 1000)
        w_end_ms = int((w + 1) * window_sec * 1000)
        w_label = f"{int(w * 10)}-{min(int(duration_sec / 60), int((w + 1) * 10))}min"

        cues_in_win = [c for c in cues if w_start_ms <= c['start_ms'] < w_end_ms]
        total_cues = len(cues_in_win)

        if total_cues < 6:
            window_stats.append({
                'window': w_label,
                'status': 'sparse_dialogue',
                'cues': total_cues,
                'coverage': 0.0,
                'median_offset_ms': None
            })
            continue

        matched_in_win = [c for c in cues_in_win if c.get('has_match')]
        coverage = len(matched_in_win) / float(total_cues)
        offsets_in_win = [c['offset_ms'] for c in matched_in_win]
        win_median = statistics.median(offsets_in_win) if offsets_in_win else None

        win_stat = {
            'window': w_label,
            'cues': total_cues,
            'matched': len(matched_in_win),
            'coverage': round(coverage, 3),
            'median_offset_ms': int(win_median) if win_median is not None else None
        }
        window_stats.append(win_stat)

        # Check A: Coverage Collapse in a dialogue-heavy window
        if total_cues >= 10 and coverage < 0.08:
            cut_failed = True
            fail_reason = f"Cobertura de âncoras colapsou na janela {w_label} ({coverage*100:.1f}% com {total_cues} falas) - corte incompatível (Theatrical vs Extended)."
            print(f"❌ [Cut Gate] {fail_reason}")
            break

        # Check B: Large Offset Discontinuity relative to Global Offset (> 4.5s)
        if win_median is not None and abs(win_median - global_offset_ms) > 4500:
            cut_failed = True
            fail_reason = f"Deslocamento divergiu {abs(win_median - global_offset_ms)/1000:.2f}s na janela {w_label} (> 4.5s) - corte incompatível."
            print(f"❌ [Cut Gate] {fail_reason}")
            break

        # Check C: Jump between consecutive dialogue windows (> 4.0s)
        if win_median is not None and prev_win_median is not None and abs(win_median - prev_win_median) > 4000:
            cut_failed = True
            fail_reason = f"Salto de corte detectado na transição {w_label} (discontinuidade: {abs(win_median - prev_win_median)/1000:.2f}s) - corte incompatível."
            print(f"❌ [Cut Gate] {fail_reason}")
            break

        if win_median is not None:
            prev_win_median = win_median

    if cut_failed:
        return {
            'aligned': False,
            'reason': fail_reason,
            'windows': window_stats,
            'global_offset_ms': int(global_offset_ms)
        }

    # Step 4: Piecewise / Local Anchor Refinement (Rolling 5-Minute Windows)
    all_valid_matches = [(c['start_ms'], c['offset_ms']) for c in cues if c.get('has_match')]
    print(f"🛡️ [Cut Gate] Aprovado em todas as {num_windows} janelas! {len(all_valid_matches)} falas confirmadas como âncoras.")

    # Control points every 60s for smooth interpolation of rolling 5-minute median
    control_step_ms = 60000
    num_steps = int(math.ceil((duration_sec * 1000) / control_step_ms)) + 1
    control_points = []

    for step_i in range(num_steps):
        t_center = step_i * control_step_ms
        # 5-minute rolling window: ±150,000ms
        win_matches = [off for t, off in all_valid_matches if abs(t - t_center) <= 150000]
        if len(win_matches) >= 3:
            med = statistics.median(win_matches)
        elif len(win_matches) >= 1:
            med = win_matches[0]
        else:
            # Expand to 10-minute window
            win_wide = [off for t, off in all_valid_matches if abs(t - t_center) <= 300000]
            med = statistics.median(win_wide) if win_wide else global_offset_ms
        control_points.append((t_center, med))

    def get_smooth_offset_ms(t_ms):
        if not control_points:
            return global_offset_ms
        if t_ms <= control_points[0][0]:
            return control_points[0][1]
        if t_ms >= control_points[-1][0]:
            return control_points[-1][1]
        idx = int(t_ms // control_step_ms)
        idx = max(0, min(len(control_points) - 2, idx))
        t0, o0 = control_points[idx]
        t1, o1 = control_points[idx + 1]
        ratio = (t_ms - t0) / float(t1 - t0) if t1 > t0 else 0.0
        return o0 + ratio * (o1 - o0)

    # Compute target timecodes for all cues
    raw_aligned = []
    for c in cues:
        c_start_ms = c['start_ms']
        c_dur_ms = max(600, c['end_ms'] - c_start_ms)
        smooth_off = get_smooth_offset_ms(c_start_ms)

        # Direct anchor match lock if within ±350ms of smooth curve
        if c.get('has_match') and abs(c['offset_ms'] - smooth_off) <= 350:
            target_start_ms = c_start_ms + c['offset_ms']
        else:
            target_start_ms = c_start_ms + smooth_off

        target_end_ms = target_start_ms + c_dur_ms
        raw_aligned.append({
            'start_ms': target_start_ms,
            'end_ms': target_end_ms,
            'text': c['text']  # 100% human-authored text preserved
        })

    # Step 5: Anti-Overlap and Monotonicity Clamping
    MIN_GAP_MS = 30
    MIN_DUR_MS = 600
    final_cues = []

    for i, item in enumerate(raw_aligned):
        start_ms = max(0, int(round(item['start_ms'])))
        end_ms = max(start_ms + MIN_DUR_MS, int(round(item['end_ms'])))

        if final_cues:
            prev = final_cues[-1]
            if prev['end_ms'] > start_ms - MIN_GAP_MS:
                # Overlap detected
                if prev['start_ms'] + MIN_DUR_MS <= start_ms - MIN_GAP_MS:
                    prev['end_ms'] = start_ms - MIN_GAP_MS
                    prev['end'] = prev['end_ms'] / 1000.0
                    prev['end_tc'] = format_timecode(prev['end'])
                else:
                    start_ms = prev['end_ms'] + MIN_GAP_MS
                    end_ms = max(start_ms + MIN_DUR_MS, end_ms)

        start_sec = start_ms / 1000.0
        end_sec = end_ms / 1000.0
        final_cues.append({
            'index': i + 1,
            'start': start_sec,
            'end': end_sec,
            'start_ms': start_ms,
            'end_ms': end_ms,
            'start_tc': format_timecode(start_sec),
            'end_tc': format_timecode(end_sec),
            'text': item['text']
        })

    write_srt(final_cues, output_srt_path)
    print(f"✅ [Dense Whisper Sync] {len(final_cues)} falas salvas perfeitamente alinhadas em {output_srt_path}!")

    offsets_list = [c['offset_ms'] for c in cues if c.get('has_match')]
    drift_range = (max(offsets_list) - min(offsets_list)) if offsets_list else 0

    return {
        'aligned': True,
        'global_offset_ms': int(global_offset_ms),
        'drift_range_ms': int(drift_range),
        'cue_count': len(final_cues),
        'matched_count': len(all_valid_matches),
        'coverage_pct': round((len(all_valid_matches) / float(len(cues))) * 100, 1),
        'windows': window_stats
    }


def main():
    parser = argparse.ArgumentParser(description="Full-Movie Dense Whisper Anchor Alignment")
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
