"use client";

import { createWorker, Worker as TesseractWorker } from "tesseract.js";
import Script from "next/script";
import { useState, useRef, useCallback, useEffect } from "react";
import DrawingCanvas, { DrawingCanvasHandle } from "@/components/DrawingCanvas";
import {
  listProjects,
  createProject,
  saveWordEntry,
  deleteWordEntry,
  deleteProject,
  moveProject,
  renameProject,
  loadVocabEntries,
  type ProjectMeta,
  type VocabEntry,
} from "@/lib/googleDrive";

// ── Types ──────────────────────────────────────────────────────────────────────

interface GoogleUser { name: string; email: string; picture: string; }
interface Definition { definition: string; example?: string; }
interface Meaning { partOfSpeech: string; definitions: Definition[]; }
interface DictResult { word: string; phonetic?: string; meanings: Meaning[]; }

type Screen = "home" | "project-select" | "find" | "study" | "manage" | "project-words";
type LookupStatus = "idle" | "recognizing" | "looking-up" | "done" | "error";
type UploadStatus = "idle" | "uploading" | "success" | "error";

// ── Star helpers (localStorage) ────────────────────────────────────────────────

function getStars(folderId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`hv:stars:${folderId}`);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

function saveStars(folderId: string, stars: Set<string>): void {
  localStorage.setItem(`hv:stars:${folderId}`, JSON.stringify(Array.from(stars)));
}

// ── Settings helpers (localStorage) ───────────────────────────────────────────

const DEFAULT_MASTERY_THRESHOLD = 3;

function getSettings(): { masteryThreshold: number; darkMode: boolean } {
  try {
    const raw = localStorage.getItem("hv:settings");
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      masteryThreshold: typeof parsed.masteryThreshold === "number" ? parsed.masteryThreshold : DEFAULT_MASTERY_THRESHOLD,
      darkMode: typeof parsed.darkMode === "boolean" ? parsed.darkMode : false,
    };
  } catch { return { masteryThreshold: DEFAULT_MASTERY_THRESHOLD, darkMode: false }; }
}

function saveSettings(s: { masteryThreshold: number; darkMode: boolean }): void {
  localStorage.setItem("hv:settings", JSON.stringify(s));
}

// ── Mastery helpers (localStorage) ────────────────────────────────────────────

function getMastery(folderId: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(`hv:mastery:${folderId}`);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch { return {}; }
}

function saveMastery(folderId: string, m: Record<string, number>): void {
  localStorage.setItem(`hv:mastery:${folderId}`, JSON.stringify(m));
}

const MEANING_OPTIONS = [
  { code: "en",    label: "English" },
  { code: "ko",    label: "한국어" },
  { code: "ja",    label: "日本語" },
  { code: "zh-CN", label: "中文" },
  { code: "es",    label: "Español" },
  { code: "fr",    label: "Français" },
  { code: "de",    label: "Deutsch" },
  { code: "pt",    label: "Português" },
  { code: "it",    label: "Italiano" },
  { code: "ru",    label: "Русский" },
  { code: "ar",    label: "العربية" },
  { code: "vi",    label: "Tiếng Việt" },
];

function getSavedMeaningLang(): string {
  try { return localStorage.getItem("hv:meaningLang") ?? "en"; } catch { return "en"; }
}
function saveMeaningLang(lang: string): void {
  try { localStorage.setItem("hv:meaningLang", lang); } catch { /* ignore */ }
}

// ── Root ───────────────────────────────────────────────────────────────────────

export default function Home() {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [screen, setScreen] = useState<Screen>("home");
  const [mode, setMode] = useState<"find" | "study">("find");
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [currentProject, setCurrentProject] = useState<ProjectMeta | null>(null);
  const [currentManageProject, setCurrentManageProject] = useState<ProjectMeta | null>(null);
  const [settings, setSettings] = useState({ masteryThreshold: DEFAULT_MASTERY_THRESHOLD, darkMode: false });

  useEffect(() => { setSettings(getSettings()); }, []);

  const handleSettingsChange = (s: { masteryThreshold: number; darkMode: boolean }) => {
    setSettings(s);
    saveSettings(s);
  };

  const tokenClientRef = useRef<TokenClient | null>(null);

  // ── Auth ──────────────────────────────────────────────────────────────────

  const initGoogleAuth = useCallback(() => {
    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!;
    tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file profile email",
      callback: async (response) => {
        if (response.error || !response.access_token) {
          setAuthError("Sign-in failed. Please try again.");
          return;
        }
        const token = response.access_token;
        setAccessToken(token);
        setAuthError(null);
        try {
          const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!res.ok) throw new Error();
          const info = await res.json();
          setUser({ name: info.name, email: info.email, picture: info.picture });
        } catch {
          setAuthError("Signed in, but could not fetch profile.");
        }
      },
    });
  }, []);

  const handleSignIn = () => {
    if (!tokenClientRef.current) {
      setAuthError("Google auth is still loading — please try again.");
      return;
    }
    tokenClientRef.current.requestAccessToken({ prompt: "select_account" });
  };

  const handleSignOut = () => {
    if (accessToken) window.google.accounts.oauth2.revoke(accessToken, () => {});
    setUser(null);
    setAccessToken(null);
    setScreen("home");
    setCurrentProject(null);
    setProjects([]);
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  const goToMode = async (m: "find" | "study") => {
    setMode(m);
    setScreen("project-select");
    if (!accessToken) return;
    setProjectsLoading(true);
    try {
      const list = await listProjects(accessToken);
      setProjects(list);
    } finally {
      setProjectsLoading(false);
    }
  };

  const selectProject = (p: ProjectMeta) => {
    setCurrentProject(p);
    setScreen(mode);
  };

  const goHome = () => {
    setScreen("home");
    setCurrentProject(null);
  };

  const goProjectSelect = () => {
    setScreen("project-select");
    setCurrentProject(null);
  };

  const goToProjectWords = (p: ProjectMeta) => {
    setCurrentManageProject(p);
    setScreen("project-words");
  };

  const handleManageProjectUpdate = (updated: ProjectMeta) => {
    setCurrentManageProject(updated);
    setProjects((prev) => prev.map((p) => p.folderId === updated.folderId ? updated : p));
  };

  const goToManage = async () => {
    setScreen("manage");
    if (!accessToken) return;
    setProjectsLoading(true);
    try {
      const list = await listProjects(accessToken);
      setProjects(list);
    } finally {
      setProjectsLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onLoad={initGoogleAuth}
      />
      <div className={`h-[100dvh] flex flex-col overflow-hidden ${settings.darkMode ? "dark bg-[#0f172a]" : "bg-slate-50"}`}>

        {/* Header */}
        <header className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between shrink-0">
          <button
            onClick={
            screen === "home" ? undefined :
            screen === "project-select" || screen === "manage" ? goHome :
            screen === "project-words" ? () => setScreen("manage") :
            goProjectSelect
          }
            className={`text-lg font-semibold text-slate-800 ${screen !== "home" ? "hover:text-blue-600 transition-colors" : ""}`}
          >
            {screen !== "home" && <span className="mr-2 text-slate-400">←</span>}
            Worddraw
          </button>
          {user ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={user.picture} alt={user.name} className="w-8 h-8 rounded-full" />
              <span className="text-sm text-slate-600 hidden sm:block">{user.name}</span>
              <button onClick={handleSignOut} className="text-sm text-slate-500 hover:text-slate-800 transition-colors">
                Sign out
              </button>
            </div>
          ) : (
            <button
              onClick={handleSignIn}
              className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
            >
              <GoogleIcon />
              Sign in with Google
            </button>
          )}
        </header>

        {authError && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2 text-red-600 text-sm shrink-0">
            {authError}
          </div>
        )}

        {/* Screens */}
        {!user ? (
          <LoginPrompt onSignIn={handleSignIn} />
        ) : screen === "home" ? (
          <HomeScreen user={user} onSelectMode={goToMode} onManage={goToManage} settings={settings} onSettingsChange={handleSettingsChange} />
        ) : screen === "project-select" ? (
          <ProjectSelectScreen
            mode={mode}
            projects={projects}
            loading={projectsLoading}
            accessToken={accessToken!}
            onSelect={selectProject}
            onCreated={(p) => { setProjects((prev) => [...prev, p]); selectProject(p); }}
          />
        ) : screen === "find" && currentProject ? (
          <FindWordsScreen
            project={currentProject}
            accessToken={accessToken!}
            onProjectWordCountUpdate={(p) => setCurrentProject({ ...p })}
          />
        ) : screen === "study" && currentProject ? (
          <StudyScreen project={currentProject} accessToken={accessToken!} masteryThreshold={settings.masteryThreshold} />
        ) : screen === "manage" ? (
          <ManageScreen
            projects={projects}
            loading={projectsLoading}
            accessToken={accessToken!}
            masteryThreshold={settings.masteryThreshold}
            onProjectsChange={setProjects}
            onProjectClick={goToProjectWords}
          />
        ) : screen === "project-words" && currentManageProject ? (
          <ProjectWordsScreen
            project={currentManageProject}
            accessToken={accessToken!}
            masteryThreshold={settings.masteryThreshold}
            onProjectUpdate={handleManageProjectUpdate}
          />
        ) : null}

        <footer className="shrink-0 py-2 text-center text-xs text-slate-300">
          © {new Date().getFullYear()}{" "}
          <a
            href="https://github.com/JaesungBae"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-slate-500 transition-colors underline underline-offset-2"
          >
            Jaesung Bae
          </a>
        </footer>

      </div>
    </>
  );
}

