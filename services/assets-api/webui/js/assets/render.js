/* ==========================================================================
   Assets — render.js
   Shell rendering: render() is the ONLY innerHTML rebuild and carries
   focus/caret/scroll across it (bug #26). One render target: #content
   (+ nav / title / sub). Also owns the view-agnostic DOM machinery every
   page shares — searchable combos, multi-select combos, modal + toast,
   list pagination (per-user page size under the 'as.' prefix — desk,
   ledger and assets share one origin behind nginx, so the prefix is
   load-bearing). No server calls. Ported from ledger's render.js.
   ========================================================================== */

function pgTitle(){ return PAGES[state.view].t; }

function needsAttention(){
  /* the overview's worklist, shared with the nav pip: expiring warranties,
     full pools, ending NON-recurring terms (recurring ones renew) */
  const out=[];
  liveAssets().filter(a=>a.status!=='retired' && a.warrantyUntil && daysTo(a.warrantyUntil)<=leadDays())
    .forEach(a=>out.push({sev:daysTo(a.warrantyUntil)<0?'red':'brass',
      t:'Warranty '+(daysTo(a.warrantyUntil)<0?'expired':'expiring')+' — '+a.ciTag+' '+a.name,
      s:clientName(a.clientId)+' · '+covText(a.warrantyUntil), go:"go('assets')"}));
  liveLicenses().filter(l=>l.seatsUsed>=l.seatsTotal)
    .forEach(l=>out.push({sev:'red', t:'Licence pool full — '+l.product,
      s:clientName(l.clientId)+' · '+l.seatsUsed+'/'+l.seatsTotal+' seats', go:"go('licenses')"}));
  liveLicenses().filter(l=>!l.recurring && l.endsOn && daysTo(l.endsOn)<=leadDays())
    .forEach(l=>out.push({sev:daysTo(l.endsOn)<0?'red':'brass',
      t:(daysTo(l.endsOn)<0?'Licence term lapsed':'Licence term ending')+' — '+l.product,
      s:clientName(l.clientId)+' · '+termLabel(l.termMonths,false)+' · '+covText(l.endsOn), go:"go('licenses')"}));
  liveContracts().filter(c=>!c.recurring && c.endsOn && daysTo(c.endsOn)<=leadDays())
    .forEach(c=>out.push({sev:daysTo(c.endsOn)<0?'red':'brass',
      t:(daysTo(c.endsOn)<0?'Coverage lapsed':'Coverage ending')+' — '+c.vendor,
      s:clientName(c.clientId)+' · '+termLabel(c.termMonths,false)+' · '+covText(c.endsOn), go:"go('contracts')"}));
  return out;
}

function renderNav(){
  const navItems = NAV.filter(n=>canView(n.id));
  const needy = state.hydrated ? needsAttention().length : 0;
  document.getElementById('nav').innerHTML =
    `<div class="nav-label">Workspace</div>` +
    navItems.map(n=>{
      let pip='';
      if(n.id==='overview' && needy>0) pip=`<span class="pip warn" title="needs attention">${needy}</span>`;
      if(n.id==='assets' && state.hydrated) pip=`<span class="pip">${liveAssets().length}</span>`;
      return `<button class="nav-item ${state.view===n.id?'on':''}" onclick="go('${n.id}')">
        ${icon(n.ic,'ic')}<span>${n.label}</span>${pip}</button>`;
    }).join('');
  document.getElementById('userName').textContent=state.user.name;
  document.getElementById('userAv').textContent=state.user.initials;
}

