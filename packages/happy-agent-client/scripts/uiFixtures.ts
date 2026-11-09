import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    chatUiCapabilitySchema,
    uiActionBlockSchema,
    uiActionRequestSchema,
    uiBlockSchema,
    uiDocumentFallback,
    uiDocumentSchema,
    uiPresentationSchema,
} from "../sources/protocol/ui.js";
import { uiActionText } from "../sources/ui/actionText.js";
import { UI_CATALOG_VERSION, uiActionDefinition, uiComponents } from "../sources/ui/catalog.js";
import { uiActionProblem, uiDocumentProblems } from "../sources/ui/checks.js";
import { uiOfferState } from "../sources/ui/offer.js";
import {
    UI_MEMBER_PERMISSIONS,
    UI_PERMISSION_IDS,
    uiActionAllowed,
    uiActionPermission,
} from "../sources/ui/permission.js";
import { redactUiValue, UI_SECRET_KEYWORD } from "../sources/ui/secret.js";

/**
 * The chat UI contract as data, for implementations outside TypeScript (Happy Cloud in Rust, the
 * iOS and Android apps): `ui.schema.json` holds every schema, and `actions.fixtures.json` holds
 * conformance vectors computed by this package's own functions. Regenerate both with
 * `pnpm --filter @slopus/happy-agent-client write:ui-fixtures`; a test fails while they are stale.
 */

/** Props for every component that has actions, as an offer stores them. */
const OFFER_PROPS: Record<string, unknown> = {
    choice: {
        options: [
            { id: "fix", label: "Fix the login redirect", primary: true },
            { id: "tests", label: "Run the tests" },
        ],
    },
    checklist: {
        options: [
            { id: "claude", label: "Claude" },
            { id: "codex", label: "Codex", checked: true },
            { id: "grok", label: "Grok" },
        ],
        submitLabel: "Use these",
        emptyLabel: "Continue without these",
    },
    text_field: { label: "Your nickname", submitLabel: "Save" },
    provider_sign_in: { provider: "claude" },
    default_model: {},
    phone_pair: {},
    invite: { role: "member" },
    github_connect: {},
    compute_join: { pool: "default" },
};

/** One valid and at least one invalid payload for every action in the catalog. */
const PAYLOADS: Record<string, { valid: unknown[]; invalid: unknown[] }> = {
    "choice.choose": {
        valid: [{ optionId: "fix" }],
        invalid: [{}, { optionId: "Fix" }, { optionId: "fix", extra: true }],
    },
    "checklist.submit": {
        valid: [{ selected: ["claude", "grok"] }, { selected: [] }],
        invalid: [{ selected: ["claude", "claude"] }, { selected: "claude" }],
    },
    "text_field.submit": {
        valid: [{ text: "Ada" }, { text: "Two\nlines" }],
        invalid: [{ text: "" }, { text: "x".repeat(2_001) }, { text: "bell\u0007" }],
    },
    "provider_sign_in.install": { valid: [{}], invalid: [{ provider: "claude" }] },
    "provider_sign_in.sign_in": { valid: [{}], invalid: [{ target: "team" }] },
    "provider_sign_in.submit_code": {
        valid: [{ code: "4F2-K9Q" }],
        invalid: [{}, { code: "" }, { code: "x".repeat(2_049) }],
    },
    "provider_sign_in.submit_token": {
        valid: [{ token: "sk-ant-oat01-example" }],
        invalid: [{}, { token: "" }, { token: "x".repeat(4_097) }],
    },
    "provider_sign_in.cancel": { valid: [{}], invalid: [{ now: true }] },
    "default_model.set": {
        valid: [{ providerId: "claude", modelId: "claude-opus-5-5", effort: "high" }],
        invalid: [{ modelId: "claude-opus-5-5", effort: "high" }, {}],
    },
    "phone_pair.start": { valid: [{}], invalid: [{ device: "ios" }] },
    "phone_pair.confirm": { valid: [{ pairingId: "pq7xk2m9r4t8w1y5z3a6b0c2" }], invalid: [{}] },
    "phone_pair.cancel": { valid: [{ pairingId: "pq7xk2m9r4t8w1y5z3a6b0c2" }], invalid: [{}] },
    "invite.create": { valid: [{ role: "member" }], invalid: [{}, { role: "Admin!" }] },
    "invite.revoke": { valid: [{ inviteId: "in1" }], invalid: [{}] },
    "github_connect.install": { valid: [{}], invalid: [{ owner: "slopus" }] },
    "github_connect.device_start": { valid: [{}], invalid: [{ scope: "repo" }] },
    "github_connect.connect": { valid: [{ installationId: "12345" }], invalid: [{}] },
    "compute_join.create": { valid: [{}], invalid: [{ pool: "default" }] },
};

