import fs from "fs";
import dotenv from "dotenv";
import { SecretBackend } from "./backends/types";
import { createBackend } from "./backends/createBackend";
import { ConfigManager } from "./ConfigManager";
import { getKind } from "./kinds";
import { tryDecodeEnvelope } from "./kinds/envelope";
import { interpolateEnv, scopePath } from "./pathUtils";
import {
  Environment,
  EnvironmentConfig,
  MonorepoSecretManagerOptions,
  SecretEvent,
  ServiceSecretConfig,
} from "./types";

export interface MonorepoSecretManagerTestOptions
  extends MonorepoSecretManagerOptions {
  backend?: SecretBackend;
}

/** Pseudo-service name for top-level shared secrets. */
export const SHARED_SERVICE = "shared";

interface ScopedItem {
  service: string;
  item: ServiceSecretConfig;
}

function scopeItem(item: ServiceSecretConfig, pkg?: string): ServiceSecretConfig {
  if (!pkg) return item;
  const mapRecord = (record?: Record<string, string>) =>
    record
      ? Object.fromEntries(
          Object.entries(record).map(([key, value]) => [key, scopePath(pkg, value)])
        )
      : undefined;
  return {
    ...item,
    sourcePath: item.sourcePath && scopePath(pkg, item.sourcePath),
    targetPath: item.targetPath && scopePath(pkg, item.targetPath),
    source: mapRecord(item.source),
    target: mapRecord(item.target),
  };
}

function defaultReporter(event: SecretEvent): void {
  const where = event.paths?.length ? ` -> ${event.paths.join(", ")}` : "";
  if (event.status === "error") {
    console.error(`x ${event.service} ${event.kind} ${event.action} failed: ${event.error}`);
  } else if (event.action === "peek") {
    console.log(`\n${event.service} ${event.kind} (${event.remoteName}):\n${event.output ?? ""}\n`);
  } else {
    console.log(`ok ${event.service} ${event.kind} ${event.action}${event.status === "dry-run" ? " (dry run)" : ""}${where}`);
  }
}

export class MonorepoSecretManager {
  private environment: Environment;
  private overrideSa: boolean;
  private dryRun: boolean;
  private report: (event: SecretEvent) => void;
  private configManager: ConfigManager;
  private backendPromise: Promise<SecretBackend> | null = null;
  private injectedBackend?: SecretBackend;
  private environmentConfig: EnvironmentConfig;

  constructor(options: MonorepoSecretManagerTestOptions) {
    this.environment = options.environment;
    this.overrideSa = options.overrideSa || false;
    this.dryRun = options.dryRun || false;
    this.report = options.onEvent || defaultReporter;
    this.configManager = new ConfigManager(options.configPath);
    this.environmentConfig = this.configManager.getEnvironmentConfig(this.environment);
    this.validateCredentials(this.environmentConfig);
    this.injectedBackend = options.backend;
  }

  private validateCredentials(environment: EnvironmentConfig): void {
    if (this.overrideSa) return;
    if (environment.provider === "gcp" && environment.credentials?.path) {
      if (!fs.existsSync(environment.credentials.path)) {
        throw new Error(
          `Service account file not found at ${environment.credentials.path}. Fix the path, or remove credentials.path to use ambient credentials.`
        );
      }
    }
  }

  /** Backend is created lazily so --dry-run push never needs cloud access. */
  private getBackend(): Promise<SecretBackend> {
    if (this.injectedBackend) return Promise.resolve(this.injectedBackend);
    if (!this.backendPromise) {
      this.backendPromise = createBackend({
        environment: this.environmentConfig,
        overrideSa: this.overrideSa,
      });
    }
    return this.backendPromise;
  }

  getAvailableServices(): string[] {
    return this.configManager.getServiceNames();
  }

  private serviceNames(serviceName: string): string[] {
    if (serviceName !== "all") return [serviceName];
    const names = this.configManager.getServiceNames();
    return this.configManager.getShared().length ? [SHARED_SERVICE, ...names] : names;
  }

  /** Items owned by a service (or by `shared`). */
  private ownItems(serviceName: string): ScopedItem[] {
    if (serviceName === SHARED_SERVICE) {
      return this.configManager.getShared().map((item) => ({ service: SHARED_SERVICE, item }));
    }
    const service = this.configManager.getServiceByName(serviceName);
    if (!service) {
      throw new Error(
        `Service '${serviceName}' not found. Services: ${this.configManager.getServiceNames().join(", ") || "(none)"}`
      );
    }
    return service.secrets.map((item) => ({
      service: serviceName,
      item: scopeItem(item, service.package),
    }));
  }

  /** Items a service reads: its own plus shared items it uses. */
  private readItems(serviceName: string): ScopedItem[] {
    if (serviceName === "all") {
      return this.serviceNames("all").flatMap((name) => this.ownItems(name));
    }
    const own = this.ownItems(serviceName);
    if (serviceName === SHARED_SERVICE) return own;
    const service = this.configManager.getServiceByName(serviceName);
    const used = new Set(service?.uses || []);
    const shared = this.configManager
      .getShared()
      .filter((item) => used.has(item.remoteName))
      .map((item) => ({ service: SHARED_SERVICE, item }));
    return [...shared, ...own];
  }

