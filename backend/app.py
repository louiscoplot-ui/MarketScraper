import os
import json
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
VAPID_EMAIL = os.environ.get("VAPID_EMAIL", "mailto:hello@drople.app")


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
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        ALTER TABLE items ADD COLUMN IF NOT EXISTS due_date TEXT DEFAULT NULL
    """)
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
            user_id = resp.json().get("sub")
            _token_cache[token] = (time.time(), user_id)
            return user_id
    except Exception:
        pass
    return None


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
                    # Subscription expired — remove it
                    conn2 = get_db()
                    cur2 = conn2.cursor()
                    cur2.execute("DELETE FROM push_subscriptions WHERE endpoint = %s", (sub["endpoint"],))
                    conn2.commit()
                    cur2.close()
                    conn2.close()
    except Exception as e:
        print(f"Push error: {e}")


def check_reminders():
    """Run daily: send push notifications for items due today or tomorrow."""
    try:
        conn = get_db()
        cur = conn.cursor()
        today = date.today().isoformat()
        tomorrow = (date.today() + timedelta(days=1)).isoformat()
        cur.execute(
            "SELECT * FROM items WHERE completed = 0 AND due_date IN (%s, %s)",
            (today, tomorrow),
        )
        rows = cur.fetchall()
        cur.close()
        conn.close()
        for row in rows:
            is_today = row["due_date"] == today
            label = "aujourd'hui" if is_today else "demain"
            send_push_to_user(
                row["user_id"],
                f"⏰ Rappel Drople",
                f"{row['title']} — échéance {label}",
            )
    except Exception as e:
        print(f"Reminder check error: {e}")


# Schedule reminder check every day at 8:00 AM
scheduler = BackgroundScheduler()
scheduler.add_job(check_reminders, "cron", hour=8, minute=0)
scheduler.start()


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
    """, (
        user_id,
        data["endpoint"],
        data["keys"]["p256dh"],
        data["keys"]["auth"],
        datetime.now().isoformat(),
    ))
    conn.commit()
    cur.close()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/process", methods=["POST"])
def process_text():
    user_id = get_user_id()
    if not user_id:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.json
    raw_text = data.get("text", "").strip()
    language = data.get("language", "french")

    if not raw_text:
        return jsonify({"error": "No text provided"}), 400

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return jsonify({"error": "ANTHROPIC_API_KEY not set"}), 500

    client = anthropic.Anthropic(api_key=api_key)

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
5. For "todo" items with sub-steps, add up to 5 subtasks

Return ONLY a valid JSON array (even if just one item), no markdown fences:
[
  {{
    "type": "todo" | "idea" | "call_note" | "note",
    "title": "short clean title",
    "content": "reformulated content",
    "subtasks": []
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

    filter_type = request.args.get("type", "all")
    conn = get_db()
    cur = conn.cursor()

    if filter_type == "all":
        cur.execute("SELECT * FROM items WHERE user_id = %s ORDER BY created_at DESC", (user_id,))
    else:
        cur.execute("SELECT * FROM items WHERE user_id = %s AND type = %s ORDER BY created_at DESC", (user_id, filter_type))

    rows = cur.fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["subtasks"] = json.loads(item["subtasks"])
        item["completed"] = bool(item["completed"])
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
        "INSERT INTO items (user_id, type, title, content, subtasks, due_date, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (
            user_id,
            data["type"],
            data["title"],
            data["content"],
            json.dumps(data.get("subtasks", [])),
            data.get("due_date") or None,
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
            "INSERT INTO subtask_status (item_id, subtask_index, completed) VALUES (%s, %s, %s) ON CONFLICT (item_id, subtask_index) DO UPDATE SET completed = EXCLUDED.completed",
            (item_id, data["subtask_index"], int(data["completed"])),
        )

    if "due_date" in data:
        cur.execute("UPDATE items SET due_date = %s WHERE id = %s AND user_id = %s", (data["due_date"] or None, item_id, user_id))

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
