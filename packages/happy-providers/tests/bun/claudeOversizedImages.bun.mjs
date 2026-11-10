import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { createRootContext } from "@steve.kite/stdlib";

import { ClaudeAuthTokenCredential } from "../../sources/vendors/claude/ClaudeAuthTokenCredential.ts";
import { ClaudeSession } from "../../sources/vendors/claude/ClaudeSession.ts";
import { fitClaudeImages } from "../../sources/vendors/claude/impl/fitClaudeImages.ts";

// Claude Code refuses a request, before sending it, when any image carries more than 5 MiB of
// base64 ("Image base64 size (5.5MB) exceeds API limit (5MB)"), and it shrinks only new prompt
// images itself, never ones resumed from history. Real pictures over the limit must reach the API
// shrunk under a 4.5 MiB target wherever they sit, on Bun, which decodes them natively.
const LIMIT = 5 * 1024 * 1024;
const TARGET = 4.5 * 1024 * 1024;

// Noise barely compresses: 1200x1200 RGB is about 4.1 MiB as PNG and 5.5 MiB as base64.
const noisyPng = encodeNoisyPng(1200, 1200, 1);
const largeJpeg = await new Bun.Image(encodeNoisyPng(2400, 1800, 2))
    .jpeg({ quality: 100 })
    .buffer();
const fixtures = [
    ["noisy PNG", { type: "image", mimeType: "image/png", data: noisyPng.toString("base64") }],
    ["large JPEG", { type: "image", mimeType: "image/jpeg", data: largeJpeg.toString("base64") }],
];
for (const [, image] of fixtures) assert.ok(image.data.length > LIMIT);

const requests = [];
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
        const { pathname } = new URL(request.url);
        if (
            request.method !== "POST" ||
            !pathname.startsWith("/v1/messages") ||
            pathname.includes("count_tokens")
        ) {
            return new Response('{"type":"error","error":{"type":"not_found_error"}}', {
                status: 404,
                headers: { "content-type": "application/json" },
            });
        }
        requests.push(await request.json());
        return new Response(textResponse("It showed noise."), {
            headers: { "content-type": "text/event-stream" },
        });
    },
});
const cwd = await mkdtemp(join(tmpdir(), "rig-claude-oversized-images-"));
const credential = await ClaudeAuthTokenCredential.tryLoad({ authToken: "image-token" });
assert.notEqual(credential, null);
const ctx = createRootContext().named("bun-claude-oversized-images");

