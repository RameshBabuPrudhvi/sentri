import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "crypto";
import { context, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

export const requestContext = new AsyncLocalStorage();
let sdkStarted = false;

export function initOpenTelemetry() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || sdkStarted) return;
  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || "sentri-backend",
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  sdk.start();
  sdkStarted = true;
}

export function createRequestId() {
  return crypto.randomUUID();
}

export function getRequestId() {
  return requestContext.getStore()?.requestId || null;
}

export function getSpanContext() {
  const span = trace.getSpan(context.active());
  const sc = span?.spanContext?.();
  if (!sc) return null;
  return { traceId: sc.traceId, spanId: sc.spanId };
}
