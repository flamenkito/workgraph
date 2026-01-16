import { spawn } from 'child_process';
import * as os from 'os';
import { BuildResult, BuildStepInfo, ExecutorOptions, Project, ProjectBuildResult } from './types';

const DEFAULT_CONCURRENCY = Math.max(1, os.cpus().length - 1);

export function defaultBuildCommand(project: Project): string {
  const scripts = project.packageJson.scripts;
  if (scripts?.['build']) {
    return `npm run build -w ${project.name}`;
  }
  return `echo "No build script for ${project.name}"`;
}

/* eslint-disable no-restricted-syntax */
async function runCommand(
  command: string,
  cwd: string,
  onOutput?: (line: string) => void
): Promise<{ success: boolean; output: string; error?: string }> {
/* eslint-enable no-restricted-syntax */
  return new Promise((resolve) => {
    const parts = command.split(' ');
    const cmd = parts[0];
    if (!cmd) {
      resolve({ success: false, output: '', error: 'Empty command' });
      return;
    }
    const args = parts.slice(1);
    // eslint-disable-next-line sonarjs/os-command
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    const processOutput = (data: Buffer, isError: boolean) => {
      const text = data.toString();
      if (isError) {
        stderr += text;
      } else {
        stdout += text;
      }
      if (onOutput) {
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            onOutput(line);
          }
        }
      }
    };

    proc.stdout?.on('data', (data: Buffer) => processOutput(data, false));
    proc.stderr?.on('data', (data: Buffer) => processOutput(data, true));

    proc.on('close', (code: number | null) => {
      resolve({
        success: code === 0,
        output: stdout,
        ...(stderr ? { error: stderr } : {}),
      });
    });

    proc.on('error', (err: Error) => {
      resolve({
        success: false,
        output: stdout,
        error: err.message,
      });
    });
  });
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing = new Set<Promise<void>>();

  for (const item of items) {
    const p: Promise<void> = fn(item).then((result) => {
      results.push(result);
      executing.delete(p);
    });

    executing.add(p);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

export async function executePlan(
  waves: string[][],
  projects: Map<string, Project>,
  root: string,
  options: ExecutorOptions = {}
): Promise<BuildResult> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    buildCommand = defaultBuildCommand,
    dryRun = false,
    onStart,
    onComplete,
    onOutput,
  } = options;

  const startTime = Date.now();
  const results: ProjectBuildResult[] = [];
  let overallSuccess = true;
  const totalSteps = waves.reduce((sum, w) => sum + w.length, 0);
  let currentStep = 0;

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex]!;
    const isParallel = wave.length > 1;

    const waveResults = await runWithConcurrency(
      wave,
      concurrency,
      async (projectName): Promise<ProjectBuildResult> => {
        const project = projects.get(projectName);
        if (!project) {
          return {
            project: projectName,
            success: false,
            duration: 0,
            error: 'Project not found',
          };
        }

        currentStep++;
        const stepInfo: BuildStepInfo = {
          project: projectName,
          wave: waveIndex + 1,
          totalWaves: waves.length,
          step: currentStep,
          totalSteps,
          isParallel,
        };
        onStart?.(stepInfo);

        const cmd = buildCommand(project);
        if (onOutput) {
          onOutput(`\x1b[33m$ ${cmd}\x1b[0m`);
        } else {
          console.log(`\x1b[33m$ ${cmd}\x1b[0m`);
        }

        const projectStart = Date.now();

        if (dryRun) {
          return {
            project: projectName,
            success: true,
            duration: 0,
            output: `[dry-run] Would run: ${cmd}`,
          };
        }

        const result = await runCommand(cmd, root, onOutput);
        const duration = Date.now() - projectStart;

        const buildResult: ProjectBuildResult = {
          project: projectName,
          success: result.success,
          duration,
          output: result.output,
          ...(result.error ? { error: result.error } : {}),
        };

        onComplete?.(buildResult);

        if (!result.success) {
          overallSuccess = false;
        }

        return buildResult;
      }
    );

    results.push(...waveResults);

    // Stop if any project in this wave failed
    if (!overallSuccess) {
      break;
    }
  }

  return {
    success: overallSuccess,
    results,
    duration: Date.now() - startTime,
  };
}