try {
    for (const [name, image] of fixtures) {
        const history = [
            { role: "user", content: [{ type: "text", text: "Here is the screenshot." }, image] },
            { role: "assistant", content: [{ type: "text", text: "Got it." }] },
            user("Take another."),
            {
                role: "assistant",
                content: [
                    { type: "tool_call", callId: "call-shot", name: "Screenshot", arguments: "{}" },
                ],
            },
            {
                role: "tool",
                callId: "call-shot",
                content: [{ type: "text", text: "Captured." }, image],
            },
            { role: "assistant", content: [{ type: "text", text: "Done." }] },
            user("What did they show?"),
        ];
        const before = JSON.stringify(history);
        const sent = await run(history);

        assert.equal(sent.length, 1, `${name}: the replayed request reaches the API`);
        const images = imagesIn(sent[0].messages);
        assert.equal(images.length, 2, `${name}: both images are still shown`);
        for (const shown of images) {
            assert.ok(shown.source.data.length <= TARGET, `${name}: the image is shrunk`);
            const decoded = await new Bun.Image(
                Buffer.from(shown.source.data, "base64"),
            ).metadata();
            assert.equal(`image/${decoded.format}`, shown.source.media_type);
            assert.ok(Math.max(decoded.width, decoded.height) <= 2000);
        }
        assert.equal(JSON.stringify(history), before, `${name}: the caller's history is unchanged`);

        const prompt = await run([
            { role: "user", content: [{ type: "text", text: "Look." }, image] },
        ]);
        assert.equal(prompt.length, 1, `${name}: a new prompt reaches the API`);
        for (const shown of imagesIn(prompt[0].messages)) {
            assert.ok(shown.source.data.length <= TARGET, `${name}: the prompt image is shrunk`);
        }
    }

    // Bytes that are no picture cannot be shrunk, so the request carries a note in their place.
    const garbage = { type: "image", mimeType: "image/png", data: "A".repeat(LIMIT + 4) };
    const sent = await run([
        { role: "user", content: [{ type: "text", text: "Look." }, garbage] },
        { role: "assistant", content: [{ type: "text", text: "Got it." }] },
        user("And now?"),
    ]);
    assert.equal(sent.length, 1);
    assert.equal(imagesIn(sent[0].messages).length, 0);
    assert.ok(
        JSON.stringify(sent[0].messages).includes(
            "[Image omitted: its base64 data is 5.1 MB, over Claude's 5 MB limit for one image.]",
        ),
    );

    // Nothing over the target leaves every message as the caller's own object.
    const small = [user("Look."), { role: "tool", callId: "call", content: [pngPixel()] }];
    const fitted = await fitClaudeImages(small);
    assert.equal(fitted[0], small[0]);
    assert.equal(fitted[1], small[1]);

    // A copy of a picture already shrunk is sent as the same bytes, so a rebuilt query keeps the
    // prompt-cache prefix it had.
    const [first] = await fitClaudeImages([{ role: "user", content: [fixtures[0][1]] }]);
    const [again] = await fitClaudeImages([
        {
            role: "user",
            content: [{ ...fixtures[0][1], data: Buffer.from(noisyPng).toString("base64") }],
        },
    ]);
    assert.deepEqual(again, first);
} finally {
    server.stop(true);
    await rm(cwd, { force: true, maxRetries: 5, recursive: true });
}

async function run(messages) {
    const session = new ClaudeSession("<SESSION_ID>", {
        instructions: "You are a careful engineer.",
        credential,
        cwd,
        env: {
            ...process.env,
            CLAUDE_CONFIG_DIR: cwd,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
            CLAUDE_CODE_OVERRIDE_DATE: "2000-01-01",
            TZ: "UTC",
        },
        model: "anthropic/opus-5-5",
        tools: [{ name: "Screenshot", description: "Capture the screen." }],
    });
    const first = requests.length;
    const events = [];
    try {
        for await (const event of session.run(ctx, {
            context: { instructions: "You are a careful engineer.", messages },
        })) {
            events.push(event);
        }
    } finally {
        session.destroy();
    }
    assert.deepEqual(
        { type: events.at(-1)?.type, state: events.at(-1)?.state, message: events.at(-1)?.message },
        { type: "done", state: "normal", message: undefined },
    );
    return requests.slice(first);
}

function user(text) {
    return { role: "user", content: [{ type: "text", text }] };
}

function pngPixel() {
    return {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    };
}

function imagesIn(messages) {
    const found = [];
    const visit = (content) => {
        if (!Array.isArray(content)) return;
        for (const block of content) {
            if (block?.type === "image") found.push(block);
            if (block?.type === "tool_result") visit(block.content);
        }
    };
    for (const message of messages) visit(message.content);
    return found;
}

/** An RGB PNG of deterministic noise, stored with almost no compression to gain. */
function encodeNoisyPng(width, height, seed) {
    let state = seed;
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let index = 0; index < raw.length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        raw[index] = index % (width * 3 + 1) === 0 ? 0 : state & 0xff;
    }
    const chunk = (type, data) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body) >>> 0);
        return Buffer.concat([length, body, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

function textResponse(text) {
    return [
        {
            type: "message_start",
            message: {
                id: "msg_oversized_images",
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 12, output_tokens: 1 },
            },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 9 },
        },
        { type: "message_stop" },
    ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join("");
}
