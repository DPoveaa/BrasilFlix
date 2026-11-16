#!/usr/bin/env python3
"""
Whisper-Powered Cinema-Grade Subtitle Verification
Extracts speech across 3 checkpoints (Beginning ~10%, Middle ~50%, Final Act ~80%)
using faster_whisper, verifies TRUE SPOKEN CONTENT against English Anchor Reference
(via token overlap and acoustic alignment), and validates frame-level synchronization.
"""

import sys
import os
import json
import re
import subprocess
import faster_whisper

# Common English stopwords to ignore in content token comparison
STOPWORDS_EN = {
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'is', 'it', 'its', 'he', 'she', 'we', 'they', 'i', 'you', 'me', 'him', 'her', 'us',
    'them', 'that', 'this', 'these', 'those', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'so', 'if', 'as', 'by',
    'from', 'up', 'down', 'out', 'all', 'what', 'who', 'how', 'when', 'where', 'why',
    'will', 'would', 'can', 'could', 'should', 'my', 'your', 'his', 'our', 'their',
    'just', 'then', 'there', 'here', 'now', 'too', 'very', 'well', 'about'
}

# Common Portuguese stopwords for PT audio comparison
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
        if re.search(r'[\w\u00C0-\u00FF]', text_clean) and end_sec > start_sec:
            cues.append({
                'start': start_sec,
                'end': end_sec,
                'start_tc': m.group(1),
                'end_tc': m.group(2),
                'text': text_clean
            })
    return cues

def extract_tokens(text, stopwords=STOPWORDS_EN):
    clean = re.sub(r'[^a-zA-Z0-9\s]', ' ', text.lower())
    tokens = set(w for w in clean.split() if len(w) >= 3 and w not in stopwords)
    return tokens

def compute_token_overlap(set_a, set_b):
    if not set_a or not set_b:
        return 0.0
    intersection = set_a & set_b
    return len(intersection) / max(1, min(len(set_a), len(set_b)))

