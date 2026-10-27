import { spawn } from "child_process";
import fs from "fs";
import { ConfigManager } from "../ConfigManager";
import { MonorepoSecretManager, SHARED_SERVICE } from "../MonorepoSecretManager";
import { addService, initializeConfig } from "../cliInit";
import { createPrompt } from "../prompt";
import { SecretEvent } from "../types";
import { CiOptions, ExportOptions, GlobalOptions, Handlers } from "./program";
import { CI_SECRETS, GhRunner, renderWorkflow, requireGh, runGh, writeWorkflow } from "./ci";
import { Colors, makeColors, shouldColor } from "./ui";

const SDKS: Record<string, string[]> = {
  gcp: ["@google-cloud/secret-manager"],
  aws: ["@aws-sdk/client-secrets-manager"],
  azure: ["@azure/identity", "@azure/keyvault-secrets"],
  local: [],
};

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  confirm: (question: string) => Promise<boolean>;
  isInteractive: () => boolean;
  /** Read a value without echoing it. */
  secret?: (question: string) => Promise<string>;
  gh?: GhRunner;
}

export const defaultIo: Io = {
  out: (text) => process.stdout.write(text + "\n"),
  err: (text) => process.stderr.write(text + "\n"),
  isInteractive: () => Boolean(process.stdin.isTTY),
  secret: (question) =>
    new Promise((resolve) => {
      process.stderr.write(question);
      const stdin = process.stdin;
      let value = "";
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      const onData = (ch: string) => {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(value);
        } else if (ch === "\u0003") {
          process.exit(130);
        } else if (ch === "\u007f") {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      };
      stdin.on("data", onData);
    }),
  confirm: async (question) => {
    const { question: ask, close } = createPrompt();
    try {
      return /^y(es)?$/i.test(await ask(`${question} [y/N]: `));
    } finally {
      close();
    }
  },
};

