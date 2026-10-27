import { Command, CommanderError } from "commander";

export interface GlobalOptions {
  env?: string;
  config: string;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
  color: boolean;
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
  pull(service: string, opts: GlobalOptions): Promise<void>;
  peek(service: string, opts: GlobalOptions): Promise<void>;
  prune(service: string, opts: GlobalOptions): Promise<void>;
  export(service: string, opts: ExportOptions): Promise<void>;
  run(service: string, command: string[], opts: GlobalOptions): Promise<void>;
  ci(service: string, opts: CiOptions): Promise<void>;
  add(opts: GlobalOptions): Promise<void>;
  rm(name: string, opts: GlobalOptions): Promise<void>;
}

export const HELP = `msm - monorepo secret manager

Usage: msm <command> [service] [options]

  init                  Create .secrets-config (detects your workspace)
  push [service]        Upload secrets
  pull [service]        Download secrets and write them to disk
  run [service] -- cmd  Run a command with secrets in its env

  status                Check config, creds, and SDKs
  list, ls              Show services and items
  peek [service]        Show redacted remote values
  prune [service]       Drop old remote versions
  export [service]      Print env values (--format dotenv|json|github)
  add                   Add a service
  rm <name>             Remove a service
  ci [service]          Write a GitHub Actions workflow via gh
                        (--set-secrets, --workflow <path>)

Options
  -e, --env <name>      Environment (default: defaultEnv)
  --dry-run             Show what would happen
  --json                JSON output
  -y, --yes             Skip prompts
  --config <path>       Config file (default: .secrets-config)
  --no-color            No color (NO_COLOR works too)

Service defaults to all. Example: msm pull -e staging && msm run api -- npm start
`;

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
  program.exitOverride(); // before subcommands so they inherit it
  if (output) program.configureOutput(output);
  program
    .version(version, "-V, --version")
    .option("-e, --env <name>")
    .option("--config <path>", "", ".secrets-config")
    .option("--dry-run")
    .option("--json")
    .option("-y, --yes")
    .option("--no-color")
    .showSuggestionAfterError(true)
    .helpCommand(false);
  program.helpInformation = () => HELP;

  const opts = <T = GlobalOptions>(c: Command) => c.optsWithGlobals() as T;
  const svc = (s?: string) => s || "all";

  program.command("init").action((_o, c) => handlers.init(opts(c)));
  program.command("status").action((_o, c) => handlers.status(opts(c)));
  program.command("list").alias("ls").action((_o, c) => handlers.list(opts(c)));
  program.command("add").action((_o, c) => handlers.add(opts(c)));
  program.command("rm <name>").alias("remove").action((name: string, _o, c) => handlers.rm(name, opts(c)));

  for (const verb of ["push", "pull", "peek", "prune"] as const) {
    program.command(`${verb} [service]`).action((s: string | undefined, _o, c) => handlers[verb](svc(s), opts(c)));
  }

  program
    .command("export [service]")
    .option("--format <format>", "", "dotenv")
    .action((s: string | undefined, _o, c) => {
      const o = opts<ExportOptions>(c);
      if (o.json) o.format = "json";
      if (!["dotenv", "json", "github"].includes(o.format)) {
        throw new CommanderError(1, "msm.format", `Unknown --format '${o.format}'. Use dotenv, json, or github.`);
      }
      return handlers.export(svc(s), o);
    });

  program.command("run [service]").action((s: string | undefined, _o, c) => {
    if (!runArgs.length) throw new CommanderError(1, "msm.run", "Missing command. Usage: msm run [service] -- <cmd>");
    return handlers.run(svc(s), runArgs, opts(c));
  });

  program
    .command("ci [service]")
    .option("--workflow <path>", "", ".github/workflows/msm.yml")
    .option("--set-secrets")
    .action((s: string | undefined, _o, c) => handlers.ci(svc(s), opts<CiOptions>(c)));

  return program;
}

/** Split argv at the first bare `--` so `msm run` can pass flags to the child. */
export function splitRunArgs(argv: string[]): { args: string[]; runArgs: string[] } {
  const i = argv.indexOf("--");
  return i === -1 ? { args: argv, runArgs: [] } : { args: argv.slice(0, i), runArgs: argv.slice(i + 1) };
}
