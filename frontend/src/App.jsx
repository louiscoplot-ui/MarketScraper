import { useState, useEffect, useCallback, useRef } from "react";
import { useGoogleLogin, googleLogout } from "@react-oauth/google";
import DropLogo from "./DropLogo";

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
  french:     { placeholder: "Vide ta tête ici… (Entrée pour analyser)", analyse: "Analyser", analysing: "Analyse…", confirm: "✓ Confirmer", discard: "Ignorer", preview: "Aperçu", chars: "car.", all: "Tout", todo: "To-do", ideas: "Idées", calls: "Calls", notes: "Notes", done: "Fait", empty: "Aucune entrée.", emptySub: "Tape quelque chose ci-dessus et analyse !", inCat: " dans cette catégorie", entry: "entrée", entries: "entrées" },
  english:    { placeholder: "Dump your thoughts here… (Enter to analyse)", analyse: "Analyse", analysing: "Analysing…", confirm: "✓ Confirm", discard: "Dismiss", preview: "Preview", chars: "chars", all: "All", todo: "To-do", ideas: "Ideas", calls: "Calls", notes: "Notes", done: "Done", empty: "No entries.", emptySub: "Type something above and analyse!", inCat: " in this category", entry: "entry", entries: "entries" },
  spanish:    { placeholder: "Vacía tu cabeza aquí… (Enter para analizar)", analyse: "Analizar", analysing: "Analizando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Vista previa", chars: "car.", all: "Todo", todo: "Tarea", ideas: "Ideas", calls: "Llamadas", notes: "Notas", done: "Hecho", empty: "Sin entradas.", emptySub: "¡Escribe algo arriba y analiza!", inCat: " en esta categoría", entry: "entrada", entries: "entradas" },
  italian:    { placeholder: "Svuota la testa qui… (Invio per analizzare)", analyse: "Analizza", analysing: "Analisi…", confirm: "✓ Conferma", discard: "Ignora", preview: "Anteprima", chars: "car.", all: "Tutto", todo: "To-do", ideas: "Idee", calls: "Chiamate", notes: "Note", done: "Fatto", empty: "Nessuna voce.", emptySub: "Scrivi qualcosa sopra e analizza!", inCat: " in questa categoria", entry: "voce", entries: "voci" },
  portuguese: { placeholder: "Esvazie sua cabeça aqui… (Enter para analisar)", analyse: "Analisar", analysing: "Analisando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Pré-visualização", chars: "car.", all: "Tudo", todo: "Tarefa", ideas: "Ideias", calls: "Chamadas", notes: "Notas", done: "Feito", empty: "Sem entradas.", emptySub: "Digite algo acima e analise!", inCat: " nesta categoria", entry: "entrada", entries: "entradas" },
  chinese:    { placeholder: "在此清空思绪…（按Enter分析）", analyse: "分析", analysing: "分析中…", confirm: "✓ 确认", discard: "忽略", preview: "预览", chars: "字", all: "全部", todo: "待办", ideas: "想法", calls: "通话", notes: "笔记", done: "完成", empty: "暂无内容。", emptySub: "在上方输入内容并分析！", inCat: "（此类别）", entry: "条", entries: "条" },
  russian:    { placeholder: "Выгрузи мысли сюда… (Enter для анализа)", analyse: "Анализ", analysing: "Анализ…", confirm: "✓ Сохранить", discard: "Отмена", preview: "Просмотр", chars: "симв.", all: "Все", todo: "Задача", ideas: "Идеи", calls: "Звонки", notes: "Заметки", done: "Готово", empty: "Нет записей.", emptySub: "Введите что-нибудь выше и нажмите анализ!", inCat: " в этой категории", entry: "запись", entries: "записей" },
};

