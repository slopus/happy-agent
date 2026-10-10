import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
    mkdir,
    readFile as readFs,
    readlink,
    symlink,
    writeFile as writeFs,
    lstat,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
    createAgentGym,
    createPublicStateBarrier,
    createUnixSocketFetch,
    generateChaosSchedule,
    namedChaosSeeds,
    runChaosSchedule,
    selectChaosSeeds,
    type AgentGym,
    type ChaosActionKind,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const active = new Set<AgentGym>();
const ACTION_COUNT = 80;
const SEEDS = selectChaosSeeds(namedChaosSeeds("F", 16));

const INITIAL_FIXTURES = {
    "README.md": "the original readme\n",
    "src/alpha.ts": "export const alpha = 1;\n",
    "src/beta.test.ts": "export const beta = 2;\n",
    "docs/notes.md": "notes for the file chaos lane\n",
    "assets/sample.bin": new Uint8Array([0, 1, 2, 127, 128, 254, 255]),
    "empty/zero.txt": "",
} as const;

type ClientLike = AgentGym["client"];

type FileAction =
    | { readonly kind: "read"; readonly path: string; readonly client: "primary" | "secondary" }
    | {
          readonly kind: "write";
          readonly mode: "new" | "current" | "stale" | "missing" | "malformed";
          readonly path: string;
          readonly content: string;
          readonly client: "primary" | "secondary";
      }
    | {
          readonly kind: "race";
          readonly path: string;
          readonly left: string;
          readonly right: string;
      }
    | {
          readonly kind: "confinement";
          readonly operation: "read" | "write";
          readonly path: string;
          readonly status: number;
      }
    | { readonly kind: "tree"; readonly path?: string; readonly limit: number }
    | { readonly kind: "tree-page" }
    | { readonly kind: "tree-invalid" }
    | { readonly kind: "search"; readonly query: string; readonly limit: number }
    | { readonly kind: "revision"; readonly path: string; readonly revision: string }
    | { readonly kind: "git" }
    | { readonly kind: "watch" }
    | { readonly kind: "external"; readonly path: string; readonly content: string }
    | { readonly kind: "restart" };

interface FileRecord {
    bytes: Buffer;
    readonly revisions: Buffer[];
}

interface FileModel {
    readonly files: Map<string, FileRecord>;
    readonly seed: string;
    readonly gitRevisionBytes: Map<string, Buffer>;
    readonly outsidePath: string;
    readonly outsideBytes: Buffer;
    readonly escapePath: string;
    readonly linkedPath: string;
    readonly initialRevisions: Map<string, Buffer>;
    readonly staleHashes: Map<string, string>;
    restarts: number;
    revisionReads: number;
}

interface JournalSnapshot {
    readonly cursors: readonly string[];
}

interface PublicProjection {
    readonly readmeHash: string;
    readonly cursor: string;
}

interface GitFixture {
    readonly path: string;
    readonly workspaceId: string;
    readonly revisions: Map<string, Buffer>;
}

interface ModelView {
    readonly files: readonly {
        readonly hash: string;
        readonly path: string;
        readonly revisions: number;
        readonly size: number;
    }[];
    readonly restarts: number;
    readonly revisionReads: number;
    readonly seed: string;
}

