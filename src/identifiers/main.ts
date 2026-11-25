// Entry point of dist/identifiers.mjs, run by .github/workflows/identifiers.yml in the project's
// checkout, after cspell and its dictionaries were installed in $CSPELL_DIR.
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { appendFileSync } from "node:fs"
import { githubLive } from "../github.js"
import { fromCheckout } from "./checkout.js"
import { program } from "./program.js"

const env = process.env
const head = env.HEAD_SHA ?? ""

const layer = githubLive({
  api: env.GITHUB_API_URL ?? "https://api.github.com",
  repo: env.GITHUB_REPOSITORY ?? "",
  token: env.GITHUB_TOKEN ?? "",
  contexto: "identifiers",
}).pipe(Layer.provide(FetchHttpClient.layer))

const { ok } = await Effect.runPromise(
  program({
    block: env.BLOCK === "true",
    headSha: head,
    fork: env.FORK === "true",
    runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`,
    ...fromCheckout(env.BASE_SHA ?? "", head, env.CSPELL_DIR ?? ""),
    log: (line) => console.log(line),
    appendSummary: (text) => {
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text)
    },
  }).pipe(Effect.provide(layer)),
)
process.exitCode = ok ? 0 : 1
