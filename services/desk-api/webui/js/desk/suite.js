/* ==========================================================================
   js/desk/suite.js — the suite bridge: postMessage out to the shell, the
   inbound listener for Ledger's relayed events, and openLedger().
   Endpoints: none.
   Invariants: every post targets location.origin explicitly, never '*';
   inbound messages are accepted only when relayed by our own parent frame
   and stamped src:'ledger'.
   ========================================================================== */

function bridgeSend(type, payload){ try{ if(window.parent!==window) window.parent.postMessage(Object.assign({src:'docket', type}, payload), location.origin); }catch(e){} }

window.addEventListener('message', ev=>{
  /* only accept relayed messages from our own suite shell */
  if(window.parent===window || ev.source!==window.parent) return;
  const d = ev.data || {};
  if(d.src!=='ledger') return;
  if(d.type==='open-directory'){ go('directory'); toast('Directory opened from Ledger.'); }
  if(d.type==='open-ticket' && tk(Number(d.ticket))){
    openTicket(Number(d.ticket));
    toast(`Jumped here from Ledger — ticket #${d.ticket}.`);
  }
  const findEntry = ()=>{
    const t = tk(Number(d.ticket)); if(!t) return {};
    let i = d.eid ? t.time.findIndex(e=>e.eid===d.eid) : -1;
    if(i<0) i = t.time.findIndex(e=>e.techId===d.techId && e.typeId===d.typeId && Math.abs(e.h-(d.oldH!=null?d.oldH:d.h))<1e-6);
    if(i<0) i = t.time.findIndex(e=>e.techId===d.techId && Math.abs(e.h-(d.oldH!=null?d.oldH:d.h))<1e-6);
    return { t, i };
  };
  if(d.type==='entry-removed'){
    const { t, i } = findEntry();
    if(!t || i==null || i<0) return;
    const e = t.time[i];
    const holder = t.articles.find(a=>a.time===e);
    if(holder) delete holder.time;
    t.time.splice(i,1);
    t.articles.push(art('sys', {name:'Ledger'}, nowMs(), `Time entry removed via Ledger — ${fmtHours(e.h)} h · ${atype(e.typeId)?.name||''} (${agent(e.techId)?.name.split(' ')[0]||''})`));
    t.updatedAt = nowMs();
    state.audit.unshift({ ts:nowMs(), who:'Ledger', action:'Time entry removed in Ledger', detail:`#${t.id} · ${fmtHours(e.h)} h · ${atype(e.typeId)?.name||''}` });
    toast(`⚡ Ledger removed ${fmtHours(e.h)} h on #${t.id} — mirrored here.`);
    render();
  }
  if(d.type==='entry-updated'){
    const { t, i } = findEntry();
    if(!t || i==null || i<0) return;
    const e = t.time[i];
    const was = e.h;
    if(d.startedAt) e.startedAt = d.startedAt;
    if(d.endedAt) e.endedAt = d.endedAt;
    e.h = (d.startedAt&&d.endedAt)? spanH(e.startedAt,e.endedAt) : d.h;
    if(d.typeId) e.typeId = d.typeId;
    t.updatedAt = nowMs();
    state.audit.unshift({ ts:nowMs(), who:'Ledger', action:'Time entry edited in Ledger', detail:`#${t.id} · ${fmtHours(was)} h → ${fmtHours(d.h)} h` });
    toast(`⚡ Ledger adjusted #${t.id} to ${fmtHours(d.h)} h — mirrored here.`);
    render();
  }
});

function openLedger(note){
  if(window.parent!==window){ window.parent.postMessage({src:'docket', type:'suite-nav', app:'ledger'}, location.origin); }
  else {
    /* standalone: on the nginx front (standard https port) Ledger is proxied
       under /ledger/; on direct service-port access it lives on :8082 */
    const url = (location.port===''||location.port==='443'||location.port==='80')
      ? '/ledger/ui/ledger.html'
      : location.protocol + '//' + location.hostname + ':8082/ui/ledger.html';
    window.open(url, 'ledger');
  }
  toast(note || 'Opening Ledger.');
}
