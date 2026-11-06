import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders } from "@slopus/happy-agent-base";
import {
    BaseProvider,
    BaseSession,
    EMPTY_SESSION_USAGE,
    type SessionCompaction,
    type SessionCompactionOptions,
    type SessionContext,
    type SessionImageBlock,
    type SessionMessage,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
} from "@slopus/happy-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { imagesByReference } from "../../sources/config/impl/imagesByReference.js";
import { providerRegistryUntil } from "../../sources/config/impl/providerRegistryUntil.js";
import { pruneImageCache } from "../../sources/config/impl/pruneImageCache.js";

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("images a person or agent sent reach the model by reference", () => {
    it("saves each sent image once and replays the same reference on every run", async () => {
        const pasted = image("pasted screenshot");
        const toolImage = image("what Read showed");
        const history: SessionMessage[] = [
            { role: "user", content: [{ type: "text", text: "Two screenshots:" }, pasted, pasted] },
            { role: "assistant", content: [{ type: "text", text: "Got them." }] },
            {
                role: "agent",
                author: { id: "child", description: "A subtask" },
                content: [{ type: "text", text: "Here is mine." }, pasted],
            },
            { role: "tool", callId: "call-1", content: [toolImage] },
            { role: "user", content: [{ type: "text", text: "yo" }] },
        ];
        const snapshot = structuredClone(history);
        const { provider, session, attachments } = await registeredSession();

        await drain(provider.run(createRootContext(), request(history)));
        await drain(provider.run(createRootContext(), request(history)));

        const [saved] = await readdir(attachments);
        expect(await readdir(attachments)).toHaveLength(1);
        expect(saved).toMatch(/^[0-9a-f]{64}\.png$/u);
        expect(await readFile(join(attachments, saved!))).toEqual(
            Buffer.from(pasted.data, "base64"),
        );
        const sent = session.runs[0]!.context.messages;
        const reference = `[Image attached here, saved at ${join(attachments, saved!)} (image/png, 17 bytes). It is not shown inline; open the file with your file-reading tool to see it.]`;
        expect(sent[0]).toEqual({
            role: "user",
            content: [
                { type: "text", text: "Two screenshots:" },
                { type: "text", text: reference },
                { type: "text", text: reference },
            ],
        });
        expect(sent[2]).toMatchObject({ content: [{}, { type: "text", text: reference }] });
        // What a reading tool returned was already sized for the model and stays inline.
        expect(sent[3]).toBe(history[3]);
        expect(sent[1]).toBe(history[1]);
        expect(session.runs[1]!.context.messages).toEqual(sent);
        expect(history).toEqual(snapshot);
    });

    it("leaves a request without sent images exactly as it was", async () => {
        const { provider, session } = await registeredSession();
        const sent = request([{ role: "user", content: [{ type: "text", text: "yo" }] }]);

        await drain(provider.run(createRootContext(), sent));

        expect(session.runs[0]).toBe(sent);
    });

    it("compacts with references in place of sent images", async () => {
        const { provider, session, attachments } = await registeredSession();

        await provider.compact(createRootContext(), {
            context: { instructions: "", messages: [{ role: "user", content: [image("a")] }] },
        });

        const [saved] = await readdir(attachments);
        expect(session.compactions[0]!.messages[0]).toMatchObject({
            content: [{ type: "text", text: expect.stringContaining(join(attachments, saved!)) }],
        });
    });

    it("writes a removed copy again from history under the same path", async () => {
        const { provider, session, attachments } = await registeredSession();
        const history: SessionMessage[] = [{ role: "user", content: [image("pruned")] }];

        await drain(provider.run(createRootContext(), request(history)));
        const [saved] = await readdir(attachments);
        await rm(join(attachments, saved!));
        await drain(provider.run(createRootContext(), request(history)));

        expect(await readdir(attachments)).toEqual([saved]);
        expect(await readFile(join(attachments, saved!), "utf8")).toBe("pruned");
        expect(session.runs[1]!.context.messages).toEqual(session.runs[0]!.context.messages);
    });

    it("renews the modification time of a copy a request names", async () => {
        const directory = join(await temporaryRoot(), "images");
        const context = {
            instructions: "",
            messages: [{ role: "user" as const, content: [image("kept")] }],
        };
        await imagesByReference(context, directory);
        const [saved] = await readdir(directory);
        const path = join(directory, saved!);
        const old = new Date(Date.now() - 200 * DAY);
        await utimes(path, old, old);

        await imagesByReference(context, directory);

        expect(Date.now() - (await stat(path)).mtimeMs).toBeLessThan(DAY);
        expect(await pruneImageCache(directory)).toBe(0);
        expect(await readdir(directory)).toEqual([saved]);
    });
});

