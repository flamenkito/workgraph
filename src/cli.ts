#!/usr/bin/env node

import { Command } from 'commander';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { loadWorkspaceProjects } from './workspace';
import { buildGraph, detectCycles, formatGraph } from './graph';
import { getAffectedProjects, resolveProjectNames } from './affected';
import { createBuildPlan, formatBuildPlan } from './planner';
import { createWatcher, formatTimestamp } from './watcher';
import { executePlan } from './executor';
import { Project, SourceConfig } from './types';
import {
  scanForUnknownDependencies,
  formatUnknownDependencies,
  loadWorkgraphConfig,
} from './source-scanner';
import { createUI } from './ui';

interface AnalyzeCommandOptions {
  root: string;
}

interface ScanCommandOptions {
  root: string;
}

interface PlanCommandOptions {
  root: string;
  changed: string[];
}

interface BuildCommandOptions {
  root: string;
  changed: string[];
  concurrency: string;
  dryRun: boolean;
}

interface WatchCommandOptions {
  root: string;
  concurrency: string;
  debounce: string;
  dryRun: boolean;
  filter: string;
  verbose: boolean;
  ui: boolean;
}

function normalizeSourceConfig(config: string | SourceConfig): SourceConfig {
  if (typeof config === 'string') {
    return { command: config, deps: [] };
  }
  return config;
}

function shouldRunGenerator(
  sourcePath: string,
  sourceConfig: SourceConfig,
  affectedProjects: Set<string>,
  projects: Map<string, Project>,
  root: string
): boolean {
  // Check if any dep project is affected
  if (sourceConfig.deps.length > 0) {
    for (const dep of sourceConfig.deps) {
      // Try exact match first
      if (affectedProjects.has(dep)) {
        return true;
      }
      // Try matching by path or partial name
      for (const projectName of affectedProjects) {
        const project = projects.get(projectName);
        if (!project) continue;
        // Match by path (e.g., "apps/api" or "api")
        if (project.path === dep || project.path.endsWith('/' + dep)) {
          return true;
        }
      }
    }
    return false;
  }

  // Fallback: check if source path is within any affected project
  const sourceDir = path.resolve(root, sourcePath);
  for (const projectName of affectedProjects) {
    const project = projects.get(projectName);
    if (!project) continue;
    if (sourceDir.startsWith(project.absolutePath)) {
      return true;
    }
  }

  return false;
}

interface SourceGeneratorCallbacks {
  log: (msg: string) => void;
  taskLog: (msg: string) => void;
  addTask: (task: { id: string; name: string; pid: number; status: 'running' | 'stopped' | 'error' }) => void;
  updateTask: (id: string, status: 'running' | 'stopped' | 'error', removeAfterMs?: number) => void;
}

async function runSourceGeneratorsWithUI(
  root: string,
  affectedProjects: Set<string>,
  projects: Map<string, Project>,
  dryRun: boolean = false,
  callbacks: SourceGeneratorCallbacks = {
    log: (msg) => console.log(`[${formatTimestamp()}] ${msg}`),
    taskLog: console.log,
    addTask: () => {},
    updateTask: () => {},
  }
): Promise<{ success: boolean; generated: string[] }> {
  const { log, taskLog, addTask, updateTask } = callbacks;
  const config = loadWorkgraphConfig(root);
  const sources = config.sources;
  const generated: string[] = [];

  for (const [sourcePath, rawConfig] of Object.entries(sources)) {
    const sourceConfig = normalizeSourceConfig(rawConfig);

    if (!shouldRunGenerator(sourcePath, sourceConfig, affectedProjects, projects, root)) {
      continue;
    }

    const taskId = `gen-${sourcePath}`;

    log(`Generating: ${sourcePath}`);
    taskLog(`\x1b[33m$ ${sourceConfig.command}\x1b[0m`);

    if (dryRun) {
      generated.push(sourcePath);
      continue;
    }

    try {
      const result = await new Promise<{ success: boolean; output: string }>((resolve) => {
        // eslint-disable-next-line sonarjs/os-command -- build tool: runs user-configured source generators
        const proc = spawn(sourceConfig.command, {
          cwd: root,
          shell: true,
          stdio: 'pipe',
        });

        if (proc.pid) {
          addTask({ id: taskId, name: `gen:${sourcePath}`, pid: proc.pid, status: 'running' });
        }

        let output = '';
        proc.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          output += text;
          text.split('\n').forEach((line: string) => {
            if (line.trim()) taskLog(line);
          });
        });
        proc.stderr?.on('data', (data: Buffer) => {
          const text = data.toString();
          output += text;
          text.split('\n').forEach((line: string) => {
            if (line.trim()) taskLog(line);
          });
        });

        proc.on('close', (code) => {
          updateTask(taskId, code === 0 ? 'stopped' : 'error', 2000);
          resolve({ success: code === 0, output });
        });

        proc.on('error', (err) => {
          updateTask(taskId, 'error', 2000);
          resolve({ success: false, output: err.message });
        });
      });

      if (result.success) {
        log('Generated successfully');
        generated.push(sourcePath);
      } else {
        log('Generation FAILED');
        return { success: false, generated };
      }
    } catch (error) {
      log(`Generation FAILED: ${(error as Error).message}`);
      return { success: false, generated };
    }
  }

  return { success: true, generated };
}

