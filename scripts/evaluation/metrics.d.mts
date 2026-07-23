/* eslint-disable @typescript-eslint/no-explicit-any -- Declaration shim for dependency-free JavaScript metrics. */

export interface JsonLinesResult {
  records: any[];
  errors: Array<{ line: number; detail: string; text: string }>;
}

export function parseJsonLines(text: string): JsonLinesResult;
export function analyzeTrace(text: string, durationMs?: number): any;
export function analyzeSession(text: string): any;
export function analyzeSessionFiles(paths: string[]): Promise<any[]>;
export function aggregateTurns(turns: any[]): any;
export function summarizeAudits(sessions: any[]): any;
export function distribution(values: number[]): any;
export function summarizeRepeatedRuns(runs: any[]): any;
export function percentChange(
  baseline: number,
  candidate: number,
): number | undefined;