  private writeItems(serviceName: string): ScopedItem[] {
    return this.serviceNames(serviceName).flatMap((name) => this.ownItems(name));
  }

  async uploadEnv(serviceName: string): Promise<SecretEvent[]> {
    const deletePolicy = this.configManager.getDeletePolicy();
    const events: SecretEvent[] = [];
    for (const { service, item } of this.writeItems(serviceName)) {
      const kind = getKind(item.kind);
      const data = await kind.readFromDisk(item, this.environment);
      kind.validate(data);
      const event: SecretEvent = {
        service,
        kind: item.kind,
        remoteName: item.remoteName,
        action: "push",
        status: this.dryRun ? "dry-run" : "ok",
      };
      if (!this.dryRun) {
        const backend = await this.getBackend();
        await backend.put(item.remoteName, { data });
        if (deletePolicy.enabled !== false) {
          await backend.destroyVersions(item.remoteName, deletePolicy);
        }
      }
      this.report(event);
      events.push(event);
    }
    return events;
  }

  async downloadEnv(serviceName: string): Promise<SecretEvent[]> {
    return this.materialize(serviceName, "source", "pull");
  }

  async setEnv(serviceName: string): Promise<SecretEvent[]> {
    return this.materialize(serviceName, "target", "write");
  }

  private async materialize(
    serviceName: string,
    dest: "source" | "target",
    action: "pull" | "write"
  ): Promise<SecretEvent[]> {
    const backend = await this.getBackend();
    const events: SecretEvent[] = [];
    for (const { service, item } of this.readItems(serviceName)) {
      const base = { service, kind: item.kind, remoteName: item.remoteName, action };
      try {
        const kind = getKind(item.kind);
        const payload = await backend.get(item.remoteName);
        kind.validate(payload.data);
        if (this.dryRun) {
          const event: SecretEvent = { ...base, status: "dry-run", paths: this.plannedPaths(item, dest) };
          this.report(event);
          events.push(event);
          continue;
        }
        const written = await kind.writeToDisk(item, payload.data, dest, this.environment);
        const event: SecretEvent = { ...base, status: "ok", paths: written };
        this.report(event);
        events.push(event);
      } catch (error) {
        this.report({ ...base, status: "error", error: (error as Error).message });
        throw error;
      }
    }
    return events;
  }

  private plannedPaths(item: ServiceSecretConfig, dest: "source" | "target"): string[] {
    const single = dest === "source" ? item.sourcePath : item.targetPath;
    const record = dest === "source" ? item.source : item.target;
    const raw = single ? [single] : Object.values(record || {});
    return raw.map((p) => interpolateEnv(p, this.environment));
  }

  async peekEnv(serviceName: string): Promise<SecretEvent[]> {
    const backend = await this.getBackend();
    const events: SecretEvent[] = [];
    for (const { service, item } of this.readItems(serviceName)) {
      const base = { service, kind: item.kind, remoteName: item.remoteName, action: "peek" as const };
      try {
        const payload = await backend.get(item.remoteName);
        const event: SecretEvent = { ...base, status: "ok", output: getKind(item.kind).peek(payload.data) };
        this.report(event);
        events.push(event);
      } catch (error) {
        const message = (error as Error).message;
        const missing = message.includes("NOT_FOUND") || message.includes("No data found");
        const event: SecretEvent = missing
          ? { ...base, status: "skipped", output: "no value found" }
          : { ...base, status: "error", error: message };
        this.report(event);
        events.push(event);
      }
    }
    return events;
  }

  async cleanupVersions(serviceName: string): Promise<SecretEvent[]> {
    const deletePolicy = this.configManager.getDeletePolicy();
    const events: SecretEvent[] = [];
    for (const { service, item } of this.writeItems(serviceName)) {
      if (!this.dryRun) {
        const backend = await this.getBackend();
        await backend.destroyVersions(item.remoteName, deletePolicy);
      }
      const event: SecretEvent = {
        service,
        kind: item.kind,
        remoteName: item.remoteName,
        action: "prune",
        status: this.dryRun ? "dry-run" : "ok",
      };
      this.report(event);
      events.push(event);
    }
    return events;
  }

  /**
   * Merge env-file values for a service (shared first, then its own) without
   * touching disk. Used by `msm run` and `msm export`.
   */
  async exportEnv(serviceName: string): Promise<Record<string, string>> {
    const backend = await this.getBackend();
    const merged: Record<string, string> = {};
    for (const { item } of this.readItems(serviceName)) {
      if (item.kind !== "env-file") continue;
      const payload = await backend.get(item.remoteName);
      const envelope = tryDecodeEnvelope(payload.data);
      const text =
        envelope?.kind === "env-file" && envelope.files.data
          ? Buffer.from(envelope.files.data, "base64").toString("utf8")
          : payload.data.toString("utf8");
      Object.assign(merged, dotenv.parse(text));
    }
    return merged;
  }
}
