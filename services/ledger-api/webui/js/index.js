/* ============================================================================
   FALLBACK THIN CLIENT — js/index.js (Ledger /ui/index.html)
   ----------------------------------------------------------------------------
   Owns the entire fallback page: nav + My time / Approvals / Periods views.
   Deliberately self-contained — its own api()/esc()/money() helpers, no
   js/ledger/* dependency. Every fetch goes through api(), which prefixes
   LBASE (bug #8) and bounces 401s to the login page.

   Endpoints:
     GET  /me
     GET  /api/entries?limit=500
     POST /api/entries/{id}/submit
     POST /api/timesheets/approve · POST /api/timesheets/return
     GET  /api/periods
     POST /api/periods/{id}/approve
     GET  /api/periods/{id}/export-payload
     POST /api/periods/{id}/mark-exported
   ========================================================================= */
const LBASE=location.pathname.startsWith('/ledger/')?'/ledger':'';
const loginUrl=()=>LBASE?'/ui/login.html':location.protocol+'//'+location.hostname+':8081/ui/login.html';
const api=(p,opt)=>fetch(LBASE+p,{credentials:'same-origin',...(opt||{})}).then(async r=>{
  if(r.status===401){location.href=loginUrl();throw new Error('auth')}
  return {ok:r.ok,data:await r.json().catch(()=>({}))}});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=c=>'$'+(c/100).toFixed(2);
let ME=null,VIEW='time',ENTRIES=[];
const can=p=>ME.perms.includes(p);

async function boot(){
  ME=(await api('/me')).data;
  document.getElementById('meName').textContent=ME.name;
  document.getElementById('meMail').textContent=ME.email;
  document.getElementById('logout').onclick=()=>{document.cookie='hts_session=; Max-Age=0; path=/';location.href=loginUrl()};
  const tabs=[['time','My time']];
  if(can('l_approve'))tabs.push(['approvals','Approvals']);
  tabs.push(['periods','Periods']);
  const nav=document.getElementById('nav');
  nav.innerHTML=tabs.map(([k,l])=>`<a data-v="${k}" class="${k===VIEW?'on':''}">${l}</a>`).join('');
  nav.querySelectorAll('a').forEach(a=>a.onclick=()=>{VIEW=a.dataset.v;boot()});
  render();
}
async function loadEntries(){ENTRIES=(await api('/api/entries?limit=500')).data.entries||[]}

