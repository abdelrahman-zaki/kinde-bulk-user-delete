import "dotenv/config";

type TokenResponse = {
    access_token: string;
    expires_in: number;
    token_type: string;
    scope?: string;
};

type ApiErrorItem = {
    code?: string;
    message?: string;
};

type ApiErrorResponse = {
    code?: string;
    message?: string;
    errors?: ApiErrorItem[];
};

type OrganizationUser = {
    id: string;
    email?: string;
};

type GetOrganizationUsersResponse = {
    code: string;
    message?: string;
    organization_users?: OrganizationUser[];
    next_token?: string;
};

type Identity = {
    id: string;
    type?: string;
    email?: string;
    name?: string;
    is_primary?: boolean;
};

type GetUserIdentitiesResponse = {
    code?: string;
    message?: string;
    identities?: Identity[];
    has_more?: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg: string) =>
    console.log(`[${new Date().toISOString()}] ${msg}`);

function requiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing env var: ${name}`);
    }
    return value;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}="${raw}". Expected a positive integer.`);
    }

    return value;
}

function parseNonNegativeIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") {
        return fallback;
    }

    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(
            `Invalid ${name}="${raw}". Expected a non-negative integer.`
        );
    }

    return value;
}

function tryParseJson<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function formatErrorBody(text: string): string {
    const parsed = tryParseJson<ApiErrorResponse>(text);
    if (!parsed) {
        return text || "No response body";
    }

    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        return parsed.errors
            .map((e) => [e.code, e.message].filter(Boolean).join(": "))
            .join("; ");
    }

    if (parsed.code || parsed.message) {
        return [parsed.code, parsed.message].filter(Boolean).join(": ");
    }

    return text || "No response body";
}

function parseRetryAfterMs(retryAfter: string | null): number | undefined {
    if (!retryAfter) {
        return undefined;
    }

    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
    }

    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }

    return undefined;
}

const HOST = requiredEnv("KINDE_HOST");
const CLIENT_ID = requiredEnv("KINDE_CLIENT_ID");
const CLIENT_SECRET = requiredEnv("KINDE_CLIENT_SECRET");
const ORG_CODE = requiredEnv("KINDE_ORG_CODE");

const PAGE_SIZE = parsePositiveIntEnv("KINDE_PAGE_SIZE", 50);
const MAX_RETRIES = parseNonNegativeIntEnv("KINDE_MAX_RETRIES", 6);
const BASE_DELAY_MS = parsePositiveIntEnv("KINDE_BASE_DELAY_MS", 500);

const AUDIENCE = process.env.KINDE_AUDIENCE ?? `${HOST}/api`;
const CONFIRM_DELETE =
    (process.env.KINDE_CONFIRM_DELETE_ALL ?? "").toLowerCase() ===
    "true";

if (!CONFIRM_DELETE) {
    throw new Error(
        "Refusing to run. Set KINDE_CONFIRM_DELETE_ALL=true in your .env to confirm."
    );
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(force = false): Promise<string> {
    if (!force && tokenCache && Date.now() < tokenCache.expiresAt) {
        return tokenCache.token;
    }

    log("Requesting M2M access token...");

    const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        audience: AUDIENCE,
    });

    const response = await fetch(`${HOST}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });

    const text = await response.text();
    if (!response.ok) {
        throw new Error(`Token request failed ${response.status}: ${formatErrorBody(text)}`);
    }

    const json = tryParseJson<TokenResponse>(text);
    if (!json?.access_token) {
        throw new Error("Token request succeeded but response did not include access_token.");
    }

    const expiresIn = json.expires_in ?? 3600;
    tokenCache = {
        token: json.access_token,
        expiresAt: Date.now() + Math.max(expiresIn - 60, 0) * 1000,
    };

    log(`Got access token (expires in ~${expiresIn}s).`);
    return tokenCache.token;
}

async function requestWithRetry(
    url: string,
    init: RequestInit,
    attempt = 0,
    refreshedAfter401 = false
): Promise<Response> {
    const token = await getAccessToken();
    const headers = new Headers(init.headers ?? {});
    headers.set("Authorization", `Bearer ${token}`);

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && !refreshedAfter401) {
        log("401 Unauthorized. Refreshing token and retrying once...");
        await getAccessToken(true);
        return requestWithRetry(url, init, attempt, true);
    }

    if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoffMs = Math.min(BASE_DELAY_MS * 2 ** attempt, 15000);
        const waitMs = (retryAfterMs ?? backoffMs) + Math.floor(Math.random() * 250);

        log(
            `Request throttled/failed (${response.status}). Retrying in ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
        );

        await sleep(waitMs);
        return requestWithRetry(url, init, attempt + 1, refreshedAfter401);
    }

    return response;
}

