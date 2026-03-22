const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PROJECT_ROOT = path.resolve(__dirname, '..');
const IS_ROOT = typeof process.getuid === 'function' ? process.getuid() === 0 : false;
const ALLOW_NON_ROOT = process.env.PANEL_ALLOW_NON_ROOT === '1';
const SUDO_MODE_AUTO = process.env.PANEL_SUDO_MODE === 'auto';
const PRIVILEGED_RUNNER = path.join(PROJECT_ROOT, 'privileged-runner.sh');
const FORCE_HTTPS = process.env.PANEL_FORCE_HTTPS === '1';
const ENABLE_SYSTEM_USERS = process.env.PANEL_SYSTEM_USERS === '1';

const fs = require('fs');
const CONFIG_FILE = path.join(__dirname, 'config.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'panel.log');
const LOG_MAX_BYTES = Number(process.env.PANEL_LOG_MAX_BYTES || 1024 * 1024);
const SESSION_TTL_MS = Number(process.env.PANEL_SESSION_TTL_MS || 12 * 60 * 60 * 1000);
const COMMAND_TIMEOUT_MS = Number(process.env.PANEL_COMMAND_TIMEOUT_MS || 600000);
const LOGIN_WINDOW_MS = Number(process.env.PANEL_LOGIN_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.PANEL_LOGIN_MAX_ATTEMPTS || 6);
const LOGIN_LOCK_MS = Number(process.env.PANEL_LOGIN_LOCK_MS || 10 * 60 * 1000);
const HASH_PREFIX = 'scrypt$';

const isScryptHash = (value) => typeof value === 'string' && value.startsWith(HASH_PREFIX);

const hashPassword = (password) => {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${HASH_PREFIX}${salt}$${hash}`;
};

const verifyPassword = (password, storedHash) => {
    if (!isScryptHash(storedHash)) return false;
    const parts = storedHash.split('$');
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const hash = parts[2];
    const calculated = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
};

const sanitizePort = (raw) => {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) return 3000;
    if (parsed < 1 || parsed > 65535) return 3000;
    return parsed;
};

const readJsonFile = (filePath, fallbackValue) => {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        const content = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        return fallbackValue;
    }
};

const readConfig = () => {
    const fallback = {
        masterPasswordHash: hashPassword('admin123'),
        port: 3000,
        theme: 'dark'
    };
    const data = readJsonFile(CONFIG_FILE, fallback);

    if (data.masterPasswordHash && isScryptHash(data.masterPasswordHash)) {
        return {
            masterPasswordHash: data.masterPasswordHash,
            port: sanitizePort(data.port),
            theme: typeof data.theme === 'string' ? data.theme : 'dark'
        };
    }

    const legacyPassword = typeof data.masterPassword === 'string' && data.masterPassword
        ? data.masterPassword
        : 'admin123';

    return {
        masterPasswordHash: hashPassword(legacyPassword),
        port: sanitizePort(data.port),
        theme: typeof data.theme === 'string' ? data.theme : 'dark'
    };
};

const saveConfig = (nextConfig) => {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 4));
};

let config = readConfig();
saveConfig(config);
const PORT = sanitizePort(process.env.PANEL_PORT || config.port);
const sessions = new Map();
const loginAttempts = new Map();
const commandJobs = new Map();
const commandQueue = [];
let activeJobId = null;

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const rotateLogIfNeeded = () => {
    try {
        if (!fs.existsSync(LOG_FILE)) return;
        const size = fs.statSync(LOG_FILE).size;
        if (size < LOG_MAX_BYTES) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rotatedPath = path.join(LOG_DIR, `panel-${stamp}.log`);
        fs.renameSync(LOG_FILE, rotatedPath);
    } catch (error) {
        console.error('[LOG] rotate failed:', error.message);
    }
};

const logEvent = (level, message, details = '') => {
    const row = `${new Date().toISOString()} [${level}] ${message}${details ? ` | ${details}` : ''}\n`;
    rotateLogIfNeeded();
    fs.appendFile(LOG_FILE, row, () => {});
};

const getClientIp = (req) => {
    const xfwd = req.headers['x-forwarded-for'];
    if (typeof xfwd === 'string' && xfwd.trim()) return xfwd.split(',')[0].trim();
    return req.socket?.remoteAddress || 'unknown';
};

const getLoginState = (ip) => {
    const now = Date.now();
    const existing = loginAttempts.get(ip);
    if (!existing || now - existing.windowStart > LOGIN_WINDOW_MS) {
        const fresh = { attempts: 0, windowStart: now, lockUntil: 0 };
        loginAttempts.set(ip, fresh);
        return fresh;
    }
    return existing;
};

const recordLoginFailure = (ip) => {
    const now = Date.now();
    const state = getLoginState(ip);
    state.attempts += 1;
    if (state.attempts >= LOGIN_MAX_ATTEMPTS) {
        state.lockUntil = now + LOGIN_LOCK_MS;
    }
    loginAttempts.set(ip, state);
    return state;
};

const clearLoginFailures = (ip) => {
    loginAttempts.delete(ip);
};

const getPrivilegeState = () => {
    const canUseSudoRunner = SUDO_MODE_AUTO && fs.existsSync(PRIVILEGED_RUNNER);
    const canManageSystem = IS_ROOT || ALLOW_NON_ROOT || canUseSudoRunner;
    return {
        rootRequired: true,
        isRoot: IS_ROOT,
        canManageSystem,
        mode: canManageSystem
            ? (IS_ROOT ? 'root' : (ALLOW_NON_ROOT ? 'allow-non-root' : 'sudo-delegated'))
            : 'restricted'
    };
};

const ensureSystemPrivileges = (res) => {
    const state = getPrivilegeState();
    if (state.canManageSystem) return true;
    res.status(403).json({
        error: 'El panel no tiene privilegios suficientes. Inicia el servicio como root para gestionar usuarios, protocolos y puertos.'
    });
    return false;
};

if (!getPrivilegeState().canManageSystem) {
    console.warn('[WARN] ScriptCGH Web Panel sin privilegios de sistema. Inicie como root para habilitar acciones administrativas.');
}

app.use(cors());
app.use(express.json());
app.set('trust proxy', true);
app.disable('x-powered-by');

if (FORCE_HTTPS) {
    app.use((req, res, next) => {
        const proto = req.headers['x-forwarded-proto'];
        if (proto && proto !== 'https') {
            res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
            return;
        }
        next();
    });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/IMG', express.static(path.join(PROJECT_ROOT, 'IMG')));
app.get('/panel-logo', (req, res) => {
    res.sendFile(path.join(__dirname, 'Gemini_Generated_Image_1oxf5m1oxf5m1oxf.png'));
});

const parseAuthToken = (headerValue) => {
    if (typeof headerValue !== 'string') return '';
    const normalized = headerValue.trim();
    if (!normalized) return '';
    if (normalized.toLowerCase().startsWith('bearer ')) {
        return normalized.slice(7).trim();
    }
    return normalized;
};

const createSessionToken = () => crypto.randomBytes(32).toString('hex');

const storeSession = (token) => {
    sessions.set(token, Date.now() + SESSION_TTL_MS);
};

const isSessionValid = (token) => {
    const expiresAt = sessions.get(token);
    if (!expiresAt) return false;
    if (Date.now() > expiresAt) {
        sessions.delete(token);
        return false;
    }
    return true;
};

setInterval(() => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions.entries()) {
        if (expiresAt <= now) sessions.delete(token);
    }
}, 10 * 60 * 1000);

setInterval(() => {
    const now = Date.now();
    for (const [ip, state] of loginAttempts.entries()) {
        const expiredWindow = now - state.windowStart > LOGIN_WINDOW_MS;
        const unlocked = !state.lockUntil || now > state.lockUntil;
        if (expiredWindow && unlocked) {
            loginAttempts.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// Middleware to check authentication
const authenticate = (req, res, next) => {
    const token = parseAuthToken(req.headers.authorization);
    if (isSessionValid(token)) {
        next();
    } else {
        res.status(401).json({ error: 'No autorizado' });
    }
};

// API for Login
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    const ip = getClientIp(req);
    const now = Date.now();
    const state = getLoginState(ip);

    if (state.lockUntil && now < state.lockUntil) {
        const remaining = Math.ceil((state.lockUntil - now) / 1000);
        res.status(429).json({ error: `Demasiados intentos. Espera ${remaining}s e intenta de nuevo.` });
        return;
    }

    const envPass = process.env.PANEL_PASS;
    const valid = typeof envPass === 'string' && envPass.length > 0
        ? password === envPass
        : verifyPassword(password || '', config.masterPasswordHash);

    if (valid) {
        clearLoginFailures(ip);
        const token = createSessionToken();
        storeSession(token);
        logEvent('INFO', 'Login exitoso', `ip=${ip}`);
        res.json({ token });
    } else {
        const failState = recordLoginFailure(ip);
        logEvent('WARN', 'Login fallido', `ip=${ip} attempts=${failState.attempts}`);
        res.status(401).json({ error: 'Contraseña incorrecta' });
    }
});

// API for Settings
app.post('/api/settings', authenticate, (req, res) => {
    const { password } = req.body;
    if (password) {
        if (password.length < 6) {
            res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
            return;
        }
        config.masterPasswordHash = hashPassword(password);
        saveConfig(config);
        logEvent('INFO', 'Password maestra actualizada', `ip=${getClientIp(req)}`);
        res.json({ message: 'Ajustes guardados correctamente' });
    } else {
        res.status(400).json({ error: 'Datos inválidos' });
    }
});

// Protect all other API endpoints
app.use('/api', (req, res, next) => {
    if (req.path === '/login' || req.path === '/settings' || req.path === '/health') return next();
    authenticate(req, res, next);
});

const net = require('net');

const PROTOCOL_CATALOG = [
    {
        id: 'v2ray',
        group: 'tunnels',
        name: 'V2Ray / VLESS',
        description: 'Gestiona servicios Xray/V2Ray y puertos',
        portLabel: '443',
        status: { type: 'port', value: 443 },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['v2ray', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['v2ray', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['v2ray', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['v2ray', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['v2ray', 'status'] }
        ]
    },
    {
        id: 'trojan',
        group: 'tunnels',
        name: 'Trojan',
        description: 'Gestiona servicios Trojan/Trojan-go y puertos',
        portLabel: '8443',
        status: { type: 'port', value: 8443 },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['trojan', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['trojan', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['trojan', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['trojan', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['trojan', 'status'] }
        ]
    },
    {
        id: 'ssh-dropbear',
        group: 'tunnels',
        name: 'SSH / Dropbear',
        description: 'Gestiona SSH, Dropbear, Stunnel y puertos',
        portLabel: '22, 143',
        status: { type: 'port', value: 22 },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['ssh', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['ssh', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['ssh', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['ssh', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['ssh', 'status'] }
        ]
    },
    {
        id: 'shadowsocks',
        group: 'tunnels',
        name: 'Shadowsocks',
        description: 'Gestiona Shadowsocks y puertos',
        portLabel: '8388',
        status: { type: 'port', value: 8388 },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['shadowsocks', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['shadowsocks', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['shadowsocks', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['shadowsocks', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['shadowsocks', 'status'] }
        ]
    },
    {
        id: 'slowdns',
        group: 'tunnels',
        name: 'SlowDNS (DNSTT)',
        description: 'Gestiona dnstt-server y puerto UDP 5300',
        portLabel: '5300/udp',
        status: { type: 'process', value: 'dnstt-server' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['slowdns', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['slowdns', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['slowdns', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['slowdns', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['slowdns', 'status'] }
        ]
    },
    {
        id: 'squid',
        group: 'tunnels',
        name: 'Squid Proxy',
        description: 'Gestiona Squid y puertos del proxy',
        portLabel: '8080',
        status: { type: 'port', value: 8080 },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['squid', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['squid', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['squid', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['squid', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['squid', 'status'] }
        ]
    },
    {
        id: 'socks-simple',
        group: 'tunnels',
        name: 'SOCKS Python SIMPLE',
        description: 'Modo 1 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'PPub.py' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['1'] }
        ]
    },
    {
        id: 'socks-seguro',
        group: 'tunnels',
        name: 'SOCKS Python SEGURO',
        description: 'Modo 2 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'PPriv.py' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['2'] }
        ]
    },
    {
        id: 'socks-directo',
        group: 'tunnels',
        name: 'SOCKS Python DIRECTO',
        description: 'Modo 3 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'PDirect.py' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['3'] }
        ]
    },
    {
        id: 'socks-openvpn',
        group: 'tunnels',
        name: 'SOCKS Python OPENVPN',
        description: 'Modo 4 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'POpen.py' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['4'] }
        ]
    },
    {
        id: 'socks-gettunel',
        group: 'tunnels',
        name: 'SOCKS Python GETTUNEL',
        description: 'Modo 5 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'PGet.py' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['5'] }
        ]
    },
    {
        id: 'socks-tcp-bypass',
        group: 'tunnels',
        name: 'SOCKS TCP BYPASS',
        description: 'Modo 6 de HTools/sockspy.sh',
        portLabel: 'Variable',
        status: { type: 'process', value: 'scktcheck' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'HTools/sockspy.sh', args: ['6'] }
        ]
    },
    {
        id: 'badvpn',
        group: 'tunnels',
        name: 'BadVPN (UDP)',
        description: 'Gestiona badvpn-udpgw y puerto UDP 7300',
        portLabel: '7300/udp',
        status: { type: 'process', value: 'badvpn-udpgw' },
        actions: [
            { id: 'start', label: 'Iniciar', command: 'protocol-manager.sh', args: ['badvpn', 'start'] },
            { id: 'stop', label: 'Detener', command: 'protocol-manager.sh', args: ['badvpn', 'stop'] },
            { id: 'restart', label: 'Reiniciar', command: 'protocol-manager.sh', args: ['badvpn', 'restart'] },
            { id: 'open-ports', label: 'Abrir puertos', command: 'protocol-manager.sh', args: ['badvpn', 'open-ports'] },
            { id: 'status', label: 'Estado', command: 'protocol-manager.sh', args: ['badvpn', 'status'] },
            { id: 'compile', label: 'Compilar', command: 'HTools/BadVPN/ARM.sh', args: [] }
        ]
    },
    {
        id: 'clean-iptables',
        group: 'tools',
        name: 'Limpiar IPTables',
        description: 'Elimina reglas huérfanas de iptables/ip6tables',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'clean_iptables.sh', args: [] }
        ]
    },
    {
        id: 'limitador-ssh',
        group: 'tools',
        name: 'Limitador SSH',
        description: 'Ejecuta control de conexiones SSH/Dropbear',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'HTools/LIMITADOR/killSSH.sh', args: [] }
        ]
    },
    {
        id: 'socks-lite',
        group: 'tools',
        name: 'SocksPY Lite',
        description: 'Lanzador alternativo de Socks Python',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'HTools/Python/SocksPY-lite.sh', args: [] }
        ]
    },
    {
        id: 'clash-mt',
        group: 'tools',
        name: 'Clash MT',
        description: 'Script principal de Clash',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'HTools/CLASH/mt.sh', args: [] }
        ]
    },
    {
        id: 'clash-mt-v2',
        group: 'tools',
        name: 'Clash MT v2.0.5',
        description: 'Versión alternativa del script Clash',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'HTools/CLASH/mt_v2.0.5.sh', args: [] }
        ]
    },
    {
        id: 'clash-android-global',
        group: 'tools',
        name: 'Clash Android Global',
        description: 'Script para configuración Clash Android',
        actions: [
            { id: 'run', label: 'Ejecutar', command: 'HTools/CLASH/ClashForAndroidGLOBAL.sh', args: [] }
        ]
    }
];

const ALLOWED_COMMANDS = {
    setup: { argPattern: /^$|^--(v2ray|trojan|ssh|shadowsocks)$/ },
    'protocol-manager.sh': { argPattern: /^(ssh|v2ray|trojan|shadowsocks|badvpn|slowdns|squid) (start|stop|restart|status|open-ports)$/ },
    'clean_iptables.sh': { argPattern: /^$/ },
    'HTools/sockspy.sh': { argPattern: /^[1-6]$/ },
    'HTools/BadVPN/ARM.sh': { argPattern: /^$/ },
    'HTools/LIMITADOR/killSSH.sh': { argPattern: /^$/ },
    'HTools/Python/SocksPY-lite.sh': { argPattern: /^$/ },
    'HTools/CLASH/mt.sh': { argPattern: /^$/ },
    'HTools/CLASH/mt_v2.0.5.sh': { argPattern: /^$/ },
    'HTools/CLASH/ClashForAndroidGLOBAL.sh': { argPattern: /^$/ },
    'HTools/AFK/tumbs.sh': { argPattern: /^$/ }
};

const commandExists = (command) => {
    const fullPath = path.resolve(PROJECT_ROOT, command);
    return fs.existsSync(fullPath);
};

const validateAllowedCommand = (command, rawArgs) => {
    const rule = ALLOWED_COMMANDS[command];
    if (!rule) return 'Comando no permitido.';
    if (!commandExists(command)) return 'El script configurado no existe en el servidor.';
    const normalized = typeof rawArgs === 'string' ? rawArgs.trim() : '';
    if (!rule.argPattern.test(normalized)) return 'Argumentos no válidos para este comando.';
    return null;
};

// Helper to check if a port is listening
const isPortOpen = (port) => {
    return new Promise((resolve) => {
        const client = net.connect({ port, host: '127.0.0.1' }, () => {
            client.end();
            resolve(true);
        });
        client.on('error', () => resolve(false));
    });
};

const isProcessRunning = (pattern) => {
    return new Promise((resolve) => {
        execFile('pgrep', ['-f', pattern], (error, stdout) => {
            if (error) {
                resolve(false);
                return;
            }
            resolve(Boolean(stdout.trim()));
        });
    });
};

const resolveProtocolStatus = async (protocol) => {
    if (!protocol.status) return false;
    if (protocol.status.type === 'port') return isPortOpen(protocol.status.value);
    if (protocol.status.type === 'process') return isProcessRunning(protocol.status.value);
    return false;
};

app.get('/api/health', (req, res) => {
    const uptimeSeconds = Math.floor(process.uptime());
    res.json({
        ok: true,
        uptime: uptimeSeconds,
        timestamp: new Date().toISOString(),
        permissions: getPrivilegeState(),
        queue: {
            activeJobId,
            pending: commandQueue.length,
            totalTracked: commandJobs.size
        }
    });
});

const executeAllowedCommand = (command, rawArgs, options = {}) => {
    return new Promise((resolve, reject) => {
        const privilegeState = getPrivilegeState();
        if (!privilegeState.canManageSystem) {
            reject(new Error('Privilegios insuficientes: inicia el panel como root para ejecutar comandos del sistema.'));
            return;
        }

        const rule = ALLOWED_COMMANDS[command];
        if (!rule) {
            reject(new Error('Comando no permitido.'));
            return;
        }

        if (!commandExists(command)) {
            reject(new Error('El script configurado no existe en el servidor.'));
            return;
        }

        const normalized = typeof rawArgs === 'string' ? rawArgs.trim() : '';
        if (!rule.argPattern.test(normalized)) {
            reject(new Error('Argumentos no válidos para este comando.'));
            return;
        }

        const args = normalized ? normalized.split(/\s+/) : [];
        const useSudoDelegated = !IS_ROOT && !ALLOW_NON_ROOT && SUDO_MODE_AUTO;
        const program = useSudoDelegated ? '/bin/bash' : '/bin/bash';
        const finalArgs = useSudoDelegated
            ? [PRIVILEGED_RUNNER, command, ...args]
            : [path.resolve(PROJECT_ROOT, command), ...args];

        const child = execFile(program, finalArgs, { cwd: PROJECT_ROOT, timeout: options.timeout || COMMAND_TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr || stdout || error.message));
                return;
            }
            resolve(stdout || stderr || 'Comando completado exitosamente.');
        });

        if (typeof options.onChild === 'function') {
            options.onChild(child);
        }
    });
};

const createJob = (command, args, requestedBy) => {
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const job = {
        id,
        command,
        args,
        requestedBy,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        output: '',
        error: '',
        pid: null,
        child: null
    };
    commandJobs.set(id, job);
    return job;
};

const trimOutput = (text) => {
    const limit = 20000;
    if (typeof text !== 'string') return '';
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n...[salida truncada]`;
};

const runNextJob = async () => {
    if (activeJobId || commandQueue.length === 0) return;
    const jobId = commandQueue.shift();
    const job = commandJobs.get(jobId);
    if (!job || job.status !== 'queued') {
        runNextJob();
        return;
    }

    activeJobId = job.id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    logEvent('INFO', 'Job iniciado', `id=${job.id} cmd=${job.command}`);

    try {
        const output = await executeAllowedCommand(job.command, job.args, {
            timeout: COMMAND_TIMEOUT_MS,
            onChild: (child) => {
                job.child = child;
                job.pid = child.pid || null;
            }
        });
        job.output = trimOutput(output);
        job.status = 'completed';
        logEvent('INFO', 'Job completado', `id=${job.id}`);
    } catch (error) {
        const message = error?.message || 'Error desconocido';
        job.error = trimOutput(message);
        if (job.status !== 'cancelled') {
            job.status = 'failed';
            logEvent('ERROR', 'Job fallido', `id=${job.id} error=${message}`);
        }
    } finally {
        job.finishedAt = new Date().toISOString();
        job.child = null;
        activeJobId = null;
        setTimeout(runNextJob, 0);
    }
};

const enqueueJob = (command, args, requestedBy) => {
    const job = createJob(command, args, requestedBy);
    commandQueue.push(job.id);
    logEvent('INFO', 'Job en cola', `id=${job.id} cmd=${job.command}`);
    runNextJob();
    return job;
};

const cancelJob = (jobId) => {
    const job = commandJobs.get(jobId);
    if (!job) return { ok: false, reason: 'not_found' };

    if (job.status === 'queued') {
        job.status = 'cancelled';
        job.finishedAt = new Date().toISOString();
        const idx = commandQueue.indexOf(jobId);
        if (idx >= 0) commandQueue.splice(idx, 1);
        logEvent('WARN', 'Job cancelado en cola', `id=${job.id}`);
        return { ok: true, job };
    }

    if (job.status === 'running' && job.child && job.child.pid) {
        try {
            process.kill(job.child.pid, 'SIGTERM');
            job.status = 'cancelled';
            job.finishedAt = new Date().toISOString();
            job.error = 'Cancelado por el usuario';
            logEvent('WARN', 'Job cancelado en ejecucion', `id=${job.id}`);
            return { ok: true, job };
        } catch (error) {
            return { ok: false, reason: 'kill_failed' };
        }
    }

    return { ok: false, reason: 'not_cancellable' };
};

// API to get system status
app.get('/api/status', async (req, res) => {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memUsage = (usedMem / totalMem * 100).toFixed(2);

    const cpuLoad = os.loadavg()[0].toFixed(2); // 1 minute load average

    const protocolStatusEntries = await Promise.all(
        PROTOCOL_CATALOG.map(async (protocol) => [protocol.id, await resolveProtocolStatus(protocol)])
    );
    const protocolStatus = Object.fromEntries(protocolStatusEntries);
    const netInfo = getNetworkSpeedKbps();

    res.json({
        cpu: cpuLoad,
        memory: memUsage,
        uptime: Math.floor(os.uptime()),
        platform: os.platform(),
        arch: os.arch(),
        network: netInfo,
        protocols: protocolStatus,
        permissions: getPrivilegeState(),
        jobQueue: {
            activeJobId,
            pending: commandQueue.length
        }
    });
});

app.get('/api/protocols', async (req, res) => {
    const protocolStatusEntries = await Promise.all(
        PROTOCOL_CATALOG.map(async (protocol) => [protocol.id, await resolveProtocolStatus(protocol)])
    );
    const protocolStatus = Object.fromEntries(protocolStatusEntries);

    const protocols = PROTOCOL_CATALOG.map((protocol) => ({
        id: protocol.id,
        group: protocol.group,
        name: protocol.name,
        description: protocol.description,
        portLabel: protocol.portLabel || 'N/A',
        isOnline: protocolStatus[protocol.id],
        actions: protocol.actions.map((action) => ({ id: action.id, label: action.label }))
    }));

    res.json({ protocols });
});

app.post('/api/protocols/:id/action', async (req, res) => {
    if (!ensureSystemPrivileges(res)) return;

    const { id } = req.params;
    const { action } = req.body || {};

    const protocol = PROTOCOL_CATALOG.find((item) => item.id === id);
    if (!protocol) {
        res.status(404).json({ error: 'Protocolo no encontrado' });
        return;
    }

    const selectedAction = protocol.actions.find((item) => item.id === action);
    if (!selectedAction) {
        res.status(400).json({ error: 'Acción inválida para este protocolo' });
        return;
    }

    if (selectedAction.message) {
        res.json({ output: selectedAction.message });
        return;
    }

    const command = selectedAction.command;
    const args = (selectedAction.args || []).join(' ');
    const validationError = validateAllowedCommand(command, args);
    if (validationError) {
        res.status(400).json({ error: validationError });
        return;
    }

    const requestUser = getClientIp(req);
    const job = enqueueJob(command, args, requestUser);
    res.status(202).json({
        jobId: job.id,
        status: job.status,
        message: 'Accion encolada para ejecucion'
    });
});

// API to execute scripts (Restricted to relevant scripts)
app.post('/api/execute', (req, res) => {
    if (!ensureSystemPrivileges(res)) return;

    const { command, args } = req.body;
    const normalizedArgs = typeof args === 'string' ? args : '';
    const validationError = validateAllowedCommand(command, normalizedArgs);
    if (validationError) {
        res.status(400).json({ error: validationError });
        return;
    }

    const requestUser = getClientIp(req);
    const job = enqueueJob(command, normalizedArgs, requestUser);
    res.status(202).json({
        jobId: job.id,
        status: job.status,
        message: 'Comando encolado para ejecucion'
    });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = commandJobs.get(req.params.id);
    if (!job) {
        res.status(404).json({ error: 'Job no encontrado' });
        return;
    }

    res.json({
        id: job.id,
        command: job.command,
        args: job.args,
        status: job.status,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        output: job.output,
        error: job.error,
        pid: job.pid
    });
});

app.get('/api/jobs', (req, res) => {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const jobs = Array.from(commandJobs.values())
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, limit)
        .map((job) => ({
            id: job.id,
            command: job.command,
            status: job.status,
            createdAt: job.createdAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt
        }));

    res.json({
        activeJobId,
        pending: commandQueue.length,
        jobs
    });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
    const result = cancelJob(req.params.id);
    if (!result.ok) {
        const status = result.reason === 'not_found' ? 404 : 400;
        res.status(status).json({ error: 'No se pudo cancelar el job' });
        return;
    }

    res.json({ message: 'Job cancelado', id: result.job.id, status: result.job.status });
});

