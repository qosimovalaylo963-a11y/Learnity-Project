# LEARNITY — The Lively Teaching Project (v3.0 Full-Stack Ecosystem)

Learnity is a production-ready interactive educational platform featuring a 3D motion-engineered public website, two-way registration and cryptographic invitation authentication, granular subject-specific learning hubs, a Staff Workspace, a Member Portal, and a private Owner Dashboard with a persistent Media Library.

---

## 1. Architecture Overview

```
learnity-fullstack/
├── .env.example                 # Environment variable template (NEVER commit .env)
├── .gitignore                   # Protects .env, SQLite DBs, and private uploads
├── package.json                 # Scripts: start, migrate, seed, test
├── README.md                    # Setup, security, and deployment documentation
├── public/
│   └── index.html               # Complete Frontend (Preserves original 3D SVG logo & 6 classroom photos)
├── src/
│   ├── server.js                # Main HTTP/REST & SPA Server entry point
│   ├── db/
│   │   ├── database.js          # Persistent SQLite database manager
│   │   ├── sqlite_worker.py     # ACID / WAL SQLite3 bridge with automatic FUSE volume staging
│   │   ├── migrations.js        # 16 relational tables with foreign keys & indexes
│   │   └── seed.js              # Preserves original photos, 8 subjects, staff, and sample resources
│   ├── middleware/
│   │   └── security.js          # HttpOnly sessions, CSRF, rate limiting, magic-byte upload validation
│   ├── routes/
│   │   └── api.js               # Complete REST API for Auth, Applications, Invitations, Subjects, Media, Owner/Staff/Member
│   └── utils/
│       ├── crypto.js            # Memory-hard scrypt password hashing & SHA-256 invitation code hashing
│       └── mailer.js            # Configurable SMTP & Resend transactional email client
├── data/
│   ├── uploads/                 # Persistent uploaded photographs & learning documents
│   └── backups/                 # On-demand SQLite database snapshots
└── tests/
    └── run_all_tests.js         # Automated 20-point end-to-end integration test suite
```

---

## 2. Quick Start & Local Installation

### Prerequisites
- **Node.js** `>= 18.0.0`
- **Python 3** `>= 3.9` (with built-in `sqlite3` standard library)

### Step-by-Step Setup

1. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set a strong rotated `OWNER_PASSWORD`, your `OWNER_EMAIL`, and your SMTP or Resend credentials:
   ```ini
   PORT=3000
   OWNER_NAME="Learnity Platform Owner"
   OWNER_EMAIL="your-email@domain.com"
   OWNER_PASSWORD="YourStrongRotatedOwnerPassword!2026"

   # Optional SMTP configuration for live applicant email notifications
   SMTP_HOST="smtp.gmail.com"
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER="your-smtp-user@domain.com"
   SMTP_PASS="your-app-password"
   SMTP_FROM="Learnity Admissions <no-reply@domain.com>"
   ```

2. **Initialize Database Migrations & Seed Data**:
   ```bash
   npm run migrate
   npm run seed
   ```

3. **Run the 20-Point Integration Test Suite**:
   ```bash
   npm test
   ```

4. **Start the Server**:
   ```bash
   npm start
   ```
   Open `http://localhost:3000` in your browser.

---

## 3. Key Security & Architectural Guarantees

1. **Owner Separation from Invitation Codes**:
   - The `OWNER` account is provisioned via environment variables (`OWNER_EMAIL`, `OWNER_PASSWORD`).
   - Invitation codes (`LRN-XXXX-XXXX-XXXX`) can only create `MEMBER` or `STAFF` accounts—never `OWNER`.
   - Invitation codes are hashed with `SHA-256` (`invitation_codes.code_hash`); plain-text codes are never stored in SQLite.

2. **Granular Subject-Level RBAC**:
   - Permissions (`can_access_subject`, `can_view_materials`, `can_upload_materials`, `can_publish_materials`, `can_create_links`, `can_upload_videos`, `can_moderate`, `can_invite_members`, `can_generate_codes`) are enforced on the server for every Subject Learning Hub (`/subjects/biology`, `/subjects/chemistry`, `/subjects/physics`, `/subjects/mathematics`, `/subjects/english`, `/subjects/academic-writing`, `/subjects/research-skills`, `/subjects/programming`).
   - A Biology contributor or staff member cannot publish materials to Mathematics or access unassigned subject hubs.

3. **Persistent Media Library**:
   - Uploaded photographs are validated by MIME type, file size, and magic bytes (`PNG`, `JPEG`, `WEBP`, `GIF`) and stored on disk in `data/uploads/` with metadata in `media_assets`.
   - Upload 10 photos today, 30 next month, and 100 next year directly from **Owner Dashboard → Media Library** without touching any HTML or JavaScript code.

---

## 4. Production Deployment Recommendations (Persistent Volume)

When deploying to Render, Railway, Fly.io, DigitalOcean App Platform, or a VPS:
- Mount a **persistent disk volume** (e.g., `/var/data/learnity`) and set:
  ```ini
  DATA_DIR=/var/data/learnity
  DB_PATH=/var/data/learnity/learnity.sqlite
  UPLOAD_DIR=/var/data/learnity/uploads
  NODE_ENV=production
  ```
- Rotate `OWNER_PASSWORD` in your hosting provider's secret manager before first boot.
