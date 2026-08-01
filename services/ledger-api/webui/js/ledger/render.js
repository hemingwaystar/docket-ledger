/* ==========================================================================
   Ledger — render.js
   Shell rendering: render() is the ONLY innerHTML rebuild and carries
   focus/caret/scroll across it (bug #26). One render target: #content
   (+ nav / title / sub). Also owns the view-agnostic DOM machinery every
   page shares: searchable combos, multi-select combos (checkbox dropdown +
   chips, empty selection = no filter), menu + scrim dismissal, soft
   rerender, input ergonomics, modal + toast · list pagination
   paginate()/pagerBar() (per-list page state + per-user page-size
   persistence). No server calls.
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

/* multi-select combo — same skeleton as combo() (searchable, bug-#26 focus
   rules), but the value is an ARRAY: empty = no filter ("All"), each option
   toggles a checkbox and stays open for the next pick. Selected values show
   as removable chips inside the control. Archived options are the caller's
   job (row 37: keep them out of opts unless currently selected).
   opts: [{v, label, sub?}] · vals: array · ontoggle(v) mutates the array in
   view state and render()s — ontoggle(null) means "clear the selection". */
function multiCombo(id, opts, vals, ontoggle, placeholder){
  vals = Array.isArray(vals) ? vals : [];
  _combos[id] = { opts, vals: vals.slice(), multi: true,
    ontoggle: typeof ontoggle==='function' ? ontoggle : null };
  /* a rebuild mid-typing must not eat the filter text: the OLD input is
     still in the document while this markup is being built — carry it */
  const oldQ = document.getElementById(id+'-q');
  const q = oldQ ? oldQ.value : '';
  const chips = vals.map(v=>{
    const o = opts.find(x=>String(x.v)===String(v));
    return `<span style="display:inline-flex;align-items:center;gap:2px;background:#eef3f2;border:1px solid var(--line);border-radius:999px;padding:1px 3px 1px 9px;font-size:12px;white-space:nowrap">${esc(o?o.label:String(v))}<button onclick="multiToggle('${id}','${jsq(String(v))}')" title="Remove" style="border:0;background:none;cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;color:var(--ink-3,#66757e)">×</button></span>`;
  }).join('');
  return `<div class="combo multi" style="position:relative;display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-height:30px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:2px 6px">
    ${chips}
    <input type="text" id="${id}-q" autocomplete="off" placeholder="${esc(vals.length?'':(placeholder||'All'))}" value="${esc(q)}"
      style="border:0;outline:none;flex:1;min-width:60px;font-size:13px;background:transparent"
      onfocus="multiOpen('${id}')" oninput="multiFilter('${id}')"
      onkeydown="if(event.key==='Enter'){event.preventDefault();multiPickFirst('${id}');} if(event.key==='Escape'){comboClose('${id}');}">
    <div id="${id}-list" style="display:none;position:absolute;top:100%;left:0;right:0;min-width:220px;max-height:240px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 24px rgba(21,32,41,.14);z-index:80"></div>
  </div>`;
}
function multiOpen(id){ multiFilter(id); }
function multiFilter(id){
  const reg=_combos[id]||{opts:[],vals:[]};
  const box=document.getElementById(id+'-list'), qEl=document.getElementById(id+'-q');
  if(!box||!qEl) return;
  const q=qEl.value.trim().toLowerCase();
  const opts=reg.opts.filter(o=>!q || o.label.toLowerCase().includes(q) || (o.sub||'').toLowerCase().includes(q));
  /* mousedown + preventDefault keeps focus in the search input, so the
     render() the toggle triggers restores focus (bug #26) and the list
     re-opens via its onfocus — the dropdown survives multi-picking */
  box.innerHTML =
    `<div style="padding:6px 11px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--line);color:${reg.vals.length?'var(--brand)':'var(--ink-3,#66757e)'}" onmousedown="event.preventDefault();multiToggle('${id}',null)">${reg.vals.length?'✕ Clear — show all':'All (nothing selected = no filter)'}</div>`
    + (opts.slice(0,50).map(o=>{
        const on=reg.vals.some(v=>String(v)===String(o.v));
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;font-size:13px" onmousedown="event.preventDefault();multiToggle('${id}','${jsq(String(o.v))}')">
          <input type="checkbox" ${on?'checked':''} tabindex="-1" style="pointer-events:none;accent-color:var(--brand)">
          <span style="font-weight:${on?600:400}">${esc(o.label)}</span>${o.sub?` <span class="mini muted">${esc(o.sub)}</span>`:''}</div>`;
      }).join('') || `<div class="mini muted" style="padding:9px 11px">No matches.</div>`);
  box.style.display='block';
}
function multiToggle(id, v){
  const f=(_combos[id]||{}).ontoggle; if(!f) return;
  try{ f(v); }catch(e){}
}
function multiPickFirst(id){
  const reg=_combos[id]||{opts:[]};
  const qEl=document.getElementById(id+'-q'); if(!qEl) return;
  const q=qEl.value.trim().toLowerCase();
  const o=reg.opts.find(x=>!q || x.label.toLowerCase().includes(q) || (x.sub||'').toLowerCase().includes(q));
  if(o) multiToggle(id, o.v);
}
/* filter-state normalizer: filter bars carry ARRAYS (empty = all). State
   seeded before build 10 (state.js / openClient) still says 'all' scalars —
   coerce once, in place, wherever a view reads its filter object. */
function _mfNorm(o, keys){
  keys.forEach(k=>{ if(!Array.isArray(o[k])) o[k]=(o[k]==null||o[k]==='all')?[]:[o[k]]; });
  return o;
}

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
const PAGER_LS = 'lg.pgsz.';
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
  if(pg.total<=PAGE_SIZES[0]) return '';    /* nothing to page */
  return `<div class="pager">
    <select onchange="pagerSetSize('${jsq(pg.key)}',Number(this.value))" title="Rows per page">${PAGE_SIZES.map(s=>`<option value="${s}" ${s===pg.size?'selected':''}>${s} / page</option>`).join('')}</select>
    <span class="mini muted">${pg.start+1}–${Math.min(pg.total,pg.start+pg.size)} of ${pg.total}</span>
    <button class="rowbtn" ${pg.page===0?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',-1)">‹ Prev</button>
    <button class="rowbtn" ${pg.page>=pg.nPages-1?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',1)">Next ›</button>
  </div>`;
}
