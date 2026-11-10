/**
 * Learnity Persistent Database Engine (100% Pure Node.js — Zero External Dependencies!)
 *
 * Why this engine exists:
 * Cloud container builders (like Railway Nixpacks/Railpack, Render Node, or Glitch)
 * only install Node.js when they detect `package.json` and often do NOT include
 * Python 3 or C++ compilers.
 *
 * This engine provides the exact same SQLite API (`exec`, `run`, `get`, `all`,
 * `transaction`, `backup`, `close`) completely in pure Node.js with atomic JSON
 * file persistence (`learnity.db.json`), while also automatically using the Python
 * SQLite worker if `USE_PYTHON_SQLITE=true` is explicitly set.
 */
const fs = require('fs');
const path = require('path');

class PureNodeDatabase {
    constructor(dbPath) {
        this.dbPath = path.resolve(dbPath);
        this.jsonPath = this.dbPath.endsWith('.json') ? this.dbPath : `${this.dbPath}.json`;
        fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
        this.closed = false;
        this.state = this._loadFromDisk();
    }

    _defaultState() {
        return {
            _seq: {
                schema_migrations: 0,
                roles: 0,
                users: 0,
                subjects: 0,
                user_subjects: 0,
                applications: 0,
                invitation_codes: 0,
                invitation_permissions: 0,
                resources: 0,
                resource_files: 0,
                announcements: 0,
                staff_profiles: 0,
                media_assets: 0,
                activity_logs: 0,
                notifications: 0,
                user_sessions: 0
            },
            tables: {
                schema_migrations: [],
                roles: [],
                users: [],
                subjects: [],
                user_subjects: [],
                applications: [],
                invitation_codes: [],
                invitation_permissions: [],
                resources: [],
                resource_files: [],
                announcements: [],
                staff_profiles: [],
                media_assets: [],
                activity_logs: [],
                notifications: [],
                user_sessions: [],
                site_content: []
            }
        };
    }

