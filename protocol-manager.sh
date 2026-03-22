#!/bin/bash
set -euo pipefail

TARGET="${1:-}"
ACTION="${2:-}"

if [[ -z "${TARGET}" || -z "${ACTION}" ]]; then
  echo "Uso: protocol-manager.sh <target> <action>"
  echo "Targets: ssh|v2ray|trojan|shadowsocks|badvpn|slowdns|squid"
  echo "Actions: start|stop|restart|status|open-ports"
  exit 1
fi

service_candidates() {
  case "${TARGET}" in
    ssh) echo "ssh sshd dropbear stunnel4 stunnel" ;;
    v2ray) echo "xray v2ray" ;;
    trojan) echo "trojan trojan-go" ;;
    shadowsocks) echo "shadowsocks-libev shadowsocks-rust ssserver shadowsocks" ;;
    squid) echo "squid squid3" ;;
    *) echo "" ;;
  esac
}

ports_for_target() {
  case "${TARGET}" in
    ssh) echo "tcp:22 tcp:143 tcp:443" ;;
    v2ray) echo "tcp:443 tcp:80" ;;
    trojan) echo "tcp:8443 tcp:443" ;;
    shadowsocks) echo "tcp:8388 udp:8388" ;;
    badvpn) echo "udp:7300" ;;
    slowdns) echo "udp:5300" ;;
    squid) echo "tcp:8080 tcp:3128" ;;
    *) echo "" ;;
  esac
}

systemctl_exists() {
  command -v systemctl >/dev/null 2>&1
}

service_exists() {
  local svc="$1"
  if systemctl_exists; then
    systemctl list-unit-files "${svc}.service" --no-legend 2>/dev/null | grep -q "${svc}.service"
    return
  fi
  service "${svc}" status >/dev/null 2>&1
}

service_state() {
  local svc="$1"
  if systemctl_exists; then
    systemctl is-active "${svc}" 2>/dev/null || true
  else
    if service "${svc}" status >/dev/null 2>&1; then
      echo "active"
    else
      echo "inactive"
    fi
  fi
}

control_service() {
  local svc="$1"
  local op="$2"
  if ! service_exists "${svc}"; then
    return 1
  fi
  if systemctl_exists; then
    systemctl "${op}" "${svc}" >/dev/null 2>&1 || return 1
  else
    service "${svc}" "${op}" >/dev/null 2>&1 || return 1
  fi
  return 0
}

ensure_port_open() {
  local item="$1"
  local proto="${item%%:*}"
  local port="${item##*:}"

  if command -v iptables >/dev/null 2>&1; then
    iptables -C INPUT -p "${proto}" --dport "${port}" -j ACCEPT >/dev/null 2>&1 || \
      iptables -I INPUT -p "${proto}" --dport "${port}" -j ACCEPT >/dev/null 2>&1 || true
  fi

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -C INPUT -p "${proto}" --dport "${port}" -j ACCEPT >/dev/null 2>&1 || \
      ip6tables -I INPUT -p "${proto}" --dport "${port}" -j ACCEPT >/dev/null 2>&1 || true
  fi

  if command -v ufw >/dev/null 2>&1; then
    ufw allow "${port}/${proto}" >/dev/null 2>&1 || true
  fi
}

run_badvpn() {
  case "${ACTION}" in
    start)
      if pgrep -f badvpn-udpgw >/dev/null 2>&1; then
        echo "BadVPN ya estaba activo"
      else
        nohup badvpn-udpgw --listen-addr 0.0.0.0:7300 --max-clients 1000 --max-connections-for-client 20 >/tmp/badvpn.log 2>&1 &
        sleep 1
        pgrep -f badvpn-udpgw >/dev/null 2>&1 && echo "BadVPN iniciado" || { echo "No se pudo iniciar BadVPN"; exit 1; }
      fi
      ;;
    stop)
      pkill -f badvpn-udpgw >/dev/null 2>&1 || true
      echo "BadVPN detenido"
      ;;
    restart)
      pkill -f badvpn-udpgw >/dev/null 2>&1 || true
      sleep 1
      nohup badvpn-udpgw --listen-addr 0.0.0.0:7300 --max-clients 1000 --max-connections-for-client 20 >/tmp/badvpn.log 2>&1 &
      sleep 1
      pgrep -f badvpn-udpgw >/dev/null 2>&1 && echo "BadVPN reiniciado" || { echo "No se pudo reiniciar BadVPN"; exit 1; }
      ;;
    status)
      pgrep -f badvpn-udpgw >/dev/null 2>&1 && echo "BadVPN activo" || echo "BadVPN inactivo"
      ;;
    open-ports)
      ensure_port_open "udp:7300"
      echo "Puerto UDP 7300 abierto"
      ;;
    *)
      echo "Accion invalida para BadVPN"
      exit 1
      ;;
  esac
}

