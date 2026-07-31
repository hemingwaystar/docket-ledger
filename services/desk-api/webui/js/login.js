/* login.js — sign-in flow for login.html.
   Owns: method discovery (SSO button / password form visibility), the login
   submit, and the MFA step-up prompt (X-MFA: required → show the TOTP row).
   Endpoints: GET /auth/methods · POST /auth/login
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
    err.textContent=d.detail||'Sign-in failed';err.style.display='block';
  }catch(e){err.textContent='Cannot reach the server';err.style.display='block'}
});
