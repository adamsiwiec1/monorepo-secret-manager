# Migrating to 3.0

3.0 replaces the flag-based CLI with subcommands. The old flags are gone, so update scripts and CI before upgrading. The SDK and existing `.secrets-config` files keep working.

| 2.x | 3.0 |
| --- | --- |
| `msm --init` | `msm init` |
| `msm --list` | `msm list` |
| `msm --add-service` / `--remove-service` | `msm service add` / `msm service rm <name>` |
| `msm --upload --service all --stg` | `msm push -e staging` |
| `msm --download --service api --prod --set` | `msm pull api -e production --write-targets` |
| `msm --peek --service all --stg` | `msm peek -e staging` |
| `msm --cleanup --service api --prod` | `msm prune api -e production` |
| `--override-sa` | `--ambient-creds` |
| `--stg` / `--prod` | `-e staging` / `-e production` (or any env name) |

Other changes:

- The service argument is optional and defaults to all services.
- Add `"defaultEnv": "staging"` to your config to skip `-e` on most commands.
- `push` and `prune` ask for confirmation on environments whose name starts with `prod`, or that set `"protected": true`. In CI, pass `-y`.
- Node.js 18 or later is required.
- Backend progress lines now go to stderr, so `--json` output on stdout stays parseable.
- `MonorepoSecretManager` methods now return a list of `SecretEvent`s, and `{env}` expands to the env name for anything other than `staging` and `production`.

v3 config adds `defaultEnv`, any environment names, `shared`, `services[].package`, and `services[].uses`. Nothing needs to change in a v2 file to keep using it.

# Migration from gcp-monorepo-secret-manager

npm cannot rename a package. `monorepo-secret-manager` is a new name. The old name stays installable and should be deprecated, not unpublished.

## For consumers

```bash
npm uninstall gcp-monorepo-secret-manager
npm install monorepo-secret-manager
```

If you use GCP, also install the optional SDK:

```bash
npm install @google-cloud/secret-manager
```

Update imports:

```ts
// before
import { loadConfig, GcpMonorepoSecretManager } from "gcp-monorepo-secret-manager";

// after
import { loadConfig, MonorepoSecretManager } from "monorepo-secret-manager";
```

`GcpMonorepoSecretManager` still works as a deprecated alias for one major version.

The `msm` binary name is unchanged. If you also move to 3.0, update CLI calls using the table above.

Existing `.secrets-config` files that use `serviceAccountPaths` and `projectIds` are still valid. They are treated as GCP. Run `msm init` in a fresh checkout when you want a provider-aware config.

## For maintainers: publish and deprecate

Run these from the **repo root**, not from `compat/`. npm will prompt for a 2FA OTP (or pass `--otp=XXXXXX`).

```bash
cd /path/to/gcp-monorepo-secret-manager
npm publish --access public --otp=XXXXXX
npm run publish:shim -- --otp=XXXXXX
npm run deprecate:legacy
```

`publish:shim` publishes `compat/gcp-monorepo-secret-manager` as `gcp-monorepo-secret-manager@1.2.0`. Do not `cd` into that folder first.

Do not unpublish `gcp-monorepo-secret-manager`. That breaks existing `1.1.0` installs.

## GitHub repository

The source repo is
[`adamsiwiec1/monorepo-secret-manager`](https://github.com/adamsiwiec1/monorepo-secret-manager).
Old clone URLs (`the-freetech-company/gcp-monorepo-secret-manager` and
`adamsiwiec1/gcp-monorepo-secret-manager`) redirect.
