import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const behaviour = await readFile(new URL("../scripts/features/authentication-surface.js", import.meta.url), "utf8");
const domRefs = await readFile(new URL("../scripts/features/chat/dom-refs.js", import.meta.url), "utf8");
const imports = await readFile(new URL("../styles/modules/12-reduced-motion.css", import.meta.url), "utf8");
const foundation = await readFile(new URL("../styles/modules/49-authentication-surfaces.css", import.meta.url), "utf8");
const responsive = await readFile(new URL("../styles/modules/50-authentication-responsive.css", import.meta.url), "utf8");

for (const token of [
  'AUTHENTICATION_SURFACE_VERSION = "8.3"',
  "authentication-email-path",
  "Google account",
  "or continue with email",
  "passwordStrength",
  'getModifierState("CapsLock")',
  'setAttribute("aria-invalid", "true")',
  'setAttribute("aria-errormessage", "auth-status")',
  'setAttribute("role", isError ? "alert" : "status")',
  "visualViewport",
  "scrollIntoView",
  "MutationObserver",
]) assert.ok(behaviour.includes(token), `authentication behaviour missing ${token}`);

for (const forbidden of ["fetch(", "localStorage", "sessionStorage", "SentIQAPI", "signInWithPassword", "signUp("]) {
  assert.equal(behaviour.includes(forbidden), false, `authentication presentation must not own ${forbidden}`);
}

assert.ok(domRefs.startsWith('import "../authentication-surface.js";'));
assert.ok(imports.includes('@import url("./49-authentication-surfaces.css");'));
assert.ok(imports.includes('@import url("./50-authentication-responsive.css");'));

for (const token of [
  "auth-sensitive-surface-open",
  "blur(5px)",
  "authentication-google-route",
  "authentication-password-meter",
  'input[aria-invalid="true"]',
  "auth-status.is-error",
  "forced-colors: active",
]) assert.ok(foundation.includes(token), `authentication CSS missing ${token}`);

assert.equal(foundation.includes("radial-gradient"), false, "sensitive forms must not add atmospheric radial gradients");

for (const token of [
  "max-width: 640px",
  "--authentication-viewport-height",
  "font-size: 16px",
  "safe-area-inset-bottom",
  "max-height: 620px",
  "prefers-reduced-motion: reduce",
]) assert.ok(responsive.includes(token), `responsive authentication CSS missing ${token}`);

console.log("Pass 8.3 authentication surface phase gate passed.");
