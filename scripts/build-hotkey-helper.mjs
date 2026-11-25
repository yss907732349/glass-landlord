import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'win32') {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const windows = process.env.WINDIR || 'C:/Windows';
  const compiler = ['Framework64', 'Framework'].map(folder => path.join(windows, 'Microsoft.NET', folder, 'v4.0.30319/csc.exe')).find(existsSync);
  if (!compiler) throw new Error('Windows .NET Framework compiler is required to package priority shortcuts');
  mkdirSync(path.join(project, 'build'), { recursive: true });
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+', `/out:${path.join(project, 'build/hotkey-helper.exe')}`, path.join(project, 'desktop/hotkey-helper.cs')], { windowsHide: true, stdio: 'inherit' });
}
