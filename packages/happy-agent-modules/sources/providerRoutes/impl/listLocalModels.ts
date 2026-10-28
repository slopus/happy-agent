import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const PROBE_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_MODELS = 500;

const modelListSchema = Type.Object({
    data: Type.Array(
        Type.Object({
            id: Type.String({ minLength: 1, maxLength: 512 }),
            owned_by: Type.Optional(Type.String({ maxLength: 256 })),
        }),
    ),
});

export interface LocalModelList {
    /** `running` listed models; `unauthorized` refused the key; `stopped` gave no model list. */
    readonly status: "running" | "unauthorized" | "stopped";
    readonly models: readonly { readonly id: string; readonly ownedBy: string | null }[];
}

/**
 * Ask a model server on this computer which models it serves: one `GET /v1/models` on
 * `127.0.0.1`, bounded to 1.5 seconds, never redirected elsewhere. This is the only request route
 * detection makes, and it never runs inference. Anything that is not an OpenAI-style model list
 * counts as no server.
 */
export async function listLocalModels(
    port: number,
    apiKey: string | null,
): Promise<LocalModelList> {
    const stopped = { status: "stopped" as const, models: [] };
    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${String(port)}/v1/models`, {
            headers: apiKey === null ? {} : { authorization: `Bearer ${apiKey}` },
            redirect: "error",
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
    } catch {
        return stopped;
    }
    if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        return { status: "unauthorized", models: [] };
    }
    let body: unknown;
    try {
        const text = await response.text();
        body = response.ok && text.length <= MAX_RESPONSE_BYTES ? JSON.parse(text) : undefined;
    } catch {
        body = undefined;
    }
    if (!Value.Check(modelListSchema, body)) return stopped;
    return {
        status: "running",
        models: body.data
            .slice(0, MAX_MODELS)
            .map((model) => ({ id: model.id, ownedBy: model.owned_by ?? null })),
    };
}
