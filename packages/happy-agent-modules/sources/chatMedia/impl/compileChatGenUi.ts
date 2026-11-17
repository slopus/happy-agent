import { Value } from "@sinclair/typebox/value";
import { Type } from "@sinclair/typebox";
import { genUiPresentationSchema, type GenUiPresentation } from "@slopus/happy-agent-client";

import { compileGenUi, genUiImageSources } from "../../impl/genUi/compileGenUi.js";
import {
    validateGenUiDocument,
    validateGenUiRenderDocument,
} from "../../impl/genUi/validateGenUiDocument.js";

const directActionSchema = Type.Union([
    Type.Object(
        { type: Type.Literal("message"), text: Type.String() },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("copy"), text: Type.String() },
        { additionalProperties: false },
    ),
    Type.Object(
        { type: Type.Literal("open"), url: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
    ),
]);
const spansSchema = Type.Array(Type.Object({ link: Type.Optional(Type.String()) }));

/** Compile one immutable, resource-free view for a chat tool result, never the artifact catalog. */
export function compileChatGenUi(text: string): GenUiPresentation {
    const checked = validateGenUiDocument(text);
    if (!checked.ok) throw new Error(`Invalid Gen UI document:\n${checked.errors.join("\n")}`);
    const images = genUiImageSources(checked.document);
    if (images.length !== 0) {
        throw new Error(
            images
                .map(
                    ({ path }) =>
                        `${path}: direct chat Gen UI does not support images; use present_files for pictures.`,
                )
                .join("\n"),
        );
    }
    const document = compileGenUi(checked.document, new Map());
    const errors = [...validateGenUiRenderDocument(document)];
    for (const [key, element] of Object.entries(document.elements)) {
        const action = element.props.action;
        if (action !== undefined) {
            if (!Value.Check(directActionSchema, action)) {
                errors.push(
                    `${key}.action: direct chat Gen UI supports only message, open, and copy actions.`,
                );
            } else if (action.type === "open" && !safeHttps(action.url)) {
                errors.push(`${key}.action.url: use an absolute HTTPS URL without credentials.`);
            }
        }
        const spans = element.props.spans;
        if (Value.Check(spansSchema, spans)) {
            for (const span of spans) {
                if (span.link !== undefined && !safeHttps(span.link)) {
                    errors.push(
                        `${key}.spans: links must be absolute HTTPS URLs without credentials.`,
                    );
                }
            }
        }
    }
    if (errors.length !== 0)
        throw new Error(`Invalid direct Gen UI document:\n${errors.join("\n")}`);
    const presentation = { type: "gen_ui", document };
    if (!Value.Check(genUiPresentationSchema, presentation)) {
        throw new Error(
            "The compiled Gen UI document does not fit the chat presentation contract.",
        );
    }
    return presentation;
}

function safeHttps(value: string): boolean {
    if (!/^https:\/\//i.test(value) || /[\s\\]/u.test(value)) return false;
    for (const character of value) {
        const code = character.charCodeAt(0);
        if (code < 32 || code === 127) return false;
    }
    try {
        const url = new URL(value);
        return (
            url.protocol === "https:" &&
            url.hostname !== "" &&
            url.username === "" &&
            url.password === ""
        );
    } catch {
        return false;
    }
}
