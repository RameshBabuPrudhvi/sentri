/**
 * @module utils/fakeDataGenerator
 * @description Seeded `@faker-js/faker` wrapper for B6 unique test data
 *   (AUDIT-ROADMAP Bundle 6, QAL-010).
 *
 * The pipeline-generated test code carries placeholder tokens
 * (`__FAKE_EMAIL__`, `__FAKE_NAME__`, …) emitted by the journey + intent
 * prompts. The runner substitutes those tokens before `vm` compilation
 * using a faker instance seeded from `hash(runId + testId)` —
 * deterministic within a run (so a retry re-uses the same data and
 * assertions stay stable), different across runs (so re-running on the
 * same DB doesn't trip uniqueness constraints from a prior pass).
 *
 * `@faker-js/faker` is an OPTIONAL backend dep — when the module is
 * not installed (CI without it, eval harness, offline) every
 * placeholder resolves to a deterministic SHA-256-derived fallback
 * string so the test still runs.
 */

import crypto from "node:crypto";

export const FAKE_DATA_TOKENS = Object.freeze([
  "__FAKE_EMAIL__",
  "__FAKE_NAME__",
  "__FAKE_FIRST_NAME__",
  "__FAKE_LAST_NAME__",
  "__FAKE_PHONE__",
  "__FAKE_USERNAME__",
  "__FAKE_PASSWORD__",
  "__FAKE_COMPANY__",
  "__FAKE_STREET__",
  "__FAKE_CITY__",
  "__FAKE_ZIP__",
  "__FAKE_UUID__",
  "__FAKE_NUMBER__",
  "__FAKE_WORD__",
  "__TIMESTAMP__",
]);

export const SUPPORTED_LOCALES = Object.freeze(new Set([
  "en", "en_US", "en_GB", "es", "es_MX", "fr", "fr_CA",
  "de", "it", "pt_BR", "ja", "zh_CN", "ko", "nl", "sv",
]));

let fakerModulePromise = null;

async function loadFakerModule() {
  if (fakerModulePromise) return fakerModulePromise;
  fakerModulePromise = (async () => {
    try {
      return await import("@faker-js/faker");
    } catch {
      // Optional dep absent — fall through to the deterministic
      // SHA-256 substitution path. Cached as `null` so subsequent
      // calls skip the dynamic-import retry.
      return null;
    }
  })();
  return fakerModulePromise;
}

/**
 * Build a deterministic 53-bit numeric seed from `hash(runId + testId)`.
 * 53 bits = `Number.MAX_SAFE_INTEGER` precision; SHA-256 is overkill
 * for non-cryptographic seeding but keeps the dependency surface
 * minimal (Node built-in).
 *
 * @param {string} runId
 * @param {string} testId
 * @returns {number}
 */
export function seedForTest(runId, testId) {
  const hash = crypto.createHash("sha256")
    .update(String(runId || ""))
    .update(":")
    .update(String(testId || ""))
    .digest();
  const hi = hash.readBigUInt64BE(0);
  return Number(hi >> 11n);
}

function deterministicFallback(token, seed) {
  const slug = crypto.createHash("sha256")
    .update(String(seed))
    .update(":")
    .update(token)
    .digest("hex")
    .slice(0, 8);
  switch (token) {
    case "__FAKE_EMAIL__":      return `fake.${slug}@example.invalid`;
    case "__FAKE_PHONE__":      return `+1-555-${slug.slice(0, 7).padStart(7, "0")}`;
    case "__FAKE_UUID__":       return `${slug}-${slug.slice(0,4)}-4${slug.slice(1,4)}-8${slug.slice(2,5)}-${slug}${slug.slice(0,4)}`;
    case "__FAKE_ZIP__":        return slug.replace(/[a-f]/g, "0").slice(0, 5);
    case "__FAKE_NUMBER__":     return String(parseInt(slug, 16) % 100000);
    case "__TIMESTAMP__":       return String(Math.floor(parseInt(slug, 16) / 1000) + 1700000000000);
    case "__FAKE_PASSWORD__":   return `Pw!${slug}9aZ`;
    default:                    return `fake-${slug}`;
  }
}

