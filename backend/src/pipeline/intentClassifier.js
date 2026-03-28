/**
 * intentClassifier.js — Layer 2: Classify page elements into user intent categories
 *
 * Categories: AUTH | NAVIGATION | FORM_SUBMISSION | SEARCH | CRUD | CHECKOUT | CONTENT
 */

// ── Intent patterns ───────────────────────────────────────────────────────────

const INTENT_PATTERNS = {
  AUTH: {
    keywords: ["login", "log in", "sign in", "signin", "register", "sign up", "signup",
               "create account", "forgot password", "reset password", "logout", "log out",
               "sign out", "password", "username", "email", "authenticate"],
    inputTypes: ["password"],
    weight: 100,
  },
  CHECKOUT: {
    keywords: ["checkout", "buy", "purchase", "add to cart", "place order", "pay",
               "payment", "billing", "shipping", "credit card", "cart", "order"],
    weight: 95,
  },
  SEARCH: {
    keywords: ["search", "find", "filter", "query", "look up", "browse"],
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
               "contact", "faq", "help", "support", "dashboard", "profile", "settings",
               "account", "back", "next", "previous", "menu"],
    weight: 50,
  },
  CONTENT: {
    keywords: ["read more", "learn more", "view", "see all", "show", "expand", "details"],
    weight: 30,
  },
};

/**
 * classifyElement(element) → { element, intent, confidence }
 */
export function classifyElement(element) {
  const text = (element.text || "").toLowerCase();
  const type = (element.type || "").toLowerCase();
  const name = (element.name || "").toLowerCase();
  const id = (element.id || "").toLowerCase();

  let bestIntent = "NAVIGATION";
  let bestScore = 0;

  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;

    // Check text keywords
    for (const kw of config.keywords || []) {
      if (text.includes(kw)) score += config.weight;
      if (name.includes(kw) || id.includes(kw)) score += config.weight * 0.5;
    }

    // Check input types
    for (const t of config.inputTypes || []) {
      if (type === t) score += config.weight * 1.5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIntent = intent;
    }
  }

  const confidence = Math.min(100, bestScore);
  return { element, intent: bestIntent, confidence };
}

/**
 * classifyPage(snapshot, filteredElements) → page intent summary
 *
 * Returns the dominant intent for the page and classified elements
 */
export function classifyPage(snapshot, filteredElements) {
  const classified = filteredElements.map(classifyElement);

  // Count intents weighted by element score
  const intentCounts = {};
  for (const { intent, confidence, element } of classified) {
    intentCounts[intent] = (intentCounts[intent] || 0) + confidence + (element._score || 0);
  }

  // Page-level signals
  if (snapshot.forms > 0) {
    intentCounts.FORM_SUBMISSION = (intentCounts.FORM_SUBMISSION || 0) + 50;
  }

  const title = (snapshot.title + " " + snapshot.h1).toLowerCase();
  if (title.includes("login") || title.includes("sign in")) intentCounts.AUTH = (intentCounts.AUTH || 0) + 200;
  if (title.includes("checkout") || title.includes("cart")) intentCounts.CHECKOUT = (intentCounts.CHECKOUT || 0) + 200;
  if (title.includes("search")) intentCounts.SEARCH = (intentCounts.SEARCH || 0) + 100;

  const dominantIntent = Object.entries(intentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "NAVIGATION";

  return {
    url: snapshot.url,
    title: snapshot.title,
    dominantIntent,
    intentBreakdown: intentCounts,
    classifiedElements: classified,
    // All pages are high priority — NAVIGATION pages like homepages still need
    // comprehensive test coverage (titles, CTAs, links, layout, 404 checks, etc.)
    isHighPriority: true,
  };
}

/**
 * buildUserJourneys(classifiedPages) → Array of journey objects
 *
 * Chains related pages into logical user journeys
 */
export function buildUserJourneys(classifiedPages) {
  const journeys = [];

  // Find auth flow
  const authPages = classifiedPages.filter(p => p.dominantIntent === "AUTH");
  const dashboardPages = classifiedPages.filter(p =>
    p.url.includes("dashboard") || p.url.includes("home") || p.title.toLowerCase().includes("dashboard")
  );
  if (authPages.length > 0) {
    journeys.push({
      name: "Authentication Flow",
      type: "AUTH",
      pages: [...authPages, ...dashboardPages].slice(0, 3),
      description: "User login and post-login navigation",
    });
  }

  // Find checkout flow
  const cartPages = classifiedPages.filter(p => p.dominantIntent === "CHECKOUT");
  if (cartPages.length > 0) {
    journeys.push({
      name: "Checkout Flow",
      type: "CHECKOUT",
      pages: cartPages,
      description: "Add to cart and purchase flow",
    });
  }

  // Find search flow
  const searchPages = classifiedPages.filter(p => p.dominantIntent === "SEARCH");
  if (searchPages.length > 0) {
    journeys.push({
      name: "Search Flow",
      type: "SEARCH",
      pages: searchPages,
      description: "Search and filter functionality",
    });
  }

  // Each high-priority page gets its own journey if not already covered
  const coveredUrls = new Set(journeys.flatMap(j => j.pages.map(p => p.url)));
  for (const page of classifiedPages) {
    if (page.isHighPriority && !coveredUrls.has(page.url)) {
      journeys.push({
        name: `${page.dominantIntent} — ${page.title}`,
        type: page.dominantIntent,
        pages: [page],
        description: `Isolated ${page.dominantIntent.toLowerCase()} flow on ${page.url}`,
      });
    }
  }

  return journeys;
}
