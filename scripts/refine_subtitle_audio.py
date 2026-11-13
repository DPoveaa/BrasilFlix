#!/usr/bin/env python3
"""
BrasilFlix - Subtitle Sync via ffsubsync
Sincroniza legendas SRT com o áudio real do vídeo usando ffsubsync,
que analisa o padrão de fala/silêncio ao longo de todo o arquivo
(não apenas o início), corrigindo offset E drift de forma confiável.

Uso: python3 refine_subtitle_audio.py <video_path> <srt_path>
Saída: JSON com resultado da sincronização (impresso em stdout)
"""

import sys
import os
import json
import shutil
import tempfile


def run_ffsubsync(video_path, srt_path):
    """Roda ffsubsync via API Python e retorna resultado."""
    if not os.path.exists(video_path):
        return {"adjusted": False, "error": f"Vídeo não encontrado: {video_path}"}
    if not os.path.exists(srt_path):
        return {"adjusted": False, "error": f"SRT não encontrado: {srt_path}"}

    try:
        from ffsubsync.ffsubsync import make_parser, run as ffsubsync_run
    except ImportError:
        return {"adjusted": False, "error": "ffsubsync não disponível. Instale com: pip install ffsubsync"}

    # Cria arquivo temporário para a saída (não sobrescreve o original até confirmar sucesso)
    tmp_out = srt_path + ".ffsubsync_tmp.srt"

    try:
        parser = make_parser()
        args = parser.parse_args([
            video_path,
            "-i", srt_path,
            "-o", tmp_out,
            "--no-fix-framerate",   # Não alterar framerate, só offset/drift temporal
            "--gss",                 # Golden Section Search: busca o melhor offset global
        ])

        result = ffsubsync_run(args)

        # Verifica se o arquivo de saída foi criado e tem tamanho razoável
        if not os.path.exists(tmp_out) or os.path.getsize(tmp_out) < 50:
            return {"adjusted": False, "error": "ffsubsync não gerou saída válida"}

        # Verifica se houve mudança real (compara tamanho como sanidade básica)
        original_size = os.path.getsize(srt_path)
        new_size = os.path.getsize(tmp_out)

        # Lê ambos para comparar conteúdo
        with open(srt_path, 'r', encoding='utf-8', errors='ignore') as f:
            original_content = f.read()
        with open(tmp_out, 'r', encoding='utf-8', errors='ignore') as f:
            new_content = f.read()

        if original_content.strip() == new_content.strip():
            os.remove(tmp_out)
            return {
                "adjusted": False,
                "reason": "ffsubsync não detectou necessidade de ajuste (legenda já sincronizada)"
            }

        # Substitui o original pelo arquivo sincronizado
        shutil.move(tmp_out, srt_path)

        # Tenta extrair o offset calculado do resultado do ffsubsync
        offset_info = {}
        if hasattr(result, '__dict__'):
            offset_info = result.__dict__
        elif isinstance(result, dict):
            offset_info = result

        return {
            "adjusted": True,
            "tool": "ffsubsync",
            "original_size": original_size,
            "new_size": new_size,
            "reason": "Legenda sincronizada com áudio via ffsubsync (análise completa offset+drift)",
            "ffsubsync_result": str(offset_info) if offset_info else "ok"
        }

    except Exception as e:
        # Limpa o temporário se existir
        if os.path.exists(tmp_out):
            try:
                os.remove(tmp_out)
            except Exception:
                pass
        return {"adjusted": False, "error": f"Exceção no ffsubsync: {str(e)}"}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({
            "adjusted": False,
            "error": "Uso: refine_subtitle_audio.py <video_path> <srt_path>"
        }))
        sys.exit(1)

    video = sys.argv[1]
    srt = sys.argv[2]
    out = run_ffsubsync(video, srt)
    print(json.dumps(out, ensure_ascii=False))
