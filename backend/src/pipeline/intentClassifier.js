/**
 * intentClassifier.js — Layer 2: Classify page elements into user intent categories
 *
 * Categories: AUTH | NAVIGATION | FORM_SUBMISSION | SEARCH | CRUD | CHECKOUT | CONTENT
 *
 * Priority tiers:
 *   HIGH   — AUTH, CHECKOUT, SEARCH, FORM_SUBMISSION, CRUD (interactive, high test value)
 *   MEDIUM — NAVIGATION (homepages, dashboards — structural tests only)
 *   LOW    — CONTENT (static pages — minimal test coverage)
 *
 * Classification modes:
 *   1. Heuristic (default) — fast, keyword/pattern-based scoring
 *   2. AI-assisted — when confidence is low (<40), asks the AI to classify
 */

import { generateText, parseJSON, hasProvider } from "../aiProvider.js";

// ── Intent patterns ───────────────────────────────────────────────────────────

const HIGH_PRIORITY_INTENTS = new Set(["AUTH", "CHECKOUT", "SEARCH", "FORM_SUBMISSION", "CRUD"]);

const INTENT_PATTERNS = {
  AUTH: {
    keywords: ["login", "log in", "sign in", "signin", "register", "sign up", "signup",
               "create account", "forgot password", "reset password", "logout", "log out",
               "sign out", "password", "username", "authenticate"],
    // "email" removed — too generic, causes false positives on contact/content pages
    inputTypes: ["password"],
    weight: 100,
  },
  CHECKOUT: {
    keywords: ["checkout", "buy", "purchase", "add to cart", "place order", "pay",
               "payment", "billing", "shipping", "credit card", "cart", "order"],
    weight: 95,
  },
  SEARCH: {
    keywords: ["search", "find", "filter", "query", "look up"],
    // "browse" removed — too generic
    inputTypes: ["search"],
    weight: 85,
  },
  FORM_SUBMISSION: {
    keywords: ["submit", "send", "contact", "subscribe", "newsletter", "feedback",
               "apply", "request", "book", "reserve", "schedule", "upload"],
    weight: 80,
  },
  CRUD: {
    keywords: ["create", "new", "add", "edit", "update", "save", "delete", "remove",
               "publish", "draft", "archive", "manage"],
    weight: 75,
  },
  NAVIGATION: {
    keywords: ["home", "about", "docs", "documentation", "blog", "pricing", "features",
               "faq", "help", "support", "dashboard", "profile", "settings",
               "account", "back", "next", "previous", "menu"],
    // "contact" removed — conflicts with FORM_SUBMISSION
    weight: 50,
  },
  CONTENT: {
    keywords: ["read more", "learn more", "view", "see all", "show", "expand", "details"],
    weight: 30,
  },
};

/**
 * classifyElement(element) → { element, intent, confidence }
 *
 * Uses weighted scoring where element TYPE matters more than text content.
 * A password input strongly signals AUTH; a link containing "password" does not.
 */
