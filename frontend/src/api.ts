/**
 * Typed client for the backend.
 *
 * All URLs are relative, never absolute: in development Vite proxies /api to
 * uvicorn, and in production the reverse proxy does the same, so there is no
 * API base URL to configure and no CORS to negotiate in either mode.
 */

import type {
  Board,
  BulkImportResult,
  CitationExport,
  DiscoverResponse,
  ImportResult,
  IntegrityReport,
  Item,
  ItemPage,
  Link,
  NearDuplicatePair,
  OnThisDayGroup,
  ReconciliationReport,
  Settings,
  SortKey,
  Tag,
  TagCategory,
  TagGraph,
  TagGraphRule,
  TagMergeResult,
  TagSuggestion,
  UploadResult,
  VersionList,
} from "./types";

export class ApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Notified whenever the API reports that the session is gone. `main.ts` uses it
 * to swap in the login screen from anywhere, so no view has to check for 401
 * itself — a session can expire mid-session, during any request, and every call
 * site handling that individually would be both repetitive and easy to forget.
 */
type UnauthorizedHandler = (setupRequired: boolean) => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

/**
 * Notified whenever a request to the backend fails at the network level
 * (server restarted, network blip) versus a normal HTTP error response. A
 * self-hosted app has no support team to notice an outage for the person
 * using it, so the UI has to say so itself — `main.ts` uses this to show a
 * connectivity banner rather than letting requests just start silently
 * failing with no explanation.
 */
type ConnectivityHandler = (online: boolean) => void;
let onConnectivityChange: ConnectivityHandler | null = null;

export function setConnectivityHandler(handler: ConnectivityHandler): void {
  onConnectivityChange = handler;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // `credentials: same-origin` is the default for same-origin requests but is
  // set explicitly because the Vite dev server proxies to a different port and
  // the session cookie must ride along there too. `cache: "no-store"` matters
  // for exactly the same reason random sort's reshuffle-on-reload silently
  // stopped working once: none of these responses carry cache-control
  // headers, so a repeated identical GET (e.g. `/api/items?random=true`, the
  // same URL on every reload) is a heuristic-freshness gamble the browser is
  // otherwise free to win by serving the old response instead of asking the
  // server again — nothing here should ever be served from the HTTP cache.
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  } catch (error) {
    // `fetch` itself throwing (not a non-2xx response — an actual network
    // failure) is exactly the "backend became unreachable mid-session" case,
    // distinct from every other error handled below.
    onConnectivityChange?.(false);
    throw new ApiError("Could not reach the backend — check your connection.", 0);
  }
  onConnectivityChange?.(true);

  if (response.status === 401 && !path.startsWith("/api/auth/")) {
    onUnauthorized?.(response.headers.get("X-Artboard-Setup-Required") === "1");
    throw new ApiError("Your session has expired — please log in again.", 401);
  }

  if (!response.ok) {
    // FastAPI puts the useful message in `detail`, which is either a string or
    // (for validation errors) a list of per-field objects. Surfacing the real
    // message matters: "422" alone tells the user nothing actionable.
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail) && body.detail.length) {
        detail = body.detail.map((d: { msg?: string }) => d.msg ?? "invalid").join("; ");
      }
    } catch {
      /* non-JSON error body: keep the status line */
    }
    throw new ApiError(detail, response.status);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function query(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)));
    else search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : "";
}

export interface ListItemsParams {
  q?: string;
  board?: number;
  subboard_tag?: number[];
  sort?: SortKey;
  cursor?: string | null;
  limit?: number;
  random?: boolean;
}

export interface AuthStatus {
  authenticated: boolean;
  setup_required: boolean;
}

export interface HealthStatus {
  status: string;
  version: string;
}

