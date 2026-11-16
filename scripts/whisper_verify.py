#!/usr/bin/env python3
"""
Whisper-Powered Cinema-Grade Subtitle Verification
Extracts speech across 3 checkpoints (Beginning ~10%, Middle ~50%, Final Act ~80%)
using faster_whisper, compares spoken dialogue vs subtitle cues, and verifies true spoken word timestamps.
"""

import sys
import os
import json
import re
import subprocess
import faster_whisper

def parse_timecode(tc):
    parts = re.split(r'[:,]', tc.strip().replace('.', ','))
    if len(parts) < 4:
        return 0.0
    h, m, s, ms = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
    return h * 3600 + m * 60 + s + ms / 1000.0

def parse_srt(srt_path):
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

def verify_sync(video_path, srt_path, max_allowed_offset_sec=1.5):
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
    
    cues = parse_srt(srt_path)
    if len(cues) < 30:
        return {'verified': False, 'error': f'Too few subtitle cues ({len(cues)})', 'checkpoints': []}
    
    # Check that subtitle covers the whole movie
    last_cue_end = cues[-1]['end']
    if last_cue_end < duration * 0.75:
        return {
            'verified': False,
            'error': f'Subtitle is incomplete (ends at {last_cue_end/60:.1f}m for {duration/60:.1f}m film)',
            'checkpoints': []
        }
    
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
            c for c in cues 
            if abs(c['start'] - target_sec) < 450 
            and len(c['text'].split()) >= 3 
            and not '♪' in c['text']
            and not c['text'].startswith('[')
            and not any(tag in c['text'].lower() for tag in ['legendas', 'tradução', 'sincronia', 'equipe', 'subtitles'])
        ]
        
        if not candidate_cues:
            candidate_cues = [c for c in cues if abs(c['start'] - target_sec) < 600]
        
        # Sort candidates by proximity to target
        candidate_cues.sort(key=lambda c: abs(c['start'] - target_sec))
        
        cp_resolved = False
        
        # Try up to 8 candidates to find clear speech
        for cue in candidate_cues[:8]:
            cue_start = cue['start']
            cue_end = cue['end']
            
            # Clip padding: 2s before start to 2s after end
            clip_start = max(0, cue_start - 2.0)
            clip_dur = min(16.0, (cue_end - cue_start) + 4.0)
            
            wav_path = f"/tmp/whisper_chk_{int(clip_start)}_{os.getpid()}.wav"
            
            try:
                # Two-stage seek: fast seek 15s before, accurate seek the rest
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
                
                # Transcribe audio slice
                segments, info = model.transcribe(wav_path, word_timestamps=True, beam_size=1)
                segments = list(segments)
                
                all_words = []
                for s in segments:
                    for w in s.words:
                        all_words.append(w)
                
                if not all_words:
                    print(f"  [DEBUG candidate without speech: {cue['start_tc']} '{cue['text'][:30]}']")
                    continue  # No speech detected in this clip, try next candidate
                
                spoken_text = ' '.join(s.text.strip() for s in segments)
                expected_rel_start = cue_start - clip_start  # ~2.0s
                
                # Find word whose start is closest to expected_rel_start
                closest_word = min(all_words, key=lambda w: abs(w.start - expected_rel_start))
                measured_offset = float(expected_rel_start - closest_word.start)
                in_sync = bool(abs(measured_offset) <= max_allowed_offset_sec)
                
                checkpoints.append({
                    'name': name,
                    'cue_timecode': f"{cue['start_tc']} --> {cue['end_tc']}",
                    'cue_text': cue['text'][:80],
                    'spoken_text': spoken_text[:80],
                    'closest_word': closest_word.word.strip(),
                    'measured_offset_sec': round(measured_offset, 2),
                    'in_sync': in_sync
                })
                
                status = '✅ PASS' if in_sync else '❌ FAIL'
                print(f"  {status} [{name}] Sub: \"{cue['text'][:40]}\" | Audio: \"{spoken_text[:40]}\" | Offset: {measured_offset:+.2f}s")
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
                'error': 'Nenhuma fala audível detectada nos candidatos desse trecho',
                'in_sync': False
            })
            print(f"  ⚠️ FAIL [{name}] Nenhuma fala detectada")
    
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
        print("Usage: whisper_verify.py <video_path> <srt_path> [max_offset_sec]")
        sys.exit(1)
    
    video = sys.argv[1]
    srt = sys.argv[2]
    max_offset = float(sys.argv[3]) if len(sys.argv) > 3 else 1.5
    
    res = verify_sync(video, srt, max_offset)
    print("\n" + "="*60)
    print(f"VERIFICATION RESULT: {'PASSED ✅' if res['verified'] else 'FAILED ❌'}")
    print(json.dumps(res, indent=2, ensure_ascii=False, default=str))
    sys.exit(0 if res['verified'] else 1)
