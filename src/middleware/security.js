/**
 * Security, Session, Rate Limiting, Multipart Upload, and Role/Subject Authorization Middleware
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashSessionToken } = (() => { try { return require('../utils/crypto'); } catch(_) { return require('./crypto'); } })();

const SESSION_COOKIE_NAME = 'learnity_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Rate limiting buckets: key -> { count, resetAt }
const rateBuckets = new Map();

function checkRateLimit(key, maxRequests = 15, windowMs = 60 * 1000) {
    const now = Date.now();
    let entry = rateBuckets.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        rateBuckets.set(key, entry);
    }
    entry.count += 1;
    return {
        allowed: entry.count <= maxRequests,
        remaining: Math.max(0, maxRequests - entry.count),
        retryAfterSec: Math.ceil((entry.resetAt - now) / 1000)
    };
}

function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    String(cookieHeader)
        .split(';')
        .forEach((pair) => {
            const idx = pair.indexOf('=');
            if (idx > 0) {
                const k = pair.slice(0, idx).trim();
                const v = pair.slice(idx + 1).trim();
                try {
                    out[k] = decodeURIComponent(v);
                } catch (_) {
                    out[k] = v;
                }
            }
        });
    return out;
}

function buildCookieHeader(name, value, maxAgeSec = 7 * 24 * 3600) {
    const isProd = process.env.NODE_ENV === 'production';
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSec}`
    ];
    if (isProd) parts.push('Secure');
    return parts.join('; ');
}

async function resolveSessionUser(db, req) {
    const cookies = parseCookies(req.headers.cookie);
    const rawToken = cookies[SESSION_COOKIE_NAME] || req.headers['x-session-token'] || '';
    if (!rawToken) return null;

    const tokenHash = hashSessionToken(rawToken);
    const session = await db.get(
        `SELECT s.id AS session_id, s.csrf_token, s.expires_at, u.*
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.session_token_hash = ?`,
        [tokenHash]
    );
    if (!session) return null;

    if (new Date(session.expires_at).getTime() <= Date.now()) {
        await db.run("DELETE FROM user_sessions WHERE id = ?", [session.session_id]);
        return null;
    }

    if (session.status !== 'active') {
        return null;
    }

    // Load user's subject permissions
    const subjectPerms = await db.all(
        `SELECT us.*, s.slug AS subject_slug, s.name AS subject_name
         FROM user_subjects us
         JOIN subjects s ON s.id = us.subject_id
         WHERE us.user_id = ?`,
        [session.id]
    );

    const subjectPermMap = {};
    for (const sp of subjectPerms) {
        subjectPermMap[sp.subject_id] = sp;
        subjectPermMap[sp.subject_slug] = sp;
    }

    let delegatable = {};
    try {
        delegatable = JSON.parse(session.delegatable_permissions_json || '{}');
    } catch (_) {}

    return {
        id: session.id,
        sessionId: session.session_id,
        csrfToken: session.csrf_token,
        full_name: session.full_name,
        email: session.email,
        role: session.role,
        status: session.status,
        phone_or_telegram: session.phone_or_telegram,
        bio: session.bio,
        avatar_url: session.avatar_url,
        can_generate_codes: Boolean(session.can_generate_codes || session.role === 'OWNER'),
        can_invite_members: Boolean(session.can_invite_members || session.role === 'OWNER'),
        can_create_announcements: Boolean(session.can_create_announcements || session.role === 'OWNER'),
        delegatable_permissions: delegatable,
        subjectPermissions: subjectPerms,
        subjectPermMap
    };
}

function hasSubjectPermission(user, subjectIdOrSlug, permFlag = 'can_access_subject') {
    if (!user) return false;
    if (user.role === 'OWNER') return true;
    const perm = user.subjectPermMap?.[subjectIdOrSlug];
    if (!perm || !perm.can_access_subject) return false;
    return Boolean(perm[permFlag]);
}

async function logActivity(db, { user, actionType, targetType = '', targetId = '', description = '', ipAddress = '', metadata = {} }) {
    try {
        await db.run(
            `INSERT INTO activity_logs (actor_user_id, actor_name, actor_role, action_type, target_type, target_id, description, ip_address, metadata_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                user ? user.id : null,
                user ? user.full_name : 'Visitor',
                user ? user.role : 'VISITOR',
                actionType,
                String(targetType),
                String(targetId),
                description,
                ipAddress || '127.0.0.1',
                JSON.stringify(metadata || {})
            ]
        );
    } catch (err) {
        console.error('[Audit Log Error]:', err.message);
    }
}

/**
 * Safe Multipart/Form-Data & JSON Body Parser with File Size and Magic-Byte Validation
 */
