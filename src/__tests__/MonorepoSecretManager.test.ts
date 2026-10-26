import fs from "fs";
import os from "os";
import path from "path";
import { MonorepoSecretManager } from "../MonorepoSecretManager";
import { GcpMonorepoSecretManager } from "../GcpMonorepoSecretManager";
import { SecretBackend } from "../backends/types";
import { DeletePolicy, SecretEvent } from "../types";

function memoryBackend(): jest.Mocked<SecretBackend> & { store: Map<string, Buffer> } {
  const store = new Map<string, Buffer>();
  return {
    store,
    provider: "local",
    get: jest.fn(async (name: string) => {
      const data = store.get(name);
      if (!data) throw new Error(`No data found for ${name}`);
      return { data };
    }),
    put: jest.fn(async (name: string, payload) => {
      store.set(name, payload.data);
    }),
    listVersions: jest.fn(async (_name: string) => []),
    destroyVersions: jest.fn(async (_name: string, _policy: DeletePolicy): Promise<void> => undefined),
  };
}

describe("MonorepoSecretManager", () => {
  let dir: string;
  let cwd: string;
  let events: SecretEvent[];
  let backend: ReturnType<typeof memoryBackend>;

  const config = {
    version: 3,
    defaultEnv: "dev",
    environments: { dev: { provider: "local" }, "prod-eu": { provider: "local" } },
    shared: [{ kind: "env-file", remoteName: "shared-env", sourcePath: ".env.shared.{env}", targetPath: ".env.shared" }],
    services: [
      {
        name: "api",
        package: "apps/api",
        uses: ["shared-env"],
        secrets: [{ kind: "env-file", remoteName: "api-env", sourcePath: ".env.{env}", targetPath: ".env" }],
      },
      {
        name: "web",
        package: "apps/web",
        secrets: [{ kind: "env-file", remoteName: "web-env", sourcePath: ".env.{env}", targetPath: ".env" }],
      },
    ],
  };

  const make = (environment = "dev", dryRun = false) =>
    new MonorepoSecretManager({ environment, backend, dryRun, onEvent: (e) => events.push(e) });

  beforeEach(() => {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "msm-"));
    process.chdir(dir);
    fs.writeFileSync(".secrets-config", JSON.stringify(config));
    fs.mkdirSync("apps/api", { recursive: true });
    fs.mkdirSync("apps/web", { recursive: true });
    fs.writeFileSync(".env.shared.dev", "DB=shared\nTOKEN=s\n");
    fs.writeFileSync("apps/api/.env.dev", "TOKEN=api\nPORT=1\n");
    fs.writeFileSync("apps/web/.env.dev", "WEB=1\n");
    events = [];
    backend = memoryBackend();
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pushes shared items and every service for 'all', with package-scoped paths", async () => {
    await make().uploadEnv("all");
    expect([...backend.store.keys()]).toEqual(["shared-env", "api-env", "web-env"]);
    expect(backend.store.get("api-env")!.toString()).toContain("TOKEN=api");
    expect(events.map((e) => e.service)).toEqual(["shared", "api", "web"]);
  });

  it("pushes only a service's own items when named", async () => {
    await make().uploadEnv("api");
    expect([...backend.store.keys()]).toEqual(["api-env"]);
  });

  it("does not write anything on a dry-run push", async () => {
    await make("dev", true).uploadEnv("all");
    expect(backend.put).not.toHaveBeenCalled();
    expect(events.every((e) => e.status === "dry-run")).toBe(true);
  });

  it("pulls used shared items into the service and writes targets inside the package", async () => {
    await make().uploadEnv("all");
    fs.rmSync("apps/api/.env.dev");
    const pulled = await make().downloadEnv("api");
    expect(pulled.map((e) => e.remoteName)).toEqual(["shared-env", "api-env"]);
    expect(fs.readFileSync("apps/api/.env.dev", "utf8")).toContain("PORT=1");
    await make().setEnv("api");
    expect(fs.existsSync("apps/api/.env")).toBe(true);
    expect(fs.existsSync(".env.shared")).toBe(true);
  });

  it("uses the env name for {env} when it is not staging or production", async () => {
    fs.writeFileSync("apps/web/.env.prod-eu", "WEB=eu\n");
    await make("prod-eu").uploadEnv("web");
    expect(backend.store.get("web-env")!.toString()).toBe("WEB=eu\n");
  });

  it("merges shared then service values for export, service wins", async () => {
    await make().uploadEnv("all");
    expect(await make().exportEnv("api")).toEqual({ DB: "shared", TOKEN: "api", PORT: "1" });
  });

  it("redacts values on peek and skips missing secrets", async () => {
    await make().uploadEnv("web");
    const peeked = await make().peekEnv("all");
    const web = peeked.find((e) => e.service === "web")!;
    expect(web.output).toBe("WEB=********\n");
    expect(peeked.find((e) => e.service === "api")!.status).toBe("skipped");
  });

  it("prunes with the delete policy", async () => {
    await make().cleanupVersions("web");
    expect(backend.destroyVersions).toHaveBeenCalledWith("web-env", expect.objectContaining({ maxVersions: 10 }));
  });

  it("names available services for an unknown one", async () => {
    await expect(make().uploadEnv("nope")).rejects.toThrow("Services: api, web");
  });

  it("rejects an unknown environment with the list of names", () => {
    expect(() => make("qa")).toThrow("Environments: dev, prod-eu");
  });

  it("keeps the deprecated GCP alias", () => {
    expect(GcpMonorepoSecretManager).toBe(MonorepoSecretManager);
  });
});
