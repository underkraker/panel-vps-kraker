#!/bin/bash
set -euo pipefail

BASE_DIR="/home/kraker/Escritorio/script chumo/web-panel"
OUT_DIR="${BASE_DIR}/backups"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "${OUT_DIR}"

tar -czf "${OUT_DIR}/web-panel-backup-${STAMP}.tar.gz" \
  -C "${BASE_DIR}" \
  config.json users.json logs

echo "Backup generado: ${OUT_DIR}/web-panel-backup-${STAMP}.tar.gz"
