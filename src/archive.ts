import { assertSafeMutation } from "./safety.js";
import { applyProjectStatuses, projectSetFingerprint } from "./projects.js";
import { classifyConversations, DEFAULT_CUTOFF } from "./filter.js";
import type { ExecuteManifestResult } from "./manifest.js";
import type { NormalizedConversation } from "./types.js";
import type { ProjectInventory } from "./projects.js";
import type { ExecutionJournal, JournalState } from "./types.js";

export interface ArchiveSnapshot {
  conversations: NormalizedConversation[];
  projectInventory: ProjectInventory;
}

export interface InventorySource {
  loadSnapshot(): Promise<ArchiveSnapshot>;
}

export interface ArchiveTransport {
  mutationMethod: string;
  archive(item: NormalizedConversation): Promise<unknown>;
  verify(item: NormalizedConversation): Promise<boolean>;
}

export interface ArchiveOptions {
  cutoff: string;
  confirmArchive: boolean;
  inventory: InventorySource;
  transport: ArchiveTransport;
  journal: ExecutionJournal;
  now?: () => Date;
}

export interface ArchiveRunResult {
  candidatesSeen: number;
  results: ExecuteManifestResult[];
}

export class ArchiveAbortedError extends Error {
  public constructor(message: string, public readonly results: ExecuteManifestResult[] = []) {
    super(message);
    this.name = "ArchiveAbortedError";
  }
}

function eligibleItems(snapshot: ArchiveSnapshot, cutoff: string): NormalizedConversation[] {
  const conversations = applyProjectStatuses(snapshot.conversations, snapshot.projectInventory);
  return classifyConversations(conversations, cutoff).candidates
    .sort((left, right) => {
      const kindOrder = { chatgpt: 0, codex: 1 } as const;
      return kindOrder[left.kind] - kindOrder[right.kind]
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
}

function findEligibleItem(snapshot: ArchiveSnapshot, target: NormalizedConversation, cutoff: string): NormalizedConversation | null {
  const matching = applyProjectStatuses(snapshot.conversations, snapshot.projectInventory)
    .filter((item) => item.id === target.id && item.kind === target.kind);
  const candidates = classifyConversations(matching, cutoff).candidates;
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0] ?? null;
}

function abort(message: string, results: ExecuteManifestResult[]): never {
  throw new ArchiveAbortedError(message, [...results]);
}

async function recordState(
  journal: ExecutionJournal,
  item: NormalizedConversation,
  state: JournalState,
  now: () => Date
): Promise<void> {
  await journal.record({ id: item.id, kind: item.kind }, state, now().toISOString());
}

async function recordAmbiguous(
  journal: ExecutionJournal,
  item: NormalizedConversation,
  results: ExecuteManifestResult[],
  now: () => Date,
  message: string
): Promise<never> {
  try {
    await recordState(journal, item, "ambiguous", now);
  } catch {
    abort("Unable to persist ambiguous archive state", results);
  }
  abort(message, results);
}

async function archiveOne(
  item: NormalizedConversation,
  options: ArchiveOptions,
  results: ExecuteManifestResult[],
  now: () => Date
): Promise<void> {
  try {
    await recordState(options.journal, item, "pending", now);
  } catch {
    abort("Unable to persist pending archive state", results);
  }

  try {
    await options.transport.archive(item);
  } catch {
    await recordAmbiguous(options.journal, item, results, now, `Archive request became ambiguous for ${item.id}`);
  }

  try {
    await recordState(options.journal, item, "awaiting-verification", now);
  } catch {
    await recordAmbiguous(options.journal, item, results, now, `Archive request became ambiguous for ${item.id}`);
  }

  let verified = false;
  try {
    verified = await options.transport.verify(item);
  } catch {
    await recordAmbiguous(options.journal, item, results, now, `Verification became ambiguous for ${item.id}`);
  }
  if (!verified) {
    await recordAmbiguous(options.journal, item, results, now, `Verification failed for ${item.id}`);
  }

  try {
    await recordState(options.journal, item, "verified", now);
  } catch {
    await recordAmbiguous(options.journal, item, results, now, `Unable to persist verified archive state for ${item.id}`);
  }

  results.push({
    id: item.id,
    kind: item.kind,
    previousArchived: false,
    archivedAt: now().toISOString()
  });
}

export async function executeArchive(options: ArchiveOptions): Promise<ArchiveRunResult> {
  if (!options.confirmArchive) {
    throw new ArchiveAbortedError("Refusing to archive without --confirm-archive");
  }

  const initial = await options.inventory.loadSnapshot();
  const protectedFingerprint = projectSetFingerprint(initial.projectInventory);
  const initialCandidates = eligibleItems(initial, options.cutoff);
  const results: ExecuteManifestResult[] = [];
  if (initialCandidates.length === 0) {
    return { candidatesSeen: 0, results };
  }

  const canaryTarget = initialCandidates[0];
  if (canaryTarget === undefined) {
    return { candidatesSeen: 0, results };
  }
  const canarySnapshot = await options.inventory.loadSnapshot();
  if (projectSetFingerprint(canarySnapshot.projectInventory) !== protectedFingerprint) {
    abort("Project set changed before canary", results);
  }
  const canary = findEligibleItem(canarySnapshot, canaryTarget, options.cutoff);
  if (canary === null) {
    abort("Canary revalidation failed; no mutation was attempted", results);
  }

  assertSafeMutation({ method: options.transport.mutationMethod, operation: "archive-conversation" });
  const now = options.now ?? (() => new Date());
  await archiveOne(canary, options, results, now);

  const afterCanary = await options.inventory.loadSnapshot();
  if (projectSetFingerprint(afterCanary.projectInventory) !== protectedFingerprint) {
    abort("Project set changed after canary", results);
  }

  for (const target of initialCandidates.slice(1)) {
    const refreshed = await options.inventory.loadSnapshot();
    if (projectSetFingerprint(refreshed.projectInventory) !== protectedFingerprint) {
      abort("Project set changed during batch", results);
    }
    const item = findEligibleItem(refreshed, target, options.cutoff);
    if (item === null) {
      continue;
    }

    assertSafeMutation({ method: options.transport.mutationMethod, operation: "archive-conversation" });
    await archiveOne(item, options, results, now);
  }

  return { candidatesSeen: initialCandidates.length, results };
}

export { DEFAULT_CUTOFF };
