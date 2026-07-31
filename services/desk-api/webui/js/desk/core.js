/* ==========================================================================
   js/desk/core.js — clock, escaping, formatters, icon set.
   Owns: NOW/BOOT/nowMs, span/date/time helpers, esc/jsq, fmt* formatters,
   the IC icon path table and icon().
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

/* ---------------- icons ---------------- */
const IC = {
  seal:'<circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 15l-1 6 4-2 4 2-1-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 10l1.7 1.7L15 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  check:'<path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  proj:'<rect x="4" y="3.5" width="16" height="17" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 8.5l1.5 1.5L12.5 7M8 14.5l1.5 1.5L12.5 13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 9h3M15 15h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  export:'<path d="M12 15V3m0 0 4 4m-4-4L8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  dash:'M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z',
  ticket:'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z',
  client:'M16 11a4 4 0 1 0-8 0M4 20c0-3 3.6-5 8-5s8 2 8 5',
  report:'M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3',
  shield:'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z',
  settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.5-3a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.6 7.6 0 0 0-2-1.2L14.6 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.7 7.7 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.06-.4.1-.8.1-1.2Z',
  audit:'M5 4h11l3 3v13H5V4Zm3 6h8M8 13h8M8 16h5',
  clock:'M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  mail:'M4 6h16v12H4V6Zm0 1 8 6 8-6',
  plus:'M12 5v14M5 12h14',
  back:'M15 6l-6 6 6 6',
  search:'M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
};
const icon = (d,cls) => `<svg class="${cls||''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
