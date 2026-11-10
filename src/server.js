#!/usr/bin/env node
/**
 * LEARNITY — The Lively Teaching Project
 * Production Full-Stack Server (Node.js + Persistent SQLite + Static & SPA Route Support)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SqliteDatabase } = require('./db/database');
const { runMigrations } = require('./db/migrations');
const { seedDatabase } = require('./db/seed');
const { handleApiRequest } = require('./routes/api');

// Load .env if present
function loadDotEnv(envPath) {
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
            if (process.env[key] === undefined) {
                process.env[key] = val;
            }
        }
    });
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.ico': 'image/x-icon'
};

async function createLearnityServer(options = {}) {
    const rootDir = options.rootDir || path.join(__dirname, '..');
    const dataDir = options.dataDir || process.env.DATA_DIR || path.join(rootDir, 'data');
    const dbPath = options.dbPath || process.env.DB_PATH || path.join(dataDir, 'learnity.sqlite');
    const uploadDir = options.uploadDir || process.env.UPLOAD_DIR || path.join(dataDir, 'uploads');
    const backupDir = options.backupDir || path.join(dataDir, 'backups');
    const publicDir = options.publicDir || path.join(rootDir, 'public');

    fs.mkdirSync(uploadDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    const db = new SqliteDatabase(dbPath);
    await runMigrations(db);
    await seedDatabase(db);

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = decodeURIComponent(urlObj.pathname);

        // 1. API Routes
        if (pathname.startsWith('/api/')) {
            return handleApiRequest(req, res, { db, uploadDir, backupDir });
        }

        // 2. Persistent Uploaded Media & Resource Files (`/uploads/*`)
        if (pathname.startsWith('/uploads/')) {
            const safeName = path.basename(pathname);
            const targetFile = path.join(uploadDir, safeName);
            if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
                const ext = path.extname(safeName).toLowerCase();
                res.writeHead(200, {
                    'Content-Type': MIME_MAP[ext] || 'application/octet-stream',
                    'Cache-Control': 'public, max-age=31536000',
                    'X-Content-Type-Options': 'nosniff'
                });
                return fs.createReadStream(targetFile).pipe(res);
            }
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Uploaded file not found' }));
        }

        // 3. Static Files in `public/`
        const candidatePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
        if (
            candidatePath.startsWith(publicDir) &&
            fs.existsSync(candidatePath) &&
            fs.statSync(candidatePath).isFile()
        ) {
            const ext = path.extname(candidatePath).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME_MAP[ext] || 'text/plain; charset=utf-8',
                'X-Content-Type-Options': 'nosniff'
            });
            return fs.createReadStream(candidatePath).pipe(res);
        }

        // 4. Clean SPA Routes (`/subjects/biology`, `/subjects/chemistry`, `/owner`, `/staff`, `/portal`, `/join`, `/apply`)
        const indexHtml = path.join(publicDir, 'index.html');
        if (fs.existsSync(indexHtml)) {
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'X-Content-Type-Options': 'nosniff'
            });
            return fs.createReadStream(indexHtml).pipe(res);
        }

        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    });

    return { server, db, dbPath, uploadDir, backupDir };
}

if (require.main === module) {
    const port = parseInt(process.env.PORT || '3000', 10);
    createLearnityServer()
        .then(({ server, dbPath }) => {
            server.listen(port, '0.0.0.0', () => {
                console.log(`=========================================================`);
                console.log(`  LEARNITY — The Lively Teaching Project (v3.0 Ecosystem)`);
                console.log(`  Server listening on: http://localhost:${port}`);
                console.log(`  Persistent SQLite DB: ${dbPath}`);
                console.log(`=========================================================`);
            });
        })
        .catch((err) => {
            console.error('Failed to start Learnity server:', err);
            process.exit(1);
        });
}

module.exports = { createLearnityServer };
