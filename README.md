# ci

Portão de PR, CI, checagem de segurança e de identificadores em inglês reutilizáveis para os projetos do Nadai.

O portão roda nas máquinas do GitHub, responde em segundos e escreve o motivo **no próprio PR**: o número, o limite e o que fazer. Ele também grava o commit status `portao` no head do PR, que é o contexto que um ruleset pode exigir.

## Adotar num repo

1. **Settings → Actions → General:** permitir actions e workflows reutilizáveis de outros repositórios ("Allow all actions and reusable workflows", ou incluir `eunadai/ci` na lista).
2. **Criar `.github/workflows/portao.yml`:**

   ```yaml
   name: Portão
   on:
     # pull_request_target roda o caller como ele está na base: um PR não muda o caller do próprio run.
     pull_request_target:
       branches: [main]
       types: [opened, synchronize, reopened, edited, labeled, unlabeled, ready_for_review]
     workflow_dispatch:
       inputs:
         pr: { description: Número do PR, type: number, required: true }
         sha: { description: SHA do head do PR, type: string, required: false }
   concurrency:
     # Um grupo por PR. O disparo manual e o `edited` sem troca de base (que o portão pula) ficam num
     # grupo só deles: nunca cancelam um run de verdade, nem são cancelados.
     group: portao-${{ (github.event.action == 'edited' && !github.event.changes.base) && github.run_id || github.event.pull_request.number || github.run_id }}
     cancel-in-progress: true
   permissions:
     contents: read
   jobs:
     portao:
       permissions:
         contents: read
         pull-requests: write
         issues: write
         statuses: write
       uses: eunadai/ci/.github/workflows/portao.yml@v1
       with:
         pr: ${{ format('{0}', inputs.pr) }}
         sha: ${{ inputs.sha }}
   ```

   O `pull_request_target` é seguro aqui porque o portão não baixa nem roda nada do PR: ele só lê o PR pela API. Ele não serve para o `seguranca.yml`, que roda as ferramentas no código do PR. O `edited` faz o portão rodar de novo quando o PR muda de base, e só nesse caso. Um caller antigo, com `pull_request`, continua funcionando.

   Depois, criar o `.github/portao.json` com as regras que fazem sentido para o repo (veja abaixo).
3. **Criar a label de aprovação**, se o repo usar a regra de tamanho: `gh label create aprovado-nadai`.

Se o repo exige checks por ruleset, exija o contexto **`portao`** (o commit status), não o check do job (`portao / portao`).

### Status que só o portão grava (opcional, GitHub App)

Sem isto, qualquer workflow com `statuses: write` consegue gravar um status `portao`, inclusive um workflow novo adicionado no próprio PR. Com um GitHub App do portão, o ruleset passa a exigir o `portao` **vindo do App**. A chave do App fica num environment que só o branch padrão alcança: um workflow do PR roda em outra ref, não lê a chave, e um status que ele grave não libera o merge.

1. Criar um GitHub App na sua conta com uma permissão só, **Commit statuses: Read and write**, sem webhook, e instalar no repo. Anotar o *Client ID* e gerar uma chave privada.
2. No repo, criar o environment `portao` com **Deployment branches and tags → Selected branches: `main`**, e guardar a chave nele como o secret `PORTAO_APP_KEY`.
3. No caller acima, passar o App e o environment:

   ```yaml
       uses: eunadai/ci/.github/workflows/portao.yml@v1
       with:
         pr: ${{ format('{0}', inputs.pr) }}
         sha: ${{ inputs.sha }}
         ambiente: portao
         app-client-id: <Client ID do App>
       secrets:
         PORTAO_APP_KEY: ${{ secrets.PORTAO_APP_KEY }}
   ```

4. No ruleset, na checagem `portao`, trocar a origem de "any source" para o App.

Um disparo manual precisa rodar no branch padrão, onde o environment deixa: `gh workflow run portao.yml --ref main -f pr=<n> -f sha=<head do PR>`. O `sha` garante que um disparo para um head que já mudou nunca aprova o head novo. Com o App, o disparo roda no branch base do PR e o `sha` é obrigatório na prática: um disparo em outro branch, ou sem `sha` fora do branch do PR, reprova sem tocar no PR (nem comentário, nem status); por isso, com o App, um PR cuja base não é o branch padrão não pode ser disparado (a chave só chega ao branch padrão, e o run tem de estar na base do PR). Se o caller pede o App e o token não sai (chave errada, App fora do repo), o portão reprova dizendo o que conferir.

