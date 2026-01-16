import { BuildPlan } from './types';

/**
 * Plan build waves using Kahn's algorithm.
 *
 * Projects in the same wave can be built in parallel (no dependencies between them).
 * Waves must be executed sequentially.
 *
 * @param affected - Set of affected project names
 * @param deps - Dependency map (A -> B means A depends on B)
 * @returns Array of waves, each wave is an array of project names
 */
export function planWaves(
  affected: Set<string>,
  deps: Map<string, Set<string>>
): string[][] {
  if (affected.size === 0) {
    return [];
  }

  // Build in-degree for induced subgraph (only count deps within affected set)
  const inDegree = new Map<string, number>();

  for (const node of affected) {
    const nodeDeps = deps.get(node) || new Set();
    // Count only dependencies that are also in the affected set
    const count = [...nodeDeps].filter(d => affected.has(d)).length;
    inDegree.set(node, count);
  }

  const waves: string[][] = [];
  const remaining = new Set(affected);

  while (remaining.size > 0) {
    // Find all nodes with in-degree 0 (no unbuilt dependencies)
    const wave = [...remaining].filter(n => inDegree.get(n) === 0);

    if (wave.length === 0) {
      // This should not happen if cycles were already checked
      throw new Error(
        'Cycle detected in affected subgraph. Cannot plan build order.'
      );
    }

    // Sort wave for consistent output
    wave.sort((a, b) => a.localeCompare(b));
    waves.push(wave);

    // Remove wave from graph and update in-degrees
    for (const node of wave) {
      remaining.delete(node);

      // Decrement in-degree of all nodes that depend on this node
      for (const other of remaining) {
        const otherDeps = deps.get(other) || new Set();
        if (otherDeps.has(node)) {
          inDegree.set(other, inDegree.get(other)! - 1);
        }
      }
    }
  }

  return waves;
}

/**
 * Create a complete build plan from affected projects and dependency graph.
 */
export function createBuildPlan(
  affected: Set<string>,
  deps: Map<string, Set<string>>
): BuildPlan {
  const waves = planWaves(affected, deps);

  return {
    affected,
    waves,
  };
}

/**
 * Format a build plan as a human-readable string.
 */
export function formatBuildPlan(plan: BuildPlan): string {
  const lines: string[] = [];

  lines.push(`Affected: ${[...plan.affected].sort((a, b) => a.localeCompare(b)).join(', ')}`);
  lines.push('');
  lines.push('Build Plan:');

  for (let i = 0; i < plan.waves.length; i++) {
    const wave = plan.waves[i]!;
    const parallelNote = wave.length > 1 ? ' (parallel)' : '';
    lines.push(`  Wave ${i + 1}${parallelNote}: ${wave.join(', ')}`);
  }

  lines.push('');
  lines.push(`Total: ${plan.affected.size} projects in ${plan.waves.length} waves`);

  return lines.join('\n');
}
