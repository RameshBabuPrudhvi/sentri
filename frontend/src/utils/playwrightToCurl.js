/**
 * @module utils/playwrightToCurl
 * @description Converts Playwright API test code into cURL commands.
 * Scans the full Playwright test code for API calls and converts each one into
 * a cURL command. Returns all commands joined by blank lines, or null if none.
 * Designed for one-click copy into Postman / Insomnia / terminal.
 */

/**
 * @param {string|null} fullCode - Full Playwright test source code.
 * @returns {string|null} cURL commands joined by blank lines, or null.
 */
export default function playwrightToCurl(fullCode) {
  if (!fullCode) return null;

  // Dynamically discover variable names assigned from request.newContext().
  // e.g. "const ctx = await request.newContext(...)" → adds "ctx" to the match list.
  const ctxNames = new Set(["request", "context", "api", "apiContext", "apiRequestContext", "res", "client", "http"]);
  const ctxAssignRe = /(?:const|let|var)\s+(\w+)\s*=\s*await\s+\w+\.newContext\s*\(/g;
  let ctxMatch;
  while ((ctxMatch = ctxAssignRe.exec(fullCode)) !== null) {
    ctxNames.add(ctxMatch[1]);
  }

  // Build the regex with all discovered variable names.
  const namesAlt = [...ctxNames].join("|");
  const callRe = new RegExp(
    `(?:${namesAlt}|response\\s*=\\s*await\\s+\\w+)\\s*\\.\\s*(get|post|put|patch|delete|head)\\s*\\(\\s*(['\"\`])([^'\"\`]+)\\2(?:\\s*,\\s*(\\{[\\s\\S]*?\\})\\s*)?\\)`,
    "gi"
  );

  const commands = [];
  let match;
  while ((match = callRe.exec(fullCode)) !== null) {
    const method = match[1].toUpperCase();
    const url = match[3];
    const optionsBlock = match[4] || "";

    const parts = ["curl"];
    if (method !== "GET") parts.push(`-X ${method}`);
    parts.push(`'${url}'`);

    // Extract headers from options: { headers: { 'Key': 'Value' } }
    const headersBlock = optionsBlock.match(/headers\s*:\s*\{([^}]*)\}/);
    if (headersBlock) {
      const headerPairs = headersBlock[1].matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g);
      for (const hp of headerPairs) {
        parts.push(`-H '${hp[1]}: ${hp[2]}'`);
      }
    }

    // Extract JSON body: { data: { ... } }
    const dataObjMatch = optionsBlock.match(/data\s*:\s*(\{[\s\S]*?\})\s*[,}]/);
    if (dataObjMatch) {
      const body = dataObjMatch[1].replace(/\s+/g, " ").trim();
      parts.push(`-d '${body}'`);
      if (!headersBlock || !/content-type/i.test(headersBlock[0])) {
        parts.push("-H 'Content-Type: application/json'");
      }
    } else {
      // Try string body: data: '...' or data: "..."
      const strDataMatch = optionsBlock.match(/data\s*:\s*(['"])([\s\S]*?)\1/);
      if (strDataMatch) {
        parts.push(`-d '${strDataMatch[2]}'`);
      }
    }

    commands.push(parts.join(" \\\n  "));
  }

  return commands.length > 0 ? commands.join("\n\n") : null;
}
