import { useState, useEffect, useRef, useCallback } from "react";
import {
  Eye, EyeOff, Check, X, Mic, MicOff, Plus, RefreshCw, LogIn, Github,
  Clock, Trash2, ChevronRight, Volume2, VolumeX, Loader, History, ArrowLeft, ExternalLink,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type Screen = "login" | "setup" | "dashboard" | "history";
type Urgency = "calm" | "mid" | "high";

interface CheckItem {
  id: string;
  text: string;
  done: boolean;
  auto: boolean;
  createdAt: number;
  difficulty: 1 | 2 | 3; // 1=easy, 2=medium, 3=hard
}

interface ProjectSetup {
  projectName: string;
  deadline: string;
  devpostUrl: string;
  githubUrl: string;
  tone: string;
  checkInterval: number; // minutes between auto check-ins, 0 = off
}

interface HistoryEntry {
  id: string;
  setup: ProjectSetup;
  essentials: CheckItem[];
  custom: CheckItem[];
  archivedAt: number;
}

interface AppState {
  screen: Screen;
  setup: ProjectSetup | null;
  essentials: CheckItem[];
  custom: CheckItem[];
  lastCheckIn: number | null;
  lastGitHubCheck: number | null;
}

// ─── Env — hardcoded fallbacks for sandbox environments ──────────────────────

const GEMINI_KEY: string = (
  (import.meta.env.VITE_GEMINI_API_KEY as string | undefined) ??
  "AQ.Ab8RN6JV4cc96ItKlEek-D1IWHDw_a5tMPQV5NYAKnf7sH7n6w"
).trim();

const GITHUB_TOKEN: string =
  (import.meta.env.VITE_GITHUB_TOKEN as string | undefined) ??
  "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";

const ELEVENLABS_KEY: string = (
  (import.meta.env.VITE_ELEVENLABS_API_KEY as string | undefined) ??
  "14869c1fcc699aa4d564aab029f9d8064a60c107a3038132cc07221e06b8e2e7"
).trim();

// Voice ID resolved at runtime from the account's voice list
let resolvedVoiceId: string =
  (import.meta.env.VITE_ELEVENLABS_VOICE_ID as string | undefined) ?? "";

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = "plusone_state_v5";

const ESSENTIALS_DEFAULT: CheckItem[] = [
  { id: "devpost",     text: "devpost submission created",        done: false, auto: false, createdAt: 0, difficulty: 2 },
  { id: "repo-public", text: "repo is public",                   done: false, auto: true,  createdAt: 0, difficulty: 1 },
  { id: "readme",      text: "readme written (not placeholder)", done: false, auto: true,  createdAt: 0, difficulty: 2 },
  { id: "demo-video",  text: "demo video link resolves",         done: false, auto: false, createdAt: 0, difficulty: 3 },
  { id: "prize-track", text: "submitted to correct prize track", done: false, auto: false, createdAt: 0, difficulty: 1 },
];

// ─── Palette ──────────────────────────────────────────────────────────────────

const TOKENS = {
  calm: {
    pageBg: "#f2ede3", border: "#dfd8cb", dot: "#6b8a6b",
    badgeBg: "#c8d8c0", badgeFg: "#3d5a3d", badgeLabel: "calm",
    statusFg: "#6b6358", checkFg: "#6b8a6b", missFg: "#b0a488",
    accentFg: "#6b8a6b", bannerBg: "", bannerFg: "", countdownFg: "#6b6358",
  },
  mid: {
    pageBg: "#f5ebe5", border: "#e8c4b0", dot: "#d4826a",
    badgeBg: "#f0c4b4", badgeFg: "#8b3a22", badgeLabel: "watching you",
    statusFg: "#7a4a38", checkFg: "#6b8a6b", missFg: "#c86a50",
    accentFg: "#c86a50", bannerBg: "rgba(240,196,180,0.50)", bannerFg: "#7a3525", countdownFg: "#c86a50",
  },
  high: {
    pageBg: "#f4e6e0", border: "#e09080", dot: "#c03a20",
    badgeBg: "#e8a090", badgeFg: "#5c150a", badgeLabel: "urgent",
    statusFg: "#5c150a", checkFg: "#6b8a6b", missFg: "#c03a20",
    accentFg: "#c03a20", bannerBg: "rgba(232,160,144,0.45)", bannerFg: "#5c150a", countdownFg: "#c03a20",
  },
};

// ─── Gemini ───────────────────────────────────────────────────────────────────

const DEFAULT_TONE = "dry and slightly sardonic, like a tired but genuinely caring teammate";

// Serializing queue with 429-aware backoff
// One call at a time; on 429 the whole queue pauses before the next attempt.
let llmQueue: Promise<unknown> = Promise.resolve();
let llmBackoff = 1000; // ms to wait between calls; doubles on 429, resets on success

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = llmQueue.then(async () => {
    await new Promise((r) => setTimeout(r, llmBackoff));
    try {
      const v = await fn();
      llmBackoff = 1000; // reset on success
      return v;
    } catch (err) {
      if ((err as { status?: number }).status === 429) {
        llmBackoff = Math.min(llmBackoff * 2, 30000); // double, cap at 30s
        console.warn(`[LLM] 429 — backing off to ${llmBackoff}ms`);
      }
      throw err;
    }
  });
  llmQueue = result.catch(() => {});
  return result;
}

async function callLLMRaw(prompt: string, maxTokens = 120): Promise<string> {
  const res = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.85,
      max_tokens: maxTokens,
    }),
  });

  if (res.status === 429) throw Object.assign(new Error("LLM 429"), { status: 429 });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub Models ${res.status}: ${body.slice(0, 120)}`);
  }

  const data = await res.json();
  const text: string | undefined = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`GitHub Models empty response: ${JSON.stringify(data)}`);
  return text.trim();
}

// All callers go through the queue; rating calls give up on 429 rather than retry
async function callGemini(prompt: string, maxTokens = 120): Promise<string> {
  return enqueue(() => callLLMRaw(prompt, maxTokens));
}

// Correct a raw speech transcript into a clean task item using surrounding context
async function correctSpeechTranscript(raw: string, existingItems: string[]): Promise<string> {
  const context = existingItems.length
    ? existingItems.slice(0, 8).map((t) => `- ${t}`).join("\n")
    : "none yet";
  const prompt = `You are correcting a voice-to-text transcript for a hackathon task list.

Existing tasks for context:
${context}

Raw transcript: "${raw}"

The user was adding a new task item by voice. Speech recognition may have misheard words. Based on the existing tasks and common hackathon terminology, return ONLY the corrected task text — no quotes, no explanation, no prefix like "add" or "task:". Just the clean task name. If the transcript already makes sense, return it unchanged.`;
  try {
    const result = await enqueue(() => callLLMRaw(prompt, 60));
    return result.trim() || raw;
  } catch {
    return raw;
  }
}

// Single call returning both messages to halve request count
async function generateMessages(
  urgency: Urgency,
  undoneItems: CheckItem[],
  timeLeft: string,
  tone: string,
  interruptHistory: { count: number; minutesSinceLast: number | null },
): Promise<{ status: string; interrupt: string | null }> {
  const itemList = undoneItems.length
    ? undoneItems.slice(0, 5).map((i) => `- ${i.text}`).join("\n")
    : "none — all checked off";

  const needsInterrupt = urgency !== "calm";

  const historyLine = interruptHistory.count === 0
    ? "This is the first nudge this session."
    : `This is nudge #${interruptHistory.count + 1} this session${interruptHistory.minutesSinceLast !== null ? `, ${interruptHistory.minutesSinceLast}m since the last one` : ""}. If the same items are still unchecked, let the tone reflect that — more clipped and less patient, not a fresh introduction.`;

  const prompt = `You are Plus One, a solo hackathon co-pilot sidebar. Reply with ONLY a JSON object — no markdown, no code fences, no explanation.

Tone: ${tone || DEFAULT_TONE}
Urgency: ${urgency} (calm = quiet/reassuring, mid = nudging/concerned, high = stop-everything urgent)
Time remaining: ${timeLeft}
Unchecked items:
${itemList}
Interrupt history: ${historyLine}

Return exactly this shape:
{
  "status": "<1–2 sentence status shown below the header, all lowercase>",
  "interrupt": ${needsInterrupt ? '"<1 sentence nudge shown in top banner, all lowercase>"' : "null"}
}

Rules: all text lowercase, no trailing punctuation, no quotes inside the strings, do not repeat the word "left" (time already includes it).`;

  const raw = await callGemini(prompt);

  // Strip accidental markdown fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(cleaned) as { status: string; interrupt: string | null };

  return {
    status: parsed.status?.trim() ?? "",
    interrupt: parsed.interrupt?.trim() ?? null,
  };
}

