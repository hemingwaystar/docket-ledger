/* ==========================================================================
   Ledger — render.js
   Shell rendering: render() is the ONLY innerHTML rebuild and carries
   focus/caret/scroll across it (bug #26). One render target: #content
   (+ nav / title / sub). Also owns the view-agnostic DOM machinery every
   page shares: searchable combos, menu + scrim dismissal, soft rerender,
   input ergonomics, modal + toast. No server calls.
   ========================================================================== */

function pgTitle(){
  if(state.view==='timesheets' && !isAdmin()) return 'My Timesheets';
  if(state.view==='client'){ const c=client(state.clientId); return c?c.name:'Client'; }
  return PAGES[state.view].t;
}

function renderNav(){
  const scoped = scopedEntries();
  const unclassified = scoped.filter(e=>e.status!=='void' && atype(e.typeId).sentinel).length;
  const navItems = NAV.filter(n=>canView(n.id));
  document.getElementById('nav').innerHTML =
    `<div class="nav-label">Workspace</div>` +
    navItems.map(n=>{
      let pip='';
      if(n.id==='timesheets' && unclassified>0) pip=`<span class="pip warn" title="unclassified">${unclassified}</span>`;
      if(n.id==='approvals'){ const aw=buildTimesheets().filter(s=>s.status==='awaiting').length; if(aw>0) pip=`<span class="pip" title="awaiting your approval">${aw}</span>`; }
      const label = (n.id==='timesheets' && !isAdmin()) ? 'My Timesheets' : n.label;
      return `<button class="nav-item ${state.view===n.id?'on':''}" onclick="go('${n.id}')">
        ${icon(n.ic,'ic')}<span>${label}</span>${pip}</button>`;
    }).join('');
  document.getElementById('userName').textContent=state.user.name;
  document.getElementById('userAv').textContent=state.user.initials;
  document.getElementById('userMeta').innerHTML=`<span class="dot"></span>SSO session · ${state.user.role||''}`;
}

function render(){
  /* focus-preserving render: a rebuild must not eject the person typing
     (bug #26 — every oninput→render() input lost focus per keystroke, and
     scrollTo(0,0) flung the page to the top on every keystroke too). */
  { const ae=document.activeElement;
    window.__fk_ae=(ae&&ae!==document.body)?(ae.id||ae.getAttribute('data-fkey')||null):null;
    window.__fk_sel=(ae&&ae.selectionStart!=null&&/^(text|search|number|email|tel|url|password)$/.test(ae.type||''))?[ae.selectionStart,ae.selectionEnd]:(ae&&ae.tagName==='TEXTAREA'?[ae.selectionStart,ae.selectionEnd]:null); }
  if(!canView(state.view)) state.view='dashboard';
  renderNav();
  document.getElementById('pgTitle').textContent=pgTitle();
  document.getElementById('pgSub').innerHTML=PAGES[state.view].s();
  const c=document.getElementById('content');
  if(!state.hydrated){   /* first paint runs before the bootstrap answer lands */
    c.innerHTML=`<div class="card card-pad">Loading…</div>`;
    return;
  }
  c.innerHTML = ({
    dashboard:viewDashboard, timesheets:viewTimesheets, approvals:viewApprovals, clients:viewClients, client:viewClient,
    types:viewTypes, periods:viewPeriods, reports:viewReports, export:viewExport, audit:viewAudit, directory:viewDirectory, settings:viewSettings
  })[state.view]();
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

/* helper: chips */
function statusChip(e){
  if(e.status==='void') return `<span class="chip void"><span class="cdot"></span>Voided</span>`;
  if(isLocked(e)) return `<span class="chip approved"><span class="cdot"></span>Locked</span>`;
  if(e.tsApproved) return `<span class="chip approved"><span class="cdot"></span>Approved</span>`;
  if(e.submitted) return `<span class="chip submitted"><span class="cdot"></span>Submitted</span>`;
  return `<span class="chip pending"><span class="cdot"></span>Pending</span>`;
}

/* searchable dropdown — ported from Docket so every client picker matches.
   opts: [{v, label, sub?}] · hidden input #<id> carries the picked value */
const _combos = {};
function combo(id, opts, val, onpick, placeholder){
  _combos[id] = { opts, onpick: typeof onpick==='function' ? onpick : null };
  const cur = opts.find(o=>o.v===val);
  return `<div class="combo" style="position:relative">
    <input type="hidden" id="${id}" value="${esc(val||'')}">
    <input type="text" id="${id}-q" autocomplete="off" placeholder="${esc(placeholder||'Type to search…')}" value="${esc(cur?cur.label:'')}"
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
  document.getElementById(id+'-q').value = o.label;
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

let searchTimer;
function softRerender(){ clearTimeout(searchTimer); searchTimer=setTimeout(()=>{ const a=document.activeElement; const val=a&&a.value; render(); const ni=document.querySelector('.search input'); if(ni){ni.focus(); ni.value=val; ni.setSelectionRange(val.length,val.length);} },160); }

/* row action menus (classify dropdown etc.) */
function closeMenus(){ document.querySelectorAll('.menu.open').forEach(m=>m.classList.remove('open')); }
function openClassify(id,ev){ ev.stopPropagation(); const m=document.getElementById('menu-'+id); const was=m.classList.contains('open'); closeMenus(); if(!was)m.classList.add('open'); }
document.addEventListener('click',closeMenus);

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

/* ==========================================================================
   MODAL + TOAST
   ========================================================================== */
function openModal(html){ const m=document.getElementById('modal'); m.innerHTML=html; document.getElementById('scrim').classList.add('open'); }
function closeModal(){ document.getElementById('scrim').classList.remove('open'); }
document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') closeModal(); });
function confirmModal(title,body,cta,cls,onOk){
  openModal(`<div class="modal-head"><h3>${title}</h3></div><div class="modal-body">${body}</div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn ${cls}" id="okBtn">${cta}</button></div>`);
  document.getElementById('okBtn').onclick=()=>{ closeModal(); onOk(); };
}
function toast(msg){
  const w=document.getElementById('toasts'); const t=document.createElement('div'); t.className='toast';
  t.innerHTML=`<span class="cdot"></span>${esc(msg)}`; w.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); },2600);
}
