// `local-checks install` (src/local/install.ts): it does nothing on CI, outside the root of a git work
// tree or in a folder the project excludes, and on a development clone it runs the setup and wires the
// pre-push hook without touching a hooks path or a hook someone else owns. Real git, temp folders.
import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HOOK, install, type InstallContext } from "../src/local/install.js"
import { expandPath } from "../src/local/project.js"

// No user or system git config: a global core.hooksPath would change what install does.
process.env.GIT_CONFIG_GLOBAL = "/dev/null"
process.env.GIT_CONFIG_NOSYSTEM = "1"
const gitEnv = process.env
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8" }).trim()

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "local-install-")))
const clone = (pkg?: unknown) => {
  const root = temp()
  git(root, "init", "-q", "-b", "main")
  if (pkg !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
  return root
}
const hookFile = (root: string) => join(git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"), "hooks", "pre-push")

const run = (cwd: string, env: NodeJS.ProcessEnv = {}, setup: () => number = () => 0) => {
  const lines: Array<string> = []
  let setups = 0
  const ctx: InstallContext = {
    cwd,
    env,
    home: "/home/nobody",
    setup: () => {
      setups++
      return setup()
    },
    log: (line) => lines.push(line),
  }
  install(ctx)
  return { lines, setups }
}

describe("local-checks install: quando não faz nada", () => {
  it("no CI, não roda o setup nem liga o hook", () => {
    const root = clone()
    for (const CI of ["true", "1"]) {
      const r = run(root, { CI })
      expect(r.setups).toBe(0)
      expect(r.lines).toEqual(["local-checks install: nada a fazer (CI)."])
    }
    expect(existsSync(hookFile(root))).toBe(false)
  })

  it("CI vazio, 0 ou false não é CI", () => {
    for (const CI of ["", "0", "false"]) expect(run(clone(), { CI }).setups).toBe(1)
  })

  it("fora de um work tree git (um git archive, por exemplo)", () => {
    const r = run(temp())
    expect(r.setups).toBe(0)
    expect(r.lines).toEqual(["local-checks install: nada a fazer (fora de um work tree git)."])
  })

  it("numa subpasta do work tree (um pacote dentro de node_modules, por exemplo)", () => {
    const root = clone()
    const sub = join(root, "node_modules", "pacote")
    mkdirSync(sub, { recursive: true })
    const r = run(sub)
    expect(r.setups).toBe(0)
    expect(r.lines).toEqual(["local-checks install: nada a fazer (não é a raiz do work tree git)."])
    expect(existsSync(hookFile(root))).toBe(false)
  })

  it("numa pasta do skipInstallIn: variável de ambiente e ~", () => {
    const root = clone({ localChecks: { skipInstallIn: ["$TOOL_HOME", "$UNSET_VAR", "~/.tool"] } })
    const byVariable = run(root, { TOOL_HOME: root })
    expect(byVariable.setups).toBe(0)
    expect(byVariable.lines).toEqual(["local-checks install: nada a fazer (pasta em localChecks.skipInstallIn ($TOOL_HOME))."])
    // A parent folder of the clone counts too; an unset variable is dropped.
    expect(run(root, { TOOL_HOME: join(root, "..") }).setups).toBe(0)
    expect(run(root, {}).setups).toBe(1)
  })

  it("com o localChecks inválido, só avisa e não faz nada", () => {
    const root = clone({ localChecks: { skipInstalIn: [] } })
    const r = run(root)
    expect(r.setups).toBe(0)
    expect(r.lines[0]).toContain(`nada a fazer («localChecks» inválido em ${join(root, "package.json")}`)
  })
})

describe("local-checks install: num clone de desenvolvimento", () => {
  it("roda o setup e liga o pre-push na pasta de hooks do git, sem mexer no core.hooksPath", () => {
    const root = clone()
    const r = run(root)
    expect(r.setups).toBe(1)
    const file = hookFile(root)
    expect(readFileSync(file, "utf8")).toBe(HOOK)
    expect(statSync(file).mode & 0o111).toBe(0o111)
    expect(r.lines).toEqual([`local-checks install: pre-push ligado em ${file}.`])
    expect(() => git(root, "config", "--get", "core.hooksPath")).toThrow()
    // Again: nothing to say, nothing changes.
    expect(run(root).lines).toEqual([])
  })

  it("um worktree ligado usa o mesmo hook do clone", () => {
    const root = clone()
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c")
    const wt = join(temp(), "wt")
    git(root, "worktree", "add", "-q", wt)
    run(wt)
    expect(readFileSync(hookFile(root), "utf8")).toBe(HOOK)
    expect(hookFile(wt)).toBe(hookFile(root))
  })

  it("reescreve um hook antigo nosso", () => {
    const root = clone()
    run(root)
    const file = hookFile(root)
    writeFileSync(file, HOOK.replace("exec", "# old\nexec"))
    run(root)
    expect(readFileSync(file, "utf8")).toBe(HOOK)
  })

  it("um pre-push de outra ferramenta fica como está, com aviso", () => {
    const root = clone()
    const file = hookFile(root)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "#!/bin/sh\nexit 0\n")
    const r = run(root)
    expect(readFileSync(file, "utf8")).toBe("#!/bin/sh\nexit 0\n")
    expect(r.lines).toEqual([
      `local-checks install: já existe um pre-push em ${file}, que fica como está: o push não é conferido. Chame «node_modules/.bin/local-checks pre-push "$@"» nele.`,
    ])
  })

  it("um core.hooksPath já escolhido fica como está; com um pre-push que chama o check, sem aviso", () => {
    const root = clone()
    git(root, "config", "core.hooksPath", ".githooks")
    const r = run(root)
    expect(git(root, "config", "--get", "core.hooksPath")).toBe(".githooks")
    expect(existsSync(hookFile(root))).toBe(false)
    expect(r.lines[0]).toContain("local-checks install: o core.hooksPath é «.githooks», e ele fica como está")

    mkdirSync(join(root, ".githooks"))
    writeFileSync(join(root, ".githooks", "pre-push"), '#!/bin/sh\nexec node_modules/.bin/local-checks pre-push "$@"\n')
    expect(run(root).lines).toEqual([])
  })

  it("sem rede (o setup falha ou lança), só avisa e liga o hook do mesmo jeito", () => {
    for (const setup of [() => 1, () => { throw new Error("npm ci: ENOTFOUND") }]) {
      const root = clone()
      const r = run(root, {}, setup)
      expect(r.lines).toContain("local-checks install: o setup do cspell não terminou (sem rede?). O identifiers não roda até «local-checks setup» funcionar.")
      expect(readFileSync(hookFile(root), "utf8")).toBe(HOOK)
    }
  })
})

describe("expandPath", () => {
  it("~, $VAR com sufixo, variável vazia e caminho relativo", () => {
    expect(expandPath("~/.canvas", "/r", {}, "/home/u")).toBe("/home/u/.canvas")
    expect(expandPath("$ORIGIN/sub", "/r", { ORIGIN: "/opt/o" })).toBe("/opt/o/sub")
    expect(expandPath("$ORIGIN", "/r", { ORIGIN: "" })).toBeUndefined()
    expect(expandPath("build", "/r", {})).toBe("/r/build")
  })
})