export const api = {
  // --- meta ---
  health: () => request<HealthStatus>("/api/health"),

  // --- auth ---
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  setup: (password: string, setupToken: string) =>
    request<AuthStatus>("/api/auth/setup", json("POST", { password, setup_token: setupToken })),
  login: (password: string) => request<AuthStatus>("/api/auth/login", json("POST", { password })),
  logout: () => request<void>("/api/auth/logout", { method: "POST" }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>("/api/auth/password", json("POST", { current_password: currentPassword, new_password: newPassword })),

  // --- items ---
  listItems: (params: ListItemsParams = {}) => request<ItemPage>(`/api/items${query({ ...params })}`),
  getItem: (id: number) => request<Item>(`/api/items/${id}`),
  untagged: (cursor?: string | null) => request<ItemPage>(`/api/items/untagged${query({ cursor })}`),
  onThisDay: () => request<OnThisDayGroup[]>("/api/items/on-this-day"),
  recommendations: (id: number) => request<Item[]>(`/api/items/${id}/recommendations`),
  itemCitation: (id: number) => request<CitationExport>(`/api/items/${id}/citation`),

  upload: (file: File, fields: { title?: string; tags?: string } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (fields.title) form.append("title", fields.title);
    if (fields.tags) form.append("tags", fields.tags);
    return request<UploadResult>("/api/items", { method: "POST", body: form });
  },

  bulkImport: (files: File[], meta: { tags?: string; boardId?: number } = {}) => {
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    // Sent with the upload rather than as follow-up calls: uploading and then
    // failing to tag would leave images with no indication which ones were
    // meant to carry the labels.
    if (meta.tags) form.append("tags", meta.tags);
    if (meta.boardId !== undefined) form.append("board_id", String(meta.boardId));
    return request<BulkImportResult>("/api/items/bulk-import", { method: "POST", body: form });
  },

  patchItem: (
    id: number,
    body: Partial<Pick<Item, "title" | "description" | "source_url" | "variant_label">> & { tags?: string[] },
  ) => request<Item>(`/api/items/${id}`, json("PATCH", body)),

  bulk: (body: {
    item_ids: number[];
    action: "tag" | "untag" | "add_to_board" | "remove_from_board" | "delete" | "restore";
    tags?: string[];
    board_id?: number;
  }) => request<{ affected: number }>("/api/items/bulk", json("POST", body)),

  // --- versions ---
  listVersions: (id: number) => request<VersionList>(`/api/items/${id}/versions`),
  addVersion: (id: number, file: File, makeCanonical = false) => {
    const form = new FormData();
    form.append("file", file);
    form.append("make_canonical", String(makeCanonical));
    return request<VersionList>(`/api/items/${id}/versions`, { method: "POST", body: form });
  },
  setCanonical: (id: number, versionId: number) =>
    request<VersionList>(`/api/items/${id}/canonical`, json("PUT", { version_id: versionId })),
  detachVersion: (id: number) =>
    request<Item>(`/api/items/${id}/versions/detach`, { method: "POST" }),

  deleteItem: (id: number) => request<Item>(`/api/items/${id}`, { method: "DELETE" }),
  restoreItem: (id: number) => request<Item>(`/api/items/${id}/restore`, { method: "POST" }),

  crop: (
    id: number,
    body: {
      x: number;
      y: number;
      w: number;
      h: number;
      target?: string | null;
      board_id?: number;
      output_width?: number;
      make_canonical?: boolean;
    },
  ) => request<Item>(`/api/items/${id}/crop`, json("POST", body)),

  // --- trash ---
  trash: (cursor?: string | null) => request<ItemPage>(`/api/trash${query({ cursor })}`),
  purge: (force = false) => request<{ purged: number }>(`/api/trash/purge${query({ force })}`, { method: "POST" }),
  purgeItem: (id: number) => request<void>(`/api/trash/${id}`, { method: "DELETE" }),

  // --- boards ---
  listBoards: () => request<Board[]>("/api/boards"),
  getBoard: (id: number) => request<Board>(`/api/boards/${id}`),
  createBoard: (body: {
    name: string;
    description?: string | null;
    is_dynamic?: boolean;
    query_tags?: { tag_id: number; match_mode: "all" | "any" }[];
  }) => request<Board>("/api/boards", json("POST", body)),
  patchBoard: (
    id: number,
    body: {
      name?: string;
      description?: string | null;
      position?: number;
      cover_item_id?: number;
      query_tags?: { tag_id: number; match_mode: "all" | "any" }[];
    },
  ) => request<Board>(`/api/boards/${id}`, json("PATCH", body)),
  deleteBoard: (id: number) => request<void>(`/api/boards/${id}`, { method: "DELETE" }),
  setBoardItems: (id: number, itemIds: number[]) =>
    request<Board>(`/api/boards/${id}/items`, json("PUT", { item_ids: itemIds })),
  setSubboardTag: (boardId: number, tagId: number, isActive: boolean) =>
    request<Board>(`/api/boards/${boardId}/subboard-tags/${tagId}`, json("PUT", { is_active: isActive })),
  boardCitation: (id: number) => request<CitationExport>(`/api/boards/${id}/citation`),
  boardTags: (id: number) => request<Tag[]>(`/api/boards/${id}/tags`),

  // --- tags ---
  listTags: () => request<Tag[]>("/api/tags"),
  suggestTags: (q: string, limit = 12) =>
    request<TagSuggestion[]>(`/api/tags/suggest${query({ q, limit })}`),
  createTag: (name: string, color?: string, categoryId?: number, linkUrl?: string) =>
    request<Tag>("/api/tags", json("POST", { name, color, category_id: categoryId, link_url: linkUrl })),
  patchTag: (
    id: number,
    body: {
      name?: string;
      color?: string;
      category_id?: number;
      clear_category?: boolean;
      link_url?: string;
      hide_from_feed?: boolean;
      icon?: string | null;
    },
  ) => request<Tag>(`/api/tags/${id}`, json("PATCH", body)),
  deleteTag: (id: number) => request<void>(`/api/tags/${id}`, { method: "DELETE" }),
  tagGraph: () => request<TagGraph>("/api/tags/graph"),
  unusedTags: () => request<Tag[]>("/api/tags/unused"),
  mergeTag: (id: number, intoTagId: number) =>
    request<TagMergeResult>(`/api/tags/${id}/merge`, json("POST", { into_tag_id: intoTagId })),

  // --- tag categories ---
  listTagCategories: () => request<TagCategory[]>("/api/tags/categories"),
  createTagCategory: (name: string, color: string, linksEnabled = false, icon?: string | null) =>
    request<TagCategory>(
      "/api/tags/categories",
      json("POST", { name, color, links_enabled: linksEnabled, icon }),
    ),
  patchTagCategory: (
    id: number,
    body: { name?: string; color?: string; links_enabled?: boolean; icon?: string | null },
  ) => request<TagCategory>(`/api/tags/categories/${id}`, json("PATCH", body)),
  deleteTagCategory: (id: number) => request<void>(`/api/tags/categories/${id}`, { method: "DELETE" }),

  // --- tag graph rules ---
  listGraphRules: () => request<TagGraphRule[]>("/api/tags/graph-rules"),
  createGraphRule: (fromCategoryId: number, toCategoryId: number, viaCategoryId: number, name?: string) =>
    request<TagGraphRule>(
      "/api/tags/graph-rules",
      json("POST", {
        name,
        from_category_id: fromCategoryId,
        to_category_id: toCategoryId,
        via_category_id: viaCategoryId,
      }),
    ),
  patchGraphRule: (
    id: number,
    body: { name?: string; from_category_id?: number; to_category_id?: number; via_category_id?: number },
  ) => request<TagGraphRule>(`/api/tags/graph-rules/${id}`, json("PATCH", body)),
  deleteGraphRule: (id: number) => request<void>(`/api/tags/graph-rules/${id}`, { method: "DELETE" }),

  // --- links ---
  listLinks: () => request<Link[]>("/api/links"),
  createLink: (body: { title: string; url: string; icon?: string | null }) =>
    request<Link>("/api/links", json("POST", body)),
  patchLink: (id: number, body: { title?: string; url?: string; icon?: string | null }) =>
    request<Link>(`/api/links/${id}`, json("PATCH", body)),
  deleteLink: (id: number) => request<void>(`/api/links/${id}`, { method: "DELETE" }),

  // --- settings ---
  getSettings: () => request<Settings>("/api/settings"),
  putSettings: (values: Partial<Record<keyof Settings, unknown>>) =>
    request<Settings>("/api/settings", json("PUT", { values })),
  resetTagsAndCovers: () => request<Settings>("/api/settings/reset", { method: "POST" }),
  deleteAllData: () => request<Settings>("/api/settings/delete-all", { method: "POST" }),

  // --- discovery ---
  discover: (q: string) => request<DiscoverResponse>(`/api/discover${query({ q })}`),
  discoveryTemplates: () =>
    request<{
      active: string;
      saved: { name: string; template: string }[];
      recommended: { name: string; template: string; note: string }[];
    }>("/api/discover/templates"),
  saveDiscovered: (body: { image_url: string; source_url?: string | null; title?: string | null }) =>
    request<UploadResult>("/api/discover/save", json("POST", body)),

  // --- backup ---
  exportUrl: "/api/export",
  importArchive: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportResult>("/api/import", { method: "POST", body: form });
  },

  // --- maintenance ---
  checkIntegrity: () => request<IntegrityReport>("/api/maintenance/integrity"),
  reconcile: () => request<ReconciliationReport>("/api/maintenance/reconcile", { method: "POST" }),
  nearDuplicates: () => request<NearDuplicatePair[]>("/api/maintenance/near-duplicates"),
};
