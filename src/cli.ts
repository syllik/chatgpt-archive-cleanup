import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeArchive, ArchiveAbortedError, type ArchiveSnapshot, type ArchiveTransport, type InventorySource } from "./archive.js";
import { connectToChatGPT, DEFAULT_CDP_URL } from "./browser.js";
import type { PageOperation } from "./api.js";
import { discoverConfig, assertDiscoveryConfigShape, validateDiscoveryConfig, type DiscoveryRuntime } from "./discovery.js";
import { DEFAULT_CUTOFF, classifyConversations } from "./filter.js";
import { loadConversationInventory, type PageFetcher } from "./inventory.js";
import {
  assertNoUnresolvedJournals,
  assertReviewedEntriesMatch,
  createExecutionJournal,
  fingerprintAccountContext,
  fingerprintDiscoveryConfig,
  readReviewedDryRunManifest,
  readDiscoveryConfig,
  stateDirectory,
  writeDiscoveryConfig,
  writeDryRunManifest,
  writeExecuteManifest
} from "./manifest.js";
import { buildProjectProtectedSet, applyProjectStatuses } from "./projects.js";
import { readPath } from "./api.js";
import type { ArchiveOperation, DiscoveryConfig, NormalizedConversation } from "./types.js";

type Command = "discover" | "dry-run" | "execute";

interface CliOptions {
  command: Command | null;
  cdpUrl: string;
  cutoff: string;
  stateDir: string;
  dryRunManifestPath: string | null;
  waitSeconds: number;
  confirmArchive: boolean;
}

export interface CliSession extends DiscoveryRuntime {
  fetchOperation(operation: PageOperation, query: Readonly<Record<string, string>>): Promise<unknown>;
  archiveConversation(operation: ArchiveOperation, id: string): Promise<unknown>;
  accountFingerprint?: () => Promise<string | null>;
  disconnect(): Promise<void>;
}

export interface CliDependencies {
  connect: (cdpUrl: string) => Promise<CliSession>;
  write: (text: string) => void;
}

export interface CliResult {
  exitCode: number;
  output: string;
}

const HELP = [
  "ChatGPT archive cleanup (read-only by default)",
  "",
  "Usage:",
  "  npm run archive -- discover [--cdp URL] [--wait-seconds N]",
  "  npm run archive -- dry-run [--cdp URL] [--cutoff ISO] [--state-dir PATH]",
  "  npm run archive -- execute --confirm-archive --dry-run-manifest PATH [--cdp URL] [--cutoff ISO] [--state-dir PATH]",
  "",
  "Commands:",
  "  discover  Observe the current client and save a redacted discovery config.",
  "  dry-run   Scan the complete inventory and save a metadata-only candidate manifest.",
  "  execute   Archive serially with a canary; requires confirmation and a reviewed dry-run manifest.",
  "",
  `The default cutoff is ${DEFAULT_CUTOFF}.`,
  "No command ever deletes conversations or projects.",
  ""
].join("\n");

const DEFAULT_DEPENDENCIES: CliDependencies = {
  connect: async (cdpUrl) => connectToChatGPT(cdpUrl),
  write: (text) => process.stdout.write(text)
};

function parseNumber(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 300) {
    throw new Error(`Invalid ${flag}: ${value}`);
  }
  return number;
}

function parseOptions(argv: string[]): CliOptions & { help: boolean } {
  let command: Command | null = null;
  let cdpUrl = DEFAULT_CDP_URL;
  let cutoff = DEFAULT_CUTOFF;
  let stateDir = stateDirectory();
  let dryRunManifestPath: string | null = null;
  let waitSeconds = 15;
  let confirmArchive = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--confirm-archive") {
      confirmArchive = true;
      continue;
    }
    const nextValue = (): string => {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      return value;
    };
    if (argument === "--cdp") {
      cdpUrl = nextValue();
      continue;
    }
    if (argument === "--cutoff") {
      cutoff = nextValue();
      continue;
    }
    if (argument === "--state-dir") {
      stateDir = nextValue();
      continue;
    }
    if (argument === "--dry-run-manifest") {
      dryRunManifestPath = nextValue();
      continue;
    }
    if (argument === "--wait-seconds") {
      waitSeconds = parseNumber(nextValue(), "--wait-seconds");
      continue;
    }
    if (argument === "discover" || argument === "dry-run" || argument === "execute") {
      if (command !== null) {
        throw new Error("Only one subcommand may be provided");
      }
      command = argument;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { command, cdpUrl, cutoff, stateDir, dryRunManifestPath, waitSeconds, confirmArchive, help };
}

