// In-app PDF export for a finished plan set.
//
// The PDF is rendered entirely on the client from the getPlanPdfData
// payload (the same scope the plan tab shows: A/B/C plans, costs,
// schedules, descriptions, notes, official sources and wait-time
// estimation material — never the chat log or the conditions form).
// No public link is created: the user saves the file through the
// share sheet and hands it over themselves (LINE, mail, …).
//
// Delivery note: the rendered file never leaves the device except
// through the save control App.tsx serves for the current shell —
// the share sheet where it can take files (the phone shells,
// proven on-device), or a plain download anchor on an object URL
// minted from the local file where it cannot (Chrome / desktop
// Muse, per the owner's 2026-11-18 ruling after the share
// button did nothing there). No control points at a server URL:
// the stored copy's relative ./blobs/… URL, handed out of the app
// as a download, kept landing the owner on a black page or an
// authentication page instead of the PDF. App.tsx shows the page
// canvases in-app in a full-screen overlay, out of the plan
// layout's flow, so previewing can no longer disturb the map.
//
// Rendering approach: each A4 page is painted with Canvas 2D (system
// fonts, so Japanese text needs no embedded font), the static map is
// composited from OpenStreetMap tiles with numbered pins drawn on
// top, and the page canvases are packed as JPEG images into a
// minimal hand-written PDF. If a tile or a photo cannot be loaded,
// the PDF is still produced without it.

import { api, type ApiResponse } from "./api";
import {
  TIGHT_LEG_CAUTION_TEXT,
  crowdFactorLabel,
  crowdScenarioPremiseText,
  formatWalkDistance,
  tightLegTargets,
} from "./plan_metrics";

export type PlanPdfData = ApiResponse<typeof api, "getPlanPdfData">;
type PdfPlan = PlanPdfData["plans"][number];
type PdfItem = PdfPlan["items"][number];

// A4 at 150dpi.
const PAGE_W = 1240;
const PAGE_H = 1754;
const MARGIN = 88;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_TOP = MARGIN;
const CONTENT_BOTTOM = PAGE_H - 156;
const RIGHT = PAGE_W - MARGIN;

const TEXT = "#22304f";
const DIM = "#68738c";
const NOTE_TEXT = "#3c4a68";
const BORDER = "#ddd5c3";
const ALT_BG = "#f1ede2";
const ACCENT = "#e4572e";
// Amber for the row-level unconfirmed mark (§9.4), matching the
// app's dashed-amber treatment as closely as print allows.
const UNCERTAIN = "#b45309";
// Red for the 予約必須 restaurant warning box: a show restaurant
// placed as an ordinary meal row must be unmissable in print too.
const WARN_BG = "#fbe3dd";
const WARN_BORDER = "#d43a1f";
const WARN_TEXT = "#8f2312";
const LINK = "#2a5db0";
const MAP_BG = "#eceee8";

const PLAN_COLORS: Record<"A" | "B" | "C", string> = {
  A: "#e4572e",
  B: "#2a7f7f",
  C: "#b9822e",
};

const KIND_LABELS: Record<PdfItem["kind"], string> = {
  attraction: "アトラクション",
  show: "ショー",
  parade: "パレード",
  restaurant: "食事",
  break: "休憩",
  move: "移動",
  other: "その他",
  purchase: "購入",
  first10: "最初の10分",
};

const KIND_COLORS: Record<PdfItem["kind"], string> = {
  attraction: "#2f6fd0",
  show: "#d6336c",
  parade: "#e8890c",
  restaurant: "#2b8a3e",
  break: "#0e9594",
  move: "#64748b",
  other: "#756a58",
  purchase: "#b45309",
  first10: "#0b7285",
};

const FONT_SANS =
  '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans CJK JP", sans-serif';
const FONT_ROUND =
  '"Hiragino Maru Gothic ProN", "Hiragino Sans", "Noto Sans CJK JP", sans-serif';

function setFont(
  ctx: CanvasRenderingContext2D,
  weight: number,
  size: number,
  round = false,
): void {
  ctx.font = `${weight} ${size}px ${round ? FONT_ROUND : FONT_SANS}`;
}

// Greedy line wrapping. CJK characters may break anywhere; latin runs
// stay together as words. With breakLong, even long tokens (URLs)
// break at any character.
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  breakLong = false,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const units = breakLong
      ? Array.from(paragraph)
      : (paragraph.match(
          /[A-Za-z0-9]+(?:[.,:/%&+'-][A-Za-z0-9]+)*|\s+|./g,
        ) ?? [paragraph]);
    let line = "";
    for (const unit of units) {
      if (line === "" && /^\s+$/.test(unit)) continue;
      const candidate = line + unit;
      if (line !== "" && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line.replace(/\s+$/, ""));
        line = /^\s+$/.test(unit) ? "" : unit;
      } else {
        line = candidate;
      }
    }
    if (line !== "") lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

// Split the generation notes into bullet points (same rule as the
// plan tab: one point per line; long legacy lines split on 。).
function splitNotes(notes: string): string[] {
  const lines = notes
    .split(/\n+/)
    .map((s) => s.trim().replace(/^[・\-•*]\s*/, ""))
    .filter(Boolean);
  const points: string[] = [];
  for (const line of lines) {
    if (line.length <= 60) {
      points.push(line);
      continue;
    }
    const sentences = line
      .split("。")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `${s}。`);
    points.push(...(sentences.length > 0 ? sentences : [line]));
  }
  return points;
}

function formatVisitDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] ?? "";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${weekday}）`;
}

// The creation timestamp (Asia/Tokyo, down to the minute) is part
// of the file name: wherever the file ends up — the Files app, a
// LINE thread, a notes app — the owner can tell at a glance that
// the file in hand is the one they just made. A file whose name
// carries NO timestamp came from an older build, which is also how
// a phone still showing a cached old page gives itself away. The
// completion block in App.tsx displays the same timestamp (and
// the file name) so the two can be cross-checked on screen.
function jstDigits(d: Date): { ymd: string; hm: string; label: string } {
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value] as const),
  );
  const y = parts.get("year") ?? "";
  const mo = parts.get("month") ?? "";
  const da = parts.get("day") ?? "";
  const h = parts.get("hour") ?? "";
  const mi = parts.get("minute") ?? "";
  return {
    ymd: `${y}${mo}${da}`,
    hm: `${h}${mi}`,
    label: `${y}年${Number(mo)}月${Number(da)}日 ${Number(h)}:${mi}`,
  };
}

export function planPdfFileName(data: PlanPdfData, createdAt: Date): string {
  const parkShort = data.park === "land" ? "ランド" : "シー";
  const t = jstDigits(createdAt);
  const stamp = `作成${t.ymd}-${t.hm}`;
  return data.visitDate
    ? `ディズニー計画_${data.visitDate}_${parkShort}_${stamp}.pdf`
    : `ディズニー計画_${parkShort}_${stamp}.pdf`;
}

// Human-readable form of the same creation timestamp the file
// name carries, for the completion block.
export function planPdfCreatedLabel(createdAt: Date): string {
  return jstDigits(createdAt).label;
}

// ------------------------------------------------------------ images

async function loadBitmap(url: string): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    try {
      return await createImageBitmap(blob);
    } catch {
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("image load failed"));
          img.src = objectUrl;
        });
        return await createImageBitmap(img);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ static map

const TILE_SIZE = 256;
const MAP_W = CONTENT_W;
const MAP_H = 600;
const MAP_PAD = 90;

function projectX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function projectY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (
    (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) *
    TILE_SIZE *
    2 ** zoom
  );
}

type PinnedPoint = { lat: number; lng: number; pin: number };

// One plan's static-map framing: the fitted zoom, the world-pixel
// origin of the canvas's top-left corner, and every tile the canvas
// covers (x already wrapped into range, key = "z/x/y").
type MapLayout = {
  zoom: number;
  left: number;
  top: number;
  tiles: { tx: number; ty: number; z: number; x: number; y: number }[];
};

function mapLayout(points: PinnedPoint[]): MapLayout {
  let zoom = 16;
  if (points.length > 1) {
    zoom = 12;
    for (let z = 18; z >= 12; z--) {
      const xs = points.map((p) => projectX(p.lng, z));
      const ys = points.map((p) => projectY(p.lat, z));
      const spreadX = Math.max(...xs) - Math.min(...xs);
      const spreadY = Math.max(...ys) - Math.min(...ys);
      if (spreadX <= MAP_W - MAP_PAD * 2 && spreadY <= MAP_H - MAP_PAD * 2) {
        zoom = z;
        break;
      }
    }
  }
  const xs = points.map((p) => projectX(p.lng, zoom));
  const ys = points.map((p) => projectY(p.lat, zoom));
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const centerY = (Math.max(...ys) + Math.min(...ys)) / 2;
  const left = centerX - MAP_W / 2;
  const top = centerY - MAP_H / 2;

  const maxTile = 2 ** zoom - 1;
  const txFrom = Math.floor(left / TILE_SIZE);
  const txTo = Math.floor((left + MAP_W - 1) / TILE_SIZE);
  const tyFrom = Math.max(0, Math.floor(top / TILE_SIZE));
  const tyTo = Math.min(maxTile, Math.floor((top + MAP_H - 1) / TILE_SIZE));
  const tiles: MapLayout["tiles"] = [];
  for (let tx = txFrom; tx <= txTo; tx++) {
    for (let ty = tyFrom; ty <= tyTo; ty++) {
      const wrappedTx = ((tx % (maxTile + 1)) + maxTile + 1) % (maxTile + 1);
      tiles.push({ tx, ty, z: zoom, x: wrappedTx, y: ty });
    }
  }
  return { zoom, left, top, tiles };
}

// Builds one plan's static map: OSM raster tiles stitched on a
// canvas, with the same numbered pins (route order among the plan's
// coordinate-carrying rows) the interactive map shows. Tile bitmaps
// come from tileBitmapFor (server-fetched blob URLs first, direct
// tile-host fetch as fallback) and are cached across plans — the
// three plans cover the same park, so most tiles are shared.
// Returns null when no tile could be loaded at all (the caller then
// notes the omission instead of a blank box).
async function buildMapCanvas(
  points: PinnedPoint[],
  pinColor: string,
  layout: MapLayout,
  tileBitmapFor: (key: string) => Promise<ImageBitmap | null>,
): Promise<HTMLCanvasElement | null> {
  const { zoom, left, top } = layout;
  const canvas = document.createElement("canvas");
  canvas.width = MAP_W;
  canvas.height = MAP_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = MAP_BG;
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  let drawnTiles = 0;
  await Promise.all(
    layout.tiles.map(async (t) => {
      const bmp = await tileBitmapFor(`${t.z}/${t.x}/${t.y}`);
      if (!bmp) return;
      ctx.drawImage(bmp, t.tx * TILE_SIZE - left, t.ty * TILE_SIZE - top);
      drawnTiles++;
    }),
  );
  if (drawnTiles === 0) return null;

  // Numbered pins, in route order, drawn over the tiles.
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p) continue;
    const px = projectX(p.lng, zoom) - left;
    const py = projectY(p.lat, zoom) - top;
    ctx.beginPath();
    ctx.arc(px, py, 27, 0, Math.PI * 2);
    ctx.fillStyle = pinColor;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    setFont(ctx, 700, 29);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(p.pin), px, py + 2);
  }
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  return canvas;
}

// ------------------------------------------------------------ page painter

class Painter {
  pages: HTMLCanvasElement[] = [];
  private ctx: CanvasRenderingContext2D;
  y = CONTENT_TOP;

  constructor() {
    this.ctx = this.freshContext();
  }

  // NOTE: a page break replaces the current context, so callers must
  // always draw through p.g (re-read after any ensure/flowText call)
  // and never hold a context across a possible page break.
  private freshContext(): CanvasRenderingContext2D {
    const c = document.createElement("canvas");
    c.width = PAGE_W;
    c.height = PAGE_H;
    const g = c.getContext("2d");
    if (!g) throw new Error("canvas is not available");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, PAGE_W, PAGE_H);
    g.textBaseline = "top";
    g.textAlign = "left";
    this.pages.push(c);
    return g;
  }

  get g(): CanvasRenderingContext2D {
    return this.ctx;
  }

  newPage(): void {
    this.ctx = this.freshContext();
    this.y = CONTENT_TOP;
  }

  ensure(height: number): void {
    if (this.y + height > CONTENT_BOTTOM) this.newPage();
  }

  // Draws wrapped text line by line (paginating between lines) and
  // advances y past it. Returns the drawn height on the last page.
  flowText(
    text: string,
    opts: {
      size: number;
      weight?: number;
      color?: string;
      lineHeight: number;
      x?: number;
      width?: number;
      round?: boolean;
      breakLong?: boolean;
    },
  ): void {
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? CONTENT_W;
    setFont(this.g, opts.weight ?? 400, opts.size, opts.round);
    const lines = wrapText(this.g, text, width, opts.breakLong);
    for (const line of lines) {
      this.ensure(opts.lineHeight);
      // A page break swaps the context: re-apply font and colour on
      // the (possibly new) current context for every line.
      setFont(this.g, opts.weight ?? 400, opts.size, opts.round);
      this.g.fillStyle = opts.color ?? TEXT;
      this.g.fillText(line, x, this.y);
      this.y += opts.lineHeight;
    }
  }

  gap(height: number): void {
    // Only advances the cursor; the next block's ensure() performs
    // any needed page break (so a trailing gap never leaves a blank
    // final page).
    this.y += height;
  }

  divider(): void {
    this.ensure(2);
    this.g.strokeStyle = BORDER;
    this.g.lineWidth = 2;
    this.g.beginPath();
    this.g.moveTo(MARGIN, this.y);
    this.g.lineTo(RIGHT, this.y);
    this.g.stroke();
  }

  // A section heading with a small plan-coloured bar.
  sectionHeading(text: string, color: string): void {
    this.ensure(52 + 8);
    this.g.fillStyle = color;
    this.g.fillRect(MARGIN, this.y + 4, 10, 40);
    setFont(this.g, 700, 33);
    this.g.fillStyle = TEXT;
    this.g.fillText(text, MARGIN + 26, this.y + 2);
    this.y += 52;
  }

  // Footer on every finished page: the app credit line (linked to
  // the note article when a URL exists) and the page number.
  drawFooters(footerText: string, footerUrl: string | null): void {
    const total = this.pages.length;
    this.pages.forEach((page, i) => {
      const g = page.getContext("2d");
      if (!g) return;
      g.strokeStyle = BORDER;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(MARGIN, PAGE_H - 128);
      g.lineTo(RIGHT, PAGE_H - 128);
      g.stroke();
      setFont(g, 400, 24);
      g.fillStyle = DIM;
      g.textAlign = "center";
      g.textBaseline = "top";
      g.fillText(footerText, PAGE_W / 2, PAGE_H - 110);
      if (footerUrl) {
        setFont(g, 400, 21);
        g.fillStyle = LINK;
        g.fillText(footerUrl, PAGE_W / 2, PAGE_H - 72);
      }
      setFont(g, 400, 22);
      g.fillStyle = DIM;
      g.textAlign = "right";
      g.fillText(`${i + 1} / ${total}`, RIGHT, PAGE_H - 110);
      g.textAlign = "left";
    });
  }
}

// Draws a cover-fit thumbnail into a rounded rect.
function drawThumb(
  g: CanvasRenderingContext2D,
  bmp: ImageBitmap,
  x: number,
  y: number,
  size: number,
): void {
  const scale = Math.max(size / bmp.width, size / bmp.height);
  const sw = size / scale;
  const sh = size / scale;
  const sx = (bmp.width - sw) / 2;
  const sy = (bmp.height - sh) / 2;
  g.save();
  g.beginPath();
  g.roundRect(x, y, size, size, 14);
  g.clip();
  g.drawImage(bmp, sx, sy, sw, sh, x, y, size, size);
  g.restore();
  g.strokeStyle = BORDER;
  g.lineWidth = 2;
  g.beginPath();
  g.roundRect(x, y, size, size, 14);
  g.stroke();
}

// ------------------------------------------------------------ plan blocks

const TIME_W = 128;
const THUMB = 96;
const THUMB_GAP = 18;
const WAIT_W = 178;

// One schedule row: time (+ pin badge under it) first like a transit
// guide, then the photo thumbnail, name / kind / pass / note, and the
// estimated wait large at the right end — the same reading order as
// the app's schedule list.
function drawScheduleRow(
  p: Painter,
  item: PdfItem,
  pin: number | null,
  photo: ImageBitmap | null,
  pinColor: string,
): void {
  const measureCtx = p.g;
  // Restaurant waits are not modeled (prepared in advance): a
  // restaurant row never shows an estimated wait, even if a stored
  // value somehow reaches this payload.
  const hasWait = item.kind !== "restaurant" && item.estWaitMin != null;
  const textX = MARGIN + TIME_W + (photo ? THUMB + THUMB_GAP : 0);
  const textW = RIGHT - textX - (hasWait ? WAIT_W + 10 : 0);

  setFont(measureCtx, 700, 32);
  const nameLines = wrapText(measureCtx, item.name, textW);
  setFont(measureCtx, 400, 28);
  const noteLines = item.note ? wrapText(measureCtx, item.note, textW) : [];
  // Row-level unconfirmed mark (§9.4): the short reason is printed
  // with the row; the explanation is traced through the
  // verification record's 未確認 list printed later in the PDF
  // (derived from this same row, so the two never disagree).
  setFont(measureCtx, 700, 25);
  const uncLines = item.unconfirmedReason
    ? wrapText(measureCtx, `未確定（${item.unconfirmedReason}）`, textW)
    : [];
  const isDpa =
    item.passType != null && /プレミアアクセス|DPA/i.test(item.passType);
  // Restaurant classification (derived server-side from the
  // restaurant fact layer): 予約必須 gets a warning box; other
  // restaurants get one status line; 未確認 is printed explicitly.
  const restInfo = item.restaurantInfo;
  const restRequired = restInfo?.reservationType === "required";
  setFont(measureCtx, 700, 30);
  const restWarnHeadLines = restRequired
    ? wrapText(measureCtx, "予約必須のレストランです", textW - 36)
    : [];
  setFont(measureCtx, 400, 26);
  const restWarnBodyLines = restRequired
    ? wrapText(
        measureCtx,
        "このお店は事前予約が必要です。この行は、予約が取れている前提で入っています。予約方法は公式ページで確認してください。",
        textW - 36,
      )
    : [];
  const restWarnH = restRequired
    ? 16 + restWarnHeadLines.length * 42 + 4 + restWarnBodyLines.length * 38 + 14
    : 0;
  setFont(measureCtx, 700, 25);
  const restStatusLines =
    restInfo && !restRequired
      ? wrapText(
          measureCtx,
          `${
            restInfo.reservationType === "ps"
              ? "PS対象（プライオリティ・シーティング）"
              : restInfo.reservationType === "none"
                ? "予約なし"
                : "予約情報：未確認"
          }／${
            restInfo.mobileOrder === "available"
              ? "モバイルオーダー対象"
              : restInfo.mobileOrder === "unavailable"
                ? "モバイルオーダー対象外"
                : "モバイルオーダー：未確認"
          }`,
          textW,
        )
      : [];

  let textH = nameLines.length * 44;
  textH += 46; // kind / area line
  if (uncLines.length > 0) textH += 8 + uncLines.length * 38;
  if (restWarnH > 0) textH += 8 + restWarnH;
  if (restStatusLines.length > 0) textH += 6 + restStatusLines.length * 38;
  if (item.passType) textH += 50;
  if (noteLines.length > 0) textH += 6 + noteLines.length * 40;
  const photoH = photo ? THUMB + (item.imageSource === "reference" ? 24 : 0) : 0;
  const waitH = hasWait ? 100 : 0;
  const rowH = Math.max(textH, photoH, waitH) + 26;

  p.ensure(rowH + 2);
  // Captured only after the (single) page-break point of this row:
  // the whole row is drawn on one page from here on.
  const g = p.g;
  const y0 = p.y;

  // Time first, pin badge below it (route number, matching the map).
  setFont(g, 700, 33);
  g.fillStyle = TEXT;
  g.fillText(item.timeLabel ?? "", MARGIN, y0 + 2);
  if (pin != null) {
    g.beginPath();
    g.arc(MARGIN + 24, y0 + 92, 23, 0, Math.PI * 2);
    g.fillStyle = pinColor;
    g.fill();
    setFont(g, 700, 26);
    g.fillStyle = "#ffffff";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(String(pin), MARGIN + 24, y0 + 93);
    g.textAlign = "left";
    g.textBaseline = "top";
  }

  if (photo) {
    drawThumb(g, photo, MARGIN + TIME_W, y0 + 2, THUMB);
    if (item.imageSource === "reference") {
      setFont(g, 400, 20);
      g.fillStyle = DIM;
      g.fillText("参考画像", MARGIN + TIME_W + 8, y0 + THUMB + 6);
    }
  }

  let ty = y0;
  setFont(g, 700, 32);
  g.fillStyle = TEXT;
  for (const line of nameLines) {
    g.fillText(line, textX, ty);
    ty += 44;
  }
  // Kind chip + area.
  const kindLabel = KIND_LABELS[item.kind];
  setFont(g, 700, 24);
  const chipW = g.measureText(kindLabel).width + 30;
  g.beginPath();
  g.roundRect(textX, ty + 4, chipW, 38, 19);
  g.fillStyle = KIND_COLORS[item.kind];
  g.fill();
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.fillText(kindLabel, textX + chipW / 2, ty + 10);
  g.textAlign = "left";
  if (item.area) {
    setFont(g, 400, 26);
    g.fillStyle = DIM;
    g.fillText(item.area, textX + chipW + 16, ty + 9);
  }
  ty += 46;
  // Unconfirmed mark: amber bold text under the kind line, so an
  // unconfirmed row is distinguishable at a glance in print too.
  if (uncLines.length > 0) {
    ty += 8;
    setFont(g, 700, 25);
    g.fillStyle = UNCERTAIN;
    for (const line of uncLines) {
      g.fillText(line, textX, ty);
      ty += 38;
    }
  }
  // Restaurant classification: 予約必須 is a bordered warning box
  // (heading + premise sentence); other restaurants print their
  // reservation / mobile-order status as one bold line.
  if (restRequired) {
    ty += 8;
    g.beginPath();
    g.roundRect(textX, ty, textW, restWarnH, 12);
    g.fillStyle = WARN_BG;
    g.fill();
    g.strokeStyle = WARN_BORDER;
    g.lineWidth = 3;
    g.stroke();
    let wy = ty + 16;
    setFont(g, 700, 30);
    g.fillStyle = WARN_TEXT;
    for (const line of restWarnHeadLines) {
      g.fillText(line, textX + 18, wy);
      wy += 42;
    }
    wy += 4;
    setFont(g, 400, 26);
    for (const line of restWarnBodyLines) {
      g.fillText(line, textX + 18, wy);
      wy += 38;
    }
    ty += restWarnH;
  } else if (restStatusLines.length > 0) {
    ty += 6;
    setFont(g, 700, 25);
    g.fillStyle = TEXT;
    for (const line of restStatusLines) {
      g.fillText(line, textX, ty);
      ty += 38;
    }
  }
  // Pass: DPA gets the solid accent treatment, others a quiet pill.
  // A DPA row also states its purchase time in the plan （購入 9:05).
  if (item.passType) {
    setFont(g, 700, 25);
    if (isDpa) {
      const passLabel = item.dpaPurchaseTime
        ? `${item.passType}（購入 ${item.dpaPurchaseTime}）`
        : item.passType;
      const labelW = g.measureText(passLabel).width;
      const dpaW = g.measureText("DPA").width + 22;
      const pillW = dpaW + labelW + 34;
      g.beginPath();
      g.roundRect(textX, ty + 3, pillW, 42, 21);
      g.fillStyle = ACCENT;
      g.fill();
      g.beginPath();
      g.roundRect(textX + 7, ty + 9, dpaW, 30, 15);
      g.fillStyle = "#ffffff";
      g.fill();
      g.fillStyle = ACCENT;
      g.textAlign = "center";
      g.fillText("DPA", textX + 7 + dpaW / 2, ty + 12);
      g.fillStyle = "#ffffff";
      g.textAlign = "left";
      g.fillText(passLabel, textX + 7 + dpaW + 12, ty + 11);
    } else {
      const pillW = g.measureText(item.passType).width + 32;
      g.beginPath();
      g.roundRect(textX, ty + 3, pillW, 42, 21);
      g.fillStyle = ALT_BG;
      g.fill();
      g.fillStyle = TEXT;
      g.fillText(item.passType, textX + 16, ty + 11);
    }
    ty += 50;
  }
  if (noteLines.length > 0) {
    ty += 6;
    setFont(g, 400, 28);
    g.fillStyle = NOTE_TEXT;
    for (const line of noteLines) {
      g.fillText(line, textX, ty);
      ty += 40;
    }
  }

  // Estimated wait: the most important number on the row, large at
  // the right end (0 minutes is shown too).
  if (hasWait) {
    setFont(g, 600, 23);
    g.fillStyle = DIM;
    const label = "推定待ち";
    g.fillText(label, RIGHT - g.measureText(label).width, y0 + 2);
    setFont(g, 700, 58);
    const num = String(item.estWaitMin);
    const numW = g.measureText(num).width;
    setFont(g, 700, 30);
    const unitW = g.measureText("分").width;
    g.fillStyle =
      item.estWaitMin != null && item.estWaitMin >= 60 ? ACCENT : TEXT;
    setFont(g, 700, 58);
    g.fillText(num, RIGHT - numW - unitW - 4, y0 + 32);
    setFont(g, 700, 30);
    g.fillText("分", RIGHT - unitW, y0 + 58);
  }

  p.y = y0 + rowH;
  p.divider();
  p.y += 14;
}

// Name key for matching a schedule row to the verification record's
// normalized DPA fact list (same normalization the server uses
// for its facility dictionary): NFKC, whitespace removed, lower-cased.
function dpaNameKey(name: string): string {
  return name.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();
}

// Application period of one extracted DPA entry, as read from the
// official sources at creation time; empty when no period
// could be read (the facility was judged as part of the lineup in
// force at fetch time).
function dpaPeriodSuffix(d: {
  effectiveFrom: string | null;
  effectiveTo: string | null;
}): string {
  const ja = (iso: string): string => {
    const [y = "", m = "", dd = ""] = iso.split("-");
    return `${Number(y)}年${Number(m)}月${Number(dd)}日`;
  };
  if (d.effectiveFrom && d.effectiveTo) {
    return `（${ja(d.effectiveFrom)}〜${ja(d.effectiveTo)}）`;
  }
  if (d.effectiveFrom) return `（${ja(d.effectiveFrom)}から）`;
  if (d.effectiveTo) return `（${ja(d.effectiveTo)}まで）`;
  return "";
}

// DPA purchase event: buying a Premier Access pass is a decision
// point of the day (one pass per purchase, the next at least 60
// minutes later, and a failed purchase forces a reschedule), so
// EVERY purchase stands in the printed timeline as its own event —
// time, facility, and the official unit price from the plan set's
// verification record (no price is printed when the record has
// none). Drawn at the purchase-time position in the timeline (the
// caller merges events in chronologically). The app additionally puts a
// 「買えなかったら？」 reschedule button on this event; a printed
// page cannot, so the branch-point note stands in its place.
function drawPurchaseEvent(
  p: Painter,
  item: PdfItem,
  priceJpy: number | null,
): void {
  const label =
    `🛒 DPA購入：${item.name}` +
    (priceJpy != null ? ` ${priceJpy.toLocaleString("ja-JP")}円` : "");
  setFont(p.g, 700, 29);
  const lines = wrapText(p.g, label, CONTENT_W - TIME_W - 36);
  const rowH = Math.max(98, lines.length * 40 + 54);
  p.ensure(rowH + 14);
  const g = p.g;
  const y0 = p.y;
  g.beginPath();
  g.roundRect(MARGIN, y0, CONTENT_W, rowH, 14);
  g.fillStyle = ALT_BG;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = ACCENT;
  g.stroke();
  setFont(g, 700, 30);
  g.fillStyle = TEXT;
  g.fillText(item.dpaPurchaseTime ?? item.timeLabel ?? "", MARGIN + 20, y0 + 16);
  setFont(g, 700, 29);
  lines.forEach((line, i) => {
    g.fillText(line, MARGIN + TIME_W, y0 + 14 + i * 40);
  });
  setFont(g, 400, 23);
  g.fillStyle = DIM;
  g.fillText(
    "買えなかったら、その後の予定の組み直しが必要になる分岐点です。",
    MARGIN + TIME_W,
    y0 + rowH - 36,
  );
  p.y = y0 + rowH + 12;
}

// 「最初の10分」 block (kind "first10"): display-only content —
// the entry time, the heading, the first tasks as a bullet list,
// and the fixed guidance line, in a framed box. It is not a
// schedule stop: no pin number, no estimated wait, and no travel
// line leads into or out of it (the caller skips those). A printed
// page cannot carry the app's 「抽選に外れたら？」 button, so the
// bullets stand as the checklist itself.
function drawFirst10Block(p: Painter, item: PdfItem): void {
  const innerX = MARGIN + TIME_W;
  const innerW = CONTENT_W - TIME_W - 36;
  type Line = { text: string; bullet: boolean; first: boolean };
  const body: Line[] = [];
  for (const raw of (item.note ?? "").split(/\n+/)) {
    const t = raw.trim();
    if (!t) continue;
    const bullet = t.startsWith("・");
    const text = bullet ? t.replace(/^・\s*/, "") : t;
    setFont(p.g, bullet ? 600 : 400, 27);
    const wrapped = wrapText(p.g, text, innerW - (bullet ? 34 : 0));
    wrapped.forEach((w, wi) =>
      body.push({ text: w, bullet, first: wi === 0 }),
    );
  }
  setFont(p.g, 700, 30);
  const headLines = wrapText(p.g, item.name, innerW);
  const rowH = 24 + headLines.length * 42 + body.length * 38 + 14;
  p.ensure(rowH + 12);
  const g = p.g;
  const y0 = p.y;
  g.beginPath();
  g.roundRect(MARGIN, y0, CONTENT_W, rowH, 14);
  g.fillStyle = ALT_BG;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = KIND_COLORS.first10;
  g.stroke();
  setFont(g, 700, 30);
  g.fillStyle = TEXT;
  g.fillText(item.timeLabel ?? "", MARGIN + 20, y0 + 16);
  let ty = y0 + 14;
  for (const hl of headLines) {
    g.fillText(hl, innerX, ty);
    ty += 42;
  }
  for (const l of body) {
    if (l.bullet) {
      setFont(g, 600, 27);
      g.fillStyle = TEXT;
      if (l.first) g.fillText("・", innerX, ty + 2);
      g.fillText(l.text, innerX + 34, ty + 2);
    } else {
      setFont(g, 400, 27);
      g.fillStyle = DIM;
      g.fillText(l.text, innerX, ty + 2);
    }
    ty += 38;
  }
  p.y = y0 + rowH + 12;
}

// Travel divider between schedule rows: the server-computed minutes
// from the previous stop to this one (coordinates + walking speed,
// margin included). Drawn for every row that carries a travelMin —
// including 移動 (move) rows, where it states how long that movement
// itself takes. Rows without one (first row, unverified leg, older
// plan sets) get no line: no invented number is printed.
function drawTravelLine(p: Painter, minutes: number): void {
  p.ensure(46);
  const g = p.g;
  setFont(g, 600, 24);
  g.fillStyle = DIM;
  const label = `移動 約${minutes}分`;
  const w = g.measureText(label).width;
  g.fillText(label, MARGIN + (CONTENT_W - w) / 2, p.y + 6);
  p.y += 42;
}

// Tight-leg caution, drawn between the two rows of a leg whose
// approximate walking distance is at least 300 m and whose
// schedule slack is at most 5 minutes (the same display-time
// judgement as the plan tab's list — see tightLegTargets in
// plan_metrics). Printed so the person the plan is handed to can
// also see which leg has no room to spare, and that it can be
// relaxed by asking the AI.
function drawCautionLine(p: Painter): void {
  setFont(p.g, 400, 26);
  const lines = wrapText(p.g, TIGHT_LEG_CAUTION_TEXT, CONTENT_W - 48);
  const boxH = lines.length * 38 + 24;
  p.ensure(boxH + 10);
  const g = p.g;
  const y0 = p.y;
  g.beginPath();
  g.roundRect(MARGIN, y0, CONTENT_W, boxH, 12);
  g.fillStyle = "#fdf3e3";
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = "#e8890c";
  g.stroke();
  setFont(g, 400, 26);
  g.fillStyle = "#7a4a00";
  lines.forEach((line, i) => {
    g.fillText(line, MARGIN + 24, y0 + 13 + i * 38);
  });
  p.y = y0 + boxH + 10;
}

// "12時間" / "6時間30分" style label for the summary's 滞在時間
// (the same wording as the plan tab's formatStayDuration).
function stayDurationText(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

// The plan-head summary, printed directly under the heading
// band — the same items in the same order as the plan tab's
// summary cards (values are the server's read-time derivation,
// carried in the payload as plan.summaryStats, so print and screen
// never disagree). Drawn as a grid of stat cells in the same
// spirit as the screen cards: small labels over big bold numbers,
// one band per row group so the groups read apart at a glance —
// row 1 （費用概算／アトラクション／待ち時間合計） on the
// strongest band (a tint of the plan colour) with the largest
// numbers, row 2 （移動時間合計／歩行距離概算／滞在時間） on
// white, row 3 （ショー／パレード／レストラン） quiet on the
// box ground with smaller numbers. The 未確認 warning, when the
// plan has any, is its own amber band under the grid; plans
// without unconfirmed rows get no band, as before. When the set's
// party includes a child under 5, the ひざ上 explanation band
// (plan.lapChildNote) follows in the same amber treatment,
// directly under the warning band when both are present.
function drawSummaryBox(p: Painter, plan: PdfPlan): void {
  const s = plan.summaryStats;
  const yen = (n: number): string => `¥${n.toLocaleString("ja-JP")}`;
  const budgetText =
    s.budgetJpy != null
      ? s.budgetDiffJpy != null
        ? `予算 ${yen(s.budgetJpy)}（${
            s.budgetDiffJpy >= 0
              ? `残り ${yen(s.budgetDiffJpy)}`
              : `${(-s.budgetDiffJpy).toLocaleString("ja-JP")}円超過`
          }）`
        : `予算 ${yen(s.budgetJpy)}`
      : null;

  type Cell = { label: string; value: string; subs: string[] };
  const rowGroups: { cells: Cell[]; valueSize: number; valueLine: number }[] = [
    {
      valueSize: 46,
      valueLine: 58,
      cells: [
        {
          label: "費用概算",
          value:
            s.totalCostJpy != null
              ? `約${s.totalCostJpy.toLocaleString("ja-JP")}円`
              : "未算出",
          subs: [
            `うちDPA ${yen(s.dpaAmountJpy)}・${s.dpaCount}件`,
            ...(budgetText ? [budgetText] : []),
          ],
        },
        {
          label: "アトラクション",
          value: `${s.attractionCount}件`,
          subs: [
            `うちDPA ${s.attractionDpaCount}件${
              s.attractionDpaRatePct != null
                ? `・DPA率 ${s.attractionDpaRatePct}%`
                : ""
            }`,
          ],
        },
        {
          label: "待ち時間合計",
          value: `${s.totalWaitMin}分`,
          subs: s.longestWait
            ? [`最長：${s.longestWait.name} ${s.longestWait.waitMin}分`]
            : [],
        },
      ],
    },
    {
      valueSize: 38,
      valueLine: 48,
      cells: [
        {
          label: "移動時間合計",
          value: s.totalTravelMin != null ? `${s.totalTravelMin}分` : "―",
          subs: [],
        },
        {
          label: "歩行距離概算",
          value: s.totalWalkM != null ? formatWalkDistance(s.totalWalkM) : "―",
          subs: [],
        },
        {
          label: "滞在時間",
          value: s.stayMinutes != null ? stayDurationText(s.stayMinutes) : "―",
          subs:
            s.stayStartLabel && s.stayEndLabel
              ? [`${s.stayStartLabel}〜${s.stayEndLabel}`]
              : [],
        },
      ],
    },
    {
      valueSize: 32,
      valueLine: 42,
      cells: [
        { label: "ショー", value: `${s.showCount}件`, subs: [] },
        { label: "パレード", value: `${s.paradeCount}件`, subs: [] },
        {
          label: "レストラン",
          value: `${s.restaurantCount}件`,
          subs: [`うちショーレストラン ${s.showRestaurantCount}件`],
        },
      ],
    },
  ];

  // Layout: the box keeps its ground and border; each row group is
  // a band inset from the box edges, cells in three columns.
  const BAND_INSET = 12;
  const COL_GAP = 16;
  const CELL_PAD_X = 14;
  const ROW_PAD_Y = 12;
  const LABEL_LINE = 29;
  const SUB_SIZE = 23;
  const SUB_LINE = 31;
  const BAND_GAP = 10;
  const BOX_PAD_Y = 14;
  const bandW = CONTENT_W - BAND_INSET * 2;
  const colW = Math.floor((bandW - COL_GAP * 2) / 3);
  const subW = colW - CELL_PAD_X * 2;

  // Measure first (subs wrap inside their column), so the whole
  // block — grid plus warning band — is ensured on one page.
  setFont(p.g, 400, SUB_SIZE);
  const laidOut = rowGroups.map((row) => {
    const cells = row.cells.map((cell) => ({
      ...cell,
      subLines: cell.subs.flatMap((sub) => wrapText(p.g, sub, subW)),
    }));
    const maxSubLines = Math.max(0, ...cells.map((c) => c.subLines.length));
    const height =
      ROW_PAD_Y +
      LABEL_LINE +
      4 +
      row.valueLine +
      (maxSubLines > 0 ? 4 + maxSubLines * SUB_LINE : 0) +
      ROW_PAD_Y;
    return { ...row, cells, height };
  });
  const boxH =
    BOX_PAD_Y * 2 +
    laidOut.reduce((sum, r) => sum + r.height, 0) +
    BAND_GAP * (laidOut.length - 1);

  const warnLead =
    s.unconfirmed.length > 0 ? `未確認${s.unconfirmed.length}件：` : null;
  const warnText = warnLead
    ? warnLead +
      s.unconfirmed.map((u) => `${u.name}（${u.reason}）`).join("、")
    : null;
  setFont(p.g, 400, 26);
  const warnLines = warnText ? wrapText(p.g, warnText, CONTENT_W - 64) : [];
  const warnH = warnLines.length * 38 + 22;

  // Under-5 child （ひざ上） explanation band: same amber treatment
  // as the 未確認 warning, drawn directly under it (or in its place
  // when the plan has no unconfirmed rows). The text and its
  // presence come from the payload (plan.lapChildNote, derived
  // server-side at read time from the set's conditions snapshot).
  const lapText = plan.lapChildNote;
  const lapLead = lapText
    ? lapText.slice(0, lapText.indexOf("：") + 1)
    : null;
  const lapLines = lapText ? wrapText(p.g, lapText, CONTENT_W - 64) : [];
  const lapH = lapLines.length * 38 + 22;

  p.ensure(
    boxH +
      (warnText ? BAND_GAP + warnH : 0) +
      (lapText ? BAND_GAP + lapH : 0) +
      20,
  );
  const g = p.g;
  const color = PLAN_COLORS[plan.slot];
  const y0 = p.y;
  g.beginPath();
  g.roundRect(MARGIN, y0, CONTENT_W, boxH, 14);
  g.fillStyle = ALT_BG;
  g.fill();
  g.lineWidth = 2.5;
  g.strokeStyle = BORDER;
  g.stroke();

  const bandX = MARGIN + BAND_INSET;
  let bandY = y0 + BOX_PAD_Y;
  laidOut.forEach((row, ri) => {
    // Band ground per group: row 1 strongest (plan-colour tint),
    // row 2 white, row 3 none (the box ground shows through).
    if (ri === 0) {
      g.save();
      g.globalAlpha = 0.16;
      g.beginPath();
      g.roundRect(bandX, bandY, bandW, row.height, 12);
      g.fillStyle = color;
      g.fill();
      g.restore();
    } else if (ri === 1) {
      g.beginPath();
      g.roundRect(bandX, bandY, bandW, row.height, 12);
      g.fillStyle = "#ffffff";
      g.fill();
    }
    row.cells.forEach((cell, ci) => {
      const x = bandX + ci * (colW + COL_GAP) + CELL_PAD_X;
      let ty = bandY + ROW_PAD_Y;
      setFont(g, ri === 0 ? 700 : 600, 22);
      g.fillStyle = ri === 0 ? TEXT : DIM;
      g.fillText(cell.label, x, ty);
      ty += LABEL_LINE + 4;
      setFont(g, 700, row.valueSize);
      g.fillStyle = TEXT;
      g.fillText(cell.value, x, ty);
      ty += row.valueLine;
      if (cell.subLines.length > 0) {
        ty += 4;
        setFont(g, 400, SUB_SIZE);
        g.fillStyle = NOTE_TEXT;
        for (const line of cell.subLines) {
          g.fillText(line, x, ty);
          ty += SUB_LINE;
        }
      }
    });
    bandY += row.height + BAND_GAP;
  });
  p.y = y0 + boxH;

  // 未確認 warning band: amber ground and border, bold lead —
  // drawn only for plans that actually have unconfirmed rows.
  if (warnText && warnLead) {
    const wy = p.y + BAND_GAP;
    g.beginPath();
    g.roundRect(MARGIN, wy, CONTENT_W, warnH, 12);
    g.fillStyle = "#fdf3e3";
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = "#e8890c";
    g.stroke();
    g.fillStyle = "#7a4a00";
    warnLines.forEach((line, i) => {
      const ly = wy + 11 + i * 38;
      if (i === 0) {
        setFont(g, 700, 26);
        g.fillText(warnLead, MARGIN + 24, ly);
        const leadW = g.measureText(warnLead).width;
        setFont(g, 400, 26);
        g.fillText(line.slice(warnLead.length), MARGIN + 24 + leadW, ly);
      } else {
        setFont(g, 400, 26);
        g.fillText(line, MARGIN + 24, ly);
      }
    });
    p.y = wy + warnH;
  }

  // Under-5 child （ひざ上） explanation band: amber ground and
  // border, bold lead — the same treatment as the 未確認 warning
  // above, continuing directly under it when both are present.
  if (lapText && lapLead) {
    const ly0 = p.y + BAND_GAP;
    g.beginPath();
    g.roundRect(MARGIN, ly0, CONTENT_W, lapH, 12);
    g.fillStyle = "#fdf3e3";
    g.fill();
    g.lineWidth = 2.5;
    g.strokeStyle = "#e8890c";
    g.stroke();
    g.fillStyle = "#7a4a00";
    lapLines.forEach((line, i) => {
      const ty = ly0 + 11 + i * 38;
      if (i === 0) {
        setFont(g, 700, 26);
        g.fillText(lapLead, MARGIN + 24, ty);
        const leadW = g.measureText(lapLead).width;
        setFont(g, 400, 26);
        g.fillText(line.slice(lapLead.length), MARGIN + 24 + leadW, ty);
      } else {
        setFont(g, 400, 26);
        g.fillText(line, MARGIN + 24, ty);
      }
    });
    p.y = ly0 + lapH;
  }
  p.y += 20;
}

function drawPlan(
  p: Painter,
  plan: PdfPlan,
  mapCanvas: HTMLCanvasElement | null,
  photos: Map<string, ImageBitmap | null>,
  dpaPrices: Map<string, number>,
  priorities: PlanPdfData["priorities"],
): void {
  let g = p.g;
  const color = PLAN_COLORS[plan.slot];

  // Heading band: プランA：{title}, wrapped inside the band. Stored
  // plan titles may already carry the 「プランX：」 prefix (the
  // generation task writes them that way), so strip it first — the
  // band must never read 「プランA：プランA：…」.
  setFont(g, 700, 36, true);
  const cleanTitle = plan.title.replace(/^プラン[ABC][:：]\s*/, "");
  const titleLines = wrapText(
    g,
    `プラン${plan.slot}：${cleanTitle}`,
    CONTENT_W - 48,
  );
  const bandH = titleLines.length * 50 + 30;
  p.ensure(bandH + 130);
  g = p.g;
  g.beginPath();
  g.roundRect(MARGIN, p.y, CONTENT_W, bandH, 16);
  g.fillStyle = color;
  g.fill();
  g.fillStyle = "#ffffff";
  titleLines.forEach((line, i) => {
    g.fillText(line, MARGIN + 24, p.y + 15 + i * 50);
  });
  p.y += bandH + 18;

  // The plan-head summary, directly under the heading band — the
  // same position and order as on the plan tab.
  drawSummaryBox(p, plan);

  // Cost box: the total first, then the itemized breakdown.
  const costLines: { text: string; total: boolean }[] = [];
  costLines.push({
    text:
      plan.estimatedCostJpy != null
        ? `概算費用（合計）：約${plan.estimatedCostJpy.toLocaleString("ja-JP")}円`
        : "概算費用：未算出",
    total: true,
  });
  for (const line of plan.costBreakdown) {
    const amount =
      line.amountJpy != null
        ? `約${line.amountJpy.toLocaleString("ja-JP")}円`
        : "—";
    costLines.push({
      text: `${line.label}：${amount}${line.note ? ` ${line.note}` : ""}`,
      total: false,
    });
  }
  const costH =
    costLines.reduce(
      (sum, l) => sum + (l.total ? 50 : 42) * 1 + (l.total ? 6 : 0),
      0,
    ) + 28;
  p.ensure(costH);
  g = p.g;
  g.beginPath();
  g.roundRect(MARGIN, p.y, CONTENT_W, costH, 14);
  g.fillStyle = ALT_BG;
  g.fill();
  let cy = p.y + 14;
  for (const l of costLines) {
    if (l.total) {
      setFont(g, 700, 34);
      g.fillStyle = TEXT;
      g.fillText(l.text, MARGIN + 24, cy);
      cy += 56;
    } else {
      setFont(g, 400, 29);
      g.fillStyle = NOTE_TEXT;
      g.fillText(l.text, MARGIN + 24, cy);
      cy += 42;
    }
  }
  p.y += costH + 20;

  // The former travel-totals lines under the cost box were absorbed
  // into the plan-head summary above （移動時間合計／歩行距離概算） —
  // they are not printed twice.

  // Premise of this plan — 「このプランの前提」: for sets made under
  // the unified conditions model, this plan's crowd scenario plus
  // the single 「重視する点」 shared by all three plans; for older
  // sets, the legacy per-slot priority plus the common priority.
  // Both come from the set's conditions snapshot / plan row (the
  // same values the plan tab shows under the plan title), so the
  // reader of a handed-over PDF can tell what the plan was built
  // around without seeing the conditions form.
  const scenarioPremise = crowdScenarioPremiseText(plan);
  const unified = priorities?.model === "unified";
  const ownPriority = unified ? null : (priorities?.[plan.slot] ?? null);
  const commonPriority = unified ? null : (priorities?.common ?? null);
  const unifiedPriority = unified ? (priorities?.unified ?? null) : null;
  // A plan with restaurant rows states in its premise that
  // restaurant waits are not included (meals are on the premise of
  // being prepared in advance) — the note text is carried in the
  // getPlanPdfData payload, derived server-side at read time from
  // the plan's rows, exactly as the plan tab's notes show it.
  const restaurantWaitNote = plan.restaurantWaitNote;
  if (
    scenarioPremise ||
    unifiedPriority ||
    ownPriority ||
    commonPriority ||
    restaurantWaitNote
  ) {
    p.sectionHeading("このプランの前提", color);
    if (scenarioPremise) {
      p.flowText(scenarioPremise, { size: 29, weight: 600, lineHeight: 42 });
    }
    if (unifiedPriority) {
      p.flowText(`重視する点：${unifiedPriority}`, {
        size: 29,
        lineHeight: 42,
      });
    }
    if (ownPriority) {
      p.flowText(`プラン${plan.slot}：${ownPriority}`, {
        size: 29,
        lineHeight: 42,
      });
    }
    if (commonPriority) {
      p.flowText(`共通：${commonPriority}`, {
        size: 29,
        lineHeight: 42,
      });
    }
    if (restaurantWaitNote) {
      p.flowText(restaurantWaitNote, { size: 29, lineHeight: 42 });
    }
    p.gap(14);
  }

  // Static map (or an explicit note when the plan has no pins).
  const pinnedCount = plan.items.filter(
    (it) => it.lat != null && it.lng != null,
  ).length;
  if (mapCanvas) {
    p.ensure(MAP_H + 46);
    g = p.g;
    g.save();
    g.beginPath();
    g.roundRect(MARGIN, p.y, MAP_W, MAP_H, 14);
    g.clip();
    g.drawImage(mapCanvas, MARGIN, p.y);
    g.restore();
    g.strokeStyle = BORDER;
    g.lineWidth = 2;
    g.beginPath();
    g.roundRect(MARGIN, p.y, MAP_W, MAP_H, 14);
    g.stroke();
    p.y += MAP_H + 6;
    setFont(g, 400, 22);
    g.fillStyle = DIM;
    const attr = "© OpenStreetMap contributors";
    g.fillText(attr, RIGHT - g.measureText(attr).width, p.y);
    p.y += 34;
  } else if (pinnedCount === 0) {
    p.flowText(
      "このプランには座標のあるスポットがないため、地図は省略しています。下のスケジュールで順番を確認してください。",
      { size: 27, color: DIM, lineHeight: 40 },
    );
    p.gap(10);
  } else {
    p.flowText(
      "地図の画像を取得できなかったため、このプランの地図は省略しています。下のスケジュールで順番を確認してください。",
      { size: 27, color: DIM, lineHeight: 40 },
    );
    p.gap(10);
  }

  // Schedule.
  p.sectionHeading("スケジュール", color);
  if (plan.items.length === 0) {
    p.flowText("スケジュールの行がありません。", {
      size: 28,
      color: DIM,
      lineHeight: 42,
    });
  }
  // DPA purchase events merged into the timeline AT their purchase
  // time (same rule as the app's schedule list): each event goes
  // before the first row that starts later than the purchase, never
  // after the pass's own row.
  const toMin = (label: string | null): number | null => {
    if (!label) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(label);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const eventsAt = new Map<number, PdfItem[]>();
  // A purchase instance already represented by a stored
  // purchase-event row (kind "purchase") is drawn from that row
  // (at its own position, with its stored unit price); the usage
  // row must not ALSO derive an event for it.
  const instanceKey = (item: PdfItem): string =>
    `${dpaNameKey(item.name)}|${item.dpaPurchaseTime ?? item.timeLabel ?? ""}`;
  const storedPurchaseKeys = new Set(
    plan.items
      .filter(
        (it) =>
          it.kind === "purchase" &&
          it.passType != null &&
          /プレミアアクセス|DPA/i.test(it.passType),
      )
      .map((it) => instanceKey(it)),
  );
  plan.items.forEach((it, i) => {
    if (
      it.passType == null ||
      !/プレミアアクセス|DPA/i.test(it.passType)
    ) {
      return;
    }
    if (it.kind === "purchase") {
      const list = eventsAt.get(i) ?? [];
      list.push(it);
      eventsAt.set(i, list);
      return;
    }
    if (!it.dpaPurchaseTime) return;
    if (storedPurchaseKeys.has(instanceKey(it))) return;
    const t = toMin(it.dpaPurchaseTime);
    let at = i;
    if (t != null) {
      for (let j = 0; j < plan.items.length; j++) {
        const jt = toMin(plan.items[j]?.timeLabel ?? null);
        if (jt != null && jt > t) {
          at = Math.min(j, i);
          break;
        }
      }
    }
    const list = eventsAt.get(at) ?? [];
    list.push(it);
    eventsAt.set(at, list);
  });
  for (const list of eventsAt.values()) {
    list.sort(
      (a, b) =>
        (toMin(a.dpaPurchaseTime) ?? Number.MAX_SAFE_INTEGER) -
        (toMin(b.dpaPurchaseTime) ?? Number.MAX_SAFE_INTEGER),
    );
  }
  // Tight legs （無理ポイント） of this plan, judged at render time
  // from the stored leg data — display-only, never plan items.
  const tightTargets = tightLegTargets(plan.items);
  let pin = 0;
  let itemIndex = 0;
  for (const item of plan.items) {
    for (const pe of eventsAt.get(itemIndex) ?? []) {
      drawPurchaseEvent(
        p,
        pe,
        pe.unitPriceJpy ?? dpaPrices.get(dpaNameKey(pe.name)) ?? null,
      );
    }
    // A stored purchase-event row is drawn ONLY as its purchase
    // event (above) — never as a schedule row, and its zero
    // pass-through travel_min never becomes a travel line.
    if (item.kind === "purchase") {
      itemIndex++;
      continue;
    }
    // The 「最初の10分」 block is drawn as its own framed block —
    // never as a schedule row, and its zero pass-through
    // travel_min never becomes a travel line.
    if (item.kind === "first10") {
      drawFirst10Block(p, item);
      itemIndex++;
      continue;
    }
    if (tightTargets.has(itemIndex)) {
      drawCautionLine(p);
    }
    if (itemIndex > 0 && item.travelMin != null) {
      drawTravelLine(p, item.travelMin);
    }
    itemIndex++;
    const itemPin =
      item.lat != null && item.lng != null ? ++pin : null;
    const photo = item.imageUrl ? (photos.get(item.imageUrl) ?? null) : null;
    drawScheduleRow(p, item, itemPin, photo, color);
  }
  p.gap(16);

  // Plan description.
  if (plan.summary) {
    p.sectionHeading("プランの説明", color);
    p.flowText(plan.summary, { size: 30, lineHeight: 46 });
    p.gap(10);
  }
}

// ------------------------------------------------------------ PDF assembly

const A4_W_PT = 595.28;
const A4_H_PT = 841.89;

function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("PDFのページ画像を作れませんでした"));
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(reject);
      },
      "image/jpeg",
      0.88,
    );
  });
}

// Minimal PDF 1.4 writer: one full-page JPEG image per page.
async function assemblePdf(
  pages: HTMLCanvasElement[],
): Promise<Blob> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const offsets = new Map<number, number>();
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const pushStr = (s: string) => push(encoder.encode(s));
  const beginObj = (id: number) => {
    offsets.set(id, offset);
    pushStr(`${id} 0 obj\n`);
  };

  const jpegs: Uint8Array[] = [];
  for (const page of pages) {
    jpegs.push(await canvasToJpegBytes(page));
  }

  pushStr("%PDF-1.4\n");
  // Binary marker comment (the PDF spec's recommendation for files
  // containing binary data): a comment line of bytes above 0x7F right
  // after the header, so file transfer tools and strict viewers
  // never mistake the file for text and mangle the image streams.
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  beginObj(1);
  pushStr("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = jpegs.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  beginObj(2);
  pushStr(
    `<< /Type /Pages /Kids [${kids}] /Count ${jpegs.length} >>\nendobj\n`,
  );
  for (let i = 0; i < jpegs.length; i++) {
    const pageId = 3 + i * 3;
    const contentId = pageId + 1;
    const imageId = pageId + 2;
    const jpeg = jpegs[i];
    if (!jpeg) continue;
    beginObj(pageId);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W_PT} ${A4_H_PT}] ` +
        `/Resources << /XObject << /Im${i} ${imageId} 0 R >> >> ` +
        `/Contents ${contentId} 0 R >>\nendobj\n`,
    );
    const content = `q ${A4_W_PT} 0 0 ${A4_H_PT} 0 0 cm /Im${i} Do Q\n`;
    beginObj(contentId);
    pushStr(
      `<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`,
    );
    beginObj(imageId);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${PAGE_W} /Height ${PAGE_H} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
        `/Length ${jpeg.length} >>\nstream\n`,
    );
    push(jpeg);
    pushStr("\nendstream\nendobj\n");
  }
  const xrefAt = offset;
  const objCount = 3 + jpegs.length * 3;
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`;
  for (let id = 1; id < objCount; id++) {
    const at = offsets.get(id) ?? 0;
    xref += `${String(at).padStart(10, "0")} 00000 n \n`;
  }
  pushStr(
    `${xref}trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return new Blob([out], { type: "application/pdf" });
}

