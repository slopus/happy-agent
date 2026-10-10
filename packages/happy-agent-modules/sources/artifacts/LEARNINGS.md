# Artifacts — learnings

## An artifact is a bundle of files, not one file

The first design held one file per Markdown or HTML artifact and told HTML to inline everything.
Steve corrected it: a Markdown document refers to images generated next to it, and an HTML page
loads images and other assets beside it. Every version is now a small tree of files named by
relative path, with one entry the type decides (`index.md`, `index.html`, or the first file for
the single-file and series types). All of a version's files are served under one URL prefix, so
relative references resolve without rewriting. Single-file types are bundles of one file.

## Versions are patches over the last one, and content is stored once

A new version starts from the latest version's files, adds or replaces paths, removes paths, or
starts over with `replaceAll`. Content is stored once per SHA-256, so a file a version keeps is
never sent or stored again, and the same picture in two artifacts is one file on disk. Manifests
are always in path order, which also orders an image series; agents number frames to choose it.

## A file's media type comes from its path

Uploads carry no name or media type. The daemon decides a file's type from its path's extension,
`application/octet-stream` when unknown, so what a client is served always agrees with the path a
reference uses. Markdown and HTML entries must be UTF-8; every upload records whether it is, so
that is checked when the upload is placed, not while it streams.

## Paths cannot leave the artifact, and serving matches the manifest exactly

Paths are validated segment by segment (`.`, `..`, empty segments, `\`, and control characters are
refused), and a file is served only when its decoded path is exactly a path in the version's
manifest. The filesystem location always comes from the digest, never from the requested path, so
traversal has nothing to reach.

## Uploads are owned before their bytes exist

An upload row and the durable call that removes it commit before any byte is written, so an
interrupted upload is still removed. Creating and changing an artifact only place uploads that
already hold stored content, inside one transaction, so those operations stay ordinary
transactional work. An expiring upload removes its content only when no version file and no other
upload holds the same digest, checked in the same transaction that deletes the row.

## Deletion is a tombstone

Deleting keeps the record readable, stops serving versions and files, and refuses later changes;
content stays on disk. That matches the API's rule that durable data is never erased and lets
every client learn of the deletion by ID. Deletion is final, so `delete_artifact` is always
reviewed in Auto.

## Where an artifact was made is found by walking up the agent tree

An agent's source is decided by walking from the acting agent through its parents: the first agent
that is a bot's or a task's, or belongs to a workspace or a project root, names the place, and the
acting agent stays the source's `agentId`. A conversation that belongs to none of them is an
`agent` source. A project's root workspace has the project's own ID, so it reads as the project.
