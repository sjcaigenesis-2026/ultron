// Ultron Orb voice assistant frontend.
// Flow: speech -> text -> POST /api/chat -> answer -> speech.

const LANG = "en-IN"; // change to "en-US" etc. after testing on your devices
const REQUEST_TIMEOUT_MS = 20000;

const orb = document.getElementById("orb");
const statusText = document.getElementById("orb-status");
const transcript = document.getElementById("transcript");
const micButton = document.getElementById("mic-button");
const stopButton = document.getElementById("stop-button");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

let state = "idle";
let recognition = null;
let activeController = null;
// Every new interaction or Stop bumps runId. Async callbacks from an older
// run compare their id and quietly exit, so stale events cannot change the Orb.
let runId = 0;

function setOrbState(next, message) {
  state = next;
  orb.classList.remove("idle", "listening", "thinking", "speaking", "error");
  orb.classList.add(next);
  statusText.textContent = message;
}

function stopAll(message) {
  runId++;
  if (activeController) activeController.abort();
  activeController = null;
  if (recognition) {
    try { recognition.abort(); } catch { /* already stopped */ }
    recognition = null;
  }
  window.speechSynthesis?.cancel();
  setOrbState("idle", message);
}

const VOICE_ERRORS = {
  "not-allowed": "Microphone access is blocked. Allow it in the browser, or type instead.",
  "service-not-allowed": "Microphone access is blocked. Allow it in the browser, or type instead.",
  "no-speech": "I didn't hear anything. Tap the Orb and try again.",
  "audio-capture": "No microphone found. Connect one, or type instead.",
  "network": "Speech recognition needs a network connection. Check it, or type instead.",
  "language-not-supported": "This browser doesn't support that language. Type instead."
};

// ---------- Speaking ----------

function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#`>~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Some browsers cut off long utterances, so speak in sentence-sized chunks.
function chunkText(text, max = 180) {
  const sentences = text.match(/[^.!?\n]+[.!?]*/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      chunks.push(current.trim());
      current = "";
    }
    current += s + " ";
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function speakAnswer(text, id) {
  if (!("speechSynthesis" in window)) {
    setOrbState("idle", "Answer shown below. This browser can't speak it.");
    return;
  }

  const chunks = chunkText(cleanForSpeech(text));
  if (!chunks.length) {
    setOrbState("idle", "Ready. Tap the Orb to speak.");
    return;
  }

  window.speechSynthesis.cancel();

  chunks.forEach((chunk, index) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = LANG;
    const last = index === chunks.length - 1;

    if (index === 0) {
      utterance.onstart = () => {
        if (id === runId) setOrbState("speaking", "Ultron is speaking...");
      };
    }
    utterance.onend = () => {
      if (id === runId && last) setOrbState("idle", "Ready. Tap the Orb to speak.");
    };
    utterance.onerror = (event) => {
      if (id !== runId) return;
      if (event.error === "canceled" || event.error === "interrupted") return;
      window.speechSynthesis.cancel();
      setOrbState("idle", "Answer shown below. Audio couldn't play.");
    };
    window.speechSynthesis.speak(utterance);
  });
}

// ---------- Asking the AI ----------

async function askAI(message) {
  runId++;
  const id = runId;
  if (activeController) activeController.abort();

  const controller = new AbortController();
  activeController = controller;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  setOrbState("thinking", "Ultron is thinking...");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal
    });

    let data = {};
    try { data = await response.json(); } catch { /* non-JSON error page */ }

    if (id !== runId) return; // user pressed Stop or started something new

    if (!response.ok) {
      throw new Error(data.error || "The AI request failed.");
    }
    if (typeof data.answer !== "string" || !data.answer.trim()) {
      throw new Error("The AI sent an empty answer.");
    }

    transcript.textContent = "Ultron: " + data.answer;
    speakAnswer(data.answer, id);
  } catch (error) {
    if (id !== runId) return;
    const timedOut = error.name === "AbortError";
    console.error(error);
    setOrbState(
      "error",
      timedOut
        ? "The AI took too long. Tap the Orb to try again."
        : (error.message || "Couldn't reach the AI.") + " Try again."
    );
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }
}

// ---------- Listening ----------

function startListening() {
  if (!SpeechRecognition) {
    setOrbState(
      "error",
      "Speech recognition isn't supported in this browser. Please type your message."
    );
    chatInput.focus();
    return;
  }

  if (state === "thinking") return;

  // Tapping while listening ends the recording and sends what was heard.
  if (state === "listening" && recognition) {
    recognition.stop();
    return;
  }

  // Tapping while speaking interrupts and listens (barge-in).
  runId++;
  const id = runId;
  window.speechSynthesis?.cancel();

  const rec = new SpeechRecognition();
  recognition = rec;
  rec.lang = LANG;
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    if (id === runId) setOrbState("listening", "Listening... Speak now.");
  };

  rec.onresult = (event) => {
    if (id !== runId) return;
    const message = event.results[0][0].transcript.trim();
    if (!message) return;
    transcript.textContent = "You: " + message;
    recognition = null;
    askAI(message); // bumps runId, so this recognizer's onend is ignored
  };

  rec.onerror = (event) => {
    if (id !== runId || event.error === "aborted") return;
    recognition = null;
    setOrbState(
      "error",
      VOICE_ERRORS[event.error] || "Voice error: " + event.error + ". Try again."
    );
  };

  rec.onend = () => {
    if (id !== runId) return;
    recognition = null;
    if (state === "listening") {
      setOrbState("idle", "Ready. Tap the Orb to speak.");
    }
  };

  try {
    rec.start();
  } catch {
    recognition = null;
    setOrbState("error", "Couldn't start the microphone. Try again.");
  }
}

// ---------- Events ----------

micButton.addEventListener("click", startListening);
orb.addEventListener("click", startListening);
orb.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    startListening();
  }
});

stopButton.addEventListener("click", () => {
  stopAll("Stopped. Ready when you are.");
});

chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;

  window.speechSynthesis?.cancel();
  if (recognition) {
    try { recognition.abort(); } catch { /* already stopped */ }
    recognition = null;
  }
  chatInput.value = "";
  transcript.textContent = "You: " + message;
  askAI(message);
});

setOrbState("idle", "Ready. Tap the Orb to speak.");
