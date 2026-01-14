# worktree

Workspace dependency analyzer and parallel build orchestrator for npm/yarn/pnpm monorepos.

## Features

- **Dependency Graph Analysis** - Scans workspace projects and builds a directed dependency graph
- **Cycle Detection** - Detects circular dependencies using DFS with coloring
- **Affected Project Detection** - Determines which projects are affected by changes (transitive dependents)
- **Parallel Build Planning** - Uses Kahn's algorithm to plan build waves (parallel within wave, sequential between waves)
- **File Watching** - Monitors file changes with debouncing and triggers rebuilds
- **Dev Server Management** - Start and manage multiple dev servers with prefixed output
- **Concurrent Execution** - Executes builds with configurable concurrency limits

## Installation

```bash
npm install -g worktree
# or
npm install -D worktree
```

## CLI Usage

### Analyze Dependencies

Show the dependency graph and detect cycles:

```bash
worktree analyze
```

Output:
```
Analyzing workspace at: /path/to/workspace

Found 6 projects

Dependency Graph:
  @myorg/api (apps/api)
    -> @myorg/auth
  @myorg/auth (libs/auth)
    (no dependencies)
  @myorg/web (apps/web)
    -> @myorg/api

No cycles detected
```

### Plan Build

Show what would be built for specific changes:

```bash
# By package name
worktree plan -c @myorg/auth

# By shorthand name
worktree plan -c auth

# By path
worktree plan -c libs/auth

# Multiple changes
worktree plan -c auth -c utils
```

Output:
```
Changed: @myorg/auth, @myorg/utils
Affected: @myorg/api, @myorg/auth, @myorg/utils, @myorg/web

Build Plan:
  Wave 1 (parallel): @myorg/auth, @myorg/utils
  Wave 2: @myorg/api
  Wave 3: @myorg/web

Total: 4 projects in 3 waves
```

### Build Affected Projects

Execute the build plan:

```bash
# Build all
worktree build

# Build affected by specific changes
worktree build -c auth

# Dry run (show plan without executing)
worktree build -c auth --dry-run

# With custom concurrency
worktree build -c auth --concurrency 2
```

### Watch Mode

Watch for file changes and automatically rebuild affected projects:

```bash
# Watch all projects
worktree watch

# Watch all, but only rebuild libs (for dev with app servers)
worktree watch --filter 'libs/*'

# Watch libs + start app dev servers
worktree watch --filter 'libs/*' api web

# Dry run mode
worktree watch --dry-run
```

**Dev workflow (single terminal):**
```bash
# Watch libs + start API and web dev servers
worktree watch --filter 'libs/*' api web
```

Output:
```
Starting dev server: @myorg/api
Starting dev server: @myorg/web

Watching 7 projects for changes...
Building only projects matching: libs/* (4 projects)
Press Ctrl+C to stop

[api] [Nest] Starting Nest application...
[web] ➜ Local: http://localhost:3000
```

## CLI Options

| Option | Description | Default |
|--------|-------------|---------|
| `-r, --root <path>` | Workspace root directory | `process.cwd()` |
| `-c, --changed <projects...>` | Changed projects (names or paths) | `[]` |
| `--concurrency <number>` | Max parallel builds | CPU count - 1 |
| `--debounce <ms>` | Debounce time for watch mode | `200` |
| `--dry-run` | Show plan without executing | `false` |
| `--filter <pattern>` | Only build projects matching pattern (e.g., `libs/*`) | - |

## Programmatic API

```typescript
import {
  loadWorkspaceProjects,
  buildGraph,
  detectCycles,
  getAffectedProjects,
  planWaves,
  executePlan,
  createWatcher,
} from 'worktree';

// Load workspace projects
const projects = await loadWorkspaceProjects('/path/to/workspace');

// Build dependency graph
const graph = buildGraph(projects);

// Check for cycles
const cycles = detectCycles(graph);
if (cycles) {
  console.error('Cycles detected:', cycles);
}

// Get affected projects
const changed = new Set(['@myorg/auth']);
const affected = getAffectedProjects(changed, graph.rdeps);

// Plan build waves
const waves = planWaves(affected, graph.deps);
// Result: [['@myorg/auth'], ['@myorg/api'], ['@myorg/web']]

// Execute build plan
const result = await executePlan(waves, projects, '/path/to/workspace', {
  concurrency: 4,
  dryRun: false,
});
```

## Algorithm Details

### Dependency Graph

The library builds two maps:
- `deps[A] = Set<B>` - A depends on B
- `rdeps[B] = Set<A>` - B is a dependency of A (reverse graph)

Dependencies are collected from:
- `dependencies`
- `devDependencies`
- `peerDependencies`
- `optionalDependencies`

### Cycle Detection

Uses DFS with three-color marking:
- WHITE (0): Unvisited
- GRAY (1): Currently visiting (in stack)
- BLACK (2): Fully visited

A back edge to a GRAY node indicates a cycle.

### Wave Planning (Kahn's Algorithm)

1. Build induced subgraph from affected projects
2. Calculate in-degree for each node (count of unbuilt dependencies)
3. Repeat until all nodes processed:
   - Wave N = all nodes with in-degree 0
   - Remove wave nodes and decrement dependents' in-degrees

Projects in the same wave have no dependencies on each other and can be built in parallel.

### Affected Detection

Uses BFS on the reverse dependency graph:
1. Start with changed projects
2. Add all transitive dependents via `rdeps`
3. Result includes original changes + all projects that depend on them

## Ignored Paths

The watcher ignores these patterns by default:
- `**/node_modules/**`
- `**/dist/**`
- `**/.angular/**`
- `**/.nx/**`
- `**/coverage/**`
- `**/*.log`
- `**/.git/**`
- `**/tmp/**`
- `**/.cache/**`

## Root Config Changes

Changes to root configuration files trigger a rebuild of all projects:
- `package.json`
- `package-lock.json`
- `pnpm-lock.yaml`
- `yarn.lock`
- `tsconfig.json`
- `tsconfig.base.json`

## License

MIT
