import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stepScript } from "./workflow-step.js"

const run = (scripts: string) => {
  const dir = mkdtempSync(join(tmpdir(), "ci-node-"))
  try {
    const summaryFile = join(dir, "summary.md")
    writeFileSync(summaryFile, "")
    const stdout = execFileSync("bash", ["-e", "-c", stepScript("ci-node.yml", "Scripts")], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", SCRIPTS: scripts, GITHUB_STEP_SUMMARY: summaryFile },
    })
    return { stdout, summary: readFileSync(summaryFile, "utf8") }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("ci-node.yml", () => {
  // Contract: the warning callers see when a script name is not one of the fixed steps.
  it("um nome fora de typecheck, lint e test gera aviso e linha no summary", () => {
    const { stdout, summary } = run('["typecheck","build"]')
    expect(stdout).toContain(
      "::warning title=CI Node::script «build» não é um passo deste workflow (typecheck, lint, test) e não roda aqui: use um job próprio",
    )
    expect(summary).toContain("⚠️ script «build» não é um passo deste workflow (typecheck, lint, test), não roda aqui")
  })

  // Contract: known names stay silent, so existing callers see no change.
  it("só nomes conhecidos: nenhum aviso", () => {
    const { stdout, summary } = run('["typecheck","lint","test"]')
    expect(stdout).toBe("")
    expect(summary).toBe("")
  })
})
