import { expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { COMMENT_AUTHOR, GitHub, githubLive, MARCADOR, MAX_ATTEMPTS } from "../src/github.js"
import { httpFalso } from "./fake-http.js"

const API = "https://api.github.test"
const acesso = { api: API, repo: "o/r", token: "t" }
const comRotas = (rotas: Parameters<typeof httpFalso>[1]) => {
  const fake = httpFalso(API, rotas)
  return { ...fake, layer: githubLive(acesso).pipe(Layer.provide(fake.layer)) }
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")

it.effect("lerConfig com 404 é none quando o repo é legível", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 404, json: {} },
    "GET /repos/o/r/commits/base1": { status: 200, json: { sha: "base1" } },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    expect(Option.isNone(yield* gh.lerConfig("base1"))).toBe(true)
  }).pipe(Effect.provide(layer))
})

it.effect("lerConfig decodifica o conteúdo base64", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 200, json: { content: b64('{"tamanho":{"limite":400}}') } },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const config = yield* gh.lerConfig("base1")
    expect(Option.getOrThrow(config).tamanho?.limite).toBe(400)
  }).pipe(Effect.provide(layer))
})

it.effect("lerConfig com JSON quebrado falha com ConfigInvalida", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 200, json: { content: b64("{ quebrado") } },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const erro = yield* Effect.flip(gh.lerConfig("base1"))
    expect(erro._tag).toBe("ConfigInvalida")
    expect(erro.mensagem).toBe(".github/portao.json no base não é JSON válido")
  }).pipe(Effect.provide(layer))
})

it.effect("labelAplicadaPor pega o último labeled", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/issues/1/events?per_page=100&page=1": {
      status: 200,
      json: [
        { event: "labeled", label: { name: "aprovado-nadai" }, actor: { login: "nadairafael" } },
        { event: "unlabeled", label: { name: "aprovado-nadai" }, actor: { login: "nadairafael" } },
        { event: "labeled", label: { name: "outra" }, actor: { login: "x" } },
        { event: "labeled", label: { name: "aprovado-nadai" }, actor: { login: "bot" } },
        { event: "assigned", actor: { login: "y" } },
      ],
    },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    expect(yield* gh.labelAplicadaPor(1, "aprovado-nadai")).toEqual(Option.some("bot"))
  }).pipe(Effect.provide(layer))
})

it.effect("gravarComentario edita quando o marcador existe", () => {
  const { layer, chamadas } = comRotas({
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": {
      status: 200, json: [{ id: 7, body: "oi", user: { login: "github-actions[bot]" } }, { id: 9, body: `${MARCADOR}\nantigo`, user: { login: "github-actions[bot]" } }],
    },
    "PATCH /repos/o/r/issues/comments/9": { status: 200, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarComentario(1, `${MARCADOR}\nnovo`)
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET", "PATCH"])
    expect(chamadas[1]!.corpo).toEqual({ body: `${MARCADOR}\nnovo` })
  }).pipe(Effect.provide(layer))
})

it.effect("gravarComentario cria quando não existe", () => {
  const { layer, chamadas } = comRotas({
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": { status: 200, json: [{ id: 7, body: "oi", user: { login: "github-actions[bot]" } }] },
    "POST /repos/o/r/issues/1/comments": { status: 201, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarComentario(1, "x")
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      "GET /repos/o/r/issues/1/comments?per_page=100&page=1",
      "POST /repos/o/r/issues/1/comments",
    ])
  }).pipe(Effect.provide(layer))
})

it.effect("lerArquivos pagina", () => {
  const pagina = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }))
  const { layer } = comRotas({
    "GET /repos/o/r/pulls/1/files?per_page=100&page=1": { status: 200, json: pagina(100) },
    "GET /repos/o/r/pulls/1/files?per_page=100&page=2": { status: 200, json: pagina(3) },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    expect((yield* gh.lerArquivos(1)).length).toBe(103)
  }).pipe(Effect.provide(layer))
})

it.effect("lerArquivos para em 3000 arquivos: a página 31 responderia 422", () => {
  const pagina = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, additions: 1, deletions: 0 }))
  const rotas = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`GET /repos/o/r/pulls/1/files?per_page=100&page=${i + 1}`, { status: 200, json: pagina }]),
  )
  const { layer, chamadas } = comRotas({
    ...rotas,
    "GET /repos/o/r/pulls/1/files?per_page=100&page=31": { status: 422, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    expect((yield* gh.lerArquivos(1)).length).toBe(3000)
    expect(chamadas.length).toBe(30)
  }).pipe(Effect.provide(layer))
})

