// Pure: the identifiers a PR adds. It reads the unified diff (-U0), keeps only added lines, drops
// comments and prose strings, and splits what is left into identifiers and their words. Comments and
// prose follow each project's language rules, so they are never checked.
import { casaAlgum } from "../glob.js"

// An identifier the PR added, with where it first shows up.
export interface Occurrence {
  readonly identifier: string
  readonly words: ReadonlyArray<string>
  readonly file: string
  readonly line: number
}

// Never checked: prose, copy (i18n), lockfiles, generated and vendored files.
export const DEFAULT_IGNORE: ReadonlyArray<string> = [
  "docs/**",
  "**/*.{md,mdx,txt,rst,adoc}",
  "**/{CHANGELOG,LICENSE,NOTICE}*",
  ".changeset/**",
  "**/{locales,locale,i18n,lang,translations,messages}/**",
  "**/*.{po,pot,xliff,xlf,strings,stringsdict,arb}",
  "**/{package-lock.json,npm-shrinkwrap.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb}",
  "**/*.lock",
  "**/{dist,build,out,coverage,vendor,node_modules,generated,__generated__}/**",
  "**/*.{min.js,min.css,map,snap,svg,csv,tsv}",
  "**/*.generated.*",
]

// Words that are not English but have no natural translation: Brazilian domain terms.
export const DEFAULT_WORDS: ReadonlyArray<string> = ["cpf", "cnpj", "cep", "pix", "boleto", "nfe", "nfse"]

// cspell's own minimum: shorter words are never reported.
export const MIN_WORD_LENGTH = 4

// Where the base already has an identifier: the file that holds it.
export interface BaseHit {
  readonly identifier: string
  readonly file: string
}

// The files the check skips: the defaults plus the project's globs.
export const ignored = (ignore: ReadonlyArray<string>): ((path: string) => boolean) =>
  casaAlgum([...DEFAULT_IGNORE, ...ignore])

// Never legacy, on top of the files the check skips: data files. A Bible text in XML or a SQLite
// file holds common words thousands of times, so a grep there is slow and its hits are not code.
export const LEGACY_IGNORE: ReadonlyArray<string> = ["**/*.{xml,db}", "**/assets/db/**"]

// The globs whose files never make an identifier legacy: the ones the check skips, plus data files.
export const legacyIgnore = (ignore: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...DEFAULT_IGNORE, ...ignore, ...LEGACY_IGNORE]

// A glob with its `{a,b}` alternatives spelled out, as `globParaRegex` reads them: no nesting, and a
// `{` with no `}` after it is literal. Git pathspecs have no braces.
export const expandBraces = (glob: string): ReadonlyArray<string> => {
  let out = [""]
  let alternatives: Array<string> | undefined
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (alternatives === undefined && c === "{" && glob.indexOf("}", i + 1) !== -1) alternatives = [""]
    else if (alternatives !== undefined && c === "}") {
      const alts = alternatives
      out = out.flatMap((p) => alts.map((a) => p + a))
      alternatives = undefined
    } else if (alternatives !== undefined && c === ",") alternatives.push("")
    else if (alternatives !== undefined) alternatives[alternatives.length - 1] += c
    else out = out.map((p) => p + c)
  }
  return out
}

// Whether the check's glob (`globParaRegex`, with no braces) can match a repo path: one that is
// relative and has no empty, `.` or `..` folder and no NUL. `*`, `?` and `**` can stand for one plain
// character, which never hurts; the `**/` of `src**/` may match nothing, so it is either nothing or a
// plain folder. `ends` holds what the path so far can end in.
type End = "start" | "slash" | "dot" | "dots" | "name"
const matchesSomePath = (glob: string): boolean => {
  let ends = new Set<End>(["start"])
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      if (ends.size > 0) ends.add("slash")
      i += 2
      continue
    }
    if (c === "*" && glob[i + 1] === "*") i += 1
    const next = new Set<End>()
    for (const e of ends) {
      if (c === "\0") continue
      if (c === "/") {
        if (e === "name") next.add("slash")
      } else if (c === ".") next.add(e === "start" || e === "slash" ? "dot" : e === "dot" ? "dots" : "name")
      else next.add("name")
    }
    ends = next
  }
  return ends.has("name")
}

