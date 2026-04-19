"""
operator.py
===========
AddFloorplanSlices — FiftyOne operator for the EgoCart Cart-Movement plugin.
"""

from pathlib import Path

import fiftyone as fo
import fiftyone.operators as foo
import fiftyone.operators.types as types

from .plotting import (
    _frame_data_from_arrays,
    _load_frame_data,
    _render_kde_png,
    _render_orientation_png,
    _render_trajectories_png,
)


# ---------------------------------------------------------------------------
# Slice metadata
# ---------------------------------------------------------------------------

#: Canonical ordered list of all supported floorplan plot types.
SLICE_NAMES = ("kde", "trajectories", "orientation")

#: Human-readable labels shown in the operator form for each plot type.
SLICE_LABELS = {
    "kde":          "KDE density heatmap",
    "trajectories": "Trajectories & Zone Map",
    "orientation":  "Orientation field",
}

#: One-sentence descriptions shown beneath each checkbox in the input form.
SLICE_DESCRIPTIONS = {
    "kde": (
        "Gaussian kernel density estimate of all cart positions rendered as a "
        "filled contour heatmap (inferno palette).  Highlights the areas of "
        "the store where the cart spent the most time."
    ),
    "trajectories": (
        "Zone scatter (semi-transparent background) with trajectory lines per "
        "sequence overlaid on top.  Circle markers (S) show sequence start "
        "positions; square markers (E) show end positions.  Zone centroids are "
        "annotated with their numeric label so the shopping-route context is "
        "immediately visible."
    ),
    "orientation": (
        "Spatially sampled heading arrows (one per grid cell) overlaid on a "
        "low-opacity density base.  Arrow colour encodes heading angle via the "
        "HSV colour wheel, revealing the dominant directions of cart travel "
        "across the store floor."
    ),
}

#: Maps each slice name to its Matplotlib renderer function.
_RENDERERS = {
    "kde":          _render_kde_png,
    "trajectories": _render_trajectories_png,
    "orientation":  _render_orientation_png,
}

#: Prefix used when naming global (dataset-level) PNG files.
_GLOBAL_PREFIX = "global"


def _selected_slices(params: dict) -> tuple[str, ...]:
    """Return the subset of :data:`SLICE_NAMES` the user has ticked.

    Each plot type is stored as a separate boolean param named
    ``plot_<slice_name>``.  If none are ticked we fall back to all three so
    the operator never produces zero output.

    Parameters
    ----------
    params:
        The ``ctx.params`` dict from the operator execution context.

    Returns
    -------
    tuple of str
        Ordered slice names that should be generated.
    """
    chosen = tuple(s for s in SLICE_NAMES if params.get(f"plot_{s}", True))
    return chosen if chosen else SLICE_NAMES


# ---------------------------------------------------------------------------
# Operator
# ---------------------------------------------------------------------------

