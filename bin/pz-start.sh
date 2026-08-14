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

# rotamos la consola anterior para no acumular gigas
if [[ -f "$PZ_CONSOLE_LOG" ]]; then
    mv -f "$PZ_CONSOLE_LOG" "${PZ_CONSOLE_LOG}.1"
fi
: > "$PZ_CONSOLE_LOG"

rm -f "$PZ_FIFO"
mkfifo -m 600 "$PZ_FIFO"

exec 3<> "$PZ_FIFO"

cd "$PZ_SERVER_DIR" || exit 1

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
