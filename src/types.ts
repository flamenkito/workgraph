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
  verbose?: boolean;
  onChange: (changedProjects: Set<string>) => void;
}

export interface BuildStepInfo {
  project: string;
  wave: number;
  totalWaves: number;
  step: number;
  totalSteps: number;
  isParallel: boolean;
}

export interface ExecutorOptions {
  concurrency?: number;
  buildCommand?: (project: Project) => string;
  dryRun?: boolean;
  onStart?: (info: BuildStepInfo) => void;
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

export interface SourceConfig {
  command: string;
  deps?: string[];
}

export interface WorkgraphConfig {
  sources?: Record<string, string | SourceConfig>;
}