app.get('/api/logs', (req, res) => {
    const lines = Math.min(500, Math.max(10, Number(req.query.lines || 120)));
    try {
        if (!fs.existsSync(LOG_FILE)) {
            res.json({ log: '' });
            return;
        }

        const content = fs.readFileSync(LOG_FILE, 'utf8');
        const chunks = content.split('\n').filter(Boolean);
        const tail = chunks.slice(-lines).join('\n');
        res.json({ log: tail });
    } catch (error) {
        res.status(500).json({ error: 'No se pudo leer el log' });
    }
});

// Helper to read users
const readUsers = () => {
    const users = readJsonFile(USERS_FILE, []);
    return Array.isArray(users) ? users : [];
};

const isSafeLinuxUsername = (value) => /^[a-z_][a-z0-9_-]{0,31}$/i.test(value || '');

const runSystemCommand = (program, args) => new Promise((resolve, reject) => {
    execFile(program, args, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) {
            reject(new Error((stderr || error.message || '').trim()));
            return;
        }
        resolve((stdout || '').trim());
    });
});

const syncSystemUser = async (action, username) => {
    if (!ENABLE_SYSTEM_USERS) return;
    if (!getPrivilegeState().canManageSystem) throw new Error('Sin permisos para sincronizar usuarios del sistema');
    if (!isSafeLinuxUsername(username)) throw new Error('Nombre de usuario no valido para Linux');

    if (action === 'add') {
        await runSystemCommand('useradd', ['-m', '-s', '/usr/sbin/nologin', username]);
    }
    if (action === 'delete') {
        await runSystemCommand('userdel', ['-r', username]);
    }
};