export function createHandlers(io: Io = defaultIo): Handlers {
  const colors = (opts: GlobalOptions): Colors => makeColors(!opts.json && shouldColor(opts.color));

  const config = (opts: GlobalOptions) => new ConfigManager(opts.config);

  const resolveEnv = (opts: GlobalOptions, manager = config(opts)): string => {
    const env = opts.env || manager.getDefaultEnv();
    manager.getEnvironmentConfig(env);
    return env;
  };

  const checkService = (manager: ConfigManager, service: string) => {
    if (service === "all" || service === SHARED_SERVICE) return;
    if (!manager.getServiceNames().includes(service)) {
      throw new Error(
        `Unknown service '${service}'. Services: ${manager.getServiceNames().join(", ") || "(none)"}. Run 'msm list'.`
      );
    }
  };

  const reporter = (opts: GlobalOptions, c: Colors) => (event: SecretEvent) => {
    if (opts.json) return;
    const label = `${c.bold(event.service)} ${c.dim(event.kind)}`;
    if (event.status === "error") {
      io.err(`${c.red("✗")} ${label} ${event.error}`);
    } else if (event.action === "peek") {
      io.out(`${c.cyan("●")} ${label} ${c.dim(event.remoteName)}`);
      io.out(event.output ?? "");
    } else {
      const mark = event.status === "dry-run" ? c.yellow("○") : c.green("✓");
      const where = event.paths?.length ? c.dim(` -> ${event.paths.join(", ")}`) : "";
      io.out(`${mark} ${label} ${event.action}${event.status === "dry-run" ? c.yellow(" (dry run)") : ""}${where}`);
    }
  };

  const summarize = (opts: GlobalOptions, c: Colors, env: string, events: SecretEvent[]) => {
    if (opts.json) {
      io.out(JSON.stringify({ env, dryRun: Boolean(opts.dryRun), results: events }, null, 2));
      return;
    }
    const failed = events.filter((e) => e.status === "error").length;
    const ok = events.length - failed;
    io.out(c.dim(`${ok} ok${failed ? `, ${failed} failed` : ""} (${env})`));
  };

  const guard = async (opts: GlobalOptions, manager: ConfigManager, env: string, verb: string, service: string) => {
    if (opts.dryRun || opts.yes || !manager.isProtected(env)) return;
    if (!io.isInteractive()) {
      throw new Error(`'${env}' is protected. Pass -y to ${verb} without a prompt.`);
    }
    if (!(await io.confirm(`${verb} ${service} to ${env}?`))) {
      throw new Error("Cancelled.");
    }
  };

  // No key file on disk means ambient creds (ADC, OIDC, managed identity).
  const manager = (opts: GlobalOptions, env: string, c: Colors) => {
    const keyFile = config(opts).getEnvironmentConfig(env).credentials?.path;
    return new MonorepoSecretManager({
      environment: env,
      overrideSa: !keyFile || !fs.existsSync(keyFile),
      configPath: opts.config,
      dryRun: opts.dryRun,
      onEvent: reporter(opts, c),
    });
  };

  const op = (verb: "push" | "pull" | "peek" | "prune") => async (service: string, opts: GlobalOptions) => {
    const c = colors(opts);
    const cfg = config(opts);
    checkService(cfg, service);
    const env = resolveEnv(opts, cfg);
    if (verb === "push" || verb === "prune") await guard(opts, cfg, env, verb, service);
    const msm = manager(opts, env, c);
    const events: SecretEvent[] = [];
    if (verb === "push") events.push(...(await msm.uploadEnv(service)));
    if (verb === "peek") events.push(...(await msm.peekEnv(service)));
    if (verb === "prune") events.push(...(await msm.cleanupVersions(service)));
    if (verb === "pull") events.push(...(await msm.downloadEnv(service)), ...(await msm.setEnv(service)));
    summarize(opts, c, env, events);
  };

  return {
    init: async (opts) => {
      const c = colors(opts);
      await initializeConfig({
        configPath: opts.config,
        yes: opts.yes,
        log: (line) => (opts.json ? undefined : io.out(`${c.green("✓")} ${line}`)),
      });
      if (opts.json) io.out(fs.readFileSync(opts.config, "utf8").trim());
    },

    status: async (opts) => {
      const c = colors(opts);
      const cfg = config(opts);
      const defaultEnv = cfg.getDefaultEnv();
      const envs = cfg.getEnvironmentNames().map((name) => {
        const env = cfg.getEnvironmentConfig(name);
        const sdks = SDKS[env.provider] || [];
        const missingSdks = sdks.filter((sdk) => {
          try {
            require.resolve(sdk, { paths: [process.cwd(), __dirname] });
            return false;
          } catch {
            return true;
          }
        });
        const credsPath = env.credentials?.path;
        const credsOk = Boolean(credsPath && fs.existsSync(credsPath));
        return {
          name,
          provider: env.provider,
          default: name === defaultEnv,
          protected: cfg.isProtected(name),
          missingSdks,
          credentials: credsOk ? "key file" : "ambient",
        };
      });
      const services = cfg.getServiceNames().length;
      if (opts.json) {
        io.out(JSON.stringify({ config: opts.config, services, shared: cfg.getShared().length, environments: envs }, null, 2));
        return;
      }
      io.out(`${c.green("✓")} config ${c.dim(opts.config)} ${c.dim(`(${services} services, ${cfg.getShared().length} shared)`)}`);
      let problems = 0;
      for (const env of envs) {
        const issues = [
          ...env.missingSdks.map((sdk) => `npm i ${sdk}`),
        ];
        problems += issues.length;
        const tags = [env.default && "default", env.protected && "protected"].filter(Boolean).join(", ");
        io.out(
          `${issues.length ? c.red("✗") : c.green("✓")} ${c.bold(env.name)} ${c.dim(env.provider)}${tags ? c.dim(` [${tags}]`) : ""}`
        );
        for (const issue of issues) io.out(`    ${c.yellow(issue)}`);
      }
      if (problems) process.exitCode = 1;
    },

    list: async (opts) => {
      const c = colors(opts);
      const cfg = config(opts);
      const shared = cfg.getShared();
      const services = cfg.getServices();
      if (opts.json) {
        io.out(JSON.stringify({ shared, services }, null, 2));
        return;
      }
      if (!services.length && !shared.length) {
        io.out(c.dim("No services yet. Run 'msm add'."));
        return;
      }
      const item = (i: { kind: string; remoteName: string }) => `    ${c.dim(i.kind.padEnd(12))} ${i.remoteName}`;
      if (shared.length) {
        io.out(c.bold("shared"));
        shared.forEach((i) => io.out(item(i)));
      }
      for (const service of services) {
        const meta = [service.package, service.uses?.length && `uses ${service.uses.join(", ")}`].filter(Boolean).join("  ");
        io.out(`${c.bold(service.name)}${meta ? "  " + c.dim(meta) : ""}`);
        service.secrets.forEach((i) => io.out(item(i)));
      }
    },

    push: op("push"),
    pull: op("pull"),
    peek: op("peek"),
    prune: op("prune"),

    export: async (service: string, opts: ExportOptions) => {
      const cfg = config(opts);
      checkService(cfg, service);
      const env = resolveEnv(opts, cfg);
      const values = await manager({ ...opts, json: true }, env, makeColors(false)).exportEnv(service);
      if (opts.format === "json") {
        io.out(JSON.stringify(values, null, 2));
      } else if (opts.format === "github") {
        const target = process.env.GITHUB_ENV;
        const lines: string[] = [];
        for (const [key, value] of Object.entries(values)) {
          for (const part of value.split(/\r?\n/)) if (part) io.out(`::add-mask::${part}`);
          const delimiter = `MSM_EOF_${Math.random().toString(36).slice(2)}`;
          lines.push(`${key}<<${delimiter}\n${value}\n${delimiter}`);
        }
        if (target) {
          fs.appendFileSync(target, lines.join("\n") + (lines.length ? "\n" : ""));
          io.err(`Exported ${lines.length} variable(s) to $GITHUB_ENV`);
        } else {
          throw new Error("GITHUB_ENV is not set. Use --format github inside GitHub Actions.");
        }
      } else {
        for (const [key, value] of Object.entries(values)) {
          io.out(`${key}=${JSON.stringify(value)}`);
        }
      }
    },

    run: async (service, command, opts) => {
      const cfg = config(opts);
      checkService(cfg, service);
      const env = resolveEnv(opts, cfg);
      const values = await manager({ ...opts, json: true }, env, makeColors(false)).exportEnv(service);
      if (opts.dryRun) {
        io.out(`Would run '${command.join(" ")}' with ${Object.keys(values).length} variable(s) from ${env}`);
        return;
      }
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(command[0], command.slice(1), {
          stdio: "inherit",
          env: { ...process.env, ...values, MSM_ENV: env },
          shell: process.platform === "win32",
        });
        child.on("error", reject);
        child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
      });
      process.exitCode = code;
    },

    ci: async (service: string, opts: CiOptions) => {
      const c = colors(opts);
      const gh = io.gh || runGh;
      const cfg = config(opts);
      checkService(cfg, service);
      const env = resolveEnv(opts, cfg);
      const envCfg = cfg.getEnvironmentConfig(env);
      requireGh(gh);

      const body = renderWorkflow({ env, service, provider: envCfg.provider, region: envCfg.region, config: opts.config });
      const result = writeWorkflow(opts.workflow, body, Boolean(opts.dryRun));
      io.out(`${c.green("✓")} ${opts.workflow} ${opts.dryRun && result !== "unchanged" ? "would be " : ""}${result}`);

      const names = CI_SECRETS[envCfg.provider];
      const list = gh(["secret", "list", "--json", "name", "-q", ".[].name"]);
      const existing = new Set(list.status === 0 ? list.stdout.split(/\s+/).filter(Boolean) : []);
      for (const name of names) {
        let value = opts.setSecrets ? process.env[name] : undefined;
        if (opts.setSecrets && !value && !existing.has(name) && io.isInteractive() && io.secret) {
          value = (await io.secret(`${name} (hidden, blank to skip): `)).trim() || undefined;
        }
        if (value) {
          if (!opts.dryRun && gh(["secret", "set", name], value).status !== 0) {
            throw new Error(`gh secret set ${name} failed. Check repo access with 'gh auth status'.`);
          }
          io.out(`${c.green("✓")} secret ${name} ${opts.dryRun ? "would be set" : "set"}`);
        } else if (existing.has(name)) {
          io.out(`${c.green("✓")} secret ${name} exists`);
        } else {
          io.out(`${c.yellow("!")} secret ${name} missing. Rerun with --set-secrets or: gh secret set ${name}`);
        }
      }
    },

    add: async (opts) => {
      await addService(opts.config);
    },

    rm: async (name, opts) => {
      const c = colors(opts);
      const cfg = config(opts);
      checkService(cfg, name);
      if (name === "all" || name === SHARED_SERVICE) throw new Error(`Cannot remove '${name}'.`);
      if (!opts.yes) {
        if (!io.isInteractive()) throw new Error("Pass -y to remove without a prompt.");
        if (!(await io.confirm(`Remove service '${name}'? Local files are kept.`))) throw new Error("Cancelled.");
      }
      const next = cfg.getConfig();
      next.services = next.services.filter((s) => s.name !== name);
      if (!opts.dryRun) cfg.writeConfig(next);
      io.out(`${c.green("✓")} removed ${c.bold(name)}${opts.dryRun ? c.yellow(" (dry run)") : ""}`);
    },
  };
}
