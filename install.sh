#!/bin/bash
set -euo pipefail

SERVICE_NAME="kraker-vps-panel"
REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="${REPO_DIR}/web-panel"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ "${EUID}" -ne 0 ]]; then
  echo "[ERROR] Ejecuta este instalador como root: sudo bash install.sh"
  exit 1
fi

if [[ ! -d "${PANEL_DIR}" ]]; then
  echo "[ERROR] No se encontro la carpeta web-panel en ${PANEL_DIR}"
  exit 1
fi

echo "[1/6] Instalando dependencias base..."
apt-get update -y
apt-get install -y curl ca-certificates gnupg

NODE_MAJOR=""
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
fi

if [[ -z "${NODE_MAJOR}" || "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[2/6] Instalando Node.js 20.x..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "[2/6] Node.js ya instalado (v$(node -v))"
fi

echo "[3/6] Instalando dependencias del panel..."
npm --prefix "${PANEL_DIR}" install --omit=dev

if [[ ! -f "${PANEL_DIR}/config.json" && -f "${PANEL_DIR}/config.example.json" ]]; then
  echo "[4/6] Creando config.json desde config.example.json..."
  cp "${PANEL_DIR}/config.example.json" "${PANEL_DIR}/config.json"
fi

echo "[5/6] Instalando servicio systemd..."
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

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

echo "[6/6] Verificando servicio..."
systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,12p'

echo
echo "Instalacion completa."
echo "URL local: http://localhost:3000"
echo "Si usas firewall, abre el puerto 3000/TCP."
echo "Password inicial: admin123 (cambiala en Ajustes del panel)."