async function render(){
  const m=document.getElementById('main');
  if(VIEW==='time'){
    await loadEntries();
    const mine=ENTRIES.filter(e=>e.technician_email===ME.email||can('l_view_all'));
    const showAmt=can('l_see_amounts');
    m.innerHTML=`<h1>Time</h1><div class="sub">${mine.length} entries · live from ledger-api</div>
      <div class="toolbar" id="tb"></div><div id="wrap"></div>`;
    const statuses=['all','pending','submitted','approved','locked'];
    let f='all';
    const draw=()=>{
      document.getElementById('tb').innerHTML=statuses.map(s=>
        `<button class="chip ${s===f?'on':''}" data-s="${s}">${s[0].toUpperCase()+s.slice(1)}</button>`).join('')
        +(mine.some(e=>e.status==='pending')?`<button class="btn" id="subAll" style="margin-left:auto">Submit all pending</button>`:'');
      document.querySelectorAll('#tb .chip').forEach(b=>b.onclick=()=>{f=b.dataset.s;draw()});
      const rows=mine.filter(e=>f==='all'||e.status===f);
      document.getElementById('wrap').innerHTML=rows.length?
        `<table><thead><tr><th>When</th><th>Ticket</th><th>Client</th><th>Tech</th><th>Type</th>
          <th class="num">Hours</th>${showAmt?'<th class="num">Amount</th>':''}<th>Status</th><th></th></tr></thead><tbody>`+
        rows.map(e=>`<tr>
          <td>${new Date(e.started_at).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
          <td class="num">${e.ticket_id?'#'+e.ticket_id:'—'}</td><td>${esc(e.client)}</td>
          <td>${esc(e.technician)}</td><td>${esc(e.activity_type)}</td>
          <td class="num">${(+e.hours).toFixed(2)}</td>
          ${showAmt?`<td class="num">${e.covered_by_project_flat?'flat':money(e.amount_cents)}</td>`:''}
          <td><span class="pill ${e.status}">${e.status}</span>${e.return_reason?` <span class="msg bad" title="${esc(e.return_reason)}">↩</span>`:''}</td>
          <td>${e.status==='pending'&&e.activity_type!=='Unclassified'?`<button class="btn ghost" data-sub="${e.id}">Submit</button>`:''}</td>
        </tr>`).join('')+'</tbody></table>'
        :'<div class="empty">No entries yet — log time from Docket tickets and it lands here.</div>';
      document.querySelectorAll('[data-sub]').forEach(b=>b.onclick=async()=>{
        const r=await api('/api/entries/'+b.dataset.sub+'/submit',{method:'POST'});
        if(r.ok){await loadEntries();draw()}else alert(r.data.detail||'Failed')});
      const sa=document.getElementById('subAll');
      if(sa)sa.onclick=async()=>{
        for(const e of mine.filter(x=>x.status==='pending'&&x.activity_type!=='Unclassified'))
          await api('/api/entries/'+e.id+'/submit',{method:'POST'});
        await loadEntries();draw()};
    };draw();
  }
  if(VIEW==='approvals'){
    await loadEntries();
    const sheets={};
    for(const e of ENTRIES.filter(e=>e.status!=='void'&&e.period_key)){
      const k=e.technician_email+'|'+e.client+'|'+e.period_key;
      (sheets[k]=sheets[k]||{tech:e.technician,tech_email:e.technician_email,client:e.client,
        period:e.period_key,hours:0,n:0,sub:0,app:0,locked:e.period_status!=='open'}).hours+=+e.hours;
      sheets[k].n++;if(e.status!=='pending')sheets[k].sub++;if(e.status==='approved'||e.status==='locked')sheets[k].app++;
    }
    const list=Object.values(sheets).sort((a,b)=>b.period.localeCompare(a.period));
    m.innerHTML=`<h1>Timesheet approvals</h1><div class="sub">${list.length} sheets (tech × client × period)</div><div id="wrap"></div>`;
    document.getElementById('wrap').innerHTML=list.length?list.map((s,i)=>`<div class="card">
      <h3>${esc(s.tech)} · ${esc(s.client)} · ${s.period}</h3>
      <div class="row"><span><b>${s.hours.toFixed(2)}</b> h · ${s.n} entries</span>
        <span>${s.sub}/${s.n} submitted · ${s.app}/${s.n} approved</span>
        ${s.locked?'<span class="pill locked">period locked</span>':`
        <button class="btn" data-ap="${i}" ${s.sub<s.n||s.app===s.n?'disabled':''}>Approve</button>
        <button class="btn warn" data-rt="${i}" ${s.sub===0||s.app===s.n?'disabled':''}>Return</button>`}
        <span class="msg" id="sm${i}"></span></div></div>`).join('')
      :'<div class="empty">Nothing awaiting review.</div>';
    const act=async(i,path,extra)=>{
      const s=list[i],el=document.getElementById('sm'+i);
      const r=await api('/api/timesheets/'+path,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({tech_email:s.tech_email,client:s.client,period_key:s.period,...extra})});
      el.textContent=r.ok?'Done ✓':(r.data.detail||'Failed');el.className='msg '+(r.ok?'ok':'bad');
      if(r.ok)setTimeout(render,700)};
    document.querySelectorAll('[data-ap]').forEach(b=>b.onclick=()=>act(+b.dataset.ap,'approve',{}));
    document.querySelectorAll('[data-rt]').forEach(b=>b.onclick=()=>{
      const reason=prompt('Reason to send back (shown to the tech):')||'';act(+b.dataset.rt,'return',{reason})});
  }
  if(VIEW==='periods'){
    const d=(await api('/api/periods')).data.periods||[];
    const showAmt=can('l_see_amounts');
    m.innerHTML=`<h1>Billing periods</h1><div class="sub">${d.length} periods</div><div id="wrap"></div>`;
    document.getElementById('wrap').innerHTML=d.length?d.map((p,i)=>`<div class="card">
      <h3>${esc(p.client)} · ${p.period_key} <span class="pill ${p.status}">${p.status}</span></h3>
      <div class="row"><span><b>${(+p.hours).toFixed(2)}</b> h · ${p.entries} entries</span>
        ${showAmt?`<span>hourly <b>${money(+p.hourly_amount_cents)}</b>${+p.project_flat_cents?` · project fees <b>${money(+p.project_flat_cents)}</b>`:''}</span>`:''}
        ${p.export_ref?`<span>ref <b>${esc(p.export_ref)}</b></span>`:''}
        ${can('l_approve')&&p.status==='open'?`<button class="btn" data-pa="${i}">Approve &amp; lock</button>`:''}
        ${can('l_export')&&p.status==='approved'?`<button class="btn ghost" data-pv="${i}">Preview export</button>
          <button class="btn" data-px="${i}">Mark exported</button>`:''}
        <span class="msg" id="pm${i}"></span></div>
      <div id="pp${i}"></div></div>`).join('')
      :'<div class="empty">Periods appear as soon as time is logged.</div>';
    const em=ME.email;
    document.querySelectorAll('[data-pa]').forEach(b=>b.onclick=async()=>{
      const i=+b.dataset.pa,r=await api('/api/periods/'+d[i].id+'/approve',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({approver_email:em})});
      const el=document.getElementById('pm'+i);
      el.textContent=r.ok?'Locked ✓':(r.data.detail||'Failed');el.className='msg '+(r.ok?'ok':'bad');
      if(r.ok)setTimeout(render,700)});
    document.querySelectorAll('[data-pv]').forEach(b=>b.onclick=async()=>{
      const i=+b.dataset.pv,r=await api('/api/periods/'+d[i].id+'/export-payload');
      document.getElementById('pp'+i).innerHTML='<pre>'+esc(JSON.stringify(r.data,null,2))+'</pre>'});
    document.querySelectorAll('[data-px]').forEach(b=>b.onclick=async()=>{
      const i=+b.dataset.px,r=await api('/api/periods/'+d[i].id+'/mark-exported',{method:'POST'});
      const el=document.getElementById('pm'+i);
      el.textContent=r.ok?('Exported ✓ '+r.data.export_ref):(r.data.detail||'Failed');
      el.className='msg '+(r.ok?'ok':'bad');if(r.ok)setTimeout(render,900)});
  }
}
boot();
