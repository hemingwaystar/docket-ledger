/* login.js — sign-in flow for login.html.
   Owns: method discovery (SSO button / password form visibility), the login
   submit, the MFA step-up prompt (X-MFA: required → show the TOTP row) and
   the login-time TOTP enrollment panel (X-MFA: enroll → password-gated
   enroll-start mints a PENDING secret; a valid code on the next submit
   completes enrollment inside /auth/login and signs in — one round-trip).
   Endpoints: GET /auth/methods · POST /auth/login · POST /auth/mfa/enroll-start
   (SSO itself is a plain navigation to /auth/oidc/login.)
   On success: suite.html, or index.html#change-password when the server says
   must_change_password. */
const f=document.getElementById('f'),err=document.getElementById('err'),mfa=document.getElementById('mfaRow');
/* which doors are open — SSO button and/or the password form */
fetch('/auth/methods',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).then(m=>{
  if(!m) return;
  if(m.sso){ document.getElementById('ssoBtn').style.display='block';
    if(m.local) document.getElementById('ssoDiv').style.display='flex'; }
  if(!m.local && m.sso){ document.getElementById('localBox').style.display='none';
    ['email','pw'].forEach(id=>document.getElementById(id).required=false); }
}).catch(()=>0);
/* login-time enrollment: password re-verified server-side, no session needed.
   Re-clicking re-mints — the server only ever replaces PENDING secrets; an
   already-enrolled account gets a 409 telling them to ask an admin. No QR
   deliberately (no external libs): manual secret entry + the otpauth: link
   (tappable where an authenticator registers the scheme) cover both paths. */
document.getElementById('enrollGo').addEventListener('click', async ()=>{
  err.style.display='none';
  const r=await fetch('/auth/mfa/enroll-start',{method:'POST',headers:{'Content-Type':'application/json'},
    credentials:'same-origin',body:JSON.stringify({email:f.email.value.trim(),password:f.pw.value})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){ err.textContent=d.detail||'Could not start enrollment'; err.style.display='block'; return; }
  const out=document.getElementById('enrollOut');
  /* server-issued strings enter the DOM as text, never markup (esc() isn't
     loaded on this page — DOM building is the escaper here) */
  out.textContent='Secret (enter manually in your authenticator): ';
  const b=document.createElement('b'); b.textContent=d.secret; out.appendChild(b);
  out.appendChild(document.createElement('br'));
  out.appendChild(document.createTextNode('Or open: '));
  const a=document.createElement('a'); a.href=d.otpauth_uri;
  a.textContent=d.otpauth_uri.slice(0,60)+'…'; out.appendChild(a);
  out.appendChild(document.createElement('br'));
  out.appendChild(document.createTextNode('Then type the 6-digit code above and press Sign in.'));
  out.style.display='block';
});
const oerr=new URLSearchParams(location.search).get('err');
if(oerr){ err.textContent=oerr; err.style.display='block'; }
f.addEventListener('submit',async ev=>{
  ev.preventDefault();err.style.display='none';
  const body={email:f.email.value.trim(),password:f.pw.value};
  const code=f.totp.value.trim();if(code)body.totp_code=code;
  try{
    const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      credentials:'same-origin',body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(r.ok){location.href=d.must_change_password?'index.html#change-password':'suite.html';return}
    if(r.headers.get('X-MFA')==='required'){mfa.style.display='block';f.totp.focus();
      err.textContent='Enter your authenticator code.';err.style.display='block';return}
    if(r.headers.get('X-MFA')==='enroll'){mfa.style.display='block';
      document.getElementById('enrollBox').style.display='block';f.totp.focus();
      err.textContent=d.detail||'MFA enrollment required.';err.style.display='block';return}
    err.textContent=d.detail||'Sign-in failed';err.style.display='block';
  }catch(e){err.textContent='Cannot reach the server';err.style.display='block'}
});
