import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { Project, SourceConfig, UnknownDependency, WorkgraphConfig } from './types';

// Match import/export statements - simplified pattern to avoid backtracking
// Matches: import 'x', import x from 'x', import {x} from 'x', export * from 'x', etc.
const IMPORT_REGEX = /(?:import|export)[^'"]*['"]([^'"]+)['"]/g;
const REQUIRE_REGEX = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export interface ScanResult {
  unknownDependencies: UnknownDependency[];
  configuredSources: Set<string>;
}

export async function scanProjectImports(
  project: Project,
  root: string
): Promise<Map<string, string[]>> {
  const importMap = new Map<string, string[]>();
  const srcPath = path.join(project.absolutePath, 'src');

  if (!fs.existsSync(srcPath)) {
    return importMap;
  }

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: srcPath,
    absolute: true,
    ignore: ['**/*.d.ts', '**/node_modules/**'],
  });

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const imports = extractImports(content);

    for (const importPath of imports) {
      // Only analyze relative imports
      if (!importPath.startsWith('.')) continue;

      const fileDir = path.dirname(file);
      const resolvedPath = resolveImportPath(importPath, fileDir);

      if (!resolvedPath) continue;

      // Check if this is an unknown dependency (doesn't exist on disk)
      if (!pathExists(resolvedPath)) {
        const relativePath = path.relative(project.absolutePath, resolvedPath);
        const key = `${project.path}/${relativePath}`;

        if (!importMap.has(key)) {
          importMap.set(key, []);
        }
        importMap.get(key)!.push(path.relative(root, file));
      }
    }
  }

  return importMap;
}

function extractImports(content: string): string[] {
  const imports: string[] = [];

  let match;
  while ((match = IMPORT_REGEX.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath) imports.push(importPath);
  }

  IMPORT_REGEX.lastIndex = 0;

  while ((match = REQUIRE_REGEX.exec(content)) !== null) {
    const requirePath = match[1];
    if (requirePath) imports.push(requirePath);
  }

  REQUIRE_REGEX.lastIndex = 0;

  return imports;
}

function resolveImportPath(importPath: string, fromDir: string): string | null {
  const resolved = path.resolve(fromDir, importPath);

  // Try common extensions and index files
  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    `${resolved}.js`,
    `${resolved}.jsx`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
    path.join(resolved, 'index.js'),
    path.join(resolved, 'index.jsx'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.statSync(candidate).isDirectory() ? candidate : path.dirname(candidate);
    }
  }

  // Return the base path (directory) for missing imports
  return resolved;
}

function pathExists(p: string): boolean {
  // Check if path exists as file or directory
  if (fs.existsSync(p)) return true;

  // Try with extensions
  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  for (const ext of extensions) {
    if (fs.existsSync(p + ext)) return true;
  }

  // Try index files
  for (const ext of extensions) {
    if (fs.existsSync(path.join(p, `index${ext}`))) return true;
  }

  return false;
}

interface RawSourceConfig {
  command: string;
  deps: string[];
  target?: string;
}

interface RawWorkgraphConfig {
  sources: Record<string, string | Partial<RawSourceConfig>>;
}

// Default for empty deps array (external API)
const EMPTY_DEPS: string[] = [];

const normalizeSourceConfig = (
  value: string | Partial<RawSourceConfig>,
  cwd?: string,
  /** Project name that contains this source config - auto-set as target */
  projectName?: string,
): SourceConfig => {
  if (typeof value === 'string') {
    const config: SourceConfig = { command: value, deps: EMPTY_DEPS };
    if (cwd) config.cwd = cwd;
    if (projectName) config.target = projectName;
    return config;
  }

  const base: SourceConfig = {
    command: value.command ?? '',
    deps: value.deps ?? EMPTY_DEPS,
  };

  if (cwd) base.cwd = cwd;
  // Explicit target overrides auto-detected, otherwise use containing project
  const target = value.target ?? projectName;
  if (target) base.target = target;

  return base;
};

