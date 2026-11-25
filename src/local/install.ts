// `local-checks install`: what a project's `prepare` script runs. On a development clone it installs
// cspell (`setup`) and wires the pre-push hook; anywhere else it does nothing. It never fails an
// install: every problem is a warning and the exit code is always 0.
//
// The hook goes to the hooks folder git already uses (`<common dir>/hooks`, shared by every worktree
// of the clone), and only when `core.hooksPath` is empty: a hooks path someone chose is never
// changed. The hook itself is a few lines that call `local-checks pre-push`, so a fix to the check
// reaches every repo with the package, and the next install rewrites it.
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve, sep } from "node:path"
import { expandPath, PROJECT_KEY, readProjectConfig } from "./project.js"

// The line that marks a hook as ours: an install only rewrites a pre-push that has it.
export const HOOK_MARK = "# local-checks: gerado por «local-checks install»"

export const HOOK = `#!/bin/sh
${HOOK_MARK} (eunadai/ci). O próximo install reescreve este arquivo.
# Confere cada branch enviada com os checks das Actions. Pular: git push --no-verify.
bin=node_modules/.bin/local-checks
if [ ! -x "$bin" ]; then
  echo "pre-push: o local-checks não está instalado neste checkout (rode o install); o push não foi conferido." >&2
  exit 0
fi
exec "$bin" pre-push "$@"
`

// A pre-push that already runs the check: ours, or a project's own hook that calls it.
const runsCheck = (text: string): boolean => text.includes("local-checks pre-push")

export interface InstallContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly home?: string
  // `local-checks setup`: its exit code. A throw counts as a failure.
  readonly setup: () => number
  readonly log: (line: string) => void
}

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)

// git's trimmed stdout, or undefined when it fails.
const git = (cwd: string, args: ReadonlyArray<string>): string | undefined => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  return r.status === 0 ? r.stdout.trim() : undefined
}

const isSet = (v: string | undefined): boolean => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"

// Why this install is not a development clone, or undefined when it is.
export const skipReason = (ctx: InstallContext): string | undefined => {
  if (isSet(ctx.env.CI)) return "CI"
  const folder = real(ctx.cwd)
  const top = git(folder, ["rev-parse", "--show-toplevel"])
  if (top === undefined) return "fora de um work tree git"
  if (real(top) !== folder) return "não é a raiz do work tree git"
  let skipIn: ReadonlyArray<string>
  try {
    skipIn = readProjectConfig(folder).skipInstallIn ?? []
  } catch (e) {
    return `${e instanceof Error ? e.message : String(e)}; corrija o «${PROJECT_KEY}» e rode o install de novo`
  }
  for (const entry of skipIn) {
    const path = expandPath(entry, folder, ctx.env, ctx.home ?? homedir())
    if (path !== undefined && inside(folder, real(path))) return `pasta em ${PROJECT_KEY}.skipInstallIn (${entry})`
  }
  return undefined
}

// Wires the pre-push hook, or says why not. Returns the warning, if any.
const wireHook = (root: string, log: (line: string) => void): string | undefined => {
  const hooksPath = git(root, ["config", "--get", "core.hooksPath"]) ?? ""
  const call = `node_modules/.bin/local-checks pre-push "$@"`
  if (hooksPath !== "") {
    const file = join(resolve(root, hooksPath.replace(/^~(?=$|\/)/, homedir())), "pre-push")
    if (existsSync(file) && runsCheck(readFileSync(file, "utf8"))) return undefined
    return `o core.hooksPath é «${hooksPath}», e ele fica como está: o push não é conferido. Chame «${call}» no pre-push de lá, ou rode «git config --unset core.hooksPath» e o install de novo.`
  }
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
  if (common === undefined) return "não achei a pasta do git deste clone; o pre-push não foi ligado."
  const file = join(common, "hooks", "pre-push")
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined
  if (current !== undefined && !current.includes(HOOK_MARK)) {
    if (runsCheck(current)) return undefined
    return `já existe um pre-push em ${file}, que fica como está: o push não é conferido. Chame «${call}» nele.`
  }
  if (current !== HOOK) {
    mkdirSync(join(common, "hooks"), { recursive: true })
    writeFileSync(file, HOOK)
    log(`local-checks install: pre-push ligado em ${file}.`)
  }
  chmodSync(file, 0o755)
  return undefined
}

export const install = (ctx: InstallContext): void => {
  const warn = (text: string) => ctx.log(`local-checks install: ${text}`)
  const reason = skipReason(ctx)
  if (reason !== undefined) {
    warn(`nada a fazer (${reason}).`)
    return
  }
  const root = real(ctx.cwd)
  let status: number
  try {
    status = ctx.setup()
  } catch (e) {
    warn(e instanceof Error ? e.message : String(e))
    status = 1
  }
  if (status !== 0) warn("o setup do cspell não terminou (sem rede?). O identifiers não roda até «local-checks setup» funcionar.")
  try {
    const problem = wireHook(root, ctx.log)
    if (problem !== undefined) warn(problem)
  } catch (e) {
    warn(`não consegui ligar o pre-push: ${e instanceof Error ? e.message : String(e)}`)
  }
}
