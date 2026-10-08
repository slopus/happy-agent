import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createGym, type HttpResponseReplacement } from "@slopus/happy-terminal-gym";

/** Claude accepts at most 2000 pixels per side once a request carries more than 20 images. */
const MANY_IMAGE_LIMIT = 20;
const MANY_IMAGE_MAX_DIMENSION = 2000;
const SCREENSHOT_COUNT = MANY_IMAGE_LIMIT + 1;

interface BedrockRequest {
    messages: { role: string; content: unknown }[];
}

describe("Claude on Bedrock reading many large screenshots", () => {
    it("sends every screenshot within Claude's many-image size limit", async () => {
        const requests: BedrockRequest[] = [];
        const screenshot = solidPng(2400, 1350);
        const files = Object.fromEntries(
            Array.from({ length: SCREENSHOT_COUNT }, (_, index) => [
                `out/step-${String(index + 1).padStart(2, "0")}.png`,
                screenshot,
            ]),
        );
        const reads = Object.keys(files).map((path, index) => ({
            type: "tool_use",
            id: `toolu_read_screenshot_${String(index + 1)}`,
            name: "Read",
            input: { file_path: `/workspace/${path}` },
        }));
        const gym = await createGym({
            mode: "docker",
            providerId: "bedrock",
            modelId: "anthropic/fable-5-1",
            rows: 50,
            files,
            environment: { AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token" },
            homeFiles: {
                "happy/config/happy.toml": [
                    "[settings]",
                    "inference_max_retries = 0",
                    "[providers]",
                    "default_enable = false",
                    "[providers.bedrock]",
                    "enabled = true",
                    'region = "us-east-1"',
                    '[providers.bedrock.model_overrides."anthropic/fable-5-1"]',
                    'endpoint = "http://bedrock.gym.test"',
                    'transport = "runtime"',
                ].join("\n"),
            },
            httpProxy: {
                handler(request) {
                    if (!new URL(request.url).pathname.endsWith("/invoke-with-response-stream")) {
                        return {
                            response: { status: 404, body: "Only scripted inference is allowed." },
                        };
                    }
                    const body = Buffer.from(request.body).toString();
                    if (body.includes("Create a concise session title")) {
                        return { response: responseFor([{ type: "text", text: "Screenshots" }]) };
                    }
                    const parsed = JSON.parse(body) as BedrockRequest;
                    requests.push(parsed);
                    const rejection = manyImageRejection(parsed);
                    if (rejection !== undefined) return { response: rejection };
                    if (requests.length === 1) {
                        return { response: responseFor(reads, "tool_use") };
                    }
                    return {
                        response: responseFor([{ type: "text", text: "SCREENSHOTS_REVIEWED" }]),
                    };
                },
            },
        });
        try {
            gym.terminal.type("Review every screenshot in out/.");
            gym.terminal.press("enter");
            const finished = await gym.terminal.waitUntil(
                (screen) =>
                    (screen.text.includes("SCREENSHOTS_REVIEWED") ||
                        screen.text.includes("many-image")) &&
                    !screen.text.includes("esc to interrupt"),
                "the screenshot review to settle",
                60_000,
            );
            expect(finished.text).not.toContain("many-image");
            expect(finished.text).toContain("SCREENSHOTS_REVIEWED");
            expect(requests).toHaveLength(2);
            const images = imageDimensions(requests[1]!);
            expect(images).toHaveLength(SCREENSHOT_COUNT);
            for (const image of images) {
                expect(image).toEqual({ width: 2000, height: 1125 });
            }
            expect(JSON.stringify(requests[1])).toContain("original 2400×1350, shown at 2000×1125");
        } finally {
            await gym.dispose();
        }
    }, 120_000);
});

/** The rejection Claude returns when a many-image request holds an image that is too large. */
function manyImageRejection(request: BedrockRequest): HttpResponseReplacement | undefined {
    const images = imageDimensions(request);
    if (images.length <= MANY_IMAGE_LIMIT) return undefined;
    if (
        images.every(
            (image) =>
                image.width <= MANY_IMAGE_MAX_DIMENSION && image.height <= MANY_IMAGE_MAX_DIMENSION,
        )
    ) {
        return undefined;
    }
    return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            type: "error",
            error: {
                type: "invalid_request_error",
                message: `At least one of the image dimensions exceed max allowed size for many-image requests: ${String(MANY_IMAGE_MAX_DIMENSION)} pixels`,
            },
        }),
    };
}

/** The size of every PNG image in a request, including those inside tool results. */
function imageDimensions(request: BedrockRequest): { width: number; height: number }[] {
    const found: { width: number; height: number }[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (typeof value !== "object" || value === null) return;
        const block = value as {
            type?: unknown;
            source?: { data?: unknown };
            content?: unknown;
        };
        if (block.type === "image" && typeof block.source?.data === "string") {
            const png = Buffer.from(block.source.data, "base64");
            found.push({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
            return;
        }
        visit(block.content);
    };
    for (const message of request.messages) visit(message.content);
    return found;
}

/** A single-colour RGB PNG of the given size, like a large blank screenshot. */
function solidPng(width: number, height: number): Uint8Array {
    const row = Buffer.alloc(1 + width * 3, 0xd0);
    row[0] = 0;
    const pixels = Buffer.concat(Array.from({ length: height }, () => row));
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(pixels)),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([length, typed, checksum]);
}

function responseFor(
    blocks: readonly Record<string, unknown>[],
    stopReason = "end_turn",
): HttpResponseReplacement {
    const events: Record<string, unknown>[] = [
        {
            type: "message_start",
            message: {
                id: "msg_many_screenshots",
                type: "message",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 100, output_tokens: 1 },
            },
        },
    ];
    for (const [index, content_block] of blocks.entries()) {
        events.push({ type: "content_block_start", index, content_block });
        events.push({ type: "content_block_stop", index });
    }
    events.push(
        {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: 20 },
        },
        { type: "message_stop" },
    );
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
    };
}