describe("files API deterministic chaos", () => {
    afterEach(async () => {
        await Promise.all([...active].map(async (gym) => await gym.dispose()));
        active.clear();
    });

    for (const seed of SEEDS) {
        it(`chaos seed=${seed.label}`, async () => {
            const gym = await createAgentGym({
                files: INITIAL_FIXTURES,
                timeoutMs: 20_000,
            });
            active.add(gym);

            const workspaceId = await rootWorkspaceId(gym);
            const outsidePath = join(dirname(gym.workspacePath), `${seed.label}-outside.txt`);
            const escapePath = join(gym.workspacePath, "escape.txt");
            const linkedPath = join(gym.workspacePath, "linked");
            const outsideBytes = Buffer.from(`outside fixture ${seed.label}\n`, "utf8");
            await writeFs(outsidePath, outsideBytes);
            await symlink(outsidePath, escapePath);
            await symlink(dirname(outsidePath), linkedPath);
            await mkdir(join(gym.workspacePath, "chaos"), { recursive: true });
            await mkdir(join(gym.workspacePath, "missing"), { recursive: true });
            await mkdir(join(gym.workspacePath, "malformed"), { recursive: true });
            const gitFixture = await createGitFixture(gym, seed.label);

            const model = createModel(
                seed.label,
                outsidePath,
                outsideBytes,
                escapePath,
                linkedPath,
                gitFixture.revisions,
            );
            let secondary = makeSecondClient(gym);
            const barrier = createPublicStateBarrier<PublicProjection>(
                async () => {
                    const events = await gym.client.getEvents({ limit: 10_000 });
                    const readme = await gym.client.readFile(workspaceId, "README.md");
                    return {
                        cursor: events.cursor,
                        state: {
                            cursor: events.cursor,
                            readmeHash: readme.hash,
                        },
                    };
                },
                { pollMs: 5, timeoutMs: 2_000 },
            );
            const schedule = buildSchedule(seed.label, seed, ACTION_COUNT);
            expect(schedule).toHaveLength(ACTION_COUNT);

            await runChaosSchedule<FileAction, ReturnType<typeof modelView>>({
                suite: "files",
                seed,
                schedule,
                actionName: (action, step) => `${action.kind}:${String(step)}`,
                apply: async (action, step) => {
                    const details = await applyAction(
                        action,
                        step,
                        gym,
                        workspaceId,
                        gitFixture.workspaceId,
                        model,
                        secondary,
                        () => {
                            secondary = makeSecondClient(gym);
                        },
                    );
                    return {
                        cursor: details.cursor,
                        details: details.details,
                        state: modelView(model),
                    };
                },
                assert: async () => {
                    const expectedReadmeHash = model.files.get("README.md");
                    if (expectedReadmeHash === undefined) {
                        throw new Error("The model lost its README.md record.");
                    }
                    await barrier.waitFor(
                        (snapshot) => snapshot.state.readmeHash === hash(expectedReadmeHash.bytes),
                        "README.md to settle at the model hash",
                    );
                    await assertInvariants(
                        gym,
                        workspaceId,
                        gitFixture.workspaceId,
                        model,
                        secondary,
                    );
                },
            });
        }, 120_000);
    }
});

function createModel(
    seed: string,
    outsidePath: string,
    outsideBytes: Buffer,
    escapePath: string,
    linkedPath: string,
    gitRevisionBytes: Map<string, Buffer>,
): FileModel {
    const files = new Map<string, FileRecord>();
    const initialRevisions = new Map<string, Buffer>();
    for (const [path, value] of Object.entries(INITIAL_FIXTURES)) {
        const bytes = Buffer.from(value);
        files.set(path, { bytes, revisions: [Buffer.from(bytes)] });
        initialRevisions.set(path, Buffer.from(bytes));
    }
    return {
        escapePath,
        files,
        gitRevisionBytes,
        initialRevisions,
        linkedPath,
        outsideBytes,
        outsidePath,
        restarts: 0,
        revisionReads: 0,
        seed,
        staleHashes: new Map(),
    };
}

