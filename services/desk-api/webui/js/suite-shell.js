/* suite-shell.js — suite.html chrome: tab switching between the Docket and
   Ledger panes, the postMessage relay between the two frames, and Ledger
   frame src resolution (nginx front vs direct service port).
   Endpoints: none — this file never calls the API.
   Invariants: the relay only accepts messages whose source is one of our own
   two frames, and posts with an explicit location.origin target. */
/* Both iframes stay mounted the whole time, so each app keeps its state while
   hidden — switching tabs never resets either app. */
let view = 'docket';
function show(v){
  view = v;
  const stage = document.getElementById('stage');
  stage.classList.toggle('split', v==='split');
  document.getElementById('pane-docket').classList.toggle('show', v==='docket'||v==='split');
  document.getElementById('pane-ledger').classList.toggle('show', v==='ledger'||v==='split');
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on', b.dataset.v===v));
}
/* Message relay — Docket time events → Ledger; Ledger ticket jumps → Docket. */
const fr = id => document.getElementById(id).contentWindow;
window.addEventListener('message', ev=>{
  /* relay only for our own two frames — nothing else gets a voice */
  if(ev.source!==fr('fr-docket') && ev.source!==fr('fr-ledger')) return;
  const d = ev.data || {};
  if(d.src==='docket'){
    if(d.type==='suite-nav'){ show(d.app==='ledger'?'ledger':'docket'); return; }
    fr('fr-ledger').postMessage(d, location.origin);
    if(d.type==='time-logged') flash('Time entry flowed Docket \u2192 Ledger');
    if(d.type==='time-updated') flash('Entry edit flowed Docket \u2192 Ledger');
    if(d.type==='time-removed') flash('Removal flowed Docket \u2192 Ledger (voided there)');
  }
  if(d.src==='ledger'){
    fr('fr-docket').postMessage(d, location.origin);
    if(d.type==='open-ticket'){ show(view==='split'?'split':'docket'); flash('Jumped Ledger \u2192 Docket ticket #'+d.ticket); }
    if(d.type==='entry-removed') flash('Removal flowed Ledger \u2192 Docket');
    if(d.type==='entry-updated') flash('Entry edit flowed Ledger \u2192 Docket');
  }
});
let flashT = null;
function flash(msg){
  const el = document.getElementById('hintTxt');
  el.textContent = '\u26a1 ' + msg;
  clearTimeout(flashT);
  flashT = setTimeout(()=>{ el.textContent = 'Log time on a ticket in Docket — watch it land in Ledger live'; }, 5000);
}

/* live: on the nginx front (standard https port) Ledger is proxied under
   /ledger/; on direct NetBird access it stays on its own service port */
document.getElementById('fr-ledger').src =
  (location.port===''||location.port==='443'||location.port==='80')
    ? '/ledger/ui/ledger.html'
    : location.protocol + '//' + location.hostname + ':8082/ui/ledger.html';
