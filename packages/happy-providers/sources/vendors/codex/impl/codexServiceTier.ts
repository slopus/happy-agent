import type { SessionServiceTier } from "@/core/SessionRunRequest.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const codexServiceTierSchema = Type.Literal("priority");

/** A service tier understood by the native Codex request protocol. */
export type CodexServiceTier = Static<typeof codexServiceTierSchema>;

/** Validate the shared opaque identifier at the Codex provider boundary. */
export function parseCodexServiceTier(
    serviceTier: SessionServiceTier | undefined,
): CodexServiceTier | undefined {
    if (serviceTier === undefined) return undefined;
    if (!Value.Check(codexServiceTierSchema, serviceTier)) {
        throw new Error(`Codex does not support service tier "${serviceTier}".`);
    }
    return serviceTier;
}