// The globs that ignore nothing, as written: no alternative matches a repo path.
export const deadGlobs = (globs: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(globs)].filter((g) => !expandBraces(g).some(matchesSomePath))

const escapeGlob = (s: string): string => s.replace(/[[\]\\]/g, "\\$&")

// The globs as `git grep` exclude pathspecs. With `glob` magic, `*` and `?` stay inside one folder and
// `**/`, `/**/` and a trailing `/**` cross folders, as in `globParaRegex`; `[`, `]` and `\` are literal
// there, so they are escaped. A glob with no `*` or `?` names one file, but git would also take it as a
// folder and exclude what is inside, so its last character is escaped (`lib` → `li\b`): git matches a
// pathspec with an escape against the whole path only. A glob that is absolute, has an empty, `.` or
// `..` folder, or has a NUL is left out: git would reject some, would read `a//b` as `a/b`, and a NUL
// can't go in a process argument.
// Excluding is only a shortcut: the hits are still filtered by `legacyIgnore`, and where git excludes
// more, fewer names are legacy, never more.
export const excludePathspecs = (globs: ReadonlyArray<string>): ReadonlyArray<string> =>
  [...new Set(globs.flatMap(expandBraces))]
    .filter((g) => !g.includes("\0") && !g.split("/").some((s) => s === "" || s === "." || s === ".."))
    .map((g) => {
      if (/[*?]/.test(g)) return `:(exclude,glob)${escapeGlob(g)}`
      const chars = [...g]
      return `:(exclude,glob)${escapeGlob(chars.slice(0, -1).join(""))}\\${chars.at(-1)}`
    })

// The hits of `git grep -o` run on `rev` without -h: lines of `<rev>:<path>:<identifier>`. The
// identifier never holds a colon, so the last one splits it from a path that may hold some.
export const parseGrep = (output: string, rev: string): ReadonlyArray<BaseHit> =>
  output.split("\n").filter((l) => l.startsWith(`${rev}:`)).map((l) => {
    const rest = l.slice(rev.length + 1)
    const i = rest.lastIndexOf(":")
    return { identifier: rest.slice(i + 1), file: rest.slice(0, i) }
  }).filter((h) => h.identifier !== "" && h.file !== "")

export interface AddedLine {
  readonly file: string
  readonly line: number
  readonly text: string
}

// The added lines of a `git diff -U0` and the files it creates. Inside a hunk, `old`/`new` count the
// lines left, so an added line that starts with "++ " is never taken for the "+++ " header.
export const parseDiff = (diff: string): { readonly lines: ReadonlyArray<AddedLine>; readonly newFiles: ReadonlyArray<string> } => {
  const lines: Array<AddedLine> = []
  const newFiles: Array<string> = []
  let file = ""
  let created = false
  let old = 0
  let added = 0
  let n = 0
  for (const raw of diff.split("\n")) {
    if (old > 0 || added > 0) {
      if (raw.startsWith("-")) old--
      else if (raw.startsWith("+")) {
        if (file !== "") lines.push({ file, line: n, text: raw.slice(1) })
        n++
        added--
      }
      continue
    }
    if (raw.startsWith("diff --git ")) created = false
    else if (raw.startsWith("new file mode") || raw.startsWith("rename to ")) created = true
    else if (raw.startsWith("+++ ")) {
      file = raw === "+++ /dev/null" ? "" : raw.slice(6)
      if (created && file !== "") newFiles.push(file)
    } else if (raw.startsWith("@@ ")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
      if (m) {
        old = m[1] === undefined ? 1 : Number(m[1])
        n = Number(m[2])
        added = m[3] === undefined ? 1 : Number(m[3])
      }
    }
  }
  return { lines, newFiles }
}

