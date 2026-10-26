import fs from "fs";
import os from "os";
import path from "path";
import { detectWorkspace, parsePnpmWorkspace } from "../workspace";

describe("workspace detection", () => {
  let root: string;
  const pkg = (dir: string, file = "package.json") => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, file), "{}");
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "msm-ws-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("parses pnpm-workspace.yaml", () => {
    expect(parsePnpmWorkspace("packages:\n  - 'apps/*'\n  - \"packages/*\" # libs\n  - '!**/test'\nother: 1\n")).toEqual([
      "apps/*",
      "packages/*",
      "!**/test",
    ]);
  });

  it("detects pnpm + turbo", () => {
    pkg("apps/api");
    pkg("packages/ui");
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
    fs.writeFileSync(path.join(root, "turbo.json"), "{}");
    expect(detectWorkspace(root)).toEqual({ tools: ["pnpm", "turbo"], packages: ["apps/api", "packages/ui"] });
  });

  it("detects yarn workspaces via yarn.lock", () => {
    pkg("packages/a");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }));
    fs.writeFileSync(path.join(root, "yarn.lock"), "");
    expect(detectWorkspace(root)).toEqual({ tools: ["yarn"], packages: ["packages/a"] });
  });

  it("detects nx projects without package manager workspaces", () => {
    pkg("apps/site", "project.json");
    fs.writeFileSync(path.join(root, "nx.json"), "{}");
    expect(detectWorkspace(root)).toEqual({ tools: ["nx"], packages: ["apps/site"] });
  });

  it("returns nothing for a plain repo", () => {
    expect(detectWorkspace(root)).toEqual({ tools: [], packages: [] });
  });
});
