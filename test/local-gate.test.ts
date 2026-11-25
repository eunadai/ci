// The local gate (src/local/gate.ts): `git diff --numstat` in the API's shape, and the verdict against a
// real git repository in a temp folder, with the config read from the base.
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { localGate, parseNumstat } from "../src/local/gate.js"

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

const repo = () => {
  const root = mkdtempSync(join(tmpdir(), "local-gate-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim()
  const commit = (files: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(files)) {
      if (text === null) rmSync(join(root, path))
      else {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
      }
    }
    git("add", "-A")
    git("commit", "-q", "--allow-empty", "-m", "c")
    return git("rev-parse", "HEAD")
  }
  git("init", "-q", "-b", "main")
  return { root, git, commit }
}

const lines = (n: number, prefix = "x") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\n") + "\n"
const config = (c: unknown) => JSON.stringify(c)

describe("parseNumstat", () => {
  it("lê arquivo comum, binário e rename no formato da API", () => {
    const out = "3\t1\tsrc/a.ts\0-\t-\timg/logo.png\0" + "2\t0\t\0src/velho.ts\0src/novo.ts\0"
    expect(parseNumstat(out)).toEqual([
      { filename: "src/a.ts", additions: 3, deletions: 1 },
      { filename: "img/logo.png", additions: 0, deletions: 0 },
      { filename: "src/novo.ts", previous_filename: "src/velho.ts", additions: 2, deletions: 0 },
    ])
  })

  it("um caminho com tab ou quebra de linha fica inteiro", () => {
    expect(parseNumstat("1\t0\tsrc/a\tb\nc.ts\0")).toEqual([{ filename: "src/a\tb\nc.ts", additions: 1, deletions: 0 }])
  })

  it("saída vazia é nenhum arquivo", () => {
    expect(parseNumstat("")).toEqual([])
  })
})

describe("localGate", () => {
  it.effect("conta do merge base ao head, com a config da base, e reprova acima do limite", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ ".github/portao.json": config({ tamanho: { limite: 10 } }), "src/a.ts": "a\n" })
      t.git("checkout", "-q", "-b", "feat/x")
      const head = t.commit({ "src/b.ts": lines(8), "src/b.test.ts": lines(50), "docs/guia.md": lines(50), "src/a.ts": "a\nb\nc\nd\n" })
      // The base moved after the branch: what it added is not the PR's.
      t.git("checkout", "-q", "main")
      const movedBase = t.commit({ "src/c.ts": lines(100) })

      const { r } = yield* localGate({ base: movedBase, head, headRef: "feat/x", cwd: t.root })
      expect(r.ok).toBe(false)
      expect(r.total).toBe(11)
      expect(r.motivos).toEqual(["O PR soma 11 linhas de lógica, acima do limite de 10."])
      expect(r.contados).toEqual([{ arquivo: "src/a.ts", linhas: 3 }, { arquivo: "src/b.ts", linhas: 8 }])

      const within = yield* localGate({ base, head: base, headRef: "main", cwd: t.root })
      expect(within.r).toMatchObject({ ok: true, total: 0, tipo: "normal" })
    }))

  it.effect("a config vem da base: a do head não vale", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ ".github/portao.json": config({ tamanho: { limite: 5 } }) })
      const head = t.commit({ ".github/portao.json": config({ tamanho: { limite: 500 } }), "src/a.ts": lines(20) })
      const { r, config: read } = yield* localGate({ base, head, headRef: "x", cwd: t.root })
      expect(read?.tamanho?.limite).toBe(5)
      expect(r.ok).toBe(false)
      expect(r.sensiveis).toEqual([".github/portao.json"])
    }))

  it.effect("rename para docs/ não é PR só de documentação", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ ".github/portao.json": config({ soDocs: ["docs/**"] }), "src/a.ts": lines(30) })
      const head = t.commit({ "src/a.ts": null, "docs/a.ts": lines(30) })
      const { r } = yield* localGate({ base, head, headRef: "x", cwd: t.root })
      expect(r.tipo).toBe("semRegras")
    }))

  it.effect("sem config na base, nenhuma regra está ligada", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ "src/a.ts": "a\n" })
      const head = t.commit({ "src/a.ts": lines(5000) })
      const { r, config: read } = yield* localGate({ base, head, headRef: "x", cwd: t.root })
      expect(read).toBeUndefined()
      expect(r).toMatchObject({ ok: true, tipo: "semRegras" })
    }))

  it.effect("config inválida na base reprova com a mensagem da Action", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ ".github/portao.json": "{ não é json" })
      const head = t.commit({ "src/a.ts": "a\n" })
      const { r } = yield* localGate({ base, head, headRef: "x", cwd: t.root })
      expect(r).toMatchObject({ ok: false, motivos: [".github/portao.json no base não é JSON válido"] })

      const t2 = repo()
      const base2 = t2.commit({ ".github/portao.json": config({ tamanho: { limite: 0 } }) })
      const { r: r2 } = yield* localGate({ base: base2, head: base2, headRef: "x", cwd: t2.root })
      expect(r2.ok).toBe(false)
      expect(r2.motivos[0]).toMatch(/^\.github\/portao\.json inválido: /)
    }))

  it.effect("uma ref que o git não lê reprova dizendo por quê", () =>
    Effect.gen(function* () {
      const t = repo()
      const base = t.commit({ "src/a.ts": "a\n" })
      const { r } = yield* localGate({ base, head: "0".repeat(40), headRef: "x", cwd: t.root })
      expect(r.ok).toBe(false)
      expect(r.motivos[0]).toMatch(/^O portão não conseguiu ler o diff: git merge-base: /)
    }))
})
