#!/usr/bin/env bash
# Actualiza los binarios del servidor via SteamCMD.
# Para el servicio, actualiza, y lo vuelve a arrancar solo si estaba activo.
set -uo pipefail

: "${PZ_STEAMCMD:?}" "${PZ_SERVER_DIR:?}" "${PZ_APPID:?}" "${PZ_UNIT:?}"
BRANCH="${PZ_BRANCH:-stable}"

WAS_ACTIVE=0
systemctl is-active --quiet "$PZ_UNIT" && WAS_ACTIVE=1

if (( WAS_ACTIVE )); then
    echo "[update] parando ${PZ_UNIT}..."
    sudo -n systemctl stop "$PZ_UNIT"
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