// API to get users
app.get('/api/users', (req, res) => {
    res.json(readUsers());
});

// API to add user
app.post('/api/users/add', async (req, res) => {
    const { user, password, date, limit } = req.body;
    if (!user || !date || !limit) {
        res.status(400).json({ error: 'Datos incompletos' });
        return;
    }

    const users = readUsers();
    if (users.some((item) => item.user === user)) {
        res.status(409).json({ error: 'El usuario ya existe' });
        return;
    }

    try {
        await syncSystemUser('add', user);
        users.push({ user, password: password || '', date, limit });
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        logEvent('INFO', 'Usuario agregado', `user=${user} ip=${getClientIp(req)}`);
        res.json({ message: 'Usuario añadido con éxito' });
    } catch (error) {
        res.status(500).json({ error: error.message || 'No se pudo crear el usuario' });
    }
});

// API to delete user
app.post('/api/users/delete', async (req, res) => {
    const { user } = req.body;
    if (!user) {
        res.status(400).json({ error: 'Usuario inválido' });
        return;
    }

    let users = readUsers();
    const previousLength = users.length;
    users = users.filter(u => u.user !== user);
    if (users.length === previousLength) {
        res.status(404).json({ error: 'Usuario no encontrado' });
        return;
    }

    try {
        await syncSystemUser('delete', user);
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        logEvent('INFO', 'Usuario eliminado', `user=${user} ip=${getClientIp(req)}`);
        res.json({ message: 'Usuario eliminado' });
    } catch (error) {
        res.status(500).json({ error: error.message || 'No se pudo eliminar el usuario' });
    }
});

