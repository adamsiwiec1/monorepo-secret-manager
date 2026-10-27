import fs from "fs";
import {
  DeletePolicy,
  Environment,
  EnvironmentConfig,
  Provider,
  SecretKindId,
  SecretsConfig,
  ServiceConfig,
  ServiceSecretConfig,
} from "./types";

const SECRET_KINDS: SecretKindId[] = [
  "env-file",
  "ssh-keypair",
  "tls-bundle",
  "json",
  "binary",
];

const PROVIDERS: Provider[] = ["gcp", "aws", "azure", "local"];

interface LegacyService {
  name?: string;
  envPath?: string;
  targetPath?: string;
  secretPrefix?: string;
  secrets?: ServiceSecretConfig[];
}

interface LegacyConfig {
  serviceAccountPaths?: { staging?: string; production?: string };
  projectIds?: { staging?: string; production?: string };
  services?: LegacyService[];
  deletePolicy?: DeletePolicy;
  version?: number;
  environments?: SecretsConfig["environments"];
  defaultEnv?: string;
  shared?: ServiceSecretConfig[];
}

function isLegacyConfig(raw: LegacyConfig): boolean {
  return Boolean(
    raw.serviceAccountPaths &&
      raw.projectIds &&
      !raw.environments
  );
}

function adaptLegacyService(service: LegacyService): ServiceConfig {
  if (!service.name) {
    throw new Error("Service is missing required field: name");
  }

  const secrets =
    service.secrets && service.secrets.length > 0
      ? service.secrets
      : service.envPath && service.targetPath && service.secretPrefix
        ? [
            {
              kind: "env-file" as const,
              sourcePath: service.envPath,
              targetPath: service.targetPath,
              remoteName: `${service.secretPrefix}_ENV_FILE`,
            },
          ]
        : [];

  return {
    name: service.name,
    package: (service as ServiceConfig).package,
    uses: (service as ServiceConfig).uses,
    envPath: service.envPath,
    targetPath: service.targetPath,
    secretPrefix: service.secretPrefix,
    secrets,
  };
}

function adaptLegacyConfig(raw: LegacyConfig): SecretsConfig {
  if (
    !raw.serviceAccountPaths?.staging ||
    !raw.serviceAccountPaths.production ||
    !raw.projectIds?.staging ||
    !raw.projectIds.production
  ) {
    throw new Error(
      "Legacy configuration must include serviceAccountPaths and projectIds for both staging and production"
    );
  }

  return {
    version: 2,
    environments: {
      staging: {
        provider: "gcp",
        projectId: raw.projectIds.staging,
        credentials: { path: raw.serviceAccountPaths.staging },
      },
      production: {
        provider: "gcp",
        projectId: raw.projectIds.production,
        credentials: { path: raw.serviceAccountPaths.production },
      },
    },
    services: (raw.services || []).map(adaptLegacyService),
    deletePolicy: raw.deletePolicy,
    serviceAccountPaths: {
      staging: raw.serviceAccountPaths.staging,
      production: raw.serviceAccountPaths.production,
    },
    projectIds: {
      staging: raw.projectIds.staging,
      production: raw.projectIds.production,
    },
  };
}

function validateItem(owner: string, secret: ServiceSecretConfig, index: number): void {
  if (!secret.kind || !SECRET_KINDS.includes(secret.kind)) {
    throw new Error(`${owner} secret at index ${index} has an invalid kind`);
  }
  if (!secret.remoteName) {
    throw new Error(`${owner} secret at index ${index} is missing remoteName`);
  }
}

function normalizeService(service: LegacyService, index: number): ServiceConfig {
  if (!service.name) {
    throw new Error(`Service at index ${index} is missing required field: name`);
  }

  const normalized = adaptLegacyService(service);
  if ((!normalized.secrets || normalized.secrets.length === 0) && normalized.uses?.length) {
    normalized.secrets = [];
    return normalized;
  }
  if (!normalized.secrets || normalized.secrets.length === 0) {
    throw new Error(
      `Service '${service.name}' must include secrets or legacy envPath, targetPath, and secretPrefix`
    );
  }

  normalized.secrets.forEach((secret, secretIndex) =>
    validateItem(`Service '${service.name}'`, secret, secretIndex)
  );

  return normalized;
}

function validateEnvironment(label: Environment, environment: EnvironmentConfig): void {
  if (!environment || !PROVIDERS.includes(environment.provider)) {
    throw new Error(
      `environments.${label}.provider must be one of: ${PROVIDERS.join(", ")}`
    );
  }

  switch (environment.provider) {
    case "gcp":
      if (!environment.projectId) {
        throw new Error(`environments.${label}.projectId is required for the GCP provider`);
      }
      break;
    case "aws":
      if (!environment.region) {
        throw new Error(`environments.${label}.region is required for the AWS provider`);
      }
      break;
    case "azure":
      if (!environment.vaultUrl) {
        throw new Error(`environments.${label}.vaultUrl is required for the Azure provider`);
      }
      break;
    case "local":
      break;
    default:
      break;
  }
}

export class ConfigManager {
  private config: SecretsConfig;
  private configPath: string;

  constructor(configPath: string = ".secrets-config") {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.validateConfig();
  }

  private loadConfig(): SecretsConfig {
    if (!fs.existsSync(this.configPath)) {
      throw new Error(
        `Configuration file not found at ${this.configPath}. Please create a .secrets-config file. Run 'msm --init' to generate a template.`
      );
    }

    let raw: LegacyConfig;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
    } catch (error) {
      throw new Error(
        `Failed to parse configuration file: ${(error as Error).message}`
      );
    }

