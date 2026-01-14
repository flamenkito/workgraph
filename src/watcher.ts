import * as chokidar from 'chokidar';
import { WatcherOptions, Project } from './types';
import { getProjectFromPath, isRootConfig } from './workspace';

const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/.angular/**',
  '**/.nx/**',
  '**/coverage/**',
  '**/*.log',
  '**/.git/**',
  '**/tmp/**',
  '**/.cache/**',
];

const DEFAULT_DEBOUNCE_MS = 200;

export function createWatcher(
  options: WatcherOptions,
  projects: Map<string, Project>
): chokidar.FSWatcher {
  const {
    root,
    ignorePatterns = [],
    debounceMs = DEFAULT_DEBOUNCE_MS,
    verbose = false,
    onChange,
  } = options;

  const allIgnorePatterns = [...DEFAULT_IGNORE_PATTERNS, ...ignorePatterns];

  let changedFiles: string[] = [];
  let debounceTimer: NodeJS.Timeout | null = null;

  const processChanges = () => {
    if (changedFiles.length === 0) return;

    const filesToProcess = [...changedFiles];
    changedFiles = [];

    const changedProjects = new Set<string>();
    const filesByProject = new Map<string, string[]>();
    let isGlobalChange = false;

    for (const file of filesToProcess) {
      if (isRootConfig(file, root)) {
        isGlobalChange = true;
        if (verbose) console.log(`[watcher] Root config changed: ${file}`);
        break;
      }

      const project = getProjectFromPath(file, projects, root);
      if (project) {
        changedProjects.add(project);
        if (!filesByProject.has(project)) {
          filesByProject.set(project, []);
        }
        filesByProject.get(project)!.push(file);
      } else if (verbose) {
        console.log(`[watcher] File not in any project: ${file}`);
      }
    }

    // Log which files triggered which projects
    if (verbose) {
      for (const [project, files] of filesByProject) {
        console.log(`[watcher] ${project}:`);
        for (const f of files) {
          const relativePath = f.replace(root + '/', '');
          console.log(`  - ${relativePath}`);
        }
      }
    }

    if (isGlobalChange) {
      // All projects affected by root config change
      onChange(new Set(projects.keys()));
    } else if (changedProjects.size > 0) {
      onChange(changedProjects);
    }
  };

  const scheduleProcess = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(processChanges, debounceMs);
  };

  const watcher = chokidar.watch(root, {
    ignored: allIgnorePatterns,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  const handleChange = (filePath: string) => {
    changedFiles.push(filePath);
    scheduleProcess();
  };

  watcher
    .on('add', handleChange)
    .on('change', handleChange)
    .on('unlink', handleChange);

  return watcher;
}

export function formatTimestamp(): string {
  const now = new Date();
  return now.toLocaleTimeString('en-US', { hour12: false });
}
