import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConversationKind, ManifestEntry } from "./types.js";
import type { DiscoveryConfig } from "./types.js";

export interface ExecuteManifestResult {
  id: string;
  kind: ConversationKind;
  previousArchived: false;
  archivedAt: string;
}

export function stateDirectory(homeDirectory: string = homedir()): string {
  return join(homeDirectory, ".local", "state", "chatgpt-archive-cleanup");
}

function fileTimestamp(createdAt: Date): string {
  return createdAt.toISOString().replace(/[:.]/g, "-");
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporaryPath, path);
}

export async function writeDryRunManifest(
  stateDir: string,
  cutoff: string,
  entries: ManifestEntry[],
  createdAt: Date = new Date()
): Promise<string> {
  const runsDir = join(stateDir, "runs");
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
  const path = join(runsDir, `${fileTimestamp(createdAt)}-dry-run.json`);
  await writeJsonAtomically(path, {
    schema: 1,
    kind: "dry-run",
    createdAt: createdAt.toISOString(),
    cutoff,
    mutationsExecuted: 0,
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
  const runsDir = join(stateDir, "runs");
  await mkdir(runsDir, { recursive: true, mode: 0o700 });
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
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, "discovery-config.json");
  await writeJsonAtomically(path, config);
  return path;
}

export async function readDiscoveryConfig(stateDir: string): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, "discovery-config.json"), "utf8")) as unknown;
}
