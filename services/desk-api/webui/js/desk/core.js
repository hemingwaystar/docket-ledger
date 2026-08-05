/* ==========================================================================
   js/desk/core.js — clock, escaping, formatters, icon set.
   Owns: NOW/BOOT/nowMs, span/date/time helpers, esc/jsq, webHref/webLabel,
   fmt* formatters, the IC icon markup table (Ledger-style full-markup
   entries) and icon().
   Endpoints: none.
   Invariants: esc() wraps every user string embedded in markup; jsq() wraps
   every user string embedded inside an onclick='fn(...)' JS literal (entity
   escaping alone is not enough there — the browser decodes entities before
   the JS parser runs, so the JS string is backslash-escaped first).
   ========================================================================== */

const NOW = new Date();                // wall clock at load
const BOOT = Date.now();               // real ms at load, for the native timer
const nowMs = () => NOW.getTime() + (Date.now() - BOOT);
/* time entries are intervals: date + start + end are the source of truth,
   hours are DERIVED to 2 decimals (3:30pm–5:00pm → 1.50). */
const spanH = (a,b) => Math.round(Math.max(0,(b-a))/36000)/100;
const msDate = ms => { const d=new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
const msTime = ms => { const d=new Date(ms); return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); };
const validT = t => /^\d{2}:\d{2}$/.test(t||'');
const spanMs = (dateStr, timeStr) => new Date(dateStr+'T'+timeStr+':00').getTime();

/* ---------------- tiny utils ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jsq = s => esc(String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"));
/* website fields are stored raw (whatever the admin typed). These two are the
   ONE seam that turns a stored value into a working link wherever it renders:
   href gets https:// prefixed when no protocol is present; the label shows
   the bare domain. */
const webHref  = u => { u = String(u||'').trim(); return u ? (/^https?:\/\//i.test(u) ? u : 'https://'+u) : ''; };
const webLabel = u => String(u||'').trim().replace(/^https?:\/\//i,'').replace(/\/+$/,'');
const H = 3600e3, MIN = 60e3;
function fmtDT(ms){ const d=new Date(ms); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' · '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function fmtAgo(ms){
  const d = nowMs()-ms;
  if(d < MIN) return 'just now';
  if(d < H) return Math.round(d/MIN)+'m ago';
  if(d < 24*H) return Math.round(d/H)+'h ago';
  return Math.round(d/(24*H))+'d ago';
}
function fmtIn(ms){
  const d = ms-nowMs(), a=Math.abs(d);
  const t = a<H ? Math.max(1,Math.round(a/MIN))+'m' : a<24*H ? (Math.round(a/H*10)/10)+'h' : Math.round(a/(24*H))+'d';
  return d>=0 ? 'in '+t : t+' over';
}
function fmtHours(h){ return h.toFixed(2); }
function fmtClock(sec){ const m=Math.floor(sec/60), s=Math.floor(sec%60); return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
const fmtKB = b => b>=1048576? (b/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(b/1024))+' KB';

/* ---------------- icons ----------------
   Ledger's icon system, adopted verbatim (build 13): each IC entry is FULL
   svg child markup (stroke-width 2, round caps/joins, fill:none unless the
   glyph is a filled shape) and icon() injects it raw. Shared views (Dashboard,
   Clients, Reports, Audit Log, Directory, Settings, search, seal/check/export)
   are STRING-IDENTICAL to js/ledger/core.js — keep the two tables in sync. */
const IC = {
  dash:'<path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z"/>',
  ticket:'<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  proj:'<rect x="4" y="3.5" width="16" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8.5l1.5 1.5L12.5 7M8 14.5l1.5 1.5L12.5 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 9h3M15 15h3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  client:'<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  report:'<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 3v6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 18v-3M12 18v-6M15 18v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  audit:'<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 8h6M9 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  settings:'<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  search:'<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  seal:'<circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 15l-1 6 4-2 4 2-1-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 10l1.7 1.7L15 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  check:'<path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  export:'<path d="M12 15V3m0 0 4 4m-4-4L8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  mail:'<rect x="4" y="6" width="16" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m4 7 8 6 8-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  shield:'<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>',
  clock:'<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 6v6l4 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  calendar:'<rect x="3.5" y="5" width="17" height="15.5" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  plus:'<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  back:'<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};
function icon(p,cls){return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="currentColor">${p}</svg>`}
