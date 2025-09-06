export type QuollaboreOptions = {
  portalUrl?: string;
  token?: string;
  projectId?: string;
  environment?: string;
  parallelTotal?: number;
  shardIndex?: number; 
};

const DEFAULT_PORTAL_URL = 'https://report-api.quollabore.com/';


export function loadOptions(partial: QuollaboreOptions = {}): Required<QuollaboreOptions> & {
  ci_job_id: string; git_branch: string; git_commit_sha: string; git_commit_msg: string; git_actor: string;
} {
  const env = process.env;
  const portalUrl   = partial.portalUrl ?? env.Q_PORTAL_URL ?? DEFAULT_PORTAL_URL;
  const token       = partial.token       ?? env.Q_INGEST_TOKEN ?? '';
  const projectId   = partial.projectId   ?? env.Q_PROJECT_ID   ?? '';
  const environment = partial.environment ?? env.Q_ENV          ?? 'prod';

  // Auto-detecção (GitHub Actions + fallbacks)
  const git_branch     = env.GIT_BRANCH ?? env.GITHUB_REF_NAME ?? '';
  const git_commit_sha = env.GIT_COMMIT ?? env.GITHUB_SHA      ?? '';
  const git_commit_msg = env.GIT_COMMIT_MSG ?? env.GITHUB_EVENT_HEAD_COMMIT_MESSAGE ?? '';
  const git_actor      = env.GIT_ACTOR ?? env.GITHUB_ACTOR ?? '';
  const ci_job_id      = env.CI_JOB_ID ?? env.GITHUB_RUN_ID ?? '';

  const parallelTotal = Number(partial.parallelTotal ?? env.PARALLEL_TOTAL ?? 1);
  const shardIndex    = Number(partial.shardIndex    ?? env.PW_SHARD ?? 0);

  if (!token)     throw new Error('Q_INGEST_TOKEN não definido');
  if (!projectId) throw new Error('Q_PROJECT_ID não definido');

  return { portalUrl, token, projectId, environment, parallelTotal, shardIndex,
    ci_job_id, git_branch, git_commit_sha, git_commit_msg, git_actor };
}
