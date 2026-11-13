/** A `chart` element's props, as the authoring catalog allows them. */
export interface GenUiChartProps {
    readonly kind: "line" | "area" | "bar" | "donut";
    readonly labels: readonly string[];
    readonly series: readonly {
        readonly name: string;
        readonly values: readonly number[];
        readonly color?: GenUiColorName;
        readonly emphasis?: boolean;
    }[];
    readonly format?: { readonly prefix?: string; readonly suffix?: string };
    readonly stacked?: boolean;
    readonly totalLabel?: string;
}

/** A colour name of the shared theme. */
export type GenUiColorName =
    | "red"
    | "orange"
    | "yellow"
    | "green"
    | "teal"
    | "cyan"
    | "blue"
    | "indigo"
    | "purple"
    | "pink"
    | "brown"
    | "gray";

/** A plot colour: a 1-based index into the shared palette, the muted neutral, or a colour name. */
export type GenUiPlotColor = number | "muted" | GenUiColorName;

/** A `plot` primitive's props: everything a client needs to draw the chart without maths. */
export interface GenUiPlotProps {
    readonly kind: GenUiChartProps["kind"];
    readonly x: readonly string[];
    readonly y?: {
        readonly min: number;
        readonly max: number;
        readonly ticks: readonly { readonly value: number; readonly label: string }[];
    };
    readonly series: readonly {
        readonly name: string;
        readonly values: readonly (number | null)[];
        readonly labels: readonly (string | null)[];
        readonly color: GenUiPlotColor;
    }[];
    readonly stacked?: boolean;
    readonly slices?: readonly {
        readonly label: string;
        readonly value: number;
        readonly color: number;
    }[];
    readonly center?: { readonly value: string; readonly label: string };
    readonly legend?: readonly {
        readonly label: string;
        readonly color: GenUiPlotColor;
        readonly value?: string;
        readonly share?: string;
    }[];
    readonly summary: string;
}

/** About how many intervals a value axis is divided into. */
const TICK_INTERVALS = 4;

/**
 * The plot a chart draws, as `components/chart.md` describes it: series cut or padded to the
 * labels, palette indices with the others muted when one series is emphasised, a value axis of
 * round ticks (bar and area from zero, a line from zero unless its smallest value is more than
 * half its largest), labels abbreviated and wrapped in the format, and a text summary. A donut
 * gets its drawable slices, its total, and no axis.
 */
