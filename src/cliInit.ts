import fs from "fs";
import {
  defaultLocalKeyPath,
  defaultLocalStorePath,
  ensureGitignoreEntry,
  writeLocalKey,
} from "./backends/local";
import { ConfigManager } from "./ConfigManager";
import { EnvironmentConfig, Provider, SecretsConfig, ServiceConfig } from "./types";
import { createPrompt } from "./prompt";
import { detectWorkspace, serviceNameFor, WorkspaceInfo } from "./workspace";
import { envSuffix } from "./pathUtils";

const PROVIDERS: Provider[] = ["gcp", "aws", "azure", "local"];

export interface InitOptions {
  configPath: string;
  /** Accept every default, no prompts. */
  yes?: boolean;
  root?: string;
  log?: (line: string) => void;
}

type Ask = (prompt: string, fallback: string) => Promise<string>;

async function promptEnvironment(ask: Ask, label: string, provider: Provider): Promise<EnvironmentConfig> {
  switch (provider) {
    case "gcp":
      return {
        provider,
        projectId: await ask(`${label} GCP project ID`, `your-${label}-project`),
        credentials: { path: await ask(`${label} service account JSON path`, `gcloud/${label}/service-account.json`) },
      };
    case "aws": {
      const region = await ask(`${label} AWS region`, "us-east-1");
      const profile = await ask(`${label} AWS profile (empty for default)`, "");
      return { provider, region, credentials: profile ? { profile } : undefined };
    }
    case "azure":
      return { provider, vaultUrl: await ask(`${label} Key Vault URL`, "https://my-vault.vault.azure.net/") };
    default:
      return { provider: "local", storePath: defaultLocalStorePath() };
  }
}

/** Env-file service for a workspace package. Paths are relative to the package. */
export function packageService(pkgDir: string): ServiceConfig {
  const name = serviceNameFor(pkgDir);
  return {
    name,
    package: pkgDir,
    secrets: [
      {
        kind: "env-file",
        remoteName: `${name}-env-file`,
        sourcePath: ".env.{env}",
        targetPath: ".env",
      },
    ],
  };
}

/** Build a v3 config. Pure so it can be tested without prompts. */
export function buildInitialConfig(
  workspace: WorkspaceInfo,
  environments: Record<string, EnvironmentConfig>
): SecretsConfig {
  const names = Object.keys(environments);
  return {
    version: 3,
    defaultEnv: names.includes("staging") ? "staging" : names[0],
    environments,
    services: workspace.packages.map(packageService),
    shared: [],
    deletePolicy: { maxVersions: 10, maxAgeDays: 30, enabled: true },
  };
}

export async function initializeConfig(options: InitOptions): Promise<SecretsConfig> {
  const log = options.log || ((line: string) => console.log(line));
  const root = options.root || process.cwd();
  const interactive = !options.yes && Boolean(process.stdin.isTTY);
  const prompt = interactive ? createPrompt() : null;
  const ask: Ask = async (label, fallback) => {
    if (!prompt) return fallback;
    return (await prompt.question(`${label} [${fallback}]: `)) || fallback;
  };

  try {
    if (fs.existsSync(options.configPath)) {
      throw new Error(`${options.configPath} already exists. Edit it, or use 'msm service add'.`);
    }

    const workspace = detectWorkspace(root);
    log(
      workspace.tools.length
        ? `Detected ${workspace.tools.join(" + ")} workspace with ${workspace.packages.length} package(s)`
        : "No workspace tool detected. Add services later with 'msm service add'."
    );

    const envNames = (await ask("Environments (comma separated)", "staging,production"))
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const providerInput = (await ask("Provider [gcp/aws/azure/local]", "local")).toLowerCase() as Provider;
    const provider = PROVIDERS.includes(providerInput) ? providerInput : "local";

    const environments: Record<string, EnvironmentConfig> = {};
    for (const name of envNames) {
      environments[name] = await promptEnvironment(ask, name, provider);
    }

    const config = buildInitialConfig(workspace, environments);
    fs.writeFileSync(options.configPath, JSON.stringify(config, null, 2) + "\n");
    log(`Wrote ${options.configPath}`);

    if (provider === "local") {
      ensureGitignoreEntry(".msm/");
      const storePath = defaultLocalStorePath();
      const keyPath = defaultLocalKeyPath(storePath);
      fs.mkdirSync(storePath, { recursive: true });
      if (!fs.existsSync(keyPath) && !process.env.MSM_LOCAL_KEY) {
        writeLocalKey(keyPath);
        log(`Created local key at ${keyPath} (gitignored)`);
      }
    }

    for (const service of config.services) {
      for (const env of envNames) {
        const file = `${service.package}/.env.${envSuffix(env)}`;
        if (!fs.existsSync(file)) {
          fs.writeFileSync(file, `# ${service.name} ${env}\n`, { mode: 0o600 });
        }
      }
    }
    if (config.services.length) {
      log(`Services: ${config.services.map((s) => s.name).join(", ")}`);
      log("Add .env.* to .gitignore if it is not ignored yet.");
    }
    log("Next: fill in the .env files, then run 'msm push'.");
    return config;
  } finally {
    prompt?.close();
  }
}

export async function addService(configPath: string): Promise<void> {
  const manager = new ConfigManager(configPath);
  const config = manager.getConfig();
  const existing = manager.getServiceNames();
  const { question, close } = createPrompt();

  try {
    let name = "";
    while (!name) {
      name = (await question("Service name: ")).trim();
      if (existing.includes(name) || name === "all" || name === "shared") {
        console.log(`'${name}' is taken. Pick another name.`);
        name = "";
      }
    }
    const pkg = (await question("Workspace package dir (empty for none) []: ")).trim();
    let service: ServiceConfig;
    if (pkg) {
      service = { ...packageService(pkg), name };
      service.secrets[0].remoteName = `${name}-env-file`;
    } else {
      const targetPath = (await question(`Target path [services/${name}/.env]: `)) || `services/${name}/.env`;
      service = {
        name,
        secrets: [
          {
            kind: "env-file",
            remoteName: `${name}-env-file`,
            sourcePath: `.environments/.${name}.{env}.env`,
            targetPath,
          },
        ],
      };
    }
    const shared = manager.getShared().map((item) => item.remoteName);
    if (shared.length) {
      const uses = (await question(`Shared secrets to use (${shared.join(", ")}) []: `))
        .split(",")
        .map((s) => s.trim())
        .filter((s) => shared.includes(s));
      if (uses.length) service.uses = uses;
    }
    config.services.push(service);
    manager.writeConfig(config);
    console.log(`Added service '${name}' to ${configPath}`);
  } finally {
    close();
  }
}
