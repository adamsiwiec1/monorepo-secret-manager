/** Any environment name defined under `environments` in the config. */
export type Environment = string;

export type Provider = "gcp" | "aws" | "azure" | "local";

export type SecretKindId =
  | "env-file"
  | "ssh-keypair"
  | "tls-bundle"
  | "json"
  | "binary";

export interface DeletePolicy {
  /**
   * Maximum number of secret versions to keep. When this limit is exceeded,
   * older versions will be destroyed. Set to 0 to disable automatic cleanup.
   * @default 10
   */
  maxVersions?: number;

  /**
   * Automatically destroy secret versions older than this many days.
   * Set to 0 to disable time-based cleanup.
   * @default 30
   */
  maxAgeDays?: number;

  /**
   * Whether to enable automatic cleanup of old secret versions
   * @default true
   */
  enabled?: boolean;
}

export interface CredentialsConfig {
  path?: string;
  profile?: string;
}

export interface EnvironmentConfig {
  provider: Provider;
  projectId?: string;
  region?: string;
  vaultUrl?: string;
  storePath?: string;
  keyPath?: string;
  kmsKeyId?: string;
  credentials?: CredentialsConfig;
  /** Ask before push/prune. Defaults to true for names starting with "prod". */
  protected?: boolean;
}

export interface ServiceSecretConfig {
  kind: SecretKindId;
  remoteName: string;
  sourcePath?: string;
  targetPath?: string;
  source?: Record<string, string>;
  target?: Record<string, string>;
}

export interface ServiceConfig {
  name: string;
  /** Workspace package dir (e.g. apps/api). Relative item paths resolve inside it. */
  package?: string;
  /** remoteNames of top-level `shared` items this service also pulls. */
  uses?: string[];
  secrets: ServiceSecretConfig[];
  /** @deprecated Legacy env-file path. Prefer secrets[].sourcePath. */
  envPath?: string;
  /** @deprecated Legacy env-file target. Prefer secrets[].targetPath. */
  targetPath?: string;
  /** @deprecated Legacy GCP secret prefix. Prefer secrets[].remoteName. */
  secretPrefix?: string;
}

export interface SecretsConfig {
  version?: 2 | 3;
  /** Environment used when -e is not passed. */
  defaultEnv?: string;
  environments: Record<string, EnvironmentConfig>;
  services: ServiceConfig[];
  /** Secrets used by more than one package. Paths resolve from the repo root. */
  shared?: ServiceSecretConfig[];
  deletePolicy?: DeletePolicy;
  /** Preserved when adapting a v1 config. */
  serviceAccountPaths?: Record<string, string>;
  /** Preserved when adapting a v1 config. */
  projectIds?: Record<string, string>;
}

export interface SecretEvent {
  service: string;
  kind: SecretKindId;
  remoteName: string;
  action: "push" | "pull" | "write" | "peek" | "prune";
  status: "ok" | "error" | "skipped" | "dry-run";
  paths?: string[];
  output?: string;
  error?: string;
}

export interface MonorepoSecretManagerOptions {
  environment: Environment;
  overrideSa?: boolean;
  configPath?: string;
  /** Report what would happen without writing anywhere. */
  dryRun?: boolean;
  /** Receives one event per secret item. Defaults to console output. */
  onEvent?: (event: SecretEvent) => void;
}

/** @deprecated Use MonorepoSecretManagerOptions. */
export type GcpMonorepoSecretManagerOptions = MonorepoSecretManagerOptions;

/**
 * Base configuration interface with common properties for all services
 */
export interface BaseConfig {
  env: "STG" | "PROD";
}

/**
 * Service-specific configuration options for loadConfig
 */
export interface ConfigOptions {
  /** The service name, used for logging and identifying the service */
  serviceName: string;
  /** Required for the GCP provider */
  projectId?: string;
  /** Secret backend. Defaults to gcp for backward compatibility. */
  provider?: Provider;
  /** Optional path to the .env file */
  envPath?: string;
  /** Optional custom secret name (defaults to "{SERVICE_NAME}_ENV_FILE") */
  secretName?: string;
  /** Required environment variables that must be present */
  requiredEnvVars?: string[];
  /** Required for the AWS provider */
  region?: string;
  /** Required for the Azure provider */
  vaultUrl?: string;
  /** Optional local store directory */
  storePath?: string;
}