function resolveToken(token, fakerInstance, seed) {
  if (!fakerInstance) return deterministicFallback(token, seed);
  try {
    switch (token) {
      case "__FAKE_EMAIL__":      return fakerInstance.internet.email();
      case "__FAKE_NAME__":       return fakerInstance.person.fullName();
      case "__FAKE_FIRST_NAME__": return fakerInstance.person.firstName();
      case "__FAKE_LAST_NAME__":  return fakerInstance.person.lastName();
      case "__FAKE_PHONE__":      return fakerInstance.phone.number();
      case "__FAKE_USERNAME__":   return fakerInstance.internet.userName();
      case "__FAKE_PASSWORD__":   return fakerInstance.internet.password({ length: 14, memorable: false });
      case "__FAKE_COMPANY__":    return fakerInstance.company.name();
      case "__FAKE_STREET__":     return fakerInstance.location.streetAddress();
      case "__FAKE_CITY__":       return fakerInstance.location.city();
      case "__FAKE_ZIP__":        return fakerInstance.location.zipCode();
      case "__FAKE_UUID__":       return fakerInstance.string.uuid();
      case "__FAKE_NUMBER__":     return String(fakerInstance.number.int({ min: 0, max: 99999 }));
      case "__FAKE_WORD__":       return fakerInstance.lorem.word();
      case "__TIMESTAMP__":       return String(fakerInstance.number.int({ min: 1700000000000, max: 1800000000000 }));
      default:                    return deterministicFallback(token, seed);
    }
  } catch {
    return deterministicFallback(token, seed);
  }
}

/**
 * Build a per-test seeded faker instance.
 *
 * @param {Object} opts
 * @param {string} opts.runId
 * @param {string} opts.testId
 * @param {string} [opts.locale="en"]
 * @param {Iterable<string>} [opts.skipTokens] — tokens NOT to substitute
 *   (e.g. columns already covered by an upstream `testFixtureRepo` row;
 *   spec at `docs/roadmap/AUDIT-ROADMAP.md:786-788`).
 * @returns {Promise<Object>} `{ substitute(code), seed, locale, fakerLoaded }` —
 *   `substitute` is `(code: string) => string`.
 */
export async function createFaker({ runId, testId, locale = "en", skipTokens } = {}) {
  const seed = seedForTest(runId, testId);
  const safeLocale = SUPPORTED_LOCALES.has(locale) ? locale : "en";
  const mod = await loadFakerModule();
  let fakerInstance = null;
  if (mod) {
    try {
      const { Faker, allLocales, faker: defaultFaker } = mod;
      if (typeof Faker === "function" && allLocales) {
        const localePack = allLocales[safeLocale] || allLocales.en;
        fakerInstance = new Faker({ locale: [localePack, allLocales.en] });
      } else if (defaultFaker) {
        fakerInstance = defaultFaker;
      }
    } catch {
      fakerInstance = mod.faker || null;
    }
    if (fakerInstance && typeof fakerInstance.seed === "function") {
      fakerInstance.seed(seed);
    }
  }
  const skip = new Set(skipTokens || []);
  return {
    seed,
    locale: safeLocale,
    fakerLoaded: fakerInstance !== null,
    substitute(code) {
      if (typeof code !== "string" || code.length === 0) return code;
      let out = code;
      for (const token of FAKE_DATA_TOKENS) {
        if (skip.has(token)) continue;
        if (out.indexOf(token) === -1) continue;
        // Resolve once per token per call so all occurrences of the
        // SAME token in one code body share one value (operators
        // expect `__FAKE_EMAIL__` mentioned three times to mean
        // "the same email three times", not three different ones).
        const value = String(resolveToken(token, fakerInstance, seed));
        // Use split/join (not String.replaceAll) so the substitution
        // is literal — `__FAKE_*__` tokens contain `_` which is a
        // RegExp metacharacter under `\w` shorthand, and replaceAll
        // with a RegExp source would mis-anchor on substrings.
        out = out.split(token).join(value);
      }
      return out;
    },
  };
}
