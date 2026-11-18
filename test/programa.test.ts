import { expect, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import type { Arquivo } from "../src/avaliar.js"
import { type Config, ConfigInvalida } from "../src/config.js"
import { ErroApi, GitHub, type PrDaApi } from "../src/github.js"
import { type Ambiente, programa } from "../src/programa.js"

const PR: PrDaApi = {
  number: 7, body: "", labels: [], user: { login: "nadairafael" },
  head: { ref: "feat/x", sha: "headsha" }, base: { ref: "main", sha: "basesha" }, changed_files: 1,
}

interface Falso {
  config?: Option.Option<Config>
  arquivos?: Effect.Effect<ReadonlyArray<Arquivo>, ErroApi>
  comentarioFalha?: boolean
  configErro?: boolean
  configMensagem?: string
  pr?: PrDaApi
  aplicadaPor?: string
}

const montar = (f: Falso = {}) => {
  const status: Array<{ sha: string; estado: string; descricao: string }> = []
  const comentarios: Array<string> = []
  const layer = Layer.succeed(GitHub, GitHub.of({
    lerPr: () => Effect.succeed(f.pr ?? PR),
    lerArquivos: () => f.arquivos ?? Effect.succeed([{ filename: "src/a.ts", additions: 10, deletions: 0 }]),
    lerConfig: () =>
      f.configErro
        ? Effect.fail(new ConfigInvalida({ mensagem: f.configMensagem ?? ".github/portao.json no base não é JSON válido" }))
        : Effect.succeed(f.config ?? Option.some<Config>({ tamanho: { limite: 400 } })),
    labelAplicadaPor: () => Effect.succeed(Option.fromNullishOr(f.aplicadaPor)),
    gravarComentario: (_n, corpo) =>
      f.comentarioFalha
        ? Effect.fail(new ErroApi({ mensagem: "POST /x respondeu 403" }))
        : Effect.sync(() => void comentarios.push(corpo)),
    gravarStatus: (sha, estado, descricao) => Effect.sync(() => void status.push({ sha, estado, descricao })),
  }))
  const log: Array<string> = []
  const amb = (over: Partial<Ambiente> = {}): Ambiente => ({
    evento: "pull_request",
    payload: { pull_request: PR },
    sha: "mergesha",
    dono: "nadairafael",
    runUrl: "https://run",
    prNumero: undefined,
    prSha: undefined,
    runRef: "refs/pull/7/merge",
    statusFromApp: false,
    log: (s) => void log.push(s),
    anexarSummary: () => {},
    ...over,
  })
  return { layer, status, comentarios, log, amb }
}

it.effect("pull_request aprovado grava status success no head.sha, não no GITHUB_SHA", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb())
    expect(r.ok).toBe(true)
    expect(m.status).toEqual([{ sha: "headsha", estado: "success", descricao: "10/400 linhas" }])
    expect(m.comentarios[0]).toContain("✅ **Portão ok** (10/400 linhas).")
  }).pipe(Effect.provide(m.layer))
})

it.effect("erro 500 em lerArquivos grava failure e comenta que não conseguiu ler o PR", () => {
  const m = montar({ arquivos: Effect.fail(new ErroApi({ mensagem: "GET /repos/o/r/pulls/7/files?per_page=100&page=1 respondeu 500" })) })
  return Effect.gen(function* () {
    const r = yield* programa(m.amb())
    expect(r.ok).toBe(false)
    expect(m.status[0]!.estado).toBe("failure")
    expect(m.comentarios[0]).toContain("O portão não conseguiu ler o PR: GET /repos/o/r/pulls/7/files?per_page=100&page=1 respondeu 500")
    expect(m.log.some((l) => l.startsWith("::error title=Portão::"))).toBe(true)
  }).pipe(Effect.provide(m.layer))
})

it.effect("dispatch com PR_NUMERO inválido falha com o motivo exato", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "abc" }))
    expect(r.ok).toBe(false)
    expect(m.log.join("\n")).toContain("o número do PR do disparo não é válido: «abc»")
    expect(m.status).toEqual([{ sha: "mergesha", estado: "failure", descricao: "o número do PR do disparo não é válido: «abc»" }])
  }).pipe(Effect.provide(m.layer))
})

it.effect("dispatch compara o head com o commit do run", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "7", sha: "outro", runRef: "refs/heads/feat/x" }))
    expect(r.ok).toBe(false)
    expect(m.log.join("\n")).toContain("O PR mudou depois do disparo")
    // The failure goes on the commit the run was for, and the comment of the new head is left alone.
    expect(m.status.map((s) => [s.sha, s.estado])).toEqual([["outro", "failure"]])
    expect(m.comentarios).toEqual([])
  }).pipe(Effect.provide(m.layer))
})

