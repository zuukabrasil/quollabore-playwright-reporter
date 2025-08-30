import { Reporter, FullConfig, Suite, TestCase, TestResult, TestStep, FullResult } from '@playwright/test/reporter';

type QuollaboreOptions = {
    portalUrl?: string;
    token?: string;
    projectId?: string;
    environment?: string;
    parallelTotal?: number;
    shardIndex?: number;
};

declare class QuollaboreReporter implements Reporter {
    private runId;
    private suiteMap;
    private suiteStats;
    private caseMap;
    private stdoutBuf;
    private stderrBuf;
    private opts;
    constructor(options?: QuollaboreOptions);
    onBegin(_config: FullConfig, _suite: Suite): Promise<void>;
    onTestBegin(test: TestCase): Promise<void>;
    onStepBegin?(test: TestCase, _result: TestResult, step: TestStep): void;
    onStepEnd?(test: TestCase, _result: TestResult, step: TestStep): void;
    onStdOut?(chunk: string | Buffer, test?: TestCase): void;
    onStdErr?(chunk: string | Buffer, test?: TestCase): void;
    onTestEnd(test: TestCase, result: TestResult): Promise<void>;
    onEnd(result: FullResult): Promise<void>;
}

export { QuollaboreReporter, QuollaboreReporter as default };
