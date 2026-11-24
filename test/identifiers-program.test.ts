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
    inBase: () => Effect.succeed([]),
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

  // Pure rule: legacy counts only in files the check itself would inspect.
  it("uma palavra que na base só aparece em docs não é legado", async () => {
    const t = setup()
    await t.run(t.env({
      diff: diff(["const pedido = 1"]),
      inBase: () => Effect.succeed([{ identifier: "pedido", file: "docs/guia.md" }]),
    }))
    expect(t.status).toEqual([{ state: "success", description: "1 identificador novo em português (só aviso)" }])
  })

  // Pure rule: a hit in code the check inspects is legacy.
  it("um identificador que a base já tem no código é legado", async () => {
    const t = setup()
    await t.run(t.env({
      diff: diff(["const pedido = 1"]),
      inBase: () => Effect.succeed([{ identifier: "pedido", file: "src/a.ts" }]),
    }))
    expect(t.status).toEqual([{ state: "success", description: "nenhum identificador novo em português" }])
  })

  it("o que já existe na base é legado e não conta", async () => {
    const t = setup()
    expect(await t.run(t.env({ block: true, inBase: (i) => Effect.succeed(i.map((identifier) => ({ identifier, file: "src/a.ts" }))) }))).toEqual({ ok: true })
    expect(t.status).toEqual([{ state: "success", description: "nenhum identificador novo em português" }])
    expect(t.log.join("\n")).toContain("2 identificadores em português que já existem na base não contam (código legado).")
  })

  it("as palavras do config da base e os termos do domínio passam", async () => {
    const t = setup()
    const env = t.env({ config: JSON.stringify({ words: ["calcular", "Frete", "pedido"] }), diff: diff(["const cpf = validarCpf(x)"]) })
    await t.run({ ...env, portuguese: (w) => Effect.succeed(new Set(w.filter((x) => x === "validar"))) })
    expect(t.status).toEqual([{ state: "success", description: "1 identificador novo em português (só aviso)" }])
  })

  // The allowlist is read from the base; its own diff is data, so a PR that only adds words passes.
  it("um PR que só adiciona palavras ao identifiers.json não tem achado", async () => {
    const t = setup()
    const allowlistDiff = [
      "diff --git a/.github/identifiers.json b/.github/identifiers.json",
      "--- a/.github/identifiers.json",
      "+++ b/.github/identifiers.json",
      "@@ -2 +2 @@",
      '-  "words": ["frete"],',
      '+  "words": ["frete", "pedido", "pagamento", "cartao"],',
    ].join("\n")
    const searched: Array<ReadonlyArray<string>> = []
    const env = t.env({
      block: true,
      config: JSON.stringify({ words: ["frete"] }),
      diff: allowlistDiff,
      inBase: (i) => Effect.sync(() => (searched.push(i), [])),
    })
    expect(await t.run(env)).toEqual({ ok: true })
    expect(t.status).toEqual([{ state: "success", description: "nenhum identificador novo em português" }])
    expect(searched).toEqual([])
  })

  it("config inválido ou cspell quebrado: não rodou, e com block reprova", async () => {
    const t = setup()
    expect(await t.run(t.env({ block: true, config: `{"palavras": []}` }))).toEqual({ ok: false })
    expect(t.status[0]?.description).toMatch(/^não rodou: \.github\/identifiers\.json inválido/)
    const u = setup()
    await u.run(u.env({ portuguese: () => Effect.fail(new CheckError({ message: "o cspell falhou: x" })) }))
    expect(u.status).toEqual([{ state: "success", description: "não rodou: o cspell falhou: x (só aviso)" }])
  })

  // A glob in `ignore` that never matches is pointed out, without changing the verdict, even with block.
  it("avisa do glob do ignore que nunca casa, sem mudar o veredito", async () => {
    const summaries: Array<string> = []
    const t = setup()
    const env = t.env({ block: true, diff: diff(["const shipping = 1"]), appendSummary: (s) => void summaries.push(s) })
    expect(await t.run({ ...env, config: JSON.stringify({ ignore: ["lib/", "legacy/**"] }) })).toEqual({ ok: true })
    expect(t.status).toEqual([{ state: "success", description: "nenhum identificador novo em português" }])
    expect(t.log.filter((l) => l.startsWith("::"))).toEqual([
      "::warning title=Glob do ignore sem efeito::O glob \"lib/\" do `ignore` do `.github/identifiers.json` nunca casa com um caminho, então não ignora nada. Um glob casa com o caminho inteiro a partir da raiz, sem `/` no começo ou no fim e sem pasta vazia, `.` ou `..`. Para uma pasta, use `pasta/**`.",
    ])
    expect(summaries.join("")).toContain("⚠️ O `ignore` do `.github/identifiers.json` tem globs que nunca casam com um caminho e não ignoram nada: `\"lib/\"`.")
    const u = setup()
    await u.run(u.env({ block: true, diff: diff(["const shipping = 1"]), config: JSON.stringify({ ignore: ["legacy/**"] }) }))
    expect(u.status).toEqual(t.status)
    expect(u.log.filter((l) => l.startsWith("::"))).toEqual([])
  })

  // With the config read, a later failure keeps the warning; an invalid config has no globs to check.
  it("o aviso do glob do ignore fica quando o cspell ou a busca na base falham", async () => {
    const warned = (log: ReadonlyArray<string>) => log.filter((l) => l.startsWith("::warning title=Glob do ignore sem efeito"))
    const config = JSON.stringify({ ignore: ["lib/"] })
    const t = setup()
    await t.run(t.env({ config, portuguese: () => Effect.fail(new CheckError({ message: "o cspell falhou: x" })) }))
    expect(t.status).toEqual([{ state: "success", description: "não rodou: o cspell falhou: x (só aviso)" }])
    expect(warned(t.log)).toHaveLength(1)
    const u = setup()
    await u.run(u.env({ config, inBase: () => Effect.fail(new CheckError({ message: "não consegui ler a base: x" })) }))
    expect(u.status).toEqual([{ state: "success", description: "não rodou: não consegui ler a base: x (só aviso)" }])
    expect(warned(u.log)).toHaveLength(1)
    const v = setup()
    await v.run(v.env({ config: `{"ignore": ["lib/"], "palavras": []}` }))
    expect(v.status[0]?.description).toMatch(/^não rodou: \.github\/identifiers\.json inválido/)
    expect(warned(v.log)).toEqual([])
  })

  it("403 no status fora de um fork reprova o job, mesmo só avisando", async () => {
    const t = setup({ statusHttp: 403 })
    expect(await t.run(t.env())).toEqual({ ok: false })
    const f = setup({ statusHttp: 403 })
    expect(await f.run(f.env({ fork: true }))).toEqual({ ok: true })
  })
})
