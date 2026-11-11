/** What both command-line tools share: repository paths and how a command's result becomes an exit code. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD = path.join(ROOT, 'build');
export const PLOTDB = path.join(BUILD, 'plotdb');
export const CONTENT = path.join(ROOT, 'content');

/**
 * A path the user typed, resolved against the directory they typed it in. `pnpm <script>` runs
 * from the package root but records the caller's directory in INIT_CWD.
 */
export function userPath(p: string): string {
  const base =
    process.env['npm_lifecycle_event'] !== undefined
      ? (process.env['INIT_CWD'] ?? process.cwd())
      : process.cwd();
  return path.resolve(base, p);
}

export function int(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) {
    throw new InvalidArgumentError(`invalid int value: '${value}'`);
  }
  return Number.parseInt(value, 10);
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** A program whose subcommands throw on usage errors instead of exiting (see `runCli`). */
export function program(name: string, description: string): Command {
  return new Command(name).description(description).exitOverride().showHelpAfterError();
}

/**
 * Parse and run. Commands report failure by setting `process.exitCode` (never `process.exit()`,
 * so piped output is flushed first). Usage errors exit with code 2, as argparse did.
 */
export async function runCli(program: Command, argv: readonly string[]): Promise<void> {
  // `storylet graph | head`: once the reader has gone, stop quietly instead of crashing.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
    process.exit(0);
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (e) {
    if (!(e instanceof CommanderError)) throw e;
    process.exitCode = e.exitCode === 0 ? 0 : 2;
  }
}
