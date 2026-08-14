#!/usr/bin/env bash
# Parada limpia: 'save' -> espera -> 'quit' -> espera a que java muera.
# Lo invoca systemd como ExecStop, asi que un apagado o reinicio del panel
# nunca pierde la partida.
set -uo pipefail

: "${PZ_FIFO:?}" "${PZ_SYS_USER:?}"

GREP_PAT='zombie.network.GameServer'

alive() { pgrep -u "$PZ_SYS_USER" -f "$GREP_PAT" >/dev/null 2>&1; }

write_cmd() {
    [[ -p "$PZ_FIFO" ]] || return 0
    timeout 5 bash -c 'printf "%s\n" "$1" > "$2"' _ "$1" "$PZ_FIFO" 2>/dev/null || true
}

if ! alive; then
    rm -f "$PZ_FIFO"
    exit 0
fi

write_cmd "save"
sleep 5
write_cmd "quit"

# hasta 150 s para que termine de volcar el mundo a disco
for _ in $(seq 1 150); do
    alive || break
    sleep 1
done

if alive; then
    pkill -u "$PZ_SYS_USER" -TERM -f "$GREP_PAT" || true
    sleep 10
    alive && pkill -u "$PZ_SYS_USER" -KILL -f "$GREP_PAT" || true
fi

rm -f "$PZ_FIFO"
exit 0
