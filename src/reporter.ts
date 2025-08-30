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

import fs from 'node:fs';
import path from 'node:path';

import { loadOptions, QuollaboreOptions } from './env';
import { send } from './http';

type SuiteStats = { tests: number; failures: number; startedAt: number };

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------
const ALLOWED_ARTIFACT_TYPES: Record<string, true> = {
  screenshot: true,
  video: true,
  trace: true,
  // adicione aqui se o CHECK no banco permitir mais tipos
  // ex.: stdout: true, stderr: true,
};

function mapAttachmentType(a: { name?: string; contentType?: string }): string | null {
  const n = (a.name || '').toLowerCase();
  const ct = (a.contentType || '').toLowerCase();

  if (n.includes('screenshot') || ct.startsWith('image/')) return 'screenshot';
  if (n.includes('video') || ct.startsWith('video/')) return 'video';
  if (n.includes('trace') || ct.includes('zip')) return 'trace';
  return null; // desconhecido -> não enviar (evita violar o CHECK)
}

// --- reconstrução do call log a partir dos steps ---
type StepLike = {
  title?: string;
  category?: string;
  error?: { message?: string } | null;
  steps?: StepLike[];
  duration?: number;
};

function pad(n: number) {
  return '  '.repeat(Math.max(0, n));
}

function serializeSteps(step: StepLike, depth = 0): string {
  const parts: string[] = [];
  const title = step.title ?? '(step)';
  const cat = step.category ? `[${step.category}] ` : '';
  const dur = typeof step.duration === 'number' ? ` (${step.duration}ms)` : '';
  parts.push(`${pad(depth)}• ${cat}${title}${dur}`);
  if (step.error?.message) {
    parts.push(`${pad(depth + 1)}↳ error: ${step.error.message}`);
  }
  for (const child of step.steps ?? []) {
    parts.push(serializeSteps(child, depth + 1));
  }
  return parts.join('\n');
}

function buildCallLogFromResult(result: TestResult): string {
  const roots: StepLike[] = (result as any).steps ?? [];
  if (!roots.length) return '';
  const lines: string[] = [];
  lines.push('[Call Log]');
  for (const s of roots) lines.push(serializeSteps(s, 0));
  return lines.join('\n');
}

// --- envio em chunks para não truncar ---
const LOG_CHUNK_SIZE = 16000; // aumentei um pouco
function chunkString(s: string, size = LOG_CHUNK_SIZE): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

async function sendBigLog(
  portalUrl: string,
  token: string,
  caseId: string,
  level: 'error' | 'info' | 'warn',
  title: string,
  body: string
) {
  const chunks = chunkString(body);
  if (!chunks.length) return;
  let idx = 1;
  for (const part of chunks) {
    await send(portalUrl, token, {
      type: 'log',
      case_id: caseId,
      level,
      message: `${title} [${idx}/${chunks.length}]\n${part}`,
    });
    idx++;
  }
}