function buildSchedule(
    label: string,
    seed: { readonly label: string; readonly value: number },
    length: number,
): readonly FileAction[] {
    const prefix: readonly FileAction[] = [
        { client: "primary", kind: "read", path: "README.md" },
        { kind: "tree", limit: 50 },
        { kind: "search", limit: 20, query: "readme" },
        {
            client: "primary",
            kind: "write",
            mode: "new",
            content: `fixed file ${label}\n`,
            path: `chaos/${label.toLowerCase()}-fixed.txt`,
        },
        { client: "secondary", kind: "read", path: `chaos/${label.toLowerCase()}-fixed.txt` },
        {
            client: "primary",
            kind: "write",
            mode: "current",
            content: `fixed update ${label}\n`,
            path: "README.md",
        },
        {
            client: "secondary",
            kind: "write",
            mode: "stale",
            content: `stale write ${label}\n`,
            path: "README.md",
        },
        {
            kind: "race",
            left: `left writer ${label}\n`,
            path: "README.md",
            right: `right writer ${label}\n`,
        },
        {
            kind: "confinement",
            operation: "write",
            path: `../${label.toLowerCase()}-escape.txt`,
            status: 400,
        },
        {
            kind: "confinement",
            operation: "read",
            path: `/tmp/${label.toLowerCase()}-escape.txt`,
            status: 400,
        },
        { kind: "confinement", operation: "read", path: "escape.txt", status: 403 },
        { kind: "confinement", operation: "write", path: "linked/escape.txt", status: 403 },
        { kind: "git" },
        { kind: "revision", path: "tracked.txt", revision: "HEAD" },
        {
            content: `external fixture ${label}\n`,
            kind: "external",
            path: `external/${label.toLowerCase()}.txt`,
        },
        { kind: "tree-page" },
        { kind: "tree-invalid" },
        {
            client: "primary",
            kind: "write",
            mode: "missing",
            content: `missing guard ${label}\n`,
            path: `missing/${label.toLowerCase()}.txt`,
        },
        {
            client: "secondary",
            kind: "write",
            mode: "malformed",
            content: "not-base64",
            path: `malformed/${label.toLowerCase()}.bin`,
        },
        { kind: "restart" },
    ];
    if (prefix.length >= length) return prefix.slice(0, length);

    const kinds: readonly ChaosActionKind<FileAction>[] = [
        {
            name: "read",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                kind: "read",
                path: random.pick([
                    "README.md",
                    "src/alpha.ts",
                    "src/beta.test.ts",
                    "docs/notes.md",
                ]),
            }),
        },
        {
            name: "current-write",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                content: `current ${label} ${String(index)} ${String(random.int(0, 1_000_000))}\n`,
                kind: "write",
                mode: "current",
                path: random.pick([
                    "README.md",
                    "src/alpha.ts",
                    "src/beta.test.ts",
                    "docs/notes.md",
                ]),
            }),
        },
        {
            name: "new-write",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                content: `new ${label} ${String(index)} ${String(random.int(0, 1_000_000))}\n`,
                kind: "write",
                mode: "new",
                path: `chaos/${label.toLowerCase()}-${String(index % 7)}.txt`,
            }),
        },
        {
            name: "stale-write",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                content: `stale ${label} ${String(index)}\n`,
                kind: "write",
                mode: "stale",
                path: "README.md",
            }),
        },
        {
            name: "missing-guard",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                content: `missing ${label} ${String(index)}\n`,
                kind: "write",
                mode: "missing",
                path: `missing/${label.toLowerCase()}-${String(index % 7)}.txt`,
            }),
        },
        {
            name: "malformed",
            create: (random, index) => ({
                client: random.bool() ? "primary" : "secondary",
                content: "definitely not base64!",
                kind: "write",
                mode: "malformed",
                path: `malformed/${label.toLowerCase()}-${String(index % 7)}.bin`,
            }),
        },
        {
            name: "race",
            create: (random, index) => ({
                kind: "race",
                left: `race-left ${label} ${String(index)}\n`,
                path: random.pick(["README.md", "src/alpha.ts", "src/beta.test.ts"]),
                right: `race-right ${label} ${String(index)}\n`,
            }),
        },
        {
            name: "tree",
            create: (random) => ({
                kind: "tree",
                limit: random.int(1, 8),
                ...(random.bool(0.65)
                    ? {}
                    : { path: random.pick(["src", "docs", "assets", "chaos"]) }),
            }),
        },
        {
            name: "tree-page",
            create: () => ({ kind: "tree-page" }),
        },
        {
            name: "search",
            create: (random) => ({
                kind: "search",
                limit: random.int(1, 12),
                query: random.pick(["readme", ".ts", "notes", "chaos", "external", "sample"]),
            }),
        },
        {
            name: "revision",
            create: (random) => ({
                kind: "revision",
                path: random.pick(["README.md", "src/alpha.ts", "src/beta.test.ts"]),
                revision: random.bool(0.8) ? "HEAD" : "HEAD~0",
            }),
        },
        {
            name: "git",
            create: () => ({ kind: "git" }),
        },
        {
            name: "confinement",
            create: (random, index) => {
                const choice = random.int(0, 4);
                if (choice === 0) {
                    return {
                        kind: "confinement",
                        operation: "read",
                        path: `../${label.toLowerCase()}-${String(index)}.txt`,
                        status: 400,
                    };
                }
                if (choice === 1) {
                    return {
                        kind: "confinement",
                        operation: "write",
                        path: `/tmp/${label.toLowerCase()}-${String(index)}.txt`,
                        status: 400,
                    };
                }
                if (choice === 2) {
                    return {
                        kind: "confinement",
                        operation: "read",
                        path: "escape.txt",
                        status: 403,
                    };
                }
                return {
                    kind: "confinement",
                    operation: "write",
                    path: "linked/escape.txt",
                    status: 403,
                };
            },
        },
        {
            name: "external",
            create: (random, index) => ({
                content: `external ${label} ${String(index)}\n`,
                kind: "external",
                path: `external/${label.toLowerCase()}-${String(random.int(0, 5))}.txt`,
            }),
        },
        {
            name: "restart",
            create: () => ({ kind: "restart" }),
        },
    ];
    const randomLength = length - prefix.length - 1;
    const generated = generateChaosSchedule(seed, randomLength, kinds);
    return [...prefix, ...generated, { kind: "watch" }];
}

