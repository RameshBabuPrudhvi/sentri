# Rebranding

To rebrand Sentri to your own product name, update the following files.

## Quick Method

Run a case-sensitive find-and-replace across the repo:
1. `Sentri` → `YourName` (capitalized — UI text, titles, docs)
2. `sentri` → `yourname` (lowercase — package names, Docker, file paths, storage keys)

## Files to Update

### Frontend — UI
| File | What |
|---|---|
| `frontend/index.html` | `<title>` |
| `frontend/public/404.html` | `<title>` |
| `frontend/src/components/AppLogo.jsx` | Wordmark text (line 86), aria-labels, SVG gradient IDs |
| `frontend/src/pages/Login.jsx` | Tagline, subtitle, button text, testimonials |
| `frontend/src/context/AuthContext.jsx` | No changes needed — keys are generic (`app_auth_token`, `app_auth_user`) |

### Backend
| File | What |
|---|---|
| `backend/package.json` | `"name"` field |
| `backend/src/index.js` | Startup log message |
| `backend/src/database/sqlite.js` | Database filename `sentri.db` and data directory path |
| `backend/src/routes/auth.js` | User-Agent string for GitHub API |

### Docker / CI
| File | What |
|---|---|
| `docker-compose.yml` | Image names, container names, network name |
| `docker-compose.prod.yml` | Same |
| `.github/workflows/cd.yml` | GHCR image names |
| `.github/workflows/ci.yml` | Docker tag names |

### Docs & Config
| File | What |
|---|---|
| `README.md` | ~40 occurrences |
| `docs/.vitepress/config.mjs` | Site title, nav, footer |
| `docs/` | All `.md` files |
| `frontend/vite.config.js` | GitHub Pages base path `/sentri/` |

### Repository
| Item | Action |
|---|---|
| GitHub repo name | Settings → General → Rename |
| GitHub repo description | Update |

## Visual Identity

The `AppLogo.jsx` component at `frontend/src/components/AppLogo.jsx` renders the brand icon + wordmark everywhere (sidebar, login, dashboard). Change:
- **Line 86** — wordmark text
- **Lines 52–66** — shield SVG path and gradient colors

This single component controls the entire visual brand across the app.

::: tip Storage Keys
The localStorage keys (`app_auth_token`, `app_auth_user`) are already brand-neutral — no changes needed during rebranding.
:::
