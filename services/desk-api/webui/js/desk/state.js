/* ==========================================================================
   js/desk/state.js — the state object, hydrated collections, static catalogs,
   RBAC, visibility scope and business-hours/SLA math.
   Owns: state (incl. state.prefs — per-user UI prefs) ·
   GROUPS/AGENTS/CLIENTS/ATYPES/STATES/PRIOS/SLA/BIZ/DESK_UI/MAILBOXES/
   GROUP_SENDAS/GROUP_SENDAS_OVR/RULES/TRIGGERS/CANNED/TITLES/AGENT_SIGS/
   VCFG/AUTH_CFG/GRAPH_AUTH/MAILCFG/SECRETS (all start EMPTY — mapIn() in
   api.js is the ONE place bootstrap data enters them) · static catalogs
   (ST_DECOR, ST_PALETTE, DEFAULT_OVERVIEWS, TRIG_EVENTS, PERM_CATALOG/ALL_PERMS/PRESETS,
   PROJ_TEMPLATES, ENTRA_COLMAP, NAV, PAGES) · can()/canView() ·
   ticketVisible/scoped/tk/isDone · effectiveOverviews/shownDashboardStates/
   savePrefs · isBizTime/addBizHours/slaInfo · log/notify/signOut ·
   csvEsc/downloadCSV · art()/mkTicket().
   Endpoints: POST /auth/logout (signOut) · PUT /auth/me/prefs (savePrefs).
   Invariants: identity and permissions come ONLY from /api/bootstrap `me`;
   every rendered collection is fed by mapIn(), never seeded here.
   ========================================================================== */

const state = {
  view:'dashboard', ticketId:null, clientId:null,
  perms:new Set(), meId:null,
  prefs:{},            // per-user UI prefs — bootstrap me.prefs; savePrefs() mirrors
  user:{ name:'', initials:'', role:'' },
  overview:'myopen', qf:{ group:[], prio:[], client:[], st:[], tag:[], scope:'', q:'' },   /* multi-selects: empty = all; scope ''=anyone */
  composer:{ kind:'reply', typeId:null, logTime:true },
  notifs:[], bulk:[], searchQ:'',
  timer:null,          // { ticketId, startedReal }  — the native note timer
  verify:{},           // ticketId → { code, method, masked, attempts, expires }
  audit:[], tickets:[], nextId:0,
  roleDefs:[], openRole:null,
  hydrated:false,      // flips true in mapIn(); render() shows Loading… until then
  /* runtime keys views add on demand:
     ticketSeq (id floor, set by mapIn) · teSeq/nSeq (entry/notif counters) ·
     editTitle · ccOpen · plainMail · _draft · _rotating (secret being rotated) ·
     af (audit filters) · rf (report filters) */
};

/* ---- hydrated collections — ALL empty until mapIn() fills them ---------- */
const GROUPS = [];
const AGENTS = [];
const CLIENTS = [];
const ATYPES = [];
const STATES = [];
const PRIOS = [];
/* SLA policy: hours to first response / to resolution, keyed by priority rank */
const SLA = {};
/* business calendar — SLA hours only tick inside working time */
const BIZ = { days:[], start:0, end:0, holidays:[] };
/* admin UI defaults — app_config key desk_ui:
   {overviews:[OverviewDef,...], dashboardStates:[label,...]}; empty = shipped defaults */
const DESK_UI = {};
const MAILBOXES = [];
/* outbound routing: every reply goes out from the ticket's BOARD address —
   an explicit group_sendas override (0026) when set, else derived from the
   board's fed-by mailbox. Tickets never choose their sender. */
const GROUP_SENDAS = {};       // group id → effective outbound mailbox id
const GROUP_SENDAS_OVR = {};   // group id → true when an explicit override row is set
const RULES = [];
const TRIGGERS = [];
const CANNED = [];
const TITLES = {};       // ticket id → display title
const AGENT_SIGS = {};   // agent id → display line (name · role); nothing mails these
const VCFG = { sms:{enabled:false}, email:{enabled:false}, ttlMin:5, attempts:3, postToThread:true };
const AUTH_CFG = {};
/* the ONE Entra app registration every mailbox + the verification sender
   authenticate through; `scopes` is the registration's static scope set */
