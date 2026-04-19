"""
plotting.py
===========
All visualization primitives for the EgoCart Cart-Movement plugin:

* Shared constants and tuning parameters
* Frame-data loading and shared computation helpers
* Plotly figure builders  (used by FloorplanPanel)
* Matplotlib PNG renderers (used by AddFloorplanSlices)
"""

import math
from collections import defaultdict
from typing import Any

import matplotlib

# Must be set before any pyplot / axes import so the Agg backend is active
# before the first figure is created.
matplotlib.use("Agg")

import matplotlib.colors as mcolors
import matplotlib.patches as mpatches
import matplotlib.pyplot as plt
import numpy as np
import plotly.colors as pc
from scipy.stats import gaussian_kde


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Human-readable names for the 16 store zones.
ZONE_NAMES: dict[int, str] = {
    1: "Zone 1",
    2: "Zone 2",
    3: "Zone 3",
    4: "Zone 4",
    5: "Zone 5",
    6: "Zone 6",
    7: "Zone 7",
    8: "Zone 8",
    9: "Zone 9",
    10: "Zone 10",
    11: "Back Wall",
    12: "Right Wall",
    13: "Bottom Right",
    14: "Bottom Left",
    15: "Central Bottom",
    16: "Left Wall",
}

#: Background colour used on every chart to match the FiftyOne dark UI.
BG_COLOR = "#0f1117"

#: tab20 RGBA array (16 entries) shared by Plotly and Matplotlib colour helpers.
_TAB20 = plt.cm.tab20(np.linspace(0, 1, 16))


def _rgba_to_plotly(rgba: np.ndarray) -> str:
    """Convert a matplotlib RGBA array (values 0–1) to a Plotly CSS colour."""
    r, g, b = (int(v * 255) for v in rgba[:3])
    return f"rgba({r},{g},{b},{rgba[3]:.2f})"


#: Plotly CSS colour string for each of the 16 zones.
ZONE_COLORS_PLOTLY: list[str] = [_rgba_to_plotly(c) for c in _TAB20]

# ---- Tuning parameters (change here to affect all consumers) ---------------

_KDE_RNG_SEED     = 42       #: RNG seed for reproducible KDE sub-sampling.
_SCATTER_RNG_SEED = 0        #: RNG seed for zone-scatter shuffle.
_KDE_MAX_SAMPLES  = 8_000    #: Maximum points fed to gaussian_kde.
_KDE_BW_METHOD    = 0.08     #: Gaussian KDE bandwidth.
_AXIS_PAD         = 0.5      #: Metres of padding added to each axis limit.
_ARROW_GRID_W     = 50       #: Orientation sampling grid width  (columns).
_ARROW_GRID_H     = 22       #: Orientation sampling grid height (rows).
_N_HEADING_BINS   = 72       #: Colour buckets for Plotly arrow traces (5° each).
_FIG_SIZE         = (10, 5)  #: Matplotlib figure size (inches) for PNG renderers.
_SAVE_DPI         = 150      #: PNG output resolution.
_PANEL_HEIGHT_PX  = 360      #: Plotly panel chart height in pixels.


# ---------------------------------------------------------------------------
# Shared computation helpers
# ---------------------------------------------------------------------------

def _finalise_frame_arrays(
    xs: list,
    ys: list,
    us: list,
    vs: list,
    cs: list,
) -> tuple[
    np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray,
    tuple[float, float], tuple[float, float],
]:
    """Convert frame lists to numpy arrays and compute padded axis limits.

    Parameters
    ----------
    xs, ys:
        Raw float lists of x/y positions.
    us, vs:
        Raw float lists of orientation vector components.
    cs:
        Raw int list of zone IDs.

    Returns
    -------
    xs, ys, us, vs, cs, xlim, ylim
        Numpy arrays and ``(min, max)`` tuples with :data:`_AXIS_PAD` padding.
    """
    xs_a = np.asarray(xs, dtype=float)
    ys_a = np.asarray(ys, dtype=float)
    us_a = np.asarray(us, dtype=float)
    vs_a = np.asarray(vs, dtype=float)
    cs_a = np.asarray(cs, dtype=int)
    xlim = (float(xs_a.min()) - _AXIS_PAD, float(xs_a.max()) + _AXIS_PAD)
    ylim = (float(ys_a.min()) - _AXIS_PAD, float(ys_a.max()) + _AXIS_PAD)
    return xs_a, ys_a, us_a, vs_a, cs_a, xlim, ylim