// --- salvar arquivo de log completo e registrar como artifact ---
function safeFilename(s: string) {
  return s.replace(/[^\w.-]+/g, '_').slice(0, 120);
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function saveFailureLogToFile(test: TestCase, full: string): string | null {
  try {
    const outDir = path.join(process.cwd(), 'test-results', 'quollabore-logs');
    ensureDir(outDir);
    const spec = path.basename(test.location.file);
    const title = safeFilename(test.titlePath().join(' > '));
    const file = path.join(outDir, `${spec}__${title}.log.txt`);
    fs.writeFileSync(file, full, 'utf-8');
    return file;
  } catch {
    return null;
  }
}

// -----------------------------------------------------
// Reporter
// -----------------------------------------------------
export class QuollaboreReporter implements Reporter {
  private runId: string | null = null;

  // spec(file path) -> suite_id
  private suiteMap = new Map<string, string>();
  // spec(file path) -> stats
  private suiteStats = new Map<string, SuiteStats>();
  // TestCase -> case_id
  private caseMap = new Map<TestCase, string>();

  // buffers de stdout/stderr por teste (para log final)
  private stdoutBuf = new Map<TestCase, string[]>();
  private stderrBuf = new Map<TestCase, string[]>();

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
            shard_index: this.opts.shardIndex, // ok mesmo sem sharding (0 default)
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

      // inicia buffers de stdout/err
      this.stdoutBuf.set(test, []);
      this.stderrBuf.set(test, []);
    } catch (err) {
      console.error('[Quollabore] suite/case start failed:', err);
    }
  }

  // ----------------- CASE UPDATE (steps) -----------------
  onStepBegin?(test: TestCase, _result: TestResult, step: TestStep) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
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

  // ----------------- LOGS (bufferizados) -----------------
  onStdOut?(chunk: string | Buffer, test?: TestCase) {
    if (!test) return;
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (!s.trim()) return;
    const arr = this.stdoutBuf.get(test) ?? [];
    arr.push(s);
    this.stdoutBuf.set(test, arr);
  }

  onStdErr?(chunk: string | Buffer, test?: TestCase) {
    if (!test) return;
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (!s.trim()) return;
    const arr = this.stderrBuf.get(test) ?? [];
    arr.push(s);
    this.stderrBuf.set(test, arr);
  }

  // ----------------- CASE FINISH (+ ARTIFACTS + FAILURE LOG) -----------------
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
    if (Array.isArray(result.attachments)) {
      for (const a of result.attachments) {
        const storage_path = (a as any).path as string | undefined;
        if (!storage_path) continue;

        const mapped = mapAttachmentType(a);
        if (!mapped || !ALLOWED_ARTIFACT_TYPES[mapped]) continue;

        try {
          await send(this.opts.portalUrl, this.opts.token, {
            type: 'artifact',
            case_id: caseId,
            artifact: { type: mapped, storage_path }
          });
        } catch (err) {
          console.error('[Quollabore] artifact send failed:', err);
        }
      }
    }

    // --- LOG COMPLETO DE FALHA (inclui primary error, errors[], call log, stdout/stderr, attachments)
    if (status === 'failed') {
      const parts: string[] = [];

      // Primary error
      if (result.error) {
        const msg = result.error.message ?? '';
        const stack = result.error.stack ?? '';
        parts.push(['[Primary Error]', msg, stack].filter(Boolean).join('\n'));
      }

      // Erros adicionais (quando houver)
      const moreErrors = (result as any).errors as Array<{ message?: string; stack?: string }> | undefined;
      if (Array.isArray(moreErrors) && moreErrors.length) {
        moreErrors.forEach((e, i) => {
          const em = e?.message ?? '';
          const es = e?.stack ?? '';
          parts.push([`[Error ${i + 1}]`, em, es].filter(Boolean).join('\n'));
        });
      }

      // Call log dos steps
      const callLog = buildCallLogFromResult(result);
      if (callLog) parts.push(callLog);

      // stdout/stderr capturados
      const so = (this.stdoutBuf.get(test) ?? []).join('');
      const se = (this.stderrBuf.get(test) ?? []).join('');
      if (so.trim()) parts.push(['[stdout]', so].join('\n'));
      if (se.trim()) parts.push(['[stderr]', se].join('\n'));

      // paths de attachments úteis (screenshot, video, trace)
      const attachmentLines: string[] = [];
      for (const a of result.attachments ?? []) {
        const p = (a as any).path as string | undefined;
        if (p) {
          const n = (a.name || a.contentType || 'attachment');
          attachmentLines.push(`- ${n}: ${p}`);
        }
      }
      if (attachmentLines.length) parts.push(['[Attachments]', ...attachmentLines].join('\n'));

      const full = parts.filter(Boolean).join('\n\n');

      // envia para logs (chunked)
      try {
        await sendBigLog(
          this.opts.portalUrl,
          this.opts.token,
          caseId,
          'error',
          'Playwright Failure',
          full
        );
      } catch (e) {
        console.error('[Quollabore] send failure log failed:', e);
      }

      // salva também em arquivo e registra como artifact (garante 100% do texto)
      const file = saveFailureLogToFile(test, full);
      if (file) {
        try {
          await send(this.opts.portalUrl, this.opts.token, {
            type: 'artifact',
            case_id: caseId,
            artifact: { type: 'trace', storage_path: file },
          });
        } catch (e) {
          console.error('[Quollabore] failure-log artifact failed:', e);
        }
      }
    }

    // limpa buffers do teste
    this.stdoutBuf.delete(test);
    this.stderrBuf.delete(test);

    // case:finish
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
