import { Type, type Static } from "@sinclair/typebox";

/** Direct chat presentations reuse the existing Gen UI render format, not its authoring tree. */
export const MAX_GEN_UI_RENDER_BYTES = 4 * 1024 * 1024;
export const MAX_GEN_UI_RENDER_ELEMENTS = 4_000;

const elementKeySchema = Type.String({ minLength: 1, maxLength: 256 });
const elementKeysSchema = Type.Array(elementKeySchema, { maxItems: MAX_GEN_UI_RENDER_ELEMENTS });

/** Primitive props belong to the Gen UI catalog; clients render unknown primitives leniently. */
export const genUiRenderElementSchema = Type.Object({
    type: Type.String({ minLength: 1, maxLength: 128 }),
    props: Type.Record(Type.String(), Type.Unknown()),
    children: Type.Optional(elementKeysSchema),
    slots: Type.Optional(Type.Record(Type.String(), elementKeysSchema, { maxProperties: 16 })),
});
export type GenUiRenderElement = Static<typeof genUiRenderElementSchema>;

/** The compiled envelope. Renderers also enforce byte/traversal bounds and validate used props. */
export const genUiRenderDocumentSchema = Type.Object({
    genuiRender: Type.Literal(1),
    compiler: Type.String({ minLength: 1, maxLength: 128 }),
    fallback: Type.Optional(Type.String({ maxLength: 256 * 1024 })),
    root: elementKeySchema,
    elements: Type.Record(elementKeySchema, genUiRenderElementSchema, {
        minProperties: 1,
        maxProperties: MAX_GEN_UI_RENDER_ELEMENTS,
    }),
});
export type GenUiRenderDocument = Static<typeof genUiRenderDocumentSchema>;

/** An immutable generated view owned by one tool call, with no artifact or external resources. */
export const genUiPresentationSchema = Type.Object({
    type: Type.Literal("gen_ui"),
    document: genUiRenderDocumentSchema,
});
export type GenUiPresentation = Static<typeof genUiPresentationSchema>;
