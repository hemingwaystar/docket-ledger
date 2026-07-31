/* ==========================================================================
   js/desk/boot.js — startup: first paint (Loading… card), the focus
   rehydrate, the notification poller, and the initial hydrate.
   Endpoints: GET /api/automations/notifications (60 s poll);
   GET /api/bootstrap via hydrate().
   Invariants: loads LAST — everything it calls is already defined.
   ========================================================================== */

render();                     /* Loading… card until the first hydrate lands */

/* refresh on focus, throttled */
window.addEventListener('focus',()=>{ if(Date.now()-HYD>30000){HYD=Date.now();hydrate();} });

/* the bell: server notifications are authoritative — the worker's scanner
   writes the notices; this only pulls them */
setInterval(async()=>{
  try{
    const r=await $fetch('/api/automations/notifications');
    if(!r.ok) return;
    const d=await r.json();
    const unread=a=>a.filter(x=>!x.read).length, before=unread(state.notifs);
    state.notifs.length=0; (d.notifs||[]).forEach(n=>state.notifs.push(n));
    const bb=document.getElementById('bellBox');
    if(unread(state.notifs)!==before && !(bb&&bb.style.display==='block')) render();
  }catch(e){}
},60000);

hydrate(false);
