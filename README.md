# Kinde Bulk User Delete

This repository contains TypeScript scripts for bulk user deletion operations against a Kinde business using the Management API.

Right now it includes a single script:

- `deleteAllUsers.ts` – deletes all users in the business by paging through `/api/v1/users` and deleting each user via `/api/v1/user`.

> ⚠️ **Danger zone:** These scripts are destructive. Always double‑check your `.env` values before running anything.

---

## Scripts

### `deleteAllUsers.ts`

Deletes **all users** from the configured Kinde business:

- Fetches users from `GET /api/v1/users` in pages
- Follows `next_token` until all users are collected
- Deletes each user via `DELETE /api/v1/user?id=<user_id>`
- Uses an M2M client to get an access token via `client_credentials`
- Refreshes the access token automatically when it expires
- Retries on 429 (rate limit) and 5xx with exponential backoff
- Logs every major step for visibility

To reduce the risk of accidents, the script will only run if
`KINDE_CONFIRM_DELETE_ALL=true` is set in your `.env` file.

---

## Requirements

- A **Kinde M2M application** with access to the **Management API**
- Scopes on the M2M app:
  - `read:users`
  - `delete:users`

---

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Set up your environment**

   Rename `.env.example` to `.env`

   Update the file with your application settings. These can be found within the M2M application details within the Kinde dashboard

   ```env
   KINDE_CLIENT_ID=your_m2m_client_id
   KINDE_CLIENT_SECRET=your_m2m_client_secret
   KINDE_HOST=https://your_subdomain.kinde.com
   KINDE_PAGE_SIZE=50
  
   KINDE_CONFIRM_DELETE_ALL=true
   KINDE_MAX_RETRIES=6
   KINDE_BASE_DELAY_MS=500
   # optional override (defaults to `${KINDE_HOST}/api`)
   # KINDE_AUDIENCE=https://abdelrahmanzakii.kinde.com/api
   ```

   > **Important:** Only set `KINDE_CONFIRM_DELETE_ALL=true` when you really intend to wipe all users in that environment.

3. **(Optional) Add an npm script**

   In `package.json`:

   ```json
   "scripts": {
     "delete:all-users": "ts-node deleteAllUsers.ts"
   }
   ```

---

## Usage

### Delete all users

From the repo root:

```bash
# Using ts-node directly
npx ts-node deleteAllUsers.ts

# Or via npm script (if added)
npm run delete:all-users
```

You’ll see logs like:

- requesting token
- fetching user pages (with `next_token`)
- deleting each user
- retries on rate limits / transient errors
- final summary (`success`, `failed` counts)
