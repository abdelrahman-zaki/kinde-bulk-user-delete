import "dotenv/config";

type TokenResponse = {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
};

type User = {
    id: string;
    email?: string;
};

type GetUsersResponse = {
    code: string;
    users: User[];
    message?: string;
    next_token?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) =>
    console.log(`[${new Date().toISOString()}] ${msg}`);

const HOST = process.env.KINDE_HOST;
const CLIENT_ID = process.env.KINDE_CLIENT_ID;
const CLIENT_SECRET = process.env.KINDE_CLIENT_SECRET;
const PAGE_SIZE = Number(process.env.KINDE_PAGE_SIZE ?? "10");

const AUDIENCE = process.env.KINDE_AUDIENCE ?? `${HOST}/api`;

const MAX_RETRIES = Number(process.env.KINDE_MAX_RETRIES ?? "6");
const BASE_DELAY_MS = Number(process.env.KINDE_BASE_DELAY_MS ?? "500");

const CONFIRM_DELETE_ALL =
    (process.env.KINDE_CONFIRM_DELETE_ALL ?? "").toLowerCase() === "true";

if (!CLIENT_ID || !CLIENT_SECRET || !HOST) {
    throw new Error(
        "Missing env vars. Required: KINDE_CLIENT_ID, KINDE_CLIENT_SECRET, KINDE_HOST"
    );
}

if (!CONFIRM_DELETE_ALL) {
    throw new Error(
        "Refusing to run. Set KINDE_CONFIRM_DELETE_ALL=true in your .env to confirm."
    );
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(force = false): Promise<string> {
    if (!force && tokenCache && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }

    log(`Requesting M2M access token...`);
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID!,
        client_secret: CLIENT_SECRET!,
        audience: AUDIENCE,
    });

    const resp = await fetch(`${HOST}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Token request failed ${resp.status}: ${text}`);
    }

    const json = (await resp.json()) as TokenResponse;
    const expiresIn = json.expires_in ?? 3600;

    // subtract 60s as safety skew
    tokenCache = {
        token: json.access_token,
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };

    log(`Got access token (expires in ~${expiresIn}s).`);
    return tokenCache.token;
}

async function requestWithRetry(
    url: string,
    init: RequestInit,
    attempt = 0
): Promise<Response> {
    const token = await getAccessToken();
    const headers = new Headers(init.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    init.headers = headers;

    const resp = await fetch(url, init);

    // If token expired/invalid, refresh once and retry
    if (resp.status === 401 && attempt < 1) {
        log(`401 Unauthorized. Refreshing token and retrying once...`);
        await getAccessToken(true);
        return requestWithRetry(url, init, attempt + 1);
    }

    // Rate limit or transient server errors => backoff retry
    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = resp.headers.get("retry-after");
        const baseDelay = retryAfter
            ? Number(retryAfter) * 1000
            : Math.min(BASE_DELAY_MS * 2 ** attempt, 15000);
        const jitter = Math.floor(Math.random() * 250);

        log(
            `Request throttled/failed (${resp.status}). Retrying in ${baseDelay + jitter
            }ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );

        await sleep(baseDelay + jitter);
        return requestWithRetry(url, init, attempt + 1);
    }

    return resp;
}

async function getUsersPage(nextToken?: string): Promise<GetUsersResponse> {
    const url = new URL(`${HOST}/api/v1/users`);
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (nextToken) url.searchParams.set("next_token", nextToken);

    log(
        `Fetching users page${nextToken ? ` (next_token=${nextToken})` : ""
        }...`
    );

    const resp = await requestWithRetry(url.toString(), { method: "GET" });
    const text = await resp.text();

    if (!resp.ok) {
        throw new Error(`GET /users failed ${resp.status}: ${text}`);
    }

    return JSON.parse(text) as GetUsersResponse;
}

async function collectAllUsers(): Promise<User[]> {
    const all: User[] = [];
    let nextToken: string | undefined;
    let prevToken: string | undefined;
    let page = 0;

    while (true) {
        page++;
        const data = await getUsersPage(nextToken);
        const users = data.users ?? [];

        log(`Page ${page}: received ${users.length} users.`);
        all.push(...users);

        prevToken = nextToken;
        nextToken = data.next_token;

        // stop if no token, no progress, or empty page
        if (!nextToken || nextToken === prevToken || users.length === 0) {
            if (!nextToken) log(`No next_token returned. Pagination complete.`);
            else if (nextToken === prevToken)
                log(`next_token did not advance. Pagination complete.`);
            else log(`Empty page returned. Pagination complete.`);
            break;
        }
    }

    log(`Collected total ${all.length} users.`);
    return all;
}

async function deleteUser(userId: string): Promise<void> {
    const url = new URL(`${HOST}/api/v1/user`);
    url.searchParams.set("id", userId);

    log(`Deleting user ${userId}...`);
    const resp = await requestWithRetry(url.toString(), { method: "DELETE" });
    const text = await resp.text();

    if (!resp.ok) {
        throw new Error(`DELETE /user failed ${resp.status}: ${text}`);
    }

    log(`Deleted user ${userId}.`);
}

async function deleteAllUsers(users: User[]) {
    let success = 0;
    let failed = 0;

    for (const [i, u] of users.entries()) {
        const label = u.email ? `${u.email} (${u.id})` : u.id;
        try {
            log(`(${i + 1}/${users.length}) Deleting ${label}...`);
            await deleteUser(u.id);
            success++;
        } catch (err: any) {
            failed++;
            log(`Failed to delete ${u.id}: ${err?.message || err}`);
        }
    }

    log(`Deletion finished. success=${success}, failed=${failed}`);
}

(async function main() {
    try {
        log(`Starting delete-all-users script against ${HOST}`);
        log(`page_size=${PAGE_SIZE}`);

        const users = await collectAllUsers();
        if (users.length === 0) {
            log(`No users found. Nothing to delete.`);
            return;
        }

        await deleteAllUsers(users);

        log(`Done.`);
    } catch (err: any) {
        console.error(err);
        process.exitCode = 1;
    }
})();
