/* ==========================================================================
   Assets — api.js
   Hydration + the shared fetch plumbing every action function uses.
   Endpoints called here:
     GET /api/bootstrap                — hydrate(): the single source of state
   Shared helpers for the views: $fetch (ABASE-prefixed, bug #8), post
   (POST/PATCH/PUT + rehydrate), oops (alert + rehydrate).
   Invariant: mapIn() consumes EVERY bootstrap key the server emits
   (me, clients, assets, licenses, contracts, events, audit, cfg) — all 8,
   nothing dropped (hydration completeness, row 36).
   ========================================================================== */

/* behind nginx, Assets lives under /assets/ with the prefix stripped
   server-side — every server call gains the base; direct :8083 access
   keeps an empty base (bug #8: paths stay absolute per origin) */
const ABASE=location.pathname.startsWith('/assets/')?'/assets':'';
const $fetch=(p,o)=>fetch(ABASE+p,{credentials:'same-origin',...(o||{})});

function mapIn(d){
  state.clients.length=0;   d.clients.forEach(c=>state.clients.push(c));
  state.assets.length=0;    d.assets.forEach(a=>state.assets.push(a));
  state.licenses.length=0;  d.licenses.forEach(l=>state.licenses.push(l));
  state.contracts.length=0; d.contracts.forEach(c=>state.contracts.push(c));
  state.events.length=0;    d.events.forEach(e=>state.events.push(e));
  if(d.audit){ state.audit.length=0;
    d.audit.forEach(a=>state.audit.push({id:'srv'+a.ts+(a.entityId||''), ts:a.ts,
      actor:a.actor, action:a.action, detail:a.detail, entityId:a.entityId})); }
  state.auditTotal=d.auditTotal||state.audit.length;   /* tail horizon (audit) */
  if(d.cfg) state.cfg=d.cfg;
  state.user={name:d.me.name, initials:d.me.initials, email:d.me.email};
  state.perms=new Set(d.me.perms);   /* full ids, deliberately unstripped */
}

async function hydrate(){
  /* hydration failures are LOUD: ⚠ in the title + alert, never silent (bug #13) */
  let r;
  try{ r=await $fetch('/api/bootstrap'); }
  catch(err){
    document.title='⚠ LIVE SYNC FAILED — Assets';
    console.error('bootstrap unreachable', err);
    alert('Live sync failed — assets-api unreachable. Check the service and reload.');
    return;
  }
  if(r.status===401){ location.href=ABASE?'/ui/login.html'
    :location.protocol+'//'+location.hostname+':8081/ui/login.html'; return; }
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    document.title='⚠ LIVE SYNC FAILED — Assets';
    console.error('bootstrap failed', r.status, d);
    alert('Live sync failed ('+r.status+'): '+(d.detail||'server error')+' — check assets-api logs.');
    return;
  }
  mapIn(await r.json());
  state.hydrated=true;
  render();
}

const oops=async d=>{ alert((d&&d.detail)? 'Server declined: '+d.detail
  : 'Live sync failed — check assets-api logs'); hydrate(); };
const post=(method,p,body)=>$fetch(p,{method,headers:{'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined})
  .then(async r=>{ if(!r.ok){ await oops(await r.json().catch(()=>0)); return null; }
    setTimeout(hydrate,600); return r.json().catch(()=>({})); });
