import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ConversationKind,
  DiscoveryConfig,
  DryRunManifest,
  DryRunManifestProvenance,
  ExecutionJournal,
  JournalEntry,
  JournalState,
  ManifestEntry,
  NormalizedConversation
} from "./types.js";

export interface ExecuteManifestResult {
  id: string;
  kind: ConversationKind;
  previousArchived: false;
  archivedAt: string;
}

const MANIFEST_ACTIONS: ManifestEntry["action"][] = [
  "candidate",
  "skip-project",
  "skip-unknown",
  "skip-new",
  "skip-invalid-date",
  "skip-archived"
];

export function stateDirectory(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".local", "state", "chatgpt-archive-cleanup");
}

function fileTimestamp(createdAt: Date): string {
  return createdAt.toISOString().replace(/[:.]/g, "-");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["EBADF", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(errorCode(error) ?? "")) {
      return;
    }
    throw error;
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const handle = await open(temporaryPath, "w", 0o600);
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function assertDryRunProvenance(provenance: DryRunManifestProvenance): void {
  if (provenance.origin !== "https://chatgpt.com"
    || !isFingerprint(provenance.discoveryConfigFingerprint)
    || (provenance.accountFingerprint !== null && !isFingerprint(provenance.accountFingerprint))) {
    throw new Error("Invalid dry-run provenance");
  }
}

export async function writeDryRunManifest(
  stateDir: string,
  cutoff: string,
  entries: ManifestEntry[],
  createdAt: Date = new Date(),
  provenance: DryRunManifestProvenance
): Promise<string> {
  assertDryRunProvenance(provenance);
  await ensurePrivateDirectory(stateDir);
  const runsDir = join(stateDir, "runs");
  await ensurePrivateDirectory(runsDir);
  const path = join(runsDir, `${fileTimestamp(createdAt)}-dry-run.json`);
  await writeJsonAtomically(path, {
    schema: 2,
    kind: "dry-run",
    createdAt: createdAt.toISOString(),
    readOnly: true,
    cutoff,
    mutationsExecuted: 0,
    provenance,
    entries
  });
  return path;
}

export async function writeExecuteManifest(
  stateDir: string,
  cutoff: string,
  results: ExecuteManifestResult[],
  createdAt: Date = new Date()
): Promise<string> {
  await ensurePrivateDirectory(stateDir);
  const runsDir = join(stateDir, "runs");
  await ensurePrivateDirectory(runsDir);
  const path = join(runsDir, `${fileTimestamp(createdAt)}-execute.json`);
  await writeJsonAtomically(path, {
    schema: 1,
    kind: "execute",
    createdAt: createdAt.toISOString(),
    cutoff,
    mutationsExecuted: results.length,
    results
  });
  return path;
}

export async function writeDiscoveryConfig(
  stateDir: string,
  config: DiscoveryConfig
): Promise<string> {
  await ensurePrivateDirectory(stateDir);
  const path = join(stateDir, "discovery-config.json");
  await writeJsonAtomically(path, config);
  return path;
}

export async function readDiscoveryConfig(stateDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, "discovery-config.json"), "utf8")) as unknown;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

export function fingerprintDiscoveryConfig(config: DiscoveryConfig | unknown): string {
  return fingerprint(config);
}

export function fingerprintAccountContext(value: string): string {
  return fingerprint({ context: value });
}

function isManifestAction(value: unknown): value is ManifestEntry["action"] {
  return MANIFEST_ACTIONS.includes(value as ManifestEntry["action"]);
}

function isManifestEntry(value: unknown): value is ManifestEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && entry.id.length > 0
    && (entry.kind === "chatgpt" || entry.kind === "codex")
    && (typeof entry.title === "string" || entry.title === null)
    && (typeof entry.lastActivity === "string" || entry.lastActivity === null)
    && (entry.projectStatus === "CONFIRMED_PROJECT"
      || entry.projectStatus === "CONFIRMED_NON_PROJECT" || entry.projectStatus === "UNKNOWN")
    && isManifestAction(entry.action);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function assertDryRunManifest(value: unknown): asserts value is DryRunManifest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid reviewed dry-run manifest");
  }
  const manifest = value as Record<string, unknown>;
  const provenance = manifest.provenance;
  if (typeof provenance !== "object" || provenance === null) {
    throw new Error("Invalid reviewed dry-run provenance");
  }
  const provenanceRecord = provenance as Record<string, unknown>;
  if (manifest.schema !== 2 || manifest.kind !== "dry-run" || manifest.readOnly !== true
    || typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))
    || typeof manifest.cutoff !== "string" || manifest.mutationsExecuted !== 0
    || provenanceRecord.origin !== "https://chatgpt.com"
    || !isFingerprint(provenanceRecord.discoveryConfigFingerprint)
    || (provenanceRecord.accountFingerprint !== null && !isFingerprint(provenanceRecord.accountFingerprint))
    || !Array.isArray(manifest.entries) || !manifest.entries.every(isManifestEntry)) {
    throw new Error("Invalid reviewed dry-run manifest");
  }

  const keys = new Set<string>();
  for (const entry of manifest.entries) {
    const key = `${entry.kind}\u0000${entry.id}`;
    if (keys.has(key)) {
      throw new Error("Invalid reviewed dry-run manifest");
    }
    keys.add(key);
  }
}