it.effect("falha ao comentar não muda ok e vira warning", () => {
  const m = montar({ comentarioFalha: true })
  return Effect.gen(function* () {
    const r = yield* programa(m.amb())
    expect(r.ok).toBe(true)
    expect(m.log.some((l) => l.startsWith("::warning"))).toBe(true)
    expect(m.status[0]!.estado).toBe("success")
  }).pipe(Effect.provide(m.layer))
})

it.effect("config inválida no base reprova com a mensagem da config", () => {
  const m = montar({ configErro: true })
  return Effect.gen(function* () {
    const r = yield* programa(m.amb())
    expect(r.ok).toBe(false)
    expect(m.comentarios[0]).toContain("- .github/portao.json no base não é JSON válido")
  }).pipe(Effect.provide(m.layer))
})

it.effect("dispatch no head atual grava no head e comenta", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "7", sha: "headsha", runRef: "refs/heads/feat/x" }))
    expect(r.ok).toBe(true)
    expect(m.status.map((s) => s.sha)).toEqual(["headsha"])
    expect(m.comentarios.length).toBe(1)
  }).pipe(Effect.provide(m.layer))
})

it.effect("um motivo com várias linhas sai numa anotação só, com as quebras escapadas", () => {
  const m = montar({ configErro: true, configMensagem: ".github/portao.json inválido: Expected number\n  at [\"tamanho\"][\"limite\"]" })
  return Effect.gen(function* () {
    yield* programa(m.amb())
    const erros = m.log.filter((l) => l.startsWith("::error"))
    expect(erros).toEqual([
      '::error title=Portão::.github/portao.json inválido: Expected number%0A  at ["tamanho"]["limite"]',
    ])
  }).pipe(Effect.provide(m.layer))
})

it.effect("dispatch no branch padrão com o sha do head: avalia o head e grava nele", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "7", sha: "mainsha", prSha: "headsha", runRef: "refs/heads/main", statusFromApp: true }))
    expect(r.ok).toBe(true)
    expect(m.status.map((s) => [s.sha, s.estado])).toEqual([["headsha", "success"]])
    expect(m.comentarios.length).toBe(1)
  }).pipe(Effect.provide(m.layer))
})

it.effect("dispatch com o sha de um head antigo: falha no sha pedido, nunca no commit do branch padrão", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "7", sha: "mainsha", prSha: "velho", runRef: "refs/heads/main", statusFromApp: true }))
    expect(r.ok).toBe(false)
    expect(m.status.map((s) => [s.sha, s.estado])).toEqual([["velho", "failure"]])
    expect(m.comentarios).toEqual([])
  }).pipe(Effect.provide(m.layer))
})

it.effect("App pedido sem token: reprova no head dizendo o que conferir", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ appSemToken: "O caller pediu o App do portão, mas o token dele não saiu." }))
    expect(r.ok).toBe(false)
    expect(m.status).toEqual([{ sha: "headsha", estado: "failure", descricao: "O caller pediu o App do portão, mas o token dele não saiu." }])
    expect(m.comentarios[0]).toContain("- O caller pediu o App do portão, mas o token dele não saiu.")
  }).pipe(Effect.provide(m.layer))
})

it.effect("App sem token num disparo de head antigo: falha no sha pedido e não comenta", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({ evento: "workflow_dispatch", payload: {}, prNumero: "7", prSha: "velho", runRef: "refs/heads/main", appSemToken: "sem token" }))
    expect(r.ok).toBe(false)
    expect(m.status.map((s) => [s.sha, s.estado])).toEqual([["velho", "failure"]])
    expect(m.comentarios).toEqual([])
  }).pipe(Effect.provide(m.layer))
})

// Contract: with the App, a dispatch off the PR's base writes no status and no comment, with this copy.
it.effect("dispatch com o App fora do branch base do PR: reprova sem gravar status nem comentário", () => {
  const m = montar({ pr: { ...PR, base: { ref: "frouxa", sha: "basesha" } } })
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({
      evento: "workflow_dispatch", prNumero: "7", prSha: "headsha", sha: "mainsha",
      runRef: "refs/heads/main", statusFromApp: true,
    }))
    expect(r.ok).toBe(false)
    expect(m.status).toEqual([])
    expect(m.comentarios).toEqual([])
    expect(m.log).toContain(
      "::error title=Portão::O disparo rodou em «main», mas a base do PR é «frouxa»: com o App, dispare no branch base do PR.",
    )
  }).pipe(Effect.provide(m.layer))
})