async function getOrganizationUsersPage(
    nextToken?: string
): Promise<GetOrganizationUsersResponse> {
    const url = new URL(
        `${HOST}/api/v1/organizations/${encodeURIComponent(ORG_CODE)}/users`
    );
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (nextToken) {
        url.searchParams.set("next_token", nextToken);
    }

    log(
        `Fetching org users page${nextToken ? ` (next_token=${nextToken})` : ""}...`
    );

    const response = await requestWithRetry(url.toString(), { method: "GET" });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `GET /organizations/${ORG_CODE}/users failed ${response.status}: ${formatErrorBody(text)}`
        );
    }

    const data = tryParseJson<GetOrganizationUsersResponse>(text);
    if (!data) {
        throw new Error("GET /organizations/{org_code}/users returned invalid JSON.");
    }

    return data;
}

async function collectOrganizationUsers(): Promise<OrganizationUser[]> {
    const users: OrganizationUser[] = [];
    let nextToken: string | undefined;
    let page = 0;

    while (true) {
        page++;
        const data = await getOrganizationUsersPage(nextToken);
        const pageUsers = data.organization_users ?? [];

        log(`Org users page ${page}: received ${pageUsers.length} users.`);
        users.push(...pageUsers);

        const newNextToken = data.next_token;

        // Intentionally stop on empty page, even if next_token exists.
        if (pageUsers.length === 0) {
            log("Empty page returned. Pagination complete.");
            break;
        }

        if (!newNextToken) {
            log("No next_token returned. Pagination complete.");
            break;
        }

        if (newNextToken === nextToken) {
            log("next_token did not advance. Pagination complete.");
            break;
        }

        nextToken = newNextToken;
    }

    log(`Collected total ${users.length} organization users.`);
    return users;
}

async function getUserIdentitiesPage(
    userId: string,
    cursor: { startingAfter?: string; endingBefore?: string } = {}
): Promise<GetUserIdentitiesResponse> {
    const url = new URL(`${HOST}/api/v1/users/${encodeURIComponent(userId)}/identities`);
    url.searchParams.set("page_size", String(PAGE_SIZE));

    if (cursor.startingAfter) {
        url.searchParams.set("starting_after", cursor.startingAfter);
    }
    if (cursor.endingBefore) {
        url.searchParams.set("ending_before", cursor.endingBefore);
    }

    const response = await requestWithRetry(url.toString(), { method: "GET" });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `GET /users/${userId}/identities failed ${response.status}: ${formatErrorBody(text)}`
        );
    }

    const data = tryParseJson<GetUserIdentitiesResponse>(text);
    if (!data) {
        throw new Error(`GET /users/${userId}/identities returned invalid JSON.`);
    }

    return data;
}

async function deleteIdentity(identityId: string): Promise<void> {
    const url = `${HOST}/api/v1/identities/${encodeURIComponent(identityId)}`;
    const response = await requestWithRetry(url, { method: "DELETE" });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `DELETE /identities/${identityId} failed ${response.status}: ${formatErrorBody(text)}`
        );
    }
}

