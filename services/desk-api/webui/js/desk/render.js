/* ==========================================================================
   js/desk/render.js — the ONE innerHTML rebuild and everything around it.
   Owns: render()/renderNav() (focus/caret/scroll carry — bug #26) · router
   go()/openTicket()/openClient() · shared chip renderers · commitRender +
   input ergonomics listeners · modal/scrim · combo (searchable dropdown) ·
   toast · notification bell · global search.
   Endpoints: POST /api/automations/notifications/read (bellGo).
   Invariants: render() is the only #content rebuild (plus nav/title/badge);
   until the first hydrate lands it shows a plain Loading… card.
   ========================================================================== */

function go(v){ if(!canView(v)) v='dashboard'; state.view=v; render(); }
function openTicket(id){ const t=tk(id); if(!ticketVisible(t)) { toast('That ticket is outside your access.'); return; } state.ticketId=id; state.view='ticket'; state.composer={kind:'reply', typeId:null, logTime:true}; render(); }
function openClient(id){ if(!can('view_clients')) return; state.clientId=id; state.view='clientv'; render(); }

function renderNav(){
  const sc = scoped();
  const unassigned = sc.filter(t=>!t.ownerId && !isDone(t)).length;
  const breached = sc.filter(t=>{const s=slaInfo(t); return s&&s.breached;}).length;
  document.getElementById('nav').innerHTML =
    `<div class="nav-label">Workspace</div>` +
    NAV.filter(n=>n.show()).map(n=>{
      let pip='';
      if(n.id==='tickets'){
        if(breached>0) pip=`<span class="pip hot" title="SLA breached">${breached}</span>`;
        else if(unassigned>0 && can('assign')) pip=`<span class="pip warn" title="unassigned">${unassigned}</span>`;
      }
      const label = (n.id==='tickets' && !can('view_all')) ? 'My Tickets' : n.label;
      return `<button class="nav-item ${state.view===n.id||(n.id==='tickets'&&state.view==='ticket')||(n.id==='clients'&&state.view==='clientv')?'on':''}" onclick="go('${n.id}')">${icon(n.ic,'ic')}<span>${label}</span>${pip}</button>`;
    }).join('');
  document.getElementById('userName').textContent = state.user.name;
  document.getElementById('userAv').textContent = state.user.initials;
  document.getElementById('userMeta').textContent = 'Entra SSO · ' + state.user.role;
}

function render(){
  if(!state.hydrated){
    document.getElementById('content').innerHTML =
      `<div class="card" style="padding:26px;text-align:center"><span class="mini muted">Loading…</span></div>`;
    return;
  }
  /* focus-preserving render: a rebuild must not eject the person typing
     (bug #26 — every oninput→render() input lost focus per keystroke, and
     scrollTo(0,0) flung the page to the top on every keystroke too). */
  { const ae=document.activeElement;
    window.__fk_ae=(ae&&ae!==document.body)?(ae.id||ae.getAttribute('data-fkey')||null):null;
    window.__fk_sel=(ae&&ae.selectionStart!=null&&/^(text|search|number|email|tel|url|password)$/.test(ae.type||''))?[ae.selectionStart,ae.selectionEnd]:(ae&&ae.tagName==='TEXTAREA'?[ae.selectionStart,ae.selectionEnd]:null); }
  if(!canView(state.view)) state.view='dashboard';
  renderNav();
  const pg = PAGES[state.view];
  document.getElementById('pgTitle').textContent =
    state.view==='ticket' ? ('Ticket #'+state.ticketId) :
    state.view==='clientv' ? (client(state.clientId)?.name || 'Client') :
    (state.view==='tickets' && !can('view_all')) ? 'My Tickets' : pg.t;
  document.getElementById('pgSub').innerHTML = pg.s();
  document.getElementById('content').innerHTML = ({
    dashboard:viewDashboard, tickets:viewTickets, projects:viewProjects, ticket:viewTicket, clients:viewClients,
    clientv:viewClient, reports:viewReports, automations:viewAutomations, directory:viewDirectory, settings:viewSettings, audit:viewAudit
  })[state.view]();
  const bb = document.getElementById('bellBadge');
  if(bb){ const n = state.notifs.filter(x=>!x.read).length; bb.style.display = n?'inline':'none'; bb.textContent = n; }
  const __ae=window.__fk_ae, __sel=window.__fk_sel;
  if(__ae){ const el=document.getElementById(__ae)||document.querySelector('[data-fkey="'+__ae+'"]');
    if(el){ window.__fk_restoring=true; el.focus();
      let placed=false;
      if(__sel&&el.setSelectionRange){ try{ el.setSelectionRange(__sel[0],__sel[1]); placed=true; }catch(e){} }
      if(!placed){ /* number inputs hide their caret API — a fresh focus()
        parks the caret at position 0, so digits typed mid-render landed
        BACKWARDS. Reassigning the value walks the caret to the end. */
        try{ const v=el.value; el.value=''; el.value=v; }catch(e){} }
      window.__fk_restoring=false; } }
  if(window.__fk_view!==state.view){ window.__fk_view=state.view; window.scrollTo(0,0); }
}

