#!/usr/bin/env node

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const serviceTierSchema = Type.Union([Type.Literal("priority"), Type.Literal("ultrafast")]);
const completedSchema = Type.Object({
    type: Type.Literal("response.completed"),
    response: Type.Object({
        model: Type.String(),
        service_tier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
});
const modelCacheSchema = Type.Object({
    models: Type.Array(
        Type.Object({
            slug: Type.String(),
            service_tiers: Type.Optional(Type.Array(Type.Object({ id: Type.String() }))),
        }),
    ),
});

const SUPPORTED_MODELS = new Set([
    "gpt-5.5",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
]);
const REASONING_EFFORT = "low";
const PROMPT = "Reply with OK.";
const CAPTURE_TIMEOUT_MS = 120_000;
const CODEX_UPSTREAM = "https://chatgpt.com/backend-api/codex";

const outputArgument = process.argv[2];
const model = process.argv[3];
const serviceTier = process.argv[4];
const codexBinary = process.env.CODEX_CAPTURE_BINARY || "codex";
if (outputArgument === undefined || model === undefined) {
    throw new Error(
        "Usage: node captureCodexSseTrace.mjs <output.json> <model> [priority|ultrafast]",
    );
}
if (!SUPPORTED_MODELS.has(model)) throw new Error(`Unsupported capture model '${model}'.`);
if (serviceTier !== undefined && !Value.Check(serviceTierSchema, serviceTier)) {
    throw new Error("Unsupported capture service tier.");
}

const outputPath = resolve(outputArgument);
const sourceCodexHome = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
if (serviceTier !== undefined) {
    const cache = JSON.parse(await readFile(join(sourceCodexHome, "models_cache.json"), "utf8"));
    if (
        !Value.Check(modelCacheSchema, cache) ||
        !cache.models.some(
            (entry) =>
                entry.slug === model &&
                entry.service_tiers?.some((tier) => tier.id === serviceTier),
        )
    ) {
        throw new Error(
            "The native model cache does not advertise the requested tier; no inference was run.",
        );
    }
}
const captureDirectory = await mkdtemp(`${tmpdir()}/rig-codex-sse-capture-`);
const isolatedCodexHome = join(captureDirectory, "codex-home");
await mkdir(isolatedCodexHome);
await copyFile(join(sourceCodexHome, "auth.json"), join(isolatedCodexHome, "auth.json"));
if (serviceTier !== undefined) {
    // Keep the native account's advertised model capabilities: an empty isolated cache would
    // make Codex filter out a new tier before the request ever reaches the capture proxy.
    await copyFile(
        join(sourceCodexHome, "models_cache.json"),
        join(isolatedCodexHome, "models_cache.json"),
    );
}

let resolveCapture;
let rejectCapture;
const capture = new Promise((resolvePromise, rejectPromise) => {
    resolveCapture = resolvePromise;
    rejectCapture = rejectPromise;
});
const server = createServer(async (request, response) => {
    try {
        if (request.method !== "POST") {
            response.writeHead(404).end();
            return;
        }
        const requestBytes = await readBody(request);
        const body = JSON.parse(
            decodeRequestBody(requestBytes, request.headers["content-encoding"]),
        );
        const upstream = await fetch(`${CODEX_UPSTREAM}${upstreamPath(request.url)}`, {
            method: "POST",
            headers: upstreamHeaders(request.headers),
            body: requestBytes,
        });
        const responseBytes = Buffer.from(await upstream.arrayBuffer());
        const trace = normalizeTrace(
            {
                formatVersion: 1,
                source: {
                    client: "codex-cli",
                    version: await codexVersion(),
                    transport: "sse",
                    capture: "forwarded-live-inference",
                },
                invocation: {
                    model,
                    reasoningEffort: REASONING_EFFORT,
                    prompt: PROMPT,
                    ...(serviceTier === undefined ? {} : { serviceTier }),
                },
                http: {
                    method: request.method,
                    path: request.url,
                    headers: sanitizeHeaders(request.headers),
                },
                request: body,
                response: summarizeSseResponse(responseBytes.toString("utf8")),
            },
            captureDirectory,
        );
        await writeFile(outputPath, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
        const tools = extractToolDefinitions(trace.request);
        await writeFile(toolsOutputPath(outputPath), `${JSON.stringify(tools, null, 2)}\n`, "utf8");
        response.writeHead(upstream.status, relayResponseHeaders(upstream.headers));
        response.end(responseBytes);
        resolveCapture();
    } catch (error) {
        rejectCapture(error);
        response.writeHead(500).end();
    }
});
server.on("error", rejectCapture);
server.listen(0, "127.0.0.1");
const port = await listeningPort(server);

const codex = spawn(
    codexBinary,
    [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--json",
        "--cd",
        captureDirectory,
        "--model",
        model,
        "--config",
        serviceTier === undefined ? 'model_provider="capture"' : 'model_provider="openai"',
        "--config",
        `model_reasoning_effort="${REASONING_EFFORT}"`,
        ...(serviceTier === undefined ? [] : ["--config", `service_tier="${serviceTier}"`]),
        "--config",
        `model_providers.${serviceTier === undefined ? "capture" : "openai"}={name="OpenAI",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
        PROMPT,
    ],
    {
        env: {
            CODEX_HOME: isolatedCodexHome,
            HOME: homedir(),
            LANG: process.env.LANG ?? "en_US.UTF-8",
            PATH: process.env.PATH,
            TMPDIR: tmpdir(),
        },
        stdio: ["ignore", "ignore", "pipe"],
    },
);
let stderr = "";
codex.stderr.setEncoding("utf8");
codex.stderr.on("data", (chunk) => {
    stderr += chunk;
});
codex.on("error", rejectCapture);
const timeout = setTimeout(
    () =>
        rejectCapture(
            new Error(`Codex did not send an SSE request within ${CAPTURE_TIMEOUT_MS}ms.`),
        ),
    CAPTURE_TIMEOUT_MS,
);

try {
    await capture;
    process.stdout.write(`Captured ${model} ${REASONING_EFFORT} SSE request to ${outputPath}\n`);
} catch (error) {
    throw new Error(
        `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`,
    );
} finally {
    clearTimeout(timeout);
    if (codex.exitCode === null) codex.kill("SIGTERM");
    server.close();
    await rm(captureDirectory, { force: true, recursive: true });
}

function readBody(request) {
    return new Promise((resolvePromise, rejectPromise) => {
        const chunks = [];
        request.on("data", (chunk) => {
            chunks.push(chunk);
        });
        request.once("end", () => resolvePromise(Buffer.concat(chunks)));
        request.once("error", rejectPromise);
    });
}

function decodeRequestBody(bytes, encoding) {
    if (encoding === "zstd") return zstdDecompressSync(bytes).toString("utf8");
    if (encoding === "gzip") return gunzipSync(bytes).toString("utf8");
    if (encoding === undefined || encoding === "identity") return bytes.toString("utf8");
    throw new Error(`Unsupported Codex request content encoding '${encoding}'.`);
}

function listeningPort(httpServer) {
    return new Promise((resolvePromise, rejectPromise) => {
        httpServer.once("listening", () => {
            const address = httpServer.address();
            if (typeof address !== "object" || address === null) {
                rejectPromise(new Error("SSE capture server did not bind a TCP port."));
            } else resolvePromise(address.port);
        });
        httpServer.once("error", rejectPromise);
    });
}

async function codexVersion() {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(codexBinary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
        });
        child.once("error", rejectPromise);
        child.once("close", (code) =>
            code === 0
                ? resolvePromise(stdout.trim())
                : rejectPromise(new Error(`codex --version exited with ${code}.`)),
        );
    });
}

function sanitizeHeaders(headers) {
    const stableHeaders = new Set([
        "accept",
        "content-type",
        "originator",
        "user-agent",
        "x-codex-beta-features",
        "x-codex-routing-hint",
        "x-openai-internal-codex-responses-lite",
    ]);
    return Object.fromEntries(
        Object.entries(headers).filter(
            ([name, value]) => value !== undefined && stableHeaders.has(name.toLowerCase()),
        ),
    );
}

function normalizeTrace(trace, temporaryDirectory) {
    const normalized = structuredClone(trace);
    const request = normalized.request;
    if ("prompt_cache_key" in request) request.prompt_cache_key = "<SESSION_ID>";
    if (request.client_metadata !== undefined) {
        request.client_metadata = Object.fromEntries(
            Object.keys(request.client_metadata).map((key) => [key, `<DYNAMIC:${key}>`]),
        );
    }
    for (const item of request.input ?? []) {
        if (item?.type !== "message" || !Array.isArray(item.content)) continue;
        for (const content of item.content) {
            if (content?.type !== "input_text" || content.text === PROMPT) continue;
            content.text = content.text
                .replaceAll(temporaryDirectory, "<CAPTURE_DIRECTORY>")
                .replaceAll(homedir(), "<HOME>")
                .replace(
                    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
                    "<UUID>",
                );
        }
    }
    return normalized;
}

function extractToolDefinitions(request) {
    if (Array.isArray(request.tools)) return request.tools;
    const additionalTools = request.input?.find((item) => item?.type === "additional_tools");
    if (Array.isArray(additionalTools?.tools)) return additionalTools.tools;
    throw new Error("Codex SSE request did not contain tool definitions.");
}

function toolsOutputPath(traceOutputPath) {
    return traceOutputPath.endsWith(".sse.json")
        ? traceOutputPath.replace(/\.sse\.json$/u, ".sse.tools.json")
        : `${traceOutputPath}.tools.json`;
}

function upstreamPath(path) {
    return (path ?? "/responses").replace(/^\/v1(?=\/|$)/u, "");
}

function upstreamHeaders(headers) {
    return Object.fromEntries(
        Object.entries(headers)
            .filter(
                ([name, value]) =>
                    value !== undefined &&
                    !["connection", "content-length", "host", "transfer-encoding"].includes(
                        name.toLowerCase(),
                    ),
            )
            .map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : value]),
    );
}

function relayResponseHeaders(headers) {
    return Object.fromEntries(
        [...headers.entries()].filter(
            ([name]) =>
                !["connection", "content-encoding", "content-length", "transfer-encoding"].includes(
                    name.toLowerCase(),
                ),
        ),
    );
}

function summarizeSseResponse(text) {
    let completed;
    const eventTypes = text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .filter((data) => data !== "[DONE]")
        .flatMap((data) => {
            try {
                const event = JSON.parse(data);
                if (Value.Check(completedSchema, event)) {
                    completed = {
                        model: event.response.model,
                        serviceTier: event.response.service_tier ?? null,
                    };
                }
                return [event.type];
            } catch {
                return [];
            }
        });
    return {
        eventTypes,
        ...(serviceTier === undefined ? {} : { completed }),
        terminal:
            eventTypes.findLast((type) =>
                ["response.completed", "response.failed", "response.incomplete", "error"].includes(
                    type,
                ),
            ) ?? null,
    };
}
