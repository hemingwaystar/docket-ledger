/* ==========================================================================
   Ledger — api.js
   Hydration + the shared fetch plumbing every action function uses.
   Endpoints called here:
     GET /api/bootstrap                — hydrate(): the single source of state
   Shared helpers for the views: $fetch (LBASE-prefixed, bug #8), post
   (POST + rehydrate), oops (alert + rehydrate), jshort, srvId,
   srvPeriodKey (UI→server period-key translation, bug #22), PERIODS
   (server period rows — id lookup for approve / mark-exported).
   Invariant: mapIn() consumes EVERY bootstrap key the server emits
   (me, clients, techs, types, entries, cfg, odooSecret, periods,
   projects, audit, groups, roles, defaultRates) — all 13, nothing dropped.
   ========================================================================== */

/* behind nginx, Ledger lives under /ledger/ with the prefix stripped
   server-side — every server call gains the base; direct :8082 access
   keeps an empty base (bug #8: paths stay absolute per origin) */
const LBASE=location.pathname.startsWith('/ledger/')?'/ledger':'';
const $fetch=(p,o)=>fetch(LBASE+p,{credentials:'same-origin',...(o||{})});
let PERIODS=[];   /* server period rows — {id, clientId, key, status, ...} */

function mapIn(d){
  state.clients.length=0; d.clients.forEach(c=>state.clients.push(c));
  state.techs.length=0;   d.techs.forEach(t=>state.techs.push(t));
  /* groups/roles feed the Directory mirror, the Approvals group filter and
     group-based client access — bootstrap-fed on every load; suite-bridge
     events only ever supplement (hydration completeness, row 36) */
  state.zammadGroups.length=0;
  (d.groups||[]).forEach(g=>state.zammadGroups.push({id:g.id,name:g.name,archived:g.active===false}));
  state.zammadRoles.length=0;
  (d.roles||[]).forEach(r=>state.zammadRoles.push({name:r.name,tech:true,note:r.note||'',
    archived:r.active===false,perms:(r.ledgerPerms||[]).slice()}));
  state.types.length=0;   d.types.forEach(t=>state.types.push(t));
  /* global default billing rates — cleared-and-refilled every hydrate like
     periods/projects (hydration completeness, row 36) */
  Object.keys(state.defaultRates).forEach(k=>delete state.defaultRates[k]);
  Object.entries(d.defaultRates||{}).forEach(([k,v])=>{ state.defaultRates[k]=v; });
  state.entries.length=0; d.entries.forEach(e=>state.entries.push(e));
  if(d.cfg){
    if(d.cfg.ledger) Object.assign(state.settings, d.cfg.ledger);
    if(d.cfg.odoo)   Object.assign(state.settings.odoo, d.cfg.odoo);
    if(d.cfg.retainers) Object.assign(state.settings.retainers, d.cfg.retainers);
  }
  state.odooSecret=d.odooSecret||null;
  state.settings.odoo.apiKey='';        /* write-only — never round-trips */
  PERIODS=d.periods||[];
  /* seed the period-lock registry from the server — approved/exported
     periods must LOOK locked, not just refuse edits (gap #4). The registry
     is UI-keyed (periodFor's M/W prefixes): server keys translate HERE,
     once — a registry entry nobody can look up is how gap #4 stayed open. */
  Object.keys(state.periods).forEach(k=>delete state.periods[k]);
  PERIODS.forEach(p=>{ state.periods[p.clientId+'|'+uiPeriodKey(p.key)]={
    status:p.status, approvedAt:p.approvedAt||null, approvedBy:p.approvedBy||null,
    exportedAt:p.exportedAt||null, exportRef:p.exportRef||null}; });
  /* projects overlay — flat-fee / task pricing needs this on every hydrate */
  Object.keys(state.projects).forEach(k=>delete state.projects[k]);
  (d.projects||[]).forEach(p=>{ state.projects[p.zTicket]=p; });
  if(d.audit){ state.audit.length=0;
    d.audit.forEach(a=>state.audit.push({id:'srv'+a.ts+(a.entityId||''), ts:a.ts,
      actor:a.actor, action:a.action, detail:a.detail, entityId:a.entityId})); }
  state.user={name:d.me.name,initials:d.me.initials,role:'Live',email:d.me.email};
  state.perms=new Set(d.me.perms.map(p=>p.replace(/^l_/,'')));
  const me=state.techs.find(t=>t.email===d.me.email);
  state.myTechId=me?me.id:null;   /* re-derived every hydrate — never stale */
}

async function hydrate(){
  /* hydration failures are LOUD: ⚠ in the title + alert, never silent (bug #13) */
  let r;
  try{ r=await $fetch('/api/bootstrap'); }
  catch(err){
    document.title='⚠ LIVE SYNC FAILED — Ledger';
    console.error('bootstrap unreachable', err);
    alert('Live sync failed — ledger-api unreachable. Check the service and reload.');
    return;
  }
  if(r.status===401){ location.href=LBASE?'/ui/login.html'
    :location.protocol+'//'+location.hostname+':8081/ui/login.html'; return; }
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    document.title='⚠ LIVE SYNC FAILED — Ledger';
    console.error('bootstrap failed', r.status, d);
    alert('Live sync failed ('+r.status+'): '+(d.detail||'server error')+' — check ledger-api logs.');
    return;
  }
  mapIn(await r.json());
  state.hydrated=true;
  render();
}

const oops=async d=>{ alert((d&&d.detail)? 'Server declined: '+d.detail
  : 'Live sync failed — check ledger-api logs'); hydrate(); };
const jshort=r=>r.json().catch(()=>0);
const post=(p,body)=>$fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined})
  .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0));
    setTimeout(hydrate,600); });

/* the UI prefixes period keys (M2026-07 / W2026-07-20); the server stores
   to_char formats (2026-07 / 2026-W30). Translate at the boundary — every
   timesheet call matched ZERO rows until this existed (bug #22). */
const srvPeriodKey=pk=>{
  if(pk && pk[0]==='M') return pk.slice(1);
  if(pk && pk[0]==='W'){
    const d=new Date(pk.slice(1)+'T00:00:00Z');
    const t=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+3)); // ISO-week Thursday
    const y=t.getUTCFullYear(), jan4=new Date(Date.UTC(y,0,4));
    const wk=1+Math.round(((t-jan4)/86400000-3+((jan4.getUTCDay()+6)%7))/7);
    return y+'-W'+String(wk).padStart(2,'0');
  }
  if(pk && pk[0]==='B') return pk.slice(1,8);  /* biweekly is UI history — the server files monthly (0003) */
  return pk;
};
/* the inverse, for hydration: server keys → the M/W keys periodFor() builds */
const uiPeriodKey=k=>{
  if(/^\d{4}-\d{2}$/.test(k)) return 'M'+k;
  const m=/^(\d{4})-W(\d{2})$/.exec(k);
  if(m){
    const jan4=new Date(Date.UTC(+m[1],0,4));
    const mon=new Date(jan4); mon.setUTCDate(jan4.getUTCDate()-((jan4.getUTCDay()+6)%7)+(+m[2]-1)*7);
    return 'W'+mon.toISOString().slice(0,10);
  }
  return k;
};
const srvId=v=>v&&String(v).length>10;
