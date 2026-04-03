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
  french:     { placeholder: "Balance tes idées ici… l'IA les réécrit et classe automatiquement. (Entrée pour analyser)", analyse: "Analyser", analysing: "Analyse…", confirm: "✓ Confirmer", discard: "Ignorer", preview: "Aperçu", chars: "car.", all: "Tout", todo: "To-do", ideas: "Idées", calls: "Calls", notes: "Notes", done: "Fait", empty: "Aucune entrée.", emptySub: "Tape quelque chose ci-dessus et analyse !", inCat: " dans cette catégorie", entry: "entrée", entries: "entrées", calendar: "Calendrier", categories: "Catégories", noDateItems: "Aucun élément avec une date.", addCat: "Ajouter une catégorie…", personal: "Personnel", newGroup: "+ Nouveau groupe", joinCode: "🔑 Rejoindre avec un code", createGroup: "Créer", join: "Rejoindre", codePlaceholder: "Code (ex: XK7P2M)…", groupName: "Nom du groupe…", deleteGroupConfirm: "Supprimer ce groupe ? Les items resteront accessibles en perso.", dueDate: "📅 Échéance (optionnel)", tagLabel: "🏷 Catégorie", tagPlaceholder: "Ajouter… (Entrée)", noCats: "Aucune catégorie personnalisée.", list: "Liste", help: "Aide", today: "Aujourd'hui", overdue: "En retard" },
  english:    { placeholder: "Dump your thoughts here… the AI will rewrite and organise them for you. (Enter to analyse)", analyse: "Analyse", analysing: "Analysing…", confirm: "✓ Confirm", discard: "Dismiss", preview: "Preview", chars: "chars", all: "All", todo: "To-do", ideas: "Ideas", calls: "Calls", notes: "Notes", done: "Done", empty: "No entries.", emptySub: "Type something above and analyse!", inCat: " in this category", entry: "entry", entries: "entries", calendar: "Calendar", categories: "Categories", noDateItems: "No items with a date.", addCat: "Add a category…", personal: "Personal", newGroup: "+ New group", joinCode: "🔑 Join with a code", createGroup: "Create", join: "Join", codePlaceholder: "Code (e.g. XK7P2M)…", groupName: "Group name…", deleteGroupConfirm: "Delete this group? Items will remain in personal space.", dueDate: "📅 Due date (optional)", tagLabel: "🏷 Category", tagPlaceholder: "Add… (Enter)", noCats: "No custom categories.", list: "List", help: "Help", today: "Today", overdue: "Overdue" },
  spanish:    { placeholder: "Suelta tus ideas aquí… la IA las reescribirá y organizará. (Enter para analizar)", analyse: "Analizar", analysing: "Analizando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Vista previa", chars: "car.", all: "Todo", todo: "Tarea", ideas: "Ideas", calls: "Llamadas", notes: "Notas", done: "Hecho", empty: "Sin entradas.", emptySub: "¡Escribe algo arriba y analiza!", inCat: " en esta categoría", entry: "entrada", entries: "entradas", calendar: "Calendario", categories: "Categorías", noDateItems: "Sin elementos con fecha.", addCat: "Añadir categoría…", personal: "Personal", newGroup: "+ Nuevo grupo", joinCode: "🔑 Unirse con código", createGroup: "Crear", join: "Unirse", codePlaceholder: "Código (ej: XK7P2M)…", groupName: "Nombre del grupo…", deleteGroupConfirm: "¿Eliminar este grupo?", dueDate: "📅 Fecha límite (opcional)", tagLabel: "🏷 Categoría", tagPlaceholder: "Añadir… (Enter)", noCats: "Sin categorías personalizadas.", list: "Lista", help: "Ayuda", today: "Hoy", overdue: "Retrasado" },
  italian:    { placeholder: "Svuota la testa qui… l'IA riscriverà e organizzerà tutto. (Invio per analizzare)", analyse: "Analizza", analysing: "Analisi…", confirm: "✓ Conferma", discard: "Ignora", preview: "Anteprima", chars: "car.", all: "Tutto", todo: "To-do", ideas: "Idee", calls: "Chiamate", notes: "Note", done: "Fatto", empty: "Nessuna voce.", emptySub: "Scrivi qualcosa sopra e analizza!", inCat: " in questa categoria", entry: "voce", entries: "voci", calendar: "Calendario", categories: "Categorie", noDateItems: "Nessun elemento con data.", addCat: "Aggiungi categoria…", personal: "Personale", newGroup: "+ Nuovo gruppo", joinCode: "🔑 Unisciti con codice", createGroup: "Crea", join: "Unisciti", codePlaceholder: "Codice (es: XK7P2M)…", groupName: "Nome del gruppo…", deleteGroupConfirm: "Eliminare questo gruppo?", dueDate: "📅 Scadenza (opzionale)", tagLabel: "🏷 Categoria", tagPlaceholder: "Aggiungi… (Invio)", noCats: "Nessuna categoria personalizzata.", list: "Lista", help: "Aiuto", today: "Oggi", overdue: "In ritardo" },
  portuguese: { placeholder: "Despeje suas ideias aqui… a IA vai reescrever e organizar tudo. (Enter para analisar)", analyse: "Analisar", analysing: "Analisando…", confirm: "✓ Confirmar", discard: "Ignorar", preview: "Pré-visualização", chars: "car.", all: "Tudo", todo: "Tarefa", ideas: "Ideias", calls: "Chamadas", notes: "Notas", done: "Feito", empty: "Sem entradas.", emptySub: "Digite algo acima e analise!", inCat: " nesta categoria", entry: "entrada", entries: "entradas", calendar: "Calendário", categories: "Categorias", noDateItems: "Sem itens com data.", addCat: "Adicionar categoria…", personal: "Pessoal", newGroup: "+ Novo grupo", joinCode: "🔑 Entrar com código", createGroup: "Criar", join: "Entrar", codePlaceholder: "Código (ex: XK7P2M)…", groupName: "Nome do grupo…", deleteGroupConfirm: "Excluir este grupo?", dueDate: "📅 Prazo (opcional)", tagLabel: "🏷 Categoria", tagPlaceholder: "Adicionar… (Enter)", noCats: "Sem categorias personalizadas.", list: "Lista", help: "Ajuda", today: "Hoje", overdue: "Atrasado" },
  chinese:    { placeholder: "在此清空思绪… AI将自动改写并分类。（按Enter分析）", analyse: "分析", analysing: "分析中…", confirm: "✓ 确认", discard: "忽略", preview: "预览", chars: "字", all: "全部", todo: "待办", ideas: "想法", calls: "通话", notes: "笔记", done: "完成", empty: "暂无内容。", emptySub: "在上方输入内容并分析！", inCat: "（此类别）", entry: "条", entries: "条", calendar: "日历", categories: "分类", noDateItems: "没有带日期的项目。", addCat: "添加分类…", personal: "个人", newGroup: "+ 新建群组", joinCode: "🔑 用代码加入", createGroup: "创建", join: "加入", codePlaceholder: "代码（如：XK7P2M）…", groupName: "群组名称…", deleteGroupConfirm: "删除此群组？", dueDate: "📅 截止日期（可选）", tagLabel: "🏷 分类", tagPlaceholder: "添加…（回车）", noCats: "暂无自定义分类。", list: "列表", help: "帮助", today: "今天", overdue: "已逾期" },
  russian:    { placeholder: "Выгрузи мысли сюда… ИИ перепишет и упорядочит всё автоматически. (Enter для анализа)", analyse: "Анализ", analysing: "Анализ…", confirm: "✓ Сохранить", discard: "Отмена", preview: "Просмотр", chars: "симв.", all: "Все", todo: "Задача", ideas: "Идеи", calls: "Звонки", notes: "Заметки", done: "Готово", empty: "Нет записей.", emptySub: "Введите что-нибудь выше и нажмите анализ!", inCat: " в этой категории", entry: "запись", entries: "записей", calendar: "Календарь", categories: "Категории", noDateItems: "Нет элементов с датой.", addCat: "Добавить категорию…", personal: "Личное", newGroup: "+ Новая группа", joinCode: "🔑 Войти по коду", createGroup: "Создать", join: "Войти", codePlaceholder: "Код (напр.: XK7P2M)…", groupName: "Название группы…", deleteGroupConfirm: "Удалить эту группу?", dueDate: "📅 Срок (необязательно)", tagLabel: "🏷 Категория", tagPlaceholder: "Добавить… (Enter)", noCats: "Нет пользовательских категорий.", list: "Список", help: "Помощь", today: "Сегодня", overdue: "Просрочено" },
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

