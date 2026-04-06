import React, { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import AppLogo from "../components/AppLogo.jsx";
import { API_BASE, parseJsonResponse } from "../utils/api.js";

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
    if (err) { setError(decodeURIComponent(err)); window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`); return; }
    if (code && provider && ["github", "google"].includes(provider)) handleOAuthCallback(provider, code);
  }, []);

  useEffect(() => { if (user) navigate(from, { replace: true }); }, [user]);
  useEffect(() => { const t = setInterval(() => setTIdx(i => (i+1) % TESTIMONIALS.length), 4000); return () => clearInterval(t); }, []);

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
      const res = await fetch(`${API_BASE}/api/auth/${provider}/callback?code=${code}`);
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "OAuth sign-in failed");
      await login(data.token, data.user);
      window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`);
    } catch (e) { setError(e.message); setOauthLoading(null); window.history.replaceState({}, "", `${import.meta.env.BASE_URL}login`); }
  }

  function handleGitHubLogin() {
    if (!GITHUB_CLIENT_ID) { setError("GitHub OAuth not configured. Add VITE_GITHUB_CLIENT_ID to .env"); return; }
    const state = crypto.randomUUID(); sessionStorage.setItem("oauth_state", state);
    const ru = encodeURIComponent(`${window.location.origin}/login?provider=github`);
    window.location.href = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${ru}&scope=user:email&state=${state}`;
  }

  function handleGoogleLogin() {
    if (!GOOGLE_CLIENT_ID) { setError("Google OAuth not configured. Add VITE_GOOGLE_CLIENT_ID to .env"); return; }
    const state = crypto.randomUUID(); sessionStorage.setItem("oauth_state", state);
    const ru = encodeURIComponent(`${window.location.origin}/login?provider=google`);
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
      const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await parseJsonResponse(res);
      if (!res.ok) throw new Error(data.error || "Something went wrong");
      if (mode === "register") { setSuccess("Account created! You can now sign in."); setMode("login"); setPassword(""); setConfirmPassword(""); }
      else await login(data.token, data.user);
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
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;1,9..40,300&display=swap');
        @keyframes spinAnim{to{transform:rotate(360deg)}}
        @keyframes slideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
        @keyframes slideDown{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:none}}
        @keyframes orbFloat{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-20px) scale(1.04)}}
        @keyframes gridShift{from{background-position:0 0}to{background-position:48px 48px}}
        @keyframes dotPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.8)}}
        .lp-root{display:flex;min-height:100vh;background:#060810;font-family:'DM Sans',sans-serif;opacity:0;transition:opacity 0.5s ease}
        .lp-root.on{opacity:1}
        .lp-left{flex:1;display:flex;flex-direction:column;justify-content:space-between;padding:48px 56px;position:relative;overflow:hidden;background:#060810}
        .lp-left::before{content:'';position:absolute;inset:0;background:radial-gradient(ellipse 70% 60% at 20% 10%,rgba(99,102,241,0.18) 0%,transparent 60%),radial-gradient(ellipse 50% 50% at 80% 80%,rgba(139,92,246,0.12) 0%,transparent 55%);pointer-events:none}
        .lp-grid{position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(99,102,241,0.07) 1px,transparent 1px),linear-gradient(90deg,rgba(99,102,241,0.07) 1px,transparent 1px);background-size:48px 48px;mask-image:radial-gradient(ellipse 80% 90% at 30% 40%,black 0%,transparent 75%);animation:gridShift 20s linear infinite}
        .lp-orb{position:absolute;border-radius:50%;filter:blur(60px);pointer-events:none;animation:orbFloat 8s ease-in-out infinite}
        .lp-orb-1{width:300px;height:300px;top:-60px;left:-60px;background:rgba(99,102,241,0.15);animation-delay:0s}
        .lp-orb-2{width:200px;height:200px;bottom:80px;right:40px;background:rgba(139,92,246,0.12);animation-delay:3s}
        .lp-orb-3{width:150px;height:150px;top:50%;left:60%;background:rgba(59,130,246,0.1);animation-delay:5s}
        .lp-brand{position:relative;z-index:1;animation:slideDown 0.6s cubic-bezier(0.16,1,0.3,1) both}
        .lp-hero{position:relative;z-index:1}
        .lp-eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.3);border-radius:999px;padding:4px 14px;margin-bottom:28px;animation:slideUp 0.7s cubic-bezier(0.16,1,0.3,1) 0.1s both}
        .lp-eyebrow-dot{width:6px;height:6px;border-radius:50%;background:#6366f1;animation:dotPulse 2s ease infinite}
        .lp-eyebrow span{font-size:0.72rem;font-weight:500;color:#a5b4fc;letter-spacing:0.5px;text-transform:uppercase}
        .lp-headline{font-family:'Syne',sans-serif;font-size:clamp(2rem,3vw,2.75rem);font-weight:800;line-height:1.1;letter-spacing:-1.5px;color:#fff;margin:0 0 20px;animation:slideUp 0.7s cubic-bezier(0.16,1,0.3,1) 0.2s both}
        .lp-accent{background:linear-gradient(135deg,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
        .lp-subline{font-size:1rem;line-height:1.65;color:#94a3b8;max-width:400px;margin:0 0 40px;font-weight:300;animation:slideUp 0.7s cubic-bezier(0.16,1,0.3,1) 0.3s both}
        .lp-features{display:flex;flex-direction:column;gap:14px;animation:slideUp 0.7s cubic-bezier(0.16,1,0.3,1) 0.4s both}
        .lp-feature{display:flex;align-items:flex-start;gap:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:16px 18px;transition:background 0.2s,border-color 0.2s,transform 0.2s;cursor:default}
        .lp-feature:hover{background:rgba(99,102,241,0.08);border-color:rgba(99,102,241,0.25);transform:translateX(4px)}
        .lp-ficon{width:36px;height:36px;border-radius:10px;flex-shrink:0;background:rgba(99,102,241,0.15);display:flex;align-items:center;justify-content:center;font-size:1rem}
        .lp-ftitle{font-size:0.875rem;font-weight:500;color:#e2e8f0;margin:0 0 3px}
        .lp-fdesc{font-size:0.78rem;color:#64748b;line-height:1.4;margin:0}
        .lp-testi{position:relative;z-index:1;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:20px 24px;animation:slideUp 0.7s cubic-bezier(0.16,1,0.3,1) 0.5s both}
        .lp-tquote{font-size:0.9rem;color:#cbd5e1;line-height:1.6;margin:0 0 14px;font-style:italic;font-weight:300}
        .lp-tauthor{display:flex;align-items:center;gap:10px}
        .lp-tavatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;color:#fff;flex-shrink:0}
        .lp-tname{font-size:0.8rem;font-weight:500;color:#94a3b8}
        .lp-trole{font-size:0.72rem;color:#475569}
        .lp-tdots{display:flex;gap:5px;margin-top:16px}
        .lp-tdot{width:20px;height:3px;border-radius:2px;background:rgba(255,255,255,0.1);transition:background 0.3s,width 0.3s}
        .lp-tdot.on{background:#6366f1;width:28px}
        @media(max-width:900px){.lp-left{display:none}}
        .lp-right{width:480px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:#0d1117;border-left:1px solid rgba(255,255,255,0.06);padding:48px 40px}
        @media(max-width:900px){.lp-right{width:100%;border-left:none}}
        .lp-fw{width:100%;max-width:360px;animation:slideUp 0.6s cubic-bezier(0.16,1,0.3,1) 0.1s both}
        .lp-fh{margin-bottom:28px}
        .lp-ftit{font-family:'Syne',sans-serif;font-size:1.6rem;font-weight:700;color:#f1f5f9;margin:0 0 6px;letter-spacing:-0.5px}
        .lp-fsub{font-size:0.875rem;color:#64748b;margin:0}
        .lp-oauth{display:flex;gap:10px;margin-bottom:20px}
        .lp-ob{flex:1;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 8px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#cbd5e1;font-size:0.82rem;font-weight:500;cursor:pointer;transition:all 0.2s;font-family:'DM Sans',sans-serif}
        .lp-ob:hover:not(:disabled){background:rgba(255,255,255,0.08);border-color:rgba(255,255,255,0.18);color:#f1f5f9;transform:translateY(-1px)}
        .lp-ob:active:not(:disabled){transform:translateY(0)}
        .lp-ob:disabled{opacity:0.45;cursor:not-allowed}
        .lp-div{display:flex;align-items:center;gap:12px;margin-bottom:20px}
        .lp-dline{flex:1;height:1px;background:rgba(255,255,255,0.07)}
        .lp-div span{font-size:0.72rem;color:#334155;white-space:nowrap;letter-spacing:0.3px}
        .lp-field{margin-bottom:16px}
        .lp-lrow{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
        .lp-lbl{font-size:0.78rem;font-weight:500;color:#64748b;letter-spacing:0.3px}
        .lp-forgot{font-size:0.75rem;color:#6366f1;text-decoration:none;font-weight:500}
        .lp-forgot:hover{color:#818cf8}
        .lp-iw{position:relative}
        .lp-in{width:100%;padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);color:#f1f5f9;font-size:0.875rem;font-family:'DM Sans',sans-serif;outline:none;transition:border-color 0.2s,background 0.2s,box-shadow 0.2s;box-sizing:border-box}
        .lp-in::placeholder{color:#334155}
        .lp-in:focus{border-color:#6366f1;background:rgba(99,102,241,0.06);box-shadow:0 0 0 3px rgba(99,102,241,0.15)}
        .lp-in:disabled{opacity:0.5;cursor:not-allowed}
        .lp-in.pi{padding-right:42px}
        .lp-eye{position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:#334155;display:flex;align-items:center;padding:2px;transition:color 0.15s}
        .lp-eye:hover{color:#94a3b8}
        .lp-str{display:flex;align-items:center;gap:10px;margin-top:8px}
        .lp-strtrack{flex:1;height:3px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden}
        .lp-strfill{height:100%;border-radius:2px;transition:width 0.4s,background 0.4s}
        .lp-strlbl{font-size:0.7rem;font-weight:600;min-width:38px;text-align:right}
        .lp-alert{display:flex;align-items:flex-start;gap:9px;border-radius:10px;padding:11px 13px;font-size:0.82rem;line-height:1.5;margin-bottom:16px}
        .lp-aerr{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#fca5a5}
        .lp-aok{background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.2);color:#86efac}
        .lp-sub{width:100%;padding:11px 16px;border-radius:10px;border:none;background:linear-gradient(135deg,#6366f1,#7c3aed);color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;font-family:'DM Sans',sans-serif;transition:opacity 0.2s,transform 0.15s,box-shadow 0.2s;box-shadow:0 4px 20px rgba(99,102,241,0.35);margin-bottom:6px;margin-top:4px}
        .lp-sub:hover:not(:disabled){opacity:0.92;transform:translateY(-1px);box-shadow:0 6px 28px rgba(99,102,241,0.45)}
        .lp-sub:active:not(:disabled){transform:translateY(0)}
        .lp-sub:disabled{opacity:0.5;cursor:not-allowed}
        .lp-sw{text-align:center;font-size:0.82rem;color:#475569;margin-top:18px}
        .lp-swb{background:none;border:none;color:#818cf8;font-weight:600;cursor:pointer;font-size:0.82rem;font-family:'DM Sans',sans-serif;padding:0}
        .lp-swb:hover{color:#a5b4fc}
        .lp-tos{text-align:center;font-size:0.7rem;color:#1e293b;margin-top:14px;line-height:1.5}
        .lp-tos a{color:#334155;text-decoration:underline}
        .lp-tos a:hover{color:#64748b}
        .fe{animation:slideUp 0.3s ease both}
      `}</style>

      <div className={`lp-root${mounted?" on":""}`}>

        {/* LEFT */}
        <div className="lp-left">
          <div className="lp-grid"/>
          <div className="lp-orb lp-orb-1"/><div className="lp-orb lp-orb-2"/><div className="lp-orb lp-orb-3"/>
          <div className="lp-brand">
            <AppLogo size={36} variant="full" color="#f1f5f9" />
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

          <div className="lp-testi">
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
                <input id="login-email" type="email" className="lp-in" placeholder="you@company.com" value={email} onChange={e=>setEmail(e.target.value)} autoComplete={mode==="login"?"username":"email"} required disabled={loading}/>
              </div>
              <div className="lp-field">
                <div className="lp-lrow">
                  <label className="lp-lbl" htmlFor="login-pw">Password</label>
                  {mode==="login" && <Link to="/forgot-password" className="lp-forgot">Forgot password?</Link>}
                </div>
                <div className="lp-iw">
                  <input id="login-pw" type={showPassword?"text":"password"} className={`lp-in pi`} placeholder={mode==="register"?"Min. 8 characters":"••••••••"} value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} required disabled={loading} minLength={mode==="register"?8:undefined}/>
                  <button type="button" className="lp-eye" onClick={()=>setShowPassword(v=>!v)} tabIndex={-1} aria-label={showPassword?"Hide password":"Show password"}>
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
            <p className="lp-tos">By continuing you agree to our <a href="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</p>
          </div>
        </div>
      </div>
    </>
  );
}