function outputResult(dependencies: CliDependencies, exitCode: number, output: string): CliResult {
  dependencies.write(output);
  return { exitCode, output };
}

async function currentConfig(stateDir: string): Promise<DiscoveryConfig> {
  const value = await readDiscoveryConfig(stateDir);
  assertDiscoveryConfigShape(value);
  return value;
}

async function validateCurrentClient(session: CliSession, config: DiscoveryConfig): Promise<void> {
  const observed = await session.observeRequests(0);
  const archiveEvidence = await session.inspectArchiveBundle();
  validateDiscoveryConfig(config, observed, archiveEvidence);
}

async function currentAccountFingerprint(session: CliSession): Promise<string | null> {
  const value = await session.accountFingerprint?.();
  return value === null || value === undefined ? null : fingerprintAccountContext(value);
}

async function inventorySnapshot(session: CliSession, config: DiscoveryConfig): Promise<ArchiveSnapshot> {
  const fetchPage: PageFetcher = (operation, query) => session.fetchOperation(operation, query);
  const conversations = await loadConversationInventory(config.operations.listConversations, fetchPage);
  const projectInventory = await buildProjectProtectedSet(
    config.operations.listProjects,
    config.operations.listProjectConversations,
    fetchPage
  );
  return { conversations, projectInventory };
}

function dryRunOutput(
  cutoff: string,
  items: NormalizedConversation[],
  entries: ReturnType<typeof classifyConversations>["entries"],
  manifestPath: string
): string {
  const scanned = { chatgpt: 0, codex: 0 };
  const candidates = { chatgpt: 0, codex: 0 };
  for (const item of items) {
    scanned[item.kind] += 1;
  }
  for (const entry of entries) {
    if (entry.action === "candidate") {
      candidates[entry.kind] += 1;
    }
  }
  const skipped = (action: string): number => entries.filter((entry) => entry.action === action).length;
  return [
    "CHATGPT ARCHIVE DRY RUN",
    "",
    `Cutoff: ${cutoff}`,
    "",
    "Scanned:",
    `  ChatGPT: ${scanned.chatgpt}`,
    `  Codex: ${scanned.codex}`,
    "",
    "Would archive:",
    `  ChatGPT: ${candidates.chatgpt}`,
    `  Codex: ${candidates.codex}`,
    "",
    "Skipped:",
    `  Projects: ${skipped("skip-project")}`,
    `  Unknown project membership: ${skipped("skip-unknown")}`,
    `  Newer: ${skipped("skip-new")}`,
    `  Missing/invalid last activity: ${skipped("skip-invalid-date")}`,
    `  Already archived: ${skipped("skip-archived")}`,
    "",
    "Mutations executed: 0",
    "",
    "Manifest:",
    manifestPath,
    ""
  ].join("\n");
}

function archiveTransport(session: CliSession, config: DiscoveryConfig): ArchiveTransport {
  let lastResponse: unknown = null;
  const operation = config.operations.archiveConversation;
  return {
    mutationMethod: operation.method,
    archive: async (item) => {
      lastResponse = await session.archiveConversation(operation, item.id);
      return lastResponse;
    },
    verify: async (item) => {
      const active = await loadConversationInventory(config.operations.listConversations,
        (pageOperation, query) => session.fetchOperation(pageOperation, query));
      if (active.some((candidate) => candidate.id === item.id && candidate.kind === item.kind)) {
        return false;
      }

      const archivedOperation = config.operations.listArchivedConversations;
      if (archivedOperation !== undefined) {
        const archived = await loadConversationInventory([archivedOperation],
          (pageOperation, query) => session.fetchOperation(pageOperation, query));
        return archived.some((candidate) => candidate.id === item.id
          && candidate.kind === item.kind && candidate.archived);
      }

      const responsePath = operation.responseArchivedPath;
      const responseState = responsePath === null
        ? (readPath(lastResponse, "is_archived") ?? readPath(lastResponse, "archived"))
        : readPath(lastResponse, responsePath);
      return responseState === true;
    }
  };
}

