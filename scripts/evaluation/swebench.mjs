export function sanitizePatch(text) {
  return text
    .split(/(?=^diff --git )/m)
    .filter(
      (section) => !section.startsWith("diff --git a/.agent-context-card/"),
    )
    .join("")
    .replaceAll("\r", "");
}

export function summarizeOfficialReport(reports, instanceId) {
  const official = reports
    .map((reportItem) => reportItem.data?.[instanceId])
    .find((value) => value !== undefined);
  if (!official) return { completed: false };
  const count = (group, status) =>
    official.tests_status?.[group]?.[status]?.length ?? 0;
  return {
    completed: true,
    patchApplied: official.patch_successfully_applied,
    resolved: official.resolved,
    failToPass: {
      success: count("FAIL_TO_PASS", "success"),
      failure: count("FAIL_TO_PASS", "failure"),
    },
    passToPass: {
      success: count("PASS_TO_PASS", "success"),
      failure: count("PASS_TO_PASS", "failure"),
    },
  };
}
