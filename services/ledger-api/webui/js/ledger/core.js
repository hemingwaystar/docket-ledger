/* ==========================================================================
   Ledger — core.js
   Pure helpers every other file builds on: clock, escaping, the icon set,
   time/money formatting, period math, pricing resolution (effective-dated
   rates), project flat-fee overlays, retainer math, and the audit log()
   feeder. No DOM writes, no server calls — endpoints live in api.js and
   the views.
   ========================================================================== */

const NOW = new Date();   /* one consistent "today" for period math */
const CURRENCY = '$';

/* ------------------------------ escaping ------------------------------ */
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
const jsq = s => esc(String(s ?? '').replace(/\\/g,'\\\\').replace(/'/g,"\\'"));

/* ------------------------------ icons ------------------------------ */
const IC = {
  dash:'<path d="M4 13h6V4H4v9Zm0 7h6v-5H4v5Zm10 0h6V11h-6v9Zm0-16v5h6V4h-6Z"/>',
  sheet:'<path d="M8 4h9a2 2 0 0 1 2 2v14l-4-2-4 2-4-2V6a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 9h6M9 13h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  client:'<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 8a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  tag:'<path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/>',
  period:'<rect x="3.5" y="5" width="17" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 9h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  export:'<path d="M12 15V3m0 0 4 4m-4-4L8 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  audit:'<path d="M5 4h14v16l-3-2-2 2-2-2-2 2-2-2-3 2V4Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 8h6M9 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  settings:'<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  lock:'<rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/>',
  check:'<path d="M4 12l5 5L20 6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
  search:'<circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.2-3.2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  seal:'<circle cx="12" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9 15l-1 6 4-2 4 2-1-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9.5 10l1.7 1.7L15 8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  warn:'<path d="M12 3 2 21h20L12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 9v5M12 17h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  caret:'<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  report:'<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13 3v6h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 18v-3M12 18v-6M15 18v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
};
function icon(p,cls){return `<svg class="${cls||''}" viewBox="0 0 24 24" fill="currentColor">${p}</svg>`}

/* ------------ helpers: time, money, periods ------------ */
function iso(d){return new Date(d).toISOString()}
function fmtHours(h){ return h.toFixed(2) }
function fmtMoney(n){ return CURRENCY + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) }
function fmtTime(d){ return new Date(d).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:false}) }
function fmtDate(d){ return new Date(d).toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'}) }
function fmtDateShort(d){ return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric'}) }
function fmtStamp(d){ return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) }
function tech(id){ return state.techs.find(t=>t.id===id) }
function client(id){ return state.clients.find(c=>c.id===id) }
/* unknown id → sentinel-shaped fallback, NEVER undefined: a bridge entry
   with a type the hydrate hasn't delivered yet used to throw in renderNav/
   priced/classifyControl and freeze the whole pane (audit). Desk's atype()
   already worked this way. */
function atype(id){ return state.types.find(a=>a.id===id)
  || {id, name:'Unclassified', billable:false, sentinel:true, active:true,
      rate:0, rateHist:[], billableHist:[], note:''} }

/* Period math — start/end range + human label + stable key, per cycle */
function periodFor(cycle, dateStr){
  const d = new Date(dateStr); let start, end, label, key;
  if(cycle==='weekly'){
    const day=(d.getDay()+6)%7; start=new Date(d); start.setDate(d.getDate()-day); start.setHours(0,0,0,0);
    end=new Date(start); end.setDate(start.getDate()+7);
    key='W'+start.toISOString().slice(0,10);
    label='Week of '+fmtDateShort(start);
  } else if(cycle==='biweekly'){
    const anchor=new Date('2026-01-05T00:00:00'); // a Monday
    const diff=Math.floor((d-anchor)/(86400000*14));
    start=new Date(anchor); start.setDate(anchor.getDate()+diff*14);
    end=new Date(start); end.setDate(start.getDate()+14);
    key='B'+start.toISOString().slice(0,10);
    label=fmtDateShort(start)+' – '+fmtDateShort(new Date(end-86400000));
  } else { // monthly
    start=new Date(d.getFullYear(),d.getMonth(),1);
    end=new Date(d.getFullYear(),d.getMonth()+1,1);
    key='M'+start.toISOString().slice(0,7);
    label=start.toLocaleDateString('en-US',{month:'long',year:'numeric'});
  }
  return {start,end,label,key};
}
function entryPeriod(e){
  const c=client(e.clientId);
  /* the server's period assignment is the billing truth (audit): hydrated
     entries carry periodKey; browser-local bucketing put an evening entry
     near a month/week end in a DIFFERENT period than the DB (UTC), so lock
     checks, sheets and period ops silently missed it. Ghosts (no periodKey
     yet) still bucket locally until the next hydrate. */
  if(e.periodKey){
    const uk=uiPeriodKey(e.periodKey);
    if(uk[0]==='M'){
      const [y,mo]=uk.slice(1).split('-').map(Number);
      const start=new Date(y,mo-1,1), end=new Date(y,mo,1);
      return {start,end,key:uk,label:start.toLocaleDateString('en-US',{month:'long',year:'numeric'})};
    }
    if(uk[0]==='W'){
      const start=new Date(uk.slice(1)+'T00:00:00');
      const end=new Date(start); end.setDate(start.getDate()+7);
      return {start,end,key:uk,label:'Week of '+fmtDateShort(start)};
    }
  }
  return periodFor(c.cycle, e.startedAt)
}
function periodState(clientId, key){
  const k=clientId+'|'+key;
  if(!state.periods[k]) state.periods[k]={status:'open',approvedAt:null,approvedBy:null,exportedAt:null,exportRef:null};
  return state.periods[k];
}
function isLocked(e){ const p=entryPeriod(e); return periodState(e.clientId,p.key).status!=='open' }
function findPeriodDate(clientId,pk){ const e=state.entries.find(x=>x.clientId===clientId && entryPeriod(x).key===pk); return e?e.startedAt:NOW; }
/* label a UI period key via the entries actually IN it — deriving the label
   from a matched entry's raw date could name the neighbouring month for a
   server-keyed boundary entry */
function periodLabel(clientId,pk){
  const e=state.entries.find(x=>x.clientId===clientId && entryPeriod(x).key===pk);
  if(e) return entryPeriod(e).label;
  const c=client(clientId); return c?periodFor(c.cycle,NOW).label:pk;
}

/* ------------ date-range filter helpers (shared by the filter bars) ------------ */
function _dateRange(f){
  const from = f&&f.from ? new Date(f.from+'T00:00:00').getTime() : -Infinity;
  const to   = f&&f.to   ? new Date(f.to+'T23:59:59').getTime()   :  Infinity;
  return [from,to];
}
function _presetDates(f,p){
  const now=NOW, d=n=>n.getFullYear()+'-'+String(n.getMonth()+1).padStart(2,'0')+'-'+String(n.getDate()).padStart(2,'0');
  if(p==='all'){ f.from=''; f.to=''; }
  else if(p==='thismonth'){ f.from=d(new Date(now.getFullYear(),now.getMonth(),1)); f.to=d(now); }
  else { const days=p==='7d'?7:p==='90d'?90:30; const s=new Date(now); s.setDate(now.getDate()-days); f.from=d(s); f.to=d(now); }
}

/* pricing resolution:
   billable = per-client-type override
              ?? (client-wide "billable by default" flag = false → false;
                  true/absent falls through — VETO ONLY, 0038: re-ticking the
                  checkbox must never make Internal/Cancelled types billable)
              ?? type.billable (sentinel never billable)
   rate     = per-client-type rate ?? client.rateOverride
              ?? (client opted in AND type not toggled off) global default rate
              ?? type.rate
   The gated default rung mirrors ledger.priced() (0029) exactly: the
   client-wide "use global default rates" switch defaults OFF, the per-type
   inherit toggle defaults ON, both resolved as-of the entry's date.
   EFFECTIVE-DATED: every rate holder may carry a history array
   [{from:'YYYY-MM-DD', rate:N}, ...]; an entry prices against the rate in
   force at its startedAt, so changing a rate NEVER reprices history. */
function effBillPick(current, hist, atMs){
  /* billable as-of the entry's day, like effRate — a flip today never
     re-flags yesterday's time */
  if(!hist || !hist.length) return current;
  const day = new Date(atMs).toISOString().slice(0,10);
  let best=null;
  hist.forEach(hh=>{ if(hh.from<=day && (!best || hh.from>best.from)) best=hh; });
  return best ? best.billable : current;
}
function effRateN(current, hist, atMs){
  /* as-of override resolution: null means "inherit at that date" — both
     before the first override existed AND after a dated reset row. Matches
     priced()'s COALESCE fall-through exactly. */
  if(!hist || !hist.length) return current!=null?current:null;
  const day = new Date(atMs).toISOString().slice(0,10);
  let best=null;
  hist.forEach(hh=>{ if(hh.from<=day && (!best || hh.from>best.from)) best=hh; });
  return best ? best.rate : null;
}
function effRate(current, hist, atMs){
  if(!hist || !hist.length) return current;
  const day = new Date(atMs).toISOString().slice(0,10);
  let best = null;
  hist.forEach(hh=>{ if(hh.from<=day && (!best || hh.from>best.from)) best = hh; });
  return best ? best.rate : (hist[0].preHistory!=null ? hist[0].preHistory : current);
}
function effFlag(current, hist, atMs, dflt){
  /* boolean twin of effRateN: as-of flag; before the first dated row the
     answer is the lane's default (wide=false, typed=true) — matching the
     SQL COALESCE(subquery, false/true) exactly */
  if(!hist || !hist.length) return current!=null?current:dflt;
  const day=new Date(atMs).toISOString().slice(0,10);
  let best=null; hist.forEach(h=>{ if(h.from<=day && (!best||h.from>best.from)) best=h; });
  return best?best.enabled:dflt;
}
function clientUsesDefaultsAsOf(c, tid, atMs){
  if(effFlag(null, c.useDefaultsHist, atMs, false)!==true) return false;   /* wide switch, default off */
  const tf=(c.defaultTypeFlags||{})[tid];
  return effFlag(null, tf&&tf.hist, atMs, true)!==false;                   /* typed toggle, default on */
}
function defaultRateAsOf(tid, atMs){
  const d=state.defaultRates[tid]; if(!d) return null;
  return effRateN(d.rate, d.hist, atMs);   /* NULL hist row = dated unset, falls through */
}
/* shown atop any view whose tallies run over the capped hydrate window */
function capBanner(){
  if(!state.entriesCapped) return '';
  return `<div class="notice info" style="margin-bottom:16px"><div><b>Not all history is loaded</b> — older entries beyond the hydrate window are excluded from the tallies on this page. Server-side period totals and Odoo exports remain complete.</div></div>`;
}
function projFor(e){ return (state.projects && state.projects[e.zTicket]) || null; }
function projTaskFor(e){ const p=projFor(e); if(!p||!e.zTask) return null; return p.tasks.find(x=>x.id===e.zTask.id)||null; }
function priced(e){
  const t=atype(e.typeId), c=client(e.clientId);
  const h=e.hours;
  /* project overlay: once Docket approves a project, its tasks price the time.
     Flat tasks: hours are covered by the fixed fee (amount 0 here; the fee
     itself bills as a flat line on the period/export). Hourly tasks: the
     task's override rate wins; empty = standard pricing below. */
  const pj = projFor(e);
  if(pj && pj.pmode==='flat'){
    return {h, billable:false, rate:0, amount:0, unclassified:false, projFlat:true};
  }
  const pt = projTaskFor(e);
  if(pt && pt.mode==='flat'){
    return {h, billable:false, rate:0, amount:0, unclassified:false, projFlat:true};
  }
  const ov = (c.rates && c.rates[e.typeId]) || null;
  const ovB = ov ? effBillPick(ov.billable, ov.billableHist, e.startedAt) : null;
  const cwB = effBillPick(null, c.billableDefaultHist, e.startedAt);  /* 0038: dated wide lane */
  const tB  = effBillPick(t.billable, t.billableHist, e.startedAt);
  const billable = t.sentinel ? false : (ovB!=null ? !!ovB : (cwB===false ? false : !!tB));
  let rate = 0;
  if(billable){
    const ovRate = ov ? effRateN(ov.rate, ov.rateHist, e.startedAt) : null;
    const cwRate = effRateN(c.rateOverride, c.rateOverrideHist, e.startedAt);
    const dfRate = clientUsesDefaultsAsOf(c, e.typeId, e.startedAt) ? defaultRateAsOf(e.typeId, e.startedAt) : null;
    if(pt && pt.mode==='hourly' && pt.rate!=null) rate = pt.rate;
    else if(ovRate!=null)              rate = ovRate;
    else if(cwRate!=null)              rate = cwRate;
    else if(dfRate!=null)              rate = dfRate;
    else                               rate = effRate(t.rate, t.rateHist, e.startedAt);
  }
  const amount = e.status==='void' ? 0 : (billable ? h*rate : 0);
  return {h,billable,rate,amount,unclassified:!!(t&&t.sentinel)};
}
/* flat project fees landing in a client's billing period (period of approval) */
function projFlatLines(clientId, perKey){
  if(!state.projects) return [];
  const out=[];
  Object.values(state.projects).forEach(p=>{
    if(p.clientId!==clientId) return;
    const c=client(clientId); if(!c) return;
    if(periodFor(c.cycle, p.approvedAt).key!==perKey) return;
    if(p.pmode==='flat'){
      if(p.projectFlat>0){ const hrs=p.tasks.reduce((a,x)=>a+(x.hours||0),0); out.push({ project:p.title, ticket:p.ticket, label:'Project flat rate', amount:p.projectFlat, hours:hrs }); }
    } else {
      p.tasks.forEach(x=>{ if(x.mode==='flat' && x.flat>0) out.push({ project:p.title, ticket:p.ticket, label:x.label, amount:x.flat, hours:x.hours||0 }); });
    }
  });
  return out;
}
function projFlatTotal(clientId, perKey){ return projFlatLines(clientId, perKey).reduce((a,l)=>a+l.amount,0); }

/* ------------ retainers / block-hour agreements ------------ */
function retainersOn(){ return !!(state.settings && state.settings.retainers && state.settings.retainers.enabled); }
function retainerFor(c){ return (retainersOn() && c && c.retainer && c.retainer.enabled) ? c.retainer : null; }
function periodBillableHours(clientId, pk){
  return state.entries.filter(e=>e.clientId===clientId && entryPeriod(e).key===pk && e.status!=='void' && priced(e).billable)
    .reduce((s,e)=>s+e.hours, 0);
}
function prevPeriodKey(clientId, pk){
  const keys = [...new Set(state.entries.filter(e=>e.clientId===clientId).map(e=>entryPeriod(e).key))].sort();
  const i = keys.indexOf(pk);
  return i>0 ? keys[i-1] : null;
}
function retainerMath(clientId, pk){
  const c = client(clientId); const r = retainerFor(c);
  if(!r) return null;
  let rollover = 0;
  const prev = prevPeriodKey(clientId, pk);
  if(prev && r.rolloverCap>0){
    const prevUsed = periodBillableHours(clientId, prev);
    rollover = Math.min(Math.max(r.includedHours - prevUsed, 0), r.rolloverCap);
  }
  const included = r.includedHours + rollover;
  const used = periodBillableHours(clientId, pk);
  const covered = Math.min(used, included);
  const overageH = Math.max(used - included, 0);
  /* overage priced at the agreement rate when set, else normal resolution applies per entry —
     for display we quote the agreement rate or the client's default */
  const oRate = r.overageRate!=null ? r.overageRate : (c.rateOverride!=null ? c.rateOverride : 150);
  return { included, base:r.includedHours, rollover, used, covered, overageH, overageAmt:overageH*oRate, oRate };
}

/* ------------ audit ------------ */
function log(action, detail, entityId){
  state.audit.unshift({ id:'ev'+(state.seq++), ts:Date.now(), actor:state.user.name, action, detail, entityId:entityId||null });
}
