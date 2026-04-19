"""Video Detection Chart Plugin

Two panel variants for visualizing per-frame temporal data:

Panels:
  - DetectionCountPlotInteractive (JS) — SVG chart with bidirectional video sync
  - FrameDataPlot (Python) — Plotly chart with field selector and timeline sync

Operators:
  - get_temporal_fields — discovers plottable frame-level fields
  - get_frame_values — returns per-frame values for any temporal field
  - get_detection_counts — (legacy) returns per-frame detection counts
"""

import fiftyone as fo
import fiftyone.core.view as fov
import fiftyone.operators as foo
import fiftyone.operators.types as types
from fiftyone import ViewField as F

LOG_PREFIX = "[TemporalDetection]"


def _has_non_none(nested):
    """Check if any non-None value exists in a (possibly nested) list."""
    for item in nested:
        if item is None:
            continue
        if isinstance(item, (list, tuple)):
            if _has_non_none(item):
                return True
        else:
            return True
    return False


def _is_dynamic_groups(ctx):
    """Check if the current view is a dynamically grouped dataset."""
    return getattr(ctx.view, "_is_dynamic_groups", False)


def _get_fields(ctx):
    """Discover plottable frame-level fields (Float, Int, List)."""
    ftypes = (fo.FloatField, fo.IntField, fo.ListField)

    if _is_dynamic_groups(ctx):
        schema = ctx.view.get_field_schema(flat=True, ftype=ftypes)
        full_schema = ctx.view.get_field_schema(flat=True)
    else:
        schema = ctx.view.get_frame_field_schema(flat=True, ftype=ftypes)
        full_schema = ctx.view.get_frame_field_schema(flat=True)

    if not schema:
        return []

    # Filter out sub-paths (e.g., keep "detections.detections" but not
    # "detections.detections.id")
    paths = sorted(schema.keys())
    top_paths = [
        p for p in paths if not any(p.startswith(other + ".") for other in paths if other != p)
    ]

    fields = []
    for path in top_paths:
        field = schema[path]
        if isinstance(field, fo.ListField):
            has_labels = (path + ".label") in full_schema
            has_tracks = False
            if (path + ".index") in full_schema:
                try:
                    if _is_dynamic_groups(ctx):
                        test = ctx.view[:1].values(path + ".index")
                    else:
                        test = ctx.view[:1].values("frames[]." + path + ".index")
                    has_tracks = _has_non_none(test)
                except Exception:
                    pass
            fields.append({
                "path": path,
                "type": "list",
                "label": f"{path} (count)",
                "has_labels": has_labels,
                "has_tracks": has_tracks,
            })
        elif isinstance(field, fo.FloatField):
            fields.append({
                "path": path, "type": "float", "label": path,
                "has_labels": False, "has_tracks": False,
            })
        elif isinstance(field, fo.IntField):
            fields.append({
                "path": path, "type": "int", "label": path,
                "has_labels": False, "has_tracks": False,
            })

    return fields


def _get_dynamic_group_key(ctx, sample_id):
    """Resolve the dynamic group key value from a sample ID."""
    # Find the group_by field from the view stages
    for stage in ctx.view._stages:
        if type(stage).__name__ == "GroupBy":
            group_field = stage._field_or_expr
            sample = ctx.dataset[sample_id]
            return sample[group_field]
    return None


def _get_frame_values(ctx, sample_id, field_path):
    """Fetch per-frame values for a given field path."""
    if _is_dynamic_groups(ctx):
        # Dynamic groups: each "frame" is a top-level sample in the group
        group_key = _get_dynamic_group_key(ctx, sample_id)
        group = ctx.view.get_dynamic_group(group_key)

        field = ctx.view.get_field(field_path)
        if isinstance(field, fo.ListField):
            expr = F(field_path).length()
        else:
            expr = field_path

        values = group.values(expr)

        # No frame_number field — generate sequential frame numbers
        frame_numbers = list(range(1, len(values) + 1))

        # Estimate fps (no metadata on grouped images)
        fps = 30
        total_frames = len(frame_numbers)
        sample_ids = [str(s) for s in group.values("id")]
    else:
        # Native video: frame data under frames[]
        sample = ctx.dataset[sample_id]
        fps = sample.metadata.frame_rate if sample.metadata else 30
        total_frames = sample.metadata.total_frame_count if sample.metadata else 0

        field = ctx.view.get_field("frames." + field_path)
        if isinstance(field, fo.ListField):
            expr = F("frames[]." + field_path).length()
        else:
            expr = "frames[]." + field_path

        view = fov.make_optimized_select_view(ctx.view, [sample_id])
        frame_numbers, values = view.values(["frames[].frame_number", expr])
        sample_ids = None

    # Replace None with 0
    values = [v if v is not None else 0 for v in values]

    return {
        "frames": frame_numbers,
        "values": values,
        "fps": fps,
        "total_frames": total_frames,
        "field": field_path,
        "sample_ids": sample_ids,
    }


