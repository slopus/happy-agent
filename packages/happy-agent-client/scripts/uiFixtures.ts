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
import {
    normalizeQuickReply,
    quickRepliesBlockSchema,
    quickRepliesPresentationSchema,
    quickRepliesProblems,
    quickReplySchema,
} from "../sources/protocol/quickReplies.js";
import {
    knownUiComponent,
    UI_CATALOG_VERSION,
    uiActionDefinition,
    uiComponents,
    uiWireComponentSchema,
} from "../sources/ui/catalog.js";
import { uiActionProblem, uiDocumentProblems } from "../sources/ui/checks.js";
import { mediaFallback } from "../sources/ui/components/media.js";
import {
    layoutMedia,
    MEDIA_GAP,
    MEDIA_LABEL_GAP,
    MEDIA_LABEL_LINE,
    MEDIA_MAX_ASPECT,
    MEDIA_MAX_ROW_SCALE,
    MEDIA_MIN_ASPECT,
    MEDIA_ROW_HEIGHT_DESKTOP,
    MEDIA_ROW_HEIGHT_PHONE,
    MEDIA_SINGLE_HEIGHT_SCALE,
    type MediaArrangementItem,
} from "../sources/ui/layoutMedia.js";
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
    provider_sign_in: { provider: "claude" },
    default_model: {},
};

/** One valid and at least one invalid payload for every action in the catalog. */
const PAYLOADS: Record<string, { valid: unknown[]; invalid: unknown[] }> = {
    "provider_sign_in.install": { valid: [{}], invalid: [{ provider: "claude" }] },
    "provider_sign_in.sign_in": { valid: [{}], invalid: [{ method: "browser" }] },
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
};

/** Results as a response may carry them, for every action that declares one. */
const RESULTS: Record<string, unknown[]> = {
    "provider_sign_in.sign_in": [{ connected: true }, { connected: false }, {}, { connected: 1 }],
};