async function applyAction(
    action: FileAction,
    step: number,
    gym: AgentGym,
    workspaceId: string,
    gitWorkspaceId: string,
    model: FileModel,
    secondary: ClientLike,
    onRestart: () => void,
): Promise<{ readonly cursor: string; readonly details: unknown }> {
    switch (action.kind) {
        case "read":
            await applyRead(action, gym, workspaceId, model, secondary);
            break;
        case "write":
            await applyWrite(action, gym, workspaceId, model, secondary);
            break;
        case "race":
            await applyRace(action, gym, workspaceId, model, secondary);
            break;
        case "confinement":
            await applyConfinement(action, gym, workspaceId, model);
            break;
        case "tree":
            await applyTree(action, gym, workspaceId);
            break;
        case "tree-page":
            await applyTreePages(gym, workspaceId, model);
            break;
        case "tree-invalid":
            await applyTreeInvalid(gym, workspaceId);
            break;
        case "search":
            await applySearch(action, gym, workspaceId, model);
            break;
        case "revision":
            await applyRevision(action, gym, gitWorkspaceId, model);
            break;
        case "git":
            await applyGit(gym, gitWorkspaceId);
            break;
        case "watch":
            await applyWatch(gym, gitWorkspaceId);
            break;
        case "external":
            await applyExternal(action, gym, workspaceId, model);
            break;
        case "restart":
            await gym.restart();
            model.restarts += 1;
            onRestart();
            expect((await gym.client.getHealth()).ready).toBe(true);
            break;
        default:
            assertNever(action);
    }
    const events = await gym.client.getEvents({ limit: 10_000 });
    return {
        cursor: events.cursor,
        details: {
            kind: action.kind,
            step,
            events: events.events.length,
            restarts: model.restarts,
        },
    };
}

