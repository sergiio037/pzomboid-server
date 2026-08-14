#!/usr/bin/env bash
# =============================================================================
#  Project Zomboid Dedicated Server + Web Panel  ::  bootstrap para VM limpia
#  Probado en Debian 12 / Ubuntu 22.04 y 24.04 (GCP, x86_64)
#
#  Uso:   sudo bash install.sh
#  Opcional (variables de entorno):
#     PANEL_USER  PANEL_PASS  PANEL_PORT
#     PZ_ADMIN_PASSWORD  PZ_SERVER_NAME  PZ_BRANCH (stable|unstable)
# =============================================================================
set -Eeuo pipefail

# ----------------------------- configuracion ---------------------------------
PANEL_USER="${PANEL_USER:-pzomboid037}"
PANEL_PASS="${PANEL_PASS:-121212}"
PANEL_PORT="${PANEL_PORT:-8080}"

PZ_ADMIN_PASSWORD="${PZ_ADMIN_PASSWORD:-121212}"
PZ_SERVER_NAME="${PZ_SERVER_NAME:-pzserver}"
PZ_BRANCH="${PZ_BRANCH:-stable}"          # stable = B41 | unstable = B42
PZ_APPID=380870

SYS_USER="pzuser"
SYS_HOME="/home/${SYS_USER}"
PZ_SERVER_DIR="${SYS_HOME}/pzserver"
PZ_ZOMBOID_DIR="${SYS_HOME}/Zomboid"
STEAMCMD_DIR="${SYS_HOME}/steamcmd"

PANEL_DIR="/opt/pzpanel"
PANEL_BIN="${PANEL_DIR}/bin"
PANEL_RUN="${PANEL_DIR}/run"
PANEL_LOG="${PANEL_DIR}/logs"
PANEL_BACKUP="${PANEL_DIR}/backups"
PANEL_TMP="${PANEL_DIR}/tmp"
PZ_UNIT="pzserver"
PZ_FIFO="${PANEL_RUN}/stdin.fifo"
PZ_CONSOLE_LOG="${PANEL_LOG}/console.log"
ENV_FILE="${PANEL_DIR}/.env"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ----------------------------- helpers ---------------------------------------
C_R=$'\033[0m'; C_G=$'\033[1;32m'; C_Y=$'\033[1;33m'; C_B=$'\033[1;36m'; C_E=$'\033[1;31m'
step() { echo; echo "${C_B}==>${C_R} ${C_B}$*${C_R}"; }
ok()   { echo "    ${C_G}ok${C_R}  $*"; }
warn() { echo "    ${C_Y}!!${C_R}  $*"; }
die()  { echo; echo "${C_E}ERROR:${C_R} $*" >&2; exit 1; }
trap 'die "fallo en la linea $LINENO"' ERR

[[ $EUID -eq 0 ]] || die "ejecuta como root:  sudo bash install.sh"
[[ -f "${SRC_DIR}/panel/server.js" ]] || die "no encuentro ${SRC_DIR}/panel/server.js — sube la carpeta pz-stack completa"
command -v apt-get >/dev/null || die "este script asume Debian/Ubuntu (apt)"

echo "${C_B}"
echo "  ####  Project Zomboid server + panel web"
echo "  ####  usuario panel : ${PANEL_USER}"
echo "  ####  puerto panel  : ${PANEL_PORT}"
echo "  ####  rama PZ       : ${PZ_BRANCH}"
echo "${C_R}"

# ----------------------------- 1. paquetes -----------------------------------
step "1/11  Instalando dependencias del sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    ca-certificates curl gnupg tar unzip zip xz-utils \
    procps psmisc coreutils util-linux \
    lib32gcc-s1 lib32stdc++6 libatomic1 \
    tzdata >/dev/null
ok "paquetes base"

# ----------------------------- 2. usuario ------------------------------------
step "2/11  Creando usuario de sistema '${SYS_USER}'"
if ! id -u "$SYS_USER" >/dev/null 2>&1; then
    useradd -m -d "$SYS_HOME" -s /bin/bash "$SYS_USER"
    ok "usuario creado"
else
    ok "ya existia"
fi
install -d -o "$SYS_USER" -g "$SYS_USER" -m 750 \
    "$STEAMCMD_DIR" "$PZ_SERVER_DIR" "$PZ_ZOMBOID_DIR" \
    "$PZ_ZOMBOID_DIR/mods" "$PZ_ZOMBOID_DIR/Server" \
    "$PZ_ZOMBOID_DIR/Saves" "$PZ_ZOMBOID_DIR/Saves/Multiplayer"

# ----------------------------- 3. node.js ------------------------------------
step "3/11  Instalando Node.js 20"
if command -v node >/dev/null 2>&1 && [[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]]; then
    ok "node $(node -v) ya presente"
else
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    chmod a+r /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list
    apt-get update -qq
    apt-get install -y -qq nodejs >/dev/null || {
        warn "NodeSource fallo, uso el nodejs de la distro"
        rm -f /etc/apt/sources.list.d/nodesource.list
        apt-get update -qq && apt-get install -y -qq nodejs npm >/dev/null
    }
    ok "node $(node -v)"
