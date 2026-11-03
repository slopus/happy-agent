import { describe, expect, it } from "vitest";
import { HappyAgentClient } from "../sources/HappyAgentClient.js";

const id = "id/with space";
const options = {
    ifMatch: "version",
    mutationId: "mutation",
    limit: 3,
    afterSeq: 4,
    beforeSeq: 8,
    afterVersion: "after",
    scope: "all",
    seq: 2,
    stateVector: "vector",
    ifNoneMatch: "etag",
};
// Transport parity deliberately uses one opaque body; individual protocol tests cover its schema.
const body = { type: "todo", name: "Name", text: "Text", mutationId: "mutation" };
const pairs = [
    ["listSurfaces", "listTabs", [options]],
    ["createSurface", "createTab", [body, options]],
    ["getSurfaceImage", "getTabImage", [id, options]],
    ["updateSurface", "updateTab", [id, body, options]],
    ["joinSurface", "joinTab", [id, options]],
    ["leaveSurface", "leaveTab", [id, options]],
    ["reorderSurface", "reorderTab", [id, body, options]],
    ["ensureSurfaceChat", "ensureTabChat", [id, options]],
    ["listTodos", "listTabTodos", [id, options]],
    ["createTodo", "createTabTodo", [id, body, options]],
    ["getTodo", "getTabTodo", [id, id, options]],
    ["updateTodo", "updateTabTodo", [id, id, body, options]],
    ["reorderTodo", "reorderTabTodo", [id, id, body, options]],
    ["deleteTodo", "deleteTabTodo", [id, id, options]],
    ["listTodoVersions", "listTabTodoVersions", [id, id, options]],
    ["getTodoVersion", "getTabTodoVersion", [id, id, id, options]],
    ["getSystemMonitor", "getTabSystemMonitor", [id, options]],
    [
        "listCalendarEvents",
        "listTabCalendarEvents",
        [id, { from: 1, to: 2, timeZone: "UTC" }, options],
    ],
    ["createCalendarEvent", "createTabCalendarEvent", [id, body, options]],
    ["getCalendarEvent", "getTabCalendarEvent", [id, id, options]],
    ["updateCalendarEvent", "updateTabCalendarEvent", [id, id, body, options]],
    ["deleteCalendarEvent", "deleteTabCalendarEvent", [id, id, options]],
    ["listCalendarEventVersions", "listTabCalendarEventVersions", [id, id, options]],
    ["getCalendarEventVersion", "getTabCalendarEventVersion", [id, id, id, options]],
    ["listSurfaceMessages", "listTabMessages", [id, options]],
    ["sendSurfaceMessage", "sendTabMessage", [id, body, options]],
    ["getSurfaceMessage", "getTabMessage", [id, id, options]],
    ["editSurfaceMessage", "editTabMessage", [id, id, body, options]],
    ["deleteSurfaceMessage", "deleteTabMessage", [id, id, options]],
    ["listSurfaceMessageVersions", "listTabMessageVersions", [id, id, options]],
    ["getSurfaceMessageVersion", "getTabMessageVersion", [id, id, id, options]],
    ["getSurfaceDocument", "getTabDocument", [id, options]],
    ["getSurfaceDocumentState", "getTabDocumentState", [id, options]],
    ["sendSurfaceDocumentUpdate", "sendTabDocumentUpdate", [id, body, options]],
    ["listSurfaceDocumentUpdates", "listTabDocumentUpdates", [id, options]],
    ["subscribeSurfaceDocument", "subscribeTabDocument", [id, body, options]],
    ["unsubscribeSurfaceDocument", "unsubscribeTabDocument", [id, body, options]],
    ["sendSurfaceDocumentPresence", "sendTabDocumentPresence", [id, body, options]],
    ["listSurfaceDocumentVersions", "listTabDocumentVersions", [id, options]],
    ["getSurfaceDocumentVersion", "getTabDocumentVersion", [id, id, options]],
] as const;

describe("all tab client routes retain the compatible transport contract", () => {
    it.each(pairs)("%s and %s differ only by namespace", async (legacy, canonical, args) => {
        const requests: {
            url: string;
            method: string | undefined;
            body: BodyInit | null | undefined;
            headers: [string, string][];
        }[] = [];
        const client = new HappyAgentClient({
            endpoint: "http://agent.local/prefix",
            token: "token",
            fetch: async (input, init) => {
                requests.push({
                    url: String(input),
                    method: init?.method,
                    body: init?.body,
                    headers: [...new Headers(init?.headers)],
                });
                return Response.json({ surface: {}, surfaces: [], cursor: "cursor" });
            },
        });
        await Reflect.apply(client[legacy], client, args);
        await Reflect.apply(client[canonical], client, args);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual({
            ...requests[0],
            url: requests[0]!.url.replace("/v0/surfaces", "/v0/tabs"),
        });
    });
});
