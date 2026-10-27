import fs from "fs";
import os from "os";
import path from "path";
import { ConfigManager } from "../ConfigManager";

describe("ConfigManager v3", () => {
  let dir: string;
  const write = (config: unknown) => {
    const file = path.join(dir, "c.json");
    fs.writeFileSync(file, JSON.stringify(config));
    return file;
  };
  beforeEach(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "msm-cfg-"))));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const svc = { name: "api", secrets: [{ kind: "env-file", remoteName: "api-env" }] };

  it("accepts any env names and picks defaultEnv", () => {
    const cm = new ConfigManager(write({ version: 3, defaultEnv: "dev", environments: { dev: { provider: "local" }, qa: { provider: "local" } }, services: [svc] }));
    expect(cm.getEnvironmentNames()).toEqual(["dev", "qa"]);
    expect(cm.getDefaultEnv()).toBe("dev");
  });

  it("falls back to staging, then the first env", () => {
    expect(new ConfigManager(write({ environments: { production: { provider: "local" }, staging: { provider: "local" } }, services: [] })).getDefaultEnv()).toBe("staging");
    expect(new ConfigManager(write({ environments: { dev: { provider: "local" } }, services: [] })).getDefaultEnv()).toBe("dev");
  });

  it("treats prod* as protected unless overridden", () => {
    const cm = new ConfigManager(write({ environments: { "prod-eu": { provider: "local" }, production: { provider: "local", protected: false }, qa: { provider: "local", protected: true } }, services: [] }));
    expect(cm.isProtected("prod-eu")).toBe(true);
    expect(cm.isProtected("production")).toBe(false);
    expect(cm.isProtected("qa")).toBe(true);
  });

  it("gives clear errors for bad envs and shared refs", () => {
    expect(() => new ConfigManager(write({ environments: {}, services: [] }))).toThrow("at least one environment");
    expect(() => new ConfigManager(write({ defaultEnv: "x", environments: { dev: { provider: "local" } }, services: [] }))).toThrow("defaultEnv 'x' is not defined");
    expect(() => new ConfigManager(write({ environments: { dev: { provider: "local" } }, services: [{ ...svc, uses: ["nope"] }] }))).toThrow("uses 'nope'");
    expect(() => new ConfigManager(write({ environments: { dev: { provider: "local" } }, services: [{ ...svc, name: "shared" }] }))).toThrow("reserved");
  });

  it("allows a service that only uses shared secrets", () => {
    const cm = new ConfigManager(write({
      environments: { dev: { provider: "local" } },
      shared: [{ kind: "env-file", remoteName: "s" }],
      services: [{ name: "worker", package: "apps/worker", uses: ["s"] }],
    }));
    expect(cm.getServiceByName("worker")).toMatchObject({ package: "apps/worker", uses: ["s"], secrets: [] });
  });

  it("still loads the shipped example", () => {
    const cm = new ConfigManager(path.join(__dirname, "../../.secrets-config.example"));
    expect(cm.getServiceNames()).toEqual(["web", "api"]);
  });
});
