import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// One place to shell out to the local tools (poppler, ImageMagick) so tests can inject a fake.
export async function run(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return { stdout, stderr };
}
