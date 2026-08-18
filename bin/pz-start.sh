#!/usr/bin/env bash
# Arranca el servidor PZ en primer plano (lo lanza systemd, Type=simple).
#
# Truco clave: creamos un FIFO y lo abrimos en modo LECTURA-ESCRITURA (fd 3)
# antes de hacer exec. Al heredarlo el proceso java como stdin, el FIFO nunca
# recibe EOF aunque no haya ningun escritor externo, asi que el servidor no se
# cierra solo y podemos inyectarle comandos desde el panel escribiendo en el.
set -uo pipefail

: "${PZ_SERVER_DIR:?}" "${PZ_SERVER_NAME:?}" "${PZ_ADMIN_PASSWORD:?}"
: "${PZ_FIFO:?}" "${PZ_CONSOLE_LOG:?}" "${PZ_RUN_DIR:?}" "${PZ_LOG_DIR:?}" "${PZ_ZOMBOID_DIR:?}"

mkdir -p "$PZ_RUN_DIR" "$PZ_LOG_DIR"

# Rotamos conservando 5 generaciones. Con una sola, un bucle de reinicio
# (RestartSec=20) borraba en 40 s el log del crash original, que es la unica
# evidencia: la unidad redirige toda la salida aqui y journalctl queda mudo.
if [[ -f "$PZ_CONSOLE_LOG" ]]; then
    for i in 4 3 2 1; do
        [[ -f "${PZ_CONSOLE_LOG}.${i}" ]] && mv -f "${PZ_CONSOLE_LOG}.${i}" "${PZ_CONSOLE_LOG}.$((i + 1))"
    done
    mv -f "$PZ_CONSOLE_LOG" "${PZ_CONSOLE_LOG}.1"
fi
: > "$PZ_CONSOLE_LOG"

falla() {
    echo "[panel] ERROR: $*" | tee -a "$PZ_CONSOLE_LOG" >&2
    exit 1
}

# Sin estas comprobaciones, un mkfifo fallido hacia que `exec 3<>` creara un
# FICHERO REGULAR: java arrancaba con el como stdin, pz-cmd.sh respondia
# siempre "el servidor no esta corriendo" y no habia forma ni de guardar.
rm -f "$PZ_FIFO"
mkfifo -m 600 "$PZ_FIFO" || falla "no se pudo crear el FIFO $PZ_FIFO"
[[ -p "$PZ_FIFO" ]] || falla "$PZ_FIFO existe pero no es un pipe"
[[ -x "$PZ_SERVER_DIR/start-server.sh" ]] || falla "falta start-server.sh en $PZ_SERVER_DIR"

exec 3<> "$PZ_FIFO" || falla "no se pudo abrir $PZ_FIFO en lectura-escritura"

cd "$PZ_SERVER_DIR" || falla "no se pudo entrar en $PZ_SERVER_DIR"

{
    echo "--------------------------------------------------------------"
    echo "[panel] arrancando ${PZ_SERVER_NAME} :: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "--------------------------------------------------------------"
} >> "$PZ_CONSOLE_LOG"

exec ./start-server.sh \
        -servername "$PZ_SERVER_NAME" \
        -adminpassword "$PZ_ADMIN_PASSWORD" \
        -cachedir="$PZ_ZOMBOID_DIR" \
    <&3 >> "$PZ_CONSOLE_LOG" 2>&1
