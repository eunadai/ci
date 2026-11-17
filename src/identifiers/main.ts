// Entry point of dist/identifiers.mjs, run by .github/workflows/identifiers.yml in the project's
// checkout, after cspell and its dictionaries were installed in $CSPELL_DIR.
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { githubLive } from "../github.js"
import { CONFIG_PATH } from "./report.js"
import { parseGrep } from "./extract.js"
import { CheckError, program } from "./program.js"

const env = process.env
const base = env.BASE_SHA ?? ""
const head = env.HEAD_SHA ?? ""
const cspellDir = env.CSPELL_DIR ?? ""

const run = (cmd: string, args: ReadonlyArray<string>, input?: string) =>
  spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })

const git = (...args: ReadonlyArray<string>): string => {
  const r = run("git", args)
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`)
  return r.stdout
}

// The words cspell does not know with `config`, one per line. Exit 1 means it found some.
const unknown = (config: string, words: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, CheckError> =>
  Effect.try({
    try: () => {
      if (words.length === 0) return new Set<string>()
      const r = run(join(cspellDir, "node_modules/.bin/cspell"), [
        "--no-progress", "--no-summary", "--no-color", "--words-only", "--unique",
        "-c", join(cspellDir, config), "stdin",
      ], words.join("\n"))
      if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.trim())
      return new Set(r.stdout.split("\n").map((w) => w.trim().toLowerCase()).filter((w) => w !== ""))
    },
    catch: (e) => new CheckError({ message: `o cspell falhou: ${e instanceof Error ? e.message : String(e)}` }),
  })

const mergeBase = git("merge-base", base, head).trim()
const configOnBase = run("git", ["show", `${base}:${CONFIG_PATH}`])

const layer = githubLive({
  api: env.GITHUB_API_URL ?? "https://api.github.com",
  repo: env.GITHUB_REPOSITORY ?? "",
  token: env.GITHUB_TOKEN ?? "",
  contexto: "identifiers",
}).pipe(Layer.provide(FetchHttpClient.layer))

const { ok } = await Effect.runPromise(
  program({
    block: env.BLOCK === "true",
    headSha: head,
    fork: env.FORK === "true",
    runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
    diff: git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", mergeBase, head),
    config: configOnBase.status === 0 ? configOnBase.stdout : undefined,
    // Portuguese: unknown in English (with the software terms), then known in pt-BR.
    portuguese: (words) =>
      unknown("en.json", words).pipe(
        Effect.flatMap((notEnglish) =>
          unknown("pt-br.json", [...notEnglish]).pipe(
            Effect.map((notPortuguese) => new Set([...notEnglish].filter((w) => !notPortuguese.has(w)))),
          )
        ),
      ),
    inBase: (identifiers) =>
      Effect.try({
        try: () => {
          const r = run("git", ["grep", "-I", "-o", "-w", "-F", ...identifiers.flatMap((i) => ["-e", i]), mergeBase, "--"])
          if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.trim())
          const hits = [...parseGrep(r.stdout, mergeBase)]
          for (const path of git("ls-tree", "-r", "--name-only", mergeBase).split("\n")) {
            for (const segment of path.split("/")) hits.push({ identifier: segment.replace(/\..*$/, ""), file: path })
          }
          const wanted = new Set(identifiers)
          return hits.filter((h) => wanted.has(h.identifier))
        },
        catch: (e) => new CheckError({ message: `não consegui ler a base: ${e instanceof Error ? e.message : String(e)}` }),
      }),
    log: (line) => console.log(line),
    appendSummary: (text) => {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text)
    },
  }).pipe(Effect.provide(layer)),
)
process.exitCode = ok ? 0 : 1
