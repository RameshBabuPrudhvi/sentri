/**
 * pageSnapshot.js — Captures a serialised DOM snapshot from a live Playwright page
 *
 * Extracts interactive elements, form structures, semantic sections, headings,
 * and page-level signals (modals, tabs, tables, login forms) so the AI has
 * rich context for test generation.
 *
 * Exports:
 *   takeSnapshot(page) → snapshot object
 */

const CRAWL_NETWORKIDLE_TIMEOUT = parseInt(process.env.CRAWL_NETWORKIDLE_TIMEOUT, 10) || 5000;

export async function takeSnapshot(page) {
  // Wait for SPA content to settle — domcontentloaded fires too early for SPAs.
  // Try networkidle first (best for SPAs), fall back to a generous timeout.
  await page.waitForLoadState("networkidle", { timeout: CRAWL_NETWORKIDLE_TIMEOUT }).catch(() => {});

  return page.evaluate(() => {
    // Compute the effective ARIA role of an element (explicit or implicit)
    function getComputedRole(el) {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && el.getAttribute("href")) return "link";
      if (tag === "input") {
        if (type === "search") return "searchbox";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button") return "button";
        return "textbox";
      }
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      return "";
    }

    // ── Capture form structures with field relationships ──────────────────
    // This gives the AI context about which fields belong to which form,
    // enabling it to generate tests that fill forms correctly rather than
    // guessing field order from a flat element list.
    const formStructures = [];
    document.querySelectorAll("form").forEach((form, idx) => {
      const fields = [];
      form.querySelectorAll("input, select, textarea").forEach(field => {
        if (field.type === "hidden") return;
        const label = field.labels?.[0]?.innerText?.trim()
          || field.getAttribute("aria-label")
          || field.getAttribute("placeholder")
          || field.getAttribute("name")
          || "";
        fields.push({
          tag: field.tagName.toLowerCase(),
          type: field.getAttribute("type") || "",
          label: label.slice(0, 60),
          name: field.getAttribute("name") || "",
          required: field.required || field.getAttribute("aria-required") === "true",
          testId: field.getAttribute("data-testid") || field.getAttribute("data-cy") || "",
        });
      });
      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      formStructures.push({
        id: form.id || `form-${idx}`,
        action: form.action || "",
        method: form.method || "get",
        fields,
        submitText: (submitBtn?.innerText || submitBtn?.value || "").trim().slice(0, 40),
      });
    });

    // ── Capture semantic page sections ────────────────────────────────────
    const sections = [];
    document.querySelectorAll("header, nav, main, aside, footer, [role='banner'], [role='navigation'], [role='main'], [role='complementary'], [role='contentinfo']").forEach(el => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role") || tag;
      const headings = Array.from(el.querySelectorAll("h1, h2, h3")).map(h => h.innerText.trim()).slice(0, 3);
      sections.push({ role, headings });
    });

    // ── Capture interactive elements with richer metadata ─────────────────
    const elements = [];
    document.querySelectorAll(
      "a, button, input, select, textarea, [role='button'], [role='link'], [role='combobox'], [role='searchbox'], [role='tab'], [role='menuitem'], form"
    ).forEach((el) => {
      const text = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || "").trim().slice(0, 80);
      const computedRole = getComputedRole(el);
      const ariaLabel = el.getAttribute("aria-label") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      // Find the closest label for inputs
      const labelText = el.labels?.[0]?.innerText?.trim() || "";
      elements.push({
        tag: el.tagName.toLowerCase(),
        text,
        type: el.getAttribute("type") || "",
        href: el.getAttribute("href") || "",
        id: el.id || "",
        name: el.getAttribute("name") || "",
        role: computedRole,
        ariaLabel,
        placeholder,
        label: labelText.slice(0, 60),
        testId: el.getAttribute("data-testid") || el.getAttribute("data-cy") || "",
        visible: el.offsetParent !== null,
        disabled: el.disabled || el.getAttribute("aria-disabled") === "true",
        required: el.required || el.getAttribute("aria-required") === "true",
        // Which form does this element belong to? Helps AI group interactions.
        formId: el.closest("form")?.id || "",
      });
    });

    // ── Capture heading hierarchy for context ─────────────────────────────
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .map(h => ({ level: parseInt(h.tagName[1]), text: h.innerText.trim().slice(0, 60) }))
      .slice(0, 10);

    return {
      title: document.title,
      url: location.href,
      elements: elements.filter(e => e.visible).slice(0, 100),
      h1: Array.from(document.querySelectorAll("h1")).map(h => h.innerText).join(" | "),
      headings,
      forms: document.querySelectorAll("form").length,
      formStructures,
      sections,
      hasLoginForm: !!document.querySelector("input[type='password']"),
      // Additional page signals for the AI
      hasModals: document.querySelectorAll("[role='dialog'], .modal, [aria-modal='true']").length > 0,
      hasTabs: document.querySelectorAll("[role='tablist'], [role='tab']").length > 0,
      hasTable: document.querySelectorAll("table, [role='grid']").length > 0,
      // Extended component inventory (#52 defect #3)
      hasSidebar: document.querySelectorAll(
        "aside, [role='complementary'], nav.sidebar, .sidebar, [class*='sidebar'], [class*='side-nav'], [class*='drawer']"
      ).length > 0,
      hasDropdown: document.querySelectorAll(
        "[role='listbox'], [role='menu'], .dropdown-menu, [class*='dropdown'], [class*='popover'], [aria-expanded='true']"
      ).length > 0,
      hasToast: document.querySelectorAll(
        "[role='alert'], [role='status'], .toast, [class*='toast'], [class*='notification'], [class*='snackbar']"
      ).length > 0,
      hasAccordion: document.querySelectorAll(
        "[role='region'][aria-labelledby], details, .accordion, [class*='accordion'], [class*='collapsible']"
      ).length > 0,
      // SPA loading / error / empty states (#52 defect #4)
      hasSpinner: document.querySelectorAll(
        "[role='progressbar'], .spinner, [class*='spinner'], [class*='loading'], .skeleton, [class*='skeleton']"
      ).length > 0,
      hasErrorState: document.querySelectorAll(
        "[role='alert'][class*='error'], .error-boundary, [class*='error-message'], [class*='error-state']"
      ).length > 0,
      hasEmptyState: document.querySelectorAll(
        ".empty-state, [class*='empty-state'], [class*='no-results'], [class*='no-data'], [class*='zero-state']"
      ).length > 0,
      // SPA framework detection (#52 defect #4)
      spaFramework: (function detectSpaFramework() {
        if (document.querySelector("[data-reactroot], #__next, #root[data-reactroot]") || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return "react";
        if (document.querySelector("[data-v-], [data-server-rendered]") || window.__VUE__) return "vue";
        if (document.querySelector("[ng-version], [_nghost], [_ngcontent]") || window.ng) return "angular";
        if (document.querySelector("[data-svelte], .svelte-") || window.__svelte) return "svelte";
        return "";
      })(),
      metaDescription: document.querySelector('meta[name="description"]')?.content?.slice(0, 120) || "",
      // Outbound same-origin links — used by buildUserJourneys() for link-graph
      // journey discovery. Normalised (no hash, no query) and deduped.
      outboundLinks: [...new Set(
        Array.from(document.querySelectorAll("a[href]"))
          .map(a => { try { const u = new URL(a.href, location.href); u.hash = ""; u.search = ""; return u.origin === location.origin ? u.toString() : null; } catch { return null; } })
          .filter(Boolean)
      )].slice(0, 50),
    };
  });
}
