import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "crypto";

export const requestContext = new AsyncLocalStorage();
let sdkStarted = false;
let otelApi = null;

export async function initOpenTelemetry() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdkStarted) return;

  const [{ NodeSDK }, { getNodeAutoInstrumentations }, { OTLPTraceExporter }, api] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/auto-instrumentations-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/api"),
  ]);

  otelApi = api;
  // INF-007: per the OTel spec, `OTEL_EXPORTER_OTLP_ENDPOINT` is a BASE URL —
  // the SDK appends the signal-specific `/v1/traces` path when the env var is
  // consumed natively. Passing the raw value as `url` to OTLPTraceExporter
  // bypasses that path-appending, so an operator who sets the standard
  // `http://collector:4318` would silently POST to `/` instead of `/v1/traces`.
  // Construct without an explicit `url` so the exporter reads the env var via
  // the standard OTel-SDK code path and appends the signal segment correctly.
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "sentri-backend",
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  await sdk.start();
  sdkStarted = true;
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function getRequestId() {
  return requestContext.getStore()?.requestId || null;
}

export function getCurrentTraceId() {
  const store = requestContext.getStore();
  if (store?.traceId) return store.traceId;
  const sc = getSpanContext();
  return sc?.traceId || null;
}

export function getSpanContext() {
  if (!otelApi) return null;
  const span = otelApi.trace.getSpan(otelApi.context.active());
  const sc = span?.spanContext?.();
  return sc ? { traceId: sc.traceId, spanId: sc.spanId } : null;
}

/**
 * AI-005 tripwire #3 — attach per-AI-call attributes to the active OTel
 * span so traces split by `ai.agent_role`, `ai.provider`, and `ai.operation`
 * line up with the Prometheus metric labels emitted by `dispatcher.js`.
 *
 * Called from `dispatcher.callProvider` around every AI call. No-op when
 * OTel is unconfigured — `getSpanContext()` already short-circuits on
 * `!otelApi`, and `span?.setAttributes?.()` lets a no-op span pass through.
 *
 * The attributes follow the OpenTelemetry "Semantic Conventions for
 * Generative AI Systems" draft (`gen_ai.*`) plus Sentri-prefixed
 * `ai.agent_role` which is not yet covered by the spec. Pinning the
 * convention now means future migration to `gen_ai.request.agent_role`
 * is a one-line rename.
 *
 * @param {Object} attrs
 * @param {string} attrs.provider
 * @param {string} [attrs.agentRole]
 * @param {string} [attrs.operation]
 * @returns {void}
 */
export function annotateAiCallSpan({ provider, agentRole, operation } = {}) {
  if (!otelApi || !provider) return;
  try {
    const span = otelApi.trace.getSpan(otelApi.context.active());
    if (!span?.setAttributes) return;
    const attrs = {
      "ai.provider": provider,
      "gen_ai.system": provider,
    };
    if (agentRole) {
      attrs["ai.agent_role"] = agentRole;
      attrs["gen_ai.request.agent_role"] = agentRole;
    }
    if (operation) {
      attrs["ai.operation"] = operation;
      attrs["gen_ai.operation.name"] = operation;
    }
    span.setAttributes(attrs);
  } catch { /* best-effort — never let observability fail a real call */ }
}
