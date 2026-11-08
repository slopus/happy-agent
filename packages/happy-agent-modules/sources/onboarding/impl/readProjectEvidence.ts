/** Runs one read-only Git command in a folder and returns its trimmed output, or throws. */
export type ReadGit = (
    cwd: string,
    args: readonly string[],
    signal: AbortSignal,
) => Promise<string>;

export interface GitCommitEvidence {
    readonly when: string;
    readonly subject: string;
}

export type ProjectEvidence =
    | { readonly kind: "notGit" }
    | { readonly kind: "unreadable" }
    | {
          readonly kind: "git";
          /** The checked-out branch, or nothing when HEAD is detached. */
          readonly branch: string | undefined;
          readonly noCommits: boolean;
          /** How many paths have uncommitted changes, and the first few of them. */
          readonly changed: number;
          readonly changedFiles: readonly string[];
          readonly commits: readonly GitCommitEvidence[];
          readonly branches: readonly { readonly name: string; readonly when: string }[];
          /** Commits of the last two weeks whose changes touched a TODO or FIXME line. */
          readonly todoCommits: readonly (GitCommitEvidence & {
              readonly files: readonly string[];
          })[];
      };

const MAX_CHANGED_FILES = 8;
const MAX_TEXT = 160;

/**
 * A project's Git metadata, the way the first-project recipe reads it: uncommitted changes, the
 * last commits, the most recently committed branches, and recent commits that touched TODO or
 * FIXME lines. Names and subjects only, never file contents.
 */
export async function readProjectEvidence(
    path: string,
    git: ReadGit,
    signal: AbortSignal,
): Promise<ProjectEvidence> {
    const [status, log, refs, todos] = await Promise.allSettled([
        git(path, ["status", "--porcelain=v1", "--branch"], signal),
        git(path, ["log", "-5", "--format=%ar%x09%s"], signal),
        git(
            path,
            [
                "for-each-ref",
                "--sort=-committerdate",
                "--count=3",
                "--format=%(refname:short)%09%(committerdate:relative)",
                "refs/heads",
            ],
            signal,
        ),
        git(
            path,
            [
                "log",
                "-10",
                "--since=2.weeks",
                "-G",
                "TODO|FIXME",
                "--format=%x1e%ar%x09%s",
                "--name-only",
            ],
            signal,
        ),
    ]);
    if (status.status === "rejected") {
        const reason: unknown = status.reason;
        const stderr =
            reason instanceof Error && "stderr" in reason ? String(reason.stderr) : String(reason);
        return /not a git repository/iu.test(stderr) ? { kind: "notGit" } : { kind: "unreadable" };
    }
    const [head = "", ...changes] = status.value.split("\n").filter((line) => line.length > 0);
    const where = head.replace(/^## /u, "");
    const unborn = /^No commits yet on (.+)$/u.exec(where);
    const branch = unborn?.[1] ?? where.split("...")[0];
    return {
        kind: "git",
        branch: branch === undefined || branch.startsWith("HEAD (") ? undefined : clean(branch),
        noCommits: unborn !== null,
        changed: changes.length,
        changedFiles: changes.slice(0, MAX_CHANGED_FILES).map((line) => clean(line.slice(3))),
        commits: lines(log).map(commit),
        branches: lines(refs).map((line) => {
            const [name = "", when = ""] = line.split("\t");
            return { name: clean(name), when: clean(when) };
        }),
        todoCommits:
            todos.status === "fulfilled"
                ? todos.value
                      .split("\u001e")
                      .filter((entry) => entry.trim().length > 0)
                      .map((entry) => {
                          const [first = "", ...files] = entry
                              .split("\n")
                              .filter((line) => line.length > 0);
                          return {
                              ...commit(first),
                              files: files.slice(0, MAX_CHANGED_FILES).map(clean),
                          };
                      })
                : [],
    };
}

function lines(result: PromiseSettledResult<string>): string[] {
    return result.status === "fulfilled"
        ? result.value.split("\n").filter((line) => line.length > 0)
        : [];
}

function commit(line: string): GitCommitEvidence {
    const tab = line.indexOf("\t");
    return tab < 0
        ? { when: "", subject: clean(line) }
        : { when: clean(line.slice(0, tab)), subject: clean(line.slice(tab + 1)) };
}

/** One line of plain text from the person's files, without control characters, bounded. */
function clean(text: string): string {
    // oxlint-disable-next-line no-control-regex -- control characters are what it removes.
    const plain = text.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    return plain.length > MAX_TEXT ? `${plain.slice(0, MAX_TEXT - 1)}…` : plain;
}
