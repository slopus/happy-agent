/**
 * How every agent mentions a Surface in a reply. Clients show the link with the Surface's live
 * name, and integrations that cannot show links get the name as plain text.
 */
export const SURFACE_REFERENCE_INSTRUCTIONS =
    "When you mention a shared Surface in a reply, such as a todo list, document, calendar, or chat, link it as [its name](happy://surfaces/<surfaceId>). That ID is the surfaceId the Surface tools take: list_surfaces finds it, and list_todos, read_document, list_calendar_events, and the other Surface tools read and change that Surface with it. Search for those tools by name if they are not loaded yet. People see the Surface's current name as the link text, so do not repeat the name beside the link. A link inside code stays literal.";
