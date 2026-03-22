const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const AUDIT_LOG_FILE = path.join(DATA_DIR, 'audit.log');
const ENV_FILE = path.join(ROOT_DIR, '.env');

const loadEnvFile = () => {
    if (!fs.existsSync(ENV_FILE)) return;
    const lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
        const row = line.trim();
        if (!row || row.startsWith('#')) continue;
        const idx = row.indexOf('=');
        if (idx <= 0) continue;
        const key = row.slice(0, idx).trim();
        let value = row.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        value = value.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        if (!process.env[key]) process.env[key] = value;
    }
};

loadEnvFile();

const CONFIG = {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminChatId: String(process.env.ADMIN_CHAT_ID || ''),
    adminUsername: String(process.env.ADMIN_USERNAME || 'underkraker').replace('@', ''),
    panelUrl: process.env.PANEL_URL || 'https://panel.example.com',
    panelVersion: process.env.PANEL_VERSION || 'V1.0.0',
    brandName: process.env.BRAND_NAME || 'Kraker VPS',
    slogan: process.env.SLOGAN || 'Shadow Castillo',
    timezoneOffsetHours: Number(process.env.TIMEZONE_OFFSET_HOURS || 0),
    accessBotTag: process.env.ACCESS_BOT_TAG || 'NewUltimate_bot',
    installCommand: process.env.INSTALL_COMMAND || '',
    pricesText: process.env.PRICES_TEXT || 'Planes:\n7 dias, 15 dias, 30 dias. Contacta al admin.',
    botActivateUrl: process.env.BOT_ACTIVATE_URL || '',
    botConsumeUrl: process.env.BOT_CONSUME_URL || '',
    botActivateSecret: process.env.BOT_ACTIVATE_SECRET || '',
    botApiPort: Number(process.env.BOT_API_PORT || 8799),
    botApiAllowedIps: String(process.env.BOT_API_ALLOWED_IPS || ''),
    userKeyCooldownSec: Number(process.env.USER_KEY_COOLDOWN_SEC || 30),
    userMaxActiveKeys: Number(process.env.USER_MAX_ACTIVE_KEYS || 3),
    backupIntervalMin: Number(process.env.DB_BACKUP_INTERVAL_MIN || 30)
};

if (!CONFIG.token) {
    console.error('[ERROR] TELEGRAM_BOT_TOKEN no configurado');
    process.exit(1);
}

if (!CONFIG.adminChatId) {
    console.error('[ERROR] ADMIN_CHAT_ID no configurado');
    process.exit(1);
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const defaultDb = () => ({
    users: {},
    keys: {},
    settings: {
        installCounter: 9000,
        keyCounter: 66
    }
});

const readDb = () => {
    try {
        if (!fs.existsSync(DB_FILE)) return defaultDb();
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        return {
            users: parsed.users || {},
            keys: parsed.keys || {},
            settings: parsed.settings || { installCounter: 9000, keyCounter: 66 }
        };
    } catch (error) {
        return defaultDb();
    }
};

const writeDb = (db) => {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
};

const appendAudit = (event, details = {}) => {
    const line = `${new Date().toISOString()} ${event} ${JSON.stringify(details)}\n`;
    fs.appendFile(AUDIT_LOG_FILE, line, () => {});
};

const backupDbSnapshot = () => {
    try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(BACKUP_DIR, `db-${stamp}.json`);
        fs.copyFileSync(DB_FILE, file);
        const files = fs.readdirSync(BACKUP_DIR)
            .filter((name) => name.startsWith('db-') && name.endsWith('.json'))
            .sort();
        while (files.length > 24) {
            const old = files.shift();
            if (old) fs.unlinkSync(path.join(BACKUP_DIR, old));
        }
    } catch (error) {
        appendAudit('backup_error', { message: error.message });
    }
};

let db = readDb();
writeDb(db);

const bot = new TelegramBot(CONFIG.token, { polling: true });
const pendingActions = new Map();
const keyGenCooldown = new Map();

