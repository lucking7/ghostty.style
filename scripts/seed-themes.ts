/**
 * Seeding script: fetches ALL Ghostty themes from the iTerm2-Color-Schemes
 * repository and inserts them into Supabase.
 *
 * The script dynamically fetches the full directory listing from the GitHub API,
 * so it will automatically pick up any new themes added to the repo.
 *
 * Existing themes (matched by title) are skipped for content insert, but their
 * upstream_added_at is refreshed to the latest commit that touched
 * ghostty/<name> so Newest sort tracks GitHub update order.
 *
 * Usage: npx tsx scripts/seed-themes.ts
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local
 */

import { createClient } from "@supabase/supabase-js";
import { parseGhosttyConfig, cleanRawConfig } from "../src/lib/config-parser";
import { generateSlug } from "../src/lib/slug-generator";
import { averageSaturation, contrastRatio } from "../src/lib/color-utils";
import https from "https";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// Validate env
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || supabaseUrl.includes("your-project")) {
  console.error(
    "ERROR: NEXT_PUBLIC_SUPABASE_URL is not set or still a placeholder.\n" +
      "Please create a Supabase project and update .env.local with real credentials.\n" +
      "See: https://supabase.com/dashboard"
  );
  process.exit(1);
}
if (!supabaseKey || supabaseKey === "your-service-role-key") {
  console.error(
    "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set or still a placeholder.\n" +
      "Find it in your Supabase project: Settings → API → service_role key."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function autoTag(
  title: string,
  config: ReturnType<typeof parseGhosttyConfig>["config"]
): string[] {
  const tags: string[] = [];
  tags.push(config.isDark ? "dark" : "light");

  const lower = title.toLowerCase();
  if (lower.includes("minimal") || lower.includes("mono")) tags.push("minimal");
  if (lower.includes("retro") || lower.includes("c64") || lower.includes("cga"))
    tags.push("retro");
  if (
    lower.includes("neon") ||
    lower.includes("synth") ||
    lower.includes("cyber") ||
    lower.includes("laser") ||
    lower.includes("matrix")
  )
    tags.push("neon");
  if (
    lower.includes("pastel") ||
    lower.includes("catppuccin") ||
    lower.includes("fairy") ||
    lower.includes("rose pine") ||
    lower.includes("sakura") ||
    lower.includes("lavandula")
  )
    tags.push("pastel");
  if (
    lower.includes("warm") ||
    lower.includes("gruvbox") ||
    lower.includes("monokai") ||
    lower.includes("coffee") ||
    lower.includes("earth")
  )
    tags.push("warm");
  if (
    lower.includes("cool") ||
    lower.includes("nord") ||
    lower.includes("iceberg") ||
    lower.includes("frost") ||
    lower.includes("glacier")
  )
    tags.push("cool");

  const sat = averageSaturation(config.palette);
  if (sat > 0.6) tags.push("colorful");
  if (sat < 0.15) tags.push("minimal");

  const contrast = contrastRatio(config.background, config.foreground);
  if (contrast > 10) tags.push("high-contrast");

  return [...new Set(tags)].slice(0, 5);
}

/**
 * Fetch content using Node's https module — more reliable than Node's
 * built-in fetch for URL-encoded paths with spaces.
 */
function httpsGet(url: string, maxRedirects = 5): Promise<string> {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error("Too many redirects"));
      return;
    }
    https
      .get(
        url,
        { headers: { "User-Agent": "ghostty-style-seeder/1.0" } },
        (res) => {
          // Follow redirects
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location
          ) {
            httpsGet(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => resolve(data));
          res.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

/**
 * Fetch all theme filenames from the GitHub API directory listing.
 * The /contents endpoint returns all files in a single response (no pagination).
 */
async function fetchAllThemeNames(): Promise<string[]> {
  console.log("Fetching theme directory from GitHub API...");

  const url = "https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/contents/ghostty";
  try {
    const raw = await httpsGet(url);
    const items = JSON.parse(raw) as { name: string; type: string }[];
    if (!Array.isArray(items)) {
      console.error("Unexpected API response (not an array)");
      return [];
    }
    const names = items.filter((i) => i.type === "file").map((i) => i.name);
    console.log(`Found ${names.length} theme files.\n`);
    return names;
  } catch (err) {
    console.error("Failed to fetch directory listing:", err);
    return [];
  }
}

async function fetchThemeContent(filename: string): Promise<string | null> {
  const encoded = encodeURIComponent(filename);
  const url = `https://raw.githubusercontent.com/mbadolato/iTerm2-Color-Schemes/master/ghostty/${encoded}`;
  try {
    return await httpsGet(url);
  } catch {
    return null;
  }
}

/**
 * One-time renames for slugs produced before `+` mapped to `plus`.
 * Idempotent: only updates when the old slug is still present.
 */
const SLUG_RENAMES: Array<{ title: string; from: string; to: string }> = [
  { title: "Dracula+", from: "dracula-1", to: "dracula-plus" },
  { title: "Dark+", from: "dark", to: "dark-plus" },
];

async function applySlugRenames(): Promise<void> {
  for (const { title, from, to } of SLUG_RENAMES) {
    const { data: row } = await supabase
      .from("configs")
      .select("id, slug")
      .eq("title", title)
      .eq("slug", from)
      .maybeSingle();
    if (!row) continue;

    const { data: taken } = await supabase
      .from("configs")
      .select("id")
      .eq("slug", to)
      .maybeSingle();
    if (taken) {
      console.log(`  SKIP rename ${title}: target slug ${to} already taken`);
      continue;
    }

    const { error } = await supabase
      .from("configs")
      .update({ slug: to })
      .eq("id", row.id);
    if (error) {
      console.log(`  FAIL rename ${title}: ${from} -> ${to} — ${error.message}`);
    } else {
      console.log(`  RENAMED ${title}: ${from} -> ${to}`);
    }
  }
}

/**
 * Generate a slug that does not collide with an existing row. Distinct upstream
 * themes can still collide after normalization; in that case we append a numeric
 * suffix, matching the upload API. (`+` now maps to `plus`, so Dracula+ -> dracula-plus.)
 */
async function uniqueSlug(base: string): Promise<string> {
  for (let suffix = 0; suffix <= 100; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix}`;
    const { data } = await supabase
      .from("configs")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "ghostty-style-seeder/1.0",
    Accept: "application/vnd.github+json",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Last commit date for every ghostty/<name> file, matching
 * https://github.com/mbadolato/iTerm2-Color-Schemes/tree/master/ghostty
 * update order (newest commit first). Walks commits that touch ghostty/ and
 * records the first time each file is seen (= most recent change).
 */
async function fetchGhosttyLastCommitDates(
  themeNames: string[]
): Promise<Map<string, string>> {
  const wanted = new Set(themeNames);
  const dates = new Map<string, string>();
  const headers = githubHeaders();
  const maxPages = 100;

  console.log(
    `Resolving last-updated dates for ${wanted.size} ghostty/ themes via commit history...`
  );

  for (let page = 1; page <= maxPages && dates.size < wanted.size; page++) {
    const listUrl = `https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/commits?path=ghostty&per_page=100&page=${page}`;
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) {
      console.warn(
        `  WARN: commits list page ${page} failed: HTTP ${listRes.status}`
      );
      break;
    }
    const commits = (await listRes.json()) as Array<{
      sha: string;
      commit?: { committer?: { date?: string }; author?: { date?: string } };
    }>;
    if (!Array.isArray(commits) || commits.length === 0) break;

    for (const c of commits) {
      const date =
        c.commit?.committer?.date ?? c.commit?.author?.date ?? null;
      if (!date || !c.sha) continue;

      const detailRes = await fetch(
        `https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/commits/${c.sha}`,
        { headers }
      );
      if (!detailRes.ok) continue;
      const detail = (await detailRes.json()) as {
        files?: Array<{ filename?: string }>;
      };
      for (const f of detail.files ?? []) {
        const filename = f.filename ?? "";
        if (!filename.startsWith("ghostty/")) continue;
        const name = filename.slice("ghostty/".length);
        if (!name || name.includes("/")) continue;
        if (wanted.has(name) && !dates.has(name)) {
          dates.set(name, date);
        }
      }
      if (dates.size >= wanted.size) break;
    }

    console.log(
      `  commit page ${page}: resolved ${dates.size}/${wanted.size} themes`
    );

    // Stop if this page was short (end of history)
    if (commits.length < 100) break;
  }

  // Large auto-generate commits truncate `files` (>300), so many ghostty/
  // paths are missed. Fill gaps with per-file last-commit lookups.
  const missing = themeNames.filter((n) => !dates.has(n));
  if (missing.length > 0) {
    console.log(
      `  Filling ${missing.length} gaps via per-file commits?path=ghostty/<name>...`
    );
    for (let i = 0; i < missing.length; i++) {
      const name = missing[i];
      const url = `https://api.github.com/repos/mbadolato/iTerm2-Color-Schemes/commits?path=${encodeURIComponent(
        `ghostty/${name}`
      )}&per_page=1`;
      try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
          if (res.status === 403 || res.status === 429) {
            console.warn(`  WARN: rate limited on ${name} (HTTP ${res.status})`);
            break;
          }
          continue;
        }
        const arr = (await res.json()) as Array<{
          commit?: { committer?: { date?: string }; author?: { date?: string } };
        }>;
        const date =
          arr[0]?.commit?.committer?.date ?? arr[0]?.commit?.author?.date;
        if (date) dates.set(name, date);
      } catch {
        // ignore single-file failures
      }
      if ((i + 1) % 50 === 0 || i + 1 === missing.length) {
        console.log(
          `  per-file ${i + 1}/${missing.length} (total resolved ${dates.size})`
        );
      }
    }
  }

  console.log(
    `Last-updated dates resolved for ${dates.size}/${wanted.size} themes.\n`
  );
  return dates;
}

const FEATURED_SLUGS = new Set([
  "catppuccin-mocha",
  "dracula",
  "nord",
  "tokyonight",
  "rose-pine",
  "gruvbox-dark",
  "one-half-dark",
  "kanagawa-wave",
  "everforest-dark-hard",
  "solarized-dark-higher-contrast",
]);

async function main() {
  // Test Supabase connection first
  console.log("Testing Supabase connection...");
  const { error: testError } = await supabase
    .from("configs")
    .select("id")
    .limit(1);
  if (testError) {
    console.error(
      `ERROR: Cannot connect to Supabase: ${testError.message}\n` +
        "Make sure you've:\n" +
        "1. Created a Supabase project\n" +
        "2. Run the migration SQL in supabase/migrations/001_initial_schema.sql\n" +
        "3. Updated .env.local with correct credentials"
    );
    process.exit(1);
  }
  console.log("Supabase connection OK!\n");

  console.log("Applying known slug renames (if needed)...");
  await applySlugRenames();
  console.log("");

  // Fetch all theme names from GitHub
  const themeNames = await fetchAllThemeNames();
  if (themeNames.length === 0) {
    console.error("ERROR: No themes found in the repository. GitHub API rate limit?");
    process.exit(1);
  }

  const lastUpdated = await fetchGhosttyLastCommitDates(themeNames);

  console.log(`Seeding ghostty.style with up to ${themeNames.length} themes...\n`);

  let seeded = 0;
  let skipped = 0;
  let failed = 0;
  let datesUpdated = 0;

  for (const themeName of themeNames) {
    // Match by title (unique upstream filename) so Dracula / Dracula+ stay distinct.
    const title = themeName.trim();
    const upstreamUpdatedAt = lastUpdated.get(themeName) ?? lastUpdated.get(title) ?? null;

    const { data: existing } = await supabase
      .from("configs")
      .select("id, upstream_added_at")
      .eq("title", title)
      .maybeSingle();

    if (existing) {
      if (
        upstreamUpdatedAt &&
        existing.upstream_added_at !== upstreamUpdatedAt
      ) {
        const { error: upErr } = await supabase
          .from("configs")
          .update({ upstream_added_at: upstreamUpdatedAt })
          .eq("id", existing.id);
        if (upErr) {
          console.log(`  FAIL date ${title}: ${upErr.message}`);
          failed++;
        } else {
          datesUpdated++;
          console.log(`  DATE: ${title} -> ${upstreamUpdatedAt}`);
        }
      } else {
        console.log(`  SKIP: ${title} (already exists)`);
      }
      skipped++;
      continue;
    }

    const content = await fetchThemeContent(themeName);
    if (!content) {
      console.log(`  SKIP: ${themeName} (not found in repo)`);
      skipped++;
      continue;
    }

    const cleanedContent = cleanRawConfig(content);
    const { config, errors } = parseGhosttyConfig(cleanedContent);
    if (errors.length > 3) {
      console.log(`  SKIP: ${themeName} (${errors.length} parse errors)`);
      skipped++;
      continue;
    }

    const tags = autoTag(title, config);
    const slug = await uniqueSlug(generateSlug(title));

    const { error } = await supabase.from("configs").insert({
      slug,
      title,
      upstream_added_at: upstreamUpdatedAt,
      description: null,
      raw_config: cleanedContent,
      background: config.background,
      foreground: config.foreground,
      cursor_color: config.cursorColor,
      cursor_text: config.cursorText,
      selection_bg: config.selectionBg,
      selection_fg: config.selectionFg,
      palette: config.palette,
      font_family: config.fontFamily,
      font_size: config.fontSize,
      cursor_style: config.cursorStyle || "block",
      bg_opacity: config.bgOpacity ?? 1.0,
      is_dark: config.isDark,
      tags,
      source_url: "https://github.com/mbadolato/iTerm2-Color-Schemes",
      author_name: "iTerm2-Color-Schemes",
      is_featured: FEATURED_SLUGS.has(slug),
      is_seed: true,
    });

    if (error) {
      console.log(`  FAIL: ${title} — ${error.message}`);
      failed++;
    } else {
      console.log(
        `  OK:   ${title} (${slug}) [${tags.join(", ")}]${
          upstreamUpdatedAt ? ` @ ${upstreamUpdatedAt}` : ""
        }`
      );
      seeded++;
    }

    await new Promise((r) => setTimeout(r, 50));
  }

  console.log(
    `\n${"=".repeat(50)}\nDone! Seeded: ${seeded}, Skipped: ${skipped}, ` +
      `Dates updated: ${datesUpdated}, Failed: ${failed}\n` +
      `Total themes in directory: ${themeNames.length}\n`
  );
}

main().catch(console.error);