const program = new Command();

program
  .name('workgraph')
  .description('Lightweight workspace dependency graph and parallel build orchestrator for monorepos')
  .version('0.0.1');

program
  .command('analyze')
  .description('Analyze workspace dependencies and show graph')
  .option('-r, --root <path>', 'Workspace root directory', process.cwd())
  .action(async (options: AnalyzeCommandOptions) => {
    try {
      const root = path.resolve(options.root);
      console.log(`Analyzing workspace at: ${root}\n`);

      const projects = await loadWorkspaceProjects(root);
      console.log(`Found ${projects.size} projects\n`);

      const graph = buildGraph(projects);

      console.log('Dependency Graph:');
      console.log(formatGraph(graph));
      console.log();

      const cycles = detectCycles(graph);
      if (cycles) {
        console.log('Cycles detected:');
        for (const cycle of cycles) {
          console.log(`  ${cycle.join(' -> ')}`);
        }
        process.exit(1);
      } else {
        console.log('No cycles detected');
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('scan')
  .description('Scan for unknown dependencies (missing generated sources)')
  .option('-r, --root <path>', 'Workspace root directory', process.cwd())
  .action(async (options: ScanCommandOptions) => {
    try {
      const root = path.resolve(options.root);
      console.log(`Scanning workspace at: ${root}\n`);

      const projects = await loadWorkspaceProjects(root);
      console.log(`Scanning ${projects.size} projects for unknown dependencies...\n`);

      const result = await scanForUnknownDependencies(projects, root);

      if (result.configuredSources.size > 0) {
        console.log('Configured sources:');
        const config = loadWorkgraphConfig(root);
        for (const sourcePath of result.configuredSources) {
          const sourceConfig = config.sources[sourcePath];
          if (!sourceConfig) continue;
          const command = typeof sourceConfig === 'string' ? sourceConfig : sourceConfig.command;
          console.log(`  ${sourcePath}`);
          console.log(`    -> ${command}`);
        }
        console.log();
      }

      if (result.unknownDependencies.length > 0) {
        console.log(formatUnknownDependencies(result.unknownDependencies, root));
        process.exit(1);
      } else {
        console.log('No unknown dependencies found');
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('plan')
  .description('Show build plan for changed projects')
  .option('-r, --root <path>', 'Workspace root directory', process.cwd())
  .option(
    '-c, --changed <projects...>',
    'Changed projects (names or paths)',
    []
  )
  .action(async (options: PlanCommandOptions) => {
    try {
      const root = path.resolve(options.root);
      const projects = await loadWorkspaceProjects(root);
      const graph = buildGraph(projects);

      const cycles = detectCycles(graph);
      if (cycles) {
        console.error('Cannot plan: cycles detected in dependency graph');
        process.exit(1);
      }

      let changedProjects: Set<string>;

      if (options.changed.length === 0) {
        console.log('No --changed specified, showing plan for all projects\n');
        changedProjects = new Set(projects.keys());
      } else {
        changedProjects = resolveProjectNames(options.changed, graph);
        if (changedProjects.size === 0) {
          console.error('Could not resolve any projects from:', options.changed);
          process.exit(1);
        }
        console.log(`Changed: ${[...changedProjects].join(', ')}\n`);
      }

      const affected = getAffectedProjects(changedProjects, graph.rdeps);
      const plan = createBuildPlan(affected, graph.deps);

      console.log(formatBuildPlan(plan));
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('build')
  .description('Build affected projects')
  .option('-r, --root <path>', 'Workspace root directory', process.cwd())
  .option(
    '-c, --changed <projects...>',
    'Changed projects (names or paths)',
    []
  )
  .option('--concurrency <number>', 'Max parallel builds', String(4))
  .option('--dry-run', 'Show what would be built without executing')
  .action(async (rawOptions: Partial<BuildCommandOptions> & { root: string; changed: string[]; concurrency: string }) => {
    const options: BuildCommandOptions = {
      ...rawOptions,
      dryRun: rawOptions.dryRun === true,
    };
    try {
      const root = path.resolve(options.root);
      const projects = await loadWorkspaceProjects(root);
      const graph = buildGraph(projects);

      const cycles = detectCycles(graph);
      if (cycles) {
        console.error('Cannot build: cycles detected in dependency graph');
        process.exit(1);
      }

      let changedProjects: Set<string>;

      if (options.changed.length === 0) {
        changedProjects = new Set(projects.keys());
      } else {
        changedProjects = resolveProjectNames(options.changed, graph);
      }

      const affected = getAffectedProjects(changedProjects, graph.rdeps);
      const plan = createBuildPlan(affected, graph.deps);

      console.log(formatBuildPlan(plan));
      console.log();

      if (plan.waves.length === 0) {
        console.log('Nothing to build');
        return;
      }

      // Run source generators before build
      const sourceResult = await runSourceGeneratorsWithUI(root, affected, projects, options.dryRun);
      if (!sourceResult.success) {
        console.error('Source generation failed, aborting build');
        process.exit(1);
      }
      if (sourceResult.generated.length > 0) {
        console.log();
      }

      const result = await executePlan(plan.waves, projects, root, {
        concurrency: parseInt(options.concurrency, 10),
        dryRun: options.dryRun,
        onStart: (info) => {
          const mode = info.isParallel ? 'parallel' : 'sequential';
          console.log(`[${formatTimestamp()}] Building: ${info.project} (wave ${info.wave}/${info.totalWaves} ${mode}, step ${info.step}/${info.totalSteps})`);
        },
        onComplete: (buildResult) => {
          const status = buildResult.success ? 'done' : 'FAILED';
          console.log(
            `[${formatTimestamp()}] ${buildResult.project}: ${status} (${buildResult.duration}ms)`
          );
          if (!buildResult.success && buildResult.error) {
            console.error(buildResult.error);
          }
        },
      });

      console.log();
      if (result.success) {
        console.log(`Build complete in ${result.duration}ms`);
      } else {
        console.error(`Build failed after ${result.duration}ms`);
        process.exit(1);
      }
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch for changes and rebuild affected projects')
  .argument('[apps...]', 'Apps to run dev servers for (e.g., api web-angular)')
  .option('-r, --root <path>', 'Workspace root directory', process.cwd())
  .option('--concurrency <number>', 'Max parallel builds', String(4))
  .option('--debounce <ms>', 'Debounce time in milliseconds', String(200))
  .option('--dry-run', 'Show what would be built without executing')
  .option('--filter <pattern>', 'Only build projects matching pattern (e.g., "libs/*")')
  .option('--verbose', 'Show detailed watcher and build output')
  .option('--no-ui', 'Disable split-screen UI')
  .action(async (apps: string[], rawOptions: Partial<WatchCommandOptions> & { root: string; concurrency: string; debounce: string; ui: boolean }) => {
    const options: WatchCommandOptions = {
      ...rawOptions,
      dryRun: rawOptions.dryRun === true,
      filter: rawOptions.filter !== undefined ? rawOptions.filter : '',
      verbose: rawOptions.verbose === true,
    };
    try {
      const root = path.resolve(options.root);
      const projects = await loadWorkspaceProjects(root);
      const graph = buildGraph(projects);

      const cycles = detectCycles(graph);
      if (cycles) {
        console.error('Cannot watch: cycles detected in dependency graph');
        process.exit(1);
      }

      // Create split-screen UI if enabled
      const ui = options.ui !== false ? createUI() : null;
      const log = ui ? ui.log : (msg: string) => console.log(`[${formatTimestamp()}] ${msg}`);
      const logRaw = ui ? (msg: string) => ui.leftPane.log(msg) : (msg: string) => console.log(msg);
      const taskLog = ui ? ui.taskLog : (msg: string) => console.log(msg);
      const setStatus = ui ? ui.setStatus : () => {};
      const addTask = ui ? ui.addTask : () => {};
      const updateTask = ui ? ui.updateTask : () => {};

      // Start dev servers for specified apps
      const devProcesses: { proc: ChildProcess; name: string; command: string }[] = [];

      // Unified cleanup handler for all resources
      const cleanup = () => {
        if (ui) {
          ui.destroy();
        }

        // ANSI color codes
        const dim = '\x1b[2m';
        const green = '\x1b[32m';
        const red = '\x1b[31m';
        const reset = '\x1b[0m';

        // Reset terminal using ANSI escape sequences (clear screen + move cursor home)
        process.stdout.write('\x1b[2J\x1b[H');

        const output: string[] = [''];

        // Kill all dev server process groups with SIGKILL for immediate termination
        if (devProcesses.length > 0) {
          output.push(`${dim}Stopping ${devProcesses.length} dev server(s)${reset}`);
          for (const { proc, name } of devProcesses) {
            if (proc.pid) {
              const shortName = name.includes('/') ? name.split('/').pop() : name;
              try {
                process.kill(-proc.pid, 'SIGKILL');
                output.push(`  ${green}✓${reset} ${shortName}`);
              } catch {
                try {
                  process.kill(proc.pid, 'SIGKILL');
                  output.push(`  ${green}✓${reset} ${shortName}`);
                } catch {
                  output.push(`  ${red}✗${reset} ${shortName} ${dim}(already stopped)${reset}`);
                }
              }
            }
          }
        }

        output.push('');

        // Print output directly to stdout
        process.stdout.write(output.join('\n'));

        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      if (apps.length > 0) {
        const resolvedApps = resolveProjectNames(apps, graph);
        if (resolvedApps.size === 0) {
          console.error('Could not resolve any apps from:', apps);
          process.exit(1);
        }

        // Build dependencies before starting dev servers
        // Get all dependencies of the apps (not the apps themselves)
        const depsToBuilt = new Set<string>();
        for (const appName of resolvedApps) {
          const appDeps = graph.deps.get(appName) ?? new Set<string>();
          for (const dep of appDeps) {
            depsToBuilt.add(dep);
            // Also add transitive dependencies
            const transitiveDeps = graph.deps.get(dep) ?? new Set<string>();
            for (const td of transitiveDeps) {
              depsToBuilt.add(td);
            }
          }
        }

        // Build dependencies first (source generators may need them)
        if (depsToBuilt.size > 0) {
          log(`Building ${depsToBuilt.size} dependencies first...`);

          // Build dependencies
          const plan = createBuildPlan(depsToBuilt, graph.deps);
          if (plan.waves.length > 0) {
            const result = await executePlan(plan.waves, projects, root, {
              concurrency: parseInt(options.concurrency, 10),
              dryRun: options.dryRun,
              onStart: (info) => {
                const mode = info.isParallel ? 'parallel' : 'sequential';
                log(`Building: ${info.project} (wave ${info.wave}/${info.totalWaves} ${mode}, step ${info.step}/${info.totalSteps})`);
                const shortName = info.project.includes('/') ? info.project.split('/').pop() : info.project;
                addTask({ id: `build-${info.project}`, name: `build:${shortName}`, pid: 0, status: 'running' });
              },
              onComplete: (buildResult) => {
                const status = buildResult.success ? 'done' : 'FAILED';
                log(`${buildResult.project}: ${status} (${buildResult.duration}ms)`);
                updateTask(`build-${buildResult.project}`, buildResult.success ? 'stopped' : 'error', 2000);
                if (!buildResult.success && buildResult.error) {
                  taskLog(buildResult.error);
                }
              },
              onOutput: taskLog,
            });

            if (result.success) {
              log('Dependencies built successfully');
            } else {
              log('Dependency build had errors, continuing anyway...');
            }
          }
        }

        // Include apps themselves for source generation
        const affected = new Set([...resolvedApps, ...depsToBuilt]);

        // Run source generators after dependencies are built
        const sourceResult = await runSourceGeneratorsWithUI(root, affected, projects, options.dryRun, { log, taskLog, addTask, updateTask });
        if (!sourceResult.success) {
          log('Source generation failed, continuing anyway...');
        }

        for (const appName of resolvedApps) {
          const project = projects.get(appName);
          if (!project) continue;

          const hasDevScript = project.packageJson.scripts['dev'];
          if (!hasDevScript) {
            log(`Warning: ${appName} has no dev script, skipping`);
            continue;
          }

          const devCmd = `npm run dev -w ${appName}`;
          log(`Starting dev server: ${appName}`);
          taskLog(`\x1b[33m$ ${devCmd}\x1b[0m`);

          // eslint-disable-next-line sonarjs/no-os-command-from-path -- build tool: npm must be resolved from PATH
          const proc = spawn('npm', ['run', 'dev', '-w', appName], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true,  // Create process group for proper cleanup
          });

          const shortName = appName.includes('/') ? appName.split('/').pop() : appName;
          const prefix = `[${shortName}]`;
          const taskId = `dev-${appName}`;

          // Add task to UI (pid is always defined after successful spawn)
          if (!proc.pid) {
            throw new Error(`Failed to start dev server for ${appName}: no pid`);
          }
          addTask({ id: taskId, name: shortName ?? appName, pid: proc.pid, status: 'running' });

          // Strip console clear escape sequences
          const ESC = '\x1b';
          const clearRegex = new RegExp(`${ESC}\\[\\d*J|${ESC}\\[\\d*H|${ESC}c`, 'g');
          const stripClearCodes = (text: string) => text.replace(clearRegex, '');

          proc.stdout?.on('data', (data: Buffer) => {
            const lines = stripClearCodes(data.toString()).trim().split('\n');
            for (const line of lines) {
              if (line) taskLog(`${prefix} ${line}`);
            }
          });

          proc.stderr?.on('data', (data: Buffer) => {
            const lines = stripClearCodes(data.toString()).trim().split('\n');
            for (const line of lines) {
              if (line) taskLog(`${prefix} ${line}`);
            }
          });

          proc.on('close', (code) => {
            log(`${prefix} exited with code ${code}`);
            updateTask(taskId, code === 0 ? 'stopped' : 'error');
          });

          devProcesses.push({ proc, name: appName, command: devCmd });
        }

        console.log();
      }

      // Filter projects if pattern provided
      const filterPattern = options.filter;
      const matchesFilter = (projectName: string): boolean => {
        if (!filterPattern) return true;
        const project = projects.get(projectName);
        if (!project) return false;

        // Match against path pattern (e.g., "libs/*")
        if (filterPattern.includes('*')) {
          const regex = new RegExp('^' + filterPattern.replace(/\*/g, '.*') + '$');
          return regex.test(project.path);
        }
        // Match against name or path
        return project.path.startsWith(filterPattern) || projectName.includes(filterPattern);
      };

      const filteredCount = filterPattern
        ? [...projects.keys()].filter(matchesFilter).length
        : projects.size;

      log(`Watching ${projects.size} projects for changes...`);
      if (filterPattern) {
        log(`Building only projects matching: ${filterPattern} (${filteredCount} projects)`);
      }
      log('Press Ctrl+C to stop');

      let isBuilding = false;
      let pendingChanges: Set<string> | null = null;
      let buildCount = 0;

      const handleChanges = async (changedProjects: Set<string>, changedFiles?: Map<string, string[]>) => {
        if (isBuilding) {
          pendingChanges = pendingChanges || new Set();
          for (const p of changedProjects) {
            pendingChanges.add(p);
          }
          return;
        }

        isBuilding = true;

        log('Changes detected:');
        if (changedFiles) {
          for (const [project, files] of changedFiles) {
            for (const file of files) {
              const relativePath = file.replace(root + '/', '');
              logRaw(`  ${relativePath} (${project})`);
            }
          }
        } else {
          logRaw(`  ${[...changedProjects].join(', ')} (pending)`);
        }

        const affected = getAffectedProjects(changedProjects, graph.rdeps);

        // Filter affected projects based on pattern
        const filteredAffected = new Set(
          [...affected].filter(matchesFilter)
        );

        if (filteredAffected.size === 0) {
          log('No matching projects to build');
          isBuilding = false;
          return;
        }

        buildCount++;
        setStatus(`build #${buildCount}`);
        logRaw('');

        const plan = createBuildPlan(filteredAffected, graph.deps);
        const totalSteps = plan.waves.reduce((sum, w) => sum + w.length, 0);

        // Display affected dependencies graph
        logRaw('Affected dependencies:');
        for (const proj of [...filteredAffected].sort((a, b) => a.localeCompare(b))) {
          const deps = graph.deps.get(proj) ?? new Set<string>();
          const affectedDeps = [...deps].filter(d => filteredAffected.has(d));
          if (affectedDeps.length > 0) {
            logRaw(`  ${proj} -> ${affectedDeps.join(', ')}`);
          } else {
            logRaw(`  ${proj} (no affected dependencies)`);
          }
        }

        // Display compilation plan
        logRaw('Compilation plan:');
        let stepCounter = 0;
        for (let i = 0; i < plan.waves.length; i++) {
          const wave = plan.waves[i]!;
          const mode = wave.length > 1 ? 'parallel' : 'sequential';
          for (const proj of wave) {
            stepCounter++;
            logRaw(`  [${stepCounter}/${totalSteps}] ${proj} (wave ${i + 1}/${plan.waves.length}, ${mode})`);
          }
        }
        logRaw('');

        // Run source generators for affected projects
        const sourceResult = await runSourceGeneratorsWithUI(root, affected, projects, options.dryRun, { log, taskLog, addTask, updateTask });
        if (!sourceResult.success) {
          log('Source generation failed');
          setStatus(`build #${buildCount} FAILED`);
          isBuilding = false;
          return;
        }

        log(`Building: ${[...filteredAffected].join(', ')}`);

        if (plan.waves.length > 0) {
          const result = await executePlan(plan.waves, projects, root, {
            concurrency: parseInt(options.concurrency, 10),
            dryRun: options.dryRun,
            onStart: (info) => {
              const mode = info.isParallel ? 'parallel' : 'sequential';
              log(`Building: ${info.project} (wave ${info.wave}/${info.totalWaves} ${mode}, step ${info.step}/${info.totalSteps})`);
              const shortName = info.project.includes('/') ? info.project.split('/').pop() : info.project;
              addTask({ id: `build-${info.project}`, name: `build:${shortName}`, pid: 0, status: 'running' });
            },
            onOutput: taskLog,
            onComplete: (buildResult) => {
              const status = buildResult.success ? 'done' : 'FAILED';
              log(`${buildResult.project}: ${status} (${buildResult.duration}ms)`);
              updateTask(`build-${buildResult.project}`, buildResult.success ? 'stopped' : 'error', 2000);
            },
          });

          if (result.success) {
            setStatus(`build #${buildCount} done`);
            log('Build complete');
          } else {
            setStatus(`build #${buildCount} FAILED`);
            log('Build failed');
          }
        } else {
          setStatus(`build #${buildCount} done`);
          log('Build complete');
        }

        isBuilding = false;

        if (pendingChanges && pendingChanges.size > 0) {
          const next = pendingChanges;
          pendingChanges = null;
          await handleChanges(next);
        }
      };

      // Get configured source paths to ignore (prevents infinite loop when generators write files)
      const config = loadWorkgraphConfig(root);
      const sourcePaths = Object.keys(config.sources).map(p => `**/${p}/**`);

      if (sourcePaths.length > 0) {
        log('Ignoring generated source paths (to prevent rebuild loops):');
        for (const p of sourcePaths) {
          logRaw(`  ${p}`);
        }
      }

      createWatcher(
        {
          root,
          debounceMs: parseInt(options.debounce, 10),
          onChange: (changedProjects, changedFiles) => {
            void handleChanges(changedProjects, changedFiles);
          },
          ignorePatterns: sourcePaths,
          verbose: options.verbose,
        },
        projects
      );
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
