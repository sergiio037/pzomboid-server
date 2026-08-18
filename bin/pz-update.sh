#!/usr/bin/env bash
# Actualiza los binarios del servidor via SteamCMD.
# Para el servicio, actualiza, y lo vuelve a arrancar solo si estaba activo.
set -uo pipefail

: "${PZ_STEAMCMD:?}" "${PZ_SERVER_DIR:?}" "${PZ_APPID:?}" "${PZ_UNIT:?}" "${PZ_SYS_USER:?}"
BRANCH="${PZ_BRANCH:-stable}"
GREP_PAT='zombie.network.GameServer'

WAS_ACTIVE=0
systemctl is-active --quiet "$PZ_UNIT" && WAS_ACTIVE=1

# Pase lo que pase, el servidor vuelve a levantarse. Sin esto, si el proceso
# moria a mitad (timeout del panel, un update.sh reiniciando el cgroup) el
# `systemctl start` del final no se alcanzaba nunca y el servidor se quedaba
# apagado sin que nadie lo supiera.
restaurar_unidad() {
    (( WAS_ACTIVE )) && sudo -n systemctl start "$PZ_UNIT" >/dev/null 2>&1 || true
}
trap restaurar_unidad EXIT INT TERM

if (( WAS_ACTIVE )); then
    echo "[update] parando ${PZ_UNIT}..."
    sudo -n systemctl stop "$PZ_UNIT" || { echo "[update] no se pudo parar ${PZ_UNIT}" >&2; exit 1; }

    # Comprobar que java ha muerto de verdad: con TimeoutStopSec agotado y la
    # JVM agonizando, SteamCMD sobrescribiria los jars bajo el proceso vivo.
    for _ in $(seq 1 60); do
        pgrep -u "$PZ_SYS_USER" -f "$GREP_PAT" >/dev/null || break
        sleep 1
    done
    if pgrep -u "$PZ_SYS_USER" -f "$GREP_PAT" >/dev/null; then
        echo "[update] java sigue vivo tras parar la unidad, aborto" >&2
        exit 1
    fi
fi

BETA=()
[[ "$BRANCH" == "unstable" ]] && BETA=(-beta unstable)

echo "[update] steamcmd app_update ${PZ_APPID} ${BETA[*]:-}"
"$PZ_STEAMCMD" \
    +force_install_dir "$PZ_SERVER_DIR" \
    +login anonymous \
    +app_update "$PZ_APPID" "${BETA[@]}" validate \
    +quit
RC=$?

chmod +x "$PZ_SERVER_DIR"/*.sh 2>/dev/null || true

if (( WAS_ACTIVE )); then
    echo "[update] arrancando ${PZ_UNIT}..."
    sudo -n systemctl start "$PZ_UNIT"
fi

echo "[update] terminado (rc=${RC})"
exit $RC