def _get_label_timeline(ctx, sample_id, field_path):
    """Fetch per-frame label data for a given field path (swim lane heatmap)."""
    label_expr = field_path + ".label"

    if _is_dynamic_groups(ctx):
        group_key = _get_dynamic_group_key(ctx, sample_id)
        group = ctx.view.get_dynamic_group(group_key)

        label_lists = group.values(F(label_expr))
        frame_numbers = list(range(1, len(label_lists) + 1))
        fps = 30
        total_frames = len(frame_numbers)
        sample_ids = [str(s) for s in group.values("id")]
    else:
        sample = ctx.dataset[sample_id]
        fps = sample.metadata.frame_rate if sample.metadata else 30
        total_frames = sample.metadata.total_frame_count if sample.metadata else 0

        view = fov.make_optimized_select_view(ctx.view, [sample_id])
        frame_numbers, label_lists = view.values(
            ["frames[].frame_number", "frames[]." + label_expr]
        )
        sample_ids = None

    # Count labels across all frames to get unique labels sorted by total count
    label_counts = {}
    for frame_labels in label_lists:
        if frame_labels:
            for label in frame_labels:
                if label is not None:
                    label_counts[label] = label_counts.get(label, 0) + 1

    # Sort labels by total count descending
    sorted_labels = sorted(
        label_counts.keys(), key=lambda l: label_counts[l], reverse=True
    )

    # Build timeline: per-label count arrays
    timeline = {}
    for label in sorted_labels:
        timeline[label] = [0] * len(frame_numbers)

    for i, frame_labels in enumerate(label_lists):
        if frame_labels:
            for label in frame_labels:
                if label is not None and label in timeline:
                    timeline[label][i] += 1

    return {
        "frames": frame_numbers,
        "labels": sorted_labels,
        "timeline": timeline,
        "fps": fps,
        "total_frames": total_frames,
        "field": field_path,
        "sample_ids": sample_ids,
    }


def _get_instance_tracks(ctx, sample_id, field_path):
    """Fetch per-instance binary presence tracks for tracked objects."""
    index_expr = field_path + ".index"
    label_expr = field_path + ".label"

    if _is_dynamic_groups(ctx):
        group_key = _get_dynamic_group_key(ctx, sample_id)
        group = ctx.view.get_dynamic_group(group_key)

        index_lists = group.values(F(index_expr))
        label_lists = group.values(F(label_expr))
        frame_numbers = list(range(1, len(index_lists) + 1))
        fps = 30
        total_frames = len(frame_numbers)
        sample_ids = [str(s) for s in group.values("id")]
    else:
        sample = ctx.dataset[sample_id]
        fps = sample.metadata.frame_rate if sample.metadata else 30
        total_frames = sample.metadata.total_frame_count if sample.metadata else 0

        view = fov.make_optimized_select_view(ctx.view, [sample_id])
        frame_numbers, index_lists, label_lists = view.values(
            [
                "frames[].frame_number",
                "frames[]." + index_expr,
                "frames[]." + label_expr,
            ]
        )
        sample_ids = None

    # Build per-instance tracks: (label, index) → set of frame indices
    instance_info = {}
    for fi, (frame_indices, frame_labels) in enumerate(
        zip(index_lists, label_lists)
    ):
        if not frame_indices or not frame_labels:
            continue
        for idx, label in zip(frame_indices, frame_labels):
            if idx is None or label is None:
                continue
            key = (label, idx)
            if key not in instance_info:
                instance_info[key] = {"label": label, "index": idx, "frames": set()}
            instance_info[key]["frames"].add(fi)

    # Sort by label then index
    sorted_keys = sorted(instance_info.keys())

    # Build response arrays
    track_names = []
    tracks = {}
    track_labels = {}
    for key in sorted_keys:
        info = instance_info[key]
        name = f"{info['label']} #{info['index']}"
        track_names.append(name)
        tracks[name] = [
            1 if fi in info["frames"] else 0
            for fi in range(len(frame_numbers))
        ]
        track_labels[name] = info["label"]

    return {
        "frames": frame_numbers,
        "track_names": track_names,
        "tracks": tracks,
        "track_labels": track_labels,
        "fps": fps,
        "total_frames": total_frames,
        "field": field_path,
        "sample_ids": sample_ids,
    }