/* shared renderers */
const stateChip = t => { const s=st8(t.st)||{cls:'st-open',label:t.st}; return `<span class="chip ${s.cls}"><span class="cdot"></span>${esc(s.label)}</span>`; };
const prioTag = p => { const x=prio(p)||{label:'?',cls:'p2'}; return `<span class="prio ${x.cls}"><span class="pflag"></span>${esc(x.label)}</span>`; };
const avatarOf = a => `<span class="avatar" style="width:22px;height:22px;font-size:9.5px;display:inline-grid" title="${esc(a.name)}">${a.initials}</span>`;
function slaCell(t){
  const s = slaInfo(t);
  if(!s) return `<span class="mini muted">—</span>`;
  const cls = s.breached ? 'breach-sla' : (s.due-nowMs() < 2*H ? 'due-sla' : 'ok-sla');
  return `<span class="sla-line ${cls}"><span class="sdot"></span>${s.kind} · ${fmtIn(s.due)}</span>`;
}
const timeTotal = t => t.time.reduce((a,e)=>a+e.h,0);

/* segmented inputs (time / datetime-local / number spinners) fire change
   while still focused; re-rendering then destroys the field mid-typing.
   Commit state immediately, defer the re-render to blur. */
function commitRender(srcEl){
  if(srcEl && document.activeElement===srcEl){ srcEl.addEventListener('blur', ()=>render(), {once:true}); }
  else render();
}

/* uniform input ergonomics (bug #26 follow-up): clicking a value field
   selects its current value so typing replaces it, and Enter commits
   (blurs). The render-restore path sets __fk_restoring so putting the
   caret back mid-typing never re-selects and eats the digits. Combo
   search inputs (-q) keep their own behavior. */
document.addEventListener('focusin',function(e){
  var el=e.target;
  if(window.__fk_restoring) return;
  if(!el||el.tagName!=='INPUT') return;
  if((el.id||'').slice(-2)==='-q') return;
  if(el.type==='number'||el.hasAttribute('data-selectall')){ try{ el.select(); }catch(_e){} }
});
document.addEventListener('keydown',function(e){
  var el=e.target;
  if(e.key!=='Enter'||!el||el.tagName!=='INPUT') return;
  if((el.id||'').slice(-2)==='-q') return;
  el.blur();
});

/* ---------------- notification bell ---------------- */
function toggleBell(){
  const b = document.getElementById('bellBox');
  if(b.style.display==='block'){ b.style.display='none'; return; }
  b.innerHTML = state.notifs.length
    ? state.notifs.slice(0,20).map(n=>`<div style="padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;${n.read?'opacity:.6':''}" onmousedown="bellGo('${n.id}')">
        <div style="font-size:12.5px">${n.kind==='breach'?'🔴':'⚠️'} ${esc(n.text)}</div>
        <div class="mini muted">${fmtDT(n.ts)}</div></div>`).join('')
    : '<div class="mini muted" style="padding:12px">No notifications — SLA warnings and breaches land here.</div>';
  b.style.display='block';
}
function bellGo(nid){
  const n = state.notifs.find(x=>x.id===nid); if(!n) return;
  n.read = true;
  document.getElementById('bellBox').style.display='none';
  if(isUuid(nid)) $fetch('/api/automations/notifications/read',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[nid]})})
    .catch(()=>0);
  if(n.ticketId) openTicket(n.ticketId); else render();
}