const allowedApiIps = CONFIG.botApiAllowedIps
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const safeSecretMatch = (left, right) => {
    if (!left || !right) return false;
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const getRemoteIp = (req) => {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const raw = xff || req.socket?.remoteAddress || '';
    return raw.replace(/^::ffff:/, '');
};

const isAllowedApiIp = (ip) => {
    if (!allowedApiIps.length) return true;
    return allowedApiIps.includes(ip);
};

const isAdmin = (msgOrId) => {
    const id = typeof msgOrId === 'object' ? String(msgOrId.chat.id) : String(msgOrId);
    return id === CONFIG.adminChatId;
};

const nowMs = () => Date.now();

const toLocalDate = (timestamp) => new Date(timestamp + CONFIG.timezoneOffsetHours * 60 * 60 * 1000);

const formatDate = (timestamp) => {
    const d = toLocalDate(timestamp);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(d.getUTCFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
};

const formatDateTime = (timestamp) => {
    const d = toLocalDate(timestamp);
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(d.getUTCFullYear()).slice(-2);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    return `${dd}/${mm}/${yy}-${hh}:${min}:${ss}`;
};

const getTelegramName = (msg) => {
    const user = msg.from || {};
    const username = user.username ? `@${user.username}` : '';
    return username || user.first_name || 'Usuario';
};

const getOrCreateUser = (msgOrId) => {
    const rawId = typeof msgOrId === 'object' ? msgOrId.from.id : msgOrId;
    const id = String(rawId);
    if (!db.users[id]) {
        db.users[id] = {
            id,
            username: typeof msgOrId === 'object' ? (msgOrId.from.username || '') : '',
            firstName: typeof msgOrId === 'object' ? (msgOrId.from.first_name || '') : '',
            membershipEndsAt: 0,
            planDays: 0,
            notify24For: 0,
            notifyExpiredFor: 0,
            createdAt: nowMs()
        };
    }
    if (typeof msgOrId === 'object') {
        db.users[id].username = msgOrId.from.username || db.users[id].username;
        db.users[id].firstName = msgOrId.from.first_name || db.users[id].firstName;
    }
    return db.users[id];
};

const getUserById = (id) => db.users[String(id)] || null;

const membershipActive = (user) => Number(user?.membershipEndsAt || 0) > nowMs();

const membershipDaysLeft = (user) => {
    if (!user || !membershipActive(user)) return 0;
    const diff = user.membershipEndsAt - nowMs();
    return Math.ceil(diff / (24 * 60 * 60 * 1000));
};

const countActiveKeysForUser = (ownerId) => Object.values(db.keys)
    .filter((item) => item.ownerId === String(ownerId) && !item.used && nowMs() <= item.expiresAt)
    .length;

const canUserGenerateKeyNow = (ownerId) => {
    const id = String(ownerId);
    const last = Number(keyGenCooldown.get(id) || 0);
    const now = nowMs();
    const cooldownMs = Math.max(0, CONFIG.userKeyCooldownSec) * 1000;
    if (cooldownMs > 0 && now - last < cooldownMs) {
        const wait = Math.ceil((cooldownMs - (now - last)) / 1000);
        return { ok: false, error: `Espera ${wait}s antes de generar otra key.` };
    }
    if (countActiveKeysForUser(id) >= Math.max(1, CONFIG.userMaxActiveKeys)) {
        return { ok: false, error: 'Ya alcanzaste el maximo de keys activas sin usar.' };
    }
    return { ok: true };
};

const markUserGeneratedKey = (ownerId) => {
    keyGenCooldown.set(String(ownerId), nowMs());
};

const parseDays = (value) => {
    const days = Number(value);
    if (![7, 15, 30].includes(days)) return null;
    return days;
};

const randomPart = (len) => crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);

const generatePanelKey = () => `KrakerVPS-${randomPart(30)}:${randomPart(20)}@`;

const installerLine = () =>
    CONFIG.installCommand || `apt update -y; apt upgrade -y; wget -q ${CONFIG.panelUrl}/setup; chmod 777 setup; ./setup --ADMcgh`;

const resolveConsumeUrl = () => {
    if (CONFIG.botConsumeUrl) return CONFIG.botConsumeUrl;
    if (CONFIG.botActivateUrl) return CONFIG.botActivateUrl.replace(/\/activate$/i, '/consume');
    return '';
};

const withKeyGateEnv = (command) => {
    const consumeUrl = resolveConsumeUrl();
    if (!consumeUrl) return command;

    const prefix = CONFIG.botActivateSecret
        ? `KRAKER_KEY_API_URL="${consumeUrl}" KRAKER_KEY_SECRET="${CONFIG.botActivateSecret}" KRAKER_PANEL_VERSION="${CONFIG.panelVersion}" `
        : `KRAKER_KEY_API_URL="${consumeUrl}" KRAKER_PANEL_VERSION="${CONFIG.panelVersion}" `;

    if (command.includes('sudo bash install.sh')) {
        return command.replace('sudo bash install.sh', `${prefix}sudo bash install.sh`);
    }

    return `${command} && ${prefix}sudo bash install.sh`;
};

const installerLineWithAutoActivation = () => withKeyGateEnv(installerLine());

const createKeyForUser = (ownerId, ownerTag) => {
    const createdAt = nowMs();
    const expiresAt = createdAt + 4 * 60 * 60 * 1000;
    const key = generatePanelKey();
    const ownerKeysCount = Object.values(db.keys).filter((item) => item.ownerId === String(ownerId)).length + 1;
    db.keys[key] = {
        key,
        keyId: ownerKeysCount,
        ownerId: String(ownerId),
        ownerTag,
        createdAt,
        expiresAt,
        used: false,
        usedAt: 0,
        activation: null
    };
    writeDb(db);
    return db.keys[key];
};

const buildKeyMessage = (keyRecord) => {
    const owner = keyRecord.ownerTag || `ID ${keyRecord.ownerId}`;
    const sloganOwner = owner.startsWith('@') ? owner : `@${owner.replace(/^ID:?\s*/i, '')}`;
    return [
        '╔══════════════════════════════════════╗',
        '║        🔐 NUEVA KEY GENERADA 🔐      ║',
        '╚══════════════════════════════════════╝',
        `🧩 KEY N° { ${keyRecord.keyId} }`,
        `👤 GENERADA POR: ${owner}`,
        `🆔 ID CLIENTE: ${keyRecord.ownerId}`,
        '⏳ VALIDEZ: 4 HORAS O HASTA SU PRIMER USO',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `🛡️ SloganKEY: ${sloganOwner}`,
        `🏷️ Marca: ${CONFIG.brandName}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `🗝️ KEY: ${keyRecord.key}`,
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        `⚙️ Instalador Oficial ${CONFIG.panelVersion}`,
        installerLineWithAutoActivation(keyRecord),
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '✅ Recomendado: Ubuntu 20.04 LTS',
        '🧬 Compatibilidad: Ubuntu 18.04 a 24.04 | X64 (x86|ARM)',
        '🧬 Compatibilidad: Debian 8 a 12 (x64)',
        `📲 ACCESOS OFICIALES: @${CONFIG.accessBotTag}`,
        '✨ Gracias por confiar en nuestro servicio ✨'
    ].join('\n');
};

const buildActivationMessage = (keyRecord) => {
    const activation = keyRecord.activation || {};
    const ownerLabel = keyRecord.ownerTag || `ID:${keyRecord.ownerId}`;
    return [
        '╔══════════════════════════════════════╗',
        '║        📩 MENSAJE RECIBIDO 📩        ║',
        '╚══════════════════════════════════════╝',
        `🗝️ ${keyRecord.key}`,
        '✅ ACTIVADA CORRECTAMENTE',
        '───────────────────────────────────────',
        `🌐 IP: ${activation.ip || 'N/A'}  <->  💻 S.O: ${activation.os || 'N/A'}`,
        '───────────────────────────────────────',
        `🧬 UUID: ${activation.uuid || 'N/A'}`,
        '───────────────────────────────────────',
        `👤 USUARIO: ${ownerLabel}`,
        `🆔 ID: ${keyRecord.ownerId}  <->  🛡️ Ver: ${activation.version || CONFIG.panelVersion}`,
        '───────────────────────────────────────',
        `🕒 HORA: ${formatDateTime(keyRecord.usedAt)}  <->  🔢 INSTALL SSH N° ${activation.installNumber || '0000'}`,
        '───────────────────────────────────────',
        `⚜️ By @${CONFIG.adminUsername} ⚜️`
    ].join('\n');
};

const buildPanelCredentialsMessage = ({ keyRecord, panelUrl, panelPassword }) => {
    const ownerLabel = keyRecord.ownerTag || `ID:${keyRecord.ownerId}`;
    return [
        '╔══════════════════════════════════════╗',
        '║      🔐 ACCESO PANEL ENTREGADO 🔐     ║',
        '╚══════════════════════════════════════╝',
        `👤 Usuario: ${ownerLabel}`,
        `🆔 ID: ${keyRecord.ownerId}`,
        '───────────────────────────────────────',
        `🌐 Panel URL: ${panelUrl || CONFIG.panelUrl}`,
        `🔑 Password: ${panelPassword}`,
        '───────────────────────────────────────',
        `🗝️ Key asociada: ${keyRecord.key}`,
        `🕒 Entregado: ${formatDateTime(nowMs())}`,
        '───────────────────────────────────────',
        `📲 Soporte: @${CONFIG.adminUsername}`
    ].join('\n');
};

const activateKeyRecord = (keyRecord, activationData = {}) => {
    db.settings.installCounter = Number(db.settings.installCounter || 9000) + 1;
    keyRecord.used = true;
    keyRecord.usedAt = nowMs();
    keyRecord.activation = {
        ip: activationData.ip || 'N/A',
        os: String(activationData.os || 'N/A').replace(/_/g, '-'),
        uuid: activationData.uuid || 'N/A',
        version: activationData.version || CONFIG.panelVersion,
        installNumber: activationData.installNumber || db.settings.installCounter
    };
    writeDb(db);
};

const validateAndActivateKey = ({ keyInput, requesterId, requireOwner = true, activationData }) => {
    const keyRecord = db.keys[keyInput];
    if (!keyRecord) return { ok: false, error: 'Key no encontrada.' };
    if (requireOwner && keyRecord.ownerId !== String(requesterId) && !isAdmin(requesterId)) {
        return { ok: false, error: 'Esta key no te pertenece.' };
    }
    if (keyRecord.used) return { ok: false, error: 'Esta key ya fue usada.' };
    if (nowMs() > keyRecord.expiresAt) {
        delete db.keys[keyInput];
        writeDb(db);
        return { ok: false, error: 'Esta key ya expiro (4 horas).' };
    }

    activateKeyRecord(keyRecord, activationData);
    return { ok: true, keyRecord };
};

const consumeKeyFromApi = (payload) => {
    const keyInput = String(payload.key || '').trim();
    return validateAndActivateKey({
        keyInput,
        requesterId: CONFIG.adminChatId,
        requireOwner: false,
        activationData: {
            ip: String(payload.ip || 'N/A'),
            os: String(payload.os || 'N/A'),
            uuid: String(payload.uuid || 'N/A'),
            version: String(payload.version || CONFIG.panelVersion),
            installNumber: Number(payload.installNumber || 0) || undefined
        }
    });
};

const requireMembership = (msg) => {
    const user = getOrCreateUser(msg);
    if (isAdmin(msg)) return { ok: true, user };
    if (!membershipActive(user)) {
        bot.sendMessage(
            msg.chat.id,
            'Tu membresia no esta activa. Pide renovacion al admin.',
            {
                reply_markup: {
                    inline_keyboard: [[
                        { text: 'Renovar Membresia', url: `https://t.me/${CONFIG.adminUsername}` },
                        { text: 'Comprar Membresia', url: `https://t.me/${CONFIG.adminUsername}` }
                    ]]
                }
            }
        );
        return { ok: false, user };
    }
    return { ok: true, user };
};

