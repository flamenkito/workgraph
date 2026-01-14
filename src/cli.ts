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

function normalizeSourceConfig(config: string | SourceConfig): SourceConfig {
  if (typeof config === 'string') {
    return { command: config };
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
  if (sourceConfig.deps && sourceConfig.deps.length > 0) {
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

async function runSourceGenerators(
  root: string,
  affectedProjects: Set<string>,
  projects: Map<string, Project>,
  dryRun: boolean = false
): Promise<{ success: boolean; generated: string[] }> {
  const config = loadWorkgraphConfig(root);
  const sources = config.sources || {};
  const generated: string[] = [];

  for (const [sourcePath, rawConfig] of Object.entries(sources)) {
    const sourceConfig = normalizeSourceConfig(rawConfig);

    if (!shouldRunGenerator(sourcePath, sourceConfig, affectedProjects, projects, root)) {
      continue;
    }

    console.log(`[${formatTimestamp()}] Generating: ${sourcePath}`);

    if (dryRun) {
      console.log(`[${formatTimestamp()}]   [dry-run] Would run: ${sourceConfig.command}`);
      generated.push(sourcePath);
      continue;
    }

    try {
      const result = await new Promise<{ success: boolean; output: string }>((resolve) => {
        const proc = spawn(sourceConfig.command, {
          cwd: root,
          shell: true,
          stdio: 'pipe',
        });

        let output = '';
        proc.stdout?.on('data', (data) => (output += data));
        proc.stderr?.on('data', (data) => (output += data));

        proc.on('close', (code) => {
          resolve({ success: code === 0, output });
        });

        proc.on('error', (err) => {
          resolve({ success: false, output: err.message });
        });
      });

      if (result.success) {
        console.log(`[${formatTimestamp()}]   Generated successfully`);
        generated.push(sourcePath);
      } else {
        console.error(`[${formatTimestamp()}]   Generation FAILED`);
        console.error(result.output);
        return { success: false, generated };
      }
    } catch (error) {
      console.error(`[${formatTimestamp()}]   Generation FAILED: ${(error as Error).message}`);
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
  .action(async (options) => {
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
  .action(async (options) => {
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
          const sourceConfig = config.sources![sourcePath];
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
  .action(async (options) => {
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
  .action(async (options) => {
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
      const sourceResult = await runSourceGenerators(root, affected, projects, options.dryRun);
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
        onComplete: (result) => {
          const status = result.success ? 'done' : 'FAILED';
          console.log(
            `[${formatTimestamp()}] ${result.project}: ${status} (${result.duration}ms)`
          );
          if (!result.success && result.error) {
            console.error(result.error);
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
  .action(async (apps: string[], options) => {
    try {
      const root = path.resolve(options.root);
      const projects = await loadWorkspaceProjects(root);
      const graph = buildGraph(projects);

      const cycles = detectCycles(graph);
      if (cycles) {
        console.error('Cannot watch: cycles detected in dependency graph');
        process.exit(1);
      }

      // Start dev servers for specified apps
      const devProcesses: ChildProcess[] = [];
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
          const appDeps = graph.deps.get(appName) || new Set();
          for (const dep of appDeps) {
            depsToBuilt.add(dep);
            // Also add transitive dependencies
            const transitiveDeps = graph.deps.get(dep) || new Set();
            for (const td of transitiveDeps) {
              depsToBuilt.add(td);
            }
          }
        }

        // Build dependencies first (source generators may need them)
        if (depsToBuilt.size > 0) {
          console.log(`Building ${depsToBuilt.size} dependencies first...\n`);

          // Build dependencies
          const plan = createBuildPlan(depsToBuilt, graph.deps);
          if (plan.waves.length > 0) {
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

            if (result.success) {
              console.log(`[${formatTimestamp()}] Dependencies built successfully\n`);
            } else {
              console.error(`[${formatTimestamp()}] Dependency build had errors, continuing anyway...\n`);
            }
          }
        }

        // Include apps themselves for source generation
        const affected = new Set([...resolvedApps, ...depsToBuilt]);

        // Run source generators after dependencies are built
        const sourceResult = await runSourceGenerators(root, affected, projects, options.dryRun);
        if (!sourceResult.success) {
          console.error('Source generation failed, continuing anyway...');
        }

        for (const appName of resolvedApps) {
          const project = projects.get(appName);
          if (!project) continue;

          const hasDevScript = project.packageJson.scripts?.dev;
          if (!hasDevScript) {
            console.warn(`Warning: ${appName} has no dev script, skipping`);
            continue;
          }

          console.log(`Starting dev server: ${appName}`);
          const proc = spawn('npm', ['run', 'dev', '-w', appName], {
            cwd: root,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
          });

          const shortName = appName.includes('/') ? appName.split('/').pop() : appName;
          const prefix = `[${shortName}]`;

          // Strip console clear escape sequences
          const stripClearCodes = (text: string) =>
            text.replace(/\x1b\[[0-9]*J|\x1b\[[0-9]*H|\x1bc/g, '');

          proc.stdout?.on('data', (data: Buffer) => {
            const lines = stripClearCodes(data.toString()).trim().split('\n');
            for (const line of lines) {
              if (line) console.log(`${prefix} ${line}`);
            }
          });

          proc.stderr?.on('data', (data: Buffer) => {
            const lines = stripClearCodes(data.toString()).trim().split('\n');
            for (const line of lines) {
              if (line) console.error(`${prefix} ${line}`);
            }
          });

          proc.on('close', (code) => {
            console.log(`${prefix} exited with code ${code}`);
          });

          devProcesses.push(proc);
        }

        // Handle cleanup on exit
        const cleanup = () => {
          for (const proc of devProcesses) {
            proc.kill();
          }
          process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

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

      console.log(`Watching ${projects.size} projects for changes...`);
      if (filterPattern) {
        console.log(`Building only projects matching: ${filterPattern} (${filteredCount} projects)`);
      }
      console.log('Press Ctrl+C to stop\n');

      let isBuilding = false;
      let pendingChanges: Set<string> | null = null;

      const handleChanges = async (changedProjects: Set<string>) => {
        if (isBuilding) {
          pendingChanges = pendingChanges || new Set();
          for (const p of changedProjects) {
            pendingChanges.add(p);
          }
          return;
        }

        isBuilding = true;

        console.log(
          `[${formatTimestamp()}] Changes detected: ${[...changedProjects].join(', ')}`
        );

        const affected = getAffectedProjects(changedProjects, graph.rdeps);

        // Filter affected projects based on pattern
        const filteredAffected = new Set(
          [...affected].filter(matchesFilter)
        );

        if (filteredAffected.size === 0) {
          console.log(`[${formatTimestamp()}] No matching projects to build\n`);
          isBuilding = false;
          return;
        }

        const plan = createBuildPlan(filteredAffected, graph.deps);

        // Run source generators for affected projects
        const sourceResult = await runSourceGenerators(root, affected, projects, options.dryRun);
        if (!sourceResult.success) {
          console.error(`[${formatTimestamp()}] Source generation failed\n`);
          isBuilding = false;
          return;
        }

        console.log(`[${formatTimestamp()}] Building: ${[...filteredAffected].join(', ')}`);

        if (plan.waves.length > 0) {
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
            },
          });

          if (result.success) {
            console.log(`[${formatTimestamp()}] Build complete\n`);
          } else {
            console.error(`[${formatTimestamp()}] Build failed\n`);
          }
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
      const sourcePaths = Object.keys(config.sources || {}).map(p => `**/${p}/**`);

      if (sourcePaths.length > 0) {
        console.log('Ignoring generated source paths (to prevent rebuild loops):');
        for (const p of sourcePaths) {
          console.log(`  ${p}`);
        }
        console.log();
      }

      createWatcher(
        {
          root,
          debounceMs: parseInt(options.debounce, 10),
          onChange: handleChanges,
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
