"""
BARCELLOMETRO - Whisper sidecar
Trascrizione audio (italiano) via faster-whisper su CPU.
Endpoint:
  GET  /health              -> {"ok": true, "model": "..."}
  POST /transcribe?lang=it  -> body: WAV bytes, ritorna {"text": "...", "duration": s}
  POST /reload              -> body: {"model": "base"} cambia modello a caldo
Config: env WHISPER_MODEL/WHISPER_PORT, con override da ../config.json (UI).
"""
import io
import json
import os
import sys
import threading
import time

from flask import Flask, request, jsonify, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_JSON = os.path.join(BASE_DIR, "..", "config.json")
VALID_MODELS = {"tiny", "base", "small", "medium", "large-v3"}


def read_config_overlay(key, default):
    try:
        with open(CONFIG_JSON, encoding="utf-8") as f:
            data = json.load(f)
        return data.get(key, default)
    except Exception:
        return default


MODEL_NAME = str(read_config_overlay("WHISPER_MODEL", os.environ.get("WHISPER_MODEL", "small")))
PORT = int(os.environ.get("WHISPER_PORT", "3901"))
if MODEL_NAME not in VALID_MODELS:
    MODEL_NAME = "small"

lock = threading.Lock()
model = None


def load_model(name):
    global model, MODEL_NAME
    from faster_whisper import WhisperModel
    print(f"[whisper] Caricamento modello '{name}'...")
    t0 = time.time()
    new_model = WhisperModel(name, device="cpu", compute_type="int8")
    with lock:
        model = new_model
        MODEL_NAME = name
    print(f"[whisper] Modello '{name}' pronto in {time.time() - t0:.1f}s")


try:
    load_model(MODEL_NAME)
except Exception as e:
    print(f"[whisper] ERRORE caricamento modello: {e}")
    sys.exit(1)

print(f"[whisper] In ascolto su porta {PORT}")
app = Flask(__name__)


@app.get("/health")
def health():
    return jsonify({"ok": model is not None, "model": MODEL_NAME})


@app.post("/reload")
def reload_model():
    name = str((request.get_json(silent=True) or {}).get("model", "")).strip()
    if name not in VALID_MODELS:
        return jsonify({"ok": False, "error": f"modello non valido (validi: {sorted(VALID_MODELS)})"}), 400
    if name == MODEL_NAME:
        return jsonify({"ok": True, "model": MODEL_NAME, "note": "gia' attivo"})
    try:
        load_model(name)
        return jsonify({"ok": True, "model": MODEL_NAME})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/tts")
def tts():
    """Sintesi vocale italiana via Edge TTS. Body: {"text": "...", "voice": "it-IT-DiegoNeural"}"""
    j = request.get_json(silent=True) or {}
    text = str(j.get("text", "")).strip()[:300]
    voice = str(j.get("voice", "it-IT-DiegoNeural"))
    if not text:
        return jsonify({"ok": False, "error": "testo mancante"}), 400
    try:
        import asyncio
        import edge_tts

        buf = io.BytesIO()

        async def run():
            comm = edge_tts.Communicate(text, voice)
            async for chunk in comm.stream():
                if chunk["type"] == "audio":
                    buf.write(chunk["data"])

        asyncio.run(run())
        audio = buf.getvalue()
        if not audio:
            return jsonify({"ok": False, "error": "audio vuoto"}), 500
        return Response(audio, mimetype="audio/mpeg")
    except Exception as e:
        print(f"[tts] errore: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/transcribe")
def transcribe():
    data = request.get_data()
    if not data or len(data) < 1000 or model is None:
        return jsonify({"text": "", "duration": 0})
    lang = request.args.get("lang", "it")
    t = time.time()
    try:
        with lock:
            current = model
        segments, info = current.transcribe(
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
