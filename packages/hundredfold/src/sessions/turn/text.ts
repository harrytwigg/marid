/** How a turn renders itself into the transcript and the channel. */

export function shouldPersistFinalAssistantMessage(options: {
  resultText: string;
  quietPreempted: boolean;
}): boolean {
  if (options.quietPreempted) return false;
  return options.resultText.trim().length > 0;
}

export function formatEngineErrorAssistantMessage(error: string): string {
  return `Error: ${error}`;
}

/**
 * What a settled turn shows. An engine that answered wins; otherwise its error
 * is surfaced; a turn with neither shows nothing, rather than a placeholder
 * that reads like an answer.
 */
export function turnDisplayText(result: string | undefined, error?: string | null): string {
  if (result?.trim()) return result;
  return error ? formatEngineErrorAssistantMessage(error) : "";
}

/** When a usage limit is expected to lift, in the operator's local phrasing. */
export function formatResumeTime(resumeAt: Date | null | undefined): string | null {
  if (!resumeAt) return null;
  return resumeAt.toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