class GetTemporalFields(foo.Operator):
    """Discovers plottable frame-level fields for the current dataset."""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_temporal_fields",
            label="Get Temporal Fields",
            unlisted=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()
        inputs.str("sample_id", required=True)
        return types.Property(inputs)

    def execute(self, ctx):
        try:
            fields = _get_fields(ctx)
            return {"fields": fields, "dataset_name": ctx.dataset.name}
        except Exception as e:
            print(f"{LOG_PREFIX} Error discovering fields: {e}")
            return {"error": str(e)}


class GetFrameValues(foo.Operator):
    """Returns per-frame values for any temporal field."""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_frame_values",
            label="Get Frame Values",
            unlisted=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()
        inputs.str("sample_id", required=True)
        inputs.str("field", default="detections.detections")
        inputs.str("mode", default="count")
        return types.Property(inputs)

    def execute(self, ctx):
        sample_id = ctx.params.get("sample_id")
        field_path = ctx.params.get("field", "detections.detections")
        mode = ctx.params.get("mode", "count")
        if not sample_id:
            return {}

        try:
            if mode == "labels":
                result = _get_label_timeline(ctx, sample_id, field_path)
                print(
                    f"{LOG_PREFIX} Loaded label timeline for '{field_path}'"
                    f" ({len(result['labels'])} labels,"
                    f" {len(result['frames'])} frames)"
                )
            elif mode == "tracks":
                result = _get_instance_tracks(ctx, sample_id, field_path)
                print(
                    f"{LOG_PREFIX} Loaded instance tracks for '{field_path}'"
                    f" ({len(result['track_names'])} tracks,"
                    f" {len(result['frames'])} frames)"
                )
            else:
                result = _get_frame_values(ctx, sample_id, field_path)
                print(
                    f"{LOG_PREFIX} Loaded {len(result['frames'])} frames"
                    f" for field '{field_path}'"
                )
            return result
        except Exception as e:
            print(f"{LOG_PREFIX} Error loading field '{field_path}': {e}")
            return {"error": str(e)}


class GetDetectionCounts(foo.Operator):
    """Legacy operator — delegates to _get_frame_values with detections."""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_detection_counts",
            label="Get Detection Counts",
            unlisted=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()
        inputs.str("sample_id", required=True)
        return types.Property(inputs)

    def execute(self, ctx):
        sample_id = ctx.params.get("sample_id")
        if not sample_id:
            return {}

        try:
            result = _get_frame_values(ctx, sample_id, "detections.detections")
            return {
                "frames": result["frames"],
                "counts": result["values"],
                "fps": result["fps"],
                "total_frames": result["total_frames"],
            }
        except Exception as e:
            print(f"{LOG_PREFIX} Error: {e}")
            return {"error": str(e)}


# ==========================================================
# Python-only Panel: FrameDataPlot
# Plotly bar chart with field selector and video timeline sync.
# Uses FrameLoaderView (no timeline_name) to subscribe to the
# video player's default timeline.
# ==========================================================


def _get_fields_for_panel(ctx):
    """Discover plottable frame-level fields, returning (paths, labels)."""
    fields = _get_fields(ctx)
    paths = [f["path"] for f in fields]
    labels = [f["label"] for f in fields]
    return paths, labels


def _get_panel_values(ctx, field_path):
    """Fetch per-frame values for the Python panel."""
    sample_id = ctx.current_sample

    field = ctx.view.get_field("frames." + field_path)
    if isinstance(field, fo.ListField):
        expr = F("frames[]." + field_path).length()
    else:
        expr = "frames[]." + field_path

    view = fov.make_optimized_select_view(ctx.view, [sample_id])
    frame_numbers, values = view.values(["frames[].frame_number", expr])
    values = [v if v is not None else 0 for v in values]

    return frame_numbers, values


