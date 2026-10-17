# Monorepo Secret Manager

[![npm version](https://img.shields.io/npm/v/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)
[![npm downloads](https://img.shields.io/npm/dm/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)
[![CI](https://github.com/adamsiwiec1/monorepo-secret-manager/actions/workflows/publish.yml/badge.svg)](https://github.com/adamsiwiec1/monorepo-secret-manager/actions/workflows/publish.yml)
[![license](https://img.shields.io/npm/l/monorepo-secret-manager.svg)](LICENSE)
[![node](https://img.shields.io/node/v/monorepo-secret-manager.svg)](https://www.npmjs.com/package/monorepo-secret-manager)

CLI and TypeScript SDK for syncing env files, SSH keypairs, TLS bundles, JSON, and binary secrets across a monorepo. Store them in [GCP Secret Manager](https://cloud.google.com/secret-manager), [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/), [Azure Key Vault](https://learn.microsoft.com/azure/key-vault/), or a local encrypted store.

You keep files on disk (typically under `.environments/`). `msm` uploads each item as a secret, downloads the latest version, writes it to a service path, or prunes old versions. Staging and production can use different providers — for example local staging and GCP production.

## Features

- Interactive setup (`msm --init`) plus add/remove service commands
- Upload, download, redacted peek, and cleanup for one service or all services
- Per-environment providers: `gcp`, `aws`, `azure`, or `local`
- Secret kinds: `env-file`, `ssh-keypair`, `tls-bundle`, `json`, `binary`
- `--set` writes downloaded files to each service’s target path
- `--override-sa` uses the environment credential chain (ADC, instance roles, Azure identity) instead of a local key file
- Optional delete policy to cap version count and age
- `loadConfig()` for apps that fetch an env-file secret at process start
- Cloud SDKs are optional peers — install only the backend you use

## Requirements

- Node.js 16 or later
- A backend for each environment you configure
- Credentials that can read and write secrets on that backend:
  - GCP: a service-account JSON file, or ADC / Workload Identity (`--override-sa`)
  - AWS: the default credential chain or `AWS_PROFILE`
  - Azure: `DefaultAzureCredential`
  - Local: `MSM_LOCAL_KEY` or `.msm/key` (created by `msm --init`)

Recommended IAM (or equivalent): admin/write for upload and cleanup, read/accessor for download and peek.

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

Coming from `gcp-monorepo-secret-manager`? Uninstall the old name and follow [MIGRATION.md](./MIGRATION.md).

## Quick start

**Monorepo (CLI)**

```bash
msm --init
# Edit the generated files in .environments/
msm --upload --service all --stg
msm --download --service all --stg --set
```

The init wizard asks for a provider per environment. Staging can be `local` while production is `gcp`, `aws`, or `azure`.

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

1. `.secrets-config` lists environments (provider + credentials) and services (one or more secret items).
2. Each item has a kind, local paths, and a `remoteName` on the backend.
3. Upload reads the local files and stores them under that name. Typed kinds go in a JSON envelope so every backend can carry them, including Azure (string-only).
4. Download writes the latest version back to the source path. `--set` also writes target paths.
5. `{env}` in paths becomes `stg` or `prod` depending on `--stg` / `--prod`.

`env-file` is stored as raw text by default so existing GCP `*_ENV_FILE` secrets keep working.

## Backends

| Provider | Store | Auth | Config |
| --- | --- | --- | --- |
| `gcp` | Secret Manager | ADC or a service-account JSON path | `projectId`, optional `credentials.path` |
| `aws` | Secrets Manager | Default credential chain or `AWS_PROFILE` | `region`, optional `credentials.profile` |
| `azure` | Key Vault secrets | `DefaultAzureCredential` | `vaultUrl` |
| `local` | Encrypted files under `.msm/store` | `MSM_LOCAL_KEY` or `.msm/key` | `storePath`, optional `keyPath` |

The local store uses AES-256-GCM. `msm --init` creates `.msm/key` (mode `0600`) and adds `.msm/` to `.gitignore`. The backend refuses to run if the store is in a git repo and is not ignored.

## Secret kinds

Each service can have one or more items:

| Kind | What it stores | On disk |
| --- | --- | --- |
| `env-file` | dotenv text | source/target file, mode `0600` |
| `ssh-keypair` | private + public key | private file `0600` |
| `tls-bundle` | cert, key, optional chain | key file `0600` |
| `json` | a JSON object or array | one file |
| `binary` | an opaque file | one file |

`msm --peek` prints redacted output. It never prints private keys or env values.

## Configuration

`msm --init` writes `.secrets-config` and creates empty source files. You can also copy [`.secrets-config.example`](.secrets-config.example).

`.secrets-config` v2:

```json
{
  "version": 2,
  "environments": {
    "staging": {
      "provider": "local",
      "storePath": ".msm/store"
    },
    "production": {
      "provider": "gcp",
      "projectId": "my-project-prod",
      "credentials": { "path": "gcloud/production/sa.json" }
    }
  },
  "services": [
    {
      "name": "api",
      "secrets": [
        {
          "kind": "env-file",
          "sourcePath": ".environments/.api.{env}.env",
          "targetPath": "services/api/.env",
          "remoteName": "api-env-file"
        },
        {
          "kind": "ssh-keypair",
          "remoteName": "api-deploy-ssh",
          "source": {
            "private": ".environments/api.{env}.id_ed25519",
            "public": ".environments/api.{env}.id_ed25519.pub"
          },
          "target": {
            "private": "services/api/.ssh/deploy",
            "public": "services/api/.ssh/deploy.pub"
          }
        }
      ]
    }
  ],
  "deletePolicy": {
    "maxVersions": 10,
    "maxAgeDays": 30,
    "enabled": true
  }
}
```

| Field | Description |
| --- | --- |
| `environments.*.provider` | `gcp`, `aws`, `azure`, or `local`. |
| `environments.*.projectId` | GCP project ID. |
| `environments.*.region` | AWS region. |
| `environments.*.vaultUrl` | Azure Key Vault URL. |
| `environments.*.storePath` | Local encrypted store directory. |
| `environments.*.credentials.path` | GCP service-account JSON. Unused with `--override-sa`. |
| `environments.*.credentials.profile` | Optional AWS profile. |
| `services[].name` | Name used with `--service`. |
| `services[].secrets[].kind` | One of the kinds above. |
| `services[].secrets[].remoteName` | Secret id on the backend. |
| `services[].secrets[].sourcePath` / `targetPath` | Single-file kinds. `{env}` becomes `stg` or `prod`. |
| `services[].secrets[].source` / `target` | Multi-file kinds (`private`, `public`, `cert`, `key`, `chain`). |
| `deletePolicy` | Optional. Applied after upload and by `--cleanup`. Defaults: 10 versions, 30 days, enabled. |

A v1 GCP-only file (`serviceAccountPaths` + `projectIds` + `secretPrefix`) is still loaded and treated as `provider: "gcp"` with one `env-file` item per service.

Suggested layout:

```text
your-monorepo/
├── .secrets-config
├── .environments/
├── .msm/                    # local store, gitignored
├── gcloud/production/sa.json
├── apps/web/.env
└── services/api/.env
```

Ignore local secrets:

```gitignore
.environments/
**/.env
.msm/
gcloud/**/*.json
```

`.secrets-config` is not secret by itself (project IDs and paths only). Commit it if the team shares the same layout; keep it private if you treat project IDs as internal.

## CLI

```text
msm [options]
```

| Option | Description |
| --- | --- |
| `--init` | Interactive wizard. Writes `.secrets-config` and source-file stubs. |
| `--list` | Print configured services and their secret items. |
| `--add-service` / `--remove-service` | Edit services in an existing config. |
| `--upload`, `-u` | Upload local files to the selected backend. |
| `--download`, `-d` | Download latest versions to source paths. |
| `--set` | With `--download` only: also write target paths. |
| `--peek`, `-p` | Print redacted secret contents. |
| `--cleanup`, `-c` | Destroy versions that exceed `deletePolicy`. |
| `--service`, `-s` | Service name, or `all`. |
| `--stg` / `--prod` | Required for upload, download, peek, and cleanup. |
| `--override-sa` | Skip local credential files; use the environment. |
| `--config` | Config path (default: `.secrets-config`). |
| `--help`, `-h` | Show help. |

```bash
msm --list

msm --upload --service api --stg
msm --upload --service all --prod

msm --download --service api --stg
msm --download --service all --prod --set

msm --peek --service api --stg
msm --cleanup --service all --prod

# CI / Workload Identity / instance roles
msm --download --service all --stg --set --override-sa
```

`--service` values are matched case-insensitively.

Optional scripts in a consuming repo:

```json
{
  "scripts": {
    "secrets": "msm --list",
    "env:stg": "msm --download --service all --stg --set",
    "env:prod": "msm --download --service all --prod --set",
    "env:stg:apply": "msm --upload --service all --stg",
    "env:prod:apply": "msm --upload --service all --prod",
    "env:stg:ci": "msm --download --service all --stg --set --override-sa",
    "env:prod:ci": "msm --download --service all --prod --set --override-sa"
  }
}
```

## Programmatic API

### `loadConfig(options)`

Loads variables into `process.env`. If `envPath` already exists (default `./.env`), that file is used and the backend is not called. Otherwise the latest secret is fetched, written to `envPath`, and loaded.

| Option | Type | Required | Default |
| --- | --- | --- | --- |
| `serviceName` | `string` | yes | — |
| `provider` | `"gcp"` \| `"aws"` \| `"azure"` \| `"local"` | no | `"gcp"` |
| `projectId` | `string` | for `gcp` | — |
| `region` | `string` | for `aws` | — |
| `vaultUrl` | `string` | for `azure` | — |
| `storePath` | `string` | no | local default |
| `envPath` | `string` | no | `./.env` |
| `secretName` | `string` | no | `{SERVICE_NAME}_ENV_FILE` (`serviceName` uppercased) |
| `requiredEnvVars` | `string[]` | no | — |

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

Same operations as the CLI, driven by `.secrets-config`.

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

console.log(secrets.getAvailableServices());
```

| Method | Description |
| --- | --- |
| `uploadEnv(name)` | Upload one service or `"all"`. Runs cleanup afterward if the policy is enabled. |
| `downloadEnv(name)` | Write the latest secret to source paths. |
| `setEnv(name)` | Write the latest secret to target paths. |
| `peekEnv(name)` | Print a redacted view of the latest secret. |
| `cleanupVersions(name)` | Apply `deletePolicy`. |
| `getAvailableServices()` | Service names from config. |

`GcpMonorepoSecretManager` remains as a deprecated alias of `MonorepoSecretManager`.

Also exported: `ConfigManager`, `loadConfig`, `createBackend`, `getKind`, `initSecretManagerClient`, and the TypeScript types `ConfigOptions`, `MonorepoSecretManagerOptions`, `SecretsConfig`, `ServiceConfig`, `Environment`, `Provider`, and `DeletePolicy`.

## CI/CD

Authenticate with the provider’s short-lived identity (GCP [Workload Identity Federation](https://cloud.google.com/iam/docs/workload-identity-federation), AWS roles, Azure managed identity), then download with `--override-sa`. A full example lives in [`.github/workflows/example-usage.yml`](.github/workflows/example-usage.yml).

```yaml
- uses: google-github-actions/auth@v2
  with:
    workload_identity_provider: ${{ secrets.WIF_PROVIDER }}
    service_account: ${{ secrets.WIF_SERVICE_ACCOUNT }}

- run: |
    npm install -g monorepo-secret-manager
    npm install -g @google-cloud/secret-manager
- run: msm --download --service all --stg --set --override-sa
```

Checkout must include `.secrets-config`. Prefer federated identity over checking in a JSON key.

## Secret versions

After each successful upload, versions are destroyed when they exceed `maxVersions` or `maxAgeDays`. At least one version is always kept. Cleanup failures are logged and do not fail the upload.

```bash
msm --cleanup --service api --prod
msm --cleanup --service all --stg
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Set `false` to disable automatic and manual cleanup. |
| `maxVersions` | `10` | Keep the newest N versions. `0` skips this rule. |
| `maxAgeDays` | `30` | Destroy versions older than N days. `0` skips this rule. |

## Security

- Treat `.environments/`, downloaded `.env` files, `.msm/key`, TLS keys, SSH private keys, and cloud credential files as secrets. Do not commit them.
- `msm --peek` redacts values. Still avoid piping peek output into shared logs if you have customized kinds.
- Grant the smallest role that matches the job (read vs write/admin).
- Use `--override-sa` with short-lived credentials in CI instead of long-lived keys.
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
| `npm run dev` | Run the CLI via `ts-node` |

Releases use [semantic-release](https://github.com/semantic-release/semantic-release) on `master` / `main`. See [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome under MIT. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately per [SECURITY.md](SECURITY.md) — never in a public issue.

## FOSS template

Community health files in this repo follow the shared FreeTech / OpenHat
[FOSS template](https://github.com/adamsiwiec1/foss-template)
([org fork](https://github.com/the-freetech-company/foss-template)):
Contributor Covenant, contributing, security, support, and GitHub issue/PR
templates. Product docs stay in this README and [MIGRATION.md](./MIGRATION.md).

## License

[MIT](LICENSE) © [Adam Siwiec](https://github.com/adamsiwiec1)