export function compileGenUiChart(chart: GenUiChartProps): GenUiPlotProps {
    const format = (value: number) => formatChartNumber(value, chart.format);
    const series = chart.series.map((entry) =>
        chart.labels.map((_, index) => entry.values[index] ?? null),
    );
    const labels = series.map((values) =>
        values.map((value) => (value === null ? null : format(value))),
    );
    if (chart.kind === "donut") {
        const first = chart.series[0]!;
        const values = series[0]!;
        const slices = chart.labels.flatMap((label, index) => {
            const value = values[index];
            return value !== null && value !== undefined && value > 0 ? [{ label, value }] : [];
        });
        const total = slices.reduce((sum, slice) => sum + slice.value, 0);
        const totalLabel = chart.totalLabel ?? "Total";
        const share = (value: number) => `${String(Math.round((value / total) * 100))}%`;
        const parts = slices.map(
            (slice) => `${slice.label} ${format(slice.value)} (${share(slice.value)})`,
        );
        return {
            kind: "donut",
            x: [...chart.labels],
            series: [{ name: first.name, values, labels: labels[0]!, color: 1 }],
            slices: slices.map((slice, index) => ({ ...slice, color: index + 1 })),
            center: { value: format(total), label: totalLabel },
            // A donut always has a legend: name, value and percentage per slice.
            legend: slices.map((slice, index) => ({
                label: slice.label,
                color: index + 1,
                value: format(slice.value),
                share: share(slice.value),
            })),
            summary: `Donut chart of ${first.name}, ${totalLabel.toLowerCase()} ${format(total)}${parts.length === 0 ? "." : `: ${parts.join(", ")}.`}`,
        };
    }
    const stacked = chart.stacked === true && chart.kind !== "line";
    const drawn = series.flatMap((values) => values.filter((value) => value !== null));
    let low: number;
    let high: number;
    if (stacked) {
        const sums = chart.labels.map((_, index) =>
            series.reduce(
                (sum, values) => {
                    const value = values[index] ?? 0;
                    return value >= 0 ? [sum[0]!, sum[1]! + value] : [sum[0]! + value, sum[1]!];
                },
                [0, 0],
            ),
        );
        low = Math.min(0, ...sums.map((sum) => sum[0]!));
        high = Math.max(0, ...sums.map((sum) => sum[1]!));
    } else {
        const min = drawn.length === 0 ? 0 : Math.min(...drawn);
        const max = drawn.length === 0 ? 0 : Math.max(...drawn);
        const fromZero = chart.kind !== "line" || !(min > 0 && min > max / 2);
        low = fromZero ? Math.min(0, min) : min;
        high = fromZero ? Math.max(0, max) : max;
    }
    const y = valueAxis(low, high, format);
    const emphasised = chart.series.some((entry) => entry.emphasis === true);
    const kindName = { line: "Line", area: "Area", bar: "Bar" }[chart.kind];
    const range =
        chart.labels.length === 1
            ? chart.labels[0]!
            : `${chart.labels[0]!} to ${chart.labels.at(-1)!}`;
    // A named colour replaces the series' palette index; emphasis still mutes the others.
    const colors = chart.series.map(
        (entry, index): GenUiPlotColor =>
            emphasised && entry.emphasis !== true ? "muted" : (entry.color ?? index + 1),
    );
    return {
        kind: chart.kind,
        x: [...chart.labels],
        y,
        series: chart.series.map((entry, index) => ({
            name: entry.name,
            values: series[index]!,
            labels: labels[index]!,
            color: colors[index]!,
        })),
        ...(stacked ? { stacked: true } : {}),
        // Two or more series name themselves in a legend.
        ...(chart.series.length > 1
            ? {
                  legend: chart.series.map((entry, index) => ({
                      label: entry.name,
                      color: colors[index]!,
                  })),
              }
            : {}),
        summary: [
            `${kindName} chart, ${range}.`,
            ...chart.series.map(
                (entry, index) =>
                    `${entry.name}: ${chart.labels
                        .map((label, at) => {
                            const value = series[index]![at];
                            return `${label} ${value === null || value === undefined ? "no value" : format(value)}`;
                        })
                        .join(", ")}.`,
            ),
        ].join(" "),
    };
}

/** Round ticks covering `low` to `high`, about `TICK_INTERVALS` apart. */
function valueAxis(
    low: number,
    high: number,
    format: (value: number) => string,
): NonNullable<GenUiPlotProps["y"]> {
    if (low === high) high = low === 0 ? 1 : low + Math.abs(low);
    const step = niceStep((high - low) / TICK_INTERVALS);
    const min = clean(Math.floor(low / step) * step);
    const max = clean(Math.ceil(high / step) * step);
    const ticks = [];
    for (let value = min; value <= max + step / 2; value = clean(value + step)) {
        ticks.push({ value, label: format(value) });
    }
    return { min, max, ticks };
}

/** The round step, 1, 2, 2.5 or 5 times a power of ten, at or above `rough`. */
function niceStep(rough: number): number {
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 2.5, 5, 10].find((factor) => factor * power >= rough - power * 1e-9) ?? 10;
    return clean(step * power);
}

/** A value with floating-point dust removed. */
function clean(value: number): number {
    const rounded = Number(value.toPrecision(12));
    return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * A chart number as `components/chart.md` writes it: abbreviated with k, M or B and at most one
 * decimal, then wrapped in the format's prefix and suffix, with a negative sign before the prefix
 * (`-$1.2k`).
 */
export function formatChartNumber(value: number, format: GenUiChartProps["format"] = {}): string {
    const magnitude = Math.abs(value);
    const [scaled, unit] =
        magnitude >= 1e9
            ? [magnitude / 1e9, "B"]
            : magnitude >= 1e6
              ? [magnitude / 1e6, "M"]
              : magnitude >= 1e3
                ? [magnitude / 1e3, "k"]
                : [magnitude, ""];
    const digits = String(Math.round(scaled * 10) / 10);
    const sign = value < 0 && digits !== "0" ? "-" : "";
    return `${sign}${format.prefix ?? ""}${digits}${unit}${format.suffix ?? ""}`;
}
