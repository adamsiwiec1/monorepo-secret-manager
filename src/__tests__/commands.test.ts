import fs from "fs";
import os from "os";
import path from "path";
import { createHandlers, Io } from "../cli/commands";
import { GlobalOptions } from "../cli/program";

describe("cli handlers (local provider)", () => {
  let dir: string;
  let cwd: string;
  let out: string[];
  let err: string[];
  let confirmAnswer: boolean;
  let interactive: boolean;
  const io: Io = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    confirm: async () => confirmAnswer,
    isInteractive: () => interactive,
  };
  const opts = (extra: Partial<GlobalOptions> = {}): GlobalOptions => ({ config: ".secrets-config", color: false, ...extra });

  beforeEach(async () => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "msm-cli-"));
    process.chdir(dir);
    fs.mkdirSync(".git");
    fs.mkdirSync("apps/api", { recursive: true });
    fs.writeFileSync("apps/api/package.json", "{}");
    fs.writeFileSync("package.json", JSON.stringify({ workspaces: ["apps/*"] }));
    out = [];
    err = [];
    confirmAnswer = false;
    interactive = false;
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    delete process.env.MSM_LOCAL_KEY;
    await createHandlers(io).init(opts({ yes: true }));
    fs.writeFileSync("apps/api/.env.stg", "A=1\n");
    fs.writeFileSync("apps/api/.env.prod", "A=2\n");
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exitCode = 0;
  });

  it("init writes a v3 local config from the npm workspace", () => {
    const config = JSON.parse(fs.readFileSync(".secrets-config", "utf8"));
    expect(config.version).toBe(3);
    expect(config.defaultEnv).toBe("staging");
    expect(config.environments.staging.provider).toBe("local");
    expect(config.services[0]).toMatchObject({ name: "api", package: "apps/api" });
    expect(out.join("\n")).toContain("Detected npm workspace");
  });

  it("push then pull --json round trips through the local store", async () => {
    const h = createHandlers(io);
    await h.push("all", opts());
    fs.rmSync("apps/api/.env.stg");
    out = [];
    await h.pull("all", { ...opts({ json: true }), writeTargets: true });
    const result = JSON.parse(out.join("\n"));
    expect(result.env).toBe("staging");
    expect(result.results.map((r: { action: string }) => r.action)).toEqual(["pull", "write"]);
    expect(fs.readFileSync("apps/api/.env", "utf8")).toBe("A=1\n");
  });

  it("refuses production push without -y when not interactive", async () => {
    await expect(createHandlers(io).push("all", opts({ env: "production" }))).rejects.toThrow("Pass -y");
  });

  it("asks before production prune and honors a no", async () => {
    interactive = true;
    await expect(createHandlers(io).prune("all", opts({ env: "production" }))).rejects.toThrow("Cancelled");
  });

  it("pushes to production with -y", async () => {
    await createHandlers(io).push("api", opts({ env: "production", yes: true }));
    expect(out.join("\n")).toContain("1 ok (production)");
  });

  it("rejects unknown services and envs with the valid names", async () => {
    const h = createHandlers(io);
    await expect(h.pull("nope", opts())).rejects.toThrow("Services: api");
    await expect(h.pull("all", opts({ env: "qa" }))).rejects.toThrow("Environments: staging, production");
  });

  it("export prints dotenv lines", async () => {
    const h = createHandlers(io);
    await h.push("all", opts());
    out = [];
    await h.export("api", { ...opts(), format: "dotenv" });
    expect(out).toEqual(['A="1"']);
  });

  it("export --format github masks values and appends to GITHUB_ENV", async () => {
    const h = createHandlers(io);
    await h.push("all", opts());
    out = [];
    process.env.GITHUB_ENV = path.join(dir, "gh.env");
    try {
      await h.export("api", { ...opts(), format: "github" });
    } finally {
      delete process.env.GITHUB_ENV;
    }
    expect(out).toContain("::add-mask::1");
    expect(fs.readFileSync(path.join(dir, "gh.env"), "utf8")).toMatch(/^A<<MSM_EOF_\w+\n1\n/);
  });

  it("run injects values into the child", async () => {
    const h = createHandlers(io);
    await h.push("all", opts());
    await h.run("api", ["node", "-e", "process.exit(process.env.A === '1' && process.env.MSM_ENV === 'staging' ? 0 : 3)"], opts());
    expect(process.exitCode).toBe(0);
  });

  it("status reports environments as json", async () => {
    out = [];
    await createHandlers(io).status(opts({ json: true }));
    const status = JSON.parse(out.join("\n"));
    expect(status.environments.map((e: { name: string; protected: boolean }) => [e.name, e.protected])).toEqual([
      ["staging", false],
      ["production", true],
    ]);
  });

  it("service rm removes with -y", async () => {
    await createHandlers(io).serviceRm("api", opts({ yes: true }));
    expect(JSON.parse(fs.readFileSync(".secrets-config", "utf8")).services).toEqual([]);
  });

  describe("ci setup", () => {
    const useGcp = () => {
      const config = JSON.parse(fs.readFileSync(".secrets-config", "utf8"));
      config.environments.ci = { provider: "gcp", projectId: "p" };
      fs.writeFileSync(".secrets-config", JSON.stringify(config));
    };
    const ciOpts = (extra: Partial<GlobalOptions> & { setSecrets?: boolean } = {}) => ({
      ...opts({ env: "ci", ...extra }),
      workflow: ".github/workflows/msm.yml",
    });
    const fakeGh = (calls: [string[], string | undefined][], existing = "", auth = 0) =>
      (args: string[], input?: string) => {
        calls.push([args, input]);
        if (args[0] === "auth") return { status: auth, stdout: "" };
        if (args[1] === "list") return { status: 0, stdout: existing };
        return { status: 0, stdout: "" };
      };

    it("fails clearly when gh is logged out", async () => {
      useGcp();
      const h = createHandlers({ ...io, gh: fakeGh([], "", 1) });
      await expect(h.ciSetup("all", ciOpts())).rejects.toThrow("gh auth login");
    });

    it("rejects the local provider", async () => {
      const h = createHandlers({ ...io, gh: fakeGh([]) });
      await expect(h.ciSetup("all", { ...ciOpts(), env: "staging" })).rejects.toThrow("gitignored");
    });

    it("writes the workflow once and sets secrets from env without echoing them", async () => {
      useGcp();
      const calls: [string[], string | undefined][] = [];
      const h = createHandlers({ ...io, gh: fakeGh(calls, "WIF_SERVICE_ACCOUNT\n") });
      process.env.WIF_PROVIDER = "super-secret";
      try {
        await h.ciSetup("api", ciOpts({ setSecrets: true }));
      } finally {
        delete process.env.WIF_PROVIDER;
      }
      const yml = fs.readFileSync(".github/workflows/msm.yml", "utf8");
      expect(yml).toContain("msm export api -e ci --format github --ambient-creds");
      expect(yml).toContain("google-github-actions/auth@v2");
      expect(calls).toContainEqual([["secret", "set", "WIF_PROVIDER"], "super-secret"]);
      expect(out.join("\n")).not.toContain("super-secret");
      expect(out.join("\n")).toContain("WIF_SERVICE_ACCOUNT exists");

      out = [];
      await h.ciSetup("api", ciOpts());
      expect(out[0]).toContain("unchanged");
    });

    it("--dry-run writes and sets nothing", async () => {
      useGcp();
      const calls: [string[], string | undefined][] = [];
      process.env.WIF_PROVIDER = "x";
      try {
        await createHandlers({ ...io, gh: fakeGh(calls) }).ciSetup("all", ciOpts({ dryRun: true, setSecrets: true }));
      } finally {
        delete process.env.WIF_PROVIDER;
      }
      expect(fs.existsSync(".github/workflows/msm.yml")).toBe(false);
      expect(calls.some(([a]) => a[1] === "set")).toBe(false);
      expect(out.join("\n")).toContain("would be created");
    });
  });
});
