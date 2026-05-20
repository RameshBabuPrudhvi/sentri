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