it.effect("gravarStatus usa o contexto portao", () => {
  const { layer, chamadas } = comRotas({ "POST /repos/o/r/statuses/abc": { status: 201, json: {} } })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarStatus("abc", "failure", "acima do limite: 900/400", "https://run")
    expect(chamadas[0]!.corpo).toEqual({
      state: "failure", context: "portao", description: "acima do limite: 900/400", target_url: "https://run",
    })
  }).pipe(Effect.provide(layer))
})

// Edge integration: a GET that answers 5xx every time is tried MAX_ATTEMPTS times, and the error is the last one.
it.effect("GET com 500 em toda tentativa falha com a mensagem de sempre", () => {
  const { layer, chamadas } = comRotas({ "GET /repos/o/r/pulls/1": { status: 500, json: {} } })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const fiber = yield* Effect.forkChild(Effect.flip(gh.lerPr(1)))
    yield* TestClock.adjust("10 seconds")
    const erro = yield* Fiber.join(fiber)
    expect(erro._tag).toBe("ErroApi")
    expect(erro.mensagem).toBe("GET /repos/o/r/pulls/1 respondeu 500")
    expect(chamadas.length).toBe(MAX_ATTEMPTS)
  }).pipe(Effect.provide(layer))
})

const pr = {
  number: 1, body: null, labels: [], user: { login: "a" },
  head: { ref: "h", sha: "s1" }, base: { ref: "main", sha: "base1" }, changed_files: 1,
}

// Edge integration: a transient 502 on a GET is retried after a wait, and the second answer is used.
it.effect("GET com 502 e depois 200 tenta de novo e devolve o resultado", () => {
  let vezes = 0
  const { layer, chamadas } = comRotas({
    "GET /repos/o/r/pulls/1": () => (++vezes === 1 ? { status: 502, json: {} } : { status: 200, json: pr }),
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const fiber = yield* Effect.forkChild(gh.lerPr(1))
    yield* TestClock.adjust("1 second")
    expect((yield* Fiber.join(fiber)).number).toBe(1)
    expect(chamadas.length).toBe(2)
  }).pipe(Effect.provide(layer))
})

// Edge integration: a write is never retried, so a 502 on a POST is not sent twice.
it.effect("POST com 502 não tenta de novo", () => {
  const { layer, chamadas } = comRotas({ "POST /repos/o/r/statuses/abc": { status: 502, json: {} } })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const fiber = yield* Effect.forkChild(Effect.flip(gh.gravarStatus("abc", "success", "ok", "https://run")))
    yield* TestClock.adjust("10 seconds")
    expect((yield* Fiber.join(fiber)).mensagem).toBe("POST /repos/o/r/statuses/abc respondeu 502")
    expect(chamadas.length).toBe(1)
  }).pipe(Effect.provide(layer))
})

// Edge integration: a 404 is an answer, not a transient failure.
it.effect("GET com 404 não tenta de novo", () => {
  const { layer, chamadas } = comRotas({ "GET /repos/o/r/pulls/1": { status: 404, json: {} } })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const fiber = yield* Effect.forkChild(Effect.flip(gh.lerPr(1)))
    yield* TestClock.adjust("10 seconds")
    expect((yield* Fiber.join(fiber))._tag).toBe("ErroApi")
    expect(chamadas.length).toBe(1)
  }).pipe(Effect.provide(layer))
})

it.effect("lerConfig com 404 e repo ilegível falha em vez de passar sem regras", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 404, json: {} },
    "GET /repos/o/r/commits/base1": { status: 404, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const erro = yield* Effect.flip(gh.lerConfig("base1"))
    expect(erro._tag).toBe("ErroApi")
    expect(erro.mensagem).toContain("contents: read")
  }).pipe(Effect.provide(layer))
})

it.effect("lerArquivos guarda o previous_filename dos renomeios", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/pulls/1/files?per_page=100&page=1": {
      status: 200, json: [{ filename: "docs/x.md", previous_filename: "src/x.ts", additions: 0, deletions: 0 }],
    },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    expect((yield* gh.lerArquivos(1))[0]!.previous_filename).toBe("src/x.ts")
  }).pipe(Effect.provide(layer))
})

