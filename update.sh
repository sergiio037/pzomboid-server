#!/usr/bin/env bash
# =============================================================================
#  Redespliega el panel desde este repo, sin reinstalar el servidor.
#  Para cualquier cambio en panel/ o bin/ esto basta: ~10 s en vez de 15 min.
#
#  Uso (en la VM, dentro del clon):  sudo bash update.sh
# =============================================================================
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="/opt/pzpanel"
SYS_USER="pzuser"

C_R=$'\033[0m'; C_G=$'\033[1;32m'; C_B=$'\033[1;36m'; C_Y=$'\033[1;33m'
step() { echo "${C_B}==>${C_R} $*"; }

[[ $EUID -eq 0 ]] || { echo "ejecuta como root:  sudo bash update.sh" >&2; exit 1; }
[[ -d "$PANEL_DIR" ]] || { echo "no existe ${PANEL_DIR}; ejecuta primero install.sh" >&2; exit 1; }
[[ -f "${SRC_DIR}/panel/server.js" ]] || { echo "no encuentro panel/server.js en ${SRC_DIR}" >&2; exit 1; }

# --- 1. traer cambios si esto es un clon de git ------------------------------
if [[ -d "${SRC_DIR}/.git" ]] && command -v git >/dev/null 2>&1; then
    step "git pull"
    git -C "$SRC_DIR" pull --ff-only
fi

# --- 2. copiar codigo --------------------------------------------------------
# cp no borra: .env, node_modules, logs y backups del destino quedan intactos
BIN_ANTES="$(md5sum "${PANEL_DIR}"/bin/*.sh 2>/dev/null | md5sum)"
step "copiando panel/ y bin/"
cp -r "${SRC_DIR}/panel/." "${PANEL_DIR}/"
cp "${SRC_DIR}"/bin/*.sh "${PANEL_DIR}/bin/"
chmod +x "${PANEL_DIR}"/bin/*.sh
sed -i 's/\r$//' "${PANEL_DIR}"/bin/*.sh
BIN_DESPUES="$(md5sum "${PANEL_DIR}"/bin/*.sh | md5sum)"
chown -R "${SYS_USER}:${SYS_USER}" "$PANEL_DIR"
[[ -f "${PANEL_DIR}/.env" ]] && chmod 600 "${PANEL_DIR}/.env"

# --- 3. dependencias (idempotente y rapido si no cambio nada) ----------------
step "npm install"
sudo -u "$SYS_USER" HOME="/home/${SYS_USER}" \
    npm --prefix "$PANEL_DIR" install --omit=dev --no-audit --no-fund >/dev/null

# --- 4. reiniciar ------------------------------------------------------------
step "reiniciando pzpanel"
systemctl restart pzpanel
sleep 2

if systemctl is-active --quiet pzpanel; then
    echo "${C_G}listo${C_R} — panel actualizado y en marcha"
else
    echo "${C_Y}el panel no arranco:${C_R}  journalctl -u pzpanel -n 40"
    exit 1
fi

# Aviso de que bin/ cambio. Antes dependia de HEAD@{1}: con el reflog vacio
# (clon recien hecho, o despliegue por scp sin .git) el git diff fallaba, el
# 2>/dev/null se lo tragaba y el operador no recibia aviso ninguno.
if [[ "${BIN_ANTES:-}" != "${BIN_DESPUES:-}" ]]; then
    echo "${C_Y}aviso:${C_R} cambiaron scripts de bin/ — aplica con:  sudo systemctl restart pzserver"
fi