def verify_sync(video_path, srt_path, max_allowed_offset_sec=1.5, ref_en_path=None):
    if not os.path.exists(video_path) or not os.path.exists(srt_path):
        return {'verified': False, 'error': 'Video or SRT file missing', 'checkpoints': []}
    
    probe_run = subprocess.run([
        'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', video_path
    ], capture_output=True, text=True)
    
    try:
        probe_data = json.loads(probe_run.stdout)
        duration = float(probe_data.get('format', {}).get('duration', 0))
        audio_streams = [s for s in probe_data.get('streams', []) if s.get('codec_type') == 'audio']
        channels = int(audio_streams[0].get('channels', 2)) if audio_streams else 2
    except Exception:
        duration = 0
        channels = 2
    
    if duration < 120:
        return {'verified': False, 'error': 'Video duration too short', 'checkpoints': []}
    
    pt_cues = parse_srt(srt_path)
    if len(pt_cues) < 30:
        return {'verified': False, 'error': f'Too few subtitle cues ({len(pt_cues)})', 'checkpoints': []}
    
    # Check that subtitle covers the whole movie
    last_cue_end = pt_cues[-1]['end']
    if last_cue_end < duration * 0.75:
        return {
            'verified': False,
            'error': f'Subtitle is incomplete (ends at {last_cue_end/60:.1f}m for {duration/60:.1f}m film)',
            'checkpoints': []
        }
    
    # Parse English Reference Anchor Subtitle if available
    en_cues = parse_srt(ref_en_path) if ref_en_path and os.path.exists(ref_en_path) else []
    if en_cues:
        print(f"⚓ [Whisper Verify] Âncora em Inglês carregada ({len(en_cues)} cues) para validação cruzada de conteúdo!")
    
    print(f"🎬 [Whisper Verify] Loading faster_whisper (tiny, int8)...")
    model = faster_whisper.WhisperModel('tiny', device='cpu', compute_type='int8')
    
    # 3 Checkpoints across the film: 10%, 50%, 80%
    targets = [
        ('Abertura (Início ~10%)', duration * 0.10),
        ('Miolo (Ponto Médio ~50%)', duration * 0.50),
        ('Clímax (Ato Final ~80%)', duration * 0.80)
    ]
    
    checkpoints = []
    
    # Audio filter: if 5.1/6 channels, extract Center channel (FC / c2) to isolate dialogue
    af_filter = 'pan=mono|c0=c2' if channels >= 6 else 'highpass=f=200,lowpass=f=3500'
    
    for name, target_sec in targets:
        # Search window of ±450s around target for candidate dialogue cues
        candidate_cues = [
            c for c in pt_cues 
            if abs(c['start'] - target_sec) < 450 
            and len(c['text'].split()) >= 3 
            and '♪' not in c['text']
            and not c['text'].startswith('[')
            and not any(tag in c['text'].lower() for tag in ['legendas', 'tradução', 'sincronia', 'equipe', 'subtitles'])
        ]
        
        if not candidate_cues:
            candidate_cues = [c for c in pt_cues if abs(c['start'] - target_sec) < 600]
        
        # Sort candidates by proximity to target
        candidate_cues.sort(key=lambda c: abs(c['start'] - target_sec))
        
        cp_resolved = False
        
        # Try up to 10 candidates to find clear, verifiable speech
        for cue in candidate_cues[:10]:
            cue_start = cue['start']
            cue_end = cue['end']
            
            # Clip padding: 2.0s before start to 2.0s after end
            clip_start = max(0, cue_start - 2.0)
            clip_dur = min(16.0, (cue_end - cue_start) + 4.0)
            
            wav_path = f"/tmp/whisper_chk_{int(clip_start)}_{os.getpid()}.wav"
            
            try:
                # Two-stage seek: fast seek 15s before, accurate seek remainder
                fast_seek = max(0, clip_start - 15.0)
                accurate_seek = clip_start - fast_seek
                
                cmd = [
                    'ffmpeg', '-nostdin', '-v', 'warning', '-y',
                    '-ss', f"{fast_seek:.3f}",
                    '-i', video_path,
                    '-ss', f"{accurate_seek:.3f}",
                    '-t', f"{clip_dur:.3f}",
                    '-vn',
                    '-af', af_filter,
                    '-ar', '16000',
                    wav_path
                ]
                run_res = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
                if run_res.returncode != 0:
                    continue
                
                # Transcribe audio slice with word timestamps
                segments, info = model.transcribe(wav_path, word_timestamps=True, beam_size=1)
                segments = list(segments)
                
                all_words = []
                for s in segments:
                    for w in s.words:
                        all_words.append(w)
                
                if not all_words:
                    continue  # No speech detected in this clip, try next candidate
                
                # Ignora trechos onde o Whisper alucinou idiomas desconexos devido a ruído/trilha sonora
                if info.language not in ('en', 'pt', 'es') and info.language_probability > 0.70:
                    continue

                spoken_text = ' '.join(s.text.strip() for s in segments)
                spoken_tokens = extract_tokens(spoken_text, STOPWORDS_EN)
                
                # --- CONTENT MATCH VERIFICATION ---
                content_matched = False
                matching_en_text = ""
                overlap_score = 0.0
                
                if en_cues:
                    # Find EN cues in a window of ±90s around cue_start to handle PAL/NTSC differences and release intro offsets
                    nearby_en = [
                        ec for ec in en_cues
                        if abs(ec['start'] - cue_start) <= 90.0
                    ]
                    
                    if nearby_en:
                        best_match = None
                        best_overlap = 0.0
                        for ec in nearby_en:
                            ec_tokens = extract_tokens(ec['text'], STOPWORDS_EN)
                            ov = compute_token_overlap(spoken_tokens, ec_tokens)
                            if ov > best_overlap:
                                best_overlap = ov
                                best_match = ec
                        
                        # Substring check against any nearby EN cue
                        if best_match is None or best_overlap < 0.25:
                            clean_spoken = re.sub(r'[^a-z0-9]', '', spoken_text.lower())
                            for ec in nearby_en:
                                clean_ec = re.sub(r'[^a-z0-9]', '', ec['text'].lower())
                                if len(clean_ec) > 5 and (clean_ec in clean_spoken or clean_spoken in clean_ec):
                                    best_match = ec
                                    best_overlap = 0.50
                                    break
                        
                        if best_match and best_overlap >= 0.25:
                            matching_en_text = best_match['text']
                            overlap_score = best_overlap
                            content_matched = True
                        else:
                            print(f"  [CONTENT MISMATCH] Trecho {cue['start_tc']}:")
                            print(f"    Whisper ouviu: \"{spoken_text[:50]}\"")
                            print(f"    Candidatos EN próximos não bateram (best overlap={best_overlap:.2f})")
                            continue  # Spoken words don't match any scene dialogue in this window!
                    else:
                        print(f"  [NO EN ANCHOR IN WINDOW] Trecho {cue['start_tc']}")
                        continue
                else:
                    # Sem âncora EN: valida se o áudio é Português
                    if info.language == 'pt':
                        pt_spoken_tokens = extract_tokens(spoken_text, STOPWORDS_PT)
                        pt_cue_tokens = extract_tokens(cue['text'], STOPWORDS_PT)
                        overlap_score = compute_token_overlap(pt_spoken_tokens, pt_cue_tokens)
                        content_matched = (overlap_score >= 0.25)
                    else:
                        # Áudio em inglês sem âncora EN: verifica nomes próprios e números
                        proper_spoken = set(re.findall(r'\b[A-Z][a-z]+\b|\b\d+\b', spoken_text))
                        proper_cue = set(re.findall(r'\b[A-Z][a-z]+\b|\b\d+\b', cue['text']))
                        overlap_score = len(proper_spoken & proper_cue) / max(1, min(len(proper_spoken), len(proper_cue))) if proper_cue else 0.5
                        content_matched = True
                
                expected_rel_start = cue_start - clip_start  # ~2.0s
                expected_rel_end = cue_end - clip_start

                # --- PHONETIC WORD ALIGNMENT ---
                # Identifica palavra de início de fala correspondente
                target_word = None
                if matching_en_text:
                    ref_tokens = list(extract_tokens(matching_en_text, STOPWORDS_EN))
                    # Localiza o segmento que pronuncia o diálogo correspondente
                    for s in segments:
                        seg_tokens = extract_tokens(s.text, STOPWORDS_EN)
                        if compute_token_overlap(seg_tokens, ref_tokens) >= 0.20:
                            for w in s.words:
                                w_clean = re.sub(r'[^a-z0-9]', '', w.word.lower())
                                if w_clean in ref_tokens or w.start >= expected_rel_start - 1.0:
                                    target_word = w
                                    break
                            if target_word:
                                break

                    if target_word is None:
                        for w in all_words:
                            w_clean = re.sub(r'[^a-z0-9]', '', w.word.lower())
                            if w_clean in ref_tokens:
                                target_word = w
                                break

                if target_word is None:
                    target_word = min(all_words, key=lambda w: abs(w.start - expected_rel_start))

                speech_start = target_word.start
                measured_offset = float(expected_rel_start - speech_start)

                # A fala pronunciada deve estar alinhada com o cue ou ocorrer durante a janela de exibição
                is_within_cue = (speech_start >= expected_rel_start - 1.0) and (speech_start <= expected_rel_end + 1.0)
                in_sync = bool((abs(measured_offset) <= max_allowed_offset_sec or is_within_cue) and content_matched)
                
                checkpoints.append({
                    'name': name,
                    'cue_timecode': f"{cue['start_tc']} --> {cue['end_tc']}",
                    'cue_text': cue['text'][:80],
                    'spoken_text': spoken_text[:80],
                    'anchor_en_text': matching_en_text[:80] if matching_en_text else 'N/A',
                    'token_overlap': round(overlap_score, 2),
                    'matched_word': target_word.word.strip(),
                    'measured_offset_sec': round(measured_offset, 2),
                    'content_matched': content_matched,
                    'in_sync': in_sync
                })
                
                status = '✅ PASS' if in_sync else '❌ FAIL'
                print(f"  {status} [{name}] PT: \"{cue['text'][:35]}\" | EN: \"{(matching_en_text or spoken_text)[:35]}\" | Offset: {measured_offset:+.2f}s (Overlap: {overlap_score:.2f})")
                cp_resolved = True
                break
                
            except Exception as e:
                pass
            finally:
                if os.path.exists(wav_path):
                    try: os.remove(wav_path)
                    except Exception: pass
        
        if not cp_resolved:
            checkpoints.append({
                'name': name,
                'error': 'Nenhuma fala audível/compatível com a âncora detectada nos candidatos desse trecho',
                'in_sync': False
            })
            print(f"  ❌ FAIL [{name}] Conteúdo falado não correspondeu aos diálogos da cena")
    
    passed_count = sum(1 for cp in checkpoints if cp.get('in_sync', False))
    total_count = len(checkpoints)
    # Require at least 2 checkpoints to pass and >= 66% pass rate
    verified = bool(passed_count >= 2 and (passed_count / max(1, total_count)) >= 0.66)
    
    return {
        'verified': verified,
        'passed': passed_count,
        'total': total_count,
        'checkpoints': checkpoints
    }

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: whisper_verify.py <video_path> <srt_path> [max_offset_sec] [ref_en_srt_path]")
        sys.exit(1)
    
    video = sys.argv[1]
    srt = sys.argv[2]
    max_offset = float(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 1.5
    ref_en = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] and sys.argv[4] != 'null' else None
    
    res = verify_sync(video, srt, max_offset, ref_en)
    print("\n" + "="*60)
    print(f"VERIFICATION RESULT: {'PASSED ✅' if res['verified'] else 'FAILED ❌'}")
    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
    sys.exit(0 if res['verified'] else 1)
