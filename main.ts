/**
 * NixOS/nix-darwin switch automation tool
 * Manages the complete workflow: showing changes, rebuilding, and committing
 */

import { Input, Select } from "jsr:@cliffy/prompt@^1.0.0-rc.8";

/** Operating system information */
interface OsInfo {
  type: "darwin" | "linux";
  homePrefix: string;
}

/** Nix configuration directory information */
interface NixConfig {
  path: string;
}

/** System generation information */
interface GenerationInfo {
  generation: string;
}

/**
 * Gets OS-specific information
 * @returns OS information including type and home directory prefix
 */
function getOsInfo(): OsInfo {
  const osType = Deno.build.os;
  if (osType === "darwin") {
    return { type: "darwin", homePrefix: "/Users" };
  } else {
    return { type: "linux", homePrefix: "/home" };
  }
}

/**
 * Finds the Nix configuration directory at ~/git/nix
 * @returns Promise resolving to Nix configuration
 * @throws Error if directory doesn't exist
 */
async function getNixDir(): Promise<NixConfig> {
  const username = Deno.env.get("USER");
  if (!username) {
    throw new Error("USER environment variable not set");
  }

  const osInfo = getOsInfo();
  const homeDir = `${osInfo.homePrefix}/${username}`;
  const nixDir = `${homeDir}/git/nix`;

  try {
    await Deno.stat(nixDir);
    return { path: nixDir };
  } catch {
    throw new Error(`Nix directory not found at ${nixDir}`);
  }
}

/**
 * Executes a command and pipes its output to stdout/stderr
 * @param name - The command name
 * @param args - The command arguments
 * @returns Promise that resolves when command completes successfully
 * @throws Error if command fails
 */
async function runCommand(name: string, ...args: string[]): Promise<void> {
  const command = new Deno.Command(name, {
    args,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { code } = await command.output();

  if (code !== 0) {
    throw new Error(
      `Command failed with exit code ${code}: ${name} ${args.join(" ")}`,
    );
  }
}

/**
 * Executes a command and captures its output as a string
 * @param name - The command name
 * @param args - The command arguments
 * @returns Promise resolving to stdout as string
 * @throws Error if command fails
 */
async function runCommandCapture(
  name: string,
  ...args: string[]
): Promise<string> {
  const command = new Deno.Command(name, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout } = await command.output();

  if (code !== 0) {
    throw new Error(
      `Command failed with exit code ${code}: ${name} ${args.join(" ")}`,
    );
  }

  return new TextDecoder().decode(stdout);
}

/**
 * Executes a command and prefixes each output line with an ISO timestamp
 * @param name - The command name
 * @param args - The command arguments
 * @returns Promise that resolves when command completes successfully
 * @throws Error if command fails
 */
async function runCommandWithTimestamps(
  name: string,
  ...args: string[]
): Promise<void> {
  const command = new Deno.Command(name, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const child = command.spawn();

  // Helper to stream output line-by-line with timestamps
  async function streamWithTimestamps(
    reader: ReadableStream<Uint8Array>,
    output: typeof Deno.stdout,
  ) {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of reader) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const timestamp = new Date().toISOString();
        const message = `${timestamp} ${line}\n`;
        await output.write(new TextEncoder().encode(message));
      }
    }

    // Handle any remaining content in buffer
    if (buffer) {
      const timestamp = new Date().toISOString();
      const message = `${timestamp} ${buffer}\n`;
      await output.write(new TextEncoder().encode(message));
    }
  }

  // Stream both stdout and stderr concurrently
  await Promise.all([
    streamWithTimestamps(child.stdout, Deno.stdout),
    streamWithTimestamps(child.stderr, Deno.stderr),
  ]);

  const { code } = await child.status;

  if (code !== 0) {
    throw new Error(
      `Command failed with exit code ${code}: ${name} ${args.join(" ")}`,
    );
  }
}

/**
 * Gets the current system generation number
 * @returns Promise resolving to generation info
 */
async function getCurrentGeneration(): Promise<GenerationInfo> {
  const osInfo = getOsInfo();

  let command: Deno.Command;
  if (osInfo.type === "darwin") {
    // On macOS with nix-darwin, check the darwin system profile
    command = new Deno.Command("sudo", {
      args: [
        "/run/current-system/sw/bin/nix-env",
        "-p",
        "/nix/var/nix/profiles/system",
        "--list-generations",
      ],
      stdout: "piped",
      stderr: "piped",
    });
  } else {
    // On NixOS
    command = new Deno.Command("sudo", {
      args: [
        "nix-env",
        "-p",
        "/nix/var/nix/profiles/system",
        "--list-generations",
      ],
      stdout: "piped",
      stderr: "piped",
    });
  }

  try {
    const { code, stdout } = await command.output();

    if (code !== 0) {
      // Fallback: just use timestamp if generation detection fails
      console.log("Warning: Could not get generation info");
      return { generation: `System update ${getCurrentTimestamp()}` };
    }

    const output = new TextDecoder().decode(stdout);
    const lines = output.split("\n");

    for (const line of lines) {
      if (line.includes("current")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length > 0) {
          return { generation: `Generation ${fields[0]}` };
        }
      }
    }

    // If no current generation found, use timestamp
    return { generation: `System update ${getCurrentTimestamp()}` };
  } catch (error) {
    console.log(`Warning: Could not get generation info: ${error}`);
    return { generation: `System update ${getCurrentTimestamp()}` };
  }
}

