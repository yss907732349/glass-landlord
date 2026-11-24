import { _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(project, 'artifacts');
await mkdir(output, { recursive: true });
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) || 'current';
const profile = await mkdtemp(path.join(output, 'memory-profile-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
const report = { label, samples: [] };
try {
  app = await electron.launch({ executablePath: path.join(project, 'node_modules/electron/dist/electron.exe'), args: [project, `--user-data-dir=${profile}`], cwd: project, env });
  const page = await app.firstWindow();
  // No mouse or keyboard input, and no persistent test window on the user's desktop.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await page.getByRole('heading', { name: '朋友，入座。' }).waitFor();
  await page.evaluate(() => {
    window.__memoryMutations = 0;
    new MutationObserver(records => { window.__memoryMutations += records.length; }).observe(document.querySelector('.table-shell'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  for (let sample = 0; sample < 3; sample++) {
    await page.waitForTimeout(3000);
    report.samples.push(await app.evaluate(async ({ app, BrowserWindow }) => ({
      processes: app.getAppMetrics().map(({ type, memory, cpu }) => ({ type, memory, cpu })),
      renderer: await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript('({heap:performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null,mutations:window.__memoryMutations})'),
    })));
  }
  for (const sample of report.samples) {
    sample.totalWorkingSetMB = Math.round(sample.processes.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024);
    sample.totalPrivateMB = Math.round(sample.processes.reduce((sum, item) => sum + item.memory.privateBytes, 0) / 1024);
  }
} finally { await app?.close(); }
await writeFile(path.join(output, `desktop-memory-${label}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