const GRAPH_AUTH = { connected:false, clientId:'', consentedAt:null, consentedBy:'',
  scopes:['Mail.Read (application)','Mail.Send (application)','offline_access'] };
/* master send switch — mail.outbound_enabled on the server; hydrated from
   bootstrap's outboundEnabled. false = recorded-only (replies stored, not sent) */
const MAILCFG = { outboundEnabled:false };
/* secrets are WRITE-ONLY: stored encrypted server-side; only set/rotated
   metadata is ever readable here */
const SECRETS = {};

/* local id counters for optimistic rows — the server id arrives on rehydrate */
let nextMbIx = 1, nextRuleIx = 1, nextTrigIx = 1, nextCannedIx = 1;

/* ---- static catalogs (vocabularies — never hydrated, by design) --------- */
/* core ticket-state styling + settings copy; server rows carry id/label/type,
   presentation lives here */
const ST_DECOR = {
  new:     { cls:'st-new',     desc:'Just arrived — first-response SLA is running.' },
  open:    { cls:'st-open',    desc:'An agent owns it and is working.' },
  pending: { cls:'st-pending', desc:'Waiting on the customer; auto-reminds, then closes.' },
  hold:    { cls:'st-hold',    desc:'Parked — SLA clock paused until re-opened.' },
  solved:  { cls:'st-solved',  desc:'Fixed; closes itself after 48h without a reply.' },
  closed:  { cls:'st-closed',  desc:'Done. A customer reply re-opens it.' },
};
/* per-state color vocabulary (0027): a state's stored color is one of these
   TOKENS — each token IS a chip class css/desk.css already ships (the st-*
   state family; no new colors invented), labelled for the Settings swatches.
   settings.py validates stored colors against this SAME literal token list
   (bug #22 class: both sides pinned to one vocabulary — a comment there
   points back here; change one, change both). */
const ST_PALETTE = [
  { tok:'st-new',     label:'Teal'  },
  { tok:'st-open',    label:'Blue'  },
  { tok:'st-pending', label:'Brass' },
  { tok:'st-hold',    label:'Slate' },
  { tok:'st-solved',  label:'Green' },
  { tok:'st-closed',  label:'Gray'  },
];
/* the shipped queue tabs, expressed as OverviewDefs — the pinned filter
   vocabulary both sides speak (design §Storage): id/label/scope +
   optional stateKinds/states/groups/clients/prios/tags/recentDays; an
   omitted key means no constraint. Out of the box the evaluator over these five is
   behavior-identical to the old fixed tab bar: 'done' deliberately ships
   with NO recentDays window ("Recently solved" always showed every done
   ticket), and the evaluator keeps the two permission quirks the vocabulary
   cannot express — scope:'unassigned' tabs hide without can('assign'), and
   the 'allopen' tab is labelled "Group open" when !can('view_all'). */
const DEFAULT_OVERVIEWS = [
  { id:'myopen',     label:'My assigned',     scope:'mine',       stateKinds:['open','paused'] },
  { id:'unassigned', label:'Unassigned',      scope:'unassigned', stateKinds:['open','paused'] },
  { id:'allopen',    label:'All open',        scope:'all',        stateKinds:['open','paused'] },
  { id:'pending',    label:'Pending / hold',  scope:'all',        stateKinds:['paused'] },
  { id:'done',       label:'Recently solved', scope:'all',        stateKinds:['done'] },
];
/* trigger activators — the builder's event vocabulary (execution is the
   mail-worker's engine; the UI only edits definitions) */
const TRIG_EVENTS = [
  { id:'create',   label:'Ticket created' },
  { id:'followup', label:'Customer follow-up received' },
  { id:'state',    label:'State changed to …' },
  { id:'priority', label:'Priority changed' },
  { id:'owner',    label:'Owner assigned' },
];
/* RBAC — same model as Ledger: a permission matrix assigned per role.
   Docket is the source of truth for roles; Ledger reads the same tables. */
