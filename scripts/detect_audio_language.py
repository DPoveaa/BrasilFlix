#!/usr/bin/env python3
"""
BrasilFlix - Speech Language Detector
Detecta o idioma real falado em uma amostra de áudio (WAV mono 16kHz) usando faster-whisper.
Retorna resultado em formato JSON limpo no stdout.
"""

import sys
import json
import os

def detect(audio_path, model_size="tiny"):
    if not os.path.exists(audio_path):
        return {"error": f"Arquivo de áudio não encontrado: {audio_path}"}
    
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"error": "faster-whisper não está instalado no ambiente Python"}

    try:
        # Usa modelo tiny em int8 (CPU) para execução ultrarrápida (~1s)
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        
        # Detecta idioma
        segments, info = model.transcribe(
            audio_path,
            beam_size=1,
            vad_filter=True, # filtra silêncios automaticamente
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        # Coleta texto dos primeiros segmentos (amostra breve para conferência)
        sample_text = []
        for s in segments:
            sample_text.append(s.text.strip())
            if len(" ".join(sample_text)) > 150:
                break
        
        return {
            "success": True,
            "language": info.language,
            "probability": round(info.language_probability, 3),
            "duration": round(info.duration, 2),
            "sample_text": " ".join(sample_text)[:200]
        }
    except Exception as e:
        return {"error": str(e)}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: detect_audio_language.py <caminho_do_audio.wav> [model_size]"}))
        sys.exit(1)
        
    audio_file = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "tiny"
    
    result = detect(audio_file, model_name)
    print(json.dumps(result, ensure_ascii=False))

