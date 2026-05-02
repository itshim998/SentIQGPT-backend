import { createServer } from "http";
import { resolveImageInputBuffer } from "./tools/imageGeneration/imageStorageService";

function assert(condition: boolean, label: string, detail?: string): void {
  if (!condition) {
    throw new Error(detail ? `${label} (${detail})` : label);
  }
  console.log(`PASS ${label}`);
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlH0f8AAAAASUVORK5CYII=";

async function testBase64Input(): Promise<void> {
  const buffer = await resolveImageInputBuffer(TINY_PNG_BASE64);
  assert(buffer.length > 0, "base64 input resolves to non-empty buffer", `size=${buffer.length}`);
}

async function testRemoteImageUrl(): Promise<void> {
  const imageBuffer = Buffer.from(TINY_PNG_BASE64, "base64");
  const server = createServer((req, res) => {
    if (req.url === "/image") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(imageBuffer);
      return;
    }

    if (req.url === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not an image");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Expected ephemeral server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const remoteBuffer = await resolveImageInputBuffer(`${baseUrl}/image`);
    assert(remoteBuffer.equals(imageBuffer), "remote image URL resolves to exact image bytes");

    let invalidError = "";
    try {
      await resolveImageInputBuffer(`${baseUrl}/text`);
    } catch (error) {
      invalidError = error instanceof Error ? error.message : String(error);
    }
    assert(
      invalidError.includes("did not return an image"),
      "non-image remote URL fails cleanly",
      invalidError || "missing validation error",
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function main(): Promise<void> {
  console.log("Running image storage service tests...");
  await testBase64Input();
  await testRemoteImageUrl();
  console.log("Image storage service tests passed.");
}

main().catch((error) => {
  console.error("Image storage service tests failed:", error);
  process.exit(1);
});
