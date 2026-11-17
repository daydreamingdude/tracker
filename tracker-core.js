/* Task Tracker core: data engine and rendering. v0.06 (2026-11-10): Frame layout (sidebar on the gradient, one window with the list and an inspector).
   The old concept pages (concept-1..3, dashboard.html) still load this file but are no longer kept in step; the frozen task tracker 0.0N.html files carry their own copy.
   Each page sets optional window.TRACKER_CONFIG, loads tracker-base.css + its own theme, then calls startup().

   Settings (window.TRACKER_CONFIG):
   ownFile: the data file this page reads and writes (in the folder you connect).
   readOnlySources: extra lists shown read-only, each in its own folder you connect once.
   Example for a future work tracker:
     { ownFile: "work_todo.json", listName: "Work",
       readOnlySources: [{ key: "personal", label: "Personal", file: "todo.json" }] }

   Items with kind "idea" live on the Ideas page and stay out of Tasks, the calendar and the counts.
*/
const CONFIG = Object.assign({ ownFile: "todo.json", listName: "Personal", version: "", readOnlySources: [] }, window.TRACKER_CONFIG || {});

const STATUSES = ["in progress", "open", "waiting", "on hold", "done"];
const STATUS_VAR = { "open": "--s-open", "in progress": "--s-progress", "waiting": "--s-waiting", "on hold": "--s-hold", "done": "--s-done" };
const PRIOS = ["high", "normal", "low"];
const POLL_MS = 4000;
const DOC_EXT = new Set(["md", "markdown", "txt", "py", "ps1", "psm1", "sh", "bash", "zsh", "r", "js", "ts", "json", "yml", "yaml", "toml", "ini", "conf", "cfg", "sql", "bat", "cmd", "html", "css", "xml", "csv", "env.example"]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git", ".venv", "venv", ".ipynb_checkpoints"]);
const MAX_VIEW_BYTES = 600000;
/* Repeat codes: number + d/w/m/y. Stored on the item as "repeat". */
const REPEATS = { "": "Doesn't repeat", "1d": "Daily", "1w": "Weekly", "2w": "Every 2 weeks", "1m": "Monthly", "3m": "Every 3 months", "6m": "Every 6 months", "1y": "Yearly" };

/* ---------- State ---------- */
const own = { dir: null, data: null, mod: 0, needsReconnect: false, missing: false, error: "" };
const ro = CONFIG.readOnlySources.map(s => ({ ...s, dir: null, data: null, needsReconnect: false, error: "" }));
const mdRoot = { dir: null, needsReconnect: false };
const ui = {
  view: "today", q: "", pal: null, clFocus: null, statuses: new Set(), tags: new Set(), showDone: false, group: "status", sort: "priority",
  open: new Set(), confirm: null, pendingRender: false, tagAdd: null, askAbout: null, dragging: false,
  pop: null, nf: { title: "", tags: "", priority: "normal", day: "", due: "", repeat: "" },
  cal: "week", anchor: null, md: null, mdSize: "normal", tagStyle: "color", collapsed: new Set(),
  sel: null, tasksMode: "list", ask: false, undo: null, tagsOpen: false
};
try {
  const s = JSON.parse(localStorage.getItem("tt-ui") || "{}");
  for (const k of ["view", "cal", "mdSize", "tagStyle", "tasksMode", "group"]) if (s[k]) ui[k] = s[k];
  if (Array.isArray(s.collapsed)) ui.collapsed = new Set(s.collapsed);
  ui.tagsOpen = s.tagsOpen === true;
} catch {}
const saveUi = () => { try { localStorage.setItem("tt-ui", JSON.stringify({ view: ui.view, cal: ui.cal, mdSize: ui.mdSize, tagStyle: ui.tagStyle, tasksMode: ui.tasksMode, group: ui.group, tagsOpen: ui.tagsOpen, collapsed: [...ui.collapsed] })); } catch {} };
try { const th = localStorage.getItem("tt-theme"); if (th === "dark" || th === "light") document.documentElement.dataset.theme = th; } catch {}
/* File explorer state */
const fx = { cache: new Map(), pending: new Set(), open: new Set([""]), all: false, search: null, index: null, indexing: false,
  mode: "names", text: new Map(), csearch: null, recent: [] };
try { fx.recent = JSON.parse(localStorage.getItem("tt-recent") || "[]"); } catch {}
const saveRecent = () => { try { localStorage.setItem("tt-recent", JSON.stringify(fx.recent)); } catch {} };
const MAX_SEARCH_BYTES = 1000000;
/* Upkeep: a daily snapshot in history/ (never deleted by the page) and archiving of old finished items. */
const ARCHIVE_DAYS = 30;
const HISTORY_DIR = "history";
const fileBase = () => CONFIG.ownFile.replace(/\.json$/i, "");
const archiveName = () => fileBase() + "-archive.json";
const arch = { data: null, loaded: false, error: "" };
const hist = { list: null, error: "", loading: false };
let queue = Promise.resolve();
let busy = false;

/* ---------- Helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ymd = d => d.toLocaleDateString("en-CA");
const today = () => ymd(new Date());
const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDay = s => parseYmd(s).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const nowIso = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 19); };
const uid = p => p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const hue = s => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const parseTags = s => [...new Set(String(s).split(",").map(t => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean))];
const sc = st => `var(${STATUS_VAR[st] || "--s-open"})`;
const isIdea = i => i.kind === "idea";
const ext = name => { const m = /\.([^.]+)$/.exec(name.toLowerCase()); return m ? m[1] : ""; };
const isMd = name => ["md", "markdown"].includes(ext(name));
const isDoc = name => DOC_EXT.has(ext(name)) || /^(readme|license|makefile|dockerfile)$/i.test(name);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
function shiftDate(s, rep) {
  const n = parseInt(rep, 10) || 1, u = rep.slice(-1);
  if (u === "d") return addDays(s, n);
  if (u === "w") return addDays(s, 7 * n);
  const d = parseYmd(s), months = u === "y" ? 12 * n : n;
  const t = new Date(d.getFullYear(), d.getMonth() + months, 1);
  t.setDate(Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
  return ymd(t);
}
function toast(msg) {
  const t = $("#toast"); if (!t) return;
  if (ui.undo) { if (!/^(Not saved|Couldn't)/.test(msg)) return; endUndo(); } // the Undo message stays put unless something failed
  t.textContent = msg; t.classList.remove("act"); t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 1800);
}
/* Undo for ticking a task done: a 7-second message with an Undo button; Cmd-Z / Ctrl-Z does the same. Only the last tick can be undone. */
const UNDO_MS = 7000;
let undoTimer = 0;
function showUndo(u, msg) {
  const t = $("#toast"); if (!t) return;
  ui.undo = u; clearTimeout(t._h); clearTimeout(undoTimer);
  t.innerHTML = `<span>${esc(msg)}</span><button class="undo" data-act="undo">Undo</button><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl Z"}</kbd>`;
  t.classList.add("show", "act");
  undoTimer = setTimeout(endUndo, UNDO_MS);
}
function endUndo() { clearTimeout(undoTimer); ui.undo = null; $("#toast")?.classList.remove("show", "act"); }
function undoDone() {
  const u = ui.undo; if (!u) return; endUndo();
  if (u.fn) return mutate(u.fn, "Undone"); // phone editor saves carry their own undo
  return mutate(d => { const i = findItem(d, u.id); if (i && i.status === "done") reopenItem(d, i, u.prev); }, "Undone");
}
/* Mark a task done; a repeating task gets its next copy. Returns the message to show. */
function completeItem(d, i) {
  i.status = "done"; touch(i);
  if (!i.repeat) return "Done";
  const next = JSON.parse(JSON.stringify(i));
  Object.assign(next, { id: uid("i"), status: "open", notes: [], added: today(), changed: today() });
  delete next.repeatedTo;
  next.checklist = (i.checklist || []).map(c => ({ ...c, done: false }));
  if (!i.due && !i.day) next.due = today();
  let guard = 0;
  do { if (next.due) next.due = shiftDate(next.due, i.repeat); if (next.day) next.day = shiftDate(next.day, i.repeat); }
  while (((next.due || next.day) <= today()) && ++guard < 500);
  d.items.push(next); delete i.repeat; i.repeatedTo = next.id;
  return "Done · next one " + fmtDay(next.due || next.day);
}
/* Reopen a done task; if ticking it created the next repeat and that copy is untouched, remove it again and give the repeat back. */
function reopenItem(d, i, status = "open") {
  i.status = status; touch(i);
  const n = i.repeatedTo && findItem(d, i.repeatedTo); let removed = false;
  if (n && n.status !== "done" && !(n.notes || []).length) { i.repeat = n.repeat; d.items = d.items.filter(x => x.id !== n.id); removed = true; }
  delete i.repeatedTo; return removed;
}
function emptyData() { return { schema: 1, list: CONFIG.listName.toLowerCase(), updated: nowIso(), items: [], notes: [], inbox: [] }; }
function normalize(d) { d.items ??= []; d.notes ??= []; d.inbox ??= []; d.pins ??= []; return d; }

const ICONS = {
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevL: '<path d="m15 18-6-6 6-6"/>',
  chevR: '<path d="m9 18 6-6-6-6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bulb: '<path d="M9 18h6M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.74V16h8v-1.26A7 7 0 0 0 12 2z"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  widen: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"/>',
  narrow: '<path d="m13 17 5-5-5-5M6 17l5-5-5-5"/>',
  full: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  unfull: '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
};
const icon = (n, s = 16) => `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

/* ---------- Desktop app bridge ----------
   In the desktop app (tracker_app.py, opened with "#app"), Python does the file work. These shims look like Chrome's
   folder handles to the rest of the code. "tracker" = the Task Tracker folder (JSON writes only, no deletes);
   "claude" = the Claude folder (read-only). Python enforces both limits. */
const APP_MODE = /(^|[#&])app\b/.test(location.hash) || !!window.pywebview;
const bridge = () => window.pywebview.api;
const notFound = () => Object.assign(new Error("Not found"), { name: "NotFoundError" });
function appFile(area, p) {
  return { kind: "file", name: p.split("/").pop(),
    async getFile() {
      const st = await bridge().stat(area, p);
      return { size: st?.size || 0, lastModified: st?.mtime || 0,
        async text() { return st ? (await bridge().read_text(area, p, 0)).text : ""; },
        slice(a, b) { return { text: async () => (await bridge().read_text(area, p, b)).text.slice(a) }; } };
    },
    async createWritable() {
      if (area !== "tracker") throw new Error("This folder is read-only");
      let buf = "";
      return { async write(x) { buf += x; }, async close() { const r = await bridge().write_text(p, buf); if (!r || !r.ok) throw new Error(r?.error || "Write failed"); } };
    } };
}
function appDir(area, path) {
  const join = n => path ? path + "/" + n : n;
  return { kind: "directory", name: path ? path.split("/").pop() : (area === "tracker" ? "Task Tracker" : "Claude"),
    async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    async getDirectoryHandle(n, o = {}) {
      const st = await bridge().stat(area, join(n));
      if (!st || st.kind !== "directory") { if (o.create && area === "tracker") { const r = await bridge().make_dir(join(n)); if (!r?.ok) throw new Error(r?.error || "Couldn't create folder"); } else throw notFound(); }
      return appDir(area, join(n));
    },
    async getFileHandle(n, o = {}) {
      const st = await bridge().stat(area, join(n));
      if (!st ? !(o.create && area === "tracker") : st.kind !== "file") throw notFound();
      return appFile(area, join(n));
    },
    async *entries() { for (const e of await bridge().list_dir(area, path)) yield [e.name, e.kind === "directory" ? appDir(area, join(e.name)) : appFile(area, join(e.name))]; } };
}
function waitForBridge(ms = 10000) {
  return new Promise((res, rej) => {
    if (window.pywebview?.api?.stat) return res();
    const t = setTimeout(() => rej(new Error("The desktop app's file bridge didn't start")), ms);
    window.addEventListener("pywebviewready", () => { clearTimeout(t); res(); }, { once: true });
  });
}

/* ---------- Dropbox storage (v0.08, 2026-11-16) ----------
   When the page is served over http(s) (the hosted phone page), it reads and writes the Dropbox app folder
   "Apps/Mobile Task Tracker" through Dropbox's API instead of a local folder. Sign-in is OAuth with PKCE
   (no app secret); the app can only see its own folder. These shims look like Chrome's folder handles,
   so mutate(), snapshots and the archive work unchanged. A save sends the revision it read; if the file
   changed on another device meanwhile, Dropbox refuses it and mutate() re-reads and tries again. */
const DBX_MODE = !APP_MODE && /^https?:$/.test(location.protocol);
const DBX_KEY = CONFIG.dropboxKey || "d7z8mu1mxlotaqo"; // app key of the Dropbox app "Mobile Task Tracker"; public by design with PKCE
const DBX_STORE = "tt-dbx", DBX_PKCE = "tt-dbx-pkce";
const dbx = { tok: null, error: "" };
try { dbx.tok = JSON.parse(localStorage.getItem(DBX_STORE) || "null"); } catch {}
const dbxSave = () => { try { dbx.tok ? localStorage.setItem(DBX_STORE, JSON.stringify(dbx.tok)) : localStorage.removeItem(DBX_STORE); } catch {} };
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dbxRedirect = () => location.origin + location.pathname.replace(/index\.html$/, ""); // must match a Redirect URI in the App Console exactly
const dbxArg = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")); // header must be ASCII
async function dbxSignIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48))), state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  try { localStorage.setItem(DBX_PKCE, JSON.stringify({ verifier, state })); } catch {}
  location.href = "https://www.dropbox.com/oauth2/authorize?" + new URLSearchParams({ client_id: DBX_KEY, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", redirect_uri: dbxRedirect(), token_access_type: "offline", state });
}
async function dbxTokenRequest(params) {
  const r = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: DBX_KEY, ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || "Dropbox sign-in failed (" + r.status + ")"), { name: r.status === 400 ? "SignedOut" : "Error" });
  return j;
}
/* Back from Dropbox's sign-in page with ?code=...: trade it for tokens, then clean the address bar. */
async function dbxFinishSignIn() {
  const q = new URLSearchParams(location.search); if (!q.has("code") && !q.has("error")) return;
  history.replaceState(null, "", dbxRedirect() + location.hash);
  let p = null; try { p = JSON.parse(localStorage.getItem(DBX_PKCE) || "null"); localStorage.removeItem(DBX_PKCE); } catch {}
  if (q.has("error")) { dbx.error = "Dropbox sign-in was cancelled or refused (" + (q.get("error_description") || q.get("error")) + ")."; return; }
  if (!p || p.state !== q.get("state")) { dbx.error = "Sign-in didn't match the request this page made. Try again."; return; }
  try {
    const j = await dbxTokenRequest({ grant_type: "authorization_code", code: q.get("code"), code_verifier: p.verifier, redirect_uri: dbxRedirect() });
    dbx.tok = { access: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000, refresh: j.refresh_token }; dbxSave();
  } catch (e) { dbx.error = e.message; }
}
async function dbxAccess(force) {
  if (!dbx.tok?.refresh) throw Object.assign(new Error("Not signed in to Dropbox"), { name: "SignedOut" });
  if (!force && dbx.tok.access && Date.now() < dbx.tok.exp - 60000) return dbx.tok.access;
  try {
    const j = await dbxTokenRequest({ grant_type: "refresh_token", refresh_token: dbx.tok.refresh });
    dbx.tok.access = j.access_token; dbx.tok.exp = Date.now() + (j.expires_in || 14400) * 1000; dbxSave();
    return dbx.tok.access;
  } catch (e) { if (e.name === "SignedOut") { dbx.tok = null; dbxSave(); own.error = "Dropbox signed this page out. Reload to sign in again."; } throw e; }
}
/* One API call. kind "rpc" sends JSON; "down"/"up" use the content host with the argument in a header. 409 = Dropbox's "this path..." errors. */
async function dbxCall(endpoint, arg, kind = "rpc", body) {
  for (let attempt = 0; ; attempt++) {
    const token = await dbxAccess(attempt > 0);
    const host = kind === "rpc" ? "https://api.dropboxapi.com/2/" : "https://content.dropboxapi.com/2/";
    const headers = { Authorization: "Bearer " + token };
    if (kind === "rpc") headers["Content-Type"] = "application/json"; else headers["Dropbox-API-Arg"] = dbxArg(arg);
    if (kind === "up") headers["Content-Type"] = "application/octet-stream";
    const r = await fetch(host + endpoint, { method: "POST", headers, body: kind === "rpc" ? JSON.stringify(arg) : kind === "up" ? new Blob([body]) : undefined });
    if (r.status === 401 && attempt === 0) continue;
    if (r.status === 409) {
      const j = await r.json().catch(() => ({})), s = j.error_summary || "";
      if (/not_found/.test(s)) throw notFound();
      if (/conflict/.test(s)) throw Object.assign(new Error("The file changed on another device"), { name: "ConflictError" });
      throw new Error("Dropbox: " + s);
    }
    if (r.status === 429) { await new Promise(res => setTimeout(res, 1500)); if (attempt < 3) continue; }
    if (!r.ok) throw new Error("Dropbox error " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 200));
    return kind === "down" ? r.text() : r.json();
  }
}
const dbxPath = (dir, n) => "/" + (dir ? dir + "/" : "") + n;
function dbxFile(path, meta) {
  const h = { kind: "file", name: path.split("/").pop(), meta, at: Date.now(),
    async getFile() {
      if (!h.meta || Date.now() - h.at > 1500) { h.meta = await dbxCall("files/get_metadata", { path }); h.at = Date.now(); }
      const m = h.meta;
      return { size: m.size || 0, lastModified: m.rev, // the revision id stands in for the modified time; poll() only compares for equality
        text: () => dbxCall("files/download", { path: "rev:" + m.rev }, "down"),
        slice: (a, b) => ({ text: async () => (await dbxCall("files/download", { path: "rev:" + m.rev }, "down")).slice(a, b) }) };
    },
    async createWritable() {
      let buf = "";
      return { async write(x) { buf += x; },
        async close() {
          const mode = h.meta?.rev ? { ".tag": "update", update: h.meta.rev } : "add";
          h.meta = await dbxCall("files/upload", { path, mode, autorename: false, mute: true, strict_conflict: true }, "up", buf); h.at = Date.now();
        } };
    } };
  return h;
}
function dbxDir(dir) {
  return { kind: "directory", name: dir || "Mobile Task Tracker",
    async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    async getDirectoryHandle(n, o = {}) {
      try { const m = await dbxCall("files/get_metadata", { path: dbxPath(dir, n) }); if (m[".tag"] !== "folder") throw notFound(); }
      catch (e) { if (e.name !== "NotFoundError" || !o.create) throw e; await dbxCall("files/create_folder_v2", { path: dbxPath(dir, n), autorename: false }); }
      return dbxDir(dir ? dir + "/" + n : n);
    },
    async getFileHandle(n, o = {}) {
      const path = dbxPath(dir, n);
      try { const m = await dbxCall("files/get_metadata", { path }); if (m[".tag"] !== "file") throw notFound(); return dbxFile(path, m); }
      catch (e) { if (e.name === "NotFoundError" && o.create) return dbxFile(path, null); throw e; }
    },
    async *entries() {
      let r = await dbxCall("files/list_folder", { path: dir ? "/" + dir : "" });
      for (;;) {
        for (const e of r.entries) yield [e.name, e[".tag"] === "folder" ? dbxDir((dir ? dir + "/" : "") + e.name) : dbxFile(e.path_display, e)];
        if (!r.has_more) break;
        r = await dbxCall("files/list_folder/continue", { cursor: r.cursor });
      }
    } };
}

/* ---------- Folder handles (kept in IndexedDB so you only pick a folder once) ---------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("tasktracker", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("h");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) { try { const db = await idb(); return await new Promise(res => { const q = db.transaction("h").objectStore("h").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } }
async function idbSet(k, v) { try { const db = await idb(); await new Promise(res => { const t = db.transaction("h", "readwrite"); t.objectStore("h").put(v, k); t.oncomplete = res; t.onerror = res; }); } catch {} }

async function readJson(dir, name) {
  const fh = await dir.getFileHandle(name);
  const f = await fh.getFile();
  return { data: normalize(JSON.parse(await f.text())), mod: f.lastModified };
}
async function loadOwn() {
  try {
    const r = await readJson(own.dir, CONFIG.ownFile);
    own.data = r.data; own.mod = r.mod; own.error = ""; own.missing = false;
  } catch (e) {
    if (e.name === "NotFoundError") { own.missing = true; own.data = null; }
    else if (e instanceof SyntaxError) own.error = CONFIG.ownFile + " isn't valid JSON right now (maybe it's being edited). The page won't save until it's fixed. Details: " + e.message;
    else own.error = "Couldn't read " + CONFIG.ownFile + ": " + e.message;
  }
}
async function loadRo(src) {
  try { src.data = (await readJson(src.dir, src.file)).data; src.error = ""; }
  catch (e) { src.data = null; src.error = "Couldn't read " + src.label + " (" + src.file + "): " + e.message; }
}

async function startup() {
  if (APP_MODE) {
    document.documentElement.classList.add("in-app");
    try { await waitForBridge(); } catch (e) { $("#app").innerHTML = `<div class="boot-card"><h1>Task Tracker</h1><p>${esc(e.message)}</p></div>`; return; }
    own.dir = appDir("tracker", ""); mdRoot.dir = appDir("claude", "");
    await loadOwn();
    render();
    setInterval(poll, POLL_MS);
    window.addEventListener("focus", poll);
    upkeep();
    return;
  }
  if (DBX_MODE) {
    document.documentElement.classList.add("in-dbx");
    await dbxFinishSignIn();
    if (dbx.tok?.refresh) { own.dir = dbxDir(""); await loadOwn(); }
    render();
    if (!own.dir) return;
    setInterval(poll, 20000); // a metadata check, not a download; also on focus and when the page is shown again
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
    upkeep();
    return;
  }
  if (!("showDirectoryPicker" in window)) {
    $("#app").innerHTML = `<div class="boot-card"><h1>Task Tracker</h1><p><b>This browser can't open folders.</b> Open this page in Chrome or Edge.</p></div>`;
    return;
  }
  const h = await idbGet("own");
  if (h) {
    own.dir = h;
    if (await h.queryPermission({ mode: "readwrite" }) === "granted") await loadOwn();
    else own.needsReconnect = true;
  }
  const m = await idbGet("mdroot");
  if (m) { mdRoot.dir = m; mdRoot.needsReconnect = await m.queryPermission({ mode: "read" }) !== "granted"; }
  for (const s of ro) {
    const rh = await idbGet("ro:" + s.key);
    if (!rh) continue;
    s.dir = rh;
    if (await rh.queryPermission({ mode: "read" }) === "granted") await loadRo(s); else s.needsReconnect = true;
  }
  render();
  setInterval(poll, POLL_MS);
  window.addEventListener("focus", poll);
  upkeep();
}
async function connectOwn(pick) {
  if (APP_MODE) { await loadOwn(); return render(); }
  try {
    if (pick || !own.dir) {
      own.dir = await window.showDirectoryPicker({ id: "tt-own", mode: "readwrite" });
      await idbSet("own", own.dir);
    } else if (await own.dir.requestPermission({ mode: "readwrite" }) !== "granted") return;
    own.needsReconnect = false;
    await loadOwn(); render(); upkeep();
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't open the folder: " + e.message); }
}
async function connectRo(key, pick) {
  const s = ro.find(x => x.key === key); if (!s) return;
  try {
    if (pick || !s.dir) { s.dir = await window.showDirectoryPicker({ id: "tt-ro-" + key, mode: "read" }); await idbSet("ro:" + key, s.dir); }
    else if (await s.dir.requestPermission({ mode: "read" }) !== "granted") return;
    s.needsReconnect = false; await loadRo(s); render();
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't open the folder: " + e.message); }
}
/* The Claude folder, read-only: used to show linked files in the side panel and for the Files page. */
async function connectMdRoot(pick) {
  if (APP_MODE) return;
  try {
    if (pick || !mdRoot.dir) {
      const opts = { id: "tt-claude", mode: "read" }; if (own.dir) opts.startIn = own.dir;
      const d = await window.showDirectoryPicker(opts);
      try { await (await d.getDirectoryHandle("Trackers")).getDirectoryHandle("Tasks"); } catch { toast("Heads up: that folder has no Trackers/Tasks inside. Pick the Claude folder."); }
      mdRoot.dir = d; await idbSet("mdroot", d);
    } else if (await mdRoot.dir.requestPermission({ mode: "read" }) !== "granted") return;
    mdRoot.needsReconnect = false; fx.cache.clear();
    if (ui.md) openDoc(ui.md.path); else render();
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't open the folder: " + e.message); }
}

/* Every change re-reads the file first, applies the change to the fresh copy, then writes,
   so edits made meanwhile (by Claude or the other machine) are not overwritten. */
function mutate(fn, msg = "Saved") {
  queue = queue.then(async () => {
    if (!own.dir || own.error) { toast("Not saved: the file isn't connected or readable."); return; }
    busy = true;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const fh = await own.dir.getFileHandle(CONFIG.ownFile, { create: own.missing });
          let d;
          if (own.missing) d = emptyData();
          else { const f = await fh.getFile(); d = normalize(JSON.parse(await f.text())); }
          fn(d);
          d.updated = nowIso();
          const w = await fh.createWritable();
          await w.write(JSON.stringify(d, null, 2) + "\n");
          await w.close();
          own.data = d; own.missing = false; own.mod = (await fh.getFile()).lastModified;
          break;
        } catch (e) { if (e.name !== "ConflictError" || attempt >= 2) throw e; } // Dropbox: changed on another device; re-read and apply again
      }
      render(); { const m = typeof msg === "function" ? msg() : msg; if (m) toast(m); }
    } catch (e) {
      if (e instanceof SyntaxError) own.error = CONFIG.ownFile + " isn't valid JSON right now. Not saved. Details: " + e.message;
      toast("Not saved: " + e.message); render();
    } finally { busy = false; }
  });
  return queue;
}
async function poll() {
  if (document.hidden || busy || !own.dir || own.needsReconnect) return;
  try {
    const f = await (await own.dir.getFileHandle(CONFIG.ownFile)).getFile();
    if (f.lastModified !== own.mod) { await loadOwn(); softRender(); if (!own.error) toast("Updated from file"); }
    else if (own.error) { await loadOwn(); softRender(); }
  } catch {}
  for (const s of ro) if (s.dir && !s.needsReconnect) await loadRo(s);
}
function typing() { const a = document.activeElement; return a && $("#app").contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); }
function softRender() {
  const a = document.activeElement;
  if (a?.id === "q" && !ui.dragging && !ui.pop) { const pos = a.selectionStart; render(); const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } return; }
  if (typing() || ui.dragging || ui.pop) ui.pendingRender = true; else render();
}
document.addEventListener("focusout", () => setTimeout(() => { if (ui.pendingRender && !typing() && !ui.dragging && !ui.pop) { ui.pendingRender = false; render(); } }, 0));