async function applyRead(
    action: Extract<FileAction, { kind: "read" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
    secondary: ClientLike,
): Promise<void> {
    const client = action.client === "primary" ? gym.client : secondary;
    const expected = model.files.get(action.path);
    if (expected === undefined) {
        const before = await journal(gym.client);
        const error = await expectApiError(() => client.readFile(workspaceId, action.path));
        expect(error.status).toBe(404);
        expect(error.code).toBe("not_found");
        await expectJournalUnchanged(gym.client, before);
        return;
    }
    const response = await client.readFile(workspaceId, action.path);
    const bytes = Buffer.from(response.content, "base64");
    expect(bytes).toEqual(expected.bytes);
    expect(response.hash).toBe(hash(expected.bytes));
}

async function applyWrite(
    action: Extract<FileAction, { kind: "write" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
    secondary: ClientLike,
): Promise<void> {
    const client = action.client === "primary" ? gym.client : secondary;
    const before = model.files.get(action.path);
    const bytes = Buffer.from(action.content, "utf8");

    if (action.mode === "malformed") {
        const journalBefore = await journal(gym.client);
        const error = await expectApiError(() =>
            client.writeFile(workspaceId, {
                content: action.content,
                expectedHash: null,
                path: action.path,
            }),
        );
        expect(error.status).toBe(400);
        expect(error.code).toBe("invalid_request");
        await expectJournalUnchanged(gym.client, journalBefore);
        return;
    }

    if (action.mode === "missing") {
        const journalBefore = await journal(gym.client);
        const error = await expectApiError(() =>
            client.writeFile(workspaceId, {
                content: bytes.toString("base64"),
                expectedHash: "0".repeat(64),
                path: action.path,
            }),
        );
        expect(error.status).toBe(409);
        expect(error.code).toBe("hash_mismatch");
        expect(model.files.has(action.path)).toBe(false);
        await expectJournalUnchanged(gym.client, journalBefore);
        return;
    }

    if (action.mode === "stale") {
        if (before === undefined) throw new Error(`Cannot stale-write missing ${action.path}.`);
        const journalBefore = await journal(gym.client);
        const stale = model.staleHashes.get(action.path) ?? flipHash(hash(before.bytes));
        expect(stale).not.toBe(hash(before.bytes));
        const error = await expectApiError(() =>
            client.writeFile(workspaceId, {
                content: bytes.toString("base64"),
                expectedHash: stale,
                path: action.path,
            }),
        );
        expect(error.status).toBe(409);
        expect(error.code).toBe("hash_mismatch");
        expect(error.body).toMatchObject({ hash: hash(before.bytes) });
        await expectJournalUnchanged(gym.client, journalBefore);
        return;
    }

    const expectedHash =
        action.mode === "new" ? null : before?.bytes === undefined ? null : hash(before.bytes);
    if (action.mode === "new" && before !== undefined) {
        const journalBefore = await journal(gym.client);
        const error = await expectApiError(() =>
            client.writeFile(workspaceId, {
                content: bytes.toString("base64"),
                expectedHash: null,
                path: action.path,
            }),
        );
        expect(error.status).toBe(409);
        expect(error.code).toBe("hash_mismatch");
        await expectJournalUnchanged(gym.client, journalBefore);
        return;
    }
    if (expectedHash === null && action.mode === "current") {
        throw new Error(`Current write unexpectedly has no record for ${action.path}.`);
    }

    const journalBefore = await journal(gym.client);
    const response = await client.writeFile(workspaceId, {
        content: bytes.toString("base64"),
        expectedHash,
        path: action.path,
    });
    expect(response.hash).toBe(hash(bytes));
    if (before !== undefined) model.staleHashes.set(action.path, hash(before.bytes));
    const revisions = before?.revisions ?? [];
    revisions.push(Buffer.from(bytes));
    model.files.set(action.path, { bytes: Buffer.from(bytes), revisions });
    await waitForFileUpdate(gym, workspaceId, action.path, journalBefore);
}

async function applyRace(
    action: Extract<FileAction, { kind: "race" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
    secondary: ClientLike,
): Promise<void> {
    const before = model.files.get(action.path);
    if (before === undefined) throw new Error(`Cannot race-write missing ${action.path}.`);
    const expectedHash = hash(before.bytes);
    const journalBefore = await journal(gym.client);
    const [left, right] = await Promise.allSettled([
        gym.client.writeFile(workspaceId, {
            content: Buffer.from(action.left).toString("base64"),
            expectedHash,
            path: action.path,
        }),
        secondary.writeFile(workspaceId, {
            content: Buffer.from(action.right).toString("base64"),
            expectedHash,
            path: action.path,
        }),
    ]);
    const fulfilled = [left, right].filter(
        (outcome): outcome is PromiseFulfilledResult<{ readonly hash: string }> =>
            outcome.status === "fulfilled",
    );
    const rejected = [left, right].filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0];
    if (winner === undefined) throw new Error("The CAS race had no winner.");
    const winnerBytes =
        left.status === "fulfilled" ? Buffer.from(action.left) : Buffer.from(action.right);
    expect(winner.value.hash).toBe(hash(winnerBytes));
    const loser = rejected[0];
    if (loser?.status === "rejected") {
        expect(loser.reason).toMatchObject({ status: 409, code: "hash_mismatch" });
        expect(loser.reason.body).toMatchObject({ hash: winner.value.hash });
    }
    model.staleHashes.set(action.path, expectedHash);
    const revisions = before.revisions;
    revisions.push(Buffer.from(winnerBytes));
    model.files.set(action.path, { bytes: winnerBytes, revisions });
    await waitForFileUpdate(gym, workspaceId, action.path, journalBefore);
}

async function applyConfinement(
    action: Extract<FileAction, { kind: "confinement" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
): Promise<void> {
    const journalBefore = await journal(gym.client);
    const error = await expectApiError(() => {
        if (action.operation === "read") return gym.client.readFile(workspaceId, action.path);
        return gym.client.writeFile(workspaceId, {
            content: Buffer.from("must stay confined\n").toString("base64"),
            expectedHash: null,
            path: action.path,
        });
    });
    expect(error.status).toBe(action.status);
    expect(error.code).toBe("invalid_request");
    await expectJournalUnchanged(gym.client, journalBefore);
    expect(await readFs(model.outsidePath)).toEqual(model.outsideBytes);
}

async function applyTree(
    action: Extract<FileAction, { kind: "tree" }>,
    gym: AgentGym,
    workspaceId: string,
): Promise<void> {
    const response = await gym.client.getFileTree(workspaceId, {
        ...(action.path === undefined ? {} : { path: action.path }),
        limit: action.limit,
    });
    const paths = response.entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.length).toBeLessThanOrEqual(action.limit);
    for (const path of paths) {
        if (action.path === undefined) {
            expect(path).not.toContain("/");
        } else {
            expect(path.startsWith(`${action.path}/`)).toBe(true);
        }
    }
}

async function applyTreePages(gym: AgentGym, workspaceId: string, model: FileModel): Promise<void> {
    let cursor: string | undefined;
    const paths: string[] = [];
    for (let page = 0; page < 128; page += 1) {
        const response = await gym.client.getFileTree(workspaceId, {
            ...(cursor === undefined ? {} : { cursor }),
            limit: 1,
        });
        paths.push(...response.entries.map((entry) => entry.path));
        if (response.nextCursor === null) break;
        cursor = response.nextCursor;
    }
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of model.files.keys()) {
        const direct = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
        expect(paths).toContain(direct);
    }
}

async function applyTreeInvalid(gym: AgentGym, workspaceId: string): Promise<void> {
    const before = await journal(gym.client);
    const error = await expectApiError(() =>
        gym.client.getFileTree(workspaceId, { path: "README.md" }),
    );
    expect(error.status).toBe(400);
    expect(error.code).toBe("invalid_request");
    await expectJournalUnchanged(gym.client, before);
}

async function applySearch(
    action: Extract<FileAction, { kind: "search" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
): Promise<void> {
    const expected = [...model.files.keys()]
        .filter((path) => path.toLowerCase().includes(action.query.toLowerCase()))
        .sort((left, right) => left.localeCompare(right));
    const response =
        expected.length > action.limit
            ? await gym.client.searchFiles(workspaceId, {
                  limit: action.limit,
                  query: action.query,
              })
            : await gym.waitUntil(
                  async () => {
                      const candidate = await gym.client.searchFiles(workspaceId, {
                          limit: action.limit,
                          query: action.query,
                      });
                      const paths = candidate.files.map((file) => file.path);
                      return expected.every((path) => paths.includes(path)) ? candidate : undefined;
                  },
                  `fuzzy file search ${JSON.stringify(action.query)} to include direct matches`,
              );
    const paths = response.files.map((file) => file.path);
    expect(paths).toHaveLength(new Set(paths).size);
    expect(paths.length).toBeLessThanOrEqual(action.limit);
    for (const path of paths) {
        expect(model.files.has(path)).toBe(true);
    }
}

async function applyRevision(
    action: Extract<FileAction, { kind: "revision" }>,
    gym: AgentGym,
    gitWorkspaceId: string,
    model: FileModel,
): Promise<void> {
    model.revisionReads += 1;
    const before = await journal(gym.client);
    try {
        const response = await gym.client.readFileRevision(gitWorkspaceId, {
            path: action.path,
            revision: action.revision,
        });
        const expected = model.gitRevisionBytes.get(action.path);
        if (expected === undefined) throw new Error(`Missing model revision for ${action.path}.`);
        expect(Buffer.from(response.content, "base64")).toEqual(expected);
    } catch (error: unknown) {
        const apiError = error as { readonly code?: unknown; readonly status?: unknown };
        expect([400, 404, 409]).toContain(apiError.status);
        expect(["invalid_request", "not_found", "conflict"]).toContain(apiError.code);
        await expectJournalUnchanged(gym.client, before);
    }
}

async function applyGit(gym: AgentGym, workspaceId: string): Promise<void> {
    const response = await gym.client.getWorkspaceGit(workspaceId);
    expect(response.git.facts.head).toBeTruthy();
    expect(response.git.files).toEqual(expect.any(Array));
    expect(["ready", "unavailable"]).toContain(response.git.comparison);
}

async function applyWatch(gym: AgentGym, workspaceId: string): Promise<void> {
    const response = await gym.client.watchGit({ workspaceIds: [workspaceId] });
    expect(response.snapshots).toEqual(expect.any(Object));
    expect(Object.keys(response.snapshots).every((id) => id === workspaceId)).toBe(true);
    const snapshot = response.snapshots[workspaceId];
    if (snapshot !== undefined) expect(snapshot.facts.head).toBeTruthy();
}

async function applyExternal(
    action: Extract<FileAction, { kind: "external" }>,
    gym: AgentGym,
    workspaceId: string,
    model: FileModel,
): Promise<void> {
    const bytes = Buffer.from(action.content, "utf8");
    const existing = model.files.get(action.path);
    const relativeDirectory = dirname(action.path);
    await mkdir(join(gym.workspacePath, relativeDirectory), { recursive: true });
    await gym.client.getFileTree(workspaceId, { limit: 1, path: relativeDirectory });
    const journalBefore = await journal(gym.client);
    await writeFs(join(gym.workspacePath, action.path), bytes);
    if (existing === undefined) {
        model.files.set(action.path, { bytes, revisions: [Buffer.from(bytes)] });
        model.initialRevisions.set(action.path, Buffer.from(bytes));
    } else {
        model.staleHashes.set(action.path, hash(existing.bytes));
        existing.revisions.push(Buffer.from(bytes));
        existing.bytes = Buffer.from(bytes);
    }
    const response = await gym.client.readFile(workspaceId, action.path);
    expect(Buffer.from(response.content, "base64")).toEqual(bytes);
    expect(response.hash).toBe(hash(bytes));
    await waitForFileUpdate(gym, workspaceId, action.path, journalBefore);
}

async function assertInvariants(
    gym: AgentGym,
    workspaceId: string,
    gitWorkspaceId: string,
    model: FileModel,
    secondary: ClientLike,
): Promise<void> {
    expect((await gym.client.getHealth()).ready).toBe(true);
    expect((await secondary.getHealth()).ready).toBe(true);
    expect(new Set(model.files.keys()).size).toBe(model.files.size);
    for (const [path, record] of [...model.files.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
    )) {
        const response = await gym.client.readFile(workspaceId, path);
        const bytes = Buffer.from(response.content, "base64");
        expect(bytes).toEqual(record.bytes);
        expect(response.hash).toBe(hash(record.bytes));
        expect(await readFs(join(gym.workspacePath, path))).toEqual(record.bytes);
    }
    expect(await readFs(model.outsidePath)).toEqual(model.outsideBytes);
    const git = await gym.client.getWorkspaceGit(gitWorkspaceId);
    expect(git.git.facts.head).toBeTruthy();
    for (const [path, bytes] of model.gitRevisionBytes) {
        const revision = await gym.client.readFileRevision(gitWorkspaceId, {
            path,
            revision: "HEAD",
        });
        expect(Buffer.from(revision.content, "base64")).toEqual(bytes);
    }

    const rootTree = await gym.client.getFileTree(workspaceId, { limit: 500 });
    const rootPaths = new Set(rootTree.entries.map((entry) => entry.path));
    for (const path of model.files.keys()) {
        const direct = path.includes("/") ? path.slice(0, path.indexOf("/")) : path;
        expect(
            rootPaths.has(direct),
            `root tree missing ${direct} for ${path}; got ${[...rootPaths].join(",")}`,
        ).toBe(true);
    }
    const directories = new Set<string>();
    for (const path of model.files.keys()) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) {
            directories.add(parts.slice(0, index).join("/"));
        }
    }
    for (const directory of directories) {
        const tree = await gym.client.getFileTree(workspaceId, { limit: 500, path: directory });
        const entries = new Set(tree.entries.map((entry) => entry.path));
        for (const path of model.files.keys()) {
            if (path.startsWith(`${directory}/`)) {
                const remainder = path.slice(directory.length + 1);
                const direct = remainder.includes("/")
                    ? remainder.slice(0, remainder.indexOf("/"))
                    : remainder;
                expect(
                    entries.has(`${directory}/${direct}`),
                    `tree missing ${directory}/${direct} for ${path}`,
                ).toBe(true);
            }
        }
    }
    const escapeStat = await lstat(model.escapePath);
    expect(escapeStat.isSymbolicLink()).toBe(true);
    expect(await readlink(model.escapePath)).toBe(model.outsidePath);
    const linkedStat = await lstat(model.linkedPath);
    expect(linkedStat.isSymbolicLink()).toBe(true);

    const events = await gym.client.getEvents({ limit: 10_000 });
    const cursors = events.events.map((event) => event.cursor);
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(cursors.every((cursor) => typeof cursor === "string" && cursor.length > 0)).toBe(true);
    if (cursors.length > 0) {
        expect(events.cursor).toBe(cursors[cursors.length - 1]);
        expect(events.latestCursor).toBe(cursors[cursors.length - 1]);
    }
}

