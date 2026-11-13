/**
 * Build the generated parts of the Gen UI spec from `docs/genui/catalog.json`, the one definition
 * of every component, prop, enum, limit, behaviour and example.
 *
 *     pnpm genui:build            # write the generated files
 *     pnpm genui:build --check    # fail when a checked-in file is out of date
 *
 * Outputs:
 *     docs/genui/genui.schema.json      JSON Schema 2020-12 for a document
 *     docs/genui/components/<type>.md   one page per component
 *     packages/happy-agent-modules/sources/impl/genUi/genUiCatalog.ts
 *                                       the catalog the daemon validates documents with
 *     packages/happy-agent-modules/sources/impl/genUi/genUiRenderCatalog.ts
 *                                       the render catalog, from docs/genui/render/catalog.json
 *     docs/genui/render/compiled/<name>.render.json
 *                                       every example compiled by the daemon's compiler, with
 *                                       stand-in measurements for its images: renderer fixtures
 *
 * README.md, SPEC.md, USAGE.md, RENDER.md, render/catalog.json and examples/ in docs/genui/ are
 * written by hand.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    compileGenUi,
    genUiImageSources,
} from "../../packages/happy-agent-modules/sources/impl/genUi/compileGenUi.js";
import { validateGenUiDocument } from "../../packages/happy-agent-modules/sources/impl/genUi/validateGenUiDocument.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const specRoot = join(repositoryRoot, "docs", "genui");
const modulesGenUi = join(
    repositoryRoot,
    "packages",
    "happy-agent-modules",
    "sources",
    "impl",
    "genUi",
);
const catalogModulePath = join(modulesGenUi, "genUiCatalog.ts");
const renderCatalogModulePath = join(modulesGenUi, "genUiRenderCatalog.ts");

/** A value type as the catalog writes it: a named type, or an object describing a composite. */
type CatalogType = string | { readonly [key: string]: unknown };

interface CatalogProp {
    readonly type: CatalogType;
    readonly description: string;
    readonly required?: boolean;
    readonly default?: unknown;
}

interface CatalogSlot {
    readonly allowed: readonly string[];
    readonly max?: number;
    readonly description: string;
}

interface CatalogComponent {
    readonly group: string;
    readonly summary: string;
    readonly props: Readonly<Record<string, CatalogProp>>;
    readonly children: string | null;
    readonly slots: Readonly<Record<string, CatalogSlot>>;
    /** The page's Behaviour section, as Markdown bullets. */
    readonly behavior: string;
    /** One example node, children nested. */
    readonly example: object;
    readonly doc: string;
}

interface Catalog {
    readonly genui: number;
    readonly limits: {
        readonly maxElements: number;
        readonly maxDepth: number;
        readonly maxDocumentBytes: number;
    };
    readonly tones: readonly string[];
    readonly icons: readonly string[];
    readonly definitions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    readonly components: Readonly<Record<string, CatalogComponent>>;
}

/** The JSON Schema for one catalog type. */
function schemaOf(type: CatalogType): Record<string, unknown> {
    if (typeof type === "string") {
        if (type === "string" || type === "markdown") return { type: "string" };
        if (type === "number" || type === "boolean") return { type };
        if (type === "any") return {};
        return { $ref: `#/$defs/${type}` };
    }
    if ("const" in type) return { const: type.const };
    if ("enum" in type) return { enum: type.enum };
    if ("array" in type) {
        const schema: Record<string, unknown> = {
            type: "array",
            items: schemaOf(type.array as CatalogType),
        };
        if ("min" in type) schema.minItems = type.min;
        if ("max" in type) schema.maxItems = type.max;
        return schema;
    }
    if ("map" in type) {
        return { type: "object", additionalProperties: schemaOf(type.map as CatalogType) };
    }
    if ("oneOf" in type) {
        return { oneOf: (type.oneOf as CatalogType[]).map((alternative) => schemaOf(alternative)) };
    }
    if ("object" in type) {
        const fields = type.object as Record<string, CatalogProp>;
        const properties = Object.fromEntries(
            Object.entries(fields).map(([key, prop]) => [
                key,
                {
                    ...schemaOf(prop.type),
                    ...(prop.description ? { description: prop.description } : {}),
                },
            ]),
        );
        const schema: Record<string, unknown> = {
            type: "object",
            properties,
            additionalProperties: false,
        };
        const required = Object.entries(fields)
            .filter(([, prop]) => prop.required === true)
            .map(([key]) => key);
        if (required.length > 0) schema.required = required;
        return schema;
    }
    throw new Error(`The catalog has a type the generator does not know: ${JSON.stringify(type)}`);
}