// The closing delimiter of a block comment (or docstring) still open at the end of a line, if any.
type Block = "" | "*/" | "-->" | '"""' | "'''"

const OPENERS: ReadonlyArray<readonly [string, Block]> = [["/*", "*/"], ["<!--", "-->"], ['"""', '"""'], ["'''", "'''"]]

// One line without its comments and prose strings. A string with whitespace is prose (copy, a log
// message) and goes; a string without whitespace is a key, a route or an event name, and stays.
export const code = (text: string, block: Block): { readonly text: string; readonly block: Block } => {
  let out = ""
  let open = block
  let i = 0
  while (i < text.length) {
    if (open !== "") {
      const j = text.indexOf(open, i)
      if (j === -1) return { text: out, block: open }
      i = j + open.length
      open = ""
      out += " "
      continue
    }
    const opener = OPENERS.find(([o]) => text.startsWith(o, i))
    const c = text[i]!
    if (opener) {
      open = opener[1]
      i += opener[0].length
    } else if (text.startsWith("//", i) || /^(?:#|--\s)/.test(text.slice(i)) && (i === 0 || /\s/.test(text[i - 1]!))) {
      return { text: out, block: "" }
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1
      const inner = text.slice(i + 1, j)
      out += /\s/.test(inner) ? " " : ` ${inner} `
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return { text: out, block: open }
}

// camelCase, PascalCase, snake_case, kebab-case and dot.case into lower-case words.
export const splitWords = (identifier: string): ReadonlyArray<string> =>
  identifier
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}]+/u)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_WORD_LENGTH)

const YAML = /\.ya?ml$/
const YAML_PROSE = /^(\s*(?:-\s+)?[\w.-]+:\s+)(?![|>"'])(.*\s.*)$/

const YAML_LABEL = /^(\s*(?:-\s+)?(?:name|title|description|summary):\s+)(?![|>]).*$/

// An unquoted YAML value with whitespace is prose, like a string with whitespace, and goes. So does
// the value of a label key (name, title, description): it is text a person reads.
export const yamlCode = (text: string): string =>
  text
    .replace(YAML_LABEL, "$1")
    .replace(YAML_PROSE, (_, key: string, value: string) => value.includes("${{") ? `${key}${value}` : key)

const IDENTIFIER = /[\p{L}_$][\p{L}\p{N}_$]*(?:-[\p{L}\p{N}_$]+)*/gu

// The first occurrence of each identifier the PR adds, in its lines and in the names of the files it
// creates. Files matching `ignore` (the defaults plus the project's) are skipped.
export const occurrences = (diff: string, ignore: ReadonlyArray<string>): ReadonlyArray<Occurrence> => {
  const skip = ignored(ignore)
  const { lines, newFiles } = parseDiff(diff)
  const seen = new Map<string, Occurrence>()
  const add = (identifier: string, file: string, line: number) => {
    if (seen.has(identifier)) return
    const words = splitWords(identifier)
    if (words.length > 0) seen.set(identifier, { identifier, words, file, line })
  }
  for (const f of newFiles) {
    if (skip(f)) continue
    for (const segment of f.split("/")) add(segment.replace(/\..*$/, ""), f, 1)
  }
  let file = ""
  let prev = -1
  let block: Block = ""
  for (const l of lines) {
    if (skip(l.file)) continue
    // A block comment only carries over between consecutive added lines of the same file.
    if (l.file !== file || l.line !== prev + 1) block = ""
    file = l.file
    prev = l.line
    const c = code(YAML.test(l.file) ? yamlCode(l.text) : l.text, block)
    block = c.block
    for (const m of c.text.matchAll(IDENTIFIER)) add(m[0], l.file, l.line)
  }
  return [...seen.values()]
}

// Words allowed by the defaults and the project's config, compared without case or accents.
export const normalize = (w: string): string => w.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
