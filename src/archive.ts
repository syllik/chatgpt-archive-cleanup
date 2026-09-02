import { assertSafeMutation } from "./safety.js";
import { applyProjectStatuses, projectSetFingerprint } from "./projects.js";
import { classifyConversations, DEFAULT_CUTOFF } from "./filter.js";
import type { ExecuteManifestResult } from "./manifest.js";
import type { NormalizedConversation } from "./types.js";
import type { ProjectInventory } from "./projects.js";

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
  const current = applyProjectStatuses(snapshot.conversations, snapshot.projectInventory)
    .find((item) => item.id === target.id && item.kind === target.kind);
  if (current === undefined || classifyConversations([current], cutoff).candidates.length !== 1) {
    return null;
  }
  return current;
}

function abort(message: string, results: ExecuteManifestResult[]): never {
  throw new ArchiveAbortedError(message, [...results]);
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
  await options.transport.archive(canary);
  results.push({
    id: canary.id,
    kind: canary.kind,
    previousArchived: false,
    archivedAt: (options.now ?? (() => new Date()))().toISOString()
  });
  if (!(await options.transport.verify(canary))) {
    abort(`Canary verification failed for ${canary.id}`, results);
  }

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
    await options.transport.archive(item);
    results.push({
      id: item.id,
      kind: item.kind,
      previousArchived: false,
      archivedAt: (options.now ?? (() => new Date()))().toISOString()
    });
    if (!(await options.transport.verify(item))) {
      abort(`Verification failed for ${item.id}`, results);
    }
  }

  return { candidatesSeen: initialCandidates.length, results };
}

export { DEFAULT_CUTOFF };
