import type { Model } from "@slopus/happy-agent-base";

export function defineTestModel<const TThinkingLevel extends string>(model: {
    id: string;
    name: string;
    thinkingLevels: readonly TThinkingLevel[];
    defaultThinkingLevel: TThinkingLevel;
    contextWindow?: number;
    autoCompactWindow?: number;
}): Model<TThinkingLevel> {
    return model;
}