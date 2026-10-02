import { execSync } from "node:child_process";

try {
  const jsonStr = execSync(
    'az containerapp show -n sentiqgpt-backend -g rg-sentiqgpt-prod --query "properties.template.containers[0].env" -o json',
    { encoding: "utf8", timeout: 35000 }
  );
  const envList = JSON.parse(jsonStr);
  const relevant = envList.filter((e) =>
    /TOOL|VISUAL|NEMO|GROQ|GEMINI|LAYER1|REGISTRY/i.test(e.name)
  );
  console.log("RELEVANT ENVIRONMENT VARIABLES ON PRODUCTION BACKEND:");
  relevant.forEach((e) => {
    console.log(`  ${e.name} = ${e.value || (e.secretRef ? `[Secret: ${e.secretRef}]` : "")}`);
  });
} catch (err) {
  console.error("Failed to query Azure environment:", err.message);
}
