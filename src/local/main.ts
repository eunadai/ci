// Entry point of dist/local-checks.mjs (the package's `local-checks` bin): the identifiers check and
// the gate's count on the local clone, before the push, with no token and no network. It compares the
// head with the base the way the Actions compare a PR, reads each config from the base, and prints the
// summary the Action would write. Exit 1 when a check fails or could not run (no cspell), 2 on a bad
// argument or a ref this clone does not have.
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { LABEL_APROVADO_PADRAO } from "../config.js"
import { summary as gateSummary } from "../relatorio.js"
import { cspellBin, fromCheckout, gitAt } from "../identifiers/checkout.js"
import { result } from "../identifiers/program.js"
import { passed, summary as identifiersSummary } from "../identifiers/report.js"
import { localGate } from "./gate.js"

const USAGE = [
  "uso: local-checks [identifiers] [portao] [--base <ref>] [--head <ref>] [--block]",
  "     local-checks setup",
  "",
  "Sem check, roda os dois.",
  "--base: a base do PR (padrão: origin/HEAD, ou origin/main).",
  "--head: o que vai para o PR (padrão: HEAD). O que não foi commitado não conta.",
  "--block: o identifiers reprova, como com o input block: true do caller.",
  "setup: instala uma vez o cspell do lockfile (só aqui precisa de rede).",
].join("\n")

const CHECKS = ["identifiers", "portao"] as const
type Check = (typeof CHECKS)[number]

// cspell lives next to this file, in dist/identifiers, as the Action installs it.
const cspellDir = process.env.CSPELL_DIR || join(dirname(fileURLToPath(import.meta.url)), "identifiers")
const setupHint = `rode uma vez «local-checks setup» (ou npm ci --prefix ${cspellDir})`

class Usage extends Error {}

const git = (...args: ReadonlyArray<string>): string => gitAt(undefined, args).trim()
const commitOf = (ref: string): string => {
  try {
    return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
  } catch {
    throw new Error(`a ref «${ref}» não existe neste clone (passe --base ou --head, ou rode git fetch)`)
  }
}
const defaultBase = (): string => {
  try {
    return git("rev-parse", "--abbrev-ref", "origin/HEAD")
  } catch {
    return "origin/main"
  }
}

const setup = (): number => {
  if (!existsSync(join(cspellDir, "package-lock.json"))) throw new Usage(`não achei o package-lock.json do cspell em ${cspellDir}`)
  const r = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: cspellDir, stdio: "inherit" })
  return r.status ?? 2
}

const check = async (checks: ReadonlySet<Check>, baseRef: string, headRef: string, block: boolean): Promise<number> => {
  process.chdir(git("rev-parse", "--show-toplevel"))
  const base = commitOf(baseRef)
  const head = commitOf(headRef)
  const branch = headRef === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : headRef.replace(/^refs\/heads\//, "")
  console.log(`Base ${baseRef} (${base.slice(0, 7)}), head ${headRef} (${head.slice(0, 7)}).\n`)
  let ok = true

  if (checks.has("identifiers")) {
    if (!existsSync(cspellBin(cspellDir))) {
      console.log(`❌ **Identificadores em inglês:** não rodou: o cspell não está instalado em ${cspellDir}: ${setupHint}.\n`)
      ok = false
    } else {
      const r = await Effect.runPromise(result({
        block,
        headSha: head,
        fork: false,
        runUrl: "",
        ...fromCheckout(base, head, cspellDir),
        log: () => {},
        appendSummary: () => {},
      }))
      console.log(identifiersSummary(r))
      ok &&= passed(r)
    }
  }

  if (checks.has("portao")) {
    const { r, config } = await Effect.runPromise(localGate({ base, head, headRef: branch }))
    console.log(gateSummary(r, config))
    if (!r.ok && r.total !== undefined && r.limite !== undefined && r.total > r.limite) {
      const label = config?.tamanho?.labelAprovado ?? LABEL_APROVADO_PADRAO
      console.log(`\nDaqui não dá para ver as labels do PR: no GitHub, a label «${label}» aplicada por quem aprova libera o limite.`)
    }
    ok &&= r.ok
  }
  return ok ? 0 : 1
}

const main = async (): Promise<number> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      head: { type: "string" },
      block: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    console.log(USAGE)
    return 0
  }
  if (positionals.length === 1 && positionals[0] === "setup") return setup()
  const unknownArgs = positionals.filter((p) => !(CHECKS as ReadonlyArray<string>).includes(p))
  if (unknownArgs.length > 0) throw new Usage(`check desconhecido: ${unknownArgs.join(", ")}`)
  const checks = new Set<Check>(positionals.length === 0 ? CHECKS : (positionals as Array<Check>))
  return check(checks, values.base ?? defaultBase(), values.head ?? "HEAD", values.block)
}

try {
  process.exitCode = await main()
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.error(e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? `local-checks: ${message}\n\n${USAGE}` : `local-checks: ${message}`)
  process.exitCode = 2
}