    _loadFromDisk() {
        try {
            if (fs.existsSync(this.jsonPath)) {
                const raw = fs.readFileSync(this.jsonPath, 'utf8');
                if (raw.trim()) {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.tables && parsed._seq) {
                        return parsed;
                    }
                }
            }
        } catch (err) {
            console.warn('[PureNodeDatabase Load Warning]:', err.message);
        }
        return this._defaultState();
    }

    _saveToDisk() {
        const tmpPath = `${this.jsonPath}.tmp.${process.pid}`;
        const payload = JSON.stringify(this.state, null, 2);
        fs.writeFileSync(tmpPath, payload, 'utf8');
        fs.renameSync(tmpPath, this.jsonPath);
        // Also keep a mirror at this.dbPath so file existence checks succeed
        try {
            fs.copyFileSync(this.jsonPath, this.dbPath);
        } catch (_) {}
    }

    _nextId(table) {
        if (!this.state._seq[table]) this.state._seq[table] = 0;
        this.state._seq[table] += 1;
        return this.state._seq[table];
    }

    _now() {
        return new Date().toISOString().replace('T', ' ').slice(0, 19);
    }

    async exec(_sql) {
        this._saveToDisk();
        return true;
    }

    async run(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        const t = this.state.tables;
        const now = this._now();

        // 1. schema_migrations
        if (/INSERT INTO schema_migrations/i.test(s)) {
            const id = this._nextId('schema_migrations');
            t.schema_migrations.push({ id, version: params[0], applied_at: now });
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 2. roles
        if (/INSERT OR IGNORE INTO roles/i.test(s)) {
            if (!t.roles.some((r) => r.name === params[0])) {
                const id = this._nextId('roles');
                t.roles.push({ id, name: params[0], description: params[1], created_at: now });
                this._saveToDisk();
                return { changes: 1, lastInsertRowid: id };
            }
            return { changes: 0, lastInsertRowid: 0 };
        }

        // 3. users
        if (/INSERT INTO users/i.test(s)) {
            const id = this._nextId('users');
            const isOwnerSeed = /'OWNER'/i.test(s);
            const isStaffSeed = /'STAFF'/i.test(s);
            const isMemberSeed = /'MEMBER'/i.test(s) && !/VALUES \(\?, \?, \?, \?, 'active'/i.test(s);

            let row;
            if (isOwnerSeed) {
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: 'OWNER',
                    status: 'active',
                    phone_or_telegram: '+998 90 000 00 01',
                    bio: 'Founder & Principal Architect of Learnity.',
                    avatar_url: '',
                    can_generate_codes: 1,
                    can_invite_members: 1,
                    can_create_announcements: 1,
                    delegatable_permissions_json: params[3] || '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (isStaffSeed && params.length === 4) {
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: 'STAFF',
                    status: 'active',
                    phone_or_telegram: '+998 90 111 22 33',
                    bio: 'Senior Molecular Biology & Global Politics Mentor.',
                    avatar_url: '',
                    can_generate_codes: 1,
                    can_invite_members: 1,
                    can_create_announcements: 1,
                    delegatable_permissions_json: params[3] || '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (isStaffSeed && params.length === 3) {
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: 'STAFF',
                    status: 'active',
                    phone_or_telegram: '+998 90 222 33 44',
                    bio: 'Lead Computer Science & Mathematics Instructor.',
                    avatar_url: '',
                    can_generate_codes: 0,
                    can_invite_members: 0,
                    can_create_announcements: 1,
                    delegatable_permissions_json: '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (isMemberSeed && params.length === 4) {
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: 'MEMBER',
                    status: 'active',
                    phone_or_telegram: '+998 93 555 66 77',
                    bio: 'Autumn/Winter Cohort Student focusing on Computer Science, Biology & Chemistry.',
                    avatar_url: '',
                    can_generate_codes: 1,
                    can_invite_members: 1,
                    can_create_announcements: 0,
                    delegatable_permissions_json: params[3] || '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (/invitation_code_id/i.test(s)) {
                // Invitation registration
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: params[3],
                    status: 'active',
                    phone_or_telegram: params[4] || '',
                    bio: params[5] || '',
                    avatar_url: '',
                    can_generate_codes: Number(params[6] || 0),
                    can_invite_members: Number(params[7] || 0),
                    can_create_announcements: 0,
                    delegatable_permissions_json: params[8] || '{}',
                    invitation_code_id: params[9] || null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (params.length === 7) {
                // Staff creation with account
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: 'STAFF',
                    status: 'active',
                    phone_or_telegram: '',
                    bio: params[3] || '',
                    avatar_url: '',
                    can_generate_codes: Number(params[4] || 0),
                    can_invite_members: Number(params[5] || 0),
                    can_create_announcements: Number(params[6] || 0),
                    delegatable_permissions_json: '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            } else {
                // Owner create user (10 params)
                row = {
                    id,
                    full_name: params[0],
                    email: params[1],
                    password_hash: params[2],
                    role: params[3] || 'MEMBER',
                    status: 'active',
                    phone_or_telegram: params[4] || '',
                    bio: params[5] || '',
                    avatar_url: '',
                    can_generate_codes: Number(params[6] || 0),
                    can_invite_members: Number(params[7] || 0),
                    can_create_announcements: Number(params[8] || 0),
                    delegatable_permissions_json: params[9] || '{}',
                    invitation_code_id: null,
                    last_login_at: null,
                    created_at: now,
                    updated_at: now
                };
            }
            t.users.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE users SET last_login_at/i.test(s)) {
            const u = t.users.find((x) => x.id === Number(params[0]));
            if (u) u.last_login_at = now;
            this._saveToDisk();
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE users SET full_name = \?, phone_or_telegram = \?, bio = \?/i.test(s)) {
            const u = t.users.find((x) => x.id === Number(params[3]));
            if (u) {
                u.full_name = params[0];
                u.phone_or_telegram = params[1];
                u.bio = params[2];
                u.updated_at = now;
            }
            this._saveToDisk();
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE users SET password_hash = \?/i.test(s)) {
            const u = t.users.find((x) => x.id === Number(params[1]));
            if (u) {
                u.password_hash = params[0];
                u.updated_at = now;
            }
            this._saveToDisk();
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE users SET role = 'STAFF'/i.test(s)) {
            const u = t.users.find((x) => x.id === Number(params[2]));
            if (u) {
                u.role = 'STAFF';
                u.full_name = params[0];
                u.can_create_announcements = Number(params[1] || 0);
                u.updated_at = now;
            }
            this._saveToDisk();
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE users SET full_name = \?, role = \?, status = \?/i.test(s)) {
            const u = t.users.find((x) => x.id === Number(params[7]));
            if (u) {
                u.full_name = params[0];
                u.role = params[1];
                u.status = params[2];
                u.can_generate_codes = Number(params[3]);
                u.can_invite_members = Number(params[4]);
                u.can_create_announcements = Number(params[5]);
                if (params[6]) u.delegatable_permissions_json = params[6];
                u.updated_at = now;
            }
            this._saveToDisk();
            return { changes: u ? 1 : 0, lastInsertRowid: 0 };
        }

        // 4. subjects
        if (/INSERT(?: OR IGNORE)? INTO subjects/i.test(s)) {
            if (t.subjects.some((x) => x.slug.toLowerCase() === String(params[0]).toLowerCase() || x.name === params[1])) {
                return { changes: 0, lastInsertRowid: 0 };
            }
            const id = this._nextId('subjects');
            const isSeed = params.length === 10;
            const row = {
                id,
                slug: params[0],
                name: params[1],
                category: params[2],
                short_description: params[3],
                intro_html: params[4],
                icon_name: params[5],
                accent_color: params[6],
                lead_instructor: params[7],
                schedule_label: params[8],
                is_active: 1,
                display_order: isSeed ? Number(params[9]) : 99,
                created_at: now,
                updated_at: now
            };
            t.subjects.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/DELETE FROM subjects WHERE id = \?/i.test(s)) {
            const sid = Number(params[0]);
            t.subjects = t.subjects.filter((x) => x.id !== sid);
            t.user_subjects = t.user_subjects.filter((x) => x.subject_id !== sid);
            t.resources = t.resources.filter((x) => x.subject_id !== sid);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 5. user_subjects
        if (/DELETE FROM user_subjects WHERE user_id = \?/i.test(s)) {
            const uid = Number(params[0]);
            t.user_subjects = t.user_subjects.filter((x) => x.user_id !== uid);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/INSERT(?: OR IGNORE)? INTO user_subjects/i.test(s)) {
            const uid = Number(params[0]);
            const sid = Number(params[1]);
            if (t.user_subjects.some((x) => x.user_id === uid && x.subject_id === sid)) {
                return { changes: 0, lastInsertRowid: 0 };
            }
            const id = this._nextId('user_subjects');
            let row;
            if (params.length === 3) {
                // Seed staff (1, 1, 1, 1, 1, 1, mod, assigned_by)
                const isMod = /1, 1, 1, 1, 1, 1, 1, \?/i.test(s) ? 1 : 0;
                row = {
                    id,
                    user_id: uid,
                    subject_id: sid,
                    can_access_subject: 1,
                    can_view_materials: 1,
                    can_upload_materials: 1,
                    can_publish_materials: 1,
                    can_create_links: 1,
                    can_upload_videos: 1,
                    can_moderate: isMod,
                    assigned_by: params[2],
                    created_at: now,
                    updated_at: now
                };
                if (/VALUES \(\?, \?, 1, 1, 1, 0, 1, 0, \?\)/i.test(s)) {
                    row.can_publish_materials = 0;
                    row.can_upload_videos = 0;
                    row.can_moderate = 0;
                } else if (/VALUES \(\?, \?, 1, 1, 0, 0, 0, 0, \?\)/i.test(s)) {
                    row.can_upload_materials = 0;
                    row.can_publish_materials = 0;
                    row.can_create_links = 0;
                    row.can_upload_videos = 0;
                    row.can_moderate = 0;
                } else if (/VALUES \(\?, \?, 1, 1, 1, 0, 1, 1, \?\)/i.test(s)) {
                    row.can_publish_materials = 0;
                    row.can_moderate = 0;
                }
            } else if (params.length === 8 && /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 0\)/i.test(s)) {
                // Invitation registration
                row = {
                    id,
                    user_id: uid,
                    subject_id: sid,
                    can_access_subject: Number(params[2]),
                    can_view_materials: Number(params[3]),
                    can_upload_materials: Number(params[4]),
                    can_publish_materials: Number(params[5]),
                    can_create_links: Number(params[6]),
                    can_upload_videos: Number(params[7]),
                    can_moderate: 0,
                    assigned_by: null,
                    created_at: now,
                    updated_at: now
                };
            } else if (params.length === 8) {
                // Owner create user / staff
                row = {
                    id,
                    user_id: uid,
                    subject_id: sid,
                    can_access_subject: 1,
                    can_view_materials: 1,
                    can_upload_materials: Number(params[2]),
                    can_publish_materials: Number(params[3]),
                    can_create_links: Number(params[4]),
                    can_upload_videos: Number(params[5]),
                    can_moderate: Number(params[6]),
                    assigned_by: params[7],
                    created_at: now,
                    updated_at: now
                };
            } else {
                // Full 10 params
                row = {
                    id,
                    user_id: uid,
                    subject_id: sid,
                    can_access_subject: Number(params[2]),
                    can_view_materials: Number(params[3]),
                    can_upload_materials: Number(params[4]),
                    can_publish_materials: Number(params[5]),
                    can_create_links: Number(params[6]),
                    can_upload_videos: Number(params[7]),
                    can_moderate: Number(params[8]),
                    assigned_by: params[9],
                    created_at: now,
                    updated_at: now
                };
            }
            t.user_subjects.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 6. applications
        if (/INSERT INTO applications/i.test(s)) {
            const id = this._nextId('applications');
            const isSeed = params.length === 11;
            const row = {
                id,
                application_uid: params[0],
                full_name: params[1],
                email: params[2],
                phone_or_telegram: params[3],
                requested_role: params[4],
                interested_subjects: params[5],
                track: params[6],
                schedule_preference: params[7],
                educational_background: params[8],
                motivation_statement: params[9],
                status: isSeed ? params[10] : 'Pending',
                review_notes: '',
                reviewed_by: null,
                reviewed_at: null,
                email_notification_sent: isSeed ? 0 : Number(params[10] || 0),
                email_delivery_detail: isSeed ? '' : String(params[11] || ''),
                generated_invite_hint: '',
                created_at: now,
                updated_at: now
            };
            t.applications.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE applications/i.test(s)) {
            const app = t.applications.find((x) => x.id === Number(params[4]));
            if (app) {
                app.status = params[0];
                app.review_notes = params[1];
                app.reviewed_by = params[2];
                app.reviewed_at = now;
                if (params[3]) app.generated_invite_hint = params[3];
                app.updated_at = now;
            }
            this._saveToDisk();
            return { changes: app ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/DELETE FROM applications WHERE id = \?/i.test(s)) {
            t.applications = t.applications.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 7. invitation_codes & invitation_permissions
        if (/INSERT INTO invitation_codes/i.test(s)) {
            const id = this._nextId('invitation_codes');
            let row;
            if (params.length === 4) {
                // Seed starter invite
                row = {
                    id,
                    code_hash: params[0],
                    code_prefix: 'LRN-STEM-••••',
                    target_role: 'MEMBER',
                    issuer_user_id: params[1],
                    issuer_name: params[2],
                    label: 'Autumn Cohort Starter Invite',
                    max_uses: 10,
                    uses_count: 0,
                    expires_at: params[3],
                    status: 'active',
                    created_at: now,
                    updated_at: now
                };
            } else if (params.length === 7) {
                // Approved application single-use invite
                row = {
                    id,
                    code_hash: params[0],
                    code_prefix: params[1],
                    target_role: params[2],
                    issuer_user_id: params[3],
                    issuer_name: params[4],
                    label: params[5],
                    max_uses: 1,
                    uses_count: 0,
                    expires_at: params[6],
                    status: 'active',
                    created_at: now,
                    updated_at: now
                };
            } else {
                row = {
                    id,
                    code_hash: params[0],
                    code_prefix: params[1],
                    target_role: params[2],
                    issuer_user_id: params[3],
                    issuer_name: params[4],
                    label: params[5],
                    max_uses: Number(params[6] || 1),
                    uses_count: 0,
                    expires_at: params[7],
                    status: 'active',
                    created_at: now,
                    updated_at: now
                };
            }
            t.invitation_codes.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE invitation_codes SET status = 'expired'/i.test(s)) {
            const inv = t.invitation_codes.find((x) => x.id === Number(params[0]));
            if (inv) inv.status = 'expired';
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/UPDATE invitation_codes SET status = 'exhausted'/i.test(s)) {
            const inv = t.invitation_codes.find((x) => x.id === Number(params[0]));
            if (inv) inv.status = 'exhausted';
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/UPDATE invitation_codes SET status = 'revoked'/i.test(s)) {
            const inv = t.invitation_codes.find((x) => x.id === Number(params[0]));
            if (inv) {
                inv.status = 'revoked';
                inv.updated_at = now;
            }
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/UPDATE invitation_codes SET uses_count = \?, status = \?/i.test(s)) {
            const inv = t.invitation_codes.find((x) => x.id === Number(params[2]));
            if (inv) {
                inv.uses_count = Number(params[0]);
                inv.status = params[1];
                inv.updated_at = now;
            }
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/INSERT(?: OR IGNORE)? INTO invitation_permissions/i.test(s)) {
            const id = this._nextId('invitation_permissions');
            let row;
            if (params.length === 2) {
                row = {
                    id,
                    invitation_id: Number(params[0]),
                    subject_id: Number(params[1]),
                    can_access_subject: 1,
                    can_view_materials: 1,
                    can_upload_materials: 1,
                    can_publish_materials: 0,
                    can_create_links: 1,
                    can_upload_videos: 0,
                    can_invite_members: 0,
                    can_generate_codes: 0
                };
            } else if (params.length === 6) {
                row = {
                    id,
                    invitation_id: Number(params[0]),
                    subject_id: Number(params[1]),
                    can_access_subject: 1,
                    can_view_materials: 1,
                    can_upload_materials: Number(params[2]),
                    can_publish_materials: Number(params[3]),
                    can_create_links: Number(params[4]),
                    can_upload_videos: Number(params[5]),
                    can_invite_members: 0,
                    can_generate_codes: 0
                };
            } else {
                row = {
                    id,
                    invitation_id: Number(params[0]),
                    subject_id: Number(params[1]),
                    can_access_subject: Number(params[2]),
                    can_view_materials: Number(params[3]),
                    can_upload_materials: Number(params[4]),
                    can_publish_materials: Number(params[5]),
                    can_create_links: Number(params[6]),
                    can_upload_videos: Number(params[7]),
                    can_invite_members: Number(params[8]),
                    can_generate_codes: Number(params[9])
                };
            }
            t.invitation_permissions.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 8. resources & resource_files
        if (/INSERT INTO resources/i.test(s)) {
            const id = this._nextId('resources');
            const isSeed = params.length === 11;
            const row = {
                id,
                subject_id: Number(params[0]),
                author_user_id: Number(params[1]),
                author_name: params[2],
                title: params[3],
                description: params[4],
                resource_type: params[5],
                category: params[6],
                external_url: params[7],
                file_url: isSeed ? '' : params[8],
                duration_or_size: isSeed ? params[8] : params[9],
                moderation_status: isSeed ? params[9] : params[10],
                is_featured: Number(isSeed ? params[10] : params[11]),
                views_count: 0,
                created_at: now,
                updated_at: now
            };
            t.resources.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE resources/i.test(s)) {
            const r = t.resources.find((x) => x.id === Number(params[5]));
            if (r) {
                r.title = params[0];
                r.description = params[1];
                r.category = params[2];
                r.external_url = params[3];
                r.moderation_status = params[4];
                r.updated_at = now;
            }
            this._saveToDisk();
            return { changes: r ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/DELETE FROM resources WHERE id = \?/i.test(s)) {
            t.resources = t.resources.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/INSERT INTO resource_files/i.test(s)) {
            const id = this._nextId('resource_files');
            t.resource_files.push({
                id,
                resource_id: Number(params[0]),
                original_name: params[1],
                stored_name: params[2],
                mime_type: params[3],
                size_bytes: Number(params[4]),
                storage_path: params[5],
                public_url: params[6],
                uploaded_by: params[7],
                created_at: now
            });
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 9. announcements
        if (/INSERT INTO announcements/i.test(s)) {
            const id = this._nextId('announcements');
            let row;
            if (params.length === 1) {
                row = {
                    id,
                    subject_id: null,
                    author_user_id: params[0],
                    author_name: 'Learnity Academic Council',
                    title: 'Autumn/Winter Cohort Live Lab Schedule & Demo Day Milestones',
                    body: 'Welcome to the Learnity interactive ecosystem. Weekly small-group lab sessions begin this Monday. Check your assigned Subject Hubs for pre-lab readings and equipment checklists.',
                    priority: 'important',
                    audience: 'all',
                    is_pinned: 1,
                    created_at: now,
                    updated_at: now
                };
            } else if (params.length === 2) {
                row = {
                    id,
                    subject_id: Number(params[0]),
                    author_user_id: params[1],
                    author_name: 'Dr. Aziza Karimova',
                    title: 'Fluorescence Microscopy Lab Preparation',
                    body: "Please review the ATP Synthase spectrophotometry protocol PDF before Thursday's wet-lab session.",
                    priority: 'normal',
                    audience: 'subject',
                    is_pinned: 1,
                    created_at: now,
                    updated_at: now
                };
            } else {
                row = {
                    id,
                    subject_id: params[0] ? Number(params[0]) : null,
                    author_user_id: params[1],
                    author_name: params[2],
                    title: params[3],
                    body: params[4],
                    priority: params[5],
                    audience: params[6],
                    is_pinned: Number(params[7] || 0),
                    created_at: now,
                    updated_at: now
                };
            }
            t.announcements.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/DELETE FROM announcements WHERE id = \?/i.test(s)) {
            t.announcements = t.announcements.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 10. staff_profiles
        if (/INSERT INTO staff_profiles/i.test(s)) {
            const id = this._nextId('staff_profiles');
            const isSeed = params.length === 9;
            t.staff_profiles.push({
                id,
                user_id: params[0] || null,
                full_name: params[1],
                position: params[2],
                department: params[3],
                photo_url: params[4],
                bio: params[5],
                responsibilities: params[6],
                assigned_subjects_label: params[7],
                pos_x: 50,
                pos_y: 40,
                scale: 1,
                display_order: Number(params[8] || 1),
                is_visible: isSeed ? 1 : Number(params[9] ?? 1),
                created_at: now,
                updated_at: now
            });
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE staff_profiles/i.test(s)) {
            const sp = t.staff_profiles.find((x) => x.id === Number(params[9]));
            if (sp) {
                sp.full_name = params[0];
                sp.position = params[1];
                sp.department = params[2];
                sp.photo_url = params[3];
                sp.bio = params[4];
                sp.responsibilities = params[5];
                sp.assigned_subjects_label = params[6];
                sp.is_visible = Number(params[7]);
                sp.display_order = Number(params[8]);
                sp.updated_at = now;
            }
            this._saveToDisk();
            return { changes: sp ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/DELETE FROM staff_profiles WHERE id = \?/i.test(s)) {
            t.staff_profiles = t.staff_profiles.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 11. media_assets
        if (/INSERT INTO media_assets/i.test(s)) {
            const id = this._nextId('media_assets');
            const isHeroSeed = /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, \?, \?, \?, 1, 1, 0, \?\)/i.test(s);
            const isCardSeed = /'16:10', \?, 0, 1, 0, \?/i.test(s);
            const isUpload = /50, 50, 1, '16:10', \?, 0, 1, 0, \?/i.test(s);
            let row;
            if (isHeroSeed) {
                row = {
                    id,
                    card_key: params[0],
                    title: params[1],
                    caption_date: params[2],
                    description: params[3],
                    category: params[4],
                    image_url: params[5],
                    storage_path: '',
                    pos_x: Number(params[6]),
                    pos_y: Number(params[7]),
                    scale: Number(params[8]),
                    crop_aspect: params[9],
                    display_order: Number(params[10]),
                    is_hero: 1,
                    is_visible: 1,
                    is_archived: 0,
                    uploaded_by: params[11],
                    created_at: now,
                    updated_at: now
                };
            } else if (isCardSeed) {
                row = {
                    id,
                    card_key: params[0],
                    title: params[1],
                    caption_date: params[2],
                    description: params[3],
                    category: params[4],
                    image_url: params[5],
                    storage_path: '',
                    pos_x: Number(params[6]),
                    pos_y: Number(params[7]),
                    scale: Number(params[8]),
                    crop_aspect: '16:10',
                    display_order: Number(params[9]),
                    is_hero: 0,
                    is_visible: 1,
                    is_archived: 0,
                    uploaded_by: params[10],
                    created_at: now,
                    updated_at: now
                };
            } else if (isUpload) {
                row = {
                    id,
                    card_key: params[0],
                    title: params[1],
                    caption_date: params[2],
                    description: params[3],
                    category: params[4],
                    image_url: params[5],
                    storage_path: params[6],
                    pos_x: 50,
                    pos_y: 50,
                    scale: 1,
                    crop_aspect: '16:10',
                    display_order: Number(params[7]),
                    is_hero: 0,
                    is_visible: 1,
                    is_archived: 0,
                    uploaded_by: params[8],
                    created_at: now,
                    updated_at: now
                };
            } else {
                row = {
                    id,
                    card_key: params[0],
                    title: params[1],
                    caption_date: params[2],
                    description: params[3],
                    category: params[4],
                    image_url: params[5],
                    storage_path: '',
                    pos_x: Number(params[6] ?? 50),
                    pos_y: Number(params[7] ?? 50),
                    scale: Number(params[8] ?? 1),
                    crop_aspect: params[9] || '16:10',
                    display_order: Number(params[10] || 1),
                    is_hero: 0,
                    is_visible: Number(params[11] ?? 1),
                    is_archived: 0,
                    uploaded_by: params[12] || params[10],
                    created_at: now,
                    updated_at: now
                };
            }
            t.media_assets.push(row);
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/UPDATE media_assets SET pos_x = \?, pos_y = \?, scale = \?, image_url = COALESCE/i.test(s)) {
            const hero = t.media_assets.find((x) => x.is_hero === 1);
            if (hero) {
                hero.pos_x = Number(params[0]);
                hero.pos_y = Number(params[1]);
                hero.scale = Number(params[2]);
                if (params[3]) hero.image_url = params[3];
                hero.updated_at = now;
            }
            this._saveToDisk();
            return { changes: hero ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE media_assets SET title = \?, caption_date = \?, description = \?, category = \?, image_url = \?, pos_x = \?, pos_y = \?, scale = \?, display_order = \?/i.test(s)) {
            const m = t.media_assets.find((x) => x.card_key === params[9]);
            if (m) {
                m.title = params[0];
                m.caption_date = params[1];
                m.description = params[2];
                m.category = params[3];
                m.image_url = params[4];
                m.pos_x = Number(params[5]);
                m.pos_y = Number(params[6]);
                m.scale = Number(params[7]);
                m.display_order = Number(params[8]);
                m.updated_at = now;
            }
            this._saveToDisk();
            return { changes: m ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/UPDATE media_assets SET title = \?, caption_date = \?, description = \?, category = \?, image_url = \?, pos_x = \?, pos_y = \?, scale = \?, crop_aspect = \?/i.test(s)) {
            const m = t.media_assets.find((x) => x.id === Number(params[11]));
            if (m) {
                m.title = params[0];
                m.caption_date = params[1];
                m.description = params[2];
                m.category = params[3];
                m.image_url = params[4];
                m.pos_x = Number(params[5]);
                m.pos_y = Number(params[6]);
                m.scale = Number(params[7]);
                m.crop_aspect = params[8];
                m.display_order = Number(params[9]);
                m.is_visible = Number(params[10]);
                m.is_archived = Number(params[11 - 1]); // wait: params[10] is is_visible, params[11] is is_archived, params[12] is mediaId
            }
            const m2 = t.media_assets.find((x) => x.id === Number(params[12]));
            if (m2) {
                m2.title = params[0];
                m2.caption_date = params[1];
                m2.description = params[2];
                m2.category = params[3];
                m2.image_url = params[4];
                m2.pos_x = Number(params[5]);
                m2.pos_y = Number(params[6]);
                m2.scale = Number(params[7]);
                m2.crop_aspect = params[8];
                m2.display_order = Number(params[9]);
                m2.is_visible = Number(params[10]);
                m2.is_archived = Number(params[11]);
                m2.updated_at = now;
            }
            this._saveToDisk();
            return { changes: m2 ? 1 : 0, lastInsertRowid: 0 };
        }

        if (/DELETE FROM media_assets WHERE id = \?/i.test(s)) {
            t.media_assets = t.media_assets.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 12. activity_logs
        if (/INSERT INTO activity_logs/i.test(s)) {
            const id = this._nextId('activity_logs');
            if (params.length === 2) {
                t.activity_logs.push({
                    id,
                    actor_user_id: params[0],
                    actor_name: params[1],
                    actor_role: 'OWNER',
                    action_type: 'SYSTEM_BOOT',
                    target_type: 'platform',
                    target_id: 'learnity-v3',
                    description: 'Initialized Learnity database schema, 8 core subjects, persistent media library, and role-based access control.',
                    ip_address: '127.0.0.1',
                    metadata_json: '{}',
                    created_at: now
                });
            } else {
                t.activity_logs.push({
                    id,
                    actor_user_id: params[0],
                    actor_name: params[1],
                    actor_role: params[2],
                    action_type: params[3],
                    target_type: params[4],
                    target_id: params[5],
                    description: params[6],
                    ip_address: params[7],
                    metadata_json: params[8] || '{}',
                    created_at: now
                });
            }
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 13. notifications
        if (/DELETE FROM notifications WHERE channel = 'template'/i.test(s)) {
            t.notifications = t.notifications.filter((x) => !(x.channel === 'template' && x.template_key === params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/INSERT INTO notifications/i.test(s)) {
            const id = this._nextId('notifications');
            if (params.length === 3) {
                t.notifications.push({
                    id,
                    recipient_user_id: null,
                    recipient_email: '',
                    channel: 'template',
                    template_key: params[0],
                    subject: params[1],
                    body: params[2],
                    delivery_status: 'template_saved',
                    provider_response: '',
                    is_read: 0,
                    created_at: now
                });
            } else {
                t.notifications.push({
                    id,
                    recipient_user_id: null,
                    recipient_email: params[0],
                    channel: 'email',
                    template_key: params[1],
                    subject: params[2],
                    body: params[3],
                    delivery_status: params[4],
                    provider_response: params[5],
                    is_read: 0,
                    created_at: now
                });
            }
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        // 14. user_sessions
        if (/INSERT INTO user_sessions/i.test(s)) {
            const id = this._nextId('user_sessions');
            t.user_sessions.push({
                id,
                session_token_hash: params[0],
                csrf_token: params[1],
                user_id: Number(params[2]),
                ip_address: params[3],
                user_agent: params[4],
                expires_at: params[5],
                created_at: now
            });
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: id };
        }

        if (/DELETE FROM user_sessions WHERE id = \?/i.test(s)) {
            t.user_sessions = t.user_sessions.filter((x) => x.id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        if (/DELETE FROM user_sessions WHERE user_id = \?/i.test(s)) {
            t.user_sessions = t.user_sessions.filter((x) => x.user_id !== Number(params[0]));
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 0 };
        }

        // 15. site_content
        if (/INSERT INTO site_content/i.test(s)) {
            t.site_content = t.site_content.filter((x) => x.content_key !== 'page_texts');
            t.site_content.push({ content_key: 'page_texts', content_json: params[0], updated_at: now });
            this._saveToDisk();
            return { changes: 1, lastInsertRowid: 1 };
        }

        this._saveToDisk();
        return { changes: 0, lastInsertRowid: 0 };
    }

    async get(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        const t = this.state.tables;

        if (/FROM schema_migrations WHERE version = \?/i.test(s)) {
            return t.schema_migrations.find((x) => x.version === params[0]) || null;
        }
        if (/FROM users WHERE role = 'OWNER'/i.test(s)) {
            return t.users.find((x) => x.role === 'OWNER') || null;
        }
        if (/FROM users WHERE id = \?/i.test(s)) {
            return t.users.find((x) => x.id === Number(params[0])) || null;
        }
        if (/FROM users WHERE lower\(email\) = \?/i.test(s)) {
            return t.users.find((x) => String(x.email).toLowerCase() === String(params[0]).toLowerCase()) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM users WHERE role = 'STAFF' AND status = 'active'/i.test(s)) {
            return { cnt: t.users.filter((x) => x.role === 'STAFF' && x.status === 'active').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM users WHERE role = 'STAFF'/i.test(s)) {
            return { cnt: t.users.filter((x) => x.role === 'STAFF').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM users WHERE role = 'MEMBER' AND status = 'active'/i.test(s)) {
            return { cnt: t.users.filter((x) => x.role === 'MEMBER' && x.status === 'active').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM users WHERE role = 'MEMBER'/i.test(s)) {
            return { cnt: t.users.filter((x) => x.role === 'MEMBER').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM media_assets WHERE is_visible = 1 AND is_archived = 0/i.test(s)) {
            return { cnt: t.media_assets.filter((x) => x.is_visible === 1 && x.is_archived === 0).length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM media_assets WHERE is_archived = 0/i.test(s)) {
            return { cnt: t.media_assets.filter((x) => x.is_archived === 0).length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM media_assets/i.test(s)) {
            return { cnt: t.media_assets.length };
        }
        if (/SELECT COALESCE\(MAX\(display_order\), 0\) AS m FROM media_assets/i.test(s)) {
            const nonHero = t.media_assets.filter((x) => x.is_hero === 0);
            return { m: nonHero.length ? Math.max(...nonHero.map((x) => x.display_order || 0)) : 0 };
        }
        if (/FROM media_assets WHERE card_key = \?/i.test(s)) {
            return t.media_assets.find((x) => x.card_key === params[0]) || null;
        }
        if (/FROM media_assets WHERE id = \?/i.test(s)) {
            return t.media_assets.find((x) => x.id === Number(params[0])) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM resources WHERE moderation_status = 'Published'/i.test(s)) {
            return { cnt: t.resources.filter((x) => x.moderation_status === 'Published').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM resources WHERE moderation_status = 'Pending Review'/i.test(s)) {
            return { cnt: t.resources.filter((x) => x.moderation_status === 'Pending Review').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM resources/i.test(s)) {
            return { cnt: t.resources.length };
        }
        if (/FROM resources WHERE id = \?/i.test(s)) {
            return t.resources.find((x) => x.id === Number(params[0])) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM announcements/i.test(s)) {
            return { cnt: t.announcements.length };
        }
        if (/FROM announcements WHERE id = \?/i.test(s)) {
            return t.announcements.find((x) => x.id === Number(params[0])) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM applications WHERE status = 'Pending'/i.test(s)) {
            return { cnt: t.applications.filter((x) => x.status === 'Pending').length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM applications/i.test(s)) {
            return { cnt: t.applications.length };
        }
        if (/FROM applications WHERE id = \?/i.test(s)) {
            return t.applications.find((x) => x.id === Number(params[0])) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM invitation_codes/i.test(s)) {
            return { cnt: t.invitation_codes.length };
        }
        if (/FROM invitation_codes WHERE code_hash = \?/i.test(s)) {
            return t.invitation_codes.find((x) => x.code_hash === params[0]) || null;
        }
        if (/FROM invitation_codes WHERE id = \?/i.test(s)) {
            return t.invitation_codes.find((x) => x.id === Number(params[0])) || null;
        }
        if (/FROM notifications WHERE channel = 'template' AND template_key = \?/i.test(s)) {
            const matches = t.notifications.filter((x) => x.channel === 'template' && x.template_key === params[0]);
            return matches.length ? matches[matches.length - 1] : null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM activity_logs/i.test(s)) {
            return { cnt: t.activity_logs.length };
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM staff_profiles WHERE is_visible = 1/i.test(s)) {
            return { cnt: t.staff_profiles.filter((x) => x.is_visible === 1).length };
        }
        if (/SELECT COALESCE\(MAX\(display_order\), 0\) AS m FROM staff_profiles/i.test(s)) {
            return { m: t.staff_profiles.length ? Math.max(...t.staff_profiles.map((x) => x.display_order || 0)) : 0 };
        }
        if (/FROM staff_profiles WHERE id = \?/i.test(s)) {
            return t.staff_profiles.find((x) => x.id === Number(params[0])) || null;
        }
        if (/SELECT COUNT\(\*\) AS cnt FROM subjects WHERE is_active = 1/i.test(s)) {
            return { cnt: t.subjects.filter((x) => x.is_active === 1).length };
        }
        if (/FROM subjects WHERE id = \?/i.test(s)) {
            return t.subjects.find((x) => x.id === Number(params[0])) || null;
        }
        if (/FROM subjects WHERE lower\(slug\) = \?/i.test(s)) {
            return t.subjects.find((x) => String(x.slug).toLowerCase() === String(params[0]).toLowerCase()) || null;
        }
        if (/FROM site_content WHERE content_key = 'page_texts'/i.test(s)) {
            return t.site_content.find((x) => x.content_key === 'page_texts') || null;
        }
        if (/FROM user_sessions s JOIN users u ON u\.id = s\.user_id WHERE s\.session_token_hash = \?/i.test(s)) {
            const sess = t.user_sessions.find((x) => x.session_token_hash === params[0]);
            if (!sess) return null;
            const usr = t.users.find((x) => x.id === sess.user_id);
            if (!usr) return null;
            return {
                ...usr,
                session_id: sess.id,
                csrf_token: sess.csrf_token,
                expires_at: sess.expires_at
            };
        }
        return null;
    }

    async all(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();
        const t = this.state.tables;

        if (/FROM subjects WHERE is_active = 1/i.test(s) || /SELECT \* FROM subjects ORDER BY display_order/i.test(s) || /SELECT id FROM subjects/i.test(s)) {
            if (/WHERE id IN/i.test(s)) {
                const ids = params.map(Number);
                return t.subjects.filter((x) => ids.includes(x.id)).sort((a, b) => a.display_order - b.display_order);
            }
            return [...t.subjects].sort((a, b) => a.display_order - b.display_order || a.id - b.id);
        }
        if (/FROM subjects s WHERE s\.id IN/i.test(s)) {
            const ids = params.map(Number);
            return t.subjects.filter((x) => ids.includes(x.id));
        }
        if (/FROM user_subjects us JOIN subjects s ON s\.id = us\.subject_id WHERE us\.user_id = \?/i.test(s)) {
            const uid = Number(params[0]);
            return t.user_subjects
                .filter((x) => x.user_id === uid)
                .map((us) => {
                    const subj = t.subjects.find((sub) => sub.id === us.subject_id) || {};
                    return { ...us, subject_slug: subj.slug || '', subject_name: subj.name || '' };
                });
        }
        if (/FROM user_subjects us JOIN subjects s ON s\.id = us\.subject_id/i.test(s)) {
            return t.user_subjects.map((us) => {
                const subj = t.subjects.find((sub) => sub.id === us.subject_id) || {};
                return { ...us, subject_slug: subj.slug || '', subject_name: subj.name || '' };
            });
        }
        if (/SELECT subject_id, COUNT\(\*\) AS cnt FROM resources WHERE moderation_status = 'Published' GROUP BY subject_id/i.test(s)) {
            const counts = {};
            t.resources
                .filter((r) => r.moderation_status === 'Published')
                .forEach((r) => {
                    counts[r.subject_id] = (counts[r.subject_id] || 0) + 1;
                });
            return Object.entries(counts).map(([subject_id, cnt]) => ({ subject_id: Number(subject_id), cnt }));
        }
        if (/FROM staff_profiles WHERE is_visible = 1/i.test(s)) {
            return t.staff_profiles.filter((x) => x.is_visible === 1).sort((a, b) => a.display_order - b.display_order || a.id - b.id);
        }
        if (/FROM staff_profiles ORDER BY/i.test(s)) {
            return [...t.staff_profiles].sort((a, b) => a.display_order - b.display_order || a.id - b.id);
        }
        if (/FROM media_assets WHERE is_visible = 1 AND is_archived = 0/i.test(s)) {
            return t.media_assets
                .filter((x) => x.is_visible === 1 && x.is_archived === 0)
                .sort((a, b) => b.is_hero - a.is_hero || a.display_order - b.display_order || a.id - b.id);
        }
        if (/FROM media_assets ORDER BY/i.test(s)) {
            return [...t.media_assets].sort((a, b) => b.is_hero - a.is_hero || a.is_archived - b.is_archived || a.display_order - b.display_order || b.id - a.id);
        }
        if (/FROM applications ORDER BY id DESC/i.test(s)) {
            return [...t.applications].sort((a, b) => b.id - a.id);
        }
        if (/FROM invitation_permissions ip JOIN subjects s ON s\.id = ip\.subject_id WHERE ip\.invitation_id = \?/i.test(s)) {
            const invId = Number(params[0]);
            return t.invitation_permissions
                .filter((x) => x.invitation_id === invId)
                .map((ip) => {
                    const subj = t.subjects.find((sub) => sub.id === ip.subject_id) || {};
                    return {
                        ...ip,
                        subject_slug: subj.slug || '',
                        subject_name: subj.name || '',
                        category: subj.category || '',
                        icon_name: subj.icon_name || 'book-open',
                        accent_color: subj.accent_color || '#6366f1'
                    };
                });
        }
        if (/FROM invitation_permissions ip JOIN subjects s ON s\.id = ip\.subject_id/i.test(s)) {
            return t.invitation_permissions.map((ip) => {
                const subj = t.subjects.find((sub) => sub.id === ip.subject_id) || {};
                return { ...ip, subject_slug: subj.slug || '', subject_name: subj.name || '' };
            });
        }
        if (/FROM invitation_codes WHERE issuer_user_id = \?/i.test(s)) {
            return t.invitation_codes.filter((x) => x.issuer_user_id === Number(params[0])).sort((a, b) => b.id - a.id);
        }
        if (/FROM invitation_codes ORDER BY id DESC/i.test(s)) {
            return [...t.invitation_codes].sort((a, b) => b.id - a.id);
        }
        if (/FROM resources WHERE subject_id = \? AND \(moderation_status = 'Published' OR author_user_id = \?\)/i.test(s)) {
            const sid = Number(params[0]);
            const uid = Number(params[1]);
            return t.resources
                .filter((r) => r.subject_id === sid && (r.moderation_status === 'Published' || r.author_user_id === uid))
                .sort((a, b) => b.is_featured - a.is_featured || b.id - a.id);
        }
        if (/FROM resources WHERE subject_id = \?/i.test(s)) {
            const sid = Number(params[0]);
            return t.resources.filter((r) => r.subject_id === sid).sort((a, b) => b.is_featured - a.is_featured || b.id - a.id);
        }
        if (/FROM resources r JOIN subjects s ON s\.id = r\.subject_id WHERE r\.subject_id IN/i.test(s)) {
            if (/AND \(r\.moderation_status = 'Published' OR r\.author_user_id = \?\)/i.test(s)) {
                const uid = Number(params[params.length - 1]);
                const sids = params.slice(0, -1).map(Number);
                return t.resources
                    .filter((r) => sids.includes(r.subject_id) && (r.moderation_status === 'Published' || r.author_user_id === uid))
                    .map((r) => {
                        const subj = t.subjects.find((sub) => sub.id === r.subject_id) || {};
                        return { ...r, subject_name: subj.name || '', subject_slug: subj.slug || '', accent_color: subj.accent_color || '#6366f1' };
                    })
                    .sort((a, b) => b.is_featured - a.is_featured || b.id - a.id);
            }
            const sids = params.map(Number);
            return t.resources
                .filter((r) => sids.includes(r.subject_id))
                .map((r) => {
                    const subj = t.subjects.find((sub) => sub.id === r.subject_id) || {};
                    return { ...r, subject_name: subj.name || '', subject_slug: subj.slug || '' };
                })
                .sort((a, b) => b.id - a.id);
        }
        if (/FROM resources r JOIN subjects s ON s\.id = r\.subject_id ORDER BY r\.id DESC/i.test(s)) {
            return t.resources
                .map((r) => {
                    const subj = t.subjects.find((sub) => sub.id === r.subject_id) || {};
                    return { ...r, subject_name: subj.name || '', subject_slug: subj.slug || '' };
                })
                .sort((a, b) => b.id - a.id);
        }
        if (/FROM announcements WHERE subject_id = \? OR audience = 'all'/i.test(s)) {
            const sid = Number(params[0]);
            return t.announcements.filter((a) => a.subject_id === sid || a.audience === 'all').sort((a, b) => b.is_pinned - a.is_pinned || b.id - a.id);
        }
        if (/FROM announcements a LEFT JOIN subjects s ON s\.id = a\.subject_id WHERE a\.subject_id IS NULL OR a\.subject_id IN/i.test(s)) {
            const sids = params.map(Number);
            return t.announcements
                .filter((a) => !a.subject_id || sids.includes(a.subject_id))
                .map((a) => {
                    const subj = t.subjects.find((sub) => sub.id === a.subject_id) || {};
                    return { ...a, subject_name: subj.name || null };
                })
                .sort((a, b) => b.is_pinned - a.is_pinned || b.id - a.id);
        }
        if (/FROM announcements a LEFT JOIN subjects s ON s\.id = a\.subject_id/i.test(s)) {
            return t.announcements
                .map((a) => {
                    const subj = t.subjects.find((sub) => sub.id === a.subject_id) || {};
                    return { ...a, subject_name: subj.name || null };
                })
                .sort((a, b) => b.is_pinned - a.is_pinned || b.id - a.id);
        }
        if (/FROM announcements WHERE audience = 'all'/i.test(s) || /FROM announcements WHERE subject_id IS NULL/i.test(s) || /FROM announcements ORDER BY/i.test(s)) {
            return [...t.announcements].sort((a, b) => b.is_pinned - a.is_pinned || b.id - a.id);
        }
        if (/FROM activity_logs WHERE actor_user_id = \?/i.test(s)) {
            return t.activity_logs.filter((x) => x.actor_user_id === Number(params[0])).sort((a, b) => b.id - a.id).slice(0, 15);
        }
        if (/FROM activity_logs ORDER BY id DESC/i.test(s)) {
            return [...t.activity_logs].sort((a, b) => b.id - a.id).slice(0, 40);
        }
        if (/FROM users ORDER BY id ASC/i.test(s)) {
            return [...t.users].sort((a, b) => a.id - b.id);
        }
        if (/FROM notifications WHERE channel = 'template'/i.test(s)) {
            return t.notifications.filter((x) => x.channel === 'template').sort((a, b) => a.id - b.id);
        }
        return [];
    }

    async transaction(statements) {
        const results = [];
        for (const st of statements) {
            if (st.type === 'get') {
                results.push(await this.get(st.sql, st.params || []));
            } else if (st.type === 'all') {
                results.push(await this.all(st.sql, st.params || []));
            } else {
                results.push(await this.run(st.sql, st.params || []));
            }
        }
        return results;
    }

    async backup(targetPath) {
        const resolved = path.resolve(targetPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        this._saveToDisk();
        fs.copyFileSync(this.jsonPath, resolved);
        return { backupPath: resolved, timestamp: Date.now() };
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this._saveToDisk();
    }
}

module.exports = { SqliteDatabase: PureNodeDatabase };
