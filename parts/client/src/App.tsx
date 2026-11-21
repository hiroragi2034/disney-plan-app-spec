// 我が家のディズニー計画 v0.1
//
// TAB1 (fixed) AI chat / TAB2 (fixed) conditions form / TAB3+ one tab per
// plan-generation run, each with sub-tabs プランA｜プランB｜プランC
// (プランA selected when the tab opens).
// On a plan tab the OpenStreetMap-based map (numbered pins in route order)
// is fixed in the top ~32% of the screen and the plan summary + timeline
// scroll below it. A fixed AI instruction form sits at the bottom on every
// tab and feeds the TAB1 conversation.

import {
Fragment,
useCallback,
useEffect,
useRef,
useState,
type FormEvent,
type KeyboardEvent,
type ReactNode,
type RefObject,
type CSSProperties,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { actionFields } from "@hatch/space-sdk/fields" with { type: "macro" };
import type { Actions } from "../../server/src/actions";
import { buildPlanPdf } from "./pdf";
import {
TIGHT_LEG_CAUTION_TEXT,
crowdFactorLabel,
crowdScenarioPremiseText,
formatWalkDistance,
tightLegTargets,
} from "./plan_metrics";
import "./hatch-maps.js";
import "./hatch-maps.css";
import { buildStaticMapUrl, mountPlaceListMap } from "./map_helpers.mjs";

// Input limits (maxLength / min / max / required …) are read from
// the server actions' request schemas at build time, so a form
// input and the action it feeds can never disagree about a limit.
const FIELDS = actionFields<typeof Actions>();

type State = ApiResponse<typeof api, "getState">;
type Conditions = State["conditions"];
type PlanSet = State["planSets"][number];
type Plan = PlanSet["plans"][number];
type PlanItem = Plan["items"][number];

type TabKey = "chat" | "conditions" | "waitsources" | "help" | number;

// What the client reports to the AI with each message from the bottom
// form: the tab open at send time. The AI resolves plan references
// （「プランB」 etc.) against the plan set open in that tab — and, for
// a plan-set tab, against the A/B/C slot selected in it.
type OpenTabArg =
  | { kind: "chat" | "conditions" | "waitsources" | "help" }
  | { kind: "planSet"; planSetId: number; slot: SubTab };
type WaitTimeSource = State["waitTimeSources"][number];
type SubTab = "A" | "B" | "C";

// A same-day set's inputs, carried from its 条件 panel's
// 「条件を変えて再検索」 into the プラン作成 tab's 当日検索 section
// as initial values. Unlike a standard set's conditions these are
// NOT written into the saved conditions form — the 当日検索 form
// carries its own values by design — so they travel through the
// App shell as a one-shot prefill, consumed (and cleared) when the
// form mounts with them.
type SameDayPrefill = {
  park: "land" | "sea";
  location: string;
  startTime: string;
  adults: number;
  children: number;
  childrenAges: string;
  budgetJpy: number | null;
  walkingSpeed: Conditions["walkingSpeed"];
  request: string;
};

const PLAN_COLORS: Record<"A" | "B" | "C", string> = {
  A: "var(--plan-a)",
  B: "var(--plan-b)",
  C: "var(--plan-c)",
};

const KIND_LABELS: Record<PlanItem["kind"], string> = {
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

// One colour per schedule-row kind, so the type of each stop reads at a
// glance. Fixed hues with white chip text work in both colour schemes.
const KIND_COLORS: Record<PlanItem["kind"], string> = {
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

// Handle to the mounted map. selectPlace highlights a pin; panTo moves
// the camera on the LIVE map with an animated pan (easeTo with a new
// centre only), so the zoom the user currently has is preserved —
// the map is never remounted to move it. panTo returns false while the
// map is still initialising, so callers may retry once.
type MapController = {
  selectPlace?: (index: number) => void;
  panTo?: (target: { lat: number; lng: number }) => boolean;
  getZoom?: () => number | null;
  refreshSize?: () => void;
};

// Desktop horizontal scrolling for the overflow-x-auto tab strips.
// On touch devices the strips already scroll natively, and this hook
// deliberately ignores touch pointers so that behaviour (including
// long-press on plan tabs) is untouched. For mouse users it adds:
// - wheel: a vertical wheel over the strip scrolls it sideways
//   (Shift+wheel arrives as deltaX and is honoured as-is); the event
//   is only swallowed while the strip can still move that way, so at
//   the ends the wheel falls through to the page as before.
// - drag: press and drag sideways to scroll; once the pointer has
//   moved past a small threshold the drag captures the pointer, the
//   click that follows is swallowed (so a drag never activates the
//   tab it started on), and onDragStart fires (the main tab bar uses
//   it to cancel a pending long-press delete).
function useDragScroll<T extends HTMLElement>(onDragStart?: () => void) {
  const ref = useRef<T | null>(null);
  const dragStartRef = useRef(onDragStart);
  dragStartRef.current = onDragStart;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      const raw =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (raw === 0) return;
      const unit =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      const max = el.scrollWidth - el.clientWidth;
      const next = Math.min(max, Math.max(0, el.scrollLeft + raw * unit));
      if (next !== el.scrollLeft) {
        el.scrollLeft = next;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    let dragging = false;
    let moved = false;
    let startX = 0;
    let startScrollLeft = 0;
    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      if (el.scrollWidth <= el.clientWidth) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startScrollLeft = el.scrollLeft;
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 5) return;
        moved = true;
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          /* capture is best-effort; window-level moves still scroll */
        }
        el.classList.add("drag-scrolling");
        dragStartRef.current?.();
      }
      el.scrollLeft = startScrollLeft - dx;
      e.preventDefault();
    };
    const endDrag = () => {
      dragging = false;
      el.classList.remove("drag-scrolling");
    };
    const onClickCapture = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("click", onClickCapture, true);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", endDrag);
      el.removeEventListener("pointercancel", endDrag);
      el.removeEventListener("click", onClickCapture, true);
    };
  }, []);
  return ref;
}

function formatDateLabel(iso: string | null): string {
  if (!iso) return "日付未定";
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()] ?? "";
  return `${d.getMonth() + 1}/${d.getDate()}（${weekday}）`;
}

// An ISO instant -> "M/D" on the park's calendar (Asia/Tokyo), for
// the 作成/最終検証 dates shown on a plan set.
function formatMonthDayJst(iso: string | null): string {
  if (!iso) return "―";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "―";
  return d.toLocaleDateString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  });
}