const refreshMembershipNotices = () => {
    const now = nowMs();
    const allUsers = Object.values(db.users);
    for (const user of allUsers) {
        if (!user.membershipEndsAt) continue;
        const remaining = user.membershipEndsAt - now;
        const oneDayMs = 24 * 60 * 60 * 1000;

        if (remaining > 0 && remaining <= oneDayMs && user.notify24For !== user.membershipEndsAt) {
            user.notify24For = user.membershipEndsAt;
            writeDb(db);
            bot.sendMessage(
                user.id,
                [
                    '=======📩 ᴍᴇɴꜱᴀᴊᴇ ᴅᴇ ᴀᴠɪꜱᴏ 📩========',
                    `ESTIMADO @${user.username || user.id}`,
                    'TU ACCESO ESTA POR FINALIZAR',
                    `ACCES FINISH ${formatDate(user.membershipEndsAt)} TIME BOT ${formatDate(user.membershipEndsAt)} - 00:00`,
                    'FIN DE CONTRATO : $',
                    'PUEDES APELAR, CONTACTANDO AL ADMIN DEL BOT',
                    '-----------------------------',
                    'RENUEVA TU MEMBRESIA DIGITANDO /prices',
                    'RECUERDA MANTENER TU CAPTURA DE PAGO, PARA ALGUN RECLAMO!',
                    '-----------------------------',
                    `Power By @${CONFIG.adminUsername}`
                ].join('\n'),
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Renovar con Admin', url: `https://t.me/${CONFIG.adminUsername}` },
                            { text: 'Comprar Membresia', url: `https://t.me/${CONFIG.adminUsername}` }
                        ]]
                    }
                }
            ).catch(() => {});
        }

        if (remaining <= 0 && user.notifyExpiredFor !== user.membershipEndsAt) {
            user.notifyExpiredFor = user.membershipEndsAt;
            writeDb(db);
            bot.sendMessage(
                user.id,
                [
                    '=======📩 ᴍᴇɴꜱᴀᴊᴇ ᴅᴇ ᴀᴠɪꜱᴏ 📩========',
                    `ESTIMADO @${user.username || user.id} YOUR ACCESS FINISH FOR SYSTEM (KILL-ID)`,
                    `ACCES FINISH ${formatDate(user.membershipEndsAt)} TIME BOT ${formatDate(user.membershipEndsAt)} - 00:00`,
                    'FIN DE CONTRATO : $',
                    'PUEDES APELAR, CONTACTANDO AL ADMIN DEL BOT',
                    '-----------------------------',
                    'RENUEVA TU MEMBRESIA DIGITANDO /prices',
                    'RECUERDA MANTENER TU CAPTURA DE PAGO, PARA ALGUN RECLAMO!',
                    '-----------------------------',
                    `Power By @${CONFIG.adminUsername}`
                ].join('\n'),
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: 'Renovar', url: `https://t.me/${CONFIG.adminUsername}` },
                            { text: 'Nueva Membresia', url: `https://t.me/${CONFIG.adminUsername}` }
                        ]]
                    }
                }
            ).catch(() => {});
        }
    }
};

const pruneExpiredUnusedKeys = () => {
    const now = nowMs();
    let changed = false;
    for (const keyValue of Object.keys(db.keys)) {
        const item = db.keys[keyValue];
        if (!item.used && now > item.expiresAt) {
            delete db.keys[keyValue];
            changed = true;
        }
    }
    if (changed) writeDb(db);
};

const adminHelp = () => [
    'Comandos admin:',
    '/addplan <telegram_id> <7|15|30>',
    '/venta <telegram_id> <7|15|30>',
    '/extend <telegram_id> <7|15|30>',
    '/removeplan <telegram_id>',
    '/genkey [telegram_id]',
    '/users',
    '/user <telegram_id>',
    '/status'
].join('\n');

const userHelp = () => [
    'Comandos usuario:',
    '/miplan',
    '/genkey',
    '/miskeys',
    '/activar <key> <ip> <so> <uuid> [version]'
].join('\n');

const keyboardMain = (isAdminUser) => {
    const rows = [
        [
            { text: '🧾 Mi Plan', callback_data: 'main_plan' },
            { text: '🗝️ Generar Mi Key', callback_data: 'main_gen' }
        ],
        [
            { text: '📦 Mis Keys', callback_data: 'main_keys' },
            { text: '⚡ Activar Key', callback_data: 'main_activate' }
        ],
        [
            { text: '💳 Precios', callback_data: 'main_prices' },
            { text: '🆘 Soporte', callback_data: 'main_support' }
        ],
        [
            { text: '📚 Ver Comandos', callback_data: 'main_help' }
        ]
    ];
    if (isAdminUser) {
        rows.unshift(
            [{ text: '👑 Admin Panel', callback_data: 'main_admin' }],
            [
                { text: '➕ Vender Membresia', callback_data: 'admin_sale' },
                { text: '⏫ Extender Membresia', callback_data: 'admin_extend' }
            ],
            [
                { text: '❌ Quitar Membresia', callback_data: 'admin_remove' },
                { text: '🔎 Ver Usuario', callback_data: 'admin_user' }
            ],
            [
                { text: '📋 Lista Usuarios', callback_data: 'admin_users' },
                { text: '🔐 Generar Key (usuario)', callback_data: 'admin_gen' }
            ]
        );
    }
    return { reply_markup: { inline_keyboard: rows } };
};

