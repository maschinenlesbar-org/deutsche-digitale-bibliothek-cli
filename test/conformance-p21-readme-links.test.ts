// Conformance test P21 (follow-up round 2026-10-06): README.md ships in the npm tarball and
// is shown on npmjs.com, so every relative link in it must point at a file the package
// ships; anything else 404s there and must be an absolute GitHub URL instead. "Shipped" is
// read from package.json `files` (plain paths and directory prefixes; `!` negations are not
// inclusions), plus what npm always packs (README*, LICENSE*/LICENCE*, package.json).
// Dependency-free: no `npm pack` here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const readme = readFileSync(new URL("README.md", ROOT), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as { files?: string[] };

/** Relative link targets in README.md: inline `](target)` and reference `[id]: target`. */
function relativeTargets(markdown: string): string[] {
  const found: string[] = [];
  for (const m of markdown.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g)) found.push(m[1]!);
  for (const m of markdown.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)) found.push(m[1]!);
  return found.filter((t) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(t));
}

function shipped(target: string): boolean {
  const path = decodeURI(target.replace(/[#?].*$/, "")).replace(/^\.\//, "").replace(/\/$/, "");
  if (path === "package.json" || /^(?:README|LICEN[CS]E)(?:\.[^/]*)?$/i.test(path)) return true;
  return (pkg.files ?? [])
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .some((entry) => path === entry || path.startsWith(`${entry}/`));
}

test("P21: every relative README link points at a file the npm package ships", () => {
  const broken = relativeTargets(readme).filter((t) => !shipped(t));
  assert.deepEqual(
    broken,
    [],
    `README.md links to files the npm package does not ship (they 404 on npmjs.com): ${broken.join(", ")}. ` +
      "Make each an absolute https://github.com/maschinenlesbar-org/<repo>/blob/main/<path> URL " +
      "(keep any #anchor), or ship the file.",
  );
});

test("P21: the link check itself recognises shipped and unshipped targets", () => {
  assert.deepEqual(relativeTargets("[a](Usage.md#x) [b](https://x.example) [c](#top)\n[d]: GLOSSARY.md"), [
    "Usage.md#x",
    "GLOSSARY.md",
  ]);
  assert.equal(shipped("README.md"), true);
  assert.equal(shipped("LICENSE"), true);
  assert.equal(shipped("package.json"), true);
  assert.equal(shipped("test/does-not-ship.ts"), false);
});
