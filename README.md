# Kinde Bulk User Delete

This repository contains TypeScript scripts for bulk deletion operations against a Kinde business using the Management API.

It includes:

- `deleteAllUsers.ts` - deletes all users in the business by paging through `/api/v1/users` and deleting each user via `/api/v1/user`.
- `deleteOrgUsersIdentities.ts` - deletes all identities for users in a specific organization.

> WARNING: These scripts are destructive. Always double-check your `.env` values before running anything.

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

### `deleteOrgUsersIdentities.ts`

Deletes all identities for users in one organization:

- Fetches org users from `GET /api/v1/organizations/{org_code}/users`
- Uses `next_token` for org users pagination
- Stops org users pagination on empty page (even if `next_token` exists)
- For each user, fetches identities from `GET /api/v1/users/{user_id}/identities`
- Uses `starting_after` cursor pagination for identities and stops when `has_more=false` or an empty page is returned
- Deletes each identity via `DELETE /api/v1/identities/{identity_id}`
- Retries on 429 (rate limit) and 5xx with exponential backoff + jitter
- Refreshes token once on 401
- Logs progress per user and final totals

To reduce the risk of accidents, the script will only run if
`KINDE_CONFIRM_DELETE_ORG_IDENTITIES=true` is set in your `.env` file.

---

## Requirements

- A **Kinde M2M application** with access to the **Management API**
- Scopes for `deleteAllUsers.ts`:
  - `read:users`
  - `delete:users`
- Scopes for `deleteOrgUsersIdentities.ts`:
  - `read:organization_users`
  - `read:user_identities`
  - `delete:identities`

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
   KINDE_CLIENT_ID=<your_m2m_client_id>
   KINDE_CLIENT_SECRET=<your_m2m_client_secret>
   KINDE_HOST=https://<your_kinde_subdomain>.kinde.com
   KINDE_PAGE_SIZE=50
   KINDE_ORG_CODE=org_1234567890

   KINDE_CONFIRM_DELETE_ALL=false
   KINDE_MAX_RETRIES=6
   KINDE_BASE_DELAY_MS=500
   # optional override (defaults to `${KINDE_HOST}/api`)
   # KINDE_AUDIENCE=<your-api>
   ```

   > **Important:** Only set confirm flags to `true` when you really intend to run destructive deletes.

3. **(Optional) Add an npm script**

   In `package.json`:

   ```json
   "scripts": {
     "delete:all-users": "ts-node deleteAllUsers.ts",
     "delete:org-identities": "ts-node deleteOrgUsersIdentities.ts"
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

### Delete identities for users in one org

From the repo root:

```bash
# Using ts-node directly
npx ts-node deleteOrgUsersIdentities.ts

# Or via npm script (if added)
npm run delete:org-identities
```

You will see logs for:

- org users pages (`next_token` pagination)
- per-user identity page fetches (`starting_after` pagination)
- each identity deletion
- retries on rate limits / transient errors
- final org summary (`users_processed`, `identities_deleted`, `identities_failed`)