it.effect("contexto e marcador próprios: status «seguranca» e o comentário do outro marcador", () => {
  const fake = httpFalso(API, {
    "POST /repos/o/r/statuses/abc": { status: 201, json: {} },
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": {
      status: 200, json: [{ id: 9, body: `${MARCADOR}\nportão`, user: { login: "github-actions[bot]" } }, { id: 11, body: "<!-- outro -->\nantigo", user: { login: "github-actions[bot]" } }],
    },
    "PATCH /repos/o/r/issues/comments/11": { status: 200, json: {} },
  })
  const layer = githubLive({ ...acesso, contexto: "seguranca", marcador: "<!-- outro -->" }).pipe(Layer.provide(fake.layer))
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarStatus("abc", "success", "nenhum achado novo", "https://run")
    yield* gh.gravarComentario(1, "<!-- outro -->\nnovo")
    expect((fake.chamadas[0]!.corpo as { context: string }).context).toBe("seguranca")
    expect(fake.chamadas.map((c) => `${c.metodo} ${c.url}`).at(-1)).toBe("PATCH /repos/o/r/issues/comments/11")
  }).pipe(Effect.provide(layer))
})

it.effect("gravarComentario com soEditar não cria quando não existe", () => {
  const { layer, chamadas } = comRotas({
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": { status: 200, json: [{ id: 7, body: "oi", user: { login: "github-actions[bot]" } }] },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarComentario(1, "x", true)
    expect(chamadas.map((c) => c.metodo)).toEqual(["GET"])
  }).pipe(Effect.provide(layer))
})

it.effect("com tokenStatus, só o status vai com o token do App; o resto, com o token do job", () => {
  const fake = httpFalso(API, {
    "POST /repos/o/r/statuses/sha1": { status: 201, json: {} },
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": { status: 200, json: [] },
    "POST /repos/o/r/issues/1/comments": { status: 201, json: {} },
  })
  const layer = githubLive({ ...acesso, tokenStatus: "app" }).pipe(Layer.provide(fake.layer))
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarStatus("sha1", "success", "ok", "https://run")
    yield* gh.gravarComentario(1, "x")
    expect(fake.chamadas.map((c) => [c.metodo, c.url.split("?")[0], c.autorizacao])).toEqual([
      ["POST", "/repos/o/r/statuses/sha1", "Bearer app"],
      ["GET", "/repos/o/r/issues/1/comments", "Bearer t"],
      ["POST", "/repos/o/r/issues/1/comments", "Bearer t"],
    ])
  }).pipe(Effect.provide(layer))
})

// Edge integration: a 403 on the config means the token lacks contents: read, and says so.
it.effect("lerConfig com 403 no conteúdo diz qual permissão falta", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 403, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const erro = yield* Effect.flip(gh.lerConfig("base1"))
    expect(erro._tag).toBe("ErroApi")
    expect(erro.mensagem).toContain("contents: read")
  }).pipe(Effect.provide(layer))
})

// Edge integration: the probe needs contents: read too, so a 403 on it is the missing permission.
it.effect("lerConfig com 404 e sonda 403 diz qual permissão falta", () => {
  const { layer } = comRotas({
    "GET /repos/o/r/contents/.github/portao.json?ref=base1": { status: 404, json: {} },
    "GET /repos/o/r/commits/base1": { status: 403, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    const erro = yield* Effect.flip(gh.lerConfig("base1"))
    expect(erro._tag).toBe("ErroApi")
    expect(erro.mensagem).toContain("contents: read")
  }).pipe(Effect.provide(layer))
})

// Edge integration: only the bot's own comment is the pinned one; a marker pasted by someone else is ignored.
it.effect("gravarComentario ignora o marcador num comentário de outro autor", () => {
  const { layer, chamadas } = comRotas({
    "GET /repos/o/r/issues/1/comments?per_page=100&page=1": {
      status: 200, json: [{ id: 9, body: `${MARCADOR}\nfalso`, user: { login: "alguem" } }],
    },
    "POST /repos/o/r/issues/1/comments": { status: 201, json: {} },
  })
  return Effect.gen(function* () {
    const gh = yield* GitHub
    yield* gh.gravarComentario(1, `${MARCADOR}\nnovo`)
    expect(chamadas.map((c) => `${c.metodo} ${c.url}`)).toEqual([
      "GET /repos/o/r/issues/1/comments?per_page=100&page=1",
      "POST /repos/o/r/issues/1/comments",
    ])
    expect(COMMENT_AUTHOR).toBe("github-actions[bot]")
  }).pipe(Effect.provide(layer))
})
