# Test Dials

Test Dials let you fine-tune AI test generation without writing prompts.

## Available Dials

| Dial | Options |
|---|---|
| **Strategy** | Happy path, Edge cases, Comprehensive, Exploratory, Regression |
| **Workflow** | E2E, Component isolation, Multi-role persona, First-time user, Interruptions |
| **Quality Checks** | Accessibility, Security, Performance, Data integrity, Error handling, Responsive, i18n, SEO |
| **Output Format** | Verbose, Concise, Gherkin |
| **Test Count** | 1–20 tests per generation |
| **Language** | English, Spanish, French, German, Japanese, Chinese, Portuguese, Hindi |

## Presets

Presets auto-fill multiple dials at once:

| Preset | What it sets |
|---|---|
| **Smoke Test** | Happy path + Concise + 3 tests |
| **BDD Blueprint** | Comprehensive + Gherkin + E2E |
| **Security Scan** | Edge cases + Security + Error handling |
| **Accessibility Audit** | Comprehensive + Accessibility + Responsive |

## How It Works

1. Configure dials in the **Test Dials** tab of the Generate modal
2. Your config is sent to the backend as a structured JSON object
3. The server validates the config (blocks prompt injection) and builds the AI prompt
4. Active dial count shows as a badge on the tab

## Persistence

Dial configuration is saved to `localStorage` and restored on next visit. The active dial count badge updates in real time.
