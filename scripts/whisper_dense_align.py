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
    if not os.path.exists(anchors_json_path):
        return {'aligned': False, 'reason': f"Arquivo de âncoras não encontrado: {anchors_json_path}"}
    if not os.path.exists(input_srt_path):
        return {'aligned': False, 'reason': f"Arquivo de legenda candidata não encontrado: {input_srt_path}"}

    with open(anchors_json_path, 'r', encoding='utf-8') as f:
        anchor_data = json.load(f)

    anchors = anchor_data.get('anchors', [])
    audio_lang = anchor_data.get('language', 'en')
    total_dur_sec = float(anchor_data.get('duration_sec') or duration_sec or 0.0)

    cues = parse_srt(input_srt_path)
    if len(cues) < 10:
        return {'aligned': False, 'reason': f"Legenda candidata vazia ou com poucas falas ({len(cues)})"}

    if len(anchors) < 5:
        # Se quase não há fala detectada no áudio (filme mudo ou silêncio), preserva 100% o original
        print("ℹ️ [Dense Whisper Sync] Poucas âncoras de voz detectadas. Preservando legenda humana 100% original.")
        write_srt(cues, output_srt_path, preserve_original_timecodes=True)
        return {
            'aligned': True,
            'in_sync': True,
            'modified': False,
            'global_offset_ms': 0,
            'drift_range_ms': 0,
            'cue_count': len(cues),
            'reason': 'Poucas âncoras detectadas. Legenda original preservada 100% intacta.'
        }

    if not duration_sec or duration_sec < 60:
        duration_sec = max(total_dur_sec, cues[-1]['end'], anchors[-1]['endMs'] / 1000.0)

    en_cues = parse_srt(ref_en_path) if ref_en_path and os.path.exists(ref_en_path) else []
    is_pt_to_en = (audio_lang == 'en')

    # Extrai onsets de fala das âncoras Whisper
    # Dá preferência para o início de palavras após pausas
    speech_onsets_sec = []
    for a in anchors:
        if a.get('words') and len(a['words']) > 0:
            for w in a['words']:
                if w.get('startMs') is not None:
                    speech_onsets_sec.append(w['startMs'] / 1000.0)
        else:
            speech_onsets_sec.append(a['startMs'] / 1000.0)

    speech_onsets_sec = sorted(list(set(speech_onsets_sec)))

    print(f"🔍 [Dense Whisper Sync Guide] Analisando {len(cues)} falas humanas contra {len(speech_onsets_sec)} onsets de voz Whisper (áudio: {audio_lang})...")

    # ==========================================================================
    # Step 1: Estimação Robusta do Deslocamento Global (Histograma de Diferenças)
    # Combina correlação temporal de onset com votos léxicos/nomes próprios
    # ==========================================================================
    bin_size_sec = 0.05  # 50ms bins
    max_search_sec = 60.0  # Janela de busca: ±60s
    bins = {}

    # 1. Votos léxicos e de nomes próprios com peso alto
    sample_cues = [c for c in cues if len(c['text'].split()) >= 2]
    step = max(1, len(sample_cues) // 250)
    for c in sample_cues[::step]:
        c_start = c['start']
        nearby_anchors = [a for a in anchors if abs((a['startMs'] / 1000.0) - c_start) <= max_search_sec]
        for a in nearby_anchors:
            sim = compute_cue_anchor_similarity(c, a, is_pt_to_en, en_cues)
            if sim >= 0.20:
                diff = (a['startMs'] / 1000.0) - c_start
                b = round(diff / bin_size_sec) * bin_size_sec
                # Peso proporcional à similaridade léxica
                bins[b] = bins.get(b, 0.0) + (sim * 10.0)

    # 2. Votos acústicos de onset (início de fala após pausa >= 0.8s)
    isolated_cues = []
    for i, c in enumerate(cues):
        if i == 0 or (c['start'] - cues[i - 1]['end'] >= 0.8):
            isolated_cues.append(c['start'])

    isolated_onsets = []
    for j, onset in enumerate(speech_onsets_sec):
        if j == 0 or (onset - speech_onsets_sec[j - 1] >= 0.8):
            isolated_onsets.append(onset)

    step_c = max(1, len(isolated_cues) // 200)
    for c_start in isolated_cues[::step_c]:
        for onset in isolated_onsets:
            diff = onset - c_start
            if abs(diff) <= max_search_sec:
                b = round(diff / bin_size_sec) * bin_size_sec
                bins[b] = bins.get(b, 0.0) + 1.0

    if bins:
        best_bin = max(bins.keys(), key=lambda b: bins[b])
        # Refina com a média/mediana ponderada nos arredores de ±0.75s do pico
        close_bins = [b for b in bins.keys() if abs(b - best_bin) <= 0.75]
        total_w = sum(bins[b] for b in close_bins)
        global_offset_sec = sum(b * bins[b] for b in close_bins) / max(0.001, total_w)
    else:
        best_bin = 0.0
        global_offset_sec = 0.0

    global_offset_ms = int(round(global_offset_sec * 1000.0))
    print(f"🎯 [Dense Whisper Sync] Deslocamento global estimado: {global_offset_ms:+d}ms (pico: {int(best_bin*1000)}ms)")

    # ==========================================================================
    # Step 2: Medição de Sincronia e Drift em Janelas de 5 Minutos
    # ==========================================================================
    window_sec = 300.0  # 5 minutos
    num_windows = int(math.ceil(duration_sec / window_sec))
    window_offsets = []

    for w in range(num_windows):
        w_start = w * window_sec
        w_end = (w + 1) * window_sec
        cues_in_win = [c for c in cues if w_start <= c['start'] < w_end]

        if len(cues_in_win) < 3:
            continue

        local_diffs = []
        for c in cues_in_win:
            expected_start = c['start'] + global_offset_sec
            # Busca o onset mais próximo no raio de ±1.5s do esperado
            nearby = [onset for onset in speech_onsets_sec if abs(onset - expected_start) <= 1.5]
            if nearby:
                closest = min(nearby, key=lambda onset: abs(onset - expected_start))
                local_diffs.append(closest - c['start'])

        if len(local_diffs) >= 3:
            w_med = statistics.median(local_diffs)
            window_offsets.append({
                'center_sec': (w_start + w_end) / 2.0,
                'median_offset_sec': w_med,
                'count': len(local_diffs)
            })

    if window_offsets:
        all_meds = [wo['median_offset_sec'] for wo in window_offsets]
        drift_range_sec = max(all_meds) - min(all_meds)
    else:
        drift_range_sec = 0.0

    drift_range_ms = int(round(drift_range_sec * 1000.0))

    # ==========================================================================
    # Step 3: Verificação de "Already In Sync" (Não destrutivo!)
    # Critério: |global_offset| <= 0.35s E drift negligenciável (<= 0.40s)
    # Se já está sincronizada: PRESERVA 100% DOS TIMECODES ORIGINAIS HUMANOS!
    # ==========================================================================
    is_already_in_sync = (abs(global_offset_sec) <= 0.35) and (drift_range_sec <= 0.40)

    if is_already_in_sync:
        print(f"✨ [Dense Whisper Sync] Legenda já está em PERFEITA sincronia com o áudio! (Offset: {global_offset_ms:+d}ms, Drift: {drift_range_ms}ms).")
        print("   Preservando 100% dos timecodes e durações originais da legenda humana (zero modificações).")
        write_srt(cues, output_srt_path, preserve_original_timecodes=True)
        return {
            'aligned': True,
            'in_sync': True,
            'modified': False,
            'global_offset_ms': global_offset_ms,
            'drift_range_ms': drift_range_ms,
            'cue_count': len(cues),
            'reason': f'Legenda humana já está em sincronia perfeita (offset {global_offset_ms:+d}ms <= 350ms, drift {drift_range_ms}ms). Timings 100% preservados.'
        }

    # ==========================================================================
    # Step 4: Subtitle Out of Sync - Calcular Offset / Drift / Piecewise Shift
    # Preservando estritamente cada duração original humana:
    # new_end = new_start + orig_duration
    # ==========================================================================
    print(f"⏱️ [Dense Whisper Sync] Legenda fora de sincronia (Offset: {global_offset_ms:+d}ms, Drift: {drift_range_ms}ms). Ajustando com preservação de durações...")

    # Detecta se há drift linear contínuo (ex: conversão de FPS 23.976 <-> 25.000)
    # slope = cov(t, off) / var(t)
    use_linear_drift = False
    slope = 0.0
    intercept = global_offset_sec

    if len(window_offsets) >= 4 and drift_range_sec > 0.6:
        ts = [wo['center_sec'] for wo in window_offsets]
        ys = [wo['median_offset_sec'] for wo in window_offsets]
        mean_t = statistics.mean(ts)
        mean_y = statistics.mean(ys)
        var_t = sum((t - mean_t) ** 2 for t in ts)
        cov_ty = sum((t - mean_t) * (y - mean_y) for t, y in zip(ts, ys))
        if var_t > 0:
            candidate_slope = cov_ty / var_t
            # Se a taxa de inclinação condiz com diferenças de framerate (ex: ~0.041 ou ~-0.040)
            if 0.02 <= abs(candidate_slope) <= 0.06:
                use_linear_drift = True
                slope = candidate_slope
                intercept = mean_y - slope * mean_t
                print(f"📈 [Dense Whisper Sync] Drift linear de framerate detectado (slope: {slope:.6f}, intercept: {intercept:.3f}s).")

    # Detecta se há salto de corte (scene-cut shift multi-segundo)
    has_cut_jump = False
    cut_jump_time = 0.0
    cut_jump_delta = 0.0
    for i in range(1, len(window_offsets)):
        delta = window_offsets[i]['median_offset_sec'] - window_offsets[i - 1]['median_offset_sec']
        if abs(delta) >= 2.5:
            has_cut_jump = True
            cut_jump_time = window_offsets[i]['center_sec']
            cut_jump_delta = delta
            print(f"✂️ [Dense Whisper Sync] Salto de corte detectado aos {cut_jump_time/60.0:.1f}min ({delta:+.2f}s).")
            break

    def get_shift_for_time(t_sec):
        if use_linear_drift:
            return intercept + slope * t_sec
        if has_cut_jump:
            if t_sec >= cut_jump_time:
                return global_offset_sec + cut_jump_delta
            else:
                return global_offset_sec
        return global_offset_sec

    # Aplica o deslocamento preservando 100% a duração humana original de cada cue
    shifted_cues = []
    for c in cues:
        orig_dur = c['orig_dur']
        shift = get_shift_for_time(c['start'])
        new_start = max(0.0, c['start'] + shift)
        new_end = new_start + orig_dur
        shifted_cues.append({
            'start': new_start,
            'end': new_end,
            'orig_dur': orig_dur,
            'text': c['text']
        })

    # Anti-overlap clamping: nunca sobrepõe falas, mantendo gap limpo de 40ms
    # E garantindo: new_end = new_start + orig_dur capped antes de next_cue.start - 0.04s
    MIN_GAP = 0.04  # 40ms
    for i in range(len(shifted_cues)):
        cur = shifted_cues[i]
        if i > 0:
            prev = shifted_cues[i - 1]
            if prev['end'] > cur['start'] - MIN_GAP:
                max_prev_end = cur['start'] - MIN_GAP
                if max_prev_end >= prev['start'] + 0.3:
                    prev['end'] = max_prev_end
                else:
                    cur['start'] = prev['end'] + MIN_GAP
                    cur['end'] = cur['start'] + cur['orig_dur']

    # Escreve o arquivo SRT final sincronizado
    write_srt(shifted_cues, output_srt_path, preserve_original_timecodes=False)
    print(f"✅ [Dense Whisper Sync] {len(shifted_cues)} falas salvas com sucesso em {output_srt_path}!")

    return {
        'aligned': True,
        'in_sync': False,
        'modified': True,
        'global_offset_ms': global_offset_ms,
        'drift_range_ms': drift_range_ms,
        'cue_count': len(shifted_cues),
        'reason': f'Legenda humana sincronizada com sucesso (offset {global_offset_ms:+d}ms, drift {drift_range_ms}ms) mantendo 100% as durações originais.'
    }


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
