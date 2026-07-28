import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import {
  evaluateNemotronDeploymentReadiness,
  type NemotronRolloutStage,
} from "./nemotronDeploymentReadiness";
import { verifyUnifiedTextProductionReadiness } from "./unifiedTextProductionReadiness";

function loadEnvironment(): void {
  const candidates = [
    pathResolve(__dirname, "..", ".env"),
    pathResolve(__dirname, "..", "..", ".env"),
    pathResolve(process.cwd(), ".env"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) dotenv.config({ path });
  else dotenv.config();
}

function readExpectedStage(argv: readonly string[]): NemotronRolloutStage | undefined {
  const argument = argv.find((value) => value.startsWith("--expect-stage="));
  if (!argument) return undefined;
  const value = argument.slice("--expect-stage=".length).trim().toLowerCase();
  if (value === "off" || value === "canary" || value === "full") return value;
  throw new Error("--expect-stage must be off, canary, or full.");
}

async function main(): Promise<void> {
  loadEnvironment();
  const argv = process.argv.slice(2);
  const report = evaluateNemotronDeploymentReadiness(process.env, {
    requireEnabled: argv.includes("--require-enabled"),
    requireCompleteBundle: argv.includes("--require-complete-bundle"),
    expectedStage: readExpectedStage(argv),
  });

  console.log(JSON.stringify({
    event: "nemotron_deployment_readiness",
    ...report,
  }));

  if (!report.ready) {
    process.exitCode = 1;
    return;
  }

  if (report.flags.unifiedTextTokensV2) {
    const databaseReport = await verifyUnifiedTextProductionReadiness();
    console.log(JSON.stringify({
      event: "unified_text_production_readiness",
      ...databaseReport,
    }));
    if (!databaseReport.ready) process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({
    event: "nemotron_deployment_readiness",
    status: "blocked",
    issues: [{
      code: "preflight_execution_error",
      message: error instanceof Error ? error.name : "Deployment preflight could not run.",
    }],
  }));
  process.exitCode = 1;
});
