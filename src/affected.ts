import { DependencyGraph } from './types';

export function getAffectedProjects(
  changedProjects: Set<string>,
  rdeps: Map<string, Set<string>>
): Set<string> {
  const affected = new Set<string>();
  const queue = [...changedProjects];

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (affected.has(current)) continue;
    affected.add(current);

    const dependents = rdeps.get(current) || new Set();
    for (const dependent of dependents) {
      if (!affected.has(dependent)) {
        queue.push(dependent);
      }
    }
  }

  return affected;
}

export function resolveProjectNames(
  projectIdentifiers: string[],
  graph: DependencyGraph
): Set<string> {
  const resolved = new Set<string>();

  for (const identifier of projectIdentifiers) {
    // Try exact name match first
    if (graph.projects.has(identifier)) {
      resolved.add(identifier);
      continue;
    }

    // Try path match
    for (const [name, project] of graph.projects) {
      if (project.path === identifier || project.absolutePath === identifier) {
        resolved.add(name);
        break;
      }
    }

    // Try partial name match (e.g., "auth" matches "@example/auth")
    for (const name of graph.projects.keys()) {
      if (name.endsWith('/' + identifier) || name === identifier) {
        resolved.add(name);
        break;
      }
    }
  }

  return resolved;
}
