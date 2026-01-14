import { DependencyGraph, Project } from './types';
import { getProjectFromPath, isRootConfig } from './workspace';

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

export function getChangedProjectsFromFiles(
  changedFiles: string[],
  projects: Map<string, Project>,
  root: string
): { changedProjects: Set<string>; isGlobalChange: boolean } {
  const changedProjects = new Set<string>();
  let isGlobalChange = false;

  for (const file of changedFiles) {
    if (isRootConfig(file, root)) {
      isGlobalChange = true;
      continue;
    }

    const project = getProjectFromPath(file, projects, root);
    if (project) {
      changedProjects.add(project);
    }
  }

  return { changedProjects, isGlobalChange };
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
