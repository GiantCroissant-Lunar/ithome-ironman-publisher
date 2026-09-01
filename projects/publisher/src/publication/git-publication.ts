import { spawn } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { AppError, ExitCode } from '../infra/errors.js';

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitSyncResult {
  receiptPath: string;
  committed: boolean;
  pushed: boolean;
}

export async function assertGitReadyForPublication(repositoryRoot: string): Promise<void> {
  const root = resolve(repositoryRoot);
  const detectedRoot = (await runGitRequired(root, ['rev-parse', '--show-toplevel'], ExitCode.SafetyConflict)).stdout.trim();
  if (resolve(detectedRoot) !== root) {
    throw new AppError('Configured repository root does not match Git', ExitCode.SafetyConflict, {
      configuredRoot: root,
      detectedRoot,
    });
  }
  const branch = (await runGitRequired(root, ['branch', '--show-current'], ExitCode.SafetyConflict)).stdout.trim();
  if (!branch) {
    throw new AppError('Publication requires a named Git branch', ExitCode.SafetyConflict, { repositoryRoot: root });
  }
  const upstream = (
    await runGitRequired(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], ExitCode.SafetyConflict)
  ).stdout.trim();
  const status = (await runGitRequired(root, ['status', '--porcelain=v1', '--untracked-files=all'], ExitCode.SafetyConflict)).stdout;
  if (status.trim()) {
    throw new AppError('Publication requires a clean Git working tree before any site mutation', ExitCode.SafetyConflict, {
      repositoryRoot: root,
      changedPaths: parseStatusPaths(status),
    });
  }
  await runGitRequired(root, ['fetch', '--quiet'], ExitCode.SafetyConflict);
  const counts = (
    await runGitRequired(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], ExitCode.SafetyConflict)
  ).stdout
    .trim()
    .split(/\s+/u)
    .map(Number);
  const [ahead, behind] = counts;
  if (ahead !== 0 || behind !== 0) {
    throw new AppError('Publication requires the local branch and upstream to be fully synchronized', ExitCode.SafetyConflict, {
      branch,
      upstream,
      ahead,
      behind,
    });
  }
  await runGitRequired(root, ['push', '--dry-run'], ExitCode.SafetyConflict);
}

export async function syncPublicationReceiptToGit(
  repositoryRoot: string,
  receiptPath: string,
  dayNumber: number,
  articleId: string,
): Promise<GitSyncResult> {
  const root = resolve(repositoryRoot);
  const receipt = resolve(receiptPath);
  const relativePath = relative(root, receipt).replaceAll('\\', '/');
  if (!relativePath || relativePath.startsWith('../') || isAbsolute(relativePath)) {
    throw new AppError('Publication receipt must stay inside the Git repository', ExitCode.GitSynchronizationFailed, {
      repositoryRoot: root,
      receiptPath: receipt,
    });
  }

  const status = (await runGitRequired(root, ['status', '--porcelain=v1', '--untracked-files=all'], ExitCode.GitSynchronizationFailed)).stdout;
  const unrelated = parseStatusPaths(status).filter((path) => path !== relativePath);
  if (unrelated.length > 0) {
    throw new AppError('Refusing to commit a publication receipt while unrelated Git changes exist', ExitCode.GitSynchronizationFailed, {
      receiptPath: relativePath,
      unrelatedPaths: unrelated,
      articleMayAlreadyBePublic: true,
    });
  }

  await runGitRequired(root, ['add', '--', relativePath], ExitCode.GitSynchronizationFailed);
  const staged = (await runGitRequired(root, ['diff', '--cached', '--name-only'], ExitCode.GitSynchronizationFailed)).stdout
    .split(/\r?\n/u)
    .filter(Boolean);
  const unexpectedStaged = staged.filter((path) => path !== relativePath);
  if (unexpectedStaged.length > 0) {
    throw new AppError('Refusing to commit unrelated staged files with the publication receipt', ExitCode.GitSynchronizationFailed, {
      receiptPath: relativePath,
      unexpectedStaged,
      articleMayAlreadyBePublic: true,
    });
  }

  let committed = false;
  if (staged.includes(relativePath)) {
    await runGitRequired(
      root,
      [
        'commit',
        '--no-gpg-sign',
        '-m',
        `chore(article): record Day ${String(dayNumber).padStart(3, '0')} publication ${articleId}`,
      ],
      ExitCode.GitSynchronizationFailed,
    );
    committed = true;
  }
  await runGitRequired(root, ['push'], ExitCode.GitSynchronizationFailed);
  return { receiptPath: relativePath, committed, pushed: true };
}

async function runGitRequired(cwd: string, arguments_: string[], exitCode: ExitCode): Promise<CommandResult> {
  const result = await runCommand('git', arguments_, cwd);
  if (result.exitCode !== 0) {
    throw new AppError('Git command failed during publication receipt handling', exitCode, {
      command: ['git', ...arguments_],
      commandExitCode: result.exitCode,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      articleMayAlreadyBePublic: exitCode === ExitCode.GitSynchronizationFailed,
    });
  }
  return result;
}

function runCommand(command: string, arguments_: string[], cwd: string): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, arguments_, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectCommand);
    child.once('close', (code) => {
      resolveCommand({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function parseStatusPaths(status: string): string[] {
  return status
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').at(-1) ?? '')
    .map((path) => path.replaceAll('\\', '/'))
    .filter(Boolean);
}

function truncate(value: string): string {
  return value.length <= 2_000 ? value : `${value.slice(0, 2_000)}…`;
}