/* ---------- Side panel documents (Markdown formatted, everything else as code) ---------- */
async function dirAt(path) {
  let d = mdRoot.dir;
  for (const p of path.split("/").filter(Boolean)) d = await d.getDirectoryHandle(p);
  return d;
}
async function openDoc(path, find = "", line = 0) {
  ui.md = { path, state: "loading", find, line, scrolled: false, hit: 0 }; render();
  if (!mdRoot.dir || mdRoot.needsReconnect) { ui.md.state = mdRoot.dir ? "reconnect" : "noroot"; return render(); }
  const md = ui.md;
  try {
    const parts = path.split("/").filter(Boolean);
    const f = await (await (await dirAt(parts.slice(0, -1).join("/"))).getFileHandle(parts[parts.length - 1])).getFile();
    md.size = f.size;
    md.text = f.size > MAX_VIEW_BYTES ? (await f.slice(0, MAX_VIEW_BYTES).text()) : await f.text();
    md.truncated = f.size > MAX_VIEW_BYTES;
    md.state = "ok"; md.changed = new Date(f.lastModified).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    fx.recent = [path, ...fx.recent.filter(p => p !== path)].slice(0, 12); saveRecent();
  } catch (e) { md.state = "error"; md.error = e.name === "NotFoundError" ? "File not found: " + path : e.message; }
  if (ui.md === md) render();
}
/* marked + DOMPurify load async from the CDN; until they arrive (or if offline) Markdown shows as plain text. */
let libWaits = 0;
function mdHtml(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  if (libWaits < 40) { libWaits++; setTimeout(() => { if (window.marked && window.DOMPurify && ui.md?.state === "ok") softRender(); else if (ui.md) mdHtml(""); }, 250); }
  return `<pre class="md-raw">${esc(text)}</pre>`;
}
function codeHtml(text) {
  return `<pre class="code">${text.split("\n").map(l => `<span class="ln">${esc(l) || " "}</span>`).join("")}</pre>`;
}
function resolveRel(base, href) {
  const parts = base.split("/").slice(0, -1);
  for (const p of href.split("#")[0].split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(decodeURIComponent(p)); }
  return parts.join("/");
}

/* ---------- File explorer ---------- */
async function listDir(path) {
  if (fx.cache.has(path)) return fx.cache.get(path);
  const d = await dirAt(path), out = [];
  for await (const [name, h] of d.entries()) {
    if (name.startsWith(".") || name.startsWith("~$") || (h.kind === "directory" && SKIP_DIRS.has(name))) continue;
    out.push({ name, kind: h.kind, path: (path ? path + "/" : "") + name });
  }
  out.sort((a, b) => (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  fx.cache.set(path, out);
  return out;
}
function loadDir(path) {
  if (fx.pending.has(path)) return; fx.pending.add(path);
  listDir(path).then(() => { fx.pending.delete(path); softRender(); }, e => { fx.pending.delete(path); fx.cache.set(path, { error: e.message }); softRender(); });
}
let searchToken = 0;
async function searchFiles(q) {
  const token = ++searchToken; fx.search = { q, results: [], running: true }; softRender();
  const ql = q.toLowerCase(), results = [], stack = [""]; let seen = 0;
  while (stack.length && seen < 8000) {
    const p = stack.shift(); let list;
    try { list = await listDir(p); } catch { continue; }
    if (token !== searchToken) return;
    for (const e of list) {
      seen++;
      if (e.kind === "directory") stack.push(e.path);
      if (e.name.toLowerCase().includes(ql) && (e.kind === "directory" || fx.all || isDoc(e.name))) results.push(e);
    }
  }
  if (token !== searchToken) return;
  fx.search = { q, results: results.slice(0, 300), running: false, capped: results.length > 300 }; softRender();
}
async function buildIndex() {
  if (fx.index || fx.indexing || !mdRoot.dir || mdRoot.needsReconnect) return;
  fx.indexing = true;
  const out = [], stack = [""]; let seen = 0;
  while (stack.length && seen < 8000) {
    const p = stack.shift(); let list;
    try { list = await listDir(p); } catch { continue; }
    for (const e of list) { seen++; if (e.kind === "directory") stack.push(e.path); else if (isDoc(e.name)) out.push(e); }
  }
  fx.index = out; fx.indexing = false;
  if (ui.pal) updatePalette();
}
let searchTimer;
function scheduleSearch() {
  clearTimeout(searchTimer);
  const q = ui.q.trim();
  if (!q) { fx.search = null; fx.csearch = null; return; }
  if (fx.mode === "contents") { if (q.length < 2) return; searchTimer = setTimeout(() => searchContents(q), 400); }
  else searchTimer = setTimeout(() => searchFiles(q), 250);
}
/* Full-text search: reads every doc/script (up to 1 MB each), keeps the text in memory until Refresh. */
let csToken = 0;
async function searchContents(q) {
  const token = ++csToken; fx.csearch = { q, results: [], running: true, scanned: 0, total: 0 }; softRender();
  const files = [], stack = [""]; let seen = 0;
  while (stack.length && seen < 8000) {
    const p = stack.shift(); let list;
    try { list = await listDir(p); } catch { continue; }
    if (token !== csToken) return;
    for (const e of list) { seen++; if (e.kind === "directory") stack.push(e.path); else if (isDoc(e.name)) files.push(e); }
  }
  fx.csearch.total = files.length;
  const ql = q.toLowerCase(), results = [];
  for (const f of files) {
    if (token !== csToken) return;
    let text = fx.text.get(f.path);
    if (text === undefined) {
      try {
        const parts = f.path.split("/");
        const file = await (await (await dirAt(parts.slice(0, -1).join("/"))).getFileHandle(parts[parts.length - 1])).getFile();
        text = file.size > MAX_SEARCH_BYTES ? null : await file.text();
      } catch { text = null; }
      fx.text.set(f.path, text);
    }
    fx.csearch.scanned++;
    if (!text) continue;
    const low = text.toLowerCase(); let k = low.indexOf(ql); if (k < 0) continue;
    let count = 0; const hits = [];
    while (k >= 0 && count < 200) {
      count++;
      if (hits.length < 3) {
        const ls = text.lastIndexOf("\n", k) + 1; let le = text.indexOf("\n", k); if (le < 0) le = text.length;
        let line = 1; for (let x = text.indexOf("\n"); x >= 0 && x < k; x = text.indexOf("\n", x + 1)) line++;
        if (!hits.length || hits[hits.length - 1].line !== line) {
          const raw = text.slice(ls, le).trim(), at = raw.toLowerCase().indexOf(ql);
          hits.push({ line, text: at > 40 ? "…" + raw.slice(at - 30, at + 160) : raw.slice(0, 190) });
        }
      }
      k = low.indexOf(ql, k + ql.length);
    }
    results.push({ ...f, count, hits });
    if (results.length % 8 === 0) { fx.csearch.results = [...results]; softRender(); }
  }
  if (token !== csToken) return;
  results.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  fx.csearch = { q, results, running: false, scanned: files.length, total: files.length }; softRender();
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function markText(s, q) {
  if (!q) return esc(s);
  return s.split(new RegExp("(" + reEsc(q) + ")", "gi")).map((part, k) => k % 2 ? `<mark>${esc(part)}</mark>` : esc(part)).join("");
}
/* Highlight the search term inside the open document and scroll to the first (or chosen) hit. */
function highlightDoc() {
  const m = ui.md, body = $(".md-body"); if (!body || !m.find) return;
  const re = new RegExp(reEsc(m.find), "gi"), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) { const n = walker.currentNode; if (n.parentElement.closest(".md-find")) continue; re.lastIndex = 0; if (re.test(n.nodeValue)) nodes.push(n); }
  let count = 0;
  for (const n of nodes) {
    if (count > 500) break;
    const frag = document.createDocumentFragment(), parts = n.nodeValue.split(new RegExp("(" + reEsc(m.find) + ")", "gi"));
    parts.forEach((part, k) => { if (k % 2) { const mk = document.createElement("mark"); mk.className = "hit"; mk.textContent = part; frag.appendChild(mk); count++; } else if (part) frag.appendChild(document.createTextNode(part)); });
    n.parentNode.replaceChild(frag, n);
  }
  m.count = count;
  const bar = $(".md-find .mf-n"); if (bar) bar.textContent = count ? `${Math.min(m.hit + 1, count)} of ${count}` : "no matches";
  const marks = body.querySelectorAll("mark.hit");
  if (!marks.length) return;
  let target = marks[Math.min(m.hit, marks.length - 1)];
  if (!m.scrolled && m.line) { const ln = body.querySelectorAll(".code .ln")[m.line - 1]; const inLine = ln?.querySelector("mark.hit"); if (inLine) { target = inLine; m.hit = [...marks].indexOf(inLine); if (bar) bar.textContent = `${m.hit + 1} of ${count}`; } }
  target.classList.add("cur");
  if (!m.scrolled) { target.scrollIntoView({ block: "center" }); m.scrolled = true; }
}

/* ---------- Upkeep: snapshots and archive ---------- */
async function readText(dir, name) { const f = await (await dir.getFileHandle(name)).getFile(); return { text: await f.text(), size: f.size, mod: f.lastModified }; }
async function writeText(dir, name, text) { const fh = await dir.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close(); }
async function historyDir() { return own.dir.getDirectoryHandle(HISTORY_DIR, { create: true }); }
const stamp = () => { const d = new Date(); return today() + "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0"); };
/* Copies the data file into history/ exactly as it is on disk. Daily: once per day (skipped if today's exists). */
async function snapshot(suffix = "") {
  const name = `${fileBase()}-${suffix || today()}.json`;
  const hd = await historyDir();
  if (!suffix) { try { await hd.getFileHandle(name); return null; } catch {} }
  const { text } = await readText(own.dir, CONFIG.ownFile);
  JSON.parse(text);
  await writeText(hd, name, text);
  hist.list = null;
  return name;
}
async function loadArchive() {
  try { arch.data = JSON.parse((await readText(own.dir, archiveName())).text); arch.error = ""; }
  catch (e) { if (e.name === "NotFoundError") { arch.data = { schema: 1, items: [], inbox: [] }; arch.error = ""; } else arch.error = "Couldn't read " + archiveName() + ": " + e.message; }
  arch.data && (arch.data.items ??= [], arch.data.inbox ??= []);
  arch.loaded = true;
}
const oldDone = (i, cutoff) => i.status === "done" && !isIdea(i) && i.changed && i.changed < cutoff;
const oldMsg = (m, cutoff) => m.status === "handled" && (m.replied || m.date) && (m.replied || m.date) < cutoff;
/* Writes the archive first, then removes the items from the data file, so a failure leaves a duplicate, never a loss. */
async function archiveOld(days = ARCHIVE_DAYS, quiet = false) {
  if (!own.data || own.error) return 0;
  const cutoff = addDays(today(), -days);
  const items = own.data.items.filter(i => oldDone(i, cutoff)), msgs = own.data.inbox.filter(m => oldMsg(m, cutoff));
  if (!items.length && !msgs.length) { if (!quiet) toast("Nothing old enough to archive"); return 0; }
  await loadArchive(); if (arch.error) { toast("Not archived: " + arch.error); return 0; }
  const ids = new Set(arch.data.items.map(i => i.id)), mids = new Set(arch.data.inbox.map(m => m.id));
  for (const i of items) if (!ids.has(i.id)) arch.data.items.push({ ...i, archivedOn: today() });
  for (const m of msgs) if (!mids.has(m.id)) arch.data.inbox.push({ ...m, archivedOn: today() });
  arch.data.updated = nowIso();
  try { await writeText(own.dir, archiveName(), JSON.stringify(arch.data, null, 2) + "\n"); }
  catch (e) { arch.loaded = false; toast("Not archived (nothing was removed): " + e.message); return 0; }
  const n = items.length + msgs.length;
  await mutate(d => {
    const a = new Set(items.map(i => i.id)), b = new Set(msgs.map(m => m.id));
    d.items = d.items.filter(i => !(a.has(i.id) && oldDone(i, cutoff)));
    d.inbox = d.inbox.filter(m => !(b.has(m.id) && oldMsg(m, cutoff)));
  }, `Archived ${n} finished item${n > 1 ? "s" : ""} (done over ${days} days ago)`);
  return n;
}
async function upkeep() {
  if (!own.data || own.error || !own.dir) return;
  try { await snapshot(); } catch (e) { toast("Daily snapshot failed: " + e.message); return; }
  try { await archiveOld(ARCHIVE_DAYS, true); } catch (e) { toast("Archiving failed: " + e.message); }
}
async function loadHistory() {
  if (hist.loading) return; hist.loading = true;
  try {
    const hd = await historyDir(), out = [];
    for await (const [name, h] of hd.entries()) {
      if (h.kind !== "file" || !name.endsWith(".json")) continue;
      const f = await h.getFile(); out.push({ name, size: f.size, mod: f.lastModified });
    }
    out.sort((a, b) => b.name.localeCompare(a.name));
    hist.list = out; hist.error = "";
  } catch (e) { hist.error = e.message; hist.list = []; }
  hist.loading = false; softRender();
}
async function restoreSnapshot(name) {
  try {
    const hd = await historyDir(), { text } = await readText(hd, name);
    const data = normalize(JSON.parse(text));
    const saved = await snapshot(stamp() + "-before-restore");
    await writeText(own.dir, CONFIG.ownFile, text.endsWith("\n") ? text : text + "\n");
    await loadOwn(); hist.list = null; ui.confirm = null; render();
    toast(`Restored ${name} (${data.items.length} items). Previous state saved as ${saved}`);
  } catch (e) { toast("Restore failed: " + e.message); }
}
/* Restore from the archive: add to the data file first, then remove from the archive. */
async function restoreArchived(kind, id) {
  await loadArchive(); if (arch.error) return toast(arch.error);
  const list = kind === "msg" ? arch.data.inbox : arch.data.items, rec = list.find(x => x.id === id); if (!rec) return;
  const clean = { ...rec }; delete clean.archivedOn;
  await mutate(d => { const target = kind === "msg" ? d.inbox : d.items; if (!target.some(x => x.id === id)) target.push(clean); }, "Restored from archive");
  if (kind === "msg") arch.data.inbox = arch.data.inbox.filter(x => x.id !== id); else arch.data.items = arch.data.items.filter(x => x.id !== id);
  arch.data.updated = nowIso();
  await writeText(own.dir, archiveName(), JSON.stringify(arch.data, null, 2) + "\n"); render();
}

/* ---------- Data access ---------- */
function allItems() {
  const list = (own.data?.items ?? []).map(i => ({ ...i, _ro: false }));
  for (const s of ro) for (const i of (s.data?.items ?? [])) list.push({ ...i, _ro: true, _src: s.label });
  return list;
}
const findItem = (d, id) => d.items.find(i => i.id === id);
const touch = i => { i.changed = today(); };
function matchesQ(i) {
  if (!ui.q) return true;
  const q = ui.q.toLowerCase();
  return [i.title, (i.tags || []).join(" "), i.link, ...(i.notes || []).map(n => n.text)].join(" ").toLowerCase().includes(q);
}
const tagOk = i => !ui.tags.size || (i.tags || []).some(t => ui.tags.has(t));
function byPrio(a, b) {
  return PRIOS.indexOf(a.priority || "normal") - PRIOS.indexOf(b.priority || "normal") || (a.due || "9999").localeCompare(b.due || "9999") || a.title.localeCompare(b.title);
}
function sortItems(a, b) {
  if (ui.sort === "due") return (a.due || "9999").localeCompare(b.due || "9999") || a.title.localeCompare(b.title);
  if (ui.sort === "day") return (a.day || "9999").localeCompare(b.day || "9999") || byPrio(a, b);
  if (ui.sort === "changed") return (b.changed || "").localeCompare(a.changed || "") || a.title.localeCompare(b.title);
  return byPrio(a, b);
}

/* ---------- Calendar ranges ---------- */
function calDays() {
  const a = parseYmd(ui.anchor || today());
  if (ui.cal === "day") return [ymd(a)];
  const sundayOf = d => { const m = new Date(d); m.setDate(d.getDate() - d.getDay()); return m; };
  let start, n;
  if (ui.cal === "week") { start = sundayOf(a); n = 7; }
  else {
    const first = new Date(a.getFullYear(), a.getMonth(), 1), last = new Date(a.getFullYear(), a.getMonth() + 1, 0);
    start = sundayOf(first); const end = new Date(last); end.setDate(last.getDate() + (6 - last.getDay()));
    n = Math.round((end - start) / 864e5) + 1;
  }
  return [...Array(n)].map((_, k) => { const d = new Date(start); d.setDate(start.getDate() + k); return ymd(d); });
}
function calShift(dir) {
  if (dir === 0) { ui.anchor = null; return; }
  const a = ui.anchor || today();
  if (ui.cal === "day") ui.anchor = addDays(a, dir);
  else if (ui.cal === "week") ui.anchor = addDays(a, 7 * dir);
  else { const d = parseYmd(a); ui.anchor = ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1)); }
}
function calLabel(days) {
  const a = parseYmd(ui.anchor || today());
  if (ui.cal === "day") return a.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  if (ui.cal === "month") return a.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const f = parseYmd(days[0]), l = parseYmd(days[6]), md = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return md(f) + " – " + (f.getMonth() === l.getMonth() ? l.getDate() : md(l)) + ", " + l.getFullYear();
}

