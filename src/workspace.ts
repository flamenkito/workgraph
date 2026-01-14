import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { PackageJson, Project } from './types';

export async function loadWorkspaceProjects(root: string): Promise<Map<string, Project>> {
  const rootPkgPath = path.join(root, 'package.json');

  if (!fs.existsSync(rootPkgPath)) {
    throw new Error(`No package.json found at ${root}`);
  }

  const rootPkg: PackageJson = JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8'));
  const workspacePatterns = rootPkg.workspaces || [];

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

      const pkgJson: PackageJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

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

export function isRootConfig(filePath: string, root: string): boolean {
  const absoluteFilePath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);

  const relativePath = path.relative(root, absoluteFilePath);

  const rootConfigs = [
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'tsconfig.json',
    'tsconfig.base.json',
  ];

  return rootConfigs.includes(relativePath) || !relativePath.includes(path.sep);
}
