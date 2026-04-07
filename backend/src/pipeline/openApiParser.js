/**
 * @module pipeline/openApiParser
 * @description Parses OpenAPI 3.x / Swagger 2.x JSON specs into ApiEndpoint[]
 * descriptors compatible with buildApiTestPrompt.
 *
 * Supports JSON format only (covers the vast majority of specs). YAML support
 * can be added later with a lightweight parser.
 *
 * ### Exports
 * - {@link parseOpenApiSpec} — `(specText) → ApiEndpoint[]`
 */

/**
 * Attempt to generate an example value from a JSON Schema property.
 * @param {object} schema
 * @returns {*}
 */
function exampleFromSchema(schema) {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];

  switch (schema.type) {
    case "string":  return schema.format === "email" ? "user@example.com" : "string";
    case "integer": return schema.minimum ?? 1;
    case "number":  return schema.minimum ?? 1.0;
    case "boolean": return true;
    case "array":
      if (schema.items) return [exampleFromSchema(schema.items)];
      return [];
    case "object": {
      const obj = {};
      for (const [key, prop] of Object.entries(schema.properties || {})) {
        obj[key] = exampleFromSchema(prop);
      }
      return obj;
    }
    default: return undefined;
  }
}

/**
 * Resolve a $ref path like "#/components/schemas/User" against the root spec.
 * Only supports local JSON pointer refs (the most common kind).
 * @param {string} ref
 * @param {object} root — the full spec object
 * @returns {object|null}
 */
function resolveRef(ref, root) {
  if (!ref || typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/");
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object") return null;
    current = current[part];
  }
  return current || null;
}

/**
 * Recursively resolve $ref in a schema object (one level deep to avoid loops).
 * @param {object} schema
 * @param {object} root
 * @returns {object}
 */
function resolveSchema(schema, root) {
  if (!schema) return schema;
  if (schema.$ref) return resolveRef(schema.$ref, root) || schema;
  if (schema.properties) {
    const resolved = { ...schema, properties: {} };
    for (const [key, prop] of Object.entries(schema.properties)) {
      resolved.properties[key] = prop.$ref ? (resolveRef(prop.$ref, root) || prop) : prop;
    }
    return resolved;
  }
  return schema;
}

/**
 * Extract request body example from an OpenAPI 3.x operation.
 * @param {object} operation — the operation object (get/post/put etc.)
 * @param {object} root — full spec for $ref resolution
 * @returns {string|null}
 */
function extractRequestBody(operation, root) {
  const rb = operation.requestBody;
  if (!rb) return null;
  const resolved = rb.$ref ? resolveRef(rb.$ref, root) : rb;
  const jsonContent = resolved?.content?.["application/json"];
  if (!jsonContent) return null;
  if (jsonContent.example) return JSON.stringify(jsonContent.example);
  if (jsonContent.schema) {
    const schema = resolveSchema(jsonContent.schema, root);
    const example = exampleFromSchema(schema);
    if (example !== undefined) return JSON.stringify(example);
  }
  return null;
}

/**
 * Extract response body example from an OpenAPI 3.x operation.
 * Tries the success response (200/201) first.
 * @param {object} operation
 * @param {object} root
 * @returns {string|null}
 */
function extractResponseBody(operation, root) {
  const responses = operation.responses;
  if (!responses) return null;
  // Try success codes first, then any code
  for (const code of ["200", "201", "default"]) {
    const resp = responses[code];
    if (!resp) continue;
    const resolved = resp.$ref ? resolveRef(resp.$ref, root) : resp;
    const jsonContent = resolved?.content?.["application/json"];
    if (!jsonContent) continue;
    if (jsonContent.example) return JSON.stringify(jsonContent.example);
    if (jsonContent.schema) {
      const schema = resolveSchema(jsonContent.schema, root);
      const example = exampleFromSchema(schema);
      if (example !== undefined) return JSON.stringify(example);
    }
  }
  return null;
}

/**
 * Parse an OpenAPI 3.x or Swagger 2.x JSON spec into ApiEndpoint[] descriptors.
 *
 * @param {string} specText — raw JSON string of the OpenAPI spec
 * @returns {ApiEndpoint[]} — endpoint descriptors, or empty array if parsing fails
 */
export function parseOpenApiSpec(specText) {
  let spec;
  try {
    spec = JSON.parse(specText);
  } catch {
    return []; // not valid JSON — caller should fall back to text-based parsing
  }

  // Must have paths object (both OpenAPI 3.x and Swagger 2.x)
  if (!spec.paths || typeof spec.paths !== "object") return [];

  // Detect if this is actually an OpenAPI spec (not random JSON)
  const isOpenApi = spec.openapi || spec.swagger;
  if (!isOpenApi) return [];

  const endpoints = [];
  const validMethods = new Set(["get", "post", "put", "patch", "delete"]);

  for (const [pathPattern, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!validMethods.has(method.toLowerCase())) continue;
      if (!operation || typeof operation !== "object") continue;

      const upperMethod = method.toUpperCase();

      // Extract status codes from responses
      const statuses = operation.responses
        ? Object.keys(operation.responses).filter(c => /^\d+$/.test(c)).map(Number).sort()
        : upperMethod === "GET" ? [200] : [200, 201];

      endpoints.push({
        method: upperMethod,
        pathPattern,
        exampleUrls: [pathPattern],
        statuses: statuses.length > 0 ? statuses : [200],
        contentType: "application/json",
        requestBodyExample: extractRequestBody(operation, spec),
        responseBodyExample: extractResponseBody(operation, spec),
        callCount: 1,
        avgDurationMs: 0,
        pageUrls: [],
      });
    }
  }

  return endpoints;
}
