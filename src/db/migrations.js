/**
 * Learnity Database Schema & Migrations
 *
 * Implements all 15+ tables required by the specification with foreign keys,
 * indexes, constraints, timestamps, and cascading rules.
 */

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 1. roles
CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE CHECK (name IN ('OWNER', 'STAFF', 'MEMBER', 'VISITOR')),
    description TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. users
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'STAFF', 'MEMBER', 'VISITOR')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'suspended')),
    phone_or_telegram TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    can_generate_codes INTEGER NOT NULL DEFAULT 0,
    can_invite_members INTEGER NOT NULL DEFAULT 0,
    can_create_announcements INTEGER NOT NULL DEFAULT 0,
    delegatable_permissions_json TEXT NOT NULL DEFAULT '{}',
    invitation_code_id INTEGER,
    last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 3. subjects
CREATE TABLE IF NOT EXISTS subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL DEFAULT 'Core Science',
    short_description TEXT NOT NULL,
    intro_html TEXT NOT NULL,
    icon_name TEXT NOT NULL DEFAULT 'book-open',
    accent_color TEXT NOT NULL DEFAULT '#6366f1',
    lead_instructor TEXT DEFAULT 'Learnity Academic Team',
    schedule_label TEXT DEFAULT 'Weekly Interactive Lab',
    is_active INTEGER NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subjects_slug ON subjects(slug);

-- 4. user_subjects (Granular per-subject permissions for Staff & Members)
CREATE TABLE IF NOT EXISTS user_subjects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    can_access_subject INTEGER NOT NULL DEFAULT 1,
    can_view_materials INTEGER NOT NULL DEFAULT 1,
    can_upload_materials INTEGER NOT NULL DEFAULT 0,
    can_publish_materials INTEGER NOT NULL DEFAULT 0,
    can_create_links INTEGER NOT NULL DEFAULT 0,
    can_upload_videos INTEGER NOT NULL DEFAULT 0,
    can_moderate INTEGER NOT NULL DEFAULT 0,
    assigned_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, subject_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_subjects_user ON user_subjects(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subjects_subject ON user_subjects(subject_id);

-- 5. applications
CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_uid TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone_or_telegram TEXT NOT NULL,
    requested_role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (requested_role IN ('MEMBER', 'STAFF')),
    interested_subjects TEXT NOT NULL DEFAULT '[]',
    track TEXT NOT NULL DEFAULT '',
    schedule_preference TEXT NOT NULL DEFAULT 'Weekday Intensive',
    educational_background TEXT NOT NULL DEFAULT '',
    motivation_statement TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Approved', 'Rejected', 'Contacted')),
    review_notes TEXT NOT NULL DEFAULT '',
    reviewed_by INTEGER,
    reviewed_at TEXT,
    email_notification_sent INTEGER NOT NULL DEFAULT 0,
    email_delivery_detail TEXT NOT NULL DEFAULT '',
    generated_invite_hint TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_role ON applications(requested_role);

-- 6. invitation_codes (Only SHA-256 hash stored, never plain-text)
CREATE TABLE IF NOT EXISTS invitation_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_hash TEXT NOT NULL UNIQUE,
    code_prefix TEXT NOT NULL,
    target_role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (target_role IN ('MEMBER', 'STAFF')),
    issuer_user_id INTEGER NOT NULL,
    issuer_name TEXT NOT NULL,
    label TEXT DEFAULT '',
    max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
    uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0),
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired', 'exhausted')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (issuer_user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invitation_codes_hash ON invitation_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_invitation_codes_status ON invitation_codes(status);

-- 7. invitation_permissions (Subjects & granular permissions tied to an invitation code)
CREATE TABLE IF NOT EXISTS invitation_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invitation_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    can_access_subject INTEGER NOT NULL DEFAULT 1,
    can_view_materials INTEGER NOT NULL DEFAULT 1,
    can_upload_materials INTEGER NOT NULL DEFAULT 0,
    can_publish_materials INTEGER NOT NULL DEFAULT 0,
    can_create_links INTEGER NOT NULL DEFAULT 0,
    can_upload_videos INTEGER NOT NULL DEFAULT 0,
    can_invite_members INTEGER NOT NULL DEFAULT 0,
    can_generate_codes INTEGER NOT NULL DEFAULT 0,
    UNIQUE(invitation_id, subject_id),
    FOREIGN KEY (invitation_id) REFERENCES invitation_codes(id) ON DELETE CASCADE,
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_inv_perms_invitation ON invitation_permissions(invitation_id);

