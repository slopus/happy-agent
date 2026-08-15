import type { Usage } from "../index.js";

export function addUsage(left: Usage, right: Usage): Usage {
    return {
        cacheRead: left.cacheRead + right.cacheRead,
        cacheWrite: left.cacheWrite + right.cacheWrite,
        cost: {
            cacheRead: left.cost.cacheRead + right.cost.cacheRead,
            cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
            input: left.cost.input + right.cost.input,
            output: left.cost.output + right.cost.output,
            total: left.cost.total + right.cost.total,
        },
        input: left.input + right.input,
        output: left.output + right.output,
        ...addReasoning(left, right),
        totalTokens: left.totalTokens + right.totalTokens,
    };
}

function addReasoning(left: Usage, right: Usage): Pick<Usage, "reasoning"> | object {
    if (left.totalTokens === 0 && left.reasoning === undefined) {
        return right.reasoning === undefined ? {} : { reasoning: right.reasoning };
    }
    return left.reasoning === undefined || right.reasoning === undefined
        ? {}
        : { reasoning: left.reasoning + right.reasoning };
}
