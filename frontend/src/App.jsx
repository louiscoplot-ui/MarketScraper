import { useState, useEffect, useCallback, useRef } from "react";

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

const T = {
  french:     { placeholder: "Vide ta tête ici… (Entrée pour analyser)", analyse: "Analyser", analysing: "Analyse…", confirm: "✓ Confirmer", discard: "Ignorer", preview: "Aperçu", chars: "car.", all: "Tout", todo: "To-do", ideas: "Idées", calls: "Calls", notes: "Notes", empty: "Aucune entrée.", emptySub: "Tape quelque chose ci-dessus et analyse !", inCat: " dans cette catégorie", entry: "entrée", entries: "entrées" },
  english:    { placeholder: "Dump your thoughts here… (Enter to analyse)", analyse: "Analyse", analysing: "Analysing…", confirm: "✓ Confirm", discard: "Dismiss", preview: "Preview", chars: "chars", all: "All", todo: "To-do", ideas: "Ideas", calls: "Calls", notes: "Notes", empty: "No entries.", emptySub: "Type something above and analyse!", inCat: " in this category", entry: "entry", entries: "entries" },
  spanish:    { placeholder: "Vacía tu cabeza aquí… (Enter para analizar)", analyse: "Analizar", analysing: "Analizando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Vista previa", chars: "car.", all: "Todo", todo: "Tarea", ideas: "Ideas", calls: "Llamadas", notes: "Notas", empty: "Sin entradas.", emptySub: "¡Escribe algo arriba y analiza!", inCat: " en esta categoría", entry: "entrada", entries: "entradas" },
  italian:    { placeholder: "Svuota la testa qui… (Invio per analizzare)", analyse: "Analizza", analysing: "Analisi…", confirm: "✓ Conferma", discard: "Ignora", preview: "Anteprima", chars: "car.", all: "Tutto", todo: "To-do", ideas: "Idee", calls: "Chiamate", notes: "Note", empty: "Nessuna voce.", emptySub: "Scrivi qualcosa sopra e analizza!", inCat: " in questa categoria", entry: "voce", entries: "voci" },
  portuguese: { placeholder: "Esvazie sua cabeça aqui… (Enter para analisar)", analyse: "Analisar", analysing: "Analisando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Pré-visualização", chars: "car.", all: "Tudo", todo: "Tarefa", ideas: "Ideias", calls: "Chamadas", notes: "Notas", empty: "Sem entradas.", emptySub: "Digite algo acima e analise!", inCat: " nesta categoria", entry: "entrada", entries: "entradas" },
  chinese:    { placeholder: "在此清空思绪…（按Enter分析）", analyse: "分析", analysing: "分析中…", confirm: "✓ 确认", discard: "忽略", preview: "预览", chars: "字", all: "全部", todo: "待办", ideas: "想法", calls: "通话", notes: "笔记", empty: "暂无内容。", emptySub: "在上方输入内容并分析！", inCat: "（此类别）", entry: "条", entries: "条" },
  russian:    { placeholder: "Выгрузи мысли сюда… (Enter для анализа)", analyse: "Анализ", analysing: "Анализ…", confirm: "✓ Сохранить", discard: "Отмена", preview: "Просмотр", chars: "симв.", all: "Все", todo: "Задача", ideas: "Идеи", calls: "Звонки", notes: "Заметки", empty: "Нет записей.", emptySub: "Введите что-нибудь выше и нажмите анализ!", inCat: " в этой категории", entry: "запись", entries: "записей" },
};

const LANGUAGES = [
  { code: "french",     label: "FR — Français" },
  { code: "english",    label: "EN — English" },
  { code: "spanish",    label: "ES — Español" },
  { code: "italian",    label: "IT — Italiano" },
  { code: "portuguese", label: "PT — Português" },
  { code: "chinese",    label: "ZH — 中文" },
  { code: "russian",    label: "RU — Русский" },
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

const THEMES = [
  { id: "dark",   label: "Dark",   color: "#30363d" },
  { id: "cream",  label: "Cream",  color: "#c8773a" },
  { id: "forest", label: "Forest", color: "#4ade80" },
  { id: "dusk",   label: "Dusk",   color: "#a78bfa" },
];

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState(() => localStorage.getItem("bd-lang") || "french");
  const [theme, setTheme] = useState(() => localStorage.getItem("bd-theme") || "dark");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("bd-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("bd-lang", language);
  }, [language]);

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      analyse();
    }
  };

  const toggleVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("La reconnaissance vocale n'est pas supportée par ce navigateur.");
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = language === "french" ? "fr-FR"
      : language === "english" ? "en-US"
      : language === "spanish" ? "es-ES"
      : language === "italian" ? "it-IT"
      : language === "portuguese" ? "pt-PT"
      : language === "chinese" ? "zh-CN"
      : language === "russian" ? "ru-RU"
      : "fr-FR";
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map((r) => r[0].transcript)
        .join(" ");
      setText((prev) => (prev ? prev + " " + transcript : transcript));
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
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
        body: JSON.stringify({ text, language }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPreview(data);
      }
    } catch {
      setError("Impossible de contacter le backend.");
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

  const t = T[language] || T.french;

  const FILTERS_T = [
    { key: "all",       label: t.all },
    { key: "todo",      label: t.todo },
    { key: "idea",      label: t.ideas },
    { key: "call_note", label: t.calls },
    { key: "note",      label: t.notes },
  ];

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
          <span className="header-count">{items.length} {items.length > 1 ? t.entries : t.entry}</span>
        )}
        <div className="theme-dots">
          {THEMES.map((th) => (
            <button
              key={th.id}
              className={`theme-dot${theme === th.id ? " active" : ""}`}
              style={{ background: th.color }}
              onClick={() => setTheme(th.id)}
              title={th.label}
            />
          ))}
        </div>
        <select
          className="lang-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </div>

      {/* Capture zone */}
      <div className="capture-card">
        <textarea
          className="capture-textarea"
          placeholder={t.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          autoFocus
        />
        <div className="capture-footer">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="char-count">{text.length} {t.chars}</span>
            <button
              className={`btn-mic${listening ? " active" : ""}`}
              onClick={toggleVoice}
              title={listening ? "Stop" : "Dictate"}
            >
              {listening ? "⏹" : "🎙"}
            </button>
          </div>
          <button
            className="btn-analyse"
            onClick={analyse}
            disabled={!text.trim() || loading}
          >
            {loading ? (
              <>
                <span className="spinner" />
                {t.analysing}
              </>
            ) : (
              <>✨ {t.analyse}</>
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
            <span className="preview-label">{t.preview}</span>
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
              {t.confirm}
            </button>
            <button className="btn-discard" onClick={() => setPreview(null)}>
              {t.discard}
            </button>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="filter-bar">
        {FILTERS_T.map((f) => (
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
            <div>{filter !== "all" ? t.empty.replace(".", "") + t.inCat + "." : t.empty}</div>
            <div style={{ marginTop: 6, opacity: 0.7 }}>{t.emptySub}</div>
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
