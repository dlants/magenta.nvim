#!/usr/bin/env node

import { execSync, exec } from "child_process";
import { exit } from "process";

function getFileList(command) {
  try {
    const output = execSync(command, { encoding: "utf8" }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch (error) {
    console.error(`Command failed: ${command}`);
    console.error(error.message);
    exit(1);
  }
}

async function main() {
  console.log("Running pre-commit checks...");

  // Get staged and unstaged modified files
  const stagedFiles = getFileList(
    "git diff --cached --name-only --diff-filter=M",
  );
  const unstagedFiles = getFileList("git diff --name-only --diff-filter=M");

  // Find files that have both staged and unstaged changes
  const partiallyStaged = stagedFiles.filter((file) =>
    unstagedFiles.includes(file),
  );

  if (partiallyStaged.length > 0) {
    console.log("Found partially staged files:", partiallyStaged.join(", "));
  }

  // Run checks in parallel
  console.log("Running checks in parallel...");
  const checks = [
    { name: "typecheck", command: "npx tsc -b" },
    { name: "biome", command: "npx biome check --write ." },
  ];

  function runCheck(check) {
    return new Promise((resolve, reject) => {
      console.log(`Starting ${check.name}...`);

      let stdout = "";
      let stderr = "";

      exec(check.command, (error, stdoutData, stderrData) => {
        stdout = stdoutData;
        stderr = stderrData;

        if (error) {
          console.error(`✗ ${check.name} failed`);
          console.error(`Command: ${check.command}`);
          if (stdout) {
            console.error(`Output:\n${stdout}`);
          }
          if (stderr) {
            console.error(`Error output:\n${stderr}`);
          }
          reject(error);
        } else {
          console.log(`✓ ${check.name} completed`);
          resolve({ stdout, stderr });
        }
      });
    });
  }

  const results = await Promise.allSettled(
    checks.map((check) => runCheck(check)),
  );

  // Check if any checks failed
  const failed = results.filter((result) => result.status === "rejected");
  if (failed.length > 0) {
    console.error(`${failed.length} checks failed: ${JSON.stringify(failed)}`);
    exit(1);
  }

  const filesToAdd = stagedFiles.filter(
    (file) => !partiallyStaged.includes(file),
  );

  if (filesToAdd.length > 0) {
    console.log(`Re-adding ${filesToAdd.length} files after formatting...`);
    try {
      execSync(`git add ${filesToAdd.map((f) => `"${f}"`).join(" ")}`, {
        encoding: "utf8",
      });
    } catch (error) {
      console.error("Failed to re-add files:", error.message);
      exit(1);
    }
  }

  if (partiallyStaged.length > 0) {
    console.log(
      `Skipped re-adding ${partiallyStaged.length} partially staged files`,
    );
  }

  console.log("Pre-commit checks completed successfully!");
}

main().catch((error) => {
  console.error("Pre-commit failed:", error);
  exit(1);
});