## Regras (`.github/portao.json`)

Nenhuma regra fica ligada sem config. O arquivo é lido do **branch base** do PR. Por isso, mudar o config num PR só vale depois do merge, e o PR não consegue afrouxar o próprio portão. Um PR que mexe no `portao.json` ou em qualquer arquivo de `.github/workflows/` recebe um aviso de "olho humano" no comentário: qualquer workflow pode gravar o status `portao`. Para que só o portão consiga, veja "Status que só o portão grava".

| Campo | O que faz |
|---|---|
| `tamanho.limite` | Máximo de linhas de lógica (adições + remoções) por PR. |
| `tamanho.ignorar` | Globs que não contam, somados ao padrão: docs, markdown, testes, gerados, lockfiles, JSON de dados e binários. `package.json` e `tsconfig*.json` sempre contam. |
| `tamanho.labelAprovado` | A label que libera o limite (padrão `aprovado-nadai`). Ela só vale se quem a aplicou foi o dono do repo. |
| `tamanho.aprovadores` | Lista (não vazia) de logins do GitHub cuja label libera o limite. Sem o campo, só vale a label aplicada pelo dono do repo. Em repo de organização o dono é a org, que nunca aplica uma label: liste ali as pessoas. Os logins comparam sem diferenciar maiúsculas. Uma lista vazia é config inválida, nunca «qualquer um». |
| `soDocs` | Globs de documentação: um PR que só mexe nesses arquivos passa. |
| `isento` | `{ headRef, autor }`: o PR com essa branch **e** esse autor passa (ex.: «Versão nova» do changesets). |

Exemplo:

```json
{
  "tamanho": { "limite": 400, "ignorar": ["prototipo/**"], "labelAprovado": "aprovado-nadai", "aprovadores": ["fulana", "beltrano"] },
  "soDocs": ["docs/**", "**/*.md"],
  "isento": { "headRef": "changeset-release/main", "autor": "github-actions[bot]" }
}
```

## CI Node (`ci-node.yml`)

Roda o CI de um repo Node **num job só**: uma vaga na fila e uma instalação por run. Depois disso, cada script do `package.json` roda como um passo próprio. Um script que não existe é pulado com aviso no summary.

```yaml
jobs:
  ci:
    uses: eunadai/ci/.github/workflows/ci-node.yml@v1
    with:
      runner: '["ubuntu-latest"]'
      scripts: '["typecheck","lint","test"]'
      env: '{"CI":"true"}'
```

Sem `runner`, o job roda em `["self-hosted","macOS"]` (o padrão do input). Em repo público, passe `runner` com uma máquina do GitHub: o padrão `self-hosted` rodaria código de PR de fork na máquina do runner.

Só `typecheck`, `lint` e `test` viram passo, nessa ordem. Outro nome em `scripts` gera um aviso e não roda: use um job próprio.

## CI Python (`ci-python.yml`)

Roda o CI de um repo Python **num job só**: uma instalação por run, e depois cada comando como um grupo próprio. A instalação segue o que o repo tem: `uv.lock` → `uv sync --frozen`; senão `pyproject.toml` → `pip install -e .` (com o extra `dev`, se o projeto declarar um); senão `requirements.txt` → `pip install -r`. O Python vem do `.python-version` do repo, ou do input `python-version` (padrão `3.12`).

```yaml
jobs:
  ci:
    uses: eunadai/ci/.github/workflows/ci-python.yml@v1
    with:
      comandos: '["python -B -m unittest discover -s tests -t .", "python -m meu_pacote verify"]'
      env: '{"CI":"true"}'
```

Todos os comandos rodam, mesmo depois de um falhar, para que um run mostre todos os vermelhos; o job falha se algum falhou, e o resumo diz qual. Sem `comandos`, roda `python -m pytest`. O padrão do `runner` já é uma máquina do GitHub (`["ubuntu-latest"]`). Num repo com Git LFS, passe `lfs: true`: os arquivos vêm junto e ficam no cache do Actions entre os runs, e só o que mudou é baixado de novo.

## Suíte agendada só quando há mudança (`changes-since-green.yml` e `failure-issue.yml`)

