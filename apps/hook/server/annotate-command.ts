import {
  annotateOutcomeExitCode,
  serializeStrictAnnotateResult,
  STRICT_GATE_ERROR_EXIT_CODE,
  writeAnnotateResultFile,
  type AnnotateOutcome,
} from "./strict-annotate-result";

export interface CompleteAnnotateCommandOptions {
  waitForDecision: () => Promise<AnnotateOutcome>;
  settleAfterDecision: () => Promise<void>;
  stopServer: () => void;
  requireApproval: boolean;
  resultFile?: string;
  writeResultFile?: (
    resultFile: string,
    serialized: string,
  ) => Promise<void>;
  writeStdout?: (output: string) => Promise<void>;
  /** `reopenable`: the review stays open in its tab after this decision, which may be followed by another. */
  emitLegacyOutcome: (result: AnnotateOutcome, extra?: { reopenable: true }) => void;
  /**
   * The review loop (#1116): after a decision, the server's word on whether
   * the review stays reopenable in its tab (`afterDecision`); null: it does not.
   */
  afterDecision?: () => Promise<"reopened" | "over"> | null;
  exit?: (code: number) => void;
  logError?: (message: string) => void;
}

export function writeStdout(output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(output, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function completeAnnotateCommand({
  waitForDecision,
  settleAfterDecision,
  stopServer,
  requireApproval,
  resultFile,
  writeResultFile = writeAnnotateResultFile,
  writeStdout: outputWriter = writeStdout,
  emitLegacyOutcome,
  afterDecision,
  exit = process.exit,
  logError = (message) => console.error(message),
}: CompleteAnnotateCommandOptions): Promise<void> {
  let result = await waitForDecision();
  // The review loop: a review the person ended under it stays open in its tab, which may reopen it. Each
  // decision goes to the host as it comes (marked reopenable); the server stops once it can no longer be.
  for (let open = requireApproval || resultFile ? null : (afterDecision?.() ?? null); open; open = afterDecision?.() ?? null) {
    emitLegacyOutcome(result, { reopenable: true });
    if ((await open) === "over") {
      stopServer();
      exit(0);
      return;
    }
    result = await waitForDecision();
  }
  await settleAfterDecision();
  stopServer();

  if (requireApproval || resultFile) {
    const serialized = serializeStrictAnnotateResult(result);
    try {
      // stdout first: the reviewer's autosaved draft is already gone by the
      // time we get here, so their completed decision must reach at least one
      // channel before a result-file publication failure can abort the run.
      // Result-file publication is best-effort on top of that record.
      await outputWriter(`${serialized}\n`);
      if (resultFile) {
        await writeResultFile(resultFile, serialized);
      }
    } catch (error) {
      // The result file was not published (or stdout itself was unwritable):
      // an environment error, not a reviewer outcome. Exit 2 — fail-closed, but
      // distinct from exit 1's "gate ran and the reviewer did not approve".
      // The stdout decision record has already been emitted unless stdout was
      // the thing that failed.
      logError(error instanceof Error ? error.message : String(error));
      exit(STRICT_GATE_ERROR_EXIT_CODE);
      return;
    }
    exit(annotateOutcomeExitCode(result, requireApproval));
    return;
  }

  emitLegacyOutcome(result);
  exit(0);
}
