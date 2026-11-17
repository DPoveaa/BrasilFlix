#!/usr/bin/env python3
"""
Forced Multi-Checkpoint Acoustic Offset Alignment (Whisper ASR)
Extracts 3 short 30-second audio clips from actual video stream at 15%, 50%, and 80% of runtime.
Transcribes with Whisper, matches spoken dialogue against subtitle cues across ±60s window.
If the 3 checkpoints disagree by > 2.5s (different movie cut, e.g. Extended vs Theatrical),
rejects the candidate subtitle so pipeline falls back to Gemini neural translation.
If checkpoints agree (<= 2.5s), applies exact median millisecond shift to all cues.
"""

import sys
import os
import json
import re
import subprocess
import statistics
import faster_whisper

STOPWORDS_EN = {
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'it', 'its', 'he', 'she', 'we', 'they', 'i', 'you', 'me', 'him', 'her', 'us',
    'them', 'that', 'this', 'these', 'those', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'so', 'if', 'as', 'by',
    'from', 'up', 'down', 'out', 'all', 'what', 'who', 'how', 'when', 'where', 'why',
    'will', 'would', 'can', 'could', 'should', 'my', 'your', 'his', 'our', 'their',
    'just', 'then', 'there', 'here', 'now', 'too', 'very', 'well', 'about'
}

STOPWORDS_PT = {
    'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
    'em', 'no', 'na', 'nos', 'nas', 'por', 'pelo', 'pela', 'pelos', 'pelas', 'para',
    'pra', 'com', 'sem', 'sob', 'sobre', 'que', 'se', 'e', 'ou', 'mas', 'como',
    'ele', 'ela', 'eles', 'elas', 'eu', 'voce', 'voces', 'tu', 'nos', 'meu', 'minha',
    'seu', 'sua', 'este', 'esta', 'esse', 'essa', 'isso', 'isto', 'aquilo', 'foi',
    'era', 'sao', 'somos', 'estou', 'esta', 'estao', 'tem', 'tinha', 'muito', 'nao'
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
                'start_tc': m.group(1).replace('.', ','),
                'end_tc': m.group(2).replace('.', ','),
                'text': text_clean
            })
    return cues

def write_srt(cues, out_path):
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, 'w', encoding='utf-8') as f:
        for idx, cue in enumerate(cues, 1):
            start_tc = format_timecode(cue['start'])
            end_tc = format_timecode(cue['end'])
            f.write(f"{idx}\n{start_tc} --> {end_tc}\n{cue['text']}\n\n")

def extract_tokens(text, stopwords=STOPWORDS_EN):
    clean = re.sub(r'[^a-zA-Z0-9\s]', ' ', text.lower())
    tokens = set(w for w in clean.split() if len(w) >= 3 and w not in stopwords)
    return tokens

def compute_token_overlap(set_a, set_b):
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    return len(intersection) / max(1, min(len(set_a), len(set_b)))