describe("pruning the image cache", () => {
    it("removes only copies no request has named for 180 days", async () => {
        const directory = await temporaryRoot();
        const now = Date.now();
        for (const [name, ageDays] of [
            ["stale.png", 181],
            ["recent.png", 179],
            ["fresh.png", 0],
        ] as const) {
            await writeFile(join(directory, name), name);
            const time = new Date(now - ageDays * DAY);
            await utimes(join(directory, name), time, time);
        }

        expect(await pruneImageCache(directory, now)).toBe(1);
        expect((await readdir(directory)).sort()).toEqual(["fresh.png", "recent.png"]);
    });

    it("has nothing to do before any image was saved", async () => {
        expect(await pruneImageCache(join(await temporaryRoot(), "missing"))).toBe(0);
    });
});

const DAY = 24 * 60 * 60 * 1000;

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "happy-image-cache-"));
    directories.push(root);
    return root;
}

function image(text: string): SessionImageBlock {
    return { type: "image", mimeType: "image/png", data: Buffer.from(text).toString("base64") };
}

function request(messages: readonly SessionMessage[]): SessionRunRequest {
    return { context: { instructions: "", messages }, model: "test/model" };
}

async function registeredSession(): Promise<{
    provider: BaseSession;
    session: RecordingSession;
    attachments: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "happy-image-cache-"));
    directories.push(root);
    const attachments = join(root, "cache", "images");
    const session = new RecordingSession("agent-1");
    const source = new AgentProviders();
    source.add("test", new RecordingProvider(session), "claude");
    const providers = providerRegistryUntil(
        source,
        new AbortController().signal,
        undefined,
        undefined,
        undefined,
        attachments,
    );
    const provider = await providers.resolve("test", "test/model");
    if (provider === null) throw new Error("The wrapped provider was not found.");
    return {
        provider: await provider.session("agent-1", { instructions: "", tools: [] }),
        session,
        attachments,
    };
}

async function drain(stream: SessionStream): Promise<void> {
    for await (const _event of stream);
}

class RecordingProvider extends BaseProvider {
    static override readonly name = "recording";
    static override readonly inputTypes = ["text", "image"] as const;
    static override readonly outputTypes = ["text"] as const;

    readonly #session: RecordingSession;

    constructor(session: RecordingSession) {
        super();
        this.#session = session;
    }

    async session(_id: string, _options: SessionOptions): Promise<BaseSession> {
        return this.#session;
    }
}

class RecordingSession extends BaseSession {
    readonly runs: SessionRunRequest[] = [];
    readonly compactions: SessionContext[] = [];

    constructor(id: string) {
        super(id);
    }

    run(_ctx: Context, request: SessionRunRequest): SessionStream {
        this.runs.push(request);
        return (async function* () {
            yield { type: "done" as const, state: "cancelled" as const };
        })();
    }

    async compact(_ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        this.compactions.push(options.context);
        const preservedMessages = options.context.messages;
        return {
            status: "completed",
            summary: "Summary.",
            preservedMessages,
            usage: EMPTY_SESSION_USAGE,
            context: { instructions: options.context.instructions, messages: preservedMessages },
        };
    }

    destroy(): void {}
}
