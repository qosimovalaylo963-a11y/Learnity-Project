/**
 * Complete REST API Router for Learnity Full-Stack Ecosystem
 *
 * Implements:
 * - Authentication & Sessions (`/api/auth/*` + backward-compatible `/api/admin/login`, `/api/admin/logout`)
 * - Two-Way Registration:
 *   - Path A: Public Member & Staff Applications (`/api/applications`, `/api/owner/applications/*`)
 *   - Path B: Invitation-Code Verification & Registration (`/api/invitations/verify`, `/api/auth/register-invite`)
 * - Advanced Invitation Code Generator (`/api/invitations`, `/api/invitations/:id/revoke`)
 * - Subject-Specific Learning Hubs & Resource Moderation (`/api/subjects`, `/api/subjects/:slug`, `/api/resources`, `/api/resources/:id/*`)
 * - Staff Workspace & Public Staff Directory (`/api/staff`, `/api/staff/workspace`, `/api/owner/staff/*`)
 * - Persistent Media Management System (`/api/media`, `/api/owner/media/*`, `/api/admin/uploads`)
 * - Owner Dashboard, Member Portal, Announcements, Permissions & Audit Logs (`/api/owner/*`, `/api/member/*`, `/api/announcements`)
 */
const fs = require('fs');
const path = require('path');
const {
    hashPassword,
    verifyPassword,
    hashInviteCode,
    generateRawInviteCode,
    generateSessionToken,
    generateApplicationUid
} = (() => { try { return require('../utils/crypto'); } catch(_) { return require('./crypto'); } })();
const { sendEmailNotification } = (() => { try { return require('../utils/mailer'); } catch(_) { return require('./mailer'); } })();
const {
    SESSION_COOKIE_NAME,
    SESSION_TTL_MS,
    ALLOWED_IMAGE_MIMES,
    ALLOWED_DOC_MIMES,
    checkRateLimit,
    buildCookieHeader,
    resolveSessionUser,
    hasSubjectPermission,
    logActivity,
    readRequestBody,
    parseMultipart,
    validateAndSaveUploadedFile
} = (() => { try { return require('../middleware/security'); } catch(_) { return require('./security'); } })();

function sendJson(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN',
        ...extraHeaders
    });
    res.end(body);
}

async function parseJsonBody(req) {
    const buf = await readRequestBody(req, 2 * 1024 * 1024);
    if (!buf || buf.length === 0) return {};
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch (_) {
        throw new Error('Invalid JSON request payload.');
    }
}

async function validateInvitationRecord(db, rawCode) {
    if (!rawCode || String(rawCode).trim().length < 6) {
        return { valid: false, error: 'Please enter a valid invitation code.' };
    }
    const codeHash = hashInviteCode(rawCode);
    const invite = await db.get("SELECT * FROM invitation_codes WHERE code_hash = ?", [codeHash]);
    if (!invite) {
        return { valid: false, error: 'Invalid invitation code. Please check the code and try again.' };
    }
    if (invite.status === 'revoked') {
        return { valid: false, error: 'This invitation code has been revoked by the platform administrator.' };
    }
    if (new Date(invite.expires_at).getTime() <= Date.now() || invite.status === 'expired') {
        if (invite.status !== 'expired') {
            await db.run("UPDATE invitation_codes SET status = 'expired' WHERE id = ?", [invite.id]);
        }
        return { valid: false, error: 'This invitation code has expired.' };
    }
    if (invite.uses_count >= invite.max_uses || invite.status === 'exhausted') {
        if (invite.status !== 'exhausted') {
            await db.run("UPDATE invitation_codes SET status = 'exhausted' WHERE id = ?", [invite.id]);
        }
        return { valid: false, error: 'This invitation code has already reached its maximum number of uses.' };
    }

    const perms = await db.all(
        `SELECT ip.*, s.slug AS subject_slug, s.name AS subject_name, s.category, s.icon_name, s.accent_color
         FROM invitation_permissions ip
         JOIN subjects s ON s.id = ip.subject_id
         WHERE ip.invitation_id = ?`,
        [invite.id]
    );

    return {
        valid: true,
        invitation: {
            id: invite.id,
            codePrefix: invite.code_prefix,
            targetRole: invite.target_role,
            issuerName: invite.issuer_name,
            label: invite.label,
            maxUses: invite.max_uses,
            usesCount: invite.uses_count,
            remainingUses: invite.max_uses - invite.uses_count,
            expiresAt: invite.expires_at,
            status: invite.status,
            permissions: perms
        }
    };
}

