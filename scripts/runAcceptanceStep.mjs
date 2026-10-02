import { SentIqTestHarness, getAzureLogs } from "./testHarness.mjs";

const FILES = {
  resume: "C:\\Users\\Sounak\\Downloads\\Sounak_Poddar_Resume.pdf.pdf",
  xor: "C:\\Users\\Sounak\\Downloads\\XOR_using_MLFFN.pdf",
  imgFieldLine: "C:\\Users\\Sounak\\Downloads\\image_document_FieldLine.jpeg",
  imgStudentOs: "C:\\Users\\Sounak\\Downloads\\StudentOS_logo.png",
  imgChatGpt: "C:\\Users\\Sounak\\Downloads\\ChatGPT Image Jul 14, 2026, 11_04_59 AM.png",
};

const testArg = process.argv.find((a) => a.startsWith("--test="))?.split("=")[1] || process.argv[2] || "1";

async function runTest1(harness) {
  console.log("\n================================================================================");
  console.log("RUNNING TEST 1: Selectable PDF Baseline");
  console.log("File:", FILES.resume);
  console.log("Question: What is my GPA?");
  console.log("================================================================================");

  await harness.startFreshChat();
  const chips = await harness.uploadFiles([FILES.resume]);

  const beforeLogs = getAzureLogs(30);
  console.log("\n[Azure Logs Before Turn]:\n", beforeLogs.slice(-400));

  await harness.askQuestion("What is my GPA?");
  const result = await harness.waitForStreamingCompletion(60);

  console.log("\n================================================================================");
  console.log("TEST 1 EXECUTION RESULT:");
  console.log("Streaming completed normally:", result.completed);
  console.log("Total assistant messages:", result.assistantCount);
  console.log("Final DOM Messages:");
  result.finalDomMessages.forEach((m) => {
    console.log(`  [${m.role.toUpperCase()}] Header: "${m.header}" | HasError: ${m.hasError}\n    Text: ${m.text.slice(0, 300)}...`);
  });

  const afterLogs = getAzureLogs(80);
  console.log("\n--- CORRELATED AZURE BACKEND LOGS ---");
  const filteredAzure = afterLogs
    .split("\n")
    .filter((l) => l.includes("sentiq") || l.includes("image_input") || l.includes("source_retrieval") || l.includes("generation") || l.includes("POST /api/chat"))
    .slice(-30);
  console.log(filteredAzure.join("\n") || afterLogs.slice(-1500));

  const imageInputCalled = harness.sseEvents.some((e) => e.data.includes("image_input")) || afterLogs.includes("image_input");
  const hasGpa = /8\.04/i.test(result.lastAssistantText) || result.finalDomMessages.some((m) => /8\.04/i.test(m.text));
  const hasErrorBubble = result.finalDomMessages.some((m) => m.hasError);

  console.log("\n--- TEST 1 DIAGNOSTIC SUMMARY ---");
  console.log(`1. Correct GPA (8.04) retrieved: ${hasGpa}`);
  console.log(`2. Visual tool 'image_input' invoked: ${imageInputCalled} (Expected: false)`);
  console.log(`3. Post-stream Error Bubble present: ${hasErrorBubble}`);
  if (hasErrorBubble) {
    console.log(`   Observed error details: System Notice appended to DOM.`);
    console.log(`   Browser console exceptions:`, harness.runtimeExceptions);
  }
}