// ── Login Prompt ───────────────────────────────────────────────────────────────

function LoginPrompt({ onSignIn }: { onSignIn: () => void }) {
  return (
    <main className="flex-1 flex flex-col items-center justify-center text-center gap-6 p-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-800 mb-2">Write and look up words</h2>
        <p className="text-slate-500 text-sm max-w-xs">
          Sign in with Google to look up words, build vocabulary projects, and study.
        </p>
      </div>
      <button
        onClick={onSignIn}
        className="flex items-center gap-3 px-6 py-3 bg-white border border-slate-300 rounded-xl text-base font-medium text-slate-700 hover:bg-slate-50 transition-colors shadow-sm"
      >
        <GoogleIcon />
        Sign in with Google
      </button>
    </main>
  );
}

// ── Home Screen ────────────────────────────────────────────────────────────────

function HomeScreen({
  user,
  onSelectMode,
  onManage,
  settings,
  onSettingsChange,
}: {
  user: GoogleUser;
  onSelectMode: (m: "find" | "study") => void;
  onManage: () => void;
  settings: { masteryThreshold: number; darkMode: boolean };
  onSettingsChange: (s: { masteryThreshold: number; darkMode: boolean }) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);

  return (
    <main className="flex-1 flex flex-col items-center justify-center gap-6 p-6">
      <div className="text-center">
        <p className="text-slate-500 text-sm">Welcome back,</p>
        <p className="text-slate-800 font-semibold">{user.name}</p>
      </div>
      <div className="flex flex-col sm:flex-row gap-4 w-full max-w-sm">
        <button
          onClick={() => onSelectMode("find")}
          className="flex-1 flex flex-col items-center gap-3 p-6 bg-white rounded-2xl border border-slate-200 shadow-sm hover:border-blue-300 hover:shadow-md transition-all"
        >
          <span className="text-3xl">✏️</span>
          <div>
            <p className="font-semibold text-slate-800">Look Up</p>
            <p className="text-xs text-slate-400 mt-0.5">Draw & look up</p>
          </div>
        </button>
        <button
          onClick={() => onSelectMode("study")}
          className="flex-1 flex flex-col items-center gap-3 p-6 bg-white rounded-2xl border border-slate-200 shadow-sm hover:border-purple-300 hover:shadow-md transition-all"
        >
          <span className="text-3xl">📚</span>
          <div>
            <p className="font-semibold text-slate-800">Study Words</p>
            <p className="text-xs text-slate-400 mt-0.5">Review vocabulary</p>
          </div>
        </button>
      </div>
      <div className="flex flex-col items-center gap-3 w-full max-w-sm">
        <button
          onClick={onManage}
          className="text-sm text-slate-400 hover:text-slate-600 transition-colors underline underline-offset-2"
        >
          Manage Projects
        </button>
        <button
          onClick={() => setShowSettings((s) => !s)}
          className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
          </svg>
          Settings
        </button>
        {showSettings && (
          <div className="w-full bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
            <div>
              <p className="text-sm font-medium text-slate-700">Mastery goal</p>
              <p className="text-xs text-slate-400 mt-0.5">How many correct answers to master a word</p>
            </div>
            <div className="flex gap-2">
              {[1, 2, 3, 5, 10].map((n) => (
                <button
                  key={n}
                  onClick={() => onSettingsChange({ ...settings, masteryThreshold: n })}
                  className={`w-10 h-10 rounded-xl text-sm font-semibold border-2 transition-colors ${
                    settings.masteryThreshold === n
                      ? "bg-blue-600 border-blue-600 text-white"
                      : "border-slate-200 text-slate-600 hover:border-blue-300"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between pt-1">
              <p className="text-sm font-medium text-slate-700">Dark mode</p>
              <button
                onClick={() => onSettingsChange({ ...settings, darkMode: !settings.darkMode })}
                className={`relative w-10 h-6 rounded-full transition-colors ${settings.darkMode ? "bg-blue-600" : "bg-slate-200"}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${settings.darkMode ? "translate-x-4" : ""}`} />
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

// ── Project Select Screen ──────────────────────────────────────────────────────

function ProjectSelectScreen({
  mode,
  projects,
  loading,
  accessToken,
  onSelect,
  onCreated,
}: {
  mode: "find" | "study";
  projects: ProjectMeta[];
  loading: boolean;
  accessToken: string;
  onSelect: (p: ProjectMeta) => void;
  onCreated: (p: ProjectMeta) => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) { setCreateError("Project name is required."); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createProject(name, newDesc.trim(), accessToken);
      onCreated(p);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create project.");
      setCreating(false);
    }
  };

  return (
    <main className="flex-1 overflow-auto p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">
          {mode === "find" ? "Find Words" : "Study Words"}
        </h2>
        <p className="text-sm text-slate-400 mt-0.5">Select a project or create a new one</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="w-6 h-6 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <button
              key={p.folderId}
              onClick={() => onSelect(p)}
              className="text-left bg-white rounded-xl border border-slate-200 px-4 py-3.5 hover:border-blue-300 hover:shadow-sm transition-all"
            >
              <div className="flex items-center justify-between">
                <p className="font-medium text-slate-800">{p.name}</p>
                <span className="text-xs text-slate-400">{p.wordCount} words</span>
              </div>
              {p.description && (
                <p className="text-xs text-slate-400 mt-0.5 truncate">{p.description}</p>
              )}
            </button>
          ))}

          {/* New project form */}
          {showForm ? (
            <div className="bg-white rounded-xl border border-blue-200 px-4 py-4 flex flex-col gap-3">
              <p className="text-sm font-medium text-slate-700">New Project</p>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Project name"
                className="w-full text-sm text-slate-800 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Description (optional)"
                className="w-full text-sm text-slate-800 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              {createError && <p className="text-red-500 text-xs">{createError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowForm(false); setNewName(""); setNewDesc(""); setCreateError(null); }}
                  className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {creating ? <><Spinner />Creating…</> : "Create"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 px-4 py-3.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-all text-sm"
            >
              <span className="text-lg leading-none">+</span>
              New Project
            </button>
          )}
        </div>
      )}
    </main>
  );
}

// ── Find Words Screen ──────────────────────────────────────────────────────────

function FindWordsScreen({
  project,
  accessToken,
  onProjectWordCountUpdate,
}: {
  project: ProjectMeta;
  accessToken: string;
  onProjectWordCountUpdate: (p: ProjectMeta) => void;
}) {
  const originLanguage = "en";
  const [meaningLanguage, setMeaningLanguage] = useState(getSavedMeaningLang);

  const handleMeaningLanguageChange = (lang: string) => {
    setMeaningLanguage(lang);
    saveMeaningLang(lang);
  };
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>("idle");
  const [recognizedWord, setRecognizedWord] = useState<string | null>(null);
  const [dictResult, setDictResult] = useState<DictResult | null>(null);
  const [displayResult, setDisplayResult] = useState<DictResult | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [uploadStatus, setUploadStatus] = useState<UploadStatus>("idle");
  const [uploadResult, setUploadResult] = useState<{ name: string } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [showKeyboard, setShowKeyboard] = useState(false);
  const [keyboardInput, setKeyboardInput] = useState("");
  const keyboardInputRef = useRef<HTMLInputElement>(null);

  const canvasRef = useRef<DrawingCanvasHandle>(null);
  const scribbleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScribbleRef = useRef<string>("");
  const tesseractWorkerRef = useRef<TesseractWorker | null>(null);

  useEffect(() => () => {
    if (scribbleTimerRef.current) clearTimeout(scribbleTimerRef.current);
  }, []);

  // Warm up Tesseract in the background so recognition is instant when needed
  useEffect(() => {
    createWorker("eng").then((w) => { tesseractWorkerRef.current = w; });
    return () => { tesseractWorkerRef.current?.terminate(); };
  }, []);

  // Reset when project changes
  useEffect(() => {
    canvasRef.current?.clear();
    setLookupStatus("idle");
    setRecognizedWord(null);
    setDictResult(null);
    setDisplayResult(null);
    setLookupError(null);
    setUploadStatus("idle");
    setUploadResult(null);
    setSaveError(null);
    setKeyboardInput("");
  }, [project.folderId]);

  // ── Lookup ──────────────────────────────────────────────────────────────

  const applyMeaning = useCallback(async (result: DictResult, lang: string) => {
    if (lang === "en") {
      setDisplayResult(result);
      setLookupStatus("done");
      return;
    }
    setLookupStatus("looking-up");
    try {
      const res = await fetch(`/api/dict-gtrans?word=${encodeURIComponent(result.word)}&lang=${encodeURIComponent(lang)}`);
      if (!res.ok) throw new Error(`Korean definition not found for "${result.word}".`);
      const data = await res.json();
      setDisplayResult({ ...result, meanings: data.meanings });
      setLookupStatus("done");
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Korean definition not found.");
      setLookupStatus("error");
    }
  }, []);

  const lookupByText = useCallback(async (word: string, origLang: string, meanLang: string) => {
    setLookupStatus("looking-up");
    setLookupError(null);
    setDictResult(null);
    setDisplayResult(null);
    setRecognizedWord(word);
    setUploadStatus("idle");
    setUploadResult(null);
    try {
      const dictRes = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/${origLang}/${encodeURIComponent(word)}`
      );
      if (!dictRes.ok) throw new Error(`"${word}" not found in dictionary.`);
      const data = await dictRes.json();
      const result: DictResult = data[0];
      setDictResult(result);
      await applyMeaning(result, meanLang);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Something went wrong.");
      setLookupStatus("error");
    }
  }, [applyMeaning]);

  useEffect(() => {
    if (dictResult) applyMeaning(dictResult, meaningLanguage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meaningLanguage]);  // re-translate when language changes

  const handleScribble = useCallback((text: string) => {
    pendingScribbleRef.current = text;
    if (scribbleTimerRef.current) clearTimeout(scribbleTimerRef.current);
    scribbleTimerRef.current = setTimeout(() => {
      const word = pendingScribbleRef.current.trim().split(/\s+/).slice(0, 3).join(" ");
      if (word) {
        canvasRef.current?.clearScribble();
        pendingScribbleRef.current = "";
        lookupByText(word, originLanguage, meaningLanguage);
      }
    }, 800);
  }, [lookupByText, originLanguage, meaningLanguage]);

  const handleLookUp = async () => {
    if (!canvasRef.current || canvasRef.current.isEmpty()) {
      setLookupError("Please draw a word first.");
      setLookupStatus("error");
      return;
    }
    setLookupStatus("recognizing");
    setLookupError(null);
    setDictResult(null);
    setRecognizedWord(null);
    setUploadStatus("idle");
    setUploadResult(null);
    try {
      const canvas = canvasRef.current.getCanvas();
      if (!canvas) throw new Error("Failed to read canvas.");
      const worker = tesseractWorkerRef.current ?? await createWorker("eng");
      const result = await worker.recognize(canvas);
      const raw = result.data.text.trim().toLowerCase();
      const word = raw.replace(/[^a-z' -]/g, "").replace(/\s+/g, " ").trim();
      if (!word) throw new Error("Could not read the handwriting.");
      await lookupByText(word, originLanguage, meaningLanguage);
    } catch (e) {
      setLookupError(e instanceof Error ? e.message : "Something went wrong.");
      setLookupStatus("error");
    }
  };

  const handleKeyboardLookup = () => {
    const word = keyboardInput.trim();
    if (!word) { setLookupError("Please type a word first."); setLookupStatus("error"); return; }
    setKeyboardInput("");
    lookupByText(word, originLanguage, meaningLanguage);
  };

  const resetAll = () => {
    canvasRef.current?.clear();
    setKeyboardInput("");
    setLookupStatus("idle");
    setRecognizedWord(null);
    setDictResult(null);
    setDisplayResult(null);
    setLookupError(null);
    setUploadStatus("idle");
    setUploadResult(null);
    setSaveError(null);
  };

  // ── Auto-save on successful lookup ──────────────────────────────────────

  useEffect(() => {
    if (lookupStatus !== "done" || !displayResult) return;
    setSaveError(null);
    setUploadResult({ name: displayResult.word });
    setUploadStatus("success");
    const entry: VocabEntry = {
      word: displayResult.word,
      meanings: displayResult.meanings,
      lang: meaningLanguage,
      addedAt: new Date().toISOString(),
    };
    saveWordEntry(entry, accessToken, project).then(() => {
      onProjectWordCountUpdate(project);
    }).catch((e) => {
      setSaveError(e instanceof Error ? e.message : "Save failed.");
      setUploadStatus("error");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupStatus]);

  const handleUnsave = () => {
    if (!uploadResult) return;
    const word = uploadResult.name;
    setUploadStatus("idle");
    setUploadResult(null);
    deleteWordEntry(word, accessToken, project).then(() => {
      onProjectWordCountUpdate(project);
    }).catch(() => {});
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <main className="flex-1 flex flex-col overflow-hidden">

      {/* Top half: Definition */}
      <div className="flex-[2] overflow-auto border-b border-slate-100 flex flex-col">
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0 flex-wrap">
          <div>
            <p className="text-xs text-slate-400">Project</p>
            <p className="text-sm font-medium text-slate-700">{project.name}</p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {/* Keyboard toggle */}
            <button
              onClick={() => {
                setShowKeyboard((k) => !k);
                setTimeout(() => keyboardInputRef.current?.focus(), 50);
              }}
              title="Type with keyboard"
              className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors ${
                showKeyboard ? "bg-blue-600 border-blue-600 text-white" : "border-slate-200 text-slate-400 hover:border-blue-300 hover:text-blue-500"
              }`}
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                <path fillRule="evenodd" d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h6a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z" clipRule="evenodd" />
              </svg>
            </button>
            <select
              value={meaningLanguage}
              onChange={(e) => handleMeaningLanguageChange(e.target.value)}
              className="text-sm text-slate-700 border border-slate-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none focus:border-blue-400 cursor-pointer"
            >
              {MEANING_OPTIONS.map((opt) => (
                <option key={opt.code} value={opt.code}>{opt.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Definition + feedback */}
        <div className="flex-1 px-5 pb-4 flex flex-col gap-2 min-h-0 overflow-auto">
          <DefinitionPanel
            status={lookupStatus}
            word={recognizedWord}
            result={displayResult}
            error={lookupError}
          />
          {uploadStatus === "success" && uploadResult && (
            <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2.5 shrink-0 flex items-center justify-between gap-3">
              <p className="text-green-800 text-xs">
                <span className="font-medium">{uploadResult.name}</span>{" "}
                saved to <span className="font-medium">{project.name}</span>
              </p>
              <button
                onClick={handleUnsave}
                className="text-xs text-green-700 underline underline-offset-2 hover:text-green-900 shrink-0 transition-colors"
              >
                Undo
              </button>
            </div>
          )}
          {saveError && <p className="text-red-500 text-xs shrink-0">{saveError}</p>}
        </div>
      </div>

      {/* Bottom half: Canvas or Keyboard */}
      <div className="flex-[3] flex flex-col p-4 gap-3 min-h-0">
        {showKeyboard ? (
          <div className="flex-1 flex flex-col gap-3">
            <input
              ref={keyboardInputRef}
              type="text"
              value={keyboardInput}
              onChange={(e) => setKeyboardInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleKeyboardLookup(); }}
              placeholder="Type a word…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full text-2xl font-semibold text-slate-800 text-center border-0 border-b-2 border-slate-200 focus:border-blue-400 focus:outline-none py-3 bg-transparent placeholder:text-slate-300 placeholder:font-light placeholder:text-xl"
            />
            <p className="text-xs text-slate-300 text-center">Press Enter or tap Look Up</p>
          </div>
        ) : (
          <div className="flex-1 bg-white rounded-2xl border-2 border-slate-200 overflow-hidden">
            <DrawingCanvas ref={canvasRef} onScribble={handleScribble} />
          </div>
        )}
        <div className="flex gap-2 shrink-0">
          <button
            onClick={resetAll}
            className="flex-1 py-3 rounded-xl border border-slate-300 text-slate-700 font-medium hover:bg-slate-100 transition-colors"
          >
            Clear
          </button>
          <button
            onClick={showKeyboard ? handleKeyboardLookup : handleLookUp}
            disabled={lookupStatus === "recognizing" || lookupStatus === "looking-up"}
            className="flex-[2] py-3 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {lookupStatus === "recognizing" ? (
              <><Spinner />Reading…</>
            ) : lookupStatus === "looking-up" ? (
              <><Spinner />Looking up…</>
            ) : (
              "Look Up"
            )}
          </button>
        </div>
      </div>
    </main>
  );
}

// ── Study Screen ───────────────────────────────────────────────────────────────

type StudyPhase = "mode-select" | "prompt" | "studying" | "summary";

interface StudySession {
  wordOrder: string[];
  currentIdx: number;
  known: string[];
  notYet: string[];
}

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function StudyScreen({ project, accessToken, masteryThreshold }: { project: ProjectMeta; accessToken: string; masteryThreshold: number }) {
  const storageKey = `hv:study:${project.folderId}`;

  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [savedSession, setSavedSession] = useState<StudySession | null>(null);
  const [queue, setQueue] = useState<VocabEntry[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<string>>(new Set());
  const [notYet, setNotYet] = useState<Set<string>>(new Set());
  const [phase, setPhase] = useState<StudyPhase>("mode-select");
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [mastery, setMastery] = useState<Record<string, number>>({});

  useEffect(() => {
    setStars(getStars(project.folderId));
    setMastery(getMastery(project.folderId));
    loadVocabEntries(project, accessToken).then((e) => {
      setEntries(e);
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          const session: StudySession = JSON.parse(raw);
          if (session.currentIdx > 0 && session.wordOrder?.length > 0) {
            setSavedSession(session);
          }
        }
      } catch { /* ignore */ }
      setLoading(false);
      setPhase("mode-select");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.folderId]);

  const applyFresh = (wordList: VocabEntry[]) => {
    const shuffled = shuffleArray(wordList);
    localStorage.removeItem(storageKey);
    setQueue(shuffled);
    setCurrentIdx(0);
    setFlipped(false);
    setKnown(new Set());
    setNotYet(new Set());
    setPhase("studying");
  };

  const applyResume = (session: StudySession, wordList: VocabEntry[]) => {
    const map = new Map(wordList.map((e) => [e.word, e]));
    const restored = session.wordOrder.map((w) => map.get(w)).filter(Boolean) as VocabEntry[];
    if (restored.length === 0) { applyFresh(wordList); return; }
    setQueue(restored);
    setCurrentIdx(Math.min(session.currentIdx, restored.length - 1));
    setFlipped(false);
    setKnown(new Set(session.known));
    setNotYet(new Set(session.notYet));
    setPhase("studying");
  };

  const saveProgress = (q: VocabEntry[], idx: number, knownSet: Set<string>, notYetSet: Set<string>) => {
    const session: StudySession = {
      wordOrder: q.map((e) => e.word),
      currentIdx: idx,
      known: Array.from(knownSet),
      notYet: Array.from(notYetSet),
    };
    localStorage.setItem(storageKey, JSON.stringify(session));
  };

  const current = queue[currentIdx];

  const toggleStar = (word: string | undefined) => {
    if (!word) return;
    setStars((prev) => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word); else next.add(word);
      saveStars(project.folderId, next);
      return next;
    });
  };

  const advance = (knew: boolean) => {
    if (!current) return;
    const newKnown = knew ? new Set([...known, current.word]) : known;
    const newNotYet = !knew ? new Set([...notYet, current.word]) : notYet;
    setKnown(newKnown);
    setNotYet(newNotYet);
    if (knew) {
      const newMastery = { ...mastery, [current.word]: (mastery[current.word] || 0) + 1 };
      setMastery(newMastery);
      saveMastery(project.folderId, newMastery);
    }
    const next = currentIdx + 1;
    if (next >= queue.length) {
      localStorage.removeItem(storageKey);
      setPhase("summary");
    } else {
      setCurrentIdx(next);
      setFlipped(false);
      saveProgress(queue, next, newKnown, newNotYet);
    }
  };

  const skip = () => {
    const next = currentIdx + 1;
    if (next >= queue.length) { localStorage.removeItem(storageKey); setPhase("summary"); }
    else { setCurrentIdx(next); setFlipped(false); saveProgress(queue, next, known, notYet); }
  };

  const startStudy = (wordList: VocabEntry[]) => {
    const shuffled = shuffleArray(wordList);
    localStorage.removeItem(storageKey);
    setQueue(shuffled);
    setCurrentIdx(0);
    setFlipped(false);
    setKnown(new Set());
    setNotYet(new Set());
    setPhase("studying");
  };

  // Keyboard shortcuts: Enter = flip, Y = got it, N = not yet
  const flippedRef = useRef(flipped);
  flippedRef.current = flipped;
  const advanceRef = useRef(advance);
  advanceRef.current = advance;
  const skipRef = useRef(skip);
  skipRef.current = skip;

  useEffect(() => {
    if (phase !== "studying") return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "Enter") { e.preventDefault(); setFlipped((f) => !f); }
      if ((e.key === "y" || e.key === "Y") && flippedRef.current) advanceRef.current(true);
      if ((e.key === "n" || e.key === "N") && flippedRef.current) advanceRef.current(false);
      if (e.key === " " && !flippedRef.current) { e.preventDefault(); skipRef.current(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [phase]);

  if (loading) return (
    <main className="flex-1 flex items-center justify-center">
      <Spinner className="w-6 h-6 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin" />
    </main>
  );

  if (entries.length === 0) return (
    <main className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="text-4xl">📭</span>
      <p className="text-slate-600 font-medium">{project.name}</p>
      <p className="text-slate-400 text-sm">No words saved in this project yet.</p>
    </main>
  );

  if (phase === "mode-select") {
    const unfinished = entries.filter((e) => (mastery[e.word] || 0) < masteryThreshold);
    const masteredCount = entries.length - unfinished.length;
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-8 p-6 text-center">
        <div className="space-y-1">
          <p className="text-2xl font-bold text-slate-800">Study Words</p>
          <p className="text-slate-400 text-sm">{project.name}</p>
          {entries.length > 0 && (
            <p className="text-xs text-slate-400 mt-1">
              {masteredCount} / {entries.length} mastered (goal: {masteryThreshold}×)
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          {savedSession && (
            <button
              onClick={() => applyResume(savedSession, entries)}
              className="w-full py-3.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-500 transition-colors"
            >
              Resume — card {savedSession.currentIdx} of {savedSession.wordOrder.length}
              {(savedSession.known.length > 0 || savedSession.notYet.length > 0) && (
                <span className="block text-xs font-normal text-blue-200 mt-0.5">
                  {savedSession.known.length} ✓ · {savedSession.notYet.length} ✗
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => applyFresh(entries)}
            className={`w-full py-3.5 rounded-xl font-semibold transition-colors ${
              savedSession
                ? "border border-slate-200 text-slate-700 hover:bg-slate-50"
                : "bg-blue-600 text-white hover:bg-blue-500"
            }`}
          >
            All words ({entries.length})
          </button>
          <button
            onClick={() => unfinished.length > 0 && applyFresh(unfinished)}
            disabled={unfinished.length === 0}
            className="w-full py-3.5 rounded-xl border border-slate-200 text-slate-700 font-semibold hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {unfinished.length === 0
              ? "All words mastered 🎉"
              : `Not yet mastered (${unfinished.length})`}
          </button>
        </div>
      </main>
    );
  }

  if (phase === "summary") {
    const masteredCount = entries.filter((e) => (mastery[e.word] || 0) >= masteryThreshold).length;
    const unfinished = entries.filter((e) => (mastery[e.word] || 0) < masteryThreshold);
    return (
      <main className="flex-1 flex flex-col items-center justify-center gap-8 p-6 text-center">
        <div className="space-y-1">
          <p className="text-2xl font-bold text-slate-800">Round complete!</p>
          <p className="text-slate-400 text-sm">{project.name}</p>
        </div>
        <div className="flex gap-10">
          <div>
            <p className="text-4xl font-bold text-green-500">{known.size}</p>
            <p className="text-xs text-slate-400 mt-1">Got it</p>
          </div>
          <div className="w-px bg-slate-200" />
          <div>
            <p className="text-4xl font-bold text-red-400">{notYet.size}</p>
            <p className="text-xs text-slate-400 mt-1">Not yet</p>
          </div>
        </div>
        <p className="text-sm text-slate-500">
          <span className="font-semibold text-slate-700">{masteredCount}</span> / {entries.length} mastered
          <span className="text-slate-400"> (goal: {masteryThreshold}×)</span>
        </p>
        <div className="flex flex-col gap-2.5 w-full max-w-xs">
          {notYet.size > 0 && (
            <button
              onClick={() => startStudy(entries.filter((e) => notYet.has(e.word)))}
              className="w-full py-3 rounded-xl bg-blue-600 text-white font-medium hover:bg-blue-500 transition-colors"
            >
              Review {notYet.size} word{notYet.size > 1 ? "s" : ""} again
            </button>
          )}
          {unfinished.length > 0 && (
            <button
              onClick={() => startStudy(unfinished)}
              className="w-full py-3 rounded-xl border border-blue-200 text-blue-600 font-medium hover:bg-blue-50 transition-colors"
            >
              Not yet mastered ({unfinished.length})
            </button>
          )}
          <button
            onClick={() => startStudy([...entries])}
            className="w-full py-3 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 transition-colors"
          >
            Study all again
          </button>
        </div>
      </main>
    );
  }

  const progressPct = (currentIdx / queue.length) * 100;

  return (
    <main className="flex-1 flex flex-col items-center px-5 pt-4 pb-4 overflow-hidden">

      {/* Progress bar */}
      <div className="w-full max-w-lg shrink-0 mb-4">
        <div className="flex justify-between text-sm text-slate-400 mb-2">
          <span>{currentIdx + 1} / {queue.length}</span>
          {known.size > 0 && <span className="text-green-500 font-medium">{known.size} ✓</span>}
        </div>
        <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-400 rounded-full transition-all duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Flashcard + star button */}
      <div className="w-full max-w-lg flex-1 min-h-0 relative mb-3">
        {/* Star — outside the 3D transform so it doesn't flip */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleStar(current?.word); }}
          className="absolute top-3 right-3 z-10 w-11 h-11 flex items-center justify-center rounded-full hover:bg-black/5 transition-colors"
          aria-label="Star word"
        >
          <svg viewBox="0 0 24 24" className="w-6 h-6" fill={current && stars.has(current.word) ? "#f59e0b" : "none"} stroke={current && stars.has(current.word) ? "#f59e0b" : "#cbd5e1"} strokeWidth="2">
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" strokeLinejoin="round" />
          </svg>
        </button>

        {/* 3D flip */}
        <div
          className="w-full h-full cursor-pointer"
          style={{ perspective: "1200px" }}
          onClick={() => setFlipped((f) => !f)}
        >
          <div
            className="relative w-full h-full transition-transform duration-500"
            style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
          >
            {/* Front — word */}
            <div
              className="absolute inset-0 bg-white rounded-3xl shadow-lg border border-slate-100 flex flex-col items-center justify-center p-10 select-none"
              style={{ backfaceVisibility: "hidden" }}
            >
              <p className="text-6xl font-bold text-slate-800 text-center leading-tight">{current?.word}</p>
              {current?.meanings[0]?.partOfSpeech && (
                <p className="text-sm text-slate-300 uppercase tracking-widest mt-4">{current.meanings[0].partOfSpeech}</p>
              )}
              <p className="text-slate-300 text-base mt-8">tap or Enter to reveal</p>
            </div>

            {/* Back — meanings */}
            <div
              className="absolute inset-0 bg-white rounded-3xl shadow-lg border border-slate-100 flex flex-col justify-center p-8 overflow-auto select-none"
              style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
            >
              <p className="text-3xl font-bold text-slate-800 mb-5">{current?.word}</p>
              <div className="space-y-4">
                {current?.meanings.slice(0, 3).map((m, i) => (
                  <div key={i}>
                    <span className="text-xs font-semibold text-blue-500 uppercase tracking-wide">{m.partOfSpeech}</span>
                    <p className="text-slate-700 text-base mt-1 leading-snug">{m.definitions[0]?.definition}</p>
                    {m.definitions[0]?.example && (
                      <p className="text-slate-400 text-sm italic mt-1">"{m.definitions[0].example}"</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Buttons + skip */}
      <div className="w-full max-w-lg flex flex-col gap-2 shrink-0">
        <div className={`flex gap-3 transition-opacity duration-300 ${flipped ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
          <button
            onClick={() => advance(false)}
            className="flex-1 py-4 rounded-2xl border-2 border-red-200 text-red-500 font-semibold text-base hover:bg-red-50 active:bg-red-100 transition-colors"
          >
            ✗ Not yet <span className="text-xs font-normal opacity-50 ml-1">(N)</span>
          </button>
          <button
            onClick={() => advance(true)}
            className="flex-1 py-4 rounded-2xl border-2 border-green-200 text-green-600 font-semibold text-base hover:bg-green-50 active:bg-green-100 transition-colors"
          >
            ✓ Got it <span className="text-xs font-normal opacity-50 ml-1">(Y)</span>
          </button>
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={skip}
            className="text-sm text-slate-300 hover:text-slate-500 transition-colors py-1"
          >
            Skip <span className="text-xs opacity-50">(Space)</span>
          </button>
        </div>
      </div>

    </main>
  );
}

// ── Manage Screen ──────────────────────────────────────────────────────────────

function ManageScreen({
  projects,
  loading,
  accessToken,
  masteryThreshold,
  onProjectsChange,
  onProjectClick,
}: {
  projects: ProjectMeta[];
  loading: boolean;
  accessToken: string;
  masteryThreshold: number;
  onProjectsChange: (p: ProjectMeta[]) => void;
  onProjectClick: (p: ProjectMeta) => void;
}) {
  const [deletingProject, setDeletingProject] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleDeleteProject = async (e: React.MouseEvent, p: ProjectMeta) => {
    e.stopPropagation();
    if (!confirm(`Delete "${p.name}" and all its words? This cannot be undone.`)) return;
    setDeletingProject(p.folderId);
    try {
      await deleteProject(p, accessToken);
      onProjectsChange(projects.filter((x) => x.folderId !== p.folderId));
    } finally {
      setDeletingProject(null);
    }
  };

  const handleMove = async (e: React.MouseEvent, p: ProjectMeta, dir: "up" | "down") => {
    e.stopPropagation();
    const idx = projects.findIndex((x) => x.folderId === p.folderId);
    const newIdx = dir === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= projects.length) return;
    const next = [...projects];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    onProjectsChange(next);
    await moveProject(p.folderId, dir, accessToken);
  };

  const startRename = (e: React.MouseEvent, p: ProjectMeta) => {
    e.stopPropagation();
    setRenamingId(p.folderId);
    setRenameValue(p.name);
  };

  const commitRename = async (p: ProjectMeta) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name || name === p.name) return;
    onProjectsChange(projects.map((x) => x.folderId === p.folderId ? { ...x, name } : x));
    await renameProject(p.folderId, name, accessToken);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) { setCreateError("Project name is required."); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const p = await createProject(name, newDesc.trim(), accessToken);
      onProjectsChange([...projects, p]);
      setShowForm(false);
      setNewName("");
      setNewDesc("");
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create project.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <main className="flex-1 overflow-auto p-5 flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-800">Manage Projects</h2>
        <p className="text-sm text-slate-400 mt-0.5">Tap a project to view its words</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="w-6 h-6 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {projects.map((p, idx) => (
            <div
              key={p.folderId}
              className="bg-white rounded-xl border border-slate-200 transition-all flex items-center gap-1 px-2 py-3"
            >
              {/* Reorder arrows */}
              <div className="flex flex-col shrink-0">
                <button
                  onClick={(e) => handleMove(e, p, "up")}
                  disabled={idx === 0}
                  className="w-7 h-5 flex items-center justify-center text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-colors text-[10px]"
                >▲</button>
                <button
                  onClick={(e) => handleMove(e, p, "down")}
                  disabled={idx === projects.length - 1}
                  className="w-7 h-5 flex items-center justify-center text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-colors text-[10px]"
                >▼</button>
              </div>

              {/* Name + description / rename input */}
              {renamingId === p.folderId ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(p);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 mx-2 text-sm text-slate-800 border border-blue-400 rounded-lg px-2 py-1 focus:outline-none"
                />
              ) : (
                <div
                  onClick={() => onProjectClick(p)}
                  className="flex-1 px-2 min-w-0 cursor-pointer"
                >
                  <p className="font-medium text-slate-800 text-sm truncate">{p.name}</p>
                  {p.description && <p className="text-xs text-slate-400 truncate">{p.description}</p>}
                </div>
              )}

              {/* Pencil / mastery count */}
              {renamingId !== p.folderId && (
                <>
                  <button
                    onClick={(e) => startRename(e, p)}
                    className="w-7 h-7 flex items-center justify-center text-slate-300 hover:text-slate-600 transition-colors shrink-0"
                    aria-label="Rename project"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                    </svg>
                  </button>
                  {(() => {
                    const m = getMastery(p.folderId);
                    const mastered = Object.values(m).filter((c) => c >= masteryThreshold).length;
                    return (
                      <span className="text-xs text-slate-400 shrink-0 mr-1 text-right leading-tight">
                        {mastered > 0 ? (
                          <><span className="text-green-500 font-medium">{mastered}</span>/{p.wordCount}</>
                        ) : (
                          p.wordCount
                        )}
                      </span>
                    );
                  })()}
                </>
              )}

              {/* Delete project */}
              <button
                onClick={(e) => handleDeleteProject(e, p)}
                disabled={deletingProject === p.folderId}
                className="w-8 h-8 flex items-center justify-center text-slate-300 hover:text-red-400 disabled:opacity-40 transition-colors shrink-0"
                aria-label="Delete project"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                  <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
              </button>
            </div>
          ))}

          {/* New project form */}
          {showForm ? (
            <div className="bg-white rounded-xl border border-blue-200 px-4 py-4 flex flex-col gap-3">
              <p className="text-sm font-medium text-slate-700">New Project</p>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="Project name"
                className="w-full text-sm text-slate-800 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Description (optional)"
                className="w-full text-sm text-slate-800 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
              />
              {createError && <p className="text-red-500 text-xs">{createError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setShowForm(false); setNewName(""); setNewDesc(""); setCreateError(null); }}
                  className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition-colors"
                >Cancel</button>
                <button
                  onClick={handleCreate}
                  disabled={creating}
                  className="flex-1 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-500 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {creating ? <><Spinner />Creating…</> : "Create"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-2 px-4 py-3.5 rounded-xl border-2 border-dashed border-slate-200 text-slate-400 hover:border-blue-300 hover:text-blue-500 transition-all text-sm"
            >
              <span className="text-lg leading-none">+</span>
              New Project
            </button>
          )}
        </div>
      )}
    </main>
  );
}