const keyboardAdmin = {
    reply_markup: {
        inline_keyboard: [
            [
                { text: '➕ Vender Membresia', callback_data: 'admin_sale' },
                { text: '⏫ Extender Membresia', callback_data: 'admin_extend' }
            ],
            [
                { text: '❌ Quitar Membresia', callback_data: 'admin_remove' },
                { text: '🔎 Ver Usuario', callback_data: 'admin_user' }
            ],
            [
                { text: '📋 Lista Usuarios', callback_data: 'admin_users' },
                { text: '🔐 Generar Key (usuario)', callback_data: 'admin_gen' }
            ],
            [
                { text: '⬅️ Menu Principal', callback_data: 'admin_back' }
            ]
        ],
    }
};

const sendMainMenu = (chatId, adminMode = false) => {
    bot.sendMessage(chatId, 'Menu principal listo. Elige una opcion:', keyboardMain(adminMode));
};

const sendAdminMenu = (chatId) => {
    bot.sendMessage(chatId, 'Panel admin:', keyboardAdmin);
};

const isCancelText = (text) => /^(cancelar|cancel|salir)$/i.test((text || '').trim());

const sendPrompt = (chatId, text) => {
    bot.sendMessage(chatId, text, {
        reply_markup: {
            inline_keyboard: [[{ text: '✖️ Cancelar', callback_data: 'flow_cancel' }]]
        }
    });
};

const activateMembership = (adminChatId, userId, days, modeLabel) => {
    const target = getOrCreateUser(userId);
    const endAt = nowMs() + days * 24 * 60 * 60 * 1000;
    target.membershipEndsAt = endAt;
    target.planDays = days;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);
    appendAudit('membership_set', { adminChatId, userId, days, mode: modeLabel });
    bot.sendMessage(adminChatId, `${modeLabel}: ${userId} => ${days} dias (vence ${formatDate(endAt)}).`);
    bot.sendMessage(
        userId,
        [
            `Tu membresia (${days} dias) fue activada en ${CONFIG.brandName}.`,
            `Vence: ${formatDate(endAt)}`,
            'Ya puedes generar tu key con /genkey o con el boton.'
        ].join('\n')
    ).catch(() => {});
};

const extendMembership = (adminChatId, userId, days) => {
    const target = getOrCreateUser(userId);
    const base = Math.max(nowMs(), Number(target.membershipEndsAt || 0));
    target.membershipEndsAt = base + days * 24 * 60 * 60 * 1000;
    target.planDays = days;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);
    appendAudit('membership_extended', { adminChatId, userId, days });
    bot.sendMessage(adminChatId, `Membresia extendida para ${userId}. Nuevo vencimiento: ${formatDate(target.membershipEndsAt)}`);
    bot.sendMessage(userId, `Tu membresia fue renovada.\nNuevo vencimiento: ${formatDate(target.membershipEndsAt)}`).catch(() => {});
};

const removeMembership = (adminChatId, userId) => {
    const target = getUserById(userId);
    if (!target) {
        bot.sendMessage(adminChatId, 'Usuario no encontrado.');
        return;
    }
    target.membershipEndsAt = 0;
    target.planDays = 0;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);
    appendAudit('membership_removed', { adminChatId, userId });
    bot.sendMessage(adminChatId, `Membresia removida para ${userId}.`);
    bot.sendMessage(userId, 'Tu membresia fue desactivada. Contacta al admin para renovarla.').catch(() => {});
};

const generateAndSendKey = (requestChatId, ownerId, options = {}) => {
    if (!options.bypassLimits) {
        const gate = canUserGenerateKeyNow(ownerId);
        if (!gate.ok) {
            bot.sendMessage(requestChatId, gate.error);
            return;
        }
    }

    const ownerUser = getOrCreateUser(ownerId);
    const ownerTag = ownerUser.username ? `@${ownerUser.username}` : `ID:${ownerId}`;
    const key = createKeyForUser(ownerId, ownerTag);
    markUserGeneratedKey(ownerId);
    appendAudit('key_generated', { ownerId, requestChatId, keyId: key.keyId });
    const out = buildKeyMessage(key);
    bot.sendMessage(ownerId, out).catch(() => {});
    if (String(ownerId) !== String(requestChatId)) {
        bot.sendMessage(requestChatId, `Key generada para ${ownerId}: ${key.key}`);
    }
};

bot.onText(/^\/start$/, (msg) => {
    getOrCreateUser(msg);
    writeDb(db);
    const header = `Bienvenido a ${CONFIG.brandName}`;
    const text = isAdmin(msg) ? `${header}\n\n${adminHelp()}\n\n${userHelp()}` : `${header}\n\n${userHelp()}`;
    bot.sendMessage(msg.chat.id, text, { reply_markup: { remove_keyboard: true } });
    sendMainMenu(msg.chat.id, isAdmin(msg));
});

bot.onText(/^\/help$/, (msg) => {
    const text = isAdmin(msg) ? `${adminHelp()}\n\n${userHelp()}` : userHelp();
    bot.sendMessage(msg.chat.id, text);
});

const usage = {
    addplan: 'Uso: /addplan <telegram_id> <7|15|30>',
    venta: 'Uso: /venta <telegram_id> <7|15|30>',
    extend: 'Uso: /extend <telegram_id> <7|15|30>',
    removeplan: 'Uso: /removeplan <telegram_id>',
    user: 'Uso: /user <telegram_id>',
    activar: 'Uso: /activar <key> <ip> <so> <uuid> [version]'
};

bot.onText(/^\/(addplan|venta|extend|removeplan|user|activar)(?:@\w+)?\s*$/, (msg, match) => {
    const command = match[1];
    if (['addplan', 'venta', 'extend', 'removeplan', 'user'].includes(command) && !isAdmin(msg)) return;
    bot.sendMessage(msg.chat.id, usage[command] || 'Comando incompleto. Usa /help');
});

bot.onText(/^\/prices(?:@\w+)?$/, (msg) => {
    bot.sendMessage(msg.chat.id, CONFIG.pricesText);
});

