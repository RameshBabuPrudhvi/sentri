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
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "sentri-backend",
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
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

export function getSpanContext() {
  if (!otelApi) return null;
  const span = otelApi.trace.getSpan(otelApi.context.active());
  const sc = span?.spanContext?.();
  return sc ? { traceId: sc.traceId, spanId: sc.spanId } : null;
}
