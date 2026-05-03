import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SOURCES_PATH = path.join(ROOT, "sources.json");
const STATE_PATH = path.join(ROOT, "state.json");
const MAX_ITEMS = Number(process.env.MAX_ITEMS || 5);
const MIN_ITEMS = Number(process.env.MIN_ITEMS || MAX_ITEMS);
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 7);
const FALLBACK_LOOKBACK_DAYS = Number(process.env.FALLBACK_LOOKBACK_DAYS || 30);
const MAX_SOURCE_SUMMARY_CHARS = Number(process.env.MAX_SOURCE_SUMMARY_CHARS || 600);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "C0B231KJ1B2";

const KEYWORDS = [
  "openai",
  "anthropic",
  "google",
  "deepmind",
  "microsoft",
  "meta",
  "nvidia",
  "mistral",
  "model",
  "agent",
  "safety",
  "regulation",
  "chip",
  "gpu",
  "robot",
  "reasoning",
  "benchmark",
  "enterprise",
  "cloud",
  "api",
  "security",
  "lawsuit",
  "funding",
  "acquisition"
];

const EXCLUDED_TITLE_TERMS = [
  "goblin"
];

async function main() {
  const [sources, state] = await Promise.all([readJson(SOURCES_PATH), readState()]);
  const postedUrls = new Set(state.postedUrls || []);
  const fetched = await Promise.allSettled(sources.map(fetchSource));
  for (const result of fetched) {
    if (result.status === "rejected") {
      console.warn(result.reason?.message || result.reason);
    }
  }
  const fetchedItems = fetched
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .map(normalizeItem)
    .filter((item) => item.url && item.title)
    .filter((item) => !isExcludedItem(item))
    .filter((item) => !postedUrls.has(item.url));

  const selected = selectItems(fetchedItems, { minItems: MIN_ITEMS, maxItems: MAX_ITEMS });

  if (selected.length === 0) {
    console.log("No new AI news candidates found.");
    return;
  }

  const message = await buildSlackMessage(selected);

  if (process.env.DRY_RUN === "1") {
    console.log(message);
    return;
  } else {
    await postToSlack(message);
  }

  const nextState = {
    postedUrls: [...new Set([...(state.postedUrls || []), ...selected.map((item) => item.url)])].slice(-500),
    lastRun: new Date().toISOString(),
    lastPosted: selected.map(({ title, url, date, source }) => ({ title, url, date, source }))
  };
  await fs.writeFile(STATE_PATH, `${JSON.stringify(nextState, null, 2)}\n`);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readState() {
  try {
    return await readJson(STATE_PATH);
  } catch {
    return { postedUrls: [], lastRun: null };
  }
}

async function fetchSource(source) {
  const response = await fetch(source.url, {
    headers: {
      "user-agent": "daily-ai-news-bot/1.0",
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml"
    }
  });
  if (!response.ok) {
    throw new Error(`${source.name}: HTTP ${response.status}`);
  }
  const xml = await response.text();
  return parseFeed(xml).map((item) => ({
    ...item,
    source: source.name,
    sourceWeight: source.weight || 5
  }));
}

function selectItems(items, { minItems, maxItems }) {
  const recent = rankedItems(items.filter((item) => withinLookback(item.date, LOOKBACK_DAYS)));
  if (recent.length >= minItems) {
    return recent.slice(0, maxItems);
  }

  const fallback = rankedItems(items.filter((item) => withinLookback(item.date, FALLBACK_LOOKBACK_DAYS)));
  return fallback.slice(0, maxItems);
}

function rankedItems(items) {
  return diversifyBySource(dedupeByUrlAndTitle(items)
    .map((item) => ({ ...item, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score)
  );
}

function isExcludedItem(item) {
  const title = item.title.toLowerCase();
  return EXCLUDED_TITLE_TERMS.some((term) => title.includes(term));
}

function parseFeed(xml) {
  const itemBlocks = matchAll(xml, /<item\b[\s\S]*?<\/item>/gi);
  if (itemBlocks.length > 0) {
    return itemBlocks.map((block) => ({
      title: textFromTag(block, "title"),
      url: textFromTag(block, "link") || attrFromTag(block, "guid", "isPermaLink"),
      summary: textFromTag(block, "description") || textFromTag(block, "content:encoded"),
      date: textFromTag(block, "pubDate") || textFromTag(block, "dc:date")
    }));
  }

  return matchAll(xml, /<entry\b[\s\S]*?<\/entry>/gi).map((block) => ({
    title: textFromTag(block, "title"),
    url: atomLink(block) || textFromTag(block, "id"),
    summary: textFromTag(block, "summary") || textFromTag(block, "content"),
    date: textFromTag(block, "published") || textFromTag(block, "updated")
  }));
}

function normalizeItem(item) {
  const url = cleanText(item.url || "");
  const title = cleanText(item.title || "");
  const summary = truncate(cleanText(item.summary || ""), MAX_SOURCE_SUMMARY_CHARS);
  const parsedDate = item.date ? new Date(decodeHtml(stripTags(item.date)).trim()) : null;
  return {
    ...item,
    title,
    url,
    summary,
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString().slice(0, 10) : null
  };
}

function withinLookback(date, days) {
  if (!date) return true;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(date).getTime() >= cutoff;
}

function dedupeByUrlAndTitle(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${canonicalUrl(item.url)}::${item.title.toLowerCase().replace(/\W+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function diversifyBySource(items) {
  const counts = new Map();
  const picked = [];
  const deferred = [];
  for (const item of items) {
    const count = counts.get(item.source) || 0;
    if (count < 2) {
      picked.push(item);
      counts.set(item.source, count + 1);
    } else {
      deferred.push(item);
    }
  }
  return [...picked, ...deferred];
}

function scoreItem(item) {
  const haystack = `${item.title} ${item.summary}`.toLowerCase();
  const keywordScore = KEYWORDS.reduce((score, keyword) => score + (haystack.includes(keyword) ? 2 : 0), 0);
  const recencyScore = item.date ? Math.max(0, 14 - ageInDays(item.date)) : 3;
  return item.sourceWeight + keywordScore + recencyScore;
}

function ageInDays(date) {
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

async function buildSlackMessage(items) {
  if (!process.env.OPENAI_API_KEY) {
    return formatSlackMessage(items.map(fallbackSummaryItem));
  }

  const prompt = [
    "あなたはAIニュース編集者です。",
    `以下の${items.length}件を、順番を保ったまま日本語で要約してください。`,
    "返答はJSONのみ。Markdown、説明文、コードフェンスは禁止です。",
    "JSON shape: {\"items\":[{\"headline\":\"...\",\"summary\":\"...\",\"why_it_matters\":\"...\",\"published_date\":\"YYYY-MM-DD または 不明\",\"url\":\"...\"}]}",
    "summaryは1-2文、why_it_mattersは1文で簡潔にしてください。",
    "urlとpublished_dateは入力値を維持してください。",
    "",
    JSON.stringify(items, null, 2)
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API failed: HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  const text = extractResponseText(data).trim();
  if (!text) {
    throw new Error("OpenAI API returned an empty response.");
  }
  return formatSlackMessage(parseSummaryItems(text, items));
}

function parseSummaryItems(text, sourceItems) {
  try {
    const parsed = JSON.parse(text);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return sourceItems.map((source, index) => normalizeSummaryItem(items[index], source));
  } catch {
    console.warn("OpenAI response was not valid JSON; using fallback formatter.");
    return sourceItems.map(fallbackSummaryItem);
  }
}

function normalizeSummaryItem(item, source) {
  return {
    headline: cleanOneLine(item?.headline) || source.title,
    summary: cleanOneLine(item?.summary) || source.summary || "公式フィードで新規記事として検出されました。",
    why_it_matters: cleanOneLine(item?.why_it_matters) || `${source.source}由来のAI関連トピックで、製品・研究・市場動向の確認対象です。`,
    published_date: cleanOneLine(item?.published_date) || source.date || "不明",
    url: source.url
  };
}

function fallbackSummaryItem(item) {
  return normalizeSummaryItem(null, item);
}

function formatSlackMessage(items) {
  const lines = [`**AIニュース要約（${todayJst()}）**`, ""];
  items.slice(0, MAX_ITEMS).forEach((item, index) => {
    lines.push(`**${index + 1}. ${item.headline}**`);
    lines.push(`- **要約:** ${item.summary}`);
    lines.push(`- **なぜ重要か:** ${item.why_it_matters}`);
    lines.push(`- **公開日:** ${item.published_date}`);
    lines.push(`- **URL:** ${item.url}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

async function postToSlack(message) {
  if (process.env.SLACK_BOT_TOKEN) {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL_ID,
        text: message,
        mrkdwn: true
      })
    });
    const data = await response.json();
    if (!data.ok) {
      throw new Error(`Slack API failed: ${data.error || "unknown_error"}`);
    }
    return;
  }

  if (process.env.SLACK_WEBHOOK_URL) {
    const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message })
    });
    if (!response.ok) {
      throw new Error(`Slack webhook failed: HTTP ${response.status}`);
    }
    return;
  }

  throw new Error("Set SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL.");
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join("\n");
}

function textFromTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, "i"));
  return match ? unwrapCdata(match[1]) : "";
}

function atomLink(block) {
  const alternate = block.match(/<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (alternate) return alternate[1];
  const any = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return any ? any[1] : "";
}

function attrFromTag(block, tag, attr) {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedAttr = attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*${escapedAttr}=["'][^"']*["'][^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  return match ? unwrapCdata(match[1]) : "";
}

function unwrapCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function stripTags(value) {
  return String(value).replace(/<[^>]+>/g, " ");
}

function cleanText(value) {
  return stripTags(decodeHtml(value)).replace(/\s+/g, " ").trim();
}

function cleanOneLine(value) {
  return cleanText(value || "").replace(/\n+/g, " ").trim();
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "fbclid" || key === "gclid") {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function matchAll(value, pattern) {
  return [...value.matchAll(pattern)].map((match) => match[0]);
}

function todayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