// Generation phase durations, recorded by the generation task:
// seconds rendered as 分/秒 so the breakdown reads at a glance.
function formatPhaseSeconds(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}秒`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s > 0 ? `${m}分${s}秒` : `${m}分`;
}

function parkLabel(park: "land" | "sea"): string {  return park === "land" ? "ランド" : "シー";
}

// Spec-change suspicion （仕様変更の疑い）: an unverified entry
// concerns the app's premises about Disney's current system (DPA
// eligibility/prices, the normalized facts, park hours, show
// times, closures, ticket prices) — travel-leg entries （移動時間・
// 座標） do not count (a data gap, not a system change). Mirrors
// the server-side predicate in actions.ts. Wherever such a
// detection is displayed, the display itself carries the repair
// guidance (the owner's rule: the help tab alone is not read) —
// the fix is asked of the owner's own Muse in the main chat,
// because the in-app AI cannot change the app.
const SPEC_SUSPECT_UNVERIFIED =
  /DPA|プレミアアクセス|ファクト|営業時間|公演時刻|休止|チケット/;
function hasSpecSuspectUnverified(unverified: string[]): boolean {
  return unverified.some(
    (u) => SPEC_SUSPECT_UNVERIFIED.test(u) && !/移動時間/.test(u),
  );
}

function SpecRepairNote() {
  return (
    <p className="mt-2 leading-relaxed">
      このアプリの前提が、現在のディズニーの仕様と合わなくなっている可能性があります。直す場合は、Museのメインのチャットで「現在のディズニーの仕様に合わせて、このアプリを直してください」と伝えてください。
    </p>
  );
}

// ---------------------------------------------------------------- map view

// ------------------------------------------------- static map fallback
//
// The interactive map comes from the virtual map library in
// map_helpers.mjs: the layer probes the shell and internally runs
// either the platform map component (MapLibre — needs a Web Worker
// and WebGL) or its Leaflet implementation (raster tiles — neither),
// and PlanMap neither knows nor cares which one it got. The layer's
// probe only tests that a Worker can be constructed, not that it can
// actually run, so a shell that silently blocks worker execution
// (the Mac desktop Muse app's view) first picks the platform
// component and fails seconds later; the layer answers that itself
// by tearing the failed engine down and mounting the other one.
// Only when the layer reports failure through onUnavailable — every
// engine inside it failed — does PlanMap fall back to Meta's static
// map image of the same pinned places (a still map beside the place
// list). It needs
// no worker and no WebGL, only an ordinary image load. The places
// are runtime data (each plan's own items), so the image is
// requested at view time from the runtime coordinates via
// buildStaticMapUrl, framed on the pins' bounding box at the frame's
// real size. If even the image fails to load, PlanMap falls back to
// the text-only message. The viewer's own 現在地 is never included —
// only the plan's places are drawn.

// Web-Mercator projection for framing the static image (the same
// math pdf.ts uses for its printed maps).
function staticProjectX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * 256 * 2 ** zoom;
}
function staticProjectY(lat: number, zoom: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** zoom;
}
function staticUnprojectLat(y: number, zoom: number): number {
  const n = Math.PI * (1 - (2 * y) / (256 * 2 ** zoom));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

// Centre + zoom fitting every point inside a w×h frame, with a
// margin so no pin sits on the frame's edge. A single distinct spot
// opens at park-detail zoom, like the interactive map's fit.
function staticMapFraming(
  points: { lat: number; lng: number }[],
  w: number,
  h: number,
): { center: [number, number]; zoom: number } {
  const distinct = new Set(points.map((p) => `${p.lat},${p.lng}`));
  let zoom = 16;
  if (distinct.size > 1) {
    zoom = 13;
    for (let z = 17; z >= 13; z--) {
      const xs = points.map((p) => staticProjectX(p.lng, z));
      const ys = points.map((p) => staticProjectY(p.lat, z));
      const spreadX = Math.max(...xs) - Math.min(...xs);
      const spreadY = Math.max(...ys) - Math.min(...ys);
      if (
        spreadX <= Math.max(120, w - 112) &&
        spreadY <= Math.max(120, h - 112)
      ) {
        zoom = z;
        break;
      }
    }
  }
  const xs = points.map((p) => staticProjectX(p.lng, zoom));
  const ys = points.map((p) => staticProjectY(p.lat, zoom));
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
  return {
    center: [
      staticUnprojectLat(cy, zoom),
      (cx / (256 * 2 ** zoom)) * 360 - 180,
    ],
    zoom,
  };
}

// An element's rendered size, tracked with a ResizeObserver, so the
// static map image can be requested at the frame's real size (the
// static service has no fit-bounds: size + centre + zoom fully
// determine the picture). Updates are thresholded so a resize does
// not refetch on every pixel.
function useElementSize<T extends HTMLElement>() {
  const [size, setSize] = useState({ w: 880, h: 560 });
  const observerRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (w <= 0 || h <= 0) return;
      setSize((prev) =>
        Math.abs(prev.w - w) > 24 || Math.abs(prev.h - h) > 24
          ? { w, h }
          : prev,
      );
    };
    update();
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(update);
      ro.observe(node);
      observerRef.current = ro;
    }
  }, []);
  return { ref, size };
}

function PlanMap({
  entries,
  mapKey,
  pinColor,
  rowRefs,
  controllerRef,
  onVisibilityChange,
}: {
  // One entry per timeline row, in display order. lat/lng null = no pin,
  // but the row still participates in list ordering.
  entries: { item: PlanItem; color: string }[];
  mapKey: string;
  pinColor?: string;
  // Reports the 地図表示 on/off state to the parent layout, which owns
  // the map cell's size: when off, the parent collapses the cell to
  // just the toggle button's height so the detail region below takes
  // over the freed space (a same-size placeholder frame would defeat
  // the point of turning the map off).
  onVisibilityChange?: (visible: boolean) => void;
  // The timeline rows rendered in the scrolling detail region below; the
  // map highlights and scrolls to them when a pin is selected.
  rowRefs: RefObject<(HTMLLIElement | null)[]>;
  // Shared handle so schedule-row taps can highlight the tapped pin and
  // smoothly pan the live map to it (zoom unchanged).
  controllerRef?: RefObject<MapController | null>;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The live map layer handle, kept outside the mount effect so the
  // frame-size effect below can ask it to re-measure. The mount
  // effect owns setting and clearing it.
  const mapHandleRef = useRef<MapController | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  // Static-image fallback (see the helpers above PlanMap): when the
  // map layer reports the interactive map unavailable — every engine
  // inside it failed, after the layer's own engine-to-engine
  // cascade — PlanMap shows Meta's static map image of the same pins
  // instead of only a text apology. staticImgFailed means even that image could not be
  // loaded; only then does the text-only message appear. retryNonce
  // re-runs the mount effect when the viewer taps 「地図を再読み込み」
  // on the static image (a fatal error can be transient — a failed
  // style fetch — so the retry starts from the layer's probe again).
  const [staticImgFailed, setStaticImgFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const { ref: frameRef, size: frameSize } =
    useElementSize<HTMLDivElement>();
  useEffect(() => {
    setStaticImgFailed(false);
  }, [mapKey]);
  // Basemap toggle: 通常地図 vs 衛星地図, expressed engine-neutrally
  // ("standard" | "satellite") — which sources those names mean is
  // the map layer's business, not the app's: the MetaMap engine maps
  // them to its named styles (standard vector basemap / the
  // "esri-clarity" satellite style built from Esri World Imagery
  // tiles served directly by server.arcgisonline.com, not the stock
  // clarity.maptiles.arcgis.com URL whose every tile goes through a
  // 301 redirect to the Wayback archive host — the fragile hop behind
  // the satellite view coming up black), the Leaflet engine to its
  // GSI standard tiles / the same Esri World Imagery service. Either
  // way the numbered pins render on top unchanged.
  const [baseLayer, setBaseLayer] = useState<"standard" | "satellite">("standard");
  // 地図表示 on/off (owner's toggle): when off, the map itself is not
  // mounted at all — only the toggle button remains, so the map can
  // always be brought back, AND the parent layout collapses the map
  // cell to the button's height (reported via onVisibilityChange), so
  // the map's space disappears with it and the list below expands.
  // The state lives here (not in the parent) so it survives A/B/C
  // switches within the same plan tab; toggling back on remounts the
  // map via the mount effect's dependency on this flag.
  const [mapVisible, setMapVisible] = useState(true);
  useEffect(() => {
    onVisibilityChange?.(mapVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapVisible]);

  // 現在地 (the viewer's own position): obtained only when the
  // 「現在地」 button is tapped, via the browser's Geolocation API —
  // never tracked continuously and never sent anywhere; the position
  // lives only in this component's state and is drawn on the map as a
  // blue dot overlay (see mountPlaceListMap). Whether the permission
  // prompt even reaches the page depends on the WebView the app runs
  // in (inside the Muse app it may be blocked); when the position
  // cannot be obtained the button says so in place instead of
  // pretending — the honest-failure shape the owner asked for.
  const [userLocation, setUserLocation] = useState<{
    lat: number;
    lng: number;
    accuracy: number | null;
  } | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoMessage, setGeoMessage] = useState<string | null>(null);
  // Set when a fresh position arrives: the map (re)mount effect below
  // pans to it once the new map is ready.
  const pendingPanRef = useRef(false);
  const userLocKey = userLocation
    ? `${userLocation.lat},${userLocation.lng}`
    : "";

  const handleLocate = () => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoMessage(
        "この端末・ブラウザでは位置情報を取得できませんでした。",
      );
      return;
    }
    setLocating(true);
    setGeoMessage(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy:
            typeof pos.coords.accuracy === "number" &&
            Number.isFinite(pos.coords.accuracy)
              ? pos.coords.accuracy
              : null,
        };
        const sameSpot =
          userLocation != null &&
          userLocation.lat === loc.lat &&
          userLocation.lng === loc.lng;
        setUserLocation(loc);
        if (sameSpot) {
          // No remount follows (the dot is already there): pan on the
          // live map directly, with the usual one retry while the map
          // is still initialising.
          const target = { lat: loc.lat, lng: loc.lng };
          let panned = false;
          try {
            panned = controllerRef?.current?.panTo?.(target) ?? false;
          } catch {
            panned = false;
          }
          if (!panned) {
            window.setTimeout(() => {
              try {
                controllerRef?.current?.panTo?.(target);
              } catch {
                /* pan is best-effort */
              }
            }, 350);
          }
        } else {
          // The mount effect re-creates the map with the dot overlay
          // and pans to it (pendingPanRef).
          pendingPanRef.current = true;
        }
      },
      (err) => {
        setLocating(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGeoMessage(
            "位置情報の許可がありませんでした。端末の設定で位置情報を許可すると現在地を表示できます。アプリ内では取得できない場合もあります。",
          );
        } else if (err.code === err.TIMEOUT) {
          setGeoMessage(
            "現在地の取得に時間がかかり、取得できませんでした。もう一度お試しください。",
          );
        } else {
          setGeoMessage("現在地を取得できませんでした。");
        }
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
    );
  };

  const pinned = entries.filter((e) => e.item.lat != null && e.item.lng != null);
  // Indices (into `entries`) of pinned rows, so pin numbers match row numbers.
  const pinnedEntryIdx = entries
    .map((e, i) => (e.item.lat != null && e.item.lng != null ? i : -1))
    .filter((i) => i >= 0);

  useEffect(() => {
    setUnavailable(false);
    const el = containerRef.current;
    // 地図表示 off: the map container is not rendered at all, so
    // there is nothing to mount into; the previous run's cleanup has
    // already destroyed the old map.
    if (!el || pinned.length === 0 || !mapVisible) return;
    const rows = pinnedEntryIdx
      .map((i) => rowRefs.current[i])
      .filter((r): r is HTMLLIElement => r != null);
    const places = pinned.map((e) => ({
      label: e.item.name,
      lat: e.item.lat as number,
      lng: e.item.lng as number,
    }));
    // The layer's handle teardown is destroy(). Calling it here is
    // what makes the basemap toggle work: without it the previous
    // basemap stays mounted on the same container and the new layer
    // never becomes visible.
    let map: {
      destroy?: () => void;
      remove?: () => void;
      selectPlace?: (index: number) => void;
      panTo?: (target: { lat: number; lng: number }) => boolean;
      getZoom?: () => number | null;
      refreshSize?: () => void;
    } | null = null;
    try {
      map = mountPlaceListMap(
        el,
        {
          places,
          rows,
          baseLayer,
          ...(userLocation
            ? {
                userLocation: {
                  lat: userLocation.lat,
                  lng: userLocation.lng,
                },
              }
            : {}),
        },
        () => setUnavailable(true),
      );
      mapHandleRef.current = map as unknown as MapController | null;
      if (controllerRef) {
        controllerRef.current = map as unknown as MapController | null;
      }
    } catch {
      setUnavailable(true);
    }
    // Both map engines put their attribution control in the map's
    // bottom-RIGHT corner, which is where the owner wants it —
    // directly above the 現在地 button that occupies the corner's
    // bottom edge. Neither engine exposes an offset option for it,
    // so theme.css lifts the whole bottom-right control corner up by
    // the button's height (the `.plan-map` rules); no DOM relocation
    // happens here any more.
    // A fresh 現在地 position remounts the map (the dot overlay is
    // part of the mount options); once mounted, centre on the viewer.
    // panTo returns false while the map is still initialising, so
    // retry on a short ladder — the same pattern row taps use.
    let panTimers: number[] = [];
    if (pendingPanRef.current && userLocation) {
      pendingPanRef.current = false;
      const target = { lat: userLocation.lat, lng: userLocation.lng };
      panTimers = [350, 900].map((delay) =>
        window.setTimeout(() => {
          try {
            map?.panTo?.(target);
          } catch {
            /* pan is best-effort */
          }
        }, delay),
      );
    }
    return () => {
      panTimers.forEach((t) => window.clearTimeout(t));
      mapHandleRef.current = null;
      if (controllerRef) controllerRef.current = null;
      try {
        map?.destroy?.();
        map?.remove?.();
      } catch {
        /* map already gone */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, baseLayer, userLocKey, mapVisible, retryNonce]);

  // Keep the map's internal size in step with its frame. The frame
  // changes size whenever content appears or disappears in the
  // banner row above it (the PDF progress / completion block, the
  // generating banners) and when the window itself resizes; the
  // raster engine (Leaflet) renders for the size it last measured
  // and never re-measures on its own, so an untold change leaves
  // its tiles laid out for a size the container no longer has —
  // the map the owner saw break after creating a PDF. frameSize
  // already tracks the frame through a ResizeObserver (it feeds
  // the static fallback's framing); every real change now also
  // asks the live map to re-measure and re-render at the true
  // size. The first run after a mount is a no-op settle (the
  // handle is set by the mount effect, which runs first).
  const frameSizeRef = useRef(frameSize);
  useEffect(() => {
    const prev = frameSizeRef.current;
    frameSizeRef.current = frameSize;
    if (prev.w === frameSize.w && prev.h === frameSize.h) return;
    try {
      mapHandleRef.current?.refreshSize?.();
    } catch {
      /* size refresh is best-effort */
    }
  }, [frameSize]);

  // 地図表示 on/off toggle (owner's placement: the map's TOP-LEFT).
  // With the map on it overlays the map's top-left corner; with the
  // map off it renders in normal flow as the ONLY content of the
  // (now collapsed) map cell — it must never disappear while the map
  // is off: it is the only way back.
  const renderVisibilityToggle = (floating: boolean) => (
    <button
      type="button"
      onClick={() => setMapVisible((v) => !v)}
      aria-pressed={mapVisible}
      aria-label="地図表示のオン・オフ"
      className={`${floating ? "absolute left-2 top-2" : ""} z-20 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold shadow-md ${
        mapVisible
          ? "bg-[var(--surface)] text-[var(--text)]"
          : "bg-[var(--text)] text-[var(--bg)]"
      }`}
    >
      地図表示 {mapVisible ? "ON" : "OFF"}
    </button>
  );
  const visibilityToggle = renderVisibilityToggle(true);

  if (!mapVisible) {
    // Nothing but the toggle: no placeholder frame, no "非表示です"
    // panel — the parent has collapsed this cell to the button's own
    // height, so the button alone is the whole off state.
    return (
      <div className="flex justify-start">{renderVisibilityToggle(false)}</div>
    );
  }
  if (pinned.length === 0 || (unavailable && staticImgFailed)) {
    return (
      <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] px-3 py-2 text-sm text-[var(--dim)]">
        {pinned.length === 0
          ? "このプランでは地図ピンの座標を取得できませんでした。下のリストで順番を確認してください。"
          : "地図を表示できませんでした。下のリストで順番を確認してください。"}
      </p>
    );
  }
  if (unavailable) {
    // Static fallback: a still map of the same pins, framed on their
    // bounding box at the frame's real size, with the map notices
    // link under it (the image's own baked-in credit stays
    // uncropped: the requested size matches the frame, so
    // object-cover crops nothing). Static pins carry no numbers —
    // the caption says so, and the numbered list below remains the
    // order reference. The basemap toggle and 現在地 button belong
    // to the live map and are not shown here; 「地図を再読み込み」
    // retries the interactive map once.
    const points = pinned.map((e) => ({
      lat: e.item.lat as number,
      lng: e.item.lng as number,
    }));
    const imgW = Math.min(1200, Math.max(320, frameSize.w));
    const imgH = Math.min(900, Math.max(240, frameSize.h));
    const framing = staticMapFraming(points, imgW, imgH);
    const staticUrl = buildStaticMapUrl({
      center: framing.center,
      zoom: framing.zoom,
      width: imgW,
      height: imgH,
      scale: 2,
      markers: points
        .slice(0, 40)
        .map((p) => ({ position: [p.lat, p.lng] })),
    });
    return (
      <div className="flex h-full w-full flex-col">
        <div
          ref={frameRef}
          className="plan-map relative min-h-0 w-full flex-1 overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
        >
          {visibilityToggle}
          <img
            src={staticUrl}
            alt="プランの地図（静止画）。ピンは下のリストにある場所の位置を示します"
            className="h-full w-full object-cover"
            onError={() => setStaticImgFailed(true)}
          />
          <span className="absolute bottom-2 left-2 z-10 max-w-[70%] rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold shadow-md">
            静止画の地図です（ピンは場所の位置のみ・番号なし）
          </span>
          <button
            type="button"
            onClick={() => {
              setStaticImgFailed(false);
              setUnavailable(false);
              setRetryNonce((n) => n + 1);
            }}
            aria-label="対話式の地図を再読み込み"
            className="absolute bottom-2 right-2 z-10 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-semibold text-[var(--text)] shadow-md"
          >
            地図を再読み込み
          </button>
        </div>
        <p className="shrink-0 pt-1 text-right text-[11px] leading-tight">
          <a
            href="https://www.facebook.com/maps/attribution_terms"
            target="_blank"
            rel="noopener"
            className="text-[var(--dim)] underline"
          >
            © OpenStreetMap contributors, Map Data Legal Notices
          </a>
        </p>
      </div>
    );
  }
  return (
    <div ref={frameRef} className="relative h-full w-full">
      {visibilityToggle}
      <div
        ref={containerRef}
        role="img"
        aria-label="プランの地図。番号ピンが回る順番を示します"
        style={pinColor ? ({ "--pin-color": pinColor } as CSSProperties) : undefined}
        className="plan-map h-full w-full overflow-hidden rounded-[var(--radius)] border border-[var(--border)]"
      />
      <div
        role="group"
        aria-label="地図の種類切替"
        className="absolute bottom-2 left-2 z-10 flex overflow-hidden rounded-full border border-[var(--border)] bg-[var(--surface)] text-xs font-semibold shadow-md"
      >
        {(
          [
            { key: "standard", label: "通常地図" },
            { key: "satellite", label: "衛星地図" },
          ] as const
        ).map((b) => (
          <button
            key={b.key}
            aria-pressed={baseLayer === b.key}
            onClick={() => setBaseLayer(b.key)}
            className={`px-3 py-1.5 ${
              baseLayer === b.key
                ? "bg-[var(--text)] text-[var(--bg)]"
                : "text-[var(--dim)]"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>
      {/* 現在地 button: bottom-right (owner's placement), with the
          map's copyright attribution directly above it (theme.css
          lifts the attribution corner by this button's height). One
          tap = one position fix; the map centres on the blue dot.
          While a fix is in flight the button is disabled and says so. */}
      <button
        type="button"
        onClick={handleLocate}
        disabled={locating}
        aria-pressed={userLocation != null}
        aria-label="現在地を表示"
        className={`absolute bottom-2 right-2 z-10 flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-semibold shadow-md ${
          userLocation != null
            ? "bg-[#2f6fd0] text-white"
            : "bg-[var(--surface)] text-[var(--text)]"
        } ${locating ? "opacity-70" : ""}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
        </svg>
        {locating ? "取得中…" : "現在地"}
      </button>
      {geoMessage ? (
        // Raised above the bottom edge so the message never covers
        // the 現在地 button it asks the viewer to retry, nor the
        // basemap toggle at the bottom-left.
        <p
          role="alert"
          className="absolute bottom-14 left-2 right-2 z-10 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed shadow-md"
        >
          {geoMessage}
        </p>
      ) : userLocation ? (
        // Bottom-left, raised above the basemap toggle that now
        // occupies that corner's bottom edge.
        <p className="absolute bottom-12 left-2 z-10 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-semibold shadow-md">
          現在地を表示しています
          {userLocation.accuracy != null
            ? `（精度 約${Math.max(1, Math.round(userLocation.accuracy))}m）`
            : ""}
        </p>
      ) : null}
    </div>
  );
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

// Row-level unconfirmed mark (§9.4): a row that places a value which
// could not be confirmed from official sources carries the mark
// 「未確定（理由）」 with its short reason, visually distinct from a
// confirmed row (dashed amber outline). Tapping the reason toggles
// the explanation the row itself stores (why it is unconfirmed,
// including the official publication timing when known). Rows
// without a reason render nothing. The tap must not trigger the
// row's own tap behaviour (map pan), so it stops propagation.
function UnconfirmedMark({ item }: { item: PlanItem }) {
  const [open, setOpen] = useState(false);
  if (!item.unconfirmedReason) return null;
  return (
    <div className="mt-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`未確定（${item.unconfirmedReason}）。押すと説明を表示します`}
        onClick={(ev) => {
          ev.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded-full border border-dashed border-amber-600 bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900 dark:border-amber-500 dark:bg-amber-950 dark:text-amber-100"
      >
        未確定（{item.unconfirmedReason}）
      </button>
      {open ? (
        <p className="mt-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-sm leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {item.unconfirmedNote ??
            "公式情報ではまだ確定していない要素です。確定情報が出たら、プランの作り直しで反映できます。"}
        </p>
      ) : null}
    </div>
  );
}

// Restaurant classification display, derived at render time from
// the restaurant fact layer classification the server attached to
// the row (item.restaurantInfo) — grounded facts read from the
// facility's own official detail page; the row itself stores
// nothing, so plans saved before a fact existed show it too.
// - 予約必須 (show restaurants): a large warning block that cannot
//   be missed when the row is opened — the row sits in the plan on
//   the premise that a reservation has been secured.
// - Otherwise: the reservation / priority-seating / mobile-order
//   status as short chips.
// - 未確認 is stated explicitly, never left blank (a blank would
//   read as "nothing needed"); the row's official-page link is the
//   reader's way to check.
// Rows without an identified facility carry no restaurantInfo and
// render nothing here.
function RestaurantInfo({ item }: { item: PlanItem }) {
  const info = item.restaurantInfo;
  if (!info) return null;
  if (info.reservationType === "required") {
    return (
      <div className="mt-2 rounded-lg border-2 border-red-600 bg-red-100 px-3 py-2.5 dark:border-red-500 dark:bg-red-950">
        <p className="text-base font-bold leading-snug text-red-900 dark:text-red-100">
          予約必須のレストランです
        </p>
        <p className="mt-1 text-sm leading-relaxed text-red-900 dark:text-red-100">
          このお店は事前予約が必要です。この行は、予約が取れている前提で入っています。予約方法は下の公式ページで確認してください。
        </p>
      </div>
    );
  }
  const reservationLabel =
    info.reservationType === "ps"
      ? "PS対象（プライオリティ・シーティング）"
      : info.reservationType === "none"
        ? "予約なし"
        : "予約情報：未確認";
  const mobileLabel =
    info.mobileOrder === "available"
      ? "モバイルオーダー対象"
      : info.mobileOrder === "unavailable"
        ? "モバイルオーダー対象外"
        : "モバイルオーダー：未確認";
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="rounded-full bg-[var(--surface-alt)] px-2.5 py-1 font-semibold text-[var(--text)]">
        {reservationLabel}
      </span>
      <span className="rounded-full bg-[var(--surface-alt)] px-2.5 py-1 font-semibold text-[var(--text)]">
        {mobileLabel}
      </span>
    </p>
  );
}

function RowList({
  entries,
  rowRefs,
  showPinNumbers,
  onRowTap,
  dpaPrices,
  onCantBuy,
  onLotteryLost,
}: {
  entries: { item: PlanItem; color: string }[];
  rowRefs?: RefObject<(HTMLLIElement | null)[]>;
  showPinNumbers?: boolean;
  // Called with the entry index when a row is tapped; the parent centres
  // the map on that row's place (rows without coordinates ignore it).
  onRowTap?: (index: number) => void;
  // Official DPA unit prices by normalized facility name, from the plan
  // set's verification record (the normalized facts the DPA gate
  // judged by at creation time). A purchase event whose
  // facility is not in this map renders without a price — never a
  // guessed one.
  dpaPrices?: Map<string, number>;
  // When set (finished set, this plan not already being replaced), each
  // DPA purchase event row carries the 「買えなかったら？」 button,
  // called with that purchase's plan item.
  onCantBuy?: (item: PlanItem) => void;
  // When set (same condition as onCantBuy), each lottery item inside
  // the 「最初の10分」 block carries the 「抽選に外れたら？」 button,
  // called with the SHOW row the item names (the reschedule works on
  // the show's own row, exactly like the DPA flow works on its usage
  // row). A lottery item whose show is not in this plan renders
  // without the button.
  onLotteryLost?: (item: PlanItem) => void;
}) {
  // DPA purchase events, merged into the timeline AT their purchase
  // time. Buying a Premier Access pass is a decision point of the
  // day (one pass per purchase, the next at least 60 minutes later,
  // and a failed purchase forces a reschedule), so EVERY purchase —
  // not just the first one after entry — stands as its own event.
  // Each event is derived from its row's stored dpaPurchaseTime and
  // inserted before the first row that starts later than the
  // purchase (never after the pass's own row, which the purchase
  // must precede); an unparseable time falls back to just before
  // its own row.
  const toMin = (label: string | null): number | null => {
    if (!label) return null;
    const m = /^(\d{1,2}):(\d{2})/.exec(label);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  type PurchaseEvent = { item: PlanItem; ownIdx: number; time: number };
  const eventsAt = new Map<number, PurchaseEvent[]>();
  // A purchase instance (facility × purchase event) that a stored
  // purchase-event row (kind "purchase") already represents: the
  // usage row must not ALSO derive an event for it, or the same
  // purchase would stand in the timeline twice. The stored row
  // itself renders as the event (at its own position, with its
  // stored unit price).
  const instanceKey = (item: PlanItem): string =>
    `${dpaNameKey(item.name)}|${item.dpaPurchaseTime ?? item.timeLabel ?? ""}`;
  const storedPurchaseKeys = new Set(
    entries
      .filter(
        (e) =>
          e.item.kind === "purchase" &&
          e.item.passType != null &&
          /プレミアアクセス|DPA/i.test(e.item.passType),
      )
      .map((e) => instanceKey(e.item)),
  );
  entries.forEach((e, i) => {
    const isDpaE =
      e.item.passType != null && /プレミアアクセス|DPA/i.test(e.item.passType);
    if (!isDpaE) return;
    if (e.item.kind === "purchase") {
      const t = toMin(e.item.dpaPurchaseTime ?? e.item.timeLabel);
      const list = eventsAt.get(i) ?? [];
      list.push({ item: e.item, ownIdx: i, time: t ?? Number.MAX_SAFE_INTEGER });
      eventsAt.set(i, list);
      return;
    }
    if (!e.item.dpaPurchaseTime) return;
    if (storedPurchaseKeys.has(instanceKey(e.item))) return;
    const t = toMin(e.item.dpaPurchaseTime);
    let at = i;
    if (t != null) {
      for (let j = 0; j < entries.length; j++) {
        const it = toMin(entries[j]?.item.timeLabel ?? null);
        if (it != null && it > t) {
          at = Math.min(j, i);
          break;
        }
      }
    }
    const list = eventsAt.get(at) ?? [];
    list.push({ item: e.item, ownIdx: i, time: t ?? Number.MAX_SAFE_INTEGER });
    eventsAt.set(at, list);
  });
  for (const list of eventsAt.values()) {
    list.sort((a, b) => a.time - b.time || a.ownIdx - b.ownIdx);
  }
  // The 「買えなかったら？」 reschedule works on the pass's usage
  // row (its purchase time and use time drive the rebuild); a
  // stored purchase-event row resolves to its usage row when one
  // exists in this plan.
  const cantBuyTarget = (item: PlanItem): PlanItem => {
    if (item.kind !== "purchase") return item;
    const usage = entries.find(
      (e) => e.item.kind !== "purchase" && instanceKey(e.item) === instanceKey(item),
    );
    return usage?.item ?? item;
  };
  // Tight legs （無理ポイント）, judged at render time from the
  // stored leg data: approximate walking distance ≥ 300 m AND
  // schedule slack ≤ 5 min (see tightLegTargets in plan_metrics).
  // Display-only — the caution row is not a plan item: it is never
  // counted, never pinned, and never reaches the verification gate.
  const tightTargets = tightLegTargets(entries.map((e) => e.item));
  return (
    <ol className="mt-3 space-y-2">
      {entries.map((e, i) => {
        // DPA (ディズニー・プレミアアクセス) rows get a solid accent badge so
        // paid-pass stops read at a glance; other passes get a quiet chip.
        const isDpa =
          e.item.passType != null &&
          /プレミアアクセス|DPA/i.test(e.item.passType);
        // Travel time into this row, computed by the server from the
        // two facilities' coordinates and the walking speed (never
        // estimated by the generation AI). Shown as a divider above
        // the row it leads into; a 移動 (move) row carries it as a
        // chip instead, since the row itself IS the movement. Null
        // (unverified leg / first row / older plan sets) shows
        // nothing — no invented number is ever displayed.
        const showTravel =
          i > 0 &&
          e.item.travelMin != null &&
          e.item.kind !== "move" &&
          e.item.kind !== "purchase" &&
          e.item.kind !== "first10";
        // A stored purchase-event row renders ONLY as its purchase
        // event card (above) — never as a schedule stop of its own.
        const isPurchaseRow = e.item.kind === "purchase";
        // The 「最初の10分」 block (kind "first10") is display-only
        // content: a heading, the first tasks as a bullet list, and
        // the fixed guidance line. Its note carries the parts one
        // per line — bullets start with 「・」, the guidance is the
        // remaining line(s). A bullet of the form 「◯◯の抽選をする」
        // is a lottery row: when this plan contains that show, it
        // carries the 「抽選に外れたら？」 button (the day-of
        // reschedule entry, same pattern as 「買えなかったら？」).
        const isFirst10 = e.item.kind === "first10";
        const first10Lines = isFirst10
          ? (e.item.note ?? "")
              .split(/\n+/)
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const first10Bullets = first10Lines
          .filter((l) => l.startsWith("・"))
          .map((l) => l.replace(/^・\s*/, ""));
        const first10Rest = first10Lines.filter(
          (l) => !l.startsWith("・"),
        );
        const lotteryShowFor = (text: string): PlanItem | null => {
          const m = /^(.+)の抽選をする$/.exec(text);
          if (!m || !m[1]) return null;
          const key = dpaNameKey(m[1]);
          const found = entries.find(
            (x) =>
              x.item.kind === "show" && dpaNameKey(x.item.name) === key,
          );
          return found?.item ?? null;
        };
        return (
        <Fragment key={e.item.id}>
        {(eventsAt.get(i) ?? []).map((pe) => {
          const price =
            pe.item.unitPriceJpy ??
            dpaPrices?.get(dpaNameKey(pe.item.name)) ??
            null;
          return (
          <li
            key={`purchase-${pe.item.id}`}
            className="flex gap-3 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-3 py-2.5"
          >
            <div className="flex w-[52px] shrink-0 flex-col items-start">
              <span className="text-base font-bold leading-tight tabular-nums">
                {pe.item.dpaPurchaseTime ?? pe.item.timeLabel}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-snug">
                🛒 DPA購入：{pe.item.name}
                {price != null ? ` ${price.toLocaleString("ja-JP")}円` : ""}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
                購入は1回に1枚だけ。買えなかったら、その後の予定の組み直しが必要になる分岐点です。
              </p>
              <UnconfirmedMark item={pe.item} />
              {onCantBuy ? (
                <button
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onCantBuy(cantBuyTarget(pe.item));
                  }}
                  className="mt-2 rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-bold text-white"
                >
                  買えなかったら？
                </button>
              ) : null}
            </div>
          </li>
          );
        })}
        {tightTargets.has(i) ? (
          <li className="rounded-[var(--radius)] border border-amber-400 bg-amber-100 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
            <p>{TIGHT_LEG_CAUTION_TEXT}</p>
          </li>
        ) : null}
        {showTravel ? (
          <li aria-hidden className="flex justify-center py-0.5">
            <span className="rounded-full bg-[var(--surface-alt)] px-3 py-1 text-xs font-semibold text-[var(--dim)]">
              移動 約{e.item.travelMin}分
            </span>
          </li>
        ) : null}
        {isFirst10 ? (
        <li
          key={e.item.id}
          className="rounded-[var(--radius)] border-2 bg-[var(--surface)] px-3 py-2.5"
          style={{ borderColor: KIND_COLORS.first10 }}
        >
          <div className="flex gap-3">
            <div className="flex w-[52px] shrink-0 flex-col items-start">
              <span className="text-base font-bold leading-tight tabular-nums">
                {e.item.timeLabel ?? ""}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-display text-base font-bold leading-snug">
                {e.item.name}
              </p>
              {first10Bullets.length > 0 ? (
                <ul className="mt-1.5 list-disc space-y-1.5 pl-5">
                  {first10Bullets.map((b, bi) => {
                    const show = lotteryShowFor(b);
                    return (
                      <li key={bi} className="text-sm leading-relaxed">
                        {b}
                        {show && onLotteryLost ? (
                          <span className="mt-1 block">
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onLotteryLost(show);
                              }}
                              className="rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-bold text-white"
                            >
                              抽選に外れたら？
                            </button>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {first10Rest.map((line, liIdx) => (
                <p
                  key={liIdx}
                  className="mt-2 text-sm leading-relaxed text-[var(--dim)]"
                >
                  {line}
                </p>
              ))}
            </div>
          </div>
        </li>
        ) : !isPurchaseRow ? (
        <li
          key={e.item.id}
          ref={
            rowRefs
              ? (el) => {
                  rowRefs.current[i] = el;
                }
              : undefined
          }
          onClick={() => onRowTap?.(i)}
          className={`flex gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5${
            e.item.lat != null && e.item.lng != null ? " cursor-pointer" : ""
          }`}
        >
          {/* Transit-guide layout: the time leads the row, large and
              first. The route pin number sits before the title (below). */}
          <div className="flex w-[52px] shrink-0 flex-col items-start">
            <span className="text-base font-bold leading-tight tabular-nums">
              {e.item.timeLabel ?? ""}
            </span>
            <span
              aria-hidden
              className="mt-2 h-2.5 w-2.5 rounded-full"
              style={{ background: e.color }}
            />
          </div>
          {e.item.imageUrl ? (
            <div className="flex w-14 shrink-0 flex-col items-center self-start">
              {/* Square thumbnail, guaranteed by three independent
                  mechanisms: the h-14/w-14 utilities, an explicit
                  aspect-ratio, and the width/height attributes. The
                  stored photos are landscape originals (860×400), so
                  if the height utility alone ever loses the cascade
                  (e.g. to the preflight img{height:auto} on some
                  phone browsers) the image renders wide — the aspect
                  ratio keeps the box 1:1 regardless. */}
              <img
                src={e.item.imageUrl}
                alt={`${e.item.name}の写真`}
                loading="lazy"
                width={56}
                height={56}
                className="aspect-square h-14 w-14 rounded-lg object-cover"
              />
              {e.item.imageSource === "reference" ? (
                <span className="mt-0.5 text-[10px] leading-none text-[var(--dim)]">
                  参考画像
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="flex items-start gap-1.5 text-base font-semibold leading-snug">
              {showPinNumbers && e.item.lat != null && e.item.lng != null ? (
                <span
                  aria-hidden
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: e.color }}
                >
                  {entries.slice(0, i + 1).filter((x) => x.item.lat != null && x.item.lng != null).length}
                </span>
              ) : null}
              <span className="min-w-0">{e.item.name}</span>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--dim)]">
              <span
                className="rounded-full px-2 py-0.5 font-semibold text-white"
                style={{ background: KIND_COLORS[e.item.kind] }}
              >
                {KIND_LABELS[e.item.kind]}
              </span>
              {e.item.area ? <span>{e.item.area}</span> : null}
              {e.item.kind === "move" && e.item.travelMin != null ? (
                <span className="font-semibold text-[var(--text)]">
                  移動 約{e.item.travelMin}分
                </span>
              ) : null}
            </p>
            {e.item.passType ? (
              <p className="mt-1.5 flex flex-wrap items-center gap-2">
                {isDpa ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] py-1 pl-1.5 pr-2.5 text-xs font-bold text-white">
                    <span className="rounded-full bg-white px-1.5 py-0.5 text-[11px] font-bold leading-none text-[var(--accent)]">
                      DPA
                    </span>
                    {e.item.passType}
                  </span>
                ) : (
                  <span className="inline-block rounded-full bg-[var(--surface-alt)] px-2.5 py-1 text-xs font-semibold text-[var(--dim)]">
                    {e.item.passType}
                  </span>
                )}
                {isDpa && e.item.dpaPurchaseTime ? (
                  <span className="text-xs font-semibold text-[var(--dim)]">
                    購入 {e.item.dpaPurchaseTime}
                  </span>
                ) : null}
              </p>
            ) : null}
            <UnconfirmedMark item={e.item} />
            <RestaurantInfo item={e.item} />
            {e.item.note ? (
              <p className="mt-1 text-sm leading-relaxed">{e.item.note}</p>
            ) : null}
            {e.item.officialUrl ? (
              <p className="mt-1.5">
                <a
                  href={e.item.officialUrl}
                  target="_blank"
                  rel="noopener"
                  onClick={(ev) => ev.stopPropagation()}
                  aria-label={`${e.item.name}の公式ページを開く`}
                  className="text-sm font-semibold text-[var(--accent)] underline underline-offset-2"
                >
                  公式ページ
                </a>
              </p>
            ) : null}
          </div>
          {/* The estimated wait is the single most important number on
              the row: it sits at the right end, large, as row data —
              never buried in the note text. Shown for 0 minutes too. */}
          {e.item.kind !== "restaurant" && e.item.estWaitMin != null ? (
            <div className="flex w-[68px] shrink-0 flex-col items-end justify-start pt-0.5 text-right">
              <span className="text-[11px] font-semibold leading-none text-[var(--dim)]">
                推定待ち
              </span>
              <span
                className={`mt-1 text-3xl font-bold leading-none tabular-nums${
                  e.item.estWaitMin >= 60 ? " text-[var(--accent)]" : ""
                }`}
              >
                {e.item.estWaitMin}
                <span className="text-base font-bold">分</span>
              </span>
            </div>
          ) : null}
        </li>
        ) : null}
        </Fragment>
        );
      })}
    </ol>
  );
}

// Split the generation notes into readable bullet points. Notes from newer
// generations are already one point per line; older ones are a single wall
// of text, so long lines fall back to splitting on sentence-ending 。.
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

function NotesList({
  notes,
  restaurantWaitNote,
}: {
  notes: string;
  // The premise note for a plan containing restaurant rows (that
  // restaurant waits are not modelled), carried as text in the
  // getState payload — derived server-side at read time from the
  // plan's rows, like the restaurant classification display —
  // never written into the stored notes. Null when the displayed
  // plan has no restaurant rows.
  restaurantWaitNote?: string | null;
}) {
  const points = splitNotes(notes);
  if (restaurantWaitNote) {
    points.push(restaurantWaitNote);
  }
  if (points.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="text-sm font-semibold">このプランの前提・注意点</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5 text-sm leading-relaxed">
        {points.map((pt, i) => (
          <li key={i}>{pt}</li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------- plan progress

type PlanProgress = PlanSet["planProgress"]["A" | "B" | "C"];

const PROGRESS_LABELS: Record<PlanProgress, string> = {
  waiting: "待機",
  generating: "作成中",
  done: "完了",
  failed: "失敗",
};

// Per-plan progress rows （プランA：作成中／プランB：待機／プランC：待機）.
// Progress is tracked per plan, not per set: 完了 is shown only for a
// plan that has actually been saved, and a plan still being worked on
// never hides the ones already finished.
function PlanProgressList({ planSet }: { planSet: PlanSet }) {
  // A 当日検索 set has exactly one plan by design: its progress list
  // shows plan A only, never B/C rows that will never exist.
  const slots = (
    planSet.setType === "same_day" ? ["A"] : ["A", "B", "C"]
  ) as ("A" | "B" | "C")[];
  return (
    <ul className="mx-auto mt-5 max-w-xs space-y-2 text-left">
      {slots.map((slot) => {
        const st = planSet.planProgress[slot];
        return (
          <li
            key={slot}
            className="flex items-center justify-between rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <span
                aria-hidden
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ background: PLAN_COLORS[slot] }}
              />
              プラン{slot}
            </span>
            <span
              className={`flex items-center gap-1.5 text-sm font-bold ${
                st === "generating"
                  ? "text-[var(--accent)]"
                  : st === "failed"
                    ? "text-red-700 dark:text-red-300"
                    : "text-[var(--dim)]"
              }`}
            >
              {st === "generating" ? (
                <span aria-hidden className="flex items-end gap-0.5">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
              ) : null}
              {PROGRESS_LABELS[st]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------------------------------- generation escape

// The stuck-generation safeguard (owner's design, 2026-11-17): under
// every progress display — and only while a generation or a partial
// operation is in flight — the elapsed time since the run started,
// the fixed note below, and リトライ / キャンセル buttons. The clock
// counts from the start timestamp the SERVER recorded for the run
// (the set's generation start, or the partial operation's start),
// so reloading the page never resets it; the one-second tick only
// re-renders the difference. Both buttons call server actions that
// never involve the possibly-dead generation task itself.
const GENERATION_ESCAPE_NOTE =
  "通常は遅くても20分以内で作成されます。遅すぎる場合はMuseが固まってる可能性があります。その場合、キャンセルかリトライボタンを押してください。";

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}時間${m}分${s}秒` : `${m}分${s}秒`;
}

function GenerationEscapeBlock({
  planSetId,
  startedAt,
  centered = false,
}: {
  planSetId: number;
  startedAt: string | null;
  centered?: boolean;
}) {
  const queryClient = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const retryMutation = useMutation({
    mutationFn: async () => await api.retryGeneration({ planSetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const cancelMutation = useMutation({
    mutationFn: async () => await api.cancelGeneration({ planSetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const busy = retryMutation.isPending || cancelMutation.isPending;
  const error =
    retryMutation.data && !retryMutation.data.ok
      ? retryMutation.data.error
      : cancelMutation.data && !cancelMutation.data.ok
        ? cancelMutation.data.error
        : retryMutation.isError || cancelMutation.isError
          ? "操作できませんでした。少し待ってもう一度お試しください。"
          : null;
  const startMs = startedAt ? new Date(startedAt).getTime() : null;
  return (
    <div
      className={
        centered
          ? "mx-auto mt-6 max-w-md space-y-2.5 text-left"
          : "mt-3 space-y-2.5 text-left"
      }
    >
      {startMs != null && !Number.isNaN(startMs) ? (
        <p className="text-sm font-semibold">
          経過時間：{formatElapsed(now - startMs)}
        </p>
      ) : null}
      <p className="text-sm leading-relaxed text-[var(--dim)]">
        {GENERATION_ESCAPE_NOTE}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => retryMutation.mutate()}
          disabled={busy}
          className="rounded-full bg-[var(--accent)] px-5 py-1.5 text-sm font-bold text-[var(--accent-text)] disabled:opacity-50"
        >
          リトライ
        </button>
        <button
          type="button"
          onClick={() => cancelMutation.mutate()}
          disabled={busy}
          className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 py-1.5 text-sm font-bold text-red-700 disabled:opacity-50 dark:text-red-300"
        >
          キャンセル
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// A failed plan set's リトライ button: the set stands at 失敗
// (never stuck at 作成中 — that is the state the task manager
// leaves when a generation's attempts ran out) and
// retryGeneration re-runs the whole generation on the SAME set
// from its recorded start inputs. Shown on the failed set's own
// tab, the failure surface for plan creation / same-day search.
function FailedSetRetryBlock({ planSetId }: { planSetId: number }) {
  const queryClient = useQueryClient();
  const retryMutation = useMutation({
    mutationFn: async () => await api.retryGeneration({ planSetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const error =
    retryMutation.data && !retryMutation.data.ok
      ? retryMutation.data.error
      : retryMutation.isError
        ? "操作できませんでした。少し待ってもう一度お試しください。"
        : null;
  return (
    <div className="mt-4 space-y-2.5">
      <button
        type="button"
        onClick={() => retryMutation.mutate()}
        disabled={retryMutation.isPending}
        className="rounded-full bg-[var(--accent)] px-5 py-1.5 text-sm font-bold text-[var(--accent-text)] disabled:opacity-50"
      >
        リトライ
      </button>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// A partial operation （部分差し替え / 当日リスケ） the task
// manager ended after exhausting its attempts: the slot stands
// at 失敗 with its request still recorded and the original plan
// untouched. リトライ re-runs the recorded request on the same
// slot; キャンセル stands the slot back down to the original.
function PartialOpFailedBlock({ planSetId }: { planSetId: number }) {
  const queryClient = useQueryClient();
  const retryMutation = useMutation({
    mutationFn: async () => await api.retryGeneration({ planSetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const cancelMutation = useMutation({
    mutationFn: async () => await api.cancelGeneration({ planSetId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const busy = retryMutation.isPending || cancelMutation.isPending;
  const error =
    retryMutation.data && !retryMutation.data.ok
      ? retryMutation.data.error
      : cancelMutation.data && !cancelMutation.data.ok
        ? cancelMutation.data.error
        : retryMutation.isError || cancelMutation.isError
          ? "操作できませんでした。少し待ってもう一度お試しください。"
          : null;
  return (
    <div className="mt-2.5 space-y-2.5">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => retryMutation.mutate()}
          disabled={busy}
          className="rounded-full bg-[var(--accent)] px-5 py-1.5 text-sm font-bold text-[var(--accent-text)] disabled:opacity-50"
        >
          リトライ
        </button>
        <button
          type="button"
          onClick={() => cancelMutation.mutate()}
          disabled={busy}
          className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-5 py-1.5 text-sm font-bold text-red-700 disabled:opacity-50 dark:text-red-300"
        >
          キャンセル
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-sm font-semibold text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------- set conditions

// Short crowd-scenario words for the A/B/C switcher pills, in the
// owner's own shorthand （条件 A劇混み B混雑 C楽）: the scenario each
// plan was built under, readable at a glance in the strip itself.
const SCENARIO_SHORT_LABELS: Record<string, string> = {
  severe: "劇混み",
  expected: "混雑",
  light: "楽",
};
// The deterministic slot→scenario mapping of a standard set (server
// derives it from the slot and the set's forecast at save time).
const SLOT_SCENARIOS: Record<SubTab, string> = {
  A: "severe",
  B: "expected",
  C: "light",
};

const WALKING_SPEED_DISPLAY: Record<Conditions["walkingSpeed"], string> = {
  slow: "ゆっくり",
  slightly_slow: "少しゆっくり",
  slightly_fast: "少し急いで",
  fast: "急いで",
};

function formatVisitDateLabel(v: string | null): string {
  if (!v) return "未定";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

// The value handed to an <input type="time">: the control accepts
// ONLY the zero-padded "HH:MM" form — an unpadded "9:00" (the
// app's text convention, which older stored conditions and
// snapshot round-trips can still carry) is invalid there and the
// field renders blank even though a value exists. The server
// normalizes conditions to the padded form at its boundaries;
// this is the client-side guard so no path can blank the field
// again. Anything that is not an H:MM time passes through as-is.
function toTimeInputValue(v: string | null | undefined): string {
  if (!v) return "";
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return v;
  return `${String(Number(m[1])).padStart(2, "0")}:${m[2]}`;
}

// Bounded time-of-day select. A native <input type="time"> offers
// all 24 hours, so nonsense like a 0:00 park entry was selectable.
// The parks' day runs roughly 9:00–22:00, so the forms offer only
// a plausible window in 15-minute steps (callers pass the window).
// A stored value outside the offered window is kept as its own
// option, so an existing value never renders blank or is silently
// replaced — it stays visible and can be changed away from.
function TimeSelect({
  id,
  value,
  onChange,
  className,
  startMin,
  endMin,
  extraOptions = [],
}: {
  id: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  className: string;
  // Minutes from midnight for the first / last offered time.
  startMin: number;
  endMin: number;
  // Additional offered times outside the stepped window.
  extraOptions?: string[];
}) {
  const v = toTimeInputValue(value);
  const stepped: string[] = [];
  for (let m = startMin; m <= endMin; m += 15) {
    stepped.push(
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`,
    );
  }
  const merged = [...extraOptions, ...stepped];
  const options =
    v && !merged.includes(v) ? [...merged, v].sort() : merged;
  return (
    <select
      id={id}
      className={className}
      value={v}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">未定</option>
      {options.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

function CondRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-24 shrink-0 text-[var(--dim)]">{label}</dt>
      <dd className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

// The 「条件」 panel: the search conditions THIS plan set was
// generated under, parsed server-side from the set's own stored
// conditions snapshot — never the live プラン作成 form, which may
// have been edited since. The conditions are shared by A/B/C, so
// the panel belongs to the set, not to a plan. A field the snapshot
// could not give back (conditionsMissing) renders as 読み取れません
// でした rather than the parser's neutral fallback value. At the
// panel's bottom sits 「条件を変えて再検索」: it hands these very
// conditions back to the プラン作成 tab (the standard form, or the
// 当日検索 section for a same-day set) so they can be tweaked and
// searched again — the panel is a view of the set's conditions,
// the button is the way back into the form with them.
function SetConditionsPanel({
  planSet,
  onResearch,
  researching,
  researchError,
}: {
  planSet: PlanSet;
  onResearch: () => void;
  researching: boolean;
  researchError: string | null;
}) {
  const c = planSet.conditions;
  const missing = new Set(planSet.conditionsMissing);
  const unreadable = (label: string): ReactNode =>
    missing.has(label) ? (
      <span className="text-[var(--dim)]">読み取れませんでした</span>
    ) : null;
  return (
    <div className="mx-4 mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
      <p className="text-sm font-bold">このプランの検索条件</p>
      {c == null ? (
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--dim)]">
          このプランには検索条件が保存されていません。
        </p>
      ) : (
        <dl className="mt-1 text-sm leading-relaxed">
          <CondRow label="パーク">
            {unreadable("パーク") ??
              (c.park === "land"
                ? "東京ディズニーランド"
                : "東京ディズニーシー")}
          </CondRow>
          <CondRow label="日付">
            {unreadable("日付") ?? formatVisitDateLabel(c.visitDate)}
          </CondRow>
          {planSet.setType === "same_day" && planSet.sameDay ? (
            <>
              <CondRow label="現在地">{planSet.sameDay.location}</CondRow>
              <CondRow label="開始時刻">
                {planSet.sameDay.startTime}から閉園まで
              </CondRow>
              <CondRow label="人数">
                {unreadable("人数") ??
                  `大人${c.adults}人・子ども${c.children}人`}
              </CondRow>
              <CondRow label="予算（上限）">
                {unreadable("予算") ??
                  (c.budgetJpy != null
                    ? `${c.budgetJpy.toLocaleString("ja-JP")}円`
                    : "未定")}
              </CondRow>
              <CondRow label="ご要望">
                <span className="whitespace-pre-line">
                  {c.priority ?? "（入力なし）"}
                </span>
              </CondRow>
            </>
          ) : (
            <>
              <CondRow label="入園〜退園">
                {unreadable("入園〜退園時刻") ??
                  `${c.entryTime ?? "未定"} 〜 ${c.exitTime ?? "未定"}`}
              </CondRow>
              <CondRow label="予算">
                {unreadable("予算") ??
                  (c.budgetJpy != null
                    ? `${c.budgetJpy.toLocaleString("ja-JP")}円`
                    : "未定")}
              </CondRow>
              <CondRow label="人数">
                {unreadable("人数") ??
                  `大人${c.adults}人・子ども${c.children}人${
                    c.childrenAges ? `（${c.childrenAges}）` : ""
                  }`}
              </CondRow>
              <CondRow label="重視する点">
                {unreadable("重視する点") ?? (
                  <span className="whitespace-pre-line">
                    {c.priority ?? "未入力"}
                  </span>
                )}
              </CondRow>
            </>
          )}
          <CondRow label="歩く速さ">
            {unreadable("歩く速さ") ?? WALKING_SPEED_DISPLAY[c.walkingSpeed]}
          </CondRow>
        </dl>
      )}
      {c != null ? (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            disabled={researching}
            onClick={onResearch}
            className="w-full rounded-full bg-[var(--accent)] px-5 py-2.5 font-display text-base font-bold text-[var(--accent-text)] disabled:opacity-50"
          >
            {researching ? "移動しています…" : "条件を変えて再検索"}
          </button>
          <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
            {planSet.setType === "same_day"
              ? "この条件をプラン作成タブの「当日検索」に入力して移動します。条件を変えて、もう一度検索できます。"
              : "この条件をプラン作成タブのフォームに入力して移動します。条件を変えてから「この条件で3プランを作成」を押すと、新しいプランが作られます。"}
          </p>
          {researchError ? (
            <p
              role="alert"
              className="mt-1.5 text-sm font-semibold text-red-700 dark:text-red-300"
            >
              {researchError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- plan tab

function PlanSetView({
  planSet,
  rebuiltFromTitle,
  selectedSlot,
  onSelectSlot,
  onResearch,
}: {
  planSet: PlanSet;
  // Title of the original set this one was rebuilt from; null for a
  // first-time plan. A rebuild never overwrites its original, so the
  // plan view states that relationship instead of letting the new tab
  // look like the old one silently replaced (or unchanged).
  rebuiltFromTitle?: string | null;
  // The selected A/B/C slot lives in the App shell (per plan set), so
  // a message sent from the bottom form can report which plan the
  // user is looking at in this tab.
  selectedSlot: SubTab;
  onSelectSlot: (slot: SubTab) => void;
  // 「条件を変えて再検索」 (bottom of the 条件 panel): the App shell
  // switches to the プラン作成 tab. For a standard set the set's
  // conditions have already been written into the saved form by the
  // mutation below (prefill is null); for a same-day set the inputs
  // travel as a prefill for the form's 当日検索 section instead.
  onResearch: (prefill: SameDayPrefill | null) => void;
}) {
  const sub = selectedSlot;
  const [detailTab, setDetailTab] = useState<"schedule" | "about" | "crowd">(
    "schedule",
  );
  // A set without a crowd forecast has no 混雑予想 detail tab; if
  // that tab was left selected (e.g. after switching sets), fall
  // back to the schedule so the detail region never renders blank.
  const activeDetailTab =
    detailTab === "crowd" && planSet.crowdLevel == null
      ? "schedule"
      : detailTab;
  // The strip is ONE exclusive tab group — 条件 / A / B / C: exactly
  // one is selected at a time. Selecting 条件 shows this set's own
  // search conditions INSTEAD of everything below the strip (the
  // fixed map and the scrolling detail region are not rendered at
  // all, so the map's fixed height cannot break the layout);
  // selecting a plan switches back to the map + detail arrangement.
  const [showConditions, setShowConditions] = useState(false);
  // 地図表示 off, as reported by PlanMap's toggle: the map cell below
  // collapses to just the toggle button's height so the detail region
  // takes over the freed space.
  const [mapOff, setMapOff] = useState(false);
  const handleMapVisibilityChange = useCallback((visible: boolean) => {
    setMapOff(!visible);
  }, []);
  const queryClient = useQueryClient();
  const imageMutation = useMutation({
    mutationFn: () => api.requestItemImages({ planSetId: planSet.id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  // 「条件を変えて再検索」: a standard set's conditions are written
  // into the saved conditions form (saveConditions) so the プラン
  // 作成 tab opens with exactly them entered; the navigation itself
  // happens in the App shell via onResearch once the save lands. A
  // same-day set's inputs （現在地点・指定時刻・ご要望） have no place
  // in the standard form, so they travel as a prefill for the 当日
  // 検索 section instead and the saved form is left untouched.
  const researchMutation = useMutation({
    mutationFn: (c: Conditions) => api.saveConditions(c),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      onResearch(null);
    },
  });
  const researchError = researchMutation.isError
    ? "条件をプラン作成タブへ移せませんでした。少し待ってもう一度お試しください。"
    : null;
  const handleResearch = () => {
    const c = planSet.conditions;
    if (!c) return;
    if (planSet.setType === "same_day" && planSet.sameDay) {
      onResearch({
        park: c.park,
        location: planSet.sameDay.location,
        startTime: planSet.sameDay.startTime,
        adults: c.adults,
        children: c.children,
        childrenAges: c.childrenAges ?? "",
        budgetJpy: c.budgetJpy,
        walkingSpeed: c.walkingSpeed,
        request: planSet.sameDay.request ?? "",
      });
    } else {
      researchMutation.mutate(c);
    }
  };
  // Timeline row elements in the scrolling detail region, shared with the
  // fixed map so pin selection can highlight/scroll to the matching row.
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  // Desktop drag/wheel sideways scrolling for the A/B/C sub-tab strip
  // (same treatment as the main tab bar). The PDF button is a sibling
  // OUTSIDE this strip, so it stays pinned at the right end.
  const subTabBarRef = useDragScroll<HTMLDivElement>();
  // Handle to the mounted map so a schedule-row tap can highlight its
  // pin and smoothly pan the live map to it.
  const mapControllerRef = useRef<MapController | null>(null);
  // PDF export state: the PDF button sits at the right end of
  // the A/B/C sub-tab strip, while its working/error state renders in
  // the banner row under the strip — one hook holds both halves.
  const pdf = usePlanPdf(planSet);
  // 「買えなかったら？」 (a DPA purchase event could not be bought):
  // the tapped purchase event's item, the user's free-text situation
  // report, and the start mutation. Nothing starts from the button
  // itself — the dialog always confirms first, and the reschedule
  // starts only from the dialog's 「作り直す」.
  const [cantBuyItem, setCantBuyItem] = useState<PlanItem | null>(null);
  const [cantBuyNote, setCantBuyNote] = useState("");
  const cantBuyMutation = useMutation({
    mutationFn: async (args: { slot: SubTab; item: PlanItem; note: string }) =>
      await api.requestDpaReschedule({
        planSetId: planSet.id,
        slot: args.slot,
        itemId: args.item.id,
        userNote: args.note,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setCantBuyItem(null);
        setCantBuyNote("");
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const cantBuyError =
    cantBuyMutation.data && !cantBuyMutation.data.ok
      ? cantBuyMutation.data.error
      : cantBuyMutation.isError
        ? "リスケジュールを開始できませんでした。少し待ってもう一度お試しください。"
        : null;
  // 「抽選に外れたら？」 (a show's entry lottery was lost): the same
  // day-of report pattern as 「買えなかったら？」 — the show row the
  // tapped lottery item names, the user's free-text situation
  // report, and the start mutation. Nothing starts from the button
  // itself — the dialog always confirms first, and the reschedule
  // starts only from the dialog's 「作り直す」.
  const [lotteryItem, setLotteryItem] = useState<PlanItem | null>(null);
  const [lotteryNote, setLotteryNote] = useState("");
  const lotteryMutation = useMutation({
    mutationFn: async (args: { slot: SubTab; item: PlanItem; note: string }) =>
      await api.requestLotteryReschedule({
        planSetId: planSet.id,
        slot: args.slot,
        itemId: args.item.id,
        userNote: args.note,
      }),
    onSuccess: (res) => {
      if (res.ok) {
        setLotteryItem(null);
        setLotteryNote("");
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const lotteryError =
    lotteryMutation.data && !lotteryMutation.data.ok
      ? lotteryMutation.data.error
      : lotteryMutation.isError
        ? "リスケジュールを開始できませんでした。少し待ってもう一度お試しください。"
        : null;
  // 「他のAIで2重検証」: the button at the end of the displayed plan
  // fetches that plan's verification package from the server (saved
  // data only) and opens a dialog holding the full text. Copying
  // uses the standard Clipboard API; the package text is ALWAYS
  // also shown in a read-only, selectable textarea in the dialog,
  // so when the clipboard write fails in a WebView the user can
  // still copy it by hand. No verification runs in this app — the
  // pasted-into AI does the checking.
  const [verifyText, setVerifyText] = useState<string | null>(null);
  const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const verifyMutation = useMutation({
    mutationFn: async (slot: SubTab) =>
      await api.getVerificationPackage({ planSetId: planSet.id, slot }),
    onSuccess: (res) => {
      setVerifyText(res.text);
      setCopyState("idle");
      setVerifyDialogOpen(true);
    },
  });
  const verifyError = verifyMutation.isError
    ? "検証用データを取得できませんでした。少し待ってもう一度お試しください。"
    : null;
  const handleCopyPackage = async () => {
    if (!verifyText) return;
    try {
      if (
        typeof navigator === "undefined" ||
        typeof navigator.clipboard?.writeText !== "function"
      ) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(verifyText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };
  // Official DPA unit prices for the purchase-event rows, keyed by
  // normalized facility name, from this set's verification record
  // (the list the server extracted mechanically from the official
  // Premier Access page at creation time).
  const dpaPrices = new Map<string, number>(
    (planSet.verification?.dpaExtracted ?? []).map((d) => [
      dpaNameKey(d.name),
      d.priceJpy,
    ]),
  );

  // Plans already saved stay viewable even while the set as a whole is
  // still generating (or failed partway): only a set with NO saved plan
  // yet gets the full-screen progress / failure view below.
  const hasSavedPlans = planSet.plans.length > 0;

  if (planSet.status === "generating" && !hasSavedPlans) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="font-display text-lg font-bold">
          {planSet.setType === "same_day"
            ? "当日検索のプランを作成中です…"
            : planSet.rebuiltFromSetId != null
              ? "作り直し版を作成中です…"
              : "プランを作成中です…"}
        </p>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--dim)]">
          {planSet.setType === "same_day"
            ? `公式サイトで本日の営業時間・休止情報・ショーの時刻を確認し、現在の掲示待ち時間をもとに、${planSet.sameDay ? `「${planSet.sameDay.location}」を${planSet.sameDay.startTime}に出発して` : ""}閉園までのプランを1つ作っています。作成には10〜20分ほどかかることがあります。このタブを開いたままでも、他のタブに移っても大丈夫です。`
            : "公式サイトで対象日の営業時間・休止情報・ショーの時刻と、現在のパス制度を確認してから、混雑シナリオの違う3プランを1つずつ作っています。作成には10〜20分ほどかかることがあります。このタブを開いたままでも、他のタブに移っても大丈夫です。"}
        </p>
        <PlanProgressList planSet={planSet} />
        {planSet.rebuiltFromSetId != null ? (
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-[var(--dim)]">
            既存のプランをもとに新しいプランを作っています。元のプランはそのまま残ります。
          </p>
        ) : null}
        <GenerationEscapeBlock
          planSetId={planSet.id}
          startedAt={planSet.generationStartedAt}
          centered
        />
      </div>
    );
  }

  if (planSet.status === "failed" && !hasSavedPlans) {
    return (
      <div className="px-4 py-10">
        <p className="font-display text-lg font-bold">
          {planSet.setType === "same_day"
            ? "当日検索のプランを作れませんでした"
            : planSet.rebuiltFromSetId != null
              ? "作り直しはできませんでした"
              : "プランを作れませんでした"}
        </p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          {planSet.error ?? "公式情報を取得できませんでした。"}
        </p>
        {planSet.rebuiltFromSetId != null ? (
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            元のプランはそのまま残っています。
          </p>
        ) : null}
        <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
          {planSet.setType === "same_day"
            ? "現在地点や指定時刻を変えて、プラン作成タブの「当日検索」からもう一度お試しください。"
            : "条件を変えて、プラン作成タブの「この条件で3プランを作成」からもう一度お試しください。"}
        </p>
        <FailedSetRetryBlock planSetId={planSet.id} />
      </div>
    );
  }

  const visiblePlans = planSet.plans.filter((p) => p.slot === sub);
  const entries = visiblePlans.flatMap((p) =>
    p.items.map((item) => ({ item, color: PLAN_COLORS[p.slot] })),
  );

  // Tapping a schedule row moves the map to that row's place: the pin
  // is highlighted via the handle, and the LIVE map pans to the place
  // with an animated easeTo that changes only the centre — the current
  // zoom is kept exactly as the user left it, and the map is not
  // remounted. Rows without coordinates have no pin to centre on.
  const handleRowTap = (entryIdx: number) => {
    const entry = entries[entryIdx];
    if (!entry || entry.item.lat == null || entry.item.lng == null) {
      return;
    }
    const pinnedIdx = entries
      .slice(0, entryIdx + 1)
      .filter((x) => x.item.lat != null && x.item.lng != null).length - 1;
    try {
      mapControllerRef.current?.selectPlace?.(pinnedIdx);
    } catch {
      /* selection is best-effort */
    }
    const target = { lat: entry.item.lat, lng: entry.item.lng };
    let panned = false;
    try {
      panned = mapControllerRef.current?.panTo?.(target) ?? false;
    } catch {
      panned = false;
    }
    if (!panned) {
      // The map may still be initialising (its camera is not ready);
      // retry the same pan once shortly after.
      window.setTimeout(() => {
        try {
          mapControllerRef.current?.panTo?.(target);
        } catch {
          /* pan is best-effort */
        }
      }, 350);
    }
  };

  // Intro photos belong to facilities, and one fetch covers the whole set
  // (all three plans share facilities), so this looks at every plan.
  const isFacilityItem = (it: PlanItem) =>
    it.kind === "attraction" ||
    it.kind === "show" ||
    it.kind === "parade" ||
    it.kind === "restaurant";
  const missingImages = planSet.plans.some((p) =>
    p.items.some((it) => !it.imageUrl && isFacilityItem(it)),
  );
  // The same fetch task also confirms each facility's official
  // detail-page link, so the fetch control covers missing links too
  // (plan sets generated before links existed backfill this way).
  const missingLinks = planSet.plans.some((p) =>
    p.items.some((it) => !it.officialUrl && isFacilityItem(it)),
  );
  const needsFetch = missingImages || missingLinks;
  const imageError =
    imageMutation.data && !imageMutation.data.ok
      ? imageMutation.data.error
      : imageMutation.isError
        ? "紹介画像の取得を開始できませんでした。少し待ってもう一度お試しください。"
        : null;

  return (
    <div
      className={`grid min-h-0 min-w-0 flex-1 grid-cols-1 ${
        showConditions
          ? "grid-rows-[auto_minmax(0,1fr)]"
          : "grid-rows-[auto_auto_auto_minmax(0,1fr)] lg:grid-cols-2 lg:grid-rows-[auto_auto_minmax(0,1fr)]"
      }`}
    >
      {/* Fixed top region: the sub-tab switcher stays put, with the map
          fixed below it; everything else lives in the detail region
          further down, which is the only part that scrolls. At desktop
          widths (lg and up) the same four regions become a two-pane
          split instead: switcher, banners and detail stack in the left
          column, and the map fills the right column at full height so
          it stays visible while the detail region scrolls. While
          「条件」 is selected the grid collapses to the switcher plus
          one scrolling row holding the conditions panel alone — the
          map and the detail region are not rendered, so the map's
          fixed height cannot break this layout. */}
      <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 px-4 pt-3">
      <div
        ref={subTabBarRef}
        role="tablist"
        aria-label="プラン切替"
        className="flex min-w-0 flex-1 cursor-grab gap-1.5 overflow-x-auto pb-1"
      >
        {/* The strip's left end is the set's own search conditions
            （条件 A劇混み B混雑 C楽 … PDF): the conditions belong to
            the whole set, not to one plan, and the strip is ONE
            exclusive tab group — selecting 「条件」 replaces the
            map and everything below it with the conditions view,
            and selecting a plan switches back. */}
        <button
          type="button"
          role="tab"
          aria-selected={showConditions}
          aria-label="このプランの検索条件を表示"
          onClick={() => setShowConditions(true)}
          className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${
            showConditions
              ? "bg-[var(--text)] text-[var(--bg)]"
              : "bg-[var(--surface-alt)] text-[var(--text)]"
          }`}
        >
          条件
        </button>
        {/* A 当日検索 set holds exactly one plan: only the プランA
            switcher shows, next to a 当日検索 chip that says what
            this tab is. */}
        {(planSet.setType === "same_day"
          ? (["A"] as SubTab[])
          : (["A", "B", "C"] as SubTab[])
        ).map((s) => {
          // The pill names the plan by its crowd scenario in the
          // owner's shorthand （A 劇混み / B 混雑 / C 楽） whenever the
          // scenario is known — from the saved plan itself, or, while
          // plans are still being generated, from the set's forecast
          // via the deterministic slot mapping. Sets with no scenario
          // (older sets) keep the plain プランA/B/C names.
          const savedPlan = planSet.plans.find((p) => p.slot === s);
          const scenario =
            savedPlan?.crowdScenario ??
            (planSet.setType === "standard" && planSet.crowdLevel != null
              ? SLOT_SCENARIOS[s]
              : null);
          const short =
            scenario != null ? SCENARIO_SHORT_LABELS[scenario] : undefined;
          return (
          <button
            key={s}
            role="tab"
            aria-selected={!showConditions && sub === s}
            onClick={() => {
              setShowConditions(false);
              onSelectSlot(s);
            }}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${
              !showConditions && sub === s
                ? "bg-[var(--text)] text-[var(--bg)]"
                : "bg-[var(--surface-alt)] text-[var(--text)]"
            }`}
          >
            {short ? `${s} ${short}` : `プラン${s}`}
            {planSet.planProgress[s] !== "done" ? (
              <span className="ml-1.5 text-xs font-semibold opacity-80">
                {PROGRESS_LABELS[planSet.planProgress[s]]}
              </span>
            ) : null}
          </button>
          );
        })}
        {planSet.setType === "same_day" ? (
          <span className="flex shrink-0 items-center rounded-full bg-[var(--accent)] px-3 py-1.5 text-sm font-bold text-[var(--accent-text)]">
            当日検索
          </span>
        ) : null}
      </div>

      {/* The PDF button lives at the right end of this strip, beside
          the A/B/C tabs it belongs to — always on screen, no hunting
          through the detail tabs. Finished sets only. */}
      {planSet.status === "done" ? <PdfButtons pdf={pdf} /> : null}
      </div>

      {/* Second grid row. In plan view it carries the status banners
          (generating / failed), collapsing to zero height when none
          shows. In 条件 view this row is the whole content area: it
          scrolls, and holds the set's search-conditions panel (plus
          the PDF block, whose button stays in the strip) — the map
          and the detail region below are not rendered at all. */}
      <div
        className={`col-start-1 row-start-2 min-w-0 ${
          showConditions
            ? "min-h-0 overflow-x-hidden overflow-y-auto pb-6"
            : ""
        }`}
      >
      {showConditions ? (
        <>
          <SetConditionsPanel
            planSet={planSet}
            onResearch={handleResearch}
            researching={researchMutation.isPending}
            researchError={researchError}
          />
          {planSet.status === "done" ? <PdfExtras pdf={pdf} /> : null}
        </>
      ) : (
        <>
      {planSet.status === "generating" ? (
        <div className="mx-4 mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
          <p className="text-sm font-semibold">
            {planSet.setType === "same_day"
              ? "当日検索のプランを作成中です（作成には10〜20分ほどかかることがあります）"
              : "残りのプランを作成中です（作成には10〜20分ほどかかることがあります）"}
          </p>
          {planSet.setType !== "same_day" ? (
            <p className="mt-1 text-sm text-[var(--dim)]">
              {(["A", "B", "C"] as const)
                .map((s) => `プラン${s}：${PROGRESS_LABELS[planSet.planProgress[s]]}`)
                .join("／")}
            </p>
          ) : null}
          <GenerationEscapeBlock
            planSetId={planSet.id}
            startedAt={planSet.generationStartedAt}
          />
        </div>
      ) : null}
      {planSet.status === "failed" ? (
        <div
          role="alert"
          className="mx-4 mt-3 shrink-0 rounded-[var(--radius)] bg-red-100 px-3.5 py-2.5 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          作成は完了しませんでした{planSet.error ? `（${planSet.error}）` : ""}。保存できたプランだけを表示しています。
          <FailedSetRetryBlock planSetId={planSet.id} />
        </div>
      ) : null}
      {planSet.status === "done" &&
      (["A", "B", "C"] as const).some((s) => planSet.partialOpFailures[s]) ? (
        <div
          role="alert"
          className="mx-4 mt-3 shrink-0 rounded-[var(--radius)] bg-red-100 px-3.5 py-2.5 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {(["A", "B", "C"] as const)
            .filter((s) => planSet.partialOpFailures[s])
            .map((s) => (
              <p key={s}>
                プラン{s}の差し替えはできませんでした。{planSet.partialOpFailures[s]}
                元のプラン{s}はそのまま残っています。
              </p>
            ))}
          <PartialOpFailedBlock planSetId={planSet.id} />
        </div>
      ) : null}
      {planSet.status === "done" &&
      (["A", "B", "C"] as const).some(
        (s) => planSet.planProgress[s] === "generating",
      ) ? (
        <div className="mx-4 mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-2.5">
          <p className="text-sm font-semibold">
            {(["A", "B", "C"] as const)
              .filter((s) => planSet.planProgress[s] === "generating")
              .map((s) => `プラン${s}`)
              .join("・")}
            を差し替え中です
          </p>
          <p className="mt-1 text-sm text-[var(--dim)]">
            表示されている内容は差し替え前のものです。他のプランはそのまま残ります。
          </p>
          <GenerationEscapeBlock
            planSetId={planSet.id}
            startedAt={
              planSet.partialOpStarts[
                (["A", "B", "C"] as const).find(
                  (s) => planSet.planProgress[s] === "generating",
                ) ?? "A"
              ]
            }
          />
        </div>
      ) : null}
      {/* The PDF progress / completion block also lives in this row,
          directly under the A/B/C strip and above the map: the user
          presses 「PDF」 in the strip, so the result of that press has
          to appear where their eyes already are. It used to render
          inside the scrolling detail region below the map, where in
          practice it was never seen — the only visible change was a
          control appearing in the strip, which read as "nothing
          changed". */}
      {planSet.status === "done" ? <PdfExtras pdf={pdf} /> : null}
        </>
      )}
      </div>

      {/* Map. On phones it is fixed at roughly the top 32% of the screen
          height, below the switcher; at desktop widths it becomes the
          right pane and fills the full height of the split. Not
          rendered at all while 「条件」 is selected. While 地図表示 is
          OFF the cell collapses to the height of the on/off toggle
          button alone (PlanMap renders nothing else then), so the
          detail region below takes over the map's space — on desktop
          the cell likewise stops spanning the right column. */}
      {!showConditions ? (
      <div
        className={
          mapOff
            ? "col-start-1 row-start-3 mt-2 min-w-0 px-4 lg:col-start-2 lg:row-start-1 lg:mt-0 lg:min-h-0 lg:px-0 lg:py-3"
            : "col-start-1 row-start-3 mt-3 h-[32dvh] min-w-0 px-4 lg:col-start-2 lg:row-start-1 lg:row-span-3 lg:mt-0 lg:h-auto lg:min-h-0 lg:px-0 lg:py-3"
        }
      >
        {visiblePlans.length === 0 ? (
          <p className="flex h-full items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border)] px-3 py-2 text-center text-sm text-[var(--dim)]">
            プラン{sub}は{PROGRESS_LABELS[planSet.planProgress[sub]]}です。完了したプランは上のボタンから切り替えて見られます。
          </p>
        ) : planSet.status === "generating" ? (
          // While the set is still generating, the map is NOT mounted
          // at all (owner report, 2026-11-18: a half-finished map was
          // on screen during creation and flickered). The pins are
          // still changing underneath — each plan save used to
          // remount the whole map (the mount key covered every plan's
          // items, and each remount replays the map layer's engine
          // cascade) — so the cell holds a quiet placeholder and the
          // map appears exactly once, when creation is finished. The
          // saved plans' lists below stay readable in the meantime.
          <p className="flex h-full items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--border)] px-3 py-2 text-center text-sm text-[var(--dim)]">
            プランを作成中です。地図は、作成が終わってから表示されます。
          </p>
        ) : (
        <PlanMap
          entries={entries}
          mapKey={`${planSet.id}-${sub}-${entries
            .map(
              (e) =>
                `${e.item.id}:${e.item.lat ?? "-"},${e.item.lng ?? "-"}`,
            )
            .join("|")}`}
          pinColor={PLAN_COLORS[sub]}
          rowRefs={rowRefs}
          controllerRef={mapControllerRef}
          onVisibilityChange={handleMapVisibilityChange}
        />
        )}
      </div>
      ) : null}

      {/* Scrolling detail region, directly below the map: the summary
          heading (PlanCostHeader) at the head of the plan, then the
          detail tabs under it, in this order — スケジュール (the
          timeline list), プランの説明 (park hours, per-plan
          summaries, the generation notes as bullets, and the
          official sources), and 混雑予想 (the set's crowd forecast
          level and its basis; the tab itself is absent on sets that
          carry no forecast). Not rendered at all while 「条件」 is
          selected. */}
      {!showConditions ? (
      <div className="col-start-1 row-start-4 mt-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-4 pb-6 [overflow-wrap:anywhere] lg:row-start-3">
      {/* When this plan was made, and when it was last verified
          against official data — a plan quietly going stale is the
          failure this app exists to prevent, so both dates stay
          visible on the set itself. */}
      <p className="mt-3 text-xs text-[var(--dim)]">
        作成 {formatMonthDayJst(planSet.createdAt)}／最終検証{" "}
        {planSet.lastVerifiedAt
          ? formatMonthDayJst(planSet.lastVerifiedAt)
          : "―"}
        {planSet.verificationRunning ? (
          <span className="ml-2 font-semibold text-[var(--accent)]">
            一括検証を実行中です…
          </span>
        ) : null}
      </p>
      {planSet.rebuiltFromSetId != null ? (
        <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-2.5 text-sm leading-relaxed">
          <span className="font-semibold">作り直し版</span>
          <span className="text-[var(--dim)]">
            ：{rebuiltFromTitle ? `既存のプラン「${rebuiltFromTitle}」をもとに作り直した版です。` : "既存のプランをもとに作り直した版です。"}
            元のプランもそのまま残っています。
          </span>
        </p>
      ) : null}
      {planSet.setType === "same_day" && planSet.sameDay ? (
        <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-2.5 text-sm leading-relaxed">
          <span className="font-semibold">当日検索</span>
          <span className="text-[var(--dim)]">
            ：現在地点「{planSet.sameDay.location}」を{planSet.sameDay.startTime}
            に出発し、閉園までのプランです。現在の掲示待ち時間をもとに作られています。
            {planSet.sameDay.request
              ? `ご要望：${planSet.sameDay.request}`
              : ""}
          </span>
        </p>
      ) : null}
      {visiblePlans.length === 0 ? (
        <div className="py-10 text-center">
          <p className="font-display text-base font-bold">
            プラン{sub}：{PROGRESS_LABELS[planSet.planProgress[sub]]}
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--dim)]">
            {planSet.planProgress[sub] === "generating"
              ? "このプランを作成しています。終わると、ここにスケジュールが表示されます。"
              : planSet.planProgress[sub] === "waiting"
                ? "まだ作成が始まっていません。プランはA・B・Cの順に1つずつ作っています。完了したプランは上のボタンから見られます。"
                : "このプランは作成できませんでした。完了したプランは上のボタンから見られます。"}
          </p>
          {planSet.status === "generating" ? (
            <PlanProgressList planSet={planSet} />
          ) : null}
        </div>
      ) : (
      <>
      {visiblePlans.map((p) => (
        <PlanCostHeader
          key={p.id}
          plan={p}
          priorities={planSet.priorities ?? null}
        />
      ))}

      <div
        role="tablist"
        aria-label="詳細切替"
        className="mt-3 flex gap-1.5 border-b border-[var(--border)]"
      >
        {(
          [
            { key: "schedule", label: "スケジュール" },
            { key: "about", label: "プランの説明" },
            // The crowd forecast is one of the detail tabs under the
            // summary heading, its level visible in the tab label.
            // Sets without a forecast (older sets) get no such tab.
            ...(planSet.crowdLevel != null
              ? [
                  {
                    key: "crowd",
                    label: `混雑予想 ${planSet.crowdLevel}/5`,
                  },
                ]
              : []),
          ] as { key: "schedule" | "about" | "crowd"; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={activeDetailTab === t.key}
            onClick={() => setDetailTab(t.key)}
            className={`-mb-px border-b-2 px-3 pb-2 pt-1 text-sm font-semibold ${
              activeDetailTab === t.key
                ? "border-[var(--accent)] text-[var(--text)]"
                : "border-transparent text-[var(--dim)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Both panels stay mounted (hidden toggle) so the timeline rows keep
          their refs and pin↔row sync with the fixed map survives tab flips. */}
      <div className={activeDetailTab === "schedule" ? undefined : "hidden"}>
        {planSet.imagesStatus === "fetching" ? (
          <div className="mt-3">
            <p className="text-sm text-[var(--dim)]">
              公式サイトから各スポットの紹介画像と公式ページへのリンクを取得しています…（取得には少し時間がかかることがあります）
            </p>
            <p className="mt-1 text-xs text-[var(--dim)]">
              10分以上終わらない場合は、取得が止まっているとみなして、もう一度取得できるボタンが自動で戻ります。
            </p>
          </div>
        ) : needsFetch ? (
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => imageMutation.mutate()}
                disabled={imageMutation.isPending}
                className="rounded-full bg-[var(--surface-alt)] px-4 py-2 text-sm font-semibold disabled:opacity-50"
              >
                {imageMutation.isPending
                  ? "開始しています…"
                  : missingImages
                    ? "各スポットの紹介画像を取得"
                    : "各スポットの公式リンクを取得"}
              </button>
              <span className="text-xs text-[var(--dim)]">
                公式サイトの写真を優先し、取れないスポットには参考画像を表示します。各行には公式ページへのリンクも付きます
              </span>
            </div>
            {planSet.imagesStatus === "failed" ? (
              <p className="mt-2 text-xs text-[var(--dim)]">
                前回の取得はうまくいきませんでした。もう一度お試しください。
              </p>
            ) : null}
            {imageError ? (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
              >
                {imageError}
              </p>
            ) : null}
          </div>
        ) : null}
        <RowList
          entries={entries}
          rowRefs={rowRefs}
          showPinNumbers
          onRowTap={handleRowTap}
          dpaPrices={dpaPrices}
          onCantBuy={
            planSet.status === "done" && planSet.planProgress[sub] === "done"
              ? (item) => {
                  cantBuyMutation.reset();
                  setCantBuyNote("");
                  setCantBuyItem(item);
                }
              : undefined
          }
          onLotteryLost={
            planSet.status === "done" && planSet.planProgress[sub] === "done"
              ? (item) => {
                  lotteryMutation.reset();
                  setLotteryNote("");
                  setLotteryItem(item);
                }
              : undefined
          }
        />
      </div>
      {activeDetailTab === "about" ? (
        <div>
          {visiblePlans.map((p) =>
            p.summary ? (
              <p key={p.id} className="mt-3 text-sm leading-relaxed">
                {p.summary}
              </p>
            ) : null,
          )}

          {planSet.parkHours ? (
            <p className="mt-3 text-sm">
              <span className="font-semibold">営業時間（公式）</span>
              <span className="text-[var(--dim)]">: {planSet.parkHours}</span>
            </p>
          ) : null}

          {planSet.generationMetrics ? (
            <div className="mt-3 text-sm leading-relaxed">
              <p>
                <span className="font-semibold">作成の記録</span>
                {planSet.generationMetrics.pagesOpened != null ? (
                  <span className="text-[var(--dim)]">
                    ： 参照したページ {planSet.generationMetrics.pagesOpened}件
                  </span>
                ) : null}
              </p>
              {planSet.generationMetrics.phases.length > 0 ? (
                <ul className="mt-1 space-y-0.5 text-[var(--dim)]">
                  {planSet.generationMetrics.phases.map((ph, i) => (
                    <li key={i}>
                      ・{ph.name}：{formatPhaseSeconds(ph.seconds)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {planSet.verification ? (
            <div className="mt-3 text-sm leading-relaxed">
              <p>
                <span className="font-semibold">検証の記録</span>
                {planSet.verification.checkedAt ? (
                  <span className="text-[var(--dim)]">
                    ： {planSet.verification.checkedAt}に取得した公式データで照合
                  </span>
                ) : null}
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5">
                {planSet.verification.checks.map((c, i) => (
                  <li key={i}>
                    <span className="font-semibold">{c.label}</span>
                    <span className="text-[var(--dim)]">：{c.result}</span>
                    {c.sourceUrl ? (
                      <>
                        {" "}
                        <a
                          href={c.sourceUrl}
                          target="_blank"
                          rel="noopener"
                          className="text-[var(--accent)] underline underline-offset-2"
                        >
                          {c.sourceTitle ?? "公式ページ"}
                        </a>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {planSet.verification.crowdFactors.length > 0 ? (
                <CrowdFactorsRecord
                  factors={planSet.verification.crowdFactors}
                />
              ) : null}
              {planSet.verification.dpaFacts.length > 0 ? (
                <div className="mt-1.5">
                  <p className="text-[var(--dim)]">
                    判定に使ったDPAファクト（公式情報を正規化したもの）
                    {planSet.verification.factSummary ? (
                      <span>
                        ：母集合{planSet.verification.factSummary.universeCount}
                        施設（対象{planSet.verification.factSummary.eligibleCount}
                        ／対象外
                        {planSet.verification.factSummary.notEligibleCount}
                        ／不明{planSet.verification.factSummary.unknownCount}）
                        {planSet.verification.factSummary.complete
                          ? "・全施設にファクトあり"
                          : "・不完全なビルド"}
                      </span>
                    ) : null}
                  </p>
                  <ul className="mt-1 space-y-1.5">
                    {planSet.verification.dpaFacts
                      .filter((f) => f.status === "eligible")
                      .map((f, i) => (
                        <li key={i}>
                          <span className="font-semibold">{f.name}</span>
                          <span className="text-[var(--dim)]">
                            {" "}
                            {f.priceJpy != null
                              ? `${f.priceJpy.toLocaleString("ja-JP")}円`
                              : ""}
                            {dpaPeriodSuffix(f)}
                          </span>
                          {f.snapshotUrl ? (
                            <span className="text-[var(--dim)]">
                              {" "}
                              （根拠：
                              <a
                                href={f.snapshotUrl}
                                target="_blank"
                                rel="noopener"
                                className="text-[var(--accent)] underline underline-offset-2"
                              >
                                {f.snapshotKind ?? "公式ページ"}
                              </a>
                              {f.snapshotFetchedAt
                                ? ` ${f.snapshotFetchedAt.slice(0, 10)}取得`
                                : ""}
                              ）
                            </span>
                          ) : null}
                          {f.evidence ? (
                            <span className="block text-xs text-[var(--dim)]">
                              根拠の抜粋：「{f.evidence}」
                            </span>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                  {planSet.verification.dpaFacts.some(
                    (f) => f.status === "unknown",
                  ) ? (
                    <ul className="mt-1 space-y-0.5 text-[var(--dim)]">
                      {planSet.verification.dpaFacts
                        .filter((f) => f.status === "unknown")
                        .map((f, i) => (
                          <li key={i}>
                            不明：{f.name}
                            {f.unknownReason ? `（${f.unknownReason}）` : ""}
                          </li>
                        ))}
                    </ul>
                  ) : null}
                  {planSet.verification.dpaFacts.some(
                    (f) => f.status === "not_eligible",
                  ) ? (
                    <p className="mt-1 text-[var(--dim)]">
                      対象外：
                      {planSet.verification.dpaFacts
                        .filter((f) => f.status === "not_eligible")
                        .map((f) => f.name)
                        .join("、")}
                    </p>
                  ) : null}
                </div>
              ) : planSet.verification.dpaExtracted.length > 0 ? (
                <p className="mt-1.5 text-[var(--dim)]">
                  スナップショットから抽出したDPA対象：
                  {planSet.verification.dpaExtracted
                    .map(
                      (d) =>
                        `${d.name} ${d.priceJpy.toLocaleString("ja-JP")}円${dpaPeriodSuffix(d)}`,
                    )
                    .join("、")}
                </p>
              ) : null}
              {planSet.verification.unverified.length > 0 ? (
                <div className="mt-2 rounded-lg bg-amber-100 px-3 py-2 dark:bg-amber-950">
                  <p className="font-semibold text-amber-900 dark:text-amber-100">
                    未確認の項目があります
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-100">
                    {planSet.verification.unverified.map((u, i) => (
                      <li key={i}>{u}</li>
                    ))}
                  </ul>
                  {hasSpecSuspectUnverified(planSet.verification.unverified) ? (
                    <div className="text-amber-900 dark:text-amber-100">
                      <SpecRepairNote />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {planSet.reverifications.length > 0 ? (
            <div className="mt-3 text-sm leading-relaxed">
              <p>
                <span className="font-semibold">再検証の履歴</span>
                <span className="text-[var(--dim)]">
                  ：作成後に公式情報を取り直して照合した記録です（プランの内容は変更していません）
                </span>
              </p>
              <ul className="mt-1.5 space-y-2">
                {planSet.reverifications.map((r, i) => (
                  <li key={i}>
                    <p>
                      <span className="font-semibold">
                        {formatMonthDayJst(r.checkedAt)}の再検証
                      </span>
                      <span className="text-[var(--dim)]">
                        ：
                        {r.problems.length > 0
                          ? `差分・問題 ${r.problems.length}件`
                          : "差分なし（現在の公式情報でも有効）"}
                        {r.unverified.length > 0
                          ? `／未確認 ${r.unverified.length}件`
                          : ""}
                      </span>
                    </p>
                    {r.factSummary ? (
                      <p className="text-[var(--dim)]">
                        判定に使ったファクト
                        {r.factBuildId != null ? `（ビルド #${r.factBuildId}）` : ""}
                        ：母集合{r.factSummary.universeCount}施設（対象
                        {r.factSummary.eligibleCount}／対象外
                        {r.factSummary.notEligibleCount}／不明
                        {r.factSummary.unknownCount}）
                      </p>
                    ) : null}
                    {r.problems.length > 0 ? (
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[var(--dim)]">
                        {r.problems.map((p, j) => (
                          <li key={j}>{p}</li>
                        ))}
                      </ul>
                    ) : null}
                    {r.unverified.length > 0 ? (
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-[var(--dim)]">
                        {r.unverified.map((u, j) => (
                          <li key={j}>未確認：{u}</li>
                        ))}
                      </ul>
                    ) : null}
                    {r.problems.length > 0 ||
                    hasSpecSuspectUnverified(r.unverified) ? (
                      <SpecRepairNote />
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {planSet.notes ||
          visiblePlans.some((p) => p.restaurantWaitNote) ? (
            <NotesList
              notes={planSet.notes ?? ""}
              restaurantWaitNote={
                visiblePlans.find((p) => p.restaurantWaitNote)
                  ?.restaurantWaitNote ?? null
              }
            />
          ) : null}

          {planSet.sources.length > 0 ? (
            <div className="mt-6 border-t border-[var(--border)] pt-3">
              <p className="text-xs font-semibold text-[var(--dim)]">
                作成時に確認した公式ページ
              </p>
              <ul className="mt-1.5 space-y-1">
                {planSet.sources.map((s) => (
                  <li key={s.url} className="text-sm">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener"
                      className="text-[var(--accent)] underline underline-offset-2"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {planSet.estimateSources.length > 0 ? (
            <div className="mt-4 border-t border-[var(--border)] pt-3">
              <p className="text-xs font-semibold text-[var(--dim)]">
                待ち時間の推定に使った材料（参考サイト）
              </p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
                公式情報ではありません。待ち時間の読みの材料として作成時に参照した、実績集計サイトです。
              </p>
              <ul className="mt-1.5 space-y-1">
                {planSet.estimateSources.map((s) => (
                  <li key={s.url} className="text-sm">
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noopener"
                      className="text-[var(--accent)] underline underline-offset-2"
                    >
                      {s.title}
                    </a>
                    {s.fetchedAt ? (
                      <span className="text-[var(--dim)]">
                        （取得日：{s.fetchedAt}）
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {activeDetailTab === "crowd" && planSet.crowdLevel != null ? (
        <div>
          {/* The set's crowd forecast: the level as a 5-step scale,
              then the basis the forecast was judged on — both are
              the set's stored premise (plan_sets.crowd_level /
              crowd_basis), shown as saved, never re-derived here. */}
          <div className="mt-4 flex items-end gap-3">
            <p className="font-display text-3xl font-bold leading-none">
              {planSet.crowdLevel}
              <span className="ml-1 text-base font-semibold text-[var(--dim)]">
                / 5
              </span>
            </p>
            <div
              className="flex flex-1 gap-1 pb-1"
              role="img"
              aria-label={`混雑予想は5段階中${planSet.crowdLevel}`}
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={`h-2.5 flex-1 rounded-full ${
                    n <= (planSet.crowdLevel ?? 0)
                      ? "bg-[var(--accent)]"
                      : "bg-[var(--surface-alt)]"
                  }`}
                />
              ))}
            </div>
          </div>
          <p className="mt-2 text-sm text-[var(--dim)]">
            5に近いほど混雑が予想される日です。
          </p>
          {planSet.crowdBasis ? (
            <div className="mt-4 text-sm leading-relaxed">
              <p className="font-semibold">根拠</p>
              <p className="mt-1 whitespace-pre-wrap">{planSet.crowdBasis}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      </>
      )}

      {/* Fixed closing line of every plan display (owner's design,
          2026-11-17): the visible form of the core contract — if
          something bothers you, say so in the AI chat below and it
          can be fixed. Display layer ONLY: a fixed literal rendered
          here deterministically, never stored in plan data, never
          part of the PDF payload or the verification package (the
          PDF's reader has no AI at hand). Sits at the very end of
          the displayed plan, directly before the 2重検証 button,
          under the same condition as that button.
          Owner's follow-up decision (2026-11-17): rendered as a
          prominent call-out banner, NOT a small footnote — most
          first-time readers don't yet know the plan can be
          customized by asking the AI, so the point of this block is
          that they NOTICE it can be fixed. Larger type than the
          body, accent border and tinted background set it apart
          from the surrounding notes. */}
      {planSet.status === "done" && visiblePlans.length > 0 ? (
        <div
          role="note"
          aria-label="プランの直し方の案内"
          className="mt-6 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_10%,var(--surface))] px-4 py-4 sm:px-5"
        >
          <p className="font-display text-lg font-bold leading-relaxed sm:text-xl">
            気になるところがあれば、下のAIチャットで気軽に教えてください。待ち時間を減らしたり、順番を変えたり、作り直したりできます。
          </p>
        </div>
      ) : null}

      {/* 「他のAIで2重検証」: at the very end of the displayed plan,
          below whichever detail tab is open. Finished sets only —
          the package is assembled from the saved plan. */}
      {planSet.status === "done" && visiblePlans.length > 0 ? (
        <div className="mt-6 border-t border-[var(--border)] pt-4">
          <button
            onClick={() => verifyMutation.mutate(sub)}
            disabled={verifyMutation.isPending}
            aria-label={`プラン${sub}を他のAIで2重検証するためのデータを開く`}
            className="w-full rounded-full border-2 border-[var(--accent)] px-4 py-2.5 text-base font-bold text-[var(--accent)] disabled:opacity-50"
          >
            {verifyMutation.isPending ? "取得しています…" : "他のAIで2重検証"}
          </button>
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            このプランの条件・前提・スケジュール・費用・参照した情報をまとめた検証用データをコピーして、他のAIに貼り付けて確かめてもらえます。
          </p>
          {verifyError && !verifyDialogOpen ? (
            <p
              role="alert"
              className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
            >
              {verifyError}
            </p>
          ) : null}
        </div>
      ) : null}

      </div>
      ) : null}

      {/* 「抽選に外れたら？」 confirmation: the same pattern as the
          「買えなかったら？」 dialog below — always shown before any
          reschedule starts, the premise (which show's lottery was
          lost, in which plan) attached automatically, the free-text
          field for what happened instead. Cancelling starts
          nothing. */}
      {lotteryItem ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="抽選に外れた場合のリスケジュールの確認"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => {
            if (!lotteryMutation.isPending) setLotteryItem(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-base font-bold">
              プラン{sub}：{lotteryItem.name}
              {lotteryItem.timeLabel
                ? `（公演 ${lotteryItem.timeLabel}）`
                : ""}
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              このショーの抽選に外れた場合の、その後のスケジュールを新しく作りますか？
            </p>
            <label
              className="mt-3 block text-sm font-semibold"
              htmlFor={`lottery-note-${planSet.id}`}
            >
              今の状況を教えてください（任意）
            </label>
            <textarea
              {...FIELDS.requestLotteryReschedule.userNote}
              id={`lottery-note-${planSet.id}`}
              value={lotteryNote}
              onChange={(e) => setLotteryNote(e.target.value)}
              rows={3}
              placeholder="例：代わりにこのショーのDPAを買ったので、それを入れて組み直して／全面的にリスケしてよい"
              className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-relaxed"
            />
            {lotteryError ? (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
              >
                {lotteryError}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() =>
                  lotteryMutation.mutate({
                    slot: sub,
                    item: lotteryItem,
                    note: lotteryNote,
                  })
                }
                disabled={lotteryMutation.isPending}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                {lotteryMutation.isPending ? "開始しています…" : "作り直す"}
              </button>
              <button
                onClick={() => setLotteryItem(null)}
                disabled={lotteryMutation.isPending}
                className="flex-1 rounded-full bg-[var(--surface-alt)] px-4 py-2.5 font-semibold disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 「買えなかったら？」 confirmation: always shown before any
          reschedule starts. The free-text field is the same channel
          as the chat composer, with one difference — the premise
          (which DPA could not be bought, in which plan) is attached
          automatically. Empty is fine: the premise alone then drives
          the reschedule. Cancelling starts nothing. */}
      {cantBuyItem ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="買えなかった場合のリスケジュールの確認"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => {
            if (!cantBuyMutation.isPending) setCantBuyItem(null);
          }}
        >
          <div
            className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-base font-bold">
              プラン{sub}：{cantBuyItem.name}
              {cantBuyItem.dpaPurchaseTime
                ? `（購入 ${cantBuyItem.dpaPurchaseTime}）`
                : ""}
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              このチケットを買えなかった場合の、その後のスケジュールを新しく作りますか？
            </p>
            <label
              className="mt-3 block text-sm font-semibold"
              htmlFor={`cantbuy-note-${planSet.id}`}
            >
              今の状況を教えてください（任意）
            </label>
            <textarea
              {...FIELDS.requestDpaReschedule.userNote}
              id={`cantbuy-note-${planSet.id}`}
              value={cantBuyNote}
              onChange={(e) => setCantBuyNote(e.target.value)}
              rows={3}
              placeholder="例：代わりに〇〇のDPAを買ったので、それを入れて組み直して／全面的にリスケしてよい"
              className="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm leading-relaxed"
            />
            {cantBuyError ? (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
              >
                {cantBuyError}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() =>
                  cantBuyMutation.mutate({
                    slot: sub,
                    item: cantBuyItem,
                    note: cantBuyNote,
                  })
                }
                disabled={cantBuyMutation.isPending}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                {cantBuyMutation.isPending ? "開始しています…" : "作り直す"}
              </button>
              <button
                onClick={() => setCantBuyItem(null)}
                disabled={cantBuyMutation.isPending}
                className="flex-1 rounded-full bg-[var(--surface-alt)] px-4 py-2.5 font-semibold disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 「他のAIで2重検証」 dialog: the fetched package, a copy
          button (Clipboard API), and — always visible — the full
          package in a read-only selectable textarea as the manual
          copy fallback for environments where the clipboard write
          fails. */}
      {verifyDialogOpen && verifyText ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="他のAIで2重検証"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setVerifyDialogOpen(false)}
        >
          <div
            className="flex max-h-[85dvh] w-full max-w-lg flex-col rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-base font-bold">他のAIで2重検証</p>
            <p className="mt-2 text-sm leading-relaxed">
              このプランの検証用データをコピーします。参考にしたサイト、検索条件、スケジュールなどを全てクリップボードにコピーします。そのまま他のAIに貼り付けてください。検証そのものは、貼り付け先のAIが行います。
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleCopyPackage}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-[var(--accent-text)]"
              >
                クリップボードにコピー
              </button>
              <button
                onClick={() => setVerifyDialogOpen(false)}
                className="flex-1 rounded-full bg-[var(--surface-alt)] px-4 py-2.5 font-semibold"
              >
                閉じる
              </button>
            </div>
            {copyState === "copied" ? (
              <p
                role="status"
                className="mt-2 rounded-lg bg-[var(--surface-alt)] px-3 py-2 text-sm font-semibold"
              >
                コピーしました。他のAIに貼り付けてください。
              </p>
            ) : null}
            {copyState === "failed" ? (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
              >
                この環境ではクリップボードへコピーできませんでした。下のテキストエリアの内容を選択して、手動でコピーしてください。
              </p>
            ) : null}
            <label
              className="mt-3 block text-sm font-semibold"
              htmlFor={`verify-package-${planSet.id}`}
            >
              検証用データ（全文）
            </label>
            <textarea
              id={`verify-package-${planSet.id}`}
              readOnly
              value={verifyText}
              rows={12}
              className="mt-1.5 min-h-0 w-full flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-relaxed"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--dim)]">
              コピーがうまくいかない場合は、この欄の内容を手動でコピーできます。
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// PDF export (finished plan sets only). The PDF covers the whole
// set (A/B/C, static maps with numbered pins, cost breakdowns,
// schedules, descriptions, notes, sources) and is rendered inside
// the app from the LOCALLY generated file; no public link is
// created, and the user hands the file over themselves (LINE,
// mail, …). The button sits at the right end of the A/B/C sub-tab
// strip; this hook holds the export state shared by that button
// and the status block in the banner row directly under the strip.
//
// Delivery — the save control follows what the CURRENT shell can
// actually do with a file, because the shells differ (owner
// reports, 2026-11-18: in Chrome the PDF could be created but
// 「保存・共有する」 did nothing at all — desktop Chrome's share
// sheet cannot take files — and the owner ruled that Chrome and
// the desktop Muse app should simply get a download button):
// - Where the share sheet can take files (the phone shells,
//   proven on the owner's phone: `navigator.canShare({files})`
//   answers true), saving is the share sheet fed with the locally
//   generated File (「保存・共有する」 → ファイルに保存 / LINE /
//   メール) — the one route proven to save a real, openable file
//   there. Download anchors stay OFF that shell: the owner
//   reported them doing nothing useful in the phone WebView (the
//   file was handed out to an external app instead of saved).
// - Where the share sheet cannot take files (Chrome, the desktop
//   Muse app), the save control is a plain 「ダウンロード」: a
//   REAL <a download> anchor whose href is an object URL minted
//   from the same local File at generation time. The user taps
//   the anchor itself, inside their own gesture — never a
//   programmatic click fired after an await (that is the shape
//   the phone shell kept turning into a navigation; see below).
// - Viewing: the generated page canvases THEMSELVES
//   (PdfPagesViewer) — the exact pixels the PDF was encoded
//   from. No file fetch, no storage round trip, no PDF parser.
//   They are shown in a full-screen overlay (PdfPreviewOverlay),
//   NOT inline in this banner row: inline, the auto-opened pages
//   grew this grid row by thousands of pixels, which resized and
//   displaced the map's grid area and broke the on-screen map
//   (owner report, 2026-11-18: 「PDFを作成すると、画面に表示され
//   ている地図が崩れる」). The overlay is out of flow, so PDF
//   creation can no longer change the map's layout at all; the
//   map layer additionally re-measures itself whenever its frame
//   changes size (see PlanMap's refreshSize wiring).
// - The file name carries its creation timestamp (to the minute,
//   Asia/Tokyo), and the completion block displays the same
//   timestamp and the file name: the owner can cross-check that
//   the file in hand is the one just made — and a file or screen
//   WITHOUT the timestamp is an older build, which is how a phone
//   still showing a cached page is told apart from a live bug.
// Also removed after repeated on-device failure: the chained
// fallback that attempted a share and, when that failed, fired a
// PROGRAMMATIC click on a temporary download anchor, and every
// real <a download> anchor as well. That click happens outside
// the user's tap gesture, and the shell treated it as a page
// navigation rather than a download — the owner kept landing on
// an authentication page (「copilotに飛ぶ」) even after every
// server-URL control was gone; a genuine download anchor the
// owner tapped themselves likewise did nothing useful in the
// phone WebView (the file was handed out to an external app —
// Copilot, then Chrome — instead of being saved). That history
// is why the download anchor is served ONLY to shells whose
// share sheet cannot take files (Chrome / desktop Muse, where
// the owner explicitly asked for it) and never to the phone
// shell, which keeps the proven share route alone.
// Removed after repeated on-device failure: every control that
// pointed at the server-stored copy's URL (ctx.blobs.getUrl
// returns a RELATIVE ./blobs/… URL). Inside the app that URL
// loads fine (the facility photos prove it), but as a download
// the phone hands it OUT of the app — where the app session does
// not follow — and the owner got, in turn, a black viewer page, a
// bare file name, and an authentication page instead of the PDF;
// the same bytes saved through the share sheet into a notes app
// displayed perfectly, which is what convicts the URL route and
// acquits the file. The savePlanPdf action still exists on the
// server (integrity-checked storage) but the client no longer
// uploads for a download link nothing may point at.
//
// The completion block can be DISMISSED (its × button): an
// earlier build left 「PDFができました」 on screen with no way to
// remove it — reported, accurately, as a section that cannot be
// deleted. Dismissing clears the generated result entirely; the
// PDF button simply generates a fresh copy on the next press.
//
// Placement and auto-open: the completion block renders in the
// banner row directly under the A/B/C strip (above the map), and
// its preview opens by itself when a generation completes — as a
// full-screen overlay above everything (see the delivery note:
// inline in this row, the pages broke the map's layout). An
// earlier build rendered the block inside the scrolling detail
// region below the map; on the owner's phone the only change
// visible where they were looking was a control in the strip
// appearing — reported, accurately, as "nothing changed".
function usePlanPdf(planSet: PlanSet) {
  const [phase, setPhase] = useState<"idle" | "working" | "done" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  // The most recently generated PDF, kept as state until it is
  // dismissed or the next generation replaces it: its page
  // canvases (the in-app display), its local File (the share
  // sheet's payload where that route is served), an object URL
  // minted from the same File at generation time (the download
  // anchor's href where THAT route is served), and its
  // creation-timestamp label and file name (shown in the
  // completion block for cross-checking). The bytes never leave
  // the device except through the save control the user
  // themselves drives — no server copy is made, because every
  // control that ever pointed at the stored copy's URL failed
  // on the owner's phone (see the delivery note above).
  const [result, setResult] = useState<{
    fileName: string;
    file: File;
    createdLabel: string;
    // Object URL for the generated File, minted at generation
    // time so the download anchor is a real link the user taps
    // directly. Revoked when the result is replaced, dismissed
    // or unmounted (the effect below owns the lifecycle).
    downloadUrl: string;
    // The page canvases the PDF was encoded from, displayed
    // directly as the in-app preview.
    pages: HTMLCanvasElement[];
  } | null>(null);

  // Object URL lifecycle: exactly one live URL per result.
  useEffect(() => {
    if (!result) return;
    const url = result.downloadUrl;
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [result]);

  // Which save route this shell gets (see the delivery note):
  // the share sheet only where it can actually take files —
  // canShare with the real File is the honest test, and a shell
  // that throws on the question counts as cannot. Everywhere
  // else the download anchor is served instead.
  const canShareFile = (() => {
    if (!result) return false;
    try {
      return (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [result.file] })
      );
    } catch {
      return false;
    }
  })();

  const onCreate = async () => {
    if (phase === "working") return;
    setPhase("working");
    setError(null);
    try {
      const data = await api.getPlanPdfData({ planSetId: planSet.id });
      const { blob, fileName, createdLabel, pages } =
        await buildPlanPdf(data);
      const file = new File([blob], fileName, {
        type: "application/pdf",
      });
      setResult({
        fileName,
        file,
        createdLabel,
        downloadUrl: URL.createObjectURL(file),
        pages,
      });
      // No programmatic click and no navigation anywhere: the
      // contents appear on screen by themselves (the preview
      // overlay opens automatically), and saving is the user's
      // own tap on the save control — the share sheet where this
      // shell can share files, the download anchor where it
      // cannot.
      setPhase("done");
    } catch {
      setPhase("error");
      setError(
        "PDFを作成できませんでした。少し待ってもう一度お試しください。",
      );
    }
  };

  // Dismiss the completion / error block and drop the generated
  // PDF entirely — the section the owner reported as impossible
  // to remove. The PDF button stays; pressing it generates a
  // fresh copy.
  const dismiss = () => {
    setResult(null);
    setError(null);
    setPhase("idle");
  };

  // Save through the share sheet, from the local File. This
  // handler is only wired to a control where canShareFile says
  // the sheet can take the file; the download shells never reach
  // it (their control is the anchor). A dismissed sheet is not
  // an error. A failed share reports itself; it NEVER falls
  // through to a download click or any other route: a chained
  // programmatic click is the shape the phone shell kept
  // turning into a navigation to an external app or an
  // authentication page.
  const onSaveFile = async () => {
    if (!result) return;
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
      setError(
        "この端末では共有シートを開けませんでした。",
      );
      return;
    }
    try {
      await navigator.share({
        files: [result.file],
        title: result.fileName,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(
        "この端末では共有できませんでした。少し待ってもう一度「保存・共有」をお試しください。",
      );
    }
  };

  return {
    phase,
    error,
    onCreate,
    result,
    canShareFile,
    onSaveFile,
    dismiss,
  };
}

type PlanPdf = ReturnType<typeof usePlanPdf>;

// The strip controls: a compact accent 「PDF」 at the right end of
// the A/B/C sub-tab row (its accessible name says what it does).
// Pressing it generates the PDF; once one exists, the save
// control stays beside it, in the shape this shell can use (see
// the delivery note above usePlanPdf): 「保存・共有」 (the share
// sheet) where the sheet can take files, a 「ダウンロード」
// anchor where it cannot (Chrome / desktop Muse).
function PdfButtons({ pdf }: { pdf: PlanPdf }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 pb-1">
      {pdf.result && pdf.phase !== "working" ? (
        pdf.canShareFile ? (
          <button
            onClick={pdf.onSaveFile}
            aria-label="作成したPDFを保存する"
            className="flex min-h-8 items-center rounded-full border border-[var(--accent)] px-3 py-1.5 text-sm font-bold text-[var(--accent)]"
          >
            保存・共有
          </button>
        ) : (
          <a
            href={pdf.result.downloadUrl}
            download={pdf.result.fileName}
            aria-label="作成したPDFをダウンロードする"
            className="flex min-h-8 items-center rounded-full border border-[var(--accent)] px-3 py-1.5 text-sm font-bold text-[var(--accent)]"
          >
            ダウンロード
          </a>
        )
      ) : null}
      <button
        onClick={pdf.onCreate}
        disabled={pdf.phase === "working"}
        aria-label="PDFを作成する"
        className="rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-bold text-[var(--accent-text)] disabled:opacity-50"
      >
        {pdf.phase === "working" ? "作成中…" : "PDF"}
      </button>
    </div>
  );
}

// The banner-row half of the PDF control (rendered directly under
// the A/B/C strip, above the map — where the user who pressed 「PDF」
// is looking): progress while generating, the error when generation
// fails, and — once a PDF exists — a completion block carrying the
// creation timestamp and file name (cross-checkable against the
// saved file), the save control in this shell's shape
// (「保存・共有する」 share sheet, or the 「ダウンロード」 anchor —
// see the delivery note above usePlanPdf) and a × that dismisses
// the block and discards the generated PDF. The in-app preview
// OPENS BY ITSELF the moment a generation completes: the contents
// are the point of the whole feature, and a preview the user has
// to discover and open by hand is, in practice, a preview that
// does not exist. The preview itself is a full-screen overlay
// (PdfPreviewOverlay), never inline in this row — inline, its
// pages grew the row by thousands of pixels and broke the map
// below (owner report, 2026-11-18). Renders nothing while idle.
function PdfExtras({ pdf }: { pdf: PlanPdf }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  // The result object the preview was auto-opened for, so a manual
  // close is not undone by re-renders — auto-open fires once per
  // generated PDF.
  const [autoOpenedFor, setAutoOpenedFor] = useState<object | null>(null);
  useEffect(() => {
    if (pdf.result && autoOpenedFor !== pdf.result) {
      setAutoOpenedFor(pdf.result);
      setPreviewOpen(true);
    }
  }, [pdf.result, autoOpenedFor]);
  if (pdf.phase === "idle") {
    return null;
  }
  return (
    <div className="mx-4 mt-3">
      {pdf.phase === "working" ? (
        <p className="flex items-center gap-2 text-sm text-[var(--dim)]">
          <span className="flex gap-1" aria-hidden="true">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>
          PDFを作成しています…
        </p>
      ) : null}
      {pdf.phase === "done" && pdf.result ? (
        <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold">PDFができました</p>
            <button
              onClick={pdf.dismiss}
              aria-label="PDFの完了表示を閉じる"
              className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-[var(--border)] text-base leading-none text-[var(--dim)]"
            >
              ×
            </button>
          </div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            作成：{pdf.result.createdLabel}
            <br />
            ファイル名：{pdf.result.fileName}
          </p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            {pdf.canShareFile
              ? "中身はそのまま表示しています。ファイルとして保存・送信するには「保存・共有する」を押してください（保存先を選べます）。保存されたファイルの名前には、上の作成時刻が入っています。"
              : "中身はそのまま表示しています。ファイルとして保存するには「ダウンロード」を押してください。保存されたファイルの名前には、上の作成時刻が入っています。"}
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              onClick={() => setPreviewOpen((v) => !v)}
              aria-expanded={previewOpen}
              className="flex min-h-8 items-center rounded-full border border-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent)]"
            >
              {previewOpen ? "PDFを閉じる" : "PDFを表示する"}
            </button>
            {pdf.canShareFile ? (
              <button
                onClick={pdf.onSaveFile}
                aria-label="作成したPDFを保存する"
                className="flex min-h-8 items-center rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
              >
                保存・共有する
              </button>
            ) : (
              <a
                href={pdf.result.downloadUrl}
                download={pdf.result.fileName}
                aria-label="作成したPDFをダウンロードする"
                className="flex min-h-8 items-center rounded-full bg-[var(--accent)] px-4 py-2 text-sm font-bold text-[var(--accent-text)]"
              >
                ダウンロード
              </a>
            )}
          </div>
          {previewOpen ? (
            <PdfPreviewOverlay
              pages={pdf.result.pages}
              fileName={pdf.result.fileName}
              onClose={() => setPreviewOpen(false)}
            />
          ) : null}
        </div>
      ) : null}
      {pdf.error ? (
        <div
          role="alert"
          className="mt-2 flex items-start justify-between gap-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          <p>{pdf.error}</p>
          <button
            onClick={pdf.dismiss}
            aria-label="エラーの表示を閉じる"
            className="flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-full border border-red-300 text-base leading-none dark:border-red-800"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );
}


// The PDF preview as a full-screen overlay: a fixed layer above
// the whole app with its own header (file name + 閉じる) and its
// own scrolling region holding the page display. It lives OUT of
// the plan grid's flow on purpose — the preview used to render
// inline in the banner row above the map, where the auto-opened
// pages (a dozen-plus full-width canvases) grew that grid row by
// thousands of pixels; the map's grid area was resized and
// displaced with it and the on-screen map broke (owner report,
// 2026-11-18). As an overlay, opening or closing the preview
// changes nothing in the plan layout: the map keeps its exact
// size and position throughout PDF creation. Escape closes it,
// like the 閉じる button.
function PdfPreviewOverlay({
  pages,
  fileName,
  onClose,
}: {
  pages: HTMLCanvasElement[];
  fileName: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="作成したPDFの内容"
      className="fixed inset-0 z-50 flex flex-col bg-[var(--bg)]"
    >
      <div
        className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 pb-3"
        style={{
          paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        }}
      >
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
          {fileName}
        </p>
        <button
          onClick={onClose}
          aria-label="PDFの表示を閉じる"
          className="flex min-h-8 shrink-0 items-center rounded-full border border-[var(--border)] bg-[var(--surface)] px-3.5 py-1.5 text-sm font-bold"
        >
          閉じる
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-8">
        <PdfPagesViewer pages={pages} />
      </div>
    </div>
  );
}

// The in-app PDF display: the generated page canvases themselves,
// appended into a plain container in page order — no fetch, no file
// URL, no PDF parser, so there is no hop left that can turn the
// contents into a black or blank screen. Each canvas keeps its full
// generated resolution and is scaled to the container width by CSS.
// The canvases are re-parented (not copied) on every mount, so
// leaving and returning to the plan tab re-displays the same pages.
function PdfPagesViewer({ pages }: { pages: HTMLCanvasElement[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    pages.forEach((canvas, i) => {
      canvas.style.display = "block";
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      canvas.setAttribute(
        "aria-label",
        `PDF ${i + 1}ページ目（全${pages.length}ページ）`,
      );
      container.appendChild(canvas);
    });
    return () => {
      container.replaceChildren();
    };
  }, [pages]);
  return (
    <div
      ref={containerRef}
      role="img"
      aria-label="作成したPDFの内容"
      className="mt-3 flex flex-col gap-2 overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2"
    />
  );
}

// The verification record's per-facility effective crowd factors.
// Since the scenario split, factors are recorded per plan (the same
// facility can carry a different factor in each plan), so they are
// grouped by plan slot; records saved before the split carry no
// slot and render as one flat list, exactly as they were saved.
function CrowdFactorsRecord({
  factors,
}: {
  factors: { name: string; factor: number; slot: "A" | "B" | "C" | null }[];
}) {
  const slots = (["A", "B", "C"] as const)
    .map((slot) => ({
      slot,
      list: factors.filter((f) => f.slot === slot),
    }))
    .filter((g) => g.list.length > 0);
  const flat = factors.filter((f) => f.slot == null);
  return (
    <div className="mt-1.5">
      <p className="text-[var(--dim)]">
        施設ごとの実効係数（混雑予想にもとづき、待ち時間の基礎推定に掛けた係数）
      </p>
      {slots.map((g) => (
        <div key={g.slot} className="mt-1">
          <p className="text-[var(--dim)]">プラン{g.slot}</p>
          <ul className="mt-0.5 space-y-0.5 text-[var(--dim)]">
            {g.list.map((f, i) => (
              <li key={i}>
                {f.name}：{crowdFactorLabel(f.factor)}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {flat.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-[var(--dim)]">
          {flat.map((f, i) => (
            <li key={i}>
              {f.name}：{crowdFactorLabel(f.factor)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// "12時間" / "6時間30分" style label for the summary's 滞在時間.
function formatStayDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

// One statistic card of the plan-head summary: a small label, one
// large bold number, and optional small sub-lines. `small` is the
// third row's compact variant （ショー／パレード／レストラン）.
function StatCard({
  label,
  value,
  sub,
  small,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg bg-[var(--surface)] px-2.5 py-2.5">
      <p className="text-[11px] font-semibold leading-tight text-[var(--dim)]">
        {label}
      </p>
      <p
        className={`mt-0.5 font-display font-bold leading-tight ${
          small ? "text-lg" : "text-2xl"
        }`}
      >
        {value}
      </p>
      {sub ? (
        <div className="mt-1 space-y-0.5 text-[11px] leading-snug text-[var(--dim)]">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

// The plan-head summary （サマリー見出し）: the executive summary at
// the very head of each plan, directly under its title — the one
// place in this app where the numbers are shown big. Every value
// comes from the server's read-time derivation (plan.summaryStats,
// the same values the PDF prints), so switching A/B/C switches the
// whole summary with the plan. Row order is the owner's design:
// 1) 費用概算／アトラクション／待ち時間合計 (the three that matter
// most), 2) 移動時間合計／歩行距離概算／滞在時間 (how tiring the day
// is), 3) ショー／パレード／レストラン (small), 4) an amber
// 未確認 band, ONLY when the plan actually has unconfirmed rows,
// followed by the under-5 child （ひざ上） explanation band in the
// same amber look, ONLY when the set's party includes a child
// under 5 (plan.lapChildNote, derived server-side at read time).
function PlanSummaryStats({ plan }: { plan: Plan }) {
  const s = plan.summaryStats;
  const yen = (n: number): string => `¥${n.toLocaleString("ja-JP")}`;
  return (
    <div className="mt-3">
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label="費用概算"
          value={
            s.totalCostJpy != null ? (
              <>
                {s.totalCostJpy.toLocaleString("ja-JP")}
                <span className="ml-0.5 text-xs font-semibold">円</span>
              </>
            ) : (
              "―"
            )
          }
          sub={
            <>
              <p>
                うちDPA {yen(s.dpaAmountJpy)}・{s.dpaCount}件
              </p>
              {s.budgetJpy != null ? (
                <p>
                  予算 {yen(s.budgetJpy)}
                  {s.budgetDiffJpy != null
                    ? s.budgetDiffJpy >= 0
                      ? `（残り ${yen(s.budgetDiffJpy)}）`
                      : `（${(-s.budgetDiffJpy).toLocaleString("ja-JP")}円超過）`
                    : ""}
                </p>
              ) : null}
            </>
          }
        />
        <StatCard
          label="アトラクション"
          value={
            <>
              {s.attractionCount}
              <span className="ml-0.5 text-xs font-semibold">件</span>
            </>
          }
          sub={
            <>
              <p>うちDPA {s.attractionDpaCount}件</p>
              {s.attractionDpaRatePct != null ? (
                <p>DPA率 {s.attractionDpaRatePct}%</p>
              ) : null}
            </>
          }
        />
        <StatCard
          label="待ち時間合計"
          value={
            <>
              {s.totalWaitMin}
              <span className="ml-0.5 text-xs font-semibold">分</span>
            </>
          }
          sub={
            s.longestWait ? (
              <p>
                最長：{s.longestWait.name} {s.longestWait.waitMin}分
              </p>
            ) : null
          }
        />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <StatCard
          label="移動時間合計"
          value={
            s.totalTravelMin != null ? (
              <>
                {s.totalTravelMin}
                <span className="ml-0.5 text-xs font-semibold">分</span>
              </>
            ) : (
              "―"
            )
          }
        />
        <StatCard
          label="歩行距離概算"
          value={s.totalWalkM != null ? formatWalkDistance(s.totalWalkM) : "―"}
        />
        <StatCard
          label="滞在時間"
          value={s.stayMinutes != null ? formatStayDuration(s.stayMinutes) : "―"}
          sub={
            s.stayStartLabel && s.stayEndLabel ? (
              <p>
                {s.stayStartLabel}〜{s.stayEndLabel}
              </p>
            ) : null
          }
        />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <StatCard
          small
          label="ショー"
          value={
            <>
              {s.showCount}
              <span className="ml-0.5 text-[11px] font-semibold">件</span>
            </>
          }
        />
        <StatCard
          small
          label="パレード"
          value={
            <>
              {s.paradeCount}
              <span className="ml-0.5 text-[11px] font-semibold">件</span>
            </>
          }
        />
        <StatCard
          small
          label="レストラン"
          value={
            <>
              {s.restaurantCount}
              <span className="ml-0.5 text-[11px] font-semibold">件</span>
            </>
          }
          sub={<p>うちショーレストラン {s.showRestaurantCount}件</p>}
        />
      </div>
      {s.unconfirmed.length > 0 ? (
        <div className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <span className="font-semibold">
            未確認{s.unconfirmed.length}件：
          </span>
          {s.unconfirmed
            .map((u) => `${u.name}（${u.reason}）`)
            .join("、")}
        </div>
      ) : null}
      {plan.lapChildNote ? (
        <div className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-sm leading-relaxed text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <span className="font-semibold">
            {plan.lapChildNote.slice(
              0,
              plan.lapChildNote.indexOf("：") + 1,
            )}
          </span>
          {plan.lapChildNote.slice(plan.lapChildNote.indexOf("：") + 1)}
        </div>
      ) : null}
    </div>
  );
}

// Plan name + cost, shown first under the map: the total, then the
// itemized breakdown lines (チケット / DPA / 食事 / お土産 …) when the
// generation produced them. The prose description lives in the
// プランの説明 detail tab instead. Directly under the title (inside
// this header card) the plan's premise is shown: for sets made
// under the unified conditions model, the single 「重視する点」
// (shared by all three plans) plus THIS plan's crowd scenario
// premise; for older sets, the legacy per-slot priority plus the
// common priority. Both come from the set's stored conditions
// snapshot / plan row — what the user actually entered for THIS
// run, not the current form values. Compact lines only, so the
// schedule rows below are not crowded.
function PlanCostHeader({
  plan,
  priorities,
}: {
  plan: Plan;
  priorities?: PlanSet["priorities"] | null;
}) {
  const scenarioPremise = crowdScenarioPremiseText(plan);
  const unified = priorities?.model === "unified";
  const ownPriority = unified ? null : (priorities?.[plan.slot] ?? null);
  const commonPriority = unified ? null : (priorities?.common ?? null);
  const unifiedPriority = unified ? (priorities?.unified ?? null) : null;
  // Stored plan titles may already carry the 「プランX：」 prefix (the
  // generation sometimes includes it), so strip it before composing
  // the heading — the same treatment the PDF renderer applies —
  // otherwise the heading reads 「プランA：プランA：…」.
  const cleanTitle = plan.title.replace(/^プラン[ABC][:：]\s*/, "");
  return (
    <div className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-3">
      <p className="font-display text-base font-bold">
        <span
          aria-hidden
          className="mr-2 inline-block h-3 w-3 rounded-full align-baseline"
          style={{ background: PLAN_COLORS[plan.slot] }}
        />
        プラン{plan.slot}：{cleanTitle}
      </p>
      {/* The summary headline sits directly under the plan title,
          before the schedule and the cost breakdown. The former
          travel-totals line under the cost section was absorbed
          into it (移動時間合計／歩行距離概算 live there now) — it
          is not shown twice. */}
      <PlanSummaryStats plan={plan} />
      {plan.estimatedCostJpy != null ? (
        <div className="mt-2">
          <p className="text-sm font-semibold">
            概算費用（合計）: 約{plan.estimatedCostJpy.toLocaleString("ja-JP")}円
          </p>
          {plan.costBreakdown.length > 0 ? (
            <dl className="mt-1.5 space-y-1">
              {plan.costBreakdown.map((line, i) => (
                <div
                  key={i}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  <dt className="text-[var(--dim)]">{line.label}</dt>
                  <dd className="text-right">
                    {line.amountJpy != null
                      ? `${line.amountJpy.toLocaleString("ja-JP")}円`
                      : ""}
                    {line.note ? (
                      <span className="text-[var(--dim)]">{line.note}</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
      {scenarioPremise || unifiedPriority || ownPriority || commonPriority ? (
        <div className="mt-3 border-t border-[var(--border)] pt-2.5">
          <p className="text-xs font-semibold text-[var(--dim)]">
            このプランの前提
          </p>
          {scenarioPremise ? (
            <p className="mt-1 text-sm font-semibold leading-relaxed">
              {scenarioPremise}
            </p>
          ) : null}
          {unifiedPriority ? (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
              <span className="font-semibold">重視する点：</span>
              {unifiedPriority}
            </p>
          ) : null}
          {ownPriority ? (
            <p className="mt-1 text-sm leading-relaxed">
              <span className="font-semibold">プラン{plan.slot}：</span>
              {ownPriority}
            </p>
          ) : null}
          {commonPriority ? (
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">
              <span className="font-semibold">共通：</span>
              {commonPriority}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- chat tab

function ChatView({
  state,
  onGoToSearch,
  sending,
  pendingText,
  researchPending,
  waitSourcesPending,
  verificationPending,
}: {
  state: State;
  onGoToSearch: () => void;
  // While a send is in flight: the just-sent message (shown immediately so
  // the tab switch reads as "my message went through") and the thinking
  // indicator below it.
  sending: boolean;
  pendingText: string | null;
  // While a fact-check task is reading the official site; its answer is
  // posted into this chat when it finishes.
  researchPending: boolean;
  // While an add/remove/re-search instruction for the wait-time
  // reference sites is being carried out; the result is posted into
  // this chat when it finishes.
  waitSourcesPending: boolean;
  // While a bulk re-verification （一括検証） is running; its result
  // is posted into this chat when it finishes.
  verificationPending: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.messages.length, sending, researchPending, waitSourcesPending, verificationPending]);

  return (
    // overflow-x-hidden + overflow-wrap:anywhere (inherited by every
    // bubble): assistant replies carry long unbroken source URLs, and
    // with only whitespace-pre-wrap those URLs refused to wrap, widened
    // this scroll region to ~615px at phone width and made the whole
    // chat tab scroll sideways. Horizontal scrolling stays confined to
    // the tab strip; tab content never scrolls sideways.
    <div ref={listRef} className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-4 pb-4 pt-3 [overflow-wrap:anywhere]">
      {/* Guide, always at the top of the chat tab: start from the conditions
          tab, ask this AI anything via the bottom form, and take complaints
          about the app itself to Muse in the main chat. */}
      <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-4">
        <p className="font-display text-base font-bold">
          当日あたふたしないために、前日までに全部決める。
        </p>
        <p className="mt-2 text-sm leading-relaxed">
          ディズニーの複雑なシステムを踏まえた上で、AIが最適なプランを３つ同時に提案します。常に「今のディズニー」に合わせたプランを提案できます。
        </p>
        <ol className="mt-3 space-y-2.5 text-sm leading-relaxed">
          <li>
            <span className="font-semibold">1. まずは「プラン作成」タブから。</span>
            日付・パーク・予算と、3プラン共通の「重視する点」を入力して、「この条件で3プランを作成」を押してください。公式サイトでその日の情報を確認したうえで、その日の混雑予想をもとに混雑シナリオの違う3つのプラン（A＝激混み前提、B＝やや混み前提、C＝思ったより空いてる前提）を作り、新しいタブに表示します。
          </li>
          <li>
            <span className="font-semibold">2. 相談・修正は、画面下のAIフォームから。</span>
            プランのことなら何でも相談できます。「プランBをもっとゆっくり回る感じにしたい」「予算をもう少し抑えたい」といった修正も、ここからどうぞ。
          </li>
          <li>
            <span className="font-semibold">3. これはあなた専用のアプリです。</span>
            アプリ自体を変更する事もできます。機能の追加や修正などなんでもMuseのメインチャットでAIに伝えてください。この画面のAIは計画づくり専用です。
          </li>
        </ol>
        <p className="mt-3 text-sm leading-relaxed">
          あなた好みの旅行計画アプリに育てて、有意義なディズニー旅行を楽しんでください。
        </p>
        <button
          type="button"
          onClick={onGoToSearch}
          className="mt-4 w-full rounded-full bg-[var(--accent)] px-4 py-2.5 text-base font-bold text-[var(--accent-text)]"
        >
          まずはプラン作成
        </button>
      </div>

      {state.messages.length === 0 && !sending && !researchPending && !waitSourcesPending && !verificationPending ? null : (
        <ol className="mt-4 min-w-0 space-y-3">
          {state.messages.map((m) => (
            <li
              key={m.id}
              className={`flex min-w-0 ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed [overflow-wrap:anywhere] ${
                  m.role === "user"
                    ? "bg-[var(--accent)] text-[var(--accent-text)]"
                    : "bg-[var(--surface)] border border-[var(--border)]"
                }`}
              >
                {m.text}
              </div>
            </li>
          ))}
          {sending ? (
            <>
              {pendingText ? (
                <li className="flex min-w-0 justify-end">
                  <div className="min-w-0 max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[var(--accent)] px-3.5 py-2.5 text-[15px] leading-relaxed text-[var(--accent-text)] opacity-80 [overflow-wrap:anywhere]">
                    {pendingText}
                  </div>
                </li>
              ) : null}
              <li className="flex justify-start">
                <div
                  role="status"
                  className="flex items-center gap-2.5 rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3 shadow-md"
                >
                  <span aria-hidden className="flex items-end gap-1">
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                    <span className="typing-dot" />
                  </span>
                  <span className="text-base font-bold">
                    AIが返信を考えています…
                  </span>
                </div>
              </li>
            </>
          ) : null}
          {researchPending && !sending ? (
            <li className="flex justify-start">
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3 shadow-md"
              >
                <span aria-hidden className="flex items-end gap-1">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
                <span className="text-base font-bold">
                  公式サイトで確認しています…
                </span>
              </div>
            </li>
          ) : null}
          {waitSourcesPending && !sending ? (
            <li className="flex justify-start">
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3 shadow-md"
              >
                <span aria-hidden className="flex items-end gap-1">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
                <span className="text-base font-bold">
                  待ち時間参考サイトを更新しています…
                </span>
              </div>
            </li>
          ) : null}
          {verificationPending && !sending ? (
            <li className="flex justify-start">
              <div
                role="status"
                className="flex items-center gap-2.5 rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3 shadow-md"
              >
                <span aria-hidden className="flex items-end gap-1">
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                  <span className="typing-dot" />
                </span>
                <span className="text-base font-bold">
                  プランを検証しています…
                </span>
              </div>
            </li>
          ) : null}
        </ol>
      )}

      {/* Scope notice: footnote pinned to the very bottom of the chat
          tab (after the message list when it overflows). Wording is the
          user's own: the one thing the app cannot do is obtain DPA
          sales status; day-of rescheduling on an explicit instruction
          IS supported. */}
      <p className="mt-auto px-1 pt-6 text-xs leading-relaxed text-[var(--dim)]">
        ※このアプリはDPAの販売状況は取得できません。当日の状況によってその場でリスケジュールする際は「予定していたトイ・ストーリーが取れなくなった。リスケジュールして」などと具体的に指示してください。
      </p>
    </div>
  );
}

// Parses a numeric form field's raw text at submit time (記録AQ):
// the numeric fields of the conditions form and the same-day form
// hold the user's typed STRING while editing — so a field can be
// cleared with backspace and stay empty — and are interpreted as
// numbers only when a button is pressed. Empty (or digit-less)
// text parses to null = 未入力.
function parseNumericText(text: string): number | null {
  const digits = text.replace(/[^0-9]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isNaN(n) ? null : n;
}

// ------------------------------------------------------- 当日検索 (same-day)

// The emergency same-day entry, at the bottom of the プラン作成 tab and
// visually apart from the pre-trip form above it: a visitor who arrived
// WITHOUT a plan （計画を作らずに来園した人） gets ONE plan for the rest
// of today — from their current location at a specified time through
// park closing, built from the current posted wait times. This form
// carries its own values (initialized from the saved conditions — or
// from a one-shot prefill when the user arrives via a same-day set's
// 「条件を変えて再検索」 — then independent of them): submitting
// never overwrites the conditions form — the values travel with the
// requestSameDaySearch call and are snapshotted onto the new plan
// set server-side.
function SameDaySearchSection({
  conditions,
  onGenerated,
  prefill,
}: {
  conditions: Conditions;
  onGenerated: (planSetId: number) => void;
  // One-shot initial values from a same-day set's 「条件を変えて
  // 再検索」: when present they win over the saved-conditions
  // defaults for every field of this form.
  prefill: SameDayPrefill | null;
}) {
  const queryClient = useQueryClient();
  const nowTime = (): string => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const [park, setPark] = useState<"land" | "sea">(
    prefill?.park ?? conditions.park,
  );
  const [location, setLocation] = useState(prefill?.location ?? "");
  const [startTime, setStartTime] = useState<string>(() =>
    prefill ? toTimeInputValue(prefill.startTime) : nowTime(),
  );
  // Numeric fields keep the typed string while editing (記録AQ):
  // empty is allowed mid-edit and means 未入力; the numbers are
  // parsed and checked only when the 当日検索 button is pressed.
  const [adultsText, setAdultsText] = useState<string>(() =>
    String(prefill?.adults ?? conditions.adults),
  );
  const [childrenText, setChildrenText] = useState<string>(() =>
    String(prefill?.children ?? conditions.children),
  );
  const [childrenAges, setChildrenAges] = useState(
    prefill?.childrenAges ?? conditions.childrenAges ?? "",
  );
  const [budget, setBudget] = useState<string>(() => {
    const b = prefill ? prefill.budgetJpy : conditions.budgetJpy;
    return b != null ? String(b) : "";
  });
  const [speed, setSpeed] = useState<Conditions["walkingSpeed"]>(
    prefill?.walkingSpeed ?? conditions.walkingSpeed,
  );
  const [request, setRequest] = useState(prefill?.request ?? "");
  // Arriving here via 「条件を変えて再検索」 lands at the TOP of the
  // プラン作成 tab while this section sits at its bottom: bring the
  // section into view once, so the filled-in form is what the user
  // sees. The prefill value is captured from the first render (the
  // shell clears it right after this mount).
  const sectionRef = useRef<HTMLElement | null>(null);
  const arrivedWithPrefill = useRef(prefill != null);
  useEffect(() => {
    if (arrivedWithPrefill.current) {
      sectionRef.current?.scrollIntoView({ block: "start" });
    }
  }, []);
  const [localError, setLocalError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (vars: {
      adults: number;
      children: number;
      budgetJpy: number;
    }) => {
      return api.requestSameDaySearch({
        park,
        currentLocation: location.trim(),
        startTime,
        adults: vars.adults,
        children: vars.children,
        childrenAges: childrenAges.trim() ? childrenAges.trim() : null,
        budgetJpy: vars.budgetJpy,
        walkingSpeed: speed,
        request,
      });
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (res.ok && res.planSetId != null) onGenerated(res.planSetId);
    },
  });

  const serverError =
    mutation.data && !mutation.data.ok
      ? mutation.data.error
      : mutation.isError
        ? "当日検索を開始できませんでした。少し待ってもう一度お試しください。"
        : null;
  const error = localError ?? serverError;

  const submit = () => {
    if (!location.trim()) {
      setLocalError("現在地点（エリア名または施設名）を入力してください。");
      return;
    }
    if (!startTime) {
      setLocalError("指定時刻を入力してください。");
      return;
    }
    // Minimum press-time checks (記録AQ), same as the conditions
    // form: adults unentered or 0 can never be a real party, and a
    // budget of nothing entered or 0 is an unentered field, not a
    // budget — both stop here with the reason shown, before any
    // generation starts. Children unentered or 0 simply fix the
    // party at 0 children and never block.
    const adults = parseNumericText(adultsText);
    if (adults == null || adults < 1) {
      setLocalError(
        "大人の人数が入力されていません（0人では作成できません）。大人1人以上を入力してください。",
      );
      return;
    }
    const budgetNum = parseNumericText(budget);
    if (budgetNum == null || budgetNum < 1) {
      setLocalError(
        "予算が入力されていません（0円では作成できません）。予算の上限を入力してください。",
      );
      return;
    }
    const children = parseNumericText(childrenText) ?? 0;
    setLocalError(null);
    mutation.mutate({ adults, children, budgetJpy: budgetNum });
  };

  const inputCls =
    "w-full min-w-0 max-w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base";
  const labelCls = "block text-sm font-semibold";
  const hintCls = "mt-1 text-xs text-[var(--dim)]";

  return (
    <section
      ref={sectionRef}
      aria-label="当日検索"
      className="space-y-4 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-4"
    >
      <div>
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-display text-lg font-bold">当日検索</span>
          <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-xs font-bold text-[var(--accent-text)]">
            緊急回避用
          </span>
        </p>
        <p className="mt-1.5 text-sm leading-relaxed">
          計画を作らずに来園したときの入口です。現在地点、指定時刻からのプランだけ新たに作ります。その他ご要望は以下にご記入ください。
        </p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--dim)]">
          現在の掲示待ち時間をもとに、指定時刻から閉園までのプランを1つ作ります（事前プランのような3プランではありません）。
        </p>
      </div>

      <fieldset className="min-w-0">
        <legend className={labelCls}>パーク</legend>
        <div
          className="mt-1.5 grid grid-cols-2 gap-2"
          role="radiogroup"
          aria-label="当日検索のパーク選択"
        >
          {(
            [
              { value: "land", label: "ディズニーランド" },
              { value: "sea", label: "ディズニーシー" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={park === opt.value}
              onClick={() => setPark(opt.value)}
              className={`rounded-[var(--radius)] border px-3 py-2.5 font-display text-base font-bold ${
                park === opt.value
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor="sd-location" className={labelCls}>
            現在地点
          </label>
          <input
            {...FIELDS.requestSameDaySearch.currentLocation}
            id="sd-location"
            type="text"
            placeholder="例：アメリカンウォーターフロント／ソアリンの前"
            className={inputCls}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
          <p className={hintCls}>
            今いるエリア名か施設名。ここが移動時間の計算の起点になります
          </p>
        </div>
        <div className="min-w-0">
          <label htmlFor="sd-start-time" className={labelCls}>
            指定時刻
          </label>
          <TimeSelect
            id="sd-start-time"
            className={inputCls}
            value={startTime}
            onChange={(v) => setStartTime(v ?? "")}
            startMin={8 * 60 + 45}
            endMin={21 * 60}
          />
          <p className={hintCls}>この時刻から先のプランを作ります</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="min-w-0">
          <label htmlFor="sd-adults" className={labelCls}>
            大人（人）
          </label>
          <input
            {...FIELDS.requestSameDaySearch.adults}
            id="sd-adults"
            type="text"
            inputMode="numeric"
            className={inputCls}
            value={adultsText}
            onChange={(e) => setAdultsText(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="sd-children" className={labelCls}>
            子ども（人）
          </label>
          <input
            {...FIELDS.requestSameDaySearch.children}
            id="sd-children"
            type="text"
            inputMode="numeric"
            className={inputCls}
            value={childrenText}
            onChange={(e) => setChildrenText(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="sd-children-ages" className={labelCls}>
            子どもの年齢・身長
          </label>
          <input
            {...FIELDS.requestSameDaySearch.childrenAges}
            id="sd-children-ages"
            type="text"
            placeholder="例：6歳、102cm"
            className={inputCls}
            value={childrenAges}
            onChange={(e) => setChildrenAges(e.target.value)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="sd-budget" className={labelCls}>
            予算の上限（円）
          </label>
          <input
            {...FIELDS.requestSameDaySearch.budgetJpy}
            id="sd-budget"
            type="text"
            inputMode="numeric"
            placeholder="例：15000"
            className={inputCls}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
          <p className={hintCls}>これからかかる費用の上限の目安</p>
        </div>
      </div>

      <fieldset className="min-w-0">
        <legend className={labelCls}>歩く速さ</legend>
        <div
          className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4"
          role="radiogroup"
          aria-label="当日検索の歩く速さの選択"
        >
          {(
            [
              { value: "slow", label: "ゆっくり" },
              { value: "slightly_slow", label: "少しゆっくり" },
              { value: "slightly_fast", label: "少し急いで" },
              { value: "fast", label: "急いで" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={speed === opt.value}
              onClick={() => setSpeed(opt.value)}
              className={`rounded-[var(--radius)] border px-2 py-2.5 text-sm font-bold ${
                speed === opt.value
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="sd-request" className={labelCls}>
          ご要望
        </label>
        <textarea
          {...FIELDS.requestSameDaySearch.request}
          id="sd-request"
          rows={3}
          placeholder="例：絶叫系は苦手。夕食は和食がいい。あと1つはDPAを使いたい"
          className={inputCls}
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
        >
          {error}
        </p>
      ) : null}

      <button
        type="button"
        disabled={mutation.isPending}
        onClick={submit}
        className="w-full rounded-full bg-[var(--accent)] px-5 py-3 font-display text-base font-bold text-[var(--accent-text)] disabled:opacity-50"
      >
        {mutation.isPending ? "開始しています…" : "当日検索"}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- conditions

function ConditionsView({
  conditions,
  onSaved,
  onGenerated,
  sameDayPrefill,
  onSameDayPrefillConsumed,
}: {
  conditions: Conditions;
  onSaved: () => void;
  onGenerated: (planSetId: number) => void;
  // A same-day set's 「条件を変えて再検索」 prefill for the 当日検索
  // section at the bottom of this tab; consumed on mount (below) so
  // it applies exactly once.
  sameDayPrefill: SameDayPrefill | null;
  onSameDayPrefillConsumed: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Conditions>(conditions);
  const dirtyRef = useRef(false);
  const syncedRef = useRef<string>(JSON.stringify(conditions));
  // The numeric fields （予算・大人・子ども） hold the typed STRING
  // while editing (記録AQ): a field can be cleared with backspace
  // and stay empty — empty means 未入力 — and the text is parsed
  // into numbers only when 保存 or 作成 is pressed. (Before this,
  // the inputs parsed on every keystroke, so clearing a field
  // instantly snapped it back to 0 and the 0 could not be deleted.)
  const [budgetText, setBudgetText] = useState<string>(() =>
    conditions.budgetJpy != null ? String(conditions.budgetJpy) : "",
  );
  const [adultsText, setAdultsText] = useState<string>(() =>
    String(conditions.adults),
  );
  const [childrenText, setChildrenText] = useState<string>(() =>
    String(conditions.children),
  );
  const [formError, setFormError] = useState<string | null>(null);

  // Adopt server-side changes (e.g. another device, agent edits) only while
  // the user has no unsaved edits in the form.
  useEffect(() => {
    const incoming = JSON.stringify(conditions);
    if (!dirtyRef.current && incoming !== syncedRef.current) {
      syncedRef.current = incoming;
      setForm(conditions);
      setBudgetText(
        conditions.budgetJpy != null ? String(conditions.budgetJpy) : "",
      );
      setAdultsText(String(conditions.adults));
      setChildrenText(String(conditions.children));
    }
  }, [conditions]);

  // The 当日検索 prefill is one-shot: the section below captured it
  // as its initial values during this mount, so clear it from the
  // shell now — a later ordinary visit to this tab must not have
  // the old same-day inputs re-applied over what the user typed.
  useEffect(() => {
    if (sameDayPrefill) onSameDayPrefillConsumed();
  }, [sameDayPrefill, onSameDayPrefillConsumed]);

  const set = <K extends keyof Conditions>(key: K, value: Conditions[K]) => {
    dirtyRef.current = true;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const saveMutation = useMutation({
    mutationFn: (c: Conditions) => api.saveConditions(c),
    onSuccess: () => {
      dirtyRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["state"] });
      onSaved();
    },
  });

  const generateMutation = useMutation({
    mutationFn: async (c: Conditions) => {
      await api.saveConditions(c);
      return api.requestPlanGeneration({});
    },
    onSuccess: (res) => {
      dirtyRef.current = false;
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (res.ok && res.planSetId != null) onGenerated(res.planSetId);
    },
  });

  const genError =
    generateMutation.data && !generateMutation.data.ok
      ? generateMutation.data.error
      : generateMutation.isError
        ? "プラン作成を開始できませんでした。少し待ってもう一度お試しください。"
        : null;

  // Press-time handling for 「この条件で3プランを作成」 (記録AQ):
  // the numeric texts are parsed here, and only here. Adults
  // unentered or 0 — a party that cannot exist — and budget
  // unentered or 0 — an unentered field, not a budget — stop the
  // press with the reason shown in place; generation never starts.
  // No other judgement is made about the amount. Children
  // unentered or 0 fix the party at 0 children and never block.
  const handleGenerate = () => {
    const adults = parseNumericText(adultsText);
    if (adults == null || adults < 1) {
      setFormError(
        "大人の人数が入力されていません（0人では作成できません）。大人1人以上を入力してください。",
      );
      return;
    }
    const budget = parseNumericText(budgetText);
    if (budget == null || budget < 1) {
      setFormError(
        "予算が入力されていません（0円では作成できません）。チケット代込みの総額で、予算を入力してください。",
      );
      return;
    }
    const children = parseNumericText(childrenText) ?? 0;
    setFormError(null);
    generateMutation.mutate({
      ...form,
      adults,
      children,
      budgetJpy: budget,
    });
  };

  // Saving keeps the same parse-at-press rule without the creation
  // checks: an emptied adults field keeps the last saved count
  // rather than writing an impossible 0, an emptied budget saves
  // as 未入力 (null), and emptied children save as 0.
  const handleSave = () => {
    setFormError(null);
    saveMutation.mutate({
      ...form,
      adults: parseNumericText(adultsText) ?? form.adults,
      children: parseNumericText(childrenText) ?? 0,
      budgetJpy: parseNumericText(budgetText),
    });
  };

  const editNumeric = (
    setter: (v: string) => void,
  ): ((e: { target: { value: string } }) => void) => {
    return (e) => {
      dirtyRef.current = true;
      setter(e.target.value);
    };
  };

  const inputCls =
    "w-full min-w-0 max-w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base";
  const labelCls = "block text-sm font-semibold";
  const hintCls = "mt-1 text-xs text-[var(--dim)]";

  return (
    <form
      className="min-h-0 w-full min-w-0 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-3"
      onSubmit={(e: FormEvent) => e.preventDefault()}
    >
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <p className="font-display text-base font-bold">プランの作り方</p>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed">
          <li>
            「重視する点」は<strong>1つだけ</strong>です。書いた内容は3プラン全てに共通して反映されます。
          </li>
          <li>
            3プランは、対象日の<strong>混雑の見通し</strong>で分けて作ります。混雑予想は、曜日・時期・過去の混雑データからアプリ側が判断します（選ぶ項目はありません）。
          </li>
          <li>
            プランA＝<strong>激混み前提</strong>（予想より混む側）、プランB＝<strong>やや混み前提</strong>（予想どおり）、プランC＝<strong>思ったより空いてる前提</strong>（予想より空く側）。当日の実際の混み具合に近い前提のプランを選んで使えます。
          </li>
        </ul>
      </div>

      <fieldset className="min-w-0">
        <legend className={labelCls}>パーク</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup" aria-label="パーク選択">
          {(
            [
              { value: "land", label: "ディズニーランド" },
              { value: "sea", label: "ディズニーシー" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={form.park === opt.value}
              onClick={() => set("park", opt.value)}
              className={`rounded-[var(--radius)] border px-3 py-2.5 font-display text-base font-bold ${
                form.park === opt.value
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="min-w-0">
        <legend className={labelCls}>歩く速さ</legend>
        <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="歩く速さの選択">
          {(
            [
              { value: "slow", label: "ゆっくり" },
              { value: "slightly_slow", label: "少しゆっくり" },
              { value: "slightly_fast", label: "少し急いで" },
              { value: "fast", label: "急いで" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={form.walkingSpeed === opt.value}
              onClick={() => set("walkingSpeed", opt.value)}
              className={`rounded-[var(--radius)] border px-2 py-2.5 text-sm font-bold ${
                form.walkingSpeed === opt.value
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-text)]"
                  : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className={hintCls}>
          施設間の移動時間は、この速さと施設間の距離から計算します（直線距離が下限で、距離に応じた迂回と余裕を加えます）。
        </p>
      </fieldset>

      {/* Date / entry / exit row. On phones the three fields STACK,
          each on its own full-width row: native date/time inputs on
          mobile WebKit (the Muse app's iOS webview) refuse to shrink
          below their intrinsic width even with min-width: 0, so in the
          earlier 2-column layout the date cell (and the half-width
          time cells) were still pushed past the screen edge on the
          user's real phone while Chromium rendered them fine. A
          full-width row gives every input the whole content width —
          the most any native input can ask for — and makes all three
          widths uniform. From sm up the three sit side by side in
          equal minmax(0,1fr) tracks. The matching appearance reset for
          phone widths lives in theme.css. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="min-w-0">
          <label htmlFor="visit-date" className={labelCls}>日付</label>
          <input
            id="visit-date"
            type="date"
            className={inputCls}
            value={form.visitDate ?? ""}
            onChange={(e) => set("visitDate", e.target.value || null)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="entry-time" className={labelCls}>入園時刻</label>
          <TimeSelect
            id="entry-time"
            className={inputCls}
            value={form.entryTime}
            onChange={(v) => set("entryTime", v)}
            startMin={8 * 60 + 45}
            endMin={21 * 60}
          />
          <p className={hintCls}>
            入園できる最速は8:45（ハッピーエントリー）です。それより前の時刻は選べません
          </p>
        </div>
        <div className="min-w-0">
          <label htmlFor="exit-time" className={labelCls}>退園時刻</label>
          <TimeSelect
            id="exit-time"
            className={inputCls}
            value={form.exitTime}
            onChange={(v) => set("exitTime", v)}
            startMin={9 * 60}
            endMin={22 * 60 + 30}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="min-w-0">
          <label htmlFor="budget" className={labelCls}>予算（円）</label>
          <input
            id="budget"
            type="text"
            inputMode="numeric"
            placeholder="例：30000"
            className={inputCls}
            value={budgetText}
            onChange={editNumeric(setBudgetText)}
          />
          <p className={hintCls}>チケット代込みの総額で入力してください</p>
        </div>
        <div className="min-w-0">
          <label htmlFor="adults" className={labelCls}>大人（人）</label>
          <input
            id="adults"
            type="text"
            inputMode="numeric"
            className={inputCls}
            value={adultsText}
            onChange={editNumeric(setAdultsText)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="children" className={labelCls}>子ども（人）</label>
          <input
            id="children"
            type="text"
            inputMode="numeric"
            className={inputCls}
            value={childrenText}
            onChange={editNumeric(setChildrenText)}
          />
        </div>
        <div className="min-w-0">
          <label htmlFor="children-ages" className={labelCls}>子どもの年齢・身長</label>
          <input
            id="children-ages"
            type="text"
            placeholder="例：6歳、102cm"
            className={inputCls}
            value={form.childrenAges ?? ""}
            onChange={(e) => set("childrenAges", e.target.value || null)}
          />
        </div>
      </div>

      {/* No 宿泊 field (owner's decision, 2026-11-16): a stay had no
          mechanical effect anywhere — its only coupling was gating
          the 8:45 Happy Entry option, which made the form
          inconsistent (an 8:45 entry the stay did not entitle, or a
          stay that changed nothing). The entry floor is now 8:45
          unconditionally and the stay is gone from the form, the
          plan tab's 条件 panel and new conditions snapshots. The
          conditions.stay_hotel column and old snapshots keep their
          recorded values untouched (history is never rewritten). */}

      <div>
        <label htmlFor="priority" className={labelCls}>重視する点（3プラン共通）</label>
        <textarea
          id="priority"
          rows={4}
          placeholder="例：美女と野獣とプーさんは絶対に乗りたい。子どもがいるので絶叫系は苦手。疲れやすいので、動き回らず休憩多めに"
          className={inputCls}
          value={form.priority ?? ""}
          onChange={(e) => set("priority", e.target.value || null)}
        />
        <p className={hintCls}>
          ここに書いたことは、混雑シナリオで分かれる3プランの全てに共通して反映されます。
        </p>
      </div>

      {formError ?? genError ? (
        <p role="alert" className="rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
          {formError ?? genError}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={generateMutation.isPending}
          onClick={handleGenerate}
          className="rounded-full bg-[var(--accent)] px-5 py-2.5 font-display text-base font-bold text-[var(--accent-text)] disabled:opacity-50"
        >
          {generateMutation.isPending ? "開始しています…" : "この条件で3プランを作成"}
        </button>
        <button
          type="button"
          disabled={saveMutation.isPending}
          onClick={handleSave}
          className="rounded-full bg-[var(--surface-alt)] px-5 py-2.5 text-base font-semibold disabled:opacity-50"
        >
          {saveMutation.isSuccess && !dirtyRef.current ? "保存しました" : "条件を保存"}
        </button>
      </div>

      <p className="text-xs leading-relaxed text-[var(--dim)]">
        プランは作成のたびに公式サイトでその日の情報を確認して作ります（作成には10〜20分ほどかかります）。フォームの項目そのものを増減したいときは、Museのメインチャットで「このアプリに◯◯を追加して」と指示してください。この画面のAIは計画づくり専用です。
      </p>

      <SameDaySearchSection
        conditions={conditions}
        onGenerated={onGenerated}
        prefill={sameDayPrefill}
      />
    </form>
  );
}

// ------------------------------------------------------- wait-time sources

// Fixed tab (same rank as AIチャット / プラン作成, never deletable): a
// display-only list of the registered wait-time reference sites. There
// is deliberately NO add/edit form here — additions, removals and
// re-searches are instructed to the AI through the bottom form, and the
// AI does the searching, checking and registering.
function WaitSourcesView({
  sources,
  pending,
}: {
  sources: WaitTimeSource[];
  pending: boolean;
}) {
  const parkBadge = (park: WaitTimeSource["park"]): string =>
    park === "land" ? "ランド" : park === "sea" ? "シー" : "両パーク";
  const checkedLabel = (iso: string | null): string => {
    if (!iso) return "最終確認日：未確認";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "最終確認日：未確認";
    return `最終確認日：${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  };
  return (
    <div className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-3 [overflow-wrap:anywhere]">
      <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-4">
        <p className="font-display text-base font-bold">
          待ち時間の推定に使う、実績データの参考サイト
        </p>
        <p className="mt-2 text-sm leading-relaxed">
          待ち時間の公式データはありません。プラン作成のときは、ここに登録された民間の集計サイト（公式の表示待ち時間を記録・集計したもの）を材料に、典型的な待ち時間を推定します。使ったサイトは、公式の出典とは分けて、各プランの「プランの説明」に残ります。
        </p>
        <p className="mt-2 text-sm font-semibold leading-relaxed">
          参考サイトの追加・削除・再検索は、画面下のフォームからAIに指示してください。
        </p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
          例：「○○を参考サイトに追加して」「△△を削除して」「待ち時間の参考サイトを探し直して」
        </p>
      </div>

      {pending ? (
        <div
          role="status"
          className="mt-4 flex items-center gap-2.5 rounded-2xl border-2 border-[var(--accent)] bg-[var(--surface)] px-4 py-3 shadow-md"
        >
          <span aria-hidden className="flex items-end gap-1">
            <span className="typing-dot" />
            <span className="typing-dot" />
            <span className="typing-dot" />
          </span>
          <span className="text-base font-bold">
            AIが参考サイトを更新しています…
          </span>
        </div>
      ) : null}

      {sources.length === 0 ? (
        <p className="mt-5 rounded-[var(--radius)] border border-dashed border-[var(--border)] px-3 py-3 text-sm leading-relaxed text-[var(--dim)]">
          現在、登録されている参考サイトはありません。画面下のフォームから「待ち時間の参考サイトを探して登録して」とAIに指示してください。
        </p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {sources.map((s) => (
            <li
              key={s.id}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
            >
              <p className="flex flex-wrap items-center gap-2">
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener"
                  className="text-base font-semibold text-[var(--accent)] underline underline-offset-2"
                >
                  {s.name}
                </a>
                <span className="rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-semibold text-[var(--dim)]">
                  {parkBadge(s.park)}
                </span>
              </p>
              <p className="mt-0.5 break-all text-xs text-[var(--dim)]">
                {s.url}
              </p>
              {s.provides ? (
                <p className="mt-1.5 text-sm leading-relaxed">{s.provides}</p>
              ) : null}
              <p className="mt-1 text-xs text-[var(--dim)]">
                {checkedLabel(s.lastCheckedAt)}
              </p>
              <p className="mt-0.5 text-xs text-[var(--dim)]">
                取得方法：
                {s.fetchMethod === "script"
                  ? "スクリプトで取得"
                  : s.fetchMethod === "browser"
                    ? "ブラウザ表示で取得"
                    : s.fetchMethod === "failed"
                      ? "前回は取得できませんでした"
                      : "未記録（次回確認します）"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------- help / customize

// Fixed tab (same rank as AIチャット / プラン作成 / 待ち時間参考サイト,
// never deletable): a display-only guide explaining that this app
// itself can be reshaped to the user's liking — not from the in-app
// AI chat at the bottom of the screen (that AI makes and edits plans
// only), but by asking Muse in the main chat, the usual conversation
// screen outside this app. There is deliberately NO "go to main chat"
// button: the app runs inside a sandboxed frame with no route back to
// the Muse shell's conversation screen, so a button could not take
// the user anywhere real. Instead the tab gives the concrete steps
// and ready-to-send example sentences with copy buttons.
const CUSTOMIZE_EXAMPLES: { wish: string; instruction: string }[] = [
  {
    wish: "プランにメモを入れられるようにして",
    instruction: "我が家のディズニー計画に、プランへメモを入れられる機能を追加して",
  },
  {
    wish: "よく使う条件を保存できるようにして",
    instruction: "我が家のディズニー計画で、よく使う条件を保存できるようにして",
  },
  {
    wish: "一度に5個プランを作れるようにして",
    instruction: "我が家のディズニー計画で、一度に5個のプランを作れるようにして",
  },
];

function CustomizeHelpView({
  promptVersion,
}: {
  promptVersion?: {
    applied: number;
    bundled: number;
    lastCheckAt: string | null;
    lastResult: string | null;
    lastErrorClass: string | null;
  };
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [resetConfirming, setResetConfirming] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const resetMutation = useMutation({
    mutationFn: async () => await api.resetUserData({}),
    onSuccess: () => {
      setResetConfirming(false);
      setResetDone(true);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const copyText = async (text: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard API can be unavailable inside a WebView; fall back
      // to the classic hidden-textarea copy.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(text);
      window.setTimeout(() => {
        setCopied((cur) => (cur === text ? null : cur));
      }, 2500);
    }
  };

  return (
    <div className="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 pb-6 pt-3 [overflow-wrap:anywhere]">
      <div className="rounded-[var(--radius)] bg-[var(--surface-alt)] px-4 py-4">
        <p className="font-display text-lg font-bold leading-snug">
          このアプリは、あなた好みに作り替えられます
        </p>
        <p className="mt-2 text-sm leading-relaxed">
          「こんな機能があったらいいのに」と思ったら、そのままMuseにお願いできます。このアプリの機能の追加や変更は、アプリの外にあるMuseのメインチャット（いつもの会話画面）で指示するだけです。プログラミングの知識は要りません。思ったことを、普段の言葉で伝えてください。
        </p>
      </div>

      <div className="mt-5">
        <p className="font-display text-base font-bold">
          画面下のAIと、メインチャットの違い
        </p>
        <div className="mt-2.5 space-y-2.5">
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3">
            <p className="text-sm font-bold">
              画面下のAIチャット（このアプリの中）
            </p>
            <p className="mt-1 text-sm leading-relaxed">
              プランの作成や変更のためのAIです。「プランBをもっとゆっくり回る感じにして」「この乗り物が取れなかったので組み直して」といった、計画づくりのお願いはこちらへ。
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              アプリの機能そのものを増やしたり変えたりはできません。
            </p>
          </div>
          <div className="rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-3.5 py-3">
            <p className="text-sm font-bold">
              Museのメインチャット（このアプリの外）
            </p>
            <p className="mt-1 text-sm leading-relaxed">
              アプリ自体を作り替えるための指示はこちらへ。機能の追加・変更、入力フォームの項目の増減、画面の見せ方の変更など、自由にお願いできます。
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5">
        <p className="font-display text-base font-bold">
          たとえば、こんなお願いができます
        </p>
        <ul className="mt-2.5 space-y-2.5">
          {CUSTOMIZE_EXAMPLES.map((ex) => (
            <li
              key={ex.wish}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3"
            >
              <p className="text-base font-semibold leading-snug">
                「{ex.wish}」
              </p>
              <p className="mt-2 text-xs font-semibold text-[var(--dim)]">
                メインチャットに送る文面（そのまま使えます）
              </p>
              <p className="mt-1 rounded-lg bg-[var(--surface-alt)] px-3 py-2 text-sm leading-relaxed">
                {ex.instruction}
              </p>
              <button
                type="button"
                onClick={() => copyText(ex.instruction)}
                aria-label={`「${ex.instruction}」をコピー`}
                className="mt-2 rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent-text)]"
              >
                {copied === ex.instruction ? "コピーしました" : "この文面をコピー"}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-2.5 text-sm leading-relaxed text-[var(--dim)]">
          このほかにも、プラン作成フォームの項目を増やす・減らす、新しいタブを追加する、ボタンの名前や並びを変えるなど、自由に機能を追加・変更できます。「こうだったら使いやすいのに」と感じたことを、そのまま言葉にしてお願いしてみてください。
        </p>
      </div>

      <div className="mt-5">
        <p className="font-display text-base font-bold">お願いする手順</p>
        <ol className="mt-2.5 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
          <li>
            アプリ（または muse.ai）を開いて、いつもの会話画面（メインチャット）を開きます。このアプリの中で話している画面ではなく、アプリの外の、いつもMuseと話している画面です。
          </li>
          <li>
            上の例から近いものをコピーして貼り付けるか、自分の言葉で「我が家のディズニー計画に、○○できるようにして」と書いて送ります。
          </li>
          <li>
            変更が終わったら、このアプリに戻って確認してください。作り替えた内容がそのまま反映されています。
          </li>
        </ol>
        <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-2.5 text-sm leading-relaxed">
          この画面からメインチャットへ直接移動するボタンはありません。お手数ですが、アプリを開いて、いつもの会話画面から指示してください。
        </p>
      </div>

      <div className="mt-8 border-t border-[var(--border)] pt-5">
        <p className="font-display text-base font-bold">データを初期化する</p>
        <p className="mt-2 text-sm leading-relaxed">
          このアプリに保存されたデータをすべて消して、使い始めたときの状態に戻します。AIチャットの履歴、プラン作成タブの条件、作成したプラン、施設辞書などがすべて消え、元に戻すことはできません。待ち時間参考サイトの登録は残ります。
        </p>
        {resetDone ? (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--surface-alt)] px-3.5 py-2.5 text-sm font-semibold leading-relaxed">
            初期化しました。データはすべて消え、初期状態に戻っています。
          </p>
        ) : resetConfirming ? (
          <div className="mt-3 rounded-[var(--radius)] border-2 border-[var(--accent)] bg-[var(--surface)] px-3.5 py-3">
            <p className="text-sm font-bold leading-relaxed">
              本当に初期化しますか？保存されたデータはすべて消え、元に戻すことはできません。
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={resetMutation.isPending}
                onClick={() => resetMutation.mutate()}
                className="rounded-full bg-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent-text)] disabled:opacity-50"
              >
                {resetMutation.isPending ? "初期化しています…" : "本当に初期化する"}
              </button>
              <button
                type="button"
                disabled={resetMutation.isPending}
                onClick={() => setResetConfirming(false)}
                className="rounded-full bg-[var(--surface-alt)] px-4 py-1.5 text-sm font-bold disabled:opacity-50"
              >
                やめる
              </button>
            </div>
            {resetMutation.isError ? (
              <p className="mt-2 text-sm leading-relaxed text-[var(--accent)]">
                初期化できませんでした。少し待ってもう一度お試しください。
              </p>
            ) : null}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setResetConfirming(true)}
            className="mt-3 rounded-full border border-[var(--accent)] px-4 py-1.5 text-sm font-bold text-[var(--accent)]"
          >
            データを初期化する
          </button>
        )}
      </div>
      <div className="mt-8 border-t border-[var(--border)] pt-4">
        <p className="text-xs leading-relaxed text-[var(--dim)]">
          アプリのアップデート（AIへの指示文）: 適用中 Ver{" "}
          {promptVersion?.applied ?? "—"}（同梱版 Ver{" "}
          {promptVersion?.bundled ?? "—"}）
          {promptVersion?.lastCheckAt
            ? ` / 最終確認 ${new Date(promptVersion.lastCheckAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}${promptVersion.lastResult === "failed" ? "（更新できませんでした。現在の版のまま動作しています）" : ""}`
            : ""}
        </p>
      </div>
    </div>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<TabKey>("chat");
  const [draft, setDraft] = useState("");
  // Why an attempted send did not go out (an empty message), shown
  // above the composer instead of silently doing nothing.
  const [composerError, setComposerError] = useState<string | null>(null);
  // The text of the in-flight send, shown in the chat immediately so the
  // automatic switch to the chat tab is self-explanatory.
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // The A/B/C slot selected in each plan-set tab, kept per set in the
  // shell so a message sent from the bottom form can report the plan
  // the user is looking at (the AI's reference for 「プランB」 etc.).
  const [planSlotBySet, setPlanSlotBySet] = useState<Record<number, SubTab>>(
    {},
  );
  // One-shot prefill for the プラン作成 tab's 当日検索 section, set
  // by a same-day plan tab's 「条件を変えて再検索」; the conditions
  // form consumes it on mount and clears it (see ConditionsView), so
  // a later ordinary visit to the tab never re-applies it.
  const [sameDayPrefill, setSameDayPrefill] =
    useState<SameDayPrefill | null>(null);
  const [longPressTarget, setLongPressTarget] = useState<PlanSet | null>(null);
  const pressTimer = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Day-before （前日） dialog: getState offers a target at most once
  // per plan set (the server records the showing). The offered target
  // is captured into local state the moment it appears — and marked
  // shown on the server at the same moment — so a later refetch can
  // never make the dialog vanish while it is being read, and it can
  // never appear twice.
  const [eveDialog, setEveDialog] = useState<{
    planSetId: number;
    title: string;
    visitDate: string;
  } | null>(null);
  const eveMarkedRef = useRef<number | null>(null);
  // Announcement dialog (spec §22.1): checked once when the space is
  // opened (the effect below). The server returns display data only
  // for a newly saved announcement with a non-empty title; anything
  // else — no news, an already-read version, a failed fetch — comes
  // back as "do not show" and nothing ever appears. When the
  // day-before dialog also applies on the same open, the
  // announcement waits: its render is gated on the eve dialog being
  // gone, so the two never stack (spec §27.2).
  const [announcement, setAnnouncement] = useState<{
    title: string;
    body: string;
  } | null>(null);
  const announceCheckedRef = useRef(false);
  useEffect(() => {
    if (announceCheckedRef.current) return;
    announceCheckedRef.current = true;
    void api
      .checkAnnouncement({})
      .then((res) => {
        if (res.show && res.title != null) {
          setAnnouncement({ title: res.title, body: res.body ?? "" });
        }
      })
      .catch(() => undefined);
  }, []);

  // Prompt update check (spec §22.3): rides along with the
  // announcement check above. The server applies a newer prompt
  // bundle automatically as an app update when it passes the frame
  // validation; the client has nothing to show either way — the
  // applied version is displayed at the end of the help tab (from
  // getState), and a failed check leaves the current version in
  // force.
  const promptCheckedRef = useRef(false);
  useEffect(() => {
    if (promptCheckedRef.current) return;
    promptCheckedRef.current = true;
    void api.checkPromptUpdate({}).catch(() => undefined);
  }, []);

  const stateQuery = useQuery({
    queryKey: ["state"],
    queryFn: () => api.getState({}),
    refetchInterval: (query) =>
      query.state.data?.planSets.some(
        (s) =>
          s.status === "generating" ||
          s.imagesStatus === "fetching" ||
          // A partial replacement in flight: the set stays "done"
          // while one slot is 作成中 — keep polling so the swap (and
          // its chat announcement) lands without a manual reload.
          Object.values(s.planProgress).some((p) => p === "generating"),
      ) ||
      query.state.data?.researchPending ||
      query.state.data?.waitTimeSourcesPending ||
      query.state.data?.verificationPending
        ? 4000
        : false,
  });

  const sendMutation = useMutation({
    mutationFn: (vars: { text: string; openTab: OpenTabArg }) =>
      api.sendMessage(vars),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (res.generationStarted != null) setActiveTab(res.generationStarted);
    },
    // Settle ALWAYS refetches the state, not only on success: the
    // server saves the user message before inference and the reply
    // when it is ready, so if the response itself is lost (timeout,
    // connection drop) the saved reply must still surface in the
    // chat instead of leaving the user with "no reply".
    onSettled: () => {
      setPendingText(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deletePlanSet({ planSetId: id }),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (activeTab === id) setActiveTab("chat");
      setLongPressTarget(null);
    },
  });

  // The dialog's 「一括検証を実行する」: starts the verification of
  // exactly the set the dialog named (the server announces the start
  // in the chat from the actual start result) and closes the dialog.
  const eveVerifyMutation = useMutation({
    mutationFn: (id: number) => api.requestPlanVerification({ planSetId: id }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (res.ok) setEveDialog(null);
    },
  });
  const eveError =
    eveVerifyMutation.data && !eveVerifyMutation.data.ok
      ? eveVerifyMutation.data.error
      : eveVerifyMutation.isError
        ? "一括検証を開始できませんでした。少し待ってもう一度お試しください。"
        : null;

  const eveTarget = stateQuery.data?.eveVerification ?? null;
  useEffect(() => {
    if (!eveTarget || eveMarkedRef.current === eveTarget.planSetId) return;
    eveMarkedRef.current = eveTarget.planSetId;
    setEveDialog(eveTarget);
    void api
      .markEveDialogShown({ planSetId: eveTarget.planSetId })
      .catch(() => undefined);
  }, [eveTarget]);

  // Task-manager congestion dialog: getState offers an unshown
  // notice when one of the auxiliary production processings
  // (wait-time site list update / image fetch / restaurant fact
  // correction) exhausted its attempts under the task manager.
  // Like the day-before dialog, the offered notice is captured
  // into local state the moment it appears — and marked shown on
  // the server at the same moment — so it displays exactly once
  // and a later refetch can never make it vanish mid-read.
  const [mgrNotice, setMgrNotice] = useState<{
    id: number;
    text: string;
  } | null>(null);
  const mgrNoticeMarkedRef = useRef<number | null>(null);
  const mgrNoticeTarget = stateQuery.data?.mgrDialogNotice ?? null;
  useEffect(() => {
    if (!mgrNoticeTarget || mgrNoticeMarkedRef.current === mgrNoticeTarget.id)
      return;
    mgrNoticeMarkedRef.current = mgrNoticeTarget.id;
    setMgrNotice(mgrNoticeTarget);
    void api
      .markMgrDialogShown({ noticeId: mgrNoticeTarget.id })
      .catch(() => undefined);
  }, [mgrNoticeTarget]);

  const state = stateQuery.data;
  const activePlanSet =
    typeof activeTab === "number"
      ? state?.planSets.find((s) => s.id === activeTab)
      : undefined;
  const effectiveTab: TabKey =
    typeof activeTab === "number" && state && !activePlanSet
      ? "chat"
      : activeTab;

  const startLongPress = (set: PlanSet) => {
    pressTimer.current = window.setTimeout(() => setLongPressTarget(set), 600);
  };
  const cancelLongPress = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  // Desktop drag/wheel sideways scrolling for the tab strip; a drag
  // also cancels any long-press delete pending on the tab it began on.
  const tabBarRef = useDragScroll<HTMLDivElement>(cancelLongPress);

  const submitDraft = () => {
    const text = draft.trim();
    if (!text) {
      setComposerError("メッセージを入力してください。");
      return;
    }
    if (sendMutation.isPending) return;
    setComposerError(null);
    // Capture the tab open at send time BEFORE the view switches to
    // the chat tab: the AI resolves plan references against the plan
    // set open in that tab (and the A/B/C slot selected in it).
    const openTab: OpenTabArg =
      effectiveTab === "chat"
        ? { kind: "chat" }
        : effectiveTab === "conditions"
          ? { kind: "conditions" }
          : effectiveTab === "waitsources"
            ? { kind: "waitsources" }
            : effectiveTab === "help"
              ? { kind: "help" }
                : {
                kind: "planSet",
                planSetId: effectiveTab,
                slot: planSlotBySet[effectiveTab] ?? "A",
              };
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setPendingText(text);
    sendMutation.mutate({ text, openTab });
    setActiveTab("chat");
  };

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !composing && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitDraft();
    }
  };

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      {/* Tab bar: fixed tabs first, plan tabs appended. Pinned to
          the top of the screen (sticky) so it never scrolls away. */}
      <div
        ref={tabBarRef}
        role="tablist"
        aria-label="タブ"
        className="pt-safe sticky top-0 z-30 flex w-full min-w-0 shrink-0 cursor-grab gap-1.5 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface)] px-3 py-2"
      >
                        <TabButton
          label="AIチャット"
          active={effectiveTab === "chat"}
          onClick={() => setActiveTab("chat")}
        />
        <TabButton
          label="プラン作成"
          active={effectiveTab === "conditions"}
          onClick={() => setActiveTab("conditions")}
        />
        <TabButton
          label="待ち時間参考サイト"
          active={effectiveTab === "waitsources"}
          badge={state?.waitTimeSourcesPending ? "更新中" : undefined}
          onClick={() => setActiveTab("waitsources")}
        />
        <TabButton
          label="もっとこうして！"
          active={effectiveTab === "help"}
          onClick={() => setActiveTab("help")}
        />
        {state?.planSets.map((s) => (
          <TabButton
            key={s.id}
            // Same-title sets are told apart by the "(N) " sequence
            // number stored at the FRONT of the set's title; it leads
            // the tab label too, since the label's end is what gets
            // truncated in the strip.
            label={`${/^\(\d+\)\s/.exec(s.title)?.[0] ?? ""}${formatDateLabel(s.visitDate)} ${parkLabel(s.park)}`}
            active={effectiveTab === s.id}
            badge={s.status === "generating" ? "作成中" : s.status === "failed" ? "失敗" : s.status === "done" && Object.values(s.planProgress).some((p) => p === "generating") ? "差し替え中" : s.setType === "same_day" ? "当日検索" : s.rebuiltFromSetId != null ? "作り直し版" : undefined}
            onClick={() => setActiveTab(s.id)}
            onLongPress={() => startLongPress(s)}
            onLongPressEnd={cancelLongPress}
          />
        ))}
      </div>

      {/* Content. Plan tabs drop the centered max-width at lg and up so
          their two-pane split spans the full display width; every other
          tab (and every tab below lg) keeps the centered column. */}
      <main
        className={`mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col ${
          typeof effectiveTab === "number" && activePlanSet
            ? "lg:mx-0 lg:max-w-none"
            : ""
        }`}
      >
        {stateQuery.isPending ? (
          <p className="px-4 py-10 text-center text-sm text-[var(--dim)]">読み込んでいます…</p>
        ) : stateQuery.isError || !state ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm">読み込めませんでした。</p>
            <button
              onClick={() => stateQuery.refetch()}
              className="mt-3 rounded-full bg-[var(--surface-alt)] px-4 py-2 text-sm font-semibold"
            >
              もう一度試す
            </button>
          </div>
        ) : effectiveTab === "chat" ? (
          <ChatView
            state={state}
            onGoToSearch={() => setActiveTab("conditions")}
            sending={sendMutation.isPending}
            pendingText={pendingText}
            researchPending={state.researchPending}
            waitSourcesPending={state.waitTimeSourcesPending}
            verificationPending={state.verificationPending}
          />
        ) : effectiveTab === "conditions" ? (
          <ConditionsView
            conditions={state.conditions}
            onSaved={() => undefined}
            onGenerated={(id) => setActiveTab(id)}
            sameDayPrefill={sameDayPrefill}
            onSameDayPrefillConsumed={() => setSameDayPrefill(null)}
          />
        ) : effectiveTab === "waitsources" ? (
          <WaitSourcesView
            sources={state.waitTimeSources}
            pending={state.waitTimeSourcesPending}
          />
        ) : effectiveTab === "help" ? (
          <CustomizeHelpView promptVersion={state?.promptVersion} />
        ) : activePlanSet ? (
          <PlanSetView
            key={activePlanSet.id}
            planSet={activePlanSet}
            rebuiltFromTitle={
              activePlanSet.rebuiltFromSetId != null
                ? (state.planSets.find((x) => x.id === activePlanSet.rebuiltFromSetId)?.title ?? null)
                : null
            }
            selectedSlot={planSlotBySet[activePlanSet.id] ?? "A"}
            onSelectSlot={(slot) =>
              setPlanSlotBySet((prev) => ({
                ...prev,
                [activePlanSet.id]: slot,
              }))
            }
            onResearch={(prefill) => {
              setSameDayPrefill(prefill);
              setActiveTab("conditions");
            }}
          />
        ) : null}
        {sendMutation.isPending ? (
          <div
            role="status"
            className="shrink-0 border-t-2 border-[var(--accent)] bg-[var(--surface-alt)] px-4 py-3"
          >
            <p className="flex items-center justify-center gap-2.5 text-center">
              <span aria-hidden className="flex items-end gap-1">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="text-base font-bold">
                メッセージを送信しました。AIが返信を考えています…
              </span>
            </p>
            <p className="mt-1 text-center text-xs text-[var(--dim)]">
              返信ができたら、AIチャットに表示されます。
            </p>
          </div>
        ) : sendMutation.isError ? (
          <p
            role="alert"
            className="shrink-0 px-4 pb-2 text-center text-sm font-semibold text-red-700 dark:text-red-300"
          >
            送信できませんでした。もう一度お試しください。
          </p>
        ) : state?.researchPending ? (
          <div
            role="status"
            className="shrink-0 border-t-2 border-[var(--accent)] bg-[var(--surface-alt)] px-4 py-3"
          >
            <p className="flex items-center justify-center gap-2.5 text-center">
              <span aria-hidden className="flex items-end gap-1">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="text-base font-bold">
                AIが公式サイトで確認しています…
              </span>
            </p>
            <p className="mt-1 text-center text-xs text-[var(--dim)]">
              回答ができたら、AIチャットに表示されます。
            </p>
          </div>
        ) : state?.waitTimeSourcesPending ? (
          <div
            role="status"
            className="shrink-0 border-t-2 border-[var(--accent)] bg-[var(--surface-alt)] px-4 py-3"
          >
            <p className="flex items-center justify-center gap-2.5 text-center">
              <span aria-hidden className="flex items-end gap-1">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="text-base font-bold">
                AIが待ち時間参考サイトを更新しています…
              </span>
            </p>
            <p className="mt-1 text-center text-xs text-[var(--dim)]">
              更新が終わったら、AIチャットと「待ち時間参考サイト」タブに表示されます。
            </p>
          </div>
        ) : state?.verificationPending ? (
          <div
            role="status"
            className="shrink-0 border-t-2 border-[var(--accent)] bg-[var(--surface-alt)] px-4 py-3"
          >
            <p className="flex items-center justify-center gap-2.5 text-center">
              <span aria-hidden className="flex items-end gap-1">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </span>
              <span className="text-base font-bold">
                AIがプランの一括検証をしています…
              </span>
            </p>
            <p className="mt-1 text-center text-xs text-[var(--dim)]">
              公式情報を取り直して照合しています。結果は、AIチャットに表示されます。
            </p>
          </div>
        ) : null}
      </main>

      {/* Fixed AI instruction form (TAB1 conversation), always at the bottom. */}
      <div className="sticky bottom-0 border-t border-[var(--border)] bg-[var(--surface)] pb-safe">
        {composerError ? (
          <p
            role="alert"
            className="mx-auto w-full max-w-3xl px-3 pt-2 text-sm font-semibold text-red-700 dark:text-red-300"
          >
            {composerError}
          </p>
        ) : null}
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-2 px-3 py-2.5"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            submitDraft();
          }}
        >
          <label htmlFor="ai-composer" className="sr-only">
            AIへの指示
          </label>
          <textarea
            {...FIELDS.sendMessage.text}
            id="ai-composer"
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder="AIに話しかける"
            className="max-h-[120px] flex-1 resize-none rounded-2xl border border-[var(--border)] bg-[var(--bg)] px-3.5 py-2.5 text-base"
            onChange={(e) => {
              setDraft(e.target.value);
              setComposerError(null);
              autoGrow();
            }}
            onKeyDown={onComposerKeyDown}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          />
          <button
            type="submit"
            disabled={!draft.trim() || sendMutation.isPending}
            aria-label="送信"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-lg font-bold text-[var(--accent-text)] disabled:opacity-40"
          >
            ↑
          </button>
        </form>
      </div>

      {/* Day-before （前日） dialog: shown once per plan set, when the
          space is opened on the day before its visit date. The
          wording is the user's own; the only addition is the small
          line naming the target plan. Executing starts the bulk
          re-verification of that set (results arrive in the AI chat
          tab); closing leaves the same verification available from
          the chat with 「検証して」. */}
      {eveDialog ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="前日のお知らせ"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        >
          <div className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5">
            <p className="text-xs text-[var(--dim)]">
              対象のプラン：「{eveDialog.title}」（{formatDateLabel(eveDialog.visitDate)} 来園）
            </p>
            <p className="font-display mt-2 text-lg font-bold">
              明日はいよいよ当日ですね！
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              ディズニーは頻繁に情報が更新されます。アトラクションの営業時間や工事など。
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              現在のプランが正しいか、検証しておきましょう。プランの内容は変更しません。
            </p>
            <p className="mt-2 text-sm leading-relaxed">
              検証結果はAIチャットタブでお知らせします。
            </p>
            {eveError ? (
              <p
                role="alert"
                className="mt-2 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100"
              >
                {eveError}
              </p>
            ) : null}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => eveVerifyMutation.mutate(eveDialog.planSetId)}
                disabled={eveVerifyMutation.isPending}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-50"
              >
                {eveVerifyMutation.isPending
                  ? "開始しています…"
                  : "一括検証を実行する"}
              </button>
              <button
                onClick={() => setEveDialog(null)}
                disabled={eveVerifyMutation.isPending}
                className="flex-1 rounded-full bg-[var(--surface-alt)] px-4 py-2.5 font-semibold disabled:opacity-50"
              >
                後で
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Announcement dialog (spec §22.1): the title is the heading
          and the body is the distributor's HTML, rendered as HTML —
          the server sanitizes the body with an allowlist sanitizer
          before storing/returning it, so only formatting markup
          (and https links) can ever reach this innerHTML.
          When the day-before dialog applies on the same open it
          comes first: this dialog renders only once there is no eve
          target and no eve dialog on screen, so the two never
          overlap, and closing the eve dialog lets this one appear. */}
      {!eveDialog && !eveTarget && announcement ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="お知らせ"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        >
          <div className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5">
            <p className="font-display text-lg font-bold">
              {announcement.title}
            </p>
            <div
              className="mt-2 text-sm leading-relaxed [&_a]:underline [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
              dangerouslySetInnerHTML={{ __html: announcement.body }}
            />
            <div className="mt-4 flex">
              <button
                onClick={() => setAnnouncement(null)}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-white"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Task-manager congestion dialog: shown when an auxiliary
          production processing (wait-time site list update /
          image fetch / restaurant fact correction) exhausted its
          attempts. The body is the one common congestion text,
          verbatim from the server. It yields to the day-before
          dialog and the announcement dialog so dialogs never
          stack; it appears once they are gone. */}
      {!eveDialog && !eveTarget && !announcement && mgrNotice ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="混雑のお知らせ"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        >
          <div className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5">
            <p className="text-sm leading-relaxed">{mgrNotice.text}</p>
            <div className="mt-4 flex">
              <button
                onClick={() => setMgrNotice(null)}
                className="flex-1 rounded-full bg-[var(--accent)] px-4 py-2.5 font-semibold text-white"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Long-press delete confirmation for plan tabs. */}
      {longPressTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="タブ削除の確認"
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
          onClick={() => setLongPressTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-[var(--radius)] bg-[var(--surface)] p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-base font-bold">
              「{longPressTarget.title}」を削除しますか？
            </p>
            <p className="mt-2 text-sm text-[var(--dim)]">
              このタブのプラン（A/B/C）はすべて消えます。元に戻せません。
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => deleteMutation.mutate(longPressTarget.id)}
                className="flex-1 rounded-full bg-red-700 px-4 py-2.5 font-semibold text-white"
              >
                削除する
              </button>
              <button
                onClick={() => setLongPressTarget(null)}
                className="flex-1 rounded-full bg-[var(--surface-alt)] px-4 py-2.5 font-semibold"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TabButton({
  label,
  active,
  badge,
  onClick,
  onLongPress,
  onLongPressEnd,
}: {
  label: string;
  active: boolean;
  badge?: string;
  onClick: () => void;
  onLongPress?: () => void;
  onLongPressEnd?: () => void;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onPointerDown={onLongPress}
      onPointerUp={onLongPressEnd}
      onPointerLeave={onLongPressEnd}
      onPointerCancel={onLongPressEnd}
      onContextMenu={onLongPress ? (e) => e.preventDefault() : undefined}
      className={`shrink-0 rounded-full px-4 py-2 text-sm font-semibold ${
        active
          ? "bg-[var(--text)] text-[var(--bg)]"
          : "bg-[var(--surface-alt)] text-[var(--text)]"
      }`}
    >
      {label}
      {badge ? (
        <span className="ml-1.5 rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold text-white">
          {badge}
        </span>
      ) : null}
    </button>
  );
}
