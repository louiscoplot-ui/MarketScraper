import os
import json
import uuid
import secrets
from datetime import datetime, date, timedelta
from flask import Flask, request, jsonify
from flask_cors import CORS
import time
import anthropic
import requests as http_requests
import psycopg2
from psycopg2.extras import RealDictCursor
from apscheduler.schedulers.background import BackgroundScheduler
from pywebpush import webpush, WebPushException

_token_cache = {}

app = Flask(__name__)
CORS(app)

DATABASE_URL = os.environ.get("DATABASE_URL", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_EMAIL = os.environ.get("VAPID_EMAIL", "mailto:hello@dropleapp.com")


def get_db():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor, connect_timeout=10)
    return conn


def init_db():
    conn = get_db()
    cur = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT 'anonymous',
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            subtasks TEXT DEFAULT '[]',
            completed INTEGER DEFAULT 0,
            due_date TEXT DEFAULT NULL,
            urgent INTEGER DEFAULT 0,
            workspace_id TEXT DEFAULT NULL,
            created_at TEXT NOT NULL
        )
    """)
    # Migrations for existing tables
    for col, definition in [
        ("due_date", "TEXT DEFAULT NULL"),
        ("urgent", "INTEGER DEFAULT 0"),
        ("workspace_id", "TEXT DEFAULT NULL"),
        ("tags", "TEXT DEFAULT '[]'"),
    ]:
        try:
            cur.execute(f"ALTER TABLE items ADD COLUMN IF NOT EXISTS {col} {definition}")
        except Exception:
            conn.rollback()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS subtask_status (
            item_id INTEGER,
            subtask_index INTEGER,
            completed INTEGER DEFAULT 0,
            PRIMARY KEY (item_id, subtask_index)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id TEXT NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS workspaces (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT PRIMARY KEY,
            reminder_times TEXT DEFAULT '["09:00"]',
            reminder_days TEXT DEFAULT '[0,1,2,3,4,5,6]',
            reminder_sent_log TEXT DEFAULT '[]'
        )
    """)
    # Migrate old schema: add new columns if missing, drop old ones gracefully
    for col, defval in [
        ("reminder_times", "'[\"09:00\"]'"),
        ("reminder_days", "'[0,1,2,3,4,5,6]'"),
        ("reminder_sent_log", "'[]'"),
    ]:
        try:
            cur.execute(f"ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS {col} TEXT DEFAULT {defval}")
        except Exception:
            conn.rollback()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS workspace_members (
            id SERIAL PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            user_id TEXT DEFAULT NULL,
            user_email TEXT DEFAULT NULL,
            user_name TEXT DEFAULT NULL,
            user_picture TEXT DEFAULT NULL,
            invite_token TEXT UNIQUE NOT NULL,
            short_code TEXT UNIQUE,
            status TEXT DEFAULT 'pending',
            invited_at TEXT NOT NULL,
            joined_at TEXT DEFAULT NULL
        )
    """)
    try:
        cur.execute("ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS short_code TEXT UNIQUE")
    except Exception:
        conn.rollback()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            user_email TEXT,
            user_name TEXT,
            user_picture TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
    """)

    # Migrate user_settings to new schema (reminder_times/reminder_days arrays)
    for col, defval in [
        ("reminder_times", "'[\"09:00\"]'"),
        ("reminder_days",  "'[0,1,2,3,4,5,6]'"),
        ("reminder_sent_log", "'[]'"),
    ]:
        try:
            cur.execute(f"ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS {col} TEXT DEFAULT {defval}")
        except Exception:
            conn.rollback()

    conn.commit()
    cur.close()
    conn.close()


try:
    init_db()
    print("DB initialized OK")
except Exception as e:
    print(f"WARNING: init_db failed: {e}")


def get_user_id():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:]
    # Check session table first (persistent sessions)
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT user_id, expires_at FROM sessions WHERE token = %s", (token,))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if row and row["expires_at"] > datetime.now().isoformat():
            return row["user_id"]
    except Exception:
        pass
    # Fall back to Google token verification
    if token in _token_cache:
        cached_at, user_id = _token_cache[token]
        if time.time() - cached_at < 240:
            return user_id
    try:
        resp = http_requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if resp.status_code == 200:
            data = resp.json()
            user_id = data.get("sub")
            _token_cache[token] = (time.time(), user_id)
            return user_id
    except Exception:
        pass
    return None


