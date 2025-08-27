import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test';
import { loadOptions, QuollaboreOptions } from './env';
import { send } from './http';

export class QuollaboreReporter implements Reporter {
  private runId: string | null = null;
  private suiteMap = new Map<string, string>();
  private caseMap = new Map<TestCase, string>();
  private opts!: ReturnType<typeof loadOptions>;

  constructor(options?: QuollaboreOptions) {
    this.opts = loadOptions(options ?? {});
  }

  async onBegin(_config, _suite) {
    const { portalUrl, token, projectId, environment, parallelTotal,
      git_branch, git_commit_sha, git_commit_msg, git_actor, ci_job_id } = this.opts;

    const res: any = await send(portalUrl, token, {
      type: 'run:start',
      run: {
        provider: 'playwright',
        project_id: projectId,
        environment,
        ci_job_id,
        git_branch, git_commit_sha, git_commit_msg, git_actor,
        parallel_total: parallelTotal,
        status: 'running'
      }
    });
    this.runId = res.run_id;
  }

  async onTestBegin(test: TestCase) {
    const spec = test.location.file;
    let suiteId = this.suiteMap.get(spec);
    if (!suiteId) {
      const res: any = await send(this.opts.portalUrl, this.opts.token, {
        type: 'suite:start',
        suite: {
          run_id: this.runId,
          name: spec,
          file_path: spec,
          shard_index: this.opts.shardIndex,
          status: 'running'
        }
      });
      suiteId = res.suite_id;
      this.suiteMap.set(spec, suiteId);
    }

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
    this.caseMap.set(test, res2.case_id);
  }

  async onTestEnd(test: TestCase, result: TestResult) {
    const caseId = this.caseMap.get(test)!;
    const status = result.status === 'passed' ? 'passed'
      : result.status === 'skipped' ? 'skipped'
      : 'failed';

    await send(this.opts.portalUrl, this.opts.token, {
      type: 'case:finish',
      case_id: caseId,
      status, duration_ms: result.duration,
      error: result.error ? { message: result.error.message, stack: result.error.stack } : undefined
    });
  }

  async onEnd(result: FullResult) {
    await send(this.opts.portalUrl, this.opts.token, {
      type: 'run:finish',
      run_id: this.runId,
      status: result.status === 'passed' ? 'passed' : 'failed',
      stats: { status: result.status }
    });
  }
}
export default QuollaboreReporter;
