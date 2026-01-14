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

export interface ProjectBuildResult {
  project: string;
  success: boolean;
  duration: number;
  output?: string;
  error?: string;
}

export interface WatcherOptions {
  root: string;
  ignorePatterns?: string[];
  debounceMs?: number;
  onChange: (changedProjects: Set<string>) => void;
}

export interface ExecutorOptions {
  concurrency?: number;
  buildCommand?: (project: Project) => string;
  dryRun?: boolean;
  onStart?: (project: string) => void;
  onComplete?: (result: ProjectBuildResult) => void;
}

export interface AnalyzeOptions {
  root: string;
}

export interface PlanOptions {
  root: string;
  changed: string[];
}

export interface BuildOptions {
  root: string;
  changed?: string[];
  concurrency?: number;
  dryRun?: boolean;
}

export interface WatchOptions {
  root: string;
  concurrency?: number;
  debounceMs?: number;
  dryRun?: boolean;
}
