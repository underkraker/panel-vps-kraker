# ScriptCGH Web Panel

Panel web para administrar protocolos, puertos y usuarios de ScriptCGH.

## Requisitos de permisos

Para levantar protocolos, abrir puertos y ejecutar scripts del sistema, el proceso **debe correr con privilegios root**.

- Sin root, el panel entra en modo restringido y bloquea acciones administrativas.
- Puedes forzar modo no-root para pruebas visuales con `PANEL_ALLOW_NON_ROOT=1`.

## Ejecutar

```bash
cd web-panel
npm install
sudo node server.js
```

Variables opcionales:

- `PANEL_PORT` puerto del panel (default `3000`)
- `PANEL_PASS` password maestra por variable de entorno
- `PANEL_ALLOW_NON_ROOT=1` modo de pruebas sin root
- `PANEL_FORCE_HTTPS=1` redirecciona a HTTPS detras de proxy
- `PANEL_SESSION_TTL_MS` expiracion de sesion en milisegundos
- `PANEL_COMMAND_TIMEOUT_MS` timeout maximo de scripts
- `PANEL_LOGIN_MAX_ATTEMPTS` intentos antes de bloqueo
- `PANEL_LOGIN_WINDOW_MS` ventana para contar intentos de login
- `PANEL_LOGIN_LOCK_MS` duracion del bloqueo por intentos fallidos
- `PANEL_SYSTEM_USERS=1` sincroniza usuarios del panel con Linux (useradd/userdel)

## Servicio systemd

Se incluye una unidad en `web-panel/deploy/scriptcgh-web-panel.service`.

Instalacion sugerida:

```bash
sudo cp web-panel/deploy/scriptcgh-web-panel.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scriptcgh-web-panel
sudo systemctl status scriptcgh-web-panel
```

## Seguridad

- `config.json` guarda `masterPasswordHash` con `scrypt`.
- El token de sesion es dinamico y expira automaticamente.
- Solo se ejecutan comandos en una whitelist definida del backend.
- Login con rate-limit y bloqueo temporal por IP.
- Cola de jobs para evitar ejecutar multiples scripts criticos a la vez.

## Observabilidad

- `GET /api/health` estado rapido del servicio.
- `GET /api/jobs` y `GET /api/jobs/:id` estado de cola y ejecuciones.
- `POST /api/jobs/:id/cancel` cancela jobs pendientes/en curso.
- `GET /api/logs?lines=120` muestra logs recientes.

## Backup

Script incluido:

```bash
sudo web-panel/deploy/backup-web-panel.sh
```

Guarda `config.json`, `users.json` y `logs/` en `web-panel/backups/`.
