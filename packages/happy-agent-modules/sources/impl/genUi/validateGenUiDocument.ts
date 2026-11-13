import type { Static, TSchema } from "@sinclair/typebox";
import { Value, ValueErrorType } from "@sinclair/typebox/value";

import {
    GEN_UI_COMPONENTS,
    GEN_UI_LIMITS,
    GEN_UI_RENDER_LIMITS,
    GEN_UI_RENDER_PRIMITIVES,
    genUiDocumentSchema,
    genUiElementSchema,
    genUiNodeIdSchema,
    genUiRenderDocumentSchema,
    type GenUiComponent,
} from "./genUiSchemas.js";

/** One node of a Gen UI document: its type, its props beside it, and nested nodes. */
export interface GenUiNode {
    readonly type: string;
    readonly id?: string;
    readonly children?: readonly GenUiNode[];
    readonly [prop: string]: unknown;
}

/** A Gen UI document that passed validation. */
export interface GenUiDocument {
    readonly genui: 1;
    readonly fallback?: string;
    readonly root: GenUiNode;
}

export type GenUiValidation =
    | { readonly ok: true; readonly document: GenUiDocument }
    | { readonly ok: false; readonly errors: readonly string[] };

/** The keys of a node that are not its props. */
const NODE_KEYS = new Set(["type", "id"]);

/**
 * Check a Gen UI document against the catalog as strictly as `docs/genui/genui.schema.json` and
 * the rules of `docs/genui/SPEC.md`: every node's type and props, children only on containers,
 * slots only with the types they allow, unique ids, and the node, depth and size limits. Each
 * error names the node it is about by its path from the root and the types along it, such as
 * `root<card>.children[0]<stat>.value: expected string`, so the writer can find it.
 */
export function validateGenUiDocument(text: string): GenUiValidation {
    if (Buffer.byteLength(text, "utf8") > GEN_UI_LIMITS.maxDocumentBytes) {
        return {
            ok: false,
            errors: [`document: larger than ${String(GEN_UI_LIMITS.maxDocumentBytes)} bytes`],
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return {
            ok: false,
            errors: [
                `document: not JSON (${error instanceof Error ? error.message : "unreadable"})`,
            ],
        };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, errors: ["document: expected object"] };
    }
    const errors = describe(genUiDocumentSchema, parsed, "");
    const ids = new Set<string>();
    let count = 0;
    const visit = (node: unknown, path: string, depth: number, allowed?: readonly string[]) => {
        if (typeof node !== "object" || node === null || Array.isArray(node)) {
            errors.push(`${path}: expected a node object`);
            return;
        }
        const fields = node as Record<string, unknown>;
        const type = fields.type;
        const component = typeof type === "string" ? GEN_UI_COMPONENTS.get(type) : undefined;
        if (component === undefined) {
            errors.push(`${path}: unknown type ${JSON.stringify(type)}`);
            return;
        }
        const at = `${path}<${String(type)}>`;
        if (allowed !== undefined && !allowed.includes(type as string)) {
            errors.push(`${at}: must be one of ${allowed.join(", ")}`);
        }
        count += 1;
        if (depth > GEN_UI_LIMITS.maxDepth) {
            errors.push(`${at}: nested deeper than ${String(GEN_UI_LIMITS.maxDepth)}`);
            return;
        }
        if (fields.id !== undefined) {
            if (!Value.Check(genUiNodeIdSchema, fields.id)) {
                errors.push(`${at}.id: must be 1–64 letters, digits, _ or -`);
            } else if (ids.has(fields.id)) {
                errors.push(`${at}.id: ${JSON.stringify(fields.id)} is used twice`);
            } else {
                ids.add(fields.id);
            }
        }
        const lists = new Map<
            string,
            { readonly allowed?: readonly string[]; readonly max?: number }
        >(component.children ? [["children", {}]] : []);
        for (const [slot, rule] of component.slots) lists.set(slot, rule);
        if (fields.children !== undefined && !component.children) {
            errors.push(`${at}: ${String(type)} takes no children`);
        }
        const props = Object.fromEntries(
            Object.entries(fields).filter(
                ([key]) => !NODE_KEYS.has(key) && !lists.has(key) && key !== "children",
            ),
        );
        errors.push(...describe(component.props, props, at));
        for (const [name, rule] of lists) {
            const list = fields[name];
            if (list === undefined) continue;
            if (!Array.isArray(list)) {
                errors.push(`${at}.${name}: expected array`);
                continue;
            }
            if (rule.max !== undefined && list.length > rule.max) {
                errors.push(`${at}.${name}: at most ${String(rule.max)}`);
            }
            list.forEach((child, index) => {
                visit(child, `${at}.${name}[${String(index)}]`, depth + 1, rule.allowed);
            });
        }
    };
    const root = (parsed as { root?: unknown }).root;
    if (root !== undefined) visit(root, "root", 1);
    if (count > GEN_UI_LIMITS.maxElements) {
        errors.push(`document: more than ${String(GEN_UI_LIMITS.maxElements)} nodes`);
    }
    return errors.length === 0
        ? { ok: true, document: parsed as GenUiDocument }
        : { ok: false, errors };
}

