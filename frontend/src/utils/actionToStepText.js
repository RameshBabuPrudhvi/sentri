/**
 * @module utils/actionToStepText
 * @description Client-side mirror of `backend/src/runner/recorder.js#recordedActionToStepText`.
 *
 * Renders a {@link RecordedAction} as a short, human-readable sentence so the
 * recorder sidebar shows the same style of prose as the AI-generated and
 * manually-created test steps displayed on the Test Detail page
 * ("Click the 'Sign in' button" vs the raw "click → role=button[name='Sign in']").
 *
 * Keep this in sync with `recordedActionToStepText` in recorder.js — both
 * functions operate on the same action shape and must produce consistent
 * prose. If you add a new `kind` to the backend, add it here too.
 */

/**
 * Extract a friendly element name from an action for use in step prose.
 * Prefers the captured `label` field (aria-label / inner text / placeholder),
 * then falls back to parsing a `role=foo[name="bar"]` selector string.
 *
 * @param {{ label?: string, selector?: string }} action
 * @param {string} [noun] - Optional element noun appended after the label
 *   (e.g. "button", "field"). Pass "" or omit to skip the noun.
 * @returns {string} E.g. ` the 'Search' button`, ` 'Search'`, or `""`.
 */
function friendlyTarget(action, noun = "") {
  const raw = (action.label || "").trim();
  if (raw) {
    return noun ? ` the '${raw}' ${noun}` : ` '${raw}'`;
  }
  // Legacy actions captured before the `label` field existed only carry the
  // selector. Try to recover a name from `role=foo[name="bar"]` so older
  // recordings still render readable steps in the sidebar.
  const sel = action.selector || "";
  const m = sel.match(/role=([a-z]+)\[name="([^"]+)"\]/i);
  if (m) {
    const name = m[2];
    return noun ? ` the '${name}' ${noun}` : ` '${name}'`;
  }
  return "";
}

/**
 * Trim a URL for display. Strips query-string and fragment so the step
 * doesn't push the sidebar sideways on pages with long tracking params.
 *
 * @param {string} u
 * @returns {string}
 */
function shortUrl(u) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const base = `${url.origin}${url.pathname}`;
    return base.length > 80 ? base.slice(0, 77) + "…" : base;
  } catch {
    return String(u).slice(0, 80);
  }
}

/**
 * Convert a single recorded action into a short, human-readable step
 * sentence suitable for display in the recorder sidebar and the persisted
 * `steps[]` array.
 *
 * @param {{ kind: string, selector?: string, label?: string, value?: string, url?: string, key?: string, target?: string }} action
 * @returns {string}
 */
export function actionToStepText(action) {
  const truncVal = (v, n = 40) => String(v ?? "").slice(0, n);

  switch (action.kind) {
    case "goto":
      return `Navigate to ${shortUrl(action.url)}`;

    case "click":
      return `Click${friendlyTarget(action, "button")}`;

    case "dblclick":
      return `Double-click${friendlyTarget(action)}`;

    case "rightClick":
      return `Open context menu on${friendlyTarget(action)}`;

    case "hover":
      return `Hover over${friendlyTarget(action)}`;

    case "fill":
      return `Fill in${friendlyTarget(action, "field")} with '${truncVal(action.value)}'`;

    case "press":
      return `Press ${action.key || ""}`.trim();

    case "select": {
      const inClause = friendlyTarget(action, "dropdown");
      return `Select '${truncVal(action.value)}'${inClause ? ` in${inClause}` : ""}`;
    }

    case "check":
      return `Check${friendlyTarget(action, "checkbox")}`;

    case "uncheck":
      return `Uncheck${friendlyTarget(action, "checkbox")}`;

    case "upload": {
      const forClause = friendlyTarget(action, "field");
      return `Upload '${truncVal(action.value)}'${forClause ? ` for${forClause}` : ""}`;
    }

    case "drag":
      return `Drag${friendlyTarget(action)}`;

    case "assertVisible":
      return friendlyTarget(action)
        ? `Verify${friendlyTarget(action)} is visible`
        : "Verify element is visible";

    case "assertText":
      return friendlyTarget(action)
        ? `Verify${friendlyTarget(action)} shows '${truncVal(action.value)}'`
        : `Verify page shows '${truncVal(action.value)}'`;

    case "assertValue": {
      const t = friendlyTarget(action, "field");
      return t
        ? `Verify${t} has value '${truncVal(action.value)}'`
        : `Verify field value is '${truncVal(action.value)}'`;
    }

    case "assertUrl":
      return `Verify URL contains '${truncVal(action.value, 60)}'`;

    default:
      return `${action.kind || "action"}${friendlyTarget(action)}`;
  }
}

/**
 * Return a terse raw-locator string for the brief "resolving" state shown
 * before the human-readable label is applied. Mirrors what the recorder
 * sidebar used to display: `click → role=button[name="Sign in"]`. Kept
 * intentionally short so the yellow-highlight flash is legible.
 *
 * @param {{ kind: string, selector?: string, url?: string, key?: string, value?: string }} action
 * @returns {string}
 */
export function actionRawLocator(action) {
  const sel = action.selector || action.url || action.key || "";
  const short = sel.length > 60 ? sel.slice(0, 57) + "…" : sel;
  return `${action.kind}${short ? ` → ${short}` : ""}`;
}