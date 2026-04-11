# Changelog

## Unreleased

### Added
- **Cookie-based auth (S1-02)** — JWT moved from `localStorage` to HttpOnly; Secure; SameSite=Strict cookies (`access_token`). Eliminates XSS-based token theft. Companion `token_exp` cookie for frontend expiry UX. CSRF double-submit cookie (`_csrf`) protection on all mutating endpoints
- **Session refresh** — `POST /api/auth/refresh` endpoint; frontend proactively refreshes 5 minutes before expiry
- **Responsive layout** — sidebar collapses to icon-rail at 768px, off-screen drawer with hamburger at 480px. Dashboard, Tests, and stat grids adapt to mobile viewports
- **Command Palette** — `Cmd/Ctrl+K` now opens a two-mode command palette instead of jumping straight to AI chat. Mode 1 (default): fuzzy-search over navigation and actions with zero LLM cost. Mode 2 (fallback): type a natural-language question to open the AI chat panel. Prefix `>` to force command mode, `?` to force AI mode.
- Confirm password field on registration form
- Email validation on frontend before submission
- OAuth CSRF protection (state parameter validation)
- `parseJsonResponse` helper for user-friendly error when backend is unreachable
- GitHub Pages SPA routing (`404.html` + restore script)
- VitePress documentation site

### Fixed
- Docker build context in `cd.yml` — was `./backend`, now `context: .` with explicit `file:`
- JWT secret no longer hardcoded — random per-process in dev, throws in production
- `verifyJwt` crash on malformed tokens (buffer length mismatch)
- OAuth provider param whitelisted to prevent path traversal
- Consistent "Sign in" / "Sign out" terminology (was mixing "login" / "sign in")
- Password fields cleared when switching between sign-in and registration modes

### Security
- **JWT in HttpOnly cookies** — token never exposed to JavaScript, immune to XSS exfiltration
- **CSRF double-submit cookie** — `_csrf` cookie + `X-CSRF-Token` header validation on all POST/PATCH/PUT/DELETE
- OAuth state parameter validated before code exchange
- JWT fallback secret replaced with random per-process generation
- `verifyJwt` wrapped in try/catch with explicit buffer length check
- Backend auth docstring corrected (scrypt, not bcrypt)

### Removed
- `CodeEditorModal.jsx` — deprecated component with no imports, deleted
