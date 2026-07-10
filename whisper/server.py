"""
BARCELLOMETRO - Whisper sidecar
Trascrizione audio (italiano) via faster-whisper su CPU.
Endpoint:
  GET  /health              -> {"ok": true, "model": "..."}
  POST /transcribe?lang=it  -> body: WAV bytes, ritorna {"text": "...", "duration": s}
"""
import io
import os
import sys
import time

from flask import Flask, request, jsonify

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
PORT = int(os.environ.get("WHISPER_PORT", "3901"))

print(f"[whisper] Caricamento modello '{MODEL_NAME}' (primo avvio: download automatico)...")
t0 = time.time()
try:
    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL_NAME, device="cpu", compute_type="int8")
except Exception as e:
    print(f"[whisper] ERRORE caricamento modello: {e}")
    sys.exit(1)
print(f"[whisper] Modello pronto in {time.time() - t0:.1f}s - in ascolto su porta {PORT}")

app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"ok": True, "model": MODEL_NAME})


@app.post("/transcribe")
def transcribe():
    data = request.get_data()
    if not data or len(data) < 1000:
        return jsonify({"text": "", "duration": 0})
    lang = request.args.get("lang", "it")
    t = time.time()
    try:
        segments, info = model.transcribe(
            io.BytesIO(data),
            language=lang,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=1,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
    except Exception as e:
        print(f"[whisper] errore trascrizione: {e}")
        return jsonify({"text": "", "error": str(e)}), 500
    dur = time.time() - t
    if text:
        print(f"[whisper] ({dur:.1f}s) {text[:120]}")
    return jsonify({"text": text, "duration": round(dur, 2)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=PORT, threaded=True)