function readRequestBody(req, maxBytes = 12 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error('File or payload size exceeds the maximum allowed limit (12 MB).'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseMultipart(buffer, contentType) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!match) throw new Error('Missing multipart boundary');
    const boundary = '--' + (match[1] || match[2]).trim();
    const boundaryBuf = Buffer.from(boundary);

    const fields = {};
    const files = [];

    let pos = buffer.indexOf(boundaryBuf);
    while (pos !== -1) {
        const start = pos + boundaryBuf.length;
        if (buffer.slice(start, start + 2).toString() === '--') break;
        const nextPos = buffer.indexOf(boundaryBuf, start);
        if (nextPos === -1) break;

        // Strip leading CRLF and trailing CRLF before next boundary
        let part = buffer.slice(start + 2, nextPos - 2);
        const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
        if (headerEnd !== -1) {
            const rawHeaders = part.slice(0, headerEnd).toString('utf8');
            const body = part.slice(headerEnd + 4);
            const nameMatch = /name="([^"]+)"/i.exec(rawHeaders);
            const filenameMatch = /filename="([^"]*)"/i.exec(rawHeaders);
            const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(rawHeaders);

            const fieldName = nameMatch ? nameMatch[1] : 'file';
            if (filenameMatch && filenameMatch[1]) {
                files.push({
                    fieldName,
                    originalName: path.basename(filenameMatch[1]),
                    mimeType: typeMatch ? typeMatch[1].trim().toLowerCase() : 'application/octet-stream',
                    buffer: body,
                    size: body.length
                });
            } else {
                fields[fieldName] = body.toString('utf8');
            }
        }
        pos = nextPos;
    }

    return { fields, files };
}

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
const ALLOWED_DOC_MIMES = new Set([
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/webp'
]);

function validateAndSaveUploadedFile(fileObj, uploadDir, allowedSet = ALLOWED_IMAGE_MIMES, maxBytes = 8 * 1024 * 1024) {
    if (!fileObj || !fileObj.buffer || fileObj.size === 0) {
        throw new Error('Uploaded file is empty.');
    }
    if (fileObj.size > maxBytes) {
        throw new Error(`File exceeds maximum size of ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    }
    if (!allowedSet.has(fileObj.mimeType)) {
        throw new Error(`Unsupported file type (${fileObj.mimeType}).`);
    }

    // Verify magic bytes for common formats to prevent disguised executable uploads
    const buf = fileObj.buffer;
    const isPng = buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isGif = buf.length > 4 && buf.slice(0, 4).toString('ascii') === 'GIF8';
    const isWebp = buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
    const isPdf = buf.length > 4 && buf.slice(0, 4).toString('ascii') === '%PDF';
    const isZipOffice = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // DOCX/PPTX

    if (fileObj.mimeType.startsWith('image/') && !(isPng || isJpg || isGif || isWebp)) {
        throw new Error('Invalid image file signature.');
    }
    if (fileObj.mimeType === 'application/pdf' && !isPdf) {
        throw new Error('Invalid PDF file signature.');
    }
    if (fileObj.mimeType.includes('officedocument') && !isZipOffice) {
        throw new Error('Invalid Office document signature.');
    }

    fs.mkdirSync(uploadDir, { recursive: true });
    const ext = path.extname(fileObj.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
    const storedName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    const storagePath = path.join(uploadDir, storedName);
    fs.writeFileSync(storagePath, buf);

    return {
        originalName: fileObj.originalName,
        storedName,
        mimeType: fileObj.mimeType,
        sizeBytes: fileObj.size,
        storagePath,
        publicUrl: `/uploads/${storedName}`
    };
}

module.exports = {
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_DOC_MIMES,
    checkRateLimit,
    parseCookies,
    buildCookieHeader,
    resolveSessionUser,
    hasSubjectPermission,
    logActivity,
    readRequestBody,
    parseMultipart,
    validateAndSaveUploadedFile
};