function render(){
  /* focus-preserving render (bug #26) — same machinery as desk/ledger */
  { const ae=document.activeElement;
    window.__fk_ae=(ae&&ae!==document.body)?(ae.id||ae.getAttribute('data-fkey')||null):null;
    window.__fk_sel=(ae&&ae.selectionStart!=null&&/^(text|search|number|email|tel|url|password)$/.test(ae.type||''))?[ae.selectionStart,ae.selectionEnd]:(ae&&ae.tagName==='TEXTAREA'?[ae.selectionStart,ae.selectionEnd]:null); }
  if(!canView(state.view)) state.view='overview';
  renderNav();
  document.getElementById('pgTitle').textContent=pgTitle();
  { const sub=PAGES[state.view].s(), se=document.getElementById('pgSub');
    se.innerHTML=sub; se.style.display=sub?'':'none'; }
  const c=document.getElementById('content');
  if(!state.hydrated){
    c.innerHTML=`<div class="card card-pad">Loading…</div>`;
    return;
  }
  c.innerHTML = ({
    overview:viewOverview, assets:viewAssetsPage, licenses:viewLicenses,
    contracts:viewContracts, reports:viewReports, audit:viewAudit, settings:viewSettings
  })[state.view]();
  const __ae=window.__fk_ae, __sel=window.__fk_sel;
  if(__ae){ const el=document.getElementById(__ae)||document.querySelector('[data-fkey="'+__ae+'"]');
    if(el){ window.__fk_restoring=true; el.focus();
      let placed=false;
      if(__sel&&el.setSelectionRange){ try{ el.setSelectionRange(__sel[0],__sel[1]); placed=true; }catch(e){} }
      if(!placed){ try{ const v=el.value; el.value=''; el.value=v; }catch(e){} }
      window.__fk_restoring=false; } }
  if(window.__fk_view!==state.view){ window.__fk_view=state.view; window.scrollTo(0,0); }
}

/* searchable dropdown — the suite's combo, verbatim contract.
   opts: [{v, label, sub?}] · hidden input #<id> carries the picked value */
const _combos = {};
function combo(id, opts, val, onpick, placeholder){
  _combos[id] = { opts, onpick: typeof onpick==='function' ? onpick : null };
  const cur = opts.find(o=>o.v===val);
  return `<div class="combo" style="position:relative">
    <input type="hidden" id="${id}" value="${esc(val||'')}">
    <input type="text" id="${id}-q" autocomplete="off" placeholder="${esc(placeholder||'Type to search…')}" value="${esc(cur?cur.label:'')}"
      onfocus="comboOpen('${id}')" oninput="comboFilter('${id}')"
      onkeydown="if(event.key==='Enter'){event.preventDefault();comboPickFirst('${id}');} if(event.key==='Escape'){comboClose('${id}');event.stopPropagation();}">
    <div id="${id}-list" style="display:none;position:absolute;top:100%;left:0;right:0;max-height:220px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 24px rgba(21,32,41,.14);z-index:80"></div>
  </div>`;
}
function comboData(id){ return (_combos[id]||{}).opts || []; }
/* opening shows the FULL list — the input still holds the current pick's
   label, and filtering against it hid every other option (the licence
   modal's client picker looked empty). Filtering starts when you TYPE. */
function comboOpen(id){ const q=document.getElementById(id+'-q'); if(q) q.select(); comboRender(id, ''); }
function comboFilter(id){ comboRender(id, document.getElementById(id+'-q').value.trim().toLowerCase()); }
function comboRender(id, q){
  if(_combos[id]) _combos[id].lastQ = q;   /* Enter picks what the list SHOWS */
  const opts = comboData(id).filter(o=>!q || o.label.toLowerCase().includes(q) || (o.sub||'').toLowerCase().includes(q));
  const box = document.getElementById(id+'-list');
  if(!box) return;
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
  const reg=_combos[id]||{};
  const q = reg.lastQ!=null ? reg.lastQ
          : document.getElementById(id+'-q').value.trim().toLowerCase();
  if(!q){
    /* fresh-open Enter keeps the CURRENT pick — never silently switches to
       the alphabetically-first option */
    const cur=document.getElementById(id);
    if(cur&&cur.value){ const o=comboData(id).find(x=>String(x.v)===String(cur.value));
      if(o){ comboPick(id,o.v); return; } }
  }
  const o = comboData(id).find(x=>!q || x.label.toLowerCase().includes(q) || (x.sub||'').toLowerCase().includes(q));
  if(o) comboPick(id, o.v);
}
function comboClose(id){ const b=document.getElementById(id+'-list'); if(b) b.style.display='none'; }
document.addEventListener('mousedown', ev=>{ if(!ev.target.closest('.combo')) document.querySelectorAll('[id$="-list"]').forEach(b=>b.style.display='none'); });

