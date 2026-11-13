import {
    compileGenUiChart,
    type GenUiChartProps,
    type GenUiColorName,
} from "./compileGenUiChart.js";
import { parseInlineMarkdown, type GenUiSpan } from "./parseInlineMarkdown.js";
import type { GenUiDocument, GenUiNode } from "./validateGenUiDocument.js";

/**
 * The compiler's version, recorded in every render document. Bump it whenever the same authoring
 * document would compile differently, so stored render documents can be told apart and rebuilt.
 */
export const GEN_UI_COMPILER_VERSION = "1.0.0";

/** A stored picture an authoring `src` resolved to, measured by the daemon. */
export interface GenUiImage {
    /** Path of the picture inside the artifact. */
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly thumbhash: string;
}

export interface GenUiRenderElement {
    readonly type: string;
    readonly props: Readonly<Record<string, unknown>>;
    readonly children?: readonly string[];
    readonly slots?: Readonly<Record<string, readonly string[]>>;
}

/** One picture of an image viewer group, which the host's viewer pages through. */
export interface GenUiViewerItem {
    readonly file: string;
    readonly width: number;
    readonly height: number;
    readonly thumbhash: string;
    readonly alt: string;
    readonly caption?: string;
}

export interface GenUiRenderDocument {
    readonly genuiRender: 1;
    readonly compiler: string;
    readonly fallback?: string;
    readonly root: string;
    readonly viewers?: Readonly<Record<string, readonly GenUiViewerItem[]>>;
    readonly elements: Readonly<Record<string, GenUiRenderElement>>;
}

/** A semantic tone, or a colour name that tints and otherwise behaves as `neutral`. */
type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | GenUiColorName;
type Action = Readonly<Record<string, unknown>>;
type Badge = {
    readonly text: string;
    readonly tone?: Tone | undefined;
    readonly icon?: string | undefined;
};
type Image = { readonly src: string; readonly alt: string };
type Shape = "landscape" | "square" | "portrait";

/** Where an element sits, which some components draw differently. */
interface Place {
    readonly inCard: boolean;
    readonly inSection: boolean;
    /** The button's position in a card's actions, which decides its default variant. */
    readonly action?: number;
}

/**
 * Every node of a document with the path the validator names it by, such as
 * `root<card>.children[0]<stat>`, in document order.
 */
function walkGenUi(document: GenUiDocument): { readonly node: GenUiNode; readonly path: string }[] {
    const nodes: { node: GenUiNode; path: string }[] = [];
    const visit = (node: GenUiNode, path: string) => {
        const at = `${path}<${node.type}>`;
        nodes.push({ node, path: at });
        for (const list of ["children", "actions"]) {
            const children = node[list] as readonly GenUiNode[] | undefined;
            children?.forEach((child, index) => visit(child, `${at}.${list}[${String(index)}]`));
        }
    };
    visit(document.root, "root");
    return nodes;
}

/** Every image `src` a document shows, with the node and prop path that names it. */
export function genUiImageSources(
    document: GenUiDocument,
): { readonly path: string; readonly src: string }[] {
    const sources = [];
    for (const { node, path } of walkGenUi(document)) {
        if (node.type === "image") sources.push({ path: `${path}.src`, src: node.src as string });
        if (node.type === "gallery" || node.type === "list") {
            const items = node.items as readonly { image?: Image }[];
            items.forEach((item, index) => {
                if (item.image !== undefined) {
                    sources.push({
                        path: `${path}.items[${String(index)}].image.src`,
                        src: item.image.src,
                    });
                }
            });
        }
    }
    return sources;
}

/**
 * The render key of every node: its `id` when it has one, otherwise its type, numbered from the
 * second of that type on in document order (`stat`, `stat-2`), skipping any key an id already
 * holds. The same document always gets the same keys.
 */