const TAG_COLORS = [
  "#3b82f6","#8b5cf6","#ec4899","#f97316","#10b981",
  "#06b6d4","#f59e0b","#6366f1","#84cc16","#ef4444",
];
function tagColor(tag) {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) & 0xffff;
  return TAG_COLORS[h % TAG_COLORS.length];
}

function TagChip({ tag, onRemove }) {
  const color = tagColor(tag);
  return (
    <span className="tag-chip" style={{ background: color + "22", color, border: `1px solid ${color}55` }}>
      {tag}
      {onRemove && <button className="tag-remove" onClick={onRemove}>×</button>}
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

function ItemCard({ item, onToggle, onToggleSubtask, onDelete, onToggleUrgent }) {
  const due = formatDueDate(item.due_date);
  const calUrl = calendarUrl(item);
  return (
    <div className={`item-card${item.completed ? " completed" : ""}${item.urgent ? " urgent-card" : ""}`}>
      <div className="item-card-header">
        <input
          type="checkbox"
          className="item-checkbox"
          checked={item.completed}
          onChange={() => onToggle(item.id, item.completed)}
        />
        <div className="item-card-body">
          <div className="item-title">
            {item.urgent && <span className="badge-urgent">URGENT</span>}
            {item.title}
          </div>
          <div className="item-meta">
            <Badge type={item.type} />
            <span className="item-date">{formatDate(item.created_at)}</span>
            {due && (
              <span className={`item-due${due.urgent ? " urgent" : ""}`}>
                📅 {due.label}
              </span>
            )}
          </div>
          {item.tags && item.tags.length > 0 && (
            <div className="item-tags">
              {item.tags.map(tag => <TagChip key={tag} tag={tag} />)}
            </div>
          )}
        </div>
        <div className="item-actions">
          <button
            className={`btn-urgent${item.urgent ? " on" : ""}`}
            onClick={() => onToggleUrgent(item.id, item.urgent)}
            title={item.urgent ? "Retirer urgent" : "Marquer urgent"}
          >🔴</button>
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

const FAQ_ITEMS = [
  {
    q: "Comment télécharger Drople sur iPhone ?",
    a: "Ouvre dropleapp.com dans Safari → appuie sur le bouton Partager (📤) → «Ajouter à l'écran d'accueil» → Ajouter. Drople s'installe comme une vraie appli.",
  },
  {
    q: "How to install on Android?",
    a: "Open dropleapp.com in Chrome → tap the ⋮ menu → 'Add to Home screen' or 'Install app'. Drople installs like a native app.",
  },
  {
    q: "Comment ça marche ?",
    a: "Tu tapes (ou dictes) n'importe quoi — idée brouillon, tâche, note de réunion. L'IA analyse, reformule, et classe automatiquement en To-do, Idée, Call ou Note.",
  },
  {
    q: "À quoi servent les catégories ?",
    a: "Ce sont tes étiquettes personnelles (ex: «Perso», «Travail», «Santé»). Une fois créées, l'IA les assigne automatiquement à chaque nouvelle note selon le contenu.",
  },
  {
    q: "Comment inviter quelqu'un dans un groupe ?",
    a: "Crée un groupe via le menu en haut → clique 🔗 à côté du groupe → partage le code à 6 lettres ou le lien. Ton collègue entre le code dans «Rejoindre avec un code».",
  },
  {
    q: "Mes données sont-elles sécurisées ?",
    a: "Oui. Chaque compte est lié à ton Google ID. Seul toi (et les membres de tes groupes partagés) pouvez voir tes notes.",
  },
  {
    q: "Comment fonctionnent les rappels ?",
    a: "Active les notifications au premier lancement. Drople t'envoie un rappel chaque matin à 9h pour tes tâches du jour, en retard, ou restées sans suite depuis 5 jours.",
  },
  {
    q: "Puis-je changer la langue ?",
    a: "Oui, clique sur le sélecteur de langue en haut à droite. L'IA reformulera ensuite tes notes dans la langue choisie.",
  },
];

function FaqItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="faq-item">
      <button className="faq-question" onClick={() => setOpen(o => !o)}>
        <span>{q}</span>
        <span className="faq-arrow">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="faq-answer">{a}</div>}
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
  const [previewTags, setPreviewTags] = useState({});
  const [tagInputs, setTagInputs] = useState({});
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
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceId, setWorkspaceId] = useState(null); // null = personal
  const [wsOpen, setWsOpen] = useState(false);
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [inviteInfo, setInviteInfo] = useState(null); // { link, short_code }
  const [inviteCopied, setInviteCopied] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [showCatManager, setShowCatManager] = useState(false);
  const [userCategories, setUserCategories] = useState(() => {
    try { return JSON.parse(localStorage.getItem("drople-cats") || "[]"); } catch { return []; }
  });
  const [newCatInput, setNewCatInput] = useState("");
  const [activeView, setActiveView] = useState("list"); // "list" | "calendar"
  const [calMonth, setCalMonth] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const [calSelectedDay, setCalSelectedDay] = useState(null);
  const [showFAQ, setShowFAQ] = useState(() => !localStorage.getItem("drople-faq-seen"));
  const wsRef = useRef(null);
  const pendingJoinToken = useRef(
    new URLSearchParams(window.location.search).get("join")
  );

  const fetchWorkspaces = useCallback(async (accessToken) => {
    const t = accessToken || token;
    if (!t) return;
    try {
      const res = await fetch("/api/workspaces", {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (res.ok) setWorkspaces(await res.json());
    } catch {}
  }, [token]);

  const createWorkspace = async () => {
    if (!newWsName.trim()) return;
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: newWsName.trim() }),
    });
    if (res.ok) {
      const ws = await res.json();
      setWorkspaces(prev => [ws, ...prev]);
      setWorkspaceId(ws.id);
      setNewWsName("");
      setShowCreateWs(false);
      setWsOpen(false);
    }
  };

  const generateInvite = async (wsId) => {
    const res = await fetch(`/api/workspaces/${wsId}/invite`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const { token: invToken, short_code } = await res.json();
      setInviteInfo({ link: `${window.location.origin}?join=${invToken}`, short_code });
      setInviteCopied(false);
    }
  };

  const copyInviteCode = () => {
    if (!inviteInfo) return;
    navigator.clipboard.writeText(inviteInfo.short_code);
    setInviteCopied("code");
    setTimeout(() => setInviteCopied(false), 2500);
  };

  const copyInviteLink = () => {
    if (!inviteInfo) return;
    navigator.clipboard.writeText(inviteInfo.link);
    setInviteCopied("link");
    setTimeout(() => setInviteCopied(false), 2500);
  };

  const joinByCode = async () => {
    const code = joinCode.trim().toUpperCase();
    if (!code) return;
    setJoinError("");
    const res = await fetch("/api/workspaces/join-by-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      const ws = await res.json();
      setWorkspaces(prev => [...prev, ws]);
      setWorkspaceId(ws.id);
      setJoinCode("");
      setShowJoin(false);
      setWsOpen(false);
      setItems([]);
    } else {
      const err = await res.json().catch(() => ({}));
      setJoinError(err.error || "Code invalide");
    }
  };

  const leaveWorkspace = async (wsId) => {
    await fetch(`/api/workspaces/${wsId}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    setWorkspaces(prev => prev.filter(w => w.id !== wsId));
    if (workspaceId === wsId) { setWorkspaceId(null); setItems([]); }
  };

  const deleteWorkspace = async (wsId) => {
    if (!window.confirm(t.deleteGroupConfirm || "Supprimer ce groupe ?")) return;
    await fetch(`/api/workspaces/${wsId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    setWorkspaces(prev => prev.filter(w => w.id !== wsId));
    if (workspaceId === wsId) { setWorkspaceId(null); setItems([]); }
  };

  const saveCategories = (cats) => {
    setUserCategories(cats);
    localStorage.setItem("drople-cats", JSON.stringify(cats));
  };

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
      fetchWorkspaces(t);
      // Handle pending join token from URL
      if (pendingJoinToken.current) {
        try {
          const jr = await fetch(`/api/workspaces/join/${pendingJoinToken.current}`, {
            method: "POST",
            headers: { Authorization: `Bearer ${t}` },
          });
          if (jr.ok) {
            const ws = await jr.json();
            setWorkspaces(prev => [...prev, ws]);
            setWorkspaceId(ws.id);
            window.history.replaceState({}, "", window.location.pathname);
          }
        } catch {}
        pendingJoinToken.current = null;
      }
    },
  });

  const logout = () => {
    googleLogout();
    setToken(null);
    setUser(null);
    localStorage.removeItem("bd-token");
    localStorage.removeItem("bd-user");
    setItems([]);
    setWorkspaces([]);
    setWorkspaceId(null);
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
      if (wsRef.current && !wsRef.current.contains(e.target)) setWsOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const fetchItems = useCallback(async () => {
    if (!token) return;
    try {
      const url = workspaceId ? `/api/items?workspace_id=${workspaceId}` : `/api/items`;
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) { logout(); return; }
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch {}
  }, [token, workspaceId]);

  useEffect(() => {
    if (token) { fetchItems(); fetchWorkspaces(); }
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
        body: JSON.stringify({ text, language: getLangName(language), categories: userCategories }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        const items = Array.isArray(data) ? data : [data];
        setPreviews(items);
        // Pre-fill tags from AI response
        const initialTags = {};
        items.forEach((item, idx) => {
          if (item.tags && item.tags.length > 0) initialTags[idx] = item.tags;
        });
        if (Object.keys(initialTags).length > 0) setPreviewTags(initialTags);
      }
    } catch {
      setError("Impossible de contacter le backend.");
    } finally {
      setLoading(false);
    }
  };

  const confirmPreviews = async () => {
    if (!previews.length) return;
    try {
      const results = await Promise.all(previews.map((p, idx) =>
        fetch("/api/items", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ ...p, due_date: previewDates[idx] || null, workspace_id: workspaceId, tags: previewTags[idx] || [] }),
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
      setPreviewTags({});
      setTagInputs({});
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

  const toggleUrgent = (id, currentUrgent) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, urgent: !currentUrgent } : i));
    fetch(`/api/items/${id}`, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ urgent: !currentUrgent }),
    });
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
    { key: "urgent",    label: "🔴 Urgent" },
    { key: "todo",      label: t.todo },
    { key: "idea",      label: t.ideas },
    { key: "call_note", label: t.calls },
    { key: "note",      label: t.notes },
    { key: "done",      label: t.done || "Fait" },
  ];

  const activeItems = items.filter(i => !i.completed);
  const doneItems = items.filter(i => i.completed);
  const urgentItems = activeItems.filter(i => i.urgent);
  const allTags = [...new Set(items.flatMap(i => i.tags || []))].sort();

  const filteredItems = filter === "done"
    ? doneItems
    : filter === "urgent"
      ? urgentItems
      : filter === "all"
        ? activeItems
        : allTags.includes(filter)
          ? activeItems.filter(i => (i.tags || []).includes(filter))
          : activeItems.filter(i => i.type === filter);

  const currentWs = workspaces.find(w => w.id === workspaceId) || null;

  // Calendar view: all items with a due_date, sorted chronologically
  const calendarItems = [...items]
    .filter(i => i.due_date)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  // Group by date for calendar view
  const calendarGroups = calendarItems.reduce((acc, item) => {
    const key = item.due_date;
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

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

        {/* Workspace switcher */}
        <div className="ws-switcher" ref={wsRef}>
          <button className="ws-btn" onClick={() => { setWsOpen(o => !o); setShowJoin(false); setShowCreateWs(false); }}>
            {currentWs ? `👥 ${currentWs.name}` : `👤 ${t.personal}`}
            <span className="ws-chevron">▾</span>
          </button>
          {wsOpen && (
            <div className="ws-menu">
              <div className={`ws-option${!workspaceId ? " active" : ""}`}
                onClick={() => { setWorkspaceId(null); setWsOpen(false); setItems([]); }}>
                👤 {t.personal}
              </div>
              {workspaces.map(ws => (
                <div key={ws.id} className={`ws-option${workspaceId === ws.id ? " active" : ""}`}
                  onClick={() => { setWorkspaceId(ws.id); setWsOpen(false); setItems([]); }}>
                  👥 {ws.name}
                  <div className="ws-actions" onClick={e => e.stopPropagation()}>
                    {ws.is_owner
                      ? <>
                          <button className="ws-action-btn" title="Inviter" onClick={() => { generateInvite(ws.id); setWsOpen(false); }}>🔗</button>
                          <button className="ws-action-btn" title="Supprimer le groupe" onClick={() => deleteWorkspace(ws.id)}>🗑</button>
                        </>
                      : <button className="ws-action-btn" title="Quitter le groupe" onClick={() => leaveWorkspace(ws.id)}>🚪</button>
                    }
                  </div>
                </div>
              ))}
              <div className="ws-divider" />
              {showCreateWs ? (
                <div className="ws-create">
                  <input className="ws-name-input" placeholder={t.groupName} value={newWsName}
                    onChange={e => setNewWsName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") createWorkspace(); if (e.key === "Escape") setShowCreateWs(false); }}
                    autoFocus />
                  <button className="ws-create-btn" onClick={createWorkspace}>{t.createGroup}</button>
                </div>
              ) : showJoin ? (
                <div className="ws-create">
                  <input className="ws-name-input" placeholder={t.codePlaceholder}
                    value={joinCode} onChange={e => { setJoinCode(e.target.value.toUpperCase()); setJoinError(""); }}
                    onKeyDown={e => { if (e.key === "Enter") joinByCode(); if (e.key === "Escape") setShowJoin(false); }}
                    maxLength={6} autoFocus />
                  <button className="ws-create-btn" onClick={joinByCode}>{t.join}</button>
                  {joinError && <span className="ws-join-error">{joinError}</span>}
                </div>
              ) : (
                <>
                  <div className="ws-option ws-new" onClick={() => { setShowCreateWs(true); setShowJoin(false); }}>{t.newGroup}</div>
                  <div className="ws-option ws-new" onClick={() => { setShowJoin(true); setShowCreateWs(false); }}>{t.joinCode}</div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Invite info banner */}
        {inviteInfo && (
          <div className="invite-banner">
            <div className="invite-banner-code">
              <span className="invite-code-label">Code :</span>
              <span className="invite-code-value">{inviteInfo.short_code}</span>
              <button className="invite-copy-btn" onClick={copyInviteCode}>
                {inviteCopied === "code" ? "✓" : "Copier"}
              </button>
            </div>
            <div className="invite-banner-link">
              <span className="invite-banner-label">ou le lien :</span>
              <button className="invite-copy-btn" onClick={copyInviteLink}>
                {inviteCopied === "link" ? "✓ Copié !" : "Copier le lien"}
              </button>
            </div>
            <button className="invite-close-btn" onClick={() => setInviteInfo(null)}>×</button>
          </div>
        )}

        <button className="btn-faq" onClick={() => setShowFAQ(true)} title={t.help || "Aide / FAQ"}>?</button>

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
                <label className="preview-due-label">{t.dueDate || "📅 Échéance (optionnel)"}</label>
                <input
                  type="date"
                  className="preview-date-input"
                  value={previewDates[idx] || ""}
                  min={new Date().toISOString().split("T")[0]}
                  onChange={e => setPreviewDates(d => ({ ...d, [idx]: e.target.value }))}
                />
              </div>
              <div className="preview-tags-row">
                <div className="preview-tags-chips">
                  {(previewTags[idx] || []).map(tag => (
                    <TagChip key={tag} tag={tag} onRemove={() =>
                      setPreviewTags(pt => ({ ...pt, [idx]: (pt[idx] || []).filter(t => t !== tag) }))
                    } />
                  ))}
                </div>
                <div className="tag-input-wrap">
                  <span className="preview-due-label">{t.tagLabel || "🏷 Catégorie"}</span>
                  <input
                    className="tag-input"
                    placeholder={t.tagPlaceholder || "Ajouter… (Entrée)"}
                    value={tagInputs[idx] || ""}
                    onChange={e => setTagInputs(ti => ({ ...ti, [idx]: e.target.value }))}
                    onKeyDown={e => {
                      if ((e.key === "Enter" || e.key === ",") && (tagInputs[idx] || "").trim()) {
                        e.preventDefault();
                        const tag = tagInputs[idx].trim().replace(/,/g, "");
                        if (tag && !(previewTags[idx] || []).includes(tag)) {
                          setPreviewTags(pt => ({ ...pt, [idx]: [...(pt[idx] || []), tag] }));
                        }
                        setTagInputs(ti => ({ ...ti, [idx]: "" }));
                      }
                    }}
                  />
                  {/* Suggest existing tags */}
                  {tagInputs[idx] && (() => {
                    const allTags = [...new Set(items.flatMap(i => i.tags || []))];
                    const suggestions = allTags.filter(t =>
                      t.toLowerCase().includes((tagInputs[idx] || "").toLowerCase()) &&
                      !(previewTags[idx] || []).includes(t)
                    );
                    return suggestions.length > 0 ? (
                      <div className="tag-suggestions">
                        {suggestions.map(t => (
                          <span key={t} className="tag-suggestion" onClick={() => {
                            setPreviewTags(pt => ({ ...pt, [idx]: [...(pt[idx] || []), t] }));
                            setTagInputs(ti => ({ ...ti, [idx]: "" }));
                          }}>{t}</span>
                        ))}
                      </div>
                    ) : null;
                  })()}
                </div>
              </div>
            </div>
          ))}
          <div className="preview-actions">
            <button className="btn-confirm" onClick={confirmPreviews}>
              {t.confirm}
            </button>
            <button className="btn-discard" onClick={() => setPreviews([])}>
              {t.discard}
            </button>
          </div>
        </div>
      )}

      {/* View tabs: List / Calendar */}
      <div className="view-tabs">
        <button
          className={`view-tab${activeView === "list" ? " active" : ""}`}
          onClick={() => setActiveView("list")}
        >📋 {t.list || "Liste"}</button>
        <button
          className={`view-tab${activeView === "calendar" ? " active" : ""}`}
          onClick={() => setActiveView("calendar")}
        >📅 {t.calendar || "Calendrier"}</button>
        <button
          className="view-tab view-tab-cats"
          onClick={() => setShowCatManager(true)}
          title={t.categories || "Catégories"}
        >🏷 {t.categories || "Catégories"}</button>
      </div>

      {/* Categories Manager Modal */}
      {showCatManager && (
        <div className="modal-overlay" onClick={() => setShowCatManager(false)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>🏷 {t.categories || "Catégories"}</span>
              <button className="modal-close" onClick={() => setShowCatManager(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="cat-chips">
                {userCategories.length === 0 && (
                  <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t.noCats || "Aucune catégorie personnalisée."}</span>
                )}
                {userCategories.map(cat => (
                  <TagChip key={cat} tag={cat} onRemove={() => saveCategories(userCategories.filter(c => c !== cat))} />
                ))}
              </div>
              <div className="cat-add-row">
                <input
                  className="cat-add-input"
                  placeholder={t.addCat || "Ajouter une catégorie…"}
                  value={newCatInput}
                  onChange={e => setNewCatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && newCatInput.trim()) {
                      const c = newCatInput.trim();
                      if (!userCategories.includes(c)) saveCategories([...userCategories, c]);
                      setNewCatInput("");
                    }
                  }}
                />
                <button className="cat-add-btn" onClick={() => {
                  const c = newCatInput.trim();
                  if (c && !userCategories.includes(c)) saveCategories([...userCategories, c]);
                  setNewCatInput("");
                }}>+</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* FAQ Modal */}
      {showFAQ && (
        <div className="modal-overlay" onClick={() => { setShowFAQ(false); localStorage.setItem("drople-faq-seen", "1"); }}>
          <div className="modal-card faq-card" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <span>❓ FAQ &amp; Aide</span>
              <button className="modal-close" onClick={() => { setShowFAQ(false); localStorage.setItem("drople-faq-seen", "1"); }}>×</button>
            </div>
            <div className="faq-install-banner">
              <div className="faq-install-item">
                <span className="faq-install-icon">🍎</span>
                <div>
                  <strong>iPhone</strong> — Safari → <span className="faq-key">📤 Partager</span> → <span className="faq-key">Ajouter à l'écran d'accueil</span>
                </div>
              </div>
              <div className="faq-install-item">
                <span className="faq-install-icon">🤖</span>
                <div>
                  <strong>Android</strong> — Chrome → <span className="faq-key">⋮</span> → <span className="faq-key">Ajouter à l'écran d'accueil</span> ou <span className="faq-key">Installer l'application</span>
                </div>
              </div>
            </div>
            <div className="faq-list">
              {FAQ_ITEMS.map((item, i) => (
                <FaqItem key={i} q={item.q} a={item.a} />
              ))}
            </div>
            <div className="faq-footer">
              <button className="faq-dismiss-btn" onClick={() => { setShowFAQ(false); localStorage.setItem("drople-faq-seen", "1"); }}>
                Compris, fermer ✓
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Calendar view — monthly grid */}
      {activeView === "calendar" && (() => {
        const today = new Date(); today.setHours(0,0,0,0);
        const { year, month } = calMonth;
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        // Start grid on Monday
        const startDow = (firstDay.getDay() + 6) % 7; // 0=Mon
        const totalCells = Math.ceil((startDow + lastDay.getDate()) / 7) * 7;
        const cells = Array.from({ length: totalCells }, (_, i) => {
          const dayNum = i - startDow + 1;
          return dayNum >= 1 && dayNum <= lastDay.getDate() ? dayNum : null;
        });
        const dayLabels = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];
        const monthName = firstDay.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
        const selectedDayItems = calSelectedDay
          ? (calendarGroups[`${year}-${String(month+1).padStart(2,"0")}-${String(calSelectedDay).padStart(2,"0")}`] || [])
          : [];
        return (
          <div className="calendar-view">
            <div className="cal-nav">
              <button className="cal-nav-btn" onClick={() => {
                const d = new Date(year, month - 1, 1);
                setCalMonth({ year: d.getFullYear(), month: d.getMonth() });
                setCalSelectedDay(null);
              }}>‹</button>
              <span className="cal-month-label">{monthName}</span>
              <button className="cal-nav-btn" onClick={() => {
                const d = new Date(year, month + 1, 1);
                setCalMonth({ year: d.getFullYear(), month: d.getMonth() });
                setCalSelectedDay(null);
              }}>›</button>
            </div>
            <div className="cal-grid">
              {dayLabels.map(d => <div key={d} className="cal-day-header">{d}</div>)}
              {cells.map((dayNum, i) => {
                if (!dayNum) return <div key={i} className="cal-cell empty" />;
                const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(dayNum).padStart(2,"0")}`;
                const dayItems = calendarGroups[dateStr] || [];
                const cellDate = new Date(year, month, dayNum);
                const isToday = cellDate.getTime() === today.getTime();
                const isPast = cellDate < today && dayItems.length > 0;
                const isSelected = calSelectedDay === dayNum;
                const hasUrgent = dayItems.some(i => i.urgent && !i.completed);
                const pendingCount = dayItems.filter(i => !i.completed).length;
                return (
                  <div
                    key={i}
                    className={`cal-cell${isToday ? " today" : ""}${isPast ? " past" : ""}${isSelected ? " selected" : ""}${dayItems.length > 0 ? " has-items" : ""}`}
                    onClick={() => dayItems.length > 0 ? setCalSelectedDay(isSelected ? null : dayNum) : null}
                  >
                    <span className="cal-day-num">{dayNum}</span>
                    {pendingCount > 0 && (
                      <span className={`cal-dot${hasUrgent ? " urgent" : isPast ? " past" : ""}`}>{pendingCount}</span>
                    )}
                    {dayItems.length > 0 && dayItems.every(i => i.completed) && (
                      <span className="cal-dot done">✓</span>
                    )}
                  </div>
                );
              })}
            </div>
            {calSelectedDay && selectedDayItems.length > 0 && (
              <div className="cal-day-panel">
                <div className="cal-date-header">
                  <span className="cal-date-label">
                    {new Date(year, month, calSelectedDay).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
                  </span>
                  <button className="modal-close" onClick={() => setCalSelectedDay(null)}>×</button>
                </div>
                <div className="cal-items">
                  {selectedDayItems.map(item => (
                    <div key={item.id} className={`cal-item${item.completed ? " completed" : ""}${item.urgent ? " urgent-card" : ""}`}>
                      <input type="checkbox" className="item-checkbox" checked={item.completed}
                        onChange={() => toggleItem(item.id, item.completed)} />
                      <div className="cal-item-body">
                        <div className="item-title">
                          {item.urgent && <span className="badge-urgent">URGENT</span>}
                          {item.title}
                        </div>
                        <div className="item-meta">
                          <Badge type={item.type} />
                          {item.tags && item.tags.length > 0 && item.tags.map(tag => <TagChip key={tag} tag={tag} />)}
                        </div>
                      </div>
                      <button className="btn-delete" onClick={() => deleteItem(item.id)}>×</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {calendarItems.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">📅</div>
                <div>{t.noDateItems || "Aucun élément avec une date."}</div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Filter bar + Items (list view) */}
      {activeView === "list" && <>
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
              {f.key === "urgent" && urgentItems.length > 0 && (
                <span style={{ marginLeft: 5, opacity: 0.75 }}>{urgentItems.length}</span>
              )}
              {f.key !== "all" && f.key !== "done" && f.key !== "urgent" && totalByType[f.key] > 0 && (
                <span style={{ marginLeft: 5, opacity: 0.75 }}>{totalByType[f.key]}</span>
              )}
            </button>
          ))}
          {allTags.map(tag => {
            const color = tagColor(tag);
            const count = activeItems.filter(i => (i.tags || []).includes(tag)).length;
            return (
              <button
                key={tag}
                className={`filter-btn tag-filter-btn${filter === tag ? " active" : ""}`}
                style={filter === tag ? { background: color + "33", color, borderColor: color } : { borderColor: color + "66", color }}
                onClick={() => setFilter(tag)}
              >
                🏷 {tag}
                {count > 0 && <span style={{ marginLeft: 5, opacity: 0.75 }}>{count}</span>}
              </button>
            );
          })}
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
                onToggleUrgent={toggleUrgent}
              />
            ))
          )}
        </div>
      </>}
    </div>
  );
}