def align_subtitles(video_path, input_srt_path, output_srt_path, duration_sec=0.0, ref_en_path=None):
    cues = parse_srt(input_srt_path)
    if len(cues) < 30:
        return {
            'aligned': False,
            'reason': f"Poucas falas na legenda ({len(cues)} cues)",
            'offsets': []
        }

    # Probes video if duration not supplied
    if not duration_sec or duration_sec < 120:
        probe = subprocess.run([
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', video_path
        ], capture_output=True, text=True)
        try:
            duration_sec = float(probe.stdout.strip())
        except Exception:
            duration_sec = cues[-1]['end']

    if duration_sec < 120:
        return {'aligned': False, 'reason': 'Duração do vídeo inválida ou curta demais', 'offsets': []}

    en_cues = parse_srt(ref_en_path) if ref_en_path and os.path.exists(ref_en_path) else []

    # Probes audio channels for center channel isolation (5.1 surround)
    channels = 2
    try:
        p_ch = subprocess.run([
            'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams', video_path
        ], capture_output=True, text=True, timeout=20)
        p_data = json.loads(p_ch.stdout)
        a_streams = [s for s in p_data.get('streams', []) if s.get('codec_type') == 'audio']
        if a_streams:
            channels = int(a_streams[0].get('channels', 2))
    except Exception:
        channels = 2

    af_filter = 'pan=mono|c0=c2' if channels >= 6 else 'highpass=f=200,lowpass=f=3500'

    print(f"🎙️ [Whisper Acoustic Align] Carregando modelo faster_whisper (tiny, int8)...")
    model = faster_whisper.WhisperModel('tiny', device='cpu', compute_type='int8')

    # 3 Checkpoints at 15%, 50%, 80%
    targets = [
        ('15% (Início)', duration_sec * 0.15),
        ('50% (Miolo)', duration_sec * 0.50),
        ('80% (Clímax)', duration_sec * 0.80)
    ]

    checkpoint_results = []

    for name, target_sec in targets:
        # Find candidate dialogue cue in ±60s window
        window_cues = [
            c for c in cues
            if abs(c['start'] - target_sec) <= 60.0
            and len(c['text'].split()) >= 3
            and '♪' not in c['text']
            and not c['text'].startswith('[')
            and not any(tag in c['text'].lower() for tag in ['legendas', 'tradução', 'sincronia', 'equipe', 'subtitles'])
        ]

        if not window_cues:
            window_cues = [c for c in cues if abs(c['start'] - target_sec) <= 120.0]

        if not window_cues:
            print(f"⚠️ [{name}] Nenhuma fala encontrada próxima a {target_sec/60:.1f}min")
            continue

        target_cue = min(window_cues, key=lambda c: abs(c['start'] - target_sec))
        clip_start = max(0.0, target_cue['start'] - 2.0)
        clip_dur = 30.0

        wav_path = f"/tmp/whisper_align_{int(clip_start)}_{os.getpid()}.wav"
        try:
            cmd = [
                'ffmpeg', '-nostdin', '-v', 'error', '-y',
                '-ss', f"{clip_start:.3f}",
                '-i', video_path,
                '-t', f"{clip_dur:.3f}",
                '-vn',
                '-af', af_filter,
                '-ar', '16000',
                wav_path
            ]
            run_res = subprocess.run(cmd, capture_output=True, text=True, timeout=35)
            if run_res.returncode != 0 or not os.path.exists(wav_path):
                continue

            segments, info = model.transcribe(wav_path, word_timestamps=True, beam_size=1)
            segments = list(segments)
            if not segments:
                continue

            spoken_text = ' '.join(s.text.strip() for s in segments)
            spoken_tokens = extract_tokens(spoken_text, STOPWORDS_EN)

            # Match across all cues in this 30s clip window (±30s)
            matched_cue = None
            matched_word = None
            matched_dialogue = None

            if en_cues:
                # Find matching EN cue in the clip window
                nearby_en = [ec for ec in en_cues if abs(ec['start'] - (clip_start + 10.0)) <= 45.0]
                best_en = None
                best_ov = 0.0
                for ec in nearby_en:
                    ov = compute_token_overlap(spoken_tokens, extract_tokens(ec['text'], STOPWORDS_EN))
                    if ov > best_ov:
                        best_ov = ov
                        best_en = ec

                if best_en and best_ov >= 0.15:
                    matched_dialogue = best_en['text']
                    ref_tokens = list(extract_tokens(matched_dialogue, STOPWORDS_EN))
                    # Find exact spoken word for this dialogue
                    for s in segments:
                        if compute_token_overlap(extract_tokens(s.text, STOPWORDS_EN), set(ref_tokens)) >= 0.15:
                            for w in s.words:
                                if re.sub(r'[^a-z0-9]', '', w.word.lower()) in ref_tokens:
                                    matched_word = w
                                    break
                            if matched_word:
                                break

                    # The corresponding candidate PT cue is the one closest to the EN dialogue cue
                    matched_cue = min(cues, key=lambda c: abs(c['start'] - best_en['start']))
            else:
                # Direct comparison with candidate cues
                clip_candidates = [c for c in cues if abs(c['start'] - (clip_start + 10.0)) <= 45.0]
                best_c = None
                best_ov = 0.0
                for c in clip_candidates:
                    c_tokens = extract_tokens(c['text'], STOPWORDS_PT) if info.language == 'pt' else extract_tokens(c['text'], STOPWORDS_EN)
                    ov = compute_token_overlap(spoken_tokens, c_tokens)
                    if ov > best_ov:
                        best_ov = ov
                        best_c = c

                if best_c and (best_ov >= 0.15 or info.language == 'pt'):
                    matched_cue = best_c
                    matched_dialogue = best_c['text']
                    expected_rel = matched_cue['start'] - clip_start
                    all_words = [w for s in segments for w in s.words]
                    if all_words:
                        matched_word = min(all_words, key=lambda w: abs(w.start - expected_rel))

            if matched_cue and matched_word:
                actual_speech_time = clip_start + matched_word.start
                offset_sec = float(actual_speech_time - matched_cue['start'])

                checkpoint_results.append({
                    'checkpoint': name,
                    'cue_start': matched_cue['start'],
                    'cue_tc': matched_cue['start_tc'],
                    'speech_time': actual_speech_time,
                    'offset_sec': offset_sec,
                    'spoken_snippet': spoken_text[:60],
                    'matched_dialogue': (matched_dialogue or matched_cue['text'])[:60]
                })
                print(f"  ✅ [{name}] Fala: \"{spoken_text[:35]}\" | Cue [{matched_cue['start_tc']}]: \"{matched_cue['text'][:35]}\" | Offset: {offset_sec:+.3f}s")
            else:
                print(f"  ⚠️ [{name}] Diálogo falado não convergiu com as falas da cena")

        except Exception as ex:
            print(f"  ⚠️ [{name}] Erro: {ex}")
        finally:
            if os.path.exists(wav_path):
                try: os.remove(wav_path)
                except Exception: pass

    if len(checkpoint_results) < 2:
        return {
            'aligned': False,
            'reason': f"Apenas {len(checkpoint_results)} checkpoints resolveram fala (mínimo 2 necessários)",
            'offsets': [c['offset_sec'] for c in checkpoint_results]
        }

    offsets = [c['offset_sec'] for c in checkpoint_results]
    spread = max(offsets) - min(offsets)
    print(f"\n📊 [Whisper Alignment Check] Offsets medidos: {[round(o, 3) for o in offsets]} | Divergência máxima (spread): {spread:.3f}s")

    # STRICT CUT MISMATCH GATE: If checkpoints disagree by > 2.5s (Theatrical vs Extended Cut)
    if spread > 2.5:
        reason = f"Checkpoints divergiram em {spread:.2f}s (> 2.5s) - corte de filme incompatível (Theatrical vs Extended). Rejeitando candidato."
        print(f"❌ [Whisper Cut Gate] {reason}")
        return {
            'aligned': False,
            'reason': reason,
            'spread': round(spread, 3),
            'offsets': [round(o, 3) for o in offsets],
            'checkpoints': checkpoint_results
        }

    # Checkpoints agree! Apply exact median millisecond shift
    median_shift_sec = float(statistics.median(offsets))
    median_shift_ms = int(round(median_shift_sec * 1000))
    print(f"🎯 [Whisper Alignment Check] Alinhamento aprovado! Deslocamento mediano acústico: {median_shift_ms:+d}ms ({median_shift_sec:+.3f}s)")

    # Apply shift to all cues
    aligned_cues = []
    for c in cues:
        new_start = max(0.0, c['start'] + median_shift_sec)
        dur = max(0.5, c['end'] - c['start'])
        new_end = new_start + dur
        aligned_cues.append({
            'index': c['index'],
            'start': new_start,
            'end': new_end,
            'text': c['text']
        })

    write_srt(aligned_cues, output_srt_path)
    print(f"✅ [Whisper Acoustic Align] {len(aligned_cues)} falas salvas com alinhamento milimétrico em {output_srt_path}!")

    return {
        'aligned': True,
        'median_shift_ms': median_shift_ms,
        'spread': round(spread, 3),
        'offsets': [round(o, 3) for o in offsets],
        'cue_count': len(aligned_cues),
        'checkpoints': checkpoint_results
    }

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: whisper_acoustic_align.py <video_path> <input_srt> <output_srt> [duration_sec] [ref_en_srt]")
        sys.exit(1)

    video_p = sys.argv[1]
    input_s = sys.argv[2]
    output_s = sys.argv[3]
    dur_s = float(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] and sys.argv[4] != '0' else 0.0
    ref_en = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] and sys.argv[5] != 'null' else None

    res = align_subtitles(video_p, input_s, output_s, dur_s, ref_en)
    print("\n" + "="*60)
    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
    sys.exit(0 if res.get('aligned') else 2)
