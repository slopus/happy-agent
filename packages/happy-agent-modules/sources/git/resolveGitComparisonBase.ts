import { Type, type Static } from "@sinclair/typebox";

export const gitComparisonBaseSchema = Type.Object(
    {
        base: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type GitComparisonBase = Static<typeof gitComparisonBaseSchema>;
export type GitBaseRunner = (args: readonly string[]) => Promise<string>;

export async function resolveGitComparisonBase(options: {
    head?: string;
    run: GitBaseRunner;
}): Promise<GitComparisonBase> {
    if (options.head === undefined) {
        return { error: "This repository has no commits yet." };
    }
    const originMain = await tryRun(options.run, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "origin/main^{commit}",
    ]);
    if (originMain === undefined || originMain.length === 0) {
        return { error: "The remote main branch is unavailable." };
    }
    const mergeBase = await tryRun(options.run, [
        "merge-base",
        "--end-of-options",
        originMain,
        options.head,
    ]);
    return mergeBase === undefined || mergeBase.length === 0
        ? { error: "This branch no longer shares history with origin/main." }
        : { base: mergeBase };
}

async function tryRun(run: GitBaseRunner, args: readonly string[]): Promise<string | undefined> {
    try {
        return (await run(args)).trim();
    } catch {
        return undefined;
    }
}