/* multi-select combo — array value, empty = no filter; suite contract */
function multiCombo(id, opts, vals, ontoggle, placeholder, noAll){
  vals = Array.isArray(vals) ? vals : [];
  _combos[id] = { opts, vals: vals.slice(), multi: true, noAll: !!noAll,
    ontoggle: typeof ontoggle==='function' ? ontoggle : null };
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
      onkeydown="if(event.key==='Enter'){event.preventDefault();multiPickFirst('${id}');} if(event.key==='Escape'){comboClose('${id}');event.stopPropagation();}">
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
  box.innerHTML =
    (reg.noAll?'':`<div style="padding:6px 11px;cursor:pointer;font-size:12px;border-bottom:1px solid var(--line);color:${reg.vals.length?'var(--brand)':'var(--ink-3,#66757e)'}" onmousedown="event.preventDefault();multiToggle('${id}',null)">${reg.vals.length?'✕ Clear — show all':'All (nothing selected = no filter)'}</div>`)
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

function closeMenus(){ document.querySelectorAll('.menu.open').forEach(m=>m.classList.remove('open')); }
document.addEventListener('click',closeMenus);

function commitRender(srcEl){
  if(srcEl && document.activeElement===srcEl){ srcEl.addEventListener('blur', ()=>render(), {once:true}); }
  else render();
}

/* uniform input ergonomics (bug #26 follow-up) */
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
function openModal(html,wide){ const m=document.getElementById('modal');
  m.className='modal'+(wide?' wide':''); m.innerHTML=html;
  document.getElementById('scrim').classList.add('open'); }
function closeModal(){ document.getElementById('scrim').classList.remove('open'); }
document.getElementById('scrim').addEventListener('click',e=>{ if(e.target.id==='scrim') closeModal(); });
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  /* Escape inside an open combo dropdown dismisses THE DROPDOWN only — the
     modal (with a half-filled form) must survive the first Escape */
  const lists=[...document.querySelectorAll('[id$="-list"]')].filter(b=>b.style.display==='block');
  if(lists.length){ lists.forEach(b=>b.style.display='none'); return; }
  closeModal();
});
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

/* ---------------- list pagination (build-13 pattern, 'as.' prefix) -------- */
const _pagers = {};
const PAGE_SIZES = [10,25,50,100];
const PAGER_LS = 'as.pgsz.';
function pagerSize(key){ let v=0; try{ v=Number(localStorage.getItem(PAGER_LS+key.split(':')[0])); }catch(e){} return PAGE_SIZES.includes(v)?v:25; }
function pagerState(key){ return _pagers[key]||(_pagers[key]={page:0}); }
function pagerSetSize(key,v){ try{ localStorage.setItem(PAGER_LS+key.split(':')[0],String(v)); }catch(e){} pagerState(key).page=0; render(); }
function pagerGo(key,delta){ pagerState(key).page+=delta; render(); }
function paginate(key,rows){
  const size=pagerSize(key), p=pagerState(key);
  const nPages=Math.max(1,Math.ceil(rows.length/size));
  if(p.page>nPages-1) p.page=nPages-1;
  if(p.page<0) p.page=0;
  const start=p.page*size;
  return { key, slice:rows.slice(start,start+size), total:rows.length, start, size, page:p.page, nPages };
}
function pagerBar(pg){
  if(pg.total===0) return '';
  return `<div class="pager">
    <select onchange="pagerSetSize('${jsq(pg.key)}',Number(this.value))" title="Rows per page">${PAGE_SIZES.map(s=>`<option value="${s}" ${s===pg.size?'selected':''}>${s} / page</option>`).join('')}</select>
    <span class="mini muted">${pg.start+1}–${Math.min(pg.total,pg.start+pg.size)} of ${pg.total}</span>
    <button class="rowbtn" ${pg.page===0?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',-1)">‹ Prev</button>
    <button class="rowbtn" ${pg.page>=pg.nPages-1?'disabled':''} onclick="pagerGo('${jsq(pg.key)}',1)">Next ›</button>
  </div>`;
}

/* ---------------- entity event feed (detail modals) ---------------- */
function eventFeed(kind, id){
  const evs = entityEvents(kind, id);
  if(!evs.length) return '<div class="mini muted">No recorded changes yet.</div>';
  return evs.map(e=>`<div class="evt">
    <span class="evt-when">${fmtStamp(e.ts)}</span>
    <div class="evt-body">${esc(e.body)}<div class="evt-who">${esc(e.author)}</div></div>
  </div>`).join('');
}

/* ---------------- CSV export (gated by a_export_csv at the call sites) ---- */
function csvDownload(name, rows){
  const csv = rows.map(r=>r.map(v=>{ v=String(v??'');
    if(/^[=+\-@]/.test(v)) v="'"+v;   /* neutralize spreadsheet formula/DDE injection */
    return /[",\r\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; }).join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=name; a.click();
}
