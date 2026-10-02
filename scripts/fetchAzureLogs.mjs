import { execSync } from "node:child_process";
import fs from "node:fs";

const tail = process.argv[2] || "150";
const targetFile = process.argv[3] || "temp_azure_logs_test4.json";

try {
  const output = execSync(`az containerapp logs show -n sentiqgpt-backend -g rg-sentiqgpt-prod --tail ${tail} --format json --follow false`, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  fs.writeFileSync(targetFile, output, "utf8");
  console.log(`Successfully wrote ${output.length} bytes to ${targetFile}`);
  
  // Also write a formatted text file
  const parsed = JSON.parse(output);
  if (Array.isArray(parsed)) {
    const textLines = parsed.map(item => typeof item === "string" ? item : (item.message || JSON.stringify(item)));
    fs.writeFileSync(targetFile.replace(".json", ".txt"), textLines.join("\n"), "utf8");
    console.log(`Parsed ${textLines.length} log lines into text file.`);
  }
} catch (err) {
  console.error("Error fetching logs:", err.message);
  if (err.stdout) fs.writeFileSync(targetFile, err.stdout, "utf8");
}
