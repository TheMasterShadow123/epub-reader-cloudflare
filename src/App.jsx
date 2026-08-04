import React, { useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback } from "react";
import {
  ArrowLeft, Search, X, Settings2, Clock, Gauge, Hourglass, Hash,
  ChevronRight, Minus, Plus, AlignLeft, AlignJustify, Type, Check,
  Upload, LogOut, BookOpen
} from "lucide-react";

/* ============================================================
   API CLIENT — talks to the deployed Cloudflare Worker.
   Token is kept in React state (in-memory) here because this file
   runs inside Claude's artifact sandbox, which disallows browser
   storage APIs. When you copy this into your real Pages project,
   swap the token state for localStorage (see NOTE near the top of
   the App component) so login persists across app restarts.
   ============================================================ */
const API_BASE = "https://epub-reader.bryanlopez100705.workers.dev";

async function apiRequest(path, token, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const apiLogin = (password) => apiRequest("/api/login", null, { method: "POST", body: JSON.stringify({ password }) });
const apiListBooks = (token) => apiRequest("/api/books", token);
const apiGetBook = (token, id) => apiRequest(`/api/books/${id}`, token);
const apiGetChapter = (token, id, idx) => apiRequest(`/api/books/${id}/chapters/${idx}`, token);
const apiUploadBook = (token, file) => {
  const form = new FormData();
  form.append("epub", file);
  return apiRequest("/api/books", token, { method: "POST", body: form });
};
const apiSaveProgress = (token, id, chapterIdx, pageInChapter) =>
  apiRequest(`/api/books/${id}/progress`, token, { method: "POST", body: JSON.stringify({ chapterIdx, pageInChapter }) });
const apiReportStats = (token, id, addSeconds, addWpmWords, addWpmMs) =>
  apiRequest(`/api/books/${id}/stats`, token, { method: "POST", body: JSON.stringify({ addSeconds, addWpmWords, addWpmMs }) });
const apiDeleteBook = (token, id) => apiRequest(`/api/books/${id}`, token, { method: "DELETE" });
const apiCoverUrl = (id) => `${API_BASE}/api/books/${id}/cover`;

/* ============================================================ */

const FONT_OPTIONS = [
  { label: "San Francisco", value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif' },
  { label: "New York", value: 'ui-serif, "New York", Georgia, serif' },
  { label: "Athelas", value: "Athelas, Georgia, serif" },
  { label: "Charter", value: "Charter, Georgia, serif" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Iowan Old Style", value: '"Iowan Old Style", Palatino, Georgia, serif' },
  { label: "Palatino", value: 'Palatino, "Palatino Linotype", Georgia, serif' },
  { label: "Seravek", value: 'Seravek, "Trebuchet MS", sans-serif' },
  { label: "Times New Roman", value: '"Times New Roman", Times, serif' },
];

const THEMES = {
  white: { label: "White", bg: "#ffffff", text: "#1c1c1e", chrome: "rgba(255,255,255,0.92)", border: "rgba(0,0,0,0.08)", sub: "#6e6e73" },
  sepia: { label: "Sepia", bg: "#f2e7d3", text: "#4a3c2a", chrome: "rgba(242,231,211,0.92)", border: "rgba(0,0,0,0.08)", sub: "#8a7457" },
  gray: { label: "Gray", bg: "#d4d3ce", text: "#2b2b28", chrome: "rgba(212,211,206,0.92)", border: "rgba(0,0,0,0.1)", sub: "#63625d" },
  graphite: { label: "Graphite", bg: "#1b1b1d", text: "#d6d6d6", chrome: "rgba(27,27,29,0.92)", border: "rgba(255,255,255,0.1)", sub: "#8e8e93" },
  black: { label: "Black", bg: "#000000", text: "#d7d7db", chrome: "rgba(0,0,0,0.9)", border: "rgba(255,255,255,0.12)", sub: "#8e8e93" },
};

const READER_CHROME_HEIGHT = 128; // header + footer + inner top padding, combined

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function fmtTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h > 0) return `${h}h ${mm}m`;
  if (m > 0) return `${m}m ${Math.floor(totalSeconds % 60)}s`;
  return `${Math.floor(totalSeconds)}s`;
}
function fmtHours(mins) {
  if (!isFinite(mins) || mins <= 0) return "0m";
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
function hashGradient(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const h1 = Math.abs(hash) % 360;
  const h2 = (h1 + 40) % 360;
  return [`hsl(${h1}, 42%, 22%)`, `hsl(${h2}, 48%, 38%)`];
}

/* ============================================================ */

const TOKEN_STORAGE_KEY = "epub_reader_token";

export default function App() {
  const [token, setTokenState] = useState(() => {
    try {
      return localStorage.getItem(TOKEN_STORAGE_KEY);
    } catch {
      return null; // storage unavailable (e.g. private browsing, sandboxed preview)
    }
  });
  const setToken = (value) => {
    setTokenState(value);
    try {
      if (value) localStorage.setItem(TOKEN_STORAGE_KEY, value);
      else localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // storage unavailable - token still works for this session via state
    }
  };

  const [passwordInput, setPasswordInput] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState(null);

  const [view, setView] = useState("library"); // library | detail | reader
  const [books, setBooks] = useState([]);
  const [booksLoading, setBooksLoading] = useState(false);
  const [booksError, setBooksError] = useState(null);

  const [selectedId, setSelectedId] = useState(null);
  const [bookMeta, setBookMeta] = useState(null);       // row from GET /api/books/:id -> book
  const [chapterMeta, setChapterMeta] = useState([]);   // [{idx,title,word_count}]
  const [chapterHtmls, setChapterHtmls] = useState([]); // fetched html, same length/order as chapterMeta
  const [serverProgress, setServerProgress] = useState(null);
  const [serverStats, setServerStats] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const fileInputRef = useRef(null);

  const [toast, setToast] = useState(null);
  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2200); };

  /* ---------------- auth ---------------- */
  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    try {
      const { token } = await apiLogin(passwordInput);
      setToken(token);
      setPasswordInput("");
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };
  const handleLogout = () => {
    setToken(null);
    setBooks([]);
    setView("library");
  };

  /* ---------------- library ---------------- */
  const refreshBooks = useCallback(async () => {
    if (!token) return;
    setBooksLoading(true);
    setBooksError(null);
    try {
      const { books } = await apiListBooks(token);
      setBooks(books);
    } catch (err) {
      setBooksError(err.message);
    } finally {
      setBooksLoading(false);
    }
  }, [token]);

  useEffect(() => { if (token) refreshBooks(); }, [token, refreshBooks]);

  const handleUpload = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      await apiUploadBook(token, file);
      showToast("Book uploaded");
      await refreshBooks();
    } catch (err) {
      setUploadError(err.message);
      showToast("Upload failed: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await apiDeleteBook(token, id);
      showToast("Book removed");
      await refreshBooks();
    } catch (err) {
      showToast("Couldn't delete: " + err.message);
    }
  };

  /* ---------------- book detail / chapters ---------------- */
  const openBook = async (id) => {
    setSelectedId(id);
    setView("detail");
    setDetailLoading(true);
    setDetailError(null);
    setChapterHtmls([]);
    try {
      const { book, chapters, progress, stats } = await apiGetBook(token, id);
      setBookMeta(book);
      setChapterMeta(chapters);
      setServerProgress(progress);
      setServerStats(stats);
      // fetch every chapter's html up front — needed to paginate accurately
      // and to show real page numbers in the chapter list
      const htmls = await Promise.all(chapters.map((c) => apiGetChapter(token, id, c.idx).then((r) => r.html)));
      setChapterHtmls(htmls);
    } catch (err) {
      setDetailError(err.message);
    } finally {
      setDetailLoading(false);
    }
  };

  /* ---------------- global reader settings ---------------- */
  const [settings, setSettings] = useState({
    theme: "graphite",
    fontFamily: FONT_OPTIONS[4].value,
    fontSize: 19,
    lineHeight: 1.6,
    paragraphSpacing: 1.0,
    margin: 22,
    textAlign: "left",
    useItalicFont: true,
    italicFontFamily: '"Times New Roman", Times, serif',
  });
  const setSetting = (k, v) => setSettings((s) => ({ ...s, [k]: v }));
  const theme = THEMES[settings.theme];

  /* ---------------- pagination (window-size driven, not DOM-measured) ---------------- */
  const [winSize, setWinSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setWinSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const contentW = Math.max(0, winSize.w - settings.margin * 2);
  const contentH = Math.max(0, winSize.h - READER_CHROME_HEIGHT);

  const [chapterIdx, setChapterIdx] = useState(0);
  const [pageInChapter, setPageInChapter] = useState(0);
  const [pagesPerChapter, setPagesPerChapter] = useState([]);
  const measureRef = useRef(null);

  // resume from server progress once a book's chapters are loaded
  useEffect(() => {
    if (chapterHtmls.length > 0 && serverProgress) {
      setChapterIdx(Math.min(serverProgress.chapter_idx || 0, chapterHtmls.length - 1));
      setPageInChapter(serverProgress.page_in_chapter || 0);
    }
  }, [chapterHtmls.length, serverProgress]);

  useLayoutEffect(() => {
    if (chapterHtmls.length === 0 || contentW <= 0 || contentH <= 0) return;
    const m = measureRef.current;
    if (!m) return;
    m.style.width = contentW + "px";
    m.style.height = contentH + "px";
    m.style.columnWidth = contentW + "px";
    m.style.setProperty("--para-spacing", settings.paragraphSpacing + "em");
    m.style.fontFamily = settings.fontFamily;
    m.style.fontSize = settings.fontSize + "px";
    m.style.lineHeight = settings.lineHeight;
    m.style.textAlign = settings.textAlign;

    const counts = chapterHtmls.map((html) => {
      m.innerHTML = html;
      // eslint-disable-next-line no-unused-expressions
      m.offsetHeight;
      return Math.max(1, Math.round(m.scrollWidth / contentW));
    });
    setPagesPerChapter(counts);
    setPageInChapter((p) => Math.min(p, Math.max(0, (counts[chapterIdx] || 1) - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterHtmls, contentW, contentH, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.textAlign, settings.paragraphSpacing]);

  const pagesInCurrentChapter = pagesPerChapter[chapterIdx] || 1;
  const totalBookPages = pagesPerChapter.reduce((a, b) => a + b, 0) || 1;
  const globalPageIndex = pagesPerChapter.slice(0, chapterIdx).reduce((a, b) => a + b, 0) + pageInChapter;

  const totalWords = bookMeta?.total_words || 0;
  const wordsReadEstimate = useMemo(() => {
    const before = chapterMeta.slice(0, chapterIdx).reduce((a, c) => a + (c.word_count || 0), 0);
    const frac = pagesInCurrentChapter > 0 ? (pageInChapter + 1) / pagesInCurrentChapter : 0;
    return before + frac * (chapterMeta[chapterIdx]?.word_count || 0);
  }, [chapterMeta, chapterIdx, pageInChapter, pagesInCurrentChapter]);

  /* ---------------- reading timer + max-dwell WPM tracking ---------------- */
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (view !== "reader" || settingsOpen || searchOpen) return;
    const id = setInterval(() => setSessionSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [view, settingsOpen, searchOpen]);

  const MAX_PAGE_DWELL_MS = 120000; // pages held open longer than this are treated as idle, not reading
  const [wpmSample, setWpmSample] = useState({ words: 0, ms: 0 }); // unflushed session deltas
  const lastPageRef = useRef(null);

  const wordsOnCurrentPage = pagesInCurrentChapter > 0 ? (chapterMeta[chapterIdx]?.word_count || 0) / pagesInCurrentChapter : 0;

  useEffect(() => {
    if (view !== "reader") { lastPageRef.current = null; return; }
    const now = Date.now();
    const prev = lastPageRef.current;
    if (prev && (prev.chapterIdx !== chapterIdx || prev.pageInChapter !== pageInChapter)) {
      const dwellMs = now - prev.time;
      if (dwellMs > 0 && dwellMs <= MAX_PAGE_DWELL_MS) {
        setWpmSample((s) => ({ words: s.words + prev.wordsOnPage, ms: s.ms + dwellMs }));
      }
    }
    lastPageRef.current = { chapterIdx, pageInChapter, time: now, wordsOnPage: wordsOnCurrentPage };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, chapterIdx, pageInChapter]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (view !== "reader" || settingsOpen || searchOpen) return;
    const id = setInterval(() => setTick((t) => t + 1), 5000);
    return () => clearInterval(id);
  }, [view, settingsOpen, searchOpen]);

  const liveWpmSample = useMemo(() => {
    let { words, ms } = wpmSample;
    const prev = lastPageRef.current;
    if (prev) {
      const dwellMs = Date.now() - prev.time;
      if (dwellMs > 0 && dwellMs <= MAX_PAGE_DWELL_MS) { words += prev.wordsOnPage; ms += dwellMs; }
    }
    return { words, ms };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wpmSample, tick, chapterIdx, pageInChapter]);

  // combine server-persisted totals with this session's not-yet-flushed deltas
  const combinedSeconds = (serverStats?.total_seconds || 0) + sessionSeconds;
  const combinedWpmWords = (serverStats?.wpm_valid_words || 0) + liveWpmSample.words;
  const combinedWpmMs = (serverStats?.wpm_valid_ms || 0) + liveWpmSample.ms;
  const liveWpm = combinedWpmMs > 15000 ? combinedWpmWords / (combinedWpmMs / 60000) : null;
  const wpmDisplay = liveWpm ? Math.round(liveWpm) : null;
  const minutesLeft = (totalWords - wordsReadEstimate) / (liveWpm || 250);

  // flush progress + stats deltas periodically
  const lastFlushedRef = useRef({ seconds: 0, words: 0, ms: 0 });
  useEffect(() => {
    if (view !== "reader" || !selectedId) return;
    const id = setInterval(async () => {
      const addSeconds = sessionSeconds - lastFlushedRef.current.seconds;
      const addWpmWords = liveWpmSample.words - lastFlushedRef.current.words;
      const addWpmMs = liveWpmSample.ms - lastFlushedRef.current.ms;
      if (addSeconds <= 0 && addWpmWords <= 0 && addWpmMs <= 0) return;
      try {
        await apiReportStats(token, selectedId, addSeconds, addWpmWords, addWpmMs);
        lastFlushedRef.current = { seconds: sessionSeconds, words: liveWpmSample.words, ms: liveWpmSample.ms };
      } catch { /* retry next tick */ }
    }, 10000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedId, sessionSeconds, liveWpmSample.words, liveWpmSample.ms]);

  useEffect(() => {
    if (view !== "reader" || !selectedId) return;
    apiSaveProgress(token, selectedId, chapterIdx, pageInChapter).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedId, chapterIdx, pageInChapter]);

  /* ---------------- navigation ---------------- */
  const nextPage = useCallback(() => {
    if (pageInChapter < pagesInCurrentChapter - 1) setPageInChapter((p) => p + 1);
    else if (chapterIdx < chapterHtmls.length - 1) { setChapterIdx((c) => c + 1); setPageInChapter(0); }
  }, [pageInChapter, pagesInCurrentChapter, chapterIdx, chapterHtmls.length]);

  const prevPage = useCallback(() => {
    if (pageInChapter > 0) setPageInChapter((p) => p - 1);
    else if (chapterIdx > 0) {
      const newC = chapterIdx - 1;
      setChapterIdx(newC);
      setPageInChapter(Math.max(0, (pagesPerChapter[newC] || 1) - 1));
    }
  }, [pageInChapter, chapterIdx, pagesPerChapter]);

  const jumpToGlobalPage = useCallback((idx) => {
    let remaining = idx;
    for (let i = 0; i < pagesPerChapter.length; i++) {
      if (remaining < pagesPerChapter[i]) { setChapterIdx(i); setPageInChapter(remaining); return; }
      remaining -= pagesPerChapter[i];
    }
  }, [pagesPerChapter]);

  const touchStartX = useRef(null);
  const handleTouchStart = (e) => (touchStartX.current = e.touches[0].clientX);
  const handleTouchEnd = (e) => {
    if (touchStartX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    if (dx < 0) nextPage(); else prevPage();
  };

  const startReading = () => { setView("reader"); setChromeVisible(true); };

  /* ---------------- search ---------------- */
  const searchResults = useMemo(() => {
    if (chapterHtmls.length === 0 || searchQuery.trim().length < 2) return [];
    const q = searchQuery.trim().toLowerCase();
    const results = [];
    chapterHtmls.forEach((html, ci) => {
      const plain = stripHtml(html);
      let idx = plain.toLowerCase().indexOf(q);
      let guard = 0;
      while (idx >= 0 && guard < 5) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(plain.length, idx + q.length + 40);
        const snippet = (start > 0 ? "…" : "") + plain.slice(start, end) + (end < plain.length ? "…" : "");
        results.push({ chapterIdx: ci, chapterTitle: chapterMeta[ci]?.title || `Chapter ${ci + 1}`, snippet });
        idx = plain.toLowerCase().indexOf(q, idx + q.length);
        guard++;
      }
    });
    return results.slice(0, 30);
  }, [chapterHtmls, chapterMeta, searchQuery]);

  /* ===================== RENDER ===================== */

  if (!token) {
    return <Login passwordInput={passwordInput} setPasswordInput={setPasswordInput} onSubmit={handleLogin} loading={authLoading} error={authError} />;
  }

  return (
    <div style={{ width: "100%", height: "100dvh", overflow: "hidden", position: "relative", background: "#000", fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" }}>
      <style>{`
        * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
        .reader-text em, .reader-text i { font-style: italic; ${settings.useItalicFont ? `font-family: ${settings.italicFontFamily};` : ""} }
        .reader-text p { text-align: ${settings.textAlign}; margin: 0 0 var(--para-spacing, 1em) 0; }
        input[type=range] { -webkit-appearance: none; appearance: none; background: transparent; }
        input[type=range]::-webkit-slider-runnable-track { height: 3px; background: rgba(128,128,128,0.4); border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,0.15), 0 1px 4px rgba(0,0,0,0.3); margin-top: -7.5px; }
        ::-webkit-scrollbar { display: none; }
      `}</style>

      {view === "library" && (
        <Library
          books={books} loading={booksLoading} error={booksError}
          onOpen={openBook} onLogout={handleLogout}
          uploading={uploading} uploadError={uploadError}
          onUploadClick={() => fileInputRef.current?.click()}
          onDelete={handleDelete}
        />
      )}

      <input
        ref={fileInputRef} type="file" accept=".epub" style={{ display: "none" }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) handleUpload(f); }}
      />

      {view === "detail" && (
        <BookDetail
          bookMeta={bookMeta} chapterMeta={chapterMeta} loading={detailLoading} error={detailError}
          totalWords={totalWords} readingSeconds={combinedSeconds} wpmDisplay={wpmDisplay} minutesLeft={minutesLeft}
          globalPageIndex={globalPageIndex} totalBookPages={totalBookPages}
          started={!!serverProgress && (serverProgress.chapter_idx > 0 || serverProgress.page_in_chapter > 0)}
          onBack={() => setView("library")}
          onRead={startReading}
          onJumpChapter={(ci) => { setChapterIdx(ci); setPageInChapter(0); startReading(); }}
          pagesPerChapter={pagesPerChapter}
        />
      )}

      {view === "reader" && chapterHtmls.length > 0 && (
        <div
          style={{ position: "absolute", inset: 0, background: theme.bg, color: theme.text, transition: "background 0.25s, color 0.25s" }}
          onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}
        >
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, zIndex: 20,
            background: theme.chrome, backdropFilter: "blur(14px)", borderBottom: `1px solid ${theme.border}`,
            paddingTop: "max(14px, env(safe-area-inset-top))", paddingBottom: 10, paddingLeft: 14, paddingRight: 14,
            display: "flex", alignItems: "center", gap: 10,
            transform: chromeVisible ? "translateY(0)" : "translateY(-100%)",
            transition: "transform 0.28s ease", pointerEvents: chromeVisible ? "auto" : "none",
          }}>
            <button onClick={() => setView("detail")} style={iconBtnStyle(theme)}><ArrowLeft size={19} /></button>
            <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 13, fontWeight: 600, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {chapterMeta[chapterIdx]?.title}
            </div>
            <button onClick={() => setSearchOpen(true)} style={iconBtnStyle(theme)}><Search size={18} /></button>
          </div>

          <div
            onClick={(e) => {
              const x = e.clientX, w = window.innerWidth;
              if (x < w * 0.28) prevPage();
              else if (x > w * 0.72) nextPage();
              else setChromeVisible((v) => !v);
            }}
            style={{ position: "absolute", inset: 0, overflow: "hidden", paddingTop: 56, paddingBottom: 44 }}
          >
            <div style={{ position: "absolute", left: settings.margin, top: 28, width: contentW, height: contentH, overflow: "hidden" }}>
              <div
                className="reader-text"
                style={{
                  width: contentW, height: contentH, columnWidth: contentW, columnGap: 0,
                  fontFamily: settings.fontFamily, fontSize: settings.fontSize, lineHeight: settings.lineHeight,
                  "--para-spacing": settings.paragraphSpacing + "em",
                  transform: `translateX(-${pageInChapter * contentW}px)`,
                  transition: "transform 0.22s ease", color: theme.text,
                }}
                dangerouslySetInnerHTML={{ __html: chapterHtmls[chapterIdx] || "" }}
              />
            </div>
          </div>

          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 20,
            background: theme.chrome, backdropFilter: "blur(14px)", borderTop: `1px solid ${theme.border}`,
            paddingBottom: "max(10px, env(safe-area-inset-bottom))", paddingTop: 8, paddingLeft: 16, paddingRight: 16,
            transform: chromeVisible ? "translateY(0)" : "translateY(100%)",
            transition: "transform 0.28s ease", pointerEvents: chromeVisible ? "auto" : "none",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 11, color: theme.sub, minWidth: 74 }}>Page {globalPageIndex + 1} of {totalBookPages}</span>
              <input type="range" min={0} max={Math.max(0, totalBookPages - 1)} value={globalPageIndex}
                onChange={(e) => jumpToGlobalPage(Number(e.target.value))} style={{ flex: 1 }} />
              <button onClick={() => setSettingsOpen(true)} style={iconBtnStyle(theme)}><Settings2 size={19} /></button>
            </div>
          </div>

          {settingsOpen && <SettingsSheet settings={settings} setSetting={setSetting} theme={theme} onClose={() => setSettingsOpen(false)} />}
          {searchOpen && (
            <SearchOverlay
              theme={theme} query={searchQuery} setQuery={setSearchQuery} results={searchResults}
              onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
              onJump={(ci) => { setChapterIdx(ci); setPageInChapter(0); setSearchOpen(false); setSearchQuery(""); }}
            />
          )}
        </div>
      )}

      <div ref={measureRef} className="reader-text" style={{ position: "fixed", top: 0, left: -99999, overflow: "hidden", visibility: "hidden" }} />

      {toast && (
        <div style={{ position: "fixed", bottom: 30, left: "50%", transform: "translateX(-50%)", background: "rgba(30,30,32,0.95)", color: "#fff", padding: "10px 16px", borderRadius: 12, fontSize: 13, zIndex: 100, maxWidth: "86%", textAlign: "center", boxShadow: "0 6px 20px rgba(0,0,0,0.3)" }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function iconBtnStyle(theme) {
  return { width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: "transparent", border: "none", color: theme.text, cursor: "pointer" };
}

/* ============================================================ LOGIN */
function Login({ passwordInput, setPasswordInput, onSubmit, loading, error }) {
  return (
    <div style={{ width: "100%", height: "100dvh", background: "#000", color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system, sans-serif" }}>
      <BookOpen size={40} style={{ marginBottom: 16, opacity: 0.85 }} />
      <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>My Library</div>
      <div style={{ fontSize: 13, color: "#8e8e93", marginBottom: 28 }}>Sign in to continue</div>
      <form onSubmit={onSubmit} style={{ width: "100%", maxWidth: 320 }}>
        <input
          type="password" autoFocus value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)}
          placeholder="Password"
          style={{ width: "100%", padding: "13px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 16, marginBottom: 14 }}
        />
        {error && <div style={{ color: "#ff453a", fontSize: 13, marginBottom: 14, textAlign: "center" }}>{error}</div>}
        <button type="submit" disabled={loading} style={{ width: "100%", background: "#0a84ff", color: "#fff", border: "none", borderRadius: 12, padding: "13px 0", fontSize: 16, fontWeight: 700, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
          {loading ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </div>
  );
}

/* ============================================================ LIBRARY */
function Library({ books, loading, error, onOpen, onLogout, uploading, uploadError, onUploadClick, onDelete }) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#000", color: "#fff", overflowY: "auto" }}>
      <div style={{ paddingTop: "max(20px, env(safe-area-inset-top))", paddingLeft: 18, paddingRight: 18, paddingBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: -0.5 }}>Library</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onUploadClick} disabled={uploading} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "50%", width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", cursor: "pointer" }}>
            <Upload size={17} />
          </button>
          <button onClick={onLogout} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: "50%", width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", cursor: "pointer" }}>
            <LogOut size={16} />
          </button>
        </div>
      </div>

      {uploading && <div style={{ padding: "0 18px", fontSize: 13, color: "#0a84ff" }}>Uploading and parsing your epub…</div>}
      {uploadError && <div style={{ padding: "0 18px", fontSize: 13, color: "#ff453a" }}>{uploadError}</div>}
      {loading && <div style={{ padding: "40px 18px", textAlign: "center", color: "#8e8e93" }}>Loading your library…</div>}
      {error && <div style={{ padding: "40px 18px", textAlign: "center", color: "#ff453a" }}>{error}</div>}
      {!loading && !error && books.length === 0 && (
        <div style={{ padding: "60px 24px", textAlign: "center", color: "#8e8e93" }}>
          No books yet — tap the upload icon above to add your first epub.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "22px 16px", padding: "10px 18px 40px" }}>
        {books.map((b) => {
          const [g1, g2] = hashGradient(b.title || b.id);
          const started = (b.chapter_idx || 0) > 0 || (b.page_in_chapter || 0) > 0;
          return (
            <div key={b.id} style={{ position: "relative" }}>
              <div onClick={() => onOpen(b.id)} style={{ cursor: "pointer" }}>
                <div style={{
                  aspectRatio: "2/3", borderRadius: 6, position: "relative", overflow: "hidden",
                  background: b.cover_key ? `url(${apiCoverUrl(b.id)}) center/cover no-repeat, linear-gradient(155deg, ${g1}, ${g2})` : `linear-gradient(155deg, ${g1}, ${g2})`,
                  boxShadow: "0 8px 20px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column",
                  justifyContent: "flex-end", padding: 14, border: "1px solid rgba(255,255,255,0.06)",
                }}>
                  {!b.cover_key && (
                    <>
                      <div style={{ fontSize: 11, letterSpacing: 1.5, opacity: 0.65, textTransform: "uppercase", marginBottom: 8 }}>{b.author}</div>
                      <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1.2, fontFamily: "Georgia, serif" }}>{b.title}</div>
                    </>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, fontSize: 12, color: "#98989d" }}>
                  <span>{started ? "Continue Reading" : "Read"}</span>
                </div>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); if (confirm(`Remove "${b.title}"?`)) onDelete(b.id); }}
                style={{ position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: "50%", background: "rgba(0,0,0,0.55)", border: "none", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================ BOOK DETAIL */
function BookDetail({ bookMeta, chapterMeta, loading, error, totalWords, readingSeconds, wpmDisplay, minutesLeft, globalPageIndex, totalBookPages, started, onBack, onRead, onJumpChapter, pagesPerChapter }) {
  if (loading || !bookMeta) {
    return (
      <div style={{ position: "absolute", inset: 0, background: "#000", color: "#fff", display: "flex", flexDirection: "column" }}>
        <div style={{ paddingTop: "max(14px, env(safe-area-inset-top))", paddingLeft: 8 }}>
          <button onClick={onBack} style={{ background: "none", border: "none", color: "#0a84ff", display: "flex", alignItems: "center", gap: 2, fontSize: 15, padding: 8, cursor: "pointer" }}>
            <ArrowLeft size={18} /> Library
          </button>
        </div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#8e8e93" }}>
          {error ? error : "Loading book…"}
        </div>
      </div>
    );
  }

  const [g1, g2] = hashGradient(bookMeta.title || bookMeta.id);
  const stats = [
    { icon: Clock, label: "Time spent", value: fmtTime(readingSeconds) },
    { icon: Gauge, label: "Reading speed", value: wpmDisplay ? `${wpmDisplay} wpm` : "—" },
    { icon: Hourglass, label: "Left to finish", value: fmtHours(minutesLeft) },
    { icon: Hash, label: "Word count", value: totalWords.toLocaleString() },
  ];
  let cumulative = 0;

  return (
    <div style={{ position: "absolute", inset: 0, background: "#000", color: "#fff", overflowY: "auto" }}>
      <div style={{ paddingTop: "max(14px, env(safe-area-inset-top))", paddingLeft: 8, paddingRight: 18 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "#0a84ff", display: "flex", alignItems: "center", gap: 2, fontSize: 15, padding: 8, cursor: "pointer" }}>
          <ArrowLeft size={18} /> Library
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 24px 6px" }}>
        <div style={{
          width: 150, aspectRatio: "2/3", borderRadius: 6,
          background: bookMeta.cover_key ? `url(${apiCoverUrl(bookMeta.id)}) center/cover no-repeat, linear-gradient(155deg, ${g1}, ${g2})` : `linear-gradient(155deg, ${g1}, ${g2})`,
          boxShadow: "0 12px 30px rgba(0,0,0,0.55)", marginBottom: 18, border: "1px solid rgba(255,255,255,0.06)",
        }} />
        <div style={{ fontSize: 21, fontWeight: 800, textAlign: "center" }}>{bookMeta.title}</div>
        <div style={{ fontSize: 14, color: "#98989d", marginTop: 2 }}>{bookMeta.author}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, padding: "14px 18px 6px" }}>
        {stats.map((s) => (
          <div key={s.label} style={{ background: "#1c1c1e", borderRadius: 12, padding: "12px 8px", textAlign: "center" }}>
            <s.icon size={16} style={{ color: "#0a84ff", marginBottom: 6 }} />
            <div style={{ fontSize: 13, fontWeight: 700 }}>{s.value}</div>
            <div style={{ fontSize: 9.5, color: "#8e8e93", marginTop: 2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "16px 18px" }}>
        <button onClick={onRead} style={{ width: "100%", background: "#0a84ff", color: "#fff", border: "none", borderRadius: 14, padding: "14px 0", fontSize: 16, fontWeight: 700, cursor: "pointer" }}>
          {started ? "Continue Reading" : "Read"}
        </button>
        {totalBookPages > 1 && (
          <div style={{ fontSize: 12, color: "#8e8e93", textAlign: "center", marginTop: 8 }}>
            Page {globalPageIndex + 1} of {totalBookPages}
          </div>
        )}
      </div>

      <div style={{ padding: "8px 18px 40px" }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.5, margin: "10px 4px" }}>Chapters</div>
        <div style={{ background: "#1c1c1e", borderRadius: 14, overflow: "hidden" }}>
          {chapterMeta.map((c, i) => {
            const startPage = cumulative + 1;
            cumulative += pagesPerChapter[i] || 1;
            return (
              <div key={i} onClick={() => onJumpChapter(i)} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 14px",
                borderBottom: i < chapterMeta.length - 1 ? "1px solid #2c2c2e" : "none", cursor: "pointer",
              }}>
                <span style={{ fontSize: 14.5 }}>{c.title}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#8e8e93", fontSize: 13, flexShrink: 0 }}>
                  <span>Page {startPage}</span>
                  <ChevronRight size={14} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ============================================================ SETTINGS SHEET */
function Row({ label, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#8e8e93", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>{label}</div>
      {children}
    </div>
  );
}
function Stepper({ display, onDec, onInc }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, background: "rgba(128,128,128,0.15)", borderRadius: 10, padding: "6px 10px", width: "fit-content" }}>
      <button onClick={onDec} style={stepBtn}><Minus size={15} /></button>
      <span style={{ fontSize: 14, minWidth: 46, textAlign: "center" }}>{display}</span>
      <button onClick={onInc} style={stepBtn}><Plus size={15} /></button>
    </div>
  );
}
const stepBtn = { width: 26, height: 26, borderRadius: "50%", border: "none", background: "rgba(128,128,128,0.25)", color: "inherit", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" };

function SettingsSheet({ settings, setSetting, theme, onClose }) {
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30 }} />
      <div style={{
        position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 31, maxHeight: "78vh", overflowY: "auto",
        background: theme.bg === "#000000" ? "#141416" : "#fff", color: theme.bg === "#000000" ? "#fff" : "#111",
        borderRadius: "18px 18px 0 0", padding: "10px 20px calc(24px + env(safe-area-inset-bottom))",
        boxShadow: "0 -8px 30px rgba(0,0,0,0.4)",
      }}>
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(128,128,128,0.4)", margin: "6px auto 16px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <div style={{ fontSize: 17, fontWeight: 800 }}>Reading Settings</div>
          <button onClick={onClose} style={{ background: "rgba(128,128,128,0.2)", border: "none", borderRadius: "50%", width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "inherit" }}><X size={15} /></button>
        </div>

        <Row label="Theme">
          <div style={{ display: "flex", gap: 12 }}>
            {Object.entries(THEMES).map(([key, t]) => (
              <button key={key} onClick={() => setSetting("theme", key)} style={{
                width: 42, height: 42, borderRadius: "50%", background: t.bg, border: settings.theme === key ? "3px solid #0a84ff" : "1px solid rgba(128,128,128,0.3)",
                cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {settings.theme === key && <Check size={16} color={t.text} />}
              </button>
            ))}
          </div>
        </Row>

        <Row label="Font">
          <select value={settings.fontFamily} onChange={(e) => setSetting("fontFamily", e.target.value)} style={selectStyle}>
            {FONT_OPTIONS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
          </select>
        </Row>

        <Row label="Font Size">
          <Stepper display={`${settings.fontSize}pt`} onDec={() => setSetting("fontSize", Math.max(13, settings.fontSize - 1))} onInc={() => setSetting("fontSize", Math.min(32, settings.fontSize + 1))} />
        </Row>

        <Row label="Line Spacing">
          <Stepper display={settings.lineHeight.toFixed(1)} onDec={() => setSetting("lineHeight", Math.max(1.1, +(settings.lineHeight - 0.1).toFixed(1)))} onInc={() => setSetting("lineHeight", Math.min(2.4, +(settings.lineHeight + 0.1).toFixed(1)))} />
        </Row>

        <Row label="Paragraph Spacing">
          <Stepper display={`${settings.paragraphSpacing.toFixed(1)}em`} onDec={() => setSetting("paragraphSpacing", Math.max(0, +(settings.paragraphSpacing - 0.2).toFixed(1)))} onInc={() => setSetting("paragraphSpacing", Math.min(3, +(settings.paragraphSpacing + 0.2).toFixed(1)))} />
        </Row>

        <Row label="Margins">
          <Stepper display={`${settings.margin}px`} onDec={() => setSetting("margin", Math.max(8, settings.margin - 4))} onInc={() => setSetting("margin", Math.min(64, settings.margin + 4))} />
        </Row>

        <Row label="Text Alignment">
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setSetting("textAlign", "left")} style={pillBtn(settings.textAlign === "left")}><AlignLeft size={15} /> Left</button>
            <button onClick={() => setSetting("textAlign", "justify")} style={pillBtn(settings.textAlign === "justify")}><AlignJustify size={15} /> Justify</button>
          </div>
        </Row>

        <Row label="Italic Text Font">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 13.5, display: "flex", alignItems: "center", gap: 6 }}><Type size={14} /> Use a different font for <i>italics</i></span>
            <button onClick={() => setSetting("useItalicFont", !settings.useItalicFont)} style={{
              width: 44, height: 26, borderRadius: 13, border: "none", cursor: "pointer",
              background: settings.useItalicFont ? "#34c759" : "rgba(128,128,128,0.35)", position: "relative",
            }}>
              <div style={{ width: 22, height: 22, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: settings.useItalicFont ? 20 : 2, transition: "left 0.15s" }} />
            </button>
          </div>
          <select disabled={!settings.useItalicFont} value={settings.italicFontFamily} onChange={(e) => setSetting("italicFontFamily", e.target.value)} style={{ ...selectStyle, opacity: settings.useItalicFont ? 1 : 0.4 }}>
            {FONT_OPTIONS.map((f) => <option key={f.label} value={f.value}>{f.label}</option>)}
          </select>
        </Row>
      </div>
    </>
  );
}
const selectStyle = { width: "100%", padding: "10px 12px", borderRadius: 10, border: "1px solid rgba(128,128,128,0.3)", background: "rgba(128,128,128,0.1)", color: "inherit", fontSize: 15 };
function pillBtn(active) {
  return { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 0", borderRadius: 10, border: "none", cursor: "pointer", fontSize: 13.5, background: active ? "#0a84ff" : "rgba(128,128,128,0.15)", color: active ? "#fff" : "inherit" };
}

/* ============================================================ SEARCH OVERLAY */
function SearchOverlay({ theme, query, setQuery, results, onClose, onJump }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 40, background: theme.bg, color: theme.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "max(14px, env(safe-area-inset-top)) 16px 10px" }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "rgba(128,128,128,0.15)", borderRadius: 10, padding: "9px 12px" }}>
          <Search size={16} style={{ opacity: 0.6 }} />
          <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search in book"
            style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: 16, color: "inherit" }} />
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#0a84ff", fontSize: 15, cursor: "pointer" }}>Cancel</button>
      </div>
      <div style={{ overflowY: "auto", height: "calc(100% - 64px)", padding: "0 16px" }}>
        {query.trim().length >= 2 && results.length === 0 && (
          <div style={{ textAlign: "center", color: theme.sub, marginTop: 40, fontSize: 14 }}>No results found</div>
        )}
        {results.map((r, i) => (
          <div key={i} onClick={() => onJump(r.chapterIdx)} style={{ padding: "12px 4px", borderBottom: `1px solid ${theme.border}`, cursor: "pointer" }}>
            <div style={{ fontSize: 12, color: "#0a84ff", fontWeight: 600, marginBottom: 3 }}>{r.chapterTitle}</div>
            <div style={{ fontSize: 14, lineHeight: 1.4 }}>{r.snippet}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
