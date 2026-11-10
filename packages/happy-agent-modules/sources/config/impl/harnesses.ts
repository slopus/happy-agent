import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Who runs an agent's loop. `happy` is Happy's own loop on any provider. `claude-code` and
 * `codex-cli` run Claude Code or Codex itself on the `claude` or `codex` accounts they accept.
 * `antigravity`, `opencode`, and `acp` are agents with their own login; each such harness is
 * offered as an account of its own.
 */
export const HARNESS_TYPES = [
    "happy",
    "claude-code",
    "codex-cli",
    "antigravity",
    "opencode",
    "acp",
] as const;
export type HarnessType = (typeof HARNESS_TYPES)[number];

/** Harnesses that run on accounts Happy already has, and the provider type they accept. */
export const ATTACHED_HARNESS_PROVIDER_TYPES = {
    "claude-code": "claude",
    "codex-cli": "codex",
} as const;
export type AttachedHarnessType = keyof typeof ATTACHED_HARNESS_PROVIDER_TYPES;

/** Harnesses with their own login, offered as accounts under the harness ID. */
export const OWN_LOGIN_HARNESS_TYPES = ["antigravity", "opencode", "acp"] as const;
export type OwnLoginHarnessType = (typeof OWN_LOGIN_HARNESS_TYPES)[number];

/** Built-in harness IDs, whose type is implied. */
const BUILT_IN_HARNESSES: Readonly<Record<string, HarnessType>> = {
    happy: "happy",
    claude_code: "claude-code",
    codex_cli: "codex-cli",
    antigravity: "antigravity",
    opencode: "opencode",
};

/** Types that only exist once, under their built-in ID. */
const SINGLETON_TYPES: readonly HarnessType[] = ["happy", "claude-code", "codex-cli"];

const MAX_ITEMS = 256;
const stringSchema = Type.String({ minLength: 1, maxLength: 4096 });
const stringArraySchema = Type.Array(stringSchema, { maxItems: MAX_ITEMS });
const nameSchema = Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" });
const environmentSchema = Type.Record(stringSchema, stringSchema, { maxProperties: MAX_ITEMS });
const typeSchema = Type.Union(HARNESS_TYPES.map((type) => Type.Literal(type)));

export const harnessInputSchema = Type.Object(
    {
        api_key: Type.Optional(stringSchema),
        args: Type.Optional(stringArraySchema),
        command: Type.Optional(stringSchema),
        enabled: Type.Optional(Type.Boolean()),
        env: Type.Optional(environmentSchema),
        exclude_models: Type.Optional(stringArraySchema),
        hidden: Type.Optional(Type.Boolean()),
        include_models: Type.Optional(stringArraySchema),
        name: Type.Optional(nameSchema),
        providers: Type.Optional(stringArraySchema),
        subagent_harnesses: Type.Optional(stringArraySchema),
        telemetry: Type.Optional(Type.Boolean()),
        type: Type.Optional(typeSchema),
    },
    { additionalProperties: false },
);
export type HarnessInput = Static<typeof harnessInputSchema>;

export const harnessSchema = Type.Object(
    {
        apiKey: Type.Optional(stringSchema),
        args: Type.Optional(stringArraySchema),
        command: Type.Optional(stringSchema),
        enabled: Type.Boolean(),
        env: Type.Optional(environmentSchema),
        excludeModels: Type.Optional(stringArraySchema),
        hidden: Type.Optional(Type.Boolean()),
        includeModels: Type.Optional(stringArraySchema),
        name: Type.Optional(nameSchema),
        providers: Type.Optional(stringArraySchema),
        subagentHarnesses: Type.Optional(stringArraySchema),
        telemetry: Type.Optional(Type.Boolean()),
        type: typeSchema,
    },
    { additionalProperties: false },
);
export type Harness = Static<typeof harnessSchema>;

export const DEFAULT_HARNESSES: Readonly<Record<string, Harness>> = {
    happy: { enabled: true, type: "happy" },
};

