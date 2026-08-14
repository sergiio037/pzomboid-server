# PZ Stack — servidor de Project Zomboid + panel web

Instalación desatendida de un servidor dedicado de Project Zomboid en una VM
limpia (Debian 12 / Ubuntu 22.04+), con un panel web para administrarlo.

## Qué instala

| Componente | Dónde |
|---|---|
| SteamCMD | `/home/pzuser/steamcmd` |
| Servidor PZ (appid 380870) | `/home/pzuser/pzserver` |
| Datos del juego (mundos, mods, config) | `/home/pzuser/Zomboid` |
| Panel web (Node 20 + Express) | `/opt/pzpanel` |
| Servicio del juego | `systemctl … pzserver` |
| Servicio del panel | `systemctl … pzpanel` |

## Instalación

Desde tu máquina, sube la carpeta y ejecuta el instalador:

```bash
gcloud compute scp --recurse pz-stack NOMBRE_VM:~ --zone=ZONA
```

```bash
gcloud compute ssh NOMBRE_VM --zone=ZONA --command="sudo bash ~/pz-stack/install.sh"
```

Tarda unos 10–15 minutos (la descarga del servidor son ~4 GB). Al terminar
imprime la URL del panel y las reglas de firewall que faltan por crear.

### Variables opcionales

```bash
sudo PANEL_PASS='otra-clave' PZ_BRANCH=unstable PZ_SERVER_NAME=miserver bash install.sh
```

| Variable | Por defecto | Para qué |
|---|---|---|
| `PANEL_USER` | `pzomboid037` | usuario del panel |
| `PANEL_PASS` | `121212` | contraseña del panel |
| `PANEL_PORT` | `8080` | puerto HTTP del panel |
| `PZ_ADMIN_PASSWORD` | `121212` | contraseña del admin **dentro del juego** |
| `PZ_SERVER_NAME` | `pzserver` | nombre del mundo y del `.ini` |
| `PZ_BRANCH` | `stable` | `unstable` para la build 42 |

## Firewall (GCP)

El instalador no puede crear las reglas por ti; ejecútalas desde tu máquina:

```bash
gcloud compute firewall-rules create pz-game --allow udp:16261-16262,udp:8766-8767 --target-tags=pz-server
```

```bash
gcloud compute firewall-rules create pz-panel --allow tcp:8080 --target-tags=pz-server --source-ranges=TU.IP.PUBLICA/32
```

```bash
gcloud compute instances add-tags NOMBRE_VM --tags=pz-server --zone=ZONA
```

## El panel

- **Resumen** — estado, jugadores conectados, RAM/CPU del proceso java, consola
  reducida y acciones rápidas (guardar, actualizar vía SteamCMD…).
- **Consola** — salida en vivo por WebSocket y campo para enviar comandos, con
  historial (`↑`/`↓`) y atajos de los comandos habituales.
- **Mods** — arrastra un `.zip` o una carpeta entera sobre la zona de subida, o
  usa los botones del explorador de archivos. Interruptor por mod para
  activarlo/desactivarlo, y gestión de los IDs del Workshop y de `Mods=`.
- **Mundos** — tamaño y fecha de cada partida, backup a `.tar.gz` descargable, y
  borrado (exige el servidor apagado).
- **Configuración** — editor de `pzserver.ini` y de `SandboxVars.lua`. Guarda un
  `.bak` antes de sobrescribir.

Los cambios de mods y configuración requieren reiniciar el servidor.

## Cómo funciona por dentro

El servidor corre bajo systemd en primer plano (`Type=simple`), no en tmux ni
screen. `pz-start.sh` crea un FIFO y lo abre en modo lectura-escritura antes de
`exec`; el proceso java lo hereda como stdin, así que nunca recibe EOF aunque no
haya escritores. Enviar un comando desde el panel es escribir una línea en ese
FIFO. Como el comando viaja por `argv` y nunca se interpola en una shell, no hay
inyección posible.

La parada es limpia: `ExecStop` manda `save`, espera, manda `quit` y solo
recurre a señales si el proceso sigue vivo pasados 150 s. Un `reboot` de la VM
tampoco pierde la partida.

El panel corre como `pzuser`, sin privilegios. Lo único que puede hacer como
root son exactamente tres comandos, fijados en `/etc/sudoers.d/pzpanel`:
`systemctl start|stop|restart pzserver`.

## Operación

```bash
systemctl status pzserver
```

```bash
journalctl -u pzpanel -f
```

```bash
tail -f /opt/pzpanel/logs/console.log
```

Para cambiar la memoria de la JVM, edita `vmArgs` en
`/home/pzuser/pzserver/ProjectZomboid64.json` (el instalador lo fija en
`RAM total − 2 GB`) y reinicia con `systemctl restart pzserver`.

## Seguridad — léelo

Tal cual queda instalado, el panel va por **HTTP sin cifrar** y con la
contraseña que hayas puesto. Sobre la red pública eso significa que las
credenciales y la sesión viajan en claro. Dos medidas, por orden de prioridad:

1. **Restringe el puerto del panel a tu IP** con `--source-ranges` en la regla de
   firewall, como en el ejemplo de arriba. Esto es lo que más aporta y no cuesta
   nada. El puerto UDP del juego sí debe quedar abierto a todos.
2. Si vas a exponerlo o compartirlo, pon HTTPS delante con un dominio y Caddy
   (`caddy reverse-proxy --from tudominio --to :8080` obtiene el certificado
   solo) y cambia `secure: false` a `true` en la cookie de `panel/server.js`.

La contraseña se guarda como hash scrypt con sal en `/opt/pzpanel/.env` (modo
600); en claro no se almacena en ningún sitio. Para cambiarla:

```bash
sudo -u pzuser node -e 'const c=require("crypto"),s=c.randomBytes(16).toString("hex");console.log(s+":"+c.scryptSync(process.argv[1],s,64).toString("hex"))' NUEVA_CLAVE
```

Pega el resultado en `PANEL_PASS_HASH` dentro de `/opt/pzpanel/.env` y reinicia
con `sudo systemctl restart pzpanel`.

## Desinstalar

```bash
sudo systemctl disable --now pzserver pzpanel && sudo rm -rf /opt/pzpanel /home/pzuser /etc/systemd/system/pz{server,panel}.service /etc/sudoers.d/pzpanel && sudo systemctl daemon-reload
```
