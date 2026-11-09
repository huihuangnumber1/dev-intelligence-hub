const COUNT_FIELDS = [
  "total", "passed", "failed", "cancelled", "skipped", "todo", "executed",
];

export function projectTestSummary(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !COUNT_FIELDS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
    value.executed !== value.passed + value.failed ||
    value.total !== value.executed + value.cancelled + value.skipped + value.todo
  ) return {};
  return {
    testSummary: Object.fromEntries(COUNT_FIELDS.map((key) => [key, value[key]])),
  };
}
