# Monorepo Secret Manager

[![npm version](https://img.shields.io/npm/v/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)
[![npm downloads](https://img.shields.io/npm/dm/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)
[![CI](https://github.com/adamsiwiec1/monorepo-secret-manager/actions/workflows/publish.yml/badge.svg)](https://github.com/adamsiwiec1/monorepo-secret-manager/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/monorepo-secret-manager.svg)](LICENSE)
[![node](https://img.shields.io/node/v/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)

CLI and TypeScript SDK for syncing env files, SSH keypairs, TLS bundles, JSON, and binary secrets across a monorepo. Store them in [GCP Secret Manager](https://cloud.google.com/secret-manager), [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/), [Azure Key Vault](https://learn.microsoft.com/azure/key-vault/), or a local encrypted store.

You keep files on disk next to each package (or under `.environments/`). `msm push` uploads each item as a secret, `msm pull` downloads the latest version, and `msm run` injects env values straight into a process. Each environment picks its own provider, so staging can stay local while production uses GCP.

## Install

Global CLI (exposes `msm` and `monorepo-secret-manager`):

```bash
npm install -g monorepo-secret-manager
```

As a project dependency (CLI via `npx` / npm scripts, plus the SDK):

```bash
npm install monorepo-secret-manager
```

```bash
npx msm --help
```

Install only the SDK for the backend you use:

```bash
npm install @google-cloud/secret-manager
npm install @aws-sdk/client-secrets-manager
npm install @azure/identity @azure/keyvault-secrets
```

The local backend is built in. No extra package is required.

If a provider SDK is missing, the CLI fails with:

```text
Provider "aws" requires @aws-sdk/client-secrets-manager. Run: npm i -D @aws-sdk/client-secrets-manager
```

Upgrading from 2.x or from `gcp-monorepo-secret-manager`? See [MIGRATION.md](./MIGRATION.md).


## Features

- `msm init` detects pnpm, npm, yarn, turbo, and nx workspaces and adds one service per package
- Works with zero cloud setup: `init` defaults to the built-in encrypted local store
- Any environment names you like (`dev`, `qa`, `prod-eu`), with a `defaultEnv` so you rarely pass `-e`
- Services map to workspace packages, so paths stay short (`.env.{env}` inside `apps/api`)
- Shared secrets that several packages use, stored once
- `push`, `pull`, `peek`, and `prune` for one service or all of them
- `msm run -- <cmd>` and `msm export` for local dev and CI, without writing files
- Confirms before `push` or `prune` on production-like environments
- Colored output on a TTY, plain text when piped, `--json` for scripts
- Providers: `gcp`, `aws`, `azure`, or `local`. Cloud SDKs are optional peers.
- Secret kinds: `env-file`, `ssh-keypair`, `tls-bundle`, `json`, `binary`
- `loadConfig()` for apps that fetch an env-file secret at process start

## Requirements

- Node.js 18 or later
- A backend for each environment you configure
- Credentials that can read and write secrets on that backend:
  - GCP: a service-account JSON file, or ADC / Workload Identity (`--ambient-creds`)
  - AWS: the default credential chain or `AWS_PROFILE`
  - Azure: `DefaultAzureCredential`
  - Local: `MSM_LOCAL_KEY` or `.msm/key` (created by `msm init`)

Recommended IAM (or equivalent): write access for `push` and `prune`, read access for `pull`, `peek`, `export`, and `run`.

## Quick start

**Monorepo (CLI)**

```bash
msm init               # detects your workspace, writes .secrets-config
# fill in apps/*/.env.stg and friends
msm push               # all services, default env
msm pull --write-targets
msm run api -- npm run dev
```

`msm init -y` takes every default without prompting. Run `msm status` any time to check config, credentials, and SDKs.

**Single service (SDK)**

```ts
import { loadConfig } from "monorepo-secret-manager";

await loadConfig({
  serviceName: "api",
  provider: "gcp",
  projectId: "my-gcp-project",
  secretName: "api-env-file",
  requiredEnvVars: ["DATABASE_URL", "API_KEY"],
});

console.log(process.env.DATABASE_URL);
```

Use the CLI when several services share one config file. Use `loadConfig` when a process should pull its own env-file secret at startup (containers, Cloud Run, functions).

## How it works

1. `.secrets-config` lists environments (provider + credentials), shared secrets, and services.
2. Each item has a kind, local paths, and a `remoteName` on the backend. When a service sets `package`, relative paths resolve inside that package.
3. `push` reads the local files and stores them under that name. Typed kinds go in a JSON envelope so every backend can carry them, including Azure (string-only).
4. `pull` writes the latest version back to the source path. `--write-targets` also writes target paths.
5. `{env}` in paths becomes `stg` for `staging`, `prod` for `production`, and the env name for anything else.

With no service argument, a command runs on every service plus `shared`. Naming a service limits it to that service. `pull`, `peek`, `export`, and `run` also include the shared items the service `uses`.

`env-file` is stored as raw text by default so existing GCP `*_ENV_FILE` secrets keep working.

## Backends

| Provider | Store | Auth | Config |
| --- | --- | --- | --- |
| `gcp` | Secret Manager | ADC or a service-account JSON path | `projectId`, optional `credentials.path` |
| `aws` | Secrets Manager | Default credential chain or `AWS_PROFILE` | `region`, optional `credentials.profile` |
| `azure` | Key Vault secrets | `DefaultAzureCredential` | `vaultUrl` |
| `local` | Encrypted files under `.msm/store` | `MSM_LOCAL_KEY` or `.msm/key` | `storePath`, optional `keyPath` |

The local store uses AES-256-GCM. `msm init` creates `.msm/key` (mode `0600`) and adds `.msm/` to `.gitignore`. The backend refuses to run if the store is in a git repo and is not ignored.

## Secret kinds

Each service can have one or more items:

| Kind | What it stores | On disk |
| --- | --- | --- |
| `env-file` | dotenv text | source/target file, mode `0600` |
| `ssh-keypair` | private + public key | private file `0600` |
| `tls-bundle` | cert, key, optional chain | key file `0600` |
| `json` | a JSON object or array | one file |
| `binary` | an opaque file | one file |

`msm peek` prints redacted output. It never prints private keys or env values.

## Configuration

`msm init` writes `.secrets-config` and creates empty `.env.*` files in each detected package. You can also copy [`.secrets-config.example`](.secrets-config.example).

`.secrets-config` v3:

```json
{
  "version": 3,
  "defaultEnv": "staging",
  "environments": {
    "staging": { "provider": "local", "storePath": ".msm/store" },
    "production": {
      "provider": "gcp",
      "projectId": "my-project-prod",
      "credentials": { "path": "gcloud/production/sa.json" }
    }
  },
  "shared": [
    {
      "kind": "env-file",
      "remoteName": "shared-env-file",
      "sourcePath": ".environments/.shared.{env}.env",
      "targetPath": ".env.shared"
    }
  ],
  "services": [
    {
      "name": "api",
      "package": "apps/api",
      "uses": ["shared-env-file"],
      "secrets": [
        {
          "kind": "env-file",
          "remoteName": "api-env-file",
          "sourcePath": ".env.{env}",
          "targetPath": ".env"
        },
        {
          "kind": "ssh-keypair",
          "remoteName": "api-deploy-ssh",
          "source": { "private": ".ssh/{env}.id_ed25519", "public": ".ssh/{env}.id_ed25519.pub" },
          "target": { "private": ".ssh/deploy", "public": ".ssh/deploy.pub" }
        }
      ]
    }
  ],
  "deletePolicy": { "maxVersions": 10, "maxAgeDays": 30, "enabled": true }
}
```

| Field | Description |
| --- | --- |
| `defaultEnv` | Env used when `-e` is omitted. Falls back to `staging`, then the first env. |
| `environments.<name>` | Any name. At least one is required. |
| `environments.*.provider` | `gcp`, `aws`, `azure`, or `local`. |
| `environments.*.projectId` | GCP project ID. |
| `environments.*.region` | AWS region. |
| `environments.*.vaultUrl` | Azure Key Vault URL. |
| `environments.*.storePath` | Local encrypted store directory. |
| `environments.*.credentials.path` | GCP service-account JSON. Unused with `--ambient-creds`. |
| `environments.*.credentials.profile` | Optional AWS profile. |
| `environments.*.protected` | Confirm before `push` and `prune`. Defaults to `true` for names starting with `prod`. |
| `shared[]` | Items used by more than one package. Paths resolve from the repo root. |
| `services[].name` | Name used on the command line. `all` and `shared` are reserved. |
| `services[].package` | Workspace package dir. Relative item paths resolve inside it. |
| `services[].uses` | `remoteName`s from `shared` that this service also reads. |
| `services[].secrets[].kind` | One of the kinds above. |
| `services[].secrets[].remoteName` | Secret id on the backend. |
| `services[].secrets[].sourcePath` / `targetPath` | Single-file kinds. |
| `services[].secrets[].source` / `target` | Multi-file kinds (`private`, `public`, `cert`, `key`, `chain`). |
| `deletePolicy` | Optional. Applied after `push` and by `prune`. Defaults: 10 versions, 30 days, enabled. |

v2 files (fixed `staging` and `production` keys) and v1 GCP-only files (`serviceAccountPaths` + `projectIds` + `secretPrefix`) still load unchanged.

Suggested layout:

```text
your-monorepo/
├── .secrets-config
├── .environments/           # shared sources, gitignored
├── .msm/                    # local store, gitignored
├── apps/api/.env.stg
└── apps/web/.env.stg
```

Ignore local secrets:

```gitignore
.environments/
**/.env
**/.env.*
.msm/
gcloud/**/*.json
```

`.secrets-config` is not secret by itself (project IDs and paths only). Commit it if the team shares the same layout; keep it private if you treat project IDs as internal.

## CLI

```text
msm <command> [options]

Core
  init                      Set up .secrets-config (detects your workspace)
  status                    Check config, environments, creds, and SDKs
  list                      Show services, packages, and items
  push [service]            Upload secrets (default: all)
  pull [service]            Download secrets (default: all)
  peek [service]            Show redacted remote values
  prune [service]           Drop old remote versions
  export [service]          Print env values for CI (dotenv, json, github)
  run [service] -- <cmd>    Run a command with secrets in its env

CI
  ci setup [service]        Write a GitHub Actions workflow via gh
    --set-secrets           Also set auth secrets with 'gh secret set'
    --workflow <path>       Default: .github/workflows/msm.yml

Services
  service add               Add a service interactively
  service rm <name>         Remove a service

Options
  -e, --env <name>          Environment (default: defaultEnv in config)
  --write-targets           With pull: also write target paths
  --ambient-creds           Use ambient cloud creds, not a key file
  --dry-run                 Show what would happen
  --json                    Machine-readable output
  -y, --yes                 Skip confirms (required for protected envs in CI)
  --config <path>           Config file (default: .secrets-config)
  --no-color                Disable color (NO_COLOR is honored too)
  -h, --help                Help
  -V, --version             Version
```

```bash
msm list
msm push api
msm push -e production -y
msm pull -e staging --write-targets
msm peek api -e production
msm prune --dry-run
msm run api -- npm start
msm export api --format json
msm service rm worker -y
```

`run` and `export` merge env-file values in order: shared items first, then the service's own, so a service can override a shared key. `run` also sets `MSM_ENV` and exits with the child's exit code.

Optional scripts in a consuming repo:

```json
{
  "scripts": {
    "dev": "msm run web -- next dev",
    "env:pull": "msm pull --write-targets",
    "env:push": "msm push"
  }
}
```

## Programmatic API

### `loadConfig(options)`

Loads variables into `process.env`. If `envPath` already exists (default `./.env`), that file is used and the backend is not called. Otherwise the latest secret is fetched, written to `envPath`, and loaded.

| Option | Type | Required | Default |
| --- | --- | --- | --- |
| `serviceName` | `string` | yes | - |
| `provider` | `"gcp"` \| `"aws"` \| `"azure"` \| `"local"` | no | `"gcp"` |
| `projectId` | `string` | for `gcp` | - |
| `region` | `string` | for `aws` | - |
| `vaultUrl` | `string` | for `azure` | - |
| `storePath` | `string` | no | local default |
| `envPath` | `string` | no | `./.env` |
| `secretName` | `string` | no | `{SERVICE_NAME}_ENV_FILE` (`serviceName` uppercased) |
| `requiredEnvVars` | `string[]` | no | - |

After load, `ENV` must be set (for example `STG` or `PROD`). Missing `requiredEnvVars` or `ENV` throws.

The default `secretName` is **not** the same as a v2 `remoteName`. Pass `secretName` explicitly when the process should read a secret created by `msm`.

```ts
import express from "express";
import { loadConfig } from "monorepo-secret-manager";

async function main() {
  await loadConfig({
    serviceName: "api",
    provider: "gcp",
    projectId: process.env.GOOGLE_CLOUD_PROJECT!,
    secretName: "api-env-file",
    requiredEnvVars: ["DATABASE_URL", "JWT_SECRET", "PORT"],
  });

  const app = express();
  app.listen(Number(process.env.PORT) || 3000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

Call `loadConfig` once at startup. Do not log secret values.

### `MonorepoSecretManager`

Same operations as the CLI, driven by `.secrets-config`. Every method returns one `SecretEvent` per item. Pass `onEvent` to handle output yourself and `dryRun: true` to skip writes.

```ts
import { MonorepoSecretManager } from "monorepo-secret-manager";

const secrets = new MonorepoSecretManager({
  environment: "production",
  overrideSa: false,
  configPath: ".secrets-config",
});

await secrets.uploadEnv("frontend");
await secrets.downloadEnv("api");
await secrets.setEnv("worker");
await secrets.peekEnv("api");
await secrets.cleanupVersions("all");
const env = await secrets.exportEnv("api"); // Record<string, string>

console.log(secrets.getAvailableServices());
```

| Method | Description |
| --- | --- |
| `uploadEnv(name)` | Upload one service or `"all"`. Runs cleanup afterward if the policy is enabled. |
| `downloadEnv(name)` | Write the latest secret to source paths. |
| `setEnv(name)` | Write the latest secret to target paths. |
| `peekEnv(name)` | Print a redacted view of the latest secret. |
| `cleanupVersions(name)` | Apply `deletePolicy`. |
| `exportEnv(name)` | Merged env-file values, without touching disk. |
| `getAvailableServices()` | Service names from config. |

`GcpMonorepoSecretManager` remains as a deprecated alias of `MonorepoSecretManager`.

Also exported: `ConfigManager`, `loadConfig`, `createBackend`, `getKind`, `initSecretManagerClient`, `detectWorkspace`, and the TypeScript types `ConfigOptions`, `MonorepoSecretManagerOptions`, `SecretsConfig`, `ServiceConfig`, `Environment`, `Provider`, `DeletePolicy`, and `SecretEvent`.

## CI/CD

Authenticate with the provider's short-lived identity (GCP [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation), AWS roles, Azure managed identity), then pull with `--ambient-creds`. A full example lives in [`.github/workflows/example-usage.yml`](.github/workflows/example-usage.yml).

```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
    service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

- run: npm install -g monorepo-secret-manager @google-cloud/secret-manager

# write files for the build
- run: msm pull -e staging --write-targets --ambient-creds

# or load values into later steps, masked in logs
- run: msm export api -e staging --format github --ambient-creds
```

`--format github` adds `::add-mask::` for every value and appends to `$GITHUB_ENV`. Non-interactive runs fail on protected envs unless you pass `-y`, so a CI `push` to production needs it explicitly.

Checkout must include `.secrets-config`. Prefer federated identity over checking in a JSON key.

### Set up CI with `gh`

```bash
msm ci setup -e staging --dry-run       # preview
msm ci setup api -e staging --set-secrets
```

Requires the [GitHub CLI](https://cli.github.com), logged in (`gh auth login`). The command:

1. Writes `.github/workflows/msm.yml` with the auth step for the env's provider, then `msm export --format github`. Rerunning leaves an identical file alone.
2. Checks the repo secrets that auth step needs and reports which are missing:

| Provider | Secrets |
| --- | --- |
| gcp | `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT` |
| aws | `AWS_ROLE_ARN` (region comes from the env config) |
| azure | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` |

With `--set-secrets`, each value comes from a shell variable of the same name, or a hidden prompt if the secret is missing. Values go to `gh secret set` over stdin and are never printed.

GitHub Actions secrets are write-only. msm can set them but can't read them back, so they can't serve as an msm backend. Keep your real secrets in GCP, AWS, or Azure. The local store is gitignored, so CI can't use it.

## Secret versions

After each successful upload, versions are destroyed when they exceed `maxVersions` or `maxAgeDays`. At least one version is always kept. Cleanup failures are logged and do not fail the upload.

```bash
msm prune api -e production
msm prune -e staging --dry-run
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable automatic and manual cleanup. |
| `maxVersions` | `10` | Keep the newest N versions. `0` skips this rule. |
| `maxAgeDays` | `30` | Destroy versions older than N days. `0` skips this rule. |

## Security

- Treat `.environments/`, downloaded `.env` files, `.msm/key`, TLS keys, SSH private keys, and cloud credential files as secrets. Do not commit them.
- `msm peek` redacts values. Still avoid piping peek output into shared logs if you have customized kinds.
- Grant the smallest role that matches the job (read vs write/admin).
- Use `--ambient-creds` with short-lived credentials in CI instead of long-lived keys.
- Keep `deletePolicy` enabled so unused versions do not pile up against provider quotas.
- The local store is refused if it is tracked by git. Keep `.msm/` ignored.

## Development

```bash
git clone https://github.com/adamsiwiec1/monorepo-secret-manager.git
cd monorepo-secret-manager
npm install
npm test
npm run build
```

| Script | Description |
| --- | --- |
| `npm test` | Jest |
| `npm run test:coverage` | Coverage report |
| `npm run build` | Compile to `dist/` |
| `npm run dev -- <command>` | Run the CLI via `ts-node` |

Releases use [semantic-release](https://github.com/semantic-release/semantic-release) on `master` / `main`. See [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome under MIT. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately per [SECURITY.md](SECURITY.md), never in a public issue.

## FOSS template

Community health files in this repo follow the shared FreeTech / OpenHat
[FOSS template](https://github.com/adamsiwiec1/foss-template)
([org fork](https://github.com/the-freetech-company/foss-template)):
Contributor Covenant, contributing, security, support, and GitHub issue/PR
templates. Product docs stay in this README and [MIGRATION.md](./MIGRATION.md).

## License

[MIT](LICENSE) © [Adam Siwiec](https://github.com/adamsiwiec1)
