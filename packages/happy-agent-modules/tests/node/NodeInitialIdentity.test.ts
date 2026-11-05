import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgentDatabaseConnection } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import type { BotsModule } from "../../sources/bots/index.js";
import { ConfigModule } from "../../sources/config/index.js";
import type { ComputeModule } from "../../sources/compute/index.js";
import type { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { normalizeManagedImage } from "../../sources/impl/images/normalizeManagedImage.js";
import { NodeModule } from "../../sources/node/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

type Command = (file: string, args: readonly string[]) => Promise<string>;
const macos = vi.hoisted(() => ({
    command: undefined as Command | undefined,
    calls: [] as { file: string; args: readonly string[] }[],
}));

// Only the macOS system tools are scripted; every other process runs normally.
vi.mock("node:child_process", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:child_process")>();
    const { promisify: promisifyOriginal } = await import("node:util");
    const execFile = ((...args: Parameters<typeof original.execFile>) =>
        original.execFile(...args)) as typeof original.execFile;
    Object.assign(execFile, {
        [promisifyOriginal.custom]: async (
            file: string,
            args: readonly string[],
            options: object,
        ) => {
            if (!file.startsWith("/usr/")) {
                return await promisifyOriginal(original.execFile)(file, args, options);
            }
            macos.calls.push({ file, args });
            if (macos.command === undefined) throw new Error(`Unexpected ${file}`);
            return { stdout: await macos.command(file, args), stderr: "" };
        },
    });
    return { ...original, execFile };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
    Object.defineProperty(process, "platform", platform);
    macos.command = undefined;
    macos.calls.length = 0;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function installation(configToml = '[node]\nname = "Studio"\n') {
    const root = await mkdtemp(join(tmpdir(), "node-initial-"));
    cleanups.push(() => rm(root, { force: true, recursive: true }));
    const directory = join(root, process.platform === "darwin" ? "Happy/Config" : "happy/config");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "happy.toml"), configToml);
    const config = await ConfigModule.load(join(root, ".happy"));
    const db = moduleDatabase(new NodeModule(...modules(config)).migrations, "node-initial-test");
    ensureAgentDatabaseConnection(db.database);
    cleanups.push(() => db.close());
    await db.ready;
    return {
        root,
        db,
        /** One daemon start against this installation's database. */
        start: async () => {
            const node = new NodeModule(...modules(config));
            await node.beforeStart(db.context);
            return node;
        },
    };
}

function modules(config: ConfigModule) {
    const bots = { forAgent: async (_ctx: Context) => undefined } as unknown as BotsModule;
    const durable = { register: vi.fn(), invoke: vi.fn() };
    return [
        config,
        bots,
        {} as ComputeModule,
        durable as unknown as DurableFunctionsModule,
    ] as const;
}

function onMac(command: Command) {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    macos.command = command;
}

/** `dscl` prints binary attributes as space-separated hex groups on an indented line. */
function dsclHex(key: string, bytes: Buffer): string {
    const groups = bytes.toString("hex").match(/.{1,8}/g)!;
    return `${key}:\n ${groups.join(" ")}\n`;
}

function missing(key: string): never {
    throw Object.assign(new Error(`No such key: ${key}`), { code: 181 });
}

async function picture(format: "png" | "jpeg" | "webp" | "tiff", background = "red") {
    return await sharp({ create: { width: 40, height: 30, channels: 3, background } })
        .toFormat(format)
        .toBuffer();
}

async function expectedThumbhash(bytes: Buffer) {
    return (await normalizeManagedImage(bytes)).thumbhash;
}

it("adopts the account photo and computer name when a Mac installation first starts", async () => {
    const photo = await picture("jpeg");
    const user = (await import("node:os")).userInfo().username;
    const f = await installation("");
    onMac(async (file, args) => {
        if (file === "/usr/sbin/scutil") return "Steve’s MacBook Pro\n";
        if (args.at(-1) === "JPEGPhoto") return dsclHex("JPEGPhoto", photo);
        return missing(args.at(-1)!);
    });
    const node = await f.start();
    expect(await node.get(f.db.context)).toEqual({
        name: "Steve’s MacBook Pro",
        avatar: { thumbhash: await expectedThumbhash(photo) },
    });
    expect(macos.calls).toContainEqual({
        file: "/usr/bin/dscl",
        args: [".", "-read", `/Users/${user}`, "JPEGPhoto"],
    });
});

it("converts other photo formats with sips into a temporary directory it removes", async () => {
    const tiff = await picture("tiff", "blue");
    const png = await picture("png", "blue");
    const f = await installation();
    let input = "";
    onMac(async (file, args) => {
        if (file === "/usr/bin/dscl") return dsclHex("JPEGPhoto", tiff);
        expect(file).toBe("/usr/bin/sips");
        expect(args.slice(0, 3)).toEqual(["-s", "format", "png"]);
        input = args[3]!;
        await writeFile(args[5]!, png);
        return "";
    });
    const node = await f.start();
    expect((await node.get(f.db.context)).avatar).toEqual({
        thumbhash: await expectedThumbhash(png),
    });
    await expect(access(input)).rejects.toThrow();
});