/**
 * Gets current timestamp for commit messages
 * @returns Formatted timestamp string
 */
function getCurrentTimestamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Prompts user for yes/no confirmation
 * @param message - The prompt message
 * @returns Promise resolving to true if user confirms, false otherwise
 */
async function confirm(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  await Deno.stdout.write(encoder.encode(`${message} (y/n): `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);

  if (n === null) {
    return false;
  }

  const answer = new TextDecoder().decode(buf.subarray(0, n)).trim()
    .toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Prompts user for commit confirmation with option to provide custom message
 * Uses cliffy TUI menu with arrow key navigation
 * @param message - The default commit message
 * @returns Promise resolving to the commit message to use, or null to skip
 */
async function confirmCommit(message: string): Promise<string | null> {
  const choice = await Select.prompt({
    message: "Choose commit action:",
    options: [
      { name: `Commit with "${message}"`, value: "default" },
      { name: "Enter custom commit message", value: "custom" },
      { name: "Skip commit", value: "skip" },
    ],
    default: "default",
  });

  if (choice === "default") {
    return message;
  } else if (choice === "custom") {
    const customMessage = await Input.prompt({
      message: "Enter custom commit message:",
    });
    return customMessage.trim().length > 0 ? customMessage : null;
  } else {
    return null;
  }
}

/**
 * Main switch workflow
 */
async function main(): Promise<void> {
  // Get the nix directory
  const nixConfig = await getNixDir();
  console.log(`Using nix directory: ${nixConfig.path}`);

  // Change to the nix directory
  Deno.chdir(nixConfig.path);

  // Step 1: Show git diff (all files, staged and unstaged, except lock files)
  console.log("\x1b[31m=== Git Diff ===\x1b[0m");
  let hasChanges = false;
  try {
    const diffOutput = await runCommandCapture(
      "git",
      "--no-pager",
      "diff",
      "--color=always",
      "HEAD",
      "-U0",
      "--",
      ".",
      ":!*.lock",
    );
    if (diffOutput.trim().length > 0) {
      console.log(diffOutput);
      hasChanges = true;
    }
  } catch (error) {
    console.log(`Warning: git diff failed: ${error}`);
  }

  // Step 2: Show full git status
  console.log("\x1b[31m=== Git Status ===\x1b[0m");
  try {
    const statusShortOutput = await runCommandCapture(
      "git",
      "status",
      "--short",
    );
    if (statusShortOutput.trim().length > 0) {
      hasChanges = true;
    }
    await runCommand("git", "status");
  } catch (error) {
    console.log(`Warning: git status failed: ${error}`);
  }

  // Step 3: Ask if user wants to stage files (only if there are changes)
  if (hasChanges) {
    const shouldStage = await confirm("\nStage all files?");

    if (!shouldStage) {
      console.log("Staging cancelled. Exiting.");
      Deno.exit(0);
    }

    try {
      await runCommand("git", "add", "-A");
      console.log("Staged all files (including untracked).");
    } catch (error) {
      console.error(`Failed to stage files: ${error}`);
      Deno.exit(1);
    }
  }

  // Step 4: Run nixos-rebuild (or darwin-rebuild on macOS)
  console.log("\x1b[31m=== Rebuilding System ===\x1b[0m");
  const osInfo = getOsInfo();
  const username = Deno.env.get("USER");
  if (!username) {
    console.error("USER environment variable not set");
    Deno.exit(1);
  }
  const flakePath = `${nixConfig.path}#${username}`;

  try {
    if (osInfo.type === "darwin") {
      await runCommandWithTimestamps(
        "sudo",
        "darwin-rebuild",
        "switch",
        "--flake",
        flakePath,
        "-L",
      );
    } else {
      await runCommandWithTimestamps(
        "sudo",
        "nixos-rebuild",
        "switch",
        "--flake",
        flakePath,
        "-L",
      );
    }
  } catch {
    console.log("Build failed, not committing or pushing changes.");
    Deno.exit(1);
  }

  // Step 5: Get the current generation
  const genInfo = await getCurrentGeneration();

  // Step 6: Show status and confirm commit
  console.log("\n=== Git Status ===");
  try {
    await runCommand("git", "status", "--short");
  } catch (error) {
    console.log(`Warning: git status failed: ${error}`);
  }

  console.log(`\nCommit message: "${genInfo.generation}"`);
  const commitMessage = await confirmCommit(genInfo.generation);

  if (!commitMessage) {
    console.log("Skipping commit and push.");
    Deno.exit(0);
  }

  // Step 7: Commit changes
  try {
    await runCommand("git", "commit", "-am", commitMessage);
  } catch (error) {
    console.error(`Failed to commit changes: ${error}`);
    Deno.exit(1);
  }

  // Step 8: Confirm push
  console.log("\n=== Ready to Push ===");
  try {
    const logOutput = await runCommandCapture("git", "log", "-1", "--oneline");
    console.log(`Last commit: ${logOutput.trim()}`);
  } catch (error) {
    console.log(`Warning: could not show last commit: ${error}`);
  }

  const shouldPush = await confirm("\nPush changes to remote?");

  if (!shouldPush) {
    console.log("Skipping push. Changes are committed locally.");
    Deno.exit(0);
  }

  // Step 9: Push changes
  try {
    await runCommand("git", "push");
  } catch (error) {
    console.error(`Failed to push changes: ${error}`);
    Deno.exit(1);
  }

  console.log("\nSwitch completed successfully!");
}

// Run main function if this is the main module
if (import.meta.main) {
  main();
}
