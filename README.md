## Quollabore Playwright Reporter

Envie resultados de testes **Playwright** para o **Portal Quollabore** com 1 linha no `playwright.config.ts`.  
O pacote intercepta os eventos do runner (before:run, after:spec, after:run), envia os dados da execução e, opcionalmente, pode enviar artifacts em versões futuras (vídeos, screenshots).

> Compatível com Node **\>= 18** (usa `fetch` nativo) e Playwright **\>= 10**.

---

## 📦 Instalação

**Com escopo (recomendado):**

`npm i -D quollabore-playwright-reporter # ou yarn add -D -quollabore-playwright-reporter`

---

## ⚙️ Configuração rápida

### `playwright.config.ts`

**Se publicou com escopo:**

```import { defineConfig } from 'playwright'; 
  import { withQuollabore } from 'quollabore-playwright-reporter'; 
  export default defineConfig({  
    e2e: {    
       setupNodeEvents: withQuollabore, // 1 linha: injeta todos os hooks necessários  
       }, 
    });
```

### Variáveis de ambiente (obrigatório)

Defina estas variáveis no seu **CI** (e opcionalmente localmente):

*   `Q_INGEST_TOKEN` → Token do **projeto/ambiente** (Bearer) para enviar reports.
*   `Q_PROJECT_ID` → UUID do projeto no Portal Quollabore.
*   `Q_ENV` (opcional) → ambiente lógico (`dev`, `staging`, `prod`, …). _default:_ `prod`.

O reporter também tenta **auto-detectar** dados do CI (branch, commit, actor, job id) a partir de variáveis padrão do **GitHub Actions**, **GitLab CI**, **Azure DevOps** e **Bitbucket**. Você pode sobrepor esses valores via ENV customizadas se quiser.

---

## 🧪 O que o reporter envia

Para cada execução, o reporter envia uma série de **eventos** para o seu portal:

*   `run:start` → início de execução
*   `suite:start` → início de cada spec executada
*   `case:start` → início de cada teste dentro da spec
*   `case:finish` → término de cada teste (status, duração, erro – se houver)
*   `suite:finish` → término da spec (status agregado, duração)
*   `run:finish` → término da execução (status agregado, métricas)

Campos de **Git/CI** preenchidos automaticamente (ou via ENV):

*   `git_branch`, `git_commit_sha`, `git_commit_msg`, `git_actor`, `ci_job_id`, `parallel_total` (se aplicável).

---

## 🧰 Opções avançadas (opcional)

Você pode passar opções diretamente ao `withQuollabore` para sobrescrever as ENVs:

```
import { defineConfig } from '@playwright/test';
import { QuollaboreReporter } from 'quollabore-playwright-reporter';

export default defineConfig({
  reporter: [
    ['list'],
    [QuollaboreReporter, {
      token: process.env.Q_INGEST_TOKEN,
      projectId: process.env.Q_PROJECT_ID,
      environment: process.env.Q_ENV ?? 'prod',
      parallelTotal: Number(process.env.PARALLEL_TOTAL ?? 1),
      shardIndex: Number(process.env.PW_SHARD ?? 0),
    }],
  ],
});
```

### Interface de opções
```
type QuollaboreOptions = {
  token?: string;        // default: process.env.Q_INGEST_TOKEN
  projectId?: string;    // default: process.env.Q_PROJECT_ID
  environment?: string;  // default: process.env.Q_ENV || 'prod'
  parallelTotal?: number;// default: process.env.PARALLEL_TOTAL || 1
  shardIndex?: number;   // default: process.env.PW_SHARD || 0
};
```

> Se você **não** passar nada, o reporter usa apenas as variáveis de ambiente.

---

## 🔐 Segurança

*   Use **token por projeto/ambiente**, nunca tokens pessoais.
*   Guarde `Q_INGEST_TOKEN` como **secret** no CI (GitHub/GitLab/Azure/Bitbucket).
*   A Edge Function deve **validar o Bearer** recebido (ideal: comparar **hash** em tabela de tokens).

---

## 🧭 Exemplos de CI

### GitHub Actions
```
name: e2e
on: [push]

jobs:
  playwright:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npx playwright install --with-deps
      - env:
          Q_INGEST_TOKEN: ${{ secrets.Q_INGEST_TOKEN }}
          Q_PROJECT_ID: ${{ secrets.Q_PROJECT_ID }}
          Q_ENV: prod
          PARALLEL_TOTAL: 4
          PW_SHARD: 0
        run: npx playwright test --shard=1/4

```

### GitLab CI
```
e2e:playwright:
  image: mcr.microsoft.com/playwright:v1.42.0-jammy
  script:
    - npm ci
    - npx playwright install --with-deps
    - npx playwright test
  variables:
    Q_INGEST_TOKEN: $Q_INGEST_TOKEN
    Q_PROJECT_ID: $Q_PROJECT_ID
    Q_ENV: "prod"

 
```

### Azure Pipelines
```
### Azure Pipelines

#### Exemplo simples (1 job)

```yaml
trigger:
  - main

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: '20.x'

  - script: npm ci
    displayName: Install deps

  - script: npx playwright install --with-deps
    displayName: Install Playwright browsers

  - script: npx playwright test
    displayName: Run Playwright
    env:
      # Quollabore (obrigatórios)
      Q_INGEST_TOKEN: $(Q_INGEST_TOKEN)
      Q_PROJECT_ID: $(Q_PROJECT_ID)
      Q_ENV: prod

      # CI/Git (auto-detect; opcional sobrescrever)
      CI_JOB_ID: $(Build.BuildId)
      GIT_BRANCH: $(Build.SourceBranchName)
      GIT_COMMIT: $(Build.SourceVersion)
      GIT_ACTOR: $(Build.RequestedFor)
      # GIT_COMMIT_MSG pode ser omitido ou preenchido via script se necessário

```

---

## ✅ Checklist de integração

*    Instalou o pacote (`-quollabore-playwright-reporter` **ou** `quollabore-playwright-reporter`)?
*   Adicionou `withQuollabore` no `cyplaywrightpress.config.ts`?
*   Definiu  `Q_INGEST_TOKEN`, `Q_PROJECT_ID` no CI?
*   Sua Edge Function está publicada e validando `Authorization: Bearer <token>`?
*   Tabelas `automation_*` criadas e com Realtime habilitado (se for usar live)?

---

## 🛠️ Troubleshooting

`**Q_INGEST_TOKEN não definido**` **/** `**Q_PROJECT_ID não definido**`  
→ Garanta que as variáveis estejam presentes no ambiente do job do CI (e não só no repositório local).

**HTTP 401/403**  
→ Token inválido/revogado ou a função não está aceitando o Bearer. Verifique a validação na Edge Function.

**HTTP 404/5xx**  
→ Função está fora do ar. Teste localmente com `curl` e verifique os logs do Supabase.

**Nada aparece no portal**  
→ Confirme se os eventos estão chegando (logs da função) e se as **FKs** (`automation_suites.run_id`, `automation_cases.suite_id`, etc.) batem com o schema.

---

## 🔄 Roadmap (ideias)

*   Upload opcional de **artifacts** (vídeos, screenshots) direto pelo reporter.
*   Flag `Q_DEBUG=1` para logs detalhados.
*   Comando `npx quollabore doctor` para validar conexão e ENVs.
*   Suporte a **retries** + marcação de **flaky** automaticamente.

---

## 🙋 Suporte

Encontrou um problema ou tem sugestão? Abra uma issue no repositório do projeto ou fale com o time do Quollabore.

---