const LANGUAGES = [
  { code: "french",      label: "FR — Français",           name: "French" },
  { code: "english",     label: "EN — English",            name: "English" },
  { code: "spanish",     label: "ES — Español",            name: "Spanish" },
  { code: "italian",     label: "IT — Italiano",           name: "Italian" },
  { code: "portuguese",  label: "PT — Português",          name: "Portuguese" },
  { code: "chinese",     label: "ZH — 中文",               name: "Chinese" },
  { code: "russian",     label: "RU — Русский",            name: "Russian" },
  { code: "german",      label: "DE — Deutsch",            name: "German" },
  { code: "dutch",       label: "NL — Nederlands",         name: "Dutch" },
  { code: "arabic",      label: "AR — العربية",             name: "Arabic" },
  { code: "japanese",    label: "JA — 日本語",              name: "Japanese" },
  { code: "korean",      label: "KO — 한국어",              name: "Korean" },
  { code: "hindi",       label: "HI — हिंदी",               name: "Hindi" },
  { code: "bengali",     label: "BN — বাংলা",              name: "Bengali" },
  { code: "turkish",     label: "TR — Türkçe",             name: "Turkish" },
  { code: "vietnamese",  label: "VI — Tiếng Việt",         name: "Vietnamese" },
  { code: "polish",      label: "PL — Polski",             name: "Polish" },
  { code: "ukrainian",   label: "UK — Українська",          name: "Ukrainian" },
  { code: "swedish",     label: "SV — Svenska",            name: "Swedish" },
  { code: "norwegian",   label: "NO — Norsk",              name: "Norwegian" },
  { code: "danish",      label: "DA — Dansk",              name: "Danish" },
  { code: "finnish",     label: "FI — Suomi",              name: "Finnish" },
  { code: "czech",       label: "CS — Čeština",            name: "Czech" },
  { code: "hungarian",   label: "HU — Magyar",             name: "Hungarian" },
  { code: "romanian",    label: "RO — Română",             name: "Romanian" },
  { code: "greek",       label: "EL — Ελληνικά",           name: "Greek" },
  { code: "hebrew",      label: "HE — עברית",              name: "Hebrew" },
  { code: "persian",     label: "FA — فارسی",              name: "Persian" },
  { code: "indonesian",  label: "ID — Bahasa Indonesia",   name: "Indonesian" },
  { code: "malay",       label: "MS — Bahasa Melayu",      name: "Malay" },
  { code: "thai",        label: "TH — ภาษาไทย",            name: "Thai" },
  { code: "tagalog",     label: "TL — Filipino",           name: "Filipino" },
  { code: "swahili",     label: "SW — Kiswahili",          name: "Swahili" },
  { code: "catalan",     label: "CA — Català",             name: "Catalan" },
  { code: "bulgarian",   label: "BG — Български",           name: "Bulgarian" },
  { code: "croatian",    label: "HR — Hrvatski",           name: "Croatian" },
  { code: "serbian",     label: "SR — Српски",              name: "Serbian" },
  { code: "slovak",      label: "SK — Slovenčina",         name: "Slovak" },
  { code: "slovenian",   label: "SL — Slovenščina",        name: "Slovenian" },
  { code: "latvian",     label: "LV — Latviešu",           name: "Latvian" },
  { code: "lithuanian",  label: "LT — Lietuvių",           name: "Lithuanian" },
  { code: "estonian",    label: "ET — Eesti",              name: "Estonian" },
  { code: "albanian",    label: "SQ — Shqip",              name: "Albanian" },
  { code: "georgian",    label: "KA — ქართული",            name: "Georgian" },
  { code: "armenian",    label: "HY — Հայերեն",            name: "Armenian" },
  { code: "icelandic",   label: "IS — Íslenska",           name: "Icelandic" },
  { code: "afrikaans",   label: "AF — Afrikaans",          name: "Afrikaans" },
  { code: "tamil",       label: "TA — தமிழ்",               name: "Tamil" },
  { code: "telugu",      label: "TE — తెలుగు",              name: "Telugu" },
  { code: "marathi",     label: "MR — मराठी",               name: "Marathi" },
  { code: "urdu",        label: "UR — اردو",               name: "Urdu" },
  { code: "nepali",      label: "NE — नेपाली",              name: "Nepali" },
  { code: "sinhala",     label: "SI — සිංහල",              name: "Sinhala" },
  { code: "burmese",     label: "MY — မြန်မာဘာသာ",         name: "Burmese" },
  { code: "khmer",       label: "KM — ភាសាខ្មែរ",          name: "Khmer" },
  { code: "mongolian",   label: "MN — Монгол",             name: "Mongolian" },
  { code: "amharic",     label: "AM — አማርኛ",              name: "Amharic" },
  { code: "yoruba",      label: "YO — Yorùbá",             name: "Yoruba" },
  { code: "hausa",       label: "HA — Hausa",              name: "Hausa" },
  { code: "zulu",        label: "ZU — isiZulu",            name: "Zulu" },
  { code: "welsh",       label: "CY — Cymraeg",            name: "Welsh" },
  { code: "irish",       label: "GA — Gaeilge",            name: "Irish" },
];

