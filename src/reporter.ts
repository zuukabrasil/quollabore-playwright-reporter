// reporters/quollabore.playwright.ts
import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  TestStep,
  FullResult,
} from '@playwright/test/reporter';

import { loadOptions, QuollaboreOptions } from './env';
import { send } from './http';

type SuiteStats = { tests: number; failures: number; startedAt: number };

export class QuollaboreReporter implements Reporter {
  private runId: string | null = null;

  // spec(file path) -> suite_id
  private suiteMap = new Map<string, string>();
  // spec(file path) -> stats
  private suiteStats = new Map<string, SuiteStats>();

  // TestCase -> case_id
  private caseMap = new Map<TestCase, string>();

  private opts!: ReturnType<typeof loadOptions>;

  constructor(options?: QuollaboreOptions) {
    this.opts = loadOptions(options ?? {});
  }

  // ----------------- RUN START -----------------
  async onBegin(_config: FullConfig, _suite: Suite) {
    const {
      portalUrl, token, projectId, environment, parallelTotal,
      git_branch, git_commit_sha, git_commit_msg, git_actor, ci_job_id
    } = this.opts;

    try {
      const res: any = await send(portalUrl, token, {
        type: 'run:start',
        run: {
          provider: 'playwright',
          project_id: projectId,
          environment,
          ci_job_id,
          git_branch, git_commit_sha, git_commit_msg, git_actor,
          parallel_total: parallelTotal,
          status: 'running',
        }
      });
      this.runId = String(res.run_id ?? '');
    } catch (err) {
      // Não interrompe execução
      // eslint-disable-next-line no-console
      console.error('[Quollabore] run:start failed:', err);
      this.runId = null;
    }
  }

  // ----------------- CASE/SUITE START -----------------
  async onTestBegin(test: TestCase) {
    if (!this.runId) return;

    const spec = test.location.file; // string
    let suiteId = this.suiteMap.get(spec);

    try {
      if (!suiteId) {
        const res: any = await send(this.opts.portalUrl, this.opts.token, {
          type: 'suite:start',
          suite: {
            run_id: this.runId,
            name: spec,
            file_path: spec,
            shard_index: this.opts.shardIndex,
            status: 'running',
          }
        });
        suiteId = String(res.suite_id ?? '');
        this.suiteMap.set(spec, suiteId);
        this.suiteStats.set(spec, { tests: 0, failures: 0, startedAt: Date.now() });
      }

      // contabiliza teste da suite
      const stats = this.suiteStats.get(spec);
      if (stats) stats.tests += 1;

      const res2: any = await send(this.opts.portalUrl, this.opts.token, {
        type: 'case:start',
        test: {
          suite_id: suiteId,
          title: test.title,
          full_title: test.titlePath().join(' > '),
          status: 'running',
          meta: { project: test.parent?.project()?.name }
        }
      });
      this.caseMap.set(test, String(res2.case_id ?? ''));
    } catch (err) {
      console.error('[Quollabore] suite/case start failed:', err);
    }
  }

  // ----------------- CASE UPDATE (steps) -----------------
  // Manda updates leves com o passo atual (nome e categoria) — opcional
  onStepBegin?(test: TestCase, _result: TestResult, step: TestStep) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    // Evita floodar com steps internos do Playwright (como hooks)
    if (!step.category || !step.title) return;

    send(this.opts.portalUrl, this.opts.token, {
      type: 'case:update',
      case_id: caseId,
      patch: {
        last_step: { title: step.title, category: step.category }
      }
    }).catch(() => {});
  }

  onStepEnd?(test: TestCase, _result: TestResult, step: TestStep) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    if (!step.category || !step.title) return;

    send(this.opts.portalUrl, this.opts.token, {
      type: 'case:update',
      case_id: caseId,
      patch: {
        last_step: { title: step.title, category: step.category, ended: true }
      }
    }).catch(() => {});
  }

  // ----------------- LOGS -----------------
  onStdOut?(chunk: string | Buffer, test?: TestCase, _result?: TestResult) {
    // Associa log ao case somente quando estiver em contexto de teste
    if (!test) return;
    const caseId = this.caseMap.get(test);
    if (!caseId) return;

    const message = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (!message?.trim()) return;

    send(this.opts.portalUrl, this.opts.token, {
      type: 'log',
      case_id: caseId,
      level: 'info',
      message,
    }).catch(() => {});
  }

  onStdErr?(chunk: string | Buffer, test?: TestCase, _result?: TestResult) {
    if (!test) return;
    const caseId = this.caseMap.get(test);
    if (!caseId) return;

    const message = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (!message?.trim()) return;

    send(this.opts.portalUrl, this.opts.token, {
      type: 'log',
      case_id: caseId,
      level: 'error',
      message,
    }).catch(() => {});
  }

  // ----------------- CASE FINISH (+ ARTIFACTS) -----------------
  async onTestEnd(test: TestCase, result: TestResult) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return; // segurança

    const status =
      result.status === 'passed' ? 'passed' :
      result.status === 'skipped' ? 'skipped' :
      'failed';

    // marca failures na suite
    const spec = test.location.file;
    const s = this.suiteStats.get(spec);
    if (s && status === 'failed') s.failures += 1;

    // artifacts por attachment.path (se houver)
    // Se você já fizer upload antes, troque para usar storage_path do upload.
    if (Array.isArray(result.attachments)) {
      for (const a of result.attachments) {
        // Preferimos arquivos em disco (path). Conteúdo inline (body) exigiria upload aqui.
        const storage_path = (a as any).path as string | undefined;
        if (storage_path) {
          try {
            await send(this.opts.portalUrl, this.opts.token, {
              type: 'artifact',
              case_id: caseId,
              artifact: {
                type: a.name ?? a.contentType ?? 'attachment',
                storage_path,
              }
            });
          } catch (err) {
            console.error('[Quollabore] artifact send failed:', err);
          }
        }
      }
    }

    try {
      await send(this.opts.portalUrl, this.opts.token, {
        type: 'case:finish',
        case_id: caseId,
        status,
        duration_ms: result.duration,
        error: result.error
          ? { message: result.error.message, stack: result.error.stack }
          : undefined
      });
    } catch (err) {
      console.error('[Quollabore] case:finish failed:', err);
    }
  }

  // ----------------- RUN/SUITE FINISH -----------------
  async onEnd(result: FullResult) {
    // fecha todas as suites antes do run:finish
    for (const [spec, suiteId] of this.suiteMap.entries()) {
      const s = this.suiteStats.get(spec);
      const durationMs = s ? (Date.now() - s.startedAt) : undefined;
      const status =
        !s ? 'passed' :
        s.failures > 0 ? 'failed' :
        s.tests === 0 ? 'skipped' : 'passed';

      try {
        await send(this.opts.portalUrl, this.opts.token, {
          type: 'suite:finish',
          suite_id: suiteId,
          status,
          duration_ms: durationMs,
        });
      } catch (err) {
        console.error('[Quollabore] suite:finish failed:', err);
      }
    }

    try {
      await send(this.opts.portalUrl, this.opts.token, {
        type: 'run:finish',
        run_id: this.runId,
        status: result.status === 'passed' ? 'passed' : 'failed',
        stats: { status: result.status }
      });
    } catch (err) {
      console.error('[Quollabore] run:finish failed:', err);
    }
  }
}

export default QuollaboreReporter;