Para uma suíte lenta (um e2e completo) que roda agendada, e não a cada PR. `changes-since-green.yml` acha o último run verde do próprio workflow na branch padrão e diz se algo mudou desde aquele commit: mudança só em `docs/` ou em `*.md` não conta (input `ignore`, uma lista JSON de regex). Sem run verde anterior, roda. No disparo manual, roda sempre. `failure-issue.yml` abre uma issue quando o run falha, com o link do run e os commits que entraram desde o último verde; se a issue já está aberta, comenta nela; quando volta a passar, fecha.

```yaml
name: e2e agendado
on:
  schedule:
    - cron: '0 6 * * 1,3,5' # segunda, quarta e sexta, 3h em Brasília
  workflow_dispatch:
permissions:
  contents: read
jobs:
  changes:
    permissions:
      contents: read
      actions: read
    uses: eunadai/ci/.github/workflows/changes-since-green.yml@v1
  e2e:
    needs: changes
    if: needs.changes.outputs.changed == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "a suíte do projeto"
  notice:
    needs: [changes, e2e]
    if: always()
    permissions:
      contents: read
      issues: write
    uses: eunadai/ci/.github/workflows/failure-issue.yml@v1
    with:
      result: ${{ needs.e2e.result }}
      base: ${{ needs.changes.outputs.base }}
```

Um run pulado por falta de mudança termina verde, e um run que falhou continua rodando nos dias seguintes até passar, comentando na mesma issue.

## Segurança (`seguranca.yml`)

Roda três ferramentas de código aberto nas máquinas do GitHub (`ubuntu-latest`), sem code scanning:

- **OSV-Scanner:** dependências com vulnerabilidade conhecida, pelos lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `requirements*.txt`);
- **Semgrep CE:** padrões inseguros no código, com as regras do registry (padrão `p/default`), baixadas a cada run;
- **gitleaks:** segredos nos commits do PR, com `--redact` (o valor de um segredo nunca aparece).

Num PR, só conta o que o diff introduziu: o que já existia na base não aparece. O resultado vai para o summary do run, para anotações nos arquivos e para o commit status **`seguranca`** no head do PR. Por padrão, **só avisa**: o status fica `success` com "N achados novos (só aviso)". Com `bloquear: true`, um achado novo (ou uma ferramenta que não rodou) dá `failure` e um comentário fixo no PR dizendo o quê.

**Num PR em rascunho, o Semgrep não roda** (é a etapa mais cara); o OSV e o gitleaks rodam sempre. Quando o PR sai do rascunho (`ready_for_review`), o run completo acontece.

Criar `.github/workflows/seguranca.yml` no projeto:

```yaml
name: Segurança
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  # Opcional: varredura completa semanal e manual (só summary e anotações, sem status).
  schedule:
    - cron: '0 9 * * 1'
  workflow_dispatch:
concurrency:
  group: seguranca-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  seguranca:
    permissions:
      contents: read
      statuses: write
      # pull-requests: write   # só com bloquear: true, para o comentário
    uses: eunadai/ci/.github/workflows/seguranca.yml@v1
    # with:
    #   bloquear: true
    #   ferramentas: '["semgrep","gitleaks"]'
```

Para exigir a segurança num ruleset, use `bloquear: true` e exija o contexto **`seguranca`** (o commit status).

| Input | Padrão | O que faz |
|---|---|---|
| `ferramentas` | `'["osv","semgrep","gitleaks"]'` | Quais rodar. Um projeto sem lockfile pode tirar o `osv`. |
| `bloquear` | `false` | `false`: os achados só avisam. `true`: achado novo reprova (status `failure`, comentário e código de saída diferente de zero). |
| `escopo` | `''` | `''` decide pelo evento: `diff` num `pull_request`, `completo` nos outros (`schedule`, `workflow_dispatch`, `push`). `diff` ou `completo` força. |
| `semgrep-config` | `p/default` | Os rulesets do Semgrep (registry ou caminho no repo, ex. `.semgrep/`), separados por espaço. Num PR, um caminho do repo vale como está na base. |
| `ci-ref` | `v1` | A ref deste repo de onde vem o `dist/seguranca.mjs`. |
| `timeout` | `10` | Minutos do job. |

### Falsos positivos