def get_user_info():
    """Returns (user_id, email, name, picture) from token."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None, None, None, None
    token = auth[7:]
    try:
        resp = http_requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {token}"},
            timeout=5,
        )
        if resp.status_code == 200:
            d = resp.json()
            return d.get("sub"), d.get("email"), d.get("name"), d.get("picture")
    except Exception:
        pass
    return None, None, None, None


def send_push_to_user(user_id, title, body):
    if not VAPID_PRIVATE_KEY:
        return
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM push_subscriptions WHERE user_id = %s", (user_id,))
        subs = cur.fetchall()
        cur.close()
        conn.close()
        for sub in subs:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub["endpoint"],
                        "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                    },
                    data=json.dumps({"title": title, "body": body}),
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_EMAIL},
                )
            except WebPushException as ex:
                if ex.response and ex.response.status_code == 410:
                    conn2 = get_db()
                    cur2 = conn2.cursor()
                    cur2.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (sub["endpoint"],))
                    conn2.commit()
                    cur2.close()
                    conn2.close()
    except Exception as e:
        print(f"Push error: {e}")


def check_reminders():
    """Per-minute: send reminders matching each user's times + days."""
    try:
        now = datetime.now()
        current_hhmm = now.strftime("%H:%M")
        today = date.today().isoformat()
        dow = now.weekday()  # 0=Mon, 6=Sun
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        stale_cutoff = (date.today() - timedelta(days=5)).isoformat()

        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT * FROM user_settings")
        all_settings = cur.fetchall()

        for row in all_settings:
            uid = row["user_id"]
            try:
                times = json.loads(row["reminder_times"] or '["09:00"]')
                days = json.loads(row["reminder_days"] or '[0,1,2,3,4,5,6]')
                sent_log = json.loads(row["reminder_sent_log"] or '[]')
            except Exception:
                continue

            if dow not in [int(d) for d in days]:
                continue
            if current_hhmm not in times:
                continue

            current_key = f"{today} {current_hhmm}"
            if current_key in sent_log:
                continue

            # Due today or tomorrow
            cur.execute(
                "SELECT * FROM items WHERE user_id = %s AND completed = 0 AND due_date IN (%s, %s)",
                (uid, today, tomorrow),
            )
            for item in cur.fetchall():
                label = "aujourd'hui" if item["due_date"] == today else "demain"
                send_push_to_user(uid, "⏰ Rappel Drople", f"{item['title']} — échéance {label}")

            # Overdue
            cur.execute(
                "SELECT * FROM items WHERE user_id = %s AND completed = 0 AND due_date IS NOT NULL AND due_date < %s",
                (uid, today),
            )
            for item in cur.fetchall():
                send_push_to_user(uid, "🔴 En retard — Drople", f"As-tu fait : {item['title']} ?")

            # Stale todos
            cur.execute(
                "SELECT * FROM items WHERE user_id = %s AND completed = 0 AND type = 'todo' AND due_date IS NULL AND created_at < %s",
                (uid, stale_cutoff),
            )
            for item in cur.fetchall():
                send_push_to_user(uid, "💭 Drople te rappelle", f"Tu n'as pas encore fait : {item['title']}")

            # Mark sent (keep last 200 entries)
            sent_log.append(current_key)
            sent_log = sent_log[-200:]
            cur.execute(
                "UPDATE user_settings SET reminder_sent_log = %s WHERE user_id = %s",
                (json.dumps(sent_log), uid),
            )

        conn.commit()
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Reminder check error: {e}")


scheduler = BackgroundScheduler()
scheduler.add_job(check_reminders, "cron", minute="*")
scheduler.start()


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.route("/", methods=["GET"])
def root():
    return "OK", 200

@app.route("/api/ping", methods=["GET"])
def ping():
    return jsonify({"status": "alive"})

