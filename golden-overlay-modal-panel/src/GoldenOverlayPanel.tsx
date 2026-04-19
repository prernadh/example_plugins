import React, { useState, useEffect, useRef, useCallback } from "react";
import { useOperatorExecutor } from "@fiftyone/operators";

const PLUGIN = "@voxel51/golden-overlay";

function getMediaUrl(filepath: string): string {
  return `/media?filepath=${encodeURIComponent(filepath)}`;
}

function getFilename(path: string): string {
  return path.split("/").pop() || path;
}

export default function GoldenOverlayPanel() {
  const filepathsOp = useOperatorExecutor(`${PLUGIN}/get_filepaths`);
  const currentSampleOp = useOperatorExecutor(`${PLUGIN}/get_current_sample`);

  const [filepaths, setFilepaths] = useState<string[]>([]);
  const [goldenPath, setGoldenPath] = useState("");
  const [opacity, setOpacity] = useState(50);
  const [showDiff, setShowDiff] = useState(false);
  const [currentFilepath, setCurrentFilepath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const hasTriggered = useRef(false);

  // Fire operators once on mount
  useEffect(() => {
    if (hasTriggered.current) return;
    hasTriggered.current = true;
    console.log("[GoldenOverlay] Triggering get_filepaths and get_current_sample");
    filepathsOp.execute({});
    currentSampleOp.execute({});
  }, []);

  // Watch filepathsOp.result
  useEffect(() => {
    const r = filepathsOp.result;
    console.log("[GoldenOverlay] filepathsOp.result changed:", r);
    if (r) {
      const paths = r.filepaths ?? r?.result?.filepaths;
      console.log("[GoldenOverlay] Extracted paths:", paths?.length, "items");
      if (paths) setFilepaths(paths);
      setLoading(false);
    }
  }, [filepathsOp.result]);

  // Watch currentSampleOp.result
  useEffect(() => {
    const r = currentSampleOp.result;
    console.log("[GoldenOverlay] currentSampleOp.result changed:", r);
    if (r) {
      const fp = r.filepath ?? r?.result?.filepath;
      console.log("[GoldenOverlay] Current filepath:", fp);
      if (fp) setCurrentFilepath(fp);
    }
  }, [currentSampleOp.result]);

  // Stop loading on error
  useEffect(() => {
    if (filepathsOp.error) {
      console.error("[GoldenOverlay] filepathsOp error:", filepathsOp.error);
      setLoading(false);
    }
  }, [filepathsOp.error]);

  useEffect(() => {
    if (currentSampleOp.error) {
      console.error("[GoldenOverlay] currentSampleOp error:", currentSampleOp.error);
    }
  }, [currentSampleOp.error]);

  const refreshSample = useCallback(() => {
    currentSampleOp.execute({});
  }, [currentSampleOp]);

  const currentSrc = currentFilepath ? getMediaUrl(currentFilepath) : null;
  const goldenSrc = goldenPath ? getMediaUrl(goldenPath) : null;

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff6d04" strokeWidth="2">
          <rect x="3" y="3" width="8" height="8" rx="1" />
          <rect x="13" y="13" width="8" height="8" rx="1" />
          <path d="M13 3h8v8M3 13v8h8" />
        </svg>
        <span style={styles.headerText}>Golden Overlay</span>
        <button onClick={refreshSample} style={styles.refreshBtn} title="Refresh current sample">&#x21bb;</button>
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <div style={styles.controlGroup}>
          <label style={styles.label}>Golden Reference Image</label>
          <select value={goldenPath} onChange={(e) => setGoldenPath(e.target.value)} style={styles.select}>
            <option value="">Select golden image…</option>
            {filepaths.map((fp) => (
              <option key={fp} value={fp}>{getFilename(fp)}</option>
            ))}
          </select>
        </div>

        <div style={styles.controlGroup}>
          <div style={styles.sliderRow}>
            <label style={styles.label}>Overlay Opacity</label>
            <span style={styles.opacityValue}>{opacity}%</span>
          </div>
          <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} style={styles.slider} />
        </div>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} style={styles.checkbox} />
          Difference mode
        </label>
      </div>

      {/* Image area */}
      <div style={styles.imageArea}>
        {loading ? (
          <div style={styles.placeholder}>Loading…</div>
        ) : !currentSrc ? (
          <div style={styles.placeholder}>Click &#x21bb; to load the current sample</div>
        ) : !goldenSrc ? (
          <div style={styles.placeholderWithImage}>
            <img src={currentSrc} alt="Current sample" style={styles.soloImage} />
            <div style={styles.hint}>Select a golden reference image above to overlay</div>
          </div>
        ) : (
          <div style={styles.overlayWrapper}>
            <img src={currentSrc} alt="Current sample" style={styles.baseImage} />
            <img src={goldenSrc} alt="Golden reference"
              style={{ ...styles.overlayImage, opacity: opacity / 100, mixBlendMode: showDiff ? ("difference" as any) : ("normal" as any) }}
            />
            <div style={styles.labels}>
              <span style={styles.tag}>Sample: {getFilename(currentFilepath || "")}</span>
              <span style={{ ...styles.tag, ...styles.goldenTag }}>Golden: {getFilename(goldenPath)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", flexDirection: "column", height: "100%", backgroundColor: "#1a1a1a", color: "#e0e0e0", fontFamily: "system-ui, -apple-system, sans-serif" },
  header: { display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid #333" },
  headerText: { fontSize: 14, fontWeight: 600, flex: 1 },
  refreshBtn: { background: "none", border: "1px solid #444", borderRadius: 4, color: "#ccc", fontSize: 16, cursor: "pointer", padding: "2px 8px", lineHeight: 1 },
  controls: { padding: 16, borderBottom: "1px solid #333", display: "flex", flexDirection: "column", gap: 12 },
  controlGroup: { display: "flex", flexDirection: "column", gap: 4 },
  label: { fontSize: 12, color: "#999", fontWeight: 500 },
  select: { width: "100%", padding: "8px 10px", borderRadius: 4, border: "1px solid #444", backgroundColor: "#2a2a2a", color: "#e0e0e0", fontSize: 13, outline: "none", cursor: "pointer" },
  sliderRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  opacityValue: { fontSize: 12, color: "#999", fontVariantNumeric: "tabular-nums" },
  slider: { width: "100%", cursor: "pointer", accentColor: "#ff6d04" },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer", color: "#ccc" },
  checkbox: { accentColor: "#ff6d04", cursor: "pointer" },
  imageArea: { flex: 1, position: "relative", overflow: "hidden", margin: 8, borderRadius: 4, backgroundColor: "#111", minHeight: 200 },
  placeholder: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#666", fontSize: 14 },
  placeholderWithImage: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12 },
  soloImage: { maxWidth: "100%", maxHeight: "calc(100% - 40px)", objectFit: "contain" },
  hint: { fontSize: 12, color: "#555", fontStyle: "italic" },
  overlayWrapper: { position: "relative", width: "100%", height: "100%" },
  baseImage: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  overlayImage: { position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", maxWidth: "100%", maxHeight: "100%", objectFit: "contain", pointerEvents: "none" },
  labels: { position: "absolute", bottom: 8, left: 8, right: 8, display: "flex", justifyContent: "space-between", pointerEvents: "none" },
  tag: { fontSize: 11, padding: "2px 6px", borderRadius: 3, backgroundColor: "rgba(0, 0, 0, 0.7)", color: "#ccc", maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const },
  goldenTag: { backgroundColor: "rgba(255, 109, 4, 0.3)", color: "#ff9d44" },
};
