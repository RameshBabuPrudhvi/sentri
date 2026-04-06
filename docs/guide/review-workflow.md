# Review Workflow

Every generated test starts as **Draft**. Nothing executes until a human approves it.

## Test Lifecycle

```
Created (crawl or manual)
        │
        ▼
    [ Draft ]  ← review required
        │
   ┌────┴────┐
   ▼         ▼
[Approved] [Rejected]
   │
   ▼
[Regression Suite]  ← included in Run Regression
```

## Review Actions

| Action | What it does |
|---|---|
| **Approve** | Promotes Draft → Approved. Test is included in regression runs |
| **Reject** | Marks as rejected. Test is excluded from runs |
| **Restore** | Returns any test back to Draft for re-review |

## Bulk Actions

Select multiple tests and apply Approve All, Reject All, Restore All, or Delete All in one click.

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `a` | Approve selected test |
| `r` | Reject selected test |
| `/` | Focus search |
| `Esc` | Clear selection / search |

## Inline Editing

Edit any test's name, steps, or description. On save, Sentri regenerates Playwright code from your updated steps and shows a **Myers line-by-line diff** of what changed.
