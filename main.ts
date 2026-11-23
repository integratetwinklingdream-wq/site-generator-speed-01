// Entry point the harness runs: node /bot/main.ts (Node 22).
// Reads every case from cases.json in the input directory, answers each
// case on its own with run() from solve.js, and writes the answers, in
// the cases' order, to answers.json in the output directory. Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// Keep V8's incremental marker off for the whole run, matching the
// house entry's tuning; set before solve.js is loaded.
setFlagsFromString('--no-incremental-marking');

const solve = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = solve.run(cases[i].input);

writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