/** Results with secrets, and what is left once they are left out. */
const RESULTS: Record<string, unknown> = {
    "phone_pair.start": {
        pairingId: "pq7xk2m9r4t8w1y5z3a6b0c2",
        pairing: "happy://direct?token=secret",
        expiresAt: 1755400420000,
    },
    "invite.create": {
        inviteId: "in1",
        code: "HAPPY-7Q2M",
        expiresAt: 1755400420000,
        serverName: "acme",
    },
    "github_connect.device_start": {
        userCode: "WDJB-MJHT",
        verificationUri: "https://github.com/login/device",
        expiresAt: 1755400420000,
    },
    "compute_join.create": {
        commands: ["curl -fsSL https://example.com/join | sh -s -- token"],
        expiresAt: 1755400420000,
    },
};

/** Who holds what: a standalone daemon's user, a team member, a viewer, nobody. */
const GRANTS: Record<string, readonly string[]> = {
    owner: UI_PERMISSION_IDS,
    member: UI_MEMBER_PERMISSIONS,
    viewer: [],
};

export function buildUiSchemaFile(): unknown {
    return {
        $comment:
            "Generated by packages/happy-agent-client/scripts/write-ui-fixtures.ts. Do not edit.",
        catalogVersion: UI_CATALOG_VERSION,
        secretKeyword: UI_SECRET_KEYWORD,
        permissions: [...UI_PERMISSION_IDS],
        memberPermissions: [...UI_MEMBER_PERMISSIONS],
        wire: {
            document: uiDocumentSchema,
            block: uiBlockSchema,
            presentation: uiPresentationSchema,
            actionBlock: uiActionBlockSchema,
            actionRequest: uiActionRequestSchema,
            capability: chatUiCapabilitySchema,
        },
        components: Object.fromEntries(
            uiComponents.map((bundle) => [
                bundle.type,
                {
                    description: bundle.description,
                    props: bundle.props,
                    ...(bundle.input === bundle.props ? {} : { input: bundle.input }),
                    actions: Object.fromEntries(
                        Object.entries(bundle.actions).map(([name, action]) => [
                            name,
                            {
                                payload: action.payload,
                                ...(action.result === undefined ? {} : { result: action.result }),
                                transcript: action.transcript,
                                once: action.once === true,
                                permission: action.permission ?? "content.write",
                            },
                        ]),
                    ),
                },
            ]),
        ),
    };
}