async function runTest2(harness) {
  console.log("\n================================================================================");
  console.log("RUNNING TEST 2: Scanned PDF / Original Failure Case");
  console.log("File:", FILES.xor);
  console.log("Question: Explain the XOR problem from this PDF.");
  console.log("================================================================================");

  await harness.startFreshChat();
  const chips = await harness.uploadFiles([FILES.xor]);

  const beforeLogs = getAzureLogs(30);
  console.log("\n[Azure Logs Before Turn]:\n", beforeLogs.slice(-400));

  await harness.askQuestion("Explain the XOR problem from this PDF.");
  const result = await harness.waitForStreamingCompletion(90);

  console.log("\n================================================================================");
  console.log("TEST 2 EXECUTION RESULT:");
  console.log("Streaming completed normally:", result.completed);
  console.log("Total assistant messages:", result.assistantCount);
  console.log("Final DOM Messages:");
  result.finalDomMessages.forEach((m) => {
    console.log(`  [${m.role.toUpperCase()}] Header: "${m.header}" | HasError: ${m.hasError}\n    Text: ${m.text.slice(0, 400)}...`);
  });

  const afterLogs = getAzureLogs(100);
  console.log("\n--- CORRELATED AZURE BACKEND LOGS ---");
  const filteredAzure = afterLogs
    .split("\n")
    .filter((l) => l.includes("sentiq") || l.includes("image_input") || l.includes("visual") || l.includes("pdf") || l.includes("gemini") || l.includes("generation"))
    .slice(-40);
  console.log(filteredAzure.join("\n") || afterLogs.slice(-2000));

  const imageInputCalled = harness.sseEvents.some((e) => e.data.includes("image_input")) || afterLogs.includes("image_input");
  const explainsXor = /linear|separable|non-linear|hidden|truth table|perceptron|MLFFN/i.test(result.lastAssistantText) || result.finalDomMessages.some((m) => /linear|separable|non-linear|hidden|truth table|perceptron|MLFFN/i.test(m.text));
  const hasErrorBubble = result.finalDomMessages.some((m) => m.hasError);

  console.log("\n--- TEST 2 DIAGNOSTIC SUMMARY ---");
  console.log(`1. Visual tool 'image_input' invoked: ${imageInputCalled} (Expected: true)`);
  console.log(`2. Answer grounded in XOR PDF: ${explainsXor}`);
  console.log(`3. Post-stream Error Bubble present: ${hasErrorBubble}`);
}

async function runTest3(harness) {
  console.log("\n================================================================================");
  console.log("RUNNING TEST 3: Multiple Image Understanding");
  console.log("Files:", [FILES.imgFieldLine, FILES.imgStudentOs, FILES.imgChatGpt]);
  console.log("Question: What do the attached images represent?");
  console.log("================================================================================");

  await harness.startFreshChat();
  const chips = await harness.uploadFiles([FILES.imgFieldLine, FILES.imgStudentOs, FILES.imgChatGpt]);

  const beforeLogs = getAzureLogs(30);
  console.log("\n[Azure Logs Before Turn]:\n", beforeLogs.slice(-400));

  await harness.askQuestion("What do the attached images represent?");
  const result = await harness.waitForStreamingCompletion(90);

  console.log("\n================================================================================");
  console.log("TEST 3 EXECUTION RESULT:");
  console.log("Streaming completed normally:", result.completed);
  console.log("Total assistant messages:", result.assistantCount);
  console.log("Final DOM Messages:");
  result.finalDomMessages.forEach((m) => {
    console.log(`  [${m.role.toUpperCase()}] Header: "${m.header}" | HasError: ${m.hasError}\n    Text: ${m.text.slice(0, 400)}...`);
  });

  const afterLogs = getAzureLogs(100);
  console.log("\n--- CORRELATED AZURE BACKEND LOGS ---");
  const filteredAzure = afterLogs
    .split("\n")
    .filter((l) => l.includes("sentiq") || l.includes("image_input") || l.includes("visual") || l.includes("gemini") || l.includes("generation"))
    .slice(-40);
  console.log(filteredAzure.join("\n") || afterLogs.slice(-2000));

  const imageInputCalled = harness.sseEvents.some((e) => e.data.includes("image_input")) || afterLogs.includes("image_input");
  const recognizedImages = result.lastAssistantText || "";

  console.log("\n--- TEST 3 DIAGNOSTIC SUMMARY ---");
  console.log(`1. Visual tool 'image_input' invoked: ${imageInputCalled} (Expected: true)`);
  console.log(`2. Answer snippet:\n${recognizedImages.slice(0, 500)}`);
}

