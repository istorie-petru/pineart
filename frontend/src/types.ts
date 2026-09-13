/** Response shapes, mirroring backend/app/schemas.py. */

export interface TagCategory {
  id: number;
  name: string;
  slug: string;
  color: string;
  position: number;
  links_enabled: boolean;
  /** Default icon for every tag filed under this category — a tag's own
   * icon (see `Tag.icon`) wins over this, same precedence as `color`. */
  icon?: string | null;
}

export interface Tag {
  id: number;
  name: string;
  slug: string;
  color: string | null;
  category?: TagCategory | null;
  /** A single outbound link (creator shop/profile/portfolio). Only offered
   * for editing when the tag's category has `links_enabled`. */
  link_url?: string | null;
  /** Opts this tag's items out of the Feed while leaving them visible in any
   * board they belong to and in a search that names the tag explicitly. */
  hide_from_feed?: boolean;
  /** This tag's own icon — see `ui.ts`'s `tagIconKey` for the fallback to
   * the category's icon. */
  icon?: string | null;
}

export interface TagGraphRule {
  id: number;
  name: string;
  from_category: TagCategory;
  to_category: TagCategory;
  via_category: TagCategory;
}

export interface TagSuggestion extends Tag {
  usage_count: number;
}

export interface ItemUrls {
  thumb: string;
  display: string;
  download: string;
}

export interface Item {
  id: number;
  hash: string;
  phash: string | null;
  title: string | null;
  description: string | null;
  width: number;
  height: number;
  filesize: number;
  mime_type: string;
  source_url: string | null;
  dominant_color: string | null;
  orientation: "portrait" | "landscape" | "square";
  parent_item_id: number | null;
  derivative_target: string | null;
  variant_label: string | null;
  version_of_id: number | null;
  canonical_version_id: number | null;
  displayed_item_id: number | null;
  is_deleted: boolean;
  deleted_at: string | null;
  added_at: string;
  updated_at: string;
  tags: Tag[];
  urls: ItemUrls;
}

export interface VersionList {
  artwork_id: number;
  canonical_id: number;
  versions: Item[];
}

export interface ItemPage {
  items: Item[];
  next_cursor: string | null;
  total: number;
}

export interface Board {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  cover_item_id: number | null;
  cover_url: string | null;
  is_dynamic: boolean;
  created_at: string;
  position: number;
  item_count: number;
  query_tags: Tag[];
  match_mode: "all" | "any";
  subboard_tags: Tag[];
}

export interface Link {
  id: number;
  title: string;
  url: string;
  description: string | null;
  category: string | null;
  icon: string | null;
  position: number;
}

export interface GraphNode {
  id: number;
  name: string;
  color: string | null;
  category?: TagCategory | null;
  link_url?: string | null;
  /** Opts this tag's items out of the Feed — see api.patchTag. */
  hide_from_feed?: boolean;
  icon?: string | null;
  usage_count: number;
}

export interface GraphEdge {
  source: number;
  target: number;
  weight: number;
}

export interface TagGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface UploadResult {
  item: Item;
  created: boolean;
  near_duplicate_ids: number[];
}

export interface BulkImportResult {
  created: Item[];
  duplicates: Item[];
  failed: { filename: string; error: string }[];
}

export interface OnThisDayGroup {
  year: number;
  items: Item[];
}

export interface DiscoverResult {
  title: string | null;
  image_url: string;
  thumbnail_url: string | null;
  source_url: string | null;
  engine: string | null;
  width: number | null;
  height: number | null;
}

export interface DiscoverResponse {
  query: string;
  expanded_query: string;
  results: DiscoverResult[];
}

export interface QueryTemplate {
  name: string;
  template: string;
}

export interface ImportResult {
  items_imported: number;
  tags_imported: number;
  boards_imported: number;
  skipped: number;
}

export interface IntegrityIssue {
  item_id: number;
  storage_path: string;
  problem: "missing" | "corrupt";
}

export interface IntegrityReport {
  checked: number;
  scanned: number;
  issues: IntegrityIssue[];
}

export interface ReconciliationReport {
  orphaned_files: string[];
  missing_files: string[];
}

export interface NearDuplicatePair {
  a: Item;
  b: Item;
  distance: number;
}

export interface TagMergeResult {
  merged_tag_id: number;
  into_tag_id: number;
  items_reassigned: number;
}

export interface CitationEntry {
  item_id: number;
  title: string | null;
  artist: string | null;
  creation_date: string | null;
  source: string | null;
}

export interface CitationExport {
  entries: CitationEntry[];
  text: string;
}

export type SortKey = "added_at" | "dimensions" | "filesize" | "title" | "random";
export type CropTarget = "avatar" | "banner" | "board_cover";

/** The settings object is a flat key/value map; these are the keys the UI uses. */
export interface Settings {
  "profile.display_name": string;
  "profile.description": string;
  "profile.avatar_item_id": number | null;
  "profile.banner_item_id": number | null;
  "profile.avatar_url": string | null;
  "profile.banner_url": string | null;
  "appearance.theme": "light" | "dark" | "system";
  "appearance.accent_color": string;
  "collection.page_size": number;
  "collection.default_sort": SortKey;
  "collection.infinite_scroll": boolean;
  "storage.convert_png_to_webp": boolean;
  "storage.preserve_original_bytes": boolean;
  "storage.trash_retention_days": number;
  "discovery.enabled": boolean;
  "discovery.searxng_url": string;
  "discovery.query_template": string;
  "discovery.templates": QueryTemplate[];
  "tagGraph.charge_strength": number;
  "tagGraph.link_distance": number;
  "tagGraph.link_strength": number;
  "tagGraph.center_strength": number;
}
