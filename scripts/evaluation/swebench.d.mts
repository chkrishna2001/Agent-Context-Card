export interface OfficialSummary {
  completed: boolean;
  patchApplied?: boolean;
  resolved?: boolean;
  failToPass?: { success: number; failure: number };
  passToPass?: { success: number; failure: number };
}

export function sanitizePatch(text: string): string;
export function summarizeOfficialReport(
  reports: Array<{ data?: Record<string, unknown> }>,
  instanceId: string,
): OfficialSummary;