def _compute_kde_grid(
    xs: np.ndarray,
    ys: np.ndarray,
    xlim: tuple[float, float],
    ylim: tuple[float, float],
    nx: int,
    ny: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute a Gaussian KDE density on a regular grid.

    Sub-samples up to :data:`_KDE_MAX_SAMPLES` points for speed, then
    evaluates the KDE on an *nx* × *ny* grid spanning *xlim* × *ylim*.

    Parameters
    ----------
    xs, ys:
        Position arrays.
    xlim, ylim:
        Axis extents.
    nx, ny:
        Grid resolution (columns × rows).

    Returns
    -------
    gx, gy, Z
        1-D grid coordinate arrays and the (*ny* × *nx*) density matrix.
    """
    rng = np.random.default_rng(_KDE_RNG_SEED)
    idx = rng.choice(len(xs), size=min(_KDE_MAX_SAMPLES, len(xs)), replace=False)
    kde = gaussian_kde(np.vstack([xs[idx], ys[idx]]), bw_method=_KDE_BW_METHOD)
    gx = np.linspace(*xlim, nx)
    gy = np.linspace(*ylim, ny)
    GX, GY = np.meshgrid(gx, gy)
    Z = kde(np.vstack([GX.ravel(), GY.ravel()])).reshape(GX.shape)
    return gx, gy, Z


def _sample_arrows_by_grid(
    xs: np.ndarray,
    ys: np.ndarray,
    us: np.ndarray,
    vs: np.ndarray,
    xlim: tuple[float, float],
    ylim: tuple[float, float],
    grid_w: int = _ARROW_GRID_W,
    grid_h: int = _ARROW_GRID_H,
) -> tuple[list, list, list, list, list]:
    """Pick one arrow per spatial grid cell for the orientation field.

    Iterates frame data in dataset order and keeps the first (x, y, u, v)
    seen in each grid cell, giving a spatially uniform sub-sample.

    Parameters
    ----------
    xs, ys, us, vs:
        Position and orientation arrays.
    xlim, ylim:
        Axis extents used to map positions to cell indices.
    grid_w, grid_h:
        Grid dimensions.

    Returns
    -------
    arrow_x, arrow_y, arrow_u, arrow_v, headings
        One entry per occupied cell.
    """
    cell_w = (xlim[1] - xlim[0]) / grid_w
    cell_h = (ylim[1] - ylim[0]) / grid_h
    arrow_x, arrow_y, arrow_u, arrow_v, headings = [], [], [], [], []
    seen: set[tuple[int, int]] = set()
    for x, y, u, v in zip(xs, ys, us, vs):
        key = (int((x - xlim[0]) / cell_w), int((y - ylim[0]) / cell_h))
        if key not in seen:
            seen.add(key)
            arrow_x.append(x)
            arrow_y.append(y)
            arrow_u.append(u)
            arrow_v.append(v)
            headings.append(math.degrees(math.atan2(v, u)))
    return arrow_x, arrow_y, arrow_u, arrow_v, headings


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _load_frame_data(dataset: Any) -> dict[str, Any]:
    """Load all relevant per-frame fields from *dataset* in a single pass.

    Uses :py:meth:`~fiftyone.core.dataset.Dataset.values` with the
    ``frames.`` prefix to avoid iterating sample-by-sample in Python, which
    is significantly faster for large datasets.

    If the dataset has been converted to grouped mode (e.g. after running
    ``AddFloorplanSlices``), only the ``"video"`` slice is queried because
    the image slices have no ``frames`` field.

    Parameters
    ----------
    dataset:
        The ``egocart_videos`` (or any compatible) FiftyOne dataset.

    Returns
    -------
    dict with keys:
        ``xs``, ``ys``      – flat numpy arrays of x/y positions (m)
        ``us``, ``vs``      – flat numpy arrays of orientation components
        ``cs``              – flat numpy int array of zone IDs (1–16)
        ``seq_groups``      – ``{seq_id: [(x, y), ...]}`` for trajectory plot
        ``xlim``, ``ylim``  – (min, max) tuples with :data:`_AXIS_PAD` padding
    """
    # When the dataset is grouped, restrict to the video slice before
    # querying frame fields.  The image slices have no 'frames' collection
    # and calling dataset.values("frames.*") on them raises ValueError.
    source = (
        dataset.select_group_slices("video")
        if dataset.group_field
        else dataset
    )

    xs_nested = source.values("frames.location_x")
    ys_nested = source.values("frames.location_y")
    us_nested = source.values("frames.orientation_u")
    vs_nested = source.values("frames.orientation_v")
    cs_nested = source.values("frames.zone_id")
    seq_ids   = source.values("sequence_id")

    xs_flat: list = []
    ys_flat: list = []
    us_flat: list = []
    vs_flat: list = []
    cs_flat: list = []
    seq_groups: dict[str, list[tuple[float, float]]] = defaultdict(list)

    for seq_id, x_frames, y_frames, u_frames, v_frames, c_frames in zip(
        seq_ids, xs_nested, ys_nested, us_nested, vs_nested, cs_nested
    ):
        for x, y, u, v, c in zip(x_frames, y_frames, u_frames, v_frames, c_frames):
            if x is None or y is None or u is None or v is None or c is None:
                continue
            xs_flat.append(x)
            ys_flat.append(y)
            us_flat.append(u)
            vs_flat.append(v)
            cs_flat.append(int(c))
            seq_groups[str(seq_id)].append((x, y))

    xs, ys, us, vs, cs, xlim, ylim = _finalise_frame_arrays(
        xs_flat, ys_flat, us_flat, vs_flat, cs_flat
    )
    return {
        "xs": xs, "ys": ys,
        "us": us, "vs": vs,
        "cs": cs,
        "seq_groups": dict(seq_groups),
        "xlim": xlim,
        "ylim": ylim,
    }


def _frame_data_from_arrays(
    xs_list: list,
    ys_list: list,
    us_list: list,
    vs_list: list,
    cs_list: list,
    seq_id: str,
) -> dict[str, Any]:
    """Build a frame data dict from pre-loaded per-sample frame arrays.

    Use this in operators that have already bulk-loaded frame values via
    ``dataset.values("frames.<field>")``.  Pass the per-sample slice of each
    nested list here rather than accessing ``sample.frames`` inside a view,
    which may not have frame fields loaded.

    Parameters
    ----------
    xs_list, ys_list:
        Lists of ``location_x`` / ``location_y`` values for every frame of
        one sample (may contain ``None`` at sequence edges).
    us_list, vs_list:
        Lists of ``orientation_u`` / ``orientation_v`` values.
    cs_list:
        List of ``zone_id`` integer values.
    seq_id:
        The ``sequence_id`` string for this sample.

    Returns
    -------
    dict
        Same schema as :func:`_load_frame_data`.  ``seq_groups`` contains
        only the single sequence belonging to this sample.
    """
    xs_flat: list = []
    ys_flat: list = []
    us_flat: list = []
    vs_flat: list = []
    cs_flat: list = []
    seq_pts: list[tuple[float, float]] = []

    for x, y, u, v, c in zip(xs_list, ys_list, us_list, vs_list, cs_list):
        if x is None or y is None or u is None or v is None or c is None:
            continue
        xs_flat.append(x)
        ys_flat.append(y)
        us_flat.append(u)
        vs_flat.append(v)
        cs_flat.append(int(c))
        seq_pts.append((x, y))

    xs, ys, us, vs, cs, xlim, ylim = _finalise_frame_arrays(
        xs_flat, ys_flat, us_flat, vs_flat, cs_flat
    )
    return {
        "xs": xs, "ys": ys,
        "us": us, "vs": vs,
        "cs": cs,
        "seq_groups": {seq_id: seq_pts},
        "xlim": xlim,
        "ylim": ylim,
    }


# ---------------------------------------------------------------------------
# Plotly figure builders  (used by FloorplanPanel)
# ---------------------------------------------------------------------------

def _dark_layout(title: str, xlim: tuple, ylim: tuple) -> dict:
    """Return a Plotly layout dict with consistent dark-theme styling.

    Parameters
    ----------
    title:
        Chart title string.
    xlim, ylim:
        (min, max) axis limits.
    """
    return {
        "title": {"text": title, "font": {"color": "white", "size": 13}},
        "paper_bgcolor": BG_COLOR,
        "plot_bgcolor": BG_COLOR,
        "xaxis": {
            "title": "X position (m)",
            "range": list(xlim),
            "color": "#aaaaaa",
            "gridcolor": "#333333",
            "zerolinecolor": "#333333",
        },
        "yaxis": {
            "title": "Y position (m)",
            "range": list(ylim),
            "color": "#aaaaaa",
            "gridcolor": "#333333",
            "zerolinecolor": "#333333",
            "scaleanchor": "x",  # keep aspect ratio square
        },
        "font": {"color": "#aaaaaa"},
        "margin": {"l": 50, "r": 20, "t": 50, "b": 40},
        "legend": {
            "bgcolor": "#1a1a2e",
            "bordercolor": "#444444",
            "font": {"color": "white", "size": 9},
        },
    }


def _build_kde_figure(data: dict) -> dict:
    """Build a Plotly KDE density contour figure dict.

    Parameters
    ----------
    data:
        Frame data dict as returned by :func:`_load_frame_data`.

    Returns
    -------
    dict
        Plotly figure dict ``{"data": [...], "layout": {...}}``.
    """
    xs, ys = data["xs"], data["ys"]
    xlim, ylim = data["xlim"], data["ylim"]

    gx, gy, Z = _compute_kde_grid(xs, ys, xlim, ylim, nx=200, ny=100)

    trace = {
        "type": "contour",
        "x": gx.tolist(),
        "y": gy.tolist(),
        "z": Z.tolist(),
        "colorscale": "Inferno",
        "contours": {"coloring": "fill", "showlines": True},
        "line": {"width": 0.5, "color": "rgba(255,255,255,0.2)"},
        "showscale": False,
        "name": "density",
    }

    return {
        "data": [trace],
        "layout": _dark_layout("Cart Trajectory Density (KDE)", xlim, ylim),
    }


def _build_trajectories_zones_figure(data: dict) -> dict:
    """Build a combined Plotly figure overlaying trajectory paths on the zone map.

    Renders the zone scatter as a semi-transparent background so that the
    spatial structure of the store is visible, then draws each sequence's
    trajectory on top.  The first and last frame of every sequence are
    marked with labelled symbols:

    * **Start** – filled circle (●) labelled ``S<seq_id>``
    * **End**   – filled square (■) labelled ``E<seq_id>``

    Zone centroid badges (numbered annotations) are added at the mean
    x/y position of each zone.

    Parameters
    ----------
    data:
        Frame data dict as returned by :func:`_load_frame_data`.

    Returns
    -------
    dict
        Plotly figure dict ``{"data": [...], "layout": {...}}``.
    """
    xs, ys, cs = data["xs"], data["ys"], data["cs"]
    xlim, ylim = data["xlim"], data["ylim"]
    seq_groups = data["seq_groups"]

    traces: list[dict] = []
    annotations: list[dict] = []

    # ---- Background: zone scatter (very transparent) -----------------------
    # Shuffled so rare zones aren't buried under high-density ones.
    rng = np.random.default_rng(_SCATTER_RNG_SEED)
    idx = rng.permutation(len(xs))
    xs_s, ys_s, cs_s = xs[idx], ys[idx], cs[idx]

    for zone in range(1, 17):
        mask = cs_s == zone
        if not mask.any():
            continue
        color = ZONE_COLORS_PLOTLY[zone - 1]
        traces.append({
            "type": "scatter",
            "mode": "markers",
            "x": xs_s[mask].tolist(),
            "y": ys_s[mask].tolist(),
            "marker": {
                "color": color,
                "size": 6,
                "opacity": 0.18,
                "line": {"width": 0},
            },
            "name": f"{zone}: {ZONE_NAMES[zone]}",
            "legendgroup": "zones",
            **({"legendgrouptitle": {
                    "text": "Zones",
                    "font": {"color": "white", "size": 9},
                }} if not traces else {}),
            "showlegend": True,
            "hoverinfo": "skip",
        })

    # ---- Zone centroid badges (annotations) --------------------------------
    for zone in range(1, 17):
        mask = cs == zone
        if not mask.any():
            continue
        cx, cy = float(xs[mask].mean()), float(ys[mask].mean())
        annotations.append({
            "x": cx, "y": cy,
            "text": f"<b>{zone}</b>",
            "showarrow": False,
            "font": {"color": "white", "size": 8},
            "bgcolor": ZONE_COLORS_PLOTLY[zone - 1],
            "borderpad": 2,
            "opacity": 0.75,
        })

    # ---- Foreground: trajectory lines + start/end markers ------------------
    palette = pc.qualitative.Alphabet  # 26 distinct colours

    for i, (seq_id, pts) in enumerate(sorted(seq_groups.items())):
        color = palette[i % len(palette)]
        px_vals = [p[0] for p in pts]
        py_vals = [p[1] for p in pts]

        traces.append({
            "type": "scatter",
            "mode": "lines",
            "x": px_vals,
            "y": py_vals,
            "line": {"color": color, "width": 1.5},
            "name": f"Seq {seq_id}",
            "legendgroup": "sequences",
            **({"legendgrouptitle": {
                    "text": "Sequences",
                    "font": {"color": "white", "size": 9},
                }} if i == 0 else {}),
            "showlegend": True,
        })

        # Start marker — filled circle labelled "S<seq_id>".
        traces.append({
            "type": "scatter",
            "mode": "markers+text",
            "x": [px_vals[0]],
            "y": [py_vals[0]],
            "marker": {
                "color": color,
                "size": 11,
                "symbol": "circle",
                "line": {"width": 1.5, "color": "white"},
            },
            "text": [f"S{seq_id}"],
            "textposition": "top center",
            "textfont": {"color": "white", "size": 8, "family": "monospace"},
            "name": f"Seq {seq_id} start",
            "legendgroup": "sequences",
            "showlegend": False,
            "hovertemplate": f"Seq {seq_id} — START<extra></extra>",
        })

        # End marker — filled square labelled "E<seq_id>".
        traces.append({
            "type": "scatter",
            "mode": "markers+text",
            "x": [px_vals[-1]],
            "y": [py_vals[-1]],
            "marker": {
                "color": color,
                "size": 11,
                "symbol": "square",
                "line": {"width": 1.5, "color": "white"},
            },
            "text": [f"E{seq_id}"],
            "textposition": "bottom center",
            "textfont": {"color": "white", "size": 8, "family": "monospace"},
            "name": f"Seq {seq_id} end",
            "legendgroup": "sequences",
            "showlegend": False,
            "hovertemplate": f"Seq {seq_id} — END<extra></extra>",
        })

    layout = _dark_layout("Trajectories & Zone Map", xlim, ylim)
    layout["annotations"] = annotations
    layout["showlegend"] = True
    layout["legend"] = {
        "bgcolor": "#1a1a2e",
        "bordercolor": "#444444",
        "font": {"color": "white", "size": 8},
        "orientation": "v",
        "x": 1.02,
        "xanchor": "left",
        "y": 0.98,
        "yanchor": "top",
    }

    return {"data": traces, "layout": layout}


def _build_orientation_figure(data: dict) -> dict:
    """Build a Plotly orientation field with sampled heading arrows.

    Bins the store floor into a :data:`_ARROW_GRID_W` × :data:`_ARROW_GRID_H`
    grid and picks one frame per cell.  Arrows are coloured by heading angle
    using the HSV colour wheel and batched into :data:`_N_HEADING_BINS`
    NaN-separated traces (one per 10° colour bucket), keeping the Plotly
    trace count low for browser performance.  A low-opacity KDE contour
    layer is drawn underneath.

    Parameters
    ----------
    data:
        Frame data dict as returned by :func:`_load_frame_data`.

    Returns
    -------
    dict
        Plotly figure dict.
    """
    xs, ys = data["xs"], data["ys"]
    us, vs = data["us"], data["vs"]
    xlim, ylim = data["xlim"], data["ylim"]
    seq_groups = data["seq_groups"]

    # KDE base layer — 150 × 70 is sufficient for a background contour.
    gx, gy, Z = _compute_kde_grid(xs, ys, xlim, ylim, nx=150, ny=70)

    base_trace = {
        "type": "contour",
        "x": gx.tolist(),
        "y": gy.tolist(),
        "z": Z.tolist(),
        "colorscale": "Blues",
        "contours": {"coloring": "fill", "showlines": False},
        "opacity": 0.35,
        "showscale": False,
        "name": "density",
        "showlegend": False,
    }

    # ---- Arrow traces (binned by heading for performance) ------------------
    arrow_x, arrow_y, arrow_u, arrow_v, arrow_headings = _sample_arrows_by_grid(
        xs, ys, us, vs, xlim, ylim
    )

    norm = mcolors.Normalize(vmin=-180, vmax=180)
    hsv_cmap = plt.cm.hsv
    scale = (xlim[1] - xlim[0]) / 25.0

    # Group arrows into _N_HEADING_BINS colour buckets.  Each bucket becomes
    # a single NaN-separated multi-segment scatter trace, cutting the Plotly
    # trace count from ~1,100 (one per arrow) to at most _N_HEADING_BINS (72).
    bins: dict[int, tuple[list, list]] = defaultdict(lambda: ([], []))
    for ax, ay, au, av, heading in zip(
        arrow_x, arrow_y, arrow_u, arrow_v, arrow_headings
    ):
        tip_x = ax + au * scale
        tip_y = ay + av * scale
        bucket = int((heading + 180) / 360 * _N_HEADING_BINS) % _N_HEADING_BINS
        bins[bucket][0].extend([ax, tip_x, None])
        bins[bucket][1].extend([ay, tip_y, None])

    arrow_traces = []
    for bucket, (xs_seg, ys_seg) in sorted(bins.items()):
        center_heading = -180 + (bucket + 0.5) * 360 / _N_HEADING_BINS
        color = _rgba_to_plotly(hsv_cmap(norm(center_heading)))
        arrow_traces.append({
            "type": "scatter",
            "mode": "lines",
            "x": xs_seg,
            "y": ys_seg,
            "line": {"color": color, "width": 1.5},
            "showlegend": False,
            "hoverinfo": "skip",
        })

    # ---- Sequence start / end markers --------------------------------------
    palette = pc.qualitative.Alphabet
    marker_traces = []
    for i, (seq_id, pts) in enumerate(sorted(seq_groups.items())):
        color = palette[i % len(palette)]
        px_vals = [p[0] for p in pts]
        py_vals = [p[1] for p in pts]

        # Start — filled circle labelled "S<seq_id>".
        marker_traces.append({
            "type": "scatter",
            "mode": "markers+text",
            "x": [px_vals[0]],
            "y": [py_vals[0]],
            "marker": {
                "color": color,
                "size": 11,
                "symbol": "circle",
                "line": {"width": 1.5, "color": "white"},
            },
            "text": [f"S{seq_id}"],
            "textposition": "top center",
            "textfont": {"color": "white", "size": 8, "family": "monospace"},
            "name": f"Seq {seq_id}",
            "legendgroup": "sequences",
            **({"legendgrouptitle": {
                    "text": "Sequences",
                    "font": {"color": "white", "size": 9},
                }} if i == 0 else {}),
            "showlegend": True,
            "hovertemplate": f"Seq {seq_id} — START<extra></extra>",
        })

        # End — filled square labelled "E<seq_id>".
        marker_traces.append({
            "type": "scatter",
            "mode": "markers+text",
            "x": [px_vals[-1]],
            "y": [py_vals[-1]],
            "marker": {
                "color": color,
                "size": 11,
                "symbol": "square",
                "line": {"width": 1.5, "color": "white"},
            },
            "text": [f"E{seq_id}"],
            "textposition": "bottom center",
            "textfont": {"color": "white", "size": 8, "family": "monospace"},
            "name": f"Seq {seq_id} end",
            "legendgroup": "sequences",
            "showlegend": False,
            "hovertemplate": f"Seq {seq_id} — END<extra></extra>",
        })

    layout = _dark_layout(
        "Camera Orientation Field (sampled headings)", xlim, ylim
    )
    layout["showlegend"] = True
    layout["legend"] = {
        "bgcolor": "#1a1a2e",
        "bordercolor": "#444444",
        "font": {"color": "white", "size": 8},
        "orientation": "v",
        "x": 1.02,
        "xanchor": "left",
        "y": 0.98,
        "yanchor": "top",
    }
    return {"data": [base_trace] + arrow_traces + marker_traces, "layout": layout}


# ---------------------------------------------------------------------------
# Matplotlib PNG renderers  (used by AddFloorplanSlices)
# ---------------------------------------------------------------------------

def _mpl_dark_axes(ax: plt.Axes, xlim: tuple, ylim: tuple) -> None:
    """Apply the shared dark-theme style to a Matplotlib :class:`~plt.Axes`.

    Parameters
    ----------
    ax:
        The axes object to style in-place.
    xlim, ylim:
        (min, max) tuples for the x and y axis limits.
    """
    ax.set_facecolor(BG_COLOR)
    ax.tick_params(colors="#aaaaaa", labelsize=8)
    for spine in ax.spines.values():
        spine.set_edgecolor("#333333")
    ax.set_xlabel("X position (m)", color="#aaaaaa", fontsize=9)
    ax.set_ylabel("Y position (m)", color="#aaaaaa", fontsize=9)
    ax.set_xlim(xlim)
    ax.set_ylim(ylim)


def _add_zone_overlay(
    ax: plt.Axes,
    xs: np.ndarray,
    ys: np.ndarray,
    cs: np.ndarray,
    *,
    legend_title: str = "Zones",
) -> None:
    """Overlay zone centroid badges and an outside legend on *ax*.

    Uses ``np.bincount`` to compute per-zone means in three O(N) passes
    instead of 32 separate ``cs == zone`` boolean scans.

    Parameters
    ----------
    ax:
        The Matplotlib axes to annotate.
    xs, ys, cs:
        Flat numpy arrays of position and zone-ID values.
    legend_title:
        Title shown above the legend box.
    """
    counts = np.bincount(cs, minlength=17)[1:]           # count per zone
    cx_arr = np.bincount(cs, weights=xs, minlength=17)[1:]
    cy_arr = np.bincount(cs, weights=ys, minlength=17)[1:]

    zone_patches = []
    for i, count in enumerate(counts):
        if count == 0:
            continue
        zone = i + 1
        cx = cx_arr[i] / count
        cy = cy_arr[i] / count
        ax.annotate(
            str(zone),
            xy=(cx, cy),
            fontsize=6.5,
            color="white",
            fontweight="bold",
            ha="center",
            va="center",
            bbox=dict(
                boxstyle="round,pad=0.2",
                fc=_TAB20[i],
                ec="none",
                alpha=0.80,
            ),
        )
        zone_patches.append(
            mpatches.Patch(color=_TAB20[i], label=f"{zone}: {ZONE_NAMES[zone]}")
        )

    ax.legend(
        handles=zone_patches,
        title=legend_title,
        title_fontsize=7,
        fontsize=6,
        loc="upper left",
        bbox_to_anchor=(1.01, 1),
        borderaxespad=0,
        facecolor="#1a1a2e",
        edgecolor="#444",
        labelcolor="white",
        framealpha=0.85,
    )


def _render_kde_png(data: dict, out_path: str) -> None:
    """Render the KDE density heatmap to *out_path* as a PNG.

    Zone centroid badges are drawn on top of the heatmap and a zone legend
    is placed outside the right edge of the axes so the user can relate
    density hotspots to named store areas.

    Parameters
    ----------
    data:
        Frame data dict (from :func:`_frame_data_from_arrays`).
    out_path:
        Absolute file path where the PNG should be saved.
    """
    xs, ys, cs = data["xs"], data["ys"], data["cs"]
    xlim, ylim = data["xlim"], data["ylim"]

    gx, gy, Z = _compute_kde_grid(xs, ys, xlim, ylim, nx=300, ny=130)
    GX, GY = np.meshgrid(gx, gy)

    fig, ax = plt.subplots(figsize=_FIG_SIZE, facecolor=BG_COLOR)
    ax.set_title("Cart Trajectory Density (KDE)", color="white", fontsize=11, pad=8)
    ax.contourf(GX, GY, Z, levels=40, cmap="inferno")
    ax.contour(GX, GY, Z, levels=10, colors="white", linewidths=0.3, alpha=0.25)

    _add_zone_overlay(ax, xs, ys, cs)
    _mpl_dark_axes(ax, xlim, ylim)

    fig.tight_layout()
    fig.savefig(out_path, dpi=_SAVE_DPI, bbox_inches="tight", facecolor=BG_COLOR)
    plt.close(fig)


def _render_trajectories_png(data: dict, out_path: str) -> None:
    """Render combined trajectory paths + zone map to *out_path*.

    Zone scatter is drawn as a semi-transparent background so the store
    geography is visible.  Trajectory lines are drawn on top with labelled
    start (circle) and end (square) markers.  Sequence and zone legends are
    placed fully outside the axes using ``bbox_to_anchor`` so they never
    occlude data.

    Parameters
    ----------
    data:
        Frame data dict.
    out_path:
        Absolute file path for the PNG.
    """
    xs, ys, cs = data["xs"], data["ys"], data["cs"]
    xlim, ylim = data["xlim"], data["ylim"]
    seq_groups = data["seq_groups"]

    seq_colors = plt.cm.Set1(np.linspace(0, 0.9, max(len(seq_groups), 1)))

    fig, ax = plt.subplots(figsize=_FIG_SIZE, facecolor=BG_COLOR)
    ax.set_title("Trajectories & Zone Map", color="white", fontsize=11, pad=8)

    # Zone scatter background (shuffled so rare zones aren't buried).
    rng = np.random.default_rng(_SCATTER_RNG_SEED)
    plot_idx = rng.permutation(len(xs))
    ax.scatter(
        xs[plot_idx], ys[plot_idx],
        c=_TAB20[cs[plot_idx] - 1],  # numpy fancy index — no Python loop
        s=1.5, alpha=0.15, linewidths=0,
    )

    # Trajectory lines + start / end markers.
    legend_handles = []
    for (seq_id, pts), col in zip(sorted(seq_groups.items()), seq_colors):
        px, py = zip(*pts)

        ax.plot(px, py, lw=0.8, alpha=0.9, color=col)

        ax.plot(px[0], py[0], "o", markersize=7, color=col,
                markeredgecolor="white", markeredgewidth=0.8)
        ax.annotate(
            f"S{seq_id}", xy=(px[0], py[0]),
            fontsize=6, color="white", fontweight="bold",
            ha="center", va="bottom",
            xytext=(0, 5), textcoords="offset points",
        )

        ax.plot(px[-1], py[-1], "s", markersize=7, color=col,
                markeredgecolor="white", markeredgewidth=0.8)
        ax.annotate(
            f"E{seq_id}", xy=(px[-1], py[-1]),
            fontsize=6, color="white", fontweight="bold",
            ha="center", va="top",
            xytext=(0, -5), textcoords="offset points",
        )

        legend_handles.append(mpatches.Patch(color=col, label=f"Seq {seq_id}"))

    # Sequence legend outside the axes; add as artist so zone legend can
    # follow below without overwriting it.
    seq_legend = ax.legend(
        handles=legend_handles,
        title="Sequences",
        title_fontsize=7,
        fontsize=7,
        loc="upper left",
        bbox_to_anchor=(1.01, 1),
        borderaxespad=0,
        facecolor="#1a1a2e",
        edgecolor="#444",
        labelcolor="white",
        framealpha=0.8,
    )
    ax.add_artist(seq_legend)

    # Zone centroid badges + zone legend (delegates entirely to helper).
    _add_zone_overlay(ax, xs, ys, cs)
    _mpl_dark_axes(ax, xlim, ylim)

    fig.tight_layout()
    fig.savefig(out_path, dpi=_SAVE_DPI, bbox_inches="tight", facecolor=BG_COLOR)
    plt.close(fig)


def _render_orientation_png(data: dict, out_path: str) -> None:
    """Render the orientation field (heading arrows) to *out_path*.

    Spatially samples one arrow per grid cell and colours them by heading
    angle using the HSV colour map.  Zone centroid badges and a zone legend
    are overlaid so the user can relate heading patterns to specific store
    areas.

    Parameters
    ----------
    data:
        Frame data dict.
    out_path:
        Absolute file path for the PNG.
    """
    xs, ys = data["xs"], data["ys"]
    us, vs = data["us"], data["vs"]
    cs     = data["cs"]
    xlim, ylim = data["xlim"], data["ylim"]
    seq_groups = data["seq_groups"]

    gx, gy, Z = _compute_kde_grid(xs, ys, xlim, ylim, nx=300, ny=130)
    GX, GY = np.meshgrid(gx, gy)

    fig, ax = plt.subplots(figsize=_FIG_SIZE, facecolor=BG_COLOR)
    ax.set_title(
        "Camera Orientation Field (sampled headings)", color="white", fontsize=11, pad=8
    )
    ax.contourf(GX, GY, Z, levels=30, cmap="Blues", alpha=0.4)

    arrow_x, arrow_y, arrow_u, arrow_v, headings = _sample_arrows_by_grid(
        xs, ys, us, vs, xlim, ylim
    )

    norm = mcolors.Normalize(vmin=-180, vmax=180)
    arrow_colors = plt.cm.hsv(norm(np.array(headings)))

    ax.quiver(
        arrow_x, arrow_y, arrow_u, arrow_v,
        color=arrow_colors,
        scale=28, width=0.003, headwidth=4, headlength=4,
        alpha=0.85,
    )

    # ---- Sequence start / end markers + legend -----------------------------
    seq_colors = plt.cm.Set1(np.linspace(0, 0.9, max(len(seq_groups), 1)))
    legend_handles = []
    for (seq_id, pts), col in zip(sorted(seq_groups.items()), seq_colors):
        px, py = zip(*pts)

        ax.plot(px[0], py[0], "o", markersize=7, color=col,
                markeredgecolor="white", markeredgewidth=0.8)
        ax.annotate(
            f"S{seq_id}", xy=(px[0], py[0]),
            fontsize=6, color="white", fontweight="bold",
            ha="center", va="bottom",
            xytext=(0, 5), textcoords="offset points",
        )

        ax.plot(px[-1], py[-1], "s", markersize=7, color=col,
                markeredgecolor="white", markeredgewidth=0.8)
        ax.annotate(
            f"E{seq_id}", xy=(px[-1], py[-1]),
            fontsize=6, color="white", fontweight="bold",
            ha="center", va="top",
            xytext=(0, -5), textcoords="offset points",
        )

        legend_handles.append(mpatches.Patch(color=col, label=f"Seq {seq_id}"))

    seq_legend = ax.legend(
        handles=legend_handles,
        title="Sequences",
        title_fontsize=7,
        fontsize=7,
        loc="upper left",
        bbox_to_anchor=(1.01, 1),
        borderaxespad=0,
        facecolor="#1a1a2e",
        edgecolor="#444",
        labelcolor="white",
        framealpha=0.8,
    )
    ax.add_artist(seq_legend)

    _add_zone_overlay(ax, xs, ys, cs)
    _mpl_dark_axes(ax, xlim, ylim)

    fig.tight_layout()
    fig.savefig(out_path, dpi=_SAVE_DPI, bbox_inches="tight", facecolor=BG_COLOR)
    plt.close(fig)
