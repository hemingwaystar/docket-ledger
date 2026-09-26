/* ==========================================================================
   js/idle.js — automatic sign-out (HIPAA §164.312(a)(2)(iii); 0049).
   Identical copy in desk-api, ledger-api and assets-api webui/js/.

   The SERVER is the enforcer: every service refuses a session idle longer
   than app_config auth.idle_minutes. This script is the screen half — it
   clears the page (navigates the top window to the sign-in page) when the
   user has been idle that long, so PHI doesn't sit on an unattended screen.

   Activity = mouse / keyboard / touch / wheel in ANY suite frame. The
   frames share one origin behind nginx, so the last-activity time is shared
   through localStorage — working in Ledger keeps Docket's frame from timing
   out. While active, it pings the app's /me at most once a minute so the
   server session stays alive even when the user is only reading or typing
   (no API calls). Background polls send X-HTS-Passive and never count.

   Config (set by the page before this loads): window.HTS_IDLE =
     { ping: '<this app's /me>', logout: '<desk /auth/logout>',
       login: '<desk /ui/login.html>' }
   ========================================================================== */
(function(){
  const cfg = window.HTS_IDLE || {};
  if(!cfg.ping || !cfg.login) return;
  const KEY = 'hts_last_activity';
  let limitMs = 480 * 60000;             /* 8 h default, until the server says otherwise */
  let local = Date.now(), lastPing = 0, gone = false;
  const readShared = () => { try{ return Number(localStorage.getItem(KEY)) || 0; }catch(e){ return 0; } };
  const writeShared = v => { try{ localStorage.setItem(KEY, String(v)); }catch(e){} };
  writeShared(local);

  function signOut(msg){
    if(gone) return; gone = true;
    const url = cfg.login + '?err=' + encodeURIComponent(msg);
    const go = () => { try{ (window.top || window).location.href = url; }
                       catch(e){ location.href = url; } };
    if(cfg.logout){
      fetch(cfg.logout, {method:'POST', credentials:'include'}).catch(()=>{}).finally(go);
    } else go();
  }
  function ping(){
    lastPing = Date.now();
    fetch(cfg.ping, {credentials:'include'})
      .then(r => { if(r.status === 401){
          return r.json().catch(()=>({})).then(d => signOut(d.detail || 'Your session ended — sign in again.')); }
        return r.ok ? r.json() : null; })
      .then(d => { if(d && d.idle_minutes) limitMs = d.idle_minutes * 60000; })
      .catch(()=>{});
  }
  function activity(){
    const n = Date.now();
    if(n - local < 5000) return;          /* mousemove storms: one stamp per 5 s */
    local = n; writeShared(n);
    if(n - lastPing > 60000) ping();
  }
  ['mousedown','keydown','wheel','touchstart','mousemove'].forEach(ev =>
    window.addEventListener(ev, activity, {passive:true, capture:true}));
  setInterval(() => {
    if(gone) return;
    const idle = Date.now() - Math.max(local, readShared());
    if(idle > limitMs) signOut('Signed out after ' + Math.round(limitMs/60000) +
                               ' minutes of inactivity — sign in again.');
  }, 15000);
  ping();                                  /* learn the configured window */
})();
