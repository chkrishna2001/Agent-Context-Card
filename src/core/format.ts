import type { RuntimeCard } from "./types";

function addList(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`${title}:`);
  for (const value of values) lines.push(`- ${value}`);
}

export function formatContextCard(card: RuntimeCard): string {
  const lines = ["<context-card>", `TASK: ${card.goal || "(unset)"}`];
  if (card.latestRequest && card.latestRequest !== card.goal)
    lines.push(`LATEST REQUEST: ${card.latestRequest}`);
  if (card.plan) {
    lines.push(`PINNED PLAN (revision ${card.plan.revision}):`);
    for (const line of card.plan.content.split(/\r?\n/))
      lines.push(`  ${line}`);
  }

  addList(
    lines,
    "PROJECT CAPABILITIES",
    [
      card.capabilities.projectType
        ? `Type: ${card.capabilities.projectType}`
        : "",
      card.capabilities.packageName
        ? `Package: ${card.capabilities.packageName}${card.capabilities.packageManager ? ` (${card.capabilities.packageManager})` : ""}`
        : "",
      card.capabilities.documentation.length
        ? `Documentation: ${card.capabilities.documentation.join(", ")}`
        : "",
      card.capabilities.validation.length
        ? `Validation: ${card.capabilities.validation.join(", ")}`
        : "",
    ].filter(Boolean),
  );
  if (card.resumed) {
    if (card.resumed.repositoryChanged)
      lines.push(
        "REPOSITORY STATE CHANGED SINCE THE PRIOR SESSION; prior validations are historical.",
      );
    addList(
      lines,
      "PRIOR SESSION UNRESOLVED FAILURES",
      card.resumed.execution.failures.map((record) =>
        record.detail ? `${record.action} — ${record.detail}` : record.action,
      ),
    );
    addList(
      lines,
      "PRIOR SESSION VERIFIED FACTS",
      card.resumed.execution.changes.map((record) =>
        record.count > 1 ? `${record.action} ×${record.count}` : record.action,
      ),
    );
  }
  addList(
    lines,
    "UNRESOLVED FAILURES",
    card.execution.failures.map((record) =>
      record.detail ? `${record.action} — ${record.detail}` : record.action,
    ),
  );
  addList(
    lines,
    "VERIFIED CHANGES",
    card.execution.changes.map((record) =>
      record.count > 1 ? `${record.action} ×${record.count}` : record.action,
    ),
  );
  lines.push("</context-card>");
  return lines.join("\n");
}