async function runTest4(harness) {
  console.log("\n================================================================================");
  console.log("RUNNING TEST 4: Multi-Image Follow-Up (In same chat as Test 3)");
  console.log("================================================================================");

  // Turn 1: Second image
  console.log("\n--- TEST 4 TURN 1: 'What is shown in the second image?' ---");
  await harness.askQuestion("What is shown in the second image?");
  let res1 = await harness.waitForStreamingCompletion(60);
  console.log("Turn 1 Answer:\n", res1.lastAssistantText.slice(0, 400));
  let logs1 = getAzureLogs(40);
  console.log("Turn 1 Azure Logs Filtered:\n", logs1.split("\n").filter(l => l.includes("image_input") || l.includes("generation") || l.includes("visual")).slice(-15).join("\n"));

  // Turn 2: Third image
  console.log("\n--- TEST 4 TURN 2: 'What does the third image show?' ---");
  await harness.askQuestion("What does the third image show?");
  let res2 = await harness.waitForStreamingCompletion(60);
  console.log("Turn 2 Answer:\n", res2.lastAssistantText.slice(0, 400));
  let logs2 = getAzureLogs(40);
  console.log("Turn 2 Azure Logs Filtered:\n", logs2.split("\n").filter(l => l.includes("image_input") || l.includes("generation") || l.includes("visual")).slice(-15).join("\n"));

  // Turn 3: Compare first and third
  console.log("\n--- TEST 4 TURN 3: 'Compare the first and third images.' ---");
  await harness.askQuestion("Compare the first and third images.");
  let res3 = await harness.waitForStreamingCompletion(60);
  console.log("Turn 3 Answer:\n", res3.lastAssistantText.slice(0, 400));
  let logs3 = getAzureLogs(40);
  console.log("Turn 3 Azure Logs Filtered:\n", logs3.split("\n").filter(l => l.includes("image_input") || l.includes("generation") || l.includes("visual")).slice(-15).join("\n"));
}

async function runTest5(harness) {
  console.log("\n================================================================================");
  console.log("RUNNING TEST 5: Cross-Context Contamination");
  console.log("Uploading Resume, XOR PDF, and Image");
  console.log("================================================================================");

  await harness.startFreshChat();
  await harness.uploadFiles([FILES.resume, FILES.xor, FILES.imgStudentOs]);

  console.log("\n--- TEST 5 TURN 1: 'Explain the XOR problem from XOR_using_MLFFN.pdf. Ignore the other files.' ---");
  await harness.askQuestion("Explain the XOR problem from XOR_using_MLFFN.pdf. Ignore the other files.");
  let res1 = await harness.waitForStreamingCompletion(90);
  console.log("Turn 1 Answer:\n", res1.lastAssistantText.slice(0, 400));

  console.log("\n--- TEST 5 TURN 2: 'What is my GPA from the Resume?' ---");
  await harness.askQuestion("What is my GPA from the Resume?");
  let res2 = await harness.waitForStreamingCompletion(60);
  console.log("Turn 2 Answer:\n", res2.lastAssistantText.slice(0, 400));

  const logs = getAzureLogs(60);
  console.log("\n--- CORRELATED AZURE BACKEND LOGS ---");
  console.log(logs.split("\n").filter(l => l.includes("sentiq") || l.includes("image_input") || l.includes("source_retrieval") || l.includes("generation")).slice(-30).join("\n"));
}

async function main() {
  const harness = new SentIqTestHarness();
  await harness.init();

  try {
    if (testArg === "1") await runTest1(harness);
    else if (testArg === "2") await runTest2(harness);
    else if (testArg === "3") await runTest3(harness);
    else if (testArg === "4") await runTest4(harness);
    else if (testArg === "5") await runTest5(harness);
    else if (testArg === "all") {
      await runTest1(harness);
      await runTest2(harness);
      await runTest3(harness);
      await runTest4(harness);
      await runTest5(harness);
    }
  } finally {
    harness.close();
  }
}

main().catch(console.error);