/* ---------- Rendering ---------- */
function render() {
  const app = $("#app");
  const keep = {}; for (const s of [".main", ".md-body", ".tray", ".sheet", ".ph-view", ".ph-ed-body"]) keep[s] = document.querySelector(s)?.scrollTop || 0;
  document.body.classList.toggle("is-phone", PHONE.matches);
  if (!own.data) { app.className = "app boot"; app.innerHTML = bootScreen(); return; }
  if (PHONE.matches) {
    app.className = "app phone"; app.innerHTML = phoneHtml();
    for (const s in keep) { const el = document.querySelector(s); if (el) el.scrollTop = keep[s]; }
    if (ph.ed) ph.ed.anim = false;
    return;
  }
  const all = allItems(), tasks = all.filter(i => !isIdea(i)), ideas = all.filter(isIdea);
  if (ui.sel && !all.some(i => i.id === ui.sel)) ui.sel = null;
  $("#alltags").innerHTML = [...new Set(all.flatMap(i => i.tags || []))].sort().map(t => `<option value="${esc(t)}">`).join("");
  app.className = "app" + (ui.md ? " md-open md-" + ui.mdSize : "") + " tags-" + ui.tagStyle;
  app.innerHTML = sidebar(tasks, ideas)
    + `<div class="win ${ui.sel ? "insp" : ""}"><main class="main">${topbar(tasks, ideas)}${activeFilters()}${banners()}<div class="content view-${ui.view}">${content(tasks, ideas)}</div></main><aside class="pane" aria-label="Details">${inspector()}</aside></div>`
    + mdPanel() + (ui.pal ? paletteHtml() : "");
  for (const s in keep) { const el = document.querySelector(s); if (el) el.scrollTop = keep[s]; }
  document.querySelectorAll(".ititle").forEach(autoSize);
  if (ui.md?.state === "ok" && ui.md.find) highlightDoc();
  if (ui.pal) { const pi = $("#pal-q"); if (pi) { pi.focus(); pi.setSelectionRange(pi.value.length, pi.value.length); } }
  else if (ui.tagAdd) document.querySelector(".tag-input")?.focus();
  else if (ui.clFocus) { document.querySelector(`.cl-add[data-cladd="${CSS.escape(ui.clFocus)}"]`)?.focus(); ui.clFocus = null; }
}
const autoSize = t => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; };
const isDark = () => { const r = document.documentElement; return r.dataset.theme === "dark" || (!r.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches); };

function bootScreen() {
  let body;
  if (DBX_MODE && !own.dir) body = `${dbx.error ? `<p class="err">${esc(dbx.error)}</p>` : ""}<p>Sign in with Dropbox to open your tasks. The page can only see its own folder, <b>Apps/Mobile Task Tracker</b>.</p><button class="btn primary" data-act="dbx-signin">Sign in with Dropbox</button>`;
  else if (DBX_MODE && own.missing) body = `<p>Signed in, but there's no <code>${esc(CONFIG.ownFile)}</code> in <b>Apps/Mobile Task Tracker</b>. Check the Dropbox account you signed in with.</p><button class="btn" data-act="retry">Try again</button>`;
  else if (!own.dir) body = `<p>Pick the <b>Tasks</b> folder in Dropbox (<code>Data Stuff/Claude/Trackers/Tasks</code>). Chrome remembers it; on later visits you may need one click to reconnect.</p><button class="btn primary" data-act="pick">${icon("folder")} Connect folder</button>`;
  else if (own.needsReconnect) body = `<p>Chrome needs your OK to use <b>${esc(own.dir.name)}</b> again.</p><button class="btn primary" data-act="reconnect">Reconnect</button> <button class="btn" data-act="pick">Pick a different folder</button>`;
  else if (own.missing) body = `<p>There's no <code>${esc(CONFIG.ownFile)}</code> in <b>${esc(own.dir.name)}</b>. Wrong folder, or start a new list?</p>${APP_MODE ? "" : `<button class="btn" data-act="pick">Pick a different folder</button> `}<button class="btn primary" data-act="create">Create an empty list here</button>`;
  else body = `<p>${esc(own.error || "Loading…")}</p><button class="btn" data-act="retry">Try again</button>`;
  return `<div class="boot-card"><div class="logo">${icon("check", 22)}</div><h1>Task Tracker</h1>${body}</div>`;
}
function banners() {
  let b = "";
  if (own.error) b += `<div class="banner err"><p>${esc(own.error)}</p><button class="btn" data-act="retry">Try again</button></div>`;
  for (const s of ro) {
    if (!s.dir) b += `<div class="banner"><p>Read-only list <b>${esc(s.label)}</b> isn't connected yet.</p><button class="btn" data-act="ro-pick" data-key="${esc(s.key)}">Connect ${esc(s.label)} (read-only)</button></div>`;
    else if (s.needsReconnect) b += `<div class="banner"><p>Reconnect read-only list <b>${esc(s.label)}</b>.</p><button class="btn" data-act="ro-reconnect" data-key="${esc(s.key)}">Reconnect</button></div>`;
    else if (s.error) b += `<div class="banner err"><p>${esc(s.error)}</p></div>`;
  }
  return b;
}

function sidebar(tasks, ideas) {
  const d = own.data, t = today();
  const active = tasks.filter(i => i.status !== "done");
  const nNew = d.inbox.filter(m => m.status !== "handled").length;
  const nav = (v, label, ic, n, hot) => `<button class="nav-item ${ui.view === v ? "on" : ""}" data-act="view" data-v="${v}">${icon(ic, 15)}<span>${label}</span>${n ? `<span class="nav-n ${hot ? "hot" : ""}">${n}</span>` : ""}</button>`;
  const tagCounts = {}; for (const i of [...active, ...ideas]) for (const tg of i.tags || []) tagCounts[tg] = (tagCounts[tg] || 0) + 1;
  return `<aside class="side">
    <div class="brand"><div class="logo">${icon("check", 16)}</div><div><div class="brand-name">Tasks</div><div class="brand-sub">${esc(CONFIG.listName)}${CONFIG.version ? " · v" + esc(CONFIG.version) : ""}</div></div></div>
    <button class="jump" data-act="pal-open">${icon("search", 14)}<span>Jump to…</span><kbd>⌘K</kbd></button>
    <nav class="nav">
      ${nav("today", "Today", "sun", active.filter(i => (i.due && i.due <= t) || (i.day && i.day <= t)).length, true)}
      ${nav("list", "Tasks", "list", active.length)}
      ${nav("cal", "Calendar", "calendar", 0)}
      ${nav("ideas", "Ideas", "bulb", ideas.length)}
      ${nav("notes", "Notes", "note", d.notes.length)}
      ${nav("files", "Files", "folder", 0)}
      ${nav("inbox", "For Claude", "msg", nNew, true)}
    </nav>
    ${ui.tagStyle === "hide" ? "" : `<button class="side-sec side-toggle ${ui.tagsOpen ? "" : "shut"}" data-act="tags-toggle" aria-expanded="${ui.tagsOpen}">Tags${!ui.tagsOpen && ui.tags.size ? `<span class="st-on">${ui.tags.size} on</span>` : ""}${icon("chevD", 12)}</button>
    ${ui.tagsOpen ? `<div class="side-tags">${Object.keys(tagCounts).sort().map(tg => `<button class="side-tag ${ui.tags.has(tg) ? "on" : ""}" data-act="ftag" data-v="${esc(tg)}" style="--h:${hue(tg)}"><span class="tdot"></span>${esc(tg)}<span class="st-n">${tagCounts[tg]}</span></button>`).join("")}</div>` : ""}`}
    <div class="side-sec">Upkeep</div>
    <nav class="nav small">
      ${nav("archive", "Archive", "archive", 0)}
      ${nav("history", "History", "clock", 0)}
    </nav>
    <div class="side-foot"><span class="dot ${own.error ? "" : "on"}"></span><span class="sf-t" title="${esc(own.dir?.name || "")}/${esc(CONFIG.ownFile)}${APP_MODE ? " · desktop app" : ""}">${esc(CONFIG.ownFile)} · ${own.error ? "not saving" : "saved"}</span>${APP_MODE ? "" : `<button class="icon-btn" data-act="pick" title="Change folder">${icon("folder", 14)}</button>`}<button class="theme-btn" data-act="theme" title="Switch light and dark">${icon(isDark() ? "sun" : "moon", 13)} Theme</button></div>
  </aside>`;
}

function topbar(tasks, ideas) {
  const active = tasks.filter(i => i.status !== "done");
  const subs = {
    today: new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" }),
    list: `${active.length} active · ${active.filter(i => i.status === "in progress").length} in progress`,
    cal: "Drag tasks onto a day to plan them",
    ideas: "Things worth keeping that aren't tasks yet",
    notes: "Facts, decisions and context Claude can search",
    files: "Your Claude folder: Markdown and scripts",
    inbox: `Say "check the tracker inbox" in Claude Code`,
    archive: `Finished tasks move here ${ARCHIVE_DAYS} days after they were last changed`,
    history: "A copy of your list is saved here every day. The page never deletes them."
  };
  const titles = { today: "Today", list: "Tasks", cal: "Calendar", ideas: "Ideas", notes: "Notes", files: "Files", inbox: "For Claude", archive: "Archive", history: "History" };
  const nFilters = ui.statuses.size + ui.tags.size + (ui.showDone ? 1 : 0);
  const withFilter = ["list", "cal", "ideas"].includes(ui.view), withNew = withFilter || ui.view === "today";
  const modes = ui.view === "list" ? `<div class="seg">${["list", "board"].map(m => `<button class="${ui.tasksMode === m ? "on" : ""}" data-act="tmode" data-v="${m}">${cap(m)}</button>`).join("")}</div>` : "";
  return `<div class="topbar">
    <div class="tb-title"><h1 class="page-title">${titles[ui.view] || "Tasks"}</h1><div class="page-sub">${esc(subs[ui.view] || "")}</div></div>
    <div class="tb-actions">${modes}
      <label class="search">${icon("search", 15)}<input type="search" id="q" placeholder="${ui.view === "files" ? "Find a file…" : "Search…"}" value="${esc(ui.q)}" autocomplete="off"><kbd>/</kbd></label>
      ${withFilter ? `<div class="popwrap"><button class="btn ghost ${ui.pop === "filter" ? "active" : ""}" data-act="pop" data-pop="filter">${icon("filter", 15)} Filter${nFilters ? `<span class="btn-n">${nFilters}</span>` : ""}</button>${ui.pop === "filter" ? filterPop([...tasks, ...ideas]) : ""}</div>` : ""}
      ${withNew ? `<div class="popwrap"><button class="btn primary" data-act="pop" data-pop="new">${icon("plus", 15)} New${ui.view === "ideas" ? " idea" : ""}</button>${ui.pop === "new" ? newPop() : ""}</div>` : ""}
    </div></div>`;
}
function filterPop(items) {
  const allTags = [...new Set(items.flatMap(i => i.tags || []))].sort();
  const taskView = ui.view !== "ideas";
  return `<div class="pop pop-filter">
    ${taskView ? `<div class="pop-sec">Status</div>
    <div class="pop-chips">${STATUSES.map(s => `<button class="chip ${ui.statuses.has(s) ? "on" : ""}" data-act="fstatus" data-v="${s}" style="--sc:${sc(s)}"><span class="cdot"></span>${s}</button>`).join("")}</div>` : ""}
    <div class="pop-sec">Tags</div>
    <div class="pop-chips">${allTags.map(t => `<button class="chip ${ui.tags.has(t) ? "on" : ""}" data-act="ftag" data-v="${esc(t)}">#${esc(t)}</button>`).join("") || `<span class="muted-s">No tags yet</span>`}</div>
    <div class="pop-sec">Display</div>
    <div class="pop-line"><span>Tags</span><div class="seg">${["color", "plain", "hide"].map(s => `<button class="${ui.tagStyle === s ? "on" : ""}" data-act="tagstyle" data-v="${s}">${cap(s)}</button>`).join("")}</div></div>
    ${taskView ? `<label class="switch"><input type="checkbox" id="opt-showdone" ${ui.showDone ? "checked" : ""}><span class="sw"></span>Show done tasks</label>` : ""}
    ${ui.view === "list" ? `<div class="pop-row two">
      <label>Group<select id="group" autocomplete="off"><option value="status" ${ui.group === "status" ? "selected" : ""}>Status</option><option value="priority" ${ui.group === "priority" ? "selected" : ""}>Priority</option><option value="when" ${ui.group === "when" ? "selected" : ""}>When</option><option value="tag" ${ui.group === "tag" ? "selected" : ""}>Tag</option><option value="none" ${ui.group === "none" ? "selected" : ""}>None</option></select></label>
      <label>Sort<select id="sort" autocomplete="off"><option value="priority" ${ui.sort === "priority" ? "selected" : ""}>Priority</option><option value="day" ${ui.sort === "day" ? "selected" : ""}>Planned day</option><option value="due" ${ui.sort === "due" ? "selected" : ""}>Due date</option><option value="changed" ${ui.sort === "changed" ? "selected" : ""}>Recently changed</option></select></label></div>` : ""}
    <div class="pop-foot"><button class="btn ghost" data-act="clear">Clear filters</button><button class="btn" data-act="pop-close">Done</button></div>
  </div>`;
}
function newPop() {
  const nf = ui.nf, idea = ui.view === "ideas";
  return `<div class="pop pop-new">
    <input class="nf-title" data-nf="title" placeholder="${idea ? "What's the idea?" : "What needs doing?"}" value="${esc(nf.title)}" autocomplete="off">
    <input data-nf="tags" list="alltags" placeholder="Tags, comma separated" value="${esc(nf.tags)}" autocomplete="off">
    ${idea ? "" : `<div class="pop-sec">Priority</div>
    <div class="seg">${PRIOS.map(p => `<button class="${nf.priority === p ? "on" : ""}" data-act="nf-prio" data-v="${p}">${p}</button>`).join("")}</div>
    <div class="pop-row two"><label>Do on<input type="date" data-nf="day" value="${esc(nf.day)}" autocomplete="off"></label><label>Due<input type="date" data-nf="due" value="${esc(nf.due)}" autocomplete="off"></label></div>
    <div class="pop-row"><label>Repeats<select data-nf="repeat" autocomplete="off">${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${nf.repeat === k ? "selected" : ""}>${v}</option>`).join("")}</select></label></div>`}
    <div class="pop-foot"><button class="btn ghost" data-act="pop-close">Cancel</button><button class="btn primary" data-act="add-item">${idea ? "Add idea" : "Add task"}</button></div>
  </div>`;
}
function activeFilters() {
  if (!(ui.statuses.size || ui.tags.size || ui.q || ui.showDone) || !["list", "cal", "ideas"].includes(ui.view)) return "";
  const chip = (label, act, v, style = "") => `<span class="fchip" ${style}>${label}<button data-act="${act}" data-v="${esc(v)}" title="Remove">${icon("x", 12)}</button></span>`;
  return `<div class="active-filters">
    ${ui.view !== "ideas" ? [...ui.statuses].map(s => chip(`<span class="cdot"></span>${s}`, "fstatus", s, `style="--sc:${sc(s)}"`)).join("") : ""}
    ${[...ui.tags].map(t => chip("#" + esc(t), "ftag", t)).join("")}
    ${ui.showDone && ui.view !== "ideas" ? chip("showing done", "showdone", "") : ""}
    ${ui.q ? chip(`“${esc(ui.q)}”`, "clear-q", "") : ""}
    <button class="btn ghost small" data-act="clear">Clear all</button></div>`;
}

function content(tasks, ideas) {
  if (ui.view === "today") return renderToday(tasks);
  if (ui.view === "list") return renderList(tasks);
  if (ui.view === "cal") return renderCal(tasks);
  if (ui.view === "ideas") return renderIdeas(ideas);
  if (ui.view === "notes") return renderNotes(own.data.notes);
  if (ui.view === "files") return renderFiles();
  if (ui.view === "archive") return renderArchive();
  if (ui.view === "history") return renderHistory();
  return renderInbox(own.data.inbox, tasks);
}

