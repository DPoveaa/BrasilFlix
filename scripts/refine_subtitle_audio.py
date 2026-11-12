#!/usr/bin/env python3
"""
BrasilFlix - Subtitle Audio Speech Refiner
Calibra com precisão cirúrgica o início das falas de um arquivo .srt contra o áudio real do vídeo.
Elimina o adiantamento artificial (lead time de 1-4s) típico de legendas amadoras,
garantindo que a legenda só apareça quando o ator realmente começar a falar.

Roda em ~2 segundos utilizando faster-whisper com Silero VAD integrado.
Totalmente seguro: se houver qualquer dúvida ou desvio anômalo, mantém a legenda original intacta.
"""

import sys
import os
import re
import json
import subprocess
import tempfile

def parse_timecode_to_sec(tc_str):
    """Converte '00:01:23,456' ou '00:01:23.456' para float de segundos."""
    try:
        tc = tc_str.strip().replace(',', '.')
        parts = tc.split(':')
        if len(parts) != 3:
            return 0.0
        h = float(parts[0])
        m = float(parts[1])
        s = float(parts[2])
        return h * 3600.0 + m * 60.0 + s
    except Exception:
        return 0.0

def format_sec_to_timecode(sec):
    """Converte float de segundos para timecode SRT '00:01:23,456'."""
    if sec < 0:
        sec = 0.0
    h = int(sec // 3600)
    rem = sec % 3600
    m = int(rem // 60)
    s = int(rem % 60)
    ms = int(round((rem % 1) * 1000))
    if ms >= 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def is_dialogue_cue(text):
    """Verifica se o texto do cue é um diálogo real e não um letreiro/crédito isolado."""
    clean = re.sub(r'<[^>]+>', '', text).strip()
    clean = re.sub(r'[\(\[\{].*?[\)\]\}]', '', clean).strip()
    words = clean.split()
    if len(words) < 2:
        return False
    # Filtra palavras típicas de letreiros / créditos
    lower = clean.lower()
    if re.search(r'\b(legendas?|traducao|tradução|estafeta|substantivo|apresenta|distribui|direcao|direção)\b', lower):
        if len(words) <= 5:
            return False
    return True

def refine(video_path, srt_path):
    if not os.path.exists(video_path):
        return {"adjusted": False, "error": f"Vídeo não encontrado: {video_path}"}
    if not os.path.exists(srt_path):
        return {"adjusted": False, "error": f"SRT não encontrado: {srt_path}"}

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"adjusted": False, "error": "faster-whisper não disponível"}

    # 1. Lê e analisa o arquivo SRT
    try:
        with open(srt_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception as e:
        return {"adjusted": False, "error": f"Falha ao ler SRT: {e}"}

    cue_pattern = re.compile(
        r'(\d+)\s*\n'
        r'(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,\.]\d{3})\s*\n'
        r'([\s\S]*?)(?=\n\s*\n\d+\s*\n|\n\s*$)',
        re.MULTILINE
    )

    matches = list(cue_pattern.finditer(content))
    if len(matches) < 5:
        return {"adjusted": False, "reason": "Poucos cues no SRT para calibração"}

    # Encontra o primeiro cue de diálogo falado significativo (nos primeiros 5 minutos)
    target_cue = None
    target_start_sec = None
    target_text = ""

    for m in matches:
        start_sec = parse_timecode_to_sec(m.group(2))
        text = m.group(4).strip()
        if start_sec > 300.0: # mais de 5 minutos sem fala relevante
            break
        if is_dialogue_cue(text):
            target_cue = m
            target_start_sec = start_sec
            target_text = text
            break

    if target_start_sec is None:
        return {"adjusted": False, "reason": "Nenhum diálogo inicial identificado na legenda"}

    # 2. Extrai amostra curta de áudio focada (PCM 16kHz mono) ao redor do diálogo
    sample_start = max(0.0, target_start_sec - 12.0)
    sample_duration = 40.0 # 40s é suficiente e ultra-rápido

    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_audio:
        tmp_wav_path = tmp_audio.name

    try:
        ffmpeg_cmd = [
            'ffmpeg', '-nostdin', '-y',
            '-ss', f"{sample_start:.3f}",
            '-i', video_path,
            '-t', f"{sample_duration:.3f}",
            '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
            tmp_wav_path
        ]
        res = subprocess.run(ffmpeg_cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12)
        if res.returncode != 0 or not os.path.exists(tmp_wav_path) or os.path.getsize(tmp_wav_path) < 1000:
            return {"adjusted": False, "error": "Falha na extração de amostra de áudio via FFmpeg"}

        # 3. Transcrição com detecção de voz neural (faster-whisper + Silero VAD)
        model = WhisperModel('tiny', device='cpu', compute_type='int8')
        segments, info = model.transcribe(
            tmp_wav_path,
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400)
        )

        detected_speech = []
        for s in segments:
            abs_start = sample_start + s.start
            abs_end = sample_start + s.end
            text = s.text.strip()
            if len(text) > 1:
                detected_speech.append({
                    "start": abs_start,
                    "end": abs_end,
                    "text": text
                })

        if not detected_speech:
            return {"adjusted": False, "reason": "Nenhuma fala detectada pelo modelo na janela de áudio"}

        # Localiza o primeiro segmento de fala correspondente
        # Procura a fala mais próxima do target_start_sec (na faixa de -2s a +6s)
        best_speech = None
        min_distance = float('inf')

        for sp in detected_speech:
            diff = sp["start"] - target_start_sec
            # A fala pode estar até 6 segundos depois da legenda (legenda adiantada)
            # ou no máximo 1 segundo antes da legenda (legenda atrasada)
            if -1.2 <= diff <= 6.5:
                if abs(diff) < min_distance:
                    min_distance = abs(diff)
                    best_speech = sp

        if not best_speech:
            # Fallback: pega a primeira fala que começa logo após o silêncio de abertura
            first_sp = detected_speech[0]
            diff = first_sp["start"] - target_start_sec
            if -1.0 <= diff <= 6.0:
                best_speech = first_sp

        if not best_speech:
            return {"adjusted": False, "reason": "Não foi possível parear a fala do áudio com a legenda com certeza"}

        real_speech_start = best_speech["start"]
        offset_delta = real_speech_start - target_start_sec

        # 4. Avalia a necessidade de calibração
        # Se a diferença for menor que 300ms, o alinhamento já é natural e imperceptível
        if abs(offset_delta) < 0.30:
            return {
                "adjusted": False,
                "reason": f"Alinhamento já ideal (desvio de {offset_delta*1000:.0f}ms está dentro da tolerância de 300ms)",
                "detected_speech_start": round(real_speech_start, 3),
                "sub_speech_start": round(target_start_sec, 3)
            }

        # Se a legenda estiver adiantada entre +0.3s e +5.5s (o caso típico de fansub/lead time excessivo):
        # aplica o ajuste para todos os cues do arquivo
        if 0.30 <= offset_delta <= 5.50:
            def shift_cue(match):
                idx = match.group(1)
                st_sec = parse_timecode_to_sec(match.group(2)) + offset_delta
                et_sec = parse_timecode_to_sec(match.group(3)) + offset_delta
                cue_text = match.group(4)
                return f"{idx}\n{format_sec_to_timecode(st_sec)} --> {format_sec_to_timecode(et_sec)}\n{cue_text}"

            new_content = cue_pattern.sub(shift_cue, content)
            with open(srt_path, 'w', encoding='utf-8') as f:
                f.write(new_content)

            return {
                "adjusted": True,
                "offset_seconds": round(offset_delta, 3),
                "direction": "atrasada" if offset_delta > 0 else "adiantada",
                "detected_speech_text": best_speech["text"],
                "detected_speech_start": round(real_speech_start, 3),
                "original_sub_start": round(target_start_sec, 3),
                "reason": f"Compensado adiantamento de {offset_delta:.2f}s para casar com o início real da fala do ator"
            }

        return {
            "adjusted": False,
            "reason": f"Diferença de {offset_delta:.2f}s fora da margem segura de calibração automática (0.3s a 5.5s)"
        }

    except Exception as e:
        return {"adjusted": False, "error": f"Exceção durante calibração: {e}"}
    finally:
        if os.path.exists(tmp_wav_path):
            try:
                os.remove(tmp_wav_path)
            except Exception:
                pass

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"adjusted": False, "error": "Uso: refine_subtitle_audio.py <video_path> <srt_path>"}))
        sys.exit(1)

    video = sys.argv[1]
    srt = sys.argv[2]
    out = refine(video, srt)
    print(json.dumps(out, ensure_ascii=False))

