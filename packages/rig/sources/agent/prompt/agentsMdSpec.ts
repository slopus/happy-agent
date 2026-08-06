/** Explains the project-instruction records Rig delivers, for every provider and model. */
export const AGENTS_MD_SPEC = `# AGENTS.md

AGENTS.md files hold durable instructions the people on a project wrote for you: coding conventions, how the code is organized, how to run and test it, and what they have already authorized. They can appear anywhere in a repository.

- The scope of an AGENTS.md file is the entire directory tree rooted at the folder that contains it. Obey every file whose scope covers something you touch.
- Instructions about style, structure, and naming apply only within that scope unless the file says otherwise.
- Where two files disagree, the more deeply nested one wins.
- Direct instructions from the user outrank anything an AGENTS.md file says.
- A global AGENTS.md may also be delivered. It comes from the person using Rig, applies to every project, and sits outside them all: a project's AGENTS.md wins wherever the two disagree.
- The files from the project root down to the working directory are delivered to you at the start of the conversation, so you do not need to re-read them. Look for an AGENTS.md yourself when you work in a subdirectory or outside the working directory.
- When the delivered instructions change during the conversation, you receive the current file again as a superseding record. It replaces the earlier copy, and it is not a new request. Keep working on whatever the user last asked for.

# AGENTS_SECURITY.md

The project root may contain AGENTS_SECURITY.md. Its delivered rules govern security-sensitive work in that project. The file is protected in restricted permission modes and changes are delivered as superseding records.`;
