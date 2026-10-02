import { isJsonObject } from "../../utils/kieTask.ts";
import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import { getGrokMediaToken, grokMediaHeaders } from "../grokMedia.ts";

interface XaiVideoBody {
  prompt?: unknown;
  image?: unknown;
  duration?: unknown;
  aspect_ratio?: unknown;
  resolution?: unknown;
  timeout_ms?: unknown;
  poll_interval_ms?: unknown;
  [key: string]: unknown;
}

interface XaiVideoLog {
  info: (scope: string, message: string) => void;
  error: (scope: string, message: string) => void;
}

/** Map the OmniRoute video body onto xAI's create-job payload. */
function buildXaiVideoPayload(model: string, prompt: string, body: XaiVideoBody) {
  const payload: Record<string, unknown> = { model, prompt };
  if (typeof body.image === "string") payload.image = body.image;
  if (body.duration != null) payload.duration = Number(body.duration);
  if (typeof body.aspect_ratio === "string") payload.aspect_ratio = body.aspect_ratio;
  if (typeof body.resolution === "string") payload.resolution = body.resolution;
  return payload;
}

function xaiVideoErrorMessage(
  data: { error?: { message?: unknown }; message?: unknown } | null,
  fallback: string
) {
  return sanitizeErrorMessage(String(data?.error?.message || data?.message || fallback));
}