bot.onText(/^\/addplan(?:@\w+)?\s+(\d+)\s+(\d+)$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    const userId = String(match[1]);
    const days = parseDays(match[2]);
    if (!days) {
        bot.sendMessage(msg.chat.id, 'Dias validos: 7, 15 o 30');
        return;
    }

    const target = getOrCreateUser(userId);
    const endAt = nowMs() + days * 24 * 60 * 60 * 1000;
    target.membershipEndsAt = endAt;
    target.planDays = days;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);

    bot.sendMessage(msg.chat.id, `Plan asignado a ${userId} por ${days} dias.`);
    bot.sendMessage(userId, `Tu membresia fue activada por ${days} dias.\nVence: ${formatDate(endAt)}`).catch(() => {});
});

bot.onText(/^\/venta(?:@\w+)?\s+(\d+)\s+(\d+)$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    const userId = String(match[1]);
    const days = parseDays(match[2]);
    if (!days) {
        bot.sendMessage(msg.chat.id, 'Dias validos: 7, 15 o 30');
        return;
    }

    const target = getOrCreateUser(userId);
    const endAt = nowMs() + days * 24 * 60 * 60 * 1000;
    target.membershipEndsAt = endAt;
    target.planDays = days;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);

    bot.sendMessage(msg.chat.id, `Venta aplicada: ${userId} => ${days} dias (vence ${formatDate(endAt)}).`);
    bot.sendMessage(
        userId,
        [
            `Tu membresia (${days} dias) fue activada en ${CONFIG.brandName}.`,
            `Vence: ${formatDate(endAt)}`,
            'Ya puedes generar tu key con /genkey'
        ].join('\n')
    ).catch(() => {});
});

bot.onText(/^\/extend(?:@\w+)?\s+(\d+)\s+(\d+)$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    const userId = String(match[1]);
    const days = parseDays(match[2]);
    if (!days) {
        bot.sendMessage(msg.chat.id, 'Dias validos: 7, 15 o 30');
        return;
    }

    const target = getOrCreateUser(userId);
    const base = Math.max(nowMs(), Number(target.membershipEndsAt || 0));
    target.membershipEndsAt = base + days * 24 * 60 * 60 * 1000;
    target.planDays = days;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);

    bot.sendMessage(msg.chat.id, `Membresia extendida para ${userId}. Nuevo vencimiento: ${formatDate(target.membershipEndsAt)}`);
    bot.sendMessage(userId, `Tu membresia fue renovada.\nNuevo vencimiento: ${formatDate(target.membershipEndsAt)}`).catch(() => {});
});

bot.onText(/^\/removeplan(?:@\w+)?\s+(\d+)$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    const userId = String(match[1]);
    const target = getUserById(userId);
    if (!target) {
        bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
        return;
    }
    target.membershipEndsAt = 0;
    target.planDays = 0;
    target.notify24For = 0;
    target.notifyExpiredFor = 0;
    writeDb(db);
    bot.sendMessage(msg.chat.id, `Membresia removida para ${userId}.`);
    bot.sendMessage(userId, 'Tu membresia fue desactivada. Contacta al admin para renovarla.').catch(() => {});
});

bot.onText(/^\/miplan(?:@\w+)?$/, (msg) => {
    const user = getOrCreateUser(msg);
    writeDb(db);
    if (membershipActive(user) || isAdmin(msg)) {
        const daysLeft = membershipDaysLeft(user);
        const text = isAdmin(msg)
            ? 'Eres admin: acceso sin limites para generar keys.'
            : `Membresia activa.\nVence: ${formatDate(user.membershipEndsAt)}\nDias restantes: ${daysLeft}`;
        bot.sendMessage(msg.chat.id, text);
        return;
    }
    bot.sendMessage(msg.chat.id, 'No tienes membresia activa.');
});

bot.onText(/^\/genkey(?:@\w+)?(?:\s+(\d+))?$/, (msg, match) => {
    getOrCreateUser(msg);
    writeDb(db);

    let ownerId = String(msg.from.id);
    if (isAdmin(msg) && match[1]) {
        ownerId = String(match[1]);
    }

    if (!isAdmin(msg)) {
        const gate = requireMembership(msg);
        if (!gate.ok) return;
    }

    generateAndSendKey(msg.chat.id, ownerId, { bypassLimits: isAdmin(msg) });
});

bot.onText(/^\/miskeys(?:@\w+)?$/, (msg) => {
    const userId = String(msg.from.id);
    const list = Object.values(db.keys)
        .filter((item) => item.ownerId === userId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 10);

    if (!list.length) {
        bot.sendMessage(msg.chat.id, 'No tienes keys recientes.');
        return;
    }

    const lines = list.map((k) => {
        const status = k.used ? 'USADA' : `EXP ${formatDateTime(k.expiresAt)}`;
        return `${k.keyId}) ${k.key}\nEstado: ${status}`;
    });
    bot.sendMessage(msg.chat.id, lines.join('\n\n'));
});