@app.route("/api/health", methods=["GET"])
def health():
    try:
        conn = get_db()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) as n FROM items")
        count = cur.fetchone()["n"]
        cur.close()
        conn.close()
        return jsonify({"status": "ok", "items_count": count, "db": "connected"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500

@app.route("/api/vapid-public-key", methods=["GET"])
def get_vapid_public_key():
    return jsonify({"key": VAPID_PUBLIC_KEY})

@app.route("/api/push/subscribe", methods=["POST"])
def push_subscribe():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id
    """, (user_id, data["endpoint"], data["keys"]["p256dh"], data["keys"]["auth"], datetime.now().isoformat()))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


# ─── Auth (persistent sessions) ──────────────────────────────────────────────

@app.route("/api/auth/google", methods=["POST"])
def auth_google():
    data = request.json or {}
    google_token = data.get("token")
    if not google_token:
        return jsonify({"error": "Missing token"}), 400
    try:
        resp = http_requests.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {google_token}"},
            timeout=5,
        )
        if resp.status_code != 200:
            return jsonify({"error": "Invalid Google token"}), 401
        profile = resp.json()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    user_id = profile.get("sub")
    session_token = secrets.token_urlsafe(32)
    expires_at = (datetime.now() + timedelta(days=30)).isoformat()
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO sessions (token, user_id, user_email, user_name, user_picture, created_at, expires_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
    """, (session_token, user_id, profile.get("email"), profile.get("name"),
          profile.get("picture"), datetime.now().isoformat(), expires_at))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({
        "session_token": session_token,
        "user": {
            "sub": user_id,
            "email": profile.get("email"),
            "name": profile.get("name"),
            "picture": profile.get("picture"),
        }
    })


@app.route("/api/auth/session", methods=["DELETE"])
def revoke_session():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        tok = auth[7:]
        try:
            conn = get_db()
            cur = conn.cursor()
            cur.execute("DELETE FROM sessions WHERE token = %s", (tok,))
            conn.commit()
            cur.close()
            conn.close()
        except Exception:
            pass
    return jsonify({"success": True})


# ─── User settings (reminders) ────────────────────────────────────────────────

@app.route("/api/settings", methods=["GET"])
def get_settings():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM user_settings WHERE user_id = %s", (user_id,))
    row = cur.fetchone()
    cur.close()
    conn.close()
    if row:
        return jsonify({
            "reminder_times": json.loads(row["reminder_times"] or '["09:00"]'),
            "reminder_days": json.loads(row["reminder_days"] or '[0,1,2,3,4,5,6]'),
        })
    return jsonify({"reminder_times": ["09:00"], "reminder_days": [0,1,2,3,4,5,6]})


@app.route("/api/settings", methods=["PUT"])
def update_settings():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    reminder_times = data.get("reminder_times", ["09:00"])
    reminder_days = data.get("reminder_days", [0,1,2,3,4,5,6])
    if not isinstance(reminder_times, list):
        reminder_times = ["09:00"]
    if not isinstance(reminder_days, list):
        reminder_days = [0,1,2,3,4,5,6]
    # Validate times format HH:MM
    import re
    reminder_times = [t for t in reminder_times if re.match(r'^\d{2}:\d{2}$', str(t))]
    reminder_days = [d for d in reminder_days if isinstance(d, int) and 0 <= d <= 6]
    conn = get_db()
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO user_settings (user_id, reminder_times, reminder_days)
        VALUES (%s, %s, %s)
        ON CONFLICT (user_id) DO UPDATE
        SET reminder_times = EXCLUDED.reminder_times,
            reminder_days = EXCLUDED.reminder_days,
            reminder_sent_log = '[]'
    """, (user_id, json.dumps(reminder_times), json.dumps(reminder_days)))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/tags/<tag>", methods=["DELETE"])
def delete_tag(tag):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id, tags FROM items WHERE user_id = %s AND tags IS NOT NULL", (user_id,))
    for item in cur.fetchall():
        try:
            tags = json.loads(item["tags"] or "[]")
            if tag in tags:
                tags = [t for t in tags if t != tag]
                cur.execute("UPDATE items SET tags = %s WHERE id = %s", (json.dumps(tags), item["id"]))
        except Exception:
            pass
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


# ─── Workspaces ───────────────────────────────────────────────────────────────

@app.route("/api/workspaces", methods=["GET"])
def get_workspaces():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    # Owned workspaces
    cur.execute("SELECT * FROM workspaces WHERE owner_id = %s ORDER BY created_at DESC", (user_id,))
    owned = [dict(r) for r in cur.fetchall()]
    # Member workspaces
    cur.execute("""
        SELECT w.* FROM workspaces w
        JOIN workspace_members m ON m.workspace_id = w.id
        WHERE m.user_id = %s AND m.status = 'active'
        ORDER BY w.created_at DESC
    """, (user_id,))
    member = [dict(r) for r in cur.fetchall()]
    # Merge, deduplicate
    seen = set()
    result = []
    for w in owned + member:
        if w["id"] not in seen:
            seen.add(w["id"])
            w["is_owner"] = w["owner_id"] == user_id
            # Get members
            cur.execute("""
                SELECT user_name, user_picture, status FROM workspace_members
                WHERE workspace_id = %s
            """, (w["id"],))
            w["members"] = [dict(r) for r in cur.fetchall()]
            result.append(w)
    cur.close()
    conn.close()
    return jsonify(result)


@app.route("/api/workspaces", methods=["POST"])
def create_workspace():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    wid = str(uuid.uuid4())
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO workspaces (id, name, owner_id, created_at) VALUES (%s, %s, %s, %s)",
        (wid, data["name"], user_id, datetime.now().isoformat())
    )
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"id": wid, "name": data["name"], "owner_id": user_id, "is_owner": True, "members": []})


@app.route("/api/workspaces/<wid>", methods=["DELETE"])
def delete_workspace(wid):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM workspaces WHERE id = %s AND owner_id = %s", (wid, user_id))
    cur.execute("DELETE FROM workspace_members WHERE workspace_id = %s", (wid,))
    cur.execute("UPDATE items SET workspace_id = NULL WHERE workspace_id = %s", (wid,))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/workspaces/<wid>/invite", methods=["POST"])
def create_invite(wid):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    # Verify user is owner or member
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT id FROM workspaces WHERE id = %s AND owner_id = %s", (wid, user_id))
    if not cur.fetchone():
        cur.execute("SELECT id FROM workspace_members WHERE workspace_id = %s AND user_id = %s AND status = 'active'", (wid, user_id))
        if not cur.fetchone():
            cur.close(); conn.close()
            return jsonify({"error": "Forbidden"}), 403
    token = secrets.token_urlsafe(20)
    # Short human-readable code (6 chars, no ambiguous chars)
    safe = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    short_code = "".join(secrets.choice(safe) for _ in range(6))
    cur.execute("""
        INSERT INTO workspace_members (workspace_id, invite_token, short_code, status, invited_at)
        VALUES (%s, %s, %s, 'pending', %s)
    """, (wid, token, short_code, datetime.now().isoformat()))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"token": token, "short_code": short_code})


def _do_join(cur, member, user_id, email, name, picture):
    cur.execute("""
        UPDATE workspace_members
        SET user_id = %s, user_email = %s, user_name = %s, user_picture = %s,
            status = 'active', joined_at = %s
        WHERE id = %s
    """, (user_id, email, name, picture, datetime.now().isoformat(), member["id"]))
    cur.execute("SELECT * FROM workspaces WHERE id = %s", (member["workspace_id"],))
    workspace = dict(cur.fetchone())
    workspace["is_owner"] = False
    workspace["members"] = []
    return workspace


@app.route("/api/workspaces/join/<token>", methods=["POST"])
def join_workspace(token):
    user_id, email, name, picture = get_user_info()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM workspace_members WHERE invite_token = %s AND status = 'pending'", (token,))
    member = cur.fetchone()
    if not member:
        cur.close(); conn.close()
        return jsonify({"error": "Invalid or already used invite"}), 404
    workspace = _do_join(cur, member, user_id, email, name, picture)
    conn.commit()
    cur.close()
    conn.close()
    return jsonify(workspace)


@app.route("/api/workspaces/join-by-code", methods=["POST"])
def join_by_code():
    user_id, email, name, picture = get_user_info()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    code = (request.json.get("code") or "").strip().upper()
    if not code:
        return jsonify({"error": "Code manquant"}), 400
    conn = get_db()
    cur = conn.cursor()
    cur.execute("SELECT * FROM workspace_members WHERE short_code = %s AND status = 'pending'", (code,))
    member = cur.fetchone()
    if not member:
        cur.close(); conn.close()
        return jsonify({"error": "Code invalide ou déjà utilisé"}), 404
    workspace = _do_join(cur, member, user_id, email, name, picture)
    conn.commit()
    cur.close()
    conn.close()
    return jsonify(workspace)


@app.route("/api/workspaces/<wid>/leave", methods=["POST"])
def leave_workspace(wid):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM workspace_members WHERE workspace_id = %s AND user_id = %s", (wid, user_id))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


# ─── Items ────────────────────────────────────────────────────────────────────

@app.route("/api/process", methods=["POST"])
def process_text():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    raw_text = data.get("text", "").strip()
    language = data.get("language", "french")
    categories = data.get("categories", [])
    if not raw_text:
        return jsonify({"error": "No text provided"}), 400
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY not set"}), 500
    client = anthropic.Anthropic(api_key=api_key)

    categories_instruction = ""
    if categories:
        cat_list = ", ".join(f'"{c}"' for c in categories)
        categories_instruction = f"""
6. TAGS: The user has defined these personal categories: [{cat_list}]. For each item, assign 0-3 relevant tags from this list (exact spelling). Only use tags from this list. Return them in a "tags" array."""

    prompt = f"""You are a smart note-taking assistant. Always respond in {language}. The user gives you a raw drop of thoughts (messy, vague, incomplete sentences, abbreviations).

Your job:
1. Split the input into SEPARATE items if it contains multiple distinct thoughts, tasks or ideas. Each distinct action or idea = one item.
2. For each item, detect the type:
   - "todo": actionable task to complete
   - "idea": creative idea, concept, something to explore
   - "call_note": notes from a phone call or meeting
   - "note": general info, reference, reminder
3. Create a clean concise title (max 60 chars) for each
4. Reformulate clearly in {language}
5. For "todo" items with sub-steps, add up to 5 subtasks{categories_instruction}

Return ONLY a valid JSON array (even if just one item), no markdown fences:
[
  {{
    "type": "todo" | "idea" | "call_note" | "note",
    "title": "short clean title",
    "content": "reformulated content",
    "subtasks": [],
    "tags": []
  }}
]

Raw input:
{raw_text}"""
    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = message.content[0].text.strip()
        if response_text.startswith("```"):
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:]
        result = json.loads(response_text)
        if isinstance(result, dict):
            result = [result]
        return jsonify(result)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"AI returned invalid JSON: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/items", methods=["GET"])
def get_items():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    workspace_id = request.args.get("workspace_id")
    conn = get_db()
    cur = conn.cursor()
    if workspace_id:
        cur.execute("SELECT * FROM items WHERE workspace_id = %s ORDER BY created_at DESC", (workspace_id,))
    else:
        cur.execute("SELECT * FROM items WHERE user_id = %s AND (workspace_id IS NULL OR workspace_id = '') ORDER BY created_at DESC", (user_id,))
    rows = cur.fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["subtasks"] = json.loads(item["subtasks"])
        item["tags"] = json.loads(item.get("tags") or "[]")
        item["completed"] = bool(item["completed"])
        item["urgent"] = bool(item.get("urgent", 0))
        cur.execute("SELECT subtask_index, completed FROM subtask_status WHERE item_id = %s", (item["id"],))
        statuses = cur.fetchall()
        item["subtask_status"] = {str(r["subtask_index"]): bool(r["completed"]) for r in statuses}
        result.append(item)
    cur.close()
    conn.close()
    return jsonify(result)


@app.route("/api/items", methods=["POST"])
def create_item():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_db()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO items (user_id, type, title, content, subtasks, due_date, urgent, workspace_id, tags, created_at) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (
            user_id,
            data["type"],
            data["title"],
            data["content"],
            json.dumps(data.get("subtasks", [])),
            data.get("due_date") or None,
            int(data.get("urgent", False)),
            data.get("workspace_id") or None,
            json.dumps(data.get("tags", [])),
            datetime.now().isoformat(),
        ),
    )
    item_id = cur.fetchone()["id"]
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"id": item_id, "success": True})


@app.route("/api/items/<int:item_id>", methods=["PUT"])
def update_item(item_id):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    data = request.json
    conn = get_db()
    cur = conn.cursor()
    if "completed" in data and "subtask_index" not in data:
        cur.execute("UPDATE items SET completed = %s WHERE id = %s AND user_id = %s", (int(data["completed"]), item_id, user_id))
    if "subtask_index" in data:
        cur.execute(
            "INSERT INTO subtask_status (item_id, subtask_index, completed) VALUES (%s,%s,%s) ON CONFLICT (item_id, subtask_index) DO UPDATE SET completed = EXCLUDED.completed",
            (item_id, data["subtask_index"], int(data["completed"])),
        )
    if "due_date" in data:
        cur.execute("UPDATE items SET due_date = %s WHERE id = %s AND user_id = %s", (data["due_date"] or None, item_id, user_id))
    if "urgent" in data:
        cur.execute("UPDATE items SET urgent = %s WHERE id = %s AND user_id = %s", (int(data["urgent"]), item_id, user_id))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/items/<int:item_id>", methods=["DELETE"])
def delete_item(item_id):
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401
    conn = get_db()
    cur = conn.cursor()
    cur.execute("DELETE FROM items WHERE id = %s AND user_id = %s", (item_id, user_id))
    cur.execute("DELETE FROM subtask_status WHERE item_id = %s", (item_id,))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
