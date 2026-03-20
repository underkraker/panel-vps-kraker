#!/bin/bash
set -euo pipefail

SERVICE_NAME="kraker-vps-panel"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="${REPO_DIR}/web-panel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
KEY_API_URL="${KRAKER_KEY_API_URL:-http://127.0.0.1:8799/consume}"
KEY_API_SECRET="${KRAKER_KEY_SECRET:-kraker-auto-activate-2026}"
PANEL_VERSION="${KRAKER_PANEL_VERSION:-V3.9.2}"
CREDENTIALS_API_URL="${KRAKER_CREDENTIALS_API_URL:-${KEY_API_URL%/consume}/panel-credentials}"

json_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/ }"
  printf '%s' "${value}"
}

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Ejecuta este instalador como root: sudo bash install.sh"
  exit 1
fi

if [[ ! -d "${PANEL_DIR}" ]]; then
  echo "[ERROR] No se encontro la carpeta web-panel en ${PANEL_DIR}"
  exit 1
fi

echo "[1/8] Instalando dependencias base..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg

echo "[2/8] Validando key de instalacion..."
read -r -p "Ingresa tu KEY: " PANEL_KEY
if [[ -z "${PANEL_KEY}" ]]; then
  echo "[ERROR] KEY vacia. Instalacion abortada."
  exit 1
fi

PUBLIC_IP="$(curl -4 -s https://api.ipify.org || curl -4 -s https://ipv4.icanhazip.com || echo N/A)"
OS_NAME="$(. /etc/os-release 2>/dev/null; echo "${NAME:-Linux}-${VERSION_ID:-0}" | tr ' ' '-')"
UUID_VALUE="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen 2>/dev/null || echo N/A)"

REQ_BODY=$(printf '{"key":"%s","ip":"%s","os":"%s","uuid":"%s","version":"%s"}' \
  "$(json_escape "${PANEL_KEY}")" \
  "$(json_escape "${PUBLIC_IP}")" \
  "$(json_escape "${OS_NAME}")" \
  "$(json_escape "${UUID_VALUE}")" \
  "$(json_escape "${PANEL_VERSION}")")

TMP_RESP="/tmp/kraker_key_check_$$.json"
HTTP_CODE="$(curl -sS -o "${TMP_RESP}" -w "%{http_code}" \
  -X POST "${KEY_API_URL}" \
  -H "Content-Type: application/json" \
  -H "x-activate-secret: ${KEY_API_SECRET}" \
  -d "${REQ_BODY}" || true)"

if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "[ERROR] KEY invalida o no disponible. Instalacion abortada."
  if [[ -s "${TMP_RESP}" ]]; then
    echo "[INFO] Respuesta API: $(cat "${TMP_RESP}")"
  fi
  rm -f "${TMP_RESP}"
  exit 1
fi
rm -f "${TMP_RESP}"
echo "[OK] KEY validada correctamente."

echo "[3/8] Generando password aleatoria del panel..."
PANEL_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)"
if [[ -z "${PANEL_PASS}" ]]; then
  echo "[ERROR] No se pudo generar password aleatoria."
  exit 1
fi
PASS_FILE="/root/kraker-panel-pass.txt"
{
  echo "URL: http://${PUBLIC_IP}:3000"
  echo "PASSWORD: ${PANEL_PASS}"
  echo "KEY: ${PANEL_KEY}"
  echo "CREATED_AT: $(date '+%Y-%m-%d %H:%M:%S')"
} > "${PASS_FILE}"
chmod 600 "${PASS_FILE}"

NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
fi

if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[4/8] Instalando Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[4/8] Node.js ya instalado (v$(node -v))"
fi

echo "[5/8] Instalando dependencias del panel..."
npm --prefix "${PANEL_DIR}" install --omit=dev

if [[ ! -f "${PANEL_DIR}/config.json" && -f "${PANEL_DIR}/config.example.json" ]]; then
  echo "[6/8] Creando config.json desde config.example.json..."
  cp "${PANEL_DIR}/config.example.json" "${PANEL_DIR}/config.json"
fi

echo "[7/8] Instalando servicio systemd..."
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=Kraker VPS Web Panel
After=network.target

[Service]
Type=simple
WorkingDirectory=${PANEL_DIR}
ExecStart=/usr/bin/node ${PANEL_DIR}/server.js
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=PANEL_PASS=${PANEL_PASS}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

CREDS_BODY=$(printf '{"key":"%s","panelPassword":"%s","panelUrl":"%s"}' \
  "$(json_escape "${PANEL_KEY}")" \
  "$(json_escape "${PANEL_PASS}")" \
  "$(json_escape "http://${PUBLIC_IP}:3000")")

CREDS_RESP_FILE="/tmp/kraker_panel_creds_$$.json"
CREDS_HTTP_CODE="$(curl -sS -o "${CREDS_RESP_FILE}" -w "%{http_code}" \
  -X POST "${CREDENTIALS_API_URL}" \
  -H "Content-Type: application/json" \
  -H "x-activate-secret: ${KEY_API_SECRET}" \
  -d "${CREDS_BODY}" || true)"

if [[ "${CREDS_HTTP_CODE}" != "200" ]]; then
  echo "[WARN] No se pudo notificar credenciales al bot (${CREDS_HTTP_CODE})."
  if [[ -s "${CREDS_RESP_FILE}" ]]; then
    echo "[WARN] Respuesta: $(cat "${CREDS_RESP_FILE}")"
  fi
fi
rm -f "${CREDS_RESP_FILE}"

echo "[8/8] Verificando servicio..."
systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,12p'

echo
echo "Instalacion completa."
echo "URL local: http://localhost:3000"
echo "Si usas firewall, abre el puerto 3000/TCP."
echo "Password generada: ${PANEL_PASS}"
echo "Credenciales guardadas en: ${PASS_FILE}"