/**
 * Check a render document, which only the daemon's compiler writes, against the render catalog:
 * every primitive's props, children and slots, and a tree reached from `root` in which each
 * element has one parent and nothing cycles.
 */
export function validateGenUiRenderDocument(value: unknown): readonly string[] {
    const errors: string[] = [];
    if (!Value.Check(genUiRenderDocumentSchema, value)) {
        errors.push(...describe(genUiRenderDocumentSchema, value, ""));
        if (
            typeof value !== "object" ||
            value === null ||
            !Value.Check(
                genUiRenderDocumentSchema.properties.elements,
                (value as { elements?: unknown }).elements,
            )
        ) {
            return errors;
        }
    }
    const document = value as Static<typeof genUiRenderDocumentSchema>;
    errors.push(...checkTree(document.elements, document.root, GEN_UI_RENDER_PRIMITIVES));
    errors.push(...genUiRenderLimitErrors(document));
    return errors;
}

/**
 * Where a render document is over the render catalog's limits, worded for the author of the
 * authoring document it came from.
 */
export function genUiRenderLimitErrors(document: {
    readonly elements: Readonly<Record<string, unknown>>;
}): readonly string[] {
    const errors: string[] = [];
    const count = Object.keys(document.elements).length;
    if (count > GEN_UI_RENDER_LIMITS.maxElements) {
        errors.push(
            `document: compiles to ${String(count)} render elements, more than ${String(GEN_UI_RENDER_LIMITS.maxElements)}; show fewer rows or items, or split it into more than one document`,
        );
    }
    const bytes = Buffer.byteLength(`${JSON.stringify(document)}\n`, "utf8");
    if (bytes > GEN_UI_RENDER_LIMITS.maxDocumentBytes) {
        errors.push(
            `document: compiles to ${String(bytes)} bytes, more than ${String(GEN_UI_RENDER_LIMITS.maxDocumentBytes)}; show less text, or split it into more than one document`,
        );
    }
    return errors;
}

/** The rules of a flat render document's elements, by the render catalog. */
function checkTree(
    elements: Readonly<Record<string, unknown>>,
    root: unknown,
    catalog: ReadonlyMap<string, GenUiComponent>,
): string[] {
    const errors: string[] = [];
    const rootKey = typeof root === "string" ? root : undefined;
    if (rootKey !== undefined && !Object.hasOwn(elements, rootKey)) {
        errors.push("root: must name an element");
    }
    const parents = new Map<string, string>();
    const references = new Map<string, string[]>();
    for (const [key, element] of Object.entries(elements)) {
        if (!Value.Check(genUiElementSchema, element)) {
            errors.push(...describe(genUiElementSchema, element, key));
            continue;
        }
        const component = catalog.get(element.type);
        if (component === undefined) {
            errors.push(`${key}: unknown type ${JSON.stringify(element.type)}`);
            continue;
        }
        errors.push(...describe(component.props, element.props, `${key}.props`));
        const refs = [...(element.children ?? [])];
        if (element.children !== undefined && !component.children) {
            errors.push(`${key}: ${element.type} takes no children`);
        }
        for (const [slot, ids] of Object.entries(element.slots ?? {})) {
            const rule = component.slots.get(slot);
            if (rule === undefined) {
                errors.push(`${key}.slots.${slot}: unknown slot`);
                continue;
            }
            if (ids.length > rule.max) {
                errors.push(`${key}.slots.${slot}: at most ${String(rule.max)}`);
            }
            const allowed = rule.allowed;
            for (const id of allowed === undefined ? [] : ids) {
                const type = Object.hasOwn(elements, id) ? typeOf(elements[id]) : undefined;
                if (type !== undefined && !allowed!.includes(type)) {
                    errors.push(
                        `${key}.slots.${slot}: ${id} must be one of ${allowed!.join(", ")}`,
                    );
                }
            }
            refs.push(...ids);
        }
        for (const ref of refs) {
            if (!Object.hasOwn(elements, ref)) {
                errors.push(`${key}: references missing element ${JSON.stringify(ref)}`);
                continue;
            }
            const parent = parents.get(ref);
            if (parent !== undefined) errors.push(`${ref}: used by both ${parent} and ${key}`);
            parents.set(ref, key);
        }
        references.set(key, refs);
    }
    for (const key of Object.keys(elements)) {
        if (key !== rootKey && !parents.has(key)) errors.push(`${key}: not reachable from root`);
    }
    if (rootKey !== undefined && Object.hasOwn(elements, rootKey)) {
        const visit = (key: string, trail: ReadonlySet<string>) => {
            if (trail.has(key)) {
                errors.push(`${key}: cycle`);
                return;
            }
            const next = new Set(trail).add(key);
            for (const ref of references.get(key) ?? []) {
                if (Object.hasOwn(elements, ref)) visit(ref, next);
            }
        };
        visit(rootKey, new Set());
    }
    return errors;
}