Cada ferramenta usa o próprio mecanismo, no repo do projeto. Num PR, esses arquivos valem **a partir do branch base**: um PR não consegue silenciar os próprios achados, e um PR que mexe neles, ou em qualquer workflow, recebe um aviso de "olho humano" no summary.

| Ferramenta | Como suprimir |
|---|---|
| OSV-Scanner | `osv-scanner.toml` na raiz: `[[IgnoredVulns]]` com `id`, `reason` e `ignoreUntil` (ponha sempre uma data de validade). |
| Semgrep | `// nosemgrep: <regra>` na linha, ou `.semgrepignore` para caminhos (fixtures, gerados). |
| gitleaks | `.gitleaksignore` com o fingerprint do achado (está no summary), ou `gitleaks:allow` na linha; regras próprias em `.gitleaks.toml`. |

Os comentários na linha (`nosemgrep`, `gitleaks:allow`) fazem parte do diff e ficam à vista na revisão.

O caller é a exceção: ele roda a partir do PR, então com `bloquear: true` um PR que edita o workflow caller desliga o check nesse PR. Por isso qualquer mudança em workflow recebe o aviso.

### Custo em minutos

Um job em `ubuntu-latest`, fora da fila do runner self-hosted. Estimativa por run de PR num repo pequeno a médio: **~1,5–3,5 min** (cobrado como 2–4 min, porque o GitHub arredonda por job), quase todo no Semgrep. Em repo público é grátis; em repo privado sai da cota do plano (2000 min/mês no Free). Para gastar menos: o `concurrency` com `cancel-in-progress` do exemplo, o Semgrep fora dos rascunhos, e tirar do `ferramentas` o que não se aplica.

As versões das ferramentas são fixas no `seguranca.yml` (os binários conferidos por SHA-256) e sobem por PR aqui.

## Identificadores em inglês (`identifiers.yml`)

Confere que o código novo dá nomes em inglês: componentes, variáveis, funções, tipos, arquivos, pastas, rotas, chaves de i18n, design tokens e eventos. Num PR, cada identificador que o diff **adiciona** é quebrado em palavras (camelCase, PascalCase, snake_case, kebab-case, dot.case), e uma palavra que o cspell não conhece em inglês mas conhece em pt-BR vira achado. A comparação ignora acento: `cartao` e `cartão` contam igual.

O que nunca entra:

- **comentários e strings com espaço** (texto, mensagem de log): o idioma deles é regra de cada projeto. Uma string sem espaço (chave, rota, nome de evento) é conferida;
- **arquivos de i18n, docs, markdown, lockfiles, gerados** (`locales/`, `i18n/`, `*.po`, `dist/`, `*.lock` e afins);
- **código legado**: um identificador que já existe na base, num arquivo que o check confere (código ou nome de arquivo; docs, markdown e i18n não valem), não conta, então chamar `calcularTotal()` de uma linha nova não é achado, mas criar `calcularFrete()` é;
- **palavra que o cspell não conhece em nenhum dos dois** (sigla, jargão, nome de marca): ela não é tratada como português.

Termos do domínio sem tradução já passam: `cpf`, `cnpj`, `cep`, `pix`, `boleto`, `nfe`, `nfse`. O resultado vai para o summary, para anotações nas linhas e para o commit status **`identifiers`** no head do PR. Por padrão, **só avisa**; com `block: true`, um identificador novo em português dá `failure`.

Criar `.github/workflows/identifiers.yml` no projeto:

```yaml
name: Identificadores
on:
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: identifiers-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  identifiers:
    permissions:
      contents: read
      statuses: write
    uses: eunadai/ci/.github/workflows/identifiers.yml@v1
    # with:
    #   block: true
```

Comece só avisando. Quando a lista de palavras do projeto estabilizar, ligue `block: true` e exija o contexto **`identifiers`** num ruleset.

| Input | Padrão | O que faz |
|---|---|---|
| `block` | `false` | `false`: os achados só avisam. `true`: identificador novo em português (ou o check que não rodou) reprova. |
| `ci-ref` | `v1` | A ref deste repo de onde vêm o `dist/identifiers.mjs` e o cspell. |
| `timeout` | `5` | Minutos do job. |

### Palavras e caminhos do projeto (`.github/identifiers.json`)

Opcional, e lido do **branch base** do PR: um PR não consegue liberar as próprias palavras. Uma palavra nova do domínio entra por um PR antes (ou no mesmo PR, só avisando).