/** Read and validate the `[harnesses]` table of one configuration file. */
export function readHarnesses(value: unknown): Record<string, HarnessInput> | undefined {
    if (value === undefined) return undefined;
    if (!isPlainTable(value)) throw new Error("harnesses must be a TOML table.");
    if (Object.keys(value).length > MAX_ITEMS) throw new Error("harnesses has too many entries.");
    const result: Record<string, HarnessInput> = {};
    for (const [id, input] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/u.test(id)) {
            throw new Error(`Harness "${id}" must be lowercase letters, digits, and underscores.`);
        }
        if (!isPlainTable(input)) throw new Error(`harnesses.${id} must be a TOML table.`);
        if (!Value.Check(harnessInputSchema, input)) {
            throw new Error(`harnesses.${id} has an invalid or unknown setting.`);
        }
        harnessType(id, input.type);
        result[id] = input;
    }
    return result;
}

/** The type a harness table has: its own, or the one its built-in ID implies. */
export function harnessType(id: string, type: HarnessType | undefined): HarnessType {
    const builtIn = BUILT_IN_HARNESSES[id];
    if (builtIn !== undefined && type !== undefined && type !== builtIn) {
        throw new Error(`Built-in harness "${id}" must use type "${builtIn}".`);
    }
    const resolved = type ?? builtIn;
    if (resolved === undefined) {
        throw new Error(
            `Harness "${id}" must set type to ${HARNESS_TYPES.map((t) => `"${t}"`).join(", ")}.`,
        );
    }
    if (builtIn === undefined && SINGLETON_TYPES.includes(resolved)) {
        const expected = Object.entries(BUILT_IN_HARNESSES).find(([, t]) => t === resolved)![0];
        throw new Error(`A "${resolved}" harness is configured as [harnesses.${expected}].`);
    }
    return resolved;
}

/** Merge one layer's harness tables over what earlier layers configured. */
export function mergeHarnesses(
    current: Readonly<Record<string, Harness>>,
    layer: Readonly<Record<string, HarnessInput>>,
): Record<string, Harness> {
    const merged: Record<string, Harness> = { ...current };
    for (const [id, input] of Object.entries(layer)) {
        const type = harnessType(id, input.type);
        const previous = merged[id]?.type === type ? merged[id] : undefined;
        merged[id] = {
            ...previous,
            ...(input.api_key === undefined ? {} : { apiKey: input.api_key }),
            ...(input.args === undefined ? {} : { args: input.args }),
            ...(input.command === undefined ? {} : { command: input.command }),
            ...(input.env === undefined ? {} : { env: input.env }),
            ...(input.exclude_models === undefined ? {} : { excludeModels: input.exclude_models }),
            ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
            ...(input.include_models === undefined ? {} : { includeModels: input.include_models }),
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.providers === undefined ? {} : { providers: input.providers }),
            ...(input.subagent_harnesses === undefined
                ? {}
                : { subagentHarnesses: input.subagent_harnesses }),
            ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
            // Writing a harness table turns it on; `enabled = false` keeps it configured but off.
            enabled: input.enabled ?? previous?.enabled ?? true,
            type,
        };
    }
    return merged;
}

/** A configured provider, as far as harness routing needs to know it. */
interface ProviderView {
    readonly type: string;
}

/**
 * Check what the merged harnesses refer to: every listed provider exists and has the type the
 * harness runs on, every ACP agent has a command, and no own-login harness shares an ID with a
 * provider account.
 */
