# Telegram Key Bot

Bot separado del panel para:

- Gestionar membresias por `telegram_id` (7, 15, 30 dias)
- Generar keys para usuarios con plan activo
- Expirar keys no usadas en 4 horas
- Notificar al usuario 1 dia antes de vencimiento y al vencer

## Instalacion

```bash
cd telegram-key-bot
npm install
cp .env.example .env
```

Edita `.env` con tus datos reales.

## Ejecutar

```bash
npm start
```

## Comandos admin

- `/addplan <telegram_id> <7|15|30>`
- `/venta <telegram_id> <7|15|30>`
- `/extend <telegram_id> <7|15|30>`
- `/removeplan <telegram_id>`
- `/genkey [telegram_id]`
- `/users`
- `/user <telegram_id>`

## Comandos usuario

- `/miplan`
- `/genkey`
- `/miskeys`
- `/activar <key> <ip> <so> <uuid> [version]`

Notas:

- En `/activar`, usa `so` sin espacios (ejemplo: `Ubuntu-24.04` o `Ubuntu_24.04`).
- Cada key pertenece a un solo usuario y no se mezcla con otros.
- Puedes personalizar formato y branding en `.env` (`SLOGAN`, `ACCESS_BOT_TAG`, `INSTALL_COMMAND`, `PANEL_VERSION`).

## Activacion automatica

Para que la key se active sola al instalar:

1) Configura en `.env`:
   - `BOT_ACTIVATE_URL` (ej: `http://TU_IP_PUBLICA:8799/activate`)
   - `BOT_ACTIVATE_SECRET`
   - `BOT_API_PORT` (default `8799`)
2) Abre el puerto `8799` en firewall si aplica.
3) El comando de instalacion que entrega la key ya incluye callback automatico.

Opciones recomendadas de seguridad/antiabuso en `.env`:

- `BOT_API_ALLOWED_IPS=127.0.0.1,IP_PANEL`
- `USER_KEY_COOLDOWN_SEC=30`
- `USER_MAX_ACTIVE_KEYS=3`
- `DB_BACKUP_INTERVAL_MIN=30`

## Validacion en instalador del panel

El `install.sh` del panel valida y consume la key durante instalacion usando:

- `POST /consume` (valida/consume key)
- `POST /panel-credentials` (envia password aleatoria al usuario dueño de la key)

## UX interactiva

- Flujos por pasos para todos los botones de admin/activacion.
- Cancelacion con texto (`cancelar`) o boton `✖️ Cancelar`.
