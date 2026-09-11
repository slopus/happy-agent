/**
 * The Git module's public surface.
 *
 * `GitModule` is the whole feature: every repository read, mutation, credential, and live watch
 * goes through an instance of it. The names below are only the module class and the types callers
 * need to speak about what its methods take and return. The commands themselves stay private —
 * ask the module instead of importing a file out of this folder.
 */
export { GitModule } from "./GitModule.js";
export {
    gitCredentialRefSchema,
    gitEntitySchema,
    gitTrackedEntitiesSchema,
    gitWatchSchema,
    type GitChangedFile,
    type GitCredentialRef,
    type GitEntity,
    type GitOperationOptions,
    type GitResource,
    type GitSnapshotObserver,
    type GitWatchInput,
} from "./GitModule.js";

export {
    gitChangeSnapshotSchema,
    gitChangeStateSchema,
    gitFileChangeSchema,
    gitFileChangeStatusSchema,
    gitLiveSnapshotSchema,
    gitRemoteSourceSchema,
    gitRepositoryFactsSchema,
    gitTrackedEntitySchema,
    projectCreatorSchema,
    type GitChangeSnapshot,
    type GitChangeState,
    type GitFileChange,
    type GitFileChangeStatus,
    type GitLiveSnapshot,
    type GitRemoteSource,
    type GitRepositoryFacts,
    type GitTrackedEntity,
    type ProjectCreator,
} from "./types.js";

export { gitRepositoryProbeSchema, type GitRepositoryProbe } from "./probeGitRepository.js";
export { type GitWorktreeIdentity } from "./readGitWorktreeIdentity.js";
export { type GitComparisonBase } from "./resolveGitComparisonBase.js";
export { workspaceBaseSchema, type WorkspaceBase } from "./resolveWorkspaceBase.js";
export { GitRevisionFileTooLargeError, type GitRevisionFile } from "./readGitFileAtRevision.js";
export { type GitWorkingTreeFiles } from "./listGitWorkingTreeFiles.js";
export { type UntrackedFileCount } from "./countUntrackedFileLines.js";
export { type HostingRepository } from "./parseHostingRepository.js";
export {
    type GitAuthentication,
    type GitCommandAuthentication,
    type GitCommandAuthenticationLease,
    type RegisterGitCredential,
} from "./GitCredentialBroker.js";

/**
 * Still published only because callers outside this package have not moved to `GitModule` yet.
 *
 * `.context/wiring/git.md` lists what each of these becomes. Do not add new uses of them.
 */
export {
    gitCommandResultSchema,
    type GitCommandOptions,
    type GitCommandResult,
    type GitCommandRunner,
} from "./GitCommandRunner.js";
export { directGitCommandRunner } from "./runGitCommand.js";
