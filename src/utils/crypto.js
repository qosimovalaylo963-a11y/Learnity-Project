/**
 * Cryptographic Security Utilities for Learnity
 *
 * - Password hashing using Node's native memory-hard `crypto.scryptSync`
 *   (N=16384, r=8, p=1, 64-byte derived key) with timing-safe verification.
 * - SHA-256 hashing for invitation codes and session tokens so plain-text
 *   invitation codes or session tokens are never stored in the SQLite database.
 * - Cryptographically random invitation code generator (`LRN-XXXX-XXXX-XXXX`).
 */
const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const KEY_LEN = 64;

function hashPassword(password) {
    const plain = String(password || '');
    if (plain.length < 6) {
        throw new Error('Password must be at least 6 characters long.');
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(plain, salt, KEY_LEN, SCRYPT_PARAMS).toString('hex');
    return `scrypt$16384$8$1$${salt}$${derived}`;
}

function verifyPassword(password, storedHash) {
    if (!password || !storedHash || typeof storedHash !== 'string') return false;
    try {
        const parts = storedHash.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
        const N = parseInt(parts[1], 10);
        const r = parseInt(parts[2], 10);
        const p = parseInt(parts[3], 10);
        const salt = parts[4];
        const expectedHex = parts[5];
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        const derivedBuf = crypto.scryptSync(String(password), salt, expectedBuf.length, {
            N,
            r,
            p,
            maxmem: 64 * 1024 * 1024
        });
        if (expectedBuf.length !== derivedBuf.length) return false;
        return crypto.timingSafeEqual(expectedBuf, derivedBuf);
    } catch (_) {
        return false;
    }
}

function normalizeInviteCode(rawCode) {
    return String(rawCode || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function hashInviteCode(rawCode) {
    const normalized = normalizeInviteCode(rawCode);
    return crypto.createHash('sha256').update(`learnity-invite-v1:${normalized}`).digest('hex');
}

function generateRawInviteCode(rolePrefix = 'LRN') {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // Unambiguous uppercase alphanumeric
    const bytes = crypto.randomBytes(12);
    let chars = '';
    for (let i = 0; i < 12; i++) {
        chars += alphabet[bytes[i] % alphabet.length];
    }
    const prefix = String(rolePrefix || 'LRN').toUpperCase().slice(0, 3);
    const formatted = `${prefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
    const codePrefix = `${prefix}-${chars.slice(0, 4)}-••••`;
    return {
        plainCode: formatted,
        codeHash: hashInviteCode(formatted),
        codePrefix
    };
}

function generateSessionToken() {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(`learnity-session:${rawToken}`).digest('hex');
    const csrfToken = crypto.randomBytes(24).toString('hex');
    return { rawToken, tokenHash, csrfToken };
}

function hashSessionToken(rawToken) {
    if (!rawToken) return '';
    return crypto.createHash('sha256').update(`learnity-session:${String(rawToken)}`).digest('hex');
}

function generateApplicationUid() {
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `LRN-APP-${stamp}-${rand}`;
}

module.exports = {
    hashPassword,
    verifyPassword,
    normalizeInviteCode,
    hashInviteCode,
    generateRawInviteCode,
    generateSessionToken,
    hashSessionToken,
    generateApplicationUid
};
