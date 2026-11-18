import { Data, Effect, Schema } from "effect"
import { escaparDado } from "../comando.js"
import { GitHub } from "../github.js"
import { casaAlgum } from "../glob.js"
import { type BaseHit, DEFAULT_WORDS, legacyIgnore, normalize, occurrences } from "./extract.js"
import { CONFIG_PATH, type Finding, passed, type Result, statusDescription, summary, annotations } from "./report.js"

// The shape of .github/identifiers.json, read from the PR's base branch.
export const Config = Schema.Struct({
  words: Schema.optionalKey(Schema.Array(Schema.String)),
  ignore: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type Config = typeof Config.Type

export class CheckError extends Data.TaggedError("CheckError")<{ readonly message: string }> {}

const decodeConfig = (raw: string | undefined): Effect.Effect<Config, CheckError> => {
  if (raw === undefined) return Effect.succeed({})
  return Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => new CheckError({ message: `${CONFIG_PATH} não é JSON` }) }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })),
    Effect.mapError((e) => e instanceof CheckError ? e : new CheckError({ message: `${CONFIG_PATH} inválido: ${e.message}` })),
  )
}

// Everything the program reads from the runner, so tests can hand it in.
export interface Environment {
  readonly block: boolean
  // The PR's head; the status goes there.
  readonly headSha: string
  // A PR from a fork: its token is read-only, so a 403 on the status is expected there.
  readonly fork: boolean
  readonly runUrl: string
  // `git diff -U0` from the merge base to the head.
  readonly diff: string
  // .github/identifiers.json as it is on the base; undefined when it does not exist there.
  readonly config: string | undefined
  // Of the given words, the ones that are Portuguese: unknown in English, known in pt-BR.
  readonly portuguese: (words: ReadonlyArray<string>) => Effect.Effect<ReadonlySet<string>, CheckError>
  // Where the base has the given identifiers: in file contents and in path segments, with the file.
  // Files matching `exclude` (globs) never count, so the search may skip them.
  readonly inBase: (identifiers: ReadonlyArray<string>, exclude: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<BaseHit>, CheckError>
  readonly log: (line: string) => void
  readonly appendSummary: (text: string) => void
}

export const result = (env: Environment): Effect.Effect<Result> =>
  Effect.gen(function* () {
    const config = yield* decodeConfig(env.config)
    const allowed = new Set([...DEFAULT_WORDS, ...(config.words ?? [])].map(normalize))
    const found = occurrences(env.diff, config.ignore ?? [])
      .map((o) => ({ ...o, words: o.words.filter((w) => !allowed.has(normalize(w))) }))
      .filter((o) => o.words.length > 0)
    const pt = yield* env.portuguese([...new Set(found.flatMap((o) => o.words))])
    const candidates: ReadonlyArray<Finding> = found
      .map((o) => ({ identifier: o.identifier, words: o.words.filter((w) => pt.has(w)), file: o.file, line: o.line }))
      .filter((f) => f.words.length > 0)
    // Legacy only where the check itself looks: a hit in docs, markdown, i18n or a data file does not count.
    const exclude = legacyIgnore(config.ignore ?? [])
    const skip = casaAlgum(exclude)
    const hits = candidates.length === 0 ? [] : yield* env.inBase(candidates.map((f) => f.identifier), exclude)
    const legacy = new Set(hits.filter((h) => !skip(h.file)).map((h) => h.identifier))
    return {
      block: env.block,
      findings: candidates.filter((f) => !legacy.has(f.identifier)),
      legacy: candidates.filter((f) => legacy.has(f.identifier)).length,
      error: undefined,
    } satisfies Result
  }).pipe(Effect.catch((e) => Effect.succeed({ block: env.block, findings: [], legacy: 0, error: e.message })))

// Annotations, summary and the «identifiers» status on the PR head. A failed write is a warning: the
// verdict stands. The exception is a 403 outside a fork: the caller is missing `statuses: write`.
export const program = (env: Environment): Effect.Effect<{ readonly ok: boolean }, never, GitHub> =>
  Effect.gen(function* () {
    const gh = yield* GitHub
    const r = yield* result(env)
    const ok = passed(r)

    for (const line of annotations(r)) env.log(line)
    const text = summary(r)
    env.log(text)
    env.appendSummary(text)

    let noPermission = false
    yield* gh.gravarStatus(env.headSha, ok ? "success" : "failure", statusDescription(r), env.runUrl).pipe(
      Effect.catch((e) => {
        const forbidden = e.status === 403 && !env.fork
        noPermission = forbidden
        const message = forbidden
          ? `não consegui gravar o status «identifiers» (403): dê ao job do caller a permissão statuses: write. ${e.mensagem}`
          : `não consegui gravar o status «identifiers»: ${e.mensagem}`
        return Effect.sync(() => env.log(`::${forbidden ? "error" : "warning"} title=Identificadores::${escaparDado(message)}`))
      }),
    )
    return { ok: ok && !noPermission }
  })
