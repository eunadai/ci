import { Context, Data, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { type Arquivo, MAX_ARQUIVOS_API } from "./avaliar.js"
import { type Config, type ConfigInvalida, parseConfig } from "./config.js"

// Hidden marker that identifies the gate's own comment, so it is edited and never duplicated.
export const MARCADOR = "<!-- portao:nadairafael/ci -->"

// The pinned comment is written with the caller's job token, so its author is this bot. A comment
// by anyone else that carries the marker is not the gate's.
export const COMMENT_AUTHOR = "github-actions[bot]"

// Attempts of a GET that fails by network or answers 429 or 5xx, waiting 1 s and then 2 s between them.
export const MAX_ATTEMPTS = 3

// `status` is the HTTP status when the API answered with an error.
export class ErroApi extends Data.TaggedError("ErroApi")<{ readonly mensagem: string; readonly status?: number }> {}

export const PrDaApi = Schema.Struct({
  number: Schema.Number,
  body: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  user: Schema.Struct({ login: Schema.String }),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  changed_files: Schema.Number,
})
export type PrDaApi = typeof PrDaApi.Type

const ArquivoDaApi = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optionalKey(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
})
const Evento = Schema.Struct({
  event: Schema.String,
  label: Schema.optionalKey(Schema.Struct({ name: Schema.String })),
  actor: Schema.NullOr(Schema.Struct({ login: Schema.String })),
})
const Comentario = Schema.Struct({
  id: Schema.Number,
  body: Schema.NullOr(Schema.String),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
})
const Conteudo = Schema.Struct({ content: Schema.String })

export interface Acesso {
  readonly api: string
  readonly repo: string
  readonly token: string
  // Writes the commit status when given: the token of the gate's GitHub App, so a ruleset can require
  // the status from that App and a status written by any other workflow does not count.
  readonly tokenStatus?: string | undefined
  // The commit status context and the comment marker; the gate's own by default.
  readonly contexto?: string
  readonly marcador?: string
}

export class GitHub extends Context.Service<GitHub, {
  readonly lerPr: (numero: number) => Effect.Effect<PrDaApi, ErroApi>
  readonly lerArquivos: (numero: number) => Effect.Effect<ReadonlyArray<Arquivo>, ErroApi>
  readonly lerConfig: (baseSha: string) => Effect.Effect<Option.Option<Config>, ErroApi | ConfigInvalida>
  readonly labelAplicadaPor: (numero: number, label: string) => Effect.Effect<Option.Option<string>, ErroApi>
  // Edits the comment with the marker, or creates one. With `soEditar`, never creates.
  readonly gravarComentario: (numero: number, corpo: string, soEditar?: boolean) => Effect.Effect<void, ErroApi>
  readonly gravarStatus: (
    sha: string,
    estado: "success" | "failure",
    descricao: string,
    url: string,
  ) => Effect.Effect<void, ErroApi>
}>()("GitHub") {}

