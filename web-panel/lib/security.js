const crypto = require('crypto');

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

module.exports = {
    createSessionToken,
    hashPassword,
    isScryptHash,
    parseAuthToken,
    verifyPassword
};
