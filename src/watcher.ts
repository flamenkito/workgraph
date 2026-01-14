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
    ignorePatterns = DEFAULT_IGNORE_PATTERNS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    onChange,
  } = options;

  let changedFiles: string[] = [];
  let debounceTimer: NodeJS.Timeout | null = null;

  const processChanges = () => {
    if (changedFiles.length === 0) return;

    const filesToProcess = [...changedFiles];
    changedFiles = [];

    const changedProjects = new Set<string>();
    let isGlobalChange = false;

    for (const file of filesToProcess) {
      if (isRootConfig(file, root)) {
        isGlobalChange = true;
        break;
      }

      const project = getProjectFromPath(file, projects, root);
      if (project) {
        changedProjects.add(project);
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
    ignored: ignorePatterns,
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
