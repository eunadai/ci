// Entry point of dist/local-checks.mjs (the package's `local-checks` bin): the identifiers check and
// the gate's count on the local clone, before the push, with no token and no network. It compares the
// head with the base the way the Actions compare a PR, reads each config from the base, and prints the
// summary the Action would write. Exit 1 when a check fails or could not run (no cspell), 2 on a bad
// argument or a ref this clone does not have. `install` and `pre-push` are what a project's `prepare`
// script and git's hook call (install.ts, push.ts).
import { Effect } from "effect"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { LABEL_APROVADO_PADRAO } from "../config.js"
import { summary as gateSummary } from "../relatorio.js"
import { cspellBin, fromCheckout, gitAt } from "../identifiers/checkout.js"
import { result } from "../identifiers/program.js"
import { passed, summary as identifiersSummary } from "../identifiers/report.js"
import { localGate } from "./gate.js"
import { install } from "./install.js"
import { PROJECT_KEY, readProjectConfig } from "./project.js"
import { branchesToCheck } from "./push.js"

const SKIP_SIZE = "LOCAL_CHECKS_SKIP_SIZE"

const USAGE = [
  "uso: local-checks [identifiers] [portao] [--base <ref>] [--head <ref>] [--block]",
  "     local-checks setup",
  "     local-checks install",
  "     local-checks pre-push <remoto> [<url>]   (lê as refs do stdin, como o git manda)",
  "",
  "Sem check, roda os dois.",
  "--base: a base do PR (padrão: origin/HEAD, ou origin/main).",
  "--head: o que vai para o PR (padrão: HEAD). O que não foi commitado não conta.",
  `--block: o identifiers reprova, como com o input block: true do caller (ou "${PROJECT_KEY}": { "block": true } no package.json).`,
  "setup: instala uma vez o cspell do lockfile (só aqui precisa de rede).",
  "install: o que o script prepare do projeto chama. Num clone de desenvolvimento, roda o setup e liga o pre-push;",
  "  no CI, fora da raiz de um work tree git ou numa pasta do skipInstallIn, não faz nada. Sai sempre com 0.",
  `pre-push: confere cada branch enviada. ${SKIP_SIZE}=1 pula a contagem do portão (PR com a label ${LABEL_APROVADO_PADRAO}).`,
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

interface CheckOptions {
  // The branch name the gate sees (for `isento`).
  readonly branch: string
  readonly block: boolean
  // The pre-push lets the push through, with a warning, when cspell is not installed.
  readonly cspellOptional: boolean
}

const check = async (checks: ReadonlySet<Check>, baseRef: string, headRef: string, o: CheckOptions): Promise<number> => {
  const base = commitOf(baseRef)
  const head = commitOf(headRef)
  console.log(`Base ${baseRef} (${base.slice(0, 7)}), head ${headRef} (${head.slice(0, 7)}).\n`)
  let ok = true

  if (checks.has("identifiers")) {
    if (!existsSync(cspellBin(cspellDir))) {
      const mark = o.cspellOptional ? "⚠️" : "❌"
      const tail = o.cspellOptional ? " O push segue sem este check." : ""
      console.log(`${mark} **Identificadores em inglês:** não rodou: o cspell não está instalado em ${cspellDir}: ${setupHint}.${tail}\n`)
      ok &&= o.cspellOptional
    } else {
      const r = await Effect.runPromise(result({
        block: o.block,
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
    const { r, config } = await Effect.runPromise(localGate({ base, head, headRef: o.branch }))
    console.log(gateSummary(r, config))
    if (!r.ok && r.total !== undefined && r.limite !== undefined && r.total > r.limite) {
      const label = config?.tamanho?.labelAprovado ?? LABEL_APROVADO_PADRAO
      console.log(`\nDaqui não dá para ver as labels do PR: no GitHub, a label «${label}» aplicada por quem aprova libera o limite.`)
      console.log(`Se o PR já tem a label, envie com ${SKIP_SIZE}=1 git push (o identifiers continua rodando).`)
    }
    ok &&= r.ok
  }
  return ok ? 0 : 1
}

// The hook's job: every branch on stdin, against the pushed remote's default branch.
const prePush = async (remote: string | undefined, block: boolean): Promise<number> => {
  if (process.stdin.isTTY) throw new Usage("pre-push lê as refs do stdin, como o git manda num hook")
  const branches = branchesToCheck(readFileSync(0, "utf8"))
  const skipSize = process.env[SKIP_SIZE] === "1"
  const checks = new Set<Check>(skipSize ? ["identifiers"] : CHECKS)
  if (skipSize && branches.length > 0) console.log(`${SKIP_SIZE}: a contagem do portão foi pulada; o identifiers roda.\n`)
  let base = defaultBase()
  if (remote !== undefined) {
    try {
      // A remote-tracking ref only: a path such as ../repo.git would also resolve as `<path>/HEAD`.
      base = git("rev-parse", "--verify", "--quiet", "--abbrev-ref", "--end-of-options", `refs/remotes/${remote}/HEAD`)
    } catch {
      // The remote has no HEAD here (or the push goes to a URL): the default base.
    }
  }
  let status = 0
  for (const b of branches) {
    console.log(`pre-push: ${b.branch} (${b.sha.slice(0, 7)})`)
    status = Math.max(status, await check(checks, base, b.sha, { branch: b.branch, block, cspellOptional: true }))
  }
  return status
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
  if (positionals.length === 1 && positionals[0] === "install") {
    // Whatever happens, an install never fails because of this.
    try {
      install({ cwd: process.cwd(), env: process.env, setup, log: (line) => console.error(line) })
    } catch (e) {
      console.error(`local-checks install: ${e instanceof Error ? e.message : String(e)}`)
    }
    return 0
  }
  process.chdir(git("rev-parse", "--show-toplevel"))
  const block = values.block || readProjectConfig(process.cwd()).block === true
  if (positionals[0] === "pre-push" && positionals.length <= 3) return prePush(positionals[1], block)
  const unknownArgs = positionals.filter((p) => !(CHECKS as ReadonlyArray<string>).includes(p))
  if (unknownArgs.length > 0) throw new Usage(`check desconhecido: ${unknownArgs.join(", ")}`)
  const checks = new Set<Check>(positionals.length === 0 ? CHECKS : (positionals as Array<Check>))
  const headRef = values.head ?? "HEAD"
  const branch = headRef === "HEAD" ? git("rev-parse", "--abbrev-ref", "HEAD") : headRef.replace(/^refs\/heads\//, "")
  return check(checks, values.base ?? defaultBase(), headRef, { branch, block, cspellOptional: false })
}

try {
  process.exitCode = await main()
} catch (e) {
  const message = e instanceof Error ? e.message : String(e)
  console.error(e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS") ? `local-checks: ${message}\n\n${USAGE}` : `local-checks: ${message}`)
  process.exitCode = 2
}
