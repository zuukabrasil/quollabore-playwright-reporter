// src/reporter.ts
import fs from "fs";
import path from "path";

// src/env.ts
var DEFAULT_PORTAL_URL = "https://report-api.quollabore.com/";
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
var ALLOWED_ARTIFACT_TYPES = {
  screenshot: true,
  video: true,
  trace: true
  // adicione aqui se o CHECK no banco permitir mais tipos
  // ex.: stdout: true, stderr: true,
};
function mapAttachmentType(a) {
  const n = (a.name || "").toLowerCase();
  const ct = (a.contentType || "").toLowerCase();
  if (n.includes("screenshot") || ct.startsWith("image/")) return "screenshot";
  if (n.includes("video") || ct.startsWith("video/")) return "video";
  if (n.includes("trace") || ct.includes("zip")) return "trace";
  return null;
}
function pad(n) {
  return "  ".repeat(Math.max(0, n));
}
function serializeSteps(step, depth = 0) {
  const parts = [];
  const title = step.title ?? "(step)";
  const cat = step.category ? `[${step.category}] ` : "";
  const dur = typeof step.duration === "number" ? ` (${step.duration}ms)` : "";
  parts.push(`${pad(depth)}\u2022 ${cat}${title}${dur}`);
  if (step.error?.message) {
    parts.push(`${pad(depth + 1)}\u21B3 error: ${step.error.message}`);
  }
  for (const child of step.steps ?? []) {
    parts.push(serializeSteps(child, depth + 1));
  }
  return parts.join("\n");
}
function buildCallLogFromResult(result) {
  const roots = result.steps ?? [];
  if (!roots.length) return "";
  const lines = [];
  lines.push("[Call Log]");
  for (const s of roots) lines.push(serializeSteps(s, 0));
  return lines.join("\n");
}
var LOG_CHUNK_SIZE = 16e3;
function chunkString(s, size = LOG_CHUNK_SIZE) {
  if (!s) return [];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
async function sendBigLog(portalUrl, token, caseId, level, title, body) {
  const chunks = chunkString(body);
  if (!chunks.length) return;
  let idx = 1;
  for (const part of chunks) {
    await send(portalUrl, token, {
      type: "log",
      case_id: caseId,
      level,
      message: `${title} [${idx}/${chunks.length}]
${part}`
    });
    idx++;
  }
}
function safeFilename(s) {
  return s.replace(/[^\w.-]+/g, "_").slice(0, 120);
}
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function saveFailureLogToFile(test, full) {
  try {
    const outDir = path.join(process.cwd(), "test-results", "quollabore-logs");
    ensureDir(outDir);
    const spec = path.basename(test.location.file);
    const title = safeFilename(test.titlePath().join(" > "));
    const file = path.join(outDir, `${spec}__${title}.log.txt`);
    fs.writeFileSync(file, full, "utf-8");
    return file;
  } catch {
    return null;
  }
}
function buildFullErrorText(test, result, so, se) {
  const parts = [];
  if (result.error) {
    const msg = result.error.message ?? "";
    const stack = result.error.stack ?? "";
    parts.push(["[Primary Error Message]", msg].filter(Boolean).join("\n"));
    if (stack) parts.push(["[Primary Error Stack]", stack].join("\n"));
  }
  const moreErrors = result.errors;
  if (Array.isArray(moreErrors) && moreErrors.length) {
    moreErrors.forEach((e, i) => {
      const em = e?.message ?? "";
      const es = e?.stack ?? "";
      parts.push([`[Error ${i + 1} Message]`, em].filter(Boolean).join("\n"));
      if (es) parts.push([`[Error ${i + 1} Stack]`, es].join("\n"));
    });
  }
  const callLog = buildCallLogFromResult(result);
  if (callLog) parts.push(callLog);
  if (so.trim()) parts.push(["[stdout]", so].join("\n"));
  if (se.trim()) parts.push(["[stderr]", se].join("\n"));
  const attachmentLines = [];
  for (const a of result.attachments ?? []) {
    const p = a.path;
    if (p) {
      const n = a.name || a.contentType || "attachment";
      attachmentLines.push(`- ${n}: ${p}`);
    }
  }
  if (attachmentLines.length) parts.push(["[Attachments]", ...attachmentLines].join("\n"));
  return parts.filter(Boolean).join("\n\n");
}
var QuollaboreReporter = class {
  runId = null;
  // spec(file path) -> suite_id
  suiteMap = /* @__PURE__ */ new Map();
  // spec(file path) -> stats
  suiteStats = /* @__PURE__ */ new Map();
  // TestCase -> case_id
  caseMap = /* @__PURE__ */ new Map();
  // buffers de stdout/stderr por teste (para log final)
  stdoutBuf = /* @__PURE__ */ new Map();
  stderrBuf = /* @__PURE__ */ new Map();
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
            // ok mesmo sem sharding (0 default)
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
      this.stdoutBuf.set(test, []);
      this.stderrBuf.set(test, []);
    } catch (err) {
      console.error("[Quollabore] suite/case start failed:", err);
    }
  }
  // ----------------- CASE UPDATE (steps) -----------------
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
  // ----------------- LOGS (bufferizados) -----------------
  onStdOut(chunk, test) {
    if (!test) return;
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (!s.trim()) return;
    const arr = this.stdoutBuf.get(test) ?? [];
    arr.push(s);
    this.stdoutBuf.set(test, arr);
  }
  onStdErr(chunk, test) {
    if (!test) return;
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    if (!s.trim()) return;
    const arr = this.stderrBuf.get(test) ?? [];
    arr.push(s);
    this.stderrBuf.set(test, arr);
  }
  // ----------------- CASE FINISH (+ ARTIFACTS + SALVAR LOG COMPLETO EM error_stack) -----------------
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
        if (!storage_path) continue;
        const mapped = mapAttachmentType(a);
        if (!mapped || !ALLOWED_ARTIFACT_TYPES[mapped]) continue;
        try {
          await send(this.opts.portalUrl, this.opts.token, {
            type: "artifact",
            case_id: caseId,
            artifact: { type: mapped, storage_path }
          });
        } catch (err) {
          console.error("[Quollabore] artifact send failed:", err);
        }
      }
    }
    const so = (this.stdoutBuf.get(test) ?? []).join("");
    const se = (this.stderrBuf.get(test) ?? []).join("");
    let errorPayload = void 0;
    if (result.error) {
      const shortMsg = String(result.error.message || "").split("\n")[0] || "Error";
      const fullText = buildFullErrorText(test, result, so, se);
      errorPayload = { message: shortMsg, stack: fullText };
      try {
        await sendBigLog(
          this.opts.portalUrl,
          this.opts.token,
          caseId,
          "error",
          "Playwright Failure",
          fullText
        );
      } catch (e) {
        console.error("[Quollabore] send failure log failed:", e);
      }
      const file = saveFailureLogToFile(test, fullText);
      if (file) {
        try {
          await send(this.opts.portalUrl, this.opts.token, {
            type: "artifact",
            case_id: caseId,
            artifact: { type: "trace", storage_path: file }
          });
        } catch (e) {
          console.error("[Quollabore] failure-log artifact failed:", e);
        }
      }
    }
    this.stdoutBuf.delete(test);
    this.stderrBuf.delete(test);
    try {
      await send(this.opts.portalUrl, this.opts.token, {
        type: "case:finish",
        case_id: caseId,
        status,
        duration_ms: result.duration,
        error: errorPayload
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
