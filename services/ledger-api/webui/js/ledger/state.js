/* ==========================================================================
   Ledger — state.js
   The single state object — every collection starts EMPTY; api.js/mapIn()
   is the only place bootstrap data enters — plus the static catalogs
   (NAV, PAGES, NAV_PERM, AF_DEFAULTS, TS_STATUS_CHIP), the router
   (go/openClient), the RBAC helpers and signOut(). Identity and permissions
   come only from bootstrap `me`. No server calls except signOut()'s
   POST /auth/logout — desk-api's route (one shared session, both apps),
   posted at the origin root, deliberately never through $fetch/LBASE.
   ========================================================================== */

const state = {
  view:'dashboard',
  hydrated:false,                // first successful bootstrap flips this; #content shows "Loading…" until then
  myTechId:null,                 // own tech identity (for "own" scoping) — set from bootstrap me
  perms:null,                    // Set of permission ids — set from bootstrap me
  user:{ name:'', initials:'', email:'' },

  settings:{
    currency:'USD', host:'',
    defaultCycle:'monthly',        // global default billing cycle
    defaultBillable:true,          // new activity types default billable?
    rounding:'none',               // display of raw hours; billing rounds per policy
    minMinutes:0,
    odoo:{ url:'', db:'', user:'', apiKey:'', journal:'Customer Invoices', enabled:false, mode:'draft' },
    retainers:{ enabled:true }   /* module switch — turn off if Odoo owns agreements */
  },

  clients:[],       // the shared directory Docket reads and writes too
  techs:[],         // agents shared with Docket; groups = the groups they belong to
  zammadGroups:[],  // groups (ticket boards) — bootstrap-fed; suite-bridge events supplement live
  zammadRoles:[],   // roles — bootstrap-fed (name/note/archived + stripped l_* perms)
  types:[],         // activity types shared with Docket; billable + rate configured here
  projects:{},      // Docket-approved projects keyed by ticket # — flat-fee / task pricing overlay
  defaultRates:{},  // global default billing rates keyed by typeId — {rate, hist:[{from,rate}]}; per-client opt-in flags ride on each client (useDefaults/useDefaultsHist/defaultTypeFlags)
  entries:[],       // timesheet ledger
  periods:{},       // key `${clientId}|${periodKey}` -> {status, approvedAt, approvedBy, exportedAt, exportRef}
  audit:[],         // audit trail
  tf:{client:'all',tech:'all',status:'all',type:'all',q:'',from:'',to:'',expanded:null,sel:{},_vis:[]},
  seq:1000
};

/* Approvals and Audit filter their lists independently — separate objects,
   separate clear functions (setAF/afClear vs setAuf/clearAuf). */
const AF_DEFAULTS={ tech:'all', group:'all', client:'all', period:'all', status:'all', expanded:null };
state.af=Object.assign({},AF_DEFAULTS);   // Approvals filters
state.auf=null;                           // Audit filters — built on first visit

const TS_STATUS_CHIP={
  awaiting:`<span class="chip submitted"><span class="cdot"></span>Awaiting review</span>`,
  partial:`<span class="chip pending"><span class="cdot"></span>Partially submitted</span>`,
  open:`<span class="chip pending"><span class="cdot"></span>In progress</span>`,
  approved:`<span class="chip approved"><span class="cdot"></span>Approved</span>`,
  locked:`<span class="chip exported"><span class="cdot"></span>Period locked</span>`,
};

/* ==========================================================================
   ROUTER
   ========================================================================== */
const NAV=[
  {id:'dashboard', label:'Dashboard', ic:IC.dash},
  {id:'timesheets',label:'Timesheets',ic:IC.sheet},
  {id:'approvals', label:'Approvals', ic:IC.seal},
  {id:'clients',   label:'Clients',   ic:IC.client},
  {id:'types',     label:'Activity Types', ic:IC.tag},
  {id:'periods',   label:'Billing Periods',ic:IC.period},
  {id:'reports',   label:'Reports',    ic:IC.report},
  {id:'export',    label:'Odoo Export',ic:IC.export},
  {id:'audit',     label:'Audit Log',  ic:IC.audit},
  {id:'directory', label:'Directory',  ic:IC.client},
  {id:'settings',  label:'Settings',   ic:IC.settings},
];
const PAGES={
  dashboard:{t:'Dashboard', s:()=> isAdmin()?`Current cycle overview · ${fmtDate(NOW)}`:`Your time this cycle · ${fmtDate(NOW)}`},
  timesheets:{t:'Timesheets', s:()=> isAdmin()?'The billing ledger — every logged entry, priced per client':'Your logged time — classify each entry and submit it for review'},
  approvals:{t:'Approvals', s:()=>'Submitted timesheets, one per technician · client · billing period — review, approve or return'},
  clients:{t:'Clients', s:()=>'Client directory · click a client to configure billing, see its tickets, and set who can access it'},
  client:{t:'Client', s:()=>{ const c=client(state.clientId); return c?`${esc(c.name)} · configuration &amp; ticket breakdown`:'Client'; }},
  types:{t:'Activity Types', s:()=>'Shared with Docket · set billable status and rate for each'},
  periods:{t:'Billing Periods', s:()=>'Review, approve and lock a period per client'},
  reports:{t:'Reports', s:()=> isAdmin()?'Build and export billing &amp; productivity reports · any grouping, range or metric':'Your hours — build and export a report of your own logged time'},
  export:{t:'Odoo Export', s:()=>'Push approved periods to Odoo'},
  audit:{t:'Audit Log', s:()=>'Immutable record of every change, including entries removed in Docket'},
  directory:{t:'Directory', s:()=>'The shared control plane — mirrored live from Docket; edits happen there'},
  settings:{t:'Settings', s:()=>'Global defaults · per-client billing lives on each client page'},
};
function openClient(id){ if(!canView('client')) return; state.clientId=id; state.cf={tech:'all',type:'all',status:'all',q:'',from:'',to:''}; state.view='client'; closeMenus(); render(); }

