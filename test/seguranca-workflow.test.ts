import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stepScript } from "./workflow-step.js"

const bash = existsSync("/opt/homebrew/bin/bash") ? "/opt/homebrew/bin/bash" : "bash"
const bashMajor = Number(execFileSync(bash, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).trim())

// The run scripts of the tool steps, read as text. Actions runs `run:` with `bash -e`, so a
// script that records the tool's exit code must turn -e off itself: otherwise a tool that exits
// non-zero because it found something kills the step before `echo $?`, and the later tools skip.
describe("seguranca.yml", () => {
  it("cada passo de ferramenta desliga o -e antes de rodar e grava o exit", () => {
    const violacoes = ["OSV-Scanner", "gitleaks", "Semgrep"].flatMap((nome) => {
      const run = stepScript("seguranca.yml", nome)
      return [
        ...(run.split("\n")[0]?.trim() === "set +e -uo pipefail" ? [] : [`${nome}: não começa com «set +e -uo pipefail»`]),
        ...(/echo \$\? > "\$out\/[a-z-]+\.exit"/.test(run) ? [] : [`${nome}: não grava o exit em $out/<nome>.exit`]),
      ]
    })
    expect(violacoes).toEqual([])
  })

  it("o Semgrep instala com hash, do requirements deste repo", () => {
    const passo = stepScript("seguranca.yml", "Instalar Semgrep")
    expect(passo).toContain("--require-hashes")
    expect(passo).toContain("-r .seguranca-ci/dist/semgrep-requirements.txt")
    const req = readFileSync(new URL("../dist/semgrep-requirements.txt", import.meta.url), "utf8")
    expect(req).toMatch(/^semgrep==\d+\.\d+\.\d+ \\$/m)
  })

  // Contract: the flag the workflow promises callers.
  it("os dois scans do OSV leem lockfile mesmo coberto pelo .gitignore", () => {
    const run = stepScript("seguranca.yml", "OSV-Scanner")
    expect(run.match(/scan source -r --no-ignore /g)?.length).toBe(2)
  })
})

// Edge integration: the "Preparar o diff" script against a real git repo. It uses `mapfile`, so it
// needs bash 4+ (macOS ships 3.2; CI runs it).
describe("seguranca.yml, passo Preparar o diff", () => {
  const prepare = (base: Record<string, string>, pr: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "seguranca-diff-"))
    const env = {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    }
    for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name]
    const repo = join(root, "repo")
    mkdirSync(repo)
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    const commit = (files: Record<string, string>, msg: string) => {
      for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text)
      git("add", "-A")
      git("commit", "-qm", msg)
    }
    git("init", "-q", "-b", "main")
    commit({ "a.txt": "1", ...base }, "base")
    const baseSha = git("rev-parse", "HEAD")
    commit(pr, "pr")
    const headSha = git("rev-parse", "HEAD")
    git("checkout", "-q", "--detach", headSha)
    const temp = join(root, "runner")
    mkdirSync(join(temp, "seguranca", "supressao"), { recursive: true })
    execFileSync(bash, ["-eo", "pipefail", "-c", stepScript("seguranca.yml", "Preparar o diff")], {
      cwd: repo,
      encoding: "utf8",
      env: { ...env, BASE: baseSha, HEAD: headSha, CONFIGS: "p/default", RUNNER_TEMP: temp, GITHUB_OUTPUT: join(root, "out") },
    })
    return repo
  }

  it.skipIf(bashMajor < 4)("um .gitleaksignore que o PR cria não fica na árvore", () => {
    const repo = prepare({}, { ".gitleaksignore": "abc:cred.js:github-pat:2\n" })
    expect(existsSync(join(repo, ".gitleaksignore"))).toBe(false)
  })

  it.skipIf(bashMajor < 4)("um .gitleaksignore que o PR altera volta ao da base", () => {
    const repo = prepare({ ".gitleaksignore": "aaa\n" }, { ".gitleaksignore": "aaa\nbbb\n" })
    expect(readFileSync(join(repo, ".gitleaksignore"), "utf8")).toBe("aaa\n")
  })
})
