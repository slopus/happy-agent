/**
 * The closed registry of inline actions; see "Actions" under "Inline actions" in API.md. An
 * action ID that is not here, or parameters that do not check, leave a control unpressable.
 * `fixtures/inlineActions.registry.json` is this registry as data, for servers in other languages.
 */

/** One parameter an action reads from a `data-X` attribute. */
export interface ChatActionParameterRule {
    readonly required: boolean;
    readonly maxLength: number;
    /** A lowercase slug: letters, digits, and inner hyphens. */
    readonly slug?: true;
}

export interface ChatActionDefinition {
    /** `server`: the press is sent. `client`: the client runs it and sends nothing. */
    readonly route: "server" | "client";
    readonly params: Readonly<Record<string, ChatActionParameterRule>>;
    /** How many parameters it takes beyond `params`, each named by the parameter rule. */
    readonly extraParams: number;
    /** The longest value an extra parameter may have. */
    readonly extraMaxLength: number;
    /** Whether it may be a checklist's action, taking the ticked values. */
    readonly takesValues: boolean;
    /** Whether it may be a code field's action, taking what was typed. */
    readonly takesCode: boolean;
    /** `conversation`: any conversation the person may send to. `onboarding`: only the server's scripted onboarding message for the step it stands on. */
    readonly pressable: "conversation" | "onboarding";
}

export const CHAT_ACTIONS = {
    reply: {
        route: "server",
        params: { text: { required: false, maxLength: 2_000 } },
        extraParams: 0,
        extraMaxLength: 0,
        takesValues: true,
        takesCode: false,
        pressable: "conversation",
    },
    "onboarding.next": {
        route: "server",
        params: { step: { required: true, maxLength: 64, slug: true } },
        extraParams: 4,
        extraMaxLength: 128,
        takesValues: true,
        takesCode: true,
        pressable: "onboarding",
    },
} as const satisfies Readonly<Record<string, ChatActionDefinition>>;

export type ChatActionId = keyof typeof CHAT_ACTIONS;

/** A control's action, known and with its parameters checked. */
export type ChatAction =
    | {
          readonly id: "reply";
          readonly route: "server";
          /** Every parameter as written. */
          readonly params: Readonly<Record<string, string>>;
          /** The words a press sends, when they are not the control's label. */
          readonly text?: string;
      }
    | {
          readonly id: "onboarding.next";
          readonly route: "server";
          readonly params: Readonly<Record<string, string>>;
          /** The onboarding step the press asks for. */
          readonly step: string;
      };

/** A parameter name: lowercase letters, digits, and inner hyphens, starting with a letter. */
export const CHAT_ACTION_PARAMETER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The action a control names, or undefined when its ID is not in the registry or its parameters
 * do not check: a missing required one, an empty or too long value, or one it does not take.
 */
export function chatActionOf(
    id: string,
    params: Readonly<Record<string, string>>,
    use: "button" | "checklist" | "code",
): ChatAction | undefined {
    if (!Object.hasOwn(CHAT_ACTIONS, id)) return undefined;
    const definition: ChatActionDefinition = CHAT_ACTIONS[id as ChatActionId];
    if (use === "checklist" && !definition.takesValues) return undefined;
    if (use === "code" && !definition.takesCode) return undefined;
    let extra = 0;
    for (const [name, value] of Object.entries(params)) {
        if (!CHAT_ACTION_PARAMETER_NAME.test(name) || value.length === 0) return undefined;
        const rule = Object.hasOwn(definition.params, name) ? definition.params[name] : undefined;
        if (rule === undefined) {
            extra += 1;
            if (extra > definition.extraParams || value.length > definition.extraMaxLength) {
                return undefined;
            }
            continue;
        }
        if (value.length > rule.maxLength || (rule.slug === true && !SLUG.test(value))) {
            return undefined;
        }
    }
    for (const [name, rule] of Object.entries(definition.params)) {
        if (rule.required && !Object.hasOwn(params, name)) return undefined;
    }
    const frozen = Object.freeze({ ...params });
    switch (id as ChatActionId) {
        case "reply": {
            const text = params["text"]?.trim();
            if (params["text"] !== undefined && !text) return undefined;
            return text === undefined
                ? { id: "reply", route: "server", params: frozen }
                : { id: "reply", route: "server", params: frozen, text };
        }
        case "onboarding.next":
            return {
                id: "onboarding.next",
                route: "server",
                params: frozen,
                step: params["step"]!,
            };
    }
}