const PERM_CATALOG = [
  { id:'view_own',       label:'View own tickets',                        group:'Visibility' },
  { id:'view_group',     label:"View tickets in my groups",               group:'Visibility' },
  { id:'view_all',       label:'View every ticket',                       group:'Visibility' },
  { id:'see_billing',    label:'See logged time & Ledger links',          group:'Visibility' },
  { id:'create',         label:'Create tickets',                          group:'Working' },
  { id:'reply',          label:'Send public replies',                     group:'Working' },
  { id:'note',           label:'Add internal notes',                      group:'Working' },
  { id:'log_time',       label:'Log time (feeds the Ledger)',             group:'Working' },
  { id:'verify_identity',label:'Run caller verification (SMS/email code)',group:'Working' },
  { id:'assign',         label:'Assign owner & move between groups',      group:'Triage' },
  { id:'edit_props',     label:'Change state, priority & tags',           group:'Triage' },
  { id:'close',          label:'Solve & close tickets',                   group:'Triage' },
  { id:'view_clients',   label:'View the client directory',               group:'Clients' },
  { id:'add_contacts',   label:'Add contacts to clients',                 group:'Clients' },
  { id:'manage_clients', label:'Edit clients & contacts',                 group:'Clients' },
  { id:'view_projects',  label:'See the Projects tab & open projects',    group:'Projects' },
  { id:'manage_projects',label:'Create projects, edit checklists & billing, submit for review', group:'Projects' },
  { id:'approve_projects',label:'Approve reviewed projects (bills to Ledger)', group:'Projects' },
  { id:'export_csv',     label:'Export & copy CSV data',                  group:'Admin' },
  { id:'manage_roles',   label:'Manage roles & access',                   group:'Admin' },
  { id:'manage_automations', label:'Manage automations & mail ingestion', group:'Admin' },
  { id:'manage_settings',label:'Manage groups, SLA & channels',           group:'Admin' },
  { id:'view_audit',     label:'View the audit log',                      group:'Admin' },
];
const ALL_PERMS = PERM_CATALOG.map(p=>p.id);
const PRESETS = {
  Technician:['view_own','view_group','create','reply','note','log_time','close','view_clients','add_contacts','verify_identity','view_projects'],
  Dispatcher:['view_own','view_group','view_all','see_billing','create','reply','note','log_time','assign','edit_props','close','view_clients','add_contacts','verify_identity','export_csv','view_projects','manage_projects'],
  Admin: ALL_PERMS.slice(),
};
const PROJ_TEMPLATES = [
  { id:'blank', name:'Blank project', tasks:[] },
  { id:'onboard', name:'Client onboarding', tasks:['Discovery & audit','Network & firewall setup','Workstation rollout','M365 / email migration','Documentation & handoff'] },
  { id:'srvmig', name:'Server migration', tasks:['Pre-migration audit','New host provisioning','Data migration','Cutover & DNS','Decommission & documentation'] },
];
/* Entra CSV contact import — recognized column headers per field */
const ENTRA_COLMAP = {
  name:['displayname','name','fullname'], email:['mail','emailaddress','userprincipalname','upn','email'],
  title:['jobtitle','title'], dept:['department','dept'], phone:['businessphones','telephonenumber','phone','officephone'], mobile:['mobilephone','mobile'],
};

/* ---- RBAC ---- */
const can = p => state.perms.has(p);
const me = () => agent(state.meId);

