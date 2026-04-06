# GitHub Pages + Render

Deploy the frontend to GitHub Pages (free static hosting) and the backend to Render (free tier available).

## Frontend → GitHub Pages

### Build

```bash
cd frontend
GITHUB_PAGES=true VITE_API_URL=https://your-app.onrender.com npm run build
```

This sets:
- `base: "/sentri/"` — so assets load from the correct path
- `VITE_API_URL` — baked into the JS bundle, points API calls to Render

### Deploy

Push the `frontend/dist/` output to the `gh-pages` branch, or use a GitHub Action.

### SPA Routing

The repo includes `frontend/public/404.html` and a restore script in `frontend/index.html` that handle client-side routing on GitHub Pages. Without these, refreshing on `/sentri/dashboard` would show a 404.

## Backend → Render

### Setup

1. Create a new **Web Service** on [render.com](https://render.com)
2. Connect your GitHub repo
3. Set:
   - **Root directory:** `backend`
   - **Build command:** `npm install && npx playwright install chromium`
   - **Start command:** `npm start`

### Environment Variables

Set these in Render → Environment:

```
NODE_ENV=production
JWT_SECRET=<generate with: openssl rand -base64 48>
PORT=3001
```

Plus your AI provider key(s):

```
ANTHROPIC_API_KEY=sk-ant-...
```

### OAuth (Optional)

If using GitHub/Google sign-in:

```
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-username.github.io/sentri/login?provider=google
```

::: warning Render Free Tier
Free Render instances spin down after inactivity. The first request after sleep takes ~30 seconds. Consider a paid plan for production.
:::