async function createSessionForUser(db, user, req) {
    const { rawToken, tokenHash, csrfToken } = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const ip = req.socket?.remoteAddress || '127.0.0.1';
    const ua = String(req.headers['user-agent'] || '').slice(0, 250);

    await db.run(
        `INSERT INTO user_sessions (session_token_hash, csrf_token, user_id, ip_address, user_agent, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [tokenHash, csrfToken, user.id, ip, ua, expiresAt]
    );
    await db.run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);
    const cookie = buildCookieHeader(SESSION_COOKIE_NAME, rawToken, Math.floor(SESSION_TTL_MS / 1000));
    return { rawToken, csrfToken, expiresAt, cookie };
}

async function handleApiRequest(req, res, { db, uploadDir, backupDir }) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;
    const method = req.method.toUpperCase();
    const ip = req.socket?.remoteAddress || '127.0.0.1';

    try {
        const currentUser = await resolveSessionUser(db, req);

        // Enforce CSRF on state-changing requests when authenticated via session cookie
        if (currentUser && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            const clientCsrf = req.headers['x-csrf-token'];
            if (clientCsrf && clientCsrf !== currentUser.csrfToken) {
                return sendJson(res, 403, { error: 'Invalid CSRF token.' });
            }
        }

        // =========================================================
        // 1. PUBLIC & SITE CONTENT ENDPOINTS
        // =========================================================
        if (pathname === '/api/public/stats' && method === 'GET') {
            const [apps, members, staff, subjects, resources, media] = await Promise.all([
                db.get("SELECT COUNT(*) AS cnt FROM applications"),
                db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'MEMBER' AND status = 'active'"),
                db.get("SELECT COUNT(*) AS cnt FROM staff_profiles WHERE is_visible = 1"),
                db.get("SELECT COUNT(*) AS cnt FROM subjects WHERE is_active = 1"),
                db.get("SELECT COUNT(*) AS cnt FROM resources WHERE moderation_status = 'Published'"),
                db.get("SELECT COUNT(*) AS cnt FROM media_assets WHERE is_visible = 1 AND is_archived = 0")
            ]);
            return sendJson(res, 200, {
                applicationsCount: apps?.cnt || 0,
                membersCount: members?.cnt || 0,
                staffCount: staff?.cnt || 0,
                subjectsCount: subjects?.cnt || 0,
                resourcesCount: resources?.cnt || 0,
                mediaCount: media?.cnt || 0
            });
        }

        if (pathname === '/api/public/bootstrap' && method === 'GET') {
            const [subjects, staff, media, announcements, savedTextsRow, stats] = await Promise.all([
                db.all("SELECT id, slug, name, category, short_description, intro_html, icon_name, accent_color, lead_instructor, schedule_label, display_order FROM subjects WHERE is_active = 1 ORDER BY display_order ASC, id ASC"),
                db.all("SELECT id, full_name, position, department, photo_url, bio, responsibilities, assigned_subjects_label, pos_x, pos_y, scale, display_order FROM staff_profiles WHERE is_visible = 1 ORDER BY display_order ASC, id ASC"),
                db.all("SELECT id, card_key, title, caption_date, description, category, image_url, pos_x, pos_y, scale, crop_aspect, display_order, is_hero FROM media_assets WHERE is_visible = 1 AND is_archived = 0 ORDER BY is_hero DESC, display_order ASC, id ASC"),
                db.all("SELECT id, subject_id, author_name, title, body, priority, audience, is_pinned, created_at FROM announcements WHERE audience = 'all' ORDER BY is_pinned DESC, id DESC LIMIT 8"),
                db.get("SELECT content_json FROM site_content WHERE content_key = 'page_texts'"),
                db.get("SELECT COUNT(*) AS cnt FROM applications")
            ]);

            // Attach resource counts per subject (metadata only — never leak restricted file URLs!)
            const resCounts = await db.all("SELECT subject_id, COUNT(*) AS cnt FROM resources WHERE moderation_status = 'Published' GROUP BY subject_id");
            const countMap = Object.fromEntries(resCounts.map((r) => [r.subject_id, r.cnt]));

            const enrichedSubjects = subjects.map((s) => ({
                ...s,
                publishedResourcesCount: countMap[s.id] || 0,
                hasAccess: currentUser ? hasSubjectPermission(currentUser, s.id, 'can_access_subject') : false
            }));

            let pageTexts = {};
            if (savedTextsRow?.content_json) {
                try { pageTexts = JSON.parse(savedTextsRow.content_json); } catch (_) {}
            }

            const heroAsset = media.find((m) => m.is_hero === 1) || null;
            const galleryCards = media.filter((m) => m.is_hero === 0).map((m) => ({
                id: m.card_key,
                mediaId: m.id,
                category: m.category,
                date: m.caption_date,
                title: m.title,
                description: m.description,
                imageSrc: m.image_url,
                posX: m.pos_x,
                posY: m.pos_y,
                scale: m.scale,
                cropAspect: m.crop_aspect
            }));

            return sendJson(res, 200, {
                user: currentUser,
                subjects: enrichedSubjects,
                staffDirectory: staff,
                heroPhotoState: heroAsset
                    ? { posX: heroAsset.pos_x, posY: heroAsset.pos_y, scale: heroAsset.scale, imageSrc: heroAsset.image_url, title: heroAsset.title }
                    : { posX: 50, posY: 40, scale: 1.02, imageSrc: null },
                lessonCards: galleryCards,
                announcements,
                pageTexts,
                applicationsCount: stats?.cnt || 0
            });
        }

        // Legacy compatibility endpoint `/api/site-content`
        if (pathname === '/api/site-content' && method === 'GET') {
            const [media, savedTextsRow] = await Promise.all([
                db.all("SELECT * FROM media_assets WHERE is_visible = 1 AND is_archived = 0 ORDER BY is_hero DESC, display_order ASC, id ASC"),
                db.get("SELECT content_json FROM site_content WHERE content_key = 'page_texts'")
            ]);
            const heroAsset = media.find((m) => m.is_hero === 1);
            const lessonCards = media.filter((m) => m.is_hero === 0).map((m) => ({
                id: m.card_key,
                mediaId: m.id,
                category: m.category,
                date: m.caption_date,
                title: m.title,
                description: m.description,
                imageSrc: m.image_url,
                posX: m.pos_x,
                posY: m.pos_y,
                scale: m.scale
            }));
            let pageTexts = {};
            if (savedTextsRow?.content_json) {
                try { pageTexts = JSON.parse(savedTextsRow.content_json); } catch (_) {}
            }
            return sendJson(res, 200, {
                content: {
                    heroPhotoState: heroAsset ? { posX: heroAsset.pos_x, posY: heroAsset.pos_y, scale: heroAsset.scale, imageSrc: heroAsset.image_url } : null,
                    lessonCards,
                    pageTexts
                }
            });
        }

        // Save site content (Owner only)
        if ((pathname === '/api/admin/site-content' || pathname === '/api/owner/site-content') && method === 'PUT') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required to modify site content.' });
            }
            const body = await parseJsonBody(req);
            if (body.heroPhotoState) {
                const h = body.heroPhotoState;
                await db.run(
                    `UPDATE media_assets SET pos_x = ?, pos_y = ?, scale = ?, image_url = COALESCE(?, image_url), updated_at = datetime('now') WHERE is_hero = 1`,
                    [Number(h.posX ?? 50), Number(h.posY ?? 40), Number(h.scale ?? 1.02), h.imageSrc || null]
                );
            }
            if (Array.isArray(body.lessonCards)) {
                for (let idx = 0; idx < body.lessonCards.length; idx++) {
                    const c = body.lessonCards[idx];
                    const key = String(c.id || `lesson-${idx + 1}`);
                    const existing = await db.get("SELECT id FROM media_assets WHERE card_key = ?", [key]);
                    if (existing) {
                        await db.run(
                            `UPDATE media_assets
                             SET title = ?, caption_date = ?, description = ?, category = ?, image_url = ?, pos_x = ?, pos_y = ?, scale = ?, display_order = ?, updated_at = datetime('now')
                             WHERE card_key = ?`,
                            [
                                String(c.title || 'Interactive Session'),
                                String(c.date || 'Live Session'),
                                String(c.description || ''),
                                String(c.category || 'Workshop'),
                                String(c.imageSrc || ''),
                                Number(c.posX ?? 50),
                                Number(c.posY ?? 50),
                                Number(c.scale ?? 1),
                                idx + 1,
                                key
                            ]
                        );
                    } else {
                        await db.run(
                            `INSERT INTO media_assets (card_key, title, caption_date, description, category, image_url, pos_x, pos_y, scale, display_order, is_hero, is_visible, is_archived, uploaded_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?)`,
                            [
                                key,
                                String(c.title || 'Interactive Session'),
                                String(c.date || 'Live Session'),
                                String(c.description || ''),
                                String(c.category || 'Workshop'),
                                String(c.imageSrc || ''),
                                Number(c.posX ?? 50),
                                Number(c.posY ?? 50),
                                Number(c.scale ?? 1),
                                idx + 1,
                                currentUser.id
                            ]
                        );
                    }
                }
            }
            if (body.pageTexts && typeof body.pageTexts === 'object') {
                await db.run(
                    `INSERT INTO site_content (content_key, content_json, updated_at)
                     VALUES ('page_texts', ?, datetime('now'))
                     ON CONFLICT(content_key) DO UPDATE SET content_json = excluded.content_json, updated_at = datetime('now')`,
                    [JSON.stringify(body.pageTexts)]
                );
            }
            await logActivity(db, {
                user: currentUser,
                actionType: 'SITE_CONTENT_UPDATED',
                targetType: 'site_content',
                targetId: 'main',
                description: 'Updated public website text and gallery framing.',
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true });
        }

        // =========================================================
        // 2. AUTHENTICATION & SESSION MANAGEMENT
        // =========================================================
        if (pathname === '/api/auth/me' && method === 'GET') {
            if (!currentUser) {
                return sendJson(res, 200, { authenticated: false, user: null });
            }
            return sendJson(res, 200, { authenticated: true, user: currentUser });
        }

        if ((pathname === '/api/auth/login' || pathname === '/api/admin/login') && method === 'POST') {
            const rl = checkRateLimit(`login:${ip}`, 12, 60 * 1000);
            if (!rl.allowed) {
                return sendJson(res, 429, { error: `Too many login attempts. Please wait ${rl.retryAfterSec}s.` });
            }

            const body = await parseJsonBody(req);
            const emailInput = String(body.email || '').trim().toLowerCase();
            const passwordInput = String(body.password || '');

            if (!passwordInput) {
                return sendJson(res, 400, { error: 'Email and password are required.' });
            }

            let userRow = null;
            if (emailInput) {
                userRow = await db.get("SELECT * FROM users WHERE lower(email) = ?", [emailInput]);
            } else {
                // Legacy `/api/admin/login` support where only password was supplied for owner login
                userRow = await db.get("SELECT * FROM users WHERE role = 'OWNER' ORDER BY id ASC LIMIT 1");
            }

            if (!userRow || !verifyPassword(passwordInput, userRow.password_hash)) {
                await logActivity(db, {
                    user: null,
                    actionType: 'LOGIN_FAILED',
                    targetType: 'user',
                    targetId: emailInput || 'owner',
                    description: `Failed login attempt for ${emailInput || 'owner account'}`,
                    ipAddress: ip
                });
                return sendJson(res, 401, { error: 'Invalid credentials. Please verify your email and password.' });
            }

            if (userRow.status !== 'active') {
                return sendJson(res, 403, { error: `Your account is currently ${userRow.status}. Please contact the platform owner.` });
            }

            const sessionInfo = await createSessionForUser(db, userRow, req);
            await logActivity(db, {
                user: userRow,
                actionType: 'LOGIN_SUCCESS',
                targetType: 'user',
                targetId: userRow.id,
                description: `${userRow.role} signed in (${userRow.email}).`,
                ipAddress: ip
            });

            // Re-resolve enriched user
            req.headers['x-session-token'] = sessionInfo.rawToken;
            const enrichedUser = await resolveSessionUser(db, req);

            return sendJson(
                res,
                200,
                {
                    ok: true,
                    user: enrichedUser,
                    csrfToken: sessionInfo.csrfToken,
                    sessionToken: sessionInfo.rawToken
                },
                { 'Set-Cookie': sessionInfo.cookie }
            );
        }

        if ((pathname === '/api/auth/logout' || pathname === '/api/admin/logout') && method === 'POST') {
            if (currentUser) {
                await db.run("DELETE FROM user_sessions WHERE id = ?", [currentUser.sessionId]);
                await logActivity(db, {
                    user: currentUser,
                    actionType: 'LOGOUT',
                    targetType: 'user',
                    targetId: currentUser.id,
                    description: `${currentUser.full_name} logged out.`,
                    ipAddress: ip
                });
            }
            const clearCookie = buildCookieHeader(SESSION_COOKIE_NAME, '', 0);
            return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
        }

        // Update personal profile (Member/Staff/Owner)
        if (pathname === '/api/auth/profile' && method === 'PUT') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            const body = await parseJsonBody(req);
            const fullName = String(body.full_name || currentUser.full_name).trim();
            const phone = String(body.phone_or_telegram ?? currentUser.phone_or_telegram).trim();
            const bio = String(body.bio ?? currentUser.bio).trim();
            if (!fullName) return sendJson(res, 400, { error: 'Full name cannot be empty.' });

            await db.run(
                "UPDATE users SET full_name = ?, phone_or_telegram = ?, bio = ?, updated_at = datetime('now') WHERE id = ?",
                [fullName, phone, bio, currentUser.id]
            );
            if (body.new_password) {
                if (!body.current_password) {
                    return sendJson(res, 400, { error: 'Current password is required to set a new password.' });
                }
                const row = await db.get("SELECT password_hash FROM users WHERE id = ?", [currentUser.id]);
                if (!verifyPassword(body.current_password, row.password_hash)) {
                    return sendJson(res, 401, { error: 'Current password is incorrect.' });
                }
                await db.run("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?", [
                    hashPassword(body.new_password),
                    currentUser.id
                ]);
            }
            const updatedUser = await resolveSessionUser(db, req);
            return sendJson(res, 200, { ok: true, user: updatedUser });
        }

        // =========================================================
        // 3. PATH A — PUBLIC APPLICATIONS & OWNER APPLICATION MANAGEMENT
        // =========================================================
        if (pathname === '/api/applications' && method === 'POST') {
            const rl = checkRateLimit(`apply:${ip}`, 10, 60 * 1000);
            if (!rl.allowed) {
                return sendJson(res, 429, { error: `Too many applications submitted. Please wait ${rl.retryAfterSec}s.` });
            }

            const body = await parseJsonBody(req);
            const fullName = String(body.full_name || body.name || '').trim();
            const email = String(body.email || 'applicant@learnity.org').trim();
            const phone = String(body.phone_or_telegram || body.phone || '').trim();
            const requestedRole = String(body.requested_role || 'MEMBER').toUpperCase() === 'STAFF' ? 'STAFF' : 'MEMBER';
            const subjectsArr = Array.isArray(body.interested_subjects)
                ? body.interested_subjects.map((s) => String(s).trim()).filter(Boolean)
                : body.track
                ? [String(body.track).trim()]
                : ['Biology'];
            const track = String(body.track || subjectsArr.join(', ') || 'STEM & Algorithm Lab').trim();
            const schedule = String(body.schedule_preference || body.schedule || 'Weekday Intensive').trim();
            const background = String(body.educational_background || '').trim();
            const motivation = String(body.motivation_statement || '').trim();

            if (!fullName || !phone || !email) {
                return sendJson(res, 400, { error: 'Full name, email address, and phone/Telegram are required.' });
            }

            const appUid = generateApplicationUid();

            // Attempt email notification to OWNER_EMAIL
            const emailResult = await sendEmailNotification(db, {
                templateKey: 'application_received_owner',
                variables: {
                    application_uid: appUid,
                    full_name: fullName,
                    email,
                    phone_or_telegram: phone,
                    requested_role: requestedRole,
                    interested_subjects: subjectsArr.join(', '),
                    track,
                    schedule_preference: schedule,
                    educational_background: background || 'Not specified',
                    motivation_statement: motivation || 'Submitted via quick cohort form'
                }
            });

            const insertRes = await db.run(
                `INSERT INTO applications
                 (application_uid, full_name, email, phone_or_telegram, requested_role, interested_subjects, track, schedule_preference, educational_background, motivation_statement, status, email_notification_sent, email_delivery_detail)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
                [
                    appUid,
                    fullName,
                    email,
                    phone,
                    requestedRole,
                    JSON.stringify(subjectsArr),
                    track,
                    schedule,
                    background,
                    motivation,
                    emailResult.sent ? 1 : 0,
                    emailResult.detail
                ]
            );

            await logActivity(db, {
                user: currentUser,
                actionType: 'APPLICATION_SUBMITTED',
                targetType: 'application',
                targetId: appUid,
                description: `New ${requestedRole} application submitted by ${fullName} (${email}).`,
                ipAddress: ip
            });

            const created = await db.get("SELECT * FROM applications WHERE id = ?", [insertRes.lastInsertRowid]);
            return sendJson(res, 201, {
                ok: true,
                application: {
                    id: created.id,
                    application_uid: created.application_uid,
                    full_name: created.full_name,
                    requested_role: created.requested_role,
                    status: created.status,
                    created_at: created.created_at
                },
                emailDelivery: {
                    sent: emailResult.sent,
                    detail: emailResult.detail
                }
            });
        }

        // Owner/Admin list applications (supports filtering, search, export)
        if ((pathname === '/api/owner/applications' || pathname === '/api/admin/applications') && method === 'GET') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authentication required.' });
            }
            const statusFilter = urlObj.searchParams.get('status') || '';
            const roleFilter = urlObj.searchParams.get('role') || '';
            const q = (urlObj.searchParams.get('q') || '').trim().toLowerCase();
            const format = urlObj.searchParams.get('format') || 'json';

            let rows = await db.all("SELECT * FROM applications ORDER BY id DESC");
            if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
            if (roleFilter) rows = rows.filter((r) => r.requested_role === roleFilter);
            if (q) {
                rows = rows.filter((r) =>
                    [r.application_uid, r.full_name, r.email, r.phone_or_telegram, r.track, r.interested_subjects, r.educational_background]
                        .join(' ')
                        .toLowerCase()
                        .includes(q)
                );
            }

            const mapped = rows.map((r) => {
                let parsedSubjects = [];
                try { parsedSubjects = JSON.parse(r.interested_subjects || '[]'); } catch (_) {}
                return {
                    ...r,
                    name: r.full_name,
                    phone: r.phone_or_telegram,
                    schedule: r.schedule_preference,
                    createdAt: r.created_at,
                    interested_subjects_list: parsedSubjects
                };
            });

            if (format === 'csv') {
                const header = ['Application UID', 'Full Name', 'Email', 'Phone/Telegram', 'Role', 'Subjects', 'Track', 'Schedule', 'Status', 'Created At', 'Review Notes'];
                const csvRows = [header.join(',')];
                for (const item of mapped) {
                    const vals = [
                        item.application_uid,
                        item.full_name,
                        item.email,
                        item.phone_or_telegram,
                        item.requested_role,
                        item.interested_subjects_list.join('; '),
                        item.track,
                        item.schedule_preference,
                        item.status,
                        item.created_at,
                        item.review_notes
                    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`);
                    csvRows.push(vals.join(','));
                }
                res.writeHead(200, {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': 'attachment; filename="learnity-applications.csv"'
                });
                return res.end(csvRows.join('\n'));
            }

            return sendJson(res, 200, { applications: mapped });
        }

        // Update application status / review notes / optionally auto-generate invitation code on approval
        const appMatch = /^\/api\/(?:owner|admin)\/applications\/(\d+)$/.exec(pathname);
        if (appMatch && (method === 'PUT' || method === 'PATCH')) {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authentication required.' });
            }
            const appId = parseInt(appMatch[1], 10);
            const existing = await db.get("SELECT * FROM applications WHERE id = ?", [appId]);
            if (!existing) return sendJson(res, 404, { error: 'Application not found.' });

            const body = await parseJsonBody(req);
            const nextStatus = ['Pending', 'Approved', 'Rejected', 'Contacted'].includes(body.status) ? body.status : existing.status;
            const reviewNotes = body.review_notes !== undefined ? String(body.review_notes) : existing.review_notes;

            let generatedInviteCard = null;
            if (nextStatus === 'Approved' && body.generate_invite) {
                const { plainCode, codeHash, codePrefix } = generateRawInviteCode(existing.requested_role === 'STAFF' ? 'STF' : 'MEM');
                const expiresAt = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
                const invRes = await db.run(
                    `INSERT INTO invitation_codes (code_hash, code_prefix, target_role, issuer_user_id, issuer_name, label, max_uses, uses_count, expires_at, status)
                     VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, 'active')`,
                    [codeHash, codePrefix, existing.requested_role, currentUser.id, currentUser.full_name, `Approved Application ${existing.application_uid}`, expiresAt]
                );

                let subjNames = [];
                try { subjNames = JSON.parse(existing.interested_subjects || '[]'); } catch (_) {}
                const allSubjects = await db.all("SELECT * FROM subjects");
                const matchedSubjects = allSubjects.filter((s) =>
                    subjNames.some((n) => n.toLowerCase() === s.name.toLowerCase() || n.toLowerCase() === s.slug.toLowerCase())
                );
                const targetSubjects = matchedSubjects.length ? matchedSubjects : allSubjects.slice(0, 2);

                const isStaff = existing.requested_role === 'STAFF';
                for (const s of targetSubjects) {
                    await db.run(
                        `INSERT OR IGNORE INTO invitation_permissions
                         (invitation_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_invite_members, can_generate_codes)
                         VALUES (?, ?, 1, 1, ?, ?, ?, ?, 0, 0)`,
                        [invRes.lastInsertRowid, s.id, isStaff ? 1 : 0, isStaff ? 1 : 0, isStaff ? 1 : 0, isStaff ? 1 : 0]
                    );
                }

                generatedInviteCard = {
                    invitationId: invRes.lastInsertRowid,
                    plainCode,
                    codePrefix,
                    targetRole: existing.requested_role,
                    subjects: targetSubjects.map((s) => s.name),
                    expiresAt
                };
            }

            await db.run(
                `UPDATE applications
                 SET status = ?, review_notes = ?, reviewed_by = ?, reviewed_at = datetime('now'),
                     generated_invite_hint = COALESCE(?, generated_invite_hint), updated_at = datetime('now')
                 WHERE id = ?`,
                [nextStatus, reviewNotes, currentUser.id, generatedInviteCard ? generatedInviteCard.codePrefix : null, appId]
            );

            // Optionally notify applicant by email
            let emailNotification = null;
            if (body.notify_applicant && existing.email) {
                emailNotification = await sendEmailNotification(db, {
                    to: existing.email,
                    templateKey: 'application_status_applicant',
                    variables: {
                        full_name: existing.full_name,
                        application_uid: existing.application_uid,
                        requested_role: existing.requested_role,
                        status: nextStatus,
                        review_notes: reviewNotes || 'Thank you for applying to Learnity.',
                        invitation_section: generatedInviteCard
                            ? `Your personal invitation code is: ${generatedInviteCard.plainCode} (valid until ${new Date(generatedInviteCard.expiresAt).toLocaleDateString()}).`
                            : ''
                    }
                });
            }

            await logActivity(db, {
                user: currentUser,
                actionType: 'APPLICATION_REVIEWED',
                targetType: 'application',
                targetId: existing.application_uid,
                description: `Marked application ${existing.application_uid} (${existing.full_name}) as ${nextStatus}.`,
                ipAddress: ip
            });

            const updated = await db.get("SELECT * FROM applications WHERE id = ?", [appId]);
            return sendJson(res, 200, {
                ok: true,
                application: updated,
                generatedInviteCard,
                emailNotification
            });
        }

        if (appMatch && method === 'DELETE') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authentication required.' });
            }
            const appId = parseInt(appMatch[1], 10);
            await db.run("DELETE FROM applications WHERE id = ?", [appId]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'APPLICATION_DELETED',
                targetType: 'application',
                targetId: appId,
                description: `Deleted application ID #${appId}.`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true });
        }

        // =========================================================
        // 4. PATH B — INVITATION CODE VERIFICATION & REGISTRATION
        // =========================================================
        if (pathname === '/api/invitations/verify' && method === 'POST') {
            const rl = checkRateLimit(`invite-verify:${ip}`, 15, 60 * 1000);
            if (!rl.allowed) {
                return sendJson(res, 429, { error: `Too many verification attempts. Please wait ${rl.retryAfterSec}s.` });
            }
            const body = await parseJsonBody(req);
            const check = await validateInvitationRecord(db, body.code);
            if (!check.valid) {
                return sendJson(res, 400, { valid: false, error: check.error });
            }
            return sendJson(res, 200, check);
        }

        if (pathname === '/api/auth/register-invite' && method === 'POST') {
            const rl = checkRateLimit(`invite-reg:${ip}`, 10, 60 * 1000);
            if (!rl.allowed) {
                return sendJson(res, 429, { error: `Too many registration attempts. Please wait ${rl.retryAfterSec}s.` });
            }
            const body = await parseJsonBody(req);
            const fullName = String(body.full_name || '').trim();
            const email = String(body.email || '').trim().toLowerCase();
            const password = String(body.password || '');
            const rawCode = String(body.invitation_code || body.code || '').trim();

            if (!fullName || !email || !password || !rawCode) {
                return sendJson(res, 400, { error: 'Full name, email, password, and a valid invitation code are required.' });
            }

            const check = await validateInvitationRecord(db, rawCode);
            if (!check.valid) {
                return sendJson(res, 400, { error: check.error });
            }

            const existingUser = await db.get("SELECT id FROM users WHERE lower(email) = ?", [email]);
            if (existingUser) {
                return sendJson(res, 409, { error: 'An account with this email address already exists.' });
            }

            const inv = check.invitation;
            // SECURITY INVARIANT: An invitation code can NEVER grant OWNER role
            const assignedRole = inv.targetRole === 'STAFF' ? 'STAFF' : 'MEMBER';
            const canInvite = inv.permissions.some((p) => p.can_invite_members === 1) ? 1 : 0;
            const canGenCodes = inv.permissions.some((p) => p.can_generate_codes === 1) ? 1 : 0;

            const delegatable = {
                can_access_subject: true,
                can_view_materials: true,
                can_upload_materials: inv.permissions.some((p) => p.can_upload_materials === 1),
                can_publish_materials: false,
                can_create_links: inv.permissions.some((p) => p.can_create_links === 1),
                can_upload_videos: inv.permissions.some((p) => p.can_upload_videos === 1),
                can_invite_members: false,
                can_generate_codes: false
            };

            const userInsert = await db.run(
                `INSERT INTO users
                 (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json, invitation_code_id)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, ?, ?)`,
                [
                    fullName,
                    email,
                    hashPassword(password),
                    assignedRole,
                    String(body.phone_or_telegram || ''),
                    `Joined Learnity via invitation (${inv.codePrefix}).`,
                    canGenCodes,
                    canInvite,
                    JSON.stringify(delegatable),
                    inv.id
                ]
            );

            const newUserId = userInsert.lastInsertRowid;

            for (const p of inv.permissions) {
                await db.run(
                    `INSERT INTO user_subjects
                     (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
                    [
                        newUserId,
                        p.subject_id,
                        p.can_access_subject,
                        p.can_view_materials,
                        p.can_upload_materials,
                        p.can_publish_materials,
                        p.can_create_links,
                        p.can_upload_videos
                    ]
                );
            }

            const nextUses = inv.usesCount + 1;
            const nextStatus = nextUses >= inv.maxUses ? 'exhausted' : 'active';
            await db.run(
                "UPDATE invitation_codes SET uses_count = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
                [nextUses, nextStatus, inv.id]
            );

            const newUserRow = await db.get("SELECT * FROM users WHERE id = ?", [newUserId]);
            const sessionInfo = await createSessionForUser(db, newUserRow, req);

            await logActivity(db, {
                user: newUserRow,
                actionType: 'INVITATION_REGISTERED',
                targetType: 'invitation_code',
                targetId: inv.id,
                description: `${fullName} (${email}) registered as ${assignedRole} using invitation ${inv.codePrefix}.`,
                ipAddress: ip
            });

            req.headers['x-session-token'] = sessionInfo.rawToken;
            const enrichedUser = await resolveSessionUser(db, req);

            return sendJson(
                res,
                201,
                {
                    ok: true,
                    user: enrichedUser,
                    csrfToken: sessionInfo.csrfToken,
                    sessionToken: sessionInfo.rawToken
                },
                { 'Set-Cookie': sessionInfo.cookie }
            );
        }

        // =========================================================
        // 5. ADVANCED INVITATION CODE GENERATOR
        // =========================================================
        if (pathname === '/api/invitations' && method === 'GET') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            if (currentUser.role !== 'OWNER' && !currentUser.can_generate_codes) {
                return sendJson(res, 403, { error: 'You do not have permission to access the invitation generator.' });
            }

            const codes = await db.all(
                currentUser.role === 'OWNER'
                    ? "SELECT * FROM invitation_codes ORDER BY id DESC"
                    : "SELECT * FROM invitation_codes WHERE issuer_user_id = ? ORDER BY id DESC",
                currentUser.role === 'OWNER' ? [] : [currentUser.id]
            );

            const perms = await db.all(
                `SELECT ip.*, s.name AS subject_name, s.slug AS subject_slug
                 FROM invitation_permissions ip
                 JOIN subjects s ON s.id = ip.subject_id`
            );
            const permsByInv = {};
            for (const p of perms) {
                if (!permsByInv[p.invitation_id]) permsByInv[p.invitation_id] = [];
                permsByInv[p.invitation_id].push(p);
            }

            return sendJson(res, 200, {
                invitations: codes.map((c) => ({
                    ...c,
                    permissions: permsByInv[c.id] || []
                }))
            });
        }

        if (pathname === '/api/invitations' && method === 'POST') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            if (currentUser.role !== 'OWNER' && !currentUser.can_generate_codes) {
                return sendJson(res, 403, { error: 'You are not authorized to generate invitation codes.' });
            }

            const body = await parseJsonBody(req);
            const subjectIds = Array.isArray(body.subject_ids) ? body.subject_ids.map(Number).filter(Boolean) : [];
            if (!subjectIds.length) {
                return sendJson(res, 400, { error: 'Select at least one subject for this invitation.' });
            }

            // Target role: only OWNER can generate STAFF invitations
            const requestedTargetRole = String(body.target_role || 'MEMBER').toUpperCase() === 'STAFF' ? 'STAFF' : 'MEMBER';
            const targetRole = currentUser.role === 'OWNER' ? requestedTargetRole : 'MEMBER';

            const reqPerms = body.permissions || {};
            const maxUses = Math.max(1, Math.min(500, parseInt(body.max_uses || '1', 10) || 1));
            const expiresInDays = Math.max(1, Math.min(365, parseInt(body.expires_in_days || '14', 10) || 14));
            const expiresAt = body.expires_at
                ? new Date(body.expires_at).toISOString()
                : new Date(Date.now() + expiresInDays * 24 * 3600 * 1000).toISOString();
            const label = String(body.label || `${targetRole} Invitation`).trim();

            // Enforce delegation bounds for non-OWNER issuers
            const validatedSubjectPerms = [];
            for (const subjectId of subjectIds) {
                if (currentUser.role !== 'OWNER') {
                    const issuerSubj = currentUser.subjectPermMap[subjectId];
                    if (!issuerSubj || !issuerSubj.can_access_subject) {
                        return sendJson(res, 403, {
                            error: 'You cannot delegate access to a subject you are not assigned to.'
                        });
                    }
                    const del = currentUser.delegatable_permissions || {};
                    validatedSubjectPerms.push({
                        subject_id: subjectId,
                        can_access_subject: 1,
                        can_view_materials: reqPerms.can_view_materials !== false ? 1 : 0,
                        can_upload_materials: reqPerms.can_upload_materials && issuerSubj.can_upload_materials && del.can_upload_materials ? 1 : 0,
                        can_publish_materials: reqPerms.can_publish_materials && issuerSubj.can_publish_materials && del.can_publish_materials ? 1 : 0,
                        can_create_links: reqPerms.can_create_links && issuerSubj.can_create_links && del.can_create_links ? 1 : 0,
                        can_upload_videos: reqPerms.can_upload_videos && issuerSubj.can_upload_videos && del.can_upload_videos ? 1 : 0,
                        can_invite_members: reqPerms.can_invite_members && currentUser.can_invite_members && del.can_invite_members ? 1 : 0,
                        can_generate_codes: reqPerms.can_generate_codes && currentUser.can_generate_codes && del.can_generate_codes ? 1 : 0
                    });
                } else {
                    validatedSubjectPerms.push({
                        subject_id: subjectId,
                        can_access_subject: reqPerms.can_access_subject !== false ? 1 : 0,
                        can_view_materials: reqPerms.can_view_materials !== false ? 1 : 0,
                        can_upload_materials: reqPerms.can_upload_materials ? 1 : 0,
                        can_publish_materials: reqPerms.can_publish_materials ? 1 : 0,
                        can_create_links: reqPerms.can_create_links ? 1 : 0,
                        can_upload_videos: reqPerms.can_upload_videos ? 1 : 0,
                        can_invite_members: reqPerms.can_invite_members ? 1 : 0,
                        can_generate_codes: reqPerms.can_generate_codes ? 1 : 0
                    });
                }
            }

            const { plainCode, codeHash, codePrefix } = generateRawInviteCode(targetRole === 'STAFF' ? 'STF' : 'LRN');
            const invInsert = await db.run(
                `INSERT INTO invitation_codes
                 (code_hash, code_prefix, target_role, issuer_user_id, issuer_name, label, max_uses, uses_count, expires_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'active')`,
                [codeHash, codePrefix, targetRole, currentUser.id, currentUser.full_name, label, maxUses, expiresAt]
            );

            const invId = invInsert.lastInsertRowid;
            for (const vp of validatedSubjectPerms) {
                await db.run(
                    `INSERT INTO invitation_permissions
                     (invitation_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_invite_members, can_generate_codes)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        invId,
                        vp.subject_id,
                        vp.can_access_subject,
                        vp.can_view_materials,
                        vp.can_upload_materials,
                        vp.can_publish_materials,
                        vp.can_create_links,
                        vp.can_upload_videos,
                        vp.can_invite_members,
                        vp.can_generate_codes
                    ]
                );
            }

            const assignedSubjects = await db.all(
                `SELECT s.id, s.name, s.slug FROM subjects s WHERE s.id IN (${subjectIds.map(() => '?').join(',')})`,
                subjectIds
            );

            await logActivity(db, {
                user: currentUser,
                actionType: 'INVITATION_GENERATED',
                targetType: 'invitation_code',
                targetId: invId,
                description: `Generated ${targetRole} invitation (${codePrefix}) for ${assignedSubjects.map((s) => s.name).join(', ')}.`,
                ipAddress: ip
            });

            return sendJson(res, 201, {
                ok: true,
                invitationCard: {
                    id: invId,
                    plainCode, // Returned once at generation time; only hash is stored in DB
                    codePrefix,
                    targetRole,
                    label,
                    maxUses,
                    usesCount: 0,
                    expiresAt,
                    issuerName: currentUser.full_name,
                    subjects: assignedSubjects,
                    permissions: validatedSubjectPerms,
                    registrationUrl: `/?invite=${encodeURIComponent(plainCode)}#join-with-code`
                }
            });
        }

        const revokeMatch = /^\/api\/invitations\/(\d+)\/revoke$/.exec(pathname);
        if (revokeMatch && method === 'POST') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            const invId = parseInt(revokeMatch[1], 10);
            const inv = await db.get("SELECT * FROM invitation_codes WHERE id = ?", [invId]);
            if (!inv) return sendJson(res, 404, { error: 'Invitation not found.' });
            if (currentUser.role !== 'OWNER' && inv.issuer_user_id !== currentUser.id) {
                return sendJson(res, 403, { error: 'Only the owner or the code issuer can revoke this invitation.' });
            }
            await db.run("UPDATE invitation_codes SET status = 'revoked', updated_at = datetime('now') WHERE id = ?", [invId]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'INVITATION_REVOKED',
                targetType: 'invitation_code',
                targetId: invId,
                description: `Revoked invitation code ${inv.code_prefix}.`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true, id: invId, status: 'revoked' });
        }

        // =========================================================
        // 6. SUBJECTS & SUBJECT-SPECIFIC LEARNING HUBS
        // =========================================================
        if (pathname === '/api/subjects' && method === 'GET') {
            const subjects = await db.all("SELECT * FROM subjects WHERE is_active = 1 ORDER BY display_order ASC, id ASC");
            const resCounts = await db.all("SELECT subject_id, COUNT(*) AS cnt FROM resources WHERE moderation_status = 'Published' GROUP BY subject_id");
            const countMap = Object.fromEntries(resCounts.map((r) => [r.subject_id, r.cnt]));

            return sendJson(res, 200, {
                subjects: subjects.map((s) => ({
                    ...s,
                    publishedResourcesCount: countMap[s.id] || 0,
                    hasAccess: currentUser ? hasSubjectPermission(currentUser, s.id, 'can_access_subject') : false,
                    userPermissions: currentUser
                        ? currentUser.role === 'OWNER'
                            ? {
                                  can_access_subject: 1,
                                  can_view_materials: 1,
                                  can_upload_materials: 1,
                                  can_publish_materials: 1,
                                  can_create_links: 1,
                                  can_upload_videos: 1,
                                  can_moderate: 1
                              }
                            : currentUser.subjectPermMap[s.id] || null
                        : null
                }))
            });
        }

        // Owner create new subject
        if (pathname === '/api/subjects' && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Only the platform owner can create new subjects.' });
            }
            const body = await parseJsonBody(req);
            const name = String(body.name || '').trim();
            if (!name) return sendJson(res, 400, { error: 'Subject name is required.' });
            const slug = String(body.slug || name)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            const category = String(body.category || 'Interdisciplinary Track').trim();
            const shortDesc = String(body.short_description || `${name} collaborative learning track and workshop lab.`).trim();
            const introHtml = String(body.intro_html || shortDesc).trim();
            const iconName = String(body.icon_name || 'book-open').trim();
            const accentColor = String(body.accent_color || '#6366f1').trim();
            const instructor = String(body.lead_instructor || 'Learnity Academic Team').trim();
            const scheduleLabel = String(body.schedule_label || 'Weekly Live Lab').trim();

            const ins = await db.run(
                `INSERT INTO subjects (slug, name, category, short_description, intro_html, icon_name, accent_color, lead_instructor, schedule_label, display_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 99)`,
                [slug, name, category, shortDesc, introHtml, iconName, accentColor, instructor, scheduleLabel]
            );
            const created = await db.get("SELECT * FROM subjects WHERE id = ?", [ins.lastInsertRowid]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'SUBJECT_CREATED',
                targetType: 'subject',
                targetId: created.slug,
                description: `Created subject "${created.name}" (/subjects/${created.slug}).`,
                ipAddress: ip
            });
            return sendJson(res, 201, { ok: true, subject: created });
        }

        // Owner delete subject
        const subjDeleteMatch = /^\/api\/subjects\/(\d+)$/.exec(pathname);
        if (subjDeleteMatch && method === 'DELETE') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Only the platform owner can remove subjects.' });
            }
            const subjId = parseInt(subjDeleteMatch[1], 10);
            const subj = await db.get("SELECT * FROM subjects WHERE id = ?", [subjId]);
            if (!subj) return sendJson(res, 404, { error: 'Subject not found.' });
            await db.run("DELETE FROM subjects WHERE id = ?", [subjId]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'SUBJECT_DELETED',
                targetType: 'subject',
                targetId: subj.slug,
                description: `Removed subject "${subj.name}".`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true });
        }

        // Get Subject Learning Hub (`/api/subjects/:slug`) — STRICT SERVER-SIDE AUTHORIZATION
        const subjSlugMatch = /^\/api\/subjects\/([a-z0-9-]+)$/i.exec(pathname);
        if (subjSlugMatch && method === 'GET') {
            const slug = subjSlugMatch[1].toLowerCase();
            const subject = await db.get("SELECT * FROM subjects WHERE lower(slug) = ?", [slug]);
            if (!subject) return sendJson(res, 404, { error: 'Subject not found.' });

            if (!currentUser) {
                return sendJson(res, 401, { error: 'Please sign in to access Subject Learning Hubs.' });
            }

            if (!hasSubjectPermission(currentUser, subject.id, 'can_access_subject')) {
                return sendJson(res, 403, {
                    error: `Access denied: Your account does not have permission to view ${subject.name}.`
                });
            }

            const canModerate = currentUser.role === 'OWNER' || hasSubjectPermission(currentUser, subject.id, 'can_moderate');
            const resources = await db.all(
                canModerate
                    ? "SELECT * FROM resources WHERE subject_id = ? ORDER BY is_featured DESC, id DESC"
                    : "SELECT * FROM resources WHERE subject_id = ? AND (moderation_status = 'Published' OR author_user_id = ?) ORDER BY is_featured DESC, id DESC",
                canModerate ? [subject.id] : [subject.id, currentUser.id]
            );

            const announcements = await db.all(
                "SELECT * FROM announcements WHERE subject_id = ? OR audience = 'all' ORDER BY is_pinned DESC, id DESC",
                [subject.id]
            );

            const perms =
                currentUser.role === 'OWNER'
                    ? {
                          can_access_subject: 1,
                          can_view_materials: 1,
                          can_upload_materials: 1,
                          can_publish_materials: 1,
                          can_create_links: 1,
                          can_upload_videos: 1,
                          can_moderate: 1
                      }
                    : currentUser.subjectPermMap[subject.id];

            return sendJson(res, 200, {
                subject,
                permissions: perms,
                resources,
                announcements
            });
        }

        // =========================================================
        // 7. LEARNING RESOURCES & MODERATION WORKFLOW
        // =========================================================
        if (pathname === '/api/resources' && method === 'POST') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });

            const contentType = req.headers['content-type'] || '';
            let payload = {};
            let uploadedFileMeta = null;

            if (contentType.includes('multipart/form-data')) {
                const rawBuf = await readRequestBody(req, 12 * 1024 * 1024);
                const parsed = parseMultipart(rawBuf, contentType);
                payload = parsed.fields;
                if (parsed.files.length > 0) {
                    uploadedFileMeta = validateAndSaveUploadedFile(parsed.files[0], uploadDir, ALLOWED_DOC_MIMES, 10 * 1024 * 1024);
                }
            } else {
                payload = await parseJsonBody(req);
            }

            const subjectId = parseInt(payload.subject_id, 10);
            const subject = await db.get("SELECT * FROM subjects WHERE id = ?", [subjectId]);
            if (!subject) return sendJson(res, 404, { error: 'Target subject not found.' });

            // Enforce granular permission by resource type
            const resType = ['pdf', 'presentation', 'video', 'youtube', 'link', 'study_guide'].includes(payload.resource_type)
                ? payload.resource_type
                : 'study_guide';

            if (currentUser.role !== 'OWNER') {
                if (!hasSubjectPermission(currentUser, subject.id, 'can_access_subject')) {
                    return sendJson(res, 403, { error: `You do not have access to ${subject.name}.` });
                }
                if ((resType === 'video' || resType === 'youtube') && !hasSubjectPermission(currentUser, subject.id, 'can_upload_videos')) {
                    return sendJson(res, 403, { error: `You do not have permission to add videos to ${subject.name}.` });
                }
                if (resType === 'link' && !hasSubjectPermission(currentUser, subject.id, 'can_create_links')) {
                    return sendJson(res, 403, { error: `You do not have permission to add external links to ${subject.name}.` });
                }
                if (['pdf', 'presentation', 'study_guide'].includes(resType) && !hasSubjectPermission(currentUser, subject.id, 'can_upload_materials')) {
                    return sendJson(res, 403, { error: `You do not have permission to upload learning materials to ${subject.name}.` });
                }
            }

            const title = String(payload.title || '').trim();
            if (!title) return sendJson(res, 400, { error: 'Resource title is required.' });

            const canPublishDirectly =
                currentUser.role === 'OWNER' || hasSubjectPermission(currentUser, subject.id, 'can_publish_materials');
            const requestedStatus = payload.moderation_status;
            const moderationStatus = canPublishDirectly
                ? ['Pending Review', 'Approved', 'Published'].includes(requestedStatus)
                    ? requestedStatus
                    : 'Published'
                : 'Pending Review';

            const fileUrl = uploadedFileMeta ? uploadedFileMeta.publicUrl : String(payload.file_url || '');
            const durationOrSize = uploadedFileMeta
                ? `${(uploadedFileMeta.sizeBytes / 1024).toFixed(1)} KB · ${uploadedFileMeta.originalName}`
                : String(payload.duration_or_size || 'Interactive Resource');

            const ins = await db.run(
                `INSERT INTO resources
                 (subject_id, author_user_id, author_name, title, description, resource_type, category, external_url, file_url, duration_or_size, moderation_status, is_featured)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    subject.id,
                    currentUser.id,
                    currentUser.full_name,
                    title,
                    String(payload.description || '').trim(),
                    resType,
                    String(payload.category || 'Core Study Materials').trim(),
                    String(payload.external_url || '').trim(),
                    fileUrl,
                    durationOrSize,
                    moderationStatus,
                    currentUser.role === 'OWNER' && payload.is_featured ? 1 : 0
                ]
            );

            if (uploadedFileMeta) {
                await db.run(
                    `INSERT INTO resource_files (resource_id, original_name, stored_name, mime_type, size_bytes, storage_path, public_url, uploaded_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        ins.lastInsertRowid,
                        uploadedFileMeta.originalName,
                        uploadedFileMeta.storedName,
                        uploadedFileMeta.mimeType,
                        uploadedFileMeta.sizeBytes,
                        uploadedFileMeta.storagePath,
                        uploadedFileMeta.publicUrl,
                        currentUser.id
                    ]
                );
            }

            const created = await db.get("SELECT * FROM resources WHERE id = ?", [ins.lastInsertRowid]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'RESOURCE_CREATED',
                targetType: 'resource',
                targetId: created.id,
                description: `Added ${resType} "${created.title}" to ${subject.name} (${moderationStatus}).`,
                ipAddress: ip
            });

            return sendJson(res, 201, { ok: true, resource: created });
        }

        const resIdMatch = /^\/api\/resources\/(\d+)$/.exec(pathname);
        if (resIdMatch && (method === 'PUT' || method === 'PATCH')) {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            const resId = parseInt(resIdMatch[1], 10);
            const existing = await db.get("SELECT * FROM resources WHERE id = ?", [resId]);
            if (!existing) return sendJson(res, 404, { error: 'Resource not found.' });

            const isOwnerOrMod =
                currentUser.role === 'OWNER' || hasSubjectPermission(currentUser, existing.subject_id, 'can_moderate');
            const isAuthor = existing.author_user_id === currentUser.id;
            if (!isOwnerOrMod && !isAuthor) {
                return sendJson(res, 403, { error: 'You do not have permission to edit this resource.' });
            }

            const body = await parseJsonBody(req);
            const nextTitle = body.title !== undefined ? String(body.title).trim() : existing.title;
            const nextDesc = body.description !== undefined ? String(body.description).trim() : existing.description;
            const nextCat = body.category !== undefined ? String(body.category).trim() : existing.category;
            const nextUrl = body.external_url !== undefined ? String(body.external_url).trim() : existing.external_url;
            const nextStatus =
                isOwnerOrMod && ['Pending Review', 'Approved', 'Published', 'Rejected'].includes(body.moderation_status)
                    ? body.moderation_status
                    : existing.moderation_status;

            await db.run(
                `UPDATE resources
                 SET title = ?, description = ?, category = ?, external_url = ?, moderation_status = ?, updated_at = datetime('now')
                 WHERE id = ?`,
                [nextTitle, nextDesc, nextCat, nextUrl, nextStatus, resId]
            );
            const updated = await db.get("SELECT * FROM resources WHERE id = ?", [resId]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'RESOURCE_UPDATED',
                targetType: 'resource',
                targetId: resId,
                description: `Updated resource "${updated.title}" (status: ${updated.moderation_status}).`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true, resource: updated });
        }

        if (resIdMatch && method === 'DELETE') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            const resId = parseInt(resIdMatch[1], 10);
            const existing = await db.get("SELECT * FROM resources WHERE id = ?", [resId]);
            if (!existing) return sendJson(res, 404, { error: 'Resource not found.' });
            if (currentUser.role !== 'OWNER' && existing.author_user_id !== currentUser.id) {
                return sendJson(res, 403, { error: 'Only the platform owner or the author can delete this resource.' });
            }
            await db.run("DELETE FROM resources WHERE id = ?", [resId]);
            return sendJson(res, 200, { ok: true });
        }

        // =========================================================
        // 8. STAFF DIRECTORY & STAFF WORKSPACE
        // =========================================================
        if (pathname === '/api/staff' && method === 'GET') {
            const includeHidden = currentUser && currentUser.role === 'OWNER';
            const staff = await db.all(
                includeHidden
                    ? "SELECT * FROM staff_profiles ORDER BY display_order ASC, id ASC"
                    : "SELECT * FROM staff_profiles WHERE is_visible = 1 ORDER BY display_order ASC, id ASC"
            );
            return sendJson(res, 200, { staff });
        }

        if (pathname === '/api/staff/workspace' && method === 'GET') {
            if (!currentUser || (currentUser.role !== 'STAFF' && currentUser.role !== 'OWNER')) {
                return sendJson(res, 403, { error: 'Staff or Owner authentication required to access the Staff Workspace.' });
            }
            const assignedSubjectIds =
                currentUser.role === 'OWNER'
                    ? (await db.all("SELECT id FROM subjects")).map((s) => s.id)
                    : currentUser.subjectPermissions.filter((p) => p.can_access_subject).map((p) => p.subject_id);

            const subjects = assignedSubjectIds.length
                ? await db.all(
                      `SELECT * FROM subjects WHERE id IN (${assignedSubjectIds.map(() => '?').join(',')}) ORDER BY display_order ASC`,
                      assignedSubjectIds
                  )
                : [];

            const resources = assignedSubjectIds.length
                ? await db.all(
                      `SELECT r.*, s.name AS subject_name, s.slug AS subject_slug
                       FROM resources r
                       JOIN subjects s ON s.id = r.subject_id
                       WHERE r.subject_id IN (${assignedSubjectIds.map(() => '?').join(',')})
                       ORDER BY r.id DESC`,
                      assignedSubjectIds
                  )
                : [];

            const announcements = await db.all(
                "SELECT * FROM announcements ORDER BY is_pinned DESC, id DESC LIMIT 15"
            );

            return sendJson(res, 200, {
                user: currentUser,
                assignedSubjects: subjects,
                resources,
                announcements
            });
        }

        // Owner create or update staff directory profile & staff user account
        if (pathname === '/api/owner/staff' && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const body = await parseJsonBody(req);
            const fullName = String(body.full_name || '').trim();
            const position = String(body.position || 'Academic Mentor').trim();
            if (!fullName) return sendJson(res, 400, { error: 'Staff member name is required.' });

            let linkedUserId = body.user_id ? parseInt(body.user_id, 10) : null;

            // Optionally create a login account for the staff member
            if (body.email && body.password) {
                const email = String(body.email).trim().toLowerCase();
                const exists = await db.get("SELECT id FROM users WHERE lower(email) = ?", [email]);
                if (exists) {
                    linkedUserId = exists.id;
                    await db.run("UPDATE users SET role = 'STAFF', full_name = ?, can_create_announcements = ? WHERE id = ?", [
                        fullName,
                        body.can_create_announcements ? 1 : 0,
                        linkedUserId
                    ]);
                } else {
                    const uIns = await db.run(
                        `INSERT INTO users (full_name, email, password_hash, role, status, bio, can_generate_codes, can_invite_members, can_create_announcements)
                         VALUES (?, ?, ?, 'STAFF', 'active', ?, ?, ?, ?)`,
                        [
                            fullName,
                            email,
                            hashPassword(body.password),
                            String(body.bio || position),
                            body.can_generate_codes ? 1 : 0,
                            body.can_invite_members ? 1 : 0,
                            body.can_create_announcements ? 1 : 0
                        ]
                    );
                    linkedUserId = uIns.lastInsertRowid;
                }

                if (Array.isArray(body.subject_ids) && linkedUserId) {
                    await db.run("DELETE FROM user_subjects WHERE user_id = ?", [linkedUserId]);
                    for (const sid of body.subject_ids.map(Number).filter(Boolean)) {
                        await db.run(
                            `INSERT INTO user_subjects
                             (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate, assigned_by)
                             VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
                            [
                                linkedUserId,
                                sid,
                                body.can_upload_materials !== false ? 1 : 0,
                                body.can_publish_materials !== false ? 1 : 0,
                                body.can_create_links !== false ? 1 : 0,
                                body.can_upload_videos !== false ? 1 : 0,
                                body.can_moderate ? 1 : 0,
                                currentUser.id
                            ]
                        );
                    }
                }
            }

            const maxOrderRow = await db.get("SELECT COALESCE(MAX(display_order), 0) AS m FROM staff_profiles");
            const ins = await db.run(
                `INSERT INTO staff_profiles
                 (user_id, full_name, position, department, photo_url, bio, responsibilities, assigned_subjects_label, display_order, is_visible)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    linkedUserId,
                    fullName,
                    position,
                    String(body.department || 'Academic Mentorship').trim(),
                    String(body.photo_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=600&q=80').trim(),
                    String(body.bio || '').trim(),
                    String(body.responsibilities || '').trim(),
                    String(body.assigned_subjects_label || '').trim(),
                    (maxOrderRow?.m || 0) + 1,
                    body.is_visible !== false ? 1 : 0
                ]
            );

            const created = await db.get("SELECT * FROM staff_profiles WHERE id = ?", [ins.lastInsertRowid]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'STAFF_PROFILE_CREATED',
                targetType: 'staff_profile',
                targetId: created.id,
                description: `Added staff member "${created.full_name}" (${created.position}).`,
                ipAddress: ip
            });
            return sendJson(res, 201, { ok: true, staffProfile: created });
        }

        const staffIdMatch = /^\/api\/owner\/staff\/(\d+)$/.exec(pathname);
        if (staffIdMatch && (method === 'PUT' || method === 'PATCH')) {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const staffId = parseInt(staffIdMatch[1], 10);
            const existing = await db.get("SELECT * FROM staff_profiles WHERE id = ?", [staffId]);
            if (!existing) return sendJson(res, 404, { error: 'Staff profile not found.' });

            const body = await parseJsonBody(req);
            await db.run(
                `UPDATE staff_profiles
                 SET full_name = ?, position = ?, department = ?, photo_url = ?, bio = ?, responsibilities = ?, assigned_subjects_label = ?, is_visible = ?, display_order = ?, updated_at = datetime('now')
                 WHERE id = ?`,
                [
                    body.full_name !== undefined ? String(body.full_name).trim() : existing.full_name,
                    body.position !== undefined ? String(body.position).trim() : existing.position,
                    body.department !== undefined ? String(body.department).trim() : existing.department,
                    body.photo_url !== undefined ? String(body.photo_url).trim() : existing.photo_url,
                    body.bio !== undefined ? String(body.bio).trim() : existing.bio,
                    body.responsibilities !== undefined ? String(body.responsibilities).trim() : existing.responsibilities,
                    body.assigned_subjects_label !== undefined ? String(body.assigned_subjects_label).trim() : existing.assigned_subjects_label,
                    body.is_visible !== undefined ? (body.is_visible ? 1 : 0) : existing.is_visible,
                    body.display_order !== undefined ? Number(body.display_order) : existing.display_order,
                    staffId
                ]
            );
            const updated = await db.get("SELECT * FROM staff_profiles WHERE id = ?", [staffId]);
            return sendJson(res, 200, { ok: true, staffProfile: updated });
        }

        if (staffIdMatch && method === 'DELETE') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const staffId = parseInt(staffIdMatch[1], 10);
            await db.run("DELETE FROM staff_profiles WHERE id = ?", [staffId]);
            return sendJson(res, 200, { ok: true });
        }

        // =========================================================
        // 9. DYNAMIC PHOTO & MEDIA MANAGEMENT SYSTEM
        // =========================================================
        if ((pathname === '/api/admin/uploads' || pathname === '/api/owner/media/upload') && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required to upload media.' });
            }
            const contentType = req.headers['content-type'] || '';
            if (!contentType.includes('multipart/form-data')) {
                return sendJson(res, 400, { error: 'Multipart file upload required.' });
            }
            const rawBuf = await readRequestBody(req, 15 * 1024 * 1024);
            const parsed = parseMultipart(rawBuf, contentType);
            if (!parsed.files.length) {
                return sendJson(res, 400, { error: 'No image file found in upload.' });
            }

            const uploadedUrls = [];
            const createdAssets = [];

            for (const fileObj of parsed.files) {
                const saved = validateAndSaveUploadedFile(fileObj, uploadDir, ALLOWED_IMAGE_MIMES, 8 * 1024 * 1024);
                uploadedUrls.push(saved.publicUrl);

                if (parsed.fields.create_gallery_card === 'true' || pathname === '/api/owner/media/upload') {
                    const maxOrder = await db.get("SELECT COALESCE(MAX(display_order), 0) AS m FROM media_assets WHERE is_hero = 0");
                    const cardKey = `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                    const title = String(parsed.fields.title || fileObj.originalName.replace(/\.[^.]+$/, '') || 'Live Classroom Moment');
                    const category = String(parsed.fields.category || 'Live Workshop');
                    const captionDate = String(parsed.fields.caption_date || 'Cohort Archive');
                    const description = String(parsed.fields.description || 'Interactive workshop photograph uploaded via Owner Media Library.');

                    const ins = await db.run(
                        `INSERT INTO media_assets
                         (card_key, title, caption_date, description, category, image_url, storage_path, pos_x, pos_y, scale, crop_aspect, display_order, is_hero, is_visible, is_archived, uploaded_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, 50, 50, 1, '16:10', ?, 0, 1, 0, ?)`,
                        [cardKey, title, captionDate, description, category, saved.publicUrl, saved.storagePath, (maxOrder?.m || 0) + 1, currentUser.id]
                    );
                    const asset = await db.get("SELECT * FROM media_assets WHERE id = ?", [ins.lastInsertRowid]);
                    createdAssets.push(asset);
                }
            }

            await logActivity(db, {
                user: currentUser,
                actionType: 'MEDIA_UPLOADED',
                targetType: 'media_asset',
                targetId: uploadedUrls.join(','),
                description: `Uploaded ${uploadedUrls.length} photograph(s) to persistent storage.`,
                ipAddress: ip
            });

            return sendJson(res, 201, {
                ok: true,
                url: uploadedUrls[0],
                urls: uploadedUrls,
                assets: createdAssets
            });
        }

        if (pathname === '/api/owner/media' && method === 'GET') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const assets = await db.all("SELECT * FROM media_assets ORDER BY is_hero DESC, is_archived ASC, display_order ASC, id DESC");
            return sendJson(res, 200, { assets });
        }

        if (pathname === '/api/owner/media' && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const body = await parseJsonBody(req);
            const maxOrder = await db.get("SELECT COALESCE(MAX(display_order), 0) AS m FROM media_assets WHERE is_hero = 0");
            const cardKey = `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
            const ins = await db.run(
                `INSERT INTO media_assets
                 (card_key, title, caption_date, description, category, image_url, pos_x, pos_y, scale, crop_aspect, display_order, is_hero, is_visible, is_archived, uploaded_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
                [
                    cardKey,
                    String(body.title || 'Interactive Classroom Session').trim(),
                    String(body.caption_date || 'Week 09 · Special Session').trim(),
                    String(body.description || 'Collaborative student session in the Learnity lab.').trim(),
                    String(body.category || 'Live Workshop').trim(),
                    String(body.image_url || 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=900&q=80').trim(),
                    Number(body.pos_x ?? 50),
                    Number(body.pos_y ?? 50),
                    Number(body.scale ?? 1),
                    String(body.crop_aspect || '16:10'),
                    (maxOrder?.m || 0) + 1,
                    body.is_visible !== false ? 1 : 0,
                    currentUser.id
                ]
            );
            const created = await db.get("SELECT * FROM media_assets WHERE id = ?", [ins.lastInsertRowid]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'MEDIA_CARD_CREATED',
                targetType: 'media_asset',
                targetId: created.id,
                description: `Created gallery card "${created.title}".`,
                ipAddress: ip
            });
            return sendJson(res, 201, { ok: true, asset: created });
        }

        const mediaIdMatch = /^\/api\/owner\/media\/(\d+)$/.exec(pathname);
        if (mediaIdMatch && (method === 'PUT' || method === 'PATCH')) {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const mediaId = parseInt(mediaIdMatch[1], 10);
            const existing = await db.get("SELECT * FROM media_assets WHERE id = ?", [mediaId]);
            if (!existing) return sendJson(res, 404, { error: 'Media asset not found.' });

            const body = await parseJsonBody(req);
            await db.run(
                `UPDATE media_assets
                 SET title = ?, caption_date = ?, description = ?, category = ?, image_url = ?,
                     pos_x = ?, pos_y = ?, scale = ?, crop_aspect = ?, display_order = ?,
                     is_visible = ?, is_archived = ?, updated_at = datetime('now')
                 WHERE id = ?`,
                [
                    body.title !== undefined ? String(body.title).trim() : existing.title,
                    body.caption_date !== undefined ? String(body.caption_date).trim() : existing.caption_date,
                    body.description !== undefined ? String(body.description).trim() : existing.description,
                    body.category !== undefined ? String(body.category).trim() : existing.category,
                    body.image_url !== undefined ? String(body.image_url).trim() : existing.image_url,
                    body.pos_x !== undefined ? Number(body.pos_x) : existing.pos_x,
                    body.pos_y !== undefined ? Number(body.pos_y) : existing.pos_y,
                    body.scale !== undefined ? Number(body.scale) : existing.scale,
                    body.crop_aspect !== undefined ? String(body.crop_aspect) : existing.crop_aspect,
                    body.display_order !== undefined ? Number(body.display_order) : existing.display_order,
                    body.is_visible !== undefined ? (body.is_visible ? 1 : 0) : existing.is_visible,
                    body.is_archived !== undefined ? (body.is_archived ? 1 : 0) : existing.is_archived,
                    mediaId
                ]
            );
            const updated = await db.get("SELECT * FROM media_assets WHERE id = ?", [mediaId]);
            return sendJson(res, 200, { ok: true, asset: updated });
        }

        if (mediaIdMatch && method === 'DELETE') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const mediaId = parseInt(mediaIdMatch[1], 10);
            const existing = await db.get("SELECT * FROM media_assets WHERE id = ?", [mediaId]);
            if (!existing) return sendJson(res, 404, { error: 'Media asset not found.' });
            await db.run("DELETE FROM media_assets WHERE id = ?", [mediaId]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'MEDIA_DELETED',
                targetType: 'media_asset',
                targetId: mediaId,
                description: `Deleted photograph "${existing.title}" from Media Library.`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true });
        }

        // =========================================================
        // 10. OWNER DASHBOARD, USERS/PERMISSIONS, ANNOUNCEMENTS & LOGS
        // =========================================================
        if (pathname === '/api/owner/overview' && method === 'GET') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authentication required.' });
            }

            const [
                totalMembers,
                activeMembers,
                totalStaff,
                pendingApps,
                totalSubjects,
                publishedResources,
                pendingResources,
                totalPhotos,
                recentLogs,
                users,
                subjects,
                applications,
                invitations,
                resources,
                announcements,
                templates
            ] = await Promise.all([
                db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'MEMBER'"),
                db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'MEMBER' AND status = 'active'"),
                db.get("SELECT COUNT(*) AS cnt FROM users WHERE role = 'STAFF'"),
                db.get("SELECT COUNT(*) AS cnt FROM applications WHERE status = 'Pending'"),
                db.get("SELECT COUNT(*) AS cnt FROM subjects WHERE is_active = 1"),
                db.get("SELECT COUNT(*) AS cnt FROM resources WHERE moderation_status = 'Published'"),
                db.get("SELECT COUNT(*) AS cnt FROM resources WHERE moderation_status = 'Pending Review'"),
                db.get("SELECT COUNT(*) AS cnt FROM media_assets WHERE is_archived = 0"),
                db.all("SELECT * FROM activity_logs ORDER BY id DESC LIMIT 40"),
                db.all("SELECT id, full_name, email, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json, last_login_at, created_at FROM users ORDER BY id ASC"),
                db.all("SELECT * FROM subjects ORDER BY display_order ASC, id ASC"),
                db.all("SELECT * FROM applications ORDER BY id DESC"),
                db.all("SELECT * FROM invitation_codes ORDER BY id DESC"),
                db.all("SELECT r.*, s.name AS subject_name, s.slug AS subject_slug FROM resources r JOIN subjects s ON s.id = r.subject_id ORDER BY r.id DESC"),
                db.all("SELECT a.*, s.name AS subject_name FROM announcements a LEFT JOIN subjects s ON s.id = a.subject_id ORDER BY a.is_pinned DESC, a.id DESC"),
                db.all("SELECT * FROM notifications WHERE channel = 'template' ORDER BY id ASC")
            ]);

            const allUserSubjects = await db.all(
                `SELECT us.*, s.name AS subject_name, s.slug AS subject_slug
                 FROM user_subjects us
                 JOIN subjects s ON s.id = us.subject_id`
            );
            const subjPermsByUser = {};
            for (const usp of allUserSubjects) {
                if (!subjPermsByUser[usp.user_id]) subjPermsByUser[usp.user_id] = [];
                subjPermsByUser[usp.user_id].push(usp);
            }

            // Subject resource breakdown for dashboard charts
            const subjectBreakdown = subjects.map((s) => ({
                id: s.id,
                name: s.name,
                slug: s.slug,
                accent_color: s.accent_color,
                resourcesCount: resources.filter((r) => r.subject_id === s.id).length,
                enrolledUsersCount: allUserSubjects.filter((u) => u.subject_id === s.id && u.can_access_subject).length
            }));

            return sendJson(res, 200, {
                metrics: {
                    totalMembers: totalMembers?.cnt || 0,
                    activeMembers: activeMembers?.cnt || 0,
                    totalStaff: totalStaff?.cnt || 0,
                    pendingApplications: pendingApps?.cnt || 0,
                    totalSubjects: totalSubjects?.cnt || 0,
                    publishedResources: publishedResources?.cnt || 0,
                    pendingResources: pendingResources?.cnt || 0,
                    totalPhotos: totalPhotos?.cnt || 0
                },
                subjectBreakdown,
                users: users.map((u) => ({
                    ...u,
                    subjectPermissions: subjPermsByUser[u.id] || []
                })),
                subjects,
                applications,
                invitations,
                resources,
                announcements,
                templates,
                activityLogs: recentLogs
            });
        }

        // Owner create or update user account & subject permissions
        if (pathname === '/api/owner/users' && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const body = await parseJsonBody(req);
            const fullName = String(body.full_name || '').trim();
            const email = String(body.email || '').trim().toLowerCase();
            const password = String(body.password || 'Learnity!2026');
            const role = ['STAFF', 'MEMBER'].includes(String(body.role || '').toUpperCase())
                ? String(body.role).toUpperCase()
                : 'MEMBER';

            if (!fullName || !email) {
                return sendJson(res, 400, { error: 'Full name and email are required.' });
            }
            const exists = await db.get("SELECT id FROM users WHERE lower(email) = ?", [email]);
            if (exists) return sendJson(res, 409, { error: 'A user with that email already exists.' });

            const delegatable = body.delegatable_permissions || {
                can_access_subject: true,
                can_view_materials: true,
                can_upload_materials: Boolean(body.can_upload_materials)
            };

            const ins = await db.run(
                `INSERT INTO users
                 (full_name, email, password_hash, role, status, phone_or_telegram, bio, can_generate_codes, can_invite_members, can_create_announcements, delegatable_permissions_json)
                 VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
                [
                    fullName,
                    email,
                    hashPassword(password),
                    role,
                    String(body.phone_or_telegram || ''),
                    String(body.bio || ''),
                    body.can_generate_codes ? 1 : 0,
                    body.can_invite_members ? 1 : 0,
                    body.can_create_announcements ? 1 : 0,
                    JSON.stringify(delegatable)
                ]
            );

            const userId = ins.lastInsertRowid;
            const subjectIds = Array.isArray(body.subject_ids) ? body.subject_ids.map(Number).filter(Boolean) : [];
            const perms = body.permissions || {};

            for (const sid of subjectIds) {
                await db.run(
                    `INSERT INTO user_subjects
                     (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate, assigned_by)
                     VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        sid,
                        perms.can_upload_materials || role === 'STAFF' ? 1 : 0,
                        perms.can_publish_materials || role === 'STAFF' ? 1 : 0,
                        perms.can_create_links || role === 'STAFF' ? 1 : 0,
                        perms.can_upload_videos || role === 'STAFF' ? 1 : 0,
                        perms.can_moderate ? 1 : 0,
                        currentUser.id
                    ]
                );
            }

            await logActivity(db, {
                user: currentUser,
                actionType: 'USER_CREATED',
                targetType: 'user',
                targetId: userId,
                description: `Created ${role} account for ${fullName} (${email}).`,
                ipAddress: ip
            });

            const created = await db.get("SELECT id, full_name, email, role, status FROM users WHERE id = ?", [userId]);
            return sendJson(res, 201, { ok: true, user: created });
        }

        const userUpdateMatch = /^\/api\/owner\/users\/(\d+)$/.exec(pathname);
        if (userUpdateMatch && (method === 'PUT' || method === 'PATCH')) {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const targetUserId = parseInt(userUpdateMatch[1], 10);
            const targetUser = await db.get("SELECT * FROM users WHERE id = ?", [targetUserId]);
            if (!targetUser) return sendJson(res, 404, { error: 'User not found.' });

            const body = await parseJsonBody(req);
            const nextRole =
                targetUser.role === 'OWNER'
                    ? 'OWNER'
                    : ['STAFF', 'MEMBER'].includes(body.role)
                    ? body.role
                    : targetUser.role;
            const nextStatus =
                targetUser.role === 'OWNER'
                    ? 'active'
                    : ['active', 'disabled', 'suspended'].includes(body.status)
                    ? body.status
                    : targetUser.status;

            await db.run(
                `UPDATE users
                 SET full_name = ?, role = ?, status = ?, can_generate_codes = ?, can_invite_members = ?, can_create_announcements = ?,
                     delegatable_permissions_json = COALESCE(?, delegatable_permissions_json), updated_at = datetime('now')
                 WHERE id = ?`,
                [
                    body.full_name !== undefined ? String(body.full_name).trim() : targetUser.full_name,
                    nextRole,
                    nextStatus,
                    body.can_generate_codes !== undefined ? (body.can_generate_codes ? 1 : 0) : targetUser.can_generate_codes,
                    body.can_invite_members !== undefined ? (body.can_invite_members ? 1 : 0) : targetUser.can_invite_members,
                    body.can_create_announcements !== undefined ? (body.can_create_announcements ? 1 : 0) : targetUser.can_create_announcements,
                    body.delegatable_permissions ? JSON.stringify(body.delegatable_permissions) : null,
                    targetUserId
                ]
            );

            if (nextStatus !== 'active') {
                await db.run("DELETE FROM user_sessions WHERE user_id = ?", [targetUserId]);
            }

            if (Array.isArray(body.subject_permissions)) {
                await db.run("DELETE FROM user_subjects WHERE user_id = ?", [targetUserId]);
                for (const sp of body.subject_permissions) {
                    const sid = parseInt(sp.subject_id, 10);
                    if (!sid) continue;
                    await db.run(
                        `INSERT INTO user_subjects
                         (user_id, subject_id, can_access_subject, can_view_materials, can_upload_materials, can_publish_materials, can_create_links, can_upload_videos, can_moderate, assigned_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                            targetUserId,
                            sid,
                            sp.can_access_subject !== false ? 1 : 0,
                            sp.can_view_materials !== false ? 1 : 0,
                            sp.can_upload_materials ? 1 : 0,
                            sp.can_publish_materials ? 1 : 0,
                            sp.can_create_links ? 1 : 0,
                            sp.can_upload_videos ? 1 : 0,
                            sp.can_moderate ? 1 : 0,
                            currentUser.id
                        ]
                    );
                }
            }

            await logActivity(db, {
                user: currentUser,
                actionType: 'USER_PERMISSIONS_UPDATED',
                targetType: 'user',
                targetId: targetUserId,
                description: `Updated permissions/status for ${targetUser.full_name} (role: ${nextRole}, status: ${nextStatus}).`,
                ipAddress: ip
            });

            return sendJson(res, 200, { ok: true });
        }

        // Announcements API
        if (pathname === '/api/announcements' && method === 'POST') {
            if (!currentUser) return sendJson(res, 401, { error: 'Authentication required.' });
            if (currentUser.role !== 'OWNER' && !currentUser.can_create_announcements) {
                return sendJson(res, 403, { error: 'You are not authorized to publish announcements.' });
            }
            const body = await parseJsonBody(req);
            const title = String(body.title || '').trim();
            const text = String(body.body || '').trim();
            if (!title || !text) return sendJson(res, 400, { error: 'Announcement title and body are required.' });

            const subjectId = body.subject_id ? parseInt(body.subject_id, 10) : null;
            if (subjectId && currentUser.role !== 'OWNER' && !hasSubjectPermission(currentUser, subjectId, 'can_access_subject')) {
                return sendJson(res, 403, { error: 'You cannot post announcements to an unassigned subject.' });
            }

            const ins = await db.run(
                `INSERT INTO announcements (subject_id, author_user_id, author_name, title, body, priority, audience, is_pinned)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    subjectId,
                    currentUser.id,
                    currentUser.full_name,
                    title,
                    text,
                    ['normal', 'important', 'urgent'].includes(body.priority) ? body.priority : 'normal',
                    ['all', 'members', 'staff', 'subject'].includes(body.audience) ? body.audience : subjectId ? 'subject' : 'all',
                    body.is_pinned ? 1 : 0
                ]
            );
            const created = await db.get("SELECT * FROM announcements WHERE id = ?", [ins.lastInsertRowid]);
            await logActivity(db, {
                user: currentUser,
                actionType: 'ANNOUNCEMENT_PUBLISHED',
                targetType: 'announcement',
                targetId: created.id,
                description: `Published announcement "${created.title}".`,
                ipAddress: ip
            });
            return sendJson(res, 201, { ok: true, announcement: created });
        }

        const annDeleteMatch = /^\/api\/announcements\/(\d+)$/.exec(pathname);
        if (annDeleteMatch && method === 'DELETE') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            await db.run("DELETE FROM announcements WHERE id = ?", [parseInt(annDeleteMatch[1], 10)]);
            return sendJson(res, 200, { ok: true });
        }

        // Update Notification Templates & Trigger Database Backup
        if (pathname === '/api/owner/notification-templates' && method === 'PUT') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const body = await parseJsonBody(req);
            const key = String(body.template_key || '').trim();
            const subject = String(body.subject || '').trim();
            const tplBody = String(body.body || '').trim();
            if (!key || !subject || !tplBody) {
                return sendJson(res, 400, { error: 'Template key, subject, and body are required.' });
            }
            await db.run("DELETE FROM notifications WHERE channel = 'template' AND template_key = ?", [key]);
            await db.run(
                `INSERT INTO notifications (channel, template_key, subject, body, delivery_status)
                 VALUES ('template', ?, ?, ?, 'template_saved')`,
                [key, subject, tplBody]
            );
            return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/owner/backup' && method === 'POST') {
            if (!currentUser || currentUser.role !== 'OWNER') {
                return sendJson(res, 403, { error: 'Owner authorization required.' });
            }
            const backupFile = path.join(backupDir, `learnity-backup-${Date.now()}.sqlite`);
            const result = await db.backup(backupFile);
            await logActivity(db, {
                user: currentUser,
                actionType: 'DATABASE_BACKUP',
                targetType: 'database',
                targetId: path.basename(backupFile),
                description: `Created SQLite database backup (${path.basename(backupFile)}).`,
                ipAddress: ip
            });
            return sendJson(res, 200, { ok: true, backupFile: path.basename(result.backupPath), timestamp: result.timestamp });
        }

        // =========================================================
        // 11. MEMBER PORTAL DASHBOARD API (Strict Subject Filtering)
        // =========================================================
        if (pathname === '/api/member/dashboard' && method === 'GET') {
            if (!currentUser) return sendJson(res, 401, { error: 'Please sign in to access the Member Portal.' });

            const allSubjects = await db.all("SELECT * FROM subjects WHERE is_active = 1 ORDER BY display_order ASC");
            const accessibleSubjectIds =
                currentUser.role === 'OWNER'
                    ? allSubjects.map((s) => s.id)
                    : currentUser.subjectPermissions.filter((p) => p.can_access_subject).map((p) => p.subject_id);

            // SECURITY INVARIANT: Only query resources belonging to accessibleSubjectIds
            const recentResources = accessibleSubjectIds.length
                ? await db.all(
                      `SELECT r.*, s.name AS subject_name, s.slug AS subject_slug, s.accent_color
                       FROM resources r
                       JOIN subjects s ON s.id = r.subject_id
                       WHERE r.subject_id IN (${accessibleSubjectIds.map(() => '?').join(',')})
                         AND (r.moderation_status = 'Published' OR r.author_user_id = ?)
                       ORDER BY r.is_featured DESC, r.id DESC
                       LIMIT 24`,
                      [...accessibleSubjectIds, currentUser.id]
                  )
                : [];

            const announcements = accessibleSubjectIds.length
                ? await db.all(
                      `SELECT a.*, s.name AS subject_name
                       FROM announcements a
                       LEFT JOIN subjects s ON s.id = a.subject_id
                       WHERE a.subject_id IS NULL OR a.subject_id IN (${accessibleSubjectIds.map(() => '?').join(',')})
                       ORDER BY a.is_pinned DESC, a.id DESC
                       LIMIT 12`,
                      accessibleSubjectIds
                  )
                : await db.all("SELECT * FROM announcements WHERE subject_id IS NULL ORDER BY is_pinned DESC, id DESC LIMIT 10");

            const personalLogs = await db.all(
                "SELECT * FROM activity_logs WHERE actor_user_id = ? ORDER BY id DESC LIMIT 15",
                [currentUser.id]
            );

            return sendJson(res, 200, {
                user: currentUser,
                subjects: allSubjects.map((s) => ({
                    ...s,
                    hasAccess: accessibleSubjectIds.includes(s.id),
                    permissions: currentUser.subjectPermMap[s.id] || null
                })),
                recentResources,
                announcements,
                personalActivity: personalLogs
            });
        }

        return sendJson(res, 404, { error: `API endpoint not found: ${method} ${pathname}` });
    } catch (err) {
        console.error(`[API Error ${method} ${pathname}]:`, err);
        return sendJson(res, 500, { error: err.message || 'Internal server error' });
    }
}

module.exports = { handleApiRequest };