export function buildUiActionFixtures(): unknown {
    const payload = Object.entries(PAYLOADS).flatMap(([type, cases]) => {
        const found = uiActionDefinition(type)!;
        const schema = Type.Object({ type: Type.Literal(type), payload: found.definition.payload });
        return [
            ...cases.valid.map((value) => ({ type, payload: value })),
            ...cases.invalid.map((value) => ({ type, payload: value })),
        ].map((action) => ({
            component: found.bundle.type,
            action,
            schemaValid: Value.Check(schema, action),
            redacted: Value.Check(schema, action)
                ? redactUiValue(found.definition.payload, action.payload)
                : null,
        }));
    });
    const offer = Object.entries(PAYLOADS).flatMap(([type, cases]) => {
        const component = {
            type: uiActionDefinition(type)!.bundle.type,
            props: OFFER_PROPS[uiActionDefinition(type)!.bundle.type],
        };
        return cases.valid.map((value) => ({
            component,
            action: { type, payload: value },
            problem: uiActionProblem(component, { type, payload: value }) ?? null,
        }));
    });
    offer.push(
        ...[
            { type: "choice.choose", payload: { optionId: "deploy" } },
            { type: "checklist.submit", payload: { selected: ["claude", "gemini"] } },
            { type: "provider_sign_in.sign_in", payload: {} },
        ].map((action) => {
            const component = { type: "choice", props: OFFER_PROPS["choice"] };
            const target =
                action.type === "checklist.submit"
                    ? { type: "checklist", props: OFFER_PROPS["checklist"] }
                    : component;
            return {
                component: target,
                action,
                problem: uiActionProblem(target, action) ?? null,
            };
        }),
    );
    const permissionProps: Record<string, unknown[]> = {
        provider_sign_in: [
            { provider: "claude" },
            { provider: "claude", target: "team" },
            { provider: "claude", target: "private" },
        ],
    };
    const permission = uiComponents.flatMap((bundle) =>
        Object.entries(bundle.actions).flatMap(([name, action]) =>
            (permissionProps[bundle.type] ?? [OFFER_PROPS[bundle.type] ?? {}]).map((props) => ({
                action: `${bundle.type}.${name}`,
                props,
                permission: uiActionPermission(action, props),
                allowed: Object.fromEntries(
                    Object.entries(GRANTS).map(([who, granted]) => [
                        who,
                        uiActionAllowed(action, props, granted),
                    ]),
                ),
            })),
        ),
    );
    const actionText = [
        { type: "choice.choose", payload: { optionId: "tests" } },
        { type: "checklist.submit", payload: { selected: ["grok", "claude"] } },
        { type: "checklist.submit", payload: { selected: [] } },
        { type: "text_field.submit", payload: { text: "Ada" } },
        { type: "provider_sign_in.sign_in", payload: {} },
    ].map((action) => {
        const componentType = uiActionDefinition(action.type)!.bundle.type;
        const component = { type: componentType, props: OFFER_PROPS[componentType] };
        return { component, action, text: uiActionText(component, action) ?? null };
    });
    const choose = { type: "choice.choose", payload: { optionId: "fix" } };
    const other = { type: "choice.choose", payload: { optionId: "tests" } };
    const openOffer = [
        { once: false, accepted: choose, personSpokeAfter: true, action: other },
        { once: true, personSpokeAfter: false, action: choose },
        { once: true, personSpokeAfter: true, action: choose },
        { once: true, accepted: choose, personSpokeAfter: true, action: choose },
        { once: true, accepted: choose, personSpokeAfter: false, action: other },
        {
            once: true,
            accepted: { type: "checklist.submit", payload: { selected: ["claude", "codex"] } },
            personSpokeAfter: true,
            action: { type: "checklist.submit", payload: { selected: ["claude", "codex"] } },
        },
    ].map((input) => ({
        ...input,
        state: uiOfferState(
            {
                once: input.once,
                accepted: input.accepted,
                personSpokeAfter: input.personSpokeAfter,
            },
            input.action,
        ),
    }));
    const result = Object.entries(RESULTS).map(([type, value]) => ({
        type,
        result: value,
        redacted: redactUiValue(uiActionDefinition(type)!.definition.result!, value),
    }));
    const documents = [
        [{ id: "pick", fallback: "Fix · Tests", type: "choice", props: OFFER_PROPS["choice"] }],
        [
            {
                id: "claude",
                fallback: "Sign in to Claude in Happy on your computer",
                type: "provider_sign_in",
                props: { provider: "claude" },
            },
            {
                id: "codex",
                fallback: "Sign in to ChatGPT in Happy on your computer",
                type: "provider_sign_in",
                props: { provider: "codex" },
            },
        ],
        [
            { id: "dup", fallback: "", type: "phone_app", props: {} },
            { id: "dup", fallback: "", type: "phone_app", props: {} },
        ],
        [
            {
                id: "pick",
                fallback: "",
                type: "choice",
                props: {
                    options: [
                        { id: "a", label: "A", primary: true },
                        { id: "a", label: "B", primary: true },
                    ],
                },
            },
        ],
        [{ id: "pick", fallback: "", type: "choice", props: { options: [] } }],
        [{ id: "x", fallback: "", type: "slideshow", props: {} }],
    ].map((components) => ({
        document: { id: "u1", components },
        problems: uiDocumentProblems(components),
        fallback: uiDocumentFallback({ components }),
    }));
    return {
        $comment:
            "Generated by packages/happy-agent-client/scripts/write-ui-fixtures.ts. Do not edit. Every expectation is computed by @slopus/happy-agent-client.",
        catalogVersion: UI_CATALOG_VERSION,
        payload,
        offer,
        permission,
        actionText,
        openOffer,
        result,
        documents,
    };
}
