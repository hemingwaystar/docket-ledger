/* ==========================================================================
   Assets — state.js
   The single state object — every collection starts EMPTY; api.js/mapIn()
   is the only place bootstrap data enters — plus the static catalogs
   (NAV, PAGES, NAV_PERM), the router (go), the RBAC helpers and signOut().
   Identity and permissions come only from bootstrap `me`.
   RBAC note: permission ids are used UNSTRIPPED (can('a_view')) — ledger's
   l_-strip lets unprefixed desk ids leak into its stripped set (recon
   finding); Assets deliberately checks full ids.
   ========================================================================== */

const state = {
  view:'overview',
  hydrated:false,                // first successful bootstrap flips this
  perms:new Set(),               // full a_* ids from bootstrap me
  user:{ name:'', initials:'', email:'' },

  clients:[],       // shared directory (light) — pickers exclude the sentinel
  assets:[],        // CIs
  licenses:[],      // software & licence pools (typed terms)
  contracts:[],     // vendor contracts & warranties (typed terms, assetIds embedded)
  events:[],        // per-entity attributed feed (assets.asset_events tail)
  audit:[],         // audit.events tail (app assets|auth), actor pre-resolved
  cfg:{ lapse_lead_days:60, lapse_group:'Alerts',
        lapse_kinds:{warranty:true, license:true, contract:true} },

  /* per-view filter bags */
  af:{status:'all', q:''},       // assets
  lf:{q:''},                     // licenses
  cf:{q:''},                     // contracts
  auf:{q:'', from:'', to:''},    // audit
  seq:1000
};

/* ==========================================================================
   ROUTER
   ========================================================================== */
const NAV=[
  {id:'overview',  label:'Overview',               ic:IC.overview},
  {id:'assets',    label:'Assets',                 ic:IC.assets},
  {id:'licenses',  label:'Software & Licenses',    ic:IC.license},
  {id:'contracts', label:'Contracts & Warranties', ic:IC.contracts},
  {id:'reports',   label:'Reports',                ic:IC.report},
  {id:'audit',     label:'Audit Log',              ic:IC.audit},
  {id:'settings',  label:'Settings',               ic:IC.settings},
];
const PAGES={
  overview:{t:'Overview', s:()=>fmtDate(localISODate())},
  assets:{t:'Assets', s:()=>''},
  licenses:{t:'Software & Licenses', s:()=>''},
  contracts:{t:'Contracts & Warranties', s:()=>''},
  reports:{t:'Reports', s:()=>''},
  audit:{t:'Audit Log', s:()=>''},
  settings:{t:'Settings', s:()=>''},
};
// nav item -> permission required to see it (null = any signed-in user)
const NAV_PERM={ overview:null, assets:'a_view', licenses:'a_view', contracts:'a_view',
  reports:'a_view', audit:'a_view_audit', settings:'a_manage_settings' };

function can(p){ return state.perms.has(p); }
function canView(view){
  const need=NAV_PERM[view];
  if(need===null||need===undefined) return true;
  return can(need);
}
function canSeeCosts(){ return can('a_see_costs'); }

function go(view){ if(!canView(view)) view='overview'; state.view=view; closeMenus(); render(); }

/* ---- session ----
   One shared session; desk-api owns /auth. Behind nginx both apps share the
   origin (ABASE '/assets'), so POST the desk logout path at the ORIGIN ROOT —
   deliberately NOT via $fetch, which would prefix /assets and miss. Direct
   :8083 access just navigates to the desk login (ledger's exact convention). */
function signOut(){
  const dk=(typeof ABASE!=='undefined'&&ABASE)?'':location.protocol+'//'+location.hostname+':8081';
  const done=()=>{ try{ (window.top||window).location.href=dk+'/ui/login.html'; }
                   catch(e){ location.href=dk+'/ui/login.html'; } };
  if(!dk) fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).finally(done);
  else done();
}
