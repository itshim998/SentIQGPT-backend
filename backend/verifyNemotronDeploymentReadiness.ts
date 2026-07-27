import {
  evaluateNemotronDeploymentReadiness,
  type NemotronRolloutStage,
} from "./nemotronDeploymentReadiness";

function readExpectedStage(argv: readonly string[]): NemotronRolloutStage | undefined {
  const argument = argv.find((value) => value.startsWith("--expect-stage="));
  if (!argument) return undefined;
  const value = argument.slice("--expect-stage=".length).trim().toLowerCase();
  if (value === "off" || value === "canary" || value === "full") return value;
  throw new Error("--expect-stage must be off, canary, or full.");
}

function main(): void {
  const argv = process.argv.slice(2);
  const report = evaluateNemotronDeploymentReadiness(process.env, {
    requireEnabled: argv.includes("--require-enabled"),
    expectedStage: readExpectedStage(argv),
  });

  console.log(JSON.stringify({
    event: "nemotron_deployment_readiness",
    ...report,
  }));

  if (!report.ready) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    event: "nemotron_deployment_readiness",
    status: "blocked",
    issues: [{
      code: "preflight_argument_error",
      message: error instanceof Error ? error.message : "Deployment preflight could not run.",
    }],
  }));
  process.exitCode = 1;
}