// ── Project Words Screen ────────────────────────────────────────────────────────

function ProjectWordsScreen({
  project,
  accessToken,
  masteryThreshold,
  onProjectUpdate,
}: {
  project: ProjectMeta;
  accessToken: string;
  masteryThreshold: number;
  onProjectUpdate: (p: ProjectMeta) => void;
}) {
  const [entries, setEntries] = useState<VocabEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [stars, setStars] = useState<Set<string>>(new Set());
  const [mastery, setMastery] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<"all" | "starred" | "mastered">("all");

  useEffect(() => {
    setStars(getStars(project.folderId));
    setMastery(getMastery(project.folderId));
    loadVocabEntries(project, accessToken)
      .then(setEntries)
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.folderId]);

  const toggleStar = (word: string) => {
    setStars((prev) => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word); else next.add(word);
      saveStars(project.folderId, next);
      return next;
    });
  };

  const removeFromState = (words: string[]) => {
    const removed = new Set(words);
    setEntries((prev) => prev.filter((e) => !removed.has(e.word)));
    onProjectUpdate({ ...project, wordCount: Math.max(0, project.wordCount - words.length) });
  };

  const handleDeleteOne = async (word: string) => {
    await deleteWordEntry(word, accessToken, project);
    removeFromState([word]);
  };

  const handleDeleteSelected = async () => {
    if (selected.size === 0) return;
    setDeleting(true);
    try {
      await Promise.all(Array.from(selected).map((w) => deleteWordEntry(w, accessToken, project)));
      removeFromState(Array.from(selected));
      setSelected(new Set());
      setSelectMode(false);
    } finally {
      setDeleting(false);
    }
  };

  const toggleOne = (word: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(word)) next.delete(word); else next.add(word);
      return next;
    });
  };

  const masteredWords = entries.filter((e) => (mastery[e.word] || 0) >= masteryThreshold);
  const displayed =
    filter === "starred" ? entries.filter((e) => stars.has(e.word)) :
    filter === "mastered" ? masteredWords :
    entries;
  const allSelected = displayed.length > 0 && displayed.every((e) => selected.has(e.word));

  return (
    <main className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 shrink-0">
        <div>
          <p className="font-semibold text-slate-800">{project.name}</p>
          <p className="text-xs text-slate-400">
            {entries.length} words · {stars.size} starred · <span className="text-green-500 font-medium">{masteredWords.length} mastered</span>
          </p>
        </div>
        {!loading && entries.length > 0 && (
          selectMode ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => allSelected ? setSelected(new Set()) : setSelected(new Set(displayed.map((e) => e.word)))}
                className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
              <button
                onClick={() => { setSelectMode(false); setSelected(new Set()); }}
                className="text-xs text-slate-500 hover:text-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteSelected}
                disabled={selected.size === 0 || deleting}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-medium hover:bg-red-400 disabled:opacity-40 transition-colors flex items-center gap-1.5"
              >
                {deleting ? <Spinner /> : null}
                Delete{selected.size > 0 ? ` (${selected.size})` : ""}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setSelectMode(true)}
              className="text-xs text-slate-500 hover:text-slate-800 transition-colors border border-slate-200 rounded-lg px-3 py-1.5"
            >
              Select
            </button>
          )
        )}
      </div>

      {/* Filter tabs */}
      {!loading && entries.length > 0 && (
        <div className="flex shrink-0 border-b border-slate-100">
          <button
            onClick={() => setFilter("all")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${filter === "all" ? "text-blue-600 border-b-2 border-blue-600" : "text-slate-400 hover:text-slate-600"}`}
          >
            All ({entries.length})
          </button>
          <button
            onClick={() => setFilter("mastered")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${filter === "mastered" ? "text-green-600 border-b-2 border-green-500" : "text-slate-400 hover:text-slate-600"}`}
          >
            ✓ Mastered ({masteredWords.length})
          </button>
          <button
            onClick={() => setFilter("starred")}
            className={`flex-1 py-2 text-sm font-medium transition-colors ${filter === "starred" ? "text-blue-600 border-b-2 border-blue-600" : "text-slate-400 hover:text-slate-600"}`}
          >
            ⭐ Starred ({stars.size})
          </button>
        </div>
      )}

      {/* Word list */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Spinner className="w-6 h-6 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin" />
          </div>
        ) : displayed.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-slate-400 text-sm">
              {filter === "starred" ? "No starred words yet" : filter === "mastered" ? "No mastered words yet" : "No words saved yet"}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {displayed.map((entry) => (
              <li
                key={entry.word}
                onClick={selectMode ? () => toggleOne(entry.word) : undefined}
                className={`flex items-center gap-2 px-4 py-2.5 transition-colors ${selectMode ? "cursor-pointer" : ""} ${selectMode && selected.has(entry.word) ? "bg-blue-50" : "hover:bg-slate-50"}`}
              >
                {/* Checkbox */}
                {selectMode && (
                  <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${selected.has(entry.word) ? "bg-blue-600 border-blue-600" : "border-slate-300"}`}>
                    {selected.has(entry.word) && (
                      <svg viewBox="0 0 12 12" fill="none" className="w-3 h-3">
                        <path d="M2 6l3 3 5-5" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                )}

                {/* Star */}
                {!selectMode && (
                  <button
                    onClick={() => toggleStar(entry.word)}
                    className="shrink-0 w-6 h-6 flex items-center justify-center"
                    aria-label="Toggle star"
                  >
                    <svg viewBox="0 0 24 24" className="w-4 h-4" fill={stars.has(entry.word) ? "#f59e0b" : "none"} stroke={stars.has(entry.word) ? "#f59e0b" : "#cbd5e1"} strokeWidth="2">
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}

                {/* Word */}
                <span className="font-semibold text-slate-800 text-sm w-24 shrink-0 truncate">{entry.word}</span>

                {/* Mastery badge */}
                {(() => {
                  const cnt = mastery[entry.word] || 0;
                  if (cnt === 0) return null;
                  const done = cnt >= masteryThreshold;
                  return (
                    <span className={`text-xs font-semibold shrink-0 px-1.5 py-0.5 rounded-full ${done ? "bg-green-100 text-green-600" : "bg-slate-100 text-slate-400"}`}>
                      {done ? "✓" : `${cnt}/${masteryThreshold}`}
                    </span>
                  );
                })()}

                {/* First definition */}
                <span className="text-xs text-slate-400 flex-1 truncate">
                  {entry.meanings[0]?.partOfSpeech && (
                    <span className="text-blue-400 font-medium mr-1">{entry.meanings[0].partOfSpeech}</span>
                  )}
                  {entry.meanings[0]?.definitions[0]?.definition}
                </span>

                {/* Delete */}
                {!selectMode && (
                  <button
                    onClick={() => handleDeleteOne(entry.word)}
                    className="w-6 h-6 flex items-center justify-center text-slate-300 hover:text-red-400 transition-colors shrink-0"
                    aria-label="Delete word"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
                      <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                    </svg>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

// ── Definition Panel ───────────────────────────────────────────────────────────

function DefinitionPanel({
  status, word, result, error,
}: {
  status: LookupStatus;
  word: string | null;
  result: DictResult | null;
  error: string | null;
}) {
  if (status === "idle") {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-slate-300 text-base font-light select-none text-center">
          Write a word below, then tap Look Up
        </p>
      </div>
    );
  }
  if (status === "recognizing" || status === "looking-up") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-slate-400">
        <Spinner className="w-5 h-5 border-2 border-slate-200 border-t-slate-400 rounded-full animate-spin" />
        <p className="text-sm">
          {status === "recognizing" ? "Reading handwriting…" : `Looking up "${word}"…`}
        </p>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="h-full flex items-center justify-center">
        <p className="text-red-400 text-sm text-center">{error}</p>
      </div>
    );
  }
  if (!result) return null;
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-3xl font-bold text-slate-800">{result.word}</h2>
        {result.phonetic && <p className="text-slate-400 text-sm mt-0.5">{result.phonetic}</p>}
      </div>
      {result.meanings.slice(0, 3).map((m, i) => (
        <div key={i}>
          <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1">
            {m.partOfSpeech}
          </p>
          {m.definitions.slice(0, 2).map((d, j) => (
            <div key={j} className="mb-2">
              <p className="text-slate-700 text-sm">{d.definition}</p>
              {d.example && <p className="text-slate-400 text-xs mt-0.5 italic">"{d.example}"</p>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Micro components ───────────────────────────────────────────────────────────

function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={
        className ??
        "w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin inline-block"
      }
    />
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}
