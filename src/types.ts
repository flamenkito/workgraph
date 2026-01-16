/* eslint-disable no-restricted-syntax */
// PackageJson mirrors external npm package.json structure - optional fields are required
export interface PackageJson {
  name?: string;
  version?: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface Project {
  name: string;
  path: string;
  absolutePath: string;
  packageJson: PackageJson;
}

export interface DependencyGraph {
  projects: Map<string, Project>;
  deps: Map<string, Set<string>>;
  rdeps: Map<string, Set<string>>;
}

export interface BuildPlan {
  affected: Set<string>;
  waves: string[][];
}

export interface BuildResult {
  success: boolean;
  results: ProjectBuildResult[];
  duration: number;
}

/* eslint-disable no-restricted-syntax */
export interface ProjectBuildResult {
  project: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
}
/* eslint-enable no-restricted-syntax */

/* eslint-disable no-restricted-syntax */
export interface WatcherOptions {
  root: string;
  ignorePatterns?: string[];
  debounceMs?: number;
  verbose?: boolean;
  onChange: (changedProjects: Set<string>, changedFiles: Map<string, string[]>) => void;
}
/* eslint-enable no-restricted-syntax */

export interface BuildStepInfo {
  project: string;
  wave: number;
  totalWaves: number;
  step: number;
  totalSteps: number;
  isParallel: boolean;
}

/* eslint-disable no-restricted-syntax */
export interface ExecutorOptions {
  concurrency?: number;
  buildCommand?: (project: Project) => string;
  dryRun?: boolean;
  onStart?: (info: BuildStepInfo) => void;
  onComplete?: (result: ProjectBuildResult) => void;
  onOutput?: (line: string) => void;
}
/* eslint-enable no-restricted-syntax */

export interface AnalyzeOptions {
  root: string;
}

export interface PlanOptions {
  root: string;
  changed: string[];
}

/* eslint-disable no-restricted-syntax */
export interface BuildOptions {
  root: string;
  changed?: string[];
  concurrency?: number;
  dryRun?: boolean;
}
/* eslint-enable no-restricted-syntax */

/* eslint-disable no-restricted-syntax */
export interface WatchOptions {
  root: string;
  concurrency?: number;
  debounceMs?: number;
  dryRun?: boolean;
}
/* eslint-enable no-restricted-syntax */

export interface UnknownDependency {
  /** Project that has the unknown dependency */
  project: string;
  /** The import path that couldn't be resolved */
  importPath: string;
  /** Resolved absolute path */
  absolutePath: string;
  /** Files that import this path */
  importedFrom: string[];
}

/* eslint-disable no-restricted-syntax */
export interface SourceConfig {
  command: string;
  deps?: string[];
}
/* eslint-enable no-restricted-syntax */

/* eslint-disable no-restricted-syntax */
export interface WorkgraphConfig {
  sources?: Record<string, string | SourceConfig>;
}
/* eslint-enable no-restricted-syntax */
