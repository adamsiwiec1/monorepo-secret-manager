import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DeletePolicy, EnvironmentConfig } from "../types";
import { writeFileSecure } from "../pathUtils";
import { SecretBackend, SecretPayload, SecretVersion, versionsToDestroy } from "./types";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function defaultLocalStorePath(): string {
  return ".msm/store";
}

export function defaultLocalKeyPath(storePath = defaultLocalStorePath()): string {
  return path.join(path.dirname(storePath), "key");
}

export function parseLocalKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 32) {
    return decoded;
  }
  throw new Error(
    "MSM_LOCAL_KEY must be 32 bytes encoded as 64-char hex or base64"
  );
}

export function generateLocalKey(): Buffer {
  return crypto.randomBytes(32);
}

export function encryptLocal(data: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptLocal(blob: Buffer, key: Buffer): Buffer {
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function isGitRepository(cwd = process.cwd()): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function assertStoreGitignored(
  storePath: string,
  cwd = process.cwd()
): void {
  if (!isGitRepository(cwd)) {
    console.warn(
      "Not a git repository; skipping gitignore check for the local store."
    );
    return;
  }

  try {
    execFileSync("git", ["check-ignore", "-q", storePath], {
      cwd,
      stdio: "pipe",
    });
  } catch {
    throw new Error(
      `Local secret store at ${storePath} must be gitignored. Add "${storePath}" or ".msm/" to .gitignore.`
    );
  }
}

export function ensureGitignoreEntry(
  entry = ".msm/",
  cwd = process.cwd()
): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    writeFileSecure(gitignorePath, `${entry}\n`, 0o644);
    console.error(`Added ${entry} to .gitignore`);
    return;
  }

  const contents = fs.readFileSync(gitignorePath, "utf8");
  const lines = contents.split(/\r?\n/);
  if (lines.some((line) => line.trim() === entry || line.trim() === ".msm")) {
    return;
  }

  const prefix = contents.endsWith("\n") || contents.length === 0 ? "" : "\n";
  fs.appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  console.error(`Added ${entry} to .gitignore`);
}

export function resolveLocalKey(keyPath?: string): Buffer {
  if (process.env.MSM_LOCAL_KEY) {
    return parseLocalKey(process.env.MSM_LOCAL_KEY);
  }

  const resolved = keyPath || defaultLocalKeyPath();
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `Local store key not found at ${resolved}. Set MSM_LOCAL_KEY or run msm --init.`
    );
  }

  return parseLocalKey(fs.readFileSync(resolved, "utf8"));
}

export function writeLocalKey(keyPath: string, key = generateLocalKey()): Buffer {
  writeFileSecure(keyPath, key.toString("hex"), 0o600);
  return key;
}

function sanitizeSecretName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export class LocalBackend implements SecretBackend {
  readonly provider = "local" as const;

  constructor(
    private readonly storePath: string,
    private readonly key: Buffer
  ) {}

  private secretDir(name: string): string {
    return path.join(this.storePath, sanitizeSecretName(name));
  }

  private versionsDir(name: string): string {
    return path.join(this.secretDir(name), "versions");
  }

  async get(name: string): Promise<SecretPayload> {
    const currentPath = path.join(this.secretDir(name), "current");
    if (!fs.existsSync(currentPath)) {
      throw new Error(`No data found for secret ${name}`);
    }
    const version = fs.readFileSync(currentPath, "utf8").trim();
    const blob = fs.readFileSync(path.join(this.versionsDir(name), version));
    return { data: decryptLocal(blob, this.key) };
  }

  async put(name: string, payload: SecretPayload): Promise<void> {
    const versionsDir = this.versionsDir(name);
    fs.mkdirSync(versionsDir, { recursive: true });

    const existing = fs
      .readdirSync(versionsDir)
      .map((entry) => Number(entry))
      .filter((value) => Number.isInteger(value));
    const next = existing.length > 0 ? Math.max(...existing) + 1 : 1;

    writeFileSecure(
      path.join(versionsDir, String(next)),
      encryptLocal(payload.data, this.key),
      0o600
    );
    writeFileSecure(path.join(this.secretDir(name), "current"), String(next), 0o600);
    console.error(`Wrote local secret ${name} version ${next}`);
  }

  async listVersions(name: string): Promise<SecretVersion[]> {
    const versionsDir = this.versionsDir(name);
    if (!fs.existsSync(versionsDir)) {
      return [];
    }

    return fs.readdirSync(versionsDir).map((id) => {
      const numeric = Number(id);
      const stat = fs.statSync(path.join(versionsDir, id));
      return {
        id,
        createdAt: Number.isFinite(numeric) ? new Date(numeric) : stat.mtime,
        enabled: true,
      };
    });
  }

  async destroyVersions(name: string, policy: DeletePolicy): Promise<void> {
    if (policy.enabled === false) {
      return;
    }

    const currentPath = path.join(this.secretDir(name), "current");
    const current = fs.existsSync(currentPath)
      ? fs.readFileSync(currentPath, "utf8").trim()
      : "";
    const versions = await this.listVersions(name);
    const toDestroy = versionsToDestroy(versions, policy).filter(
      (version) => version.id !== current
    );
    if (toDestroy.length === 0) {
      return;
    }

    console.error(`Cleaning up ${toDestroy.length} old version(s) of ${name}`);
    for (const version of toDestroy) {
      fs.unlinkSync(path.join(this.versionsDir(name), version.id));
    }
  }
}

export async function createLocalBackend(
  environment: EnvironmentConfig
): Promise<LocalBackend> {
  const storePath = environment.storePath || defaultLocalStorePath();
  assertStoreGitignored(storePath);
  const key = resolveLocalKey(environment.keyPath || defaultLocalKeyPath(storePath));
  fs.mkdirSync(storePath, { recursive: true });
  return new LocalBackend(storePath, key);
}
