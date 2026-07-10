import { getLiveUnavailableCopy } from "./live-composer-state.js";
import {
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  PcmChunkAccumulator,
  StreamingPcm16Resampler,
  base64Pcm16ToFloat32,
  buildLiveAudioInputMessage,
} from "./live-audio-protocol.js";

const LIVE_HANDSHAKE_STABILITY_MS = 750;

(function initializeSentIQLive() {
  const API = window.SentIQAPI;
  const liveButton = document.getElementById("live-beta-btn");
  const panel = document.getElementById("live-beta-panel");
  const stateLabel = document.getElementById("live-beta-state");
  const messageLabel = document.getElementById("live-beta-message");
  const transcriptElement = document.getElementById("live-beta-transcript");
  const transcriptWrap = document.getElementById("live-beta-transcript-wrap");
  const transcriptToggle = document.getElementById("live-beta-transcript-toggle");
  const remainingLabel = document.getElementById("live-beta-remaining");
  const muteButton = document.getElementById("live-beta-mute");
  const endButton = document.getElementById("live-beta-end");
  const retryButton = document.getElementById("live-beta-retry");

  if (
    !API || !liveButton || !panel || !stateLabel || !messageLabel
    || !muteButton || !endButton || !retryButton || !remainingLabel
  ) return;

  let currentSession = null;
  let socket = null;
  let mediaStream = null;
  let inputCapture = null;
  let playback = null;
  let audioContext = null;
  let audioInputReady = false;
  let loggedFirstInputChunk = false;
  let loggedFirstOutputChunk = false;
  let maxDurationTimer = 0;
  let remainingTimer = 0;
  let sessionEndAt = 0;
  let ending = false;
  let muted = false;
  let transcript = [];
  let previousFocus = null;
  let lastStatus = {
    enabled: false,
    available: false,
    reason: "busy",
    remainingSecondsToday: 0,
    remainingSessionsToday: 0,
    maxSessionSeconds: 0,
    activeSession: null,
  };

  function liveDebug(event, details = {}) {
    window.SentIQChat?.debugLog?.("[Live]", { event, ...details });
  }

  function waitForHandshakeStability() {
    return new Promise((resolve) => window.setTimeout(resolve, LIVE_HANDSHAKE_STABILITY_MS));
  }

  function classifySocketClose(event) {
    const reason = typeof event?.reason === "string" ? event.reason.toLowerCase() : "";
    if (event?.code === 1008 || /permission|policy|auth|forbidden/.test(reason)) return "policy";
    if (event?.code === 1011 || /quota|capacity|resource/.test(reason)) return "capacity";
    if (event?.code === 1000) return "normal";
    return "connection";
  }

  function unlockAudioContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return Promise.reject(new Error("Audio is unavailable."));
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextClass({ latencyHint: "interactive" });
    }
    return audioContext.resume();
  }

  class PcmInputCapture {
    constructor(stream, onSamples, context) {
      this.stream = stream;
      this.onSamples = onSamples;
      this.context = context;
      this.source = null;
      this.processor = null;
      this.silentGain = null;
      this.resampler = null;
      this.accumulator = new PcmChunkAccumulator();
    }

    async start() {
      await this.context.resume();
      this.resampler = new StreamingPcm16Resampler(this.context.sampleRate, LIVE_INPUT_SAMPLE_RATE);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      this.silentGain.connect(this.context.destination);

      const handleChunk = (chunk) => {
        const pcm = this.resampler?.process(chunk);
        if (pcm?.length) this.accumulator.push(pcm, this.onSamples);
      };

      if (this.context.audioWorklet && typeof window.AudioWorkletNode === "function") {
        try {
          await this.context.audioWorklet.addModule("scripts/features/live/pcm-capture-worklet.js");
          this.processor = new AudioWorkletNode(this.context, "sentiq-pcm-capture");
          this.processor.port.onmessage = (event) => handleChunk(event.data);
        } catch {
          this.processor = null;
        }
      }

      if (!this.processor) {
        if (typeof this.context.createScriptProcessor !== "function") {
          throw new Error("Audio conversion is unavailable.");
        }
        this.processor = this.context.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => {
          handleChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
          event.outputBuffer.getChannelData(0).fill(0);
        };
      }

      this.source.connect(this.processor);
      this.processor.connect(this.silentGain);
    }

    setMuted(nextMuted) {
      for (const track of this.stream.getAudioTracks()) track.enabled = !nextMuted;
    }

    async stop() {
      try { this.source?.disconnect(); } catch { /* already disconnected */ }
      try { this.processor?.disconnect(); } catch { /* already disconnected */ }
      try { this.silentGain?.disconnect(); } catch { /* already disconnected */ }
      for (const track of this.stream.getTracks()) track.stop();
      this.accumulator.reset();
      this.source = null;
      this.processor = null;
    }
  }

  class PcmPlaybackQueue {
    constructor(sampleRate, context) {
      this.sampleRate = sampleRate;
      this.context = context;
      this.nextStartTime = 0;
      this.sources = new Set();
    }

    async enqueue(base64) {
      await this.context.resume();
      const samples = base64Pcm16ToFloat32(base64);
      if (samples.length === 0) return;
      const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
      buffer.copyToChannel(samples, 0);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.context.destination);
      const startTime = Math.max(this.context.currentTime + 0.02, this.nextStartTime);
      this.nextStartTime = startTime + buffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
      source.start(startTime);
    }

    clear() {
      for (const source of this.sources) {
        try { source.stop(); } catch { /* source already ended */ }
      }
      this.sources.clear();
      this.nextStartTime = this.context?.currentTime || 0;
    }

    async close() {
      this.clear();
    }
  }

  function setPanelState(state, label, message) {
    panel.dataset.state = state;
    stateLabel.textContent = label;
    if (message) messageLabel.textContent = message;
    const retryable = [
      "error",
      "quota_denied",
      "mic_blocked",
      "websocket_failed",
      "audio_failed",
      "unavailable",
    ].includes(state);
    retryButton.hidden = !retryable || Boolean(currentSession);
    liveDebug("state", { state });
  }

  function formatDuration(totalSeconds) {
    const safeSeconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setAvailableStatus(status) {
    const safeSeconds = Math.max(0, Math.floor(Number(status?.remainingSecondsToday) || 0));
    if (safeSeconds > 0) {
      remainingLabel.textContent = `${formatDuration(safeSeconds)} available today`;
    } else {
      remainingLabel.textContent = "No time left today";
    }
  }

  function updateSessionTime() {
    if (!sessionEndAt) return;
    const remainingSeconds = Math.max(0, Math.ceil((sessionEndAt - Date.now()) / 1_000));
    remainingLabel.textContent = `${formatDuration(remainingSeconds)} remaining`;
  }

  function startRemainingTimer(seconds) {
    window.clearInterval(remainingTimer);
    sessionEndAt = Date.now() + Math.max(0, Number(seconds) || 0) * 1_000;
    updateSessionTime();
    remainingTimer = window.setInterval(updateSessionTime, 1_000);
  }

  function setEndButtonLabel(label) {
    const text = endButton.querySelector("span");
    if (text) text.textContent = label;
    endButton.setAttribute("aria-label", label === "Close" ? "Close Live voice" : "End Live voice");
  }

  function supportsLiveAudio() {
    return Boolean(
      typeof WebSocket === "function"
      && navigator.mediaDevices?.getUserMedia
      && (window.AudioContext || window.webkitAudioContext)
    );
  }

  function liveStartFailure(error) {
    if (error?.status === 401 || error?.code === "live_sign_in_required") {
      return { label: "Sign in required", message: getLiveUnavailableCopy("sign_in_required") };
    }
    if (error?.code === "live_plan_unavailable") {
      return { label: "Unavailable", message: getLiveUnavailableCopy("not_available_on_plan") };
    }
    if (error?.code === "live_daily_time_exhausted") {
      return { label: "Daily limit reached", message: getLiveUnavailableCopy("daily_limit_reached") };
    }
    if ([
      "live_active_limit",
      "live_global_capacity",
      "live_project_capacity",
      "live_capacity_unavailable",
      "live_token_provision_failed",
    ].includes(error?.code)) {
      return { label: "Busy", message: getLiveUnavailableCopy("busy") };
    }
    return { label: "Could not start", message: "Check microphone access and try Live voice again." };
  }

  function showPanel() {
    if (panel.hidden) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("live-beta-open");
    window.requestAnimationFrame(() => endButton.focus());
  }

  function hidePanel() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("live-beta-open");
    if (transcriptWrap) transcriptWrap.open = false;
    transcriptToggle?.setAttribute("aria-expanded", "false");
    transcriptToggle?.setAttribute("aria-label", "Show transcript");
    previousFocus?.focus?.();
    previousFocus = null;
  }

  function renderTranscript() {
    if (!transcriptElement) return;
    transcriptElement.replaceChildren();
    for (const turn of transcript) {
      const line = document.createElement("div");
      line.className = "live-beta-transcript-line";
      const role = document.createElement("span");
      role.className = "live-beta-transcript-role";
      role.textContent = turn.role === "assistant" ? "SentIQ" : "You";
      const text = document.createElement("span");
      text.textContent = turn.text;
      line.append(role, text);
      transcriptElement.appendChild(line);
    }
    transcriptElement.scrollTop = transcriptElement.scrollHeight;
  }

  function appendTranscript(role, text) {
    const normalized = typeof text === "string" ? text.replace(/\s+/g, " ") : "";
    if (!normalized.trim()) return;
    const previous = transcript[transcript.length - 1];
    if (previous?.role === role) {
      previous.text = `${previous.text}${normalized}`.trim().slice(0, 4_000);
    } else {
      transcript.push({ role, text: normalized.trim().slice(0, 4_000) });
      if (transcript.length > 100) transcript = transcript.slice(-100);
    }
    renderTranscript();
  }

  function sendSocketMessage(payload) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }

  async function releaseLocalResources() {
    window.clearTimeout(maxDurationTimer);
    window.clearInterval(remainingTimer);
    maxDurationTimer = 0;
    remainingTimer = 0;
    sessionEndAt = 0;
    audioInputReady = false;
    playback?.clear();
    const capture = inputCapture;
    inputCapture = null;
    if (capture) await capture.stop().catch(() => {});
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    const player = playback;
    playback = null;
    if (player) await player.close().catch(() => {});
    const context = audioContext;
    audioContext = null;
    if (context) await context.close().catch(() => {});
    const activeSocket = socket;
    socket = null;
    if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, "session ended");
    muteButton.disabled = true;
    liveDebug("local_resources_released");
  }

  async function finishSession(reason = "client_end", options = {}) {
    if (ending) return;
    const session = currentSession;
    if (!session) {
      if (options.failure) {
        setPanelState(options.failure.state || "error", options.failure.label, options.failure.message);
        setEndButtonLabel("Close");
      } else {
        hidePanel();
      }
      return;
    }
    ending = true;
    endButton.disabled = true;
    setPanelState("ended", "Ending", "Closing the Live conversation.");
    await releaseLocalResources();
    let commitSucceeded = true;
    try {
      if (!options.skipCommit && session.audioStarted && transcript.length > 0) {
        await API.commitLiveSession(session.sessionId, { transcript });
      }
    } catch {
      commitSucceeded = false;
    }
    const endResult = await API.endLiveSession(
      session.sessionId,
      reason,
      { keepalive: Boolean(options.keepalive) },
    ).catch(() => null);
    currentSession = null;
    muted = false;
    const muteLabel = muteButton.querySelector("span");
    if (muteLabel) muteLabel.textContent = "Mute";
    muteButton.setAttribute("aria-label", "Mute microphone");
    muteButton.setAttribute("aria-pressed", "false");
    endButton.disabled = false;
    setEndButtonLabel("Close");
    ending = false;
    if (options.failure) {
      setPanelState(options.failure.state || "error", options.failure.label, options.failure.message);
    } else if (!endResult) {
      setPanelState("error", "Cleanup pending", "Live voice ended here. Try again after the status refresh completes.");
    } else {
      setPanelState(
        commitSucceeded ? "ended" : "error",
        commitSucceeded ? "Ended" : "Transcript not saved",
        commitSucceeded ? "The Live conversation has ended." : "The conversation ended, but its transcript could not be saved.",
      );
    }
    liveDebug("session_finished", {
      reason,
      cleanup_succeeded: Boolean(endResult),
      transcript_saved: commitSucceeded,
      audio_started: Boolean(session.audioStarted),
    });
    if (commitSucceeded && session.audioStarted) {
      await window.SentIQChat?.refreshLiveConversation?.(session.conversationId).catch(() => {});
    }
    await refreshAvailability();
  }

  function failSession(reason, state, label, message) {
    return finishSession(reason, {
      skipCommit: true,
      failure: { state, label, message },
    });
  }

  async function handleServerMessage(event) {
    let raw;
    try {
      raw = typeof event.data === "string" ? event.data : await event.data.text();
      const message = JSON.parse(raw);
      if (Object.prototype.hasOwnProperty.call(message, "setupComplete")) {
        if (inputCapture) return;
        const historySent = sendSocketMessage({
          clientContent: {
            turns: Array.isArray(currentSession?.initialHistory) ? currentSession.initialHistory : [],
            turnComplete: true,
          },
        });
        if (!historySent) throw new Error("Live setup could not be completed.");
        liveDebug("setup_complete");
        // Some provider-side policy/quota failures arrive immediately after
        // setupComplete. Do not start metering or audio capture until the
        // socket has survived that setup window.
        await waitForHandshakeStability();
        if (ending || !currentSession || socket?.readyState !== WebSocket.OPEN) return;
        inputCapture = new PcmInputCapture(mediaStream, (pcm) => {
          if (!audioInputReady || muted || socket?.readyState !== WebSocket.OPEN) return;
          if (!loggedFirstInputChunk) {
            loggedFirstInputChunk = true;
            liveDebug("input_audio_started", {
              sample_rate: LIVE_INPUT_SAMPLE_RATE,
              chunk_samples: pcm.length,
            });
          }
          sendSocketMessage(buildLiveAudioInputMessage(pcm));
        }, audioContext);
        await inputCapture.start();
        await API.markLiveSessionStarted(currentSession.sessionId);
        currentSession.audioStarted = true;
        audioInputReady = true;
        startRemainingTimer(currentSession.sessionMaxSeconds);
        maxDurationTimer = window.setTimeout(
          () => finishSession("max_duration"),
          currentSession.sessionMaxSeconds * 1_000,
        );
        muteButton.disabled = false;
        setPanelState("listening", "Listening", "Speak naturally. You can interrupt while SentIQ is responding.");
        return;
      }

      const content = message.serverContent;
      if (content?.interrupted) {
        playback?.clear();
        setPanelState("listening", "Listening", "SentIQ stopped so you can continue.");
      }
      if (content?.inputTranscription?.text) {
        liveDebug("transcription_received", { direction: "input" });
        appendTranscript("user", content.inputTranscription.text);
        setPanelState("thinking", "Thinking", "Considering what you said.");
      }
      if (content?.outputTranscription?.text) {
        liveDebug("transcription_received", { direction: "output" });
        appendTranscript("assistant", content.outputTranscription.text);
        setPanelState("thinking", "Thinking", "Preparing a response.");
      }
      for (const part of content?.modelTurn?.parts || []) {
        const audio = part?.inlineData;
        if (!audio?.data || !String(audio.mimeType || "").startsWith("audio/pcm")) continue;
        if (!playback) {
          playback = new PcmPlaybackQueue(
            currentSession?.audio?.outputSampleRate || LIVE_OUTPUT_SAMPLE_RATE,
            audioContext,
          );
        }
        if (!loggedFirstOutputChunk) {
          loggedFirstOutputChunk = true;
          liveDebug("output_audio_started", {
            sample_rate: currentSession?.audio?.outputSampleRate || LIVE_OUTPUT_SAMPLE_RATE,
          });
        }
        setPanelState("speaking", "Speaking", "You can interrupt at any time.");
        await playback.enqueue(audio.data);
      }
      if (content?.turnComplete) {
        setPanelState(muted ? "muted" : "listening", muted ? "Muted" : "Listening", muted ? "Unmute when you are ready." : "Speak when you are ready.");
      }
      if (message.goAway) await finishSession("socket_closed");
    } catch {
      await failSession(
        "audio_start_failed",
        "audio_failed",
        "Audio connection failed",
        "Live voice could not process audio. Try again.",
      );
    }
  }

  async function startSession() {
    if (currentSession || ending) return;
    loggedFirstInputChunk = false;
    loggedFirstOutputChunk = false;
    const audioUnlockPromise = supportsLiveAudio()
      ? unlockAudioContext().then(() => null).catch((error) => error)
      : Promise.resolve(null);
    const status = await refreshAvailability();
    liveDebug("start_status", {
      available: status.available,
      reason: status.reason,
      remaining_seconds: status.remainingSecondsToday,
      remaining_sessions: status.remainingSessionsToday,
    });
    if (status.reason === "sign_in_required") {
      await releaseLocalResources();
      window.SentIQChat?.requestLiveAuth?.();
      return;
    }
    showPanel();
    transcript = [];
    renderTranscript();
    if (transcriptWrap) transcriptWrap.open = false;
    transcriptToggle?.setAttribute("aria-expanded", "false");
    setEndButtonLabel("End");
    endButton.disabled = false;
    muteButton.disabled = true;
    setAvailableStatus(status);

    if (!status.available) {
      await releaseLocalResources();
      const label = status.reason === "daily_limit_reached"
        ? "Daily limit reached"
        : ["not_available", "not_available_on_plan", "browser_unsupported"].includes(status.reason)
          ? "Unavailable"
          : "Busy";
      const state = status.reason === "daily_limit_reached"
        ? "quota_denied"
        : ["not_available", "not_available_on_plan", "browser_unsupported"].includes(status.reason)
          ? "unavailable"
          : "error";
      setPanelState(state, label, getLiveUnavailableCopy(status.reason));
      setEndButtonLabel("Close");
      return;
    }

    setPanelState("connecting", "Connecting", "Getting Live voice ready.");

    if (!supportsLiveAudio()) {
      setPanelState("unavailable", "Unavailable", getLiveUnavailableCopy("browser_unsupported"));
      setEndButtonLabel("Close");
      return;
    }

    try {
      const audioUnlockError = await audioUnlockPromise;
      if (audioUnlockError) throw audioUnlockError;
      const conversationId = await window.SentIQChat?.prepareLiveConversation?.();
      if (!conversationId) throw new Error("A signed-in conversation is required.");
      currentSession = await API.createLiveSessionToken(conversationId);
      currentSession.audioStarted = false;
      liveDebug("token_ready", { max_seconds: currentSession.sessionMaxSeconds });
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      playback = new PcmPlaybackQueue(
        currentSession?.audio?.outputSampleRate || LIVE_OUTPUT_SAMPLE_RATE,
        audioContext,
      );
      const separator = currentSession.webSocketUrl.includes("?") ? "&" : "?";
      socket = new WebSocket(
        `${currentSession.webSocketUrl}${separator}access_token=${encodeURIComponent(currentSession.ephemeralToken)}`,
      );
      socket.onopen = () => {
        liveDebug("websocket_open");
        if (!sendSocketMessage({ setup: currentSession.setup })) {
          void failSession("websocket_failed", "websocket_failed", "Connection failed", "Live voice could not connect. Try again.");
        }
      };
      socket.onmessage = (event) => { void handleServerMessage(event); };
      socket.onerror = () => {
        liveDebug("failure", { stage: "websocket" });
        void failSession("websocket_failed", "websocket_failed", "Connection failed", "Live voice could not connect. Try again.");
      };
      socket.onclose = (event) => {
        liveDebug("websocket_closed", {
          code: Number(event?.code) || 0,
          clean: Boolean(event?.wasClean),
          failure_class: classifySocketClose(event),
        });
        if (!ending && currentSession) {
          void failSession("websocket_failed", "websocket_failed", "Connection closed", "Live voice disconnected. Try again.");
        }
      };
      currentSession.ephemeralToken = "";
    } catch (error) {
      const micBlocked = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      const reason = micBlocked ? "mic_blocked" : "audio_start_failed";
      const failure = micBlocked
        ? { label: "Microphone blocked", message: "Allow microphone access to use Live voice." }
        : liveStartFailure(error);
      liveDebug("failure", { stage: micBlocked ? "microphone" : "startup", reason });
      if (currentSession) {
        await failSession(reason, micBlocked ? "mic_blocked" : "audio_failed", failure.label, failure.message);
      } else {
        await releaseLocalResources();
        setPanelState(micBlocked ? "mic_blocked" : "error", failure.label, failure.message);
        setEndButtonLabel("Close");
        await refreshAvailability();
      }
    }
  }

  async function refreshAvailability() {
    try {
      const status = await API.getLiveStatus();
      const browserUnsupported = Boolean(status?.available) && !supportsLiveAudio();
      lastStatus = {
        enabled: Boolean(status?.enabled),
        available: browserUnsupported ? false : Boolean(status?.available),
        reason: browserUnsupported
          ? "browser_unsupported"
          : typeof status?.reason === "string" ? status.reason : "busy",
        remainingSecondsToday: Math.max(0, Number(status?.remainingSecondsToday) || 0),
        remainingSessionsToday: Math.max(0, Number(status?.remainingSessionsToday) || 0),
        maxSessionSeconds: Math.max(0, Number(status?.maxSessionSeconds) || 0),
        activeSession: status?.activeSession?.status === "active" ? { status: "active" } : null,
      };
    } catch {
      lastStatus = {
        enabled: false,
        available: false,
        reason: "busy",
        remainingSecondsToday: 0,
        remainingSessionsToday: 0,
        maxSessionSeconds: 0,
        activeSession: null,
      };
    }
    document.dispatchEvent(new CustomEvent("sentiq-live-status", { detail: { ...lastStatus } }));
    liveDebug("status_refreshed", {
      available: lastStatus.available,
      reason: lastStatus.reason,
      remaining_seconds: lastStatus.remainingSecondsToday,
      remaining_sessions: lastStatus.remainingSessionsToday,
      active: Boolean(lastStatus.activeSession),
    });
    return lastStatus;
  }

  liveButton.addEventListener("click", () => { void startSession(); });
  muteButton.addEventListener("click", () => {
    if (!inputCapture || !currentSession) return;
    muted = !muted;
    inputCapture.setMuted(muted);
    const muteLabel = muteButton.querySelector("span");
    if (muteLabel) muteLabel.textContent = muted ? "Unmute" : "Mute";
    muteButton.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    muteButton.setAttribute("aria-pressed", muted ? "true" : "false");
    if (muted) sendSocketMessage({ realtimeInput: { audioStreamEnd: true } });
    setPanelState(muted ? "muted" : "listening", muted ? "Muted" : "Listening", muted ? "Unmute when you are ready." : "Speak when you are ready.");
  });
  endButton.addEventListener("click", () => {
    if (currentSession) void finishSession("client_end");
    else hidePanel();
  });
  transcriptToggle?.addEventListener("click", () => {
    if (!transcriptWrap) return;
    transcriptWrap.open = !transcriptWrap.open;
    transcriptToggle.setAttribute("aria-expanded", transcriptWrap.open ? "true" : "false");
    transcriptToggle.setAttribute("aria-label", transcriptWrap.open ? "Hide transcript" : "Show transcript");
  });
  retryButton.addEventListener("click", () => { void startSession(); });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (currentSession) void finishSession("client_end");
      else hidePanel();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...panel.querySelectorAll("button:not(:disabled)")]
      .filter((control) => !control.hidden && control.getClientRects().length > 0);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("sentiq-auth-changed", (event) => {
    if (!event.detail?.session?.user && currentSession) void finishSession("navigation");
    void refreshAvailability();
  });
  window.addEventListener("pagehide", () => {
    if (!currentSession || ending) return;
    const sessionId = currentSession.sessionId;
    ending = true;
    if (currentSession.audioStarted && transcript.length > 0) {
      void API.commitLiveSession(sessionId, { transcript }, { keepalive: true }).catch(() => {});
    }
    void releaseLocalResources();
    void API.endLiveSession(sessionId, "navigation", { keepalive: true }).catch(() => {});
    currentSession = null;
  });

  void refreshAvailability();
})();
