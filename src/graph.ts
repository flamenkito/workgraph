import { DependencyGraph, Project } from './types';

export function buildGraph(projects: Map<string, Project>): DependencyGraph {
  const deps = new Map<string, Set<string>>();
  const rdeps = new Map<string, Set<string>>();

  // Initialize empty sets for all projects
  for (const name of projects.keys()) {
    deps.set(name, new Set());
    rdeps.set(name, new Set());
  }

  // Build dependency edges
  for (const [name, project] of projects) {
    const allDeps = {
      ...project.packageJson.dependencies,
      ...project.packageJson.devDependencies,
      ...project.packageJson.peerDependencies,
      ...project.packageJson.optionalDependencies,
    };

    for (const depName of Object.keys(allDeps)) {
      if (projects.has(depName)) {
        // A depends on depName: A -> depName
        deps.get(name)!.add(depName);
        // Reverse: depName has dependent A
        rdeps.get(depName)!.add(name);
      }
    }
  }

  return { projects, deps, rdeps };
}

export function detectCycles(graph: DependencyGraph): string[][] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;

  const color = new Map<string, number>();
  const cycles: string[][] = [];

  // Initialize all nodes as WHITE (unvisited)
  for (const name of graph.projects.keys()) {
    color.set(name, WHITE);
  }

  function dfs(node: string, path: string[]): void {
    color.set(node, GRAY);
    path.push(node);

    const nodeDeps = graph.deps.get(node) || new Set();
    for (const dep of nodeDeps) {
      const depColor = color.get(dep);

      if (depColor === GRAY) {
        // Back edge found - cycle detected
        const cycleStart = path.indexOf(dep);
        cycles.push([...path.slice(cycleStart), dep]);
      } else if (depColor === WHITE) {
        dfs(dep, path);
      }
    }

    path.pop();
    color.set(node, BLACK);
  }

  for (const name of graph.projects.keys()) {
    if (color.get(name) === WHITE) {
      dfs(name, []);
    }
  }

  return cycles.length > 0 ? cycles : null;
}

export function getTopologicalOrder(graph: DependencyGraph): string[] {
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(node: string): void {
    if (visited.has(node)) return;
    visited.add(node);

    const nodeDeps = graph.deps.get(node) || new Set();
    for (const dep of nodeDeps) {
      visit(dep);
    }

    result.push(node);
  }

  for (const name of graph.projects.keys()) {
    visit(name);
  }

  return result;
}

export function formatGraph(graph: DependencyGraph): string {
  const lines: string[] = [];

  const sortedProjects = [...graph.projects.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [name, project] of sortedProjects) {
    lines.push(`  ${name} (${project.path})`);

    const projectDeps = graph.deps.get(name) || new Set();
    if (projectDeps.size === 0) {
      lines.push('    (no dependencies)');
    } else {
      for (const dep of [...projectDeps].sort()) {
        lines.push(`    -> ${dep}`);
      }
    }
  }

  return lines.join('\n');
}