bot.onText(/^\/activar(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/, (msg, match) => {
    const gate = requireMembership(msg);
    if (!gate.ok) return;

    const keyInput = match[1];
    const ip = match[2];
    const osName = match[3].replace(/_/g, '-');
    const uuid = match[4];
    const version = match[5] || CONFIG.panelVersion;
    const ownerId = String(msg.from.id);
    const result = validateAndActivateKey({
        keyInput,
        requesterId: ownerId,
        requireOwner: true,
        activationData: { ip, os: osName, uuid, version }
    });
    if (!result.ok) {
        bot.sendMessage(msg.chat.id, result.error);
        return;
    }

    const text = buildActivationMessage(result.keyRecord);
    bot.sendMessage(ownerId, text);
});

bot.onText(/^\/users(?:@\w+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    const users = Object.values(db.users)
        .sort((a, b) => Number(b.membershipEndsAt || 0) - Number(a.membershipEndsAt || 0))
        .slice(0, 30);

    if (!users.length) {
        bot.sendMessage(msg.chat.id, 'No hay usuarios en registro.');
        return;
    }

    const lines = users.map((u) => {
        const tag = u.username ? `@${u.username}` : u.firstName || 'sin_nombre';
        const state = membershipActive(u) ? `activo hasta ${formatDate(u.membershipEndsAt)}` : 'sin plan';
        return `${u.id} | ${tag} | ${state}`;
    });
    bot.sendMessage(msg.chat.id, lines.join('\n'));
});

bot.onText(/^\/user(?:@\w+)?\s+(\d+)$/, (msg, match) => {
    if (!isAdmin(msg)) return;
    const userId = String(match[1]);
    const u = getUserById(userId);
    if (!u) {
        bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
        return;
    }

    const keys = Object.values(db.keys).filter((k) => k.ownerId === userId).length;
    const used = Object.values(db.keys).filter((k) => k.ownerId === userId && k.used).length;
    bot.sendMessage(
        msg.chat.id,
        [
            `ID: ${u.id}`,
            `Username: ${u.username ? '@' + u.username : '-'}`,
            `Nombre: ${u.firstName || '-'}`,
            `Membresia: ${membershipActive(u) ? 'activa' : 'inactiva'}`,
            `Vence: ${u.membershipEndsAt ? formatDate(u.membershipEndsAt) : '-'}`,
            `Keys: ${keys} (usadas ${used})`
        ].join('\n')
    );
});

bot.onText(/^\/status(?:@\w+)?$/, (msg) => {
    if (!isAdmin(msg)) return;
    const users = Object.keys(db.users).length;
    const keys = Object.values(db.keys);
    const activeKeys = keys.filter((k) => !k.used && nowMs() <= k.expiresAt).length;
    const usedKeys = keys.filter((k) => k.used).length;
    const activePlans = Object.values(db.users).filter((u) => membershipActive(u)).length;
    bot.sendMessage(msg.chat.id, [
        '📊 Estado Bot',
        `Usuarios: ${users}`,
        `Planes activos: ${activePlans}`,
        `Keys activas: ${activeKeys}`,
        `Keys usadas: ${usedKeys}`,
        `Pendientes flujo: ${pendingActions.size}`,
        `API port: ${CONFIG.botApiPort}`
    ].join('\n'));
});

bot.on('callback_query', (query) => {
    const chatId = query.message?.chat?.id;
    const fromId = String(query.from?.id || '');
    const data = query.data || '';
    const adminMode = isAdmin(fromId);

    if (!chatId) return;
    bot.answerCallbackQuery(query.id).catch(() => {});

    if (data === 'flow_cancel') {
        pendingActions.delete(fromId);
        bot.sendMessage(chatId, 'Operacion cancelada.');
        sendMainMenu(chatId, adminMode);
        return;
    }

    if (data === 'main_admin') {
        if (!adminMode) {
            bot.sendMessage(chatId, 'No autorizado.');
            return;
        }
        sendAdminMenu(chatId);
        return;
    }

    if (data === 'admin_back') {
        sendMainMenu(chatId, adminMode);
        return;
    }

    if (data === 'main_plan') {
        const user = getOrCreateUser(fromId);
        if (membershipActive(user) || adminMode) {
            const daysLeft = membershipDaysLeft(user);
            const out = adminMode
                ? 'Eres admin: acceso sin limites para generar keys.'
                : `Membresia activa.\nVence: ${formatDate(user.membershipEndsAt)}\nDias restantes: ${daysLeft}`;
            bot.sendMessage(chatId, out);
        } else {
            bot.sendMessage(chatId, 'No tienes membresia activa.');
        }
        return;
    }

    if (data === 'main_gen') {
        if (!adminMode) {
            const fakeMsg = { chat: { id: chatId }, from: { id: fromId } };
            const gate = requireMembership(fakeMsg);
            if (!gate.ok) return;
        }
        generateAndSendKey(chatId, fromId, { bypassLimits: adminMode });
        return;
    }

    if (data === 'main_keys') {
        const list = Object.values(db.keys)
            .filter((item) => item.ownerId === fromId)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10);
        if (!list.length) {
            bot.sendMessage(chatId, 'No tienes keys recientes.');
            return;
        }
        const lines = list.map((k) => `${k.keyId}) ${k.key}\nEstado: ${k.used ? 'USADA' : `EXP ${formatDateTime(k.expiresAt)}`}`);
        bot.sendMessage(chatId, lines.join('\n\n'));
        return;
    }

    if (data === 'main_activate') {
        pendingActions.set(fromId, { type: 'activateKey', step: 'ask_key' });
        sendPrompt(chatId, 'Paso 1/5: envia la KEY\n(Escribe cancelar para salir)');
        return;
    }

    if (data === 'main_prices') {
        bot.sendMessage(chatId, CONFIG.pricesText);
        return;
    }

    if (data === 'main_support') {
        bot.sendMessage(chatId, `Contacta al admin: @${CONFIG.adminUsername}`);
        return;
    }

    if (data === 'main_help') {
        const text = adminMode ? `${adminHelp()}\n\n${userHelp()}` : userHelp();
        bot.sendMessage(chatId, text);
        return;
    }

    if (!adminMode) return;

    if (data === 'admin_sale') {
        pendingActions.set(fromId, { type: 'venta', step: 'ask_id' });
        sendPrompt(chatId, 'Envia primero el TELEGRAM_ID del cliente\nEjemplo: 8251878604');
        return;
    }
    if (data === 'admin_extend') {
        pendingActions.set(fromId, { type: 'extend', step: 'ask_id' });
        sendPrompt(chatId, 'Envia primero el TELEGRAM_ID a extender\nEjemplo: 8251878604');
        return;
    }
    if (data === 'admin_remove') {
        pendingActions.set(fromId, { type: 'remove', step: 'ask_id' });
        sendPrompt(chatId, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
        return;
    }
    if (data === 'admin_user') {
        pendingActions.set(fromId, { type: 'userInfo', step: 'ask_id' });
        sendPrompt(chatId, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
        return;
    }
    if (data === 'admin_users') {
        const users = Object.values(db.users)
            .sort((a, b) => Number(b.membershipEndsAt || 0) - Number(a.membershipEndsAt || 0))
            .slice(0, 30);
        if (!users.length) {
            bot.sendMessage(chatId, 'No hay usuarios en registro.');
            return;
        }
        const lines = users.map((u) => {
            const tag = u.username ? `@${u.username}` : u.firstName || 'sin_nombre';
            const state = membershipActive(u) ? `activo hasta ${formatDate(u.membershipEndsAt)}` : 'sin plan';
            return `${u.id} | ${tag} | ${state}`;
        });
        bot.sendMessage(chatId, lines.join('\n'));
        return;
    }
    if (data === 'admin_gen') {
        pendingActions.set(fromId, { type: 'genkeyUser', step: 'ask_id' });
        sendPrompt(chatId, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
    }
});

bot.on('message', (msg) => {
    const text = (msg.text || '').trim();
    if (!text) return;
    if (text.startsWith('/')) return;

    if (/^\.cmd\s*$/i.test(text)) {
        pendingActions.delete(String(msg.from.id));
        sendMainMenu(msg.chat.id, isAdmin(msg));
        return;
    }

    const userId = String(msg.from.id);
    const adminMode = isAdmin(msg);

    const pending = pendingActions.get(userId);
    if (pending) {
        let keepPending = false;
        try {
            if (isCancelText(text)) {
                bot.sendMessage(msg.chat.id, 'Operacion cancelada.');
                return;
            }

            if (pending.type === 'venta' || pending.type === 'addplan') {
                if (pending.step === 'ask_id') {
                    const targetId = text.split(/\s+/)[0];
                    if (!/^\d+$/.test(targetId || '')) {
                        bot.sendMessage(msg.chat.id, 'ID invalido. Envia solo numeros. Ejemplo: 8251878604');
                        return;
                    }
                    pendingActions.set(userId, { type: pending.type, step: 'ask_days', targetId });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Ahora envia los dias del plan: 7, 15 o 30');
                    return;
                }

                if (pending.step === 'ask_days') {
                    const days = parseDays(text.split(/\s+/)[0]);
                    if (!days) {
                        bot.sendMessage(msg.chat.id, 'Dias invalidos. Solo 7, 15 o 30.');
                        return;
                    }
                    activateMembership(msg.chat.id, String(pending.targetId), days, pending.type === 'venta' ? 'Venta aplicada' : 'Plan asignado');
                    return;
                }

                const [targetId, rawDays] = text.split(/\s+/);
                const days = parseDays(rawDays);
                if (!targetId || !days) {
                    bot.sendMessage(msg.chat.id, 'Formato invalido. Ejemplo: 8251878604 30');
                    return;
                }
                activateMembership(msg.chat.id, String(targetId), days, pending.type === 'venta' ? 'Venta aplicada' : 'Plan asignado');
            } else if (pending.type === 'extend') {
                if (pending.step === 'ask_id') {
                    const targetId = text.split(/\s+/)[0];
                    if (!/^\d+$/.test(targetId || '')) {
                        bot.sendMessage(msg.chat.id, 'ID invalido. Envia solo numeros. Ejemplo: 8251878604');
                        return;
                    }
                    pendingActions.set(userId, { type: 'extend', step: 'ask_days', targetId });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Ahora envia los dias a extender: 7, 15 o 30');
                    return;
                }

                if (pending.step === 'ask_days') {
                    const days = parseDays(text.split(/\s+/)[0]);
                    if (!days) {
                        bot.sendMessage(msg.chat.id, 'Dias invalidos. Solo 7, 15 o 30.');
                        return;
                    }
                    extendMembership(msg.chat.id, String(pending.targetId), days);
                    return;
                }

                const [targetId, rawDays] = text.split(/\s+/);
                const days = parseDays(rawDays);
                if (!targetId || !days) {
                    bot.sendMessage(msg.chat.id, 'Formato invalido. Ejemplo: 8251878604 15');
                    return;
                }
                extendMembership(msg.chat.id, String(targetId), days);
            } else if (pending.type === 'remove') {
                const targetId = text.split(/\s+/)[0];
                if (!targetId) {
                    bot.sendMessage(msg.chat.id, 'Formato invalido. Ejemplo: 8251878604');
                    return;
                }
                removeMembership(msg.chat.id, String(targetId));
            } else if (pending.type === 'userInfo') {
                const targetId = text.split(/\s+/)[0];
                const u = getUserById(targetId);
                if (!u) {
                    bot.sendMessage(msg.chat.id, 'Usuario no encontrado.');
                    return;
                }
                const keys = Object.values(db.keys).filter((k) => k.ownerId === String(targetId)).length;
                const used = Object.values(db.keys).filter((k) => k.ownerId === String(targetId) && k.used).length;
                bot.sendMessage(msg.chat.id, [
                    `ID: ${u.id}`,
                    `Username: ${u.username ? '@' + u.username : '-'}`,
                    `Nombre: ${u.firstName || '-'}`,
                    `Membresia: ${membershipActive(u) ? 'activa' : 'inactiva'}`,
                    `Vence: ${u.membershipEndsAt ? formatDate(u.membershipEndsAt) : '-'}`,
                    `Keys: ${keys} (usadas ${used})`
                ].join('\n'));
            } else if (pending.type === 'genkeyUser') {
                const targetId = text.split(/\s+/)[0];
                if (!targetId) {
                    bot.sendMessage(msg.chat.id, 'Formato invalido. Ejemplo: 8251878604');
                    return;
                }
                generateAndSendKey(msg.chat.id, String(targetId), { bypassLimits: true });
            } else if (pending.type === 'activateKey') {
                if (pending.step === 'ask_key') {
                    const keyInput = text.split(/\s+/)[0];
                    if (!keyInput || !db.keys[keyInput]) {
                        bot.sendMessage(msg.chat.id, 'Key invalida o no encontrada. Intenta de nuevo o escribe cancelar.');
                        keepPending = true;
                        return;
                    }
                    const key = db.keys[keyInput];
                    if (key.ownerId !== userId && !adminMode) {
                        bot.sendMessage(msg.chat.id, 'Esta key no te pertenece.');
                        return;
                    }
                    if (key.used) {
                        bot.sendMessage(msg.chat.id, 'Esta key ya fue usada.');
                        return;
                    }
                    if (nowMs() > key.expiresAt) {
                        bot.sendMessage(msg.chat.id, 'Esta key ya expiro (4 horas).');
                        delete db.keys[keyInput];
                        writeDb(db);
                        return;
                    }
                    pendingActions.set(userId, { type: 'activateKey', step: 'ask_ip', keyInput });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Ahora envia la IP de activacion (ej: 3.129.228.232)');
                    return;
                }

                if (pending.step === 'ask_ip') {
                    const ip = text.split(/\s+/)[0];
                    pendingActions.set(userId, { ...pending, step: 'ask_os', ip });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Ahora envia el S.O (ej: Ubuntu-24.04)');
                    return;
                }

                if (pending.step === 'ask_os') {
                    const os = text.split(/\s+/)[0];
                    pendingActions.set(userId, { ...pending, step: 'ask_uuid', os });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Ahora envia el UUID');
                    return;
                }

                if (pending.step === 'ask_uuid') {
                    const uuid = text.split(/\s+/)[0];
                    pendingActions.set(userId, { ...pending, step: 'ask_version', uuid });
                    keepPending = true;
                    sendPrompt(msg.chat.id, 'Envia la version (ej: V3.9.2) o escribe 0 para usar la actual');
                    return;
                }

                if (pending.step !== 'ask_version') {
                    bot.sendMessage(msg.chat.id, 'Flujo invalido, vuelve a intentar con el boton Activar Key.');
                    return;
                }

                const version = text.trim() === '0' ? CONFIG.panelVersion : text.trim();
                const gate = requireMembership(msg);
                if (!gate.ok) return;
                const result = validateAndActivateKey({
                    keyInput: pending.keyInput,
                    requesterId: userId,
                    requireOwner: true,
                    activationData: {
                        ip: pending.ip,
                        os: pending.os,
                        uuid: pending.uuid,
                        version
                    }
                });
                if (!result.ok) {
                    bot.sendMessage(msg.chat.id, result.error);
                    return;
                }
                bot.sendMessage(userId, buildActivationMessage(result.keyRecord));
            }
        } finally {
            if (!keepPending) pendingActions.delete(userId);
        }
        return;
    }

    if (text === 'menu' || text === 'Menu') {
        sendMainMenu(msg.chat.id, adminMode);
        return;
    }

    if (text === '⬅️ Menu Principal') {
        sendMainMenu(msg.chat.id, adminMode);
        return;
    }

    if (text === '👑 Admin Panel' && adminMode) {
        sendAdminMenu(msg.chat.id);
        return;
    }

    if (text === '💳 Precios') {
        bot.sendMessage(msg.chat.id, CONFIG.pricesText);
        return;
    }

    if (text === '🆘 Soporte') {
        bot.sendMessage(msg.chat.id, `Contacta al admin: @${CONFIG.adminUsername}`);
        return;
    }

    if (text === '🧾 Mi Plan') {
        const user = getOrCreateUser(msg);
        writeDb(db);
        if (membershipActive(user) || adminMode) {
            const daysLeft = membershipDaysLeft(user);
            const out = adminMode
                ? 'Eres admin: acceso sin limites para generar keys.'
                : `Membresia activa.\nVence: ${formatDate(user.membershipEndsAt)}\nDias restantes: ${daysLeft}`;
            bot.sendMessage(msg.chat.id, out);
        } else {
            bot.sendMessage(msg.chat.id, 'No tienes membresia activa.');
        }
        return;
    }

    if (text === '🗝️ Generar Mi Key') {
        if (!adminMode) {
            const gate = requireMembership(msg);
            if (!gate.ok) return;
        }
        generateAndSendKey(msg.chat.id, userId, { bypassLimits: adminMode });
        return;
    }

    if (text === '📦 Mis Keys') {
        const list = Object.values(db.keys)
            .filter((item) => item.ownerId === userId)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10);
        if (!list.length) {
            bot.sendMessage(msg.chat.id, 'No tienes keys recientes.');
            return;
        }
        const lines = list.map((k) => `${k.keyId}) ${k.key}\nEstado: ${k.used ? 'USADA' : `EXP ${formatDateTime(k.expiresAt)}`}`);
        bot.sendMessage(msg.chat.id, lines.join('\n\n'));
        return;
    }

    if (text === '⚡ Activar Key') {
        pendingActions.set(userId, { type: 'activateKey', step: 'ask_key' });
        sendPrompt(msg.chat.id, 'Paso 1/5: envia la KEY\n(Escribe cancelar para salir)');
        return;
    }

    if (!adminMode) return;

    if (text === '➕ Vender Membresia') {
        pendingActions.set(userId, { type: 'venta', step: 'ask_id' });
        sendPrompt(msg.chat.id, 'Envia primero el TELEGRAM_ID del cliente\nEjemplo: 8251878604');
        return;
    }
    if (text === '⏫ Extender Membresia') {
        pendingActions.set(userId, { type: 'extend', step: 'ask_id' });
        sendPrompt(msg.chat.id, 'Envia primero el TELEGRAM_ID a extender\nEjemplo: 8251878604');
        return;
    }
    if (text === '❌ Quitar Membresia') {
        pendingActions.set(userId, { type: 'remove', step: 'ask_id' });
        sendPrompt(msg.chat.id, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
        return;
    }
    if (text === '🔎 Ver Usuario') {
        pendingActions.set(userId, { type: 'userInfo', step: 'ask_id' });
        sendPrompt(msg.chat.id, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
        return;
    }
    if (text === '📋 Lista Usuarios') {
        const users = Object.values(db.users)
            .sort((a, b) => Number(b.membershipEndsAt || 0) - Number(a.membershipEndsAt || 0))
            .slice(0, 30);
        if (!users.length) {
            bot.sendMessage(msg.chat.id, 'No hay usuarios en registro.');
            return;
        }
        const lines = users.map((u) => {
            const tag = u.username ? `@${u.username}` : u.firstName || 'sin_nombre';
            const state = membershipActive(u) ? `activo hasta ${formatDate(u.membershipEndsAt)}` : 'sin plan';
            return `${u.id} | ${tag} | ${state}`;
        });
        bot.sendMessage(msg.chat.id, lines.join('\n'));
        return;
    }
    if (text === '🔐 Generar Key (usuario)') {
        pendingActions.set(userId, { type: 'genkeyUser', step: 'ask_id' });
        sendPrompt(msg.chat.id, 'Envia: TELEGRAM_ID\nEjemplo: 8251878604');
    }
});

if (CONFIG.botActivateSecret) {
    const apiServer = http.createServer((req, res) => {
        if (req.method !== 'POST' || (req.url !== '/activate' && req.url !== '/consume' && req.url !== '/panel-credentials')) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
            return;
        }

        const secret = req.headers['x-activate-secret'];
        const remoteIp = getRemoteIp(req);
        if (!isAllowedApiIp(remoteIp)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'IP no permitida' }));
            appendAudit('api_blocked_ip', { ip: remoteIp, url: req.url });
            return;
        }

        if (!safeSecretMatch(secret, CONFIG.botActivateSecret)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            appendAudit('api_bad_secret', { ip: remoteIp, url: req.url });
            return;
        }

        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
            if (body.length > 1024 * 32) req.destroy();
        });

        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');

                if (req.url === '/panel-credentials') {
                    const keyInput = String(payload.key || '').trim();
                    const panelPassword = String(payload.panelPassword || '').trim();
                    const panelUrl = String(payload.panelUrl || '').trim();

                    if (!keyInput || !panelPassword) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'key y panelPassword son requeridos' }));
                        return;
                    }

                    const keyRecord = db.keys[keyInput];
                    if (!keyRecord) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Key no encontrada' }));
                        return;
                    }

                    if (!keyRecord.used) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'La key aun no fue consumida' }));
                        return;
                    }

                    keyRecord.panelCredentialsSentAt = nowMs();
                    keyRecord.panelUrl = panelUrl || keyRecord.panelUrl || CONFIG.panelUrl;
                    writeDb(db);
                    appendAudit('panel_credentials_sent', { ownerId: keyRecord.ownerId, keyId: keyRecord.keyId, ip: remoteIp });

                    const ownerId = keyRecord.ownerId;
                    const message = buildPanelCredentialsMessage({
                        keyRecord,
                        panelUrl: keyRecord.panelUrl,
                        panelPassword
                    });
                    bot.sendMessage(ownerId, message).catch(() => {});

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, ownerId }));
                    return;
                }

                const result = consumeKeyFromApi(payload);

                if (!result.ok) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: result.error }));
                    return;
                }

                const ownerId = result.keyRecord.ownerId;
                bot.sendMessage(ownerId, buildActivationMessage(result.keyRecord)).catch(() => {});
                appendAudit('key_consumed_api', { ownerId, keyId: result.keyRecord.keyId, ip: remoteIp, url: req.url });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    ok: true,
                    ownerId,
                    ownerTag: result.keyRecord.ownerTag || '',
                    keyId: result.keyRecord.keyId
                }));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid payload' }));
            }
        });
    });

    apiServer.listen(CONFIG.botApiPort, '0.0.0.0', () => {
        console.log(`[OK] Activation API escuchando en puerto ${CONFIG.botApiPort}`);
    });
}

bot.on('polling_error', (error) => {
    console.error('[BOT] polling error:', error.message);
});

setInterval(() => {
    refreshMembershipNotices();
    pruneExpiredUnusedKeys();
}, 60 * 1000);

setInterval(() => {
    backupDbSnapshot();
}, Math.max(5, CONFIG.backupIntervalMin) * 60 * 1000);

appendAudit('bot_started', { port: CONFIG.botApiPort });

console.log(`[OK] ${CONFIG.brandName} bot iniciado`);
