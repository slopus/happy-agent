import { codexValuesEqual } from "@/vendors/codex/impl/codexValuesEqual.js";

const REUSED_PROPERTIES = [
    "model",
    "instructions",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "store",
    "stream",
    "include",
    "service_tier",
    "access_programs",
    "prompt_cache_key",
    "text",
] as const;

/** Matches the exhaustive non-input reuse check in the Codex websocket client. */
export function codexRequestPropertiesMatch(previous: object, current: object): boolean {
    return REUSED_PROPERTIES.every((property) =>
        codexValuesEqual(Reflect.get(previous, property), Reflect.get(current, property)),
    );
}
