import { createProgram, Handlers, splitRunArgs } from "../cli/program";

function handlers(): jest.Mocked<Handlers> {
  const fn = () => jest.fn(async () => undefined);
  return {
    init: fn(), status: fn(), list: fn(), push: fn(), pull: fn(), peek: fn(), prune: fn(),
    export: fn(), run: fn(), ci: fn(), add: fn(), rm: fn(),
  } as unknown as jest.Mocked<Handlers>;
}

async function parse(argv: string[], h = handlers()) {
  const { args, runArgs } = splitRunArgs(argv);
  const program = createProgram(h, "3.0.0", runArgs, { writeErr: () => undefined, writeOut: () => undefined });
  await program.parseAsync(args, { from: "user" });
  return h;
}

describe("cli parser", () => {
  it("defaults service to all", async () => {
    const h = await parse(["push"]);
    expect(h.push).toHaveBeenCalledWith("all", expect.objectContaining({ config: ".secrets-config", color: true }));
  });

  it("accepts any env name and global flags after the verb", async () => {
    const h = await parse(["push", "api", "-e", "prod-eu", "-y", "--dry-run", "--json", "--config", "x.json"]);
    expect(h.push).toHaveBeenCalledWith(
      "api",
      expect.objectContaining({ env: "prod-eu", yes: true, dryRun: true, json: true, config: "x.json" })
    );
  });

  it("accepts global flags before the verb", async () => {
    const h = await parse(["-e", "qa", "pull"]);
    expect(h.pull).toHaveBeenCalledWith("all", expect.objectContaining({ env: "qa" }));
  });

  it("dropped --write-targets and --ambient-creds", async () => {
    await expect(parse(["pull", "--write-targets"])).rejects.toThrow(/unknown option/);
    await expect(parse(["pull", "--ambient-creds"])).rejects.toThrow(/unknown option/);
  });

  it("handles --no-color", async () => {
    const h = await parse(["list", "--no-color"]);
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ color: false }));
  });

  it("passes everything after -- to run", async () => {
    const h = await parse(["run", "api", "-e", "dev", "--", "npm", "start", "--port", "3"]);
    expect(h.run).toHaveBeenCalledWith("api", ["npm", "start", "--port", "3"], expect.objectContaining({ env: "dev" }));
  });

  it("requires a command for run", async () => {
    await expect(parse(["run"])).rejects.toThrow(/Missing command/);
  });

  it("routes add, rm, and ci", async () => {
    const h = await parse(["add"]);
    expect(h.add).toHaveBeenCalled();
    await parse(["rm", "api", "-y"], h);
    expect(h.rm).toHaveBeenCalledWith("api", expect.objectContaining({ yes: true }));
    await parse(["ci", "api", "--set-secrets"], h);
    expect(h.ci).toHaveBeenCalledWith("api", expect.objectContaining({ setSecrets: true, workflow: ".github/workflows/msm.yml" }));
  });

  it("maps export --json to json format and rejects unknown formats", async () => {
    const h = await parse(["export", "api", "--json"]);
    expect(h.export).toHaveBeenCalledWith("api", expect.objectContaining({ format: "json" }));
    await expect(parse(["export", "--format", "yaml"])).rejects.toThrow(/Unknown --format/);
  });

  it("removed the v2 flag CLI", async () => {
    await expect(parse(["--upload", "--service", "all", "--stg"])).rejects.toThrow(/unknown option/);
  });

  it("prints version", async () => {
    await expect(parse(["-V"])).rejects.toMatchObject({ code: "commander.version" });
  });
});
