import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { PackageJson, PackageManager, Project } from './types';

interface RawPackageJson {
  name: string;
  version: string;
  workspaces: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  scripts: Record<string, string>;
}

// Default values for optional package.json fields (external npm API)
const EMPTY_STRING = '';
const EMPTY_ARRAY: string[] = [];
const EMPTY_RECORD: Record<string, string> = {};

function normalizePackageJson(raw: Partial<RawPackageJson>): PackageJson {
  return {
    name: raw.name !== undefined ? raw.name : EMPTY_STRING,
    version: raw.version !== undefined ? raw.version : EMPTY_STRING,
    workspaces: raw.workspaces !== undefined ? raw.workspaces : EMPTY_ARRAY,
    dependencies: raw.dependencies !== undefined ? raw.dependencies : EMPTY_RECORD,
    devDependencies: raw.devDependencies !== undefined ? raw.devDependencies : EMPTY_RECORD,
    peerDependencies: raw.peerDependencies !== undefined ? raw.peerDependencies : EMPTY_RECORD,
    optionalDependencies: raw.optionalDependencies !== undefined ? raw.optionalDependencies : EMPTY_RECORD,
    scripts: raw.scripts !== undefined ? raw.scripts : EMPTY_RECORD,
  };
}

export function detectPackageManager(root: string): PackageManager {
  // Check packageManager field in package.json first (highest priority)
  const pkgJsonPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    if (typeof pkgJson['packageManager'] === 'string') {
      const pm = pkgJson['packageManager'].split('@')[0];
      if (pm === 'bun' || pm === 'pnpm' || pm === 'yarn' || pm === 'npm') {
        return pm;
      }
    }
  }

  // Fall back to lockfile detection
  if (fs.existsSync(path.join(root, 'bun.lockb')) || fs.existsSync(path.join(root, 'bun.lock'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

export async function loadWorkspaceProjects(root: string): Promise<Map<string, Project>> {
  const rootPkgPath = path.join(root, 'package.json');

  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`No package.json found at ${root}`);
  }

  const rootPkg = normalizePackageJson(JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8')) as Partial<RawPackageJson>);
  const workspacePatterns = rootPkg.workspaces;

  if (workspacePatterns.length === 0) {
    throw new Error('No workspaces defined in package.json');
  }

  const projects = new Map<string, Project>();
  const seenNames = new Map<string, string>();

  for (const pattern of workspacePatterns) {
    const matches = await glob(pattern, {
      cwd: root,
      absolute: false,
    });

    for (const match of matches) {
      const projectPath = match;
      const absolutePath = path.resolve(root, match);
      const pkgJsonPath = path.join(absolutePath, 'package.json');

      if (!fs.existsSync(pkgJsonPath)) {
        continue;
      }

      const pkgJson = normalizePackageJson(JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as Partial<RawPackageJson>);

      if (!pkgJson.name) {
        continue;
      }

      if (seenNames.has(pkgJson.name)) {
        throw new Error(
          `Duplicate project name "${pkgJson.name}" found at:\n` +
          `  - ${seenNames.get(pkgJson.name)}\n` +
          `  - ${projectPath}`
        );
      }

      seenNames.set(pkgJson.name, projectPath);

      projects.set(pkgJson.name, {
        name: pkgJson.name,
        path: projectPath,
        absolutePath,
        packageJson: pkgJson,
      });
    }
  }

  return projects;
}

export function getProjectFromPath(
  filePath: string,
  projects: Map<string, Project>,
  root: string
): string | null {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);

  let longestMatch: string | null = null;
  let longestLength = 0;

  for (const [name, project] of projects) {
    if (absoluteFilePath.startsWith(project.absolutePath + path.sep)) {
      if (project.absolutePath.length > longestLength) {
        longestLength = project.absolutePath.length;
        longestMatch = name;
      }
    }
  }

  return longestMatch;
}
