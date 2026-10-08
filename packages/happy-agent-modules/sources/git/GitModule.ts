import { randomUUID } from "node:crypto";
import { lstat, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentModule } from "@slopus/happy-agent-base";
import { computePermissions, type Compute } from "@slopus/happy-agent-compute";
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { RunnersModule } from "../runners/index.js";
import type { GitCommandOptions, GitCommandResult, GitCommandRunner } from "./GitCommandRunner.js";
import {
    GitCredentialBroker,
    type GitAuthentication,
    type GitCommandAuthentication,
    type RegisterGitCredential,
} from "./GitCredentialBroker.js";
import { cloneRemoteRepository, remoteUrlForSource } from "./cloneRemoteRepository.js";
import { countUntrackedFileLines, type UntrackedFileCount } from "./countUntrackedFileLines.js";
import { createGitWorktree } from "./createGitWorktree.js";
import { detectGitDefaultBranch } from "./detectGitDefaultBranch.js";
import type { GitWorkingFiles } from "./GitWorkingFiles.js";
import { cloneOnRunner } from "./impl/cloneOnRunner.js";
import { GitStateTracker } from "./impl/GitStateTracker.js";
import { localGitWorkingFiles } from "./impl/localGitWorkingFiles.js";
import { RunnerGitCredentialTunnel } from "./impl/RunnerGitCredentialTunnel.js";
import { RunnerGitStateTracker, type RunnerGitAccess } from "./impl/RunnerGitStateTracker.js";
import { runnerGitCommandRunner, runnerScanGit } from "./impl/runnerGitRunners.js";
import { runnerGitWorkingFiles } from "./impl/runnerGitWorkingFiles.js";
import { watchRunnerWorkingTree } from "./impl/watchRunnerWorkingTree.js";
import { WorkingTreeWatcher, type WorkingTreeObserver } from "./impl/WorkingTreeWatcher.js";
import { isGitWorktreeAt } from "./isGitWorktreeAt.js";
import { listGitWorkingTreeFiles, type GitWorkingTreeFiles } from "./listGitWorkingTreeFiles.js";
import { normalizeFuturePath } from "./normalizeFuturePath.js";
import { normalizeProjectCwd } from "./normalizeProjectCwd.js";
import { parseHostingRepository, type HostingRepository } from "./parseHostingRepository.js";
import { probeGitRepository, type GitRepositoryProbe } from "./probeGitRepository.js";
import { readGitCommonDir } from "./readGitCommonDir.js";
import { readGitFileAtRevision, type GitRevisionFile } from "./readGitFileAtRevision.js";
import { readGitTopLevel } from "./readGitTopLevel.js";
import { readGitWorktreeIdentity, type GitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
import { remoteProjectName } from "./remoteProjectName.js";
import { removeGitWorktree } from "./removeGitWorktree.js";
import { renameGitBranch } from "./renameGitBranch.js";
import { resolveGitCommit } from "./resolveGitCommit.js";
import { resolveGitComparisonBase, type GitComparisonBase } from "./resolveGitComparisonBase.js";
import { resolveWorkspaceBase, type WorkspaceBase } from "./resolveWorkspaceBase.js";
import { directGitCommandRunner, runGitCommandWithEnvironment } from "./runGitCommand.js";
import {
    gitCommandRunnerFromScanGitRunner,
    runScanGit,
    scanGitRunnerFromCommandRunner,
    type ScanGitRunner,
} from "./runScanGit.js";
import { scanGitRepository } from "./scanGitRepository.js";
import { selectGitRemoteUrl } from "./selectGitRemoteUrl.js";
import { supportsRecursiveWorktreeWatch } from "./watchGitRepositoryChanges.js";
import {
    gitTrackedEntitySchema,
    projectCreatorSchema,
    type GitChangeSnapshot,
    type GitChangeState,
    type GitFileChange,
    type GitLiveSnapshot,
    type GitRemoteSource,
    type GitRepositoryFacts,
    type GitTrackedEntity,
    type ProjectCreator,
} from "./types.js";

const SNAPSHOT_CACHE_MS = 2_000;
const MAX_CACHE_ENTRIES = 32;
const MAX_SNAPSHOT_FILES = 1_000;
const MAX_WATCH_ENTITIES = 256;

export type GitResource = ReturnType<GitModule["resource"]>;

export const gitEntitySchema = Type.Object(
    {
        projectId: Type.String({ minLength: 1, maxLength: 128 }),
        workspaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
);
export const gitWatchSchema = Type.Object(
    {
        // Watching nothing is a real state, not a mistake: a client whose window shows no folder
        // yet still polls, and it is told about no folders rather than refused.
        entities: Type.Array(gitEntitySchema, { maxItems: MAX_WATCH_ENTITIES }),
    },
    { additionalProperties: false },
);
export const gitTrackedEntitiesSchema = Type.Array(gitTrackedEntitySchema, {
    maxItems: MAX_WATCH_ENTITIES,
});

/**
 * Names the project credential a Git command should carry.
 *
 * A repository cloned with a token needs the same token for every later fetch, so callers name the
 * project and the person it was registered for rather than carrying an environment of their own.
 */
export const gitCredentialRefSchema = Type.Object(
    {
        creator: projectCreatorSchema,
        projectId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type GitEntity = Static<typeof gitEntitySchema>;
export type GitWatchInput = Static<typeof gitWatchSchema>;
export type GitCredentialRef = Static<typeof gitCredentialRefSchema>;
export type GitChangedFile = GitFileChange;
export type { GitChangeSnapshot, GitLiveSnapshot, GitRepositoryFacts };

/** Where a repository lives: the runner holding it, or this machine when absent. */
export interface GitPlacement {
    readonly runnerId?: string;
}

/** How one Git operation runs: where, whose credential it carries, and when it must give up. */
export interface GitOperationOptions extends GitPlacement {
    readonly credential?: GitCredentialRef;
    readonly signal?: AbortSignal;
}

/** The product reads and writes its own folders; the agent sandbox does not apply here. */
const PRODUCT = computePermissions("full_access");

/** Everything Git work needs on one machine. */
interface GitMachine {
    foreground(credential: GitCredentialRef | undefined): GitCommandRunner;
    readonly read: GitCommandRunner;
    readonly scan: ScanGitRunner;
    readonly files: GitWorkingFiles;
    isDirectory(path: string): Promise<boolean>;
    makeDirectory(path: string): Promise<void>;
    inspect(path: string): Promise<{ isDirectory: boolean; isSymbolicLink: boolean }>;
}

/** What a live snapshot subscriber is told each time a watched repository changes. */
export type GitSnapshotObserver = (
    ctx: Context,
    entity: GitTrackedEntity,
    snapshot: GitChangeSnapshot,
) => void | Promise<void>;

interface CachedSnapshot {
    readonly expiresAt: number;
    readonly root: string;
    readonly runnerId: string | undefined;
    readonly snapshot: GitChangeSnapshot;
}

/**
 * Git, as one module.
 *
 * Everything the product does with a repository runs through here: reading facts and change
 * snapshots, probing a folder, cloning a remote, cutting and retiring worktrees, renaming
 * branches, brokering repository credentials, and watching repositories for change. It reaches
 * Git itself rather than being handed a runner, and unattended reads go
 * through the hardened read-only scanner while mutations and network work use the foreground one.
 *
 * Snapshots compare against the merge base with the default branch (origin's when it has one,
 * otherwise the local one), HEAD, or the empty tree, include committed, staged, unstaged,
 * and untracked work, detect binary files, omit large files, and retain both sides of displayed
 * binary deltas.
 */
export class GitModule implements AgentModule {
    readonly name = "git";

    readonly #cache = new Map<string, CachedSnapshot>();
    readonly #credentials = new GitCredentialBroker();
    readonly #generation = randomUUID();
    readonly #observers = new Set<GitSnapshotObserver>();
    readonly #runners: RunnersModule | undefined;
    readonly #runnerMachines = new Map<string, GitMachine>();
    readonly #tunnel = new RunnerGitCredentialTunnel();
    #config: ConfigModule | undefined;
    #runnerTracker: RunnerGitStateTracker | undefined;
    /** Whether Git is reached directly, which is what makes a credential-carrying runner possible. */
    #direct = true;
    #disposed = false;
    #foreground: GitCommandRunner;
    #lifetime: RootContext | undefined;
    #read: GitCommandRunner;
    #scan: ScanGitRunner;
    #tracker: GitStateTracker | undefined;
    #tree: WorkingTreeWatcher | undefined;
    #version = 0;

    constructor(config?: ConfigModule, runners?: RunnersModule) {
        this.#config = config;
        this.#runners = runners;
        this.#foreground = directGitCommandRunner;
        this.#scan =
            config === undefined
                ? runScanGit
                : async (options) => {
                      const gitCeilingDirectories = config.gitCeilingDirectories;
                      return await runScanGit({
                          ...options,
                          ...(gitCeilingDirectories === undefined ? {} : { gitCeilingDirectories }),
                      });
                  };
        this.#read = gitCommandRunnerFromScanGitRunner(this.#scan);
    }

    /**
     * Test-only construction over one supplied Git execution boundary.
     *
     * Production always runs Git itself. A test that needs to watch which commands were issued, or
     * to make one fail, replaces the boundary here instead of reaching into the module.
     */
    static withRunner(runner: GitCommandRunner): GitModule {
        const module = new GitModule();
        module.#direct = false;
        module.#foreground = runner;
        module.#scan = scanGitRunnerFromCommandRunner(runner);
        module.#read = gitCommandRunnerFromScanGitRunner(module.#scan);
        return module;
    }

    /**
     * Adopts the collection's lifetime so watchers and background scans outlive the call that
     * started them. Git contributes no tools, instructions, or hooks.
     */
    readonly beforeStart = (ctx: Context): void => {
        this.#lifetime ??= detach(ctx);
    };

    // --- Paths and names -------------------------------------------------------------------

    /** The canonical form of a folder that already exists. */
    normalizeProjectCwd(cwd: string): string {
        return normalizeProjectCwd(cwd);
    }

    /** The canonical form a folder will have once it is created. */
    normalizeFuturePath(path: string): string {
        return normalizeFuturePath(path);
    }

    /** The repository name a remote URL implies, or nothing when it names none. */
    remoteProjectName(remote: string): string | undefined {
        return remoteProjectName(remote);
    }

    /** The hosting owner and repository a remote points at, when it is a recognized host. */
    parseHostingRepository(remote: string): HostingRepository | undefined {
        return parseHostingRepository(remote);
    }

    /** The validated clone URL for a remote source. */
    remoteUrlForSource(source: GitRemoteSource): string {
        return remoteUrlForSource(source);
    }

    /** Whether this platform can watch a whole worktree recursively. */
    supportsRecursiveWorktreeWatch(): boolean {
        return supportsRecursiveWorktreeWatch();
    }

    // --- Running Git -----------------------------------------------------------------------

    /**
     * Runs one Git command in the foreground, carrying a project credential when one is named.
     *
     * The escape hatch for work this module has no method for. It returns exit status and both
     * streams rather than throwing, so a caller can read a failure without losing Git's own text.
     */
    async run(
        cwd: string,
        args: readonly string[],
        options: GitCommandOptions & GitPlacement & { readonly credential?: GitCredentialRef } = {},
    ): Promise<GitCommandResult> {
        const { credential, runnerId, ...command } = options;
        return await this.#machine(runnerId).foreground(credential).run(cwd, args, command);
    }

    /**
     * Runs one unattended read-only Git command and returns its trimmed output.
     *
     * Prompts, optional locks, lazy fetches, hooks, credential helpers, fsmonitor, and external
     * diff programs are all disabled, and both time and output are bounded.
     */
    async readOnly(
        cwd: string,
        args: readonly string[],
        options: GitPlacement & { readonly signal?: AbortSignal } = {},
    ): Promise<string> {
        const result = await this.#machine(options.runnerId).scan({
            args,
            cwd,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return result.stdout.trim();
    }

    // --- Reading a repository --------------------------------------------------------------

    /** What a folder is: present, a repository root, and whether a worktree can be cut from it. */
    async probe(
        path: string,
        options: GitOperationOptions & { readonly isHome?: boolean } = {},
    ): Promise<GitRepositoryProbe> {
        const machine = this.#machine(options.runnerId);
        return await probeGitRepository({
            git: this.#readFor(options.credential, options.runnerId),
            ...(options.runnerId === undefined
                ? {}
                : {
                      isDirectory: async (candidate: string) =>
                          await machine.isDirectory(candidate),
                  }),
            path,
            ...(options.isHome === undefined ? {} : { isHome: options.isHome }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** The branch, head, upstream, and divergence of a repository. */
    async facts(
        root: string,
        signal?: AbortSignal,
        placement: GitPlacement = {},
    ): Promise<GitRepositoryFacts> {
        const machine = this.#machine(placement.runnerId);
        const probe = await probeGitRepository({
            git: machine.read,
            ...(placement.runnerId === undefined
                ? {}
                : {
                      isDirectory: async (candidate: string) =>
                          await machine.isDirectory(candidate),
                  }),
            path: root,
            ...(signal === undefined ? {} : { signal }),
        });
        return probe.facts ?? { ahead: 0, behind: 0, detached: false };
    }

    /** The canonical top level of the repository containing a path. */
    async topLevel(path: string, options: GitOperationOptions = {}): Promise<string> {
        return await readGitTopLevel(this.#readFor(options.credential, options.runnerId), path);
    }

    /** The shared Git directory every worktree of a repository has in common. */
    async commonDir(path: string, options: GitOperationOptions = {}): Promise<string> {
        return await readGitCommonDir(this.#readFor(options.credential, options.runnerId), path);
    }

    /** Both halves of a worktree's identity: its own top level and its shared common directory. */
    async worktreeIdentity(
        path: string,
        options: GitOperationOptions = {},
    ): Promise<GitWorktreeIdentity> {
        return await readGitWorktreeIdentity(
            this.#readFor(options.credential, options.runnerId),
            path,
        );
    }

    /** Whether a path is the top level of a worktree belonging to one specific repository. */
    async isWorktreeAt(
        options: GitOperationOptions & { readonly commonDir: string; readonly path: string },
    ): Promise<boolean> {
        return await isGitWorktreeAt({
            commonDir: options.commonDir,
            git: this.#readFor(options.credential, options.runnerId),
            path: options.path,
        });
    }

    /** The branch a repository treats as its default, preferring what origin says. */
    async defaultBranch(
        path: string,
        options: GitOperationOptions = {},
    ): Promise<string | undefined> {
        return await detectGitDefaultBranch(
            this.#readFor(options.credential, options.runnerId),
            path,
        );
    }

    /** The remote URL a repository is really working against, tracked branch first. */
    async selectRemoteUrl(
        cwd: string,
        options: GitOperationOptions = {},
    ): Promise<string | undefined> {
        return await selectGitRemoteUrl(this.#readFor(options.credential, options.runnerId), cwd);
    }

    /** The commit a reference resolves to, or nothing when Git answered with something else. */
    async resolveCommit(
        cwd: string,
        ref: string,
        options: GitOperationOptions = {},
    ): Promise<string | undefined> {
        return await resolveGitCommit(
            this.#readFor(options.credential, options.runnerId),
            cwd,
            ref,
            options.signal === undefined ? undefined : { signal: options.signal },
        );
    }

    /**
     * The merge base a branch's changes are measured from.
     *
     * The merge base with `origin/<default branch>` comes first; the local default branch is used
     * only when the remote has none, then HEAD, then the empty tree for an unborn branch.
     */
    async resolveComparisonBase(
        cwd: string,
        options: GitPlacement & { readonly head?: string; readonly signal?: AbortSignal } = {},
    ): Promise<GitComparisonBase> {
        return await resolveGitComparisonBase({
            ...(options.head === undefined ? {} : { head: options.head }),
            run: async (args) =>
                await this.readOnly(cwd, args, {
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                    ...(options.runnerId === undefined ? {} : { runnerId: options.runnerId }),
                }),
        });
    }

    /** The exact bytes of one path at one revision, or that it is absent there. */
    async readFileAtRevision(
        options: GitPlacement & {
            readonly maximumBytes: number;
            readonly path: string;
            readonly relativePath: string;
            readonly revision: string;
            readonly signal?: AbortSignal;
        },
    ): Promise<GitRevisionFile> {
        return await readGitFileAtRevision({
            maximumBytes: options.maximumBytes,
            path: options.path,
            relativePath: options.relativePath,
            revision: options.revision,
            runGit: this.#machine(options.runnerId).scan,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** Every tracked and untracked file a working tree holds, bounded and ignore-aware. */
    async listWorkingTreeFiles(
        options: GitPlacement & {
            readonly path: string;
            readonly signal?: AbortSignal;
        },
    ): Promise<GitWorkingTreeFiles> {
        return await listGitWorkingTreeFiles({
            path: options.path,
            runGit: this.#machine(options.runnerId).scan,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** How many lines an untracked file adds, and whether it is binary or could not be counted. */
    async countUntrackedFileLines(
        path: string,
        maximumBytes: number,
        placement: GitPlacement = {},
    ): Promise<UntrackedFileCount> {
        if (placement.runnerId === undefined)
            return await countUntrackedFileLines(path, maximumBytes);
        return await this.#machine(placement.runnerId).files.countUntrackedLines(
            path,
            maximumBytes,
        );
    }

    // --- Changing a repository -------------------------------------------------------------

    /**
     * Clones a remote into a folder that does not exist yet.
     *
     * The clone runs in a private staging directory, proves the checkout's identity, and is only
     * then renamed into place, so a failed or interrupted clone never exposes a partial project.
     */
    async clone(
        options: GitPlacement & {
            readonly credential?: GitCredentialRef;
            readonly destination: string;
            readonly gitIdentity?: { readonly email: string; readonly name: string };
            readonly source: GitRemoteSource;
        },
    ): Promise<void> {
        const authentication =
            options.credential === undefined
                ? undefined
                : this.daemonAuthentication(
                      options.credential.projectId,
                      options.credential.creator,
                  );
        if (options.runnerId !== undefined) {
            const runnerId = options.runnerId;
            const machine = await this.#runnerMachine(runnerId);
            await cloneOnRunner(this.#root().named("runner-git-clone"), machine, {
                destination: options.destination,
                source: options.source,
                ...(authentication === undefined
                    ? {}
                    : {
                          gitAuthentication: await this.#throughTunnel(
                              runnerId,
                              machine,
                              authentication,
                          ),
                      }),
                ...(options.gitIdentity === undefined ? {} : { gitIdentity: options.gitIdentity }),
            });
            return;
        }
        await cloneRemoteRepository({
            destination: options.destination,
            source: options.source,
            ...(authentication === undefined ? {} : { gitAuthentication: authentication }),
            ...(options.gitIdentity === undefined ? {} : { gitIdentity: options.gitIdentity }),
        });
    }

    /** The commit a new workspace should start from, fetching origin first when it can. */
    async resolveWorkspaceBase(
        options: GitPlacement & {
            readonly credential?: GitCredentialRef;
            readonly defaultBranch?: string;
            readonly projectPath: string;
            readonly requestedRef?: string;
            readonly signal?: AbortSignal;
        },
    ): Promise<WorkspaceBase> {
        return await resolveWorkspaceBase({
            git: this.#machine(options.runnerId).foreground(options.credential),
            projectPath: options.projectPath,
            ...(options.defaultBranch === undefined
                ? {}
                : { defaultBranch: options.defaultBranch }),
            ...(options.requestedRef === undefined ? {} : { requestedRef: options.requestedRef }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
    }

    /** Cuts a worktree on a new branch and proves Git created it where and from what it was told. */
    async createWorktree(
        options: GitPlacement & {
            readonly branch: string;
            readonly commit: string;
            readonly credential?: GitCredentialRef;
            readonly expectedCommonDir: string;
            readonly projectPath: string;
            readonly workspacePath: string;
        },
    ): Promise<void> {
        const machine = this.#machine(options.runnerId);
        await createGitWorktree({
            branch: options.branch,
            commit: options.commit,
            expectedCommonDir: options.expectedCommonDir,
            git: machine.foreground(options.credential),
            ...(options.runnerId === undefined
                ? {}
                : { makeParent: async (path: string) => await machine.makeDirectory(path) }),
            projectPath: options.projectPath,
            workspacePath: options.workspacePath,
        });
        this.invalidate(options.projectPath);
    }

    /**
     * Retires a worktree, optionally deleting its folder.
     *
     * Deletion is refused unless the path is a real directory that is the top level of its own
     * worktree and shares the repository the caller named.
     */
    async removeWorktree(
        options: GitPlacement & {
            readonly credential?: GitCredentialRef;
            readonly expectedCommonDir: string;
            readonly projectPath: string;
            readonly removeDirectory: boolean;
            readonly workspacePath: string;
        },
    ): Promise<void> {
        const machine = this.#machine(options.runnerId);
        await removeGitWorktree({
            expectedCommonDir: options.expectedCommonDir,
            git: machine.foreground(options.credential),
            ...(options.runnerId === undefined
                ? {}
                : { inspect: async (path: string) => await machine.inspect(path) }),
            projectPath: options.projectPath,
            removeDirectory: options.removeDirectory,
            workspacePath: options.workspacePath,
        });
        this.invalidate(options.workspacePath);
        this.invalidate(options.projectPath);
    }

    /** Renames the branch a worktree is on, refusing when it is not the branch the caller named. */
    async renameBranch(
        options: GitPlacement & {
            readonly credential?: GitCredentialRef;
            readonly expectedCommonDir: string;
            readonly from: string;
            readonly to: string;
            readonly workspacePath: string;
        },
    ): Promise<void> {
        await renameGitBranch({
            expectedCommonDir: options.expectedCommonDir,
            from: options.from,
            git: this.#machine(options.runnerId).foreground(options.credential),
            to: options.to,
            workspacePath: options.workspacePath,
        });
        this.invalidate(options.workspacePath);
    }

    // --- Repository credentials ------------------------------------------------------------

    /**
     * Who this machine commits as, read from Git's own configuration.
     *
     * A clone made on someone's behalf writes commits, and commits need a name and an address.
     * Asking Git is the honest answer: it is the same identity the person's own commits already
     * carry. When Git has nothing configured there is no local identity at all, and the caller
     * decides what that means rather than being handed an invented person.
     */
    async localIdentity(): Promise<{ readonly email: string; readonly name: string } | undefined> {
        const read = async (key: string): Promise<string | undefined> => {
            const result = await this.run(homedir(), ["config", "--get", key], {
                maxOutputBytes: 4_096,
            });
            if (result.code !== 0) return undefined;
            const value = result.stdout.trim();
            return value.length > 0 ? value : undefined;
        };
        const [email, name] = await Promise.all([read("user.email"), read("user.name")]);
        if (email === undefined || name === undefined) return undefined;
        return { email, name };
    }

    /**
     * Records a repository token and returns the environment Git needs to use it.
     *
     * The token never reaches Git itself: it stays in this process behind a loopback proxy that
     * only serves the one repository it was registered for.
     */
    async registerCredential(input: RegisterGitCredential): Promise<GitAuthentication> {
        return await this.#credentials.register(input);
    }

    /** The leaseable credential for a command the model or a person is about to run. */
    commandAuthentication(
        projectId: string,
        creator: ProjectCreator,
    ): GitCommandAuthentication | undefined {
        return this.#credentials.authentication(projectId, creator);
    }

    /** The credential Happy Agent's own background Git work carries for a project. */
    daemonAuthentication(
        projectId: string,
        creator: ProjectCreator,
    ): GitAuthentication | undefined {
        return this.#credentials.daemonAuthentication(projectId, creator);
    }

    /** Forgets every credential registered for a project. */
    revokeCredentials(projectId: string): void {
        this.#credentials.revoke(projectId);
    }

    // --- Snapshots -------------------------------------------------------------------------

    /** The public Git state shared by HTTP and encrypted session reads. */
    resource(snapshot: GitChangeSnapshot) {
        return {
            facts: {
                branch: snapshot.facts.branch ?? null,
                detached: snapshot.facts.detached,
                head: snapshot.facts.head ?? null,
                upstream: snapshot.facts.upstream ?? null,
                ahead: snapshot.facts.ahead,
                behind: snapshot.facts.behind,
            },
            comparison: snapshot.comparison,
            base: snapshot.base ?? null,
            changedFiles: snapshot.changedFiles,
            insertions: snapshot.insertions,
            deletions: snapshot.deletions,
            countsExact: snapshot.countsExact,
            conflicted: snapshot.conflicted,
            files: snapshot.files.map((file) => ({
                path: file.path,
                ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
                status: file.status,
                staged: file.staged,
                unstaged: file.unstaged,
                binary: file.binary,
                ...(file.insertions === undefined ? {} : { insertions: file.insertions }),
                ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
            })),
            filesTruncated: snapshot.filesTruncated,
            scannedAt: snapshot.scannedAt,
        };
    }

    /** This module's identity, which every snapshot version is counted within. */
    generation(): string {
        return this.#generation;
    }

    /** One repository's change snapshot, served from a short-lived cache. */
    async snapshot(
        root: string,
        key = root,
        signal?: AbortSignal,
        placement: GitPlacement = {},
    ): Promise<GitChangeSnapshot> {
        const now = Date.now();
        this.#evictExpired(now);
        const cached = this.#cache.get(key);
        if (
            cached !== undefined &&
            cached.expiresAt > now &&
            cached.root === root &&
            cached.runnerId === placement.runnerId
        ) {
            this.#cache.delete(key);
            this.#cache.set(key, cached);
            return cached.snapshot;
        }
        const machine = this.#machine(placement.runnerId);
        const state = await scanGitRepository({
            files: machine.files,
            path: root,
            runGit: machine.scan,
            ...(signal === undefined ? {} : { signal }),
        });
        const files = state.files.slice(0, MAX_SNAPSHOT_FILES);
        const snapshot: GitChangeSnapshot = {
            ...state,
            files,
            filesTruncated: state.filesTruncated || state.files.length > files.length,
            generation: this.#generation,
            version: ++this.#version,
        };
        this.#cache.delete(key);
        while (this.#cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = this.#cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#cache.delete(oldest);
        }
        this.#cache.set(key, {
            expiresAt: Date.now() + SNAPSHOT_CACHE_MS,
            root,
            runnerId: placement.runnerId,
            snapshot,
        });
        return snapshot;
    }

    /** Snapshots for a batch of catalog entities, addressed the way a live subscriber reads them. */
    async watch(
        entities: readonly (GitEntity & GitPlacement & { readonly root: string })[],
    ): Promise<readonly GitLiveSnapshot[]> {
        const snapshots: GitLiveSnapshot[] = [];
        for (const entity of entities.slice(0, MAX_WATCH_ENTITIES)) {
            const snapshot = await this.snapshot(
                entity.root,
                `${entity.projectId}:${entity.workspaceId ?? ""}`,
                undefined,
                entity.runnerId === undefined ? {} : { runnerId: entity.runnerId },
            );
            snapshots.push(
                liveSnapshot(
                    {
                        path: entity.root,
                        projectId: entity.projectId,
                        ...(entity.workspaceId === undefined
                            ? {}
                            : { workspaceId: entity.workspaceId }),
                        ...(entity.runnerId === undefined ? {} : { runnerId: entity.runnerId }),
                    },
                    snapshot,
                ),
            );
        }
        return snapshots;
    }

    /** Drops cached snapshots, for one repository root or for all of them. */
    invalidate(root?: string): void {
        if (root === undefined) {
            this.#cache.clear();
            return;
        }
        for (const [key, value] of this.#cache) {
            if (value.root === root) this.#cache.delete(key);
        }
    }

    // --- Live tracking ---------------------------------------------------------------------

    /**
     * Watches one repository, keeping it in the module's bounded live set.
     *
     * Watching is a subscription, not a scan: file events are debounced, a rescan runs on the
     * module's own lifetime, and subscribers hear only about repositories that actually changed.
     */
    track(entity: GitTrackedEntity): void {
        if (this.#disposed) return;
        if (entity.runnerId !== undefined) {
            this.#runnerTrackerInstance().watch({ ...entity, runnerId: entity.runnerId });
            return;
        }
        this.#trackerInstance().watch(entity);
    }

    /**
     * Atomically replaces the live-watch set.
     *
     * Re-registering an unchanged entity retains its watcher and last snapshot and only renews its
     * lifetime; the stale fallback owns reconciliation. An omitted entity is retired immediately,
     * even when its first scan has not completed, so it cannot keep a filesystem watcher, timer, or
     * pending publication alive after the caller lost interest.
     */
    replaceTracked(entities: readonly GitTrackedEntity[]): void {
        if (!Value.Check(gitTrackedEntitiesSchema, entities)) {
            throw new Error("The Git watch entities are invalid.");
        }
        if (this.#disposed) return;
        const local = entities.filter((entity) => entity.runnerId === undefined);
        const remote = entities.flatMap((entity) =>
            entity.runnerId === undefined ? [] : [{ ...entity, runnerId: entity.runnerId }],
        );
        if (remote.length > 0) this.#runnerTrackerInstance().replace(remote);
        else this.#runnerTracker?.replace([]);
        if (local.length === 0) {
            this.#tracker?.replace([]);
            return;
        }
        this.#trackerInstance().replace(local);
    }

    /** Stops watching one repository and releases its watchers and timers. */
    untrack(entity: GitTrackedEntity): void {
        if (entity.runnerId !== undefined) this.#runnerTracker?.unwatch(entity);
        else this.#tracker?.unwatch(entity);
    }

    /**
     * Watches one folder's working tree until the returned function is called.
     *
     * Every observer of the same folder shares one native recursive watch that excludes what Git
     * ignores, and it is the same watch the live Git tracking uses. `onWatching(false)` means
     * events are not arriving and the caller must poll; `onChanges(null)` means some may have
     * been missed.
     */
    watchWorkingTree(
        root: string,
        observer: WorkingTreeObserver,
        placement: GitPlacement = {},
    ): () => void {
        if (this.#disposed) return () => undefined;
        const runnerId = placement.runnerId;
        if (runnerId !== undefined) {
            return watchRunnerWorkingTree(
                this.#root().named("runner-working-tree-watch"),
                async () => await this.#runnerMachine(runnerId),
                root,
                observer,
            );
        }
        return this.#treeInstance().watch(root, observer);
    }

    /** Tells the watcher a repository is dirty, for a change it saw before the watcher did. */
    markChanged(entity: GitTrackedEntity): void {
        if (entity.runnerId !== undefined) this.#runnerTracker?.markChanged(entity);
        else this.#tracker?.markChanged(entity);
    }

    /** What the last scan of a watched repository found, if it has been scanned at all. */
    trackedSnapshot(entity: GitTrackedEntity): GitChangeSnapshot | undefined {
        return entity.runnerId !== undefined
            ? this.#runnerTracker?.snapshot(entity)
            : this.#tracker?.snapshot(entity);
    }

    /** Every watched repository that has a snapshot, ready to be sent to a live subscriber. */
    liveSnapshots(): readonly GitLiveSnapshot[] {
        return [...(this.#tracker?.tracked() ?? []), ...(this.#runnerTracker?.tracked() ?? [])].map(
            ({ entity, snapshot }) => liveSnapshot(entity, snapshot),
        );
    }

    /** The repositories currently being watched, most recently used first. */
    trackedKeys(): readonly string[] {
        return [...(this.#tracker?.trackedKeys ?? []), ...(this.#runnerTracker?.trackedKeys ?? [])];
    }

    /** Rescans one repository now, whether or not it is already watched. */
    async refresh(ctx: Context, entity: GitTrackedEntity): Promise<GitChangeSnapshot | undefined> {
        if (this.#disposed) return undefined;
        if (entity.runnerId !== undefined) {
            return await this.#runnerTrackerInstance().refresh(ctx, {
                ...entity,
                runnerId: entity.runnerId,
            });
        }
        return await this.#trackerInstance().refresh(ctx, entity);
    }

    /**
     * Subscribes to every snapshot a watched repository produces, until the returned function is
     * called.
     *
     * A subscriber that throws is treated as a failed delivery rather than a successful one, so
     * the same snapshot stays pending behind the watcher's bounded backoff and is offered again.
     */
    onSnapshot(observer: GitSnapshotObserver): () => void {
        this.#observers.add(observer);
        return () => {
            this.#observers.delete(observer);
        };
    }

    /** Stops every watcher, clears the snapshot cache, and closes the credential broker. */
    dispose(): void {
        this.#disposed = true;
        this.#tracker?.dispose();
        this.#tracker = undefined;
        this.#tree?.dispose();
        this.#tree = undefined;
        this.#runnerTracker?.dispose();
        this.#runnerTracker = undefined;
        this.#tunnel.close();
        this.#runnerMachines.clear();
        this.#observers.clear();
        this.#cache.clear();
        this.#credentials.close();
    }

    // --- Internals -------------------------------------------------------------------------

    #treeInstance(): WorkingTreeWatcher {
        this.#tree ??= new WorkingTreeWatcher(this.#root(), this.#scan);
        return this.#tree;
    }

    #trackerInstance(): GitStateTracker {
        const tree = this.#treeInstance();
        this.#tracker ??= new GitStateTracker(
            this.#root(),
            this.#scan,
            {
                deliver: async (ctx, entity, snapshot) => {
                    // Snapshotted so a subscriber that unsubscribes mid-delivery still sees this one.
                    const observers = Array.from(this.#observers);
                    for (const observer of observers) {
                        await observer(ctx, entity, snapshot);
                    }
                },
                report: (ctx, error, entity) => {
                    ctx.log.debug("A Git watcher could not scan a repository.", {
                        path: entity.path,
                        projectId: entity.projectId,
                    });
                    ctx.log.debug("The Git watcher failure was:", {}, error);
                },
                stamp: (state) => this.#stamp(state),
            },
            tree,
        );
        return this.#tracker;
    }

    #runnerTrackerInstance(): RunnerGitStateTracker {
        this.#runnerTracker ??= new RunnerGitStateTracker(
            this.#root(),
            {
                deliver: async (ctx, entity, snapshot) => {
                    const observers = Array.from(this.#observers);
                    for (const observer of observers) await observer(ctx, entity, snapshot);
                },
                report: (ctx, error, entity) => {
                    ctx.log.debug("A Git watcher could not scan a repository on a runner.", {
                        path: entity.path,
                        projectId: entity.projectId,
                        runnerId: entity.runnerId,
                    });
                    ctx.log.debug("The Git watcher failure was:", {}, error);
                },
                stamp: (state) => this.#stamp(state),
            },
            (runnerId): RunnerGitAccess => {
                const machine = this.#machine(runnerId);
                return {
                    machine: async () => await this.#runnerMachine(runnerId),
                    scan: machine.scan,
                    files: machine.files,
                };
            },
        );
        return this.#runnerTracker;
    }

    #stamp(state: GitChangeState): GitChangeSnapshot {
        return { ...state, generation: this.#generation, version: ++this.#version };
    }

    /**
     * The lifetime background Git work runs on.
     *
     * `beforeStart` adopts the collection's lifetime. A caller using this module without an agent
     * collection — the daemon's HTTP surface does — gets a lifetime of its own instead.
     */
    #root(): RootContext {
        this.#lifetime ??= createRootContext();
        return this.#lifetime;
    }

    /** Git work on this machine, or on the runner named. */
    #machine(runnerId: string | undefined): GitMachine {
        if (runnerId === undefined) {
            return {
                foreground: (credential) => this.#foregroundFor(credential),
                read: this.#read,
                scan: this.#scan,
                files: localGitWorkingFiles,
                isDirectory: async (path) =>
                    await stat(path)
                        .then((stats) => stats.isDirectory())
                        .catch(() => false),
                makeDirectory: async (path) => {
                    await mkdir(path, { recursive: true, mode: 0o700 });
                },
                inspect: async (path) => {
                    const stats = await lstat(path);
                    return {
                        isDirectory: stats.isDirectory(),
                        isSymbolicLink: stats.isSymbolicLink(),
                    };
                },
            };
        }
        const existing = this.#runnerMachines.get(runnerId);
        if (existing !== undefined) return existing;
        const target = {
            machine: async () => await this.#runnerMachine(runnerId),
            ctx: () => this.#root().named("runner-git"),
        };
        const scan = runnerScanGit(target, () => this.#config?.gitCeilingDirectories);
        const plain = runnerGitCommandRunner(target);
        const created: GitMachine = {
            foreground: (credential) => {
                const authentication =
                    credential === undefined
                        ? undefined
                        : this.daemonAuthentication(credential.projectId, credential.creator);
                if (authentication === undefined) return plain;
                return runnerGitCommandRunner(target, async () => {
                    const machine = await this.#runnerMachine(runnerId);
                    return {
                        GIT_CONFIG_GLOBAL: "/dev/null",
                        GIT_CONFIG_NOSYSTEM: "1",
                        ...(await this.#throughTunnel(runnerId, machine, authentication))
                            .environment,
                    };
                });
            },
            read: gitCommandRunnerFromScanGitRunner(scan),
            scan,
            files: runnerGitWorkingFiles(target.machine),
            isDirectory: async (path) => {
                const machine = await this.#runnerMachine(runnerId);
                return await machine.fs
                    .stat(PRODUCT, path)
                    .then((stats) => stats.isDirectory)
                    .catch(() => false);
            },
            makeDirectory: async (path) => {
                await (
                    await this.#runnerMachine(runnerId)
                ).fs.mkdir(PRODUCT, path, {
                    recursive: true,
                });
            },
            inspect: async (path) => {
                const stats = await (await this.#runnerMachine(runnerId)).fs.lstat(PRODUCT, path);
                return { isDirectory: stats.isDirectory, isSymbolicLink: stats.isSymbolicLink };
            },
        };
        this.#runnerMachines.set(runnerId, created);
        return created;
    }

    async #runnerMachine(runnerId: string): Promise<Compute> {
        if (this.#runners === undefined) {
            throw new Error("Git cannot reach runners without the runners module.");
        }
        return await this.#runners.machine(runnerId);
    }

    /** The credential's environment, pointed at the runner's own way back to the proxy. */
    async #throughTunnel(
        runnerId: string,
        machine: Compute,
        authentication: GitAuthentication,
    ): Promise<GitAuthentication> {
        const port = await this.#tunnel.port(
            this.#root().named(`runner-git-tunnel-${runnerId}`),
            machine,
            authentication.loopbackPort,
        );
        const here = `127.0.0.1:${String(authentication.loopbackPort)}`;
        const there = `127.0.0.1:${String(port)}`;
        return {
            environment: Object.fromEntries(
                Object.entries(authentication.environment).map(([name, value]) => [
                    name,
                    value.replaceAll(here, there),
                ]),
            ),
            loopbackPort: port,
        };
    }

    /** The foreground boundary: writes, fetches, and anything needing a repository credential. */
    #foregroundFor(credential: GitCredentialRef | undefined): GitCommandRunner {
        if (credential === undefined || !this.#direct) return this.#foreground;
        const authentication = this.daemonAuthentication(credential.projectId, credential.creator);
        if (authentication === undefined) return this.#foreground;
        return {
            run: async (cwd, args, options) =>
                await runGitCommandWithEnvironment(
                    cwd,
                    args,
                    {
                        GIT_CONFIG_GLOBAL: "/dev/null",
                        GIT_CONFIG_NOSYSTEM: "1",
                        ...authentication.environment,
                    },
                    options,
                ),
        };
    }

    /** The unattended read boundary, which still carries a credential when the read needs one. */
    #readFor(credential: GitCredentialRef | undefined, runnerId?: string): GitCommandRunner {
        const machine = this.#machine(runnerId);
        if (credential === undefined) return machine.read;
        return machine.foreground(credential);
    }

    #evictExpired(now: number): void {
        for (const [key, cached] of this.#cache) {
            if (cached.expiresAt <= now) this.#cache.delete(key);
        }
    }
}

function liveSnapshot(entity: GitTrackedEntity, git: GitChangeSnapshot): GitLiveSnapshot {
    return {
        createdAt: git.scannedAt,
        data: { git },
        id: randomUUID(),
        projectId: entity.projectId,
        type: entity.workspaceId === undefined ? "project_git_changed" : "workspace_git_changed",
        ...(entity.workspaceId === undefined ? {} : { workspaceId: entity.workspaceId }),
    };
}
