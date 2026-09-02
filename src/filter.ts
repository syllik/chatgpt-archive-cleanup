import type {
  ClassificationResult,
  ManifestAction,
  ManifestEntry,
  NormalizedConversation,
  ProjectStatus
} from "./types.js";

export type { NormalizedConversation } from "./types.js";

export const DEFAULT_CUTOFF = "2026-06-02T18:10:00+07:00";

function validTimestamp(value: string | null): number | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function mergedProjectStatus(left: ProjectStatus, right: ProjectStatus): ProjectStatus {
  if (left === "UNKNOWN" || right === "UNKNOWN") {
    return "UNKNOWN";
  }

  if (left === "CONFIRMED_PROJECT" || right === "CONFIRMED_PROJECT") {
    return "CONFIRMED_PROJECT";
  }

  return "CONFIRMED_NON_PROJECT";
}

function deterministicString(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left <= right ? left : right;
}

function mergeDuplicate(left: NormalizedConversation, right: NormalizedConversation): NormalizedConversation {
  const leftTime = validTimestamp(left.lastActivity);
  const rightTime = validTimestamp(right.lastActivity);
  const datesConflict = left.lastActivity === null || right.lastActivity === null
    || leftTime === null || rightTime === null;
  let latestDate: string | null = null;
  if (!datesConflict && leftTime !== null && rightTime !== null
    && left.lastActivity !== null && right.lastActivity !== null) {
    latestDate = leftTime === rightTime
      ? deterministicString(left.lastActivity, right.lastActivity)
      : leftTime > rightTime ? left.lastActivity : right.lastActivity;
  }

  return {
    id: left.id,
    kind: left.kind,
    title: deterministicString(left.title, right.title),
    archived: left.archived || right.archived,
    lastActivity: datesConflict ? null : latestDate,
    projectStatus: mergedProjectStatus(left.projectStatus, right.projectStatus)
  };
}

export function deduplicateConversations(items: NormalizedConversation[]): NormalizedConversation[] {
  const byKey = new Map<string, NormalizedConversation>();

  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    const previous = byKey.get(key);
    byKey.set(key, previous === undefined ? item : mergeDuplicate(previous, item));
  }

  return [...byKey.values()];
}

function actionFor(item: NormalizedConversation, cutoffTimestamp: number): ManifestAction {
  if (item.archived) {
    return "skip-archived";
  }

  if (item.projectStatus === "CONFIRMED_PROJECT") {
    return "skip-project";
  }

  if (item.projectStatus === "UNKNOWN") {
    return "skip-unknown";
  }

  const activityTimestamp = validTimestamp(item.lastActivity);
  if (activityTimestamp === null) {
    return "skip-invalid-date";
  }

  return activityTimestamp < cutoffTimestamp ? "candidate" : "skip-new";
}

export function classifyConversations(
  items: NormalizedConversation[],
  cutoff: string = DEFAULT_CUTOFF
): ClassificationResult {
  const cutoffTimestamp = validTimestamp(cutoff);
  if (cutoffTimestamp === null) {
    throw new Error(`Invalid cutoff timestamp: ${cutoff}`);
  }

  const entries: ManifestEntry[] = [];
  const candidates: NormalizedConversation[] = [];

  for (const item of deduplicateConversations(items)) {
    const action = actionFor(item, cutoffTimestamp);
    entries.push({
      id: item.id,
      kind: item.kind,
      title: item.title,
      lastActivity: item.lastActivity,
      projectStatus: item.projectStatus,
      action
    });

    if (action === "candidate") {
      candidates.push(item);
    }
  }

  return { entries, candidates };
}
