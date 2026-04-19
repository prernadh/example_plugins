// ============================================================
// TemporalDataExplorer — JS Panel for temporal-detection
//
// SVG line chart of per-frame temporal data with bidirectional
// video sync:
//   - Video → Chart: vertical blue line tracks current frame
//   - Chart → Video: click/drag on chart seeks the video
//
// Supports multiple charts with add/remove/reorder and
// per-dataset localStorage persistence.
//
// Hand-written UMD (no build step). Uses FiftyOne globals:
//   __fos__ (state), __foo__ (operators), __fop__ (plugins),
//   __mui__ (MUI), React, recoil
// ============================================================

(function () {
  "use strict";

  // --- Globals ---
  var React = window.React;
  var h = React.createElement;
  var useState = React.useState;
  var useEffect = React.useEffect;
  var useRef = React.useRef;
  var useCallback = React.useCallback;
  var memo = React.memo;

  var useRecoilValue = window.recoil.useRecoilValue;
  var useSetRecoilState = window.recoil.useSetRecoilState;

  var fos = window.__fos__;
  var foo = window.__foo__;
  var fop = window.__fop__;
  var mui = window.__mui__;

  var Box = mui.Box;
  var Typography = mui.Typography;
  var CircularProgress = mui.CircularProgress;

  var LOG_PREFIX = "[TemporalDataExplorer]";

  // Stable selector reference for "Use frame number" app config
  // Created once at module level so Recoil can properly subscribe to changes
  var useFrameNumberSelector = (fos && fos.appConfigOption)
    ? fos.appConfigOption({ modal: true, key: "useFrameNumber" })
    : null;

  // --- Constants ---
  var CHART_HEIGHT = 350;
  var MARGIN = { top: 35, right: 30, bottom: 50, left: 65 };

  // --- Label Timeline Constants ---
  var LT_MARGIN = { top: 35, right: 30, bottom: 30, left: 140 };
  var LT_ROW_HEIGHT = 14;
  var LT_ROW_GAP = 1;
  var LT_DEFAULT_MAX_LABELS = 15;

  var LABEL_COLORS = [
    "#FF6D04", "#4FC3F7", "#81C784", "#FFB74D", "#BA68C8",
    "#4DD0E1", "#AED581", "#FF8A65", "#9575CD", "#FFD54F",
    "#F06292", "#26A69A", "#DCE775", "#7986CB", "#A1887F",
    "#90A4AE", "#CE93D8", "#80CBC4", "#FFAB91", "#80DEEA",
  ];

  function hashString(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  function labelColor(label) {
    return LABEL_COLORS[hashString(label) % LABEL_COLORS.length];
  }

  function chartKey(field, type) {
    return field + ":" + (type || "count");
  }

  // Format frame number as timestamp (M:SS.s or H:MM:SS.s)
  function formatTimestamp(frame, fps) {
    if (!fps || fps <= 0) return String(frame);
    var seconds = (frame - 1) / fps;
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    if (h > 0) {
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
    }
    return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
  }

  // Format for tick labels (less precision)
  function formatTimestampTick(frame, fps) {
    if (!fps || fps <= 0) return String(frame);
    var seconds = (frame - 1) / fps;
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    if (h > 0) {
      return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    }
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  // ==========================================================
  // Hook: useVideoState
  // Reads video playback state from the modal looker.
  // Handles both regular video and ImaVid modes.
  // Pattern from cariad-imavid-state plugin.
  // ==========================================================
  function useVideoState() {
    var isImaVid = useRecoilValue(fos.shouldRenderImaVidLooker(true));
    var imaVidFrameNumber = useRecoilValue(
      fos.imaVidLookerState("currentFrameNumber"),
    );
    var imaVidPlaying = useRecoilValue(fos.imaVidLookerState("playing"));
    var modalLooker = useRecoilValue(fos.modalLooker);

    // Dynamic group state — controls which sample is displayed
    var isDynamicGroup = useRecoilValue(fos.isDynamicGroup);
    var dynamicGroupIndex = useRecoilValue(fos.dynamicGroupCurrentElementIndex);
    var setDynamicGroupIndex = useSetRecoilState(
      fos.dynamicGroupCurrentElementIndex,
    );

    // Detect carousel vs pagination mode in dynamic groups
    var dynamicGroupsViewMode = useRecoilValue(
      fos.dynamicGroupsViewMode(true),
    );
    var isCarousel = isDynamicGroup && dynamicGroupsViewMode === "carousel";

    // ImaVid frame setter — directly controls the ImaVid player's current frame
    var setImaVidFrameNumber = useSetRecoilState(
      fos.imaVidLookerState("currentFrameNumber"),
    );

    var stateRef = useRef({ playing: false, frameNumber: 1 });
    var _s = useState(0);
    var forceUpdate = _s[1];

    useEffect(
      function () {
        // Path 1: Dynamic group in VIDEO mode — uses ImaVid looker
        if (isDynamicGroup && isImaVid) {
          stateRef.current = {
            playing: imaVidPlaying,
            frameNumber: imaVidFrameNumber,
          };
          forceUpdate(function (n) {
            return n + 1;
          });
          return;
        }

        // Path 2: Dynamic group in PAGINATION mode (carousel handled by panel)
        if (isDynamicGroup && !isCarousel) {
          var dgFrame = (dynamicGroupIndex || 0) + 1;
          stateRef.current = {
            playing: false,
            frameNumber: dgFrame,
          };
          forceUpdate(function (n) {
            return n + 1;
          });
          return;
        }

        // Path 3: ImaVid mode (non-dynamic-group, if it ever applies)
        if (isImaVid) {
          stateRef.current = {
            playing: imaVidPlaying,
            frameNumber: imaVidFrameNumber,
          };
          forceUpdate(function (n) {
            return n + 1;
          });
          return;
        }

        // Path 4: Regular video — subscribe to looker state
        if (modalLooker && typeof modalLooker.subscribeToState === "function") {
          stateRef.current = {
            playing: modalLooker.state.playing,
            frameNumber: modalLooker.state.frameNumber,
          };
          forceUpdate(function (n) {
            return n + 1;
          });

          var unsub1 = modalLooker.subscribeToState("playing", function (v) {
            stateRef.current = {
              playing: v,
              frameNumber: stateRef.current.frameNumber,
            };
            forceUpdate(function (n) {
              return n + 1;
            });
          });

          var unsub2 = modalLooker.subscribeToState(
            "frameNumber",
            function (v) {
              stateRef.current = {
                playing: stateRef.current.playing,
                frameNumber: v,
              };
              forceUpdate(function (n) {
                return n + 1;
              });
            },
          );

          return function () {
            unsub1();
            unsub2();
          };
        }
      },
      [isDynamicGroup, isCarousel, dynamicGroupIndex, isImaVid, imaVidFrameNumber, imaVidPlaying, modalLooker],
    );

    return {
      playing: stateRef.current.playing,
      frameNumber: stateRef.current.frameNumber,
      modalLooker: modalLooker,
      isImaVid: isImaVid,
      isDynamicGroup: isDynamicGroup,
      isCarousel: isCarousel,
      setDynamicGroupIndex: setDynamicGroupIndex,
      setImaVidFrameNumber: setImaVidFrameNumber,
    };
  }

  // ==========================================================
  // Utility: seekVideoToFrame
  // Uses modalLooker.getVideo() to seek the <video> element
  // (not in regular DOM, only accessible via the looker) and
  // modalLooker.updater() to sync internal looker state.
  // ==========================================================
  function seekVideoToFrame(frameNumber, modalLooker, fps) {
    if (!modalLooker) return;

    // Seek the actual video element (native video only)
    if (typeof modalLooker.getVideo === "function") {
      var video = modalLooker.getVideo();
      if (video && video.currentTime !== undefined) {
        video.currentTime = (frameNumber - 1) / fps;
      }
    }

    // Sync the looker's internal state
    if (typeof modalLooker.updater === "function") {
      modalLooker.updater({ frameNumber: frameNumber });
    }

    // Pause if playing (stay on the seeked frame)
    if (typeof modalLooker.pause === "function") {
      modalLooker.pause();
    }
  }

  // ==========================================================
  // Utility: seekImaVidToFrame
  // Dispatches a timeline CustomEvent to seek the ImaVid player.
  // This is the same mechanism FiftyOne's built-in set_frame_number
  // operator and seek bar use. It updates:
  //   - The canvas (via renderFrame → drawFrameNoAnimation)
  //   - The Jotai frame number atom (resume point for playback)
  //   - The status indicator ("30/38" counter)
  //   - The seek bar position
  // ==========================================================
  function seekImaVidToFrame(frameNumber) {
    var params = new URLSearchParams(window.location.search);
    var sampleId = params.get("id");
    var groupId = params.get("groupId");

    if (!sampleId && !groupId) return;

    var timelineName = groupId
      ? "timeline-" + groupId
      : "timeline-" + sampleId;

    window.dispatchEvent(
      new CustomEvent("set-frame-number-" + timelineName, {
        detail: { frameNumber: Math.max(frameNumber, 1) },
      }),
    );
  }

  // ==========================================================
  // localStorage helpers for chart persistence
  // ==========================================================
  var LS_PREFIX = "temporal-detection:fields:";

  function saveChartFields(datasetName, charts) {
    if (!datasetName) return;
    try {
      var entries = charts.map(function (c) {
        return { field: c.field, type: c.type || "count" };
      });
      localStorage.setItem(LS_PREFIX + datasetName, JSON.stringify(entries));
    } catch (e) { /* quota errors etc */ }
  }

  function loadChartFields(datasetName) {
    if (!datasetName) return null;
    try {
      var raw = localStorage.getItem(LS_PREFIX + datasetName);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.length) return null;
      // Migration: old format was string array of field paths
      if (typeof parsed[0] === "string") {
        return parsed.map(function (f) {
          return { field: f, type: "count" };
        });
      }
      return parsed;
    } catch (e) { return null; }
  }

  // ==========================================================
  // Component: SVGChart
  // Pure SVG line chart with current-frame indicator and
  // click/drag-to-seek.
  // ==========================================================
  function SVGChart(props) {
    var frames = props.frames;
    var counts = props.counts;
    var currentFrame = props.currentFrame;
    var totalFrames = props.totalFrames;
    var onFrameSeek = props.onFrameSeek;
    var width = props.width;
    var yAxisTitle = props.yAxisTitle || "Detection Count";
    var useFrameNumber = props.useFrameNumber !== false;
    var fps = props.fps || 30;

    var plotWidth = width - MARGIN.left - MARGIN.right;
    var plotHeight = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

    if (plotWidth <= 0 || plotHeight <= 0) return null;

    var maxCount = 1;
    for (var i = 0; i < counts.length; i++) {
      if (counts[i] > maxCount) maxCount = counts[i];
    }
    // Add 10% headroom
    var yMax = Math.ceil(maxCount * 1.1);

    // --- Scale functions ---
    var xScale = function (frame) {
      return (
        MARGIN.left + ((frame - 1) / Math.max(totalFrames - 1, 1)) * plotWidth
      );
    };
    var yScale = function (count) {
      return MARGIN.top + plotHeight - (count / yMax) * plotHeight;
    };

    // --- Frame seek from mouse position ---
    var frameFromMouseX = function (clientX, svgEl) {
      var rect = svgEl.getBoundingClientRect();
      var clickX = clientX - rect.left;
      if (clickX < MARGIN.left) clickX = MARGIN.left;
      if (clickX > width - MARGIN.right) clickX = width - MARGIN.right;
      var fraction = (clickX - MARGIN.left) / plotWidth;
      var frame = Math.round(fraction * (totalFrames - 1)) + 1;
      return Math.max(1, Math.min(totalFrames, frame));
    };

    // --- Mouse handlers for click + drag seeking ---
    var svgRef = useRef(null);

    var handleMouseDown = useCallback(
      function (e) {
        if (!svgRef.current) return;
        e.preventDefault();

        var frame = frameFromMouseX(e.clientX, svgRef.current);
        onFrameSeek(frame);

        var svg = svgRef.current;

        var handleMouseMove = function (ev) {
          var f = frameFromMouseX(ev.clientX, svg);
          onFrameSeek(f);
        };

        var handleMouseUp = function () {
          document.removeEventListener("mousemove", handleMouseMove);
          document.removeEventListener("mouseup", handleMouseUp);
        };

        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
      },
      [onFrameSeek, totalFrames, width],
    );

    // --- Build SVG children ---
    var children = [];

    // Background
    children.push(
      h("rect", {
        key: "bg",
        width: width,
        height: CHART_HEIGHT,
        fill: "#18191A",
        rx: 6,
      }),
    );

    // Y axis gridlines + labels
    var yTickCount = 5;
    for (var t = 0; t <= yTickCount; t++) {
      var tickVal = Math.round((yMax / yTickCount) * t);
      var y = yScale(tickVal);
      children.push(
        h("line", {
          key: "yg-" + t,
          x1: MARGIN.left,
          y1: y,
          x2: width - MARGIN.right,
          y2: y,
          stroke: "#1E1F20",
          strokeWidth: 1,
          strokeDasharray: "4,4",
        }),
      );
      children.push(
        h(
          "text",
          {
            key: "yl-" + t,
            x: MARGIN.left - 10,
            y: y + 4,
            fill: "#8F8D8B",
            fontSize: 12,
            textAnchor: "end",
            fontFamily: "monospace",
          },
          tickVal,
        ),
      );
    }

    // X axis tick labels
    var xTickStep = Math.max(1, Math.floor(totalFrames / 8));
    var xTicks = [];
    for (var f = 1; f <= totalFrames; f += xTickStep) {
      xTicks.push(f);
    }
    if (xTicks[xTicks.length - 1] !== totalFrames) {
      xTicks.push(totalFrames);
    }
    for (var xi = 0; xi < xTicks.length; xi++) {
      var xv = xTicks[xi];
      children.push(
        h(
          "text",
          {
            key: "xl-" + xi,
            x: xScale(xv),
            y: CHART_HEIGHT - MARGIN.bottom + 20,
            fill: "#8F8D8B",
            fontSize: 12,
            textAnchor: "middle",
            fontFamily: "monospace",
          },
          useFrameNumber ? xv : formatTimestampTick(xv, fps),
        ),
      );
      // Small tick mark
      children.push(
        h("line", {
          key: "xt-" + xi,
          x1: xScale(xv),
          y1: MARGIN.top + plotHeight,
          x2: xScale(xv),
          y2: MARGIN.top + plotHeight + 5,
          stroke: "#404040",
          strokeWidth: 1,
        }),
      );
    }

    // Axis lines
    children.push(
      h("line", {
        key: "xaxis",
        x1: MARGIN.left,
        y1: MARGIN.top + plotHeight,
        x2: width - MARGIN.right,
        y2: MARGIN.top + plotHeight,
        stroke: "#404040",
        strokeWidth: 1,
      }),
    );
    children.push(
      h("line", {
        key: "yaxis",
        x1: MARGIN.left,
        y1: MARGIN.top,
        x2: MARGIN.left,
        y2: MARGIN.top + plotHeight,
        stroke: "#404040",
        strokeWidth: 1,
      }),
    );

    // Area fill under line
    if (frames.length > 1) {
      var areaD = "M " + xScale(frames[0]) + "," + (MARGIN.top + plotHeight);
      for (var ai = 0; ai < frames.length; ai++) {
        areaD += " L " + xScale(frames[ai]) + "," + yScale(counts[ai]);
      }
      areaD +=
        " L " +
        xScale(frames[frames.length - 1]) +
        "," +
        (MARGIN.top + plotHeight) +
        " Z";
      children.push(
        h("path", {
          key: "area",
          d: areaD,
          fill: "rgba(255, 109, 4, 0.10)",
        }),
      );
    }

    // Data line
    if (frames.length > 0) {
      var pts = "";
      for (var li = 0; li < frames.length; li++) {
        if (li > 0) pts += " ";
        pts += xScale(frames[li]) + "," + yScale(counts[li]);
      }
      children.push(
        h("polyline", {
          key: "line",
          points: pts,
          fill: "none",
          stroke: "#FF6D04",
          strokeWidth: 1.5,
          strokeLinejoin: "round",
          strokeLinecap: "round",
        }),
      );
    }

    // Current frame indicator
    if (currentFrame >= 1 && currentFrame <= totalFrames) {
      var cx = xScale(currentFrame);

      // Vertical line
      children.push(
        h("line", {
          key: "vline",
          x1: cx,
          y1: MARGIN.top,
          x2: cx,
          y2: MARGIN.top + plotHeight,
          stroke: "#86B5F6",
          strokeWidth: 2,
          opacity: 0.85,
        }),
      );

      // Frame label above chart
      children.push(
        h(
          "text",
          {
            key: "vlabel",
            x: cx,
            y: MARGIN.top - 10,
            fill: "#86B5F6",
            fontSize: 14,
            fontWeight: "bold",
            textAnchor: "middle",
            fontFamily: "monospace",
          },
          useFrameNumber ? "Frame " + currentFrame : formatTimestamp(currentFrame, fps),
        ),
      );

      // Dot at data point (if frame exists in data)
      var dataIdx = -1;
      for (var di = 0; di < frames.length; di++) {
        if (frames[di] === currentFrame) {
          dataIdx = di;
          break;
        }
      }
      if (dataIdx >= 0) {
        children.push(
          h("circle", {
            key: "vdot",
            cx: cx,
            cy: yScale(counts[dataIdx]),
            r: 5,
            fill: "#86B5F6",
            stroke: "#FFF9F5",
            strokeWidth: 2,
          }),
        );
        // Count label next to dot
        children.push(
          h(
            "text",
            {
              key: "vcount",
              x: cx + 10,
              y: yScale(counts[dataIdx]) - 8,
              fill: "#86B5F6",
              fontSize: 12,
              fontWeight: "bold",
              fontFamily: "monospace",
            },
            String(counts[dataIdx]),
          ),
        );
      }
    }

    // Y axis title
    children.push(
      h(
        "text",
        {
          key: "ytitle",
          x: 16,
          y: CHART_HEIGHT / 2,
          fill: "#6E6C6A",
          fontSize: 14,
          textAnchor: "middle",
          transform: "rotate(-90, 16, " + CHART_HEIGHT / 2 + ")",
          fontFamily: "sans-serif",
        },
        yAxisTitle,
      ),
    );

    // X axis title
    children.push(
      h(
        "text",
        {
          key: "xtitle",
          x: width / 2,
          y: CHART_HEIGHT - 5,
          fill: "#6E6C6A",
          fontSize: 14,
          textAnchor: "middle",
          fontFamily: "sans-serif",
        },
        useFrameNumber ? "Frame Number" : "Time",
      ),
    );

    // Transparent overlay for click/drag — on top of everything
    children.push(
      h("rect", {
        key: "overlay",
        x: MARGIN.left,
        y: MARGIN.top,
        width: plotWidth,
        height: plotHeight,
        fill: "transparent",
        cursor: "crosshair",
        onMouseDown: handleMouseDown,
      }),
    );

    return h(
      "svg",
      {
        ref: svgRef,
        width: width,
        height: CHART_HEIGHT,
        style: { display: "block", userSelect: "none" },
      },
      children,
    );
  }

  // ==========================================================
  // Component: LabelTimelineChart
  // Swim lane heatmap showing per-label detection counts.
  // ==========================================================
  function LabelTimelineChart(props) {
    var frames = props.frames;
    var labels = props.labels;
    var timeline = props.timeline;
    var colorKeyMap = props.colorKeyMap || null; // maps label → color key (for instance tracks)
    var currentFrame = props.currentFrame;
    var totalFrames = props.totalFrames;
    var onFrameSeek = props.onFrameSeek;
    var width = props.width;
    var useFrameNumber = props.useFrameNumber !== false;
    var fps = props.fps || 30;

    var _expanded = useState(false);
    var expanded = _expanded[0];
    var setExpanded = _expanded[1];

    var _hoverInfo = useState(null);
    var hoverInfo = _hoverInfo[0];
    var setHoverInfo = _hoverInfo[1];

    // Label filter: null = show all, array = selected labels
    var _labelFilter = useState(null);
    var labelFilter = _labelFilter[0];
    var setLabelFilter = _labelFilter[1];

    // Filter dropdown open state
    var _filterOpen = useState(false);
    var filterOpen = _filterOpen[0];
    var setFilterOpen = _filterOpen[1];

    var svgRef = useRef(null);
    var wrapRef = useRef(null);
    var filterBtnRef = useRef(null);

    if (!labels || labels.length === 0) {
      return h(
        Box,
        {
          sx: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: 200,
            bgcolor: "#18191A",
          },
        },
        h(Typography, { sx: { color: "#8F8D8B" } }, "No label data available"),
      );
    }

    // Toggle a label in the filter
    var handleFilterToggle = function (label) {
      setLabelFilter(function (prev) {
        if (!prev) {
          // Currently showing all → show all except this one
          return labels.filter(function (l) { return l !== label; });
        }
        var idx = prev.indexOf(label);
        if (idx >= 0) {
          var next = prev.filter(function (l) { return l !== label; });
          return next.length === 0 || next.length === labels.length ? null : next;
        }
        return prev.concat([label]);
      });
    };

    var filteredLabels = labelFilter
      ? labels.filter(function (l) { return labelFilter.indexOf(l) >= 0; })
      : labels;
    var visibleLabels = expanded ? filteredLabels : filteredLabels.slice(0, LT_DEFAULT_MAX_LABELS);
    var hiddenCount = filteredLabels.length - LT_DEFAULT_MAX_LABELS;
    var showExpander = !expanded && hiddenCount > 0;
    var showCollapser = expanded && filteredLabels.length > LT_DEFAULT_MAX_LABELS;

    var plotWidth = width - LT_MARGIN.left - LT_MARGIN.right;
    var heatmapHeight = visibleLabels.length * (LT_ROW_HEIGHT + LT_ROW_GAP);
    var expanderHeight = (showExpander || showCollapser) ? 24 : 0;
    var chartHeight = LT_MARGIN.top + heatmapHeight + expanderHeight + LT_MARGIN.bottom;

    if (plotWidth <= 0) return null;

    // Find per-label max count for opacity scaling
    // Each label is scaled against its own peak, so every row
    // independently shows where that label is most/least active
    var labelMax = {};
    for (var li = 0; li < visibleLabels.length; li++) {
      var lm = 1;
      var arr = timeline[visibleLabels[li]];
      if (arr) {
        for (var fi = 0; fi < arr.length; fi++) {
          if (arr[fi] > lm) lm = arr[fi];
        }
      }
      labelMax[visibleLabels[li]] = lm;
    }

    // Frame binning: when plotWidth / totalFrames < 2px
    var binSize = 1;
    var binnedFrameCount = frames.length;
    if (frames.length > 0 && plotWidth / frames.length < 2) {
      binSize = Math.ceil(frames.length / (plotWidth / 2));
      binnedFrameCount = Math.ceil(frames.length / binSize);
    }

    // Bin timeline data if needed
    var displayTimeline = timeline;
    if (binSize > 1) {
      displayTimeline = {};
      for (var bi = 0; bi < visibleLabels.length; bi++) {
        var lbl = visibleLabels[bi];
        var src = timeline[lbl] || [];
        var binned = [];
        for (var bj = 0; bj < src.length; bj += binSize) {
          var maxVal = 0;
          for (var bk = bj; bk < Math.min(bj + binSize, src.length); bk++) {
            if (src[bk] > maxVal) maxVal = src[bk];
          }
          binned.push(maxVal);
        }
        displayTimeline[lbl] = binned;
      }
    }

    var cellWidth = plotWidth / binnedFrameCount;

    // Scale function
    var xScale = function (frame) {
      return LT_MARGIN.left + ((frame - 1) / Math.max(totalFrames - 1, 1)) * plotWidth;
    };

    var frameFromMouseX = function (clientX, svgEl) {
      var rect = svgEl.getBoundingClientRect();
      var clickX = clientX - rect.left;
      if (clickX < LT_MARGIN.left) clickX = LT_MARGIN.left;
      if (clickX > width - LT_MARGIN.right) clickX = width - LT_MARGIN.right;
      var fraction = (clickX - LT_MARGIN.left) / plotWidth;
      var frame = Math.round(fraction * (totalFrames - 1)) + 1;
      return Math.max(1, Math.min(totalFrames, frame));
    };

    // Mouse handlers for click + drag seeking
    var handleMouseDown = useCallback(
      function (e) {
        if (!svgRef.current) return;
        e.preventDefault();
        var frame = frameFromMouseX(e.clientX, svgRef.current);
        onFrameSeek(frame);
        var svg = svgRef.current;
        var onMove = function (ev) {
          onFrameSeek(frameFromMouseX(ev.clientX, svg));
        };
        var onUp = function () {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      },
      [onFrameSeek, totalFrames, width],
    );

    // Hover handler
    var handleHover = function (e) {
      if (!svgRef.current || !wrapRef.current) return;
      var wrapRect = wrapRef.current.getBoundingClientRect();
      var svgRect = svgRef.current.getBoundingClientRect();
      var mouseX = e.clientX - svgRect.left;
      var binIdx = Math.max(
        0,
        Math.min(binnedFrameCount - 1, Math.floor((mouseX - LT_MARGIN.left) / cellWidth)),
      );

      var entries = [];
      for (var ti = 0; ti < visibleLabels.length; ti++) {
        var hl = visibleLabels[ti];
        var val = displayTimeline[hl] ? (displayTimeline[hl][binIdx] || 0) : 0;
        if (val > 0) entries.push({ label: hl, count: val, color: labelColor(colorKeyMap ? colorKeyMap[hl] || hl : hl) });
      }

      if (entries.length === 0) {
        setHoverInfo(null);
        return;
      }

      var frameStart = binIdx * binSize + 1;
      var frameEnd = Math.min((binIdx + 1) * binSize, totalFrames);
      var hoverFrame = frameFromMouseX(e.clientX, svgRef.current);
      var frameLabel;
      if (useFrameNumber) {
        frameLabel = binSize > 1
          ? "Frames " + frameStart + "\u2013" + frameEnd
          : "Frame " + hoverFrame;
      } else {
        frameLabel = binSize > 1
          ? formatTimestampTick(frameStart, fps) + "\u2013" + formatTimestampTick(frameEnd, fps)
          : formatTimestamp(hoverFrame, fps);
      }

      setHoverInfo({
        x: e.clientX,
        y: e.clientY,
        frameLabel: frameLabel,
        entries: entries,
      });
    };

    var handleMouseLeave = function () {
      setHoverInfo(null);
    };

    // Build SVG children
    var children = [];

    // Background
    children.push(
      h("rect", {
        key: "bg",
        width: width,
        height: chartHeight,
        fill: "#18191A",
        rx: 6,
      }),
    );

    // Heatmap cells
    for (var ri = 0; ri < visibleLabels.length; ri++) {
      var lbl = visibleLabels[ri];
      var color = labelColor(colorKeyMap ? colorKeyMap[lbl] || lbl : lbl);
      var rowY = LT_MARGIN.top + ri * (LT_ROW_HEIGHT + LT_ROW_GAP);
      var vals = displayTimeline[lbl] || [];

      for (var ci = 0; ci < vals.length; ci++) {
        if (vals[ci] === 0) continue;
        var opacity = 0.2 + 0.8 * (vals[ci] / labelMax[lbl]);
        children.push(
          h("rect", {
            key: "c-" + ri + "-" + ci,
            x: LT_MARGIN.left + ci * cellWidth,
            y: rowY,
            width: Math.max(cellWidth - 0.5, 1),
            height: LT_ROW_HEIGHT,
            fill: color,
            opacity: opacity,
          }),
        );
      }

      // Color swatch
      children.push(
        h("rect", {
          key: "sw-" + ri,
          x: LT_MARGIN.left - 18,
          y: rowY + 3,
          width: 8,
          height: 8,
          fill: color,
          rx: 1,
        }),
      );

      // Label name (truncated with SVG title tooltip)
      var displayName = lbl.length > 16 ? lbl.substring(0, 15) + "\u2026" : lbl;
      children.push(
        h(
          "text",
          {
            key: "ln-" + ri,
            x: LT_MARGIN.left - 22,
            y: rowY + LT_ROW_HEIGHT / 2 + 4,
            fill: "#C1BFBD",
            fontSize: 11,
            textAnchor: "end",
            fontFamily: "monospace",
          },
          lbl.length > 16 ? h("title", null, lbl) : null,
          displayName,
        ),
      );
    }

    // Frame indicator (blue vertical line)
    if (currentFrame >= 1 && currentFrame <= totalFrames) {
      var cx = xScale(currentFrame);
      children.push(
        h("line", {
          key: "vline",
          x1: cx,
          y1: LT_MARGIN.top,
          x2: cx,
          y2: LT_MARGIN.top + heatmapHeight,
          stroke: "#86B5F6",
          strokeWidth: 2,
          opacity: 0.85,
        }),
      );
      children.push(
        h(
          "text",
          {
            key: "vlabel",
            x: cx,
            y: LT_MARGIN.top - 10,
            fill: "#86B5F6",
            fontSize: 14,
            fontWeight: "bold",
            textAnchor: "middle",
            fontFamily: "monospace",
          },
          useFrameNumber ? "Frame " + currentFrame : formatTimestamp(currentFrame, fps),
        ),
      );
    }

    // X axis ticks
    var xTickStep = Math.max(1, Math.floor(totalFrames / 6));
    var xAxisY = LT_MARGIN.top + heatmapHeight + expanderHeight;
    var xTicks = [];
    for (var xt = 1; xt <= totalFrames; xt += xTickStep) xTicks.push(xt);
    if (xTicks[xTicks.length - 1] !== totalFrames) xTicks.push(totalFrames);
    for (var xi = 0; xi < xTicks.length; xi++) {
      children.push(
        h(
          "text",
          {
            key: "xl-" + xi,
            x: xScale(xTicks[xi]),
            y: xAxisY + 16,
            fill: "#8F8D8B",
            fontSize: 11,
            textAnchor: "middle",
            fontFamily: "monospace",
          },
          useFrameNumber ? xTicks[xi] : formatTimestampTick(xTicks[xi], fps),
        ),
      );
    }

    // "Show N more…" expander / "Show less" collapser
    if (showExpander) {
      children.push(
        h(
          "text",
          {
            key: "expander",
            x: width / 2,
            y: LT_MARGIN.top + heatmapHeight + 18,
            fill: "#4FC3F7",
            fontSize: 12,
            textAnchor: "middle",
            fontFamily: "sans-serif",
            cursor: "pointer",
            onClick: function () {
              setExpanded(true);
            },
          },
          "Show " + hiddenCount + " more\u2026 \u25BC",
        ),
      );
    } else if (showCollapser) {
      children.push(
        h(
          "text",
          {
            key: "collapser",
            x: width / 2,
            y: LT_MARGIN.top + heatmapHeight + 18,
            fill: "#4FC3F7",
            fontSize: 12,
            textAnchor: "middle",
            fontFamily: "sans-serif",
            cursor: "pointer",
            onClick: function () {
              setExpanded(false);
            },
          },
          "Show less \u25B2",
        ),
      );
    }

    // Transparent overlay for click/drag + hover
    children.push(
      h("rect", {
        key: "overlay",
        x: LT_MARGIN.left,
        y: LT_MARGIN.top,
        width: plotWidth,
        height: heatmapHeight,
        fill: "transparent",
        cursor: "crosshair",
        onMouseDown: handleMouseDown,
        onMouseMove: handleHover,
        onMouseLeave: handleMouseLeave,
      }),
    );

    // Tooltip — rendered via portal to body so it floats above all charts
    var tooltip = null;
    if (hoverInfo) {
      var tipEl = h(
        "div",
        {
          style: {
            position: "fixed",
            left: hoverInfo.x + 12 + "px",
            top: hoverInfo.y - 10 + "px",
            backgroundColor: "rgba(0,0,0,0.92)",
            border: "1px solid #404040",
            borderRadius: "4px",
            padding: "6px 10px",
            pointerEvents: "none",
            zIndex: 99999,
            whiteSpace: "nowrap",
          },
        },
        h(
          "div",
          {
            style: {
              color: "#86B5F6",
              fontSize: "12px",
              fontFamily: "monospace",
              marginBottom: "4px",
            },
          },
          hoverInfo.frameLabel,
        ),
        hoverInfo.entries.map(function (entry, i) {
          return h(
            "div",
            {
              key: i,
              style: {
                display: "flex",
                alignItems: "center",
                gap: "6px",
                fontSize: "11px",
                fontFamily: "monospace",
              },
            },
            h("span", {
              style: {
                display: "inline-block",
                width: "8px",
                height: "8px",
                backgroundColor: entry.color,
                borderRadius: "1px",
                flexShrink: 0,
              },
            }),
            h(
              "span",
              { style: { color: "#C1BFBD" } },
              entry.count + "\u00D7 " + entry.label,
            ),
          );
        }),
      );
      tooltip = window.ReactDOM.createPortal(tipEl, document.body);
    }

    // Filter bar
    var filterBar = h(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 8px",
          backgroundColor: "#111213",
          borderBottom: "1px solid #2A2A2A",
        },
      },
      h(
        "button",
        {
          ref: filterBtnRef,
          onClick: function () { setFilterOpen(function (v) { return !v; }); },
          style: {
            background: labelFilter ? "#1A2A3A" : "none",
            border: labelFilter ? "1px solid #4FC3F7" : "1px solid #404040",
            color: labelFilter ? "#4FC3F7" : "#8F8D8B",
            cursor: "pointer",
            padding: "2px 8px",
            fontSize: "11px",
            borderRadius: "3px",
            fontFamily: "sans-serif",
          },
        },
        "\u25BC Filter labels" + (labelFilter ? " (" + labelFilter.length + "/" + labels.length + ")" : ""),
      ),
      labelFilter
        ? h(
            "button",
            {
              onClick: function () { setLabelFilter(null); },
              style: {
                background: "none",
                border: "none",
                color: "#4FC3F7",
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: "11px",
                fontFamily: "sans-serif",
              },
            },
            "Show all",
          )
        : null,
    );

    // Dropdown panel — rendered via portal to overlay other charts
    var filterDropdown = null;
    if (filterOpen && filterBtnRef.current) {
      var btnRect = filterBtnRef.current.getBoundingClientRect();
      filterDropdown = window.ReactDOM.createPortal(
        h(
          "div",
          {
            style: {
              position: "fixed",
              top: btnRect.bottom + 2 + "px",
              left: btnRect.left + "px",
              zIndex: 99999,
              backgroundColor: "#1E1F20",
              border: "1px solid #404040",
              borderRadius: "4px",
              padding: "6px 0",
              maxHeight: "300px",
              overflowY: "auto",
              minWidth: "220px",
              boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
            },
          },
          // Select all / Clear all
          h(
            "div",
            {
              style: {
                display: "flex",
                gap: "12px",
                padding: "2px 12px 6px",
                borderBottom: "1px solid #333",
                marginBottom: "4px",
              },
            },
            h(
              "span",
              {
                onClick: function () { setLabelFilter(null); },
                style: { color: "#4FC3F7", fontSize: "11px", cursor: "pointer", fontFamily: "sans-serif" },
              },
              "Select all",
            ),
            h(
              "span",
              {
                onClick: function () { setLabelFilter([]); },
                style: { color: "#4FC3F7", fontSize: "11px", cursor: "pointer", fontFamily: "sans-serif" },
              },
              "Clear all",
            ),
          ),
          // Label checkboxes
          labels.map(function (lbl) {
            var isChecked = !labelFilter || labelFilter.indexOf(lbl) >= 0;
            return h(
              "label",
              {
                key: lbl,
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "3px 12px",
                  cursor: "pointer",
                  fontSize: "11px",
                  fontFamily: "monospace",
                  color: isChecked ? "#C1BFBD" : "#666",
                },
                onMouseEnter: function (e) { e.currentTarget.style.backgroundColor = "#2A2A2A"; },
                onMouseLeave: function (e) { e.currentTarget.style.backgroundColor = "transparent"; },
              },
              h("input", {
                type: "checkbox",
                checked: isChecked,
                onChange: function () { handleFilterToggle(lbl); },
                style: { accentColor: labelColor(colorKeyMap ? colorKeyMap[lbl] || lbl : lbl), cursor: "pointer" },
              }),
              h("span", {
                style: {
                  display: "inline-block",
                  width: "8px",
                  height: "8px",
                  backgroundColor: labelColor(colorKeyMap ? colorKeyMap[lbl] || lbl : lbl),
                  borderRadius: "1px",
                  flexShrink: 0,
                  opacity: isChecked ? 1 : 0.3,
                },
              }),
              lbl,
            );
          }),
        ),
        document.body,
      );
    }

    return h(
      "div",
      { ref: wrapRef, style: { position: "relative" } },
      filterBar,
      h(
        "svg",
        {
          ref: svgRef,
          width: width,
          height: chartHeight,
          style: { display: "block", userSelect: "none" },
        },
        children,
      ),
      tooltip,
      filterDropdown,
    );
  }

  // ==========================================================
  // Component: ChartCard
  // Wraps a single chart with header (label + action buttons)
  // and handles loading/error/data states.
  // ==========================================================
  var CARD_BTN_STYLE = {
    background: "none",
    border: "none",
    color: "#8F8D8B",
    cursor: "pointer",
    padding: "2px 6px",
    fontSize: "12px",
    lineHeight: "1",
    borderRadius: "3px",
    fontFamily: "sans-serif",
  };

  function ChartCard(props) {
    var field = props.field;
    var chartType = props.chartType || "count";
    var label = props.label;
    var data = props.data;
    var loading = props.loading;
    var error = props.error;
    var chartIndex = props.chartIndex;
    var totalCharts = props.totalCharts;
    var onRemove = props.onRemove;
    var onMoveUp = props.onMoveUp;
    var onMoveDown = props.onMoveDown;
    var currentFrame = props.currentFrame;
    var totalFrames = props.totalFrames;
    var onFrameSeek = props.onFrameSeek;
    var width = props.width;
    var useFrameNumber = props.useFrameNumber !== false;
    var fps = props.fps || 30;

    var placeholderHeight = chartType === "labels" ? 200 : CHART_HEIGHT;

    var body;
    if (loading) {
      body = h(
        Box,
        {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: placeholderHeight,
            bgcolor: "#18191A",
            gap: 1,
          },
        },
        h(CircularProgress, { size: 28, sx: { color: "#FF6D04" } }),
        h(
          Typography,
          { variant: "body2", sx: { color: "#8F8D8B" } },
          "Loading " + field + "\u2026",
        ),
      );
    } else if (error) {
      body = h(
        Box,
        {
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: placeholderHeight,
            bgcolor: "#18191A",
            gap: 1,
          },
        },
        h(
          Typography,
          { sx: { color: "#FF6767", fontSize: "13px" } },
          "Error: " + error,
        ),
      );
    } else if (chartType === "tracks" && data && data.tracks) {
      body = h(LabelTimelineChart, {
        frames: data.frames,
        labels: data.track_names,
        timeline: data.tracks,
        colorKeyMap: data.track_labels,
        currentFrame: currentFrame,
        totalFrames: totalFrames,
        onFrameSeek: onFrameSeek,
        width: width,
        useFrameNumber: useFrameNumber,
        fps: fps,
      });
    } else if (chartType === "labels" && data && data.timeline) {
      body = h(LabelTimelineChart, {
        frames: data.frames,
        labels: data.labels,
        timeline: data.timeline,
        currentFrame: currentFrame,
        totalFrames: totalFrames,
        onFrameSeek: onFrameSeek,
        width: width,
        useFrameNumber: useFrameNumber,
        fps: fps,
      });
    } else if (data && data.frames && data.frames.length > 0) {
      body = h(SVGChart, {
        frames: data.frames,
        counts: data.counts,
        currentFrame: currentFrame,
        totalFrames: totalFrames,
        onFrameSeek: onFrameSeek,
        width: width,
        yAxisTitle: label,
        useFrameNumber: useFrameNumber,
        fps: fps,
      });
    } else {
      body = h(
        Box,
        {
          sx: {
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: placeholderHeight,
            bgcolor: "#18191A",
          },
        },
        h(
          Typography,
          { sx: { color: "#8F8D8B" } },
          "No data available for this field",
        ),
      );
    }

    return h(
      "div",
      {
        style: {
          marginBottom: "4px",
          borderRadius: "6px",
          overflow: "hidden",
          backgroundColor: "#18191A",
        },
      },
      // Header bar
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            backgroundColor: "#111213",
            borderBottom: "1px solid #2A2A2A",
          },
        },
        h(
          "span",
          {
            style: {
              color: "#C1BFBD",
              fontSize: "12px",
              fontFamily: "monospace",
            },
          },
          label,
        ),
        h(
          "div",
          { style: { display: "flex", gap: "2px" } },
          // Move up
          h(
            "button",
            {
              onClick: function () { onMoveUp(chartIndex); },
              disabled: chartIndex === 0,
              style: Object.assign(
                {},
                CARD_BTN_STYLE,
                chartIndex === 0 ? { opacity: 0.3, cursor: "default" } : {},
              ),
              title: "Move up",
            },
            "\u25B2",
          ),
          // Move down
          h(
            "button",
            {
              onClick: function () { onMoveDown(chartIndex); },
              disabled: chartIndex === totalCharts - 1,
              style: Object.assign(
                {},
                CARD_BTN_STYLE,
                chartIndex === totalCharts - 1 ? { opacity: 0.3, cursor: "default" } : {},
              ),
              title: "Move down",
            },
            "\u25BC",
          ),
          // Remove
          h(
            "button",
            {
              onClick: function () { onRemove(chartIndex); },
              style: Object.assign({}, CARD_BTN_STYLE, { color: "#FF6767" }),
              title: "Remove chart",
            },
            "\u2715",
          ),
        ),
      ),
      // Body
      body,
    );
  }

  // ==========================================================
  // Main Panel Component
  // ==========================================================
  function DetectionCountPlotPanel() {
    // --- Multi-chart state ---
    var _charts = useState([]);
    var charts = _charts[0];
    var setCharts = _charts[1];

    var _chartStatus = useState({});
    var chartStatus = _chartStatus[0];
    var setChartStatus = _chartStatus[1];

    var dataStoreRef = useRef({});

    // --- Load queue ---
    var loadQueueRef = useRef([]);
    var loadingFieldRef = useRef(null);
    var processedResultRef = useRef(null);
    var nextIdRef = useRef(1);
    var datasetNameRef = useRef("");

    // --- Field discovery state ---
    var _fields = useState([]);
    var fields = _fields[0];
    var setFields = _fields[1];

    var _fieldsLoading = useState(true);
    var fieldsLoading = _fieldsLoading[0];
    var setFieldsLoading = _fieldsLoading[1];

    var _width = useState(800);
    var containerWidth = _width[0];
    var setContainerWidth = _width[1];

    var containerRef = useRef(null);
    var prevSampleRef = useRef(null);

    // --- Recoil state ---
    var modalSampleId;
    try {
      modalSampleId = useRecoilValue(fos.modalSampleId);
    } catch (e) {
      console.warn(LOG_PREFIX, "fos.modalSampleId failed, trying fallback", e);
      modalSampleId = null;
    }

    // --- Carousel navigation: set modal sample to navigate carousel ---
    var setModalSample = useSetRecoilState(fos.modalSelector);

    // --- Video state ---
    // Read "Use frame number" setting — combines app config default with
    // runtime checkbox override from savedLookerOptions (same merge logic
    // as FiftyOne's lookerOptions selector in looker.ts)
    var useFrameNumberSetting = true;
    try {
      var configVal = useFrameNumberSelector
        ? useRecoilValue(useFrameNumberSelector)
        : true;
      var savedOpts = fos.savedLookerOptions
        ? useRecoilValue(fos.savedLookerOptions)
        : {};
      useFrameNumberSetting = (savedOpts && savedOpts.useFrameNumber !== undefined)
        ? savedOpts.useFrameNumber
        : configVal;
    } catch (e) {
      // Fallback: default to frame numbers if atoms not available
    }

    var videoState = useVideoState();
    var frameNumber = videoState.frameNumber;
    var playing = videoState.playing;
    var modalLooker = videoState.modalLooker;
    var isImaVid = videoState.isImaVid;
    var isDynamicGroup = videoState.isDynamicGroup;
    var isCarousel = videoState.isCarousel;
    var setDynamicGroupIndex = videoState.setDynamicGroupIndex;
    var setImaVidFrameNumber = videoState.setImaVidFrameNumber;

    // --- Carousel mode state ---
    var _carouselFrame = useState(1);
    var carouselFrame = _carouselFrame[0];
    var setCarouselFrame = _carouselFrame[1];
    var sampleIdToFrame = useRef(null);
    var frameToSampleId = useRef(null);

    // --- Operator executors ---
    var fieldsExecutor = null;
    var dataExecutor = null;
    if (foo && typeof foo.useOperatorExecutor === "function") {
      fieldsExecutor = foo.useOperatorExecutor(
        "temporal-detection/get_temporal_fields",
      );
      dataExecutor = foo.useOperatorExecutor(
        "temporal-detection/get_frame_values",
      );
    } else {
      console.error(
        LOG_PREFIX,
        "foo.useOperatorExecutor not available — cannot load data",
      );
    }

    // --- Process queue: load fields one at a time ---
    var processQueue = function () {
      if (loadingFieldRef.current) return;
      if (loadQueueRef.current.length === 0) return;
      if (!dataExecutor || !modalSampleId) return;

      var entry = loadQueueRef.current.shift();
      var key = chartKey(entry.field, entry.type);
      loadingFieldRef.current = key;

      setChartStatus(function (prev) {
        var next = Object.assign({}, prev);
        next[key] = { loading: true, error: null };
        return next;
      });

      console.log(LOG_PREFIX, "Loading field", entry.field, "mode", entry.type);
      dataExecutor.execute({
        sample_id: modalSampleId,
        field: entry.field,
        mode: entry.type || "count",
      });
    };
    var processQueueRef = useRef(processQueue);
    processQueueRef.current = processQueue;

    // --- Dynamic group guard ---
    var groupDataLoadedRef = useRef(false);

    // --- Load fields when sample changes ---
    useEffect(
      function () {
        if (!modalSampleId || !fieldsExecutor) return;

        // Dynamic group: only load once; subsequent sample changes are
        // from chart-click navigation within the same group.
        if (isDynamicGroup && groupDataLoadedRef.current) return;

        if (modalSampleId === prevSampleRef.current) return;
        prevSampleRef.current = modalSampleId;

        setFieldsLoading(true);

        // Clear data cache and queue
        dataStoreRef.current = {};
        sampleIdToFrame.current = null;
        frameToSampleId.current = null;
        loadQueueRef.current = [];
        loadingFieldRef.current = null;
        processedResultRef.current = null;

        console.log(LOG_PREFIX, "Discovering fields for sample", modalSampleId);
        fieldsExecutor.execute({ sample_id: modalSampleId });
      },
      [modalSampleId],
    );

    // --- Watch fields result → initialize charts → queue data loads ---
    useEffect(
      function () {
        if (!fieldsExecutor) return;
        if (fieldsExecutor.isExecuting) return;

        if (fieldsExecutor.error) {
          setFieldsLoading(false);
          return;
        }

        var result = fieldsExecutor.result;
        if (!result) return;

        var payload = result.result || result;

        if (payload.error) {
          setFieldsLoading(false);
          return;
        }

        if (!payload.fields || payload.fields.length === 0) {
          setFields([]);
          setFieldsLoading(false);
          return;
        }

        setFields(payload.fields);
        setFieldsLoading(false);

        // Store dataset name for localStorage key
        if (payload.dataset_name) {
          datasetNameRef.current = payload.dataset_name;
        }

        var availablePaths = payload.fields.map(function (f) { return f.path; });
        var initialEntries = null;

        // 1. If we already have charts (sample change), keep them filtered
        if (charts.length > 0) {
          var surviving = charts.filter(function (c) {
            return availablePaths.indexOf(c.field) >= 0;
          });
          if (surviving.length > 0) {
            initialEntries = surviving.map(function (c) {
              return { field: c.field, type: c.type || "count" };
            });
          }
        }

        // 2. Try localStorage
        if (!initialEntries) {
          var saved = loadChartFields(datasetNameRef.current);
          if (saved && saved.length > 0) {
            var valid = saved.filter(function (e) {
              return availablePaths.indexOf(e.field) >= 0;
            });
            if (valid.length > 0) {
              initialEntries = valid;
            }
          }
        }

        // 3. Default: prefer labels type for first label-capable field
        if (!initialEntries) {
          var defaultEntry = null;
          for (var i = 0; i < payload.fields.length; i++) {
            if (payload.fields[i].path === "detections.detections" && payload.fields[i].has_labels) {
              defaultEntry = { field: "detections.detections", type: "labels" };
              break;
            }
          }
          if (!defaultEntry) {
            for (var i = 0; i < payload.fields.length; i++) {
              if (payload.fields[i].has_labels) {
                defaultEntry = { field: payload.fields[i].path, type: "labels" };
                break;
              }
            }
          }
          if (!defaultEntry) {
            defaultEntry = { field: payload.fields[0].path, type: "count" };
          }
          initialEntries = [defaultEntry];
        }

        // Create chart entries
        nextIdRef.current = 1;
        var newCharts = initialEntries.map(function (e) {
          return { id: nextIdRef.current++, field: e.field, type: e.type || "count" };
        });
        setCharts(newCharts);

        // Initialize status and queue all for loading
        var statusInit = {};
        for (var si = 0; si < initialEntries.length; si++) {
          var sKey = chartKey(initialEntries[si].field, initialEntries[si].type);
          statusInit[sKey] = { loading: true, error: null };
        }
        setChartStatus(statusInit);

        loadQueueRef.current = initialEntries.map(function (e) {
          return { field: e.field, type: e.type || "count" };
        });
        setTimeout(function () {
          processQueueRef.current();
        }, 0);
      },
      [
        fieldsExecutor && fieldsExecutor.isExecuting,
        fieldsExecutor && fieldsExecutor.result,
      ],
    );

    // --- Watch data result → stash in cache → advance queue ---
    useEffect(
      function () {
        if (!dataExecutor) return;
        if (dataExecutor.isExecuting) return;

        var result = dataExecutor.result;
        if (!result || result === processedResultRef.current) return;
        processedResultRef.current = result;

        var key = loadingFieldRef.current;
        if (!key) return;

        var payload = result.result || result;
        var stashOk = false;

        if (dataExecutor.error) {
          setChartStatus(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { loading: false, error: String(dataExecutor.error) };
            return next;
          });
        } else if (payload.error) {
          setChartStatus(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { loading: false, error: payload.error };
            return next;
          });
        } else if (payload.tracks) {
          // Instance track data
          dataStoreRef.current[key] = {
            frames: payload.frames,
            track_names: payload.track_names,
            tracks: payload.tracks,
            track_labels: payload.track_labels,
            fps: payload.fps,
            total_frames: payload.total_frames,
          };
          stashOk = true;
          console.log(LOG_PREFIX, "Loaded", payload.track_names.length, "instance tracks for", key);
        } else if (payload.timeline) {
          // Label timeline data
          dataStoreRef.current[key] = {
            frames: payload.frames,
            labels: payload.labels,
            timeline: payload.timeline,
            fps: payload.fps,
            total_frames: payload.total_frames,
          };
          stashOk = true;
          console.log(LOG_PREFIX, "Loaded label timeline for", key);
        } else if (payload.frames && payload.values) {
          // Count data
          dataStoreRef.current[key] = {
            frames: payload.frames,
            counts: payload.values,
            fps: payload.fps,
            total_frames: payload.total_frames,
          };
          stashOk = true;
          console.log(LOG_PREFIX, "Loaded", payload.frames.length, "frames for", key);
        }

        if (stashOk) {
          // Build sample ID ↔ frame number mappings (from first chart with sample_ids)
          if (
            payload.sample_ids &&
            payload.sample_ids.length > 0 &&
            !sampleIdToFrame.current
          ) {
            var s2f = {};
            var f2s = {};
            for (var mi = 0; mi < payload.sample_ids.length; mi++) {
              var mFrame = payload.frames[mi] || mi + 1;
              s2f[payload.sample_ids[mi]] = mFrame;
              f2s[mFrame] = payload.sample_ids[mi];
            }
            sampleIdToFrame.current = s2f;
            frameToSampleId.current = f2s;
            if (isCarousel && modalSampleId && s2f[modalSampleId]) {
              setCarouselFrame(s2f[modalSampleId]);
            }
          }

          if (isDynamicGroup) {
            groupDataLoadedRef.current = true;
          }

          setChartStatus(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { loading: false, error: null };
            return next;
          });
        }

        loadingFieldRef.current = null;

        // Process next in queue
        setTimeout(function () {
          processQueueRef.current();
        }, 0);
      },
      [
        dataExecutor && dataExecutor.isExecuting,
        dataExecutor && dataExecutor.result,
      ],
    );

    // --- Carousel → Chart sync: watch modalSampleId changes ---
    useEffect(
      function () {
        if (!isCarousel || !modalSampleId || !sampleIdToFrame.current) return;
        var frame = sampleIdToFrame.current[modalSampleId];
        if (frame !== undefined) {
          setCarouselFrame(frame);
        }
      },
      [modalSampleId, isCarousel],
    );

    // --- Container resize ---
    useEffect(function () {
      if (!containerRef.current) return;
      var obs = new ResizeObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          setContainerWidth(entries[i].contentRect.width);
        }
      });
      obs.observe(containerRef.current);
      return function () {
        obs.disconnect();
      };
    }, []);

    // --- Save charts to localStorage when they change ---
    useEffect(
      function () {
        if (datasetNameRef.current) {
          saveChartFields(datasetNameRef.current, charts);
        }
      },
      [charts],
    );

    // --- Add chart handler ---
    var handleAddChart = useCallback(
      function (e) {
        var rawValue = e.target.value;
        if (!rawValue) return;
        e.target.value = "";

        var lastColon = rawValue.lastIndexOf(":");
        var newField = rawValue.substring(0, lastColon);
        var newType = rawValue.substring(lastColon + 1);
        var key = chartKey(newField, newType);

        setCharts(function (prev) {
          return prev.concat([{ id: nextIdRef.current++, field: newField, type: newType }]);
        });

        if (dataStoreRef.current[key]) {
          // Already cached — mark as loaded
          setChartStatus(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { loading: false, error: null };
            return next;
          });
        } else {
          // Queue for loading
          loadQueueRef.current.push({ field: newField, type: newType });
          setChartStatus(function (prev) {
            var next = Object.assign({}, prev);
            next[key] = { loading: true, error: null };
            return next;
          });
          setTimeout(function () {
            processQueueRef.current();
          }, 0);
        }
      },
      [],
    );

    // --- Remove chart handler ---
    var handleRemoveChart = useCallback(function (index) {
      setCharts(function (prev) {
        return prev.filter(function (_, i) {
          return i !== index;
        });
      });
    }, []);

    // --- Move handlers ---
    var handleMoveUp = useCallback(function (index) {
      if (index <= 0) return;
      setCharts(function (prev) {
        var next = prev.slice();
        var temp = next[index - 1];
        next[index - 1] = next[index];
        next[index] = temp;
        return next;
      });
    }, []);

    var handleMoveDown = useCallback(function (index) {
      setCharts(function (prev) {
        if (index >= prev.length - 1) return prev;
        var next = prev.slice();
        var temp = next[index + 1];
        next[index + 1] = next[index];
        next[index] = temp;
        return next;
      });
    }, []);

    // --- Chart → Video seeking ---
    var fpsForSeek = 30;
    for (var fi = 0; fi < charts.length; fi++) {
      var fData = dataStoreRef.current[chartKey(charts[fi].field, charts[fi].type)];
      if (fData) {
        fpsForSeek = fData.fps || 30;
        break;
      }
    }

    var handleFrameSeek = useCallback(
      function (frame) {
        if (isDynamicGroup && isImaVid) {
          // Video mode: dispatch timeline event (handles canvas, jotai atoms, and resume point)
          seekImaVidToFrame(frame);
        } else if (isCarousel) {
          // Carousel mode: navigate via modalSelector
          var targetSampleId =
            frameToSampleId.current && frameToSampleId.current[frame];
          if (targetSampleId && setModalSample) {
            setModalSample(function (current) {
              return current
                ? Object.assign({}, current, { id: targetSampleId })
                : current;
            });
          }
          setCarouselFrame(frame);
        } else if (isDynamicGroup) {
          // Pagination mode: navigate via group element index
          setDynamicGroupIndex(frame - 1);
        } else if (isImaVid) {
          // ImaVid (non-dynamic-group)
          seekImaVidToFrame(frame);
        } else {
          // Native video
          seekVideoToFrame(frame, modalLooker, fpsForSeek);
        }
      },
      [isDynamicGroup, isCarousel, isImaVid, setDynamicGroupIndex, setModalSample, modalLooker, fpsForSeek],
    );

    // --- Derive display info from first loaded chart ---
    var firstData = null;
    var statusTotalFrames = 0;
    for (var di = 0; di < charts.length; di++) {
      var dd = dataStoreRef.current[chartKey(charts[di].field, charts[di].type)];
      if (dd) {
        firstData = dd;
        statusTotalFrames = dd.total_frames || dd.frames.length;
        break;
      }
    }
    var effectiveFrame = isCarousel ? carouselFrame : frameNumber;

    // --- Render: Field discovery loading ---
    if (fieldsLoading) {
      return h(
        Box,
        {
          ref: containerRef,
          sx: {
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: CHART_HEIGHT,
            bgcolor: "#18191A",
            borderRadius: 1.5,
            gap: 2,
          },
        },
        h(CircularProgress, { size: 36, sx: { color: "#FF6D04" } }),
        h(
          Typography,
          { variant: "body2", sx: { color: "#8F8D8B" } },
          "Discovering fields\u2026",
        ),
      );
    }

    // --- Render: No fields ---
    if (fields.length === 0) {
      return h(
        Box,
        {
          ref: containerRef,
          sx: {
            padding: 3,
            bgcolor: "#18191A",
            borderRadius: 1.5,
            textAlign: "center",
          },
        },
        h(
          Typography,
          { sx: { color: "#8F8D8B" } },
          "No plottable fields found for this sample",
        ),
      );
    }

    // --- Build "Add chart" options (fields not already in charts) ---
    var usedKeys = {};
    for (var ui = 0; ui < charts.length; ui++) {
      usedKeys[chartKey(charts[ui].field, charts[ui].type)] = true;
    }
    var addOptions = [];
    for (var oi = 0; oi < fields.length; oi++) {
      var af = fields[oi];
      if (af.has_labels) {
        if (!usedKeys[chartKey(af.path, "labels")]) {
          addOptions.push({ value: af.path + ":labels", label: af.path + " (labels)" });
        }
        if (af.has_tracks && !usedKeys[chartKey(af.path, "tracks")]) {
          addOptions.push({ value: af.path + ":tracks", label: af.path + " (tracks)" });
        }
        if (!usedKeys[chartKey(af.path, "count")]) {
          addOptions.push({ value: af.path + ":count", label: af.label });
        }
      } else {
        if (af.has_tracks && !usedKeys[chartKey(af.path, "tracks")]) {
          addOptions.push({ value: af.path + ":tracks", label: af.path + " (tracks)" });
        }
        if (!usedKeys[chartKey(af.path, "count")]) {
          addOptions.push({ value: af.path + ":count", label: af.label });
        }
      }
    }

    // --- Render: Multi-chart UI ---
    return h(
      Box,
      {
        ref: containerRef,
        sx: { width: "100%", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" },
      },
      // Toolbar with "Add chart" dropdown
      h(
        "div",
        {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px",
            backgroundColor: "#0D0D0D",
            borderTopLeftRadius: "6px",
            borderTopRightRadius: "6px",
          },
        },
        h(
          "select",
          {
            value: "",
            onChange: handleAddChart,
            disabled: addOptions.length === 0,
            style: {
              backgroundColor: "#18191A",
              color: "#C1BFBD",
              border: "1px solid #404040",
              borderRadius: "4px",
              padding: "4px 24px 4px 8px",
              fontSize: "12px",
              fontFamily: "monospace",
              outline: "none",
              cursor: addOptions.length > 0 ? "pointer" : "default",
              minWidth: "180px",
              appearance: "none",
              WebkitAppearance: "none",
              backgroundImage:
                "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238F8D8B'/%3E%3C/svg%3E\")",
              backgroundRepeat: "no-repeat",
              backgroundPosition: "right 8px center",
              opacity: addOptions.length === 0 ? 0.5 : 1,
            },
          },
          h(
            "option",
            { value: "" },
            addOptions.length > 0 ? "Add chart\u2026" : "All fields added",
          ),
          addOptions.map(function (opt) {
            return h("option", { key: opt.value, value: opt.value }, opt.label);
          }),
        ),
      ),
      // Scrollable chart container
      h(
        "div",
        {
          style: {
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
          },
        },
        charts.length === 0
          ? h(
              Box,
              {
                sx: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: CHART_HEIGHT,
                  bgcolor: "#18191A",
                },
              },
              h(
                Typography,
                { sx: { color: "#8F8D8B" } },
                "Add a chart to get started",
              ),
            )
          : charts.map(function (chart, idx) {
              var cKey = chartKey(chart.field, chart.type);
              var fieldData = dataStoreRef.current[cKey];
              var status = chartStatus[cKey] || { loading: true, error: null };
              var chartTotalFrames = fieldData
                ? (fieldData.total_frames || fieldData.frames.length)
                : statusTotalFrames;

              // Find label for this field
              var label = chart.field;
              for (var li = 0; li < fields.length; li++) {
                if (fields[li].path === chart.field) {
                  if (chart.type === "labels") {
                    label = chart.field + " (labels)";
                  } else if (chart.type === "tracks") {
                    label = chart.field + " (tracks)";
                  } else {
                    label = fields[li].label;
                  }
                  break;
                }
              }

              return h(ChartCard, {
                key: chart.id,
                field: chart.field,
                chartType: chart.type,
                label: label,
                data: fieldData,
                loading: status.loading,
                error: status.error,
                chartIndex: idx,
                totalCharts: charts.length,
                onRemove: handleRemoveChart,
                onMoveUp: handleMoveUp,
                onMoveDown: handleMoveDown,
                currentFrame: effectiveFrame,
                totalFrames: chartTotalFrames,
                onFrameSeek: handleFrameSeek,
                width: containerWidth,
                useFrameNumber: isDynamicGroup ? true : useFrameNumberSetting,
                fps: fpsForSeek,
              });
            }),
      ),
      // Status bar
      h(
        Box,
        {
          sx: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            px: 2,
            py: 1,
            bgcolor: "#0D0D0D",
            borderBottomLeftRadius: 6,
            borderBottomRightRadius: 6,
          },
        },
        h(
          Typography,
          { variant: "body2", sx: { color: "#8F8D8B", fontFamily: "monospace" } },
          (isDynamicGroup || useFrameNumberSetting)
            ? "Frame " + effectiveFrame + " / " + (statusTotalFrames || "?")
            : formatTimestamp(effectiveFrame, fpsForSeek) + " / " + formatTimestamp(statusTotalFrames || 1, fpsForSeek),
        ),
        h(
          Typography,
          { variant: "body2", sx: { color: "#8F8D8B", fontFamily: "monospace" } },
          (firstData ? firstData.fps : "?") +
            " FPS \u00B7 " +
            charts.length +
            (charts.length === 1 ? " chart" : " charts"),
        ),
        h(
          Typography,
          {
            variant: "body2",
            sx: {
              color: playing ? "#FF6D04" : "#8F8D8B",
              fontFamily: "monospace",
              fontWeight: playing ? "bold" : "normal",
            },
          },
          playing ? "\u25B6 Playing" : "\u23F8 Paused",
        ),
      ),
    );
  }

  // ==========================================================
  // Icon Component — line chart icon
  // ==========================================================
  var ChartIcon = memo(function ChartIcon(props) {
    var size = props.size || "1rem";
    return h(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: props.style,
      },
      h("polyline", { points: "22 12 18 12 15 21 9 3 6 12 2 12" }),
    );
  });

  // ==========================================================
  // Register Panel
  // ==========================================================
  console.log(LOG_PREFIX, "Registering TemporalDataExplorer panel");

  fop.registerComponent({
    name: "TemporalDataExplorer",
    label: "Temporal Data Explorer",
    component: DetectionCountPlotPanel,
    type: fop.PluginComponentType.Panel,
    Icon: ChartIcon,
    panelOptions: { surfaces: "modal" },
  });

  console.log(LOG_PREFIX, "Registration complete");
})();