```json
{
  "words": ["frete", "lojista"],
  "ignore": ["legacy/**", "supabase/migrations/**"]
}
```

| Campo | O que faz |
|---|---|
| `words` | Palavras que passam, além dos termos do domínio acima (sem diferença de caixa ou acento). |
| `ignore` | Globs que não são conferidos, somados ao padrão. |

O cspell (10.4.0) e o dicionário pt-BR são fixos pelo `dist/identifiers/package-lock.json`, com hash de integridade, e sobem por PR aqui. Um run de PR leva poucos segundos depois da instalação.

## Clones locais em dia (`scripts/repo-sync.sh`)

Mantém os clones de uma máquina alinhados com o remoto, sem nunca mexer em trabalho em andamento. A cada execução, pergunta a cada remoto para onde apontam as refs (`git ls-remote`, sem baixar nada), faz `fetch --all --prune` só nos repos em que algo mudou e avança por fast-forward toda branch local que está **só atrás** do upstream. Rodando a cada 60 s, um merge chega à máquina em cerca de um minuto. A cada `REPO_SYNC_FULL_EVERY` segundos (padrão 600), uma passada completa busca todos de novo e tenta outra vez o que tinha sido pulado. Os repos rodam 8 de cada vez (`REPO_SYNC_JOBS`). O resto fica como está e vai para o log:

- branch com commits locais que o remoto não tem;
- branch aberta numa worktree ligada (como as de agentes);
- branch em checkout cujos arquivos não commitados seriam sobrescritos (o `merge --ff-only` para antes de tocar em qualquer coisa);
- repo com rebase, merge, cherry-pick ou bisect em andamento.

Nunca roda stash, reset, rebase ou force.

```sh
scripts/repo-sync.sh --dry-run      # mostra o que faria
scripts/repo-sync.sh                # roda uma vez
scripts/repo-sync.sh install 60     # macOS: agente do launchd a cada 60 s (o padrão)
scripts/repo-sync.sh uninstall
```

A lista de repos fica fora deste repo, em `~/.config/repo-sync/repos` (ou `REPO_SYNC_CONFIG`): um caminho ou glob por linha, `#` para comentário. Só contam raízes de clone (pasta com `.git`), então um glob como `~/code/*/*` pega clones novos sozinho. O log fica em `~/Library/Logs/repo-sync.log` no macOS (ou `REPO_SYNC_LOG`) e registra cada avanço e cada pulo ou falha uma vez, até mudar. Com `REPO_SYNC_NOTIFY=1` no `install`, cada pulo ou falha nova também vira notificação do macOS.

## Desenvolvimento

```sh
npm ci
npm test            # vitest + @effect/vitest
npm run typecheck
npm run build       # gera dist/portao.mjs, dist/seguranca.mjs e dist/identifiers.mjs (commitados)
```

O `dist/` é commitado, e o CI falha se ele estiver desatualizado em relação a `src/`.

### Lançar uma versão

Criar a tag no commit do `main` e enviar só ela:

```sh
git tag v1.x.y origin/main
git push origin v1.x.y
```

O `release.yml` faz o resto: confere que o commit está no `main`, roda o typecheck, os testes e o `check:dist`, cria a release com as notas geradas e move a `v1` para o mesmo commit. Se uma conferência falha, nada é criado nem movido: corrija, apague a tag (`git push origin :v1.x.y`) e envie de novo. A `v1` só anda se a tag nova for a maior da major, então um backport nunca a puxa para trás. Rodar de novo uma release que já existe não duplica nada.

O `GITHUB_TOKEN` não consegue apontar uma ref para um commit que muda `.github/workflows/`. Para a `v1` andar nesses casos, crie um GitHub App com **Contents** e **Workflows: Read and write**, instale no repo, guarde o *Client ID* na variável `RELEASE_APP_CLIENT_ID` do repo e a chave no secret `RELEASE_APP_KEY` do environment `release` (com **Deployment branches and tags** limitado às tags `v*`). Sem o App, o run tenta com o `GITHUB_TOKEN` e, se falhar, mostra o comando para mover à mão (`git tag -f v1 v1.x.y && git push -f origin v1`).

Uma versão que quebra quem chama é `v2.0.0`, nunca uma `v1` movida.
