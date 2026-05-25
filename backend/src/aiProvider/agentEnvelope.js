import { z } from "zod";

export const ROLES = Object.freeze([
  "explorer",
  "planner",
  "author",
  "reviewer",
  "oracle",
  "healer",
  "triager",
  "supervisor",
  "default",
]);

export const INTENTS = Object.freeze([
  "handoff",
  "request_revision",
  "accept",
  "reject",
  "question",
  "answer",
  "final",
  "tool_call",
  "tool_result",
  "reject_final",
]);

const AgentEnvelopeSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  threadId: z.string().min(1),
  traceId: z.string().min(1),
  fromRole: z.enum(ROLES),
  toRole: z.enum(ROLES).nullable().optional(),
  replyToId: z.string().min(1).nullable().optional(),
  intent: z.enum(INTENTS),
  artifact: z.unknown().nullable().optional(),
  rationale: z.string().nullable().optional(),
  round: z.number().int().min(0).optional(),
  workspaceId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

export function validateEnvelope(msg) {
  const parsed = AgentEnvelopeSchema.safeParse(msg);
  if (parsed.success) {
    return {
      ...parsed.data,
      round: parsed.data.round ?? 0,
      toRole: parsed.data.toRole ?? null,
      replyToId: parsed.data.replyToId ?? null,
      artifact: parsed.data.artifact ?? null,
      rationale: parsed.data.rationale ?? null,
    };
  }

  const err = new Error(`Invalid agent envelope: ${parsed.error.issues.map(i => i.path.join(".") || "(root)").join(", ")}`);
  err.code = "ERR_AGENT_ENVELOPE_INVALID";
  err.issues = parsed.error.issues;
  throw err;
}
