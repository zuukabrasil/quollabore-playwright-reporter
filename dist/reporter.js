// src/env.ts
var DEFAULT_PORTAL_URL = "https://api.quollabore.com/qa-report";
function loadOptions(partial = {}) {
  const env = process.env;
  const portalUrl = partial.portalUrl ?? env.Q_PORTAL_URL ?? DEFAULT_PORTAL_URL;
  const token = partial.token ?? env.Q_INGEST_TOKEN ?? "";
  const projectId = partial.projectId ?? env.Q_PROJECT_ID ?? "";
  const environment = partial.environment ?? env.Q_ENV ?? "prod";
  const git_branch = env.GIT_BRANCH ?? env.GITHUB_REF_NAME ?? "";
  const git_commit_sha = env.GIT_COMMIT ?? env.GITHUB_SHA ?? "";
  const git_commit_msg = env.GIT_COMMIT_MSG ?? env.GITHUB_EVENT_HEAD_COMMIT_MESSAGE ?? "";
  const git_actor = env.GIT_ACTOR ?? env.GITHUB_ACTOR ?? "";
  const ci_job_id = env.CI_JOB_ID ?? env.GITHUB_RUN_ID ?? "";
  const parallelTotal = Number(partial.parallelTotal ?? env.PARALLEL_TOTAL ?? 1);
  const shardIndex = Number(partial.shardIndex ?? env.PW_SHARD ?? 0);
  if (!token) throw new Error("Q_INGEST_TOKEN n\xE3o definido");
  if (!projectId) throw new Error("Q_PROJECT_ID n\xE3o definido");
  return {
    portalUrl,
    token,
    projectId,
    environment,
    parallelTotal,
    shardIndex,
    ci_job_id,
    git_branch,
    git_commit_sha,
    git_commit_msg,
    git_actor
  };
}

// src/http.ts
async function send(portalUrl, token, payload) {
  const res = await fetch(portalUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`[quollabore] HTTP ${res.status}: ${text}`);
  }
  return res.json().catch(() => ({}));
}