function groupSection(key, name, color, items, opts = {}) {
  const k = ui.view + ":" + key, shut = ui.collapsed.has(k);
  const head = name ? `<button class="gh" data-act="collapse" data-v="${esc(k)}" aria-expanded="${!shut}"><h2>${esc(name)}</h2><span class="count">${items.length}</span>${opts.hint ? `<span class="hint">${esc(opts.hint)}</span>` : ""}${icon("chevD", 14)}</button>` : "";
  return `<section class="group ${shut ? "shut" : ""}">${head}${shut ? "" : `<div class="rows">${items.map(i => renderItem(i, opts)).join("")}</div>`}</section>`;
}
function renderList(items) {
  const vis = items.filter(i => {
    if (ui.statuses.size) { if (!ui.statuses.has(i.status)) return false; }
    else if (i.status === "done" && !ui.showDone) return false;
    return tagOk(i) && matchesQ(i);
  }).sort(sortItems);
  if (ui.tasksMode === "board") {
    const cols = STATUSES.filter(s => ui.statuses.size ? ui.statuses.has(s) : s !== "done" || ui.showDone);
    return `<div class="board">${cols.map(s => { const l = vis.filter(i => i.status === s); return `<div class="bcol" data-sdrop="${s}"><h3>${esc(cap(s))}<span class="count">${l.length}</span></h3>${l.map(bcard).join("") || `<div class="drop-empty">Drop a task here</div>`}</div>`; }).join("")}</div>`;
  }
  if (!vis.length) return `<div class="empty">${icon("check", 28)}<p>Nothing here. ${items.length ? "Try clearing the filters." : "Press <kbd>n</kbd> to add your first task."}</p></div>`;
  let groups;
  if (ui.group === "status") groups = STATUSES.map(s => [s, cap(s), sc(s), vis.filter(i => i.status === s)]);
  else if (ui.group === "priority") groups = PRIOS.map(p => ["p-" + p, cap(p) + " priority", `var(--p-${p})`, vis.filter(i => (i.priority || "normal") === p)]);
  else if (ui.group === "when") {
    /* Same buckets as Today: overdue first, then today, the next 7 days, later, undated. */
    const t = today(), horizon = addDays(t, 7);
    const bucket = i => {
      if (i.status === "done") return "done";
      if ((i.due && i.due < t) || (i.day && i.day < t)) return "over";
      if (i.day === t || i.due === t) return "today";
      const next = [i.day, i.due].filter(x => x && x > t).sort()[0];
      return !next ? "none" : next <= horizon ? "soon" : "later";
    };
    groups = [["w-over", "Needs attention"], ["w-today", "Today"], ["w-soon", "Coming up"], ["w-later", "Later"], ["w-none", "No date"], ["w-done", "Done"]]
      .map(([k, name]) => [k, name, "", vis.filter(i => "w-" + bucket(i) === k)]);
  }
  else if (ui.group === "tag") {
    const keys = [...new Set(vis.map(i => (i.tags || [])[0] || "untagged"))].sort();
    groups = keys.map(k => ["t-" + k, k === "untagged" ? "Untagged" : "#" + k, "", vis.filter(i => ((i.tags || [])[0] || "untagged") === k)]);
  } else groups = [["all", "", "", vis]];
  return groups.filter(g => g[3].length).map(([k, name, c, g]) => groupSection(k, name, c, g)).join("");
}
const bcard = i => `<div class="bcard ${ui.sel === i.id ? "sel" : ""} ${i.status === "done" ? "done" : ""}" id="item-${esc(i.id)}" data-act="sel" data-id="${esc(i.id)}" ${i._ro ? "" : `draggable="true" data-drag="${esc(i.id)}"`}>
  <div class="bt">${hiDot(i)}<span>${esc(i.title)}</span></div><div class="bm">${tagDots(i)}${whenHtml(i)}</div></div>`;

function dueBadge(i) {
  if (!i.due) return "";
  const t = today(); const cls = i.status !== "done" && i.due < t ? "over" : i.due === t ? "today" : "";
  return `<span class="badge due ${cls}">Due ${esc(fmtDay(i.due))}</span>`;
}
const dayBadge = i => i.day ? `<span class="badge day">${icon("calendar", 12)} ${esc(i.day === today() ? "Today" : fmtDay(i.day))}</span>` : "";
const linkHtml = l => l ? `<button class="linkbtn ${ui.md?.path === l ? "on" : ""}" data-act="doc" data-path="${esc(l)}" title="Open ${esc(l)}">${icon(isMd(l) ? "book" : "code", 13)}${esc(l.split("/").pop())}</button>` : "";
function tagsHtml(i) {
  const editing = ui.tagAdd === i.id ? `<input class="tag-input" data-tagadd="${esc(i.id)}" list="alltags" placeholder="new tag, Enter" autocomplete="off">` : "";
  if (ui.tagStyle === "hide") return editing;
  if (i._ro) return (i.tags || []).map(t => `<span class="tag static" style="--h:${hue(t)}">#${esc(t)}</span>`).join("");
  return (i.tags || []).map(t => `<span class="tag" style="--h:${hue(t)}">#${esc(t)}<button class="x" data-act="tag-del" data-id="${esc(i.id)}" data-tag="${esc(t)}" title="Remove tag">×</button></span>`).join("") + editing;
}
const tagAddBtn = i => i._ro || ui.tagAdd === i.id ? "" : `<button class="tag-add" data-act="tag-add" data-id="${esc(i.id)}">+ tag</button>`;
function prioCtl(i) {
  const p = i.priority || "normal";
  if (i._ro) return p === "normal" ? "" : `<span class="ppill p-${p}">${cap(p)}</span>`;
  return `<span class="ppill p-${p}" title="Priority"><select data-field="priority" data-id="${esc(i.id)}" autocomplete="off">${PRIOS.map(x => `<option value="${x}" ${x === p ? "selected" : ""}>${cap(x)}${x === "normal" ? "" : ""}</option>`).join("")}</select></span>`;
}