/** POST the create-job request; resolves to the request_id or a ready error message. */
async function createXaiVideoJob({
  baseUrl,
  token,
  payload,
  log,
  headers = {},
  deadline,
}: {
  baseUrl: string;
  token: string;
  payload: Record<string, unknown>;
  log?: XaiVideoLog | null;
  headers?: Record<string, string>;
  deadline: number;
}): Promise<{ requestId?: string; error?: string; status?: number }> {
  const createRes = await fetch(`${baseUrl}/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    redirect: "error",
  });
  const createData = await createRes.json().catch(() => ({}));
  const requestId = createData?.request_id;
  if (createRes.ok && typeof requestId === "string" && /^[A-Za-z0-9_-]+$/.test(requestId)) {
    return { requestId };
  }

  const errorMessage = xaiVideoErrorMessage(
    createData,
    "xAI video generation did not return request_id"
  );
  if (log) {
    log.error("VIDEO", `xAI createJob failed (${createRes.status}): ${errorMessage}`);
  }
  return {
    error: errorMessage,
    status: createRes.ok ? 502 : createRes.status,
  };
}

type XaiPollOutcome =
  | { terminal: "done"; videoUrl?: string }
  | { terminal: "failed"; error?: unknown }
  | { terminal: "error"; status: number; error: string }
  | { terminal: "timeout"; lastStatus: string };

async function pollXaiVideoJob({
  statusUrl,
  requestId,
  token,
  deadline,
  pollIntervalMs,
  headers = {},
}: {
  statusUrl: string;
  requestId: string;
  token: string;
  deadline: number;
  pollIntervalMs: number;
  headers?: Record<string, string>;
}): Promise<XaiPollOutcome> {
  let lastStatus = "pending";
  while (Date.now() < deadline) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())))
    );
    if (Date.now() >= deadline) break;
    const pollRes = await fetch(`${statusUrl}/${requestId}`, {
      headers: { Authorization: `Bearer ${token}`, ...headers },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      redirect: "error",
    });
    const pollData = await pollRes.json().catch(() => ({}));
    if (!pollRes.ok) {
      return {
        terminal: "error",
        status: pollRes.status,
        error: xaiVideoErrorMessage(pollData, `xAI video job ${requestId} polling failed`),
      };
    }
    lastStatus = pollData?.status || "pending";

    if (lastStatus === "done") return { terminal: "done", videoUrl: pollData?.video?.url };
    if (lastStatus === "failed") return { terminal: "failed", error: pollData?.error };
    // pending / processing → keep polling
  }
  return { terminal: "timeout", lastStatus };
}

/** Resolve the request knobs (timeouts, credential, endpoints, prompt) from the call. */
function resolveXaiVideoOptions(
  body: XaiVideoBody,
  providerConfig: { baseUrl: string; statusUrl?: string },
  credentials?: { apiKey?: string; accessToken?: string } | null
) {
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  return {
    timeoutMs:
      Number.isFinite(Number(body.timeout_ms)) && Number(body.timeout_ms) > 0
        ? Math.max(1, Math.floor(Math.min(Number(body.timeout_ms), 2147483647)))
        : 300000,
    pollIntervalMs:
      Number.isFinite(Number(body.poll_interval_ms)) && Number(body.poll_interval_ms) > 0
        ? Math.max(1, Math.floor(Math.min(Number(body.poll_interval_ms), 2147483647)))
        : 2500,
    token: credentials?.apiKey || credentials?.accessToken,
    baseUrl,
    statusUrl: (providerConfig.statusUrl || baseUrl).replace(/\/$/, ""),
    prompt: typeof body.prompt === "string" ? body.prompt : String(body.prompt ?? ""),
  };
}

/** Map a terminal poll outcome onto the OpenAI-like video response (or an error). */
function buildXaiVideoResponse({
  outcome,
  requestId,
  provider,
  model,
  startTime,
}: {
  outcome: XaiPollOutcome;
  requestId: string;
  provider: string;
  model: string;
  startTime: number;
}) {
  if (outcome.terminal === "failed") {
    return {
      success: false,
      status: 502,
      error: sanitizeErrorMessage(String(outcome.error || "xAI video job failed")),
    };
  }

  if (outcome.terminal === "error") {
    return { success: false, status: outcome.status, error: outcome.error };
  }

  if (outcome.terminal === "timeout") {
    return {
      success: false,
      status: 504,
      error: sanitizeErrorMessage(
        `xAI video job ${requestId} timed out (status: ${outcome.lastStatus})`
      ),
    };
  }

  if (!outcome.videoUrl) {
    return { success: false, status: 502, error: "xAI video job done but no video.url" };
  }

  saveCallLog({
    method: "POST",
    path: "/v1/videos/generations",
    status: 200,
    model: `${provider}/${model}`,
    provider,
    duration: Date.now() - startTime,
    responseBody: { videos_count: 1 },
  }).catch(() => {});

  return {
    success: true,
    data: {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: outcome.videoUrl, format: "mp4" }],
    },
  };
}

export async function handleXaiVideoGeneration({
  model,
  provider,
  providerConfig,
  body,
  credentials,
  log,
}: {
  model: string;
  provider: string;
  providerConfig: { baseUrl: string; statusUrl?: string };
  body: XaiVideoBody;
  credentials?: { apiKey?: string; accessToken?: string } | null;
  log?: XaiVideoLog | null;
}) {
  const startTime = Date.now();
  const { timeoutMs, pollIntervalMs, token, baseUrl, statusUrl, prompt } = resolveXaiVideoOptions(
    body,
    providerConfig,
    credentials
  );

  if (!token) {
    return { success: false, status: 401, error: "xAI API key is required" };
  }

  if (log) {
    log.info("VIDEO", `${provider}/${model} (xai-video) | prompt: "${prompt.slice(0, 60)}..."`);
  }

  try {
    const requestToken = provider === "grok-cli" ? await getGrokMediaToken(credentials) : token;
    const headers = provider === "grok-cli" ? grokMediaHeaders(requestToken) : {};
    const created = await createXaiVideoJob({
      baseUrl,
      token: requestToken,
      payload: buildXaiVideoPayload(model, prompt, body),
      log,
      headers,
      deadline: startTime + timeoutMs,
    });
    if (!created.requestId) {
      return { success: false, status: created.status || 502, error: created.error };
    }

    const outcome = await pollXaiVideoJob({
      statusUrl,
      requestId: created.requestId,
      token: requestToken,
      deadline: startTime + timeoutMs,
      pollIntervalMs,
      headers,
    });

    return buildXaiVideoResponse({
      outcome,
      requestId: created.requestId,
      provider,
      model,
      startTime,
    });
  } catch (err: unknown) {
    return {
      success: false,
      status:
        err instanceof Error && ["TimeoutError", "AbortError"].includes(err.name)
          ? 504
          : isJsonObject(err) && Number.isFinite(Number(err.status))
            ? Number(err.status)
            : 502,
      error: sanitizeErrorMessage(err) || "Video provider error",
    };
  }
}