// ------------------------------------------------------------ entry point

// Builds the plan PDF entirely in-app and resolves with the file
// blob plus its download file name. Throws on hard failures (the
// caller shows the error and offers a retry); missing photos or map
// tiles degrade the contents, never the whole export.
//
// `pages` is the very canvases the PDF's page images were encoded
// from. The caller displays them directly as the in-app preview:
// the contents the user sees are then the actual generated pixels,
// with no file fetch, no blob-storage round trip and no PDF parser
// between generation and the user's eyes — every one of those hops
// has, on the owner's phone, turned a valid PDF into a black or
// blank screen at least once.
export async function buildPlanPdf(
  data: PlanPdfData,
): Promise<{
  blob: Blob;
  fileName: string;
  createdLabel: string;
  pages: HTMLCanvasElement[];
}> {
  // Load every distinct intro photo once (facilities repeat across
  // plans) and build each plan's static map from shared tile cache.
  const photoUrls = new Set<string>();
  for (const plan of data.plans) {
    for (const item of plan.items) {
      if (item.imageUrl) photoUrls.add(item.imageUrl);
    }
  }
  const photos = new Map<string, ImageBitmap | null>();
  await Promise.all(
    Array.from(photoUrls).map(async (url) => {
      photos.set(url, await loadBitmap(url));
    }),
  );

  // Static maps. Frame every plan first so the union of tiles it
  // needs is known, then fetch those tiles through the getMapTiles
  // action: the server downloads them and hands back owned blob
  // URLs, the same channel the intro photos use. Fetching the tile
  // host directly from this sandboxed page proved unreliable (the
  // PDF shipped without maps), so the direct fetch remains only as
  // a per-tile fallback for tiles the server could not get either.
  const planPoints = new Map<string, PinnedPoint[]>();
  const planLayouts = new Map<string, MapLayout>();
  const wanted = new Map<string, { z: number; x: number; y: number }>();
  for (const plan of data.plans) {
    const points: PinnedPoint[] = [];
    let pin = 0;
    for (const item of plan.items) {
      if (item.lat != null && item.lng != null) {
        pin++;
        points.push({ lat: item.lat, lng: item.lng, pin });
      }
    }
    planPoints.set(plan.slot, points);
    if (points.length === 0) continue;
    const layout = mapLayout(points);
    planLayouts.set(plan.slot, layout);
    for (const t of layout.tiles) {
      wanted.set(`${t.z}/${t.x}/${t.y}`, { z: t.z, x: t.x, y: t.y });
    }
  }
  const serverTileUrls = new Map<string, string>();
  if (wanted.size > 0) {
    try {
      const res = await api.getMapTiles({
        tiles: Array.from(wanted.values()),
      });
      for (const t of res.tiles) {
        if (t.url) serverTileUrls.set(`${t.z}/${t.x}/${t.y}`, t.url);
      }
    } catch {
      // Action unavailable: every tile falls back to a direct fetch.
    }
  }
  const tileBitmapCache = new Map<string, Promise<ImageBitmap | null>>();
  const tileBitmapFor = (key: string): Promise<ImageBitmap | null> => {
    let bmp = tileBitmapCache.get(key);
    if (!bmp) {
      const serverUrl = serverTileUrls.get(key);
      bmp = serverUrl
        ? loadBitmap(serverUrl)
        : loadBitmap(`https://tile.openstreetmap.org/${key}.png`);
      tileBitmapCache.set(key, bmp);
    }
    return bmp;
  };
  const mapCanvases = new Map<string, HTMLCanvasElement | null>();
  for (const plan of data.plans) {
    const points = planPoints.get(plan.slot) ?? [];
    const layout = planLayouts.get(plan.slot);
    mapCanvases.set(
      plan.slot,
      points.length > 0 && layout
        ? await buildMapCanvas(
            points,
            PLAN_COLORS[plan.slot],
            layout,
            tileBitmapFor,
          )
        : null,
    );
  }

  const p = new Painter();

  // Document header: set title, park / date, park hours.
  setFont(p.g, 700, 54, true);
  const titleLines = wrapText(p.g, data.title, CONTENT_W);
  for (const line of titleLines) {
    p.ensure(76);
    setFont(p.g, 700, 54, true);
    p.g.fillStyle = TEXT;
    p.g.fillText(line, MARGIN, p.y);
    p.y += 76;
  }
  p.gap(6);
  const meta =
    data.visitDate != null
      ? `${data.parkName}／${formatVisitDate(data.visitDate)}`
      : data.parkName;
  p.flowText(meta, { size: 31, weight: 600, lineHeight: 44 });
  if (data.parkHours) {
    p.flowText(`営業時間：${data.parkHours}`, {
      size: 28,
      color: DIM,
      lineHeight: 40,
    });
  }
  // Crowd forecast premise of the set: the level the generation
  // evaluated for this date and its basis — the premise the waits
  // in this document were built under. Sets created before the
  // forecast existed carry none and print nothing here.
  if (data.crowdLevel != null) {
    p.flowText(
      `混雑予想：${data.crowdLevel}／5${data.crowdBasis ? `（${data.crowdBasis}）` : ""}`,
      { size: 28, weight: 600, lineHeight: 40 },
    );
    p.flowText(
      `推定待ち時間には、この混雑予想にもとづく係数を適用しています。3プランは混雑シナリオで分けてあります（プランA＝激混み前提、プランB＝やや混み前提、プランC＝思ったより空いてる前提）。各プランのシナリオ前提は各プランの先頭に、施設ごとの実効係数は検証の記録にあります`,
      { size: 24, color: DIM, lineHeight: 34 },
    );
  }
  p.gap(10);
  p.divider();
  p.gap(22);

  // Official DPA unit prices for the purchase events, from the set's
  // verification record (the normalized facts the DPA gate judged
  // by at creation time).
  const dpaPrices = new Map<string, number>(
    (data.verification?.dpaExtracted ?? []).map((d) => [
      dpaNameKey(d.name),
      d.priceJpy,
    ]),
  );
  for (const plan of data.plans) {
    drawPlan(p, plan, mapCanvases.get(plan.slot) ?? null, photos, dpaPrices, data.priorities);
    p.gap(18);
  }

  // Set-level notes, official sources, estimation material (kept
  // apart, like the plan tab).
  if (data.notes) {
    const points = splitNotes(data.notes);
    if (points.length > 0) {
      p.sectionHeading("前提・注意点", ACCENT);
      for (const point of points) {
        setFont(p.g, 400, 29);
        const lines = wrapText(p.g, point, CONTENT_W - 40);
        lines.forEach((line, i) => {
          p.ensure(42);
          setFont(p.g, 400, 29);
          p.g.fillStyle = TEXT;
          p.g.fillText(i === 0 ? `・${line}` : `　${line}`, MARGIN, p.y);
          p.y += 42;
        });
      }
      p.gap(14);
    }
  }
  // Verification record: what was cross-checked against the official
  // data fetched at creation time, and what stayed 未確認.
  if (data.verification) {
    p.sectionHeading("検証の記録", ACCENT);
    if (data.verification.checkedAt) {
      p.flowText(
        `${data.verification.checkedAt}に取得した公式データで照合しました。`,
        { size: 25, color: DIM, lineHeight: 36 },
      );
      p.gap(4);
    }
    for (const c of data.verification.checks) {
      setFont(p.g, 400, 29);
      const line = `${c.label}：${c.result}`;
      const lines = wrapText(p.g, line, CONTENT_W - 40);
      lines.forEach((l, i) => {
        p.ensure(42);
        setFont(p.g, 400, 29);
        p.g.fillStyle = TEXT;
        p.g.fillText(i === 0 ? `・${l}` : `　${l}`, MARGIN, p.y);
        p.y += 42;
      });
    }
    if (data.verification.crowdFactors.length > 0) {
      // Per-plan grouping since the scenario split (records saved
      // before it carry no slot and print as one flat list).
      const factors = data.verification.crowdFactors;
      const grouped = (["A", "B", "C"] as const)
        .map((slot) => ({
          slot,
          list: factors.filter((f) => f.slot === slot),
        }))
        .filter((g) => g.list.length > 0);
      const flat = factors.filter((f) => f.slot == null);
      if (grouped.length > 0) {
        p.flowText(
          `プラン別・施設ごとの実効係数（混雑予想にもとづき、待ち時間の基礎推定に掛けた係数）`,
          { size: 25, color: DIM, lineHeight: 36 },
        );
        for (const g of grouped) {
          p.flowText(
            `プラン${g.slot}：${g.list
              .map((f) => `${f.name} ${crowdFactorLabel(f.factor)}`)
              .join("、")}`,
            { size: 25, color: DIM, lineHeight: 36 },
          );
        }
      }
      if (flat.length > 0) {
        p.flowText(
          `施設ごとの実効係数（混雑予想にもとづき、待ち時間の基礎推定に掛けた係数）：${flat
            .map((f) => `${f.name} ${crowdFactorLabel(f.factor)}`)
            .join("、")}`,
          { size: 25, color: DIM, lineHeight: 36 },
        );
      }
      p.gap(4);
    }
    if (data.verification.dpaFacts.length > 0) {
      const fs = data.verification.factSummary;
      p.flowText(
        `判定に使ったDPAファクト（公式情報を正規化したもの）${fs ? `：母集合${fs.universeCount}施設（対象${fs.eligibleCount}／対象外${fs.notEligibleCount}／不明${fs.unknownCount}）${fs.complete ? "・全施設にファクトあり" : "・不完全なビルド"}` : ""}`,
        { size: 25, color: DIM, lineHeight: 36 },
      );
      const eligible = data.verification.dpaFacts.filter(
        (f) => f.status === "eligible",
      );
      if (eligible.length > 0) {
        p.flowText(
          `対象：${eligible
            .map(
              (f) =>
                `${f.name} ${f.priceJpy != null ? `${f.priceJpy.toLocaleString("ja-JP")}円` : ""}${dpaPeriodSuffix(f)}`,
            )
            .join("、")}`,
          { size: 25, color: DIM, lineHeight: 36 },
        );
      }
      for (const f of data.verification.dpaFacts.filter(
        (f) => f.status === "unknown",
      )) {
        p.flowText(
          `不明：${f.name}${f.unknownReason ? `（${f.unknownReason}）` : ""}`,
          { size: 25, color: DIM, lineHeight: 36 },
        );
      }
      const notEligible = data.verification.dpaFacts.filter(
        (f) => f.status === "not_eligible",
      );
      if (notEligible.length > 0) {
        p.flowText(
          `対象外：${notEligible.map((f) => f.name).join("、")}`,
          { size: 25, color: DIM, lineHeight: 36 },
        );
      }
      p.gap(4);
    } else if (data.verification.dpaExtracted.length > 0) {
      p.flowText(
        `スナップショットから抽出したDPA対象：${data.verification.dpaExtracted
          .map((d) => `${d.name} ${d.priceJpy.toLocaleString("ja-JP")}円${dpaPeriodSuffix(d)}`)
          .join("、")}`,
        { size: 25, color: DIM, lineHeight: 36 },
      );
      p.gap(4);
    }
    for (const u of data.verification.unverified) {
      p.flowText(u.startsWith("未確認") ? u : `未確認：${u}`, {
        size: 29,
        color: ACCENT,
        lineHeight: 40,
      });
    }
    p.gap(14);
  }
  if (data.sources.length > 0) {
    p.sectionHeading("作成時に確認した公式ページ", ACCENT);
    for (const s of data.sources) {
      p.flowText(s.title, { size: 29, color: LINK, lineHeight: 40 });
      p.flowText(s.url, {
        size: 22,
        color: DIM,
        lineHeight: 30,
        breakLong: true,
      });
      p.gap(8);
    }
    p.gap(6);
  }
  if (data.estimateSources.length > 0) {
    p.sectionHeading("待ち時間の推定に使った材料（参考サイト）", ACCENT);
    p.flowText(
      "公式情報ではありません。待ち時間の読みの材料として作成時に参照した、実績集計サイトです。",
      { size: 25, color: DIM, lineHeight: 36 },
    );
    p.gap(4);
    for (const s of data.estimateSources) {
      p.flowText(
        `${s.title}${s.fetchedAt ? `（取得日：${s.fetchedAt}）` : ""}`,
        { size: 29, color: LINK, lineHeight: 40 },
      );
      p.flowText(s.url, {
        size: 22,
        color: DIM,
        lineHeight: 30,
        breakLong: true,
      });
      p.gap(8);
    }
  }

  p.drawFooters(data.footerText, data.footerUrl);
  const blob = await assemblePdf(p.pages);
  // One creation instant for both the file name's timestamp and
  // the completion block's label, so the two always agree.
  const createdAt = new Date();
  return {
    blob,
    fileName: planPdfFileName(data, createdAt),
    createdLabel: planPdfCreatedLabel(createdAt),
    pages: p.pages,
  };
}
