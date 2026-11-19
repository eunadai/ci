// Edge integration: the legacy search (`baseHits`) and the check's verdict (`result`) against a real
// git repository in a temp folder. The case is the one that hung the check: a base with a big data
// file full of common Portuguese words, which `git grep -o` with many patterns never finished reading.
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { casaAlgum } from "../src/glob.js"
import { baseHits } from "../src/identifiers/base.js"
import { legacyIgnore } from "../src/identifiers/extract.js"
import { type Environment, result } from "../src/identifiers/program.js"

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
}

const repo = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), "identifiers-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim()
  const commit = (fs: Record<string, string>) => {
    for (const [path, text] of Object.entries(fs)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    git("add", "-A")
    git("commit", "-qm", "commit")
    return git("rev-parse", "HEAD")
  }
  git("init", "-q", "-b", "main")
  return { root, git, base: commit(files), commit }
}

// About 5 MB of verse text, like the Bible XML that hung the check, and the same text as JSON.
const VERSE = "e disse o senhor ao povo: guardai o texto, a ordem e cada trecho da palavra"
const bible = (open: string, close: string) => Array.from({ length: 70_000 }, (_, i) => `${open}${i} ${VERSE}${close}`).join("\n")

// A 9k-line rename adds hundreds of identifiers; `git grep -o -w -F` slows down with each pattern.
const MANY = Array.from({ length: 400 }, (_, i) => `renamedThing${i}`)

const PT = new Set(["texto", "ordem", "trecho"])

describe("identifiers na base", () => {
  const r = repo({
    "apps/mobile/assets/db/sources/onbv/poronbv_vpl.xml": bible("<v n=\"", "</v>"),
    "corpus/biblia.json": bible("\"", "\","),
    "src/legado.ts": "export const ordem = 1\n",
    ".github/identifiers.json": JSON.stringify({ ignore: ["corpus/**"] }),
  })

  it("não lê os arquivos de dados nem os ignorados, e acha o legado no código", () => {
    const started = performance.now()
    const hits = baseHits(r.base, ["texto", "ordem", "trecho", ...MANY], legacyIgnore(["corpus/**"]), r.root)
    const ms = performance.now() - started
    console.log(`baseHits: ${Math.round(ms)} ms`)
    expect(hits).toEqual([{ identifier: "ordem", file: "src/legado.ts" }])
    expect(ms).toBeLessThan(5_000)
  })

  it("um PR que adiciona «texto» o tem como novo, e «ordem» do código é legado", async () => {
    const head = r.commit({ "src/novo.ts": "export const texto = ordem\n" })
    const e: Environment = {
      block: true,
      headSha: head,
      fork: false,
      runUrl: "https://run",
      diff: r.git("diff", "-U0", "--no-color", "--no-renames", r.base, head),
      config: r.git("show", `${r.base}:.github/identifiers.json`),
      portuguese: (words) => Effect.succeed(new Set(words.filter((w) => PT.has(w)))),
      inBase: (identifiers, exclude) => Effect.sync(() => baseHits(r.base, identifiers, exclude, r.root)),
      log: () => {},
      appendSummary: () => {},
    }
    const started = performance.now()
    const verdict = await Effect.runPromise(result(e))
    console.log(`result: ${Math.round(performance.now() - started)} ms`)
    expect(verdict.error).toBeUndefined()
    expect(verdict.findings.map((f) => f.identifier)).toEqual(["texto"])
    expect(verdict.legacy).toBe(1)
  }, 10_000)

  // A path in `ignore` with no wildcard names one file: the grep never reads it, and the verdict is
  // the one the hits filter alone gives.
  it("o caminho exato do ignore fica fora do grep, e o resultado é o mesmo", async () => {
    const x = repo({
      "src/velho.ts": "export const ordem = 1\n",
      "src/legado.ts": "export const trecho = 1\n",
      ".github/identifiers.json": JSON.stringify({ ignore: ["src/velho.ts"] }),
    })
    const globs = legacyIgnore(["src/velho.ts"])
    expect(baseHits(x.base, ["ordem", "trecho"], globs, x.root)).toEqual([{ identifier: "trecho", file: "src/legado.ts" }])
    const head = x.commit({ "src/novo.ts": "export const texto = ordem + trecho\n" })
    const verdict = (inBase: Environment["inBase"]) => Effect.runPromise(result({
      block: true,
      headSha: head,
      fork: false,
      runUrl: "https://run",
      diff: x.git("diff", "-U0", "--no-color", "--no-renames", x.base, head),
      config: x.git("show", `${x.base}:.github/identifiers.json`),
      portuguese: (words) => Effect.succeed(new Set(words.filter((w) => PT.has(w)))),
      inBase,
      log: () => {},
      appendSummary: () => {},
    }))
    const excluded = await verdict((identifiers, exclude) => Effect.sync(() => baseHits(x.base, identifiers, exclude, x.root)))
    const unexcluded = await verdict((identifiers) => Effect.sync(() => baseHits(x.base, identifiers, [], x.root)))
    expect(excluded).toEqual(unexcluded)
    expect(excluded.findings.map((f) => f.identifier).sort()).toEqual(["ordem", "texto"])
    expect(excluded.legacy).toBe(1)
  })

  // A NUL in an `ignore` glob would make the grep's argument invalid: the glob stays out of the grep,
  // and the hits are the same as with no such glob.
  it("um glob com NUL no ignore não quebra a busca, e o resultado é o mesmo", () => {
    const n = repo({
      "src/legado.ts": "export const ordem = 1\n",
      ".github/identifiers.json": JSON.stringify({ ignore: ["a\u0000*", "a\u0000b"] }),
    })
    const without = baseHits(n.base, ["ordem"], legacyIgnore([]), n.root)
    expect(baseHits(n.base, ["ordem"], legacyIgnore(["a\u0000*", "a\u0000b"]), n.root)).toEqual(without)
    expect(without).toEqual([{ identifier: "ordem", file: "src/legado.ts" }])
  })

  // The pathspecs must exclude what the check's glob ignores, and nothing it keeps. The marker is in
  // the contents only, so every hit comes from the grep.
  it("o git exclui o mesmo que o glob do check", () => {
    const paths = [
      "src/a.ts", "docs/guia.ts", "a/docs/b.ts", "README.md", "x/y/notes.txt", "CHANGELOG.md", "LICENSE",
      "src/locales/pt.json", "app/i18n/x.ts", "pt.po", "package-lock.json", "web/yarn.lock", "Cargo.lock",
      "dist/a.ts", "pkg/node_modules/x/y.ts", "a.min.js", "icon.svg", "api.generated.ts", "data.xml",
      "deep/db/app.db", "apps/mobile/assets/db/x.json", "assets/db/y.ts", "corpus/a/b.ts", "src/corpus/c.ts",
      "srcdocs/x.ts", "dbx/a.xml.ts", "lib/one.ts",
    ]
    const g = repo(Object.fromEntries(paths.map((p) => [p, "marker\n"])))
    const globs = legacyIgnore(["corpus/**", "lib"])
    const kept = new Set(baseHits(g.base, ["marker"], globs, g.root).map((h) => h.file))
    const skip = casaAlgum(globs)
    expect([...kept].sort()).toEqual(paths.filter((p) => !skip(p)).sort())
  })
})
