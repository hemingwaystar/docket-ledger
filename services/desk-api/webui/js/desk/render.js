/* ==========================================================================
   js/desk/render.js — the ONE innerHTML rebuild and everything around it.
   Owns: render()/renderNav() (focus/caret/scroll carry — bug #26) · router
   go()/openTicket()/openClient() · shared chip renderers · commitRender +
   input ergonomics listeners · modal/scrim · combo (searchable dropdown) ·
   multiCombo (checkbox dropdown + chips, empty = All; noAll opt-out) · toast ·
   notification bell · global search · list pagination paginate()/pagerBar()
   (per-list page state + per-user page-size persistence).
   Endpoints: POST /api/automations/notifications/read
     ({ids:[id]} bellGo · {all:true} bellAllRead).
   Invariants: render() is the only #content rebuild (plus nav/title/badge);
   until the first hydrate lands it shows a plain Loading… card.
   ========================================================================== */

function go(v){ if(!canView(v)) v='dashboard'; state.view=v; render(); }
function openTicket(id){ const t=tk(id); if(!ticketVisible(t)) { toast('That ticket is outside your access.'); return; } state.ticketId=id; state.view='ticket'; state.composer={kind:'reply', typeId:null, logTime:true}; render(); }
function openClient(id){ if(!can('view_clients')) return; state.clientId=id; state.clf={st:[],tag:[],owner:[],q:'',from:'',to:''}; state.view='clientv'; render(); }

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
  /* subtitle strings may legitimately be '' (state.js) — hide the node so an
     empty .page-sub never leaves its stray margin under the title */
  { const sub = pg.s(), se = document.getElementById('pgSub');
    se.innerHTML = sub; se.style.display = sub ? '' : 'none'; }
  document.getElementById('content').innerHTML = ({
    dashboard:viewDashboard, tickets:viewTickets, schedule:viewSchedule, projects:viewProjects, ticket:viewTicket, clients:viewClients,
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
  reflowAudit();   /* re-open expanded audit disclosures + drop no-op arrows */
  if(window.__fk_view!==state.view){ window.__fk_view=state.view; window.scrollTo(0,0); }
}

/* shared renderers */
const stateChip = t => { const s=st8(t.st)||{cls:'st-open',label:t.st}; return `<span ${stChipAttrs(s)}><span class="cdot"></span>${esc(s.label)}</span>`; };
const prioTag = p => { const x=prio(p)||{label:'?',cls:'p2'}; return `<span ${prioTagAttrs(x)}><span class="pflag"></span>${esc(x.label)}</span>`; };
const avatarOf = a => `<span class="avatar" style="width:22px;height:22px;font-size:9.5px;display:inline-grid" title="${esc(a.name)}">${a.initials}</span>`;
function slaCell(t){
  const s = slaInfo(t);
  if(!s) return `<span class="mini muted">—</span>`;
  const cls = s.breached ? 'breach-sla' : (s.due-nowMs() < 2*H ? 'due-sla' : 'ok-sla');
  return `<span class="sla-line ${cls}"><span class="sdot"></span>${s.kind} · ${fmtIn(s.due)}</span>`;
}
const timeTotal = t => t.time.reduce((a,e)=>a+e.h,0);

/* collapsible audit text (build 25): a short line renders plain; a long one
   collapses behind a native disclosure arrow (<details>) that expands to the
   whole text — used by BOTH the ticket Audit block (props.js) and the Audit Log
   view (audit.js). The CSS clamps the collapsed summary to 2 lines and every
   branch wraps long unbroken strings. */
function auditBody(text, key){
  const s = String(text ?? '');
  if(s.length <= 100) return `<span class="audit-txt">${esc(s)}</span>`;
  return `<details class="audit-ev"${key?` data-akey="${esc(key)}"`:''}><summary class="audit-txt">${esc(s)}</summary></details>`;
}
/* post-render upkeep for the audit disclosures (called from render()): the
   innerHTML rebuild recreates every <details> collapsed, so (1) re-open the ones
   the user had expanded (tracked by data-akey in __auditOpen), and (2) flatten a
   <details> whose text does NOT actually overflow its 2-line clamp — so a
   non-truncated entry shows no pointless expand arrow (the char threshold in
   auditBody can't know the real column width; this measures it). */
function reflowAudit(){
  const open = window.__auditOpen || (window.__auditOpen = new Set());
  document.querySelectorAll('details.audit-ev').forEach(d=>{
    const key = d.getAttribute('data-akey');
    if(key && open.has(key)) d.open = true;
    d.addEventListener('toggle', ()=>{ if(key){ d.open ? open.add(key) : open.delete(key); } });
    const s = d.firstElementChild;                 /* the <summary> */
    if(!d.open && s && s.scrollHeight <= s.clientHeight + 1) d.classList.add('audit-flat');
  });
}

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
  b.innerHTML =
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line)">
      <span class="mini muted" style="text-transform:uppercase;letter-spacing:.06em">Notifications</span>
      ${state.notifs.some(x=>!x.read)?`<button class="rowbtn" onclick="bellAllRead()">Mark all read</button>`:''}
    </div>` +
    (state.notifs.length
    ? state.notifs.slice(0,20).map(n=>`<div style="padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer;${n.read?'opacity:.6':''}" onmousedown="bellGo('${n.id}')">
        <div style="font-size:12.5px">${n.kind==='breach'?'🔴':'⚠️'} ${esc(n.text)}</div>
        <div class="mini muted">${fmtDT(n.ts)}</div></div>`).join('')
    : '<div class="mini muted" style="padding:12px">No notifications — SLA warnings and breaches land here.</div>');
  b.style.display='block';
}
function bellAllRead(){
  if(!state.notifs.some(x=>!x.read)) return;                    /* diff-guard */
  state.notifs.forEach(n=>{ n.read=true; });
  document.getElementById('bellBox').style.display='none';
  render();                                                     /* badge → 0 */
  $fetch('/api/automations/notifications/read',{method:'POST',
    headers:{'Content-Type':'application/json'},body:JSON.stringify({all:true})})
    .then(async r=>{ if(!r.ok) return oops(await r.json().catch(()=>0)); })
    .catch(()=>oops());
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

/* multi-select dropdown — combo's checkbox sibling. Picked values render as
   removable chips; empty selection = All. opts: [{v,label,sub?,archived?}] —
   archived options stay out of the list unless currently picked, then read
   "(archived)" (row 37). onchg is a GLOBAL function NAME (inline-handler
   architecture): window[onchg](selectedArr, fkey) fires after every toggle;
   that handler owns state + render(). open + the typed query survive the
   rebuild so the list stays up while several boxes are ticked. noAll (6th
   arg, optional) suppresses the leading "All" row — for pickers where empty
   already reads as "none" (a hide-list), not "everything"; ticking boxes off
   one by one is the only clear there. Default (omitted) keeps the All row. */
const _mcombos = {};  /* fkey → {opts, sel, onchg, open, q, noAll} — options live here, not in the DOM */
function multiCombo(fkey, opts, sel, onchg, placeholder, noAll){
  sel = (sel||[]).slice();
  const has = v => sel.some(s=>String(s)===String(v));
  opts = opts.filter(o=>!o.archived || has(o.v))
             .map(o=>o.archived ? Object.assign({},o,{label:o.label+' (archived)'}) : o);
  const prev = _mcombos[fkey]||{};
  const m = _mcombos[fkey] = { opts, sel, onchg, open: !!prev.open, q: prev.q||'', noAll: !!noAll };
  const chips = sel.map(v=>{ const o=opts.find(x=>String(x.v)===String(v));
    return o?`<span class="chip tagchip" style="margin-top:3px">${esc(o.label)}<button onclick="mcToggle('${fkey}','${jsq(String(o.v))}')" title="remove">×</button></span>`:''; }).join('');
  return `<div class="combo mcombo" style="position:relative">
    <input type="text" id="${fkey}-q" autocomplete="off" placeholder="${esc(sel.length?sel.length+' selected':(placeholder||'All'))}" value="${esc(m.open?m.q:'')}"
      onfocus="mcOpen('${fkey}')" oninput="mcFilter('${fkey}')"
      onkeydown="if(event.key==='Enter'){event.preventDefault();mcFirst('${fkey}');} if(event.key==='Escape'){mcClose('${fkey}');}">
    <div id="${fkey}-list" style="display:${m.open?'block':'none'};position:absolute;top:100%;left:0;right:0;max-height:220px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 24px rgba(21,32,41,.14);z-index:80">${m.open?mcRows(fkey,m.q):''}</div>
    ${chips?`<div style="display:flex;flex-wrap:wrap;gap:0 4px">${chips}</div>`:''}
  </div>`;
}
function mcRows(fkey, q){
  const m = _mcombos[fkey]; if(!m) return '';
  q = (q||'').trim().toLowerCase();
  const has = v => m.sel.some(s=>String(s)===String(v));
  const row = (h, on, click) => `<div style="display:flex;align-items:center;gap:7px;padding:7px 11px;cursor:pointer;font-size:13px" onmousedown="event.preventDefault();${click}"><input type="checkbox" tabindex="-1" style="pointer-events:none" ${on?'checked':''}>${h}</div>`;
  return (m.noAll ? '' : row(`<b>All</b>`, !m.sel.length, `mcClear('${fkey}')`)) +
    (m.opts.filter(o=>!q || o.label.toLowerCase().includes(q) || (o.sub||'').toLowerCase().includes(q))
      .slice(0,50)
      .map(o=>row(`<b>${esc(o.label)}</b>${o.sub?` <span class="mini muted">${esc(o.sub)}</span>`:''}`, has(o.v), `mcToggle('${fkey}','${jsq(String(o.v))}')`)).join('')
    || `<div class="mini muted" style="padding:9px 11px">No matches.</div>`);
}
function mcOpen(fkey){ const m=_mcombos[fkey]; if(!m) return; m.open=true; const q=document.getElementById(fkey+'-q'); if(q) q.select(); mcFilter(fkey); }
function mcFilter(fkey){
  const m=_mcombos[fkey], box=document.getElementById(fkey+'-list'); if(!m||!box) return;
  m.q = document.getElementById(fkey+'-q').value;
  box.innerHTML = mcRows(fkey, m.q);
  box.style.display='block';
}
function mcToggle(fkey, v){
  const m=_mcombos[fkey]; if(!m) return;
  const i=m.sel.findIndex(s=>String(s)===String(v));
  if(i>=0) m.sel.splice(i,1);
  else { const o=m.opts.find(x=>String(x.v)===String(v)); if(!o) return; m.sel.push(o.v); }
  const f=window[m.onchg]; if(typeof f==='function') f(m.sel.slice(), fkey);
}
function mcClear(fkey){
  const m=_mcombos[fkey]; if(!m||!m.sel.length) return;        /* already All */
  m.sel.length=0;
  const f=window[m.onchg]; if(typeof f==='function') f([], fkey);
}
function mcFirst(fkey){
  const m=_mcombos[fkey]; if(!m) return;
  const q=document.getElementById(fkey+'-q').value.trim().toLowerCase();
  const o=m.opts.find(x=>!q || x.label.toLowerCase().includes(q) || (x.sub||'').toLowerCase().includes(q));
  if(o) mcToggle(fkey, String(o.v));
}
function mcClose(fkey){ const m=_mcombos[fkey]; if(m){ m.open=false; m.q=''; } const b=document.getElementById(fkey+'-list'); if(b) b.style.display='none'; }
document.addEventListener('mousedown', ev=>{ if(!ev.target.closest('.mcombo')) Object.keys(_mcombos).forEach(k=>{ if(_mcombos[k].open) mcClose(k); }); });

/* ---------------- toast ---------------- */
function toast(msg){
  const w = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className='toast'; t.innerHTML=`<span class="cdot"></span><span>${msg}</span>`;
  w.appendChild(t); setTimeout(()=>t.remove(), 4200);
}

/* ---------------- list pagination (build 13) ----------------
   ONE pattern for every long object list, applied AFTER the view's existing
   filters/search: page-size select (10/25/50/100), prev/next, 'x–y of N'.
   Page number lives per-list in _pagers (JS object, never the URL); page SIZE
   persists per user in localStorage under an app prefix — desk and ledger
   share one origin behind nginx, so the prefix is load-bearing. A pager key
   may carry an instance suffix after ':' ('clientTickets:<id>'): the size is
   remembered per list TYPE (prefix before ':'), the page per instance.
   Aggregates, counts and CSV exports keep reading the FULL filtered set. */
const _pagers = {};
const PAGE_SIZES = [10,25,50,100];
const PAGER_LS = 'dk.pgsz.';
function pagerSize(key){ let v=0; try{ v=Number(localStorage.getItem(PAGER_LS+key.split(':')[0])); }catch(e){} return PAGE_SIZES.includes(v)?v:25; }
function pagerState(key){ return _pagers[key]||(_pagers[key]={page:0}); }
function pagerSetSize(key,v){ try{ localStorage.setItem(PAGER_LS+key.split(':')[0],String(v)); }catch(e){} pagerState(key).page=0; render(); }
function pagerGo(key,delta){ pagerState(key).page+=delta; render(); }
function paginate(key,rows){
  const size=pagerSize(key), p=pagerState(key);
  const nPages=Math.max(1,Math.ceil(rows.length/size));
  if(p.page>nPages-1) p.page=nPages-1;      /* filters shrank the list */
  if(p.page<0) p.page=0;
  const start=p.page*size;
  return { key, slice:rows.slice(start,start+size), total:rows.length, start, size, page:p.page, nPages };
}
function pagerBar(pg){
  if(pg.total===0) return '';   /* empty lists keep their empty-state message;
     any rows at all render the bar — the size select must stay discoverable
     even on short lists (build 14a: the ≤10 auto-hide read as "no pages") */
  return `<div class="pager">
    <select onchange="pagerSetSize('${jsq(pg.key)}',Number(this.value))" title="Rows per page">${PAGE_SIZES.map(s=>`<option value="${s}" ${s===pg.size?'selected':''}>${s} / page</option>`).join('')}</select>
    <span class="mini muted">${pg.start+1}–${Math.min(pg.total,pg.start+pg.size)} of ${pg.total}</span>
    <button class="rowbtn" ${pg.page===0?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',-1)">‹ Prev</button>
    <button class="rowbtn" ${pg.page>=pg.nPages-1?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',1)">Next ›</button>
  </div>`;
}
