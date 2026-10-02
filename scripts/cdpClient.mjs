// Minimal Chrome DevTools Protocol Client over WebSocket
export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method) {
          const listeners = this.eventListeners.get(msg.method) || [];
          for (const listener of listeners) {
            try { listener(msg.params); } catch (e) { console.error("Event listener error:", e); }
          }
        }
      } catch (err) {
        console.error("CDP onmessage parse error:", err);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const curId = this.id++;
      this.pending.set(curId, { resolve, reject });
      this.ws.send(JSON.stringify({ id: curId, method, params }));
    });
  }

  on(method, callback) {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, []);
    }
    this.eventListeners.get(method).push(callback);
  }

  close() {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }
}

export async function getSentIqTabDebuggerUrl() {
  const tabsRes = await fetch("http://localhost:9222/json");
  const tabs = await tabsRes.json();
  const target = tabs.find((t) => t.url && t.url.includes("sentiqchat.sentiqlabs.com"));
  if (!target) throw new Error("Could not find open SentIQ Chat tab on port 9222");
  return target.webSocketDebuggerUrl;
}
