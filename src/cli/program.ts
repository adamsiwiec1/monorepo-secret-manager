import { Command, CommanderError } from "commander";

export interface GlobalOptions {
  env?: string;
  config: string;
  ambientCreds?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  color: boolean;
}

export interface PullOptions extends GlobalOptions {
  writeTargets?: boolean;
}

export interface ExportOptions extends GlobalOptions {
  format: "dotenv" | "json" | "github";
}

export interface CiOptions extends GlobalOptions {
  workflow: string;
  setSecrets?: boolean;
}

export interface Handlers {
  init(opts: GlobalOptions): Promise<void>;
  status(opts: GlobalOptions): Promise<void>;
  list(opts: GlobalOptions): Promise<void>;
  push(service: string, opts: GlobalOptions): Promise<void>;
  pull(service: string, opts: PullOptions): Promise<void>;
  peek(service: string, opts: GlobalOptions): Promise<void>;
  prune(service: string, opts: GlobalOptions): Promise<void>;
  export(service: string, opts: ExportOptions): Promise<void>;
  run(service: string, command: string[], opts: GlobalOptions): Promise<void>;
  ciSetup(service: string, opts: CiOptions): Promise<void>;
  serviceAdd(opts: GlobalOptions): Promise<void>;
  serviceRm(name: string, opts: GlobalOptions): Promise<void>;
}

export const HELP = `msm - monorepo secret manager

Usage:
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

Examples
  msm init
  msm pull -e staging
  msm push api -e production -y
  msm run api -- npm start
  msm export api -e staging --format github
  msm ci setup -e staging --set-secrets
`;

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

/**
 * Build the CLI. `runArgs` holds everything after a bare `--`, which `main`
 * strips before commander sees argv.
 */
export function createProgram(
  handlers: Handlers,
  version: string,
  runArgs: string[] = [],
  output?: { writeOut?: (s: string) => void; writeErr?: (s: string) => void }
): Command {
  const program = new Command("msm");
  // Set before subcommands are added so they inherit it.
  program.exitOverride();
  if (output) program.configureOutput(output);
  program
    .version(version, "-V, --version")
    .option("-e, --env <name>", "environment")
    .option("--config <path>", "config file", ".secrets-config")
    .option("--ambient-creds", "use ambient cloud credentials")
    .option("--dry-run", "show what would happen")
    .option("--json", "machine-readable output")
    .option("-y, --yes", "skip confirms")
    .option("--no-color", "disable color")
    .showSuggestionAfterError(true)
    .helpCommand(false);
  program.helpInformation = () => HELP;

  program.command("init").description("set up .secrets-config").action((_o, c) => handlers.init(globals(c)));
  program.command("status").description("check config, creds, and SDKs").action((_o, c) => handlers.status(globals(c)));
  program.command("list").alias("ls").description("show services and items").action((_o, c) => handlers.list(globals(c)));

  for (const verb of ["push", "peek", "prune"] as const) {
    program
      .command(`${verb} [service]`)
      .description(`${verb} secrets (default: all)`)
      .action((service: string | undefined, _o, c) => handlers[verb](service || "all", globals(c)));
  }

  program
    .command("pull [service]")
    .description("download secrets (default: all)")
    .option("--write-targets", "also write target paths")
    .action((service: string | undefined, _o, c) => handlers.pull(service || "all", globals(c) as PullOptions));

  program
    .command("export [service]")
    .description("print env values for CI")
    .option("--format <format>", "dotenv | json | github", "dotenv")
    .action((service: string | undefined, _o, c) => {
      const opts = globals(c) as ExportOptions;
      if (opts.json) opts.format = "json";
      if (!["dotenv", "json", "github"].includes(opts.format)) {
        throw new CommanderError(1, "msm.format", `Unknown --format '${opts.format}'. Use dotenv, json, or github.`);
      }
      return handlers.export(service || "all", opts);
    });

  program
    .command("run [service]")
    .description("run a command with secrets in its env")
    .action((service: string | undefined, _o, c) => {
      if (runArgs.length === 0) {
        throw new CommanderError(1, "msm.run", "Missing command. Usage: msm run [service] -- <cmd> [args...]");
      }
      return handlers.run(service || "all", runArgs, globals(c));
    });

  const ci = program.command("ci").description("configure CI");
  ci.command("setup [service]")
    .description("write a GitHub Actions workflow via gh")
    .option("--workflow <path>", "workflow file", ".github/workflows/msm.yml")
    .option("--set-secrets", "set auth secrets with gh secret set")
    .action((service: string | undefined, _o, c) => handlers.ciSetup(service || "all", globals(c) as CiOptions));

  const service = program.command("service").description("manage services");
  service.command("add").description("add a service").action((_o, c) => handlers.serviceAdd(globals(c)));
  service
    .command("rm <name>")
    .alias("remove")
    .description("remove a service")
    .action((name: string, _o, c) => handlers.serviceRm(name, globals(c)));

  return program;
}

/** Split argv at the first bare `--` so `msm run` can pass flags to the child. */
export function splitRunArgs(argv: string[]): { args: string[]; runArgs: string[] } {
  const index = argv.indexOf("--");
  if (index === -1) return { args: argv, runArgs: [] };
  return { args: argv.slice(0, index), runArgs: argv.slice(index + 1) };
}
