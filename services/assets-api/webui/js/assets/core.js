/* ==========================================================================
   Assets — core.js
   Pure helpers every other file builds on: clock, escaping, the icon set,
   money/date formatting, the typed-term vocabulary (term_months + recurring,
   user decision 2026-08-20), coverage-health classification, and the audit
   log() feeder. No DOM writes, no server calls — endpoints live in api.js
   and the views.
   ========================================================================== */

const NOW = new Date();   /* one consistent "today" for coverage math */
const CURRENCY = '$';

/* ------------------------------ escaping ------------------------------ */
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
const jsq = s => esc(String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"));

/* ------------------------------ icons (stroke set, prototype-ported) --- */
function _st(inner){return '<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+inner+'</g>';}
const IC = {
  overview: _st('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  assets:   _st('<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>'),
  license:  _st('<circle cx="8" cy="9" r="4"/><path d="M11 12l6 6M16 15l2-2 2 2-2 2z"/>'),
  contracts:_st('<path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4M9 13h6M9 17h6"/>'),
  report:   _st('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  audit:    _st('<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4Z"/><path d="M9 8h6M9 12h4"/>'),
  settings: _st('<circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'),
  search:   _st('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  plus:     _st('<path d="M12 5v14M5 12h14"/>'),
  warn:     _st('<path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 17h.01"/>'),
  money:    _st('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.7 2.5 1.7c0 2.3-5 1.3-5 3.6 0 1 1 1.7 2.5 1.7s2.5-.5 2.5-1.5"/>'),
  laptop:   _st('<rect x="4" y="5" width="16" height="10" rx="1.5"/><path d="M2 19h20"/>'),
  server:   _st('<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>'),
  network:  _st('<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>'),
  firewall: _st('<path d="M12 3l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V6z"/><path d="M9 12l2 2 4-4"/>'),
  phone:    _st('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>'),
  printer:  _st('<path d="M6 9V3h12v6M6 18H4v-6h16v6h-2M8 14h8v6H8z"/>'),
  desktop:  _st('<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>'),
  box:      _st('<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
  client:   _st('<path d="M3 21V7l7-4 7 4v14M9 21v-5h4v5M21 21H3M14 9h.01M6 9h.01M6 13h.01"/>'),
};
function icon(p,cls){return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="currentColor">${p}</svg>`}
const TYPEIC = {Laptop:IC.laptop, Desktop:IC.desktop, Server:IC.server, Network:IC.network,
  Firewall:IC.firewall, Mobile:IC.phone, Printer:IC.printer, Peripheral:IC.box, Other:IC.assets};
const ATYPES  = ['Laptop','Desktop','Server','Network','Firewall','Mobile','Printer','Peripheral','Other'];
const CT_KINDS = ['support','warranty','retainer','other'];
const CT_KIND_LABEL = {support:'Support contract', warranty:'Warranty', retainer:'Retainer', other:'Other'};

/* ------------ formatting: money (integer cents!), dates ------------ */
function fmtMoney(cents){ return CURRENCY + (cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) }
function fmtDate(d){ return new Date(d+(String(d).length===10?'T00:00:00':'')).toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'}) }
function fmtStamp(ts){ return new Date(ts).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) }

/* ------------ shared lookups ------------ */
function client(id){ return state.clients.find(c=>c.id===id) }
function clientName(id){ if(id==null) return 'All clients (MSP-wide)'; const c=client(id); return c?c.name:'—'; }
function assetById(id){ return state.assets.find(a=>a.id===id) }

/* ------------ typed terms (term_months + recurring) ------------
   'Monthly' = 1 · '3-yr' = 36 · anything else 'N-mo'. Cost is per TERM,
   billed up front at each term start — never amortized; annualized figures
   are REPORTING math only. */
function termLabel(m, recurring){
  const base = m===1 ? 'Monthly' : (m%12===0 ? (m/12)+'-yr' : m+'-mo');
  return base + (recurring ? ' · ↻ recurring' : '');
}
function annualizedCents(costCents, m){ return Math.round(costCents*12/m); }
/* licence cost_cents is PER SEAT per term (user decision 2026-08-20 — the
   $4.80/seat M365 case); the POOL pays unit x purchased seats. A lump-priced
   licence is just 1 seat x the lump. Contracts stay whole-agreement. */
function licPoolCents(l){ return l.costCents * l.seatsTotal; }

/* ------------ coverage health ------------
   due-window follows the lapse-scan setting so "needs attention" and the
   Build-30 ticket scan agree on what "soon" means.
   daysTo counts LOCAL calendar days against a per-call "today" — comparing
   to a load-time timestamp made the expired/due boundary move at noon and
   drift ever-wrong in long-lived tabs (review finding). */
function localISODate(d){ const t=d?new Date(d):new Date();
  return t.getFullYear()+'-'+String(t.getMonth()+1).padStart(2,'0')+'-'+String(t.getDate()).padStart(2,'0'); }
function daysTo(d){
  const t=new Date(); const mid=new Date(t.getFullYear(),t.getMonth(),t.getDate());
  return Math.round((new Date(d+'T00:00:00') - mid)/86400000);
}
function leadDays(){ return (state.cfg && state.cfg.lapse_lead_days) || 60; }
function covClass(d){ if(!d) return 'none'; const n=daysTo(d); return n<0?'breach':(n<=leadDays()?'due':'ok'); }
function covText(d){
  if(!d) return '—';
  const n=daysTo(d);
  return n<0?('expired '+fmtDate(d)):(n<=leadDays()?('in '+n+'d · '+fmtDate(d)):fmtDate(d));
}
function hdot(d){ return `<span class="hdot ${covClass(d)}"><span class="sdot"></span>${covText(d)}</span>`; }
/* term-end cell: a recurring term never "expires" — it renews (the server
   rolls endsOn to the CURRENT term already; Build 30 advances the anchor) */
function endCell(d, recurring){
  if(!d) return '—';
  if(recurring) return `<span class="hdot ok"><span class="sdot"></span>renews ${fmtDate(d)}</span>`;
  return hdot(d);
}

const ASSET_STATUS = {inuse:['green','In use'], stock:['blue','In stock'], repair:['brass','In repair'], retired:['grey','Retired']};
function statusChip(s){ const c=ASSET_STATUS[s]||['grey',s]; return `<span class="chip ${c[0]} slim"><span class="cdot"></span>${c[1]}</span>`; }
function kindChip(k){ return `<span class="chip grey slim"><span class="cdot"></span>${CT_KIND_LABEL[k]||k}</span>`; }

/* who inventory can belong to: real, live clients only (never the sentinel) */
function pickableClients(){ return state.clients.filter(c=>!c.sentinel && !c.archived); }

/* ISO-date window test (dates compare lexicographically). Once a window is
   set, undated rows drop out — an unknown date can't be proven inside it. */
function inDateRange(d, from, to){
  if(!d) return !(from||to);
  if(from && d < from) return false;
  if(to && d > to) return false;
  return true;
}

/* multi-select filter toggle — one shape for every view's filter bag:
   toggle(null) clears the whole selection (the combo's "All" row) */
function mfToggle(bag, key, v){
  const arr=state[bag][key];
  if(v===null) arr.length=0;
  else { const i=arr.indexOf(v); if(i>=0) arr.splice(i,1); else arr.push(v); }
  render();
}

/* live (non-archived) slices — every view starts from these */
function liveAssets(){ return state.assets.filter(a=>!a.archived); }
function liveLicenses(){ return state.licenses.filter(l=>!l.archived); }
function liveContracts(){ return state.contracts.filter(c=>!c.archived); }
function contractsCovering(assetId){ return liveContracts().filter(c=>(c.assetIds||[]).includes(assetId)); }
function entityEvents(kind, id){ return state.events.filter(e=>e.kind===kind && e.entityId===id); }

/* ------------ audit ------------
   Optimistic UI sugar only — the durable row is the server's audit.events
   write; the next hydrate replaces state.audit wholesale (ledger doctrine). */
function log(action, detail, entityId){
  state.audit.unshift({ id:'ev'+(state.seq++), ts:Date.now(), actor:state.user.name, action, detail, entityId:entityId||null });
}
