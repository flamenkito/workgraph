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
import { Project } from './types';

const program = new Command();

program
  .name('worktree')
  .description('Workspace dependency analyzer and parallel build orchestrator for monorepos')
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

      const result = await executePlan(plan.waves, projects, root, {
        concurrency: parseInt(options.concurrency, 10),
        dryRun: options.dryRun,
        onStart: (project) => {
          console.log(`[${formatTimestamp()}] Building: ${project}`);
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

          proc.stdout?.on('data', (data: Buffer) => {
            const lines = data.toString().trim().split('\n');
            for (const line of lines) {
              console.log(`${prefix} ${line}`);
            }
          });

          proc.stderr?.on('data', (data: Buffer) => {
            const lines = data.toString().trim().split('\n');
            for (const line of lines) {
              console.error(`${prefix} ${line}`);
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

        console.log(`[${formatTimestamp()}] Building: ${[...filteredAffected].join(', ')}`);

        if (plan.waves.length > 0) {
          const result = await executePlan(plan.waves, projects, root, {
            concurrency: parseInt(options.concurrency, 10),
            dryRun: options.dryRun,
            onStart: (project) => {
              console.log(`[${formatTimestamp()}] Building: ${project}`);
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

      createWatcher(
        {
          root,
          debounceMs: parseInt(options.debounce, 10),
          onChange: handleChanges,
        },
        projects
      );
    } catch (error) {
      console.error('Error:', (error as Error).message);
      process.exit(1);
    }
  });

program.parse();
