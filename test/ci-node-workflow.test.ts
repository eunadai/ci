import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { stepScript } from "./workflow-step.js"

const workflow = readFileSync(new URL("../.github/workflows/ci-node.yml", import.meta.url), "utf8")

// Runs a step's `run: |` with bash -e in `cwd`, with the runner's files GitHub gives every step.
const runStep = (stepName: string, cwd: string, env: Record<string, string>) => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "ci-node-runner-"))
  const summaryFile = join(runnerTemp, "summary.md")
  const outputFile = join(runnerTemp, "output.txt")
  writeFileSync(summaryFile, "")
  writeFileSync(outputFile, "")
  try {
    const result = spawnSync("bash", ["-e", "-c", stepScript("ci-node.yml", stepName)], {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        RUNNER_TEMP: runnerTemp,
        GITHUB_STEP_SUMMARY: summaryFile,
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
    })
    return {
      status: result.status,
      stdout: result.stdout,
      summary: readFileSync(summaryFile, "utf8"),
      output: readFileSync(outputFile, "utf8"),
    }
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true })
  }
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

// A repository with a base commit on main and a PR branch on top of it.
const pullRequest = (change: (git: (...args: string[]) => string, write: (path: string, text: string) => void) => void) => {
  const root = mkdtempSync(join(tmpdir(), "ci-node-repo-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim()
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  git("init", "-q", "-b", "main")
  write("src/index.ts", "export const one = 1\n")
  write("README.md", "# repo\n")
  git("add", "-A")
  git("commit", "-qm", "base")
  const base = git("rev-parse", "HEAD")
  git("switch", "-q", "-c", "pr")
  change(git, write)
  git("add", "-A")
  git("commit", "-qm", "pr", "--allow-empty")
  return { root, base, head: git("rev-parse", "HEAD") }
}

const docsOnly = (root: string, base: string, head: string, fetchDepth = "0") =>
  runStep("Só documentação?", root, {
    SKIP_DOCS: '["^docs/", "\\\\.md$"]',
    FETCH_DEPTH: fetchDepth,
    BASE_SHA: base,
    HEAD_SHA: head,
  })

describe("ci-node.yml", () => {
  // Contract: the warning callers see when a script name is not one of the fixed steps.
  it("um nome fora de typecheck, lint e test gera aviso e linha no summary", () => {
    const { stdout, summary } = runStep("Scripts", tmpdir(), { SCRIPTS: '["typecheck","build"]' })
    expect(stdout).toContain(
      "::warning title=CI Node::script «build» não é um passo deste workflow (typecheck, lint, test) e não roda aqui: use um job próprio",
    )
    expect(summary).toContain("⚠️ script «build» não é um passo deste workflow (typecheck, lint, test), não roda aqui")
  })

  // Contract: known names stay silent, so existing callers see no change.
  it("só nomes conhecidos: nenhum aviso", () => {
    const { stdout, summary } = runStep("Scripts", tmpdir(), { SCRIPTS: '["typecheck","lint","test"]' })
    expect(stdout).toBe("")
    expect(summary).toBe("")
  })

  // Contract: every new input is off by default, and each step it adds or skips is guarded by it, so a
  // caller that passes none of them runs the same steps as before.
  it("as entradas novas vêm desligadas e cada passo novo depende da sua", () => {
    // The first `default:` after the input's key, under `on.workflow_call.inputs`.
    const defaultOf = (name: string) => {
      const start = workflow.indexOf(`\n      ${name}:\n`)
      expect(start, `entrada «${name}»`).toBeGreaterThan(-1)
      return workflow.slice(start).match(/\n {8}default: (.*)\n/)?.[1]
    }
    expect(defaultOf("fetch-depth")).toBe("1")
    expect(defaultOf("skip-docs")).toBe("'[]'")
    expect(defaultOf("npm-cache")).toBe("false")
    expect(defaultOf("pr-scripts")).toBe("'[]'")
    expect(defaultOf("status-context")).toBe("''")

    const guard = (stepName: string) => workflow.split(`      - name: ${stepName}\n`)[1]?.split("\n").find((l) => l.startsWith("        if: "))
    expect(guard("Só documentação?")).toContain("inputs.skip-docs != '[]'")
    expect(guard("Cache do npm")).toContain("inputs.npm-cache")
    expect(guard("Scripts do PR")).toContain("inputs.pr-scripts != '[]'")
    expect(guard("Status no commit")).toBe("        if: always() && inputs.status-context != ''")
    // The job declares no permissions: a caller without status-context does not grant statuses: write.
    expect(workflow).not.toMatch(/^ {4}permissions:/m)
  })

  // Pure rule: what counts as a docs-only PR.
  describe("skip-docs", () => {
    it("PR só com docs/ e .md: pula, com linha no summary", () => {
      const pr = pullRequest((_, write) => {
        write("docs/guia.md", "texto\n")
        write("docs/diagrama.svg", "<svg/>\n")
        write("README.md", "# repo, agora com mais texto\n")
      })
      const { status, output, summary } = docsOnly(pr.root, pr.base, pr.head)
      expect(status).toBe(0)
      expect(output).toBe("so_docs=true\n")
      expect(summary).toBe("PR só de documentação: instalação e testes pulados.\n")
    })

    it("PR com código: não pula", () => {
      const pr = pullRequest((_, write) => {
        write("docs/guia.md", "texto\n")
        write("src/index.ts", "export const one = 2\n")
      })
      const { status, output, summary } = docsOnly(pr.root, pr.base, pr.head)
      expect(status).toBe(0)
      expect(output).toBe("")
      expect(summary).toBe("")
    })

    it("arquivo movido de src/ para docs/: não pula", () => {
      const pr = pullRequest((git, write) => {
        write("docs/.gitkeep", "")
        git("mv", "src/index.ts", "docs/index.ts")
      })
      expect(docsOnly(pr.root, pr.base, pr.head).output).toBe("")
    })

    it("PR sem arquivo mudado: não pula", () => {
      const pr = pullRequest(() => {})
      expect(docsOnly(pr.root, pr.base, pr.head).output).toBe("")
    })

    it("ligado sem fetch-depth: 0, o job falha e diz por quê", () => {
      const pr = pullRequest((_, write) => write("docs/guia.md", "texto\n"))
      const { status, stdout, output } = docsOnly(pr.root, pr.base, pr.head, "1")
      expect(status).not.toBe(0)
      expect(stdout).toContain("::error title=CI Node::skip-docs precisa de fetch-depth: 0 (recebeu 1)")
      expect(output).toBe("")
    })
  })

  // Contract: pr-scripts run in order, with the PR's refs, and a missing or failing one stops the job.
  describe("pr-scripts", () => {
    const project = () => {
      const root = mkdtempSync(join(tmpdir(), "ci-node-pkg-"))
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: {
            first: 'echo "first $BASE_SHA $HEAD_SHA $HEAD_REF $HEAD_REPO $BASE_REF $REPOSITORY" >> log.txt',
            second: "echo second >> log.txt",
            broken: "exit 3",
          },
        }),
      )
      return root
    }
    const prEnv = (scripts: string) => ({
      PR_SCRIPTS: scripts,
      BASE_SHA: "base1",
      HEAD_SHA: "head1",
      HEAD_REF: "feature",
      HEAD_REPO: "owner/repo",
      BASE_REF: "main",
      REPOSITORY: "owner/repo",
    })
    const log = (root: string) => readFileSync(join(root, "log.txt"), "utf8")

    it("rodam na ordem da lista, cada um num grupo do log, com os dados do PR", () => {
      const root = project()
      const { status, stdout } = runStep("Scripts do PR", root, prEnv('["first","second"]'))
      expect(status).toBe(0)
      expect(log(root)).toBe("first base1 head1 feature owner/repo main owner/repo\nsecond\n")
      expect(stdout).toContain("::group::npm run first")
      expect(stdout).toContain("::group::npm run second")
    })

    it("o primeiro que falha para o passo", () => {
      const root = project()
      const { status } = runStep("Scripts do PR", root, prEnv('["first","broken","second"]'))
      expect(status).not.toBe(0)
      expect(log(root)).toBe("first base1 head1 feature owner/repo main owner/repo\n")
    })

    it("um nome que não existe no package.json falha, sem rodar os seguintes", () => {
      const root = project()
      const { status, stdout } = runStep("Scripts do PR", root, prEnv('["first","changeset","second"]'))
      expect(status).not.toBe(0)
      expect(stdout).toContain("::error title=CI Node::script «changeset» pedido em pr-scripts não existe no package.json")
      expect(log(root)).toBe("first base1 head1 feature owner/repo main owner/repo\n")
    })
  })

  // Edge integration: the status goes through the GitHub API, here a fake `gh` that records its arguments.
  it("status-context grava o commit status no sha recebido, com o estado e o link do run", () => {
    const bin = mkdtempSync(join(tmpdir(), "ci-node-gh-"))
    const argsFile = join(bin, "args.txt")
    writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsFile}"\n`)
    chmodSync(join(bin, "gh"), 0o755)
    const { status } = runStep("Status no commit", bin, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GITHUB_REPOSITORY: "owner/repo",
      GH_TOKEN: "token",
      CONTEXT: "checks",
      SHA: "abc123",
      STATE: "failure",
      RUN_URL: "https://github.com/owner/repo/actions/runs/1",
    })
    expect(status).toBe(0)
    // On a PR, the head (what a ruleset reads), not GITHUB_SHA, the merge commit; elsewhere GITHUB_SHA.
    expect(workflow).toContain("          SHA: ${{ github.event.pull_request.head.sha || github.sha }}\n")
    expect(readFileSync(argsFile, "utf8").split("\n")).toEqual([
      "api",
      "repos/owner/repo/statuses/abc123",
      "-f",
      "state=failure",
      "-f",
      "context=checks",
      "-f",
      "target_url=https://github.com/owner/repo/actions/runs/1",
      "-f",
      "description=CI Node",
      "",
    ])
  })
})
