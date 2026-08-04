CREATE TABLE IF NOT EXISTS books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT,
  cover_key TEXT,
  epub_key TEXT NOT NULL,
  total_words INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  title TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  UNIQUE(book_id, idx)
);

CREATE TABLE IF NOT EXISTS progress (
  book_id TEXT PRIMARY KEY,
  chapter_idx INTEGER NOT NULL DEFAULT 0,
  page_in_chapter INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- wpm_valid_words / wpm_valid_ms exclude any page held open longer than
-- the 2-minute max-dwell cutoff, computed client-side and reported as deltas
CREATE TABLE IF NOT EXISTS reading_stats (
  book_id TEXT PRIMARY KEY,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  wpm_valid_words REAL NOT NULL DEFAULT 0,
  wpm_valid_ms INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id);
