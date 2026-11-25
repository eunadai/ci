// What a project tells the local command in its own package.json, under the `localChecks` key. It is
// local configuration, read from the working tree, never from the PR's base: it decides how this
// clone runs the checks, not what the Action accepts.
import { Effect, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const PROJECT_KEY = "localChecks"

const ProjectConfig = Schema.Struct({
  // As the caller's `block: true`: a new Portuguese identifier fails the check, and so the push.
  block: Schema.optionalKey(Schema.Boolean),
  // Folders where `local-checks install` does nothing (a tool's own install of the repo, for
  // example). `~` is the home folder; `$NAME` is an environment variable, and the entry is dropped
  // when the variable is not set.
  skipInstallIn: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ProjectConfig = typeof ProjectConfig.Type

// The `localChecks` key of `<root>/package.json`; empty when there is no file or no key. Throws with
// a message for the user when the key is malformed.
export const readProjectConfig = (root: string): ProjectConfig => {
  const file = join(root, "package.json")
  if (!existsSync(file)) return {}
  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    throw new Error(`${file} não é JSON válido`)
  }
  const value = typeof pkg === "object" && pkg !== null ? (pkg as Record<string, unknown>)[PROJECT_KEY] : undefined
  if (value === undefined) return {}
  return Effect.runSync(
    Schema.decodeUnknownEffect(ProjectConfig, { onExcessProperty: "error" })(value).pipe(
      Effect.mapError((e) => new Error(`«${PROJECT_KEY}» inválido em ${file}: ${e.message}`)),
    ),
  )
}

// One `skipInstallIn` entry as an absolute path, or undefined when it names an unset variable.
export const expandPath = (
  entry: string,
  root: string,
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string | undefined => {
  const variable = /^\$(\w+)(.*)$/s.exec(entry)
  if (variable !== null) {
    const value = env[variable[1] ?? ""]
    return value === undefined || value === "" ? undefined : resolve(root, value + (variable[2] ?? ""))
  }
  if (entry === "~" || entry.startsWith("~/")) return join(home, entry.slice(1))
  return resolve(root, entry)
}
