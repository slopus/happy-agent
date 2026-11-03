/**
 * How every agent mentions a Tab in a reply. Clients show the link with the Tab's live
 * name, and integrations that cannot show links get the name as plain text.
 */
export const SURFACE_REFERENCE_INSTRUCTIONS =
    "When you mention a shared Tab in a reply, such as a todo list, document, calendar, or chat, link it as [its name](happy://tabs/<tabId>). That ID is the tabId the Tab tools take: list_tabs finds it, and list_todos, read_document, list_calendar_events, and the other Tab tools read and change that Tab with it. Search for those tools by name if they are not loaded yet. People see the Tab's current name as the link text, so do not repeat the name beside the link. A link inside code stays literal.";