/** The most reasons one refusal lists; a document with more is far from valid anyway. */
const MAX_LISTED_ERRORS = 30;

/** A refusal of the Gen UI file at `path` that says what to fix, one reason per line. */
export function describeGenUiErrors(path: string, errors: readonly string[]): string {
    const listed = errors.slice(0, MAX_LISTED_ERRORS).map((error) => `- ${error}`);
    if (errors.length > MAX_LISTED_ERRORS) {
        listed.push(`- and ${String(errors.length - MAX_LISTED_ERRORS)} more`);
    }
    return [
        `"${path}" is not a valid Gen UI document, so nothing was saved. Fix these and write it again (genui/USAGE.md and genui/components/<type>.md beside the Happy Agent documentation README describe every component):`,
        ...listed,
    ].join("\n");
}

function typeOf(element: unknown): string | undefined {
    if (typeof element !== "object" || element === null) return undefined;
    const type = (element as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
}

/** What is wrong with `value` against `schema`, one line per place, under `prefix`. */
function describe(schema: TSchema, value: unknown, prefix: string): string[] {
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const error of Value.Errors(schema, value)) {
        const path = joinPath(prefix, error.path);
        if (seen.has(path)) continue;
        seen.add(path);
        if (error.type === ValueErrorType.Union) {
            const variant = matchingVariant(error.schema, error.value);
            if (variant !== undefined) {
                lines.push(...describe(variant, error.value, path));
                continue;
            }
        }
        lines.push(`${path || "document"}: ${reason(error.type, error.schema, error.value)}`);
    }
    return lines;
}

/**
 * The one variant of a union a value was evidently meant to be, so its errors can be told
 * precisely: the only object variant for an object, or the one whose `type` it names.
 */
function matchingVariant(schema: TSchema, value: unknown): TSchema | undefined {
    const variants = (schema.anyOf as TSchema[] | undefined) ?? [];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const objects = variants.filter((variant) => variant.type === "object");
    if (objects.length === 1) return objects[0];
    const named = (value as { type?: unknown }).type;
    const matches = objects.filter(
        (variant) =>
            (variant.properties as Record<string, TSchema> | undefined)?.type?.const === named,
    );
    return matches.length === 1 ? matches[0] : undefined;
}

function reason(type: ValueErrorType, schema: TSchema, value: unknown): string {
    switch (type) {
        case ValueErrorType.ObjectRequiredProperty:
            return "required";
        case ValueErrorType.ObjectAdditionalProperties:
            return "unknown property";
        case ValueErrorType.ObjectMaxProperties:
            return `at most ${String(schema.maxProperties)} elements`;
        case ValueErrorType.Object:
            return "expected object";
        case ValueErrorType.Array:
            return "expected array";
        case ValueErrorType.ArrayMinItems:
        case ValueErrorType.ArrayMaxItems:
            return `${String((value as unknown[]).length)} items, allowed ${String(schema.minItems ?? 0)}..${schema.maxItems === undefined ? "any" : String(schema.maxItems)}`;
        case ValueErrorType.String:
            return "expected string";
        case ValueErrorType.Number:
            return "expected number";
        case ValueErrorType.Boolean:
            return "expected boolean";
        case ValueErrorType.Literal:
            return `expected ${JSON.stringify(schema.const)}`;
        case ValueErrorType.Union: {
            const variants = (schema.anyOf as TSchema[] | undefined) ?? [];
            if (variants.length > 0 && variants.every((variant) => "const" in variant)) {
                return `${JSON.stringify(value)} is not one of ${variants.map((variant) => String(variant.const)).join(", ")}`;
            }
            return "matches none of the allowed shapes";
        }
        default:
            return "invalid value";
    }
}

/** `badge.tone` and `items[0].title` from a JSON pointer such as `/badge/tone`, `/items/0/title`. */
function joinPath(prefix: string, pointer: string): string {
    let path = prefix;
    for (const raw of pointer.split("/").slice(1)) {
        const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
        if (/^\d+$/.test(segment)) path += `[${segment}]`;
        else path += path === "" ? segment : `.${segment}`;
    }
    return path;
}
