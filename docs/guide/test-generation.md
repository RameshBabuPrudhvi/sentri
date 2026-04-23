# Test Generation

## The 8-Stage Pipeline

Each page snapshot goes through a structured pipeline — not a single prompt:

1. **Crawl** — visit pages, capture DOM snapshots
2. **Filter** — remove noise from interactive elements
3. **Classify** — identify page intent (AUTH, CHECKOUT, SEARCH, CRUD, NAVIGATION, CONTENT)
4. **Plan** — two-phase PLAN → GENERATE split avoids token truncation
5. **Generate** — writes focused Playwright tests per page intent
6. **Deduplicate** — removes redundant tests across the batch
7. **Enhance** — strengthens assertions for better coverage
8. **Validate** — rejects malformed or placeholder output, including raw-CSS visibility/text assertions (see below)

### Validator — quality gate for assertions

The validator rejects tests that chain `toBeVisible()`, `toContainText(...)`, or `toHaveText(...)` off a raw CSS `page.locator()`:

```js
// ❌ Rejected — bypasses self-healing, breaks on class renames or empty states
await expect(page.locator('.todo-count')).toContainText('0 items left');

// ✅ Accepted — semantic locator, resilient
await expect(page.getByText('0 items left')).toBeVisible();

// ✅ Accepted — self-healing waterfall
await safeExpect(page, expect, '0 items left');
```

Count, state, attribute, class, and CSS matchers on `page.locator()` are intentionally **allowed** — `toHaveCount`, `toBeHidden`, `toHaveAttribute`, `toHaveClass`, `toHaveCSS`. Those don't have a safe-helper equivalent and the generation prompt explicitly recommends `page.locator()` for them.

## Generate from Description

Skip crawling entirely — open **Create Tests**, write a plain-English scenario, and Sentri generates the steps and Playwright code. Watch AI output arrive token by token via LLM streaming.

## Test Dials

Configure generation behaviour before hitting Generate:

- **Strategy:** happy path, edge cases, comprehensive, exploratory, regression
- **Workflow:** E2E, component isolation, multi-role persona, first-time user
- **Quality checks:** accessibility, security, performance, data integrity
- **Output format:** verbose, concise, Gherkin
- **Test count and language**

Presets like "Smoke Test" and "BDD Blueprint" auto-fill multiple dials. Config is validated server-side to prevent prompt injection.
