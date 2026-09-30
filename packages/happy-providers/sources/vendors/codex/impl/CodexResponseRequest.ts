import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { CodexAccessProgram } from "@/vendors/codex/impl/codexAccessProgram.js";

export type CodexResponseRequest = Omit<ResponseCreateParamsStreaming, "service_tier"> & {
    access_programs?: { cyber: CodexAccessProgram };
    // Codex desktop accepts Ultrafast before the OpenAI SDK's generated enum includes it.
    service_tier?: ResponseCreateParamsStreaming["service_tier"] | "ultrafast";
    client_metadata?: Record<string, unknown>;
    generate?: boolean;
};
