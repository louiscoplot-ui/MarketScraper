import os
import json
import sqlite3
from datetime import datetime
from flask import Flask, request, jsonify
from flask_cors import CORS
import anthropic

app = Flask(__name__)
CORS(app)

DB_PATH = os.path.join(os.path.dirname(__file__), "braindump.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            subtasks TEXT DEFAULT '[]',
            completed INTEGER DEFAULT 0,
            created_at TEXT NOT NULL
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS subtask_status (
            item_id INTEGER,
            subtask_index INTEGER,
            completed INTEGER DEFAULT 0,
            PRIMARY KEY (item_id, subtask_index)
        )
    """)
    conn.commit()
    conn.close()


@app.route("/api/process", methods=["POST"])
def process_text():
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
1. Detect the type:
   - "todo": actionable task(s) to complete
   - "idea": creative idea, concept, project idea, something to explore
   - "call_note": notes from a phone call or meeting
   - "note": general info, reference, reminder, something to remember
2. Create a clean, concise title (max 60 characters)
3. Reformulate the content clearly (keep the same language as the input)
4. If it's a "todo" with multiple distinct actions, extract up to 5 subtasks

Return ONLY valid JSON with no markdown fences:
{{
  "type": "todo" | "idea" | "call_note" | "note",
  "title": "short clean title",
  "content": "reformulated content",
  "subtasks": ["subtask 1", "subtask 2"]
}}

If there are no subtasks, return "subtasks": []

Raw input:
{raw_text}"""

    try:
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = message.content[0].text.strip()
        # Strip markdown fences if model returns them
        if response_text.startswith("```"):
            response_text = response_text.split("```")[1]
            if response_text.startswith("json"):
                response_text = response_text[4:]
        result = json.loads(response_text)
        return jsonify(result)
    except json.JSONDecodeError as e:
        return jsonify({"error": f"AI returned invalid JSON: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/items", methods=["GET"])
def get_items():
    filter_type = request.args.get("type", "all")
    conn = get_db()

    if filter_type == "all":
        rows = conn.execute(
            "SELECT * FROM items ORDER BY created_at DESC"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM items WHERE type = ? ORDER BY created_at DESC",
            (filter_type,),
        ).fetchall()

    result = []
    for row in rows:
        item = dict(row)
        item["subtasks"] = json.loads(item["subtasks"])
        item["completed"] = bool(item["completed"])
        statuses = conn.execute(
            "SELECT subtask_index, completed FROM subtask_status WHERE item_id = ?",
            (item["id"],),
        ).fetchall()
        item["subtask_status"] = {
            str(r["subtask_index"]): bool(r["completed"]) for r in statuses
        }
        result.append(item)

    conn.close()
    return jsonify(result)


@app.route("/api/items", methods=["POST"])
def create_item():
    data = request.json
    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO items (type, title, content, subtasks, created_at) VALUES (?, ?, ?, ?, ?)",
        (
            data["type"],
            data["title"],
            data["content"],
            json.dumps(data.get("subtasks", [])),
            datetime.now().isoformat(),
        ),
    )
    conn.commit()
    item_id = cursor.lastrowid
    conn.close()
    return jsonify({"id": item_id, "success": True})


@app.route("/api/items/<int:item_id>", methods=["PUT"])
def update_item(item_id):
    data = request.json
    conn = get_db()

    if "completed" in data and "subtask_index" not in data:
        conn.execute(
            "UPDATE items SET completed = ? WHERE id = ?",
            (int(data["completed"]), item_id),
        )

    if "subtask_index" in data:
        conn.execute(
            "INSERT OR REPLACE INTO subtask_status (item_id, subtask_index, completed) VALUES (?, ?, ?)",
            (item_id, data["subtask_index"], int(data["completed"])),
        )

    conn.commit()
    conn.close()
    return jsonify({"success": True})


@app.route("/api/items/<int:item_id>", methods=["DELETE"])
def delete_item(item_id):
    conn = get_db()
    conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
    conn.execute("DELETE FROM subtask_status WHERE item_id = ?", (item_id,))
    conn.commit()
    conn.close()
    return jsonify({"success": True})


if __name__ == "__main__":
    init_db()
    app.run(debug=True, port=5000)