function buildSchema(catalog: Catalog): Record<string, unknown> {
    const nodes = { type: "array", items: { $ref: "#/$defs/node" } };
    const elements = Object.entries(catalog.components).map(([name, component]) => {
        const base = schemaOf({ object: component.props }) as {
            properties: Record<string, unknown>;
            required?: string[];
        };
        const properties: Record<string, unknown> = {
            type: { const: name },
            id: { $ref: "#/$defs/id" },
            ...base.properties,
        };
        if (component.children) properties.children = nodes;
        for (const [slot, rule] of Object.entries(component.slots)) {
            properties[slot] = {
                type: "array",
                maxItems: rule.max,
                description: rule.description,
                items: {
                    allOf: [
                        { $ref: "#/$defs/node" },
                        { properties: { type: { enum: rule.allowed } } },
                    ],
                },
            };
        }
        return {
            type: "object",
            title: name,
            description: component.summary,
            additionalProperties: false,
            required: ["type", ...(base.required ?? [])],
            properties,
        };
    });
    const definitions: Record<string, unknown> = Object.fromEntries(
        Object.entries(catalog.definitions).map(([name, definition]) => [
            name,
            {
                ...schemaOf(definition),
                ...("description" in definition ? { description: definition.description } : {}),
            },
        ]),
    );
    definitions.id = {
        type: "string",
        pattern: "^[A-Za-z0-9_-]{1,64}$",
        description:
            "Optional stable name for a node, unique in the document. Lets a later edit or action refer to it.",
    };
    definitions.node = { oneOf: elements };
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://happy.engineering/genui/v1/genui.schema.json",
        title: "Gen UI document, version 1",
        type: "object",
        required: ["genui", "root"],
        additionalProperties: false,
        properties: {
            genui: { const: 1, description: "Format version." },
            fallback: {
                type: "string",
                description:
                    "Plain-text equivalent for clients that cannot render Gen UI, and for search, notifications and screen readers.",
            },
            root: { $ref: "#/$defs/node", description: "The root node." },
        },
        $defs: definitions,
    };
}

/** How a component page names a type. */
function typeName(type: CatalogType): string {
    if (typeof type === "string") return type === "markdown" ? "string (inline Markdown)" : type;
    if ("const" in type) return JSON.stringify(type.const);
    if ("enum" in type) {
        return (type.enum as string[]).map((value) => `\`${value}\``).join(" \\| ");
    }
    if ("array" in type) {
        const count = "max" in type ? ` (${String(type.min ?? 0)}–${String(type.max)})` : "";
        return `array of ${typeName(type.array as CatalogType)}${count}`;
    }
    if ("map" in type) return "object";
    if ("oneOf" in type) {
        return (type.oneOf as CatalogType[])
            .map((alternative) => typeName(alternative))
            .join(" or ");
    }
    return "object";
}

function propRows(props: Readonly<Record<string, CatalogProp>>, prefix = ""): string[] {
    const rows: string[] = [];
    for (const [key, prop] of Object.entries(props)) {
        let notes = prop.description;
        if (prop.default !== undefined && prop.default !== null) {
            const shown = JSON.stringify(prop.default).replace(/^"+|"+$/g, "");
            notes = `${notes ? `${notes} ` : ""}Default \`${shown}\`.`;
        }
        rows.push(
            `| \`${prefix}${key}\` | ${typeName(prop.type)} | ${prop.required === true ? "yes" : ""} | ${notes} |`,
        );
        const type = prop.type;
        const inner =
            typeof type !== "string" && "array" in type ? (type.array as CatalogType) : type;
        if (typeof inner !== "string" && "object" in inner) {
            rows.push(
                ...propRows(
                    inner.object as Record<string, CatalogProp>,
                    `${prefix}${key}${inner === type ? "" : "[]"}.`,
                ),
            );
        }
    }
    return rows;
}

