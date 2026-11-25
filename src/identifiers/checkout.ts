// What the check reads from the project's checkout: the diff from the merge base to the head, the
// config on the base, cspell's verdict on the words and the base's identifiers. The Action
// (main.ts) and the local command (src/local) both build it here, so both judge a diff the same way.
// It runs git in the current directory, which must be the project's root.
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { baseHits } from "./base.js"
import { CheckError, type Environment } from "./program.js"
import { CONFIG_PATH } from "./report.js"

export type CheckoutInputs = Pick<Environment, "diff" | "config" | "portuguese" | "inBase">

const run = (cmd: string, args: ReadonlyArray<string>, input?: string, cwd?: string) =>
  spawnSync(cmd, args, { input, cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })

// git's stdout; throws with its stderr when it fails. `cwd` defaults to the current directory.
export const gitAt = (cwd: string | undefined, args: ReadonlyArray<string>): string => {
  const r = run("git", args, undefined, cwd)
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`)
  return r.stdout
}
const git = (...args: ReadonlyArray<string>): string => gitAt(undefined, args)

// cspell as `npm ci` installs it from dist/identifiers/package-lock.json.
export const cspellBin = (cspellDir: string): string => join(cspellDir, "node_modules/.bin/cspell")

// The words cspell does not know with `config`, one per line. Exit 1 means it found some.
const unknown = (cspellDir: string, config: string, words: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, CheckError> =>
  Effect.try({
    try: () => {
      if (words.length === 0) return new Set<string>()
      const r = run(cspellBin(cspellDir), [
        "--no-progress", "--no-summary", "--no-color", "--words-only", "--unique",
        "-c", join(cspellDir, config), "stdin",
      ], words.join("\n"))
      if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.trim())
      return new Set(r.stdout.split("\n").map((w) => w.trim().toLowerCase()).filter((w) => w !== ""))
    },
    catch: (e) => new CheckError({ message: `o cspell falhou: ${e instanceof Error ? e.message : String(e)}` }),
  })

// `base` is the PR's base commit (its tip), `head` the PR's head. Throws when git cannot read them.
export const fromCheckout = (base: string, head: string, cspellDir: string): CheckoutInputs => {
  const mergeBase = git("merge-base", base, head).trim()
  const configOnBase = run("git", ["show", `${base}:${CONFIG_PATH}`])
  return {
    diff: git("diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", mergeBase, head),
    config: configOnBase.status === 0 ? configOnBase.stdout : undefined,
    // Portuguese: unknown in English (with the software terms), then known in pt-BR.
    portuguese: (words) =>
      unknown(cspellDir, "en.json", words).pipe(
        Effect.flatMap((notEnglish) =>
          unknown(cspellDir, "pt-br.json", [...notEnglish]).pipe(
            Effect.map((notPortuguese) => new Set([...notEnglish].filter((w) => !notPortuguese.has(w)))),
          )
        ),
      ),
    inBase: (identifiers, exclude) =>
      Effect.try({
        try: () => baseHits(mergeBase, identifiers, exclude),
        catch: (e) => new CheckError({ message: `não consegui ler a base: ${e instanceof Error ? e.message : String(e)}` }),
      }),
  }
}