/* ---- lookups ---- */
const st8 = id => STATES.find(s=>s.id===id);
const grp = id => GROUPS.find(g=>g.id===id);
const agent = id => AGENTS.find(a=>a.id===id);
const client = id => CLIENTS.find(c=>c.id===id);
const contact = id => { for(const c of CLIENTS){ const p=c.contacts.find(p=>p.id===id); if(p) return p; } return null; };
const atype = id => ATYPES.find(a=>a.id===id) || {name:'Unclassified', billable:false, active:false};
const prio = id => PRIOS.find(p=>p.id===id);
/* archive-aware pickers: archived entries keep their history but leave every picker */
const isArch = x => x && x.active===false;
const aGROUPS = () => GROUPS.filter(g=>!isArch(g));
const aSTATES = () => STATES.filter(s=>!isArch(s));
const aPRIOS  = () => PRIOS.filter(p=>!isArch(p));
const aATYPES = () => ATYPES.filter(x=>!isArch(x));
const mbox = id => MAILBOXES.find(m=>m.id===id);
function outboundBoxes(){ return MAILBOXES.filter(m=>m.outbound && m.status==='connected'); }
function outboundFor(t){
  const ok = m => m && m.outbound && m.status==='connected';
  if(ok(mbox(GROUP_SENDAS[t.groupId]))) return mbox(GROUP_SENDAS[t.groupId]);
  return outboundBoxes()[0] || MAILBOXES[0];
}
function firstLine(t){ return t.title || (t.articles[0]?.body||'').split(/[.!?\n]/)[0].slice(0,80); }

/* ---- caller verification helpers (masking mirrors the verify service) ---- */
const VERIFIED_TAG = 'identity-verified';
const maskPhone = n => '***' + String(n).replace(/\D/g,'').slice(-4);
const maskEmail = e => { const [u,d] = String(e).split('@'); return (u[0]||'*') + '***@' + (d||''); };

/* rule/trigger conditions: rows AND within a group, groups OR together.
   Legacy flat list = one group; one group saves FLAT so old rules keep shape. */
function condGroups(conds){
  const c = JSON.parse(JSON.stringify(conds||[]));
  if(!c.length) return [];
  return c.every(x=>Array.isArray(x)) ? c.filter(g=>g.length) : [c];
}
function packGroups(groups){
  const g = (groups||[]).map(grp=>grp.filter(c=>String(c.value||'').trim())).filter(grp=>grp.length);
  return g.length===0 ? [] : (g.length===1 ? g[0] : g);
}
function groupsWhen(conds, fmt){
  const gs = condGroups(conds);
  if(!gs.length) return '';
  const parts = gs.map(g=>g.map(fmt).join(' and '));
  return gs.length>1 ? parts.map(s=>`(${s})`).join(' or ') : parts[0];
}

/* ---- visibility scope ---- */
function ticketVisible(t){
  if(!t) return false;
  if(can('view_all')) return true;
  if(can('view_group') && me().groups.includes(t.groupId)) return true;
  if(can('view_own') && t.ownerId===state.meId) return true;
  return false;
}
const scoped = () => state.tickets.filter(ticketVisible);
const tk = id => state.tickets.find(t=>t.id===id);
const isDone = t => (st8(t.st)||{}).type==='done';

/* ---- overviews & per-user prefs ---- */
/* effective queue tabs: admin defaults (desk_ui.overviews when non-empty,
   else DEFAULT_OVERVIEWS), minus prefs.overviews.hidden, reordered by
   .order (unlisted ids keep admin order, after the listed ones), plus the
   user's .custom defs at the end. Returns shallow copies — the evaluator
   decorates rows (counts) without touching the catalogs. */
/* the admin tab list with the shipped-default fallback — the ONE resolver
   every consumer uses (evaluator, Customize modal, Settings card) */
function adminOverviews(){
  return (Array.isArray(DESK_UI.overviews) && DESK_UI.overviews.length)
    ? DESK_UI.overviews : DEFAULT_OVERVIEWS;
}
function effectiveOverviews(){
  /* admin archive-style hide (active:false) filters here — the read seam */
  const admin = adminOverviews().filter(o=>!isArch(o));
  const p = state.prefs.overviews || {};
  const hidden = p.hidden || [];
  let base = admin.filter(o=>!hidden.includes(o.id));
  if(Array.isArray(p.order) && p.order.length){
    const pos = id => { const i=p.order.indexOf(id); return i<0 ? p.order.length : i; };
    base = base.slice().sort((a,b)=>pos(a.id)-pos(b.id));
  }
  const out = base.concat((p.custom||[]).filter(o=>!hidden.includes(o.id)))
    .map(o=>Object.assign({},o));
  /* a queue with zero tabs cannot render — inconsistent prefs fall back */
  return out.length ? out
       : (admin.length ? admin : DEFAULT_OVERVIEWS).map(o=>Object.assign({},o));
}
/* dashboard Queue-by-state visibility: the prefs list when present, else the
   admin default — both lists are SHOWN labels; absent = all active states.
   Rendering keeps the server's position order (STATES arrives sorted). */
