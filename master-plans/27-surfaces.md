# Master plan 27: Surfaces

A Surface is an instance of a predefined feature with a strict API inside the
agent. Its ID is a CUID2, and multiple todo-list Surfaces may exist. A todo
list is one Surface; a calendar is another possible Surface type. The API lists
the available Surfaces. People join and leave them to add and remove them
from their sidebar, and every person has their own list and order. Each
Surface records the people who joined it so the app can show them.
Members live inside their Surface, not in a separate list beside the catalog.
An empty member array means nobody joined. The Todo API lives under
`/v0/surfaces/todo`.
Every Surface has a name and an optional image. Admin bots can create them
through a tool specific to the Surface type, and can add or remove people.
Any agent can create a document Surface, but only for the person it works for,
or for nobody when it works for nobody.
Surface, node, and bot images use one normalization function.

The first Surface is Todo: a plain Wunderlist-style list with text,
checkmarks, and completed todos. Its API loads all active todos and reorders
them with the existing decimal fractional format, reused everywhere with one
shared implementation. Returning an inactive todo to active puts it
at the end. Completed todos cannot be reordered. Todos can be deleted.

Every todo has a version, and every version is kept permanently so the todo
can be returned to an earlier state at any time. There is no separate restoring
command: the agent reads history and changes the todo's text and status using
the ordinary update operation, and uses ordinary reorder for placement.
Deleting or changing state must never lose history.
The Surface also supplies model tools to list, create, modify, and reorder
todos.

First establish the Surface catalog, joined-user tracking, and each person's
independent sidebar membership and order. Then implement the Todo API,
persistence, version history, and tools. This task covers the agent side
only. The later app should draw on the legacy happy-list and
happy-list-server data model and drag-and-drop mechanism.

This is done when the agent exposes the typed Surface and Todo operations,
membership order stays independent for each person, active todos reorder
correctly, completed todos reject reordering, returning to active appends, and every
todo revision remains available after edits, deletion, applying an earlier state, and
restart.