// API to update user
app.post('/api/users/update', (req, res) => {
    const { user, currentUser, password, date, limit } = req.body;
    const targetUser = currentUser || user;

    if (!targetUser || !user || !date || !limit) {
        return res.status(400).json({ error: 'Datos incompletos' });
    }

    const users = readUsers();
    const idx = users.findIndex(u => u.user === targetUser);
    if (idx === -1) {
        return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (user !== targetUser && users.some((u) => u.user === user)) {
        return res.status(409).json({ error: 'El nuevo nombre de usuario ya existe' });
    }

    users[idx] = { user, password: password || '', date, limit };
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    logEvent('INFO', 'Usuario actualizado', `from=${targetUser} to=${user} ip=${getClientIp(req)}`);
    res.json({ message: 'Usuario actualizado con éxito' });
});

app.listen(PORT, () => {
    console.log(`ScriptCGH Web Panel running at http://localhost:${PORT}`);
    logEvent('INFO', 'Panel iniciado', `port=${PORT} mode=${getPrivilegeState().mode}`);
});

let previousNetworkSnapshot = null;

function getNetworkTotalsBytes() {
    try {
        const content = fs.readFileSync('/proc/net/dev', 'utf8');
        const lines = content.split('\n').slice(2).filter(Boolean);
        let rxBytes = 0;
        let txBytes = 0;

        for (const line of lines) {
            const [ifaceRaw, valuesRaw] = line.split(':');
            if (!ifaceRaw || !valuesRaw) continue;
            const iface = ifaceRaw.trim();
            if (iface === 'lo') continue;
            const values = valuesRaw.trim().split(/\s+/);
            if (values.length < 10) continue;
            rxBytes += Number(values[0] || 0);
            txBytes += Number(values[8] || 0);
        }

        return { rxBytes, txBytes };
    } catch (error) {
        return null;
    }
}

function getNetworkSpeedKbps() {
    const now = Date.now();
    const current = getNetworkTotalsBytes();
    if (!current) return { up: '0.0', down: '0.0' };

    if (!previousNetworkSnapshot) {
        previousNetworkSnapshot = { ...current, timestamp: now };
        return { up: '0.0', down: '0.0' };
    }

    const deltaSeconds = (now - previousNetworkSnapshot.timestamp) / 1000;
    if (deltaSeconds <= 0) return { up: '0.0', down: '0.0' };

    const rxDelta = Math.max(0, current.rxBytes - previousNetworkSnapshot.rxBytes);
    const txDelta = Math.max(0, current.txBytes - previousNetworkSnapshot.txBytes);
    previousNetworkSnapshot = { ...current, timestamp: now };

    const down = (rxDelta / deltaSeconds / 1024).toFixed(1);
    const up = (txDelta / deltaSeconds / 1024).toFixed(1);
    return { up, down };
}
