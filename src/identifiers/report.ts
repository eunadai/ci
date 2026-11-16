// Pure: the copy the identifiers workflow writes (summary, annotations, status). pt-BR, and pinned by
// the tests: it is part of the contract.
import { escaparDado, escaparPropriedade } from "../comando.js"

export const CONFIG_PATH = ".github/identifiers.json"

// A new identifier with Portuguese words: only those words are listed.
export interface Finding {
  readonly identifier: string
  readonly words: ReadonlyArray<string>
  readonly file: string
  readonly line: number
}

export interface Result {
  readonly block: boolean
  readonly findings: ReadonlyArray<Finding>
  // Identifiers with Portuguese words that already exist on the base: legacy code, not counted.
  readonly legacy: number
  // Why the check could not run (invalid config, cspell failed); undefined when it ran.
  readonly error: string | undefined
}

// Blocks only with `block`: then a new finding, or a check that did not run, fails the run.
export const passed = (r: Result): boolean => !r.block || (r.findings.length === 0 && r.error === undefined)

const count = (n: number): string =>
  n === 0
    ? "nenhum identificador novo em português"
    : n === 1
    ? "1 identificador novo em português"
    : `${n} identificadores novos em português`

// The verdict in one line: shared by the summary title and the status.
const sentence = (r: Result): string => {
  if (r.error !== undefined) return `não rodou: ${r.error}${r.block ? "" : " (só aviso)"}`
  return `${count(r.findings.length)}${!r.block && r.findings.length > 0 ? " (só aviso)" : ""}`
}

// The commit status description: GitHub caps it at 140 characters.
export const statusDescription = (r: Result): string => {
  const text = sentence(r)
  return text.length <= 140 ? text : `${text.slice(0, 139)}…`
}

const HOW_TO =
  `Use um nome em inglês. Se é um termo do domínio sem tradução, ponha a palavra em \`words\` no \`${CONFIG_PATH}\`; ` +
  "se é texto para o usuário, ele vai no arquivo de i18n."

// One annotation per finding, up to `max`; the summary lists the rest.
export const annotations = (r: Result, max = 50): ReadonlyArray<string> => {
  const level = r.block ? "error" : "warning"
  const lines = r.findings.slice(0, max).map((f) =>
    `::${level} file=${escaparPropriedade(f.file)},line=${f.line},title=Identificador em português::${
      escaparDado(`«${f.identifier}»: ${f.words.join(", ")}. ${HOW_TO}`)
    }`
  )
  if (r.error !== undefined) lines.push(`::${level} title=Identificadores::${escaparDado(`não rodou: ${r.error}`)}`)
  return lines
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

export const summary = (r: Result, max = 100): string => {
  const clean = r.findings.length === 0 && r.error === undefined
  const emoji = clean ? "✅" : passed(r) ? "⚠️" : "❌"
  const parts = [`${emoji} **Identificadores em inglês:** ${sentence(r)}.`]
  if (r.findings.length > 0) {
    parts.push(
      [
        "| Identificador | Palavras em português | Onde |",
        "|---|---|---|",
        ...r.findings.slice(0, max).map((f) => `| \`${cell(f.identifier)}\` | ${cell(f.words.join(", "))} | \`${cell(f.file)}:${f.line}\` |`),
      ].join("\n"),
    )
    if (r.findings.length > max) parts.push(`… e mais ${r.findings.length - max}.`)
    parts.push(HOW_TO)
  }
  if (r.legacy > 0) {
    parts.push(
      r.legacy === 1
        ? "1 identificador em português que já existe na base não conta (código legado)."
        : `${r.legacy} identificadores em português que já existem na base não contam (código legado).`,
    )
  }
  return `${parts.join("\n\n")}\n`
}