class FrameDataPlot(foo.Panel):
    """Python-only panel — Plotly bar chart of per-frame data with timeline sync."""

    @property
    def config(self):
        return foo.PanelConfig(
            name="frame_data_plot",
            label="Frame Data Plot (Python)",
            surfaces="modal",
            unlisted=False,
        )

    def on_load(self, ctx):
        fields, labels = _get_fields_for_panel(ctx)
        ctx.panel.state.fields = fields
        ctx.panel.state.field_labels = labels

        if not fields:
            return

        # Default to detections.detections if available, else first field
        selected = fields[0]
        if "detections.detections" in fields:
            selected = "detections.detections"
        ctx.panel.state.selected_field = selected

        self._load_plot(ctx, selected)

    def on_change_current_sample(self, ctx):
        self.on_load(ctx)

    def on_field_select(self, ctx):
        selected = ctx.panel.state.selected_field
        if selected:
            self._load_plot(ctx, selected)

    def _load_plot(self, ctx, field_path):
        """Load data and configure the Plotly bar chart."""
        try:
            frame_numbers, values = _get_panel_values(ctx, field_path)
        except Exception as e:
            print(f"{LOG_PREFIX} Panel error loading '{field_path}': {e}")
            return

        # Find the label for this field
        label = field_path
        fields = ctx.panel.state.fields or []
        labels = ctx.panel.state.field_labels or []
        for i, f in enumerate(fields):
            if f == field_path:
                label = labels[i]
                break

        ctx.panel.state.plot = {
            "type": "scatter",
            "mode": "lines+markers",
            "x": frame_numbers,
            "y": values,
            "line": {"color": "#FF6D04", "width": 1.5},
            "fill": "tozeroy",
            "fillcolor": "rgba(255, 109, 4, 0.10)",
            "marker": {"size": 6, "color": "rgba(0,0,0,0)"},
            "selected": {
                "marker": {
                    "color": "#86B5F6",
                    "size": 8,
                    "line": {"color": "#FFF9F5", "width": 2},
                },
            },
            "unselected": {"marker": {"opacity": 0}},
            "selectedpoints": [],
            "hovertemplate": (
                f"<b>Frame</b>: %{{x}}<br>"
                f"<b>{label}</b>: %{{y}}<extra></extra>"
            ),
        }
        ctx.panel.state.plot_field = field_path

    def render(self, ctx):
        panel = types.Object()

        # Field selector dropdown
        fields = ctx.panel.state.fields or []
        labels = ctx.panel.state.field_labels or []
        field_choices = types.Choices()
        for i, path in enumerate(fields):
            field_choices.add_choice(path, label=labels[i] if i < len(labels) else path)

        panel.enum(
            "selected_field",
            values=field_choices.values(),
            label="Field",
            view=types.AutocompleteView(),
            on_change=self.on_field_select,
        )

        # Plotly chart
        panel.plot(
            "plot",
            height=250,
            layout={
                "paper_bgcolor": "#18191A",
                "plot_bgcolor": "#18191A",
                "margin": {"t": 10, "b": 40, "l": 50, "r": 20},
                "xaxis": {
                    "title": "Frame Number",
                    "color": "#8F8D8B",
                    "gridcolor": "#1E1F20",
                    "linecolor": "#404040",
                },
                "yaxis": {
                    "title": ctx.panel.state.get("plot_field", "Value"),
                    "color": "#8F8D8B",
                    "gridcolor": "#1E1F20",
                    "linecolor": "#404040",
                },
                "font": {"color": "#8F8D8B", "size": 12},
            },
        )

        # FrameLoaderView — no timeline_name = subscribe to video player
        panel.obj(
            "frame_data",
            view=types.FrameLoaderView(
                on_load_range=self.on_load_range,
                target="plot.selectedpoints",
            ),
        )

        return types.Property(panel)

    def on_load_range(self, ctx):
        r = ctx.params.get("range")
        chunk = {}
        for i in range(r[0], r[1]):
            chunk[f"frame_data.frames[{i}]"] = [i - 1]
        ctx.panel.set_data(chunk)

        field = ctx.panel.state.selected_field or ""
        ctx.panel.set_state("frame_data.signature", field + str(r))


def register(p):
    p.register(GetTemporalFields)
    p.register(GetFrameValues)
    p.register(GetDetectionCounts)
    # FrameDataPlot disabled — Python panel is a reference example only
    # p.register(FrameDataPlot)
