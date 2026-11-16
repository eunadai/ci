import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { ErroApi, GitHub } from "../src/github.js"
import { CheckError, type Environment, program } from "../src/identifiers/program.js"

// Stand-in for cspell: these are the Portuguese words.
const PT = new Set(["calcular", "frete", "pedido", "pagamento", "cartao", "salvar"])

const diff = (lines: ReadonlyArray<string>) =>
  ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n")

const setup = (f: { statusHttp?: number } = {}) => {
  const status: Array<{ state: string; description: string }> = []
  const nope = () => Effect.die("não usado")
  const layer = Layer.succeed(GitHub, GitHub.of({
    lerPr: nope,
    lerArquivos: nope,
    lerConfig: nope,
    labelAplicadaPor: nope,
    gravarComentario: nope,
    gravarStatus: (_sha, state, description) =>
      f.statusHttp
        ? Effect.fail(new ErroApi({ mensagem: `POST /statuses respondeu ${f.statusHttp}`, status: f.statusHttp }))
        : Effect.sync(() => void status.push({ state, description })),
  }))
  const log: Array<string> = []
  const env = (over: Partial<Environment> = {}): Environment => ({
    block: false,
    headSha: "head",
    fork: false,
    runUrl: "https://run",
    diff: diff(["const total = calcularFrete(pedido)", "const shipping = computeShipping(order)"]),
    config: undefined,
    portuguese: (words) => Effect.succeed(new Set(words.filter((w) => PT.has(w)))),
    inBase: () => Effect.succeed(new Set()),
    log: (s) => void log.push(s),
    appendSummary: () => {},
    ...over,
  })
  return { status, log, env, run: (e: Environment) => Effect.runPromise(program(e).pipe(Effect.provide(layer))) }
}

describe("identifiers", () => {
  it("só avisa por padrão: anota cada identificador novo e o status fica success", async () => {
    const t = setup()
    expect(await t.run(t.env())).toEqual({ ok: true })
    expect(t.status).toEqual([{ state: "success", description: "2 identificadores novos em português (só aviso)" }])
    expect(t.log.filter((l) => l.startsWith("::warning"))).toEqual([
      "::warning file=a.ts,line=1,title=Identificador em português::«calcularFrete»: calcular, frete. Use um nome em inglês. Se é um termo do domínio sem tradução, ponha a palavra em `words` no `.github/identifiers.json`; se é texto para o usuário, ele vai no arquivo de i18n.",
      "::warning file=a.ts,line=1,title=Identificador em português::«pedido»: pedido. Use um nome em inglês. Se é um termo do domínio sem tradução, ponha a palavra em `words` no `.github/identifiers.json`; se é texto para o usuário, ele vai no arquivo de i18n.",
    ])
  })

  it("com block, um identificador novo reprova", async () => {
    const t = setup()
    expect(await t.run(t.env({ block: true }))).toEqual({ ok: false })
    expect(t.status).toEqual([{ state: "failure", description: "2 identificadores novos em português" }])
  })

  it("o que já existe na base é legado e não conta", async () => {
    const t = setup()
    expect(await t.run(t.env({ block: true, inBase: (i) => Effect.succeed(new Set(i)) }))).toEqual({ ok: true })
    expect(t.status).toEqual([{ state: "success", description: "nenhum identificador novo em português" }])
    expect(t.log.join("\n")).toContain("2 identificadores em português que já existem na base não contam (código legado).")
  })

  it("as palavras do config da base e os termos do domínio passam", async () => {
    const t = setup()
    const env = t.env({ config: JSON.stringify({ words: ["calcular", "Frete", "pedido"] }), diff: diff(["const cpf = validarCpf(x)"]) })
    await t.run({ ...env, portuguese: (w) => Effect.succeed(new Set(w.filter((x) => x === "validar"))) })
    expect(t.status).toEqual([{ state: "success", description: "1 identificador novo em português (só aviso)" }])
  })

  it("config inválido ou cspell quebrado: não rodou, e com block reprova", async () => {
    const t = setup()
    expect(await t.run(t.env({ block: true, config: `{"palavras": []}` }))).toEqual({ ok: false })
    expect(t.status[0]?.description).toMatch(/^não rodou: \.github\/identifiers\.json inválido/)
    const u = setup()
    await u.run(u.env({ portuguese: () => Effect.fail(new CheckError({ message: "o cspell falhou: x" })) }))
    expect(u.status).toEqual([{ state: "success", description: "não rodou: o cspell falhou: x (só aviso)" }])
  })

  it("403 no status fora de um fork reprova o job, mesmo só avisando", async () => {
    const t = setup({ statusHttp: 403 })
    expect(await t.run(t.env())).toEqual({ ok: false })
    const f = setup({ statusHttp: 403 })
    expect(await f.run(f.env({ fork: true }))).toEqual({ ok: true })
  })
})
