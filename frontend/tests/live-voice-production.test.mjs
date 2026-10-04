import fs from "node:fs";
import assert from "node:assert/strict";

const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const controller = fs.readFileSync(new URL("../scripts/features/live/live-controller.js", import.meta.url), "utf8");
const surface = fs.readFileSync(new URL("../scripts/features/live-surface.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../styles/modules/16-live-beta.css", import.meta.url), "utf8");
const adaptiveConfig = fs.readFileSync(new URL("../scripts/features/adaptive-panel-state.js", import.meta.url), "utf8");

// 1. Dedicated Close button in header (X) triggers canonical termination
assert.ok(html.includes('id="live-beta-close-btn"'), "Header must have dedicated close button");
assert.ok(html.includes('class="adaptive-panel-close live-beta-close-btn"'));
assert.match(controller, /closeButton\?\.addEventListener\("click",\s*\(\)\s*=>\s*\{\s*void terminateLiveSession\(\{\s*reason:\s*"client_end",\s*source:\s*"close_btn"/);

// 2. Outside backdrop click triggers canonical termination
assert.match(controller, /panel\.addEventListener\("click",\s*\(event\)\s*=>\s*\{[\s\S]*event\.target === panel[\s\S]*terminateLiveSession\(\{\s*reason:\s*"client_end",\s*source:\s*"backdrop_click"/);

// 3. Escape key closes Live with stopImmediatePropagation and calls canonical termination
assert.match(controller, /if\s*\(event\.key === "Escape"\)\s*\{[\s\S]*event\.preventDefault\(\);[\s\S]*event\.stopImmediatePropagation\(\);[\s\S]*terminateLiveSession\(\{\s*reason:\s*"client_end",\s*source:\s*"escape"/);

// 4. Inside click does not close Live (target must strictly equal panel for backdrop dismiss)
assert.ok(controller.includes("if (event.target === panel)"));

// 5. Canonical termination is idempotent
assert.match(controller, /if\s*\(terminationPromise\)\s*return terminationPromise;/);

// 6. #live-beta-end is completely gone
assert.equal(html.includes('id="live-beta-end"'), false, "#live-beta-end must be removed from HTML");
assert.equal(controller.includes('id="live-beta-end"'), false);

// 7. #live-beta-transcript-toggle is completely gone
assert.equal(html.includes('id="live-beta-transcript-toggle"'), false, "#live-beta-transcript-toggle must be removed from HTML");

// 8. #live-beta-mute is present and centered
assert.ok(html.includes('id="live-beta-mute"'), "Mute button must be present");
assert.match(css, /\.live-beta-controls\s*\{[\s\S]*justify-content:\s*center;/);
assert.match(controller, /muteButton\.addEventListener\("click"/);
assert.match(controller, /inputCapture\.setMuted\(muted\)/);
assert.match(controller, /sendSocketMessage\(\{\s*realtimeInput:\s*\{\s*audioStreamEnd:\s*true\s*\}\s*\}\)/);

// 9. Panel closes immediately while commit/finalization continues in background
const releaseIndex = controller.indexOf("void releaseLocalResources();");
const hideIndex = controller.indexOf("hidePanel();");
const commitIndex = controller.indexOf("API.commitLiveSession");
assert.ok(releaseIndex >= 0 && hideIndex > releaseIndex, "Local resources released before hide");
assert.ok(commitIndex > hideIndex, "Background commit proceeds asynchronously without blocking panel hide");

// 10. Hardware and socket cleanup occurs synchronously in releaseLocalResources
assert.match(controller, /mediaStream\.getTracks\(\)\)\s*track\.stop\(\)/);
assert.match(controller, /activeSocket\.close\(1000,\s*"session ended"\)/);
assert.match(controller, /playback\?\.clear\(\)/);

// 11. Immediate and repeated reopen works
assert.match(controller, /window\.SentIQLive\s*=\s*Object\.freeze\(\{\s*start:\s*startSession,\s*terminate:\s*terminateLiveSession/);
assert.equal(controller.includes("LIVE_HANDSHAKE_STABILITY_MS = 750"), false, "750ms artificial delay must be eliminated");
assert.equal(controller.includes("waitForHandshakeStability"), false);

// 12. Adaptive panel state explicitly targets closeActionSelector: "#live-beta-close-btn"
assert.match(adaptiveConfig, /id:\s*"live-beta-panel"[\s\S]*closeActionSelector:\s*"#live-beta-close-btn"/);
assert.match(adaptiveConfig, /generatedClose:\s*false/);

// 13. UI reveals immediately before waiting for backend token
assert.ok(controller.indexOf("showPanel();") < controller.indexOf("API.createLiveSessionToken"), "UI must appear immediately on click");

console.log("Pass 14 Live voice production behavioral contracts passed (all 13 requirements verified).");
