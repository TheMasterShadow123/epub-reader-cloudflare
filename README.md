# epub-reader frontend (Cloudflare Pages)

This is a Vite + React scaffold wrapping `src/App.jsx` (your reader UI, unchanged in
behavior from the artifact version except the token is now persisted to
`localStorage`, so login survives closing and reopening the app).

`API_BASE` inside `src/App.jsx` is already hardcoded to your deployed Worker:
`https://epub-reader.bryanlopez100705.workers.dev`. If you ever redeploy the
Worker under a different name/subdomain, update that constant before building.

## Option A — Git integration (same pattern as your Worker)

This mirrors how you already deployed the Worker via "Import a repository."

1. Push this folder to a GitHub repo (it can be its own repo, or a
   subfolder of an existing one — just set the right root directory in step 4).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**.
3. Pick the repo.
4. Build settings:
   - Framework preset: **Vite**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: `/` (or the subfolder path, if this lives inside a monorepo)
5. Deploy. Cloudflare builds on every push, same as the Worker.
6. Your app will be live at `https://<project-name>.pages.dev`.

No environment variables or secrets are needed for the frontend — it's a static
build that calls the Worker directly from the browser. CORS is already wide
open (`Access-Control-Allow-Origin: *`) on the Worker side, so it'll work from
any `.pages.dev` domain without extra config.

## Option B — Deploy from your machine with Wrangler

If you'd rather not wire up Git for this one:

```bash
npm install
npm run build
npx wrangler pages deploy dist --project-name=epub-reader
```

First run will prompt you to log in and create the Pages project; after that,
`npx wrangler pages deploy dist` redeploys.

## After it's live

- Open the `.pages.dev` URL, log in with your admin password.
- Confirm the token survives a page reload (it's now in `localStorage` under
  `epub_reader_token`) — before this patch it reset on every refresh.
- Upload a real epub via the Upload button and confirm it shows up in the
  library with a cover and working chapters — this is the first true
  end-to-end test of the whole stack.

## Known limitation carried over from the Worker

In-chapter images (illustrations, diagrams — not the book cover) aren't
extracted or served yet. If your test epub has real inline images, they'll
show as broken. Say the word if you want that added; it needs a new R2 prefix
for chapter-local images and rewritten `<img src>` paths at parse time.