async function collectAllUserIdentities(
    user: OrganizationUser,
    userIndex: number,
    totalUsers: number
): Promise<Identity[]> {
    const userLabel = user.email ? `${user.email} (${user.id})` : user.id;
    const allIdentities: Identity[] = [];
    log(`(${userIndex}/${totalUsers}) Collecting identities for user ${userLabel}...`);

    let page = 0;
    let startingAfter: string | undefined;

    while (true) {
        page++;
        const data = await getUserIdentitiesPage(user.id, { startingAfter });
        const identities = data.identities ?? [];

        log(
            `(${userIndex}/${totalUsers}) ${userLabel}: identities page ${page} returned ${identities.length} identities.`
        );

        if (identities.length === 0) {
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: empty identities page. Pagination complete.`
            );
            break;
        }

        allIdentities.push(...identities);

        if (!data.has_more) {
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: has_more=false. Pagination complete.`
            );
            break;
        }

        const newStartingAfter = identities[identities.length - 1]?.id;
        if (!newStartingAfter) {
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: no identity cursor available. Pagination complete.`
            );
            break;
        }

        if (newStartingAfter === startingAfter) {
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: cursor did not advance. Pagination complete.`
            );
            break;
        }

        startingAfter = newStartingAfter;
    }

    log(
        `(${userIndex}/${totalUsers}) ${userLabel}: collected ${allIdentities.length} identities.`
    );

    return allIdentities;
}

async function deleteAllUserIdentities(
    user: OrganizationUser,
    userIndex: number,
    totalUsers: number
): Promise<{ deleted: number; failed: number; processed: number }> {
    const userLabel = user.email ? `${user.email} (${user.id})` : user.id;
    log(`(${userIndex}/${totalUsers}) Processing user ${userLabel}...`);

    const identities = await collectAllUserIdentities(user, userIndex, totalUsers);
    if (identities.length === 0) {
        log(`(${userIndex}/${totalUsers}) ${userLabel}: no identities to delete.`);
        return { deleted: 0, failed: 0, processed: 0 };
    }

    let deleted = 0;
    let failed = 0;
    let processed = 0;
    const uniqueIdentityIds = Array.from(
        new Set(
            identities
                .map((identity) => identity.id)
                .filter((id): id is string => Boolean(id))
        )
    );

    for (const [index, identityId] of uniqueIdentityIds.entries()) {
        processed = index + 1;

        try {
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: deleting identity ${processed}/${uniqueIdentityIds.length} ${identityId}...`
            );
            await deleteIdentity(identityId);
            deleted++;
        } catch (err: any) {
            failed++;
            log(
                `(${userIndex}/${totalUsers}) ${userLabel}: failed to delete identity ${identityId}: ${err?.message || err}`
            );
        }
    }

    log(
        `(${userIndex}/${totalUsers}) ${userLabel}: finished. identities_processed=${processed}, deleted=${deleted}, failed=${failed}`
    );

    return { deleted, failed, processed };
}

(async function main() {
    try {
        log(`Starting delete-org-users-identities script against ${HOST}`);
        log(
            `org_code=${ORG_CODE}, page_size=${PAGE_SIZE}`
        );

        const orgUsers = await collectOrganizationUsers();
        if (orgUsers.length === 0) {
            log("No users found in organization. Nothing to delete.");
            return;
        }

        let usersProcessed = 0;
        let identitiesProcessed = 0;
        let identitiesDeleted = 0;
        let identitiesFailed = 0;

        for (const [index, user] of orgUsers.entries()) {
            const result = await deleteAllUserIdentities(
                user,
                index + 1,
                orgUsers.length
            );

            usersProcessed++;
            identitiesProcessed += result.processed;
            identitiesDeleted += result.deleted;
            identitiesFailed += result.failed;
        }

        log(
            `Deletion finished for org ${ORG_CODE}. users_processed=${usersProcessed}, identities_processed=${identitiesProcessed}, identities_deleted=${identitiesDeleted}, identities_failed=${identitiesFailed}`
        );

        if (identitiesFailed > 0) {
            process.exitCode = 1;
        }
    } catch (err: any) {
        console.error(err);
        process.exitCode = 1;
    }
})();
