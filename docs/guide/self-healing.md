# Self-Healing

Sentri's self-healing runtime automatically recovers from broken selectors at test execution time.

## How It Works

When a selector fails, the self-healing layer tries multiple fallback strategies in a waterfall:

```
getByRole('button', { name }) → getByRole('link', { name })
→ getByText(exact) → getByText(partial)
→ locator([aria-label]) → locator([title])
```

When a fallback wins, Sentri **records which strategy index succeeded** for that element. On the next run, it tries the winner first — skipping strategies that previously failed.

## Healing History

The healing history is stored per element, keyed by `<testId>::<action>::<label>`. Over time, tests become more resilient automatically as the system learns the best strategy for each element.

View healing stats on the **Dashboard** (self-healed count, elements tracked) and in the **Healing Timeline** on each test run detail page.

## Failure Classification

After failures, an AI feedback loop classifies each one:

| Category | Description |
|---|---|
| `SELECTOR_ISSUE` | Element not found — selector changed or removed |
| `TIMEOUT` | Element exists but didn't become interactive in time |
| `ASSERTION_FAIL` | Element found but content/state doesn't match expected |
| `NAVIGATION_FAIL` | Page didn't load or redirected unexpectedly |

The highest-priority failing tests are auto-regenerated with context-aware fix instructions.

## Clearing History

To reset the healing history and force the waterfall to start fresh:

- **UI:** Settings → Data Management → Clear Self-Healing History
- **API:** `DELETE /api/data/healing`
