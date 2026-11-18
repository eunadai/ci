import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { decodeConfig } from "../src/config.js"

it.effect("um objeto vazio decodifica", () =>
  Effect.gen(function* () {
    const config = yield* decodeConfig({})
    expect(config.tamanho).toBeUndefined()
  }))

it.effect("limite com tipo errado falha com ConfigInvalida citando o campo", () =>
  Effect.gen(function* () {
    const erro = yield* Effect.flip(decodeConfig({ tamanho: { limite: "400" } }))
    expect(erro._tag).toBe("ConfigInvalida")
    expect(erro.mensagem).toContain("limite")
  }))

it.effect("limite zero falha", () =>
  Effect.gen(function* () {
    const erro = yield* Effect.flip(decodeConfig({ tamanho: { limite: 0 } }))
    expect(erro._tag).toBe("ConfigInvalida")
  }))

it.effect("chave desconhecida (erro de digitação) falha em vez de desligar o portão", () =>
  Effect.gen(function* () {
    const erro = yield* Effect.flip(decodeConfig({ Tamanho: { limite: 400 } }))
    expect(erro._tag).toBe("ConfigInvalida")
    expect(erro.mensagem).toContain("Tamanho")
  }))

it.effect("aprovadores é uma lista de logins", () =>
  Effect.gen(function* () {
    const config = yield* decodeConfig({ tamanho: { limite: 400, aprovadores: ["fulana", "beltrano"] } })
    expect(config.tamanho?.aprovadores).toEqual(["fulana", "beltrano"])
  }))

it.effect("aprovadores vazio falha em vez de liberar qualquer um", () =>
  Effect.gen(function* () {
    const erro = yield* Effect.flip(decodeConfig({ tamanho: { limite: 400, aprovadores: [] } }))
    expect(erro._tag).toBe("ConfigInvalida")
    expect(erro.mensagem).toContain("aprovadores")
  }))

it.effect("aprovadores com tipo errado ou login vazio falha", () =>
  Effect.gen(function* () {
    for (const aprovadores of ["fulana", [1], [""]]) {
      const erro = yield* Effect.flip(decodeConfig({ tamanho: { limite: 400, aprovadores } }))
      expect(erro._tag).toBe("ConfigInvalida")
    }
  }))
