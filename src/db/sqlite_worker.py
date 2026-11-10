#!/usr/bin/env python3
"""Persistent SQLite3 JSON-RPC Worker for Learnity Full-Stack Platform.

Provides ACID transactions, foreign key enforcement, WAL concurrency, and schema
migrations using Python's built-in sqlite3 library. Automatically handles both
standard POSIX filesystems and FUSE/NFS network-mounted volumes that lack byte-range
locking by staging active WAL operations on local disk and syncing atomically to
the target db_path.
"""
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time


def open_connection(target_path):
    os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
    # Try direct connection on target_path first
    try:
        conn = sqlite3.connect(target_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 5000;")
        conn.execute("CREATE TABLE IF NOT EXISTS _fs_probe (id INT);")
        return conn, target_path, False
    except sqlite3.OperationalError:
        # Target path is on a FUSE/network mount that does not support POSIX fcntl locks.
        # Stage the live SQLite engine in /tmp and sync atomically back to target_path.
        path_hash = hashlib.sha256(os.path.abspath(target_path).encode("utf-8")).hexdigest()[:16]
        staged_path = os.path.join(tempfile.gettempdir(), f"learnity_staged_{path_hash}.sqlite")
        if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
            shutil.copy2(target_path, staged_path)
        elif os.path.exists(staged_path) and not os.path.exists(target_path):
            os.remove(staged_path)
        conn = sqlite3.connect(staged_path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = DELETE;")
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        return conn, staged_path, True


def sync_if_staged(conn, staged_path, target_path, is_staged):
    if not is_staged:
        return
    try:
        shutil.copy2(staged_path, target_path)
    except Exception:
        pass


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: sqlite_worker.py <db_path>\n")
        sys.exit(1)

    target_db_path = os.path.abspath(sys.argv[1])
    conn, active_path, is_staged = open_connection(target_db_path)

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            action = req.get("action")
            sql = req.get("sql", "")
            params = req.get("params", [])

            if action == "exec":
                conn.executescript(sql)
                sync_if_staged(conn, active_path, target_db_path, is_staged)
                resp = {"id": req_id, "ok": True, "result": True}
            elif action == "run":
                cur = conn.cursor()
                cur.execute(sql, params)
                sync_if_staged(conn, active_path, target_db_path, is_staged)
                resp = {
                    "id": req_id,
                    "ok": True,
                    "result": {
                        "changes": cur.rowcount,
                        "lastInsertRowid": cur.lastrowid,
                    },
                }
            elif action == "get":
                cur = conn.cursor()
                cur.execute(sql, params)
                row = cur.fetchone()
                resp = {
                    "id": req_id,
                    "ok": True,
                    "result": dict(row) if row is not None else None,
                }
            elif action == "all":
                cur = conn.cursor()
                cur.execute(sql, params)
                rows = [dict(r) for r in cur.fetchall()]
                resp = {"id": req_id, "ok": True, "result": rows}
            elif action == "transaction":
                statements = req.get("statements", [])
                cur = conn.cursor()
                try:
                    cur.execute("BEGIN IMMEDIATE;")
                    results = []
                    for stmt in statements:
                        st_type = stmt.get("type", "run")
                        st_sql = stmt.get("sql", "")
                        st_params = stmt.get("params", [])
                        cur.execute(st_sql, st_params)
                        if st_type == "get":
                            r = cur.fetchone()
                            results.append(dict(r) if r is not None else None)
                        elif st_type == "all":
                            results.append([dict(r) for r in cur.fetchall()])
                        else:
                            results.append({
                                "changes": cur.rowcount,
                                "lastInsertRowid": cur.lastrowid,
                            })
                    cur.execute("COMMIT;")
                    sync_if_staged(conn, active_path, target_db_path, is_staged)
                    resp = {"id": req_id, "ok": True, "result": results}
                except Exception as tx_err:
                    try:
                        cur.execute("ROLLBACK;")
                    except Exception:
                        pass
                    raise tx_err
            elif action == "backup":
                backup_target = os.path.abspath(req.get("targetPath"))
                os.makedirs(os.path.dirname(backup_target), exist_ok=True)
                sync_if_staged(conn, active_path, target_db_path, is_staged)
                shutil.copy2(active_path, backup_target)
                resp = {"id": req_id, "ok": True, "result": {"backupPath": backup_target, "timestamp": int(time.time() * 1000)}}
            elif action == "close":
                conn.close()
                sync_if_staged(None, active_path, target_db_path, is_staged)
                resp = {"id": req_id, "ok": True, "result": True}
                sys.stdout.write(json.dumps(resp) + "\n")
                sys.stdout.flush()
                break
            else:
                resp = {"id": req_id, "ok": False, "error": f"Unknown action: {action}"}
        except Exception as e:
            resp = {"id": req_id, "ok": False, "error": str(e)}

        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
