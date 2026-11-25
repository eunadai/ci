// The gate's verdict on a local diff: the same `avaliar` the Action runs, fed from git instead of
// the API. The Action reads the PR's files from the merge base to the head and the config from the
// base; this reads both from the clone, with no token and no network.
import { Effect } from "effect"
import { type Arquivo, avaliar, falha, type Resultado } from "../avaliar.js"
import { type Config, parseConfig } from "../config.js"
import { gitAt } from "../identifiers/checkout.js"

export const GATE_CONFIG_PATH = ".github/portao.json"

const lines = (n: string): number => (n === "-" ? 0 : Number(n))

// `git diff --numstat -z -M` in the API's shape. A binary file counts 0 lines, as in the API. A
// rename is `adds\tdels\t` followed by the old and the new path, each ended by NUL.
export const parseNumstat = (out: string): ReadonlyArray<Arquivo> => {
  const tokens = out.split("\0")
  const files: Array<Arquivo> = []
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? "")
    if (m === null) continue
    const [, adds = "0", dels = "0", path = ""] = m
    if (path !== "") {
      files.push({ filename: path, additions: lines(adds), deletions: lines(dels) })
    } else {
      const previous = tokens[i + 1] ?? ""
      const filename = tokens[i + 2] ?? ""
      i += 2
      files.push({ filename, previous_filename: previous, additions: lines(adds), deletions: lines(dels) })
    }
  }
  return files
}

export interface GateInput {
  // The PR's base commit (its tip) and head, as commits.
  readonly base: string
  readonly head: string
  // The head's branch name.
  readonly headRef: string
  readonly cwd?: string | undefined
}

// The Action also knows the PR's labels and author; here there are none, so the approval label never
// releases the limit and `isento` never applies.
export const localGate = (i: GateInput): Effect.Effect<{ readonly r: Resultado; readonly config: Config | undefined }> =>
  Effect.gen(function* () {
    const read = yield* Effect.try({
      try: () => {
        const mergeBase = gitAt(i.cwd, ["merge-base", i.base, i.head]).trim()
        const numstat = gitAt(i.cwd, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", mergeBase, i.head])
        const exists = gitAt(i.cwd, ["ls-tree", "--name-only", i.base, "--", GATE_CONFIG_PATH]).trim() !== ""
        const config = exists ? gitAt(i.cwd, ["show", `${i.base}:${GATE_CONFIG_PATH}`]) : undefined
        return { arquivos: parseNumstat(numstat), config }
      },
      catch: (e) => falha(`O portão não conseguiu ler o diff: ${e instanceof Error ? e.message : String(e)}`),
    })
    const config = read.config === undefined ? undefined : yield* parseConfig(read.config).pipe(
      Effect.mapError((e) => falha(e.mensagem)),
    )
    const r = avaliar({
      config,
      labels: [],
      labelAplicadaPorAprovador: false,
      autor: "",
      headRef: i.headRef,
      headSha: i.head,
      changedFiles: read.arquivos.length,
      arquivos: read.arquivos,
    })
    return { r, config }
  }).pipe(Effect.catch((r) => Effect.succeed({ r, config: undefined })))
