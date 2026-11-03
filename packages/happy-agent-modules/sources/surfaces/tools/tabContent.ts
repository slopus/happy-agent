import { Type, type TObject, type TProperties } from "@sinclair/typebox";
import { surfaceIdSchema } from "@slopus/happy-agent-client";

/** Model content uses tabId; persistent records and the compatible HTTP API keep surfaceId. */
export function tabContentSchema<T extends TProperties>(schema: TObject<T>) {
    return Type.Object(
        {
            ...Type.Omit(schema, ["surfaceId"]).properties,
            tabId: surfaceIdSchema,
        },
        { additionalProperties: schema.additionalProperties },
    );
}

type TabContent<T> = T extends { surfaceId: string }
    ? Omit<T, "surfaceId"> & { tabId: string }
    : never;

export function tabContent<T extends { surfaceId: string }>(content: T): TabContent<T> {
    const { surfaceId, ...rest } = content;
    // The sole changed key is surfaceId; the distributive type preserves content unions.
    return { ...rest, tabId: surfaceId } as TabContent<T>;
}