// src/reporter.ts
var QuollaboreReporter = class {
  runId = null;
  // spec(file path) -> suite_id
  suiteMap = /* @__PURE__ */ new Map();
  // spec(file path) -> stats
  suiteStats = /* @__PURE__ */ new Map();
  // TestCase -> case_id
  caseMap = /* @__PURE__ */ new Map();
  opts;
  constructor(options) {
    this.opts = loadOptions(options ?? {});
  }
  // ----------------- RUN START -----------------
  async onBegin(_config, _suite) {
    const {
      portalUrl,
      token,
      projectId,
      environment,
      parallelTotal,
      git_branch,
      git_commit_sha,
      git_commit_msg,
      git_actor,
      ci_job_id
    } = this.opts;
    try {
      const res = await send(portalUrl, token, {
        type: "run:start",
        run: {
          provider: "playwright",
          project_id: projectId,
          environment,
          ci_job_id,
          git_branch,
          git_commit_sha,
          git_commit_msg,
          git_actor,
          parallel_total: parallelTotal,
          status: "running"
        }
      });
      this.runId = String(res.run_id ?? "");
    } catch (err) {
      console.error("[Quollabore] run:start failed:", err);
      this.runId = null;
    }
  }
  // ----------------- CASE/SUITE START -----------------
  async onTestBegin(test) {
    if (!this.runId) return;
    const spec = test.location.file;
    let suiteId = this.suiteMap.get(spec);
    try {
      if (!suiteId) {
        const res = await send(this.opts.portalUrl, this.opts.token, {
          type: "suite:start",
          suite: {
            run_id: this.runId,
            name: spec,
            file_path: spec,
            shard_index: this.opts.shardIndex,
            status: "running"
          }
        });
        suiteId = String(res.suite_id ?? "");
        this.suiteMap.set(spec, suiteId);
        this.suiteStats.set(spec, { tests: 0, failures: 0, startedAt: Date.now() });
      }
      const stats = this.suiteStats.get(spec);
      if (stats) stats.tests += 1;
      const res2 = await send(this.opts.portalUrl, this.opts.token, {
        type: "case:start",
        test: {
          suite_id: suiteId,
          title: test.title,
          full_title: test.titlePath().join(" > "),
          status: "running",
          meta: { project: test.parent?.project()?.name }
        }
      });
      this.caseMap.set(test, String(res2.case_id ?? ""));
    } catch (err) {
      console.error("[Quollabore] suite/case start failed:", err);
    }
  }
  // ----------------- CASE UPDATE (steps) -----------------
  // Manda updates leves com o passo atual (nome e categoria) — opcional
  onStepBegin(test, _result, step) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    if (!step.category || !step.title) return;
    send(this.opts.portalUrl, this.opts.token, {
      type: "case:update",
      case_id: caseId,
      patch: {
        last_step: { title: step.title, category: step.category }
      }
    }).catch(() => {
    });
  }
  onStepEnd(test, _result, step) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    if (!step.category || !step.title) return;
    send(this.opts.portalUrl, this.opts.token, {
      type: "case:update",
      case_id: caseId,
      patch: {
        last_step: { title: step.title, category: step.category, ended: true }
      }
    }).catch(() => {
    });
  }
  // ----------------- LOGS -----------------
  onStdOut(chunk, test, _result) {
    if (!test) return;
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (!message?.trim()) return;
    send(this.opts.portalUrl, this.opts.token, {
      type: "log",
      case_id: caseId,
      level: "info",
      message
    }).catch(() => {
    });
  }
  onStdErr(chunk, test, _result) {
    if (!test) return;
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    const message = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (!message?.trim()) return;
    send(this.opts.portalUrl, this.opts.token, {
      type: "log",
      case_id: caseId,
      level: "error",
      message
    }).catch(() => {
    });
  }
  // ----------------- CASE FINISH (+ ARTIFACTS) -----------------
  async onTestEnd(test, result) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    const status = result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";
    const spec = test.location.file;
    const s = this.suiteStats.get(spec);
    if (s && status === "failed") s.failures += 1;
    if (Array.isArray(result.attachments)) {
      for (const a of result.attachments) {
        const storage_path = a.path;
        if (storage_path) {
          try {
            await send(this.opts.portalUrl, this.opts.token, {
              type: "artifact",
              case_id: caseId,
              artifact: {
                type: a.name ?? a.contentType ?? "attachment",
                storage_path
              }
            });
          } catch (err) {
            console.error("[Quollabore] artifact send failed:", err);
          }
        }
      }
    }
    try {
      await send(this.opts.portalUrl, this.opts.token, {
        type: "case:finish",
        case_id: caseId,
        status,
        duration_ms: result.duration,
        error: result.error ? { message: result.error.message, stack: result.error.stack } : void 0
      });
    } catch (err) {
      console.error("[Quollabore] case:finish failed:", err);
    }
  }
  // ----------------- RUN/SUITE FINISH -----------------
  async onEnd(result) {
    for (const [spec, suiteId] of this.suiteMap.entries()) {
      const s = this.suiteStats.get(spec);
      const durationMs = s ? Date.now() - s.startedAt : void 0;
      const status = !s ? "passed" : s.failures > 0 ? "failed" : s.tests === 0 ? "skipped" : "passed";
      try {
        await send(this.opts.portalUrl, this.opts.token, {
          type: "suite:finish",
          suite_id: suiteId,
          status,
          duration_ms: durationMs
        });
      } catch (err) {
        console.error("[Quollabore] suite:finish failed:", err);
      }
    }
    try {
      await send(this.opts.portalUrl, this.opts.token, {
        type: "run:finish",
        run_id: this.runId,
        status: result.status === "passed" ? "passed" : "failed",
        stats: { status: result.status }
      });
    } catch (err) {
      console.error("[Quollabore] run:finish failed:", err);
    }
  }
};
var reporter_default = QuollaboreReporter;
export {
  QuollaboreReporter,
  reporter_default as default
};