function shownDashboardStates(){
  const shown = state.prefs.dashboardStates || DESK_UI.dashboardStates;
  const base = aSTATES();
  return Array.isArray(shown) ? base.filter(s=>shown.includes(s.label)) : base;
}
/* per-user prefs mirror: merge PART (top-level keys, whole subtrees) into
   state.prefs and PUT the whole object — the server upserts uprefs:<uuid>
   keyed off the session. Diff-guarded (row 21): an unchanged merge never
   calls out. oops() rolls back by rehydrating (mapIn restores me.prefs). */
function savePrefs(part){
  const next = Object.assign({}, state.prefs, part);
  /* null = clear the key: §Storage pins "absent key = follow admin default" */
  Object.keys(next).forEach(k=>{ if(next[k]===null) delete next[k]; });
  if(JSON.stringify(next)===JSON.stringify(state.prefs)) return;
  state.prefs = next; render();
  $fetch('/auth/me/prefs',{method:'PUT',
    headers:{'Content-Type':'application/json'},body:JSON.stringify(state.prefs)})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); })
    .catch(()=>oops());
}

/* ---- SLA: first-response due until an agent replies; then resolution due.
   SLA hours only tick inside working time; the walk is 15-min steps
   (fast enough at SLA scale). ---- */
function isBizTime(ms){
  const d = new Date(ms);
  if(!BIZ.days.includes(d.getDay())) return false;
  if(BIZ.holidays.includes(msDate(ms))) return false;
  const hr = d.getHours() + d.getMinutes()/60;
  return hr >= BIZ.start && hr < BIZ.end;
}
function addBizHours(startMs, hours){
  let remaining = hours*60, t = startMs;
  const STEP = 15;
  let guard = 0;
  while(remaining > 0 && guard++ < 40000){
    if(isBizTime(t)) remaining -= STEP;
    t += STEP*MIN;
  }
  return t;
}
function slaInfo(t){
  if((st8(t.st)||{}).type!=='open') return null;
  const pol = SLA[t.prio];
  if(!pol) return null;                 // no policy configured for this tier
  if(!t.slaFrMet){
    const due = addBizHours(t.createdAt, pol.fr);
    return { kind:'First response', due, breached: nowMs()>due };
  }
  const due = addBizHours(t.createdAt, pol.res);
  return { kind:'Resolution', due, breached: nowMs()>due };
}

