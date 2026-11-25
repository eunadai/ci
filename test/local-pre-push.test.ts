// The pre-push hook end to end, through the built bin (dist/local-checks.mjs, which CI keeps in step
// with src/): the README's `prepare` line wires it, and a real `git push` to a bare remote is blocked
// when the gate would fail what is being sent — whatever the checkout's HEAD is. No cspell here, so the
// identifiers check is the "not installed" case: a warning, never a block.
import { describe, expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { HOOK } from "../src/local/install.js"
import { branchesToCheck } from "../src/local/push.js"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "local-checks.mjs")
const README = join(dirname(fileURLToPath(import.meta.url)), "..", "README.md")

// The `prepare` script of the README's recipe, as a project copies it.
const recipe = (): string => {
  const m = /"prepare": "((?:[^"\\]|\\.)*)"/.exec(readFileSync(README, "utf8"))
  if (m === null) throw new Error("README sem o script prepare")
  return JSON.parse(`"${m[1]}"`) as string
}

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "local-pre-push-")))
const NODE_DIR = dirname(process.execPath)

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = {
    PATH: `${NODE_DIR}:/usr/bin:/bin`,
    HOME: temp(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    // An empty folder: cspell is not installed, and `setup` has no lockfile to install from.
    CSPELL_DIR: temp(),
    ...extra,
  }
  for (const [k, v] of Object.entries(e)) if (v === undefined) delete e[k]
  return e
}

