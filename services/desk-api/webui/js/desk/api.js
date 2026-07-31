/* ==========================================================================
   js/desk/api.js — server I/O foundation.
   Owns: $fetch · mapIn() (the ONE place bootstrap data enters state — every
   key the server emits is consumed here: me, groups, agents, clients, atypes,
   states, priorities, canned, graph, vcfg, authCfg, secretMeta,
   outboundEnabled, mailboxes, roles, rules, sla, biz, tickets, audit,
   notifs) · hydrate() · oops() · attOpen() · stageUploads() ·
   srvId/isUuid/iso/typeName · ME (session identity) · HYD (focus throttle).
   Endpoints: GET /api/bootstrap · GET /api/attachments/{id} · POST /api/uploads.
   Invariants: hydration failure is LOUD — ⚠ title + alert (bug #13), never
   silent. Fetch paths are absolute per origin (bug #8).
   ========================================================================== */

const $fetch = (p,opt)=>fetch(p,{credentials:'same-origin',...(opt||{})});
let ME=null, HYD=0;

function mapIn(d){
  GROUPS.length=0; d.groups.forEach(g=>GROUPS.push(g));
  /* agent rows ride whole — including hasPassword/mfa, which the Directory's
     credential badges render */
  AGENTS.length=0; d.agents.forEach(a=>AGENTS.push(a));
  CLIENTS.length=0; d.clients.forEach(c=>CLIENTS.push(c));
  ATYPES.length=0; d.atypes.forEach(a=>ATYPES.push(a));
  STATES.length=0;
  d.states.forEach(s=>{ const dec=ST_DECOR[s.id];
    STATES.push({ id:s.id, label:s.label, type:s.type, sid:s.sid,
      cls:dec? dec.cls : (s.id==='child-closed'?'st-closed':'st-hold'),
      desc:dec? dec.desc : '', core:!!dec,
      active:s.active!==false, system:s.system===true }); });
  if(d.priorities){
    PRIOS.length=0;
    /* the UI keys priorities by rank (tickets carry the rank); the server
       uuid rides along as pid for the Settings editor's PATCH */
    d.priorities.forEach(p=>PRIOS.push({ id:p.rank, pid:p.id, label:p.label,
      rank:p.rank, cls:'p'+Math.min(4,Math.max(1,Number(p.rank)||1)),
      active:p.active!==false }));
  }
  state.tickets.length=0;
  d.tickets.forEach(t=>{
    t.tags=t.tags||[]; t.articles=t.articles||[]; t.time=t.time||[];
    /* article↔entry linkage (0012): same object on both sides, so an edit
       in either place is an edit everywhere — mirrors mkTicket's contract */
    t.time.forEach(e=>{ if(e.articleId){
      const a=t.articles.find(x=>x.id===e.articleId); if(a) a.time=e; } });
    state.tickets.push(t);
  });
  state.audit.length=0; d.audit.forEach(a=>state.audit.push(a));
  if(d.mailboxes){
    if(typeof d.outboundEnabled!=='undefined') MAILCFG.outboundEnabled = !!d.outboundEnabled;
    MAILBOXES.length=0;
    d.mailboxes.forEach(m=>MAILBOXES.push(m));
    if(!MAILBOXES.length) MAILBOXES.push({id:'mb0',addr:'(no mailbox configured)',
      type:'shared',groupId:(GROUPS[0]||{}).id,prio:2,outbound:false,
      desc:'Add one via /api/settings/mailboxes',status:'paused',today:0});
    Object.keys(GROUP_SENDAS).forEach(k=>delete GROUP_SENDAS[k]);
    GROUPS.forEach(g=>{ const m=MAILBOXES.find(x=>x.groupId===g.id)||MAILBOXES[0];
      if(m) GROUP_SENDAS[g.id]=m.id; });
  }
  try{
  /* automations — the engine is the mail-worker's: builders hydrate server
     rules in their own vocabulary; runs counters are the worker's real tallies */
  RULES.length=0; TRIGGERS.length=0;
  if(d.rules){
    (d.rules.mail||[]).forEach(r=>RULES.push(r));
    (d.rules.triggers||[]).forEach(g=>TRIGGERS.push(g));
  }
  if(d.sla) Object.keys(d.sla).forEach(k=>{ const p=d.sla[k];
    if(p&&p.fr!=null) SLA[Number(k)]={fr:Number(p.fr),res:Number(p.res)}; });
  if(d.biz){
    /* bug #29: tolerate every shape any writer produced — 8, "8", "08:00".
       A string here made isBizTime() always-false and guard-capped SLA at 416d */
    const hn=v=>{ if(typeof v==='string'&&v.includes(':')){ const p=v.split(':');
        const h=parseFloat(p[0]); return isNaN(h)?null:h+((parseFloat(p[1])||0)/60); }
      const n=Number(v); return isNaN(n)?null:n; };
    if(Array.isArray(d.biz.days)){ const ds=d.biz.days.map(Number).filter(n=>!isNaN(n));
      if(ds.length) BIZ.days=ds; }
    const _s=hn(d.biz.start), _e=hn(d.biz.end);
    if(_s!=null) BIZ.start=_s;
    if(_e!=null) BIZ.end=(_e>(_s!=null?_s:BIZ.start))?_e:BIZ.start+1;
    if(Array.isArray(d.biz.holidays)) BIZ.holidays=d.biz.holidays;
    if(d.biz.tz) BIZ.tz=d.biz.tz;
  }
  if(d.notifs){ state.notifs.length=0; d.notifs.forEach(n=>state.notifs.push(n)); }
  d.tickets.forEach(t=>{ if(t.title) TITLES[t.id]=t.title; });
  AGENTS.forEach(a=>{ AGENT_SIGS[a.id]=a.name+(a.role?' · '+a.role:''); });
  if(d.authCfg) Object.assign(AUTH_CFG, d.authCfg);
  if(d.graph){
    GRAPH_AUTH.connected=!!d.graph.connected;
    GRAPH_AUTH.clientId=d.graph.clientId||'—';
    GRAPH_AUTH.consentedAt=d.graph.at||null;
    GRAPH_AUTH.consentedBy=d.graph.by||'—';
    if(d.graph.tenant){ GRAPH_AUTH.tenant=d.graph.tenant; AUTH_CFG.tenant=AUTH_CFG.tenant||d.graph.tenant; }
  }
  if(d.canned){ CANNED.length=0; d.canned.forEach(c=>CANNED.push(c)); }
  if(d.vcfg&&Object.keys(d.vcfg).length){
    ['sms','email'].forEach(k=>{ if(d.vcfg[k]) Object.assign(VCFG[k]=VCFG[k]||{}, d.vcfg[k]); });
    ['ttlMin','attempts','postToThread'].forEach(k=>{ if(d.vcfg[k]!=null) VCFG[k]=d.vcfg[k]; });
  }
  if(d.secretMeta){
    const put=(slot,name,label)=>{ const m=d.secretMeta[name];
      SECRETS[slot]= m? {set:true, at:m.at, by:m.by, label} : {set:false, at:null, by:'', label}; };
    put('graphSecret','graph','Graph app client secret');
    put('entraSecret','entra_oidc','Entra OIDC client secret');
    put('voipKey','voipms','voip.ms API password');
    put('twilioToken','twilio','Twilio auth token');
  }
  }catch(err){ console.error('cosmetic hydration failed (core data is live):', err); }
  if(d.roles){
    state.roleDefs.length=0;
    d.roles.forEach(r=>state.roleDefs.push({name:r.name,note:r.note||'',
      perms:new Set(r.perms),members:AGENTS.filter(a=>a.role===r.name).length,
      core:r.core,entra:r.entra||''}));
  }
  ME=d.me;
  state.user={name:ME.name,initials:ME.initials,role:'Live'};
  state.meId=(AGENTS.find(a=>a.email===ME.email)||{}).id||ME.id;
  state.perms=new Set(ME.perms);
  state.overview = state.perms.has('view_all') ? 'allopen' : 'myopen';
  state.ticketSeq=Math.max(100000,...state.tickets.map(t=>t.id));
  state.nextId=state.ticketSeq+1;
  state.hydrated=true;
}