// Rate a single task text → 1/2/3, or null if uncertain/failed
// Rate one or many items in a single LLM call — returns array aligned to input
async function rateItemsDifficulty(texts: string[]): Promise<(1 | 2 | 3 | null)[]> {
  if (!texts.length) return [];
  try {
    const numbered = texts.map((t, i) => `${i + 1}. "${t}"`).join("\n");
    const raw = await callGemini(
      `Rate each hackathon task for a solo developer. Reply with ONLY a comma-separated list of digits (1=easy <30min, 2=medium 30-90min, 3=hard 2h+), one per task, nothing else.\n\n${numbered}`,
      texts.length * 3
    );
    const digits = raw.replace(/[^1-3,]/g, "").split(",");
    return texts.map((_, i) => {
      const n = parseInt(digits[i] ?? "", 10);
      return (n === 1 || n === 2 || n === 3) ? n : null;
    });
  } catch {
    return texts.map(() => null);
  }
}

// ─── List/doc parser ─────────────────────────────────────────────────────────

function parseImportedList(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  return lines
    .map((l) =>
      l
        .replace(/^[-*•]\s+\[.\]\s*/i, "") // - [ ] / - [x]
        .replace(/^[-*•]\s+/, "")           // - item / * item
        .replace(/^\d+[.)]\s+/, "")         // 1. item / 1) item
        .replace(/^\s*#+\s+/, "")           // ## heading → treat as item
        .trim()
    )
    .filter((l) => l.length > 0 && l.length < 200);
}

// ─── Static fallbacks (used while Gemini loads or if it fails) ───────────────

function fallbackStatus(urgency: Urgency, undoneCount: number, timeLeft: string): string {
  if (urgency === "calm") {
    if (undoneCount === 0) return "everything's checked off. go touch grass for five minutes.";
    if (undoneCount === 1) return `one item left. you've got time. ${timeLeft} on the clock.`;
    return `${undoneCount} items outstanding. looking fine. checking back in a few.`;
  }
  if (urgency === "mid") {
    if (undoneCount === 0) return `checklist is clean. ${timeLeft} — hold the line.`;
    if (undoneCount === 1) return "one thing still open and the clock is running. finish it.";
    return `${undoneCount} unchecked. ${timeLeft}. time to stop adding features.`;
  }
  if (undoneCount === 0) return `checklist is clear. ${timeLeft}. submit and breathe.`;
  if (undoneCount >= 3) return `${undoneCount} items open and ${timeLeft}. stop everything. work the list.`;
  return `${undoneCount} ${undoneCount === 1 ? "item" : "items"} unfinished. ${timeLeft}. this is not a drill.`;
}

function fallbackInterrupt(urgency: Urgency, undoneItems: CheckItem[]): string {
  if (urgency === "mid") {
    if (undoneItems.length === 0) return "checklist looks good. just keep an eye on the clock.";
    return `"${undoneItems[0].text}" is still open. that one matters.`;
  }
  if (undoneItems.length === 0) return "all checked. hit submit before you change anything.";
  const names = undoneItems.slice(0, 2).map((i) => `"${i.text}"`).join(" and ");
  return `${names} ${undoneItems.length === 1 ? "is" : "are"} still missing. judges will notice.`;
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

function msToHuman(ms: number): string {
  if (ms <= 0) return "time's up";
  const totalSecs = Math.floor(ms / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

// Each difficulty point ≈ 45 min of work; urgency escalates when workload/time ratio is high
function computeUrgency(ms: number, undoneItems: CheckItem[]): Urgency {
  const hours = Math.max(ms / 3600000, 0.01);
  const effortHours = undoneItems.reduce((sum, i) => sum + i.difficulty * 0.75, 0);
  const ratio = effortHours / hours;

  if (hours <= 1 || ratio >= 1.5) return "high";
  if (hours <= 4 || ratio >= 0.6) return "mid";
  return "calm";
}

function relativeTime(ts: number | null): string {
  if (!ts) return "never";
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ─── GitHub integration ───────────────────────────────────────────────────────

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  try {
    const u = new URL(url.trim());
    if (!u.hostname.includes("github.com")) return null;
    const parts = u.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

async function checkGitHubRepo(
  githubUrl: string,
): Promise<{ isPublic: boolean | null; hasReadme: boolean | null; error?: string }> {
  if (!GITHUB_TOKEN) return { isPublic: null, hasReadme: null, error: "no token" };
  const parsed = parseGitHubRepo(githubUrl);
  if (!parsed) return { isPublic: null, hasReadme: null, error: "invalid url" };

  const headers: HeadersInit = {
    Authorization: `token ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
  };

  try {
    const repoRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers });
    if (repoRes.status === 401) return { isPublic: null, hasReadme: null, error: "bad token (401)" };
    if (repoRes.status === 403) return { isPublic: null, hasReadme: null, error: "forbidden (403)" };
    if (repoRes.status === 404) return { isPublic: null, hasReadme: null, error: `repo not found: ${parsed.owner}/${parsed.repo}` };
    if (!repoRes.ok) return { isPublic: null, hasReadme: null, error: `github ${repoRes.status}` };

    const repoData = await repoRes.json() as { private: boolean };
    const isPublic = !repoData.private;

    const readmeRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/README.md`, { headers });
    const hasReadme = readmeRes.ok;

    return { isPublic, hasReadme };
  } catch (err) {
    return { isPublic: null, hasReadme: null, error: err instanceof Error ? err.message : "network error" };
  }
}

// ─── ElevenLabs integration ───────────────────────────────────────────────────

let currentAudio: HTMLAudioElement | null = null;
let speakCounter = 0;

function elHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "xi-api-key": ELEVENLABS_KEY, ...extra };
}

async function resolveVoiceId(): Promise<string> {
  if (resolvedVoiceId) return resolvedVoiceId;
  console.log("[ElevenLabs] key length:", ELEVENLABS_KEY.length, "first4:", ELEVENLABS_KEY.slice(0, 4));
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: elHeaders(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs voices ${res.status} — ${body.slice(0, 120)}`);
  }
  const data = await res.json() as { voices: { voice_id: string; name: string }[] };
  if (!data.voices?.length) throw new Error("No voices on this ElevenLabs account");
  const rachel = data.voices.find((v) => v.name === "Rachel");
  resolvedVoiceId = (rachel ?? data.voices[0]).voice_id;
  console.log("[ElevenLabs] using voice:", (rachel ?? data.voices[0]).name, resolvedVoiceId);
  return resolvedVoiceId;
}

async function speakText(text: string): Promise<void> {
  const token = ++speakCounter;

  // Stop whatever is playing unconditionally before any await
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }

  const voiceId = await resolveVoiceId();
  if (token !== speakCounter) return;

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: elHeaders({ "Content-Type": "application/json", Accept: "audio/mpeg" }),
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.45, similarity_boost: 0.75 },
    }),
  });
  if (token !== speakCounter) return;

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 150)}`);
  }

  const blob = await res.blob();
  if (token !== speakCounter) return;

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  audio.onended = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; };
  await audio.play();
}

// ─── LocalStorage ─────────────────────────────────────────────────────────────

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AppState;
      // Guard against old stored state missing fields
      if (!Array.isArray(parsed.essentials)) parsed.essentials = ESSENTIALS_DEFAULT;
      if (!Array.isArray(parsed.custom)) parsed.custom = [];
      return parsed;
    }
  } catch {}
  return { screen: "login", setup: null, essentials: ESSENTIALS_DEFAULT, custom: [], lastCheckIn: null, lastGitHubCheck: null };
}

function saveState(s: AppState) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
}

const HISTORY_KEY = "plusone_history_v1";

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as HistoryEntry[]) : [];
  } catch { return []; }
}

function saveHistory(entries: HistoryEntry[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(entries)); } catch {}
}

function archiveProject(setup: ProjectSetup, essentials: CheckItem[], custom: CheckItem[]) {
  const entries = loadHistory();
  entries.unshift({ id: Date.now().toString(), setup, essentials, custom, archivedAt: Date.now() });
  saveHistory(entries);
}

