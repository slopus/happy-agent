import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";

import { createClaudeSessionReplay } from "../../sources/vendors/claude/impl/createClaudeSessionReplay.ts";
import { fitClaudeImages } from "../../sources/vendors/claude/impl/fitClaudeImages.ts";
import { claudeNativeCompactionContext } from "../../sources/vendors/claudeAgent/impl/claudeNativeCompactionContext.ts";

// Claude Code accepts an image up to 5 MiB of base64 in its own transcript, and a native
// checkpoint keeps that image. A rebuilt query fits every image over the 4.5 MiB target, so the
// checkpoint's projected copy of it is shrunk: the checkpoint must be checked against the history
// as stored, or every rebuilt query of the session (restart, model switch, `/compact`) refuses it.
// Only Bun decodes images, so only here does the fitting run.
const LIMIT = 5 * 1024 * 1024;
const TARGET = 4.5 * 1024 * 1024;

// Noise barely compresses: 1100x1100 RGB is about 4.6 MiB of base64 as PNG.
const png = encodeNoisyPng(1100, 1100, 3).toString("base64");
assert.ok(png.length > TARGET && png.length <= LIMIT, `the fixture is ${png.length} bytes`);
const nativeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: png },
};

const source = claudeNativeCompactionContext({
    boundaryId: "boundary",
    summaryId: "summary",
    summary: "keep the screenshots",
    preTokens: 120_000,
    messages: [
        native("prefix", "user", "Keep this prefix exactly"),
        native("summary", "user", "keep the screenshots"),
        native("shown", "user", [{ type: "text", text: "Here is the screen." }, nativeImage]),
        native("call", "assistant", [
            { type: "tool_use", id: "call-shot", name: "Screenshot", input: {} },
        ]),
        native(
            "result",
            "user",
            [{ type: "tool_result", tool_use_id: "call-shot", content: [nativeImage] }],
            { sourceToolAssistantUUID: "call" },
        ),
        native("answer", "assistant", [{ type: "text", text: "Both show the same screen." }]),
    ],
});
const nativeMessages = source.compaction.vendor.messages;
const later = { type: "image", mimeType: "image/png", data: png };
const retained = [
    ...structuredClone(source.messages),
    { role: "user", content: [{ type: "text", text: "And this one?" }, later] },
    { role: "assistant", content: [{ type: "text", text: "The same again." }] },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
];
// Base joins the checkpoint's last assistant message with the blocks that followed it: here a
// provider's inline result holding an image, which is sent from this request's copy, fitted.
const joined = retained[source.messages.length - 1];
assert.equal(joined.role, "assistant", "the checkpoint ends on Claude's answer");
joined.content.push({ type: "tool_result", callId: "call-inline", content: [later] });
const before = JSON.stringify(retained);

const fitted = await fitClaudeImages(retained);
const shrunk = imagesInSession(fitted);
assert.equal(shrunk.length, 4, "every image is still in this request's copy");
for (const image of shrunk) assert.ok(image.data.length <= TARGET, "and each is fitted");

const rows = replay({ context: { instructions: "", messages: fitted }, retained });
assert.equal(JSON.stringify(retained), before, "the history as stored is unchanged");

// The checkpoint replays Claude Code's own entries, with the image bytes it accepted.
assert.deepEqual(
    rows.slice(0, nativeMessages.length).map((row) => row.message),
    nativeMessages.map((row) => row.message),
);
assert.deepEqual(
    rows.slice(0, nativeMessages.length).map((row) => row.uuid),
    nativeMessages.map((row) => row.uuid),
);
// The work after it is sent from this request's copy, its images fitted: the blocks joined to
// the checkpoint's last answer as well as the later turns.
const after = rows.slice(nativeMessages.length).map((row) => row.message);
assert.equal(after[0].content[0].type, "tool_result", "the joined result follows the checkpoint");
const sent = imagesInSdk(after);
assert.equal(sent.length, 2, "the joined and the later image are still shown");
for (const image of sent) assert.ok(image.source.data.length <= TARGET, "and each is fitted");
assert.equal(JSON.stringify(rows).includes(png), true, "the checkpoint keeps its own image");

// Checked against this request's copy instead, the shrunk images cannot match the checkpoint.
assert.throws(
    () => replay({ context: { instructions: "", messages: fitted } }),
    /native checkpoint does not match its retained history/,
);
// A stored history that is not the one the copy was fitted from is refused.
assert.throws(
    () =>
        replay({ context: { instructions: "", messages: fitted }, retained: retained.slice(1) }),
    /does not match the history it was fitted from/,
);

function replay(options) {
    return createClaudeSessionReplay({
        ...options,
        model: "claude-sonnet-5",
        sessionId: "11111111-1111-4111-8111-111111111111",
    })
        .entries()
        .filter((entry) => entry.type === "user" || entry.type === "assistant");
}

function native(uuid, type, content, metadata = {}) {
    return {
        ...metadata,
        uuid,
        type,
        session_id: "old-session",
        message: { role: type, content },
        parent_tool_use_id: null,
        parent_agent_id: null,
    };
}

function imagesInSession(messages) {
    return messages.flatMap((message) =>
        Array.isArray(message.content)
            ? message.content.flatMap((block) =>
                  block.type === "image"
                      ? [block]
                      : block.type === "tool_result"
                        ? block.content.filter((inner) => inner.type === "image")
                        : [],
              )
            : [],
    );
}

function imagesInSdk(messages) {
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