export function validateHarnesses(
    harnesses: Readonly<Record<string, Harness>>,
    providers: Readonly<Record<string, ProviderView>>,
): void {
    for (const [id, harness] of Object.entries(harnesses)) {
        for (const target of harness.subagentHarnesses ?? []) {
            if (harnesses[target] === undefined) {
                throw new Error(`Harness "${id}" lists unknown sub-agent harness "${target}".`);
            }
        }
        if (harness.type === "acp" && harness.command === undefined) {
            throw new Error(`Harness "${id}" is an ACP agent and must set command.`);
        }
        if (harness.telemetry !== undefined && harness.type !== "claude-code") {
            throw new Error(`Harness "${id}" cannot set telemetry; only Claude Code takes it.`);
        }
        if (isOwnLoginHarness(harness)) {
            if (harness.providers !== undefined) {
                throw new Error(`Harness "${id}" uses its own login and takes no providers.`);
            }
            continue;
        }
        for (const providerId of harness.providers ?? []) {
            const provider = providers[providerId];
            if (provider === undefined) {
                throw new Error(`Harness "${id}" lists unknown provider "${providerId}".`);
            }
            if (!isAttachedHarness(harness)) continue;
            const expected = ATTACHED_HARNESS_PROVIDER_TYPES[harness.type];
            if (provider.type !== expected) {
                throw new Error(
                    `Harness "${id}" runs on "${expected}" providers, not "${providerId}".`,
                );
            }
        }
    }
}

export function isOwnLoginHarness(
    harness: Harness,
): harness is Harness & { readonly type: OwnLoginHarnessType } {
    return (OWN_LOGIN_HARNESS_TYPES as readonly string[]).includes(harness.type);
}

export function isAttachedHarness(
    harness: Harness,
): harness is Harness & { readonly type: AttachedHarnessType } {
    return harness.type in ATTACHED_HARNESS_PROVIDER_TYPES;
}

/**
 * Whether `harness` runs on provider `providerId`: the providers it lists, or by default every
 * provider of the type it runs on (`happy`: every provider).
 */
export function harnessAcceptsProvider(
    harness: Harness,
    providerId: string,
    provider: ProviderView,
): boolean {
    if (!harness.enabled) return false;
    if (harness.providers !== undefined) return harness.providers.includes(providerId);
    if (harness.type === "happy") return true;
    if (isAttachedHarness(harness)) {
        return provider.type === ATTACHED_HARNESS_PROVIDER_TYPES[harness.type];
    }
    return false;
}

/**
 * Foreign harnesses Happy's own loop reaches for by default: those whose models Happy cannot run
 * itself. Happy already runs Claude, GPT, and the rest across providers, so Claude Code, Codex CLI,
 * OpenCode, and unknown ACP agents are opt-in.
 */
const HAPPY_DEFAULT_SUBAGENT_TYPES: readonly HarnessType[] = ["antigravity"];

/**
 * Whether an agent on harness `creatorId` may create sub-agents on harness `targetId`. Its own
 * harness always; otherwise the creator's `subagent_harnesses` when set. By default Happy reaches
 * the foreign harnesses it has no counterpart for, and a foreign harness reaches every other
 * foreign harness but not Happy: someone on a native harness has chosen not to use Happy's loop.
 */
export function harnessAllowsSubagents(
    harnesses: Readonly<Record<string, Harness>>,
    creatorId: string,
    targetId: string,
): boolean {
    const target = harnesses[targetId];
    if (target === undefined || !target.enabled) return false;
    if (creatorId === targetId) return true;
    const creator = harnesses[creatorId];
    if (creator === undefined) return false;
    if (creator.subagentHarnesses !== undefined) {
        return creator.subagentHarnesses.includes(targetId);
    }
    if (creator.type === "happy") return HAPPY_DEFAULT_SUBAGENT_TYPES.includes(target.type);
    return target.type !== "happy";
}

/** Order `models` by `include`, drop those in `exclude`; models the agent does not list stay out. */
export function pickHarnessModels<T extends { readonly id: string }>(
    models: readonly T[],
    include: readonly string[] | undefined,
    exclude: readonly string[] | undefined,
): readonly T[] {
    const kept = models.filter(
        (model) => exclude?.includes(model.id) !== true && include?.includes(model.id) !== false,
    );
    if (include === undefined) return kept;
    return [...kept].sort((left, right) => include.indexOf(left.id) - include.indexOf(right.id));
}

function isPlainTable(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
