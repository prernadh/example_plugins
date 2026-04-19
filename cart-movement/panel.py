"""
panel.py
========
FloorplanPanel — static three-chart Plotly panel for ``egocart_videos``.
"""

import fiftyone.operators as foo
import fiftyone.operators.types as types

from .plotting import (
    _PANEL_HEIGHT_PX,
    _build_kde_figure,
    _build_orientation_figure,
    _build_trajectories_zones_figure,
    _load_frame_data,
)


class FloorplanPanel(foo.Panel):
    """Static three-chart floorplan panel for ``egocart_videos``.

    Opens alongside the main sample grid.  On load it reads all frame-level
    trajectory fields from the current dataset and renders three Plotly
    charts stacked vertically:

    1. Trajectories & Zone Map – sequence paths overlaid on zone scatter
    2. KDE density heatmap – where the cart spent most of its time
    3. Orientation field – sampled heading arrows

    The panel is intentionally **non-interactive** — there are no click
    handlers, filters, or view-change callbacks.  It is a read-only
    spatial overview of the dataset.

    Computed figures are cached in the FiftyOne execution store (keyed by
    dataset ID and schema version) so subsequent opens are instant.
    """

    #: Bump this when the figure schema changes to invalidate old caches.
    _VERSION = "v1"

    def _get_store_key(self, ctx: foo.ExecutionContext) -> str:
        """Return a namespaced execution-store key for this panel + dataset."""
        return f"floorplan_panel_{ctx.dataset._doc.id}_{self._VERSION}"

    @property
    def config(self) -> foo.PanelConfig:
        return foo.PanelConfig(
            name="floorplan_panel",
            label="EgoCart Floorplan",
            surfaces="grid",
            help_markdown=(
                "Displays three floorplan visualisations derived from the "
                "per-frame trajectory fields of **egocart_videos**.\n\n"
                "* **Trajectories & Zone Map** – sequence paths overlaid on zone scatter\n"
                "* **KDE density** – where the cart spent most time\n"
                "* **Orientation** – sampled heading arrows\n"
            ),
        )

    def on_load(self, ctx: foo.ExecutionContext) -> None:
        """Compute all three Plotly figures and push them to the panel.

        Figures are cached in the FiftyOne execution store keyed by dataset ID
        so repeated panel opens skip the expensive KDE + data-loading step.
        The cache is invalidated when the dataset sample count changes (i.e.
        new videos were added) or when :attr:`_VERSION` is bumped.

        Traces are pushed via ``ctx.panel.set_data(key, traces)`` so the
        runtime wires them to the matching ``panel.obj(key)`` property in
        :meth:`render`.  Because ``ctx.panel.data`` is write-only (Python
        cannot read it back), the layout dict is stored separately in
        ``ctx.panel.state`` so :meth:`render` can retrieve it and pass it
        inline to ``PlotlyView``.  Panel placement is left to FiftyOne's own
        layout manager.

        Parameters
        ----------
        ctx:
            The FiftyOne execution context injected by the plugin runtime.
        """
        store  = ctx.store(self._get_store_key(ctx))
        cached = store.get("figures")

        # Cache hit: dataset size unchanged → push stored figures to panel.
        # ctx.panel.data is write-only, so traces (set_data) and layout
        # (set_state) are kept separate so render() can read the layout back.
        if cached and cached.get("dataset_size") == len(ctx.dataset):
            for key in ("trajectories", "kde", "orientation"):
                ctx.panel.set_data(key, cached[key]["data"])
                ctx.panel.set_state(f"{key}_layout", cached[key]["layout"])
            return

        # Cache miss: (re)build all figures from raw frame data.
        data = _load_frame_data(ctx.dataset)

        figures: dict[str, dict] = {}
        for key, builder, r_margin in (
            # trajectories: wider right margin to fit Sequences + Zones legend
            ("trajectories", _build_trajectories_zones_figure, 200),
            ("kde",          _build_kde_figure,                 20),
            ("orientation",  _build_orientation_figure,         20),
        ):
            fig = builder(data)
            fig["layout"].update({
                "height":   _PANEL_HEIGHT_PX,
                "autosize": True,
                "margin":   {"l": 50, "r": r_margin, "t": 45, "b": 40},
            })
            figures[key] = {"data": fig["data"], "layout": fig["layout"]}
            ctx.panel.set_data(key, fig["data"])
            ctx.panel.set_state(f"{key}_layout", fig["layout"])

        # Persist the full figure dicts so the next open is instant.
        store.set("figures", {**figures, "dataset_size": len(ctx.dataset)})

    def render(self, ctx: foo.ExecutionContext) -> types.Property:
        """Build the panel layout: three plots stacked vertically.

        Layout structure::

            ┌──────────────────────────────────────────────┐
            │  Trajectories & Zone Map  (trajectories)     │
            ├──────────────────────────────────────────────┤
            │  KDE density              (kde)              │
            ├──────────────────────────────────────────────┤
            │  Orientation field        (orientation)      │
            └──────────────────────────────────────────────┘

        Each plot pairs a data key (populated in :meth:`on_load`) with its
        corresponding layout stored in panel state.  The vertical
        ``GridView`` makes the panel scrollable so every chart gets its
        full allocated height.

        Parameters
        ----------
        ctx:
            The FiftyOne execution context.

        Returns
        -------
        types.Property
            The root panel property that FiftyOne renders.
        """
        panel = types.Object()

        # Traces for each key are stored via set_data() in on_load(); the
        # panel runtime wires panel.data[key] to the matching obj() property.
        # Layout is read back from state (ctx.panel.data is write-only) and
        # passed inline to PlotlyView so axis ranges are preserved exactly.
        for key in ("trajectories", "kde", "orientation"):
            layout = getattr(ctx.panel.state, f"{key}_layout") or {}
            panel.obj(
                key,
                view=types.PlotlyView(layout=layout),
            )

        return types.Property(
            panel,
            view=types.GridView(
                orientation="vertical",
                gap=2,
                height=100,
                width=100,
            ),
        )
