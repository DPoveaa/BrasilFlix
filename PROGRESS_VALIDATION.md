# 🛡️ Validação Inteligente Pré-FFmpeg (Áudio Real & Legenda Fixa)

> **Data de Início:** 06/11/2026  
> **Objetivo:** Implementar pipeline de validação pré-conversão para garantir qualidade máxima e evitar desperdício de CPU/GPU com releases incorretos:
> 1. **Detecção de Idioma Falado Real (Speech Language ID)**: Identificação em amostra de áudio (25s em PCM 16kHz) via `faster-whisper` (tiny int8 no CPU) para garantir que áudios marcados como dublado são realmente em Português (e não espanhol/russo/coreano).
> 2. **Detecção Visual de Legenda Fixa (Hardsub OCR multi-ponto)**: Amostragem de frames nos 22% inferiores em 5 pontos do vídeo com `tesseract-ocr` para detectar e rejeitar vídeos com legendas estrangeiras gravadas na imagem (ex: cirílico/russo, asiático/chinês/coreano) antes de processar.

---

## 📌 Status das Etapas

- [x] **Etapa 1:** Diagnóstico e planejamento de arquitetura (sem impacto de performance).
- [x] **Etapa 2:** Criar serviço de Detecção de Legenda Fixa (`HardsubDetectorService.js`) com amostragem multi-ponto (20%, 35%, 50%, 65%, 80%) e OCR via Tesseract com suporte a português, inglês, russo, chinês e coreano.
- [x] **Etapa 3:** Criar script helper Python (`scripts/detect_audio_language.py`) e serviço Node.js (`SpeechLanguageService.js`) com extração de 25s de áudio via FFmpeg e Language ID ultraleve (< 1s de execução).
- [x] **Etapa 4:** Integrar os dois validadores no pipeline de pré-processamento do `VideoProcessor.js` em `optimizeForTelegram` (executado antes de qualquer Remux ou Full Transcode, com suporte a troca automática para trilha PT válida quando disponível).
- [x] **Etapa 5:** Instalação das dependências necessárias no servidor Ubuntu via SSH (`tesseract-ocr`, `tesseract-ocr-por`, `tesseract-ocr-rus`, `tesseract-ocr-chi-sim`, `tesseract-ocr-kor`, `faster-whisper`).
- [ ] **Etapa 6:** Commit e push para GitHub (`origin/main`).
- [ ] **Etapa 7:** `git pull` no servidor remoto (`/mnt/ssd500/projetos/BrasilFlix`) e reinicialização do PM2 (`pm2 restart brasilflix`).
- [ ] **Etapa 8:** Acompanhamento dos logs e validação em execução real no servidor.

---

## 🔍 Regras de Decisão Implementadas

1. **Softsub vs. Hardsub (OCR):**
   - Softsubs (trilhas do container MKV/MP4) são ignorados pelo extrator de frames brutos (`-map 0:v:0`). Qualquer texto detectado na região inferior da imagem é **hardsub real** gravado nos pixels.
   - **Em vídeos Dublados:**
     - Se detectar legenda fixa estrangeira (Cirílico >= 2 amostras ou Asiático >= 2 amostras): o release é **imediatamente rejeitado**.
     - Se detectar texto latino persistente em quase todas as amostras (>= 4 de 5): é **rejeitado**. Textos pontuais (1 amostra) são aceitos (letreiros, placas, etc.).
   - **Em vídeos Legendados:**
     - Se for queimar legenda PT-BR via ASS/SRT e o arquivo já possuir hardsub fixo na imagem: é **rejeitado** para evitar queima sobreposta (dupla legenda ilegível).

2. **Detecção de Dublagem Real (Speech ID):**
   - O áudio da trilha selecionada é amostrado (25 segundos a 15% da duração do vídeo).
   - O detector de idioma verifica se a fala é `pt`. Se Whisper identificar com confiança (>= 70%) que a trilha é outro idioma (ex: `es`, `en`, `ko`, `ru`):
     - Testa automaticamente outras trilhas de áudio do arquivo. Se encontrar uma trilha que realmente fale `pt`, faz auto-correção.
     - Se nenhuma trilha falar português, rejeita o release antes de iniciar horas de conversão.