-- 8. resources (Learning hub materials, PDFs, presentations, YouTube videos, external links)
CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER NOT NULL,
    author_user_id INTEGER,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    resource_type TEXT NOT NULL CHECK (resource_type IN ('pdf', 'presentation', 'video', 'youtube', 'link', 'study_guide')),
    category TEXT NOT NULL DEFAULT 'Core Study Materials',
    external_url TEXT DEFAULT '',
    file_url TEXT DEFAULT '',
    duration_or_size TEXT DEFAULT '',
    moderation_status TEXT NOT NULL DEFAULT 'Published' CHECK (moderation_status IN ('Pending Review', 'Approved', 'Published', 'Rejected')),
    is_featured INTEGER NOT NULL DEFAULT 0,
    views_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_subject ON resources(subject_id);
CREATE INDEX IF NOT EXISTS idx_resources_status ON resources(moderation_status);

-- 9. resource_files (Uploaded binary documents & presentations linked to resources)
CREATE TABLE IF NOT EXISTS resource_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_path TEXT NOT NULL,
    public_url TEXT NOT NULL,
    uploaded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);

-- 10. announcements (Global or subject-specific announcements)
CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_id INTEGER,
    author_user_id INTEGER,
    author_name TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'important', 'urgent')),
    audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'members', 'staff', 'subject')),
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
    FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_announcements_subject ON announcements(subject_id);

-- 11. staff_profiles (Public Staff Directory & Staff Workspace metadata)
CREATE TABLE IF NOT EXISTS staff_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    full_name TEXT NOT NULL,
    position TEXT NOT NULL,
    department TEXT NOT NULL DEFAULT 'Academic Mentorship',
    photo_url TEXT NOT NULL,
    bio TEXT NOT NULL,
    responsibilities TEXT NOT NULL DEFAULT '',
    assigned_subjects_label TEXT NOT NULL DEFAULT '',
    pos_x REAL NOT NULL DEFAULT 50,
    pos_y REAL NOT NULL DEFAULT 40,
    scale REAL NOT NULL DEFAULT 1,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 12. media_assets (Persistent Photo & Media Management Library)
CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    caption_date TEXT NOT NULL DEFAULT 'Live Workshop Session',
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Live Workshop',
    image_url TEXT NOT NULL,
    storage_path TEXT DEFAULT '',
    pos_x REAL NOT NULL DEFAULT 50,
    pos_y REAL NOT NULL DEFAULT 50,
    scale REAL NOT NULL DEFAULT 1,
    crop_aspect TEXT NOT NULL DEFAULT '16:10',
    display_order INTEGER NOT NULL DEFAULT 0,
    is_hero INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    is_archived INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_media_assets_order ON media_assets(display_order);

-- 13. activity_logs (Security & Audit Trail)
CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id INTEGER,
    actor_name TEXT NOT NULL DEFAULT 'System',
    actor_role TEXT NOT NULL DEFAULT 'SYSTEM',
    action_type TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON activity_logs(created_at DESC);

-- 14. notifications (In-app & Email Notification Records + Templates)
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_user_id INTEGER,
    recipient_email TEXT DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'in_app' CHECK (channel IN ('in_app', 'email', 'template')),
    template_key TEXT DEFAULT '',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    delivery_status TEXT NOT NULL DEFAULT 'delivered' CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'template_saved')),
    provider_response TEXT DEFAULT '',
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 15. user_sessions (Persistent Server-Side Sessions with HttpOnly Cookie Tokens)
CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(session_token_hash);

-- 16. site_content (Preserves existing inline editable text keys & configuration)
CREATE TABLE IF NOT EXISTS site_content (
    content_key TEXT PRIMARY KEY,
    content_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

async function runMigrations(db) {
    await db.exec(SCHEMA_SQL);
    const existing = await db.get("SELECT version FROM schema_migrations WHERE version = ?", ['2026.11.01-ultra-ecosystem']);
    if (!existing) {
        await db.run("INSERT INTO schema_migrations (version) VALUES (?)", ['2026.11.01-ultra-ecosystem']);
    }
}

module.exports = { runMigrations, SCHEMA_SQL };