function getLangName(code) {
  const found = LANGUAGES.find(l => l.code === code);
  return found ? found.name : code;
}

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

function formatDueDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((d - today) / 86400000);
  if (diff < 0) return { label: `En retard (${d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })})`, urgent: true };
  if (diff === 0) return { label: "Aujourd'hui", urgent: true };
  if (diff === 1) return { label: "Demain", urgent: false };
  return { label: d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }), urgent: false };
}

function calendarUrl(item) {
  const title = encodeURIComponent(item.title);
  const details = encodeURIComponent(item.content || "");
  if (!item.due_date) return null;
  const d = item.due_date.replace(/-/g, "");
  const next = item.due_date.split("-").map(Number);
  next[2] += 1;
  const dEnd = next.map((n, i) => String(n).padStart(i === 0 ? 4 : 2, "0")).join("");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${d}/${dEnd}&details=${details}`;
}

function ItemCard({ item, onToggle, onToggleSubtask, onDelete }) {
  const due = formatDueDate(item.due_date);
  const calUrl = calendarUrl(item);
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
            {due && (
              <span className={`item-due${due.urgent ? " urgent" : ""}`}>
                📅 {due.label}
              </span>
            )}
          </div>
        </div>
        <div className="item-actions">
          {calUrl && (
            <a className="btn-calendar" href={calUrl} target="_blank" rel="noreferrer" title="Ajouter au calendrier">
              📅
            </a>
          )}
          <button className="btn-delete" onClick={() => onDelete(item.id)} title="Supprimer">×</button>
        </div>
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
                <input type="checkbox" className="subtask-checkbox" checked={done}
                  onChange={() => onToggleSubtask(item.id, i, done)} />
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
  { id: "dark",    label: "Dark",    color: "#30363d" },
  { id: "cream",   label: "Cream",   color: "#c8773a" },
  { id: "sage",    label: "Sage",    color: "#3a7d52" },
  { id: "ocean",   label: "Ocean",   color: "#1a6fa4" },
  { id: "fiesta",  label: "Fiesta",  color: "#ff2d78" },
];

const VAPID_PUBLIC_KEY = "BKEZ57KJVXJ0FM64niTIXaVv14kr4-hQsw2tEst0ujasRkKMXKLEi2Q_ovhhz4FxwhDZVh7dHt3CXODxG-4_0kw";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export default function App() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [previews, setPreviews] = useState([]);
  const [previewDates, setPreviewDates] = useState({});
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState(null);
  const [language, setLanguage] = useState(() => localStorage.getItem("bd-lang") || "french");
  const [theme, setTheme] = useState(() => localStorage.getItem("bd-theme") || "dark");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const [langOpen, setLangOpen] = useState(false);
  const [langSearch, setLangSearch] = useState("");
  const langRef = useRef(null);
  const [token, setToken] = useState(() => localStorage.getItem("bd-token") || null);
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem("bd-user") || "null"); } catch { return null; }
  });

  const subscribePush = async (accessToken) => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(sub.toJSON()),
      });
    } catch {}
  };

  const login = useGoogleLogin({
    onSuccess: async (res) => {
      const t = res.access_token;
      const profile = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${t}` },
      }).then((r) => r.json());
      setToken(t);
      setUser(profile);
      localStorage.setItem("bd-token", t);
      localStorage.setItem("bd-user", JSON.stringify(profile));
      subscribePush(t);
    },
  });

  const logout = () => {
    googleLogout();
    setToken(null);
    setUser(null);
    localStorage.removeItem("bd-token");
    localStorage.removeItem("bd-user");
    setItems([]);
  };

  const authHeaders = token
    ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
    : { "Content-Type": "application/json" };

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("bd-theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("bd-lang", language);
  }, [language]);

  useEffect(() => {
    const handleClick = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setLangOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const fetchItems = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/items`, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch {
      // ignore fetch errors for list
    }
  }, [token]);

  useEffect(() => {
    if (token) fetchItems();
  }, [fetchItems, token]);

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
    setPreviews([]);
    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ text, language: getLangName(language) }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setPreviews(Array.isArray(data) ? data : [data]);
      }
    } catch {
      setError("Impossible de contacter le backend.");
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    if (!previews.length) return;
    try {
      const results = await Promise.all(previews.map((p, idx) =>
        fetch("/api/items", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ ...p, due_date: previewDates[idx] || null }),
        })
      ));
      for (const r of results) {
        if (r.status === 401) { logout(); setError("Session expirée — reconnecte-toi."); return; }
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          setError(`Erreur sauvegarde: ${err.error || r.status}`);
          return;
        }
      }
      setPreviews([]);
      setPreviewDates({});
      setText("");
      fetchItems();
    } catch {
      setError("Erreur lors de la sauvegarde.");
    }
  };

  const toggleItem = (id, completed) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, completed: !completed } : i));
    fetch(`/api/items/${id}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ completed: !completed }),
    });
  };

  const toggleSubtask = (itemId, subtaskIndex, currentDone) => {
    setItems(prev => prev.map(i => i.id === itemId ? {
      ...i,
      subtask_status: { ...i.subtask_status, [subtaskIndex]: !currentDone }
    } : i));
    fetch(`/api/items/${itemId}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ subtask_index: subtaskIndex, completed: !currentDone }),
    });
  };

  const deleteItem = (id) => {
    setItems(prev => prev.filter(i => i.id !== id));
    fetch(`/api/items/${id}`, { method: "DELETE", headers: authHeaders });
  };

  const t = T[language] || T.french;

  if (!token) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <DropLogo size={72} />
          <h1 className="login-title">Drople</h1>
          <p className="login-sub">Capture tes idées, tâches et notes en quelques secondes.</p>
          <button className="btn-google" onClick={() => login()}>
            <svg width="18" height="18" viewBox="0 0 18 18"><path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/><path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.964 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.707V4.961H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.039l3.007-2.332z"/><path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.96l3.007 2.332C4.672 5.163 6.656 3.58 9 3.58z"/></svg>
            Continuer avec Google
          </button>
          <div className="theme-dots" style={{ justifyContent: "center", marginTop: 24 }}>
            {THEMES.map((th) => (
              <button key={th.id} className={`theme-dot${theme === th.id ? " active" : ""}`}
                style={{ background: th.color }} onClick={() => setTheme(th.id)} title={th.label} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  const FILTERS_T = [
    { key: "all",       label: t.all },
    { key: "todo",      label: t.todo },
    { key: "idea",      label: t.ideas },
    { key: "call_note", label: t.calls },
    { key: "note",      label: t.notes },
    { key: "done",      label: t.done || "Fait" },
  ];

  const activeItems = items.filter(i => !i.completed);
  const doneItems = items.filter(i => i.completed);

  const filteredItems = filter === "done"
    ? doneItems
    : filter === "all"
      ? activeItems
      : activeItems.filter(i => i.type === filter);

  const totalByType = FILTERS.slice(1).reduce((acc, f) => {
    acc[f.key] = activeItems.filter((i) => i.type === f.key).length;
    return acc;
  }, {});

  return (
    <div className="app">
      {/* Header */}
      <div className="header">
        <DropLogo size={28} />
        <h1>Drople</h1>
        {items.length > 0 && (
          <span className="header-count">{items.length} {items.length > 1 ? t.entries : t.entry}</span>
        )}
        <button className="btn-logout" onClick={logout} title="Se déconnecter">
          {user?.picture
            ? <img src={user.picture} alt="avatar" className="user-avatar" />
            : <span>⏻</span>}
        </button>
        <div className="theme-dots">
          {THEMES.map((th) => (
            <button key={th.id} className={`theme-dot${theme === th.id ? " active" : ""}`}
              style={{ background: th.color }} onClick={() => setTheme(th.id)} title={th.label} />
          ))}
        </div>
        <div className="lang-dropdown" ref={langRef}>
          <button className="lang-dropdown-btn" onClick={() => { setLangOpen(o => !o); setLangSearch(""); }}>
            {LANGUAGES.find(l => l.code === language)?.label || language}
          </button>
          {langOpen && (
            <div className="lang-dropdown-menu">
              <input
                className="lang-search"
                placeholder="Search…"
                value={langSearch}
                onChange={e => setLangSearch(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && langSearch.trim()) {
                    const match = LANGUAGES.find(l =>
                      l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
                      l.name.toLowerCase().includes(langSearch.toLowerCase())
                    );
                    if (match) { setLanguage(match.code); setLangOpen(false); setLangSearch(""); }
                  }
                  if (e.key === "Escape") setLangOpen(false);
                }}
                autoFocus
              />
              <div className="lang-options">
                {LANGUAGES
                  .filter(l => l.label.toLowerCase().includes(langSearch.toLowerCase()) || l.name.toLowerCase().includes(langSearch.toLowerCase()))
                  .map(l => (
                    <div key={l.code} className={`lang-option${language === l.code ? " active" : ""}`}
                      onClick={() => { setLanguage(l.code); setLangOpen(false); setLangSearch(""); }}>
                      {l.label}
                    </div>
                  ))
                }
              </div>
            </div>
          )}
        </div>
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
      {previews.length > 0 && (
        <div className="preview-card">
          <div className="preview-header">
            <span className="preview-label">{t.preview}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{previews.length} note{previews.length > 1 ? "s" : ""}</span>
          </div>
          {previews.map((preview, idx) => (
            <div key={idx} className="preview-body" style={idx > 0 ? { borderTop: "1px solid var(--border)" } : {}}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <Badge type={preview.type} />
              </div>
              <div className="preview-title">{preview.title}</div>
              <div className="preview-content">{preview.content}</div>
              {preview.subtasks && preview.subtasks.length > 0 && (
                <div className="preview-subtasks">
                  {preview.subtasks.map((st, i) => (
                    <div className="subtask-preview" key={i}>{st}</div>
                  ))}
                </div>
              )}
              <div className="preview-due">
                <label className="preview-due-label">📅 Échéance (optionnel)</label>
                <input
                  type="date"
                  className="preview-date-input"
                  value={previewDates[idx] || ""}
                  min={new Date().toISOString().split("T")[0]}
                  onChange={e => setPreviewDates(d => ({ ...d, [idx]: e.target.value }))}
                />
              </div>
            </div>
          ))}
          <div className="preview-actions">
            <button className="btn-confirm" onClick={confirm}>
              {t.confirm}
            </button>
            <button className="btn-discard" onClick={() => setPreviews([])}>
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
            {f.key === "done" && doneItems.length > 0 && (
              <span style={{ marginLeft: 5, opacity: 0.75 }}>{doneItems.length}</span>
            )}
            {f.key !== "all" && f.key !== "done" && totalByType[f.key] > 0 && (
              <span style={{ marginLeft: 5, opacity: 0.75 }}>{totalByType[f.key]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Items */}
      <div className="items-list">
        {filteredItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📭</div>
            <div>{filter !== "all" ? t.empty.replace(".", "") + t.inCat + "." : t.empty}</div>
            <div style={{ marginTop: 6, opacity: 0.7 }}>{t.emptySub}</div>
          </div>
        ) : (
          filteredItems.map((item) => (
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
