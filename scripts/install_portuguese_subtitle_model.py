"""Install the pinned locale classifier for the subtitle worker's Python."""
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.request import urlopen


REVISION = "f58c96b242d63b2c48f98cfb00045e4cf8cdf6b0"
CHECKSUM = "00add97008d34b43803471daedb60d910de9b1eac15fc00814c336a4b23f0f6d"


def checksum(file):
    with file.open("rb") as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


if __name__ == "__main__":
    model = Path(sys.argv[1]) if len(sys.argv) > 1 else (
        Path(__file__).resolve().parent.parent
        / "data/subtitle_models/portuguese-locale/model_quantized.ftz"
    )
    model.parent.mkdir(parents=True, exist_ok=True)
    if not model.is_file() or checksum(model) != CHECKSUM:
        url = f"https://huggingface.co/duarteocarmo/fasttext-euptvid/resolve/{REVISION}/model_quantized.ftz"
        temporary = model.with_suffix(".download")
        try:
            with urlopen(url, timeout=60) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if checksum(temporary) != CHECKSUM:
                raise RuntimeError("Checksum do modelo fastText incorreto.")
            temporary.replace(model)
        finally:
            temporary.unlink(missing_ok=True)
    packages = model.parent / "python"
    sys.path.insert(0, str(packages))
    try:
        import fasttext
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "--target",
                        str(packages), "fasttext-wheel==0.9.2", "numpy<2"], check=True)
    print(f"Classificador instalado em {model}")
