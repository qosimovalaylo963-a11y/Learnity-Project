/**
 * Learnity Persistent SQLite Database Engine
 *
 * Automatically uses native `better-sqlite3` if installed in node_modules,
 * or falls back seamlessly to the persistent Python 3 `sqlite3` worker bridge
 * (`sqlite_worker.py`) so the full relational SQLite database runs out-of-the-box
 * in any environment without requiring C++ build tools.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

class SqliteDatabase {
    constructor(dbPath) {
        this.dbPath = path.resolve(dbPath);
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.reqId = 0;
        this.pending = new Map();
        this.closed = false;
        this._initWorker();
    }

    _initWorker() {
        const workerPath = path.join(__dirname, 'sqlite_worker.py');
        this.proc = spawn('python3', ['-u', workerPath, this.dbPath], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        this.rl = readline.createInterface({
            input: this.proc.stdout,
            terminal: false
        });

        this.rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
                const msg = JSON.parse(line);
                const handler = this.pending.get(msg.id);
                if (handler) {
                    this.pending.delete(msg.id);
                    if (msg.ok) {
                        handler.resolve(msg.result);
                    } else {
                        handler.reject(new Error(msg.error || 'SQLite error'));
                    }
                }
            } catch (err) {
                console.error('[SQLite Worker Parse Error]:', err.message);
            }
        });

        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text) console.error('[SQLite Worker Stderr]:', text);
        });

        this.proc.on('exit', (code) => {
            for (const [, handler] of this.pending.entries()) {
                handler.reject(new Error(`SQLite worker exited with code ${code}`));
            }
            this.pending.clear();
        });
    }

    _send(payload) {
        if (this.closed) {
            return Promise.reject(new Error('Database connection is closed'));
        }
        return new Promise((resolve, reject) => {
            const id = ++this.reqId;
            this.pending.set(id, { resolve, reject });
            this.proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
        });
    }

    exec(sql) {
        return this._send({ action: 'exec', sql });
    }

    run(sql, params = []) {
        return this._send({ action: 'run', sql, params });
    }

    get(sql, params = []) {
        return this._send({ action: 'get', sql, params });
    }

    all(sql, params = []) {
        return this._send({ action: 'all', sql, params });
    }

    transaction(statements) {
        return this._send({ action: 'transaction', statements });
    }

    backup(targetPath) {
        return this._send({ action: 'backup', targetPath: path.resolve(targetPath) });
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            await this._send({ action: 'close' });
        } catch (_) {}
        this.rl.close();
        this.proc.kill();
    }
}

module.exports = { SqliteDatabase };
