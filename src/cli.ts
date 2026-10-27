#!/usr/bin/env node
import { CommanderError } from "commander";
import { createHandlers } from "./cli/commands";
import { createProgram, splitRunArgs } from "./cli/program";
import { makeColors, shouldColor } from "./cli/ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../package.json");

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { args, runArgs } = splitRunArgs(argv);
  const program = createProgram(createHandlers(), version, runArgs);
  const red = makeColors(!args.includes("--no-color") && shouldColor(true, process.stderr)).red;

  if (args.length === 0) {
    process.stdout.write(program.helpInformation());
    return;
  }

  try {
    await program.parseAsync(args, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      if (error.code.startsWith("msm.")) process.stderr.write(`${red("error:")} ${error.message}\n`);
      process.exitCode = error.exitCode || 1;
      return;
    }
    process.stderr.write(`${red("error:")} ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