function go(view){ if(!canView(view)) view='dashboard'; state.view=view; closeMenus(); render(); }

/* ---------------- RBAC ----------------
   A person's effective permissions are the union of their roles' permission
   sets, resolved server-side and delivered by bootstrap `me` (l_* perms,
   prefix stripped in mapIn). */
// nav item -> permission required to see it (null = any signed-in user)
const NAV_PERM={ dashboard:null, timesheets:'view', approvals:'approve', clients:'view_clients', types:'manage_types',
  periods:'approve', reports:'view', export:'export', audit:'view_audit', directory:'manage_settings', settings:'manage_settings' };

state.perms=new Set();   // empty until bootstrap answers — only Dashboard shows
function can(p){ return state.perms.has(p); }
function canView(view){
  if(view==='client') return can('view_clients');
  const need=NAV_PERM[view];
  if(need===null||need===undefined) return true;
  if(need==='view') return can('view_own')||can('view_all');
  return can(need);
}
function isAdmin(){ return can('view_all'); }        // "sees everyone" (scoping/columns)
function canSeeMoney(){ return can('see_amounts'); }
function myTechId(){ return can('view_all')? null : state.myTechId; }
// which clients this person may see/work on
function techGroups(tid){ const t=tech(tid); return (t&&t.groups)||[]; }
function canAccessClient(c){
  if(can('all_clients')) return true;
  const a=c.access; if(!a||a.mode==='all') return true;
  if(a.mode==='restricted') return (a.techs||[]).includes(state.myTechId);
  if(a.mode==='group'){ const mine=techGroups(state.myTechId); return (a.groups||[]).some(g=>mine.includes(g)); }
  return false;
}
function accessibleClients(){ return state.clients.filter(canAccessClient); }
function scopedEntries(){
  let es=state.entries;
  const id=myTechId(); if(id) es=es.filter(e=>e.techId===id);
  if(!can('all_clients')){ const ok=new Set(accessibleClients().map(c=>c.id)); es=es.filter(e=>ok.has(e.clientId)); }
  return es;
}
function myName(){ return state.user.name; }
// can the signed-in person edit this specific entry?
function canEditEntry(e){
  if(isLocked(e)||e.status==='void') return false;
  if(e.tsApproved) return false; /* manager sign-off freezes it — revoke on Approvals first */
  const own = e.techId===state.myTechId;
  if(!(can('edit_all')||(own&&can('edit_own')))) return false;
  if(e.submitted && !can('edit_submitted')) return false;
  return true;
}
function canSubmitEntry(e){
  if(isLocked(e)||e.status==='void'||e.submitted||atype(e.typeId).sentinel) return false;
  const own = e.techId===state.myTechId;
  return can('submit') && (own || can('edit_all'));
}
function canRecallEntry(e){
  if(isLocked(e)||e.status==='void'||!e.submitted||e.tsApproved) return false;
  const own = e.techId===state.myTechId;
  return (own && can('submit')) || can('edit_submitted');
}

/* ---- session ---- */
function signOut(){
  /* one shared session, and desk-api owns /auth: behind nginx both apps share
     the origin (LBASE '/ledger'), so POST the desk logout path at the ORIGIN
     ROOT — deliberately NOT via $fetch, which would prefix /ledger and miss
     (ledger-api has no /auth routes). Direct :8082 access just navigates to
     the desk login, the same redirect hydrate()'s 401 path uses. Navigate the
     TOP window so the whole suite leaves, not just this pane. */
  const dk=(typeof LBASE!=='undefined'&&LBASE)?'':location.protocol+'//'+location.hostname+':8081';
  const done=()=>{ try{ (window.top||window).location.href=dk+'/ui/login.html'; }
                   catch(e){ location.href=dk+'/ui/login.html'; } };
  if(!dk) fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).finally(done);
  else done();
}