const loadPackageWorkgraphConfig = (
  pkgPath: string,
  cwd?: string,
  /** Project name for auto-targeting sources defined in this package */
  projectName?: string,
): Record<string, SourceConfig> => {
  if (!fs.existsSync(pkgPath)) {
    return {};
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
    workgraph?: Partial<RawWorkgraphConfig>;
  };
  const workgraph = pkg.workgraph;
  if (!workgraph?.sources) {
    return {};
  }

  const sources: Record<string, SourceConfig> = {};
  for (const [key, value] of Object.entries(workgraph.sources)) {
    if (value) {
      sources[key] = normalizeSourceConfig(value, cwd, projectName);
    }
  }

  return sources;
};

export const loadWorkgraphConfig = (
  root: string,
  projects?: Map<string, Project>,
): WorkgraphConfig => {
  // Load root config (no cwd - runs from root)
  const rootSources = loadPackageWorkgraphConfig(path.join(root, 'package.json'));

  // Load per-project configs (auto-target sources to their containing project)
  const projectSources: Record<string, SourceConfig> = {};
  if (projects) {
    for (const [name, project] of projects) {
      const pkgPath = path.join(project.absolutePath, 'package.json');
      const sources = loadPackageWorkgraphConfig(pkgPath, project.absolutePath, name);
      Object.assign(projectSources, sources);
    }
  }

  // Merge: project-level sources override root sources
  return {
    sources: { ...rootSources, ...projectSources },
  };
};

export function isPathInGitignore(filePath: string, root: string): boolean {
  const gitignorePath = path.join(root, '.gitignore');

  if (!fs.existsSync(gitignorePath)) {
    return false;
  }

  const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
  const relativePath = path.relative(root, filePath);

  const patterns = gitignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  for (const pattern of patterns) {
    // Simple pattern matching - exact match or starts with
    if (relativePath === pattern || relativePath.startsWith(pattern.replace(/\/$/, '') + '/')) {
      return true;
    }
    // Handle patterns that match directories
    if (pattern.endsWith('/') && relativePath.startsWith(pattern)) {
      return true;
    }
  }

  return false;
}

export async function scanForUnknownDependencies(
  projects: Map<string, Project>,
  root: string
): Promise<ScanResult> {
  const config = loadWorkgraphConfig(root, projects);
  const configuredSources = new Set<string>(Object.keys(config.sources));
  const unknownDependencies: UnknownDependency[] = [];

  for (const [name, project] of projects) {
    const importMap = await scanProjectImports(project, root);

    for (const [importPath, files] of importMap) {
      // Skip if this source is already configured
      if (configuredSources.has(importPath)) continue;

      const absolutePath = path.resolve(root, importPath);

      unknownDependencies.push({
        project: name,
        importPath,
        absolutePath,
        importedFrom: files,
      });
    }
  }

  return {
    unknownDependencies,
    configuredSources,
  };
}

export function formatUnknownDependencies(deps: UnknownDependency[], root: string): string {
  if (deps.length === 0) return '';

  const lines: string[] = [];
  lines.push('Unknown dependencies detected:');
  lines.push('');

  const byProject = new Map<string, UnknownDependency[]>();
  for (const dep of deps) {
    if (!byProject.has(dep.project)) {
      byProject.set(dep.project, []);
    }
    byProject.get(dep.project)!.push(dep);
  }

  for (const [project, projectDeps] of byProject) {
    lines.push(`  ${project}:`);
    for (const dep of projectDeps) {
      const inGitignore = isPathInGitignore(dep.absolutePath, root);
      const note = inGitignore ? ' (in .gitignore)' : '';
      lines.push(`    - ${dep.importPath}${note}`);
      lines.push(`      Imported from: ${dep.importedFrom[0]}`);
      if (dep.importedFrom.length > 1) {
        lines.push(`        (and ${dep.importedFrom.length - 1} more files)`);
      }
    }
  }

  lines.push('');
  lines.push('To configure generated sources, add to your root package.json:');
  lines.push('');
  lines.push('  "workgraph": {');
  lines.push('    "sources": {');
  for (const dep of deps) {
    lines.push(`      "${dep.importPath}": "<command to generate>"`);
  }
  lines.push('    }');
  lines.push('  }');
  lines.push('');

  return lines.join('\n');
}