export async function runCli(
  argv: string[],
  providedDependencies: CliDependencies = DEFAULT_DEPENDENCIES
): Promise<CliResult> {
  let options: CliOptions & { help: boolean };
  try {
    options = parseOptions(argv);
  } catch (error) {
    return outputResult(providedDependencies, 2, `Error: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  if (options.help || options.command === null) {
    return outputResult(providedDependencies, 0, HELP);
  }
  if (options.command === "execute" && !options.confirmArchive) {
    return outputResult(providedDependencies, 2, "Refusing to execute without --confirm-archive\n");
  }

  let preloadedConfig: DiscoveryConfig | null = null;
  let reviewedManifest: Awaited<ReturnType<typeof readReviewedDryRunManifest>> | null = null;
  if (options.command === "execute") {
    if (options.dryRunManifestPath === null) {
      return outputResult(providedDependencies, 2,
        "Refusing to execute without --dry-run-manifest PATH referencing a reviewed dry run\n");
    }
    try {
      preloadedConfig = await currentConfig(options.stateDir);
      reviewedManifest = await readReviewedDryRunManifest(
        options.dryRunManifestPath,
        options.cutoff,
        fingerprintDiscoveryConfig(preloadedConfig)
      );
      await assertNoUnresolvedJournals(options.stateDir);
    } catch {
      return outputResult(providedDependencies, 2,
        "Refusing to execute: reviewed dry run, discovery provenance, or prior journal is invalid\n");
    }
  }

  let session: CliSession | null = null;
  try {
    session = await providedDependencies.connect(options.cdpUrl);
    if (options.command === "discover") {
      const config = await discoverConfig(session, options.waitSeconds);
      const path = await writeDiscoveryConfig(options.stateDir, config);
      return outputResult(providedDependencies, 0, `Discovery complete.\nConfig:\n${path}\n`);
    }

    const config = preloadedConfig ?? await currentConfig(options.stateDir);
    await validateCurrentClient(session, config);
    if (options.command === "dry-run") {
      const snapshot = await inventorySnapshot(session, config);
      const classified = classifyConversations(
        applyProjectStatuses(snapshot.conversations, snapshot.projectInventory),
        options.cutoff
      );
      const path = await writeDryRunManifest(
        options.stateDir,
        options.cutoff,
        classified.entries,
        new Date(),
        {
          origin: "https://chatgpt.com",
          discoveryConfigFingerprint: fingerprintDiscoveryConfig(config),
          accountFingerprint: await currentAccountFingerprint(session)
        }
      );
      return outputResult(providedDependencies, 0,
        dryRunOutput(options.cutoff, snapshot.conversations, classified.entries, path));
    }

    const inventory: InventorySource = {
      loadSnapshot: () => inventorySnapshot(session as CliSession, config)
    };
    if (reviewedManifest === null) {
      throw new Error("Reviewed dry-run manifest is required for execute");
    }
    const reviewedSnapshot = await inventorySnapshot(session, config);
    const reviewedClassification = classifyConversations(
      applyProjectStatuses(reviewedSnapshot.conversations, reviewedSnapshot.projectInventory),
      options.cutoff
    );
    assertReviewedEntriesMatch(reviewedManifest.entries, reviewedClassification.entries);
    const currentFingerprint = await currentAccountFingerprint(session);
    if (reviewedManifest.provenance.accountFingerprint !== currentFingerprint) {
      throw new Error("Authenticated account/workspace fingerprint does not match reviewed dry run");
    }

    const journal = await createExecutionJournal(options.stateDir);
    const result = await executeArchive({
      cutoff: options.cutoff,
      confirmArchive: options.confirmArchive,
      inventory,
      transport: archiveTransport(session, config),
      journal
    });
    const path = await writeExecuteManifest(options.stateDir, options.cutoff, result.results);
    return outputResult(providedDependencies, 0,
      `Execute complete.\nArchived: ${result.results.length}\nManifest:\n${path}\n`);
  } catch (error) {
    let message = `Error: ${error instanceof Error ? error.message : String(error)}\n`;
    if (error instanceof ArchiveAbortedError && error.results.length > 0) {
      const path = await writeExecuteManifest(options.stateDir, options.cutoff, error.results);
      message += `Partial execute manifest:\n${path}\n`;
    }
    return outputResult(providedDependencies, 1, message);
  } finally {
    if (session !== null) {
      await session.disconnect();
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === resolve(invokedPath)) {
  void runCli(process.argv.slice(2)).then((result) => {
    process.exitCode = result.exitCode;
  });
}