/* ---- audit + session ---- */
function log(action, detail){ state.audit.unshift({ ts:nowMs(), who:state.user.name, action, detail }); }
function signOut(){
  /* one shared session: ending it here signs Ledger out too. Navigate the
     TOP window so the whole suite leaves, not just this pane. */
  fetch('/auth/logout',{method:'POST',credentials:'same-origin'})
    .finally(()=>{ try{ (window.top||window).location.href='/ui/login.html'; }
                   catch(e){ location.href='/ui/login.html'; } });
}
/* CSV: rows = array of arrays; downloads client-side */
function csvEsc(v){ v = String(v ?? ''); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
function downloadCSV(name, rows){
  const csv = rows.map(r=>r.map(csvEsc).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = name; a.click();
  log('CSV exported', `${name} · ${rows.length-1} rows`);
  toast(`${name} — ${rows.length-1} rows.`);
}

/* ---- ticket construction (optimistic rows; the server row replaces them
   on the next hydrate) ---- */
let AID = 1;
const art = (kind, author, ts, body, extra={}) => Object.assign({ id:'ar'+(AID++), kind, author, ts, body }, extra);
/* kinds: 'mail-in' (customer email) · 'reply' (agent, public) · 'note' (internal) · 'sys' */

function mkTicket(t){
  t.tags = t.tags||[]; t.articles = t.articles||[]; t.time = t.time||[];
  /* one object per entry: the article chip and the ticket's time list must be
     the same record, so an edit in either place is an edit everywhere */
  t.articles.forEach(a=>{ if(a.time && !t.time.includes(a.time)){
    const m = t.time.find(e=>!e._ln && e.techId===a.time.techId && e.h===a.time.h && e.typeId===a.time.typeId);
    if(m){ a.time = m; m._ln = true; } } });
  t.time.forEach(e=>{ delete e._ln;
    if(!e.eid) e.eid = 'te'+(state.teSeq=(state.teSeq||0)+1);
    if(!e.endedAt){ const holder=t.articles.find(a=>a.time===e); const end=holder?holder.ts:(t.updatedAt||nowMs());
      e.endedAt=end; e.startedAt=end - e.h*H; }
    e.h = spanH(e.startedAt, e.endedAt); });
  t.createdAt = t.articles.length? t.articles[0].ts : nowMs();
  t.updatedAt = t.articles.length? t.articles[t.articles.length-1].ts : t.createdAt;
  state.tickets.push(t); return t;
}

/* ---- navigation catalog ---- */
const NAV = [
  { id:'dashboard', label:'Dashboard',      ic:IC.dash,    show:()=>true },
  { id:'tickets',   label:'Tickets',        ic:IC.ticket,  show:()=>true },
  { id:'projects',  label:'Projects',       ic:IC.proj,    show:()=>can('view_projects') },
  { id:'clients',   label:'Clients',        ic:IC.client,  show:()=>can('view_clients') },
  { id:'reports',   label:'Reports',        ic:IC.report,  show:()=>can('view_all') },
  { id:'automations',label:'Automations',   ic:IC.mail,    show:()=>can('manage_automations') },
  /* tail order mirrors Ledger's rail exactly: Audit Log → Directory → Settings */
  { id:'audit',     label:'Audit Log',      ic:IC.audit,   show:()=>can('view_audit') },
  { id:'directory', label:'Directory',      ic:IC.client,  show:()=>can('manage_settings')||can('manage_roles') },  /* person icon — matches Ledger's rail */
  { id:'settings',  label:'Settings',       ic:IC.settings,show:()=>can('manage_settings') },
];
const PAGES = {
  dashboard:{ t:'Dashboard', s:()=> can('view_all') ? `Queue health across every group · ${fmtDT(nowMs())}` : `Your queue · ${fmtDT(nowMs())}` },
  tickets:{ t:'Tickets', s:()=> can('view_all') ? 'Every ticket, every group — the working queue' : 'Tickets assigned to you and your groups' },
  projects:{ t:'Projects', s:()=>'Checklist-driven project tickets — time lands under each task; approval bills the project to Ledger' },
  ticket:{ t:'Ticket', s:()=>{ const t=tk(state.ticketId); return t? `${esc(client(t.clientId).name)} · opened ${fmtAgo(t.createdAt)}` : ''; } },
  clients:{ t:'Clients', s:()=>'Shared directory — the same organisations Ledger bills' },
  clientv:{ t:'Client', s:()=>{ const c=client(state.clientId); return c? `${esc(c.name)} · contacts & ticket history` : ''; } },
  reports:{ t:'Reports', s:()=>'Ticket volume, response times and workload' },
  automations:{ t:'Automations', s:()=>'Graph mail ingestion — mailboxes, boards and rules' },
  settings:{ t:'Settings', s:()=>'Groups, states, SLA targets and mail channels' },
  directory:{ t:'Directory', s:()=>'The shared control plane — one set of clients, groups, agents and activity types for every app' },
  audit:{ t:'Audit Log', s:()=>'Immutable record of every change' },
};
function canView(v){
  if(v==='ticket') return true;
  if(v==='clientv') return can('view_clients');
  const n = NAV.find(n=>n.id===v); return n ? n.show() : false;
}