// Contract: a dispatch without `sha` off the PR's branch writes no status and no comment, with this copy.
it.effect("dispatch sem sha fora do branch do PR: pede o sha e não grava nada", () => {
  const m = montar()
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({
      evento: "workflow_dispatch", prNumero: "7", prSha: undefined, sha: "mainsha", runRef: "refs/heads/main",
    }))
    expect(r.ok).toBe(false)
    expect(m.status).toEqual([])
    expect(m.comentarios).toEqual([])
    expect(m.log).toContain(
      "::error title=Portão::O disparo não trouxe o input sha, e o commit do run (mainsha) não é o head do PR: dispare com -f sha=headsha (ou, num caller sem o input sha, dispare no branch do PR).",
    )
  }).pipe(Effect.provide(m.layer))
})

// Contract: with the App, a dispatch without `sha` needs the run's commit to be the head, even when a
// fork's branch shares the base's name; it writes no status (never on top of main) and asks for the sha.
it.effect("dispatch com o App sem sha, PR de fork cujo branch se chama main: pede o sha e não grava nada", () => {
  const m = montar({ pr: { ...PR, head: { ref: "main", sha: "headsha" } } })
  return Effect.gen(function* () {
    const r = yield* programa(m.amb({
      evento: "workflow_dispatch", prNumero: "7", prSha: undefined, sha: "mainsha", runRef: "refs/heads/main",
      statusFromApp: true,
    }))
    expect(r.ok).toBe(false)
    expect(m.status).toEqual([])
    expect(m.comentarios).toEqual([])
    expect(m.log).toContain(
      "::error title=Portão::O disparo não trouxe o input sha, e o commit do run (mainsha) não é o head do PR: dispare com -f sha=headsha (ou, num caller sem o input sha, dispare no branch do PR).",
    )
  }).pipe(Effect.provide(m.layer))
})

// A repo owned by an organization: the owner is the org, which is never the actor of a label event.
const PR_COM_LABEL: PrDaApi = { ...PR, labels: [{ name: "aprovado-nadai" }] }
const GRANDE = Effect.succeed([{ filename: "src/a.ts", additions: 900, deletions: 0 }])
const configCom = (aprovadores?: ReadonlyArray<string>): Option.Option<Config> =>
  Option.some<Config>({ tamanho: { limite: 400, ...(aprovadores === undefined ? {} : { aprovadores }) } })
const rodarComLabel = (aplicadaPor: string, aprovadores?: ReadonlyArray<string>) => {
  const m = montar({ pr: PR_COM_LABEL, arquivos: GRANDE, config: configCom(aprovadores), aplicadaPor })
  const run = programa(m.amb({ dono: "minha-org", payload: { pull_request: PR_COM_LABEL } })).pipe(Effect.provide(m.layer))
  return Effect.map(run, (r) => ({ ok: r.ok, comentarios: m.comentarios }))
}

it.effect("repo de organização: a label de quem está em aprovadores libera o limite", () =>
  Effect.gen(function* () {
    const r = yield* rodarComLabel("fulana", ["fulana"])
    expect(r.ok).toBe(true)
    expect(r.comentarios[0]).toContain("liberado pela label «aprovado-nadai»")
  }))

it.effect("repo de organização: a label de quem não está em aprovadores não libera, e o comentário diz por quê", () =>
  Effect.gen(function* () {
    const r = yield* rodarComLabel("intruso", ["fulana"])
    expect(r.ok).toBe(false)
    expect(r.comentarios[0]).toContain("- A label «aprovado-nadai» não foi aplicada por um aprovador do repo, então não libera o limite.")
    expect(r.comentarios[0]).toContain("peça a um aprovador do repo a label «aprovado-nadai»")
  }))

it.effect("sem aprovadores vale a regra antiga: a label do dono libera, a de um membro da org não", () =>
  Effect.gen(function* () {
    expect((yield* rodarComLabel("minha-org")).ok).toBe(true)
    const r = yield* rodarComLabel("fulana")
    expect(r.ok).toBe(false)
    expect(r.comentarios[0]).toContain("não foi aplicada pelo dono do repo")
    expect(r.comentarios[0]).toContain("peça ao dono do repo a label")
  }))

it.effect("com aprovadores, a label do dono do repo deixa de valer se ele não está na lista", () =>
  Effect.gen(function* () {
    expect((yield* rodarComLabel("minha-org", ["fulana"])).ok).toBe(false)
  }))