    if (isLegacyConfig(raw)) {
      return adaptLegacyConfig(raw);
    }

    if (
      !raw.environments ||
      typeof raw.environments !== "object" ||
      Object.keys(raw.environments).length === 0
    ) {
      throw new Error(
        "Config must define at least one environment under 'environments', e.g. { \"staging\": { \"provider\": \"local\" } }"
      );
    }

    return {
      version: raw.version === 3 ? 3 : 2,
      defaultEnv: raw.defaultEnv,
      environments: raw.environments,
      shared: raw.shared,
      services: (raw.services || []).map((service, index) =>
        normalizeService(service, index)
      ),
      deletePolicy: raw.deletePolicy,
      serviceAccountPaths: raw.serviceAccountPaths as SecretsConfig["serviceAccountPaths"],
      projectIds: raw.projectIds as SecretsConfig["projectIds"],
    };
  }

  private validateConfig(): void {
    for (const [name, env] of Object.entries(this.config.environments)) {
      validateEnvironment(name, env);
    }

    if (this.config.defaultEnv && !this.config.environments[this.config.defaultEnv]) {
      throw new Error(
        `defaultEnv '${this.config.defaultEnv}' is not defined. Environments: ${this.getEnvironmentNames().join(", ")}`
      );
    }

    const shared = this.config.shared || [];
    if (!Array.isArray(shared)) {
      throw new Error("shared must be an array if provided");
    }
    shared.forEach((item, index) => validateItem("shared", item, index));
    const sharedNames = new Set(shared.map((item) => item.remoteName));
    for (const service of this.config.services || []) {
      if (service.name === "shared" || service.name === "all") {
        throw new Error(`'${service.name}' is a reserved service name`);
      }
      for (const used of service.uses || []) {
        if (!sharedNames.has(used)) {
          throw new Error(
            `Service '${service.name}' uses '${used}', which is not in shared`
          );
        }
      }
    }

    if (this.config.services && !Array.isArray(this.config.services)) {
      throw new Error("Services must be an array if provided");
    }

    if (this.config.deletePolicy) {
      this.validateDeletePolicy(this.config.deletePolicy);
    }
  }

  private validateDeletePolicy(policy: DeletePolicy): void {
    if (
      policy.maxVersions !== undefined &&
      (policy.maxVersions < 0 || !Number.isInteger(policy.maxVersions))
    ) {
      throw new Error("deletePolicy.maxVersions must be a non-negative integer");
    }

    if (
      policy.maxAgeDays !== undefined &&
      (policy.maxAgeDays < 0 || !Number.isInteger(policy.maxAgeDays))
    ) {
      throw new Error("deletePolicy.maxAgeDays must be a non-negative integer");
    }

    if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") {
      throw new Error("deletePolicy.enabled must be a boolean");
    }
  }

  getConfig(): SecretsConfig {
    return this.config;
  }

  getEnvironmentNames(): string[] {
    return Object.keys(this.config.environments);
  }

  /** defaultEnv, else staging if defined, else the first environment. */
  getDefaultEnv(): string {
    const names = this.getEnvironmentNames();
    return this.config.defaultEnv || (names.includes("staging") ? "staging" : names[0]);
  }

  getEnvironmentConfig(environment: Environment): EnvironmentConfig {
    const config = this.config.environments[environment];
    if (!config) {
      throw new Error(
        `Unknown environment '${environment}'. Environments: ${this.getEnvironmentNames().join(", ")}`
      );
    }
    return config;
  }

  /** Production-like envs ask for confirmation before push/prune. */
  isProtected(environment: Environment): boolean {
    const config = this.getEnvironmentConfig(environment);
    if (typeof config.protected === "boolean") return config.protected;
    return /^prod/i.test(environment);
  }

  getShared(): ServiceSecretConfig[] {
    return this.config.shared || [];
  }

  getServiceAccountPath(environment: Environment): string {
    const fromLegacy = this.config.serviceAccountPaths?.[environment];
    if (fromLegacy) {
      return fromLegacy;
    }

    const path = this.getEnvironmentConfig(environment).credentials?.path;
    if (!path) {
      throw new Error(
        `No service account path configured for ${environment}`
      );
    }
    return path;
  }

  getProjectId(environment: Environment): string {
    const fromLegacy = this.config.projectIds?.[environment];
    if (fromLegacy) {
      return fromLegacy;
    }

    const projectId = this.getEnvironmentConfig(environment).projectId;
    if (!projectId) {
      throw new Error(`No project ID configured for ${environment}`);
    }
    return projectId;
  }

  getServices(): ServiceConfig[] {
    return this.config.services || [];
  }

  getServiceByName(name: string): ServiceConfig | undefined {
    return this.getServices().find((service) => service.name === name);
  }

  getServiceNames(): string[] {
    return this.getServices().map((service) => service.name);
  }

  getDeletePolicy(): DeletePolicy {
    return (
      this.config.deletePolicy || {
        maxVersions: 10,
        maxAgeDays: 30,
        enabled: true,
      }
    );
  }

  writeConfig(config: SecretsConfig = this.config): void {
    this.config = config;
    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  static generateTemplate(outputPath: string = ".secrets-config"): void {
    const template: SecretsConfig = {
      version: 3,
      defaultEnv: "staging",
      environments: {
        staging: { provider: "local", storePath: ".msm/store" },
        production: { provider: "local", storePath: ".msm/store" },
      },
      services: [],
      deletePolicy: { maxVersions: 10, maxAgeDays: 30, enabled: true },
    };

    fs.writeFileSync(outputPath, JSON.stringify(template, null, 2) + "\n");
  }
}