/* A row carries three things: the check, the title, and one quiet "when". Everything else lives in the inspector. */
function shortDay(s) {
  const d = parseYmd(s), n = Math.round((d - parseYmd(today())) / 864e5);
  return Math.abs(n) <= 6 ? d.toLocaleDateString("en-US", { weekday: "short" }) : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function relDay(s) {
  const n = Math.round((parseYmd(s) - parseYmd(today())) / 864e5);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 0 ? `in ${n} days` : `${-n} days ago`;
}
function whenHtml(i) {
  const t = today(), cl = i.checklist || [];
  if (i.status !== "done" && !isIdea(i)) {
    if (i.due) return `<span class="when due">${i.due < t ? "overdue · " + esc(shortDay(i.due)) : i.due === t ? "due today" : "due " + esc(shortDay(i.due))}</span>`;
    if (i.day) return `<span class="when ${i.day < t ? "late" : ""}">${i.day === t ? "today" : esc(shortDay(i.day))}</span>`;
  }
  if (cl.length) return `<span class="when faint">${cl.filter(c => c.done).length}/${cl.length}</span>`;
  return "";
}
const hiDot = i => i.priority === "high" && i.status !== "done" ? `<i class="hi" title="High priority"></i>` : "";
const tagDots = i => ui.tagStyle === "hide" || !(i.tags || []).length ? "" : `<span class="rtg">${i.tags.slice(0, 3).map(t => `<i style="--h:${hue(t)}" title="#${esc(t)}"></i>`).join("")}</span>`;
function renderItem(i, opts = {}) {
  const done = i.status === "done" && !isIdea(i);
  return `<div class="row ${done ? "done" : ""} ${ui.sel === i.id ? "sel" : ""}" id="item-${esc(i.id)}" data-act="sel" data-id="${esc(i.id)}" ${i._ro ? "" : `draggable="true" data-drag="${esc(i.id)}"`}>
    <button class="check" data-act="toggle" data-id="${esc(i.id)}" ${i._ro ? "disabled" : ""} aria-label="Mark done">${icon("check", 11)}</button>
    <div class="rt">${hiDot(i)}<span class="rtt">${esc(i.title)}</span>${tagDots(i)}${i._ro ? `<span class="src">${esc(i._src)}</span>` : ""}</div>
    ${whenHtml(i)}</div>`;
}

/* ---------- Inspector (right pane in the window) ---------- */
function inspector() {
  const i = ui.sel && allItems().find(x => x.id === ui.sel);
  if (!i) return "";
  const id = esc(i.id), idea = isIdea(i), ro = i._ro, cl = i.checklist || [], clDone = cl.filter(c => c.done).length, t = today();
  const prop = (k, v) => `<div class="pk">${k}</div><div class="pv">${v}</div>`;
  const dateCtl = f => ro ? (i[f] ? esc(fmtDay(i[f])) : `<span class="faint">None</span>`)
    : `<input type="date" class="pdate ${f === "due" && i.due && i.due < t && i.status !== "done" ? "over" : ""}" data-field="${f}" data-id="${id}" value="${esc(i[f] || "")}" autocomplete="off">`
      + (i[f] ? `<button class="icon-btn sm" data-act="date-clear" data-id="${id}" data-v="${f}" title="Clear">${icon("x", 12)}</button><span class="faint">${esc(relDay(i[f]))}</span>` : "");
  const p = i.priority || "normal";
  const tags = (i.tags || []).map(tg => `<span class="tag" style="--h:${hue(tg)}">${esc(tg)}${ro ? "" : `<button class="x" data-act="tag-del" data-id="${id}" data-tag="${esc(tg)}" title="Remove tag">×</button>`}</span>`).join("")
    + (ro ? "" : ui.tagAdd === i.id ? `<input class="tag-input" data-tagadd="${id}" list="alltags" placeholder="new tag, Enter" autocomplete="off">` : `<button class="set" data-act="tag-add" data-id="${id}">+ tag</button>`);
  const props = `<div class="props">
    ${idea ? "" : prop("Status", ro ? esc(i.status) : `<select class="psel" data-field="status" data-id="${id}" autocomplete="off">${STATUSES.map(s => `<option ${s === i.status ? "selected" : ""}>${s}</option>`).join("")}</select>`)}
    ${idea ? "" : prop("Priority", ro ? esc(cap(p)) : `<div class="seg">${PRIOS.map(x => `<button class="${x === p ? "on" : ""}" data-act="prio" data-id="${id}" data-v="${x}">${cap(x)}</button>`).join("")}</div>`)}
    ${idea ? "" : prop("Do on", dateCtl("day"))}
    ${idea ? "" : prop("Due", dateCtl("due"))}
    ${idea ? "" : prop("Repeats", ro ? esc(REPEATS[i.repeat || ""] || i.repeat) : `<select class="psel" data-field="repeat" data-id="${id}" autocomplete="off">${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${(i.repeat || "") === k ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
    ${prop("Tags", tags || `<span class="faint">None</span>`)}
  </div>`;
  const checklist = idea && !cl.length ? "" : `<section class="isec"><div class="ih">Checklist${cl.length ? `<span class="count">${clDone} of ${cl.length}</span>` : ""}<span class="bar"></span></div>
    ${cl.length ? `<div class="iprog"><i style="width:${Math.round(100 * clDone / cl.length)}%"></i></div>` : ""}
    <div class="cl">${cl.map((c, k) => `<div class="cl-row ${c.done ? "done" : ""}"><button class="cl-box" data-act="cl-toggle" data-id="${id}" data-k="${k}" ${ro ? "disabled" : ""} aria-label="Toggle step">${icon("check", 10)}</button><span class="cl-t">${esc(c.text)}</span>${ro ? "" : `<button class="icon-btn sm" data-act="cl-del" data-id="${id}" data-k="${k}" title="Remove step">${icon("x", 12)}</button>`}</div>`).join("")}
    ${ro ? "" : `<input class="cl-add" data-cladd="${id}" placeholder="Add a step, then Enter" autocomplete="off">`}</div></section>`;
  const link = ro && !i.link ? "" : `<section class="isec"><div class="ih">Linked file<span class="bar"></span></div><div class="lnk">${icon(i.link && !isMd(i.link) ? "code" : "book", 15)}
    ${ro ? `<span class="lp">${esc(i.link)}</span>` : `<input data-field="link" data-id="${id}" value="${esc(i.link || "")}" placeholder="Server/to-do/file.md" autocomplete="off" spellcheck="false">`}
    ${i.link ? `<button class="btn small ${ui.md?.path === i.link ? "active" : ""}" data-act="doc" data-path="${esc(i.link)}">Open</button>` : ""}</div></section>`;
  const msgs = (own.data?.inbox || []).filter(m => m.about === i.id);
  const evs = [...(i.notes || []).map((n, k) => ({ date: n.date || "", k, n })), ...msgs.map(m => ({ date: m.date || "", m }))].sort((a, b) => a.date.localeCompare(b.date));
  const who = by => by ? `<span class="av ${by === "Claude" ? "c" : ""}">${esc(by[0])}</span>` : `<span class="av none"></span>`;
  const activity = evs.map(e => e.n
    ? `<div class="note">${who(e.n.by)}<div class="nb"><div class="nw"><b>${esc(e.n.by || "Note")}</b><span>${esc(e.n.date)}</span>${ro ? "" : `<button class="icon-btn sm nx" data-act="del-inote" data-id="${id}" data-k="${e.k}" title="Remove note">${icon("x", 12)}</button>`}</div><p>${esc(e.n.text)}</p></div></div>`
    : `<div class="note">${who("Barrett")}<div class="nb"><div class="nw"><b>Barrett</b><span>to Claude · ${esc(e.m.date)}</span><span class="pill ${e.m.status === "handled" ? "" : "new"}">${e.m.status === "handled" ? "handled" : "waiting"}</span></div><p>${esc(e.m.text)}</p></div></div>`
      + (e.m.reply ? `<div class="note">${who("Claude")}<div class="nb"><div class="nw"><b>Claude</b><span>${esc(e.m.replied || "")}</span></div><p>${esc(e.m.reply)}</p></div></div>` : "")).join("");
  const composer = ro ? "" : `<div class="icomp"><textarea id="note-${id}" placeholder="${ui.ask ? "Ask Claude about this. It reads it when you say “check the tracker inbox”." : "Add a note. Claude can read these later."}"></textarea>
    <div class="icr"><button class="tog ${ui.ask ? "on" : ""}" data-act="ask-toggle" aria-pressed="${ui.ask}"><span class="sw"></span>For Claude</button><span class="sp"></span><button class="btn primary small" data-act="${ui.ask ? "ask-send" : "add-inote"}" data-id="${id}">${ui.ask ? "Send to Claude" : "Add note"}</button></div></div>`;
  return `<div class="sheet">
    <div class="itop"><span>${idea ? "Idea" : "Task"}${ro ? ` · ${esc(i._src)} (read-only)` : ""}</span><span class="sp"></span><button class="btn ghost small" data-act="handoff" data-id="${id}" title="Copy this task as a handoff for Gemini or a new chat">${icon("copy", 13)} Handoff</button><button class="icon-btn" data-act="insp-close" title="Close (Esc)">${icon("x", 15)}</button></div>
    ${ro ? `<h2 class="ititle-ro">${esc(i.title)}</h2>` : `<textarea class="ititle" data-field="title" data-id="${id}" rows="1" spellcheck="false" aria-label="Title">${esc(i.title)}</textarea>`}
    ${props}${checklist}${link}
    <section class="isec"><div class="ih">Activity${evs.length ? `<span class="count">${evs.length}</span>` : ""}<span class="bar"></span></div><div class="activity">${activity}${composer}</div></section>
    <div class="istamp">Added ${esc(i.added || "?")} · changed ${esc(i.changed || "?")}</div>
    ${ro ? "" : `<div class="ifoot">${idea ? `<button class="btn ghost small" data-act="promote" data-id="${id}">${icon("list", 13)} Make it a task</button>` : `<button class="btn ghost small" data-act="demote" data-id="${id}">${icon("bulb", 13)} Move to Ideas</button>`}<span class="sp"></span>
      ${ui.confirm === i.id ? `<span class="confirm">Delete this ${idea ? "idea" : "task"}?</span><button class="btn danger small" data-act="del-yes" data-id="${id}">Delete</button><button class="btn small" data-act="del-no">Cancel</button>` : `<button class="btn ghost small danger-t" data-act="del" data-id="${id}">Delete</button>`}</div>`}
  </div>`;
}

/* Handoff: the task as a standalone Markdown document for Gemini or a fresh chat, copied to the clipboard. */
async function handoff(id) {
  const i = allItems().find(x => x.id === id); if (!i) return;
  const L = [`# ${i.title}`, "", `- ${isIdea(i) ? "Idea" : "Task"} · status ${i.status} · priority ${i.priority || "normal"}`];
  if ((i.tags || []).length) L.push(`- Tags: ${i.tags.join(", ")}`);
  if (i.day) L.push(`- Planned for ${fmtDay(i.day)} (${i.day})`);
  if (i.due) L.push(`- Due ${fmtDay(i.due)} (${i.due})`);
  if (i.repeat) L.push(`- Repeats: ${REPEATS[i.repeat] || i.repeat}`);
  L.push(`- Added ${i.added || "?"}, last changed ${i.changed || "?"}`);
  if (i.link) L.push(`- Linked file: ${i.link} (path relative to Data Stuff/Claude)`);
  if ((i.checklist || []).length) L.push("", "## Checklist", ...i.checklist.map(c => `- [${c.done ? "x" : " "}] ${c.text}`));
  if ((i.notes || []).length) L.push("", "## Notes", ...i.notes.map(n => `- ${n.date}${n.by ? " (" + n.by + ")" : ""}: ${n.text}`));
  const msgs = (own.data?.inbox || []).filter(m => m.about === i.id);
  if (msgs.length) L.push("", "## Messages with Claude", ...msgs.flatMap(m => [`- ${m.date}, Barrett: ${m.text}`, ...(m.reply ? [`  - ${m.replied || ""}, Claude: ${m.reply}`] : [])]));
  if (i.link && mdRoot.dir && !mdRoot.needsReconnect) {
    try {
      const parts = i.link.split("/").filter(Boolean);
      const f = await (await (await dirAt(parts.slice(0, -1).join("/"))).getFileHandle(parts[parts.length - 1])).getFile();
      const text = f.size > MAX_VIEW_BYTES ? await f.slice(0, MAX_VIEW_BYTES).text() : await f.text();
      L.push("", `## Contents of ${i.link}${f.size > MAX_VIEW_BYTES ? " (first " + Math.round(MAX_VIEW_BYTES / 1000) + " KB)" : ""}`, "", text);
    } catch (e) { L.push("", `(Couldn't read ${i.link}: ${e.message})`); }
  }
  const text = L.join("\n");
  if (await copyText(text)) return toast(`Handoff copied (${Math.max(1, Math.round(text.length / 1000))} KB)`);
  ui.md = { path: "handoff.md", state: "ok", text, virtual: true, find: "", line: 0, hit: 0 }; render();
  toast("Couldn't reach the clipboard here. The handoff is open on the right to copy by hand.");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement("textarea"); ta.value = text; ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch {} ta.remove(); return ok;
}

function renderIdeas(ideas) {
  const vis = ideas.filter(i => tagOk(i) && matchesQ(i)).sort((a, b) => (b.changed || "").localeCompare(a.changed || "") || a.title.localeCompare(b.title));
  if (!vis.length) return `<div class="empty">${icon("bulb", 28)}<p>${ideas.length ? "No ideas match the filters." : "No ideas yet. Use <b>New idea</b>, or open a task and choose <b>Move to Ideas</b>."}</p></div>`;
  return `<div class="ideas">${vis.map(i => `<article class="idea ${ui.sel === i.id ? "sel" : ""}" id="item-${esc(i.id)}" data-act="sel" data-id="${esc(i.id)}">
    <h3>${esc(i.title)}</h3>${(i.notes || []).length ? `<p>${esc(i.notes[0].text)}</p>` : ""}
    <div class="idea-m">${ui.tagStyle === "hide" ? "" : (i.tags || []).map(t => `<span class="tg" style="--h:${hue(t)}">${esc(t)}</span>`).join("")}${i._ro ? `<span class="src">${esc(i._src)}</span>` : ""}</div></article>`).join("")}</div>`;
}

/* Calendar: drag cards between the tray and the days. */
/* Calendar weeks: a task is one bar from Do on to Due when Due is later; otherwise a block on each date it has.
   Bars are laid out in lanes on a 7-column grid so a Thu→Sat task stretches across the days. */
function segsFor(i) {
  if (i.day && i.due && i.due > i.day) return [{ a: i.day, b: i.due, kind: "span" }];
  const s = [];
  if (i.day) s.push({ a: i.day, b: i.day, kind: "day" });
  if (i.due && i.due !== i.day) s.push({ a: i.due, b: i.due, kind: "due" });
  return s;
}
const onDay = (i, d) => segsFor(i).some(s => s.a <= d && d <= s.b);
function weekLayout(days, items) {
  const a = days[0], b = days[days.length - 1], segs = [];
  for (const i of items) for (const sg of segsFor(i)) {
    if (sg.b < a || sg.a > b) continue;
    const col = days.indexOf(sg.a < a ? a : sg.a), end = days.indexOf(sg.b > b ? b : sg.b);
    segs.push({ i, kind: sg.kind, col, span: end - col + 1, contL: sg.a < a, contR: sg.b > b });
  }
  segs.sort((x, y) => x.col - y.col || y.span - x.span || (x.i.status === "done") - (y.i.status === "done") || byPrio(x.i, y.i));
  const ends = [];
  for (const sg of segs) { let l = ends.findIndex(e => e < sg.col); if (l < 0) l = ends.push(-1) - 1; ends[l] = sg.col + sg.span - 1; sg.lane = l; }
  return { segs, lanes: ends.length };
}
/* o: { cls, max, cellCls(d), head(d, n), bar(item, seg), more(d, n) } */
function weekRow(days, items, o) {
  const { segs, lanes } = weekLayout(days, items), max = o.max || Infinity, shown = Math.min(lanes, max);
  const covers = c => segs.filter(sg => sg.col <= c && c < sg.col + sg.span);
  const hidden = days.map((_, c) => covers(c).filter(sg => sg.lane >= max).length);
  const rows = shown + (hidden.some(n => n) ? 1 : 0);
  return `<div class="wk ${o.cls}" style="grid-template-rows:auto${rows ? ` repeat(${rows}, auto)` : ""} 1fr">
    ${days.map((d, c) => `<div class="wk-cell ${c ? "" : "c0"} ${o.cellCls(d)}" style="grid-column:${c + 1}" data-drop="${d}"></div><div class="wk-head ${o.cellCls(d)}" style="grid-column:${c + 1}" data-drop="${d}">${o.head(d, covers(c).length)}</div>`).join("")}
    ${segs.filter(sg => sg.lane < max).map(sg => `<div class="wk-bar k-${sg.kind} ${sg.contL ? "cl" : ""} ${sg.contR ? "cr" : ""}" style="grid-column:${sg.col + 1} / span ${sg.span};grid-row:${sg.lane + 2}">${o.bar(sg.i, sg)}</div>`).join("")}
    ${hidden.map((n, c) => n ? `<div class="wk-more" style="grid-column:${c + 1};grid-row:${shown + 2}" data-drop="${days[c]}">${o.more(days[c], n)}</div>` : "").join("")}
  </div>`;
}

function renderCal(items) {
  const days = calDays(), inView = new Set(days), t = today();
  const base = items.filter(i => tagOk(i) && matchesQ(i) && (!ui.statuses.size || ui.statuses.has(i.status)) && (ui.showDone || i.status !== "done" || inView.has(i.day)));
  const placed = i => days.some(d => onDay(i, d));
  const rest = base.filter(i => i.status !== "done" && !placed(i));
  const carried = rest.filter(i => i.day && i.day < t).sort(byPrio);
  const unsched = rest.filter(i => !i.day).sort(byPrio);
  const later = rest.filter(i => i.day && i.day >= t).sort((a, b) => a.day.localeCompare(b.day));
  const on = day => base.filter(i => onDay(i, day)).sort((a, b) => (a.status === "done") - (b.status === "done") || byPrio(a, b));

  const bar = `<div class="calbar">
    <div class="seg">${["day", "week", "month"].map(m => `<button class="${ui.cal === m ? "on" : ""}" data-act="calmode" data-v="${m}">${cap(m)}</button>`).join("")}</div>
    <div class="calnav"><button class="icon-btn" data-act="calnav" data-v="-1" title="Previous">${icon("chevL")}</button><button class="btn small" data-act="calnav" data-v="0">Today</button><button class="icon-btn" data-act="calnav" data-v="1" title="Next">${icon("chevR")}</button></div>
    <h2 class="cal-label">${esc(calLabel(days))}</h2></div>`;
  const tray = `<div class="tray" data-drop="">
    <div class="tray-h">Unscheduled<span>Drag onto a day · drag back to clear</span></div>
    ${carried.length ? `<div class="tray-sec">Carried over</div>${carried.map(i => mini(i, "tray")).join("")}` : ""}
    <div class="tray-sec">No day yet · ${unsched.length}</div>${unsched.map(i => mini(i, "tray")).join("") || `<div class="drop-empty">Nothing unscheduled</div>`}
    ${later.length ? `<div class="tray-sec">Planned outside this view</div>${later.map(i => mini(i, "tray")).join("")}` : ""}
  </div>`;

  let grid;
  if (ui.cal === "month") {
    const month = parseYmd(ui.anchor || t).getMonth();
    const heads = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => `<div class="mhead">${d}</div>`).join("");
    const weeks = [...Array(days.length / 7)].map((_, w) => days.slice(w * 7, w * 7 + 7));
    grid = `<div class="mgrid"><div class="mheads">${heads}</div>${weeks.map(wk => weekRow(wk, base.filter(i => wk.some(d => onDay(i, d))), {
      cls: "wk-month", max: 3,
      cellCls: d => `${d === t ? "today" : ""} ${parseYmd(d).getMonth() !== month ? "other" : ""} ${d < t ? "past" : ""}`,
      head: d => `<button class="mnum" data-act="cal-day" data-v="${d}">${parseYmd(d).getDate()}</button>`,
      bar: mchip,
      more: (d, n) => `<button class="more" data-act="cal-day" data-v="${d}">+${n} more</button>`
    })).join("")}</div>`;
  } else if (ui.cal === "week") {
    grid = `<div class="wgrid">${weekRow(days, base.filter(i => days.some(d => onDay(i, d))), {
      cls: "wk-week",
      cellCls: d => `${d === t ? "today" : ""} ${d < t ? "past" : ""}`,
      head: (d, n) => `<div class="colh"><span class="dn">${parseYmd(d).toLocaleDateString("en-US", { weekday: "short" })}</span><button class="dd" data-act="cal-day" data-v="${d}">${parseYmd(d).getDate()}</button><span class="cnt">${n || ""}</span></div>`,
      bar: i => mini(i, "day")
    })}</div>`;
  } else {
    grid = `<div class="days one">${days.map(day => {
      const dt = parseYmd(day), list = on(day);
      return `<div class="col ${day === t ? "today" : ""} ${day < t ? "past" : ""}" data-drop="${day}">
        <div class="colh"><span class="dn">${dt.toLocaleDateString("en-US", { weekday: "long" })}</span><button class="dd" data-act="cal-day" data-v="${day}">${dt.getDate()}</button><span class="cnt">${list.length || ""}</span></div>
        ${list.map(i => mini(i, "big")).join("") || `<div class="drop-empty">Drop here</div>`}</div>`;
    }).join("")}</div>`;
  }
  return bar + `<div class="cal cal-${ui.cal}">${tray}${grid}</div>`;
}
function mini(i, where) {
  const ghost = !i.day && i.due;
  const w = where === "tray" ? whenHtml(i) : i.due && i.status !== "done" && i.due !== i.day ? `<span class="when due">${ghost ? "due" : "due " + esc(shortDay(i.due))}</span>` : "";
  return `<div class="mini w-${where} ${i.status === "done" ? "done" : ""} ${ghost ? "ghost-due" : ""} ${ui.sel === i.id ? "sel" : ""}" ${i._ro ? "" : `draggable="true" data-drag="${esc(i.id)}"`} data-act="sel" data-id="${esc(i.id)}" title="${esc(i.title)}">
    <button class="check" data-act="toggle" data-id="${esc(i.id)}" ${i._ro ? "disabled" : ""} aria-label="Mark done">${icon("check", 10)}</button>
    <div class="mbody"><div class="mt">${hiDot(i)}${esc(i.title)}</div>${w ? `<div class="mm">${w}</div>` : ""}</div></div>`;
}
const mchip = i => `<div class="mchip ${i.status === "done" ? "done" : ""} ${ui.sel === i.id ? "sel" : ""}" ${i._ro ? "" : `draggable="true" data-drag="${esc(i.id)}"`} data-act="sel" data-id="${esc(i.id)}" title="${esc(i.title)}"><span>${esc(i.title)}</span></div>`;

function renderFiles() {
  if (!mdRoot.dir) return `<div class="empty">${icon("folder", 28)}<p>The Files page shows your <b>Claude</b> folder (<code>Data Stuff/Claude</code>), read-only.<br>The page can open files there but never change them.</p><button class="btn primary" data-act="md-root">${icon("folder", 15)} Connect Claude folder</button></div>`;
  if (mdRoot.needsReconnect) return `<div class="empty">${icon("folder", 28)}<p>Chrome needs your OK to read <b>${esc(mdRoot.dir.name)}</b> again.</p><button class="btn primary" data-act="md-reconnect">Reconnect</button></div>`;
  const bar = `<div class="fxbar">
    <div class="seg" title="What the search box looks in"><button class="${fx.mode === "names" ? "on" : ""}" data-act="fx-mode" data-v="names">File names</button><button class="${fx.mode === "contents" ? "on" : ""}" data-act="fx-mode" data-v="contents">Inside files</button></div>
    <div class="seg"><button class="${fx.all ? "" : "on"}" data-act="fx-all" data-v="0">Docs &amp; scripts</button><button class="${fx.all ? "on" : ""}" data-act="fx-all" data-v="1">All files</button></div>
    <button class="btn small" data-act="fx-collapse">${icon("up", 14)} Collapse all</button>
    <button class="btn small" data-act="fx-refresh" title="Re-read folders and file contents">${icon("refresh", 14)} Refresh</button>
    <span class="fx-root">${icon("folderOpen", 14)} ${esc(mdRoot.dir.name)}</span></div>`;
  const q = ui.q.trim();
  if (q && fx.mode === "contents") {
    if (q.length < 2) return bar + `<div class="fx-msg">Type at least 2 characters to search inside files.</div>`;
    const s = fx.csearch;
    if (!s || s.q !== q) { scheduleSearch(); return bar + `<div class="fx-msg">Searching inside files…</div>`; }
    const status = s.running ? `Searching… ${s.scanned} of ${s.total || "?"} files` : `${s.results.length} file${s.results.length === 1 ? "" : "s"} contain “${esc(q)}” · ${s.results.reduce((n, r) => n + r.count, 0)} matches · ${s.total} files searched`;
    return bar + `<div class="fx-status">${status}</div><div class="fxlist cs">${s.results.map(r => `<div class="cs-res">
      <div class="fxline"><button class="fxrow file" style="--d:0" data-act="doc-find" data-path="${esc(r.path)}">${icon(isMd(r.name) ? "book" : "code", 15)}<span class="fxn">${esc(r.name)}</span><span class="fxp">${esc(r.path.split("/").slice(0, -1).join(" / "))}</span></button><span class="cs-n">${r.count}</span>${pinBtn(r.path)}</div>
      ${r.hits.map(h => `<button class="cs-hit" data-act="doc-find" data-path="${esc(r.path)}" data-line="${h.line}"><span class="cs-ln">${h.line}</span><span class="cs-t">${markText(h.text, q)}</span></button>`).join("")}
    </div>`).join("") || (s.running ? "" : `<div class="fx-msg">No files contain that.</div>`)}</div>`;
  }
  if (q) {
    const s = fx.search;
    if (!s || s.q !== q) { scheduleSearch(); return bar + `<div class="fx-msg">Searching…</div>`; }
    const rows = s.results.map(e => fileRow(e, 0, true)).join("");
    return bar + `<div class="fxlist">${rows || `<div class="fx-msg">${s.running ? "Searching…" : "No files match."}</div>`}</div>${s.capped ? `<div class="fx-msg">Showing the first 300 matches.</div>` : ""}`;
  }
  const asFile = p => ({ name: p.split("/").pop(), path: p, kind: "file" });
  const pins = own.data.pins || [], recent = fx.recent.filter(p => !pins.includes(p)).slice(0, 8);
  const quick = (pins.length || recent.length) ? `<div class="fx-quick">
    ${pins.length ? `<div class="fxq"><div class="fxq-h">${icon("star", 13)} Pinned</div><div class="fxlist">${pins.map(p => fileRow(asFile(p), 0, true)).join("")}</div></div>` : ""}
    ${recent.length ? `<div class="fxq"><div class="fxq-h">${icon("clock", 13)} Recent <button class="btn ghost small" data-act="fx-clear-recent">Clear</button></div><div class="fxlist">${recent.map(p => fileRow(asFile(p), 0, true)).join("")}</div></div>` : ""}
  </div>` : "";
  return bar + quick + `<div class="fxq-h">${icon("folder", 13)} All folders</div><div class="fxlist">${fxTree("", 0)}</div>`;
}
const pinBtn = path => { const on = (own.data?.pins || []).includes(path); return `<button class="fx-pin ${on ? "on" : ""}" data-act="pin" data-path="${esc(path)}" title="${on ? "Unpin" : "Pin"}">${icon("star", 14)}</button>`; };
function fxTree(path, depth) {
  const list = fx.cache.get(path);
  if (list === undefined) { loadDir(path); return `<div class="fx-msg" style="--d:${depth}">Loading…</div>`; }
  if (list.error) return `<div class="fx-msg" style="--d:${depth}">Couldn't read this folder: ${esc(list.error)}</div>`;
  const rows = list.filter(e => e.kind === "directory" || fx.all || isDoc(e.name)).map(e => {
    if (e.kind !== "directory") return fileRow(e, depth);
    const open = fx.open.has(e.path);
    return `<button class="fxrow dir ${open ? "open" : ""}" style="--d:${depth}" data-act="fx-dir" data-path="${esc(e.path)}">${icon("chevR", 13)}${icon(open ? "folderOpen" : "folder", 15)}<span class="fxn">${esc(e.name)}</span></button>${open ? fxTree(e.path, depth + 1) : ""}`;
  }).join("");
  return rows || `<div class="fx-msg" style="--d:${depth}">${list.length ? "No docs or scripts here (switch to All files)" : "Empty folder"}</div>`;
}
function fileRow(e, depth, showPath) {
  if (e.kind === "directory") return `<button class="fxrow dir" style="--d:0" data-act="fx-reveal" data-path="${esc(e.path)}">${icon("folder", 15)}<span class="fxn">${esc(e.name)}</span><span class="fxp">${esc(e.path)}</span></button>`;
  const ic = isMd(e.name) ? "book" : isDoc(e.name) ? "code" : "file";
  return `<div class="fxline"><button class="fxrow file ${ui.md?.path === e.path ? "on" : ""} ${isDoc(e.name) ? "" : "dim"}" style="--d:${depth}" data-act="doc" data-path="${esc(e.path)}">${showPath ? "" : `<span class="fx-sp"></span>`}${icon(ic, 15)}<span class="fxn">${esc(e.name)}</span>${showPath ? `<span class="fxp">${esc(e.path.split("/").slice(0, -1).join(" / ") || "Claude")}</span>` : `<span class="fxx">${esc(ext(e.name))}</span>`}</button>${pinBtn(e.path)}</div>`;
}

function renderArchive() {
  if (!arch.loaded) { loadArchive().then(softRender); return `<div class="fx-msg">Loading archive…</div>`; }
  if (arch.error) return `<div class="banner err"><p>${esc(arch.error)}</p></div>`;
  const live = new Set(own.data.items.map(i => i.id)), q = ui.q.toLowerCase();
  const items = arch.data.items.filter(i => !live.has(i.id) && (!q || [i.title, (i.tags || []).join(" "), ...(i.notes || []).map(n => n.text)].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (b.changed || "").localeCompare(a.changed || ""));
  const msgs = arch.data.inbox.filter(m => !q || [m.text, m.reply].join(" ").toLowerCase().includes(q)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const cutoff = addDays(today(), -ARCHIVE_DAYS), due = own.data.items.filter(i => oldDone(i, cutoff)).length + own.data.inbox.filter(m => oldMsg(m, cutoff)).length;
  const head = `<div class="fxbar"><span class="fx-status" style="margin:0">${arch.data.items.length} tasks and ${arch.data.inbox.length} inbox messages in <code>${esc(archiveName())}</code>${due ? ` · ${due} ready to archive` : ""}</span><span class="sp"></span>
    <button class="btn small" data-act="archive-now">${icon("archive", 14)} Archive now</button></div>`;
  const row = i => `<article class="item done arch" style="--sc:var(--s-done)"><span class="idea-ic">${icon("archive", 15)}</span><div class="body">
    <div class="row1"><span class="title" style="cursor:default">${esc(i.title)}</span><span class="nn">done ${esc(i.changed || "?")} · archived ${esc(i.archivedOn || "?")}</span></div>
    <div class="meta">${(i.tags || []).map(t => `<span class="tag static" style="--h:${hue(t)}">#${esc(t)}</span>`).join("")}${(i.notes || []).length ? `<span>${i.notes.length} note${i.notes.length > 1 ? "s" : ""}</span>` : ""}${linkHtml(i.link)}<span class="sp"></span><button class="btn ghost small" data-act="arch-restore" data-kind="item" data-id="${esc(i.id)}">Restore</button></div></div></article>`;
  const k = "archive:tasks", shut = ui.collapsed.has(k);
  return head + (items.length ? `<section class="group ${shut ? "shut" : ""}"><h2 class="group-h"><button class="gtoggle" data-act="collapse" data-v="${k}">${icon("chevD", 14)}<span class="gdot" style="--sc:var(--s-done)"></span>Archived tasks<span class="count">${items.length}</span></button></h2>${shut ? "" : items.map(row).join("")}</section>`
      : `<div class="empty">${icon("archive", 28)}<p>No archived tasks${q ? " match" : " yet"}. Done tasks move here ${ARCHIVE_DAYS} days after they were last changed.</p></div>`)
    + (msgs.length ? `<section class="group"><h2 class="group-h"><span class="gtoggle" style="cursor:default">${icon("msg", 14)}Archived inbox messages<span class="count">${msgs.length}</span></span></h2>${msgs.map(m => `<article class="card handled"><div class="card-h"><span class="pill">${esc(m.date)}</span><span class="sp"></span><button class="btn ghost small" data-act="arch-restore" data-kind="msg" data-id="${esc(m.id)}">Restore</button></div><div class="card-text">${esc(m.text)}</div>${m.reply ? `<div class="reply"><b>Claude</b>${esc(m.reply)}</div>` : ""}</article>`).join("")}</section>` : "");
}
function renderHistory() {
  if (hist.list === null) { loadHistory(); return `<div class="fx-msg">Loading snapshots…</div>`; }
  if (hist.error) return `<div class="banner err"><p>Couldn't read the history folder: ${esc(hist.error)}</p></div>`;
  const kb = n => n < 1024 ? n + " B" : (n / 1024).toFixed(1) + " KB";
  const total = hist.list.reduce((n, f) => n + f.size, 0);
  const head = `<div class="fxbar"><span class="fx-status" style="margin:0">${hist.list.length} snapshot${hist.list.length === 1 ? "" : "s"} in <code>Trackers/Tasks/${HISTORY_DIR}</code> · ${kb(total)} · old ones are kept until you delete them yourself</span><span class="sp"></span>
    <button class="btn small" data-act="snap-now">${icon("plus", 14)} Save a snapshot now</button></div>`;
  if (!hist.list.length) return head + `<div class="empty">${icon("clock", 28)}<p>No snapshots yet. One is saved automatically each day the page is opened.</p></div>`;
  return head + `<div class="fxlist">${hist.list.map(f => {
    const label = f.name.replace(fileBase() + "-", "").replace(/\.json$/, "");
    const [y, mo, d] = label.split("-"), when = y && d ? new Date(+y, +mo - 1, +d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : label;
    const extra = label.split("-").slice(3).join(" ").replace(/^(\d{2})(\d{2})/, "$1:$2");
    return `<div class="fxline hist"><span class="fxrow" style="--d:0;cursor:default">${icon("clock", 15)}<span class="fxn"><b>${esc(when)}</b>${extra ? ` <span class="hx">${esc(extra)}</span>` : ""}</span><span class="fxp">${esc(f.name)} · ${kb(f.size)}</span></span>
      ${mdRoot.dir && !mdRoot.needsReconnect ? `<button class="btn ghost small" data-act="doc" data-path="Trackers/Tasks/${HISTORY_DIR}/${esc(f.name)}">View</button>` : ""}
      ${ui.confirm === "h:" + f.name ? `<span class="confirm">Replace your current list with this one?</span><button class="btn danger small" data-act="snap-restore" data-v="${esc(f.name)}">Restore</button><button class="btn small" data-act="del-no">Cancel</button>`
        : `<button class="btn ghost small" data-act="del" data-id="h:${esc(f.name)}">Restore…</button>`}</div>`;
  }).join("")}</div><p class="hint" style="margin-top:12px">Restoring first saves your current list as a new snapshot, so a restore can itself be undone.</p>`;
}
function renderNotes(notes) {
  const q = ui.q.toLowerCase();
  const vis = notes.filter(n => !q || [n.title, n.text, (n.tags || []).join(" ")].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return `<div class="composer">
      <input class="c-title" id="n-title" placeholder="Note title" autocomplete="off">
      <textarea id="n-text" placeholder="Write a note…"></textarea>
      <div class="c-foot"><input id="n-tags" list="alltags" placeholder="Tags, comma separated" autocomplete="off"><button class="btn primary" data-act="add-note">Save note</button></div></div>
    ${vis.length ? vis.map(n => `<article class="card" id="note-card-${esc(n.id)}"><div class="card-h"><b class="card-t">${esc(n.title || "(untitled)")}</b><span class="pill">${esc(n.date)}</span>${ui.tagStyle === "hide" ? "" : (n.tags || []).map(tg => `<span class="tag static" style="--h:${hue(tg)}">#${esc(tg)}</span>`).join("")}
      <span class="sp"></span>${ui.confirm === n.id ? `<span class="confirm">Delete?</span><button class="btn danger small" data-act="del-note-yes" data-id="${esc(n.id)}">Delete</button><button class="btn small" data-act="del-no">Cancel</button>` : `<button class="btn ghost small danger-t" data-act="del" data-id="${esc(n.id)}">Delete</button>`}</div>
      <div class="card-text">${esc(n.text)}</div></article>`).join("") : `<div class="empty">${icon("note", 28)}<p>No notes yet.</p></div>`}`;
}
function renderInbox(inbox, items) {
  const title = id => allItems().find(i => i.id === id)?.title || id;
  const q = ui.q.toLowerCase();
  const vis = inbox.filter(m => !q || [m.text, m.reply].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (a.status === "handled") - (b.status === "handled") || (b.date || "").localeCompare(a.date || ""));
  return `<div class="composer">
      <textarea id="m-text" placeholder="What should Claude do or know?"></textarea>
      <div class="c-foot"><label class="c-about">About<select id="m-about" autocomplete="off"><option value="">(no specific task)</option>${allItems().filter(i => !i._ro && i.status !== "done").map(i => `<option value="${esc(i.id)}" ${ui.askAbout === i.id ? "selected" : ""}>${isIdea(i) ? "Idea: " : ""}${esc(i.title)}</option>`).join("")}</select></label>
      <button class="btn primary" data-act="add-msg">Send to Claude</button></div></div>
    ${vis.length ? `<div class="thread">${vis.map(m => `<article class="msg ${m.status === "handled" ? "handled" : ""}">
      <div class="mrow"><span class="av">B</span><div class="nb"><div class="nw"><b>Barrett</b><span>${esc(m.date)}</span>${m.about ? `<span>re: <button class="lk" data-act="goto" data-id="${esc(m.about)}">${esc(title(m.about))}</button></span>` : ""}<span class="pill ${m.status === "handled" ? "" : "new"}">${m.status === "handled" ? "Handled" : "Waiting"}</span><span class="sp"></span>
        <button class="btn ghost small" data-act="msg-toggle" data-id="${esc(m.id)}">${m.status === "handled" ? "Reopen" : "Mark handled"}</button>
        ${ui.confirm === m.id ? `<span class="confirm">Delete?</span><button class="btn danger small" data-act="del-msg-yes" data-id="${esc(m.id)}">Delete</button><button class="btn small" data-act="del-no">Cancel</button>` : `<button class="btn ghost small danger-t" data-act="del" data-id="${esc(m.id)}">Delete</button>`}</div><p>${esc(m.text)}</p></div></div>
      ${m.reply ? `<div class="mrow"><span class="av c">C</span><div class="nb"><div class="nw"><b>Claude</b><span>${esc(m.replied || "")}</span></div><p>${esc(m.reply)}</p></div></div>` : ""}</article>`).join("")}</div>`
    : `<div class="empty">${icon("inbox", 28)}<p>Nothing for Claude yet. Messages you send here, or with “For Claude” on a task, show up in this thread.</p></div>`}`;
}

function mdPanel() {
  const m = ui.md;
  if (!m) return `<aside class="mdpanel"></aside>`;
  const parts = m.path.split("/"), file = parts.pop();
  let body;
  if (m.state === "loading") body = `<p class="md-msg">Loading…</p>`;
  else if (m.state === "noroot") body = `<div class="md-msg"><p>To show files here, give the page <b>read-only</b> access to your <b>Claude</b> folder (<code>Data Stuff/Claude</code>), two levels above Trackers/Tasks. It can't change anything there.</p><button class="btn primary" data-act="md-root">${icon("folder", 15)} Connect Claude folder</button></div>`;
  else if (m.state === "reconnect") body = `<div class="md-msg"><p>Chrome needs your OK to read the Claude folder again.</p><button class="btn primary" data-act="md-reconnect">Reconnect</button></div>`;
  else if (m.state === "error") body = `<div class="md-msg"><p>${esc(m.error)}</p><button class="btn" data-act="md-root">Pick the Claude folder again</button></div>`;
  else body = (m.truncated ? `<p class="md-msg">Large file: showing the first ${Math.round(MAX_VIEW_BYTES / 1000)} KB.</p>` : "") + (isMd(file) ? `<div class="markdown">${mdHtml(m.text)}</div>` : codeHtml(m.text));
  const sizeBtn = (s, ic, label) => `<button class="icon-btn ${ui.mdSize === s ? "on" : ""}" data-act="md-size" data-v="${s}" title="${label}">${icon(ic)}</button>`;
  return `<aside class="mdpanel"><div class="md-inner">
    <div class="md-head"><div class="md-ic">${icon(isMd(file) ? "book" : "code", 16)}</div><div class="md-t"><div class="md-title">${esc(file)}</div><div class="md-path">${esc(parts.join(" / ") || "Claude")}${m.changed ? " · edited " + esc(m.changed) : ""}</div></div>
    ${m.state === "ok" && !m.virtual ? pinBtn(m.path) : ""}
    <div class="md-sizes">${ui.mdSize === "normal" ? sizeBtn("wide", "widen", "Wider") : sizeBtn("normal", "narrow", "Narrower")}${ui.mdSize === "full" ? sizeBtn("wide", "unfull", "Exit full width") : sizeBtn("full", "full", "Full width")}</div>
    <button class="icon-btn" data-act="md-close" title="Close (Esc)">${icon("x")}</button></div>
    ${m.state === "ok" && m.find ? `<div class="md-find">${icon("search", 13)}<span>“${esc(m.find)}”</span><span class="mf-n"></span><button class="btn ghost small" data-act="md-find-prev" title="Previous match">${icon("up", 13)}</button><button class="btn ghost small" data-act="md-find-next" title="Next match">${icon("chevD", 13)}</button><button class="icon-btn" data-act="md-find-clear" title="Clear highlight">${icon("x", 13)}</button></div>` : ""}
    <div class="md-body ${isMd(file) ? "" : "is-code"}">${body}</div></div></aside>`;
}

/* ---------- Today ---------- */
function renderToday(tasks) {
  const t = today(), horizon = addDays(t, 7);
  const act = tasks.filter(i => i.status !== "done" && tagOk(i) && matchesQ(i));
  const used = new Set();
  const take = (f, sort = byPrio) => act.filter(i => !used.has(i.id) && f(i)).sort(sort).map(i => (used.add(i.id), i));
  const firstDate = i => [i.day, i.due].filter(x => x && x > t).sort()[0] || "9999";
  const attention = take(i => (i.due && i.due < t) || (i.day && i.day < t));
  const todays = take(i => i.day === t || i.due === t);
  const soon = take(i => firstDate(i) <= horizon, (a, b) => firstDate(a).localeCompare(firstDate(b)) || byPrio(a, b));
  const prog = take(i => i.status === "in progress");
  const replies = own.data.inbox.filter(m => m.status === "handled" && m.reply && !m.seen);
  const waiting = own.data.inbox.filter(m => m.status !== "handled").length;
  const doneToday = tasks.filter(i => i.status === "done" && i.changed === t).length;
  const weekStart = addDays(t, -parseYmd(t).getDay()), weekEnd = addDays(weekStart, 13);
  const fmtShort = s => parseYmd(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const unplanned = tasks.filter(i => i.status !== "done" && tagOk(i) && !i.day && !i.due).length;
  const stripHead = `<div class="strip-h"><b>This week and next</b><span>${esc(fmtShort(weekStart))} – ${esc(fmtShort(weekEnd))}</span><span class="sp"></span>
    <span class="lg"><i></i>planned</span><span class="lg due"><i></i>due</span>
    ${unplanned ? `<button class="lk" data-act="strip-day" data-v="${t}" data-cal="week" title="The calendar lists unscheduled tasks under the week">${unplanned} not scheduled</button>` : ""}</div>`;
  const live = tasks.filter(i => i.status !== "done" && tagOk(i));
  const strip = stripHead + `<div class="strip">${[0, 7].map(off => {
    const wk = [...Array(7)].map((_, k) => addDays(weekStart, off + k));
    return weekRow(wk, live.filter(i => wk.some(d => onDay(i, d))), {
      cls: "wk-strip", max: 4,
      cellCls: d => d === t ? "today" : d < t ? "past" : "",
      head: (d, n) => { const dt = parseYmd(d); return `<button class="sdn" data-act="strip-day" data-v="${d}" title="Open this day in the calendar"><b>${dt.getDate()}</b>${dt.toLocaleDateString("en-US", { weekday: "short" })}${n ? `<span class="sn">${n}</span>` : ""}</button>`; },
      bar: (i, sg) => `<button class="sev ${sg.kind === "due" ? "due" : ""}" data-act="sel" data-id="${esc(i.id)}" title="${esc(i.title)}${sg.kind === "span" ? ` · ${esc(fmtShort(i.day))} → due ${esc(fmtShort(i.due))}` : ""}"><i></i><span>${esc(i.title)}</span></button>`,
      more: (d, n) => `<span class="smore">+${n} more</span>`
    });
  }).join("")}</div>`;
  const st = (n, label, cls = "") => `<span class="${cls} ${n ? "" : "z"}"><b>${n}</b>${label}</span>`;
  const line = `<div class="tline">${st(attention.length, "need attention", "att")}${st(todays.length, "for today")}${st(prog.length, "in progress")}${st(soon.length, "in the next 7 days")}${st(doneToday, "done today")}</div>`;
  const title = id => allItems().find(i => i.id === id)?.title;
  const repl = replies.length ? `<section class="group"><div class="gh static"><h2>From Claude</h2><span class="count">${replies.length}</span></div><div class="activity replies">
    ${replies.map(m => `<div class="note"><span class="av c">C</span><div class="nb"><div class="nw"><b>Claude</b><span>${esc(m.replied || m.date)}</span>${m.about && title(m.about) ? `<span>re: <button class="lk" data-act="sel" data-id="${esc(m.about)}">${esc(title(m.about))}</button></span>` : ""}<span class="sp"></span><button class="btn ghost small" data-act="seen" data-id="${esc(m.id)}">Got it</button></div>
      <p class="q">${esc(m.text)}</p><p>${esc(m.reply)}</p></div></div>`).join("")}</div></section>` : "";
  const wait = waiting ? `<div class="banner soft">${icon("inbox", 15)} ${waiting} message${waiting > 1 ? "s" : ""} waiting for Claude. In Claude Code, say <b>"check the tracker inbox"</b>.</div>` : "";
  const sec = (key, name, list, hint) => list.length ? groupSection("today:" + key, name, "", list, { today: true, hint }) : "";
  const body = sec("attention", "Needs attention", attention, "overdue, or planned for a day that has passed")
    + sec("today", "Today", todays)
    + sec("soon", "Coming up", soon, "planned or due in the next 7 days")
    + sec("progress", "In progress", prog);
  return strip + line + wait + repl + (body || (repl ? "" : `<div class="empty">${icon("sun", 30)}<p>All clear. Nothing overdue, planned or due soon.</p></div>`));
}

/* ---------- Phone layout (v0.07, 2026-11-16): prototype B "Agenda" ----------
   Up to 640 px wide, render() swaps the sidebar, window and inspector for one column: a header switch
   (Agenda / Ideas / For Claude), a 7-day load chart, every task in one list by day, and one full-screen
   editor used both to add and to edit tasks and ideas. Same data and the same mutate(); an edit writes
   only the fields that changed since the editor opened, and new notes are appended to the fresh copy. */
const PHONE = matchMedia("(max-width: 640px)");
PHONE.addEventListener?.("change", () => render());
const ph = { seg: "agenda", search: false, doneOpen: false, ed: null };
const PH_FIELDS = ["title", "status", "priority", "tags", "day", "due", "repeat", "kind", "checklist"];
const clone = o => JSON.parse(JSON.stringify(o));

function phDay(s) {
  const t = today(), d = parseYmd(s), n = Math.round((d - parseYmd(t)) / 864e5);
  if (n === 0) return "Today"; if (n === 1) return "Tomorrow"; if (n === -1) return "Yesterday";
  return n > 1 && n < 7 ? d.toLocaleDateString("en-US", { weekday: "short" }) + " " + d.getDate() : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const phLow = s => /^(Today|Tomorrow|Yesterday)$/.test(s) ? s.toLowerCase() : s;
const phTag = t => `<span class="ph-tag" style="--h:${hue(t)}">${esc(t)}</span>`;
function phWhen(i, noDay) {
  if (i.status === "done" || isIdea(i)) return "";
  const t = today();
  if (i.due && i.due < t) { const n = Math.round((parseYmd(t) - parseYmd(i.due)) / 864e5); return `<span class="ph-when due">Overdue ${n} day${n === 1 ? "" : "s"}</span>`; }
  if (i.due === t) return `<span class="ph-when due">Due today</span>`;
  const p = [];
  if (!noDay && i.day) p.push(i.day < t ? "planned " + phLow(phDay(i.day)) : phDay(i.day));
  if (i.due) p.push("due " + phLow(phDay(i.due)));
  if (i.repeat) p.push((REPEATS[i.repeat] || i.repeat).toLowerCase());
  return p.length ? `<span class="ph-when ${i.day && i.day < t ? "due" : ""}">${esc(cap(p.join(", ")))}</span>` : "";
}
const phSteps = i => (i.checklist || []).length ? `<span class="ph-steps">${icon("list", 13)}${i.checklist.filter(c => c.done).length}/${i.checklist.length}</span>` : "";
function phRow(i, o = {}) {
  const done = i.status === "done", id = esc(i.id);
  const st = !["open", "done"].includes(i.status) ? `<span class="ph-st"><i class="ph-dot" style="--c:${sc(i.status)}"></i>${esc(cap(i.status))}</span>` : "";
  return `<div class="ph-row ${done ? "done" : ""}">
    <button class="ph-check" data-act="toggle" data-id="${id}" ${i._ro ? "disabled" : ""} aria-label="${done ? "Mark not done" : "Mark done"}: ${esc(i.title)}">${icon("check", 13)}</button>
    <button class="ph-body" data-act="ph-open" data-id="${id}"><span class="ph-t">${esc(i.title)}</span><span class="ph-m">${(i.tags || []).map(phTag).join("")}${st}${phWhen(i, o.noDay)}${phSteps(i)}${i._ro ? `<span class="ph-src">${esc(i._src)}</span>` : ""}</span></button>
    <span>${i.priority === "high" && !done ? '<i class="ph-hi" title="High priority"></i>' : ""}</span></div>`;
}
function phSec(key, title, sub, list, o = {}) {
  if (!list.length) return "";
  return `<section class="ph-sec" id="ph-${key}"><div class="ph-sh"><h2 class="${o.late ? "late" : ""}">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</h2><span>${list.length}</span></div>${list.map(i => phRow(i, o)).join("")}</section>`;
}
function phAgenda() {
  const t = today(), tasks = allItems().filter(i => !isIdea(i));
  const live = tasks.filter(i => i.status !== "done" && matchesQ(i));
  const isLate = i => (i.due && i.due < t) || (i.day && i.day < t);
  const late = live.filter(isLate).sort(byPrio), rest = live.filter(i => !isLate(i));
  const anchor = i => i.day || i.due || "";
  const days = [...Array(7)].map((_, n) => addDays(t, n));
  const on = s => rest.filter(i => anchor(i) === s).sort(byPrio);
  const counts = days.map((s, n) => ({ s, n, c: on(s).length, late: n === 0 ? late.length : 0 }));
  const max = Math.max(4, ...counts.map(x => x.c + x.late));
  const load = ui.q ? "" : `<div class="ph-load" aria-label="Next 7 days">${counts.map(({ s, n, c, late: l }) =>
    `<button class="ph-ld ${n === 0 ? "today" : ""}" data-act="ph-jump" data-v="ph-d${n}" aria-label="${esc(fmtDay(s))}: ${c + l} tasks"><b>${c + l}</b><span class="ph-bar">${l ? `<i class="late" style="height:${l / max * 100}%"></i>` : ""}<i style="height:${c / max * 100}%"></i></span><small>${n === 0 ? "Today" : esc(parseYmd(s).toLocaleDateString("en-US", { weekday: "short" }))}</small></button>`).join("")}</div>`;
  let html = phSec("late", "Overdue", "", late, { late: true });
  days.forEach((s, n) => { const d = parseYmd(s); html += phSec("d" + n, n < 2 ? phDay(s) : d.toLocaleDateString("en-US", { weekday: "long" }), d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), on(s), { noDay: true }); });
  html += phSec("later", "Later", "", rest.filter(i => anchor(i) > days[6]).sort((a, b) => anchor(a).localeCompare(anchor(b))));
  html += phSec("nodate", "No date", "", rest.filter(i => !anchor(i)).sort(byPrio));
  const done = tasks.filter(i => i.status === "done" && matchesQ(i)).sort((a, b) => (b.changed || "").localeCompare(a.changed || ""));
  if (done.length) html += `<section class="ph-sec"><button class="ph-sh ph-fold" data-act="ph-done" aria-expanded="${ph.doneOpen}"><h2>Done</h2><span>${done.length} ${icon(ph.doneOpen ? "up" : "chevD", 14)}</span></button>${ph.doneOpen ? done.map(i => phRow(i)).join("") : ""}</section>`;
  if (!live.length && !done.length) html += ui.q ? `<p class="ph-empty"><b>No tasks match “${esc(ui.q)}”.</b>Try a shorter word.</p>` : `<p class="ph-empty"><b>All clear.</b>Tap + to add a task.</p>`;
  return banners() + load + html;
}
function phIdeas() {
  const list = allItems().filter(i => isIdea(i) && matchesQ(i)).sort((a, b) => (b.changed || "").localeCompare(a.changed || "") || a.title.localeCompare(b.title));
  if (!list.length) return banners() + `<p class="ph-empty"><b>${ui.q ? `No ideas match “${esc(ui.q)}”.` : "No ideas yet."}</b>${ui.q ? "Try a shorter word." : "Tap + to save one. Ideas stay here until you make them tasks."}</p>`;
  return banners() + `<div class="ph-sh"><h2>Ideas</h2><span>${list.length}</span></div>` + list.map(i =>
    `<button class="ph-idea" data-act="ph-open" data-id="${esc(i.id)}"><span class="ph-t">${esc(i.title)}</span>${(i.notes || []).length ? `<p>${esc(i.notes[0].text)}</p>` : ""}<span class="ph-m">${(i.tags || []).map(phTag).join("")}${phSteps(i)}</span></button>`).join("")
    + `<p class="ph-empty">Open an idea and switch its type to Task when you're ready to do it.</p>`;
}
function phInbox() {
  const title = id => allItems().find(i => i.id === id)?.title;
  const q = ui.q.toLowerCase();
  const msgs = own.data.inbox.filter(m => !q || [m.text, m.reply].join(" ").toLowerCase().includes(q))
    .sort((a, b) => (a.status === "handled") - (b.status === "handled") || (b.date || "").localeCompare(a.date || ""));
  const opts = allItems().filter(i => !i._ro && i.status !== "done").map(i => `<option value="${esc(i.id)}">${isIdea(i) ? "Idea: " : ""}${esc(i.title)}</option>`).join("");
  return banners() + `<div class="ph-compose"><label for="m-text">Message Claude</label><textarea id="m-text" placeholder="Ask something or leave a note for the next session"></textarea>
      <select id="m-about" aria-label="About a task" autocomplete="off"><option value="">Not about a specific task</option>${opts}</select>
      <div class="ph-row-end"><span class="ph-hint">Claude reads these when you say “check the tracker inbox”.</span><button class="ph-btn" data-act="add-msg">Send to Claude</button></div></div>`
    + (msgs.length ? msgs.map(m => `<article class="ph-msg"><div class="ph-msg-top"><span>${esc(m.date || "")}${m.about && title(m.about) ? ` · re: ${esc(title(m.about))}` : ""}</span>${m.status === "handled" ? "<span>Answered</span>" : '<span class="ph-new">Waiting</span>'}</div><p>${esc(m.text)}</p>${m.reply ? `<div class="ph-reply"><b>Claude</b>${esc(m.reply)}</div>` : ""}</article>`).join("")
      : `<p class="ph-empty">Nothing for Claude yet.</p>`);
}
function phoneHtml() {
  const nNew = own.data.inbox.filter(m => m.status !== "handled").length;
  const head = { agenda: "Tasks", ideas: "Ideas", claude: "For Claude" }[ph.seg];
  const body = ph.seg === "ideas" ? phIdeas() : ph.seg === "claude" ? phInbox() : phAgenda();
  return `<header class="ph-hdr">
      <div class="ph-top"><h1>${head}</h1><button class="ph-hbtn" data-act="ph-search" aria-pressed="${ph.search}" aria-label="Search">${icon("search", 18)}</button><button class="ph-hbtn" data-act="theme" aria-label="Switch light and dark">${icon(isDark() ? "sun" : "moon", 17)}</button></div>
      ${ph.search ? `<input id="q" class="ph-q" type="search" placeholder="Search" value="${esc(ui.q)}" autocomplete="off" aria-label="Search">` : ""}
      <div class="ph-seg" role="group" aria-label="Show">${[["agenda", "Agenda"], ["ideas", "Ideas"], ["claude", "For Claude"]].map(([k, l]) => `<button data-act="ph-seg" data-v="${k}" aria-pressed="${ph.seg === k}">${l}${k === "claude" && nNew ? `<span class="ph-n">${nNew}</span>` : ""}</button>`).join("")}</div>
    </header>
    <main class="ph-view">${body}</main>
    ${ph.seg !== "claude" ? `<button class="ph-fab" data-act="ph-add" aria-label="${ph.seg === "ideas" ? "Add idea" : "Add task"}">${icon("plus", 24)}</button>` : ""}
    ${ph.ed ? `<section class="ph-sheet ${ph.ed.anim ? "enter" : ""}" role="dialog" aria-modal="true" aria-label="${esc(phEdTitle())}">${phEditor()}</section>` : ""}`;
}

/* Editor: one screen for adding and editing. Chip taps change the working copy in place; adding a step, note or tag re-renders. */
const phEdTitle = () => `${ph.ed.mode === "add" ? "New" : "Edit"} ${isIdea(ph.ed.d) ? "idea" : "task"}`;
function phChips(f, opts, cur, label) {
  return `<div class="ph-chips" role="group" aria-label="${label}">${opts.map(([v, l, dot]) =>
    `<button type="button" class="ph-chip" data-act="ed" data-f="${f}" data-v="${esc(v)}" aria-pressed="${v === cur}">${dot ? `<i class="ph-dot" style="--c:${sc(v)}"></i>` : ""}${esc(l)}</button>`).join("")}</div>`;
}
function phDateField(f, none) {
  const t = today(), days = [...Array(7)].map((_, n) => addDays(t, n)), cur = ph.ed.d[f] || "", other = cur && !days.includes(cur);
  return phChips(f, [...days.map(s => [s, phDay(s)]), ["", none]], cur, f === "day" ? "Do on" : "Due")
    + `<label class="ph-other">Other date <input type="date" data-ed-date="${f}" value="${other ? esc(cur) : ""}" autocomplete="off"></label>`;
}
function phEditor() {
  const e = ph.ed, d = e.d, idea = isIdea(d), add = e.mode === "add", cl = d.checklist || [];
  const tags = [...new Set([...allItems().flatMap(i => i.tags || []), ...(d.tags || [])])].sort();
  const blk = (h, inner, cls = "") => `<div class="ph-field ${cls}"><h3>${h}</h3>${inner}</div>`;
  return `<div class="ph-edbar"><button class="ph-cancel" data-act="ed-cancel">Cancel</button><h2>${esc(phEdTitle())}</h2><button class="ph-btn" data-act="ed-save">${add ? "Add" : "Save"}</button></div>
    <div class="ph-ed-body">
      <div class="ph-field"><input id="ed-title" class="ph-title" data-ed-text="title" value="${esc(d.title)}" placeholder="${idea ? "What's the idea?" : "What needs doing?"}" aria-label="Title" autocomplete="off">${e.err ? `<p class="ph-err">Add a title to save it.</p>` : ""}</div>
      ${blk("Type", phChips("kind", [["task", "Task"], ["idea", "Idea"]], idea ? "idea" : "task", "Type"))}
      ${idea ? "" : blk("Status", phChips("status", STATUSES.map(s => [s, cap(s), 1]), d.status, "Status"))}
      ${idea ? "" : blk("Do on", phDateField("day", "No date"))}
      ${idea ? "" : blk("Due", phDateField("due", "No deadline"))}
      ${idea ? "" : blk("Priority", phChips("priority", PRIOS.map(p => [p, cap(p)]), d.priority || "normal", "Priority"))}
      ${idea ? "" : blk("Repeats", `<select class="ph-select" data-ed="repeat" aria-label="Repeats" autocomplete="off">${Object.entries(REPEATS).map(([k, v]) => `<option value="${k}" ${(d.repeat || "") === k ? "selected" : ""}>${v}</option>`).join("")}</select>`)}
      ${blk("Tags", `<div class="ph-chips ph-wrap" role="group" aria-label="Tags">${tags.map(t => `<button type="button" class="ph-chip" data-act="ed-tag" data-v="${esc(t)}" aria-pressed="${(d.tags || []).includes(t)}">${esc(t)}</button>`).join("")}<button type="button" class="ph-chip ph-newtag" data-act="ed-newtag">+ New tag</button></div>
        ${e.tagOpen ? `<div class="ph-inline"><input id="ed-tagname" data-ed-text="tag" value="${esc(e.tag)}" placeholder="New tag name" aria-label="New tag name" autocomplete="off" maxlength="30"><button class="ph-btn quiet" data-act="ed-addtag">Add</button></div>` : ""}`)}
      ${blk(`Checklist${cl.length ? `<span>${cl.filter(c => c.done).length} of ${cl.length}</span>` : ""}`,
        (cl.length ? cl.map((c, k) => `<div class="ph-step ${c.done ? "done" : ""}"><button class="ph-box" data-act="ed-stoggle" data-k="${k}" aria-pressed="${!!c.done}" aria-label="Done: ${esc(c.text)}">${icon("check", 11)}</button><span>${esc(c.text)}</span><button class="ph-rm" data-act="ed-rmstep" data-k="${k}" aria-label="Remove step: ${esc(c.text)}">${icon("x", 14)}</button></div>`).join("") : `<p class="ph-none">No steps yet.</p>`)
        + `<div class="ph-inline"><input id="ed-step" data-ed-text="step" value="${esc(e.step)}" placeholder="Add a step" aria-label="Add a step" autocomplete="off"><button class="ph-btn quiet" data-act="ed-addstep">Add</button></div>`)}
      ${blk("Notes", ((d.notes || []).length ? d.notes.map(n => `<div class="ph-note ${n.by === "Claude" ? "c" : ""}"><b>${esc(n.by || "Note")}${n.date ? `<span>${esc(n.date)}</span>` : ""}</b>${esc(n.text)}</div>`).join("") : `<p class="ph-none">No notes yet.</p>`)
        + `<div class="ph-inline"><input id="ed-note" data-ed-text="note" value="${esc(e.note)}" placeholder="Add a note" aria-label="Add a note" autocomplete="off"><button class="ph-btn quiet" data-act="ed-addnote">Add</button></div>`)}
      ${d.link ? blk("Linked file", `<p class="ph-none">${esc(d.link)}</p>`) : ""}
      ${add ? "" : `<p class="ph-stamp">Added ${esc(d.added || "?")}, changed ${esc(d.changed || "?")}</p>`}
    </div>`;
}
function phOpen(mode, it, idea = false) {
  const d = it ? clone(it) : { title: "", status: "open", priority: "normal", tags: [], day: idea ? "" : today(), due: "", checklist: [], notes: [], link: "" };
  if (!it && idea) d.kind = "idea";
  delete d._ro; delete d._src;
  ph.ed = { mode, id: it?.id, orig: clone(d), d, step: "", note: "", tag: "", tagOpen: false, err: false, anim: true };
  render();
  if (mode === "add") setTimeout(() => $("#ed-title")?.focus(), 320);
}
function phRefocus(sel) { render(); const el = $(sel); if (el) { el.focus(); el.scrollIntoView({ block: "nearest" }); } }
function phAddStep() { const e = ph.ed, v = e.step.trim(); if (!v) return $("#ed-step")?.focus(); (e.d.checklist ??= []).push({ text: v, done: false }); e.step = ""; phRefocus("#ed-step"); }
function phAddNote() { const e = ph.ed, v = e.note.trim(); if (!v) return $("#ed-note")?.focus(); (e.d.notes ??= []).push({ date: today(), by: "Barrett", text: v }); e.note = ""; phRefocus("#ed-note"); }
function phAddTag() { const e = ph.ed, t = parseTags(e.tag); if (!t.length) return $("#ed-tagname")?.focus(); e.d.tags = [...new Set([...(e.d.tags || []), ...t])]; e.tag = ""; e.tagOpen = false; render(); }
function phSave() {
  const e = ph.ed, d = e.d;
  d.title = (d.title || "").trim();
  if (!d.title) { e.err = true; return phRefocus("#ed-title"); }
  if (e.step.trim()) (d.checklist ??= []).push({ text: e.step.trim(), done: false });
  if (e.note.trim()) (d.notes ??= []).push({ date: today(), by: "Barrett", text: e.note.trim() });
  if (e.tag.trim()) d.tags = [...new Set([...(d.tags || []), ...parseTags(e.tag)])];
  const idea = isIdea(d);
  ph.ed = null;
  if (e.mode === "add") {
    const item = { id: uid("i"), title: d.title, status: idea ? "open" : d.status, tags: d.tags || [], priority: idea ? "normal" : d.priority, day: idea ? "" : d.day, due: idea ? "" : d.due, link: "", notes: d.notes || [], added: today(), changed: today() };
    if ((d.checklist || []).length) item.checklist = d.checklist;
    if (idea) item.kind = "idea";
    else if (d.repeat) { item.repeat = d.repeat; if (!item.due && !item.day) item.due = today(); }
    let msg = idea ? "Idea added" : "Task added";
    return mutate(x => { x.items.push(item); if (!idea && item.status === "done") msg = completeItem(x, item); }, null)
      .then(() => { if (own.data?.items.some(i => i.id === item.id)) showUndo({ fn: x => { x.items = x.items.filter(i => i.id !== item.id && i.id !== item.repeatedTo); } }, msg); });
  }
  const o = e.orig, same = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");
  const changed = PH_FIELDS.filter(f => !same(d[f], o[f]));
  const newNotes = (d.notes || []).slice((o.notes || []).length);
  if (!changed.length && !newNotes.length) return render();
  let before = null, msg = "Saved";
  return mutate(x => {
    const i = findItem(x, e.id); if (!i) { msg = "Not saved: that item is gone from the file"; return; }
    before = clone(i);
    for (const f of changed) {
      if (f === "status" && d.status === "done" && i.status !== "done") continue; // handled below so repeats work
      if (d[f] === undefined || ((f === "repeat" || f === "kind") && !d[f])) delete i[f]; else i[f] = clone(d[f]);
    }
    if (changed.includes("kind")) { msg = isIdea(i) ? "Moved to Ideas" : "Moved to Tasks"; if (!isIdea(i) && !i.status) i.status = "open"; }
    if (i.repeat && !i.due && !i.day) i.due = today();
    if (newNotes.length) (i.notes ??= []).push(...newNotes);
    touch(i);
    if (changed.includes("status") && d.status === "done" && i.status !== "done" && !isIdea(i)) msg = completeItem(x, i);
  }, null).then(() => {
    if (!before) return toast(msg);
    const b = before;
    showUndo({ fn: x => { const k = x.items.findIndex(i => i.id === b.id); if (k < 0) return; const nx = x.items[k].repeatedTo; x.items[k] = b; if (nx && nx !== b.repeatedTo) x.items = x.items.filter(i => i.id !== nx); } }, msg);
  });
}

/* ---------- Quick jump (Cmd/Ctrl-K) ---------- */
function openPalette() { ui.pal = { q: "", sel: 0, results: [] }; ui.pop = null; render(); buildIndex(); }
function paletteResults(q) {
  const ql = q.trim().toLowerCase(), out = [];
  const score = s => { s = (s || "").toLowerCase(); if (!ql) return 1; const k = s.indexOf(ql); return k < 0 ? 0 : k === 0 ? 3 : /[\s\/_-]/.test(s[k - 1]) ? 2 : 1; };
  const views = [["today", "Today", "sun"], ["list", "Tasks", "list"], ["cal", "Calendar", "calendar"], ["ideas", "Ideas", "bulb"], ["notes", "Notes", "note"], ["files", "Files", "folder"], ["inbox", "For Claude", "msg"]];
  const cmds = [{ type: "new", label: "New task", ic: "plus", hint: "N" }, { type: "newidea", label: "New idea", ic: "bulb" }, ...views.map(([v, l, ic]) => ({ type: "go", v, label: "Go to " + l, ic }))];
  const add = (list, max) => list.filter(r => r._s > 0).sort((a, b) => b._s - a._s).slice(0, max).forEach(r => out.push(r));
  const all = allItems();
  if (!ql) {
    add((own.data?.pins || []).map(p => ({ type: "file", path: p, label: p.split("/").pop(), sub: p.split("/").slice(0, -1).join(" / "), ic: isMd(p) ? "book" : "code", group: "Pinned files", _s: 1 })), 8);
    add(cmds.map(c => ({ ...c, group: "Actions", _s: 1 })), 9);
    add(all.filter(i => !isIdea(i) && i.status !== "done").sort((a, b) => (b.changed || "").localeCompare(a.changed || "")).slice(0, 6).map(i => ({ type: "item", item: i, label: i.title, ic: "list", group: "Recently changed", _s: 1 })), 6);
    return out;
  }
  add(all.filter(i => !isIdea(i)).map(i => ({ type: "item", item: i, label: i.title, ic: i.status === "done" ? "check" : "list", group: "Tasks", _s: Math.max(score(i.title) * 2, score((i.tags || []).join(" "))) })), 8);
  add(all.filter(isIdea).map(i => ({ type: "item", item: i, label: i.title, ic: "bulb", group: "Ideas", _s: score(i.title) })), 5);
  add((own.data?.notes || []).map(n => ({ type: "note", note: n, label: n.title || n.text.slice(0, 60), ic: "note", group: "Notes", _s: Math.max(score(n.title) * 2, score(n.text)) })), 5);
  add((fx.index || []).map(f => ({ type: "file", path: f.path, label: f.name, sub: f.path.split("/").slice(0, -1).join(" / "), ic: isMd(f.name) ? "book" : "code", group: "Files", _s: score(f.name) * 2 || score(f.path) })), 8);
  add(cmds.map(c => ({ ...c, group: "Actions", _s: score(c.label) })), 4);
  return out;
}
function paletteList() {
  const p = ui.pal; p.results = paletteResults(p.q);
  if (p.sel >= p.results.length) p.sel = 0;
  let last = "";
  const rows = p.results.map((r, k) => {
    const head = r.group && r.group !== last ? `<div class="pal-g">${esc(r.group)}</div>` : ""; last = r.group || last;
    const sub = r.type === "item" ? (r.item.status && !isIdea(r.item) ? r.item.status : "") : r.sub || "";
    return head + `<button class="pal-r ${k === p.sel ? "sel" : ""}" data-act="pal-go" data-k="${k}">${icon(r.ic, 15)}<span class="pal-l">${esc(r.label)}</span>${sub ? `<span class="pal-s">${esc(sub)}</span>` : ""}${r.hint ? `<kbd>${r.hint}</kbd>` : ""}</button>`;
  }).join("");
  const filesNote = !mdRoot.dir ? "Connect the Claude folder (Files page) to search files too." : fx.indexing ? "Indexing files…" : "";
  return (rows || `<div class="pal-empty">No matches.</div>`) + (filesNote ? `<div class="pal-foot">${filesNote}</div>` : "");
}
function updatePalette() {
  const box = $("#pal-res"); if (!box || !ui.pal) return;
  box.innerHTML = paletteList();
  box.querySelector(".pal-r.sel")?.scrollIntoView({ block: "nearest" });
}
function paletteHtml() {
  return `<div class="pal-back" data-act="pal-close"><div class="pal" role="dialog" aria-label="Jump to">
    <div class="pal-in">${icon("search", 16)}<input id="pal-q" placeholder="Jump to a task, idea, note or file…" value="${esc(ui.pal.q)}" autocomplete="off" spellcheck="false"><kbd class="pal-x" data-act="pal-close">esc</kbd></div>
    <div class="pal-res" id="pal-res">${paletteList()}</div>
    <div class="pal-keys"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div></div></div>`;
}
function runPalette(k) {
  const r = ui.pal?.results?.[k]; if (!r) return;
  ui.pal = null; ui.q = ""; fx.search = null;
  if (r.type === "go") { ui.view = r.v; saveUi(); return render(); }
  if (r.type === "new" || r.type === "newidea") { ui.view = r.type === "new" ? (["today", "list", "cal"].includes(ui.view) ? ui.view : "list") : "ideas"; ui.pop = "new"; render(); return $(".nf-title")?.focus(); }
  if (r.type === "file") { render(); return openDoc(r.path); }
  if (r.type === "note") { ui.view = "notes"; render(); return document.getElementById("note-card-" + r.note.id)?.scrollIntoView({ block: "center", behavior: "smooth" }); }
  const i = r.item; ui.view = isIdea(i) ? "ideas" : "list"; if (i.status === "done") ui.showDone = true;
  ui.sel = i.id; ui.confirm = null; saveUi(); render();
  document.getElementById("item-" + i.id)?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/* ---------- Events ---------- */
document.addEventListener("click", e => {
  const a = e.target.closest(".markdown a");
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener");
    else if (href && !href.startsWith("#") && ui.md) openDoc(resolveRel(ui.md.path, href));
    return;
  }
  if (ui.pop && !e.target.closest(".pop") && !e.target.closest('[data-act="pop"]')) { ui.pop = null; render(); }
  const el = e.target.closest("[data-act]"); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  switch (act) {
    case "dbx-signin": return dbxSignIn().catch(err => toast("Couldn't start sign-in: " + err.message));
    /* Phone layout */
    case "ph-seg": ph.seg = el.dataset.v; render(); { const v = $(".ph-view"); if (v) v.scrollTop = 0; } return;
    case "ph-search": ph.search = !ph.search; if (!ph.search) ui.q = ""; render(); if (ph.search) $("#q")?.focus(); return;
    case "ph-jump": { const s = document.getElementById(el.dataset.v); if (s) s.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); else toast("Nothing planned that day"); return; }
    case "ph-done": ph.doneOpen = !ph.doneOpen; return render();
    case "ph-open": { const it = allItems().find(x => x.id === id); if (!it) return; if (it._ro) return toast("That list is read-only here"); return phOpen("edit", it); }
    case "ph-add": return phOpen("add", null, ph.seg === "ideas");
    case "ed": {
      const f = el.dataset.f, v = el.dataset.v;
      if (f === "kind") { if (v === "idea") ph.ed.d.kind = "idea"; else { delete ph.ed.d.kind; if (!ph.ed.d.status) ph.ed.d.status = "open"; } return render(); }
      ph.ed.d[f] = v;
      el.parentElement.querySelectorAll(".ph-chip").forEach(c => c.setAttribute("aria-pressed", c === el));
      const other = document.querySelector(`[data-ed-date="${f}"]`); if (other) other.value = "";
      return;
    }
    case "ed-tag": { const t = (ph.ed.d.tags ??= []), v = el.dataset.v, k = t.indexOf(v); k < 0 ? t.push(v) : t.splice(k, 1); el.setAttribute("aria-pressed", k < 0); return; }
    case "ed-newtag": ph.ed.tagOpen = true; return phRefocus("#ed-tagname");
    case "ed-addtag": return phAddTag();
    case "ed-addstep": return phAddStep();
    case "ed-addnote": return phAddNote();
    case "ed-stoggle": { const c = ph.ed.d.checklist[+el.dataset.k]; c.done = !c.done; return render(); }
    case "ed-rmstep": ph.ed.d.checklist.splice(+el.dataset.k, 1); return render();
    case "ed-cancel": ph.ed = null; return render();
    case "ed-save": return phSave();
    case "sel": if (ui.sel !== id) { ui.sel = id; ui.confirm = null; ui.tagAdd = null; } return render();
    case "insp-close": ui.sel = null; ui.confirm = null; ui.tagAdd = null; return render();
    case "prio": return mutate(d => { const i = findItem(d, id); if (i) { i.priority = el.dataset.v; touch(i); } }, "Priority: " + el.dataset.v);
    case "date-clear": { const f = el.dataset.v; return mutate(d => { const i = findItem(d, id); if (i) { i[f] = ""; touch(i); } }, f === "due" ? "Due date cleared" : "Day cleared"); }
    case "tmode": ui.tasksMode = el.dataset.v; saveUi(); return render();
    case "theme": { const r = document.documentElement; r.dataset.theme = isDark() ? "light" : "dark"; try { localStorage.setItem("tt-theme", r.dataset.theme); } catch {} return render(); }
    case "ask-toggle": { const ta = ui.sel && document.getElementById("note-" + ui.sel), v = ta ? ta.value : ""; ui.ask = !ui.ask; render(); const n = ui.sel && document.getElementById("note-" + ui.sel); if (n) { n.value = v; n.focus(); } return; }
    case "ask-send": {
      const ta = document.getElementById("note-" + id), text = ta?.value.trim(); if (!text) return toast("Write a message first");
      return mutate(d => { d.inbox.push({ id: uid("m"), date: today(), text, about: id, status: "new", reply: "", replied: "" }); }, "Sent to Claude's inbox");
    }
    case "handoff": return handoff(id);
    case "strip-day": ui.view = "cal"; ui.cal = el.dataset.cal || "day"; ui.anchor = el.dataset.v; saveUi(); return render();
    case "pick": return connectOwn(true);
    case "reconnect": return connectOwn(false);
    case "retry": return loadOwn().then(render);
    case "create": return mutate(() => {}, "Created " + CONFIG.ownFile);
    case "ro-pick": return connectRo(el.dataset.key, true);
    case "ro-reconnect": return connectRo(el.dataset.key, false);
    case "view": ui.view = el.dataset.v; ui.confirm = null; ui.tagAdd = null; ui.pop = null; ui.q = ""; fx.search = null; saveUi(); return render();
    case "pop": ui.pop = ui.pop === el.dataset.pop ? null : el.dataset.pop; render(); if (ui.pop === "new") $(".nf-title")?.focus(); return;
    case "pop-close": ui.pop = null; return render();
    case "nf-prio": ui.nf.priority = el.dataset.v; return render();
    case "tagstyle": ui.tagStyle = el.dataset.v; ui.tagAdd = null; saveUi(); return render();
    case "collapse": toggleSet(ui.collapsed, el.dataset.v); saveUi(); return render();
    case "tags-toggle": ui.tagsOpen = !ui.tagsOpen; saveUi(); return render();
    case "showdone": ui.showDone = !ui.showDone; return render();
    case "fstatus": toggleSet(ui.statuses, el.dataset.v); return render();
    case "ftag": toggleSet(ui.tags, el.dataset.v); return render();
    case "clear-q": ui.q = ""; fx.search = null; return render();
    case "clear": ui.statuses.clear(); ui.tags.clear(); ui.q = ""; ui.showDone = false; return render();
    case "calmode": ui.cal = el.dataset.v; saveUi(); return render();
    case "calnav": calShift(+el.dataset.v); return render();
    case "cal-day": ui.cal = "day"; ui.anchor = el.dataset.v; saveUi(); return render();
    case "expand": ui.open.has(id) ? ui.open.delete(id) : ui.open.add(id); ui.confirm = null; return render();
    case "goto": { const it = allItems().find(x => x.id === id); ui.view = it && isIdea(it) ? "ideas" : "list"; if (it?.status === "done") ui.showDone = true; } ui.sel = id; ui.confirm = null; saveUi(); render(); return document.getElementById("item-" + id)?.scrollIntoView({ block: "center", behavior: "smooth" });
    case "toggle": { let msg = "Updated", ticked = null;
      return mutate(d => {
        const i = findItem(d, id); if (!i) return;
        if (i.status === "done") { msg = reopenItem(d, i) ? "Reopened (removed the next repeat)" : "Reopened"; return; }
        ticked = { id, prev: i.status };
        msg = completeItem(d, i);
      }, () => ticked ? null : msg).then(() => { if (ticked && own.data?.items.some(i => i.id === ticked.id && i.status === "done")) showUndo(ticked, msg); }); }
    case "undo": return undoDone();
    case "do-today": return mutate(d => { const i = findItem(d, id); if (i) { i.day = today(); touch(i); } }, "Planned for today");
    case "cl-toggle": return mutate(d => { const i = findItem(d, id); const c = i?.checklist?.[+el.dataset.k]; if (c) { c.done = !c.done; touch(i); } }, "Updated");
    case "cl-del": return mutate(d => { const i = findItem(d, id); if (i?.checklist) { i.checklist.splice(+el.dataset.k, 1); touch(i); } }, "Step removed");
    case "seen": return mutate(d => { const m = d.inbox.find(x => x.id === id); if (m) m.seen = true; }, "Cleared from Today");
    case "pal-open": return openPalette();
    case "pal-close": if (e.target.closest(".pal") && !e.target.closest(".pal-x")) return; ui.pal = null; return render();
    case "pal-go": return runPalette(+el.dataset.k);
    case "promote": ui.open.delete(id); return mutate(d => { const i = findItem(d, id); if (i) { delete i.kind; i.status = "open"; touch(i); } }, "Moved to Tasks");
    case "demote": ui.open.delete(id); return mutate(d => { const i = findItem(d, id); if (i) { i.kind = "idea"; touch(i); } }, "Moved to Ideas");
    case "tag-add": ui.tagAdd = id; return render();
    case "tag-del": return mutate(d => { const i = findItem(d, id); if (i) { i.tags = (i.tags || []).filter(t => t !== el.dataset.tag); touch(i); } }, "Tag removed");
    case "add-item": return addItem();
    case "doc": return ui.md?.path === el.dataset.path && !e.target.closest(".fxrow") ? (ui.md = null, render()) : openDoc(el.dataset.path);
    case "md-close": ui.md = null; return render();
    case "md-size": ui.mdSize = el.dataset.v; saveUi(); return render();
    case "md-root": return connectMdRoot(true);
    case "md-reconnect": return connectMdRoot(false);
    case "fx-dir": toggleSet(fx.open, el.dataset.path); return render();
    case "fx-all": fx.all = el.dataset.v === "1"; fx.search = null; return render();
    case "fx-mode": fx.mode = el.dataset.v; fx.search = null; fx.csearch = null; render(); return $("#q")?.focus();
    case "archive-now": return archiveOld().then(() => { arch.loaded = false; render(); });
    case "arch-restore": return restoreArchived(el.dataset.kind, id);
    case "snap-now": return snapshot(stamp()).then(n => { toast("Saved " + n); render(); }, err => toast("Snapshot failed: " + err.message));
    case "snap-restore": return restoreSnapshot(el.dataset.v);
    case "fx-clear-recent": fx.recent = []; saveRecent(); return render();
    case "pin": { const p = el.dataset.path; return mutate(d => { d.pins ??= []; const k = d.pins.indexOf(p); k >= 0 ? d.pins.splice(k, 1) : d.pins.push(p); }, () => (own.data.pins || []).includes(p) ? "Pinned" : "Unpinned"); }
    case "doc-find": return openDoc(el.dataset.path, ui.q.trim(), +el.dataset.line || 0);
    case "md-find-next": case "md-find-prev": { const m = ui.md; if (!m?.count) return; m.hit = (m.hit + (act === "md-find-next" ? 1 : -1) + m.count) % m.count; m.scrolled = false; return render(); }
    case "md-find-clear": if (ui.md) { ui.md.find = ""; } return render();
    case "fx-collapse": fx.open = new Set([""]); return render();
    case "fx-refresh": fx.cache.clear(); fx.text.clear(); fx.index = null; fx.search = null; fx.csearch = null; return render();
    case "fx-reveal": { const p = el.dataset.path.split("/"); for (let k = 1; k <= p.length; k++) fx.open.add(p.slice(0, k).join("/")); ui.q = ""; fx.search = null; return render(); }
    case "add-inote": {
      const ta = document.getElementById("note-" + id); const text = ta?.value.trim(); if (!text) return toast("Write a note first");
      return mutate(d => { const i = findItem(d, id); if (i) { (i.notes ??= []).push({ date: today(), by: "Barrett", text }); touch(i); } }, "Note added");
    }
    case "del-inote": return mutate(d => { const i = findItem(d, id); if (i) { i.notes.splice(+el.dataset.k, 1); touch(i); } }, "Note removed");
    case "ask": ui.view = "inbox"; ui.askAbout = id; render(); return $("#m-text")?.focus();
    case "del": ui.confirm = id; return render();
    case "del-no": ui.confirm = null; return render();
    case "del-yes": ui.confirm = null; ui.open.delete(id); if (ui.sel === id) ui.sel = null; return mutate(d => { d.items = d.items.filter(i => i.id !== id); }, "Deleted");
    case "add-note": {
      const title = $("#n-title").value.trim(), text = $("#n-text").value.trim(), tags = parseTags($("#n-tags").value);
      if (!text && !title) return toast("Write a note first");
      return mutate(d => { d.notes.push({ id: uid("n"), date: today(), title, text, tags }); }, "Note saved");
    }
    case "del-note-yes": ui.confirm = null; return mutate(d => { d.notes = d.notes.filter(n => n.id !== id); }, "Deleted");
    case "add-msg": {
      const text = $("#m-text").value.trim(), about = $("#m-about").value; if (!text) return toast("Write a message first");
      ui.askAbout = null;
      return mutate(d => { d.inbox.push({ id: uid("m"), date: today(), text, about, status: "new", reply: "", replied: "" }); }, "Sent to Claude's inbox");
    }
    case "msg-toggle": return mutate(d => { const m = d.inbox.find(x => x.id === id); if (m) m.status = m.status === "handled" ? "new" : "handled"; }, "Updated");
    case "del-msg-yes": ui.confirm = null; return mutate(d => { d.inbox = d.inbox.filter(m => m.id !== id); }, "Deleted");
  }
});
function toggleSet(s, v) { s.has(v) ? s.delete(v) : s.add(v); }

function addItem() {
  const nf = ui.nf, title = nf.title.trim(); if (!title) { toast("Type a title first"); $(".nf-title")?.focus(); return; }
  const idea = ui.view === "ideas";
  const item = { id: uid("i"), title, status: "open", tags: parseTags(nf.tags), priority: idea ? "normal" : nf.priority, day: idea ? "" : nf.day, due: idea ? "" : nf.due, link: "", notes: [], added: today(), changed: today() };
  if (idea) item.kind = "idea";
  else if (nf.repeat) { item.repeat = nf.repeat; if (!item.due && !item.day) item.due = today(); }
  ui.nf = { title: "", tags: "", priority: "normal", day: "", due: "", repeat: "" }; ui.pop = null;
  return mutate(d => { d.items.push(item); }, idea ? "Idea added" : "Added");
}
function commitTag(el) {
  const id = el.dataset.tagadd, tags = parseTags(el.value);
  el.value = ""; ui.tagAdd = null;
  if (!tags.length) return render();
  mutate(d => { const i = findItem(d, id); if (i) { i.tags = [...new Set([...(i.tags || []), ...tags])]; touch(i); } }, "Tag added");
}

document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "group") { ui.group = el.value; saveUi(); return render(); }
  if (el.id === "sort") { ui.sort = el.value; return render(); }
  if (el.id === "opt-showdone") { ui.showDone = el.checked; return render(); }
  if (ph.ed && el.dataset.edDate) {
    const f = el.dataset.edDate; ph.ed.d[f] = el.value || "";
    el.closest(".ph-field").querySelectorAll(".ph-chip").forEach(c => c.setAttribute("aria-pressed", c.dataset.v === (el.value || "")));
    return;
  }
  if (ph.ed && el.dataset.ed) { ph.ed.d[el.dataset.ed] = el.value; return; }
  const f = el.dataset.field, id = el.dataset.id; if (!f || !id) return;
  const v = el.value;
  mutate(d => {
    const i = findItem(d, id); if (!i) return;
    if (f === "title") { if (v.trim()) i.title = v.trim(); }
    else if (f === "repeat") { if (v) { i.repeat = v; if (!i.due && !i.day) i.due = today(); } else delete i.repeat; }
    else i[f] = f === "link" ? v.trim() : v;
    touch(i);
  }, f === "priority" ? "Priority: " + v : "Saved");
});
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.nf) { ui.nf[el.dataset.nf] = el.value; return; }
  if (ph.ed && el.dataset.edText) {
    const k = el.dataset.edText;
    if (k === "title") { ph.ed.d.title = el.value; if (ph.ed.err) { ph.ed.err = false; document.querySelector(".ph-err")?.remove(); } }
    else ph.ed[k] = el.value;
    return;
  }
  if (el.classList.contains("ititle")) return autoSize(el);
  if (el.id === "pal-q") { ui.pal.q = el.value; ui.pal.sel = 0; return updatePalette(); }
  if (el.id === "q") {
    ui.q = el.value; if (ui.view === "files") scheduleSearch();
    const pos = el.selectionStart; render();
    const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
  }
});
document.addEventListener("keydown", e => {
  const el = e.target, inField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && own.data) { e.preventDefault(); return ui.pal ? (ui.pal = null, render()) : openPalette(); }
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && ui.undo && !inField) { e.preventDefault(); return undoDone(); }
  if (ui.pal && el.id === "pal-q") {
    const n = ui.pal.results?.length || 0;
    if (e.key === "ArrowDown") { e.preventDefault(); ui.pal.sel = n ? (ui.pal.sel + 1) % n : 0; return updatePalette(); }
    if (e.key === "ArrowUp") { e.preventDefault(); ui.pal.sel = n ? (ui.pal.sel - 1 + n) % n : 0; return updatePalette(); }
    if (e.key === "Enter") { e.preventDefault(); return runPalette(ui.pal.sel); }
    if (e.key === "Escape") { e.preventDefault(); ui.pal = null; return render(); }
    return;
  }
  if (ph.ed && PHONE.matches) {
    if (e.key === "Escape") { e.preventDefault(); ph.ed = null; return render(); }
    if (e.key === "Enter" && el.dataset?.edText) { e.preventDefault(); const k = el.dataset.edText; return k === "step" ? phAddStep() : k === "note" ? phAddNote() : k === "tag" ? phAddTag() : phSave(); }
    return;
  }
  if (el.classList?.contains("cl-add") && e.key === "Enter") {
    e.preventDefault(); const text = el.value.trim(), id = el.dataset.cladd; if (!text) return;
    el.value = ""; ui.clFocus = id;
    return mutate(d => { const i = findItem(d, id); if (i) { (i.checklist ??= []).push({ text, done: false }); touch(i); } }, "Step added");
  }
  if (el.classList?.contains("tag-input")) {
    if (e.key === "Enter") { e.preventDefault(); commitTag(el); }
    else if (e.key === "Escape") { el.value = ""; ui.tagAdd = null; render(); }
    return;
  }
  if (el.classList?.contains("ititle") && e.key === "Enter") { e.preventDefault(); return el.blur(); }
  if (el.dataset?.nf && e.key === "Enter") { e.preventDefault(); return addItem(); }
  if (e.key === "Escape") {
    if (ui.pop) { ui.pop = null; return render(); }
    if (ui.md && !inField) { ui.md = null; return render(); }
    if (ui.sel && !inField) { ui.sel = null; ui.confirm = null; ui.tagAdd = null; return render(); }
  }
  if (inField || e.metaKey || e.ctrlKey || e.altKey || !own.data) return;
  if (e.key === "/") { e.preventDefault(); $("#q")?.focus(); }
  else if (e.key === "n" && ["today", "list", "cal", "ideas"].includes(ui.view)) { e.preventDefault(); ui.pop = "new"; render(); $(".nf-title")?.focus(); }
});
document.addEventListener("focusout", e => { if (e.target.classList?.contains("tag-input") && ui.tagAdd) commitTag(e.target); });