async function hydrate(keepView){
  const r=await $fetch('/api/bootstrap');
  if(r.status===401){ location.href='login.html'; return; }
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    document.title='⚠ LIVE SYNC FAILED — Docket';
    console.error('bootstrap failed', r.status, d);
    alert('Live sync failed ('+r.status+'): '+(d.detail||'server error')+'\nShowing stale data — check desk-api logs.');
    return;
  }
  const d=await r.json();
  const keep={view:state.view,ticketId:state.ticketId,clientId:state.clientId,
              qf:state.qf,searchQ:state.searchQ,overview:state.overview};
  mapIn(d);
  if(keepView!==false) Object.assign(state,keep);
  if(state.ticketId && !state.tickets.some(t=>t.id===state.ticketId)){
    state.view='tickets'; state.ticketId=null; }
  render();
}

const typeName=id=>(ATYPES.find(a=>a.id===id)||{}).name||'Unclassified';
const iso=ms=>new Date(ms).toISOString();
const srvId=v=>v&&String(v).length>10;              // server uuid vs local id
const isUuid=v=>/^[0-9a-f]{8}-/.test(String(v));
const oops=async d=>{ alert((d&&d.detail)? 'Server declined: '+d.detail
  : 'Live sync failed — check desk-api logs'); await hydrate(); };

function attOpen(id){
  if(id) window.open('/api/attachments/'+id,'_blank');
  else toast('This file is still uploading — try again in a moment.');
}

/* staged composer files first (each returns its row id); the article that
   claims them comes after — the server links the rows and mails them on
   replies. Resolves to the ids of the newly staged files. */
function stageUploads(atts){
  const staged=(atts||[]).filter(f=>f._file);
  return Promise.all(staged.map(f=>{
    const fd=new FormData(); fd.append('file', f._file, f.name);
    return $fetch('/api/uploads',{method:'POST',body:fd})
      .then(async r=>{ if(!r.ok) throw await r.json().catch(()=>0);
        const d=await r.json(); f.id=d.id; delete f._file; return d.id; });
  }));
}