export async function readReviewedDryRunManifest(
  path: string,
  cutoff: string,
  expectedConfigFingerprint: string
): Promise<DryRunManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Unable to read reviewed dry-run manifest");
  }
  assertDryRunManifest(parsed);
  if (parsed.cutoff !== cutoff) {
    throw new Error("Reviewed dry-run cutoff does not match execute cutoff");
  }
  if (parsed.provenance.discoveryConfigFingerprint !== expectedConfigFingerprint) {
    throw new Error("Reviewed dry-run discovery provenance does not match current config");
  }
  return parsed;
}

function entrySafetySignature(entry: ManifestEntry): string {
  return JSON.stringify([
    entry.kind,
    entry.id,
    entry.action,
    entry.lastActivity,
    entry.projectStatus
  ]);
}

export function assertReviewedEntriesMatch(
  reviewedEntries: ManifestEntry[],
  freshEntries: ManifestEntry[]
): void {
  const reviewed = reviewedEntries.map(entrySafetySignature).sort();
  const fresh = freshEntries.map(entrySafetySignature).sort();
  if (reviewed.length !== fresh.length || reviewed.some((value, index) => value !== fresh[index])) {
    throw new Error("Fresh inventory does not match reviewed dry-run safety metadata");
  }
}

const JOURNAL_STATES: JournalState[] = [
  "pending",
  "awaiting-verification",
  "verified",
  "ambiguous"
];

function isConversationKind(value: unknown): value is ConversationKind {
  return value === "chatgpt" || value === "codex";
}

function isJournalState(value: unknown): value is JournalState {
  return JOURNAL_STATES.includes(value as JournalState);
}

function journalKey(item: Pick<NormalizedConversation, "id" | "kind">): string {
  return `${item.kind}\u0000${item.id}`;
}

function assertJournalEntry(value: unknown): asserts value is JournalEntry {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid execute journal");
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0
    || !isConversationKind(entry.kind) || !isJournalState(entry.state)
    || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))) {
    throw new Error("Invalid execute journal");
  }
}

function assertJournalEnvelope(value: unknown): asserts value is {
  schema: 1;
  kind: "execute-journal";
  createdAt: string;
  entries: JournalEntry[];
} {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid execute journal");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.schema !== 1 || envelope.kind !== "execute-journal"
    || typeof envelope.createdAt !== "string" || !Number.isFinite(Date.parse(envelope.createdAt))
    || !Array.isArray(envelope.entries)) {
    throw new Error("Invalid execute journal");
  }
  for (const entry of envelope.entries) {
    assertJournalEntry(entry);
  }
}

async function journalFiles(stateDir: string): Promise<string[]> {
  const journalsDir = join(stateDir, "journals");
  let entries;
  try {
    entries = await readdir(journalsDir, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }

  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error("Invalid execute journal directory");
    }
    paths.push(join(journalsDir, entry.name));
  }
  return paths;
}

export async function assertNoUnresolvedJournals(stateDir: string): Promise<void> {
  for (const path of await journalFiles(stateDir)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      assertJournalEnvelope(parsed);
    } catch {
      throw new Error("Unresolved execute journal requires review");
    }
    if (parsed.entries.some((entry) => entry.state !== "verified")) {
      throw new Error("Unresolved execute journal requires review");
    }
  }
}

function assertJournalItem(item: Pick<NormalizedConversation, "id" | "kind">): void {
  if (typeof item.id !== "string" || item.id.length === 0 || !isConversationKind(item.kind)) {
    throw new Error("Invalid execute journal item");
  }
}

function assertTransition(previous: JournalEntry | undefined, next: JournalState): void {
  const allowed = previous === undefined
    ? next === "pending"
    : previous.state === "pending"
      ? next === "awaiting-verification" || next === "ambiguous"
      : previous.state === "awaiting-verification"
        ? next === "verified" || next === "ambiguous"
        : false;
  if (!allowed) {
    throw new Error("Invalid execute journal transition");
  }
}

export async function createExecutionJournal(
  stateDir: string,
  createdAt: Date = new Date()
): Promise<ExecutionJournal> {
  await assertNoUnresolvedJournals(stateDir);
  await ensurePrivateDirectory(stateDir);
  const journalsDir = join(stateDir, "journals");
  await ensurePrivateDirectory(journalsDir);
  const path = join(journalsDir, `${fileTimestamp(createdAt)}-execute-journal-${randomUUID()}.json`);
  let entries: JournalEntry[] = [];
  await writeJsonAtomically(path, {
    schema: 1,
    kind: "execute-journal",
    createdAt: createdAt.toISOString(),
    entries
  });

  return {
    record: async (item, state, at): Promise<void> => {
      assertJournalItem(item);
      if (!isJournalState(state) || typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
        throw new Error("Invalid execute journal transition");
      }
      const current = entries.find((entry) => journalKey(entry) === journalKey(item));
      assertTransition(current, state);
      const nextEntry: JournalEntry = { id: item.id, kind: item.kind, state, at };
      const nextEntries = current === undefined
        ? [...entries, nextEntry]
        : entries.map((entry) => journalKey(entry) === journalKey(item) ? nextEntry : entry);
      await writeJsonAtomically(path, {
        schema: 1,
        kind: "execute-journal",
        createdAt: createdAt.toISOString(),
        entries: nextEntries
      });
      entries = nextEntries;
    }
  };
}