function componentPage(name: string, component: CatalogComponent) {
    const rows = propRows(component.props);
    const lines = [
        `# \`${name}\``,
        "",
        component.summary,
        "",
        `Group: ${component.group}.`,
        "",
        "## Props",
        "",
        "| Prop | Type | Required | Notes |",
        "|---|---|---|---|",
        ...(rows.length > 0 ? rows : ["| (none) | | | |"]),
        "",
        "## Children and slots",
        "",
        component.children ? "- `children`: an array of nodes, nested inline." : "- No children.",
        ...Object.entries(component.slots).map(
            ([slot, rule]) =>
                `- \`${slot}\`: ${rule.description} An array of nodes, nested inline. Allowed: ${rule.allowed.map((type) => `\`${type}\``).join(", ")}; at most ${String(rule.max)}.`,
        ),
        "- `id`: optional on every node; a stable name, unique in the document.",
        "",
        "## Behaviour",
        "",
        component.behavior.trim(),
        "",
        "## Example",
        "",
        "```json",
        JSON.stringify(component.example, null, 2),
        "```",
        "",
    ];
    return lines.join("\n");
}

function catalogModule(source: string, doc: string, name: string, catalog: unknown): string {
    return [
        `// Generated by scripts/genui/buildGenUiSpec.ts from docs/genui/${source}. Do not edit.`,
        "",
        `/** ${doc} */`,
        `export const ${name} = ${JSON.stringify(catalog, null, 4)};`,
        "",
    ].join("\n");
}

/**
 * Every example compiled to its render document. Examples name images that are not stored, so
 * each gets the same stand-in measurements a 1600×1067 photo would have.
 */
function compiledExamples(): Map<string, string> {
    const examples = join(specRoot, "examples");
    const compiled = new Map<string, string>();
    for (const name of readdirSync(examples).sort()) {
        if (!name.endsWith(".genui.json")) continue;
        const validation = validateGenUiDocument(readFileSync(join(examples, name), "utf8"));
        if (!validation.ok) {
            throw new Error(`examples/${name} is invalid:\n${validation.errors.join("\n")}`);
        }
        const images = new Map(
            genUiImageSources(validation.document).map((source) => [
                source.src,
                {
                    file: source.src,
                    width: 1600,
                    height: 1067,
                    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
                },
            ]),
        );
        compiled.set(
            join(specRoot, "render", "compiled", name.replace(/\.genui\.json$/, ".render.json")),
            `${JSON.stringify(compileGenUi(validation.document, images), null, 2)}\n`,
        );
    }
    return compiled;
}

/** Every generated file with the text it must hold, by absolute path. */
export function generateGenUiSpec(): Map<string, string> {
    const catalog = JSON.parse(readFileSync(join(specRoot, "catalog.json"), "utf8")) as Catalog;
    const outputs = new Map<string, string>();
    outputs.set(
        join(specRoot, "genui.schema.json"),
        `${JSON.stringify(buildSchema(catalog), null, 2)}\n`,
    );
    for (const [name, component] of Object.entries(catalog.components)) {
        if (component.doc !== `components/${name}.md`) {
            throw new Error(`The catalog's ${name} must name components/${name}.md as its doc.`);
        }
        outputs.set(join(specRoot, component.doc), componentPage(name, component));
    }
    outputs.set(
        catalogModulePath,
        catalogModule(
            "catalog.json",
            "The Gen UI v1 catalog: every component, prop, enum and limit.",
            "GEN_UI_CATALOG",
            catalog,
        ),
    );
    outputs.set(
        renderCatalogModulePath,
        catalogModule(
            "render/catalog.json",
            "The Gen UI render catalog: every primitive a client draws, and its props.",
            "GEN_UI_RENDER_CATALOG",
            JSON.parse(readFileSync(join(specRoot, "render", "catalog.json"), "utf8")),
        ),
    );
    for (const [path, text] of compiledExamples()) outputs.set(path, text);
    return outputs;
}

/** Generated files that differ from what is checked in, and pages no component owns. */
export function staleGenUiFiles(): string[] {
    const outputs = generateGenUiSpec();
    const stale = [...outputs]
        .filter(([path, text]) => {
            try {
                return readFileSync(path, "utf8") !== text;
            } catch {
                return true;
            }
        })
        .map(([path]) => path);
    for (const folder of [join(specRoot, "components"), join(specRoot, "render", "compiled")]) {
        for (const file of readdirSync(folder)) {
            const path = join(folder, file);
            if (!outputs.has(path)) stale.push(path);
        }
    }
    return stale;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes("--check")) {
        const stale = staleGenUiFiles();
        if (stale.length > 0) {
            console.error(
                `These Gen UI files are out of date; run pnpm genui:build:\n${stale.join("\n")}`,
            );
            process.exit(1);
        }
    } else {
        mkdirSync(join(specRoot, "render", "compiled"), { recursive: true });
        for (const [path, text] of generateGenUiSpec()) writeFileSync(path, text);
    }
}
