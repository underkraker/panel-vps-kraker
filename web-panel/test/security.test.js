const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createSessionToken,
    hashPassword,
    parseAuthToken,
    verifyPassword
} = require('../lib/security');

test('hashPassword and verifyPassword validate credentials', () => {
    const hash = hashPassword('clave-super-segura');
    assert.equal(verifyPassword('clave-super-segura', hash), true);
    assert.equal(verifyPassword('clave-invalida', hash), false);
});

test('parseAuthToken accepts bearer and raw format', () => {
    assert.equal(parseAuthToken('Bearer abc123'), 'abc123');
    assert.equal(parseAuthToken('abc123'), 'abc123');
    assert.equal(parseAuthToken('  bearer   token-x  '), 'token-x');
    assert.equal(parseAuthToken(''), '');
});

test('createSessionToken returns random hex token', () => {
    const tokenA = createSessionToken();
    const tokenB = createSessionToken();
    assert.match(tokenA, /^[a-f0-9]{64}$/);
    assert.match(tokenB, /^[a-f0-9]{64}$/);
    assert.notEqual(tokenA, tokenB);
});