class AddFloorplanSlices(foo.Operator):
    """Generate floorplan PNGs at sample level, dataset level, or both.

    **Scope options**

    ``sample``
        For every video sample, render the selected plot type(s) using only
        that sample's frames.  PNGs are saved alongside the original video
        file using the same base filename (e.g. ``seq1_kde.png`` next to
        ``seq1.mp4``).  The original video and each generated image are
        combined into a FiftyOne :class:`~fiftyone.core.groups.Group`, giving
        the dataset a grouped structure with slices:
        ``video``, ``kde``, ``trajectories``, ``orientation``
        (depending on what was selected).

    ``global``
        Aggregate *all* frames from the entire dataset and render the
        selected plot type(s) once.  PNGs are saved in the same directory
        as the first sample's video file, named
        ``global_<plot_type>.png``.  No grouping is applied.

    ``both``
        Performs both operations above in sequence.

    **Idempotency**
        If a sample already has a ``group`` field it is overwritten.
        Existing PNG files at the computed paths are silently replaced.

    **Progress**
        The operator uses ``execute_as_generator`` so a progress bar is
        shown in the App during the (potentially slow) rendering step.
    """

    @property
    def config(self) -> foo.OperatorConfig:
        return foo.OperatorConfig(
            name="add_floorplan_slices",
            label="Add Floorplan Group Slices",
            description=(
                "Renders floorplan visualisations at sample level, global "
                "level, or both, and optionally adds them as grouped image "
                "slices to the dataset."
            ),
            icon="/assets/floor-plan-svgrepo-com.svg",
            execute_as_generator=True,  # enables yielded progress updates
            dynamic=True,               # re-evaluates resolve_input on change
            allow_immediate_execution=True,
            allow_delegated_execution=True,
            default_choice_to_delegated=False,
        )

    def resolve_input(self, ctx: foo.ExecutionContext) -> types.Property:
        """Build the dynamic operator input form.

        The form has three sections:

        1. **Scope** – radio group: sample / global / both.
        2. **Plot types** – one checkbox per plot type (all on by default).
        3. **Global output directory** – only shown when scope includes
           ``global``; defaults to the directory of the first sample's video.

        The form re-evaluates when the scope radio changes (``dynamic=True``
        on the config) so the global directory field appears/disappears
        without needing a page reload.

        Parameters
        ----------
        ctx:
            The FiftyOne execution context.

        Returns
        -------
        types.Property
            The input form to render in the App.
        """
        inputs = types.Object()

        n = ctx.dataset.count()

        # ---- Scope ---------------------------------------------------------
        scope_choices = types.RadioGroup()
        scope_choices.add_choice(
            "sample",
            label="Sample level",
            description=(
                f"Render plots per video sample ({n} samples) and add "
                "each as a grouped image slice alongside the video."
            ),
        )
        scope_choices.add_choice(
            "global",
            label="Global (whole dataset)",
            description=(
                "Aggregate all frames and render a single set of plots "
                "covering the entire dataset."
            ),
        )
        scope_choices.add_choice(
            "both",
            label="Both",
            description="Run sample-level AND global rendering.",
        )
        inputs.enum(
            "scope",
            values=["sample", "global", "both"],
            label="Scope",
            view=scope_choices,
            default="sample",
            required=True,
        )

        # ---- Plot type checkboxes ------------------------------------------
        inputs.message(
            "plot_type_header",
            label="Plot types to generate",
            description="Select one or more visualisations to render.",
        )
        for slice_name in SLICE_NAMES:
            inputs.bool(
                f"plot_{slice_name}",
                label=SLICE_LABELS[slice_name],
                description=SLICE_DESCRIPTIONS[slice_name],
                default=True,
            )

        # ---- Global output dir (only when scope includes global) -----------
        scope = ctx.params.get("scope", "sample")
        if scope in ("global", "both"):
            first_fp = ctx.dataset.first().filepath
            default_global_dir = str(Path(first_fp).parent)
            inputs.str(
                "global_output_dir",
                label="Global plots output directory",
                description=(
                    "Directory where the global PNG files will be saved.  "
                    "Files are named ``global_<plot_type>.png``."
                ),
                default=default_global_dir,
                required=True,
            )

        # ---- Warning if dataset already grouped ----------------------------
        if ctx.dataset.group_field and scope in ("sample", "both"):
            inputs.view(
                "already_grouped_warning",
                types.Warning(
                    label="Dataset already grouped",
                    description=(
                        f"The dataset already has group field "
                        f"'{ctx.dataset.group_field}'.  Running the operator "
                        "again will overwrite existing group assignments for "
                        "processed samples."
                    ),
                ),
            )

        return types.Property(
            inputs,
            view=types.View(label="Configure floorplan generation"),
        )

    def execute(self, ctx: foo.ExecutionContext):
        """Render the selected plots at the requested scope.

        **Sample-level flow** (scope ``"sample"`` or ``"both"``)

        For each sample:

        1. Load per-frame data from FiftyOne.
        2. Derive the output PNG path as
           ``<video_dir>/<video_stem>_<plot_type>.png`` — keeping PNGs next
           to their source video.
        3. Render each selected plot type to its PNG path.
        4. Create a :class:`~fiftyone.core.groups.Group`, assign the original
           video to ``"video"`` slice, and create one image
           :class:`~fiftyone.core.sample.Sample` per plot type.
        5. Bulk-add all new samples and set ``dataset.group_field``.

        **Global flow** (scope ``"global"`` or ``"both"``)

        1. Load aggregated frame data from the entire dataset.
        2. Render each selected plot to
           ``<global_output_dir>/global_<plot_type>.png``.
        3. No grouping changes are made.

        Parameters
        ----------
        ctx:
            Execution context.  Relevant params:

            * ``scope`` – ``"sample"``, ``"global"``, or ``"both"``
            * ``plot_<name>`` – bool per plot type
            * ``global_output_dir`` – path for global PNGs

        Yields
        ------
        Progress trigger dicts (required by ``execute_as_generator``).
        """
        scope    = ctx.params.get("scope", "sample")
        selected = _selected_slices(ctx.params)
        dataset  = ctx.dataset

        sample_count = 0
        global_count = 0

        # ================================================================
        # Sample-level rendering
        # ================================================================
        if scope in ("sample", "both"):
            # ---- Step 1: capture all data BEFORE activating grouped mode ---
            #
            # dataset.add_group_field() (called below) changes how the
            # dataset iterates: once grouped mode is active, list(dataset)
            # filters to the default_group_slice.  We must therefore capture
            # every value we need from the flat dataset first, before any
            # schema changes.
            #
            # dataset.values() bulk-loads per-sample frame data as a nested
            # list (one inner list per sample) — the only reliable way to
            # separate frames by sample without loading each sample's
            # frames individually (which would see all frames when called on
            # a select_fields view that excludes frame fields).
            filepaths    = dataset.values("filepath")
            sequence_ids = dataset.values("sequence_id")
            xs_nested    = dataset.values("frames.location_x")
            ys_nested    = dataset.values("frames.location_y")
            us_nested    = dataset.values("frames.orientation_u")
            vs_nested    = dataset.values("frames.orientation_v")
            cs_nested    = dataset.values("frames.zone_id")

            # Capture sample objects while the dataset is still flat so
            # that we can call sample.save() on them later to persist group
            # field assignments.
            samples = list(dataset)
            total   = len(samples)

            # ---- Step 2: activate grouped mode properly -------------------
            #
            # add_group_field() must be called (not add_sample_field) so
            # that it executes _add_group_field() internally, which:
            #   • sets dataset.media_type → "group"   ← most critical step
            #   • initialises group_media_types = {}
            #   • sets group_field and default_group_slice
            #   • creates MongoDB indexes for grouped queries
            #
            # Skipping any of these (e.g. using add_sample_field + manual
            # group_field assignment) results in the App raising
            # "DatasetView has no group slice 'video'" because FiftyOne
            # never registers the video samples' slice in its internal
            # registry, and because the group indexes are absent so the
            # grouped-query path cannot locate the original video samples.
            if not dataset.has_sample_field("group"):
                dataset.add_group_field("group", default="video")

            # ---- Step 3: render PNGs and update existing sample records ---
            new_image_samples: list[fo.Sample] = []

            for i, sample in enumerate(samples):
                seq_id = str(sequence_ids[i])

                # Build per-sample frame data from the bulk-loaded arrays.
                # Index [i] gives frame values for this sample only.
                frame_data = _frame_data_from_arrays(
                    xs_nested[i], ys_nested[i],
                    us_nested[i], vs_nested[i],
                    cs_nested[i], seq_id,
                )

                # Save PNGs alongside the source video using the same stem.
                # e.g. /data/egocart_seq_1.mp4 → /data/egocart_seq_1_kde.png
                video_path = Path(filepaths[i])
                base_stem  = video_path.stem
                output_dir = video_path.parent

                png_paths: dict[str, str] = {}
                for slice_name in selected:
                    png_path = str(output_dir / f"{base_stem}_{slice_name}.png")
                    _RENDERERS[slice_name](frame_data, png_path)
                    png_paths[slice_name] = png_path

                # Assign the original video sample to the "video" slice of
                # a new group and persist.  The "group" field now exists in
                # the schema (added above), so save() works correctly.
                group = fo.Group()
                sample.group = group.element("video")
                sample.save()

                # Create one image sample per rendered plot type, sharing
                # the same group ID so FiftyOne links them together.
                for slice_name in selected:
                    new_image_samples.append(fo.Sample(
                        filepath=png_paths[slice_name],
                        group=group.element(slice_name),
                        sequence_id=sample.sequence_id,
                    ))

                sample_count += 1
                yield ctx.trigger(
                    "set_progress",
                    {
                        "progress": (i + 1) / total,
                        "label": f"[Sample] {i + 1}/{total}: seq {seq_id}",
                    },
                )

            # ---- Step 4: add image samples and register all slices --------
            #
            # add_samples() registers image slice names ("kde", etc.) in
            # dataset.group_media_types automatically.
            dataset.add_samples(new_image_samples)

            # sample.save() does NOT update group_media_types — only
            # add_samples() does.  The "video" slice therefore needs to be
            # registered explicitly via the public add_group_slice() API.
            if "video" not in dataset.group_slices:
                dataset.add_group_slice("video", fo.core.media.VIDEO)

            # Ensure the App defaults to the original video slice.
            dataset.default_group_slice = "video"
            dataset.save()

        # ================================================================
        # Global rendering
        # ================================================================
        if scope in ("global", "both"):
            global_dir = Path(
                ctx.params.get(
                    "global_output_dir",
                    str(Path(dataset.first().filepath).parent),
                )
            )
            global_dir.mkdir(parents=True, exist_ok=True)

            global_data = _load_frame_data(dataset)

            for j, slice_name in enumerate(selected):
                png_path = str(global_dir / f"{_GLOBAL_PREFIX}_{slice_name}.png")
                _RENDERERS[slice_name](global_data, png_path)
                global_count += 1

                yield ctx.trigger(
                    "set_progress",
                    {
                        "progress": (j + 1) / len(selected),
                        "label": (
                            f"[Global] {j + 1}/{len(selected)}: "
                            f"{SLICE_LABELS[slice_name]}"
                        ),
                    },
                )

        # Mark completion.  ctx.ops.notify() does not fire reliably from
        # generator operators, so the refresh reminder is carried entirely
        # by the resolve_output markdown panel below.
        yield ctx.trigger(
            "set_progress",
            {"progress": 1.0, "label": "Done — refresh your browser to continue"},
        )

        # Build the markdown summary here so resolve_output can read it
        # directly from ctx.results without mutating the dict itself.
        lines = [
            "## Floorplan Generation Complete\n",
            "> **Action required:** press **Cmd+R** (macOS) or "
            "**Ctrl+R** (Windows / Linux) to reload the browser and see "
            "the new group slices in the App.\n",
            f"**Scope:** `{scope}`\n",
            "**Plot types generated:** "
            + ", ".join(f"`{s}`" for s in selected) + "\n",
        ]
        if scope in ("sample", "both"):
            lines.append(
                f"\n### Sample level\n"
                f"Processed **{sample_count}** video samples. "
                f"Each now has group slices: `video` + "
                + ", ".join(f"`{s}`" for s in selected) + "."
            )
        if scope in ("global", "both"):
            lines.append(
                f"\n### Global level\n"
                f"Generated **{global_count}** aggregate plot(s) saved to disk."
            )

        yield {
            "status": "complete",
            "scope": scope,
            "selected_slices": list(selected),
            "sample_count": sample_count,
            "global_count": global_count,
            "summary": "\n".join(lines),
        }

    def resolve_output(self, ctx: foo.ExecutionContext) -> types.Property:
        """Display the markdown completion summary in the operator output panel.

        The summary string is built in :meth:`execute` and returned in the
        result dict, so this method simply reads ``ctx.results["summary"]``
        via the field's ``default`` — the documented FiftyOne pattern.

        Parameters
        ----------
        ctx:
            Execution context, populated with the ``execute`` return value.

        Returns
        -------
        types.Property
            Markdown summary property.
        """
        outputs = types.Object()
        outputs.str(
            "summary",
            label="Result",
            view=types.MarkdownView(),
            default=ctx.results.get("summary", ""),
        )
        return types.Property(outputs)
