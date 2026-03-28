import { useState, useEffect, useCallback } from "react";

const TYPE_META = {
  todo:      { label: "To-do",    icon: "✓",  badgeClass: "badge-todo" },
  idea:      { label: "Idée",     icon: "💡", badgeClass: "badge-idea" },
  call_note: { label: "Call",     icon: "📞", badgeClass: "badge-call_note" },
  note:      { label: "Note",     icon: "📝", badgeClass: "badge-note" },
};

const FILTERS = [
  { key: "all",       label: "Tout" },
  { key: "todo",      label: "To-do" },
  { key: "idea",      label: "Idées" },
  { key: "call_note", label: "Calls" },
  { key: "note",      label: "Notes" },
];

function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  const diffH = Math.floor(diffMs / 3600000);
  const diffD = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "à l'instant";
  if (diffMin < 60) return `il y a ${diffMin} min`;
  if (diffH < 24) return `il y a ${diffH}h`;
  if (diffD < 7) return `il y a ${diffD}j`;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function Badge({ type }) {
  const meta = TYPE_META[type] || TYPE_META.note;
  return (
    <span className={`badge ${meta.badgeClass}`}>
      {meta.icon} {meta.label}
    </span>
  );
}

function ItemCard({ item, onToggle, onToggleSubtask, onDelete }) {
  return (
    <div className={`item-card${item.completed ? " completed" : ""}`}>
      <div className="item-card-header">
        <input
          type="checkbox"
          className="item-checkbox"
          checked={item.completed}
          onChange={() => onToggle(item.id, item.completed)}
        />
        <div className="item-card-body">
          <div className="item-title">{item.title}</div>
          <div className="item-meta">
            <Badge type={item.type} />
            <span className="item-date">{formatDate(item.created_at)}</span>
          </div>
        </div>
        <button
          className="btn-delete"
          onClick={() => onDelete(item.id)}
          title="Supprimer"
        >
          ×
        </button>
      </div>

      {item.content && (
        <div className="item-content">{item.content}</div>
      )}

      {item.subtasks && item.subtasks.length > 0 && (
        <div className="item-subtasks">
          {item.subtasks.map((st, i) => {
            const done = item.subtask_status?.[String(i)] || false;
            return (
              <div className="subtask-row" key={i}>
                <input
                  type="checkbox"
                  className="subtask-checkbox"
                  checked={done}
                  onChange={() => onToggleSubtask(item.id, i, done)}
                />
                <span className={`subtask-label${done ? " done" : ""}`}>{st}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(`/api/items?type=${filter}`);
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch {
      // ignore fetch errors for list
    }
  }, [filter]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      analyse();
    }
  };

  const analyse = async () => {
    if (!text.trim() || loading) return;
    setLoading(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPreview(data);
      }
    } catch {
      setError("Impossible de contacter le backend. Vérifiez qu'il tourne sur le port 5000.");
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    if (!preview) return;
    try {
      await fetch("/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preview),
      });
      setPreview(null);
      setText("");
      fetchItems();
    } catch {
      setError("Erreur lors de la sauvegarde.");
    }
  };

  const toggleItem = async (id, completed) => {
    await fetch(`/api/items/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !completed }),
    });
    fetchItems();
  };

  const toggleSubtask = async (itemId, subtaskIndex, currentDone) => {
    await fetch(`/api/items/${itemId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtask_index: subtaskIndex, completed: !currentDone }),
    });
    fetchItems();
  };

  const deleteItem = async (id) => {
    await fetch(`/api/items/${id}`, { method: "DELETE" });
    fetchItems();
  };

  const totalByType = FILTERS.slice(1).reduce((acc, f) => {
    acc[f.key] = items.filter((i) => i.type === f.key).length;
    return acc;
  }, {});

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <span style={{ fontSize: 28 }}>🧠</span>
        <h1>Braindump</h1>
        {items.length > 0 && (
          <span className="header-count">{items.length} entrée{items.length > 1 ? "s" : ""}</span>
        )}
      </div>

      {/* Capture zone */}
      <div className="capture-card">
        <textarea
          className="capture-textarea"
          placeholder="Vide ta tête ici... (Ctrl+Entrée pour analyser)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <div className="capture-footer">
          <span className="char-count">{text.length} caractères</span>
          <button
            className="btn-analyse"
            onClick={analyse}
            disabled={!text.trim() || loading}
          >
            {loading ? (
              <>
                <span className="spinner" />
                Analyse en cours…
              </>
            ) : (
              <>✨ Analyser</>
            )}
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="error-banner">
          ⚠ {error}
        </div>
      )}

      {/* Preview */}
      {preview && (
        <div className="preview-card">
          <div className="preview-header">
            <span className="preview-label">Aperçu</span>
            <Badge type={preview.type} />
          </div>
          <div className="preview-body">
            <div className="preview-title">{preview.title}</div>
            <div className="preview-content">{preview.content}</div>
            {preview.subtasks && preview.subtasks.length > 0 && (
              <div className="preview-subtasks">
                {preview.subtasks.map((st, i) => (
                  <div className="subtask-preview" key={i}>{st}</div>
                ))}
              </div>
            )}
          </div>
          <div className="preview-actions">
            <button className="btn-confirm" onClick={confirm}>
              ✓ Confirmer
            </button>
            <button className="btn-discard" onClick={() => setPreview(null)}>
              Ignorer
            </button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-btn${filter === f.key ? ` active ${f.key}` : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            {f.key !== "all" && totalByType[f.key] > 0 && (
              <span style={{ marginLeft: 5, opacity: 0.75 }}>{totalByType[f.key]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Items */}
      <div className="items-list">
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <div>Aucune entrée{filter !== "all" ? " dans cette catégorie" : ""}.</div>
            <div style={{ marginTop: 6, opacity: 0.7 }}>
              Tape quelque chose ci-dessus et analyse !
            </div>
          </div>
        ) : (
          items.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              onToggle={toggleItem}
              onToggleSubtask={toggleSubtask}
              onDelete={deleteItem}
            />
          ))
        )}
      </div>
    </div>
  );
}
