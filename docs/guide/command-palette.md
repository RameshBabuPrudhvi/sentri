# Command Palette

Press **⌘K** (Mac) or **Ctrl+K** (Windows/Linux) to open the command palette — the fastest way to navigate Sentri and ask the AI assistant.

## Two Modes

The palette operates in two modes that you can switch between with a single-character prefix:

| Mode | Prefix | What it does | Cost |
|---|---|---|---|
| **Command** | `>` | Fuzzy-search navigation links and actions | Free — pure frontend |
| **AI Chat** | `?` | Send a natural-language question to Sentri AI | Same as AI Chat |
| **Unified** | *(none)* | Shows command results first, with an AI fallback row at the bottom | Free until you select the AI row |

### Examples

| You type | What happens |
|---|---|
| `dash` | Matches **Go to Dashboard** — press Enter to navigate |
| `>settings` | Force command mode — matches **Go to Settings** |
| `?why are my tests flaky` | Force AI mode — press Enter to open AI Chat with your question |
| `debug login` | Unified mode — shows matching commands **and** an "Ask Sentri AI" row at the bottom |

## Available Commands

### Navigation

| Command | Keywords | Route |
|---|---|---|
| Go to Dashboard | home, overview, stats | `/dashboard` |
| Go to Projects | applications, apps | `/projects` |
| Go to Tests | test, cases, suite | `/tests` |
| Go to Reports | analytics, charts | `/reports` |
| Go to Runs | executions, history | `/runs` |
| Go to System | context, info | `/context` |
| Go to Settings | config, api keys, provider | `/settings` |

### Actions

| Command | Keywords | Route |
|---|---|---|
| Create New Project | add, application | `/projects/new` |
| Generate Test | create, ai, generate | `/tests` |

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Open the palette |
| `↑` `↓` | Navigate results |
| `Enter` | Execute selected item |
| `Esc` | Close the palette |

## Fuzzy Matching

The search uses a character-by-character fuzzy matcher that:

- Matches characters in order (not necessarily adjacent)
- Rewards prefix matches and exact substrings
- Penalises gaps between matched characters
- Highlights matched ranges in the results

Typing `gts` matches **G**o **t**o **S**ettings — the matched characters are highlighted in the result list.

## AI Fallback

When you type a query that doesn't look like a command (or when no commands match well enough), the palette shows an **"Ask Sentri AI"** row at the bottom of the results. Selecting it closes the palette and opens the AI Chat panel with your query pre-filled.

This means you never need to decide upfront whether you want to navigate or ask a question — just type and pick the best result.
