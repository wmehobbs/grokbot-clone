/**
 * Run every end-to-end check against a running server.
 *
 *   node scripts/smoke-all.mjs [baseUrl]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const { spawn } = await import('node:child_process');

const suites = ['smoke.mjs', 'smoke-providers.mjs', 'smoke-team.mjs', 'smoke-local.mjs', 'smoke-machines.mjs'];
let failed = 0;

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [`scripts/${suite}`, base], { stdio: 'inherit' });
    child.on('close', resolve);
  });
  if (code !== 0) {
    failed++;
    console.log(`>>> ${suite} exited ${code}`);
  }
}

console.log(`\n${failed ? `${failed} suite(s) failed` : 'all suites passed'}`);
process.exit(failed ? 1 : 0);
