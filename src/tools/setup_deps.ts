import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import { probeCapabilities, npmInstall, planCliInstall, installCli, NPM_CAPABILITIES } from './deps.js';

export class SetupDepsTool extends Tool {
  get name(): string { return 'setup_deps'; }
  get description(): string {
    return [
      'Check, plan and install the optional capabilities the full-feature tools use (one-click environment setup).',
      'action="status" (default): report every system CLI (python, playwright, curl-impersonate, ffmpeg, pdftotext, tesseract, ghidra, jadx, objdump, wabt, dotnet, adb, binwalk, docker, nuclei) and npm library.',
      'action="plan": show the install commands that would run on this host (no changes).',
      'action="install": install npm libraries and, where a package manager exists (npm/pip/winget/choco/brew/apt/cargo/go), the missing CLIs. Requires yes:true.',
      'target="cli" | "npm" | "all" (default all); only:["name",...] limits to specific items. After installing playwright, the chromium browser is fetched too.',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'plan', 'install'], description: 'status (default) / plan / install.' },
      target: { type: 'string', enum: ['all', 'cli', 'npm'], description: 'What to plan/install; default all.' },
      only: { type: 'array', items: { type: 'string' }, description: 'Limit to these capability/package names.' },
      yes: { type: 'boolean', description: 'Confirm installation (required for action:install).' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const action = ['plan', 'install'].includes(args.action) ? args.action : 'status';
      const target = ['cli', 'npm'].includes(args.target) ? args.target : 'all';
      const only: string[] = Array.isArray(args.only) ? args.only.map((v: any) => String(v)) : [];

      if (action === 'status') {
        const report = await probeCapabilities(true);
        return success({
          cli: report.cli.map((c) => ({ name: c.name, available: c.available, command: c.command, version: c.version })),
          npm: report.npm,
          missingCli: report.cli.filter((c) => !c.available).map((c) => c.name),
          missingNpm: report.npm.filter((n) => !n.installed).map((n) => n.pkg),
        });
      }

      const report = await probeCapabilities(true);
      const missingCliNames = report.cli.filter((c) => !c.available).map((c) => c.name).filter((n) => !only.length || only.includes(n));
      const missingNpmNames = report.npm.filter((n) => !n.installed).map((n) => n.pkg).filter((n) => !only.length || only.includes(n));

      const wantCli = (target === 'all' || target === 'cli') && missingCliNames.length;
      const wantNpm = (target === 'all' || target === 'npm') && missingNpmNames.length;

      if (action === 'plan') {
        const cliPlans = wantCli ? await Promise.all(missingCliNames.map((name) => planCliInstall(name))) : [];
        return success({
          target,
          missingCli: missingCliNames,
          missingNpm: missingNpmNames,
          cliPlans: cliPlans.filter(Boolean),
          npmlPlan: wantNpm ? [`npm install --no-audit --no-fund ${missingNpmNames.join(' ')}`] : [],
          note: 'Run action:"install" with yes:true to apply. Tools work without these; installing enables richer paths.',
        });
      }

      if (args.yes !== true) return failure('install requires yes:true (run action:"plan" first to review the commands)');
      const installed: any[] = [];
      const failed: any[] = [];
      if (wantCli) {
        for (const name of missingCliNames) {
          const result = await installCli(name, { signal: context.signal });
          (result.ok ? installed : failed).push(result);
        }
      }
      if (wantNpm) {
        const result = await npmInstall(missingNpmNames, context.cwd, context.signal);
        installed.push({ name: 'npm-libraries', ok: result.code === 0, packages: missingNpmNames, exitCode: result.code, output: (result.stdout || result.stderr).slice(-3000) });
        if (result.code !== 0) failed.push({ name: 'npm-libraries', note: 'npm install returned non-zero' });
      }
      const after = await probeCapabilities(true);
      return success({
        installed,
        failed,
        stillMissingCli: after.cli.filter((c) => !c.available).map((c) => c.name),
        stillMissingNpm: after.npm.filter((n) => !n.installed).map((n) => n.pkg),
        cli: after.cli.map((c) => ({ name: c.name, available: c.available })),
      });
    } catch (error) { return failure(error); }
  }
}
