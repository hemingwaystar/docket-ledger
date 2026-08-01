/* views/reports.js — Reports view.
   Owns state.rpt (report grouping/range/filter/metric state; defaults to the
   current month). client / tech / type / billable / scope filters are
   multi-select ARRAYS (empty = all; setRpt toggles membership, 'all'/null
   clears); group / from / to / includeVoid stay scalar. buildReport computes
   grouped or detailed rows client-side from hydrated entries; viewReports
   renders the builder, stat cards, result table and the admin utilization
   card. CSV leaves via downloadCSV/copyCSV/exportUtilCSV.
   This file calls no server endpoints. */

state.rpt={
  group:'client', from:isoDate(new Date(NOW.getFullYear(),NOW.getMonth(),1)), to:isoDate(new Date(NOW.getFullYear(),NOW.getMonth()+1,0)),
  client:[], tech:[], type:[], billable:[], scope:[], includeVoid:false,
  metrics:{entries:true,hours:true,billable:true,nonbill:false,amount:true,avgrate:true},
  det:{rate:true,status:true,note:false,zammad:false}
};
const RPT_ARR=['client','tech','type','billable','scope'];   /* multi-select keys — empty array = all */

function isoDate(d){ d=new Date(d); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function reportRange(){
  const r=state.rpt;
  const from = r.from ? new Date(r.from+'T00:00:00').getTime() : -Infinity;
  const to   = r.to   ? new Date(r.to+'T23:59:59').getTime()   :  Infinity;
  return [from,to];
}
function reportEntries(){
  const r=_mfNorm(state.rpt,RPT_ARR); const [from,to]=reportRange();
  let es=scopedEntries().slice();
  if(!r.includeVoid) es=es.filter(e=>e.status!=='void');
  es=es.filter(e=> e.startedAt>=from && e.startedAt<=to);
  /* every multi-select predicate is any-of; empty = no constraint */
  if(r.client.length) es=es.filter(e=>r.client.includes(e.clientId));
  if(isAdmin() && r.tech.length) es=es.filter(e=>r.tech.includes(e.techId));
  if(r.type.length)   es=es.filter(e=>r.type.includes(e.typeId));
  if(r.billable.length) es=es.filter(e=>{const p=priced(e);
    return r.billable.some(v=> v==='billable'?p.billable:(!p.billable && !p.unclassified));});
  if(r.scope.length) es=es.filter(e=> r.scope.some(v=> v==='open'?!isLocked(e):isLocked(e)));
  return es;
}
function buildReport(){
  const r=state.rpt, es=reportEntries(), cols=[], rows=[];
  const money=canSeeMoney(), admin=isAdmin();
  if(r.group==='entry'){
    cols.push({k:'date',l:'Date'},{k:'client',l:'Client'},{k:'ticket',l:'Ticket'});
    if(admin) cols.push({k:'tech',l:'Technician'});
    cols.push({k:'activity',l:'Activity'});
    if(r.det.rate && money) cols.push({k:'rate',l:'Rate',num:true});
    cols.push({k:'billable',l:'Billable'},{k:'hours',l:'Hours',num:true});
    if(money) cols.push({k:'amount',l:'Amount',num:true});
    if(r.det.status) cols.push({k:'status',l:'Status'});
    if(r.det.note)   cols.push({k:'note',l:'Note'});
    if(r.det.zammad) cols.push({k:'zammad',l:'Docket ref'});
    es.slice().sort((a,b)=>a.startedAt-b.startedAt).forEach(e=>{
      const p=priced(e), c=client(e.clientId), t=tech(e.techId), a=atype(e.typeId);
      rows.push({ date:fmtDate(e.startedAt), client:c.name, ticket:'#'+e.zTicket+' '+e.ticketTitle, tech:t.name, activity:a.name,
        rate:p.billable?p.rate:0, billable:p.unclassified?'Unclassified':(p.billable?'Yes':'No'),
        hours:p.h, amount:p.amount, status:e.status==='void'?'Voided':(isLocked(e)?'Locked':(e.tsApproved?'Approved':(e.submitted?'Submitted':'Pending'))),
        note:e.content, zammad:'entry #'+e.zEntryId });
    });
  } else {
    const groups={};
    es.forEach(e=>{
      let key,label,meta='';
      if(r.group==='client'){ const c=client(e.clientId); key=c.id; label=c.name; meta=c.cycle; }
      else if(r.group==='tech'){ const t=tech(e.techId); key=t.id; label=t.name; }
      else if(r.group==='type'){ const a=atype(e.typeId); key=a.id; label=a.name; meta=a.sentinel?'unclassified':(a.billable?'billable':'non-billable'); }
      else if(r.group==='ticket'){ key='#'+e.zTicket; label='#'+e.zTicket+' '+e.ticketTitle; meta=client(e.clientId).name; }
      else { const c=client(e.clientId), per=periodFor(c.cycle,e.startedAt); key=c.id+'|'+per.key; label=c.name; meta=per.label+' · '+periodState(c.id,per.key).status; }
      const g=groups[key]||(groups[key]={label,meta,entries:0,hours:0,billH:0,nonbillH:0,amount:0,avg:0});
      const p=priced(e);
      g.entries++; g.hours+=p.h; g.amount+=p.amount;
      if(p.billable) g.billH+=p.h; else if(!p.unclassified) g.nonbillH+=p.h;
    });
    const gl={client:'Client',tech:'Technician',type:'Activity type',ticket:'Ticket',period:'Client'}[r.group];
    cols.push({k:'label',l:gl});
    if(r.group!=='tech') cols.push({k:'meta',l:{client:'Cycle',type:'Kind',ticket:'Client',period:'Period · status'}[r.group]});
    const m=r.metrics;
    if(m.entries)  cols.push({k:'entries',l:'Entries',num:true});
    if(m.hours)    cols.push({k:'hours',l:'Hours',num:true});
    if(m.billable) cols.push({k:'billH',l:'Billable h',num:true});
    if(m.nonbill)  cols.push({k:'nonbillH',l:'Non-bill h',num:true});
    if(m.amount && money)  cols.push({k:'amount',l:'Amount',num:true});
    if(m.avgrate && money) cols.push({k:'avg',l:'Avg $/h',num:true});
    Object.values(groups).forEach(g=>{ g.avg=g.billH>0?g.amount/g.billH:0; rows.push(g); });
    rows.sort((a,b)=> b.amount-a.amount || b.hours-a.hours);
  }
  const totals={entries:0,hours:0,billH:0,nonbillH:0,amount:0,avg:0};
  es.forEach(e=>{ const p=priced(e); totals.entries++; totals.hours+=p.h; totals.amount+=p.amount;
    if(p.billable) totals.billH+=p.h; else if(!p.unclassified) totals.nonbillH+=p.h; });
  totals.avg = totals.billH>0?totals.amount/totals.billH:0;
  return {cols,rows,totals};
}
function rcellHTML(k,row){
  switch(k){
    case 'label': return `<div class="cell-title">${esc(row.label)}</div>`;
    case 'meta': return `<span class="cell-meta" style="text-transform:capitalize">${esc(row.meta||'—')}</span>`;
    case 'entries': return row.entries;
    case 'hours': return fmtHours(row.hours);
    case 'billH': return fmtHours(row.billH);
    case 'nonbillH': return fmtHours(row.nonbillH);
    case 'amount': return `<b>${fmtMoney(row.amount)}</b>`;
    case 'avg': return row.billH>0?`<span class="tape">${fmtMoney(row.avg)}</span>`:'<span class="muted">—</span>';
    case 'date': return `<span class="tape">${esc(row.date)}</span>`;
    case 'client': return esc(row.client);
    case 'ticket': return `<div class="cell-title" style="font-weight:500">${esc(row.ticket)}</div>`;
    case 'tech': return esc(row.tech);
    case 'activity': return esc(row.activity);
    case 'rate': return row.rate?`<span class="tape">${fmtMoney(row.rate)}</span>`:'<span class="muted">—</span>';
    case 'billable': return row.billable==='Yes'?'<span class="chip billable slim"><span class="cdot"></span>Yes</span>':row.billable==='Unclassified'?'<span class="chip unclassified slim"><span class="cdot"></span>Uncl.</span>':'<span class="muted">No</span>';
    case 'status': return esc(row.status);
    case 'note': return `<span class="cell-meta">${esc((row.note||'').slice(0,70))}${(row.note||'').length>70?'…':''}</span>`;
    case 'zammad': return `<span class="tape cell-meta">${esc(row.zammad)}</span>`;
    default: return '';
  }
}
function rtotalHTML(k,t){
  switch(k){
    case 'entries': return t.entries;
    case 'hours': return fmtHours(t.hours);
    case 'billH': return fmtHours(t.billH);
    case 'nonbillH': return fmtHours(t.nonbillH);
    case 'amount': return `<b>${fmtMoney(t.amount)}</b>`;
    case 'avg': return t.billH>0?fmtMoney(t.avg):'—';
    default: return '';
  }
}
function rcellCSV(k,row){
  switch(k){
    case 'label': return row.label; case 'meta': return row.meta||'';
    case 'entries': return row.entries;
    case 'hours': return row.hours.toFixed(2); case 'billH': return row.billH.toFixed(2);
    case 'nonbillH': return row.nonbillH.toFixed(2); case 'amount': return row.amount.toFixed(2);
    case 'avg': return (row.billH>0?row.avg:0).toFixed(2);
    case 'date': return row.date; case 'client': return row.client; case 'ticket': return row.ticket;
    case 'tech': return row.tech; case 'activity': return row.activity;
    case 'rate': return (row.rate||0).toFixed(2); case 'billable': return row.billable;
    case 'status': return row.status; case 'note': return row.note||''; case 'zammad': return row.zammad||'';
    default: return '';
  }
}
function rtotalCSV(k,t){
  switch(k){ case 'entries':return t.entries; case 'hours':return t.hours.toFixed(2);
    case 'billH':return t.billH.toFixed(2); case 'nonbillH':return t.nonbillH.toFixed(2);
    case 'amount':return t.amount.toFixed(2); case 'avg':return (t.billH>0?t.avg:0).toFixed(2); default:return ''; }
}
function reportCSV(rep){
  const q=v=>{ v=String(v); return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const lines=[rep.cols.map(c=>q(c.l)).join(',')];
  rep.rows.forEach(row=> lines.push(rep.cols.map(c=>q(rcellCSV(c.k,row))).join(',')));
  if(rep.rows.length) lines.push(rep.cols.map((c,i)=> i===0?q('TOTAL'):q(rtotalCSV(c.k,rep.totals))).join(','));
  return lines.join('\r\n');
}
function reportTitle(){ return {entry:'Detailed timesheet report',client:'Billing summary by client',tech:'Hours by technician',type:'Summary by activity type',period:'Billing periods report',ticket:'Summary by ticket'}[state.rpt.group]; }
function reportFilename(){ const r=state.rpt; return `ledger-${r.group}-${(r.from||'start')}_to_${(r.to||'end')}.csv`; }
function setRpt(k,v){
  if(RPT_ARR.includes(k)){
    _mfNorm(state.rpt,RPT_ARR);
    if(v==null||v==='all') state.rpt[k]=[];
    else { const a=state.rpt[k], i=a.indexOf(v); if(i>=0) a.splice(i,1); else a.push(v); }
    render(); return;
  }
  state.rpt[k]=v; render();
}
function setRptMetric(k){ state.rpt.metrics[k]=!state.rpt.metrics[k]; render(); }
function setRptDet(k){ state.rpt.det[k]=!state.rpt.det[k]; render(); }
function rptPreset(p){
  const r=state.rpt, y=NOW.getFullYear(), m=NOW.getMonth(); let s,e;
  if(p==='thismonth'){ s=new Date(y,m,1); e=new Date(y,m+1,0); }
  else if(p==='lastmonth'){ s=new Date(y,m-1,1); e=new Date(y,m,0); }
  else if(p==='quarter'){ s=new Date(y,Math.floor(m/3)*3,1); e=NOW; }
  else { const ds=state.entries.map(x=>x.startedAt); s=new Date(Math.min(...ds)); e=new Date(Math.max(...ds)); }
  r.from=isoDate(s); r.to=isoDate(e); render();
}
function downloadCSV(){
  const rep=buildReport();
  if(!rep.rows.length){ toast('Nothing to export for this report'); return; }
  const blob=new Blob([reportCSV(rep)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=reportFilename(); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1200);
  toast('Exported '+reportFilename());
}
function copyCSV(){
  const rep=buildReport();
  if(!rep.rows.length){ toast('Nothing to copy'); return; }
  const csv=reportCSV(rep);
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(csv).then(()=>toast('Report copied — paste into a spreadsheet'),()=>toast('Copy blocked by browser')); }
  else toast('Clipboard unavailable in this browser');
}
function exportUtilCSV(){
  const mkey = new Date().toISOString().slice(0,7);
  const data = [['technician','total_hours','billable_hours','utilization_pct']];
  state.techs.forEach(t=>{
    const es = state.entries.filter(e=>e.techId===t.id && e.status!=='void' && new Date(e.startedAt).toISOString().slice(0,7)===mkey);
    const tot = es.reduce((s,e)=>s+e.hours,0), bil = es.filter(e=>priced(e).billable).reduce((s,e)=>s+e.hours,0);
    data.push([t.name, tot.toFixed(2), bil.toFixed(2), tot?(bil/tot*100).toFixed(1):'0']);
  });
  const csv = data.map(r=>r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = `ledger-utilization-${mkey}.csv`; a.click();
  log('CSV exported', `utilization ${mkey}`);
}
function viewReports(){
  const admin=isAdmin(), money=canSeeMoney();
  const r=_mfNorm(state.rpt,RPT_ARR);
  if(!admin && r.group==='tech') r.group='client';   // techs have no "by technician"
  const rep=buildReport(), t=rep.totals;
  const isDet=r.group==='entry';
  let groups=[['entry','Detailed entries'],['client','By client'],['tech','By technician'],['type','By activity type'],['period','By billing period'],['ticket','By ticket']];
  if(!admin) groups=groups.filter(([v])=>v!=='tech');
  const groupSeg=groups.map(([v,l])=>`<button class="${r.group===v?'on':''}" onclick="setRpt('group','${v}')">${l}</button>`).join('');
  let metricDefs=[['entries','Entries'],['hours','Hours'],['billable','Billable h'],['nonbill','Non-billable h'],['amount','Amount'],['avgrate','Avg $/h']];
  if(!money) metricDefs=metricDefs.filter(([k])=>k!=='amount'&&k!=='avgrate');
  let detDefs=[['rate','Rate'],['status','Status'],['note','Note'],['zammad','Docket ref']];
  if(!money) detDefs=detDefs.filter(([k])=>k!=='rate');
  const metricSeg=isDet
    ? detDefs.map(([k,l])=>`<button class="${r.det[k]?'on':''}" onclick="setRptDet('${k}')">${l}</button>`).join('')
    : metricDefs.map(([k,l])=>`<button class="${r.metrics[k]?'on':''}" onclick="setRptMetric('${k}')">${l}</button>`).join('');

  const controls=`
  <div class="card"><div class="card-pad" style="display:flex;flex-direction:column;gap:13px">
    <div class="rpt-line"><span class="rpt-lab">Report</span><div class="seg wrap">${groupSeg}</div></div>
    <div class="rpt-line"><span class="rpt-lab">Period</span>
      <div class="seg">
        <button onclick="rptPreset('thismonth')">This month</button>
        <button onclick="rptPreset('lastmonth')">Last month</button>
        <button onclick="rptPreset('quarter')">Quarter</button>
        <button onclick="rptPreset('all')">All time</button>
      </div>
      <label class="mini" style="display:flex;align-items:center;gap:6px">from <input type="date" value="${r.from}" onchange="setRpt('from',this.value)"></label>
      <label class="mini" style="display:flex;align-items:center;gap:6px">to <input type="date" value="${r.to}" onchange="setRpt('to',this.value)"></label>
    </div>
    <div class="rpt-line"><span class="rpt-lab">Filters</span>
      <span style="display:inline-block;min-width:200px;vertical-align:middle">${multiCombo('rptClient', state.clients.filter(c=>!c.archivedInDocket||r.client.includes(c.id)).map(c=>({v:c.id,label:c.name+(c.archivedInDocket?' (archived)':'')})), r.client, function(v){ setRpt('client',v); }, 'All clients')}</span>
      ${admin?`<span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('rptTech', state.techs.map(t=>({v:t.id,label:t.name})), r.tech, function(v){ setRpt('tech',v); }, 'All techs')}</span>`:''}
      <span style="display:inline-block;min-width:170px;vertical-align:middle">${multiCombo('rptType', state.types.filter(a=>a.active!==false||r.type.includes(a.id)).map(a=>({v:a.id,label:a.name+(a.active===false?' (archived)':'')})), r.type, function(v){ setRpt('type',v); }, 'All activities')}</span>
      ${money?`<span style="display:inline-block;min-width:150px;vertical-align:middle">${multiCombo('rptBill', [{v:'billable',label:'Billable'},{v:'nonbill',label:'Non-billable'}], r.billable, function(v){ setRpt('billable',v); }, 'Billable + non')}</span>`:''}
      <span style="display:inline-block;min-width:150px;vertical-align:middle">${multiCombo('rptScope', [{v:'open',label:'Open'},{v:'locked',label:'Approved / locked'}], r.scope, function(v){ setRpt('scope',v); }, 'Any status')}</span>
      <label class="mini" style="display:flex;align-items:center;gap:6px"><input type="checkbox" ${r.includeVoid?'checked':''} onchange="setRpt('includeVoid',this.checked)"> include voided</label>
    </div>
    <div class="rpt-line"><span class="rpt-lab">${isDet?'Columns':'Metrics'}</span><div class="seg wrap">${metricSeg}</div></div>
  </div></div>`;

  const stats= money ? `<div class="grid g-4" style="margin:16px 0">
    <div class="card stat"><div class="lab">Entries</div><div class="val tape">${t.entries}</div><div class="sub">in selected range</div></div>
    <div class="card stat"><div class="lab">Total hours</div><div class="val tape">${fmtHours(t.hours)}<span class="u">h</span></div><div class="sub">${fmtHours(t.billH)} billable</div></div>
    <div class="card stat"><div class="lab">Billable amount</div><div class="val money">${fmtMoney(t.amount)}</div><div class="sub">avg ${t.billH>0?fmtMoney(t.avg):'—'}/h</div></div>
    <div class="card stat"><div class="lab">Non-billable</div><div class="val tape">${fmtHours(t.nonbillH)}<span class="u">h</span></div><div class="sub">not invoiced</div></div>
  </div>` : `<div class="grid g-4" style="margin:16px 0">
    <div class="card stat"><div class="lab">Entries</div><div class="val tape">${t.entries}</div><div class="sub">in selected range</div></div>
    <div class="card stat"><div class="lab">Total hours</div><div class="val tape">${fmtHours(t.hours)}<span class="u">h</span></div><div class="sub">your logged time</div></div>
    <div class="card stat"><div class="lab">Billable hours</div><div class="val tape">${fmtHours(t.billH)}<span class="u">h</span></div><div class="sub">on billable activities</div></div>
    <div class="card stat"><div class="lab">Non-billable</div><div class="val tape">${fmtHours(t.nonbillH)}<span class="u">h</span></div><div class="sub">not invoiced</div></div>
  </div>`;

  const head=`<tr>${rep.cols.map(c=>`<th class="${c.num?'num':''}">${c.l}</th>`).join('')}</tr>`;
  const pgR=paginate('report',rep.rows);
  const body= rep.rows.length
    ? pgR.slice.map(row=>`<tr>${rep.cols.map(c=>`<td class="${c.num?'num':''}">${rcellHTML(c.k,row)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${rep.cols.length}" style="padding:26px;text-align:center" class="muted">No entries match this report. Widen the date range or clear a filter.</td></tr>`;
  const foot= rep.rows.length
    ? `<tr class="rpt-total">${rep.cols.map((c,i)=> i===0?`<td>Total · ${rep.rows.length} ${isDet?'entries':'rows'}</td>`:`<td class="${c.num?'num':''}">${rtotalHTML(c.k,t)}</td>`).join('')}</tr>`
    : '';

  const table=`<div class="card">
    <div class="card-head"><h3>${reportTitle()}</h3><span class="hint tape">${r.from} → ${r.to}</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn sm" onclick="copyCSV()">Copy</button>
        <button class="btn primary" onclick="downloadCSV()">${icon(IC.export)}Export CSV</button>
      </div></div>
    <div style="overflow:auto"><table class="tbl"><thead>${head}</thead><tbody>${body}${foot}</tbody></table></div>${pagerBar(pgR)}
  </div>`;

  return `
  ${isAdmin()?`<div class="card" style="margin-bottom:16px">
    <div class="card-head"><h3>Utilization — this month</h3><span class="hint">billable share of all logged time, per technician · target 75%</span>
      <span class="spacer"></span><button class="btn sm ghost" onclick="exportUtilCSV()">⬇ CSV</button></div>
    <div class="card-pad">
      ${(()=>{ const now=new Date(); const mkey=now.toISOString().slice(0,7);
        const rows = state.techs.map(t=>{
          const es = state.entries.filter(e=>e.techId===t.id && e.status!=='void' && new Date(e.startedAt).toISOString().slice(0,7)===mkey);
          const tot = es.reduce((s,e)=>s+e.hours,0);
          const bil = es.filter(e=>priced(e).billable).reduce((s,e)=>s+e.hours,0);
          return { t, tot, bil, pct: tot? bil/tot*100 : 0 };
        });
        return rows.map(r=>`<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="width:130px;font-size:13px">${esc(r.t.name)}</span>
          <div style="flex:1;height:10px;background:#e8edec;border-radius:6px;overflow:hidden;position:relative">
            <div style="height:100%;width:${Math.min(100,r.pct)}%;background:${r.pct>=75?'var(--brand)':'#c9a227'}"></div>
            <div style="position:absolute;left:75%;top:-2px;bottom:-2px;width:2px;background:#15202966"></div>
          </div>
          <span class="tape" style="width:190px;text-align:right">${r.bil.toFixed(1)} / ${r.tot.toFixed(1)} h · <b>${r.pct.toFixed(0)}%</b></span>
        </div>`).join(''); })()}
    </div>
  </div>`:''}`
    + controls + stats + table;
}