// ─── Login ────────────────────────────────────────────────────────────────────

function LoginScreen({ onNext }: { onNext: () => void }) {
  const [blinking, setBlinking] = useState(false);
  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    function blink() {
      setBlinking(true);
      timeout = setTimeout(() => {
        setBlinking(false);
        timeout = setTimeout(blink, 2500 + Math.random() * 2500);
      }, 150);
    }
    timeout = setTimeout(blink, 1000);
    return () => clearTimeout(timeout);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center px-8" style={{ background: "#f2ede3", fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-full max-w-[340px] flex flex-col items-center gap-9">
        <div className="relative">
          <div className="w-24 h-24 rounded-full flex items-center justify-center" style={{ background: "#c8d8c0" }}>
            <Eye
              size={36}
              strokeWidth={1.4}
              style={{
                color: "#2c2722",
                transform: blinking ? "scaleY(0.08)" : "scaleY(1)",
                transition: blinking ? "transform 0.06s ease-in" : "transform 0.09s ease-out",
                display: "block",
              }}
            />
          </div>
          <div className="absolute top-3 right-3 w-3 h-3 rounded-full" style={{ background: "#6b8a6b" }} />
        </div>
        <div className="text-center flex flex-col gap-2">
          <h1 className="lowercase tracking-tight" style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 400, fontSize: "2.25rem", color: "#2c2722", lineHeight: 1.1 }}>
            plus one
          </h1>
          <p className="text-center leading-snug" style={{ color: "#6b6358", fontSize: "0.875rem", maxWidth: "270px" }}>
            the teammate you didn&apos;t have to split credit with
          </p>
        </div>
        <div className="w-full flex flex-col items-center gap-3">
          <button onClick={onNext} className="w-full flex items-center justify-center gap-2.5 rounded-2xl py-4 text-sm font-medium transition-opacity hover:opacity-90 active:opacity-80" style={{ background: "#2c2722", color: "#f2ede3" }}>
            add your plus one
          </button>
          <p className="text-xs italic" style={{ color: "#9a9088" }}>it&apos;s already judging your repo name.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

