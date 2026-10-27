import fs from "fs";
import path from "path";
import { Environment } from "./types";

/** staging -> stg and production -> prod (v2 file names); any other env keeps its name. */
export function envSuffix(environment: Environment): string {
  if (environment === "staging") return "stg";
  if (environment === "production") return "prod";
  return environment;
}

export function interpolateEnv(
  template: string,
  environment: Environment
): string {
  return template.replace(/\{env\}/g, envSuffix(environment));
}

export function writeFileSecure(
  filePath: string,
  data: string | Buffer,
  mode: number
): void {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(filePath, data, { mode });
  fs.chmodSync(filePath, mode);
}

export function readRequiredFile(filePath: string, label: string): Buffer {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found at ${filePath}`);
  }
  return fs.readFileSync(filePath);
}

/** Prefix relative paths with a package dir. Absolute paths are left alone. */
export function scopePath(pkg: string | undefined, p: string): string {
  if (!pkg || path.isAbsolute(p)) return p;
  return path.join(pkg, p);
}
