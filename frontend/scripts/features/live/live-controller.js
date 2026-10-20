import { getLiveUnavailableCopy } from "./live-composer-state.js";
import {
  LIVE_INPUT_SAMPLE_RATE,
  LIVE_OUTPUT_SAMPLE_RATE,
  PcmChunkAccumulator,
  StreamingPcm16Resampler,
  base64Pcm16ToFloat32,
  buildLiveAudioInputMessage,
} from "./live-audio-protocol.js";

(function initializeSentIQLive() {
  const API = window.SentIQAPI;
  const liveButton = document.getElementById("live-beta-btn");
  const panel = document.getElementById("live-beta-panel");
  const stateLabel = document.getElementById("live-beta-state");
  const messageLabel = document.getElementById("live-beta-message");
  const transcriptElement = document.getElementById("live-beta-transcript");
  const transcriptWrap = document.getElementById("live-beta-transcript-wrap");
  const remainingLabel = document.getElementById("live-beta-remaining");
  const muteButton = document.getElementById("live-beta-mute");
  const closeButton = document.getElementById("live-beta-close-btn");
  const retryButton = document.getElementById("live-beta-retry");

  if (
    !API || !liveButton || !panel || !stateLabel || !messageLabel
    || !muteButton || !retryButton || !remainingLabel
  ) return;

  let currentSession = null;
  let socket = null;
  let mediaStream = null;
  let inputCapture = null;
  let playback = null;
  let audioContext = null;
  let audioInputReady = false;
  let bufferedInputChunks = [];
  let loggedFirstInputChunk = false;
  let loggedFirstOutputChunk = false;
  let maxDurationTimer = 0;
  let remainingTimer = 0;
  let sessionEndAt = 0;
  let ending = false;
  let muted = false;
  let transcript = [];
  let previousFocus = null;
  let terminationPromise = null;
  let reconnecting = false;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 3;
  let lastStatus = {
    enabled: false,
    available: false,
    reason: "not_available",
    remainingSecondsToday: 0,
    remainingSessionsToday: 0,
    maxSessionSeconds: 0,
    activeSession: null,
  };

  function liveDebug(event, details = {}) {
    window.SentIQChat?.debugLog?.("[Live]", { event, ...details });
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
    if (messageLabel) {
      messageLabel.textContent = message || "";
      messageLabel.hidden = !message;
    }
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
    if (error?.code === "live_active_limit") {
      return { label: "Session active", message: "You already have an active Live voice session. Please close it first." };
    }
    if (error?.code === "live_provider_rate_limited") {
      return { label: "Rate limited", message: "Live voice is temporarily rate limited. Try again shortly." };
    }
    if (error?.code === "live_global_capacity" || error?.code === "live_project_capacity" || error?.code === "live_capacity_unavailable") {
      return { label: "At capacity", message: "Live voice is temporarily at capacity. Try again shortly." };
    }
    if (error?.code === "live_provider_unavailable") {
      return { label: "Provider unavailable", message: "Live voice provider is currently unavailable. Try again shortly." };
    }
    if (error?.code === "live_provider_auth_failure") {
      return { label: "Provider error", message: "Live voice authentication failed. Check server configuration." };
    }
    if (error?.code === "live_provider_configuration") {
      return { label: "Configuration error", message: "Live voice provider is not properly configured." };
    }
    if (error?.code === "live_network_error") {
      return { label: "Network error", message: "Could not connect to Live voice. Check your internet connection." };
    }
    if (error?.code === "live_internal_error") {
      return { label: "Server error", message: "An internal server error occurred while starting Live voice." };
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
    window.requestAnimationFrame(() => (closeButton || muteButton)?.focus());
  }

  function hidePanel() {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("live-beta-open");
    if (transcriptWrap) transcriptWrap.open = false;
    previousFocus?.focus?.();
    previousFocus = null;
    window.SentIQPanels?.sync?.();
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
    bufferedInputChunks = [];
    playback?.clear();

    // 1. Immediately and synchronously stop all media stream tracks
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }

    // 2. Immediately close WebSocket
    const activeSocket = socket;
    socket = null;
    if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) {
      try { activeSocket.close(1000, "session ended"); } catch {}
    }

    // 3. Immediately close AudioContext
    const context = audioContext;
    audioContext = null;
    if (context && context.state !== "closed") {
      await context.close().catch(() => {});
    }

    const capture = inputCapture;
    inputCapture = null;
    if (capture) await capture.stop().catch(() => {});

    const player = playback;
    playback = null;
    if (player) await player.close().catch(() => {});

    muteButton.disabled = true;
    liveDebug("local_resources_released");
  }

  function terminateLiveSession(options = {}) {
    const reason = options.reason || "client_end";
    const source = options.source || "user";
    liveDebug("terminate_session", { reason, source });

    if (terminationPromise) return terminationPromise;

    const session = currentSession;
    const hasSession = Boolean(session);
    const wasAudioStarted = Boolean(session?.audioStarted);
    const currentTranscript = [...transcript];
    const liveChatId = session?.liveConversationId || session?.conversationId;

    // 1. Immediately and synchronously tear down hardware & socket handles
    if (mediaStream) {
      for (const track of mediaStream.getTracks()) track.stop();
      mediaStream = null;
    }
    if (socket && socket.readyState < WebSocket.CLOSING) {
      try { socket.close(1000, "session ended"); } catch {}
      socket = null;
    }
    if (audioContext && audioContext.state !== "closed") {
      try { audioContext.close(); } catch {}
      audioContext = null;
    }
    reconnecting = false;
    reconnectAttempts = 0;
    void releaseLocalResources();

    // 2. Immediately and synchronously hide UI & clear flags
    setPanelState("ended", "Ending", "Live session ended.");
    hidePanel();
    currentSession = null;
    ending = false;
    muted = false;
    const muteLabel = muteButton.querySelector("span");
    if (muteLabel) muteLabel.textContent = "Mute";
    muteButton.setAttribute("aria-label", "Mute microphone");
    muteButton.setAttribute("aria-pressed", "false");
    muteButton.disabled = true;

    // 3. Background asynchronous cleanup (non-blocking for UI)
    terminationPromise = (async () => {
      try {
        if (hasSession && session.sessionId) {
          if (!options.skipCommit && wasAudioStarted && currentTranscript.length > 0) {
            try {
              await API.commitLiveSession(
                session.sessionId,
                { transcript: currentTranscript },
                { keepalive: Boolean(options.keepalive) },
              );
              liveDebug("background_commit_success", { sessionId: session.sessionId });
            } catch (err) {
              liveDebug("background_commit_error", { error: String(err) });
            }
          }
          await API.endLiveSession(session.sessionId, reason, {
            keepalive: Boolean(options.keepalive),
          }).catch(() => null);

          if (liveChatId && wasAudioStarted) {
            window.SentIQChat?.refreshLiveConversation?.(liveChatId).catch(() => {});
          }
        }
      } finally {
        terminationPromise = null;
        void refreshAvailability();
      }
    })();

    return terminationPromise;
  }

  async function failSession(reason, state, label, message) {
    liveDebug("fail_session", { reason, state });
    await releaseLocalResources();
    setPanelState(state, label, message);
    if (currentSession?.sessionId) {
      await API.endLiveSession(currentSession.sessionId, reason).catch(() => null);
      currentSession = null;
    }
    ending = false;
    await refreshAvailability();
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

        if (ending || !currentSession || socket?.readyState !== WebSocket.OPEN) return;

        inputCapture = new PcmInputCapture(mediaStream, (pcm) => {
          if (muted || socket?.readyState !== WebSocket.OPEN) return;
          if (!audioInputReady) {
            if (bufferedInputChunks.length < 5) bufferedInputChunks.push(pcm);
            return;
          }
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

        if (bufferedInputChunks.length > 0) {
          for (const chunk of bufferedInputChunks) {
            sendSocketMessage(buildLiveAudioInputMessage(chunk));
          }
          bufferedInputChunks = [];
        }

        startRemainingTimer(currentSession.sessionMaxSeconds);
        maxDurationTimer = window.setTimeout(
          () => terminateLiveSession({ reason: "max_duration", source: "timer" }),
          currentSession.sessionMaxSeconds * 1_000,
        );
        muteButton.disabled = false;
        setPanelState("listening", "Listening", "Speak naturally. You can interrupt while SentIQ is responding.");
        return;
      }

      if (message.sessionResumptionUpdate?.newHandle) {
        if (currentSession) {
          currentSession.resumptionHandle = message.sessionResumptionUpdate.newHandle;
          currentSession.resumable = message.sessionResumptionUpdate.resumable !== false;
        }
        liveDebug("resume_update", {
          handle: "present",
          resumable: currentSession?.resumable,
        });
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
      if (message.goAway) {
        const timeLeft = message.goAway.timeLeft;
        liveDebug("goaway_received", { timeLeft });
        if (!ending && currentSession?.resumptionHandle && (sessionEndAt > Date.now()) && !reconnecting) {
          void attemptSessionResumption("goaway");
        } else {
          await terminateLiveSession({ reason: "socket_closed", source: "go_away" });
        }
      }
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
    bufferedInputChunks = [];

    // Step 1: Immediately show UI in connecting state!
    showPanel();
    setPanelState("connecting", "Connecting", "");
    transcript = [];
    renderTranscript();
    if (transcriptWrap) transcriptWrap.open = false;
    muteButton.disabled = true;

    // Step 2: Parallelize audio unlock, mic permission, and destination token preparation
    const audioUnlockPromise = supportsLiveAudio()
      ? unlockAudioContext().then(() => null).catch((error) => error)
      : Promise.resolve(new Error("Audio is not supported in this browser."));

    const micStreamPromise = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        }).catch((err) => err)
      : Promise.resolve(new Error("Microphone unavailable"));

    let sourceConversationId = null;
    try {
      sourceConversationId = await window.SentIQChat?.prepareLiveConversation?.();
    } catch {
      // Non-fatal
    }

    // Step 3: Request session token from backend
    try {
      const [tokenResult, audioUnlockError, micResult] = await Promise.all([
        API.createLiveSessionToken(sourceConversationId ? { sourceConversationId } : {}),
        audioUnlockPromise,
        micStreamPromise,
      ]);

      if (audioUnlockError) throw audioUnlockError;
      if (micResult instanceof Error) throw micResult;

      mediaStream = micResult;
      currentSession = tokenResult;
      currentSession.audioStarted = false;
      liveDebug("token_ready", { sessionId: currentSession.sessionId, max_seconds: currentSession.sessionMaxSeconds });

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
        if (currentSession?.sessionId) {
          API.reportLiveSessionError?.(currentSession.sessionId, { errorType: "websocket_failed" }).catch(() => {});
        }
        void failSession("websocket_failed", "websocket_failed", "Connection failed", "Live voice could not connect. Try again.");
      };

      socket.onclose = (event) => {
        const failureClass = classifySocketClose(event);
        liveDebug("websocket_closed", {
          code: Number(event?.code) || 0,
          clean: Boolean(event?.wasClean),
          failure_class: failureClass,
        });
        if (currentSession?.sessionId && (event?.code === 1008 || event?.code === 1011 || !event?.wasClean)) {
          API.reportLiveSessionError?.(currentSession.sessionId, {
            errorType: "websocket_failed",
            code: event.code,
            reason: event.reason,
          }).catch(() => {});
        }
        if (!ending && currentSession) {
          if (currentSession.resumptionHandle && (sessionEndAt > Date.now()) && reconnectAttempts < MAX_RECONNECT_ATTEMPTS && !reconnecting) {
            void attemptSessionResumption("socket_close");
          } else if (!reconnecting) {
            void failSession("websocket_failed", "websocket_failed", "Connection closed", "Live voice disconnected. Try again.");
          }
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
          : typeof status?.reason === "string" ? status.reason : "internal_error",
        remainingSecondsToday: Math.max(0, Number(status?.remainingSecondsToday) || 0),
        remainingSessionsToday: Math.max(0, Number(status?.remainingSessionsToday) || 0),
        maxSessionSeconds: Math.max(0, Number(status?.maxSessionSeconds) || 0),
        activeSession: status?.activeSession?.status === "active" ? { status: "active" } : null,
      };
    } catch {
      lastStatus = {
        enabled: false,
        available: false,
        reason: "network_error",
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
  closeButton?.addEventListener("click", () => {
    void terminateLiveSession({ reason: "client_end", source: "close_btn" });
  });

  panel.addEventListener("click", (event) => {
    if (event.target === panel) {
      void terminateLiveSession({ reason: "client_end", source: "backdrop_click" });
    }
  });
  panel.addEventListener("pointerdown", (event) => {
    if (event.target === panel) {
      void terminateLiveSession({ reason: "client_end", source: "backdrop_click" });
    }
  });

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

  retryButton.addEventListener("click", () => { void startSession(); });

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void terminateLiveSession({ reason: "client_end", source: "escape" });
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

  // Global document capture for Escape while Live panel is active
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden && panel.getAttribute("aria-hidden") !== "true") {
      event.preventDefault();
      event.stopImmediatePropagation();
      void terminateLiveSession({ reason: "client_end", source: "escape" });
    }
  }, true);

  // Close Live canonical lifecycle if panel is closed externally
  panel.addEventListener("sentiq-panel-closed", () => {
    if (currentSession && !terminationPromise) {
      void terminateLiveSession({ reason: "client_end", source: "panel_closed" });
    }
  });

  async function attemptSessionResumption(trigger) {
    if (ending || !currentSession || reconnecting) return;
    if (!currentSession.resumptionHandle) {
      void failSession("websocket_failed", "websocket_failed", "Connection closed", "Live voice disconnected. Try again.");
      return;
    }
    reconnecting = true;
    reconnectAttempts += 1;
    liveDebug("reconnect_started", { attempt: reconnectAttempts, trigger });
    setPanelState("connecting", "Reconnecting", "Reconnecting Live voice…");

    try {
      if (socket && socket.readyState < WebSocket.CLOSING) {
        try { socket.close(1000, "resuming"); } catch {}
      }
      socket = null;

      let resumeAuth = null;
      try {
        resumeAuth = await API.getLiveResumeToken(currentSession.sessionId);
      } catch (err) {
        liveDebug("resume_token_fetch_failed", { error: String(err) });
      }

      const token = resumeAuth?.ephemeralToken || currentSession.ephemeralToken;
      const wsUrl = resumeAuth?.webSocketUrl || currentSession.webSocketUrl;
      if (!token || !wsUrl) {
        throw new Error("No token available for session resumption.");
      }

      const separator = wsUrl.includes("?") ? "&" : "?";
      const newSocket = new WebSocket(`${wsUrl}${separator}access_token=${encodeURIComponent(token)}`);
      socket = newSocket;

      newSocket.onopen = () => {
        liveDebug("websocket_open", { mode: "resumption" });
        const resumeSetup = {
          setup: {
            model: currentSession.setup?.model || "models/gemini-3.8-live",
            sessionResumption: {
              handle: currentSession.resumptionHandle,
            },
          },
        };
        if (!sendSocketMessage(resumeSetup)) {
          throw new Error("Resumption setup could not be sent.");
        }
        reconnecting = false;
        reconnectAttempts = 0;
        liveDebug("reconnect_succeeded");
        setPanelState(muted ? "muted" : "listening", muted ? "Muted" : "Listening", muted ? "Unmute when you are ready." : "Speak when you are ready.");
      };

      newSocket.onmessage = (event) => { void handleServerMessage(event); };
      newSocket.onerror = () => {
        liveDebug("failure", { stage: "websocket_resume" });
        if (!ending && currentSession) {
          void failSession("websocket_failed", "websocket_failed", "Connection failed", "Live voice could not connect. Try again.");
        }
      };
      newSocket.onclose = (event) => {
        liveDebug("websocket_closed", { code: event?.code, mode: "resumption" });
        if (!ending && currentSession && !reconnecting) {
          void failSession("websocket_failed", "websocket_failed", "Connection closed", "Live voice disconnected. Try again.");
        }
      };
    } catch (err) {
      reconnecting = false;
      liveDebug("reconnect_failed", { error: String(err) });
      void failSession("websocket_failed", "websocket_failed", "Connection closed", "Live voice disconnected. Try again.");
    }
  }

  document.addEventListener("sentiq-auth-changed", (event) => {
    if (!event.detail?.session?.user && currentSession) {
      void terminateLiveSession({ reason: "navigation", source: "auth_changed" });
    }
    void refreshAvailability();
  });

  window.addEventListener("pagehide", () => {
    if (!currentSession) return;
    void terminateLiveSession({ reason: "navigation", source: "pagehide", keepalive: true });
  });

  window.SentIQLive = Object.freeze({
    start: startSession,
    terminate: terminateLiveSession,
    isAvailable: () => lastStatus.available,
  });

  void refreshAvailability();
})();
