# Instagram Connect Dashboard (MVP)

This project provides:

- Connect button for Instagram OAuth
- List previous posts from Instagram
- Publish new image posts to Instagram
- Explicit handling for delete (not supported by Instagram Graph API for normal feed media)

## 1) Prerequisites

- Node.js 18+
- Meta developer app with Instagram Graph API access
- Instagram Professional account (Business or Creator), connected to Facebook Page

## 2) Setup

1. Copy `.env.example` to `.env`
2. Fill in your values:

   - `INSTAGRAM_APP_ID`
   - `INSTAGRAM_APP_SECRET`
   - `REDIRECT_URI` (must match your Meta app OAuth redirect exactly)

3. Install and run:

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## 3) Notes on API limits

- Reading account media is supported.
- Publishing is supported with Instagram Graph API permissions.
- Deleting existing IG posts is generally not supported for normal feed media via official Graph API.

## 4) Next recommended improvements

- Persist tokens and users in a database (PostgreSQL)
- Add token refresh job
- Add drag-and-drop ordering in UI (project-side arrangement)
- Add login/session for multiple users
- Add robust error logging and retries