run_slowdns() {
  local priv_key="/etc/slowdns/key.priv"
  case "${ACTION}" in
    start)
      if pgrep -f dnstt-server >/dev/null 2>&1; then
        echo "SlowDNS ya estaba activo"
      else
        if [[ ! -f "${priv_key}" ]]; then
          echo "No existe ${priv_key}. Configura SlowDNS primero."
          exit 1
        fi
        nohup dnstt-server -udp :5300 -privkey-file "${priv_key}" 127.0.0.1:22 >/tmp/slowdns.log 2>&1 &
        sleep 1
        pgrep -f dnstt-server >/dev/null 2>&1 && echo "SlowDNS iniciado" || { echo "No se pudo iniciar SlowDNS"; exit 1; }
      fi
      ;;
    stop)
      pkill -f dnstt-server >/dev/null 2>&1 || true
      echo "SlowDNS detenido"
      ;;
    restart)
      pkill -f dnstt-server >/dev/null 2>&1 || true
      sleep 1
      if [[ ! -f "${priv_key}" ]]; then
        echo "No existe ${priv_key}. Configura SlowDNS primero."
        exit 1
      fi
      nohup dnstt-server -udp :5300 -privkey-file "${priv_key}" 127.0.0.1:22 >/tmp/slowdns.log 2>&1 &
      sleep 1
      pgrep -f dnstt-server >/dev/null 2>&1 && echo "SlowDNS reiniciado" || { echo "No se pudo reiniciar SlowDNS"; exit 1; }
      ;;
    status)
      pgrep -f dnstt-server >/dev/null 2>&1 && echo "SlowDNS activo" || echo "SlowDNS inactivo"
      ;;
    open-ports)
      ensure_port_open "udp:5300"
      echo "Puerto UDP 5300 abierto"
      ;;
    *)
      echo "Accion invalida para SlowDNS"
      exit 1
      ;;
  esac
}

run_service_group() {
  local services
  services="$(service_candidates)"
  local found=0
  local changed=0

  for svc in ${services}; do
    if service_exists "${svc}"; then
      found=1
      case "${ACTION}" in
        start|stop|restart)
          if control_service "${svc}" "${ACTION}"; then
            echo "${svc}: ${ACTION} OK"
            changed=1
          else
            echo "${svc}: ${ACTION} ERROR"
          fi
          ;;
        status)
          echo "${svc}: $(service_state "${svc}")"
          ;;
        open-ports)
          ;;
        *)
          echo "Accion invalida"
          exit 1
          ;;
      esac
    fi
  done

  if [[ "${ACTION}" == "open-ports" ]]; then
    local ports
    ports="$(ports_for_target)"
    for p in ${ports}; do
      ensure_port_open "${p}"
    done
    echo "Puertos actualizados para ${TARGET}: ${ports}"
    return
  fi

  if [[ "${ACTION}" == "status" ]]; then
    local ports
    ports="$(ports_for_target)"
    for item in ${ports}; do
      local proto="${item%%:*}"
      local port="${item##*:}"
      local listening="no"
      if command -v ss >/dev/null 2>&1 && ss -lntup 2>/dev/null | grep -E "[:.]${port} " >/dev/null 2>&1; then
        listening="yes"
      fi
      echo "port ${port}/${proto}: ${listening}"
    done
  fi

  if [[ ${found} -eq 0 && "${TARGET}" != "badvpn" && "${TARGET}" != "slowdns" ]]; then
    if [[ "${ACTION}" == "start" || "${ACTION}" == "restart" ]]; then
      case "${TARGET}" in
        ssh)
          /bin/bash "$(dirname "$0")/setup" --ssh >/dev/null 2>&1 || true
          echo "No se detectaron servicios SSH/Dropbear instalados. Se intento ejecutar setup --ssh."
          return
          ;;
        v2ray)
          /bin/bash "$(dirname "$0")/setup" --v2ray >/dev/null 2>&1 || true
          echo "No se detecto Xray/V2Ray instalado. Se intento ejecutar setup --v2ray."
          return
          ;;
        trojan)
          /bin/bash "$(dirname "$0")/setup" --trojan >/dev/null 2>&1 || true
          echo "No se detecto Trojan instalado. Se intento ejecutar setup --trojan."
          return
          ;;
        shadowsocks)
          /bin/bash "$(dirname "$0")/setup" --shadowsocks >/dev/null 2>&1 || true
          echo "No se detecto Shadowsocks instalado. Se intento ejecutar setup --shadowsocks."
          return
          ;;
      esac
    fi

    if [[ "${ACTION}" == "status" ]]; then
      echo "No se encontro ningun servicio instalado para ${TARGET}."
      return
    fi

    echo "No se encontro ningun servicio instalado para ${TARGET}."
    exit 1
  fi

  if [[ "${ACTION}" != "status" && "${ACTION}" != "open-ports" && ${changed} -eq 0 && "${TARGET}" != "badvpn" && "${TARGET}" != "slowdns" ]]; then
    echo "No se pudieron aplicar cambios sobre servicios de ${TARGET}."
    exit 1
  fi
}

case "${TARGET}" in
  badvpn)
    run_badvpn
    ;;
  slowdns)
    run_slowdns
    ;;
  ssh|v2ray|trojan|shadowsocks|squid)
    run_service_group
    ;;
  *)
    echo "Target invalido: ${TARGET}"
    exit 1
    ;;
esac
