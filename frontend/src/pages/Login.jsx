import React, { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import AppLogo from "../components/AppLogo.jsx";
import { API_BASE, parseJsonResponse } from "../utils/apiBase.js";
import usePageTitle from "../hooks/usePageTitle.js";
import "../styles/pages/login.css";

const GITHUB_CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID || "";
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function Spinner() {
  return (
    <svg style={{animation:'spinAnim 0.8s linear infinite',display:'inline-block'}} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" strokeOpacity="0.2"/>
      <path d="M12 2a10 10 0 0 1 10 10"/>
    </svg>
  );
}

const FEATURES = [
  { icon: "⚡", title: "AI-Powered Test Generation", desc: "Generate comprehensive test suites from your app in seconds" },
  { icon: "🔁", title: "Self-Healing Tests", desc: "Tests that automatically adapt when your UI changes" },
  { icon: "📊", title: "Real-time Analytics", desc: "Deep insights into test coverage, pass rates and trends" },
];

const TESTIMONIALS = [
  { quote: "Sentri cut our QA cycle from 3 days to 20 minutes.", name: "Priya S.", role: "Engineering Lead" },
  { quote: "The self-healing alone saves us hours every sprint.", name: "Marcus T.", role: "Senior Dev" },
  { quote: "Best DX of any testing tool I've used in 10 years.", name: "Aiko N.", role: "CTO" },
];

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, user } = useAuth();

  const [mode, setMode] = useState("login");
  usePageTitle(mode === "login" ? "Sign in" : "Create account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [mounted, setMounted] = useState(false);
  const [tIdx, setTIdx] = useState(0);

  const from = location.state?.from?.pathname || "/dashboard";

  useEffect(() => {
    setMounted(true);
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const provider = params.get("provider");
    const err = params.get("error");
    if (err) {
      const decoded = decodeURIComponent(err);
      const friendlyErrors = {
        access_denied: "Access denied — check that the redirect URI in Google/GitHub Cloud Console matches exactly: " + window.location.origin + "/login?provider=" + (provider || "google"),
        invalid_client: "Invalid OAuth client ID — verify VITE_GOOGLE_CLIENT_ID in frontend/.env matches the Client ID in Google Cloud Console",
        redirect_uri_mismatch: "Redirect URI mismatch — add this exact URI to your OAuth app: " + window.location.origin + "/login?provider=" + (provider || "google"),
      };
      setError(friendlyErrors[decoded] || decoded);
      window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`);
      return;
    }
    if (code && provider && ["github", "google"].includes(provider)) handleOAuthCallback(provider, code);
  }, []);

  const [testiPaused, setTestiPaused] = useState(false);
  useEffect(() => { if (user) navigate(from, { replace: true }); }, [user]);
  useEffect(() => { if (testiPaused) return; const t = setInterval(() => setTIdx(i => (i+1) % TESTIMONIALS.length), 4000); return () => clearInterval(t); }, [testiPaused]);

  async function handleOAuthCallback(provider, code) {
    setOauthLoading(provider); setError("");
    try {
      const params = new URLSearchParams(location.search);
      const returnedState = params.get("state");
      const savedState = sessionStorage.getItem("oauth_state");
      sessionStorage.removeItem("oauth_state");
      if (!returnedState || returnedState !== savedState) {
        throw new Error("OAuth state mismatch — possible CSRF attack. Please try again.");
      }
      const res = await fetch(`${API_BASE}/api/auth/${provider}/callback?code=${code}`, { credentials: "include" });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "OAuth sign-in failed");
      login(data.user);
      window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`);
    } catch (e) { setError(e.message); setOauthLoading(null); window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`); }
  }

  function handleGitHubLogin() {
    if (!GITHUB_CLIENT_ID) { setError("GitHub OAuth not configured. Add VITE_GITHUB_CLIENT_ID to frontend/.env AND GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET to backend/.env"); return; }
    const state = crypto.randomUUID(); sessionStorage.setItem("oauth_state", state);
    const ru = encodeURIComponent(`${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/login?provider=github`);
    window.location.href = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${ru}&scope=user:email&state=${state}`;
  }

  function handleGoogleLogin() {
    if (!GOOGLE_CLIENT_ID) { setError("Google OAuth not configured. Add VITE_GOOGLE_CLIENT_ID to frontend/.env AND GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to backend/.env"); return; }
    const state = crypto.randomUUID(); sessionStorage.setItem("oauth_state", state);
    const ru = encodeURIComponent(`${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/login?provider=google`);
    const sc = encodeURIComponent("openid email profile");
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${ru}&response_type=code&scope=${sc}&state=${state}&access_type=offline&prompt=select_account`;
  }

  async function handleSubmit(e) {
    e.preventDefault(); setError(""); setSuccess("");
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      setError("Please enter a valid email address."); return;
    }
    if (mode === "register") {
      if (!name.trim()) { setError("Full name is required."); return; }
      if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
      if (password !== confirmPassword) { setError("Passwords do not match."); return; }
    }
    setLoading(true);
    try {
      const endpoint = mode === "login" ? `${API_BASE}/api/auth/login` : `${API_BASE}/api/auth/register`;
      const body = mode === "login" ? { email, password } : { name, email, password };
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(body) });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      if (mode === "register") { setSuccess("Account created! You can now sign in."); setMode("login"); setPassword(""); setConfirmPassword(""); }
      else login(data.user);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  const strength = (() => {
    if (!password || mode === "login") return null;
    let s = 0;
    if (password.length >= 8) s++; if (password.length >= 12) s++;
    if (/[A-Z]/.test(password)) s++; if (/[0-9]/.test(password)) s++;
    if (/[^A-Za-z0-9]/.test(password)) s++;
    if (s <= 1) return { label: "Weak", color: "#f87171", pct: "20%" };
    if (s <= 2) return { label: "Fair", color: "#fb923c", pct: "45%" };
    if (s <= 3) return { label: "Good", color: "#facc15", pct: "70%" };
    return { label: "Strong", color: "#4ade80", pct: "100%" };
  })();

  return (
    <>
      {/* Styles loaded from styles/pages/login.css */}

      <div className={`lp-root${mounted?" on":""}`}>

        {/* LEFT */}
        <div className="lp-left">
          <div className="lp-grid"/>
          <div className="lp-orb lp-orb-1"/><div className="lp-orb lp-orb-2"/><div className="lp-orb lp-orb-3"/>
          <div className="lp-brand flex-between">
            <AppLogo size={36} variant="full" color="#f1f5f9" />
            <a href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener noreferrer" style={{fontSize:"0.78rem",color:"#64748b",textDecoration:"none",display:"flex",alignItems:"center",gap:5,transition:"color 0.15s"}} onMouseEnter={e=>{e.currentTarget.style.color="#a5b4fc"}} onMouseLeave={e=>{e.currentTarget.style.color="#64748b"}}>
              Docs
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            </a>
          </div>

          <div className="lp-hero">
            <div className="lp-eyebrow">
              <div className="lp-eyebrow-dot"/>
              <span>Autonomous QA Platform</span>
            </div>
            <h1 className="lp-headline">Ship faster.<br/>Break <span className="lp-accent">nothing.</span></h1>
            <p className="lp-subline">Sentri writes, runs, and heals your test suite — so your team can focus on building, not debugging.</p>
            <div className="lp-features">
              {FEATURES.map((f,i) => (
                <div className="lp-feature" key={i}>
                  <div className="lp-ficon">{f.icon}</div>
                  <div><p className="lp-ftitle">{f.title}</p><p className="lp-fdesc">{f.desc}</p></div>
                </div>
              ))}
            </div>
          </div>

          <div className="lp-testi"
            onMouseEnter={() => setTestiPaused(true)}
            onMouseLeave={() => setTestiPaused(false)}
            role="region"
            aria-label="Testimonials"
            aria-live="polite"
          >
            <p className="lp-tquote">"{TESTIMONIALS[tIdx].quote}"</p>
            <div className="lp-tauthor">
              <div className="lp-tavatar">{TESTIMONIALS[tIdx].name.charAt(0)}</div>
              <div><div className="lp-tname">{TESTIMONIALS[tIdx].name}</div><div className="lp-trole">{TESTIMONIALS[tIdx].role}</div></div>
            </div>
            <div className="lp-tdots">{TESTIMONIALS.map((_,i)=><div key={i} className={`lp-tdot${i===tIdx?" on":""}`}/>)}</div>
          </div>
        </div>

        {/* RIGHT */}
        <div className="lp-right">
          <div className="lp-fw">
            <div className="lp-fh">
              <h2 className="lp-ftit">{mode==="login"?"Welcome back":"Create account"}</h2>
              <p className="lp-fsub">{mode==="login"?"Sign in to continue to Sentri":"Start your free workspace today"}</p>
            </div>

            <div className="lp-oauth">
              <button className="lp-ob" onClick={handleGitHubLogin} disabled={!!loading||!!oauthLoading} aria-label="GitHub">
                {oauthLoading==="github"?<Spinner/>:<GitHubIcon/>} GitHub
              </button>
              <button className="lp-ob" onClick={handleGoogleLogin} disabled={!!loading||!!oauthLoading} aria-label="Google">
                {oauthLoading==="google"?<Spinner/>:<GoogleIcon/>} Google
              </button>
            </div>

            <div className="lp-div"><div className="lp-dline"/><span>or with email</span><div className="lp-dline"/></div>

            {error && (
              <div className="lp-alert lp-aerr" role="alert">
                <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" style={{flexShrink:0,marginTop:1}}><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd"/></svg>
                {error}
              </div>
            )}
            {success && (
              <div className="lp-alert lp-aok" role="status">
                <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" style={{flexShrink:0,marginTop:1}}><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd"/></svg>
                {success}
              </div>
            )}

            <form onSubmit={handleSubmit} noValidate>
              {mode==="register" && (
                <div className="lp-field fe">
                  <div className="lp-lrow"><label className="lp-lbl" htmlFor="reg-name">Full name</label></div>
                  <input id="reg-name" type="text" className="lp-in" placeholder="Ada Lovelace" value={name} onChange={e=>setName(e.target.value)} autoComplete="name" required disabled={loading}/>
                </div>
              )}
              <div className="lp-field">
                <div className="lp-lrow"><label className="lp-lbl" htmlFor="login-email">Email address</label></div>
                <input id="login-email" type="email" className="lp-in" placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" required disabled={loading}/>
              </div>
              <div className="lp-field">
                <div className="lp-lrow">
                  <label className="lp-lbl" htmlFor="login-pw">Password</label>
                  {mode==="login" && <Link to="/forgot-password" className="lp-forgot">Forgot password?</Link>}
                </div>
                <div className="lp-iw">
                  <input id="login-pw" type={showPassword?"text":"password"} className={`lp-in pi`} placeholder={mode==="register"?"Min. 8 characters":"••••••••"} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} required disabled={loading} minLength={mode==="register"?8:undefined}/>
                  <button type="button" className="lp-eye" onClick={()=>setShowPassword(v=>!v)} aria-label={showPassword?"Hide password":"Show password"}>
                    {showPassword
                      ? <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/></svg>
                      : <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/><path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                    }
                  </button>
                </div>
                {strength && (
                  <div className="lp-str">
                    <div className="lp-strtrack"><div className="lp-strfill" style={{width:strength.pct,background:strength.color}}/></div>
                    <span className="lp-strlbl" style={{color:strength.color}}>{strength.label}</span>
                  </div>
                )}
              </div>
              {mode==="register" && (
                <div className="lp-field fe">
                  <div className="lp-lrow"><label className="lp-lbl" htmlFor="reg-confirm-pw">Confirm password</label></div>
                  <input id="reg-confirm-pw" type={showPassword?"text":"password"} className="lp-in" placeholder="Re-enter your password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} autoComplete="new-password" required disabled={loading}/>
                  {confirmPassword && password !== confirmPassword && (
                    <div style={{fontSize:"0.75rem",color:"#f87171",marginTop:6}}>Passwords do not match.</div>
                  )}
                </div>
              )}

              <button type="submit" className="lp-sub" disabled={loading||!!oauthLoading||(mode==="register"&&password!==confirmPassword)}>
                {loading && <Spinner/>}
                {loading?(mode==="login"?"Signing in…":"Creating account…"):(mode==="login"?"Sign in to Sentri":"Create account")}
              </button>
            </form>

            <p className="lp-sw">
              {mode==="login"
                ? (<>Don't have an account?{" "}<button className="lp-swb" onClick={()=>{setMode("register");setError("");setSuccess("");setPassword("");setConfirmPassword("");}}>Create account</button></>)
                : (<>Already have an account?{" "}<button className="lp-swb" onClick={()=>{setMode("login");setError("");setSuccess("");setPassword("");setConfirmPassword("");}}>Sign in</button></>)
              }
            </p>
            <p className="lp-tos">By continuing you agree to our <a href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</p>
            <p className="lp-tos" style={{marginTop:8}}><a href={`${import.meta.env.BASE_URL}docs/`} target="_blank" rel="noopener noreferrer">Documentation</a></p>
          </div>
        </div>
      </div>
    </>
  );
}
