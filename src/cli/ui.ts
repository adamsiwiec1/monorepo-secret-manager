import { createColors } from "picocolors";

export type Colors = ReturnType<typeof createColors>;

/** Color only on a TTY, and never when NO_COLOR is set or --no-color is passed. */
export function shouldColor(flag: boolean, stream: NodeJS.WriteStream = process.stdout): boolean {
  if (!flag) return false;
  if ("NO_COLOR" in process.env && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") return true;
  return Boolean(stream.isTTY);
}

export function makeColors(enabled: boolean): Colors {
  return createColors(enabled);
}
