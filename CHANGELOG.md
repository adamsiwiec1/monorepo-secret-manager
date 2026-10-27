# [3.0.0](https://github.com/adamsiwiec1/monorepo-secret-manager/compare/v2.0.0...v3.0.0) (2026-10-27)


* feat!: CLI v3 with subcommands, any env names, and workspace-aware services ([a922153](https://github.com/adamsiwiec1/monorepo-secret-manager/commit/a9221535a39007603d4a8a836bbba9c3799091d1))


### Features

* add msm ci setup to configure GitHub Actions via gh ([d3a5610](https://github.com/adamsiwiec1/monorepo-secret-manager/commit/d3a5610d5f0da227568a517ec5cb9307ba4e002d))


### BREAKING CHANGES

* the 2.x flags (--upload, --download, --stg, --prod,
--override-sa, ...) are removed. See MIGRATION.md for the mapping.
Node.js 18+ is required.

# [2.0.0](https://github.com/adamsiwiec1/monorepo-secret-manager/compare/v1.1.0...v2.0.0) (2026-09-10)

### Features

* rename the package to `monorepo-secret-manager` and add AWS, Azure, and local backends
* add `env-file`, `ssh-keypair`, `tls-bundle`, `json`, and `binary` secret kinds
* support provider-aware `.secrets-config` v2 while still loading the GCP-only v1 shape

### BREAKING CHANGES

* the npm package name is now `monorepo-secret-manager`
* `firebase-admin` is no longer a dependency; GCP uses ADC or a service-account JSON path
* cloud SDKs are optional peer dependencies

# [1.1.0](https://github.com/the-freetech-company/gcp-monorepo-secret-manager/compare/v1.0.1...v1.1.0) (2025-07-12)


### Features

* add loadConfig to allow users to set .env at ruintime programtically in a variety of environments ([04feb21](https://github.com/the-freetech-company/gcp-monorepo-secret-manager/commit/04feb214cf8c33e97a5adb0178bc0db8ff05482c))

## [1.0.1](https://github.com/the-freetech-company/gcp-monorepo-secret-manager/compare/v1.0.0...v1.0.1) (2025-06-28)


### Bug Fixes

* readme install command + help command ([becff9d](https://github.com/the-freetech-company/gcp-monorepo-secret-manager/commit/becff9dd7e222a6ba95a7282fe4cf426e7109a80))

# 1.0.0 (2025-06-28)


### Bug Fixes

* readme ([ceffff8](https://github.com/the-freetech-company/gcp-monorepo-secret-manager/commit/ceffff89ec4a47b196ece043a950a9ccc65e01cc))
