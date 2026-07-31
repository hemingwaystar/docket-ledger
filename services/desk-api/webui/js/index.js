/* index.js — fallback Docket shell (/ui/index.html).
   Self-contained on purpose: no js/desk/* dependency, so it still works when
   the full app cannot load. Owns: session boot, forced password change
   (login.html redirects here with #change-password), the ticket queue with
   state filters, and a minimal ticket view — state/priority/owner patching
   and a note/reply composer with optional time logging.
   Endpoints: GET /auth/me · POST /auth/logout · POST /auth/change-password ·
   GET /api/meta · GET /api/tickets[?state=] · GET /api/tickets/{id} ·
   PATCH /api/tickets/{id} · POST /api/tickets/{id}/articles
   Any 401 redirects to login.html. */
const api=p=>fetch(p,{credentials:'same-origin'}).then(r=>{if(r.status===401)location.href='login.html';return r.json()});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let ME=null,META=null,FILTER='open';

async function boot(){
  ME=await api('/auth/me');
  document.getElementById('meName').textContent=ME.name;
  document.getElementById('meMail').textContent=ME.email;
  document.getElementById('logout').onclick=async()=>{await fetch('/auth/logout',{method:'POST',credentials:'same-origin'});location.href='login.html'};
  if(ME.must_change_password||location.hash==='#change-password'){
    document.getElementById('pwCard').style.display='block';
    document.getElementById('pwGo').onclick=async()=>{
      const m=document.getElementById('pwMsg');m.textContent='';m.className='msg';
      const cur=document.getElementById('pwCur').value,nw=document.getElementById('pwNew').value;
      if(nw!==document.getElementById('pwNew2').value){m.textContent='New passwords differ';m.className='msg bad';return}
      const r=await fetch('/auth/change-password',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({current_password:cur,new_password:nw})});
      const d=await r.json().catch(()=>({}));
      if(r.ok){m.textContent='Changed ✓';m.className='msg ok';
        setTimeout(()=>{location.hash='';document.getElementById('pwCard').style.display='none'},700)}
      else{m.textContent=d.detail||'Failed';m.className='msg bad'}
    };
  }
  META=await api('/api/meta');
  renderFilters();loadQueue();
}
function renderFilters(){
  const f=document.getElementById('filters');
  f.innerHTML=['open','paused','done','all'].map(k=>
    `<button class="chip ${k===FILTER?'on':''}" data-k="${k}">${k[0].toUpperCase()+k.slice(1)}</button>`).join('');
  f.querySelectorAll('.chip').forEach(b=>b.onclick=()=>{FILTER=b.dataset.k;renderFilters();loadQueue()});
}
async function loadQueue(){
  const q=FILTER==='all'?'':'?state='+FILTER;
  const d=await api('/api/tickets'+q);
  const rows=d.tickets||[];
  document.getElementById('qsub').textContent=rows.length+' tickets · live from desk-api';
  document.getElementById('qwrap').innerHTML=rows.length?
    `<table><thead><tr><th>#</th><th>Title</th><th>Client</th><th>Group</th><th>State</th><th>Priority</th><th>Owner</th></tr></thead><tbody>`+
    rows.map(t=>`<tr data-id="${t.id}"><td class="num">${t.id}</td><td><b>${esc(t.title)}</b>${t.is_project?' 📋':''}</td>
      <td>${esc(t.client)}</td><td>${esc(t.group)}</td>
      <td><span class="pill ${t.state_kind}">${esc(t.state)}</span></td>
      <td>${esc(t.priority)}</td><td>${esc(t.owner||'—')}</td></tr>`).join('')+'</tbody></table>'
    :'<div class="empty">No tickets match. When Graph ingestion goes live, inbound mail lands here.</div>';
  document.querySelectorAll('tbody tr').forEach(tr=>tr.onclick=()=>openTicket(tr.dataset.id));
}
async function openTicket(id){
  const t=await api('/api/tickets/'+id);
  document.getElementById('queue').style.display='none';
  const v=document.getElementById('view');v.style.display='block';
  const lastIn=[...t.articles].reverse().find(a=>a.kind==='mail_in');
  const opts=(list,cur)=>list.map(x=>`<option ${x===cur?'selected':''}>${esc(x)}</option>`).join('');
  v.innerHTML=`<span class="back" id="back">← Queue</span>
    <h1>#${t.id} · ${esc(t.title)}</h1>
    <div class="meta">
      <span>Client <b>${esc(t.client)}</b></span><span>Group <b>${esc(t.group)}</b></span>
      <span>State <select id="mState">${opts(META.states.map(s=>s.label),t.state)}</select></span>
      <span>Priority <select id="mPrio">${opts(META.priorities,t.priority)}</select></span>
      <span>Owner <select id="mOwner"><option value="">—</option>${META.agents.map(a=>
        `<option value="${esc(a.email)}" ${a.name===t.owner?'selected':''}>${esc(a.name)}</option>`).join('')}</select></span>
      ${t.time.length?`<span>Time <b>${t.time.reduce((a,e)=>a+ +e.hours,0).toFixed(2)} h</b></span>`:''}
      <span class="msg" id="mMsg"></span></div>
    <div class="thread">${t.articles.map(a=>`<div class="art ${a.kind==='note'?'note':a.kind==='sys'?'sys':''}">
      <div class="hd"><b>${esc(a.author)}</b> · ${a.kind==='mail_in'?'inbound mail':a.kind==='reply'?(a.mail_to?'reply → '+esc(a.mail_to):'reply'):a.kind} · ${new Date(a.sent_at).toLocaleString()}</div>
      <div>${esc(a.body)}</div></div>`).join('')||'<div class="art sys">No articles yet</div>'}</div>
    <div class="composer">
      <div class="row" style="margin:0 0 9px">
        <button class="chip on" id="segNote">Note</button>
        <button class="chip" id="segReply">Reply</button>
        <span id="toWrap" style="display:none">to
          <input id="cTo" style="padding:7px 9px;border:1px solid var(--line);border-radius:8px;font:inherit;font-size:13px;min-width:240px"
                 value="${esc(lastIn?lastIn.mail_from||'':'')}"></span>
      </div>
      <textarea id="cBody" placeholder="Internal note…"></textarea>
      <div class="row">
        <label><input type="checkbox" id="cTime"> log time</label>
        <input type="datetime-local" id="cStart"><span style="color:var(--mut)">→</span>
        <input type="datetime-local" id="cEnd">
        <select id="cType">${META.activity_types.map(x=>`<option>${esc(x)}</option>`).join('')}</select>
        <button class="btn" id="cSend">Add note</button><span class="msg" id="cMsg"></span>
      </div></div>`;
  document.getElementById('back').onclick=()=>{v.style.display='none';document.getElementById('queue').style.display='block';loadQueue()};
  let MODE='note';
  const segN=document.getElementById('segNote'),segR=document.getElementById('segReply');
  const setMode=m=>{MODE=m;segN.className='chip'+(m==='note'?' on':'');segR.className='chip'+(m==='reply'?' on':'');
    document.getElementById('toWrap').style.display=m==='reply'?'inline':'none';
    document.getElementById('cBody').placeholder=m==='reply'?'Reply to the customer…':'Internal note…';
    document.getElementById('cSend').textContent=m==='reply'?'Send reply':'Add note'};
  segN.onclick=()=>setMode('note');segR.onclick=()=>setMode('reply');
  const patch=async body=>{
    const m=document.getElementById('mMsg');m.textContent='';m.className='msg';
    const r=await fetch('/api/tickets/'+id,{method:'PATCH',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify({version:t.version,...body})});
    const d=await r.json().catch(()=>({}));
    if(r.ok){openTicket(id)}else{m.textContent=d.detail||'Failed';m.className='msg bad'}
  };
  document.getElementById('mState').onchange=e=>patch({state:e.target.value});
  document.getElementById('mPrio').onchange=e=>patch({priority:e.target.value});
  document.getElementById('mOwner').onchange=e=>patch({owner_email:e.target.value});
  const now=new Date(),pad=n=>String(n).padStart(2,'0'),
    dl=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('cEnd').value=dl(now);
  document.getElementById('cStart').value=dl(new Date(now-30*60000));
  document.getElementById('cSend').onclick=async()=>{
    const msg=document.getElementById('cMsg');msg.textContent='';msg.className='msg';
    const payload={kind:MODE,body:document.getElementById('cBody').value.trim(),author_email:ME.email};
    if(!payload.body){msg.textContent='Write something first';msg.className='msg bad';return}
    if(MODE==='reply'){const to=document.getElementById('cTo').value.trim();if(to)payload.to=to}
    if(document.getElementById('cTime').checked)
      payload.time={started_at:new Date(document.getElementById('cStart').value).toISOString(),
        ended_at:new Date(document.getElementById('cEnd').value).toISOString(),
        activity_type:document.getElementById('cType').value,technician_email:ME.email};
    const r=await fetch('/api/tickets/'+id+'/articles',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d=await r.json().catch(()=>({}));
    if(r.ok){
      msg.className='msg ok';
      msg.textContent=MODE==='reply'?(d.sent?'Sent ✓':'Recorded — outbound disabled'):
        (d.time_entry_id?'Noted + time → Ledger':'Noted');
      setTimeout(()=>openTicket(id),600);
    }else{msg.textContent=d.detail||'Failed';msg.className='msg bad'}
  };
}

boot();