it("falls back to the account Picture file when there is no photo", async () => {
    const png = await picture("png", "green");
    const f = await installation();
    const path = "/Library/User Pictures/Animals/Eagle.heic";
    onMac(async (file, args) => {
        if (args.at(-1) === "JPEGPhoto") return missing("JPEGPhoto");
        if (args.at(-1) === "Picture") return `Picture:\n ${path}\n`;
        expect(args[3]).toBe(path);
        await writeFile(args[5]!, png);
        return "";
    });
    const node = await f.start();
    expect((await node.get(f.db.context)).avatar).toEqual({
        thumbhash: await expectedThumbhash(png),
    });
});

it("never replaces an existing node's name or avatar on later starts", async () => {
    const f = await installation();
    onMac(async (_file, args) => missing(args.at(-1)!));
    const first = await f.start();
    expect(await first.get(f.db.context)).toEqual({ name: "Studio", avatar: null });
    await first.setName(f.db.context, "Renamed");
    const photo = await picture("png");
    macos.calls.length = 0;
    onMac(async () => dsclHex("JPEGPhoto", photo));
    const later = await f.start();
    expect(await later.get(f.db.context)).toEqual({ name: "Renamed", avatar: null });
    expect(macos.calls).toEqual([]);
});

it("seeds exactly one state when installations start concurrently", async () => {
    const f = await installation();
    let call = 0;
    const photos = [await picture("png", "red"), await picture("png", "blue")];
    onMac(async (_file, args) =>
        args.at(-1) === "JPEGPhoto" ? dsclHex("JPEGPhoto", photos[call++ % 2]!) : "",
    );
    const [a, b] = await Promise.all([f.start(), f.start()]);
    const state = await a.get(f.db.context);
    expect(await b.get(f.db.context)).toEqual(state);
    expect(state.avatar).not.toBeNull();
});

it.each<[string, Command]>([
    [
        "directory reads fail",
        async (_file: string, args: readonly string[]) => missing(args.at(-1)!),
    ],
    [
        "commands time out",
        async () => {
            throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" });
        },
    ],
    ["the photo is not hex", async () => "JPEGPhoto:\n not an image\n"],
    ["the photo cannot be decoded", async () => dsclHex("JPEGPhoto", Buffer.from("garbage"))],
    [
        "the photo is a corrupt JPEG",
        async () => dsclHex("JPEGPhoto", Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3])),
    ],
    [
        "the Picture file is in a privacy-protected folder",
        async (file: string, args: readonly string[]) => {
            if (file === "/usr/bin/sips") throw new Error("A protected file must not be opened");
            return args.at(-1) === "JPEGPhoto"
                ? missing("JPEGPhoto")
                : "Picture:\n /Users/steve/Downloads/me.heic\n";
        },
    ],
    [
        "the Picture path escapes the picture library",
        async (file: string, args: readonly string[]) => {
            if (file === "/usr/bin/sips") throw new Error("A protected file must not be opened");
            return args.at(-1) === "JPEGPhoto"
                ? missing("JPEGPhoto")
                : "Picture:\n /Library/User Pictures/../../Users/steve/Documents/me.png\n";
        },
    ],
    [
        "the Picture path is relative",
        async (_file: string, args: readonly string[]) =>
            args.at(-1) === "JPEGPhoto" ? missing("JPEGPhoto") : "Picture: relative.heic\n",
    ],
])("leaves no avatar and still starts when %s", async (_label, command) => {
    const f = await installation();
    onMac(command);
    const node = await f.start();
    expect(await node.get(f.db.context)).toEqual({ name: "Studio", avatar: null });
});

it("does not look for an account picture off macOS", async () => {
    const f = await installation();
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    macos.command = async () => {
        throw new Error("macOS tools must not run");
    };
    const node = await f.start();
    expect(await node.get(f.db.context)).toEqual({ name: "Studio", avatar: null });
    expect(macos.calls).toEqual([]);
});

it("keeps the photo's own bytes when they are already a supported format", async () => {
    const webp = await picture("webp", "yellow");
    const f = await installation();
    onMac(async (file) => {
        expect(file).toBe("/usr/bin/dscl");
        return dsclHex("JPEGPhoto", webp);
    });
    const node = await f.start();
    expect((await node.get(f.db.context)).avatar).toEqual({
        thumbhash: await expectedThumbhash(webp),
    });
    expect(macos.calls.map((call) => call.file)).toEqual(["/usr/bin/dscl"]);
});