function genUiNodeKeys(document: GenUiDocument): ReadonlyMap<GenUiNode, string> {
    const nodes = walkGenUi(document).map(({ node }) => node);
    const taken = new Set(nodes.flatMap((node) => (node.id === undefined ? [] : [node.id])));
    const counts = new Map<string, number>();
    const keys = new Map<GenUiNode, string>();
    for (const node of nodes) {
        if (node.id !== undefined) {
            keys.set(node, node.id);
            continue;
        }
        let key: string;
        do {
            const count = (counts.get(node.type) ?? 0) + 1;
            counts.set(node.type, count);
            key = count === 1 ? node.type : `${node.type}-${String(count)}`;
        } while (taken.has(key));
        taken.add(key);
        keys.set(node, key);
    }
    return keys;
}

/**
 * Compile a valid authoring document into the render document clients draw, by the lowering
 * rules of `docs/genui/RENDER.md` with each component page as the contract. It is a pure function
 * of the document and the images its sources resolved to, every one of which must be given.
 * Each node's outermost primitive takes the node's key (see `genUiNodeKeys`), and the primitives
 * inside it are keyed below it (`revenue.label`), so an action reports against the node.
 */
export function compileGenUi(
    document: GenUiDocument,
    images: ReadonlyMap<string, GenUiImage>,
): GenUiRenderDocument {
    const keys = genUiNodeKeys(document);
    const out: Record<string, GenUiRenderElement> = {};

    const add = (
        key: string,
        type: string,
        props: Readonly<Record<string, unknown>>,
        children?: readonly string[],
    ): string => {
        const defined = Object.fromEntries(
            Object.entries(props).filter(([, value]) => value !== undefined),
        );
        out[key] = { type, props: defined, ...(children === undefined ? {} : { children }) };
        return key;
    };
    const box = (key: string, props: Readonly<Record<string, unknown>>, children: string[]) =>
        add(key, "box", props, children);
    const text = (
        key: string,
        spans: readonly GenUiSpan[] | string,
        role: string,
        props: Readonly<Record<string, unknown>> = {},
    ) =>
        add(key, "text", {
            spans: typeof spans === "string" ? [{ text: spans }] : spans,
            role,
            ...props,
        });
    const icon = (key: string, name: string, role: "leading" | "inline", tone?: string) =>
        add(key, "icon", { name, tone, role });
    const pill = (key: string, badge: Badge) =>
        add(key, "pill", { text: badge.text, tone: badge.tone, icon: badge.icon });
    const image = (
        key: string,
        source: Image,
        shape: Shape,
        role: "figure" | "tile" | "thumb" | "cover",
        extra: Readonly<Record<string, unknown>> = {},
    ) => {
        const stored = images.get(source.src);
        if (stored === undefined) throw new Error(`The image ${source.src} was not resolved.`);
        return add(key, "image", {
            file: stored.file,
            width: stored.width,
            height: stored.height,
            thumbhash: stored.thumbhash,
            alt: source.alt,
            shape,
            role,
            ...extra,
        });
    };
    const viewers: Record<string, GenUiViewerItem[]> = {};
    const viewerItem = (source: Image, caption?: string): GenUiViewerItem => {
        const stored = images.get(source.src)!;
        return {
            file: stored.file,
            width: stored.width,
            height: stored.height,
            thumbhash: stored.thumbhash,
            alt: source.alt,
            ...(caption === undefined ? {} : { caption }),
        };
    };
    const press = (
        key: string,
        action: Action | undefined,
        child: string,
        role?: "item" | "tile",
    ) => (action === undefined ? child : add(key, "press", { action, role }, [child]));

    const lower = (node: GenUiNode, place: Place): string => {
        const key = keys.get(node)!;
        const props: unknown = node;
        const inner: Place = { inCard: place.inCard, inSection: place.inSection };
        const children = (within: Place) =>
            (node.children ?? []).map((child) => lower(child, within));
        switch (node.type) {
            case "card": {
                const nested = place.inCard;
                const parts: string[] = [];
                const {
                    title,
                    subtitle,
                    icon: glyph,
                    badge,
                } = props as {
                    title?: string;
                    subtitle?: string;
                    icon?: string;
                    badge?: Badge;
                };
                if (!nested && (title ?? subtitle ?? glyph ?? badge) !== undefined) {
                    const header: string[] = [];
                    if (glyph !== undefined) header.push(icon(`${key}.icon`, glyph, "leading"));
                    const heading: string[] = [];
                    if (title !== undefined) heading.push(text(`${key}.title`, title, "title"));
                    if (subtitle !== undefined) {
                        heading.push(text(`${key}.subtitle`, subtitle, "subtitle"));
                    }
                    if (heading.length === 1 && glyph === undefined) header.push(heading[0]!);
                    else if (heading.length > 0) {
                        header.push(box(`${key}.heading`, { gap: "tight", grow: true }, heading));
                    }
                    if (badge !== undefined) header.push(pill(`${key}.badge`, badge));
                    parts.push(
                        box(
                            `${key}.header`,
                            {
                                role: "header",
                                direction: "row",
                                gap: "inline",
                                align: "start",
                                justify: "between",
                            },
                            header,
                        ),
                    );
                }
                parts.push(...children({ inCard: true, inSection: place.inSection }));
                const actions = (node.actions as readonly GenUiNode[] | undefined) ?? [];
                if (actions.length > 0) {
                    parts.push(
                        box(
                            `${key}.actions`,
                            { role: "actions", direction: "row", gap: "inline", wrap: true },
                            actions.map((action, index) =>
                                lower(action, { inCard: true, inSection: false, action: index }),
                            ),
                        ),
                    );
                }
                // A card inside a card keeps its content and actions but not its frame or header.
                return box(key, { role: nested ? "plain" : "card", gap: "blocks" }, parts);
            }
            case "stack":
                return box(key, { gap: "blocks" }, children(inner));
            case "row": {
                // Up to three stats always sit side by side, even on a phone.
                const stats = (node.children ?? []).every((child) => child.type === "stat");
                const fits = stats && (node.children ?? []).length <= 3;
                return box(
                    key,
                    {
                        direction: "row",
                        gap: "blocks",
                        align: "start",
                        equal: true,
                        wrap: !fits,
                    },
                    children(inner),
                );
            }
            case "section": {
                const { title } = props as { title: string };
                const content = children({ inCard: place.inCard, inSection: true });
                const body =
                    content.length > 1
                        ? [box(`${key}.content`, { gap: "blocks" }, content)]
                        : content;
                // Sections do not nest: one inside another is plain children under its title.
                return box(key, { role: place.inSection ? "plain" : "section", gap: "heading" }, [
                    text(`${key}.title`, title, place.inSection ? "label" : "heading"),
                    ...body,
                ]);
            }
            case "text": {
                const {
                    text: markdown,
                    variant,
                    tone,
                } = props as {
                    text: string;
                    variant?: "body" | "title" | "caption";
                    tone?: Tone;
                };
                return text(
                    key,
                    parseInlineMarkdown(markdown),
                    variant === "title" ? "heading" : variant === "caption" ? "note" : "body",
                    { tone },
                );
            }
            case "badge":
                return pill(key, props as Badge);
            case "stat": {
                const stat = props as {
                    label: string;
                    value: string;
                    delta?: string;
                    deltaLabel?: string;
                    trend?: "up" | "down" | "flat";
                    tone?: Tone;
                    spark?: readonly number[];
                };
                const tone =
                    stat.tone ??
                    (stat.trend === "up"
                        ? "success"
                        : stat.trend === "down"
                          ? "danger"
                          : "neutral");
                const line = [text(`${key}.value`, stat.value, "value", { fixed: true })];
                if (stat.delta !== undefined) {
                    // The arrow and its delta stay together when the line wraps.
                    const change: string[] = [];
                    if (stat.trend !== undefined) {
                        const arrow = { up: "arrow-up", down: "arrow-down", flat: "arrow-right" };
                        change.push(icon(`${key}.trend`, arrow[stat.trend], "inline", tone));
                    }
                    change.push(text(`${key}.delta`, stat.delta, "delta", { tone, fixed: true }));
                    line.push(
                        box(
                            `${key}.change`,
                            { direction: "row", gap: "inline", align: "baseline", wrap: false },
                            change,
                        ),
                    );
                }
                if (stat.deltaLabel !== undefined) {
                    line.push(text(`${key}.deltaLabel`, stat.deltaLabel, "note"));
                }
                return box(key, { gap: "related" }, [
                    text(`${key}.label`, stat.label, "label"),
                    box(
                        `${key}.line`,
                        {
                            direction: "row",
                            gap: "inline",
                            align: "baseline",
                            wrap: true,
                        },
                        line,
                    ),
                    ...(stat.spark === undefined
                        ? []
                        : [add(`${key}.spark`, "spark", { values: stat.spark, tone })]),
                ]);
            }
            case "keyvalue": {
                const { items } = props as {
                    items: readonly {
                        label: string;
                        value: string;
                        icon?: string;
                        tone?: Tone;
                        action?: Action;
                    }[];
                };
                const leading = items.some((item) => item.icon !== undefined) ? "icon" : "none";
                const compact = box(
                    `${key}.compact`,
                    { gap: "items", divide: "full", leading },
                    items.map((item, index) => {
                        const at = `${key}.compact.${String(index)}`;
                        const row = box(
                            at,
                            {
                                role: "item",
                                direction: "row",
                                gap: "inline",
                                // An icon is centred on its row, as in a list; text rows align
                                // label and value on their baseline.
                                align: leading === "icon" ? "center" : "baseline",
                                leading,
                            },
                            [
                                // The icon leads the row directly, as a list row's does.
                                ...(item.icon === undefined
                                    ? []
                                    : [icon(`${at}.icon`, item.icon, "leading")]),
                                box(`${at}.texts`, { grow: true }, [
                                    text(`${at}.label`, item.label, "label"),
                                ]),
                                text(`${at}.value`, item.value, "body", {
                                    tone: item.tone,
                                    align: "end",
                                    fixed: true,
                                }),
                            ],
                        );
                        return press(`${at}.press`, item.action, row, "item");
                    }),
                );
                const regular = add(
                    `${key}.regular`,
                    "grid",
                    {
                        // With any icon, icons get a column of their own so labels share an edge.
                        columns: [
                            ...(leading === "icon" ? [{ width: "auto" }] : []),
                            { width: "auto" },
                            { width: "fill" },
                        ],
                        density: "pairs",
                    },
                    items.flatMap((item, index) => {
                        const at = `${key}.regular.${String(index)}`;
                        return [
                            ...(leading === "none"
                                ? []
                                : [
                                      item.icon === undefined
                                          ? box(`${at}.icon`, {}, [])
                                          : icon(`${at}.icon`, item.icon, "leading"),
                                  ]),
                            text(`${at}.label`, item.label, "label"),
                            press(
                                `${at}.press`,
                                item.action,
                                text(`${at}.value`, item.value, "body", {
                                    tone: item.tone,
                                    fixed: true,
                                }),
                            ),
                        ];
                    }),
                );
                return lowerSwitch(key, compact, regular);
            }
            case "callout": {
                const callout = props as {
                    text: string;
                    title?: string;
                    tone?: Tone;
                    icon?: string;
                };
                const tone = callout.tone ?? "neutral";
                const glyph =
                    callout.icon ??
                    (tone === "success"
                        ? "check"
                        : tone === "warning" || tone === "danger"
                          ? "alert"
                          : "info");
                const body = parseInlineMarkdown(callout.text);
                return box(
                    key,
                    { role: "notice", tone, direction: "row", gap: "inline", align: "start" },
                    [
                        icon(`${key}.icon`, glyph, "leading", tone),
                        text(
                            `${key}.text`,
                            callout.title === undefined
                                ? body
                                : [{ text: callout.title, strong: true }, { text: " " }, ...body],
                            "body",
                        ),
                    ],
                );
            }
            case "code": {
                const code = props as { text: string; language?: string; title?: string };
                return add(key, "code", {
                    text: code.text,
                    language: code.language,
                    title: code.title,
                });
            }
            case "chart": {
                const { caption, ...chart } = props as GenUiChartProps & { caption?: string };
                if (caption === undefined) {
                    return add(key, "plot", { ...compileGenUiChart(chart) });
                }
                return box(key, { gap: "labeled" }, [
                    add(`${key}.plot`, "plot", { ...compileGenUiChart(chart) }),
                    text(`${key}.caption`, caption, "note"),
                ]);
            }
            case "table":
                return lowerTable(key, props as TableProps);
            case "list":
                return lowerList(key, props as ListProps);
            case "steps": {
                const { items } = props as {
                    items: readonly {
                        title: string;
                        detail?: string;
                        status: "done" | "active" | "pending" | "failed";
                        time?: string;
                    }[];
                };
                return box(
                    key,
                    { gap: "items" },
                    items.map((item, index) => {
                        const at = `${key}.${String(index)}`;
                        const texts = [
                            text(`${at}.title`, item.title, "item", {
                                tone:
                                    item.status === "pending"
                                        ? "muted"
                                        : item.status === "failed"
                                          ? "danger"
                                          : undefined,
                            }),
                        ];
                        if (item.detail !== undefined) {
                            texts.push(text(`${at}.detail`, item.detail, "detail"));
                        }
                        return box(at, { direction: "row", gap: "inline", align: "start" }, [
                            add(`${at}.marker`, "marker", {
                                status: item.status,
                                rail: index < items.length - 1 ? true : undefined,
                            }),
                            box(`${at}.texts`, { gap: "related", grow: true }, texts),
                            ...(item.time === undefined
                                ? []
                                : [text(`${at}.time`, item.time, "trailing", { fixed: true })]),
                        ]);
                    }),
                );
            }
            case "progress": {
                const progress = props as {
                    value: number;
                    label?: string;
                    detail?: string;
                    tone?: Tone;
                };
                const line = [];
                if (progress.label !== undefined) {
                    line.push(text(`${key}.label`, progress.label, "label"));
                }
                if (progress.detail !== undefined) {
                    line.push(text(`${key}.detail`, progress.detail, "detail", { align: "end" }));
                }
                return box(key, { gap: "labeled" }, [
                    ...(line.length === 0
                        ? []
                        : [
                              box(
                                  `${key}.line`,
                                  {
                                      direction: "row",
                                      gap: "inline",
                                      align: "baseline",
                                      justify: "between",
                                  },
                                  line,
                              ),
                          ]),
                    add(`${key}.bar`, "bar", {
                        value: Math.min(1, Math.max(0, progress.value)),
                        tone: progress.tone,
                    }),
                ]);
            }
            case "gallery":
                return lowerGallery(key, props as GalleryProps);
            case "image": {
                const figure = props as Image & { caption?: string; aspect?: Shape };
                const shape = figure.aspect ?? "landscape";
                const viewer = { viewer: { group: key, index: 0 } };
                viewers[key] = [viewerItem(figure, figure.caption)];
                if (figure.caption === undefined)
                    return image(key, figure, shape, "figure", viewer);
                return box(key, { gap: "related" }, [
                    image(`${key}.image`, figure, shape, "figure", viewer),
                    text(`${key}.caption`, figure.caption, "note"),
                ]);
            }
            case "button": {
                const button = props as {
                    label: string;
                    action: Action;
                    icon?: string;
                    variant?: "primary" | "secondary" | "plain";
                    tone?: Tone;
                };
                return add(key, "button", {
                    label: button.label,
                    action: button.action,
                    icon: button.icon,
                    variant: button.variant ?? (place.action === 0 ? "primary" : "secondary"),
                    tone: button.tone,
                });
            }
            case "choices": {
                const choices = props as {
                    options: readonly {
                        label: string;
                        description?: string;
                        icon?: string;
                        action: Action;
                    }[];
                    prompt?: string;
                    layout?: "list" | "chips";
                };
                const choiceLeading = choices.options.some((choice) => choice.icon !== undefined)
                    ? "icon"
                    : "none";
                const options =
                    choices.layout === "chips"
                        ? box(
                              `${key}.options`,
                              { direction: "row", gap: "inline", wrap: true },
                              choices.options.map((option, index) =>
                                  add(`${key}.${String(index)}`, "button", {
                                      label: option.label,
                                      action: option.action,
                                      icon: option.icon,
                                      variant: "chip",
                                      group: key,
                                  }),
                              ),
                          )
                        : box(
                              `${key}.options`,
                              { gap: "items", divide: "full", leading: choiceLeading },
                              choices.options.map((option, index) => {
                                  const at = `${key}.${String(index)}`;
                                  const texts = [text(`${at}.label`, option.label, "item")];
                                  if (option.description !== undefined) {
                                      texts.push(
                                          text(`${at}.description`, option.description, "detail"),
                                      );
                                  }
                                  const row = box(
                                      `${at}.row`,
                                      {
                                          role: "item",
                                          direction: "row",
                                          gap: "inline",
                                          align: "center",
                                          leading: choiceLeading,
                                      },
                                      [
                                          ...(option.icon === undefined
                                              ? []
                                              : [icon(`${at}.icon`, option.icon, "leading")]),
                                          box(`${at}.texts`, { gap: "related", grow: true }, texts),
                                          icon(`${at}.chevron`, "chevron-right", "inline", "muted"),
                                      ],
                                  );
                                  return add(
                                      at,
                                      "press",
                                      { action: option.action, role: "item", group: key },
                                      [row],
                                  );
                              }),
                          );
                if (choices.prompt === undefined) return box(key, {}, [options]);
                return box(key, { gap: "heading" }, [
                    text(`${key}.prompt`, choices.prompt, "prompt"),
                    options,
                ]);
            }
            default:
                throw new Error(`Gen UI has no lowering for ${node.type}.`);
        }
    };

    const lowerSwitch = (key: string, compact: string, regular: string): string => {
        out[key] = { type: "switch", props: {}, slots: { compact: [compact], regular: [regular] } };
        return key;
    };

    const lowerTable = (key: string, table: TableProps): string => {
        const cell = (
            at: string,
            column: TableColumn,
            value: TableCell | undefined,
            role?: "rowhead",
        ) => {
            const raw = typeof value === "string" ? { text: value } : (value ?? { text: "" });
            if (column.kind === "badge" && raw.text !== "") {
                return pill(at, { text: raw.text, tone: raw.tone });
            }
            // A grid cell takes its column's alignment, so the text carries none.
            return text(
                at,
                column.kind === "code" && raw.text !== ""
                    ? [{ text: raw.text, code: true }]
                    : raw.text,
                role ?? (column.kind === "number" ? "number" : "cell"),
                { tone: raw.tone, fixed: column.kind === "number" ? true : undefined },
            );
        };
        const grid = (at: string) =>
            add(
                at,
                "grid",
                {
                    columns: table.columns.map((column, index) => ({
                        width: index === 0 ? "fill" : "auto",
                        align: column.align ?? (column.kind === "number" ? "end" : undefined),
                    })),
                    density: "table",
                    divide: true,
                    header: true,
                },
                [
                    ...table.columns.map((column, index) =>
                        text(`${at}.head.${String(index)}`, column.label, "column"),
                    ),
                    ...table.rows.flatMap((row, rowIndex) =>
                        table.columns.map((column, index) =>
                            cell(
                                `${at}.${String(rowIndex)}.${String(index)}`,
                                column,
                                row[column.key],
                                index === 0 ? "rowhead" : undefined,
                            ),
                        ),
                    ),
                ],
            );
        const regular = grid(`${key}.regular`);
        const compact =
            table.columns.length <= 3
                ? grid(`${key}.compact`)
                : box(
                      `${key}.compact`,
                      { gap: "items", divide: "full" },
                      table.rows.map((row, rowIndex) => {
                          const at = `${key}.compact.${String(rowIndex)}`;
                          const [first, ...rest] = table.columns;
                          const badge = rest.find((column) => column.kind === "badge");
                          const others = rest.filter((column) => column !== badge);
                          const title = [
                              cell(
                                  `${at}.title`,
                                  { ...first!, kind: "text" },
                                  row[first!.key],
                                  "rowhead",
                              ),
                          ];
                          if (badge !== undefined && row[badge.key] !== undefined) {
                              title.push(cell(`${at}.badge`, badge, row[badge.key]));
                          }
                          return box(at, { role: "record", gap: "related" }, [
                              box(
                                  `${at}.line`,
                                  {
                                      direction: "row",
                                      gap: "inline",
                                      align: "center",
                                      justify: "between",
                                  },
                                  title,
                              ),
                              add(
                                  `${at}.fields`,
                                  "grid",
                                  {
                                      // On a phone each value sits at the trailing edge.
                                      columns: [{ width: "auto" }, { width: "fill", align: "end" }],
                                      density: "pairs",
                                  },
                                  others.flatMap((column) => {
                                      const index = table.columns.indexOf(column);
                                      return [
                                          text(
                                              `${at}.${String(index)}.label`,
                                              column.label,
                                              "label",
                                          ),
                                          cell(
                                              `${at}.${String(index)}.value`,
                                              column,
                                              row[column.key],
                                          ),
                                      ];
                                  }),
                              ),
                          ]);
                      }),
                  );
        const alone = table.rows.length > 0 && table.caption === undefined;
        const parts = [lowerSwitch(alone ? key : `${key}.table`, compact, regular)];
        if (table.rows.length === 0) parts.push(text(`${key}.empty`, "No rows", "note"));
        if (table.caption !== undefined) parts.push(text(`${key}.caption`, table.caption, "note"));
        return parts.length === 1 ? parts[0]! : box(key, { gap: "labeled" }, parts);
    };

    const lowerList = (key: string, list: ListProps): string => {
        // Every row reserves the widest leading element of the list, so titles share an edge.
        const leading = widestLeading(
            list.items.map((item) =>
                item.image !== undefined
                    ? "thumb"
                    : list.ordered === true
                      ? "number"
                      : item.icon !== undefined
                        ? "icon"
                        : "none",
            ),
        );
        return box(
            key,
            { gap: "items", divide: "inset", leading },
            list.items.map((item, index) => {
                const at = `${key}.${String(index)}`;
                const lead = (branch: string): string[] => {
                    if (item.image !== undefined) {
                        return [image(`${branch}.image`, item.image, "square", "thumb")];
                    }
                    if (list.ordered === true) {
                        return [text(`${branch}.number`, `${String(index + 1)}.`, "ordinal")];
                    }
                    if (item.icon !== undefined) {
                        return [icon(`${branch}.icon`, item.icon, "leading", item.tone)];
                    }
                    return [];
                };
                const title = (branch: string) =>
                    text(`${branch}.title`, item.title, "item", { overflow: "clamp" });
                const subtitle = (branch: string) =>
                    item.subtitle === undefined
                        ? []
                        : [
                              text(`${branch}.subtitle`, item.subtitle, "detail", {
                                  overflow: "truncate",
                              }),
                          ];
                const trailing = (branch: string) =>
                    item.trailing === undefined
                        ? []
                        : [text(`${branch}.trailing`, item.trailing, "trailing", { fixed: true })];
                const badge = (branch: string) =>
                    item.badge === undefined ? [] : [pill(`${branch}.badge`, item.badge)];
                const chevron = (branch: string) =>
                    item.action === undefined
                        ? []
                        : [icon(`${branch}.chevron`, "chevron-right", "inline", "muted")];
                const rowProps = {
                    role: "item",
                    direction: "row",
                    gap: "inline",
                    align: "center",
                    leading,
                };
                // Wide: badge, trailing text and chevron at the trailing edge.
                const regular = (branch: string) =>
                    box(branch, rowProps, [
                        ...lead(branch),
                        box(`${branch}.texts`, { gap: "related", grow: true }, [
                            title(branch),
                            ...subtitle(branch),
                        ]),
                        ...badge(branch),
                        ...trailing(branch),
                        ...chevron(branch),
                    ]);
                let content: string;
                if (item.badge === undefined) {
                    content = regular(`${at}.row`);
                } else {
                    // Phones: trailing text on the title line, the badge on the subtitle line.
                    const branch = `${at}.compact`;
                    const lineProps = {
                        direction: "row",
                        gap: "inline",
                        align: "baseline",
                        justify: "between",
                    };
                    const lines =
                        item.subtitle === undefined
                            ? [
                                  box(`${branch}.line`, lineProps, [
                                      title(branch),
                                      ...badge(branch),
                                      ...trailing(branch),
                                  ]),
                              ]
                            : [
                                  box(`${branch}.line`, lineProps, [
                                      title(branch),
                                      ...trailing(branch),
                                  ]),
                                  box(`${branch}.subline`, lineProps, [
                                      ...subtitle(branch),
                                      ...badge(branch),
                                  ]),
                              ];
                    const compact = box(branch, rowProps, [
                        ...lead(branch),
                        box(`${branch}.texts`, { gap: "related", grow: true }, lines),
                        ...chevron(branch),
                    ]);
                    content = lowerSwitch(`${at}.switch`, compact, regular(`${at}.regular`));
                }
                return press(at, item.action, content, "item");
            }),
        );
    };

    const lowerGallery = (key: string, gallery: GalleryProps): string => {
        const shape = gallery.aspect ?? "landscape";
        if (gallery.layout === "carousel") {
            return add(
                key,
                "scroll",
                { shape },
                gallery.items.map((item, index) => {
                    const at = `${key}.${String(index)}`;
                    const parts = [image(`${at}.image`, item.image, shape, "cover")];
                    if (item.title !== undefined)
                        parts.push(text(`${at}.title`, item.title, "item", { overflow: "clamp" }));
                    if (item.subtitle !== undefined) {
                        parts.push(
                            text(`${at}.subtitle`, item.subtitle, "detail", {
                                overflow: "truncate",
                            }),
                        );
                    }
                    // The badge has a line of its own, under the title and subtitle.
                    if (item.badge !== undefined) parts.push(pill(`${at}.badge`, item.badge));
                    const card = box(
                        item.action === undefined ? at : `${at}.card`,
                        { role: "tile", gap: "related" },
                        parts,
                    );
                    return press(at, item.action, card, "tile");
                }),
            );
        }
        // The platform arranges up to five tiles by their count; the viewer pages through all.
        viewers[key] = gallery.items.map((item) => viewerItem(item.image, item.title));
        const more = gallery.items.length - 5;
        return box(
            key,
            { role: "mosaic" },
            gallery.items.slice(0, 5).map((item, index) =>
                image(`${key}.${String(index)}`, item.image, shape, "tile", {
                    overlay: index === 4 && more > 0 ? `+${String(more)}` : undefined,
                    viewer: { group: key, index },
                }),
            ),
        );
    };

    const root = lower(document.root, { inCard: false, inSection: false });
    // Elements are listed from the root down, each before what it holds, so the document reads
    // in the order it draws.
    const ordered: Record<string, GenUiRenderElement> = {};
    const visit = (key: string) => {
        const element = out[key]!;
        ordered[key] = element;
        for (const child of element.children ?? []) visit(child);
        for (const ids of Object.values(element.slots ?? {})) ids.forEach(visit);
    };
    visit(root);
    return {
        genuiRender: 1,
        compiler: GEN_UI_COMPILER_VERSION,
        ...(document.fallback === undefined ? {} : { fallback: document.fallback }),
        root,
        ...(Object.keys(viewers).length === 0 ? {} : { viewers }),
        elements: ordered,
    };
}

