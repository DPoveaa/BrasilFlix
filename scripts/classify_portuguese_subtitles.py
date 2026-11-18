"""Classify the Portuguese variety of subtitle dialogue with fastText."""
import json
import statistics
import sys
from pathlib import Path


def classify(model, cues):
    words = " ".join(cues).split()
    if len(words) < 50:
        return {"variety": "uncertain", "chunks": 0}
    chunks = [" ".join(words[start:start + 100]) for start in range(0, len(words), 100)
              if len(words[start:start + 100]) >= 50]
    if len(chunks) > 24:
        chunks = [chunks[round(index * (len(chunks) - 1) / 23)] for index in range(24)]
    labels, probabilities = model.predict(chunks)
    scores = [float(prob[0]) if tag[0] == "__label__PT_PT" else 1 - float(prob[0])
              for tag, prob in zip(labels, probabilities)]
    median = statistics.median(scores)
    pt = sum(score >= .70 for score in scores)
    br = sum(score < .50 for score in scores)
    variety = "uncertain"
    if pt >= 3 and pt / len(scores) >= .55 and median >= .75:
        variety = "pt-PT"
    elif br >= 2 and br / len(scores) >= .55 and median <= .48 and pt / len(scores) <= .25:
        variety = "pt-BR"
    return {"variety": variety, "chunks": len(scores), "ptVotes": pt, "brVotes": br,
            "medianPt": round(median, 4)}


if __name__ == "__main__":
    model_path = Path(sys.argv[1])
    sys.path.insert(0, str(model_path.parent / "python"))
    import fasttext

    print(json.dumps(classify(fasttext.load_model(str(model_path)), json.load(sys.stdin))))
