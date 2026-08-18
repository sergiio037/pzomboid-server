#!/usr/bin/env bash
# Parada limpia: 'save' -> espera -> 'quit' -> espera a que java muera.
# Lo invoca systemd como ExecStop, asi que un apagado o reinicio del panel
# nunca pierde la partida.
set -uo pipefail

: "${PZ_FIFO:?}" "${PZ_SYS_USER:?}"

GREP_PAT='zombie.network.GameServer'

alive() { pgrep -u "$PZ_SYS_USER" -f "$GREP_PAT" >/dev/null 2>&1; }

# Devuelve != 0 si NO se pudo enviar. Antes esta funcion callaba y devolvia 0
# cuando el FIFO no estaba: el script esperaba 150 s en vano, mandaba TERM y
# KILL y salia con exito, asi que systemd y el panel daban la parada por limpia
# mientras se perdia todo lo jugado desde el ultimo autoguardado.
write_cmd() {
    if [[ ! -p "$PZ_FIFO" ]]; then
        echo "[panel] ERROR: $PZ_FIFO no es un pipe; NO se pudo enviar '$1'" \
            | tee -a "${PZ_CONSOLE_LOG:-/dev/null}" >&2
        return 1
    fi
    timeout 5 bash -c 'printf "%s\n" "$1" > "$2"' _ "$1" "$PZ_FIFO"
}

if ! alive; then
    rm -f "$PZ_FIFO"
    exit 0
fi

if ! write_cmd "save"; then
    # Sin canal de mandos no hay parada limpia posible: no tiene sentido
    # esperar el minuto y medio del bucle. Se termina y se avisa con rc != 0.
    pkill -u "$PZ_SYS_USER" -TERM -f "$GREP_PAT" || true
    sleep 10
    alive && pkill -u "$PZ_SYS_USER" -KILL -f "$GREP_PAT" || true
    rm -f "$PZ_FIFO"
    exit 1
fi

sleep 5
write_cmd "quit" || true

# Hasta 90 s para volcar el mundo a disco. El presupuesto total queda en ~110 s,
# holgado frente a TimeoutStopSec y compatible con la ventana de apagado ACPI de
# un hipervisor, que nunca espera los 175 s de antes.
for _ in $(seq 1 90); do
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