export const githubLive = (acesso: Acesso): Layer.Layer<GitHub, never, HttpClient.HttpClient> =>
  Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const marcador = acesso.marcador ?? MARCADOR

      // One API call. 404 is returned as None; any other non-2xx is an ErroApi. A GET that fails by
      // network or answers 429 or 5xx is tried again, up to MAX_ATTEMPTS; a write never is.
      const pedir = (metodo: "GET" | "POST" | "PATCH", caminho: string, corpo?: unknown, token = acesso.token) => {
        const base = HttpClientRequest.make(metodo)(`${acesso.api}${caminho}`).pipe(
          HttpClientRequest.setHeaders({
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          }),
          HttpClientRequest.bearerToken(token),
        )
        const request = corpo === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, corpo)
        const falhou = (detalhe: string, status?: number) =>
          new ErroApi({ mensagem: `${metodo} ${caminho} ${detalhe}`, ...(status === undefined ? {} : { status }) })
        // Only transient failures leave this effect: a network error or a 429/5xx answer.
        const attempt = http.execute(request).pipe(
          Effect.mapError((e) => falhou(`falhou: ${e.message}`)),
          Effect.flatMap((resposta) =>
            resposta.status === 429 || resposta.status >= 500
              ? Effect.fail(falhou(`respondeu ${resposta.status}`, resposta.status))
              : Effect.succeed(resposta)
          ),
        )
        const comRetry = metodo === "GET"
          ? attempt.pipe(Effect.retry({ schedule: Schedule.exponential("1 second"), times: MAX_ATTEMPTS - 1 }))
          : attempt
        return comRetry.pipe(
          Effect.flatMap((resposta) =>
            resposta.status === 404
              ? Effect.succeed(Option.none<unknown>())
              : resposta.status < 200 || resposta.status >= 300
              ? Effect.fail(falhou(`respondeu ${resposta.status}`, resposta.status))
              : resposta.status === 204
              ? Effect.succeed(Option.some<unknown>(null))
              : resposta.json.pipe(
                Effect.map((j) => Option.some<unknown>(j)),
                Effect.mapError(() => falhou("devolveu um corpo que não é JSON")),
              )
          ),
        )
      }

      const ler = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
        schema: S,
        caminho: string,
      ): Effect.Effect<S["Type"], ErroApi> =>
        pedir("GET", caminho).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new ErroApi({ mensagem: `GET ${caminho} respondeu 404` })),
            onSome: Effect.succeed,
          })),
          Effect.flatMap((j) =>
            Schema.decodeUnknownEffect(schema)(j).pipe(
              Effect.mapError((e) => new ErroApi({ mensagem: `GET ${caminho} devolveu um formato inesperado: ${e.message}` })),
            )
          ),
        )

      const escrever = (metodo: "POST" | "PATCH", caminho: string, corpo: unknown, token?: string) =>
        pedir(metodo, caminho, corpo, token).pipe(
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new ErroApi({ mensagem: `${metodo} ${caminho} respondeu 404` })),
            onSome: () => Effect.void,
          })),
        )

      // Pages of 100 until a short page, or until `maxPaginas`.
      const paginado = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
        item: S,
        caminho: string,
        maxPaginas = Number.POSITIVE_INFINITY,
      ): Effect.Effect<ReadonlyArray<S["Type"]>, ErroApi> =>
        Effect.gen(function* () {
          const todos: Array<S["Type"]> = []
          for (let pagina = 1; pagina <= maxPaginas; pagina++) {
            const lidos = yield* ler(Schema.Array(item), `${caminho}?per_page=100&page=${pagina}`)
            todos.push(...lidos)
            if (lidos.length < 100) return todos
          }
          return todos
        })

      return GitHub.of({
        lerPr: (numero) => ler(PrDaApi, `/repos/${acesso.repo}/pulls/${numero}`),

        lerArquivos: (numero) =>
          // The API lists at most MAX_ARQUIVOS_API files: asking for the page after that answers 422.
          paginado(ArquivoDaApi, `/repos/${acesso.repo}/pulls/${numero}/files`, MAX_ARQUIVOS_API / 100).pipe(
            Effect.map((as) =>
              as.map((a) => ({
                filename: a.filename,
                previous_filename: a.previous_filename,
                additions: a.additions,
                deletions: a.deletions,
              }))
            ),
          ),

        lerConfig: (baseSha) => {
          const caminho = `/repos/${acesso.repo}/contents/.github/portao.json?ref=${baseSha}`
          const noReadAccess = new ErroApi({
            mensagem: `o token não lê ${acesso.repo}: dê ao job do caller a permissão contents: read`,
          })
          const onDenied = (e: ErroApi) => Effect.fail(e.status === 403 ? noReadAccess : e)
          return pedir("GET", caminho).pipe(
            Effect.catchTag("ErroApi", onDenied),
            Effect.flatMap(Option.match({
              // A 404 is "no config" only if the token can read the repo's contents: a token without
              // contents access also gets 404, and must not turn every rule off silently. The probe
              // reads the base commit object (no diff), which needs contents: read (the repo itself only needs metadata).
              onNone: () =>
                pedir("GET", `/repos/${acesso.repo}/git/commits/${baseSha}`).pipe(
                  Effect.catchTag("ErroApi", onDenied),
                  Effect.flatMap(Option.match({
                    onNone: () => Effect.fail(noReadAccess),
                    onSome: () => Effect.succeed(Option.none<Config>()),
                  })),
                ),
              onSome: (j) =>
                Schema.decodeUnknownEffect(Conteudo)(j).pipe(
                  Effect.mapError((e) => new ErroApi({ mensagem: `GET ${caminho} devolveu um formato inesperado: ${e.message}` })),
                  Effect.flatMap(({ content }) => parseConfig(Buffer.from(content, "base64").toString("utf8"))),
                  Effect.map(Option.some),
                ),
            })),
          )
        },

        labelAplicadaPor: (numero, label) =>
          paginado(Evento, `/repos/${acesso.repo}/issues/${numero}/events`).pipe(
            Effect.map((eventos) => {
              const ultimo = eventos.filter((e) => e.event === "labeled" && e.label?.name === label).at(-1)
              return Option.fromNullishOr(ultimo?.actor?.login)
            }),
          ),

        gravarComentario: (numero, corpo, soEditar = false) =>
          paginado(Comentario, `/repos/${acesso.repo}/issues/${numero}/comments`).pipe(
            Effect.flatMap((comentarios) => {
              const meu = comentarios.find((c) => c.user?.login === COMMENT_AUTHOR && c.body?.includes(marcador))
              return meu
                ? escrever("PATCH", `/repos/${acesso.repo}/issues/comments/${meu.id}`, { body: corpo })
                : soEditar
                ? Effect.void
                : escrever("POST", `/repos/${acesso.repo}/issues/${numero}/comments`, { body: corpo })
            }),
          ),

        gravarStatus: (sha, estado, descricao, url) =>
          escrever("POST", `/repos/${acesso.repo}/statuses/${sha}`, {
            state: estado,
            context: acesso.contexto ?? "portao",
            description: descricao,
            target_url: url,
          }, acesso.tokenStatus || undefined),
      })
    }),
  )
