// Thin API client for the epub-reader Worker.
// Set API_BASE to your deployed Worker URL, e.g. "https://epub-reader.<you>.workers.dev"

const API_BASE = "https://epub-reader.YOUR-SUBDOMAIN.workers.dev";
const TOKEN_KEY = "epub_reader_token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}
export function isLoggedIn() {
  return !!getToken();
}

async function request(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      ...(opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired — please log in again");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export async function login(password) {
  const { token } = await request("/api/login", { method: "POST", body: JSON.stringify({ password }) });
  setToken(token);
}

export const listBooks = () => request("/api/books");
export const getBook = (id) => request(`/api/books/${id}`);
export const getChapter = (id, idx) => request(`/api/books/${id}/chapters/${idx}`);
export const coverUrl = (id) => `${API_BASE}/api/books/${id}/cover`;

export async function uploadBook(file) {
  const form = new FormData();
  form.append("epub", file);
  return request("/api/books", { method: "POST", body: form });
}

export const deleteBook = (id) => request(`/api/books/${id}`, { method: "DELETE" });

export const saveProgress = (id, chapterIdx, pageInChapter) =>
  request(`/api/books/${id}/progress`, { method: "POST", body: JSON.stringify({ chapterIdx, pageInChapter }) });

// Call this periodically (e.g. every 5-10s) from the reader with the deltas
// accumulated since the last call. The 2-minute max-dwell filter should
// already have been applied client-side before these numbers get here.
export const reportStats = (id, addSeconds, addWpmWords, addWpmMs) =>
  request(`/api/books/${id}/stats`, { method: "POST", body: JSON.stringify({ addSeconds, addWpmWords, addWpmMs }) });