type Leading = "none" | "number" | "icon" | "thumb";

/** The widest of the leading elements a list's rows have. */
function widestLeading(kinds: readonly Leading[]): Leading {
    const order: readonly Leading[] = ["none", "number", "icon", "thumb"];
    return kinds.reduce<Leading>(
        (widest, kind) => (order.indexOf(kind) > order.indexOf(widest) ? kind : widest),
        "none",
    );
}

type TableCell = string | { readonly text: string; readonly tone?: Tone };
interface TableColumn {
    readonly key: string;
    readonly label: string;
    readonly kind?: "text" | "number" | "badge" | "code";
    readonly align?: "start" | "end";
}
interface TableProps {
    readonly columns: readonly TableColumn[];
    readonly rows: readonly Readonly<Record<string, TableCell>>[];
    readonly caption?: string;
}
interface ListProps {
    readonly items: readonly {
        readonly title: string;
        readonly subtitle?: string;
        readonly icon?: string;
        readonly image?: Image;
        readonly tone?: Tone;
        readonly badge?: Badge;
        readonly trailing?: string;
        readonly action?: Action;
    }[];
    readonly ordered?: boolean;
}
interface GalleryProps {
    readonly items: readonly {
        readonly image: Image;
        readonly title?: string;
        readonly subtitle?: string;
        readonly badge?: Badge;
        readonly action?: Action;
    }[];
    readonly layout?: "grid" | "carousel";
    readonly aspect?: Shape;
}
