/**
 * The person's words for a `"message"` action against an offer's stored props: what the server
 * stores as their message, and what a client shows as the optimistic bubble. Undefined for a
 * silent action, or a payload that does not fit the props.
 *
 * - `choice.choose`: the option's label.
 * - `checklist.submit`: the submit label, a colon, and the ticked labels in the order the
 *   checklist shows them ("Use these: Claude, Codex"); with nothing ticked, `emptyLabel` when it
 *   has one, otherwise the submit label alone.
 * - `text_field.submit`: the text as typed.
 */
export function uiActionText(
    component: { readonly type: string; readonly props: unknown },
    action: { readonly type: string; readonly payload: unknown },
): string | undefined {
    const props = asRecord(component.props);
    const payload = asRecord(action.payload);
    if (props === undefined || payload === undefined) return undefined;
    switch (action.type) {
        case "choice.choose": {
            if (component.type !== "choice") return undefined;
            return optionsOf(props).find((option) => option.id === payload["optionId"])?.label;
        }
        case "checklist.submit": {
            if (component.type !== "checklist" || typeof props["submitLabel"] !== "string") {
                return undefined;
            }
            const selected = payload["selected"];
            if (!Array.isArray(selected)) return undefined;
            const options = optionsOf(props);
            if (selected.some((id) => !options.some((option) => option.id === id))) {
                return undefined;
            }
            const labels = options
                .filter((option) => selected.includes(option.id))
                .map((option) => option.label);
            if (labels.length === 0) {
                return typeof props["emptyLabel"] === "string"
                    ? props["emptyLabel"]
                    : props["submitLabel"];
            }
            return `${props["submitLabel"]}: ${labels.join(", ")}`;
        }
        case "text_field.submit": {
            if (component.type !== "text_field") return undefined;
            return typeof payload["text"] === "string" ? payload["text"] : undefined;
        }
        default:
            return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function optionsOf(props: Record<string, unknown>): { id: string; label: string }[] {
    const options = props["options"];
    if (!Array.isArray(options)) return [];
    return options.flatMap((option) => {
        const record = asRecord(option);
        return record !== undefined &&
            typeof record["id"] === "string" &&
            typeof record["label"] === "string"
            ? [{ id: record["id"], label: record["label"] }]
            : [];
    });
}
