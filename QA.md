# Manual QA Guide — Sentri

## 🎯 Purpose
This document is for **manual testers** to validate all functional flows in Sentri before release.

This is NOT a smoke test.  
Test everything like a real user.

---

## 🧪 How to Test

- Use a real browser (Chrome recommended)
- Do NOT use APIs directly unless needed for debugging
- Test like an end user:
  - Click flows
  - Navigate pages
  - Refresh browser
  - Use back/forward buttons

---

## 👤 Test Accounts

Create and use:
- User A (Admin)
- User B (Secondary user)

👉 Use separate browsers or incognito for User B

---

## ⚙️ Setup

1. Start backend
2. Start frontend (`npm run dev`)
3. Open app in browser
4. Confirm `/health` is working

---

## ✅ What to Test

### 🔐 Authentication
- Register new user
- Verify email
- Login / Logout
- Wrong password error
- Forgot password → reset flow
- Session expiry

---

### 👥 Workspaces
- Create workspace
- Switch workspace
- Invite user
- Change roles

---

### 📁 Projects
- Create, edit, delete
- Restore from recycle bin

---

### 🧪 Tests Page
- Crawl URL
- Generate tests
- Approve / reject
- Edit test
- Export tests

---

### 🎥 Recorder
- Record actions
- Save test

⚠️ Watch for empty steps bug

---

### ▶️ Runs
- Run single test
- Run regression
- Stop execution

---

### 🖼️ Visual Testing
- Baseline creation
- Detect changes
- Accept baseline

---

### 📊 Dashboard
- Charts load
- Data correctness

---

### 🤖 AI Chat
- Ask about tests/runs/projects
- Validate responses

---

### ⚙️ Settings
- Update configs
- Save changes

---

### 🔔 Notifications
- Trigger failure
- Verify alerts

---

### 🔒 Security
- Unauthorized access checks
- URL manipulation

---

## 📱 Cross Checks
- Mobile view
- Dark mode
- Refresh mid-flow
- Browser navigation

---

## 🚨 Known Issues
- Deploy pages failing
- Image push failures
- Recorder issues
- Visual diff bugs

---

## 🐞 Bug Reporting

Include:
- Steps
- Expected vs actual
- Screenshot

---

## 📋 Checklist

| Area | Status | Notes |
|------|--------|------|
| Auth | ⬜ | |
| Workspaces | ⬜ | |
| Projects | ⬜ | |
| Tests | ⬜ | |
| Recorder | ⬜ | |
| Runs | ⬜ | |
| Visual | ⬜ | |
| Dashboard | ⬜ | |
| Chat | ⬜ | |
| Settings | ⬜ | |

---

## ✅ Done When
- All flows tested
- Bugs documented

---

## ❗ Rule
Do NOT stop after first bug
