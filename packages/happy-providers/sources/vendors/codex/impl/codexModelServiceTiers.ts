import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CodexProviderCredential } from "@/vendors/VendorCredential.js";
import { CodexSessionCredential } from "@/vendors/codex/CodexSessionCredential.js";

const catalogSchema = Type.Object({
    models: Type.Array(
        Type.Object({
            slug: Type.String(),
            service_tiers: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))),
        }),
    ),
});
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;

/** Capability identity is deliberately opaque and changes when the stored login rotates. */
export async function codexServiceTierAccountKey(
    credential: CodexProviderCredential,
): Promise<string | null> {
    const current = await currentCredential(credential);
    return current === null
        ? null
        : createHash("sha256")
              .update(
                  JSON.stringify([current.credential.accountId, current.credential.accessToken]),
              )
              .digest("hex");
}

/** Read capabilities for caller-owned model IDs, never turn a remote catalog into model discovery. */
export async function codexModelServiceTiers(options: {
    credential: CodexProviderCredential;
    endpoint: string;
    modelIds: readonly string[];
    userAgent: string;
    signal?: AbortSignal;
}): Promise<Readonly<Record<string, readonly string[]>>> {
    if (options.signal?.aborted || options.modelIds.length === 0) return {};
    const credential = await currentCredential(options.credential);
    if (credential === null) return {};
    const timeout = AbortSignal.timeout(10_000);
    const signal =
        options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    try {
        const url = new URL(`${options.endpoint.replace(/\/$/u, "")}/codex/models`);
        url.searchParams.set(
            "client_version",
            /codex_exec\/([^\s]+)/u.exec(options.userAgent)?.[1] ?? "unknown",
        );
        const response = await fetch(url, {
            headers: {
                authorization: `Bearer ${credential.credential.accessToken}`,
                "chatgpt-account-id": credential.credential.accountId!,
                originator: "codex_exec",
                "user-agent": options.userAgent,
            },
            redirect: "error",
            signal,
        });
        if (!response.ok || response.body === null) {
            await response.body?.cancel();
            return {};
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) break;
                bytes += next.value.byteLength;
                if (bytes > MAX_CATALOG_BYTES) {
                    await reader.cancel();
                    return {};
                }
                chunks.push(next.value);
            }
        } finally {
            reader.releaseLock();
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!Value.Check(catalogSchema, parsed)) return {};
        const result: Record<string, readonly string[]> = {};
        for (const modelId of options.modelIds) {
            const entry = parsed.models.find(
                (model) => model.slug === modelId.replace(/^openai\//u, ""),
            );
            if (entry?.service_tiers === undefined) continue;
            result[modelId] = [
                ...new Set(
                    entry.service_tiers
                        .map((tier) => tier.id)
                        .filter((tier) => tier === "priority" || tier === "ultrafast"),
                ),
            ];
        }
        // Never grant a capability observed while the stored account was being replaced.
        const current = await currentCredential(options.credential);
        if (current?.credential.accessToken !== credential.credential.accessToken) return {};
        return result;
    } catch {
        // Catalog availability is optional. Do not expose vendor diagnostics or credentials.
        return {};
    }
}

async function currentCredential(
    credential: CodexProviderCredential,
): Promise<CodexSessionCredential | null> {
    if (
        !(credential instanceof CodexSessionCredential) ||
        credential.credential.accountId === undefined
    )
        return null;
    try {
        const current = await CodexSessionCredential.tryLoad({ authFile: credential.authFile });
        return current?.credential.accountId === credential.credential.accountId ? current : null;
    } catch {
        return null;
    }
}