/* Drag and drop (calendar) */
document.addEventListener("dragstart", e => {
  const c = e.target.closest?.("[data-drag]"); if (!c) return;
  e.dataTransfer.setData("text/plain", c.dataset.drag); e.dataTransfer.effectAllowed = "move";
  ui.dragging = true; requestAnimationFrame(() => c.classList.add("dragging"));
});
document.addEventListener("dragend", e => {
  e.target.closest?.("[data-drag]")?.classList.remove("dragging");
  document.querySelectorAll(".drop-over").forEach(z => z.classList.remove("drop-over"));
  ui.dragging = false; if (ui.pendingRender) { ui.pendingRender = false; render(); }
});
const DROPS = "[data-drop],[data-sdrop]";
const dropZone = e => e.target.closest?.(DROPS) || document.elementsFromPoint(e.clientX, e.clientY).find(el => el.matches(DROPS));
document.addEventListener("dragover", e => {
  const z = dropZone(e); if (!z) return;
  e.preventDefault(); e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".drop-over").forEach(o => o !== z && o.classList.remove("drop-over"));
  z.classList.add("drop-over");
});
document.addEventListener("dragleave", e => {
  const z = e.target.closest?.(DROPS); if (z && !z.contains(e.relatedTarget)) z.classList.remove("drop-over");
});
document.addEventListener("drop", e => {
  const z = dropZone(e); if (!z) return;
  e.preventDefault(); z.classList.remove("drop-over"); ui.dragging = false;
  const id = e.dataTransfer.getData("text/plain"), day = z.dataset.drop;
  if (!id) return;
  if (z.dataset.sdrop) {
    const st = z.dataset.sdrop, it = own.data?.items.find(i => i.id === id); if (!it || it.status === st) return;
    return mutate(d => { const i = findItem(d, id); if (i) { i.status = st; touch(i); } }, "Moved to " + st);
  }
  const cur = own.data?.items.find(i => i.id === id); if (cur && (cur.day || "") === day) return;
  const len = cur && day && cur.day && cur.due > cur.day ? Math.round((parseYmd(cur.due) - parseYmd(cur.day)) / 864e5) : 0;
  mutate(d => { const i = findItem(d, id); if (i) { i.day = day; if (len) i.due = addDays(day, len); touch(i); } },
    !day ? "Unscheduled" : "Planned for " + fmtDay(day) + (len ? ", due " + fmtDay(addDays(day, len)) : ""));
});
