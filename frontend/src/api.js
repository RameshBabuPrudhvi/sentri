import { demoApi } from "./demo.js";

const BASE = "/api";
let _useDemo = null; // null = not checked yet, true/false after check

async function checkBackend() {
  if (_useDemo !== null) return _useDemo;
  try {
    const res = await fetch(`${BASE}/dashboard`, { method: "GET", signal: AbortSignal.timeout(3000) });
    _useDemo = !res.ok;
  } catch {
    _useDemo = true;
  }
  return _useDemo;
}

async function req(method, path, body) {
  const useDemo = await checkBackend();
  if (useDemo) {
    // Route to demo API
    const route = path;
    if (route === "/dashboard") return demoApi.getDashboard();
    if (route === "/projects" && method === "GET") return demoApi.getProjects();
    if (route === "/projects" && method === "POST") return demoApi.createProject(body);
    const projMatch = route.match(/^\/projects\/([^/]+)$/);
    if (projMatch && method === "GET") return demoApi.getProject(projMatch[1]);
    const testsMatch = route.match(/^\/projects\/([^/]+)\/tests$/);
    if (testsMatch) return demoApi.getTests(testsMatch[1]);
    const deleteTestMatch = route.match(/^\/projects\/([^/]+)\/tests\/([^/]+)$/);
    if (deleteTestMatch && method === "DELETE") return demoApi.deleteTest(deleteTestMatch[1], deleteTestMatch[2]);
    const runsMatch = route.match(/^\/projects\/([^/]+)\/runs$/);
    if (runsMatch) return demoApi.getRuns(runsMatch[1]);
    const runMatch = route.match(/^\/runs\/([^/]+)$/);
    if (runMatch) return demoApi.getRun(runMatch[1]);
    const crawlMatch = route.match(/^\/projects\/([^/]+)\/crawl$/);
    if (crawlMatch) return demoApi.crawl(crawlMatch[1]);
    const runTestsMatch = route.match(/^\/projects\/([^/]+)\/run$/);
    if (runTestsMatch) return demoApi.runTests(runTestsMatch[1]);
    return Promise.reject(new Error("Demo: route not found"));
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Request failed");
  }
  return res.json();
}

export const api = {
  // Projects
  createProject: (data) => req("POST", "/projects", data),
  getProjects: () => req("GET", "/projects"),
  getProject: (id) => req("GET", `/projects/${id}`),

  // Crawl
  crawl: (id) => req("POST", `/projects/${id}/crawl`),
  runTests: (id, options) => req("POST", `/projects/${id}/run`, options),

  // Tests
  getTests: (id) => req("GET", `/projects/${id}/tests`),
  deleteTest: (projectId, testId) => req("DELETE", `/projects/${projectId}/tests/${testId}`),

  // Runs
  getRuns: (id) => req("GET", `/projects/${id}/runs`),
  getRun: (runId) => req("GET", `/runs/${runId}`),

  // Dashboard
  getDashboard: () => req("GET", "/dashboard"),
};
