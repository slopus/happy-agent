import { Type, type TSchema } from "@sinclair/typebox";

import { GEN_UI_CATALOG } from "./genUiCatalog.js";
import { GEN_UI_RENDER_CATALOG } from "./genUiRenderCatalog.js";

/** A value type as a catalog writes it: a named type, or an object describing a composite. */
type CatalogType = string | { readonly [key: string]: unknown };

interface CatalogProp {
    readonly type: CatalogType;
    readonly required?: boolean;
}

/** What a validator needs to know about one component or primitive. */
export interface GenUiComponent {
    /** The props as one closed object. */
    readonly props: TSchema;
    /** Whether it takes `children`. */
    readonly children: boolean;
    /** The slots it takes, with the types each allows (any when absent) and how many. */
    readonly slots: ReadonlyMap<
        string,
        { readonly allowed?: readonly string[]; readonly max: number }
    >;
}

/** The TypeBox schema for one catalog type, with the catalog's definitions written in place. */
function schemaOf(type: CatalogType, definitions: Readonly<Record<string, CatalogType>>): TSchema {
    if (typeof type === "string") {
        if (type === "string" || type === "markdown") return Type.String();
        if (type === "number") return Type.Number();
        if (type === "boolean") return Type.Boolean();
        if (type === "any") return Type.Unknown();
        const definition = definitions[type];
        if (definition === undefined) throw new Error(`The Gen UI catalog has no type ${type}.`);
        return schemaOf(definition, definitions);
    }
    if ("const" in type) {
        return type.const === null ? Type.Null() : Type.Literal(type.const as string);
    }
    if ("enum" in type) {
        return Type.Union((type.enum as string[]).map((value) => Type.Literal(value)));
    }
    if ("array" in type) {
        return Type.Array(schemaOf(type.array as CatalogType, definitions), {
            ...(typeof type.min === "number" ? { minItems: type.min } : {}),
            ...(typeof type.max === "number" ? { maxItems: type.max } : {}),
        });
    }
    if ("map" in type) {
        return Type.Record(Type.String(), schemaOf(type.map as CatalogType, definitions));
    }
    if ("oneOf" in type) {
        return Type.Union(
            (type.oneOf as CatalogType[]).map((alternative) => schemaOf(alternative, definitions)),
        );
    }
    if ("object" in type) {
        return objectSchema(type.object as Record<string, CatalogProp>, definitions);
    }
    throw new Error(`The Gen UI catalog has a type the validator does not know.`);
}

function objectSchema(
    props: Readonly<Record<string, CatalogProp>>,
    definitions: Readonly<Record<string, CatalogType>>,
): TSchema {
    return Type.Object(
        Object.fromEntries(
            Object.entries(props).map(([key, prop]) => {
                const schema = schemaOf(prop.type, definitions);
                return [key, prop.required === true ? schema : Type.Optional(schema)];
            }),
        ),
        { additionalProperties: false },
    );
}

/** Every component of the authoring catalog, by type. */
export const GEN_UI_COMPONENTS: ReadonlyMap<string, GenUiComponent> = new Map(
    Object.entries(GEN_UI_CATALOG.components).map(([name, component]) => [
        name,
        {
            props: objectSchema(
                component.props as Record<string, CatalogProp>,
                GEN_UI_CATALOG.definitions,
            ),
            children: component.children !== null,
            slots: new Map(
                Object.entries(
                    component.slots as Record<string, { allowed: string[]; max: number }>,
                ).map(([slot, rule]) => [slot, { allowed: rule.allowed, max: rule.max }]),
            ),
        },
    ]),
);

/** Every primitive of the render catalog, by type. */
export const GEN_UI_RENDER_PRIMITIVES: ReadonlyMap<string, GenUiComponent> = new Map(
    Object.entries(GEN_UI_RENDER_CATALOG.primitives).map(([name, primitive]) => [
        name,
        {
            props: objectSchema(
                primitive.props as Record<string, CatalogProp>,
                GEN_UI_RENDER_CATALOG.definitions,
            ),
            children: primitive.children,
            slots: new Map(
                Object.entries(primitive.slots as Record<string, number>).map(([slot, max]) => [
                    slot,
                    { max },
                ]),
            ),
        },
    ]),
);

export const GEN_UI_LIMITS = GEN_UI_CATALOG.limits;

/** How large a compiled render document may be. */
export const GEN_UI_RENDER_LIMITS = GEN_UI_RENDER_CATALOG.limits;

/** An authoring document's outer shape; its nodes are checked one by one by type. */
export const genUiDocumentSchema = Type.Object(
    {
        genui: Type.Literal(1),
        fallback: Type.Optional(Type.String()),
        root: Type.Unknown(),
    },
    { additionalProperties: false },
);

/** A render document's outer shape. */
export const genUiRenderDocumentSchema = Type.Object(
    {
        genuiRender: Type.Literal(1),
        compiler: Type.String(),
        fallback: Type.Optional(Type.String()),
        root: Type.String(),
        viewers: Type.Optional(
            Type.Record(
                Type.String(),
                Type.Array(
                    schemaOf(GEN_UI_RENDER_CATALOG.viewerItem, GEN_UI_RENDER_CATALOG.definitions),
                ),
            ),
        ),
        elements: Type.Record(Type.String(), Type.Unknown()),
    },
    { additionalProperties: false },
);

/** A render element's shape before its type is known. */
export const genUiElementSchema = Type.Object(
    {
        type: Type.String(),
        props: Type.Unknown(),
        children: Type.Optional(Type.Array(Type.String())),
        slots: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    },
    { additionalProperties: false },
);

/** A node's optional stable name. */
export const genUiNodeIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{1,64}$" });