fi

# ----------------------------- 4. steamcmd -----------------------------------
step "4/11  Instalando SteamCMD"
if [[ ! -x "${STEAMCMD_DIR}/steamcmd.sh" ]]; then
    curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz \
        | sudo -u "$SYS_USER" tar -xz -C "$STEAMCMD_DIR"
    ok "steamcmd descargado"
else
    ok "ya estaba instalado"
fi
chown -R "$SYS_USER:$SYS_USER" "$STEAMCMD_DIR"

# ----------------------------- 5. servidor PZ --------------------------------
step "5/11  Descargando Project Zomboid Dedicated Server (appid ${PZ_APPID})"
echo "    esto tarda varios minutos, es ~4 GB..."
BETA_ARGS=()
[[ "$PZ_BRANCH" == "unstable" ]] && BETA_ARGS=(-beta unstable)
sudo -u "$SYS_USER" HOME="$SYS_HOME" "${STEAMCMD_DIR}/steamcmd.sh" \
    +force_install_dir "$PZ_SERVER_DIR" \
    +login anonymous \
    +app_update "$PZ_APPID" "${BETA_ARGS[@]}" validate \
    +quit
[[ -f "${PZ_SERVER_DIR}/start-server.sh" ]] || die "start-server.sh no aparecio; revisa la salida de steamcmd"
chmod +x "${PZ_SERVER_DIR}"/*.sh 2>/dev/null || true
ok "servidor instalado en ${PZ_SERVER_DIR}"

# ----------------------------- 6. heap de la JVM -----------------------------
step "6/11  Ajustando memoria de la JVM"
TOTAL_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
HEAP_MB=$(( TOTAL_MB - 2048 ))
(( HEAP_MB < 2048 )) && HEAP_MB=2048
JSON="${PZ_SERVER_DIR}/ProjectZomboid64.json"
if [[ -f "$JSON" ]]; then
    node -e '
      const fs = require("fs");
      const [file, heap] = process.argv.slice(1);
      const j = JSON.parse(fs.readFileSync(file, "utf8"));
      j.vmArgs = (j.vmArgs || []).filter(a => !/^-Xm[sx]/.test(a));
      j.vmArgs.push("-Xms" + heap, "-Xmx" + heap);
      fs.writeFileSync(file, JSON.stringify(j, null, 4));
    ' "$JSON" "${HEAP_MB}m"
    chown "$SYS_USER:$SYS_USER" "$JSON"
    ok "heap fijado a ${HEAP_MB}m (RAM total ${TOTAL_MB}m)"
else
    warn "no encuentro ProjectZomboid64.json, heap por defecto"
fi

# ----------------------------- 7. panel --------------------------------------
step "7/11  Copiando el panel web"
install -d -o "$SYS_USER" -g "$SYS_USER" -m 750 \
    "$PANEL_DIR" "$PANEL_BIN" "$PANEL_RUN" "$PANEL_LOG" "$PANEL_BACKUP" "$PANEL_TMP"
cp -r "${SRC_DIR}/panel/." "$PANEL_DIR/"
cp "${SRC_DIR}"/bin/*.sh "$PANEL_BIN/"
chmod +x "$PANEL_BIN"/*.sh
chown -R "$SYS_USER:$SYS_USER" "$PANEL_DIR"
ok "archivos copiados a ${PANEL_DIR}"

step "8/11  Generando credenciales y .env"
PANEL_PASS_HASH="$(node -e '
  const c = require("crypto");
  const salt = c.randomBytes(16).toString("hex");
  const hash = c.scryptSync(process.argv[1], salt, 64).toString("hex");
  process.stdout.write(salt + ":" + hash);
' "$PANEL_PASS")"
PANEL_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cat > "$ENV_FILE" <<ENVEOF
PANEL_PORT="${PANEL_PORT}"
PANEL_USER="${PANEL_USER}"
PANEL_PASS_HASH="${PANEL_PASS_HASH}"
PANEL_SECRET="${PANEL_SECRET}"
PZ_UNIT="${PZ_UNIT}"
PZ_SYS_USER="${SYS_USER}"
PZ_SERVER_DIR="${PZ_SERVER_DIR}"
PZ_ZOMBOID_DIR="${PZ_ZOMBOID_DIR}"
PZ_SERVER_NAME="${PZ_SERVER_NAME}"
PZ_ADMIN_PASSWORD="${PZ_ADMIN_PASSWORD}"
PZ_FIFO="${PZ_FIFO}"
PZ_CONSOLE_LOG="${PZ_CONSOLE_LOG}"
PZ_RUN_DIR="${PANEL_RUN}"
PZ_LOG_DIR="${PANEL_LOG}"
PZ_BACKUP_DIR="${PANEL_BACKUP}"
PZ_TMP_DIR="${PANEL_TMP}"
PZ_BIN_DIR="${PANEL_BIN}"
PZ_STEAMCMD="${STEAMCMD_DIR}/steamcmd.sh"
PZ_APPID="${PZ_APPID}"
PZ_BRANCH="${PZ_BRANCH}"
HOME="${SYS_HOME}"
ENVEOF
chown "$SYS_USER:$SYS_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "credenciales guardadas (hash scrypt, la contrasena en claro no se almacena)"

step "9/11  Instalando dependencias npm del panel"
sudo -u "$SYS_USER" HOME="$SYS_HOME" npm --prefix "$PANEL_DIR" install --omit=dev --no-audit --no-fund >/dev/null
ok "node_modules listo"

# ----------------------------- 10. systemd -----------------------------------
step "10/11  Registrando servicios systemd"

cat > /etc/systemd/system/${PZ_UNIT}.service <<UNITEOF
[Unit]
Description=Project Zomboid Dedicated Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SYS_USER}
Group=${SYS_USER}
WorkingDirectory=${PZ_SERVER_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${PANEL_BIN}/pz-start.sh
ExecStop=${PANEL_BIN}/pz-stop.sh
Restart=on-failure
RestartSec=20
TimeoutStartSec=600
TimeoutStopSec=180
KillMode=control-group
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNITEOF

cat > /etc/systemd/system/pzpanel.service <<UNITEOF
[Unit]
Description=Project Zomboid Web Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SYS_USER}
Group=${SYS_USER}
WorkingDirectory=${PANEL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node ${PANEL_DIR}/server.js
Restart=always
RestartSec=5
LimitNOFILE=32768

[Install]
WantedBy=multi-user.target
UNITEOF

# el panel necesita poder arrancar/parar el servicio del juego, y nada mas
SUDOERS=/etc/sudoers.d/pzpanel
cat > "$SUDOERS" <<SUDOEOF
Defaults:${SYS_USER} !requiretty
${SYS_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl start ${PZ_UNIT}, \\
    /usr/bin/systemctl start ${PZ_UNIT}.service, \\
    /usr/bin/systemctl stop ${PZ_UNIT}, \\
    /usr/bin/systemctl stop ${PZ_UNIT}.service, \\
    /usr/bin/systemctl restart ${PZ_UNIT}, \\
    /usr/bin/systemctl restart ${PZ_UNIT}.service, \\
    /bin/systemctl start ${PZ_UNIT}, /bin/systemctl stop ${PZ_UNIT}, /bin/systemctl restart ${PZ_UNIT}
SUDOEOF
chmod 440 "$SUDOERS"
visudo -c -f "$SUDOERS" >/dev/null || die "sudoers invalido"

systemctl daemon-reload
systemctl enable "${PZ_UNIT}.service" pzpanel.service >/dev/null 2>&1
ok "unidades ${PZ_UNIT}.service y pzpanel.service registradas"

# ----------------------------- 11. primer arranque ---------------------------
step "11/11  Primer arranque (genera los ficheros de configuracion)"
systemctl start "${PZ_UNIT}.service"

INI="${PZ_ZOMBOID_DIR}/Server/${PZ_SERVER_NAME}.ini"
echo -n "    esperando a ${PZ_SERVER_NAME}.ini "
for i in $(seq 1 120); do
    [[ -f "$INI" ]] && break
    sleep 2; echo -n "."
done
echo
if [[ -f "$INI" ]]; then
    ok "configuracion generada en ${INI}"
else
    warn "el .ini aun no existe; el servidor puede seguir arrancando."
    warn "revisa:  journalctl -u ${PZ_UNIT} -f   y   tail -f ${PZ_CONSOLE_LOG}"
fi

systemctl start pzpanel.service
sleep 2
systemctl is-active --quiet pzpanel.service \
    && ok "panel web activo" \
    || warn "el panel no arranco: journalctl -u pzpanel -n 50"

IP_PUB="$(curl -fsS -H 'Metadata-Flavor: Google' \
    http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip \
    2>/dev/null || echo '<IP-DE-TU-VM>')"

cat <<FINEOF

${C_G}================================================================${C_R}
${C_G} LISTO${C_R}

  Panel web    http://${IP_PUB}:${PANEL_PORT}
  Usuario      ${PANEL_USER}
  Contrasena   ${PANEL_PASS}

  Servidor PZ  ${IP_PUB}:16261   (UDP)
  Admin PZ     usuario 'admin' / ${PZ_ADMIN_PASSWORD}

${C_Y} Abre los puertos en el firewall de GCP (desde tu maquina):${C_R}

  gcloud compute firewall-rules create pz-game \\
      --allow udp:16261-16262,udp:8766-8767 --target-tags=pz-server

  gcloud compute firewall-rules create pz-panel \\
      --allow tcp:${PANEL_PORT} --target-tags=pz-server \\
      --source-ranges=TU.IP.PUBLICA/32

  gcloud compute instances add-tags <NOMBRE-VM> --tags=pz-server --zone=<ZONA>

${C_Y} Comandos utiles:${C_R}
  systemctl status ${PZ_UNIT}        journalctl -u ${PZ_UNIT} -f
  systemctl status pzpanel           journalctl -u pzpanel -f
  tail -f ${PZ_CONSOLE_LOG}
${C_G}================================================================${C_R}

FINEOF
