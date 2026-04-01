const BASE = "/api";

// Default timeouts (ms)
const TIMEOUT_DEFAULT = 30_000;
const TIMEOUT_LONG    = 300_000; // crawl / run

async function req(method, path, body, timeout = TIMEOUT_DEFAULT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error("Request timed out. Please try again.");
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`[${res.status}] ${err.error || res.statusText || "Request failed"}`);
  }
  return res.json();
}

export const api = {
  // Projects
  createProject: (data) => req("POST", "/projects", data),
  getProjects:   ()     => req("GET",  "/projects"),
  getProject:    (id)   => req("GET",  `/projects/${id}`),
  deleteProject: (id)   => req("DELETE", `/projects/${id}`),

  // Crawl & Run
  crawl:         (id)    => req("POST", `/projects/${id}/crawl`, undefined, TIMEOUT_LONG),
  runTests:      (id)    => req("POST", `/projects/${id}/run`,   undefined, TIMEOUT_LONG),
  runSingleTest: (testId)=> req("POST", `/tests/${testId}/run`,  undefined, TIMEOUT_LONG),

  // Tests
  getTests:     (id)                => req("GET",    `/projects/${id}/tests`),
  getAllTests:   ()                  => req("GET",    "/tests"),
  getTest:      (testId)            => req("GET",    `/tests/${testId}`),
  updateTest:   (testId, data)      => req("PATCH",  `/tests/${testId}`, data),
  createTest:   (projectId, data)   => req("POST",   `/projects/${projectId}/tests`, data),
  generateTest: (projectId, data)   => req("POST",   `/projects/${projectId}/tests/generate`, data, TIMEOUT_LONG),
  deleteTest:   (projectId, testId) => req("DELETE", `/projects/${projectId}/tests/${testId}`),

  // Test review actions
  approveTest:     (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/approve`),
  rejectTest:      (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/reject`),
  restoreTest:     (projectId, testId) => req("PATCH", `/projects/${projectId}/tests/${testId}/restore`),
  bulkUpdateTests: (projectId, testIds, action) =>
    req("POST", `/projects/${projectId}/tests/bulk`, { testIds, action }),

  // Runs
  getRuns: (id)    => req("GET", `/projects/${id}/runs`),
  getRun:  (runId) => req("GET", `/runs/${runId}`),

  // Dashboard
  getDashboard: () => req("GET", "/dashboard"),

  // Config & Settings
   getConfig:    ()                 => req("GET",    "/config"),
   getSettings:  ()                 => req("GET",    "/settings"),

  // For cloud providers pass apiKey; for "local" (Ollama) pass { baseUrl?, model? } instead
  saveApiKey: (provider, apiKey, ollamaOpts) =>
    provider === "local"
      ? req("POST", "/settings", { provider, ...ollamaOpts })
      : req("POST", "/settings", { provider, apiKey }),
  deleteApiKey: (provider) => req("DELETE", `/settings/${provider}`),

  // Ollama / local provider
  getOllamaStatus: () => req("GET", "/ollama/status"),

  // System info & data management
  getSystemInfo:   () => req("GET",    "/system"),
  clearRuns:       () => req("DELETE", "/data/runs"),
  clearActivities: () => req("DELETE", "/data/activities"),
  clearHealing:    () => req("DELETE", "/data/healing"),
};
