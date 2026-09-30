import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";

export type ResponsesLiteRequest = Omit<ResponseCreateParamsStreaming, "service_tier"> & {
    service_tier?: ResponseCreateParamsStreaming["service_tier"] | "ultrafast";
    client_metadata?: Record<string, unknown>;
    generate?: boolean;
};
