import { getLiveUnavailableCopy } from "./live-composer-state.js";

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
    maxSessionSeconds: 0,
    activeSession: null,
  };

  class StreamingPcm16Resampler {
    constructor(inputSampleRate, outputSampleRate) {
      this.ratio = inputSampleRate / outputSampleRate;
      this.position = 0;
      this.remainder = new Float32Array(0);
    }

    process(chunk) {
      if (!(chunk instanceof Float32Array) || chunk.length === 0) return new Int16Array(0);
      const combined = new Float32Array(this.remainder.length + chunk.length);
      combined.set(this.remainder, 0);
      combined.set(chunk, this.remainder.length);
      const samples = [];
      while (this.position + 1 < combined.length) {
        const leftIndex = Math.floor(this.position);
        const fraction = this.position - leftIndex;
        const sample = combined[leftIndex] + (combined[leftIndex + 1] - combined[leftIndex]) * fraction;
        samples.push(Math.max(-1, Math.min(1, sample)));
        this.position += this.ratio;
      }
      const consumed = Math.min(Math.floor(this.position), Math.max(0, combined.length - 1));
      this.remainder = combined.slice(consumed);
      this.position -= consumed;
      const output = new Int16Array(samples.length);
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index];
        output[index] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      }
      return output;
    }
  }

  function pcm16ToBase64(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      view.setInt16(index * 2, samples[index], true);
    }
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  function base64ToFloat32(base64) {
    const binary = atob(base64);
    const byteLength = binary.length - (binary.length % 2);
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < byteLength; index += 1) bytes[index] = binary.charCodeAt(index);
    const view = new DataView(bytes.buffer);
    const samples = new Float32Array(byteLength / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 0x8000;
    }
    return samples;
  }

  class PcmInputCapture {
    constructor(stream, onSamples) {
      this.stream = stream;
      this.onSamples = onSamples;
      this.context = null;
      this.source = null;
      this.processor = null;
      this.silentGain = null;
      this.resampler = null;
    }

    async start() {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio capture is unavailable.");
      this.context = new AudioContextClass({ latencyHint: "interactive" });
      await this.context.resume();
      this.resampler = new StreamingPcm16Resampler(this.context.sampleRate, 16_000);
      this.source = this.context.createMediaStreamSource(this.stream);
      this.silentGain = this.context.createGain();
      this.silentGain.gain.value = 0;
      this.silentGain.connect(this.context.destination);

      const handleChunk = (chunk) => {
        const pcm = this.resampler?.process(chunk);
        if (pcm?.length) this.onSamples(pcm);
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
      await this.context?.close().catch(() => {});
      this.context = null;
      this.source = null;
      this.processor = null;
    }
  }

  class PcmPlaybackQueue {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.context = null;
      this.nextStartTime = 0;
      this.sources = new Set();
    }

    async enqueue(base64) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error("Audio playback is unavailable.");
      if (!this.context) this.context = new AudioContextClass({ latencyHint: "interactive" });
      await this.context.resume();
      const samples = base64ToFloat32(base64);
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
      await this.context?.close().catch(() => {});
      this.context = null;
    }
  }

  function setPanelState(state, label, message) {
    panel.dataset.state = state;
    stateLabel.textContent = label;
    if (message) messageLabel.textContent = message;
    retryButton.hidden = state !== "error" || Boolean(currentSession);
  }

  function formatDuration(totalSeconds) {
    const safeSeconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
    const minutes = Math.floor(safeSeconds / 60);
    const seconds = safeSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setAvailableTime(seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    remainingLabel.textContent = safeSeconds > 0
      ? `${formatDuration(safeSeconds)} available today`
      : "No time left today";
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

  function liveStartFailure(error) {
    if (error?.status === 401 || error?.code === "live_sign_in_required") {
      return { label: "Sign in required", message: getLiveUnavailableCopy("sign_in_required") };
    }
    if (error?.code === "live_plan_unavailable") {
      return { label: "Unavailable", message: getLiveUnavailableCopy("not_available_on_plan") };
    }
    if (error?.code === "live_daily_time_exhausted" || error?.code === "live_daily_sessions_exhausted") {
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
    const activeSocket = socket;
    socket = null;
    if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, "session ended");
    muteButton.disabled = true;
  }

  async function finishSession(reason = "client_end", options = {}) {
    if (ending) return;
    const session = currentSession;
    if (!session) {
      hidePanel();
      return;
    }
    ending = true;
    endButton.disabled = true;
    setPanelState("ended", "Ending", "Saving the text transcript and closing the session.");
    await releaseLocalResources();
    let commitSucceeded = true;
    try {
      if (transcript.length > 0) {
        await API.commitLiveSession(session.sessionId, { transcript });
      }
    } catch {
      commitSucceeded = false;
    }
    await API.endLiveSession(session.sessionId, reason, { keepalive: Boolean(options.keepalive) }).catch(() => {});
    currentSession = null;
    muted = false;
    const muteLabel = muteButton.querySelector("span");
    if (muteLabel) muteLabel.textContent = "Mute";
    muteButton.setAttribute("aria-label", "Mute microphone");
    muteButton.setAttribute("aria-pressed", "false");
    endButton.disabled = false;
    setEndButtonLabel("Close");
    ending = false;
    setPanelState(
      commitSucceeded ? "ended" : "error",
      commitSucceeded ? "Ended" : "Transcript not saved",
      commitSucceeded ? "The Live conversation has ended." : "The conversation ended, but its transcript could not be saved.",
    );
    if (commitSucceeded) {
      await window.SentIQChat?.refreshLiveConversation?.(session.conversationId).catch(() => {});
    }
    await refreshAvailability();
  }

  async function handleServerMessage(event) {
    let raw;
    try {
      raw = typeof event.data === "string" ? event.data : await event.data.text();
      const message = JSON.parse(raw);
      if (Object.prototype.hasOwnProperty.call(message, "setupComplete")) {
        if (inputCapture) return;
        sendSocketMessage({
          clientContent: {
            turns: Array.isArray(currentSession?.initialHistory) ? currentSession.initialHistory : [],
            turnComplete: true,
          },
        });
        inputCapture = new PcmInputCapture(mediaStream, (pcm) => {
          if (muted || socket?.readyState !== WebSocket.OPEN) return;
          sendSocketMessage({
            realtimeInput: {
              audio: {
                data: pcm16ToBase64(pcm),
                mimeType: "audio/pcm;rate=16000",
              },
            },
          });
        });
        await inputCapture.start();
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
        appendTranscript("user", content.inputTranscription.text);
        setPanelState("thinking", "Thinking", "Considering what you said.");
      }
      if (content?.outputTranscription?.text) {
        appendTranscript("assistant", content.outputTranscription.text);
        setPanelState("thinking", "Thinking", "Preparing a response.");
      }
      for (const part of content?.modelTurn?.parts || []) {
        const audio = part?.inlineData;
        if (!audio?.data || !String(audio.mimeType || "").startsWith("audio/pcm")) continue;
        if (!playback) playback = new PcmPlaybackQueue(currentSession?.audio?.outputSampleRate || 24_000);
        setPanelState("speaking", "Speaking", "You can interrupt at any time.");
        await playback.enqueue(audio.data);
      }
      if (content?.turnComplete) {
        setPanelState(muted ? "muted" : "listening", muted ? "Muted" : "Listening", muted ? "Unmute when you are ready." : "Speak when you are ready.");
      }
      if (message.goAway) await finishSession("socket_closed");
    } catch {
      setPanelState("error", "Connection error", "Live audio could not be processed. End the session and try again.");
    }
  }

  async function startSession() {
    if (currentSession || ending) return;
    const status = await refreshAvailability();
    if (status.reason === "sign_in_required") {
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
    setAvailableTime(status.remainingSecondsToday);

    if (!status.available) {
      const label = status.reason === "daily_limit_reached"
        ? "Daily limit reached"
        : status.reason === "not_available_on_plan"
          ? "Unavailable"
          : "Busy";
      setPanelState("error", label, getLiveUnavailableCopy(status.reason));
      setEndButtonLabel("Close");
      return;
    }

    setPanelState("connecting", "Connecting", "Getting Live voice ready.");

    if (
      typeof WebSocket !== "function"
      || !navigator.mediaDevices?.getUserMedia
      || !(window.AudioContext || window.webkitAudioContext)
    ) {
      setPanelState("error", "Unavailable", "Live voice needs microphone and audio support in this browser.");
      setEndButtonLabel("Close");
      return;
    }

    try {
      const conversationId = await window.SentIQChat?.prepareLiveConversation?.();
      if (!conversationId) throw new Error("A signed-in conversation is required.");
      currentSession = await API.createLiveSessionToken(conversationId);
      startRemainingTimer(currentSession.sessionMaxSeconds);
      maxDurationTimer = window.setTimeout(
        () => finishSession("max_duration"),
        currentSession.sessionMaxSeconds * 1_000,
      );
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      const separator = currentSession.webSocketUrl.includes("?") ? "&" : "?";
      socket = new WebSocket(
        `${currentSession.webSocketUrl}${separator}access_token=${encodeURIComponent(currentSession.ephemeralToken)}`,
      );
      socket.onopen = () => {
        if (!sendSocketMessage({ setup: currentSession.setup })) {
          void finishSession("error");
        }
      };
      socket.onmessage = (event) => { void handleServerMessage(event); };
      socket.onerror = () => {
        setPanelState("error", "Connection error", "Live voice could not connect. End the session and try again.");
      };
      socket.onclose = () => {
        if (!ending && currentSession) void finishSession("socket_closed");
      };
      currentSession.ephemeralToken = "";
    } catch (error) {
      const session = currentSession;
      await releaseLocalResources();
      if (session?.sessionId) await API.endLiveSession(session.sessionId, "error").catch(() => {});
      currentSession = null;
      const failure = liveStartFailure(error);
      setPanelState("error", failure.label, failure.message);
      setEndButtonLabel("Close");
      await refreshAvailability();
    }
  }

  async function refreshAvailability() {
    try {
      const status = await API.getLiveStatus();
      lastStatus = {
        enabled: Boolean(status?.enabled),
        available: Boolean(status?.available),
        reason: typeof status?.reason === "string" ? status.reason : "busy",
        remainingSecondsToday: Math.max(0, Number(status?.remainingSecondsToday) || 0),
        maxSessionSeconds: Math.max(0, Number(status?.maxSessionSeconds) || 0),
        activeSession: status?.activeSession?.status === "active" ? { status: "active" } : null,
      };
    } catch {
      lastStatus = {
        enabled: false,
        available: false,
        reason: "busy",
        remainingSecondsToday: 0,
        maxSessionSeconds: 0,
        activeSession: null,
      };
    }
    document.dispatchEvent(new CustomEvent("sentiq-live-status", { detail: { ...lastStatus } }));
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
    if (transcript.length > 0) {
      void API.commitLiveSession(sessionId, { transcript }, { keepalive: true }).catch(() => {});
    }
    void releaseLocalResources();
    void API.endLiveSession(sessionId, "navigation", { keepalive: true }).catch(() => {});
    currentSession = null;
  });

  void refreshAvailability();
})();
