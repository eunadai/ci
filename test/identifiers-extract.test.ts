import { describe, expect, it } from "@effect/vitest"
import { code, occurrences, parseDiff, splitWords, yamlCode } from "../src/identifiers/extract.js"

const diff = (file: string, added: ReadonlyArray<string>, opts: { created?: boolean; start?: number } = {}) =>
  [
    `diff --git a/${file} b/${file}`,
    ...(opts.created ? ["new file mode 100644"] : []),
    `--- ${opts.created ? "/dev/null" : `a/${file}`}`,
    `+++ b/${file}`,
    `@@ -0,0 +${opts.start ?? 1},${added.length} @@`,
    ...added.map((l) => `+${l}`),
  ].join("\n")

const ids = (d: string, ignore: ReadonlyArray<string> = []) => occurrences(d, ignore).map((o) => o.identifier)

describe("splitWords", () => {
  it("separa camelCase, PascalCase, snake, kebab e dot", () => {
    expect(splitWords("calcularFreteTotal")).toEqual(["calcular", "frete", "total"])
    expect(splitWords("HTTPCartaoPagamento")).toEqual(["http", "cartao", "pagamento"])
    expect(splitWords("botao-primario_grande.cor")).toEqual(["botao", "primario", "grande"])
  })

  it("descarta palavras com menos de 4 letras", () => {
    expect(splitWords("getId")).toEqual([])
  })
})

// Only the words matter: whitespace is collapsed.
const words = (text: string, block: Parameters<typeof code>[1] = "") => code(text, block).text.trim().split(/\s+/).join(" ")

describe("code", () => {
  it("tira comentários e strings com espaço, mantém strings sem espaço", () => {
    expect(words(`const a = "Olá, mundo" // calcula`)).toBe("const a =")
    expect(words(`t("checkout.pagamento.titulo")`)).toBe("t( checkout.pagamento.titulo )")
    expect(words(`x = 1  # comentário`)).toBe("x = 1")
  })

  it("leva o comentário de bloco para a linha seguinte", () => {
    const a = code(`foo /* começa`, "")
    expect(a.block).toBe("*/")
    expect(words(`ainda */ bar`, a.block)).toBe("bar")
  })
})

describe("yamlCode", () => {
  it("tira um valor sem aspas com espaço, mantém chave e valor de uma palavra", () => {
    expect(yamlCode("name: Identificadores em inglês")).toBe("name: ")
    expect(yamlCode("  - description: true para avisar")).toBe("  - description: ")
    expect(yamlCode("    runs-on: ubuntu-latest")).toBe("    runs-on: ubuntu-latest")
    expect(yamlCode("    run: |")).toBe("    run: |")
    expect(yamlCode("      - name: Identificadores")).toBe("      - name: ")
  })
})

describe("parseDiff", () => {
  it("lê só as linhas adicionadas, com o número na head", () => {
    const d = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3 +3,2 @@",
      "-velho",
      "+++novo",
      "+outro",
    ].join("\n")
    expect(parseDiff(d)).toEqual({
      lines: [{ file: "a.ts", line: 3, text: "++novo" }, { file: "a.ts", line: 4, text: "outro" }],
      newFiles: [],
    })
  })
})

describe("occurrences", () => {
  it("pega identificadores do código e o nome de um arquivo novo", () => {
    expect(ids(diff("src/CartaoPagamento.tsx", ["export const valorTotal = calcularFrete(pedido)"], { created: true })))
      .toEqual(["CartaoPagamento", "export", "const", "valorTotal", "calcularFrete", "pedido"])
  })

  it("ignora i18n, markdown e os globs do projeto", () => {
    expect(ids(diff("src/locales/pt-BR.json", [`"salvar": "Salvar"`]))).toEqual([])
    expect(ids(diff("README.md", ["pagamento"]))).toEqual([])
    expect(ids(diff("legado/x.ts", ["pagamento"]), ["legado/**"])).toEqual([])
  })
})