/* ---------------- global search ---------------- */
function gSearch(q){
  state.searchQ = q;
  const box = document.getElementById('gResults');
  if(!q || q.trim().length<2){ box.style.display='none'; return; }
  const ql = q.trim().toLowerCase();
  const tix = scoped().filter(t=>
      String(t.id).includes(ql) ||
      (TITLES[t.id]||firstLine(t)).toLowerCase().includes(ql) ||
      t.articles.some(a=>a.kind!=='sys' && (a.body||'').toLowerCase().includes(ql))
    ).slice(0,8);
  const cls = can('view_clients') ? CLIENTS.filter(c=>c.name.toLowerCase().includes(ql)).slice(0,4) : [];
  const cts = can('view_clients') ? CLIENTS.flatMap(c=>c.contacts.filter(p=>p.active!==false && (p.name.toLowerCase().includes(ql)||p.email.toLowerCase().includes(ql))).map(p=>({p,c}))).slice(0,4) : [];
  const row = (html, go) => `<div style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line)" onmousedown="${go}">${html}</div>`;
  box.innerHTML = (tix.length?`<div class="mini muted" style="padding:6px 12px 2px;text-transform:uppercase;letter-spacing:.06em">Tickets</div>`:'') +
    tix.map(t=>row(`<b>#${t.id}</b> ${esc((TITLES[t.id]||firstLine(t)).slice(0,52))} <span class="mini muted">· ${esc(client(t.clientId).name)}</span>`, `gGo('t',${t.id})`)).join('') +
    (cls.length?`<div class="mini muted" style="padding:6px 12px 2px;text-transform:uppercase;letter-spacing:.06em">Clients</div>`:'') +
    cls.map(c=>row(`🏢 ${esc(c.name)}`, `gGo('c','${c.id}')`)).join('') +
    (cts.length?`<div class="mini muted" style="padding:6px 12px 2px;text-transform:uppercase;letter-spacing:.06em">Contacts</div>`:'') +
    cts.map(x=>row(`👤 ${esc(x.p.name)} <span class="mini muted">${esc(x.p.email)} · ${esc(x.c.name)}</span>`, `gGo('c','${x.c.id}')`)).join('') ||
    `<div class="mini muted" style="padding:10px 12px">Nothing matches “${esc(q)}” in your scope.</div>`;
  box.style.display='block';
}
function gGo(kind, id){
  document.getElementById('gResults').style.display='none';
  document.getElementById('gSearch').value='';
  if(kind==='t') openTicket(id); else openClient(id);
}
document.addEventListener('click', ev=>{ const b=document.getElementById('gResults'); if(b && !ev.target.closest('.search')) b.style.display='none'; });
document.addEventListener('keydown', ev=>{ if(ev.key==='/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'')){ ev.preventDefault(); document.getElementById('gSearch')?.focus(); } });

/* ---------------- modal ---------------- */
function closeModal(){ document.getElementById('scrim').classList.remove('open'); }
document.getElementById('scrim').addEventListener('click', e=>{ if(e.target.id==='scrim') closeModal(); });

/* searchable dropdown — scales past select's comfort zone.
   opts: [{v, label, sub?}] · hidden input #<id> carries the picked value */
const _combos = {};   /* id → {opts, onpick} — options live here, not in the DOM */
function combo(id, opts, val, onpick, placeholder){
  _combos[id] = { opts, onpick: typeof onpick==='function' ? onpick : null };
  const cur = opts.find(o=>o.v===val);
  return `<div class="combo" style="position:relative">
    <input type="hidden" id="${id}" value="${esc(val||'')}">
    <input type="text" id="${id}-q" autocomplete="off" placeholder="${esc(placeholder||'Type to search…')}" value="${esc(cur&&!cur.blank?cur.label:'')}"
      onfocus="comboOpen('${id}')" oninput="comboFilter('${id}')"
      onkeydown="if(event.key==='Enter'){event.preventDefault();comboPickFirst('${id}');} if(event.key==='Escape'){comboClose('${id}');}">
    <div id="${id}-list" style="display:none;position:absolute;top:100%;left:0;right:0;max-height:220px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 24px rgba(21,32,41,.14);z-index:80"></div>
  </div>`;
}
function comboData(id){ return (_combos[id]||{}).opts || []; }
function comboOpen(id){ const q=document.getElementById(id+'-q'); if(q) q.select(); comboFilter(id); }
function comboFilter(id){
  const q = document.getElementById(id+'-q').value.trim().toLowerCase();
  const opts = comboData(id).filter(o=>!q || o.label.toLowerCase().includes(q) || (o.sub||'').toLowerCase().includes(q));
  const box = document.getElementById(id+'-list');
  box.innerHTML = opts.slice(0,50).map(o=>`<div style="padding:7px 11px;cursor:pointer;font-size:13px" onmousedown="comboPick('${id}','${jsq(String(o.v))}')"><b>${esc(o.label)}</b>${o.sub?` <span class="mini muted">${esc(o.sub)}</span>`:''}</div>`).join('')
    || `<div class="mini muted" style="padding:9px 11px">No matches.</div>`;
  box.style.display='block';
}
function comboPick(id, v){
  const o = comboData(id).find(x=>String(x.v)===String(v)); if(!o) return;
  document.getElementById(id).value = o.v;
  document.getElementById(id+'-q').value = o.blank ? '' : o.label;
  comboClose(id);
  const f = (_combos[id]||{}).onpick;
  if(f){ try{ f(); }catch(e){} }
}
function comboPickFirst(id){
  const q = document.getElementById(id+'-q').value.trim().toLowerCase();
  const o = comboData(id).find(x=>!q || x.label.toLowerCase().includes(q) || (x.sub||'').toLowerCase().includes(q));
  if(o) comboPick(id, o.v);
}
function comboClose(id){ const b=document.getElementById(id+'-list'); if(b) b.style.display='none'; }
document.addEventListener('mousedown', ev=>{ if(!ev.target.closest('.combo')) document.querySelectorAll('[id$="-list"]').forEach(b=>b.style.display='none'); });

/* ---------------- toast ---------------- */
function toast(msg){
  const w = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className='toast'; t.innerHTML=`<span class="cdot"></span><span>${msg}</span>`;
  w.appendChild(t); setTimeout(()=>t.remove(), 4200);
}
