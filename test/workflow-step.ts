import { readFileSync } from "node:fs"

// The body of a step's `run: |` in a reusable workflow, without the YAML indentation. Throws when the
// step or its `run` is missing, so a renamed step fails loudly instead of testing an empty string.
export const stepScript = (workflowFile: string, stepName: string): string => {
  const text = readFileSync(new URL(`../.github/workflows/${workflowFile}`, import.meta.url), "utf8")
  const start = text.indexOf(`      - name: ${stepName}\n`)
  if (start === -1) throw new Error(`${workflowFile}: step "${stepName}" not found`)
  const end = text.indexOf("\n      - name: ", start + 1)
  const step = text.slice(start, end === -1 ? undefined : end)
  const marker = "        run: |\n"
  const run = step.indexOf(marker)
  if (run === -1) throw new Error(`${workflowFile}: step "${stepName}" has no run: |`)
  return step
    .slice(run + marker.length)
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
}
