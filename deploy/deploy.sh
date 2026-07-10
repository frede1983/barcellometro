#!/usr/bin/env bash
# BARCELLOMETRO - Deploy su VPS (Ubuntu/Debian)
# Uso: bash deploy.sh
set -e

APP_DIR=/opt/barcellometro
REPO=https://github.com/frede1983/barcellometro.git

echo "=== BARCELLOMETRO deploy ==="

# 1. Dipendenze di sistema
apt-get update -qq
apt-get install -y -qq ffmpeg python3 python3-pip git curl >/dev/null

# Node 20+ (NodeSource) se mancante o troppo vecchio
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "[ok] node $(node -v), ffmpeg, python3"

# 2. Codice
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"

# 3. Dipendenze app
npm install --no-audit --no-fund
pip3 install -q -r whisper/requirements.txt --break-system-packages 2>/dev/null || pip3 install -q -r whisper/requirements.txt

# 4. Config
if [ ! -f .env ]; then
  cp .env.example .env
  # Su VPS: modello whisper leggero e password obbligatoria
  sed -i 's/^WHISPER_MODEL=.*/WHISPER_MODEL=base/' .env
  echo "[!] Creato .env: IMPOSTA DASH_PASSWORD e le altre chiavi, poi riavvia i servizi"
fi

# 5. CLI Claude Code (per AI_PROVIDER=claude-sdk)
if ! command -v claude >/dev/null; then
  npm install -g @anthropic-ai/claude-code >/dev/null 2>&1 || true
  echo "[!] CLI claude installata: autenticala con 'claude setup-token' (subscription)"
fi

# 6. Servizi systemd
cp deploy/barcellometro.service deploy/barcellometro-whisper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable barcellometro-whisper barcellometro
systemctl restart barcellometro-whisper barcellometro

# 7. Firewall (se ufw attivo)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 3900/tcp >/dev/null || true
fi

echo ""
echo "=== FATTO ==="
echo "Dashboard: http://$(hostname -f):3900  (o http://IP:3900)"
echo "Log:       journalctl -u barcellometro -f"
