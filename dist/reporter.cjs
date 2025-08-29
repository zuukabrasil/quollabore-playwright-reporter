"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/reporter.ts
var reporter_exports = {};
__export(reporter_exports, {
  QuollaboreReporter: () => QuollaboreReporter,
  default: () => reporter_default
});
module.exports = __toCommonJS(reporter_exports);

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
  suiteMap = /* @__PURE__ */ new Map();
  caseMap = /* @__PURE__ */ new Map();
  opts;
  constructor(options) {
    this.opts = loadOptions(options ?? {});
  }
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
  }
  async onTestBegin(test) {
    const spec = test.location.file;
    let suiteId = this.suiteMap.get(spec);
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
    }
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
  }
  async onTestEnd(test, result) {
    const caseId = this.caseMap.get(test);
    if (!caseId) return;
    const status = result.status === "passed" ? "passed" : result.status === "skipped" ? "skipped" : "failed";
    await send(this.opts.portalUrl, this.opts.token, {
      type: "case:finish",
      case_id: caseId,
      status,
      duration_ms: result.duration,
      error: result.error ? { message: result.error.message, stack: result.error.stack } : void 0
    });
  }
  async onEnd(result) {
    await send(this.opts.portalUrl, this.opts.token, {
      type: "run:finish",
      run_id: this.runId,
      status: result.status === "passed" ? "passed" : "failed",
      stats: { status: result.status }
    });
  }
};
var reporter_default = QuollaboreReporter;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QuollaboreReporter
});
