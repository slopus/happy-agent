/**
 * The standard components a page loads last with `<script src="/api/v1/components.js"></script>`:
 * `<happy-diff>`, `<happy-code>`, `<happy-files>`, `<happy-chart>`, and `<happy-diagram>`.
 *
 * Each element reads what it shows from the page itself, from a file of the artifact named by
 * `src` or from a `<script>` child, so a page needs no script of its own to use them. A page's
 * script may also set an element's `source` property, which redraws it. Elements render into
 * the light DOM, styled by `/api/v1/style.css`, so a page restyles them in its own stylesheet.
 * Diffs and code are drawn by the renderer the page's host provides at `code.js` beside this
 * script, which Happy Desktop serves so they look as its own do, and plainly where there is none.
 * The diagram renderer is large and loaded only when a page holds a `<happy-diagram>`, from
 * `diagrams.js` beside this script. Like the SDK this is plain browser script served by the
 * daemon, so it upgrades with the agent.
 */
export const ARTIFACT_COMPONENTS_SCRIPT = String.raw`/* Happy standard components, served by Happy Agent. */
(function (global) {
    "use strict";
    var doc = global.document;
    if (!doc || !global.customElements || global.customElements.get("happy-diff")) return;

    var SVG_NS = "http://www.w3.org/2000/svg";
    var BASE = (function () {
        try {
            var current = doc.currentScript && doc.currentScript.src;
            return current ? new URL(".", current).href : new URL("/api/v1/", global.location.href).href;
        } catch (error) { return "/api/v1/"; }
    })();

    function node(tag, className, text) {
        var element = doc.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = String(text);
        return element;
    }

    function svgNode(tag, attributes) {
        var element = doc.createElementNS(SVG_NS, tag);
        for (var name in attributes) {
            if (Object.prototype.hasOwnProperty.call(attributes, name)) element.setAttribute(name, String(attributes[name]));
        }
        return element;
    }

    function failure(message) {
        return node("div", "happy-error", message);
    }

    function countsNode(added, removed) {
        var span = node("span", "happy-counts");
        if (added) span.appendChild(node("span", "happy-added", "+" + added));
        if (added && removed) span.appendChild(doc.createTextNode(" "));
        if (removed) span.appendChild(node("span", "happy-removed", "\u2212" + removed));
        return span;
    }

    var STATUS_WORDS = { added: "new", deleted: "deleted", renamed: "renamed", modified: "" };
    var STATUS_LETTERS = { added: "A", deleted: "D", renamed: "R", modified: "M" };

    function statusOf(value) {
        return value === "added" || value === "deleted" || value === "renamed" ? value : "modified";
    }

    /**
     * The base of every element. It reads its source once the page has been parsed, so an element
     * sees its children wherever the script is loaded, keeps an inline source after replacing its
     * children with what it draws, and redraws when an attribute or its source property changes.
     */
    class HappyElement extends HTMLElement {
        constructor() {
            super();
            this._source = undefined;
            this._fromProperty = false;
            this._inline = null;
            this._token = 0;
            this._started = false;
        }

        connectedCallback() {
            if (this._started) return;
            var self = this;
            if (doc.readyState === "loading") {
                doc.addEventListener("DOMContentLoaded", function () { self._start(); }, { once: true });
            } else {
                this._start();
            }
        }

        attributeChangedCallback() {
            if (this._started) this._draw();
        }

        get source() { return this._source; }
        set source(value) {
            this._source = value;
            this._fromProperty = true;
            if (this._started) this._draw();
        }

        _start() {
            if (this._started) return;
            this._started = true;
            if (!this._fromProperty) this._inline = this._readInline();
            this._draw();
        }

        _readInline() {
            var types = this.constructor.inlineTypes;
            for (var i = 0; i < this.children.length; i++) {
                var child = this.children[i];
                var type = (child.getAttribute("type") || "").toLowerCase();
                if (child.tagName === "SCRIPT" && types.indexOf(type) >= 0) {
                    return { type: type, text: child.textContent || "" };
                }
            }
            return null;
        }

        _load() {
            if (this._fromProperty) return Promise.resolve({ type: "property", value: this._source });
            var src = this.getAttribute("src");
            if (src) {
                return fetch(new URL(src, global.location.href).href).then(function (response) {
                    if (!response.ok) throw new Error("Could not read " + src + " (" + response.status + ").");
                    return response.text();
                }).then(function (text) { return { type: "src", text: text }; });
            }
            if (this._inline) return Promise.resolve(this._inline);
            return Promise.reject(new Error("Nothing to show: give <" + this.localName + "> a src or a <script> child."));
        }

        _draw() {
            var token = ++this._token;
            var self = this;
            this.setAttribute("aria-busy", "true");
            this._load().then(function (input) {
                if (token !== self._token) return;
                return Promise.resolve(self.render(input)).then(function (content) {
                    if (token !== self._token) return;
                    self.replaceChildren(content);
                });
            }).catch(function (error) {
                if (token !== self._token) return;
                self.replaceChildren(failure(error && error.message ? error.message : String(error)));
                if (global.console) global.console.warn("<" + self.localName + ">", error);
            }).then(function () {
                if (token === self._token) self.removeAttribute("aria-busy");
            });
        }
    }

    function parseJson(text, what) {
        try { return JSON.parse(text); } catch (error) { throw new Error(what + " is not valid JSON: " + error.message); }
    }

    var scripts = {};

    /** A large script beside this one, loaded once and only when a page needs it, by the global it sets. */
    function loadScript(file, name, what) {
        if (scripts[file]) return scripts[file];
        scripts[file] = new Promise(function (resolve, reject) {
            if (global[name]) { resolve(global[name]); return; }
            var script = doc.createElement("script");
            script.src = BASE + file;
            script.onload = function () {
                if (global[name]) resolve(global[name]);
                else reject(new Error("The " + what + " did not load."));
            };
            script.onerror = function () {
                scripts[file] = null;
                reject(new Error("The " + what + " could not be loaded."));
            };
            doc.head.appendChild(script);
        });
        return scripts[file];
    }

    // Diffs.

    function diffPath(raw) {
        var value = raw.replace(/\t.*$/, "");
        if (value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
            try { value = JSON.parse(value); } catch (error) { value = value.slice(1, -1); }
        }
        if (value === "/dev/null") return null;
        return value.replace(/^[ab]\//, "");
    }

    /** Parse a unified diff, as 'git diff' or 'diff -u' write it, into files of hunks. */
    function parseDiff(text) {
        var files = [];
        var file = null;
        var hunk = null;
        var oldNumber = 0;
        var newNumber = 0;
        var lines = text.split(/\r?\n/);
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        function start() {
            file = { oldPath: undefined, newPath: undefined, status: null, binary: false, hunks: [], added: 0, removed: 0 };
            files.push(file);
            hunk = null;
        }
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (hunk !== null && (hunk.oldLeft > 0 || hunk.newLeft > 0)) {
                var sign = line.charAt(0);
                if (sign === " " || line === "") {
                    hunk.lines.push({ kind: "context", oldNumber: oldNumber++, newNumber: newNumber++, text: line.slice(1) });
                    hunk.oldLeft--; hunk.newLeft--;
                    continue;
                }
                if (sign === "-") {
                    hunk.lines.push({ kind: "del", oldNumber: oldNumber++, newNumber: null, text: line.slice(1) });
                    hunk.oldLeft--; file.removed++;
                    continue;
                }
                if (sign === "+") {
                    hunk.lines.push({ kind: "add", oldNumber: null, newNumber: newNumber++, text: line.slice(1) });
                    hunk.newLeft--; file.added++;
                    continue;
                }
                if (sign === "\\") continue;
                hunk = null;
            }
            if (line.charAt(0) === "\\") continue;
            if (line.indexOf("diff --git ") === 0) {
                start();
                var names = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line);
                if (names) { file.oldPath = names[1]; file.newPath = names[2]; }
                continue;
            }
            var header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(line);
            if (header) {
                if (file === null) start();
                oldNumber = Number(header[1]);
                newNumber = Number(header[3]);
                hunk = {
                    oldStart: oldNumber,
                    newStart: newNumber,
                    oldCount: header[2] === undefined ? 1 : Number(header[2]),
                    newCount: header[4] === undefined ? 1 : Number(header[4]),
                    oldLeft: header[2] === undefined ? 1 : Number(header[2]),
                    newLeft: header[4] === undefined ? 1 : Number(header[4]),
                    section: header[5] || "",
                    lines: [],
                };
                file.hunks.push(hunk);
                continue;
            }
            if (line.indexOf("--- ") === 0 && i + 1 < lines.length && lines[i + 1].indexOf("+++ ") === 0) {
                if (file === null || file.hunks.length > 0 || file.binary) start();
                file.oldPath = diffPath(line.slice(4));
                file.newPath = diffPath(lines[i + 1].slice(4));
                i++;
                continue;
            }
            if (file === null) continue;
            if (line.indexOf("new file mode") === 0) file.status = "added";
            else if (line.indexOf("deleted file mode") === 0) file.status = "deleted";
            else if (line.indexOf("rename from ") === 0) { file.status = "renamed"; file.oldPath = line.slice(12); }
            else if (line.indexOf("rename to ") === 0) { file.status = "renamed"; file.newPath = line.slice(10); }
            else if (line.indexOf("Binary files ") === 0 || line.indexOf("GIT binary patch") === 0) file.binary = true;
        }
        return files.map(function (entry) {
            var oldPath = entry.oldPath === undefined ? null : entry.oldPath;
            var newPath = entry.newPath === undefined ? null : entry.newPath;
            var status = entry.status;
            if (status === null) {
                if (oldPath === null && newPath !== null) status = "added";
                else if (newPath === null && oldPath !== null) status = "deleted";
                else if (oldPath !== newPath) status = "renamed";
                else status = "modified";
            }
            if (status === "added") oldPath = null;
            if (status === "deleted") newPath = null;
            return {
                path: newPath !== null ? newPath : oldPath || "",
                oldPath: oldPath,
                status: status,
                binary: entry.binary,
                hunks: entry.hunks,
                added: entry.added,
                removed: entry.removed,
            };
        }).filter(function (entry) { return entry.path !== ""; });
    }

    function parseRange(value) {
        if (!value) return null;
        var match = /^\s*(\d+)\s*(?:[-–:]\s*(\d+))?\s*$/.exec(value);
        if (!match) throw new Error('lines must be a range such as "40-52".');
        var first = Number(match[1]);
        var last = match[2] === undefined ? first : Number(match[2]);
        return first <= last ? { first: first, last: last } : { first: last, last: first };
    }

    /**
     * The hunks of a file trimmed to the lines in range, by the changed file's numbers, each with
     * the start and count of both sides that a hunk header says.
     */
    function hunksInRange(file, range) {
        var useOld = file.status === "deleted";
        var trimmed = [];
        file.hunks.forEach(function (hunk) {
            var next = useOld ? hunk.oldStart : hunk.newStart;
            // The last line of each side before the next one, which is where a side that keeps no
            // line says it is: "-5,0" is after line 5.
            var oldBefore = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
            var newBefore = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
            var kept = [];
            var keptOldBefore = 0;
            var keptNewBefore = 0;
            hunk.lines.forEach(function (line) {
                var number = useOld ? line.oldNumber : line.newNumber;
                var at = number === null ? next : number;
                if (number !== null) next = number + 1;
                if (range === null || (at >= range.first && at <= range.last)) {
                    if (kept.length === 0) { keptOldBefore = oldBefore; keptNewBefore = newBefore; }
                    kept.push(line);
                }
                if (line.oldNumber !== null) oldBefore = line.oldNumber;
                if (line.newNumber !== null) newBefore = line.newNumber;
            });
            if (kept.length === 0) return;
            var oldCount = kept.filter(function (line) { return line.kind !== "add"; }).length;
            var newCount = kept.filter(function (line) { return line.kind !== "del"; }).length;
            trimmed.push({
                section: hunk.section,
                oldStart: oldCount === 0 ? keptOldBefore : keptOldBefore + 1,
                oldCount: oldCount,
                newStart: newCount === 0 ? keptNewBefore : keptNewBefore + 1,
                newCount: newCount,
                lines: kept,
            });
        });
        return trimmed;
    }

    /** One file's hunks as the git patch the renderer reads. */
    function filePatch(file, hunks) {
        var oldPath = file.oldPath === null ? file.path : file.oldPath;
        var lines = ["diff --git a/" + oldPath + " b/" + file.path];
        if (file.status === "added") lines.push("new file mode 100644");
        if (file.status === "deleted") lines.push("deleted file mode 100644");
        if (file.status === "renamed") lines.push("rename from " + oldPath, "rename to " + file.path);
        lines.push(file.status === "added" ? "--- /dev/null" : "--- a/" + oldPath);
        lines.push(file.status === "deleted" ? "+++ /dev/null" : "+++ b/" + file.path);
        hunks.forEach(function (hunk) {
            lines.push("@@ -" + hunk.oldStart + "," + hunk.oldCount + " +" + hunk.newStart + "," + hunk.newCount + " @@" + (hunk.section ? " " + hunk.section : ""));
            hunk.lines.forEach(function (line) {
                lines.push((line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text);
            });
        });
        return lines.join("\n") + "\n";
    }

    // Diffs and code are drawn by the renderer the page's host provides as code.js beside this
    // script, an ES module: Happy Desktop serves the one it draws its own diffs and code with, so a
    // diff in an artifact and the same diff in the desktop look alike. A host without one, the
    // daemon among them, answers 404, and the elements draw plain monospace text instead, with
    // numbered lines and coloured additions and deletions but no highlighting.

    var hostRenderer = null;

    /** The host's code renderer, or null when it has none this script can use. */
    function loadHostRenderer() {
        if (hostRenderer) return hostRenderer;
        hostRenderer = import(BASE + "code.js").then(function (module) {
            if (module && module.version === 1 && typeof module.renderDiff === "function" && typeof module.renderCode === "function") return module;
            return null;
        }, function () { return null; });
        return hostRenderer;
    }

    /** A file's name in a header: the folder faint, then the name, and its status. */
    function fileTitle(path, previousPath, status) {
        var title = node("span", "happy-file-title");
        if (previousPath) {
            var previous = node("span", "happy-file-title-previous");
            previous.appendChild(node("bdi", null, previousPath));
            title.appendChild(previous);
            title.appendChild(node("span", "happy-file-title-arrow", "→"));
        }
        var slash = path.lastIndexOf("/");
        if (slash >= 0) {
            var folder = node("span", "happy-file-title-folder");
            folder.appendChild(node("bdi", null, path.slice(0, slash + 1)));
            title.appendChild(folder);
        }
        title.appendChild(node("span", "happy-file-title-name", path.slice(slash + 1)));
        var word = status ? STATUS_WORDS[status] : "";
        if (word) title.appendChild(node("span", "happy-status happy-status-" + status, word));
        return title;
    }

    function header(title, added, removed) {
        var row = node("div", "happy-code-header");
        row.appendChild(title);
        if (added || removed) row.appendChild(countsNode(added, removed));
        return row;
    }

    /** Numbered monospace lines, each { kind, oldNumber, newNumber, text }, for when there is no renderer. */
    function plainLines(rows, columns) {
        var table = node("table", "happy-lines");
        var body = node("tbody");
        rows.forEach(function (row) {
            var line = node("tr", "happy-line-" + row.kind);
            if (row.kind === "gap") {
                var cell = node("td", "happy-line-gap", row.text);
                cell.colSpan = columns + 1;
                line.appendChild(cell);
                body.appendChild(line);
                return;
            }
            if (columns >= 2) line.appendChild(node("td", "happy-line-number", row.oldNumber === null ? "" : row.oldNumber));
            if (columns >= 1) line.appendChild(node("td", "happy-line-number", row.newNumber === null ? "" : row.newNumber));
            var code = node("td", "happy-line-code");
            if (columns === 2) code.appendChild(node("span", "happy-line-sign", row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""));
            code.appendChild(doc.createTextNode(row.text));
            line.appendChild(code);
            body.appendChild(line);
        });
        table.appendChild(body);
        return table;
    }

    /**
     * The base of the elements the host's code renderer draws. Each part is drawn by the renderer
     * when there is one, and plainly when there is none or it fails, and what the renderer drew is
     * released before drawing again or leaving the page.
     */
    class HappyCodeElement extends HappyElement {
        disconnectedCallback() {
            this._release();
        }

        _release() {
            (this._drawn || []).forEach(function (drawn) {
                try { drawn.dispose(); } catch (error) { /* already gone */ }
            });
            this._drawn = [];
        }

        render(input) {
            var self = this;
            return loadHostRenderer().then(function (renderer) {
                self._release();
                return self.renderParts(input, function (kind, part, plain) {
                    var target = node("div", "happy-code-target");
                    if (renderer === null) {
                        target.appendChild(plain());
                        return Promise.resolve(target);
                    }
                    var drawn = self._drawn;
                    return Promise.resolve().then(function () { return renderer[kind](target, part); }).then(function (result) {
                        if (result && typeof result.dispose === "function") drawn.push(result);
                        return target;
                    }, function (error) {
                        if (global.console) global.console.warn("<" + self.localName + ">", error);
                        target.replaceChildren(plain());
                        return target;
                    });
                });
            });
        }
    }

    class HappyDiff extends HappyCodeElement {
        static get observedAttributes() { return ["src", "path", "lines", "nowrap"]; }
        static get inlineTypes() { return ["text/x-diff", "text/x-patch"]; }

        renderParts(input, draw) {
            var text = input.type === "property" ? String(input.value === undefined || input.value === null ? "" : input.value) : input.text;
            var files = parseDiff(text);
            var path = this.getAttribute("path");
            if (path) {
                files = files.filter(function (file) { return file.path === path || file.oldPath === path; });
                if (files.length === 0) throw new Error("The diff does not change " + path + ".");
            }
            if (files.length === 0) throw new Error("The diff has no changes.");
            var range = parseRange(this.getAttribute("lines"));
            var wrap = !this.hasAttribute("nowrap");
            return Promise.all(files.map(function (file) {
                var section = node("section", "happy-diff-file");
                section.setAttribute("data-path", file.path);
                var previousPath = file.status === "renamed" ? file.oldPath : null;
                var hunks = file.binary ? [] : hunksInRange(file, range);
                if (hunks.length === 0) {
                    section.appendChild(header(fileTitle(file.path, previousPath, file.status), file.added, file.removed));
                    section.appendChild(node("div", "happy-diff-note", file.binary ? "Binary file" : range === null ? "No changed lines" : "No changes in lines " + range.first + "–" + range.last));
                    return section;
                }
                var part = { patch: filePatch(file, hunks), path: file.path, previousPath: previousPath, status: file.status, wrap: wrap };
                return draw("renderDiff", part, function () {
                    var plain = doc.createDocumentFragment();
                    var added = 0;
                    var removed = 0;
                    var rows = [];
                    hunks.forEach(function (hunk, index) {
                        if (index > 0 || hunk.section) rows.push({ kind: "gap", text: index > 0 ? "⋯ " + hunk.section : hunk.section });
                        hunk.lines.forEach(function (line) {
                            if (line.kind === "add") added++;
                            if (line.kind === "del") removed++;
                            rows.push(line);
                        });
                    });
                    plain.appendChild(header(fileTitle(file.path, previousPath, file.status), added, removed));
                    var lines = plainLines(rows, 2);
                    if (!wrap) lines.classList.add("happy-lines-nowrap");
                    plain.appendChild(lines);
                    return plain;
                }).then(function (target) {
                    section.appendChild(target);
                    return section;
                });
            })).then(function (sections) {
                var fragment = doc.createDocumentFragment();
                sections.forEach(function (section) { fragment.appendChild(section); });
                return fragment;
            });
        }
    }

    /** Inline code as written inside the page, without the blank line and indent around it. */
    function dedent(text) {
        var lines = text.replace(/\r\n?/g, "\n").split("\n");
        while (lines.length > 0 && lines[0].trim() === "") lines.shift();
        while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
        var indent = null;
        lines.forEach(function (line) {
            if (line.trim() === "") return;
            var width = /^[ \t]*/.exec(line)[0].length;
            if (indent === null || width < indent) indent = width;
        });
        return lines.map(function (line) { return line.slice(indent || 0); }).join("\n");
    }

    class HappyCode extends HappyCodeElement {
        static get observedAttributes() { return ["src", "path", "language", "lines", "nowrap"]; }
        static get inlineTypes() { return ["text/plain"]; }

        renderParts(input, draw) {
            var text = input.type === "property" ? String(input.value === undefined || input.value === null ? "" : input.value)
                : input.type === "src" ? input.text.replace(/\r\n?/g, "\n").replace(/\n$/, "") : dedent(input.text);
            if (text === "") throw new Error("There is no code to show.");
            var path = this.getAttribute("path");
            var src = this.getAttribute("src");
            var range = parseRange(this.getAttribute("lines"));
            var all = text.split("\n");
            if (range !== null && range.first > all.length) throw new Error("The code has only " + all.length + " lines.");
            if (range !== null) range = { first: range.first, last: Math.min(range.last, all.length) };
            var part = {
                code: text,
                path: path,
                name: path || (src ? src.replace(/[?#].*$/, "") : "snippet"),
                language: this.getAttribute("language"),
                lines: range,
                // Lines are numbered when they are a file's or a range of them, as the desktop
                // numbers a file and leaves a snippet in prose unnumbered.
                lineNumbers: Boolean(src) || range !== null,
                wrap: !this.hasAttribute("nowrap"),
            };
            return draw("renderCode", part, function () {
                var plain = node("div", "happy-code-plain");
                if (path) plain.appendChild(header(fileTitle(path, null, null), 0, 0));
                var first = range === null ? 1 : range.first;
                var shown = range === null ? all : all.slice(range.first - 1, range.last);
                var lines = plainLines(shown.map(function (line, index) {
                    return { kind: "context", oldNumber: null, newNumber: first + index, text: line };
                }), part.lineNumbers ? 1 : 0);
                if (!part.wrap) lines.classList.add("happy-lines-nowrap");
                plain.appendChild(lines);
                return plain;
            });
        }
    }

    // File trees.

    function fileEntries(input) {
        if (input.type === "property") return typeof input.value === "string" ? parseDiff(input.value) : input.value;
        if (input.type === "application/json" || /^\s*\[/.test(input.text)) return parseJson(input.text, "The file list");
        return parseDiff(input.text);
    }

    function buildTree(entries) {
        var root = { folders: {}, files: [] };
        entries.forEach(function (entry) {
            var parts = entry.path.split("/").filter(function (part) { return part !== ""; });
            var folder = root;
            for (var i = 0; i < parts.length - 1; i++) {
                if (!Object.prototype.hasOwnProperty.call(folder.folders, parts[i])) folder.folders[parts[i]] = { folders: {}, files: [] };
                folder = folder.folders[parts[i]];
            }
            folder.files.push({ name: parts[parts.length - 1] || entry.path, entry: entry });
        });
        return root;
    }

    function diffSection(path) {
        var sections = doc.querySelectorAll("happy-diff .happy-diff-file");
        for (var i = 0; i < sections.length; i++) {
            if (sections[i].getAttribute("data-path") === path) return sections[i];
        }
        return null;
    }

    function treeList(folder) {
        var list = node("ul");
        Object.keys(folder.folders).sort().forEach(function (name) {
            var child = folder.folders[name];
            var label = name;
            // A folder holding only one folder reads as one path, such as 'src/app/'.
            while (Object.keys(child.folders).length === 1 && child.files.length === 0) {
                var only = Object.keys(child.folders)[0];
                label += "/" + only;
                child = child.folders[only];
            }
            var item = node("li", "happy-files-folder");
            var row = node("div", "happy-files-row");
            row.appendChild(node("span", "happy-path", label + "/"));
            item.appendChild(row);
            item.appendChild(treeList(child));
            list.appendChild(item);
        });
        folder.files.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }).forEach(function (file) {
            var entry = file.entry;
            var status = entry.status === undefined || entry.status === null ? null : statusOf(entry.status);
            var item = node("li", "happy-files-file");
            var row = node("div", "happy-files-row");
            if (status !== null) {
                var letter = node("span", "happy-status happy-status-" + status, STATUS_LETTERS[status]);
                letter.title = status;
                row.appendChild(letter);
            }
            row.appendChild(node("span", "happy-path", file.name));
            if (entry.added || entry.removed) row.appendChild(countsNode(entry.added, entry.removed));
            row.addEventListener("pointerenter", function () {
                row.classList.toggle("happy-files-link", diffSection(entry.path) !== null);
            });
            row.addEventListener("click", function () {
                var section = diffSection(entry.path);
                if (section) section.scrollIntoView({ block: "start", behavior: "smooth" });
            });
            item.appendChild(row);
            list.appendChild(item);
        });
        return list;
    }

    class HappyFiles extends HappyElement {
        static get observedAttributes() { return ["src"]; }
        static get inlineTypes() { return ["application/json", "text/x-diff", "text/x-patch"]; }

        render(input) {
            var entries = fileEntries(input);
            if (!Array.isArray(entries)) throw new Error("The file list must be an array of { path }.");
            entries = entries.filter(function (entry) { return entry && typeof entry.path === "string" && entry.path !== ""; });
            if (entries.length === 0) throw new Error("There are no files to show.");
            var tree = treeList(buildTree(entries));
            tree.className = "happy-files-tree";
            return tree;
        }
    }

    // Charts.

    function chartData(input) {
        var data = input.type === "property" ? input.value : parseJson(input.text, "The chart");
        if (!data || !Array.isArray(data.labels) || !Array.isArray(data.series) || data.series.length === 0) {
            throw new Error('The chart must be { "labels": [...], "series": [{ "name", "values" }] }.');
        }
        data.series.forEach(function (series, index) {
            if (!series || !Array.isArray(series.values)) throw new Error("Series " + (index + 1) + " has no values.");
        });
        return data;
    }

    function withUnit(text, unit) {
        return unit ? (unit === "%" ? text + "%" : text + " " + unit) : text;
    }

    function formatter(unit, compact) {
        var format = null;
        try {
            // Numbers read in the page's own language, not the viewer's machine's, so a chart in an
            // English page never says "1 тыс.".
            format = new Intl.NumberFormat(document.documentElement.lang || undefined, compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 2 });
        } catch (error) { format = null; }
        return function (value) {
            if (typeof value !== "number" || !isFinite(value)) return "";
            return withUnit(format ? format.format(value) : String(value), unit);
        };
    }

    function color(index) {
        return "var(--happy-chart-" + ((index % 6) + 1) + ")";
    }

    function numbers(data) {
        var values = [];
        data.series.forEach(function (series) {
            series.values.forEach(function (value) { if (typeof value === "number" && isFinite(value)) values.push(value); });
        });
        return values;
    }

    /** Round axis ticks spanning the values and zero. */
    function ticks(min, max) {
        if (min === max) max = min + 1;
        var rough = (max - min) / 4;
        var step = Math.pow(10, Math.floor(Math.log(rough) / Math.LN10));
        var scaled = rough / step;
        step *= scaled > 5 ? 10 : scaled > 2 ? 5 : scaled > 1 ? 2 : 1;
        var values = [];
        for (var value = Math.floor(min / step) * step; value <= Math.ceil(max / step) * step + step / 2; value += step) {
            values.push(Math.round(value / step) * step);
        }
        return values;
    }

    function legend(data) {
        if (data.series.length < 2) return null;
        var row = node("div", "happy-chart-legend");
        data.series.forEach(function (series, index) {
            var key = node("span", "happy-chart-key");
            var swatch = node("span", "happy-chart-swatch");
            swatch.style.background = color(index);
            key.appendChild(swatch);
            key.appendChild(doc.createTextNode(series.name || "Series " + (index + 1)));
            row.appendChild(key);
        });
        return row;
    }

    function textWidth(text) {
        return String(text).length * 6.6 + 4;
    }

    function horizontalBars(data) {
        var format = formatter(data.unit, false);
        var max = Math.max.apply(null, numbers(data).map(Math.abs).concat([0]));
        var rows = node("div", "happy-chart-bars");
        data.labels.forEach(function (label, index) {
            var row = node("div", "happy-chart-bar-row");
            row.appendChild(node("div", "happy-chart-bar-label", label));
            var tracks = node("div", "happy-chart-bar-tracks");
            data.series.forEach(function (series, seriesIndex) {
                var value = series.values[index];
                var share = max > 0 && typeof value === "number" && isFinite(value) ? Math.abs(value) / max : 0;
                var track = node("div", "happy-chart-bar-track");
                var fill = node("div", "happy-chart-bar-fill");
                fill.style.background = color(seriesIndex);
                fill.style.width = "calc((100% - 80px) * " + share + ")";
                fill.title = (series.name ? series.name + ": " : "") + format(value);
                track.appendChild(fill);
                track.appendChild(node("span", "happy-chart-bar-value", format(value)));
                tracks.appendChild(track);
            });
            row.appendChild(tracks);
            rows.appendChild(row);
        });
        return rows;
    }

    function titled(element, text) {
        var title = svgNode("title", {});
        title.textContent = text;
        element.appendChild(title);
        return element;
    }

    function plotChart(data, type, width, height) {
        var format = formatter(data.unit, false);
        var axisFormat = formatter(data.unit, true);
        var values = numbers(data);
        var axis = ticks(Math.min.apply(null, values.concat([0])), Math.max.apply(null, values.concat([0])));
        var low = axis[0];
        var high = axis[axis.length - 1];
        var left = Math.max.apply(null, axis.map(function (tick) { return textWidth(axisFormat(tick)); })) + 8;
        var top = 8;
        var plotWidth = Math.max(40, width - left - 8);
        var plotHeight = Math.max(40, height - top - 24);
        function y(value) { return top + plotHeight - ((value - low) / (high - low)) * plotHeight; }
        var svg = svgNode("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, role: "img" });
        axis.forEach(function (tick) {
            var at = Math.round(y(tick)) + 0.5;
            svg.appendChild(svgNode("line", { class: "happy-chart-grid", x1: left, x2: left + plotWidth, y1: at, y2: at }));
            var label = svgNode("text", { x: left - 8, y: at + 4, "text-anchor": "end" });
            label.textContent = axisFormat(tick);
            svg.appendChild(label);
        });
        var count = data.labels.length;
        var slot = plotWidth / Math.max(1, count);
        function center(index) {
            if (type === "bar") return left + slot * (index + 0.5);
            return count < 2 ? left + plotWidth / 2 : left + (plotWidth * index) / (count - 1);
        }
        var widest = Math.max.apply(null, data.labels.map(textWidth).concat([1]));
        var spacing = type === "bar" ? slot : plotWidth / Math.max(1, count - 1);
        var every = Math.max(1, Math.ceil((widest + 8) / Math.max(1, spacing)));
        data.labels.forEach(function (label, index) {
            if (index % every !== 0) return;
            var anchor = type === "bar" || count < 2 ? "middle" : index === 0 ? "start" : index === count - 1 ? "end" : "middle";
            var text = svgNode("text", { x: center(index), y: top + plotHeight + 18, "text-anchor": anchor });
            text.textContent = label;
            svg.appendChild(text);
        });
        var seriesCount = data.series.length;
        if (type === "bar") {
            var group = Math.min(slot * 0.72, seriesCount * 28);
            var barWidth = Math.max(1, group / seriesCount - (seriesCount > 1 ? 2 : 0));
            var zero = y(Math.max(low, Math.min(0, high)));
            data.series.forEach(function (series, seriesIndex) {
                series.values.forEach(function (value, index) {
                    if (typeof value !== "number" || !isFinite(value) || index >= count) return;
                    var x = center(index) - group / 2 + (group / seriesCount) * seriesIndex;
                    var bar = svgNode("rect", {
                        x: x,
                        y: Math.min(zero, y(value)),
                        width: barWidth,
                        height: Math.max(1, Math.abs(y(value) - zero)),
                        rx: Math.min(2, barWidth / 2),
                        style: "fill: " + color(seriesIndex),
                    });
                    svg.appendChild(titled(bar, data.labels[index] + (series.name ? " · " + series.name : "") + ": " + format(value)));
                });
            });
            return svg;
        }
        data.series.forEach(function (series, seriesIndex) {
            var points = [];
            series.values.forEach(function (value, index) {
                if (typeof value === "number" && isFinite(value) && index < count) points.push({ x: center(index), y: y(value), value: value, index: index });
            });
            if (points.length === 0) return;
            var line = points.map(function (point, index) { return (index === 0 ? "M" : "L") + point.x.toFixed(1) + " " + point.y.toFixed(1); }).join(" ");
            if (type === "area") {
                var base = y(Math.max(low, Math.min(0, high))).toFixed(1);
                var area = line + " L" + points[points.length - 1].x.toFixed(1) + " " + base + " L" + points[0].x.toFixed(1) + " " + base + " Z";
                svg.appendChild(svgNode("path", { d: area, style: "fill: " + color(seriesIndex) + "; fill-opacity: 0.16; stroke: none" }));
            }
            svg.appendChild(svgNode("path", { d: line, style: "fill: none; stroke: " + color(seriesIndex) + "; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round" }));
            if (points.length > 60) return;
            points.forEach(function (point) {
                var dot = svgNode("circle", { cx: point.x, cy: point.y, r: points.length <= 24 ? 3 : 2, style: "fill: " + color(seriesIndex) });
                svg.appendChild(titled(dot, data.labels[point.index] + (series.name ? " · " + series.name : "") + ": " + format(point.value)));
            });
        });
        return svg;
    }

    class HappyChart extends HappyElement {
        static get observedAttributes() { return ["src", "type", "height"]; }
        static get inlineTypes() { return ["application/json"]; }

        connectedCallback() {
            super.connectedCallback();
            if (this._resize || typeof ResizeObserver === "undefined") return;
            var self = this;
            // A chart is drawn at its width, so it redraws when only that changes.
            this._resize = new ResizeObserver(function () {
                if (self._data && Math.floor(self.clientWidth) !== self._width) {
                    try { self.replaceChildren(self._chart(self._data)); } catch (error) { self.replaceChildren(failure(error.message)); }
                }
            });
            this._resize.observe(this);
        }

        disconnectedCallback() {
            if (this._resize) { this._resize.disconnect(); this._resize = null; }
        }

        render(input) {
            this._data = null;
            var data = chartData(input);
            var chart = this._chart(data);
            this._data = data;
            return chart;
        }

        _chart(data) {
            var type = this.getAttribute("type") || "bar";
            if (["bar", "hbar", "line", "area"].indexOf(type) < 0) throw new Error('type must be "bar", "hbar", "line", or "area".');
            var fragment = doc.createDocumentFragment();
            var key = legend(data);
            if (key) fragment.appendChild(key);
            this._width = Math.floor(this.clientWidth);
            if (type === "hbar") {
                fragment.appendChild(horizontalBars(data));
                return fragment;
            }
            fragment.appendChild(plotChart(data, type, this._width || 600, Number(this.getAttribute("height")) || 240));
            return fragment;
        }
    }

    // Diagrams.

    class HappyDiagram extends HappyElement {
        static get observedAttributes() { return ["src"]; }
        static get inlineTypes() { return ["text/x-mermaid", "text/plain"]; }

        render(input) {
            var source = input.type === "property" ? String(input.value === undefined || input.value === null ? "" : input.value) : input.text;
            source = source.replace(/^\s*\n/, "").replace(/\s+$/, "");
            if (source === "") throw new Error("The diagram is empty.");
            return loadScript("diagrams.js", "happyDiagrams", "diagram renderer").then(function (diagrams) {
                var markup;
                try {
                    markup = diagrams.render(source, {
                        accent: "var(--happy-accent)",
                        bg: "var(--happy-diagram-background, transparent)",
                        border: "var(--happy-border)",
                        fg: "var(--happy-text)",
                        font: "Figtree",
                        layerSpacing: 40,
                        line: "var(--happy-faint)",
                        muted: "var(--happy-muted)",
                        nodeSpacing: 24,
                        padding: 8,
                        surface: "var(--happy-surface)",
                        transparent: true,
                    });
                } catch (error) {
                    throw new Error("The diagram could not be drawn: " + (error && error.message ? error.message : String(error)));
                }
                // The renderer imports a web font, which a page never fetches.
                markup = markup.replace(/@import\s+url\([^)]*\);?/gi, "");
                var figure = node("div", "happy-diagram-figure");
                figure.innerHTML = markup;
                var svg = figure.querySelector("svg");
                if (svg) {
                    var box = (svg.getAttribute("viewBox") || "").split(/\s+/);
                    if (box.length === 4) {
                        svg.setAttribute("width", box[2]);
                        svg.removeAttribute("height");
                    }
                    svg.setAttribute("role", "img");
                }
                return figure;
            });
        }
    }

    global.customElements.define("happy-diff", HappyDiff);
    global.customElements.define("happy-code", HappyCode);
    global.customElements.define("happy-files", HappyFiles);
    global.customElements.define("happy-chart", HappyChart);
    global.customElements.define("happy-diagram", HappyDiagram);
})(typeof window !== "undefined" ? window : globalThis);
`;