const CHECK_INTERVAL_OPTIONS = [
  { label: "off", value: 0 },
  { label: "1 min", value: 1 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1 hr", value: 60 },
  { label: "2 hr", value: 120 },
];

function SetupScreen({ initial, onNext, onBack }: { initial: ProjectSetup | null; onNext: (s: ProjectSetup) => void; onBack: () => void }) {
  const [projectName, setProjectName] = useState(initial?.projectName ?? "");
  const [deadline, setDeadline] = useState(initial?.deadline ?? "");
  const [devpostUrl, setDevpostUrl] = useState(initial?.devpostUrl ?? "");
  const [githubUrl, setGithubUrl] = useState(initial?.githubUrl ?? "");
  const [tone, setTone] = useState(initial?.tone ?? "");
  const [checkInterval, setCheckInterval] = useState(initial?.checkInterval ?? 30);
  const canSubmit = projectName.trim().length > 0 && deadline.length > 0;

  const inputBase: React.CSSProperties = { background: "#ece7dc", border: "1px solid #d9d2c5", color: "#2c2722", fontFamily: "'DM Sans', sans-serif", fontSize: "0.875rem", borderRadius: "12px", padding: "12px 16px", width: "100%", outline: "none" };

  return (
    <div className="min-h-screen flex items-center justify-center px-8 py-12" style={{ background: "#f2ede3", fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-full max-w-[360px]">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full" style={{ background: "#6b8a6b" }} />
            <span className="text-xs font-medium" style={{ color: "#9a9088" }}>plus one</span>
          </div>
          <h2 className="lowercase" style={{ fontSize: "1.5rem", fontWeight: 400, color: "#2c2722", lineHeight: 1.2 }}>let&apos;s set the clock.</h2>
          <p className="mt-1.5 text-xs" style={{ color: "#9a9088" }}>everything runs off your deadline.</p>
        </div>
        <div className="flex flex-col gap-5">
          {[
            { label: "project name", value: projectName, setter: setProjectName, type: "text", placeholder: "what are you building" },
          ].map(({ label, value, setter, type, placeholder }) => (
            <div key={label}>
              <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: "#9a9088", fontWeight: 500 }}>{label}</label>
              <input type={type} value={value} onChange={(e) => setter(e.target.value)} placeholder={placeholder} style={inputBase} className="placeholder-[#b0a89e]" />
            </div>
          ))}
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: "#9a9088", fontWeight: 500 }}>submission deadline</label>
            <input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} style={inputBase} />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: "#9a9088", fontWeight: 500 }}>
              github url <span className="normal-case" style={{ color: "#b0a89e", fontWeight: 400 }}>(used for auto-checks)</span>
            </label>
            <input type="url" value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} placeholder="https://github.com/you/repo" style={inputBase} className="placeholder-[#b0a89e]" />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: "#9a9088", fontWeight: 500 }}>
              devpost url <span className="normal-case" style={{ color: "#b0a89e", fontWeight: 400 }}>(optional)</span>
            </label>
            <input type="url" value={devpostUrl} onChange={(e) => setDevpostUrl(e.target.value)} placeholder="https://devpost.com/..." style={inputBase} className="placeholder-[#b0a89e]" />
          </div>
          <div>
            <label className="block text-xs uppercase tracking-wider mb-1.5" style={{ color: "#9a9088", fontWeight: 500 }}>
              how should i talk to you?{" "}
              <span className="normal-case" style={{ color: "#b0a89e", fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              type="text"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              placeholder={`default: "${DEFAULT_TONE}"`}
              style={inputBase}
              className="placeholder-[#b0a89e]"
            />
          </div>

          <div>
            <label className="block text-xs uppercase tracking-wider mb-2" style={{ color: "#9a9088", fontWeight: 500 }}>
              auto check-in <span className="normal-case" style={{ color: "#b0a89e", fontWeight: 400 }}>(how often should i speak up?)</span>
            </label>
            <div className="flex gap-2">
              {CHECK_INTERVAL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setCheckInterval(opt.value)}
                  className="flex-1 py-2 text-xs rounded-xl transition-colors"
                  style={{
                    background: checkInterval === opt.value ? "#2c2722" : "#ece7dc",
                    color: checkInterval === opt.value ? "#f2ede3" : "#9a9088",
                    border: "1px solid #d9d2c5",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button onClick={() => canSubmit && onNext({ projectName: projectName.trim(), deadline, devpostUrl, githubUrl, tone: tone.trim(), checkInterval })} disabled={!canSubmit}
            className="w-full mt-1 py-4 rounded-xl text-sm font-medium transition-opacity"
            style={{ background: canSubmit ? "#2c2722" : "#c0b8ae", color: "#f2ede3", cursor: canSubmit ? "pointer" : "not-allowed" }}>
            start getting watched
          </button>
        </div>
        <button onClick={onBack} className="mt-5 w-full text-center text-xs hover:opacity-70 transition-opacity" style={{ color: "#9a9088" }}>← back</button>
      </div>
    </div>
  );
}

// ─── Checklist item ───────────────────────────────────────────────────────────

const DIFF_COLORS: Record<1 | 2 | 3, string> = { 1: "#6b8a6b", 2: "#c28040", 3: "#c03a20" };
const DIFF_LABELS: Record<1 | 2 | 3, string> = { 1: "easy", 2: "medium", 3: "hard" };

function ChecklistItem({ item, onToggle, onDelete, onDifficulty, checkColor, missColor, deletable, isRating, needsRating }: {
  item: CheckItem; onToggle: () => void; onDelete?: () => void; onDifficulty?: (d: 1 | 2 | 3) => void;
  checkColor: string; missColor: string; deletable?: boolean;
  isRating?: boolean; needsRating?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const diff = (item.difficulty ?? 2) as 1 | 2 | 3;
  return (
    <div className="flex flex-col gap-1 py-0.5">
      <div className="flex items-center gap-2.5 group" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <button onClick={onToggle} className="flex items-center gap-2.5 flex-1 text-left min-w-0">
          <span className="flex-shrink-0 transition-colors duration-300" style={{ color: item.done ? checkColor : missColor }}>
            {item.done ? <Check size={15} strokeWidth={2.5} /> : <X size={14} strokeWidth={2.5} />}
          </span>
          <span className="text-sm flex-1 truncate transition-colors duration-200"
            style={{ color: item.done ? "#9a9088" : "#2c2722", textDecorationLine: item.done ? "line-through" : "none", textDecorationColor: "#c0b8ae", fontFamily: "'DM Sans', sans-serif" }}>
            {item.text}
          </span>
        </button>

        {/* Difficulty pips or rating spinner */}
        {!item.done && (
          isRating ? (
            <Loader size={10} className="animate-spin flex-shrink-0" style={{ color: "#b0a89e" }} />
          ) : (
            <button
              onClick={() => onDifficulty?.(((diff % 3) + 1) as 1 | 2 | 3)}
              title={`difficulty: ${DIFF_LABELS[diff]} — click to change`}
              className="flex-shrink-0 flex items-center gap-0.5 transition-opacity"
              style={{ opacity: hovered || diff !== 2 || needsRating ? 1 : 0.35 }}
            >
              {Array.from({ length: 3 }, (_, i) => (
                <span key={i} className="w-1 h-1 rounded-full" style={{ background: i < diff ? DIFF_COLORS[diff] : "#dfd8cb" }} />
              ))}
            </button>
          )
        )}

        {item.auto && !deletable && (
          <span className="text-[10px] flex-shrink-0 transition-opacity" style={{ color: "#b0a89e", opacity: hovered ? 1 : 0 }}>auto</span>
        )}
        {deletable && onDelete && (
          <button onClick={onDelete} className="flex-shrink-0 transition-opacity" style={{ color: "#c0b8ae", opacity: hovered ? 1 : 0 }}>
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Manual difficulty picker — shown when AI couldn't rate */}
      {needsRating && !item.done && onDifficulty && (
        <div className="flex items-center gap-1.5 pl-6">
          <span className="text-[10px]" style={{ color: "#b0a89e" }}>how hard is this?</span>
          {([1, 2, 3] as const).map((d) => (
            <button
              key={d}
              onClick={() => onDifficulty(d)}
              className="text-[10px] px-2 py-0.5 rounded-full transition-opacity hover:opacity-80"
              style={{ background: DIFF_COLORS[d] + "22", color: DIFF_COLORS[d], border: `1px solid ${DIFF_COLORS[d]}44` }}
            >
              {DIFF_LABELS[d]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function DashboardScreen({ setup, essentials, setEssentials, custom, setCustom, lastCheckIn, lastGitHubCheck, onCheckIn, onGitHubCheck, onReset, onEditSetup, onViewHistory, onExtendDeadline }: {
  setup: ProjectSetup; essentials: CheckItem[]; setEssentials: (i: CheckItem[]) => void;
  custom: CheckItem[]; setCustom: (i: CheckItem[]) => void;
  lastCheckIn: number | null; lastGitHubCheck: number | null;
  onCheckIn: () => void; onGitHubCheck: (ts: number) => void; onReset: () => void; onEditSetup: () => void; onViewHistory: () => void;
  onExtendDeadline: (deadline: string) => void;
}) {
  const [newItem, setNewItem] = useState("");
const [pasteToast, setPasteToast] = useState<string | null>(null);
  const pasteToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // IDs of items currently being AI-rated
  const [ratingIds, setRatingIds] = useState<Set<string>>(new Set());
  // IDs of items where AI rating failed and user needs to pick
  const [needsRatingIds, setNeedsRatingIds] = useState<Set<string>>(new Set());
  const [listening, setListening] = useState(false);
  const [alwaysOn, setAlwaysOn] = useState(false);
  const [wakeToast, setWakeToast] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [speakError, setSpeakError] = useState<string | null>(null);
  const [ghStatus, setGhStatus] = useState<string | null>(null);
  const [ghLoading, setGhLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Gemini-generated copy (null = use fallback while loading)
  const [geminiStatus, setGeminiStatus] = useState<string | null>(null);
  const [geminiInterrupt, setGeminiInterrupt] = useState<string | null>(null);
  const [geminiLoading, setGeminiLoading] = useState(false);
  const prevUrgency = useRef<Urgency | null>(null);
  const geminiUrgencyRef = useRef<Urgency | null>(null);
  const interruptHistoryRef = useRef<{ timestamp: number; urgency: Urgency }[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const wakeRecRef = useRef<SpeechRecognition | null>(null);
  const alwaysOnRef = useRef(false);
  const wakeToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customRef = useRef(custom);
  const checkInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  customRef.current = custom;

  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const msLeft = Math.max(0, new Date(setup.deadline).getTime() - now);
  const timesUp = new Date(setup.deadline).getTime() <= now;
  const timeLeftStr = msToHuman(msLeft);
  const allItems = [...essentials, ...custom];
  const undoneItems = allItems.filter((i) => !i.done);
  const urgency = msLeft > 0 ? computeUrgency(msLeft, undoneItems) : "high";
  const tk = TOKENS[urgency];
  const tone = setup.tone || DEFAULT_TONE;

  const [newDeadline, setNewDeadline] = useState("");
  const [showDeadlineInput, setShowDeadlineInput] = useState(false);
  const [checkInActive, setCheckInActive] = useState(false);

  // Displayed copy: Gemini result if ready, else static fallback
  const statusMsg = geminiStatus ?? fallbackStatus(urgency, undoneItems.length, timeLeftStr);
  const interruptMsg = urgency !== "calm"
    ? (geminiInterrupt ?? fallbackInterrupt(urgency, undoneItems))
    : null;
  // checkInActive = show statusMsg; otherwise interruptMsg takes priority
  const displayedMsg = checkInActive ? statusMsg : (interruptMsg ?? statusMsg);

  useEffect(() => { document.title = `Plus One — ${timeLeftStr}`; }, [timeLeftStr]);

  function getInterruptHistory() {
    const history = interruptHistoryRef.current;
    const last = history.length ? history[history.length - 1] : null;
    return {
      count: history.length,
      minutesSinceLast: last ? Math.round((Date.now() - last.timestamp) / 60000) : null,
    };
  }

  function recordInterrupt(u: Urgency) {
    interruptHistoryRef.current = [...interruptHistoryRef.current, { timestamp: Date.now(), urgency: u }];
  }

  // Single Gemini call returns both status + interrupt
  async function refreshGemini(forceUndone?: CheckItem[]) {
    if (geminiLoading) return;
    const items = forceUndone ?? undoneItems;
    setGeminiLoading(true);
    try {
      const { status, interrupt } = await generateMessages(urgency, items, timeLeftStr, tone, getInterruptHistory());
      if (status) setGeminiStatus(status);
      setGeminiInterrupt(interrupt);
      geminiUrgencyRef.current = urgency;
    } catch (err) {
      console.error("[Gemini]", err);
    } finally {
      setGeminiLoading(false);
    }
  }

  useEffect(() => {
    if (urgency !== geminiUrgencyRef.current) {
      setGeminiStatus(null);
      setGeminiInterrupt(null);
      refreshGemini();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urgency]);

  // Auto-check GitHub on load if URL is set and not checked in last 5min
  useEffect(() => {
    if (!setup.githubUrl) return;
    const stale = !lastGitHubCheck || Date.now() - lastGitHubCheck > 5 * 60 * 1000;
    if (stale) runGitHubCheck();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Document-level paste → auto-detect multi-line lists anywhere on page
  useEffect(() => {
    function onDocPaste(e: ClipboardEvent) {
      const active = document.activeElement;
      // If user is already in an input/textarea, let the input's own handler deal with it
      if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      const lines = parseImportedList(text);
      if (lines.length < 2) return;
      e.preventDefault();
      bulkAddWithRating(lines);
    }
    document.addEventListener("paste", onDocPaste);
    return () => document.removeEventListener("paste", onDocPaste);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Wake-word: "hey one, add X [to my list]" ──────────────────────────────
  const [wakeError, setWakeError] = useState<string | null>(null);

  function getSR() {
    const w = window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  const [wakeListening, setWakeListening] = useState(false); // true = capturing command (post-beep)
  const wakeListeningRef = useRef(false);

  // Short beep to signal "I heard the wake word, now say your item"
  function playBeep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.start(); osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }

  // Stage 2: dedicated session that captures just the item text (no wake word noise)
  const captureRef = useRef<() => void>(() => {});
  captureRef.current = () => {
    const SR = getSR();
    if (!SR || !alwaysOnRef.current) return;
    wakeListeningRef.current = true;
    setWakeListening(true);
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 5;
    rec.onresult = (e) => {
      // Use the highest-confidence alternative
      let best = "";
      for (let a = 0; a < e.results[0].length; a++) {
        const t = e.results[0][a].transcript.trim();
        if (t.length > best.length) best = t;
      }
      const raw = best
        .replace(/^(add|at|and|had|add a|add an)\s+/i, "")
        .replace(/\s+to\s+(my\s+|the\s+)?list\s*$/i, "")
        .replace(/\s+on\s+(my\s+|the\s+)?list\s*$/i, "")
        .trim();
      if (raw.length > 1) {
        // Add optimistically with raw text, then correct in background
        const entry = makeEntry(raw);
        setCustom([...customRef.current, entry]);
        rateAndUpdate([{ id: entry.id, text: entry.text }]);
        setWakeToast(`added "${raw}"`);
        if (wakeToastTimer.current) clearTimeout(wakeToastTimer.current);
        wakeToastTimer.current = setTimeout(() => setWakeToast(null), 3500);
        // Correct the transcript using LLM context
        const existingTexts = customRef.current.map((i) => i.text);
        correctSpeechTranscript(raw, existingTexts).then((corrected) => {
          if (corrected !== raw) {
            setCustom((prev) => prev.map((i) => i.id === entry.id ? { ...i, text: corrected } : i));
            setWakeToast(`added "${corrected}"`);
            if (wakeToastTimer.current) clearTimeout(wakeToastTimer.current);
            wakeToastTimer.current = setTimeout(() => setWakeToast(null), 3500);
          }
        });
      }
    };
    rec.onend = () => {
      wakeListeningRef.current = false;
      setWakeListening(false);
      if (alwaysOnRef.current) setTimeout(() => launchRef.current(), 80);
    };
    rec.onerror = () => {
      wakeListeningRef.current = false;
      setWakeListening(false);
      if (alwaysOnRef.current) setTimeout(() => launchRef.current(), 80);
    };
    try {
      wakeListeningRef.current = true;
      setWakeListening(true);
      rec.start();
      wakeRecRef.current = rec;
    } catch {
      wakeListeningRef.current = false;
      setWakeListening(false);
      if (alwaysOnRef.current) setTimeout(() => launchRef.current(), 300);
    }
  };

  // Stage 1: always-on wake detector — continuous, only checks for wake phrase
  const launchRef = useRef<() => void>(() => {});
  launchRef.current = () => {
    const SR = getSR();
    if (!SR) { setWakeError("SpeechRecognition not supported in this browser"); setAlwaysOn(false); alwaysOnRef.current = false; return; }
    if (!alwaysOnRef.current) return;

    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;

    let wakeTriggered = false; // prevent double-trigger within one session

    rec.onresult = (e) => {
      if (wakeTriggered) return;
      for (let r = e.resultIndex; r < e.results.length; r++) {
        for (let a = 0; a < e.results[r].length; a++) {
          const t = e.results[r][a].transcript.toLowerCase();
          const heard = wakes.some((w) => t.includes(w));
          if (heard) {
            console.log("[Wake] phrase detected:", t);
            wakeTriggered = true;
            try { rec.stop(); } catch {}
            playBeep();
            setTimeout(() => captureRef.current(), 200);
            return;
          }
        }
      }
    };

    rec.onend = () => {
      // no-speech and other timeouts: restart immediately if not mid-capture
      if (alwaysOnRef.current && !wakeListeningRef.current) setTimeout(() => launchRef.current(), 80);
    };

    rec.onerror = (e) => {
      console.error("[Wake] error:", e.error);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setWakeError("microphone permission denied");
        alwaysOnRef.current = false;
        setAlwaysOn(false);
      }
      // no-speech / network / audio-capture: onend fires next and restarts
    };

    try {
      rec.start();
      wakeRecRef.current = rec;
    } catch (err) {
      console.error("[Wake] start failed:", err);
      if (alwaysOnRef.current) setTimeout(() => launchRef.current(), 300);
    }
  };

  // Extract the wakes list so Stage 1 onresult can reference it
  const wakes = [
    "hey one", "hey won", "hey wan", "hey wun", "hey 1",
    "hay one", "hay won", "hay wan",
    "a one", "a won",
    "he won", "he one",
    "hey on", "hey own",
    "hi one", "hi won",
  ];

  // Stop the listener when alwaysOn turns off (no gesture needed to stop)
  useEffect(() => {
    if (!alwaysOn) {
      alwaysOnRef.current = false;
      try { wakeRecRef.current?.stop(); } catch {}
      wakeRecRef.current = null;
    }
  }, [alwaysOn]);

  // Request mic permission explicitly, then start — guarantees browser grant flow
  async function enableWakeWord() {
    setWakeError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Stop the tracks immediately — we just needed the grant
      stream.getTracks().forEach((t) => t.stop());
    } catch {
      setWakeError("microphone access denied — allow mic in browser settings and try again");
      return;
    }
    alwaysOnRef.current = true;
    setAlwaysOn(true);
    launchRef.current();
  }

  function disableWakeWord() {
    alwaysOnRef.current = false;
    setAlwaysOn(false);
  }

  // Speak interrupt when urgency escalates
  useEffect(() => {
    const prev = prevUrgency.current;
    prevUrgency.current = urgency;
    if (!prev) return; // skip on mount
    const escalated = (prev === "calm" && (urgency === "mid" || urgency === "high")) || (prev === "mid" && urgency === "high");
    if (escalated && interruptMsg) {
      recordInterrupt(urgency);
      triggerSpeak(interruptMsg);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urgency]);

  async function runGitHubCheck() {
    if (!setup.githubUrl || ghLoading) return;
    setGhLoading(true);
    setGhStatus(null);
    const result = await checkGitHubRepo(setup.githubUrl);
    setGhLoading(false);
    onGitHubCheck(Date.now());

    if (result.error) {
      setGhStatus(`github error: ${result.error}`);
      console.error("[GitHub]", result.error);
      return;
    }

    setEssentials(essentials.map((item) => {
      if (item.id === "repo-public" && result.isPublic !== null) return { ...item, done: result.isPublic };
      if (item.id === "readme" && result.hasReadme !== null) return { ...item, done: result.hasReadme };
      return item;
    }));
    setGhStatus("github checked just now");
  }

  async function triggerSpeak(text: string) {
    setSpeaking(true);
    setSpeakError(null);
    try {
      await speakText(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSpeakError(msg);
      console.error("[ElevenLabs]", msg);
    } finally {
      setSpeaking(false);
    }
  }

  async function handleCheckIn() {
    onCheckIn();
    if (urgency !== "calm") recordInterrupt(urgency);
    const fallback = fallbackStatus(urgency, undoneItems.length, timeLeftStr);
    triggerSpeak(fallback);
    // Show status result for 20s, suppressing any interrupt
    if (checkInTimerRef.current) clearTimeout(checkInTimerRef.current);
    setCheckInActive(true);
    checkInTimerRef.current = setTimeout(() => setCheckInActive(false), 20000);
    try {
      const { status, interrupt } = await generateMessages(urgency, undoneItems, timeLeftStr, tone, getInterruptHistory());
      if (status) { setGeminiStatus(status); triggerSpeak(status); }
      setGeminiInterrupt(interrupt);
    } catch {
      setGeminiStatus(fallback);
    }
  }

  // Auto check-in interval
  const [nextCheckAt, setNextCheckAt] = useState<number | null>(null);
  const handleCheckInRef = useRef(handleCheckIn);
  handleCheckInRef.current = handleCheckIn;

  useEffect(() => {
    const interval = setup.checkInterval ?? 0;
    if (!interval || timesUp) { setNextCheckAt(null); return; }
    const ms = interval * 60 * 1000;
    setNextCheckAt(Date.now() + ms);
    const id = setInterval(() => {
      handleCheckInRef.current();
      setNextCheckAt(Date.now() + ms);
    }, ms);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup.checkInterval, timesUp]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function makeEntry(text: string): CheckItem {
    return { id: `${Date.now()}-${Math.random()}`, text: text.trim(), done: false, auto: false, createdAt: Date.now(), difficulty: 2 };
  }

  // Rate one or more items in a single batched LLM call
  function rateAndUpdate(entries: { id: string; text: string }[]) {
    if (!entries.length) return;
    setRatingIds((prev) => { const s = new Set(prev); entries.forEach((e) => s.add(e.id)); return s; });
    rateItemsDifficulty(entries.map((e) => e.text)).then((ratings) => {
      setRatingIds((prev) => { const s = new Set(prev); entries.forEach((e) => s.delete(e.id)); return s; });
      const updates = new Map(entries.map((e, i) => [e.id, ratings[i]]));
      const failed: string[] = [];
      updates.forEach((rating, id) => { if (rating === null) failed.push(id); });
      setCustom(customRef.current.map((i) => {
        const r = updates.get(i.id);
        return r != null ? { ...i, difficulty: r } : i;
      }));
      if (failed.length) setNeedsRatingIds((prev) => { const s = new Set(prev); failed.forEach((id) => s.add(id)); return s; });
    });
  }

  function showPasteToast(count: number) {
    if (pasteToastTimer.current) clearTimeout(pasteToastTimer.current);
    setPasteToast(`${count} item${count === 1 ? "" : "s"} added`);
    pasteToastTimer.current = setTimeout(() => setPasteToast(null), 2500);
  }

  function bulkAddWithRating(lines: string[]) {
    if (!lines.length) return;
    const entries = lines.map(makeEntry);
    setCustom([...customRef.current, ...entries]);
    setNewItem("");
    showPasteToast(entries.length);
    rateAndUpdate(entries.map((e) => ({ id: e.id, text: e.text })));
  }

  // Parse raw text into individual item strings — strips markdown bullets, numbering, empty lines
  function parseLines(raw: string): string[] {
    return raw
      .split(/\r?\n/)
      .map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
      .filter((l) => l.length > 0 && l.length < 200);
  }

  function addItem(text?: string) {
    const val = (text ?? newItem).trim();
    if (!val) return;
    const lines = parseLines(val);
    if (lines.length > 1) { bulkAddWithRating(lines); return; }
    const entry = makeEntry(val);
    setCustom([...customRef.current, entry]);
    setNewItem("");
    rateAndUpdate([{ id: entry.id, text: entry.text }]);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!text.includes("\n")) return; // single line — let default paste handle it
    e.preventDefault();
    bulkAddWithRating(parseImportedList(text));
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      bulkAddWithRating(parseImportedList(ev.target?.result as string));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function toggleMic() {
    const SR = getSR();
    if (!SR) return;
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => { addItem(e.results[0][0].transcript); };
    rec.onend = () => setListening(false);
    rec.start();
    recognitionRef.current = rec;
    setListening(true);
  }

  const progressDone = allItems.filter((i) => i.done).length;
  const progressTotal = allItems.length;
  const progressPct = progressTotal === 0 ? 0 : Math.round((progressDone / progressTotal) * 100);
  const hasGitHub = !!setup.githubUrl && !!parseGitHubRepo(setup.githubUrl);

  return (
    <>
    <style>{`
      .scroll-list::-webkit-scrollbar { width: 3px; }
      .scroll-list::-webkit-scrollbar-track { background: transparent; }
      .scroll-list::-webkit-scrollbar-thumb { background: #c8bfb5; border-radius: 99px; }
      .scroll-list { scrollbar-width: thin; scrollbar-color: #c8bfb5 transparent; }
    `}</style>
    <div className="min-h-screen flex items-start justify-center transition-colors duration-700" style={{ background: tk.pageBg, fontFamily: "'DM Sans', sans-serif" }}>

      {/* Time's up — full-screen overlay */}
      {timesUp && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center px-8" style={{ background: "#1e1a17" }}>
          {/* Ambient glow */}
          <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 40% at 50% 60%, rgba(107,138,107,0.12) 0%, transparent 70%)" }} />

          <div className="relative w-full max-w-md flex flex-col items-center gap-8 text-center">
            {/* Wordmark */}
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full" style={{ background: "#6b8a6b" }} />
              <span className="text-xs tracking-widest uppercase" style={{ color: "#6b8a6b" }}>plus one</span>
            </div>

            {/* Headline */}
            <div className="flex flex-col gap-3">
              <h1 className="text-5xl font-light tracking-tight" style={{ color: "#f2ede3", lineHeight: 1 }}>
                time's up.
              </h1>
              <p className="text-base leading-relaxed" style={{ color: "#6b5f56" }}>
                {undoneItems.length === 0
                  ? "everything's checked off. hope you hit submit."
                  : `${undoneItems.length} item${undoneItems.length === 1 ? "" : "s"} still open — did you get it in?`}
              </p>
              {progressTotal > 0 && (
                <p className="text-sm" style={{ color: "#4a3f38" }}>
                  {progressDone} of {progressTotal} done
                </p>
              )}
            </div>

            {/* Actions */}
            {showDeadlineInput ? (
              <div className="w-full flex flex-col gap-3">
                <input
                  type="datetime-local"
                  value={newDeadline}
                  onChange={(e) => setNewDeadline(e.target.value)}
                  className="w-full text-sm rounded-2xl px-4 py-3.5 focus:outline-none"
                  style={{ background: "#2c2722", color: "#f2ede3", border: "1px solid #3d3530", fontFamily: "'DM Sans', sans-serif" }}
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowDeadlineInput(false)}
                    className="flex-1 text-sm py-3.5 rounded-2xl transition-opacity hover:opacity-70"
                    style={{ background: "#2c2722", color: "#6b5f56", border: "1px solid #3d3530" }}
                  >
                    cancel
                  </button>
                  <button
                    disabled={!newDeadline}
                    onClick={() => {
                      if (!newDeadline) return;
                      onExtendDeadline(newDeadline);
                      setShowDeadlineInput(false);
                      setNewDeadline("");
                    }}
                    className="flex-1 text-sm py-3.5 rounded-2xl transition-opacity hover:opacity-80 disabled:opacity-30"
                    style={{ background: "#6b8a6b", color: "#f2ede3" }}
                  >
                    extend deadline
                  </button>
                </div>
              </div>
            ) : (
              <div className="w-full flex flex-col gap-3">
                <button
                  onClick={() => {
                    archiveProject(setup, essentials, custom);
                    onReset();
                  }}
                  className="w-full text-sm py-4 rounded-2xl transition-opacity hover:opacity-80"
                  style={{ background: "#6b8a6b", color: "#f2ede3" }}
                >
                  archive + start new project
                </button>
                <button
                  onClick={() => setShowDeadlineInput(true)}
                  className="w-full text-sm py-4 rounded-2xl transition-opacity hover:opacity-70"
                  style={{ background: "#2c2722", color: "#c8d8c0", border: "1px solid #3d3530" }}
                >
                  extend deadline
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="w-[400px] h-screen flex flex-col overflow-hidden transition-colors duration-700" style={{ borderLeft: `1px solid ${tk.border}`, borderRight: `1px solid ${tk.border}` }}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 transition-colors duration-700" style={{ borderBottom: `1px solid ${tk.border}` }}>
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors duration-700" style={{ background: tk.dot }} />
            <span className="text-sm font-medium truncate" style={{ color: "#2c2722" }}>{setup.projectName}</span>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 ml-2">
            <button onClick={onViewHistory} title="past projects" className="hover:opacity-60 transition-opacity" style={{ color: "#b0a89e" }}>
              <History size={14} />
            </button>
            <span className="text-xs font-medium px-3 py-1 rounded-full transition-colors duration-700" style={{ background: tk.badgeBg, color: tk.badgeFg }}>
              {tk.badgeLabel}
            </span>
          </div>
        </div>

        {/* Status / inline callout */}
        <div className="px-5 pt-5 pb-3 flex items-start gap-2">
          <p className="text-sm leading-relaxed transition-colors duration-500 flex-1"
            style={{ color: (!checkInActive && interruptMsg) ? tk.accentFg : tk.statusFg, fontStyle: (!checkInActive && interruptMsg) ? "italic" : "normal" }}>
            {displayedMsg}
          </p>
          {geminiLoading && <Loader size={11} className="animate-spin flex-shrink-0 mt-0.5" style={{ color: "#b0a89e" }} />}
        </div>

        {/* Progress bar */}
        <div className="px-5 pb-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: tk.border }}>
              <div className="h-full rounded-full transition-all duration-500" style={{ width: `${progressPct}%`, background: urgency === "calm" ? "#6b8a6b" : tk.accentFg }} />
            </div>
            <span className="text-xs flex-shrink-0" style={{ color: "#b0a89e" }}>{progressDone}/{progressTotal}</span>
          </div>
        </div>

        {/* Essentials */}
        <div className="flex flex-col flex-shrink-0" style={{ maxHeight: "calc(2 * 2.2rem + 3.5rem)" }}>
          <div className="px-5 flex items-center justify-between mb-3 flex-shrink-0">
            <span className="text-[10px] uppercase tracking-widest font-medium" style={{ color: "#b0a89e" }}>essentials</span>
            <div className="flex items-center gap-2">
              {setup.githubUrl && (
                <span className="text-[10px] truncate max-w-[120px]" style={{ color: "#c0b8ae" }} title={setup.githubUrl}>
                  {setup.githubUrl.replace("https://github.com/", "")}
                </span>
              )}
              {hasGitHub && (
                <button onClick={runGitHubCheck} disabled={ghLoading} className="flex items-center gap-1 text-[10px] transition-opacity hover:opacity-60 disabled:opacity-40" style={{ color: "#b0a89e" }}>
                  {ghLoading ? <Loader size={9} className="animate-spin" /> : <Github size={9} />}
                  {ghLoading ? "checking…" : ghStatus ?? "check"}
                </button>
              )}
            </div>
          </div>
          {ghStatus && ghStatus.includes("error") && (
            <div className="px-5 mb-3 text-[10px] leading-relaxed flex-shrink-0" style={{ color: "#c03a20" }}>
              {ghStatus}{" "}
              <button onClick={onEditSetup} className="underline hover:opacity-70">fix url →</button>
            </div>
          )}
          <div className="scroll-list overflow-y-auto min-h-0 px-5 flex flex-col gap-2.5 pb-1" style={{ maskImage: "linear-gradient(to bottom, black 70%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent 100%)" }}>
            {[...essentials.filter(i => !i.done), ...essentials.filter(i => i.done)].map((item) => (
              <ChecklistItem key={item.id} item={item}
                onToggle={() => setEssentials(essentials.map((i) => i.id === item.id ? { ...i, done: !i.done } : i))}
                onDifficulty={(d) => setEssentials(essentials.map((i) => i.id === item.id ? { ...i, difficulty: d } : i))}
                checkColor={tk.checkFg} missColor={tk.missFg} />
            ))}
          </div>
        </div>

        {/* Custom */}
        <div className="flex flex-col flex-1 min-h-0 pt-3">
          <div className="px-5 mb-3 flex-shrink-0">
            <span className="text-[10px] uppercase tracking-widest font-medium" style={{ color: "#b0a89e" }}>added by you</span>
          </div>
          <div className="scroll-list flex-1 overflow-y-auto min-h-0 px-5 pb-2" style={{ maskImage: "linear-gradient(to bottom, black 70%, transparent 100%)", WebkitMaskImage: "linear-gradient(to bottom, black 70%, transparent 100%)" }}>
            {custom.length === 0 && (
              <p className="text-xs italic mb-3" style={{ color: "#c0b8ae" }}>nothing yet. add below or use the mic.</p>
            )}
            <div className="flex flex-col gap-2.5">
              {[...custom.filter(i => !i.done), ...custom.filter(i => i.done)].map((item) => (
                <ChecklistItem key={item.id} item={item}
                  onToggle={() => setCustom(custom.map((i) => i.id === item.id ? { ...i, done: !i.done } : i))}
                  onDelete={() => { setCustom(custom.filter((i) => i.id !== item.id)); setNeedsRatingIds((prev) => { const s = new Set(prev); s.delete(item.id); return s; }); }}
                  onDifficulty={(d) => { setCustom(custom.map((i) => i.id === item.id ? { ...i, difficulty: d } : i)); setNeedsRatingIds((prev) => { const s = new Set(prev); s.delete(item.id); return s; }); }}
                  checkColor={tk.checkFg} missColor={tk.missFg} deletable
                  isRating={ratingIds.has(item.id)}
                  needsRating={needsRatingIds.has(item.id)} />
              ))}
            </div>
          </div>

          {/* Toasts */}
          {pasteToast && (
            <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs italic" style={{ background: tk.badgeBg, color: tk.badgeFg }}>
              ✓ {pasteToast} — rating difficulty…
            </div>
          )}
          {wakeToast && (
            <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs italic" style={{ background: tk.badgeBg, color: tk.badgeFg }}>
              ✓ {wakeToast}
            </div>
          )}
          {wakeError && (
            <div className="mx-5 mt-3 px-3 py-2 rounded-lg text-xs" style={{ background: "#fde8e8", color: "#c03a20" }}>
              {wakeError}
            </div>
          )}

          {/* Add item row */}
          <div className="flex items-center gap-3 mt-4 mx-5 mb-2 px-4 py-3 rounded-2xl flex-shrink-0" style={{ border: `1px solid ${tk.border}`, background: "rgba(44,39,34,0.03)" }}>
            <input type="text" value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              onPaste={handlePaste}
              placeholder={wakeListening ? "say your item now…" : alwaysOn ? "say \"hey one\" to add…" : listening ? "listening…" : "add an item or paste a list"}
              className="flex-1 bg-transparent text-sm focus:outline-none"
              style={{ color: "#2c2722", fontFamily: "'DM Sans', sans-serif", caretColor: tk.accentFg }} />
            <button onClick={() => addItem()} className="transition-opacity hover:opacity-60" style={{ color: "#9a9088" }}><Plus size={15} /></button>
            {/* File upload */}
            <input ref={fileInputRef} type="file" accept=".txt,.md,.csv,.text" className="hidden" onChange={handleFileUpload} />
            <button onClick={() => fileInputRef.current?.click()} title="import from file (.txt, .md, .csv)" className="transition-opacity hover:opacity-60" style={{ color: "#9a9088" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            {/* One-shot mic */}
            <button onClick={toggleMic} title="tap to dictate one item" className="transition-opacity hover:opacity-60" style={{ color: listening ? tk.accentFg : "#9a9088" }}>
              {listening ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
            {/* Always-on wake-word toggle */}
            <button
              onClick={() => alwaysOn ? disableWakeWord() : enableWakeWord()}
              title={alwaysOn ? "wake word active — say \"hey one\"" : "enable wake word"}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-full transition-colors"
              style={wakeListening
                ? { background: tk.accentFg + "22", color: tk.accentFg }
                : alwaysOn
                  ? { background: tk.badgeBg, color: tk.badgeFg }
                  : { background: "transparent", color: "#b0a89e" }}
            >
              {wakeListening
                ? <span className="w-1.5 h-1.5 rounded-full animate-ping inline-block" style={{ background: tk.accentFg }} />
                : alwaysOn
                  ? <span className="w-1.5 h-1.5 rounded-full animate-pulse inline-block" style={{ background: tk.dot }} />
                  : null}
              {wakeListening ? "say it…" : "hey one"}
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 mt-auto transition-colors duration-700" style={{ borderTop: `1px solid ${tk.border}` }}>
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "#b0a89e" }}>
              <Clock size={11} />
              <span>last check: {relativeTime(lastCheckIn)}</span>
            </div>
            {nextCheckAt && (
              <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "#c0b8ae" }}>
                <RefreshCw size={9} />
                <span>next auto: {(() => { const s = Math.max(0, Math.round((nextCheckAt - now) / 1000)); return s < 60 ? `${s}s` : `${Math.ceil(s / 60)}m`; })()}</span>
              </div>
            )}
            {speakError && (
              <span className="text-[10px] leading-tight" style={{ color: "#c03a20", maxWidth: "200px", wordBreak: "break-all" }}>
                🔊 {speakError}
              </span>
            )}
          </div>
          <button onClick={handleCheckIn} className="flex items-center gap-1.5 text-xs transition-opacity hover:opacity-60" style={{ color: "#9a9088" }}>
            {speaking ? <VolumeX size={11} /> : <RefreshCw size={11} />}
            how am i doing?
          </button>
        </div>

        {/* Countdown + edit project */}
        <div className="px-5 py-4 flex items-center justify-between transition-colors duration-700" style={{ borderTop: `1px solid ${tk.border}` }}>
          <p className="text-sm font-medium tabular-nums transition-colors duration-700" style={{ color: tk.countdownFg }}>{timeLeftStr}</p>
          <div className="flex items-center gap-3">
            <button onClick={onEditSetup} className="text-[10px] hover:opacity-70 transition-opacity" style={{ color: "#c0b8ae" }}>edit project</button>
            <button onClick={onReset} className="text-[10px] hover:opacity-70 transition-opacity" style={{ color: "#e0a090" }}>reset checklist</button>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}

// ─── History Screen ───────────────────────────────────────────────────────────

function HistoryScreen({ onBack }: { onBack: () => void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());
  const [expanded, setExpanded] = useState<string | null>(null);

  function deleteEntry(id: string) {
    const next = entries.filter((e) => e.id !== id);
    saveHistory(next);
    setEntries(next);
    if (expanded === id) setExpanded(null);
  }

  function formatDate(ts: number) {
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function completionPct(e: HistoryEntry) {
    const all = [...e.essentials, ...e.custom];
    if (!all.length) return 0;
    return Math.round((all.filter((i) => i.done).length / all.length) * 100);
  }

  return (
    <div className="min-h-screen flex items-start justify-center" style={{ background: "#f2ede3", fontFamily: "'DM Sans', sans-serif" }}>
      <div className="w-[400px] min-h-screen flex flex-col" style={{ borderLeft: "1px solid #dfd8cb", borderRight: "1px solid #dfd8cb" }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: "1px solid #dfd8cb" }}>
          <div className="flex items-center gap-2">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#6b8a6b" }} />
            <span className="text-sm font-medium" style={{ color: "#2c2722" }}>past projects</span>
          </div>
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs hover:opacity-60 transition-opacity" style={{ color: "#9a9088" }}>
            <ArrowLeft size={12} />
            back
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm italic" style={{ color: "#c0b8ae" }}>no archived projects yet.</p>
              <p className="text-xs mt-1" style={{ color: "#c0b8ae" }}>archive a project from the dashboard to see it here.</p>
            </div>
          ) : (
            entries.map((entry) => {
              const pct = completionPct(entry);
              const allItems = [...entry.essentials, ...entry.custom];
              const doneCount = allItems.filter((i) => i.done).length;
              const isOpen = expanded === entry.id;

              return (
                <div key={entry.id} style={{ borderBottom: "1px solid #dfd8cb" }}>
                  {/* Summary row */}
                  <button
                    onClick={() => setExpanded(isOpen ? null : entry.id)}
                    className="w-full px-5 py-4 text-left flex items-start gap-3 hover:bg-black/[0.02] transition-colors"
                  >
                    {/* Progress ring placeholder — simple arc via CSS */}
                    <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-medium mt-0.5"
                      style={{ background: pct === 100 ? "#c8d8c0" : "#ece7dc", color: pct === 100 ? "#3d5a3d" : "#9a9088" }}>
                      {pct}%
                    </div>

                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "#2c2722" }}>{entry.setup.projectName}</p>
                      <p className="text-xs mt-0.5" style={{ color: "#9a9088" }}>
                        {doneCount}/{allItems.length} done · archived {formatDate(entry.archivedAt)}
                      </p>
                      {/* Mini progress bar */}
                      <div className="mt-2 h-0.5 rounded-full overflow-hidden" style={{ background: "#dfd8cb" }}>
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct === 100 ? "#6b8a6b" : "#b0a488" }} />
                      </div>
                    </div>

                    <ChevronRight size={14} className={`flex-shrink-0 mt-1 transition-transform ${isOpen ? "rotate-90" : ""}`} style={{ color: "#c0b8ae" }} />
                  </button>

                  {/* Expanded detail */}
                  {isOpen && (
                    <div className="px-5 pb-4" style={{ borderTop: "1px solid #ece7dc" }}>
                      {/* Deadline */}
                      <div className="flex items-center gap-1.5 mt-3 mb-3">
                        <Clock size={10} style={{ color: "#b0a89e" }} />
                        <span className="text-xs" style={{ color: "#b0a89e" }}>
                          deadline: {new Date(entry.setup.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>

                      {/* Links */}
                      {(entry.setup.devpostUrl || entry.setup.githubUrl) && (
                        <div className="flex gap-3 mb-3">
                          {entry.setup.githubUrl && (
                            <a href={entry.setup.githubUrl} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs hover:opacity-70 transition-opacity"
                              style={{ color: "#6b8a6b" }}>
                              <Github size={10} /> github <ExternalLink size={9} />
                            </a>
                          )}
                          {entry.setup.devpostUrl && (
                            <a href={entry.setup.devpostUrl} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs hover:opacity-70 transition-opacity"
                              style={{ color: "#6b8a6b" }}>
                              devpost <ExternalLink size={9} />
                            </a>
                          )}
                        </div>
                      )}

                      {/* Checklist snapshot */}
                      {allItems.length > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <span className="text-[10px] uppercase tracking-widest font-medium mb-1" style={{ color: "#b0a89e" }}>checklist snapshot</span>
                          {allItems.map((item) => (
                            <div key={item.id} className="flex items-center gap-2">
                              <span style={{ color: item.done ? "#6b8a6b" : "#c0b8ae" }}>
                                {item.done ? <Check size={12} strokeWidth={2.5} /> : <X size={11} strokeWidth={2.5} />}
                              </span>
                              <span className="text-xs" style={{ color: item.done ? "#9a9088" : "#6b6358",
                                textDecorationLine: item.done ? "line-through" : "none",
                                textDecorationColor: "#c0b8ae" }}>
                                {item.text}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Delete */}
                      <button
                        onClick={() => deleteEntry(entry.id)}
                        className="mt-4 flex items-center gap-1.5 text-xs hover:opacity-70 transition-opacity"
                        style={{ color: "#c0b8ae" }}
                      >
                        <Trash2 size={11} /> remove from history
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function setMeta(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  if (!el) { el = document.createElement("meta"); el.name = name; document.head.appendChild(el); }
  el.content = content;
}
function setOgMeta(property: string, content: string) {
  let el = document.querySelector(`meta[property="${property}"]`) as HTMLMetaElement | null;
  if (!el) { el = document.createElement("meta"); el.setAttribute("property", property); document.head.appendChild(el); }
  el.content = content;
}

export default function App() {
  useEffect(() => {
    document.title = "Plus One";
    const desc = "Plus One — a solo hackathon co-pilot that watches your submission checklist and interrupts you before you miss a deadline.";
    setMeta("description", desc);
    setOgMeta("og:title", "Plus One");
    setOgMeta("og:description", desc);
    setMeta("twitter:title", "Plus One");
    setMeta("twitter:description", desc);
  }, []);

  const [state, setState] = useState<AppState>(() => loadState());
  const { screen, setup, lastCheckIn, lastGitHubCheck } = state;
  const essentials = Array.isArray(state.essentials) ? state.essentials : ESSENTIALS_DEFAULT;
  const custom = Array.isArray(state.custom) ? state.custom : [];
  const [isNewProject, setIsNewProject] = useState(!setup);

  const patch = useCallback((partial: Partial<AppState>) => {
    setState((prev) => { const next = { ...prev, ...partial }; saveState(next); return next; });
  }, []);

  if (screen === "login") return <LoginScreen onNext={() => patch({ screen: "setup" })} />;
  if (screen === "history") return <HistoryScreen onBack={() => patch({ screen: "dashboard" })} />;
  if (screen === "setup") return (
    <SetupScreen
      initial={isNewProject ? null : setup}
      onNext={(s) => { setIsNewProject(false); patch({ screen: "dashboard", setup: s }); }}
      onBack={() => patch({ screen: setup ? "dashboard" : "login" })}
    />
  );
  if (!setup) { patch({ screen: "setup" }); return null; }

  return (
    <DashboardScreen
      setup={setup}
      essentials={essentials}
      setEssentials={(items) => patch({ essentials: items })}
      custom={custom}
      setCustom={(items) => patch({ custom: items })}
      lastCheckIn={lastCheckIn}
      lastGitHubCheck={lastGitHubCheck ?? null}
      onCheckIn={() => patch({ lastCheckIn: Date.now() })}
      onGitHubCheck={(ts) => patch({ lastGitHubCheck: ts })}
      onEditSetup={() => patch({ screen: "setup" })}
      onViewHistory={() => patch({ screen: "history" })}
      onExtendDeadline={(deadline) => patch({ setup: { ...setup, deadline } })}
      onReset={() => {
        archiveProject(setup, essentials, custom);
        setIsNewProject(true);
        const fresh: AppState = { screen: "setup", setup, essentials: ESSENTIALS_DEFAULT, custom: [], lastCheckIn: null, lastGitHubCheck: null };
        saveState(fresh); setState(fresh);
      }}
    />
  );
}
