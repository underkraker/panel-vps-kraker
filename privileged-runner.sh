#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMMAND_NAME="${1:-}"
shift || true

if [[ -z "${COMMAND_NAME}" ]]; then
  echo "Uso: privileged-runner.sh <command> [args...]"
  exit 1
fi

case "${COMMAND_NAME}" in
  setup|clean_iptables.sh|protocol-manager.sh|HTools/sockspy.sh|HTools/BadVPN/ARM.sh|HTools/LIMITADOR/killSSH.sh|HTools/Python/SocksPY-lite.sh|HTools/CLASH/mt.sh|HTools/CLASH/mt_v2.0.5.sh|HTools/CLASH/ClashForAndroidGLOBAL.sh|HTools/AFK/tumbs.sh)
    ;;
  *)
    echo "Comando no permitido en privileged-runner"
    exit 1
    ;;
esac

TARGET="${ROOT_DIR}/${COMMAND_NAME}"
if [[ ! -f "${TARGET}" ]]; then
  echo "Script no encontrado: ${COMMAND_NAME}"
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  exec /bin/bash "${TARGET}" "$@"
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo no disponible para elevacion controlada"
  exit 1
fi

exec sudo -n /bin/bash "${TARGET}" "$@"
