import os
import json
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import time
import anthropic
import requests as http_requests
import psycopg2
from psycopg2.extras import RealDictCursor

_token_cache = {}

app = Flask(__name__)
CORS(app)

DATABASE_URL = os.environ.get("DATABASE_URL", "")


def get_db():
    conn = psycopg2.connect(DATABASE_URL, cursor_factory=RealDictCursor, sslmode="require")
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
            created_at TEXT NOT NULL
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS subtask_status (
            item_id INTEGER,
            subtask_index INTEGER,
            completed INTEGER DEFAULT 0,
            PRIMARY KEY (item_id, subtask_index)
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
    # Cache valid tokens for 4 minutes
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

    prompt = f"""You are a smart note-taking assistant. Always respond in {language}. The user gives you a raw braindump (messy, vague, incomplete sentences, abbreviations).

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
        # Normalize to always return array
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
        "INSERT INTO items (user_id, type, title, content, subtasks, created_at) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (user_id, data["type"], data["title"], data["content"], json.dumps(data.get("subtasks", [])), datetime.now().isoformat()),
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