async function expectJournalUnchanged(client: ClientLike, before: JournalSnapshot): Promise<void> {
    const after = await journal(client);
    expect(after.cursors).toEqual(before.cursors);
    expect((await client.getHealth()).ready).toBe(true);
}

async function waitForFileUpdate(
    gym: AgentGym,
    workspaceId: string,
    path: string,
    before: JournalSnapshot,
): Promise<void> {
    const previousCursors = new Set(before.cursors);
    const event = await gym.waitForEvent((candidate) => {
        if (previousCursors.has(candidate.cursor) || candidate.type !== "files.updated") {
            return false;
        }
        return (
            candidate.payload.workspaceId === workspaceId &&
            (candidate.payload.paths === null || candidate.payload.paths.includes(path))
        );
    }, `files.updated for ${workspaceId}:${path}`);
    expect(event).toMatchObject({
        type: "files.updated",
        payload: { workspaceId },
    });
}

async function journal(client: ClientLike): Promise<JournalSnapshot> {
    const response = await client.getEvents({ limit: 10_000 });
    return { cursors: response.events.map((event) => event.cursor) };
}

async function expectApiError(
    action: () => Promise<unknown>,
): Promise<{ readonly body?: unknown; readonly code?: unknown; readonly status?: unknown }> {
    try {
        await action();
    } catch (error: unknown) {
        return error as {
            readonly body?: unknown;
            readonly code?: unknown;
            readonly status?: unknown;
        };
    }
    throw new Error("Expected a public API request to fail.");
}

