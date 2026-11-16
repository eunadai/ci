// Edge integration: scripts/repo-sync.sh against real git repositories in a temp folder. The cases
// are the ones a sync script gets wrong silently: a branch left behind, or work in progress lost.
import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../scripts/repo-sync.sh", import.meta.url))

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "repo-sync-"))
  const env = {
    ...process.env,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    REPO_SYNC_CONFIG: join(root, "repos"),
    REPO_SYNC_LOG: join(root, "sync.log"),
  }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text)
    git(cwd, "add", file)
    git(cwd, "commit", "-qm", `${file}: ${text}`)
  }

  // origin with main and feature; "local" is the clone being synced; "upstream" pushes new work.
  const origin = join(root, "origin.git")
  git(root, "init", "-q", "--bare", "-b", "main", origin)
  const upstream = join(root, "upstream")
  git(root, "clone", "-q", origin, upstream)
  commit(upstream, "a.txt", "1")
  git(upstream, "push", "-q", "origin", "main")
  git(upstream, "push", "-q", "origin", "main:feature", "main:diverged", "main:in-worktree")
  const code = join(root, "code")
  mkdirSync(code)
  const local = join(code, "local")
  git(root, "clone", "-q", origin, local)
  for (const b of ["feature", "diverged", "in-worktree"]) git(local, "branch", "-q", b, `origin/${b}`)
  mkdirSync(join(code, "not-a-repo"))
  writeFileSync(env.REPO_SYNC_CONFIG, `# all clones\n${code}/*\n`)

  const advance = (...branches: string[]) => {
    for (const b of branches) {
      git(upstream, "switch", "-q", "-C", b, "origin/main")
      commit(upstream, `${b}.txt`, "new")
      git(upstream, "push", "-q", "-f", "origin", b)
    }
    git(upstream, "switch", "-q", "main")
  }
  const sync = (extra: Record<string, string> = {}) =>
    execFileSync("bash", [script], { env: { ...env, ...extra }, encoding: "utf8" })
  const tip = (cwd: string, ref: string) => git(cwd, "rev-parse", ref)
  const log = () => readFileSync(env.REPO_SYNC_LOG, "utf8")
  return { env, root, code, local, git, commit, advance, sync, tip, log }
}

describe("repo-sync.sh", () => {
  it("fast-forwards every branch that is only behind, checked out or not", () => {
    const t = setup()
    t.advance("main", "feature")
    t.sync()
    expect(t.tip(t.local, "main")).toBe(t.tip(t.local, "origin/main"))
    expect(t.tip(t.local, "feature")).toBe(t.tip(t.local, "origin/feature"))
    expect(readFileSync(join(t.local, "main.txt"), "utf8")).toBe("new")
  })

  it("leaves work in progress as it is and logs each skip once", () => {
    const t = setup()
    // uncommitted edit to a file the update changes, a local commit, a branch open in a worktree
    writeFileSync(join(t.local, "main.txt"), "my edit")
    t.git(t.local, "switch", "-q", "diverged")
    t.commit(t.local, "mine.txt", "local work")
    t.git(t.local, "switch", "-q", "main")
    // the worktree sits where the config's glob also matches it: it must not be synced twice
    t.git(t.local, "worktree", "add", "-q", join(t.code, "wt"), "in-worktree")
    t.advance("main", "diverged", "in-worktree")
    const before = ["main", "diverged", "in-worktree"].map((b) => t.tip(t.local, b))

    t.sync()
    t.sync()

    expect(["main", "diverged", "in-worktree"].map((b) => t.tip(t.local, b))).toEqual(before)
    expect(readFileSync(join(t.local, "main.txt"), "utf8")).toBe("my edit")
    const skips = t.log().split("\n").filter((l) => l.includes(" SKIP "))
    expect(skips).toHaveLength(3)
    expect(skips.join("\n")).toMatch(/ main: uncommitted changes in the way: main\.txt/)
    expect(skips.join("\n")).toMatch(/ diverged: 1 local commit\(s\)/)
    expect(skips.join("\n")).toMatch(/ in-worktree: checked out in another worktree/)
  })

  it("brings in a new push on the next quick run, and retries a skip on the next full pass", () => {
    const t = setup()
    const quick = { REPO_SYNC_FULL_EVERY: "3600" }
    t.sync(quick) // first run is a full pass and records where the remote points
    t.advance("feature")
    execFileSync("bash", [script, "--dry-run"], { env: { ...t.env, ...quick } }) // must not hide the push
    t.sync(quick)
    expect(t.tip(t.local, "feature")).toBe(t.tip(t.local, "origin/feature"))

    writeFileSync(join(t.local, "main.txt"), "my edit")
    t.advance("main")
    t.sync(quick)
    const behind = t.tip(t.local, "main")
    expect(behind).not.toBe(t.tip(t.local, "origin/main"))
    execFileSync("rm", [join(t.local, "main.txt")])
    t.sync(quick) // remote unchanged: a quick run does not look again
    expect(t.tip(t.local, "main")).toBe(behind)
    t.sync({ REPO_SYNC_FULL_EVERY: "0" })
    expect(t.tip(t.local, "main")).toBe(t.tip(t.local, "origin/main"))
  })

  it("touches no branch while a rebase is in progress", () => {
    const t = setup()
    t.advance("main", "feature")
    const before = [t.tip(t.local, "main"), t.tip(t.local, "feature")]
    mkdirSync(join(t.local, ".git", "rebase-merge"))
    t.sync()
    expect([t.tip(t.local, "main"), t.tip(t.local, "feature")]).toEqual(before)
    expect(t.log()).toMatch(/SKIP .* \*: rebase, merge, cherry-pick or bisect in progress/)
  })
})
