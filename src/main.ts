import { parseArgs, run } from './cli.js';

const args = parseArgs(process.argv.slice(2));
run(args).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
