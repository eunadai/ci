// Where the base already has the given identifiers: in file contents (`git grep`) and in path segments
// (`git ls-tree`). It runs git in `cwd`, the project's checkout.
import { spawnSync } from "node:child_process"
import { type BaseHit, excludePathspecs, parseGrep } from "./extract.js"

const git = (cwd: string | undefined, args: ReadonlyArray<string>): { readonly status: number | null; readonly stdout: string; readonly stderr: string } =>
  spawnSync("git", ["-c", "core.quotePath=false", ...args], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })

// `exclude` are the globs whose files never make an identifier legacy (`legacyIgnore`). The grep skips
// them, so a big data file is never read; path segments are left to the caller's filter.
export const baseHits = (
  rev: string,
  identifiers: ReadonlyArray<string>,
  exclude: ReadonlyArray<string>,
  cwd?: string,
): ReadonlyArray<BaseHit> => {
  const grep = git(cwd, ["grep", "-I", "-o", "-w", "-F", ...identifiers.flatMap((i) => ["-e", i]), rev, "--", ...excludePathspecs(exclude)])
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep: ${grep.stderr.trim()}`)
  const tree = git(cwd, ["ls-tree", "-r", "--name-only", rev])
  if (tree.status !== 0) throw new Error(`git ls-tree: ${tree.stderr.trim()}`)
  const hits = [...parseGrep(grep.stdout, rev)]
  for (const path of tree.stdout.split("\n")) {
    for (const segment of path.split("/")) hits.push({ identifier: segment.replace(/\..*$/, ""), file: path })
  }
  const wanted = new Set(identifiers)
  return hits.filter((h) => wanted.has(h.identifier))
}