// The hook's stdout and stderr both reach the terminal; `out` has the two together.
const sh = (cwd: string, script: string, extra: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync("sh", ["-c", script], { cwd, env: env(extra), encoding: "utf8" })
  return { status: r.status, stderr: r.stderr, out: r.stdout + r.stderr }
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`).join("\n") + "\n"

// A clone of a bare remote whose main has a gate config with a limit of 10 lines, the bin installed
// in node_modules/.bin, `small` (3 lines) and `big` (50 lines) branches, and small checked out.
const project = () => {
  const dir = temp()
  const remote = join(dir, "origin.git")
  const work = join(dir, "work")
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: work, env: env(), encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
    return r.stdout.trim()
  }
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote], { env: env() })
  mkdirSync(work)
  git("init", "-q", "-b", "main")
  git("remote", "add", "origin", remote)
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(work, path)), { recursive: true })
    writeFileSync(join(work, path), text)
  }
  write(".gitignore", "node_modules/\n")
  write(".github/portao.json", JSON.stringify({ tamanho: { limite: 10 } }))
  write("package.json", JSON.stringify({ name: "p", private: true, scripts: { prepare: recipe() } }))
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  git("push", "-q", "origin", "main")
  git("remote", "set-head", "origin", "main")
  for (const [branch, n] of [["big", 50], ["small", 3]] as const) {
    git("switch", "-q", "-c", branch, "main")
    write(`src/${branch}.ts`, lines(n))
    git("add", "-A")
    git("commit", "-q", "-m", branch)
  }
  const binDir = join(work, "node_modules", ".bin")
  mkdirSync(binDir, { recursive: true })
  symlinkSync(BIN, join(binDir, "local-checks"))
  const push = (args: string, extra: NodeJS.ProcessEnv = {}) => sh(work, `git push origin ${args}`, extra)
  const onRemote = (branch: string) =>
    spawnSync("git", ["ls-remote", remote, `refs/heads/${branch}`], { env: env(), encoding: "utf8" }).stdout.trim() !== ""
  return { work, remote, binDir, git, push, onRemote, hook: join(work, ".git", "hooks", "pre-push") }
}

// The project with the hook wired the way the README says: the `prepare` line, run by the package
// manager with node_modules/.bin on the PATH.
const wired = () => {
  const p = project()
  const r = sh(p.work, recipe(), { PATH: `${p.binDir}:${NODE_DIR}:/usr/bin:/bin` })
  expect(r.status).toBe(0)
  expect(readFileSync(p.hook, "utf8")).toBe(HOOK)
  return p
}

describe("a receita do README (script prepare)", () => {
  it("sem as devDependencies (o bin não existe), sai com 0 sem fazer nada", () => {
    const p = project()
    const r = sh(p.work, recipe())
    expect(r.status).toBe(0)
    expect(r.stderr).toBe("")
    expect(existsSync(p.hook)).toBe(false)
  })

  it("no CI, sai com 0 sem ligar o hook", () => {
    const p = project()
    const r = sh(p.work, recipe(), { PATH: `${p.binDir}:${NODE_DIR}:/usr/bin:/bin`, CI: "true" })
    expect(r.status).toBe(0)
    expect(existsSync(p.hook)).toBe(false)
  })

  it("num clone, liga o hook e só avisa que o setup do cspell falhou", () => {
    const p = project()
    const r = sh(p.work, recipe(), { PATH: `${p.binDir}:${NODE_DIR}:/usr/bin:/bin` })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("o setup do cspell não terminou")
    expect(r.stderr).toContain("pre-push ligado em")
  })
})

describe("o pre-push confere o que está sendo enviado, não o HEAD", () => {
  it("barra HEAD:refs/heads/x, sha direto e outra branch acima do limite; deixa passar a pequena", () => {
    const p = wired()
    const big = p.git("rev-parse", "big")

    // On small, a sha and another branch send big: the old hooks, which checked HEAD, let both through.
    const bySha = p.push(`${big}:refs/heads/by-sha`)
    expect(bySha.status).not.toBe(0)
    expect(bySha.out).toContain("O PR soma 50 linhas de lógica, acima do limite de 10.")
    expect(p.onRemote("by-sha")).toBe(false)

    const otherBranch = p.push("big")
    expect(otherBranch.status).not.toBe(0)
    expect(otherBranch.out).toContain("pre-push: big (")
    expect(p.onRemote("big")).toBe(false)

    p.git("switch", "-q", "big")
    const head = p.push("HEAD:refs/heads/x")
    expect(head.status).not.toBe(0)
    expect(head.out).toContain("pre-push: x (")
    expect(p.onRemote("x")).toBe(false)

    // The small branch goes, with a warning that cspell is not installed.
    p.git("switch", "-q", "small")
    const small = p.push("small")
    expect(small.status).toBe(0)
    expect(small.out).toContain("⚠️ **Identificadores em inglês:** não rodou")
    expect(p.onRemote("small")).toBe(true)

    // A push to the remote's path, not its name, uses the default base.
    const byPath = sh(p.work, `git push ${p.remote} small:refs/heads/by-path`)
    expect(byPath.status).toBe(0)
    expect(byPath.out).toContain("Base origin/main")

    // A remote HEAD that points to a pruned branch falls back to the default base too.
    p.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone")
    const dangling = p.push("small:refs/heads/dangling")
    expect(dangling.status).toBe(0)
    expect(dangling.out).toContain("Base origin/main")
  })

  it("deixa passar a remoção de branch e as tags", () => {
    const p = wired()
    expect(p.push("--no-verify big").status).toBe(0)
    const deletion = p.push(":big")
    expect(deletion.status).toBe(0)
    expect(p.onRemote("big")).toBe(false)

    p.git("tag", "v9", "big")
    expect(p.push("v9").status).toBe(0)

    // With no branch to check, an invalid package.json is never read.
    writeFileSync(join(p.work, "package.json"), "{ broken")
    p.git("tag", "v10", "big")
    expect(p.push("v10").status).toBe(0)
    expect(p.push("--no-verify big:refs/heads/gone").status).toBe(0)
    expect(p.push(":gone").status).toBe(0)
    // A branch still reads it, and fails with the reason.
    const branch = p.push("small:refs/heads/after-broken")
    expect(branch.status).not.toBe(0)
    expect(branch.out).toContain("package.json não é JSON válido")
  })

  it("LOCAL_CHECKS_SKIP_SIZE=1 pula a contagem do portão, e o identifiers continua", () => {
    const p = wired()
    const r = p.push("big", { LOCAL_CHECKS_SKIP_SIZE: "1" })
    expect(r.status).toBe(0)
    expect(r.out).toContain("LOCAL_CHECKS_SKIP_SIZE: a contagem do portão foi pulada; o identifiers roda.")
    expect(r.out).toContain("**Identificadores em inglês:**")
    expect(r.out).not.toContain("linhas de lógica")
    // Only "1" skips it.
    expect(p.push("big:refs/heads/big2", { LOCAL_CHECKS_SKIP_SIZE: "0" }).status).not.toBe(0)
  })

  it("num checkout sem o bin, avisa e deixa passar", () => {
    const p = wired()
    rmSync(join(p.binDir, "local-checks"))
    const r = p.push("big")
    expect(r.status).toBe(0)
    expect(r.out).toContain("pre-push: o local-checks não está instalado neste checkout")
  })
})

// The hook is one file for every worktree of a clone, and it calls the bin of the worktree that pushes.
// A worktree whose node_modules still has the v1.10.0 bin (no `pre-push`) must not be blocked by it.
describe("um worktree com o bin antigo (sem o pre-push)", () => {
  // What the v1.10.0 bin does with `pre-push`: it reads the word as a check name, prints this, exits 2.
  const oldBin = (exit: number, message: string) =>
    ["#!/bin/sh", `echo ${JSON.stringify(message)} >&2`, `exit ${exit}`, ""].join("\n")
  const OLD_MESSAGE = "local-checks: check desconhecido: pre-push, origin, /remote\n\nuso: local-checks [identifiers] [portao]"

  // A second worktree of the project, with its own node_modules/.bin/local-checks.
  const secondWorktree = (p: ReturnType<typeof wired>, bin: string) => {
    const wt = join(temp(), "wt")
    p.git("worktree", "add", "-q", wt, "big")
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true })
    const file = join(wt, "node_modules", ".bin", "local-checks")
    writeFileSync(file, bin)
    chmodSync(file, 0o755)
    return { wt, push: (args: string) => sh(wt, `git push origin ${args}`) }
  }

  it("deixa o push passar com aviso, e o worktree novo do mesmo clone continua barrando", () => {
    const p = wired()
    const old = secondWorktree(p, oldBin(2, OLD_MESSAGE))
    expect(existsSync(join(old.wt, ".git"))).toBe(true)
    // One hook for both worktrees.
    expect(sh(old.wt, "git rev-parse --git-path hooks/pre-push").out.trim()).toContain(p.hook.replace(/\/pre-push$/, ""))

    const fromOld = old.push("big")
    expect(fromOld.status).toBe(0)
    expect(fromOld.stderr).toContain("o local-checks deste checkout é antigo e não tem o pre-push")
    expect(fromOld.stderr).toContain("rode o install para ligar o check")
    expect(fromOld.stderr).not.toContain("check desconhecido")
    expect(p.onRemote("big")).toBe(true)

    // The same hook, the new bin, a diff over the limit: blocked.
    const fromNew = p.push("big:refs/heads/big-new")
    expect(fromNew.status).not.toBe(0)
    expect(fromNew.out).toContain("O PR soma 50 linhas de lógica, acima do limite de 10.")
    expect(p.onRemote("big-new")).toBe(false)
  })

  it("qualquer outra falha do bin continua barrando, com a saída e o exit code dele", () => {
    const p = wired()
    for (const [exit, message] of [[2, "local-checks: check desconhecido: portao"], [1, "boom"], [127, "node: not found"]] as const) {
      const wt = secondWorktree(p, oldBin(exit, message))
      const r = wt.push("big:refs/heads/x")
      // git push reports its own code when a hook fails; the bin's output is what shows the cause.
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(message)
      expect(r.stderr).not.toContain("não tem o pre-push")
      expect(p.onRemote("x")).toBe(false)
      p.git("worktree", "remove", "--force", wt.wt)
    }
  })

  it("o bin de verdade da v1.10.0 também passa, e o hook guarda o stdin para o bin novo", () => {
    // Only when this clone has the tag: CI may check out without tags.
    const tag = spawnSync("git", ["show", "v1.10.0:dist/local-checks.mjs"], { cwd: dirname(BIN), encoding: "utf8" })
    if (tag.status !== 0) return
    const p = wired()
    const old = secondWorktree(p, tag.stdout)
    const r = old.push("big:refs/heads/by-v1-10")
    expect(r.status).toBe(0)
    expect(r.stderr).toContain("não tem o pre-push")
    // The probe took no stdin from the new bin: it still read the refs and blocked.
    expect(p.push("big:refs/heads/by-new").status).not.toBe(0)
  })
})

describe("branchesToCheck", () => {
  const zero = "0".repeat(40)
  const a = "a".repeat(40)
  it("uma linha por branch de destino; pula tags, outras refs e remoção", () => {
    const stdin = [
      `HEAD ${a} refs/heads/x ${zero}`,
      `refs/heads/feat ${a} refs/heads/feat ${a}`,
      `${a} ${a} refs/heads/by-sha ${zero}`,
      `refs/tags/v1 ${a} refs/tags/v1 ${zero}`,
      `(delete) ${zero} refs/heads/old ${a}`,
      `refs/notes/x ${a} refs/notes/x ${zero}`,
      "",
    ].join("\n")
    expect(branchesToCheck(stdin)).toEqual([
      { sha: a, branch: "x" },
      { sha: a, branch: "feat" },
      { sha: a, branch: "by-sha" },
    ])
  })
})