/** Media sets every client lays out the same way, at each width and both row heights. */
const MEDIA_SETS: Record<string, MediaArrangementItem[]> = {
    "one landscape": [{ kind: "image", width: 1600, height: 900 }],
    "one portrait": [{ kind: "image", width: 900, height: 1600 }],
    "one panorama, clamped to 3": [{ kind: "image", width: 4000, height: 500 }],
    "one small square": [{ kind: "image", width: 64, height: 64, label: "Icon" }],
    "two 16:9 screenshots share a row": [
        { kind: "image", width: 1920, height: 1080 },
        { kind: "image", width: 1920, height: 1080 },
    ],
    "two mixed": [
        { kind: "image", width: 1600, height: 900 },
        { kind: "image", width: 900, height: 1600 },
    ],
    "three labelled": [
        { kind: "image", width: 1200, height: 800, label: "Login" },
        { kind: "image", width: 800, height: 1200 },
        { kind: "image", width: 1000, height: 1000, label: "Home" },
    ],
    "five mixed": [
        { kind: "image", width: 1600, height: 900 },
        { kind: "image", width: 1200, height: 1200 },
        { kind: "image", width: 900, height: 1600 },
        { kind: "image", width: 2000, height: 1000 },
        { kind: "image", width: 1080, height: 1920 },
    ],
    "seven squares": Array.from({ length: 7 }, () => ({
        kind: "image",
        width: 1000,
        height: 1000,
    })),
    "three tall, clamped to 0.4": Array.from({ length: 3 }, () => ({
        kind: "image",
        width: 300,
        height: 2000,
    })),
    "unmeasured video and file": [
        { kind: "video" },
        { kind: "document", label: "Report.pdf" },
        { kind: "image", width: 1200, height: 900 },
    ],
};
const MEDIA_WIDTHS = [320, 546, 786];

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
            component: uiWireComponentSchema,
            document: uiDocumentSchema,
            block: uiBlockSchema,
            presentation: uiPresentationSchema,
            actionBlock: uiActionBlockSchema,
            actionRequest: uiActionRequestSchema,
            capability: chatUiCapabilitySchema,
        },
        quickReplies: {
            block: quickRepliesBlockSchema,
            presentation: quickRepliesPresentationSchema,
            quickReply: quickReplySchema,
        },
        mediaLayout: {
            rowHeightDesktop: MEDIA_ROW_HEIGHT_DESKTOP,
            rowHeightPhone: MEDIA_ROW_HEIGHT_PHONE,
            gap: MEDIA_GAP,
            labelGap: MEDIA_LABEL_GAP,
            labelLine: MEDIA_LABEL_LINE,
            maxRowScale: MEDIA_MAX_ROW_SCALE,
            singleHeightScale: MEDIA_SINGLE_HEIGHT_SCALE,
            minAspect: MEDIA_MIN_ASPECT,
            maxAspect: MEDIA_MAX_ASPECT,
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
            { type: "provider_sign_in.sign_in", payload: {} },
            { type: "default_model.set", payload: { modelId: "claude-opus-5-5" } },
        ].map((action) => {
            const component = { type: "default_model", props: OFFER_PROPS["default_model"] };
            return { component, action, problem: uiActionProblem(component, action) ?? null };
        }),
    );
    const permission = uiComponents.flatMap((bundle) =>
        Object.entries(bundle.actions).map(([name, action]) => {
            const props = OFFER_PROPS[bundle.type] ?? {};
            return {
                action: `${bundle.type}.${name}`,
                props,
                permission: uiActionPermission(action, props),
                allowed: Object.fromEntries(
                    Object.entries(GRANTS).map(([who, granted]) => [
                        who,
                        uiActionAllowed(action, props, granted),
                    ]),
                ),
            };
        }),
    );
    const quickReplies = [
        ["Yes, go ahead", "Not now"],
        ["  Fix   the\tlogin  ", "Run the tests"],
        [],
        ["a", "b", "c", "d", "e", "f", "g"],
        ["Same", "Same"],
        ["x".repeat(201)],
        ["bell\u0007"],
        ["right-to-left \u202e"],
    ].map((options) => {
        const normalized = options.map(normalizeQuickReply);
        return { options, normalized, problems: quickRepliesProblems(normalized) };
    });
    const mediaLayout = Object.entries(MEDIA_SETS).map(([name, items]) => ({
        name,
        items,
        fallback: mediaFallback(items),
        layouts: [MEDIA_ROW_HEIGHT_DESKTOP, MEDIA_ROW_HEIGHT_PHONE].flatMap((rowHeight) =>
            MEDIA_WIDTHS.map((width) => ({
                width,
                rowHeight,
                ...layoutMedia(items, width, rowHeight),
            })),
        ),
    }));
    const result = Object.entries(RESULTS).flatMap(([type, values]) => {
        const schema = uiActionDefinition(type)!.definition.result!;
        return values.map((value) => ({
            type,
            result: value,
            schemaValid: Value.Check(schema, value),
            redacted: Value.Check(schema, value) ? redactUiValue(schema, value) : null,
        }));
    });
    const documents = [
        [{ id: "model", fallback: "Choose your default model", type: "default_model", props: {} }],
        [
            {
                id: "claude",
                fallback: "Sign in to Claude Code in Happy on your computer.",
                type: "provider_sign_in",
                props: { provider: "claude" },
            },
            {
                id: "codex",
                fallback: "Sign in to Codex in Happy on your computer.",
                type: "provider_sign_in",
                props: { provider: "codex" },
            },
        ],
        [
            {
                id: "dup",
                fallback: "src/app.ts",
                type: "file_tree",
                props: { paths: ["src/app.ts"] },
            },
            {
                id: "dup",
                fallback: "src/app.ts",
                type: "file_tree",
                props: { paths: ["src/app.ts"] },
            },
        ],
        [
            {
                id: "claude",
                fallback: "Sign in to Claude Code in Happy on your computer.",
                type: "provider_sign_in",
                props: { provider: "claude", target: "team" },
            },
        ],
        // A type from a newer server: legal on the wire, drawn as its fallback line.
        [
            {
                id: "x",
                fallback: "A slideshow of 3 pictures",
                type: "slideshow",
                props: { count: 3 },
            },
        ],
        [
            {
                id: "shots",
                fallback: "2 images: Login",
                type: "media",
                props: { items: [{ mediaIndex: 0, label: "Login" }, { mediaIndex: 1 }] },
            },
        ],
        [
            {
                id: "grid",
                fallback: "1 image",
                type: "media",
                props: { items: [{ mediaIndex: 0 }], columns: 2 },
            },
        ],
    ].map((components) => ({
        document: { id: "u1x8k2m9r4t8w1y5z3a6b0c2", components },
        // Whether a client may read it at all, and which components it draws rather than
        // showing their fallback line.
        wireValid: Value.Check(uiDocumentSchema, {
            id: "u1x8k2m9r4t8w1y5z3a6b0c2",
            components,
        }),
        drawn: components.map((component) => knownUiComponent(component) !== undefined),
        // What a server answers a model or a module that wrote these components.
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
        quickReplies,
        mediaLayout,
        result,
        documents,
    };
}
