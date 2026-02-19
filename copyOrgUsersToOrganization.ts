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
    code?: string;
    message?: string;
    organization_users?: OrganizationUser[];
    next_token?: string;
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

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
        chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
}

const HOST = requiredEnv("KINDE_HOST");
const CLIENT_ID = requiredEnv("KINDE_CLIENT_ID");
const CLIENT_SECRET = requiredEnv("KINDE_CLIENT_SECRET");
const SOURCE_ORG_CODE =
    process.env.KINDE_SOURCE_ORG_CODE ?? process.env.KINDE_ORG_CODE;
const TARGET_ORG_CODE = requiredEnv("KINDE_TARGET_ORG_CODE");

if (!SOURCE_ORG_CODE) {
    throw new Error(
        "Missing source org. Set KINDE_SOURCE_ORG_CODE (or KINDE_ORG_CODE)."
    );
}

if (SOURCE_ORG_CODE === TARGET_ORG_CODE) {
    throw new Error(
        "Source and target org codes are the same. Use different org codes."
    );
}

const PAGE_SIZE = parsePositiveIntEnv("KINDE_PAGE_SIZE", 50);
const ASSIGN_BATCH_SIZE = parsePositiveIntEnv("KINDE_ASSIGN_BATCH_SIZE", 50);
const MAX_RETRIES = parseNonNegativeIntEnv("KINDE_MAX_RETRIES", 6);
const BASE_DELAY_MS = parsePositiveIntEnv("KINDE_BASE_DELAY_MS", 500);

const AUDIENCE = process.env.KINDE_AUDIENCE ?? `${HOST}/api`;
const CONFIRM_COPY_ORG_USERS =
    (process.env.KINDE_CONFIRM_COPY_ORG_USERS ?? "").toLowerCase() === "true";

if (!CONFIRM_COPY_ORG_USERS) {
    throw new Error(
        "Refusing to run. Set KINDE_CONFIRM_COPY_ORG_USERS=true in your .env to confirm."
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
        throw new Error(
            `Token request failed ${response.status}: ${formatErrorBody(text)}`
        );
    }

    const json = tryParseJson<TokenResponse>(text);
    if (!json?.access_token) {
        throw new Error(
            "Token request succeeded but response did not include access_token."
        );
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

    if (
        (response.status === 429 || response.status >= 500) &&
        attempt < MAX_RETRIES
    ) {
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
    orgCode: string,
    nextToken?: string
): Promise<GetOrganizationUsersResponse> {
    const url = new URL(
        `${HOST}/api/v1/organizations/${encodeURIComponent(orgCode)}/users`
    );
    url.searchParams.set("page_size", String(PAGE_SIZE));
    if (nextToken) {
        url.searchParams.set("next_token", nextToken);
    }

    log(
        `Fetching users for org ${orgCode}${nextToken ? ` (next_token=${nextToken})` : ""}...`
    );

    const response = await requestWithRetry(url.toString(), { method: "GET" });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `GET /organizations/${orgCode}/users failed ${response.status}: ${formatErrorBody(text)}`
        );
    }

    const data = tryParseJson<GetOrganizationUsersResponse>(text);
    if (!data) {
        throw new Error("GET /organizations/{org_code}/users returned invalid JSON.");
    }

    return data;
}

async function collectOrganizationUserIds(
    orgCode: string
): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let nextToken: string | undefined;
    let pages = 0;

    while (true) {
        pages++;
        const data = await getOrganizationUsersPage(orgCode, nextToken);
        const pageUsers = data.organization_users ?? [];
        const pageIds = pageUsers
            .map((user) => user.id)
            .filter((id): id is string => Boolean(id));

        log(`Org ${orgCode} page ${pages}: received ${pageUsers.length} users.`);
        ids.push(...pageIds);

        const newNextToken = data.next_token;

        // Stop on empty page even when next_token is returned.
        if (pageUsers.length === 0) {
            log(`Org ${orgCode}: empty page returned. Pagination complete.`);
            break;
        }

        if (!newNextToken) {
            log(`Org ${orgCode}: no next_token returned. Pagination complete.`);
            break;
        }

        if (newNextToken === nextToken) {
            log(`Org ${orgCode}: next_token did not advance. Pagination complete.`);
            break;
        }

        nextToken = newNextToken;
    }

    const uniqueIds = Array.from(new Set(ids));
    const duplicates = ids.length - uniqueIds.length;
    log(
        `Org ${orgCode}: collected ${uniqueIds.length} unique users across ${pages} page(s). duplicate_ids_removed=${duplicates}`
    );

    return { ids: uniqueIds, pages };
}

