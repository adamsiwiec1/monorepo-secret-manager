import fs from "fs";
import path from "path";

export type WorkspaceTool = "pnpm" | "yarn" | "npm" | "turbo" | "nx";

export interface WorkspaceInfo {
  /** Package manager or task runner hints found at the repo root. */
  tools: WorkspaceTool[];
  /** Package dirs relative to root, e.g. apps/api. */
  packages: string[];
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Minimal parse of the `packages:` list in pnpm-workspace.yaml. */
export function parsePnpmWorkspace(text: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      if (match) globs.push(match[1].trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return globs;
}

/** Expand simple workspace globs: `dir`, `dir/*`, `dir/**`. Negations are dropped. */
export function expandGlobs(root: string, globs: string[]): string[] {
  const found = new Set<string>();
  const excluded = new Set(globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)));
  for (const glob of globs) {
    if (glob.startsWith("!")) continue;
    const clean = glob.replace(/\/+$/, "");
    const star = clean.match(/^(.*?)\/\*{1,2}$/);
    if (star) {
      const base = path.join(root, star[1]);
      if (!fs.existsSync(base)) continue;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const rel = path.posix.join(star[1], entry.name);
        if (fs.existsSync(path.join(root, rel, "package.json")) || fs.existsSync(path.join(root, rel, "project.json"))) {
          found.add(rel);
        }
      }
    } else if (!clean.includes("*") && fs.existsSync(path.join(root, clean))) {
      found.add(clean);
    }
  }
  return [...found].filter((p) => !excluded.has(p)).sort();
}

export function detectWorkspace(root: string = process.cwd()): WorkspaceInfo {
  const tools: WorkspaceTool[] = [];
  let globs: string[] = [];
  const pkg = readJson(path.join(root, "package.json"));
  const pnpmFile = path.join(root, "pnpm-workspace.yaml");

  if (fs.existsSync(pnpmFile)) {
    tools.push("pnpm");
    globs = parsePnpmWorkspace(fs.readFileSync(pnpmFile, "utf8"));
  } else if (pkg?.workspaces) {
    const list = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
    globs = list;
    tools.push(fs.existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm");
  }
  if (fs.existsSync(path.join(root, "turbo.json"))) tools.push("turbo");
  if (fs.existsSync(path.join(root, "nx.json"))) {
    tools.push("nx");
    if (globs.length === 0) globs = ["apps/*", "libs/*", "packages/*"];
  }
  if (globs.length === 0 && tools.length > 0) globs = ["apps/*", "packages/*"];

  return { tools, packages: expandGlobs(root, globs) };
}

/** Service name for a package dir: its basename. */
export function serviceNameFor(pkgDir: string): string {
  return path.posix.basename(pkgDir).toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
