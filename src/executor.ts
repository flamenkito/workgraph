import { spawn } from 'child_process';
import * as os from 'os';
import { BuildResult, ExecutorOptions, Project, ProjectBuildResult } from './types';

const DEFAULT_CONCURRENCY = Math.max(1, os.cpus().length - 1);

export function defaultBuildCommand(project: Project): string {
  const scripts = project.packageJson.scripts || {};
  if (scripts.build) {
    return `npm run build -w ${project.name}`;
  }
  return `echo "No build script for ${project.name}"`;
}

async function runCommand(
  command: string,
  cwd: string
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(' ');
    const proc = spawn(cmd, args, {
      cwd,
      shell: true,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        success: code === 0,
        output: stdout,
        error: stderr || undefined,
      });
    });

    proc.on('error', (err) => {
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
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const p = fn(item).then((result) => {
      results.push(result);
    });

    executing.push(p);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
      // Remove completed promises
      const completed = executing.filter(
        (p) => (p as Promise<void> & { settled?: boolean }).settled
      );
      for (const c of completed) {
        const idx = executing.indexOf(c);
        if (idx > -1) executing.splice(idx, 1);
      }
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
  } = options;

  const startTime = Date.now();
  const results: ProjectBuildResult[] = [];
  let overallSuccess = true;

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex];

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

        onStart?.(projectName);

        const projectStart = Date.now();

        if (dryRun) {
          const cmd = buildCommand(project);
          return {
            project: projectName,
            success: true,
            duration: 0,
            output: `[dry-run] Would run: ${cmd}`,
          };
        }

        const cmd = buildCommand(project);
        const result = await runCommand(cmd, root);
        const duration = Date.now() - projectStart;

        const buildResult: ProjectBuildResult = {
          project: projectName,
          success: result.success,
          duration,
          output: result.output,
          error: result.error,
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
