#!/usr/bin/env bash
# Envia una linea a la consola del servidor.
#   uso: pz-cmd.sh "players"
#
# El comando llega como argv, nunca se interpola en una shell, asi que el
# panel puede pasar texto arbitrario del usuario sin riesgo de inyeccion.
set -uo pipefail

: "${PZ_FIFO:?}"

CMD="${1:-}"
[[ -n "$CMD" ]] || { echo "comando vacio" >&2; exit 2; }
[[ -p "$PZ_FIFO" ]] || { echo "el servidor no esta corriendo" >&2; exit 3; }

# quitamos saltos de linea para que no se cuelen varios comandos de golpe
CMD="${CMD//$'\n'/ }"
CMD="${CMD//$'\r'/ }"

timeout 5 bash -c 'printf "%s\n" "$1" > "$2"' _ "$CMD" "$PZ_FIFO"