async function addUsersToOrganizationBatch(
    targetOrgCode: string,
    userIds: string[]
): Promise<void> {
    const url = `${HOST}/api/v1/organizations/${encodeURIComponent(targetOrgCode)}/users`;
    const body = JSON.stringify({
        users: userIds.map((id) => ({ id })),
    });

    const response = await requestWithRetry(url, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body,
    });
    const text = await response.text();

    if (!response.ok) {
        throw new Error(
            `POST /organizations/${targetOrgCode}/users failed ${response.status}: ${formatErrorBody(text)}`
        );
    }
}

async function addUsersToTargetOrganization(
    targetOrgCode: string,
    userIds: string[]
): Promise<{
    added: number;
    failed: number;
    batchesProcessed: number;
    batchFailures: number;
}> {
    const batches = chunkArray(userIds, ASSIGN_BATCH_SIZE);
    let added = 0;
    let failed = 0;
    let batchFailures = 0;
    let batchesProcessed = 0;

    for (const [batchIndex, batch] of batches.entries()) {
        const humanBatchIndex = batchIndex + 1;
        batchesProcessed = humanBatchIndex;

        try {
            log(
                `Adding batch ${humanBatchIndex}/${batches.length} to org ${targetOrgCode} (size=${batch.length})...`
            );
            await addUsersToOrganizationBatch(targetOrgCode, batch);
            added += batch.length;
        } catch (err: any) {
            batchFailures++;
            log(
                `Batch ${humanBatchIndex}/${batches.length} failed: ${err?.message || err}`
            );

            if (batch.length === 1) {
                failed++;
                continue;
            }

            log(
                `Retrying failed batch ${humanBatchIndex}/${batches.length} as individual requests...`
            );

            for (const [singleIndex, userId] of batch.entries()) {
                try {
                    log(
                        `Batch ${humanBatchIndex}/${batches.length} fallback ${singleIndex + 1}/${batch.length}: adding user ${userId}...`
                    );
                    await addUsersToOrganizationBatch(targetOrgCode, [userId]);
                    added++;
                } catch (singleErr: any) {
                    failed++;
                    log(
                        `Failed to add user ${userId} during fallback: ${singleErr?.message || singleErr}`
                    );
                }
            }
        }
    }

    return { added, failed, batchesProcessed, batchFailures };
}

(async function main() {
    try {
        log(`Starting copy-org-users script against ${HOST}`);
        log(
            `source_org=${SOURCE_ORG_CODE}, target_org=${TARGET_ORG_CODE}, page_size=${PAGE_SIZE}, assign_batch_size=${ASSIGN_BATCH_SIZE}`
        );

        const source = await collectOrganizationUserIds(SOURCE_ORG_CODE);
        if (source.ids.length === 0) {
            log("Source organization has no users. Nothing to add.");
            return;
        }

        const target = await collectOrganizationUserIds(TARGET_ORG_CODE);
        const targetIds = new Set(target.ids);
        const usersToAdd = source.ids.filter((id) => !targetIds.has(id));

        log(
            `Planning assignment: source_users=${source.ids.length}, target_users=${target.ids.length}, already_in_target=${source.ids.length - usersToAdd.length}, to_add=${usersToAdd.length}`
        );

        if (usersToAdd.length === 0) {
            log("All source users already exist in target org. Nothing to add.");
            return;
        }

        const result = await addUsersToTargetOrganization(
            TARGET_ORG_CODE,
            usersToAdd
        );

        log(
            `Assignment finished. source_users=${source.ids.length}, target_users_before=${target.ids.length}, users_targeted=${usersToAdd.length}, added=${result.added}, failed=${result.failed}, batches_processed=${result.batchesProcessed}, batch_failures=${result.batchFailures}`
        );

        if (result.failed > 0) {
            process.exitCode = 1;
        }
    } catch (err: any) {
        console.error(err);
        process.exitCode = 1;
    }
})();