export function classifyElement(element) {
  const text = (element.text || "").toLowerCase();
  const type = (element.type || "").toLowerCase();
  const name = (element.name || "").toLowerCase();
  const id = (element.id || "").toLowerCase();
  const tag = (element.tag || "").toLowerCase();

  let bestIntent = "NAVIGATION";
  let bestScore = 0;

  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;

    // Check text keywords — weight by element type
    for (const kw of config.keywords || []) {
      if (text.includes(kw)) {
        // Buttons and inputs matching keywords are stronger signals than links
        const typeMultiplier = (tag === "button" || tag === "input") ? 1.2
          : (tag === "a") ? 0.6 : 1.0;
        score += config.weight * typeMultiplier;
      }
      if (name.includes(kw) || id.includes(kw)) score += config.weight * 0.5;
    }

    // Check input types — strongest signal (e.g. input[type=password] → AUTH)
    for (const t of config.inputTypes || []) {
      if (type === t) score += config.weight * 2.0;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  const confidence = Math.min(100, bestScore);
  return { element, intent: bestIntent, confidence };
}

// ── AI-assisted classification ────────────────────────────────────────────────
// When the heuristic confidence is below AI_THRESHOLD, we ask the LLM to
// classify the page. This handles non-English UIs, custom components, and
// pages where keyword matching is ambiguous.

const AI_THRESHOLD = parseInt(process.env.AI_CLASSIFY_THRESHOLD, 10) || 40;

async function aiClassifyPage(snapshot) {
  const elements = (snapshot.elements || []).slice(0, 15).map(e => ({
    tag: e.tag, text: (e.text || "").slice(0, 40), role: e.role, type: e.type,
  }));

  const prompt = `You are a QA page classifier. Given a web page's metadata and interactive elements, classify the page's dominant user intent.

PAGE:
  URL: ${snapshot.url}
  Title: ${snapshot.title}
  H1: ${snapshot.h1 || "none"}
  Forms: ${snapshot.forms}
  Has login form: ${snapshot.hasLoginForm}

ELEMENTS (sample):
${JSON.stringify(elements, null, 2)}

Classify into EXACTLY ONE of these categories:
  AUTH — login, registration, password reset
  CHECKOUT — cart, payment, purchase flow
  SEARCH — search bar, filters, results listing
  FORM_SUBMISSION — contact forms, subscribe, apply
  CRUD — create/edit/delete data
  NAVIGATION — homepage, dashboard, navigation hub
  CONTENT — articles, documentation, static content

Return ONLY valid JSON (no markdown):
{
  "intent": "AUTH",
  "confidence": 85,
  "reason": "one-sentence explanation"
}`;

  const text = await generateText(prompt, { maxTokens: 256 });
  const result = parseJSON(text);
  const intent = (result.intent || "").toUpperCase();
  const validIntents = ["AUTH", "CHECKOUT", "SEARCH", "FORM_SUBMISSION", "CRUD", "NAVIGATION", "CONTENT"];
  if (!validIntents.includes(intent)) return null;
  return { intent, confidence: result.confidence || 70 };
}

/**
 * classifyPage(snapshot, filteredElements) → page intent summary
 *
 * Returns the dominant intent for the page, classified elements, and priority tier.
 * Priority is based on the dominant intent — interactive pages get more test coverage.
 */
export function classifyPage(snapshot, filteredElements) {
  const classified = filteredElements.map(classifyElement);

  // Count intents weighted by element score
  const intentCounts = {};
  for (const { intent, confidence, element } of classified) {
    intentCounts[intent] = (intentCounts[intent] || 0) + confidence + (element._score || 0);
  }

  // Page-level signals — use form structures when available for stronger signals
  if (snapshot.hasLoginForm) {
    intentCounts.AUTH = (intentCounts.AUTH || 0) + 300;
  } else if (snapshot.forms > 0) {
    intentCounts.FORM_SUBMISSION = (intentCounts.FORM_SUBMISSION || 0) + 50;
  }

  const title = (snapshot.title + " " + (snapshot.h1 || "")).toLowerCase();
  if (title.includes("login") || title.includes("sign in")) intentCounts.AUTH = (intentCounts.AUTH || 0) + 200;
  if (title.includes("checkout") || title.includes("cart")) intentCounts.CHECKOUT = (intentCounts.CHECKOUT || 0) + 200;
  if (title.includes("search")) intentCounts.SEARCH = (intentCounts.SEARCH || 0) + 100;

  const dominantIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "NAVIGATION";

  // Priority based on intent — only interactive pages are high priority.
  // NAVIGATION and CONTENT pages get lighter coverage (2-3 structural tests).
  const isHighPriority = HIGH_PRIORITY_INTENTS.has(dominantIntent);

  return {
    url: snapshot.url,
    title: snapshot.title,
    dominantIntent,
    intentBreakdown: intentCounts,
    classifiedElements: classified,
    isHighPriority,
    // Confidence score: how strongly does this page match its dominant intent?
    // Low confidence → the AI should generate fewer, more conservative tests.
    intentConfidence: Math.min(100, intentCounts[dominantIntent] || 0),
  };
}

/**
 * classifyPageWithAI(snapshot, filteredElements, { signal }) → page intent summary
 *
 * Same as classifyPage but falls back to the AI when heuristic confidence
 * is below AI_THRESHOLD. Call this from the crawler pipeline instead of
 * classifyPage when an AI provider is available.
 *
 * @param {AbortSignal} [signal] — forwarded to AI calls so abort stops classification
 */
export async function classifyPageWithAI(snapshot, filteredElements, { signal } = {}) {
  // AI fallback disabled to conserve LLM API quota (Gemini free tier: 20 calls/day).
  // The heuristic classifier has been improved with better keyword scoring and
  // element-type weighting, so AI assistance is not needed for typical pages.
  // To re-enable: remove this early return and uncomment the AI block below.
  return classifyPage(snapshot, filteredElements);

  /*
  const heuristic = classifyPage(snapshot, filteredElements);
  if (heuristic.intentConfidence >= AI_THRESHOLD) return heuristic;
  try {
    if (!hasProvider()) return heuristic;
    if (signal?.aborted) return heuristic;
    const aiResult = await aiClassifyPage(snapshot, signal);
    if (!aiResult) return heuristic;
    const isHighPriority = HIGH_PRIORITY_INTENTS.has(aiResult.intent);
    return {
      ...heuristic,
      dominantIntent: aiResult.intent,
      intentConfidence: aiResult.confidence,
      isHighPriority,
      _aiAssisted: true,
    };
  } catch (err) {
    if (err.name === "AbortError") throw err;
    return heuristic;
  }
  */
}

/**
 * buildUserJourneys(classifiedPages, snapshotsByUrl?) → Array of journey objects
 *
 * Chains related pages into GENUINE multi-page user journeys.
 * Single-page intents are NOT wrapped as journeys — they are handled
 * separately by generateIntentTests in journeyGenerator.js.
 *
 * Detection strategies (applied in order):
 *   1. Intent-based patterns — AUTH→dashboard, multi-CHECKOUT, multi-SEARCH, multi-CRUD
 *   2. Link-graph analysis   — when snapshots are provided, discover cross-intent
 *      journeys by following outbound links between classified pages
 *   3. Form→confirmation     — FORM_SUBMISSION page linking to a CONTENT/NAVIGATION page
 */
export function buildUserJourneys(classifiedPages, snapshotsByUrl = {}) {
  const journeys = [];
  const usedUrls = new Set(); // track URLs already in a journey to avoid overlap

  // ── 1. Intent-based pattern matching (original logic, improved) ────────────

  // Auth flow — login page → post-login destination
  const authPages = classifiedPages.filter(p => p.dominantIntent === "AUTH");
  const dashboardPages = classifiedPages.filter(p =>
    p.url.includes("dashboard") || p.url.includes("home") || p.title.toLowerCase().includes("dashboard")
  );
  if (authPages.length > 0 && dashboardPages.length > 0) {
    const pages = [...authPages, ...dashboardPages].slice(0, 3);
    journeys.push({
      name: "Authentication Flow",
      type: "AUTH",
      pages,
      description: "User login and post-login navigation",
    });
    pages.forEach(p => usedUrls.add(p.url));
  }

  // Checkout flow — only if we have multiple checkout-related pages
  const cartPages = classifiedPages.filter(p => p.dominantIntent === "CHECKOUT");
  if (cartPages.length >= 2) {
    journeys.push({
      name: "Checkout Flow",
      type: "CHECKOUT",
      pages: cartPages,
      description: "Add to cart and purchase flow",
    });
    cartPages.forEach(p => usedUrls.add(p.url));
  }

  // Search → results flow
  const searchPages = classifiedPages.filter(p => p.dominantIntent === "SEARCH");
  if (searchPages.length >= 2) {
    journeys.push({
      name: "Search Flow",
      type: "SEARCH",
      pages: searchPages,
      description: "Search and filter functionality",
    });
    searchPages.forEach(p => usedUrls.add(p.url));
  }

  // CRUD flow — list → create/edit → detail
  const crudPages = classifiedPages.filter(p => p.dominantIntent === "CRUD");
  if (crudPages.length >= 2) {
    const pages = crudPages.slice(0, 4);
    journeys.push({
      name: "CRUD Flow",
      type: "CRUD",
      pages,
      description: "Create, read, update, delete workflow",
    });
    pages.forEach(p => usedUrls.add(p.url));
  }

  // ── 2. Link-graph journey discovery ────────────────────────────────────────
  // When snapshots include outbound links, we can discover cross-intent journeys
  // that the pattern matcher misses (e.g. pricing → signup → dashboard).

  if (Object.keys(snapshotsByUrl).length > 0) {
    const classifiedByUrl = {};
    for (const cp of classifiedPages) classifiedByUrl[cp.url] = cp;

    // Build adjacency: page URL → set of classified page URLs it links to
    const adjacency = {};
    for (const cp of classifiedPages) {
      const snap = snapshotsByUrl[cp.url];
      if (!snap?.outboundLinks) continue;
      adjacency[cp.url] = new Set();
      for (const link of snap.outboundLinks) {
        if (classifiedByUrl[link] && link !== cp.url) {
          adjacency[cp.url].add(link);
        }
      }
    }

    // Find chains of 2-4 pages connected by links that aren't already in a journey
    for (const startPage of classifiedPages) {
      if (usedUrls.has(startPage.url)) continue;
      if (!adjacency[startPage.url]?.size) continue;
      // Only start chains from high-priority pages
      if (!startPage.isHighPriority) continue;

      const chain = [startPage];
      const chainUrls = new Set([startPage.url]);
      let current = startPage;

      // Greedy walk: follow the first link to another classified page
      for (let step = 0; step < 3; step++) {
        const neighbors = adjacency[current.url];
        if (!neighbors) break;
        let next = null;
        for (const neighborUrl of neighbors) {
          if (!chainUrls.has(neighborUrl) && !usedUrls.has(neighborUrl)) {
            next = classifiedByUrl[neighborUrl];
            break;
          }
        }
        if (!next) break;
        chain.push(next);
        chainUrls.add(next.url);
        current = next;
      }

      if (chain.length >= 2) {
        const intents = chain.map(p => p.dominantIntent).join(" → ");
        journeys.push({
          name: `${chain[0].dominantIntent} → ${chain[chain.length - 1].dominantIntent} Flow`,
          type: chain[0].dominantIntent,
          pages: chain,
          description: `Cross-page flow: ${intents}`,
          _discoveredBy: "link_graph",
        });
        chain.forEach(p => usedUrls.add(p.url));
      }
    }
  }

  // ── 3. Form → confirmation journey ─────────────────────────────────────────
  // A FORM_SUBMISSION page that links to a CONTENT or NAVIGATION page is likely
  // a "submit form → see confirmation" flow.

  const formPages = classifiedPages.filter(p =>
    p.dominantIntent === "FORM_SUBMISSION" && !usedUrls.has(p.url)
  );
  for (const formPage of formPages) {
    const snap = snapshotsByUrl[formPage.url];
    if (!snap?.outboundLinks) continue;
    for (const link of snap.outboundLinks) {
      const target = classifiedPages.find(p =>
        p.url === link &&
        !usedUrls.has(p.url) &&
        (p.dominantIntent === "CONTENT" || p.dominantIntent === "NAVIGATION")
      );
      if (target) {
        journeys.push({
          name: "Form Submission Flow",
          type: "FORM_SUBMISSION",
          pages: [formPage, target],
          description: `Submit form on ${formPage.title} → confirmation on ${target.title}`,
          _discoveredBy: "form_confirmation",
        });
        usedUrls.add(formPage.url);
        usedUrls.add(target.url);
        break; // one confirmation page per form is enough
      }
    }
  }

  // DO NOT create single-page "journeys" — those are handled by generateIntentTests.

  return journeys;
}
