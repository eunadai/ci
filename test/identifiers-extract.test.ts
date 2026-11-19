import { describe, expect, it } from "@effect/vitest"
import { casaAlgum } from "../src/glob.js"
import { code, deadGlobs, excludePathspecs, expandBraces, legacyIgnore, occurrences, parseGrep, parseDiff, splitWords, yamlCode } from "../src/identifiers/extract.js"

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

describe("parseGrep", () => {
  // Pure rule: the path may hold colons; the identifier is what follows the last one.
  it("lê caminho e identificador, mesmo com dois-pontos no caminho", () => {
    expect(parseGrep("abc:src/a.ts:pedido\nabc:src/x:y.ts:frete\n", "abc")).toEqual([
      { identifier: "pedido", file: "src/a.ts" },
      { identifier: "frete", file: "src/x:y.ts" },
    ])
  })
})

describe("excludePathspecs", () => {
  // Pure rule: git pathspecs have no braces, so each alternative becomes its own glob.
  it("abre as alternativas entre chaves, como o glob do check", () => {
    expect(expandBraces("**/*.{md,mdx}")).toEqual(["**/*.md", "**/*.mdx"])
    expect(expandBraces("{a,b}/{c,d}")).toEqual(["a/c", "a/d", "b/c", "b/d"])
    expect(expandBraces("a{b")).toEqual(["a{b"])
  })

  // Pure rule: every glob becomes a glob-aware exclude; brackets are literal, as in the check's glob. A
  // glob without wildcards gets its last character escaped, so git never takes it as a folder.
  it("vira um exclude com glob, sem repetir e sem o que o git rejeitaria", () => {
    expect(excludePathspecs(["legacy/**", "**/*.{xml,db}", "legacy/**", "x[1]?.ts", "", "src", "a/b]", "café", "lib/", "a//b", "/abs/*", "../fora/*", "a/./*"])).toEqual([
      ":(exclude,glob)legacy/**",
      ":(exclude,glob)**/*.xml",
      ":(exclude,glob)**/*.db",
      ":(exclude,glob)x\\[1\\]?.ts",
      ":(exclude,glob)sr\\c",
      ":(exclude,glob)a/b\\]",
      ":(exclude,glob)caf\\é",
    ])
  })

  // Pure rule: a NUL can't go in a process argument, so a glob with one is left out, with or without
  // wildcards; the hits filter still ignores what it matches.
  it("um glob com NUL fica fora dos pathspecs", () => {
    expect(excludePathspecs(["a\u0000*", "a\u0000b", "legacy/**"])).toEqual([":(exclude,glob)legacy/**"])
  })

  // Pure rule: a glob that only matches absolute paths, or ones with an empty, `.` or `..` folder or a
  // NUL, ignores nothing; the `**/` of `src**/` may match nothing, so that one still matches `src`.
  it("aponta os globs do ignore que nunca casam com um caminho", () => {
    const dead = deadGlobs(["lib/", "/abs/*", "a//b", "./x", "a/../b", "**/", "a\u0000*", "{lib/,src/}", "", "lib/"])
    expect(dead).toEqual(["lib/", "/abs/*", "a//b", "./x", "a/../b", "**/", "a\u0000*", "{lib/,src/}", ""])
    expect(deadGlobs(["legacy/**", "src", ".github/**", "{lib/,src/**}", "a/.b/*", "src**/", "a**//b", ".*/x"])).toEqual([])
    const paths = ["lib", "lib/a.ts", "abs/a", "a/b", "x", "a/b/c", "src", "src/a.ts", "a"]
    expect(paths.filter(casaAlgum(dead))).toEqual([])
  })

  // Pure rule: data files never make a name legacy, even with no config.
  it("os arquivos de dados ficam sempre de fora do legado", () => {
    expect(legacyIgnore([])).toEqual(expect.arrayContaining(["**/*.{xml,db}", "**/assets/db/**"]))
    expect(legacyIgnore(["corpus/**"])).toContain("corpus/**")
  })
})
