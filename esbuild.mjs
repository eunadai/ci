// Bundles each entry into one file with no runtime dependencies, so the reusable workflows run it
// without npm install. dist/ is committed; CI fails when it is stale.
import { build } from "esbuild"
import { chmodSync } from "node:fs"

const BANNER = "// Gerado por esbuild.mjs a partir de src/. Não edite à mão."

// The third field marks a bin (package.json): it gets a shebang and the executable bit.
const entradas = [
  ["src/main.ts", "dist/portao.mjs"],
  ["src/seguranca/main.ts", "dist/seguranca.mjs"],
  ["src/identifiers/main.ts", "dist/identifiers.mjs"],
  ["src/local/main.ts", "dist/local-checks.mjs", true],
]

for (const [entrada, saida, bin] of entradas) {
  await build({
    entryPoints: [entrada],
    bundle: true,
    platform: "node",
    target: "node26",
    format: "esm",
    outfile: saida,
    legalComments: "none",
    banner: { js: bin ? `#!/usr/bin/env node\n${BANNER}` : BANNER },
  })
  if (bin) chmodSync(saida, 0o755)
}