function modelView(model: FileModel): ModelView {
    return {
        files: [...model.files.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([path, record]) => ({
                hash: hash(record.bytes),
                path,
                revisions: record.revisions.length,
                size: record.bytes.byteLength,
            })),
        restarts: model.restarts,
        revisionReads: model.revisionReads,
        seed: model.seed,
    };
}

function hash(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function flipHash(value: string): string {
    return `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`;
}

function makeSecondClient(gym: AgentGym): ClientLike {
    type Constructor = new (options: {
        readonly endpoint: string;
        readonly token: string;
        readonly fetch: typeof globalThis.fetch;
    }) => ClientLike;
    const constructor = gym.client.constructor as unknown as Constructor;
    return new constructor({
        endpoint: gym.client.endpoint,
        fetch: createUnixSocketFetch(gym.socketPath),
        token: gym.token,
    });
}

async function rootWorkspaceId(gym: AgentGym): Promise<string> {
    const projects = await gym.client.listProjects();
    const project = projects.projects.find(
        (candidate) =>
            candidate.compute.type === "host" && candidate.compute.path === gym.workspacePath,
    );
    if (project === undefined) throw new Error("The gym root project was not registered.");
    return project.id;
}

async function createGitFixture(gym: AgentGym, label: string): Promise<GitFixture> {
    const path = join(dirname(gym.workspacePath), `${label.toLowerCase()}-git-repository`);
    await mkdir(join(path, "nested"), { recursive: true });
    await writeFs(join(path, "tracked.txt"), "version one\n", "utf8");
    await writeFs(join(path, "nested/deep.txt"), "deep content\n", "utf8");
    await initializeGit(path);
    const project = (
        await gym.client.registerProject({
            path,
            projectId: `git${label.toLowerCase()}`,
        })
    ).project;
    await gym.waitUntil(
        async () => {
            const current = (await gym.client.getProject(project.id)).project;
            if (current.initialization.status === "failed") {
                throw new Error(
                    current.initialization.error ?? "Git fixture initialization failed.",
                );
            }
            return current.initialization.status === "ready" ? true : undefined;
        },
        `Git fixture ${label} to initialize`,
        20_000,
    );
    return {
        path,
        revisions: new Map([
            ["tracked.txt", Buffer.from("version one\n", "utf8")],
            ["nested/deep.txt", Buffer.from("deep content\n", "utf8")],
        ]),
        workspaceId: project.id,
    };
}

async function initializeGit(cwd: string): Promise<void> {
    const environment = {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
    };
    await execFile("git", ["init", "--initial-branch=main"], { cwd, env: environment });
    await execFile("git", ["config", "user.email", "chaos@example.invalid"], {
        cwd,
        env: environment,
    });
    await execFile("git", ["config", "user.name", "API Chaos"], { cwd, env: environment });
    await execFile("git", ["add", "."], { cwd, env: environment });
    await execFile("git", ["commit", "-m", "initial chaos fixture"], { cwd, env: environment });
}

function assertNever(value: never): never {
    throw new Error(`Unexpected file chaos action: ${JSON.stringify(value)}`);
}
