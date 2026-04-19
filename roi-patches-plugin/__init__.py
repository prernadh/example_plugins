"""ROI Patches plugin for FiftyOne.

Tiles images into a configurable grid of ROI (Region of Interest) patches
for region-based analysis. Creates virtual crop patches using FiftyOne's
native to_patches() mechanism.

Operators:
    - CreateROIPatches: Add grid-based bounding boxes and switch to patches view
    - ClearROIPatches: Remove ROI patch fields from a dataset
"""

import fiftyone as fo
import fiftyone.operators as foo
from fiftyone.operators import types


def compute_roi_grid(rows, cols, overlap_pct):
    """Compute a grid of ROI bounding boxes in normalized [0, 1] coordinates.

    Args:
        rows: number of rows in the grid (>= 1)
        cols: number of columns in the grid (>= 1)
        overlap_pct: overlap percentage between adjacent tiles [0, 90]

    Returns:
        list of dicts with keys: label, row, col, bounding_box
        where bounding_box is [x, y, w, h] in [0, 1] normalized format
    """
    overlap = overlap_pct / 100.0

    # Tile dimensions
    if cols > 1:
        tile_w = 1.0 / (cols - (cols - 1) * overlap)
    else:
        tile_w = 1.0

    if rows > 1:
        tile_h = 1.0 / (rows - (rows - 1) * overlap)
    else:
        tile_h = 1.0

    # Stride between tile origins
    stride_x = tile_w * (1 - overlap) if cols > 1 else 0
    stride_y = tile_h * (1 - overlap) if rows > 1 else 0

    patches = []
    for r in range(rows):
        for c in range(cols):
            x = c * stride_x
            y = r * stride_y

            # Clamp to [0, 1] for floating-point safety
            x = min(max(x, 0.0), 1.0)
            y = min(max(y, 0.0), 1.0)
            w = min(tile_w, 1.0 - x)
            h = min(tile_h, 1.0 - y)

            patches.append(
                {
                    "label": f"R{r}_C{c}",
                    "row": r,
                    "col": c,
                    "bounding_box": [x, y, w, h],
                }
            )

    return patches


class CreateROIPatches(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="create_roi_patches",
            label="Create ROI patches",
            description=(
                "Tile images into a grid of ROI patches for region-based analysis"
            ),
            dynamic=True,
            allow_delegated_execution=True,
            allow_immediate_execution=True,
            default_choice_to_delegated=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()

        # View target selector (dataset / current view / selected samples)
        inputs.view_target(ctx)

        # Grid configuration
        inputs.int(
            "rows",
            default=2,
            required=True,
            label="Rows",
            description="Number of rows in the grid (1-20)",
            view=types.View(),
        )

        inputs.int(
            "cols",
            default=2,
            required=True,
            label="Columns",
            description="Number of columns in the grid (1-20)",
            view=types.View(),
        )

        inputs.int(
            "overlap_pct",
            default=0,
            required=True,
            label="Overlap %",
            description="Percentage of overlap between adjacent tiles (0-90)",
            view=types.View(),
        )

        inputs.str(
            "field_name",
            default="roi_patches",
            required=True,
            label="Field name",
            description=("The sample field in which to store the ROI patch detections"),
        )

        # Dynamic preview
        rows = ctx.params.get("rows", 2)
        cols = ctx.params.get("cols", 2)
        overlap_pct = ctx.params.get("overlap_pct", 0)

        total_patches = rows * cols
        overlap = overlap_pct / 100.0

        if cols > 1:
            tile_w = 1.0 / (cols - (cols - 1) * overlap)
        else:
            tile_w = 1.0

        if rows > 1:
            tile_h = 1.0 / (rows - (rows - 1) * overlap)
        else:
            tile_h = 1.0

        preview = (
            f"**Grid preview:** {rows} x {cols} = "
            f"**{total_patches} patches** per image\n\n"
            f"Tile size: {tile_w:.1%} x {tile_h:.1%} "
            f"(width x height, relative to image)"
        )
        if overlap_pct > 0:
            preview += f"\n\nOverlap: {overlap_pct:.0f}%"

        inputs.view(
            "preview",
            types.Notice(label=preview),
        )

        return types.Property(inputs, view=types.View(label="Create ROI patches"))

    def execute(self, ctx):
        rows = max(1, min(int(ctx.params["rows"]), 20))
        cols = max(1, min(int(ctx.params["cols"]), 20))
        overlap_pct = max(0, min(int(ctx.params["overlap_pct"]), 90))
        field_name = ctx.params["field_name"]

        target_view = ctx.target_view()

        # Compute grid
        grid = compute_roi_grid(rows, cols, overlap_pct)

        # Apply to all samples — create FRESH detections per sample
        # Each fo.Detection gets a unique _id on creation, so we must
        # build new objects per sample to avoid DuplicateKeyError in
        # to_patches()
        for sample in target_view.iter_samples(autosave=True, progress=True):
            detections = [
                fo.Detection(
                    label=patch["label"],
                    bounding_box=patch["bounding_box"],
                    row=patch["row"],
                    col=patch["col"],
                    overlap_pct=overlap_pct,
                    grid_rows=rows,
                    grid_cols=cols,
                )
                for patch in grid
            ]
            sample[field_name] = fo.Detections(detections=detections)

        ctx.trigger("reload_dataset")


class ClearROIPatches(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="clear_roi_patches",
            label="Clear ROI patches",
            description="Remove ROI patch detection fields from the dataset",
            dynamic=True,
            allow_delegated_execution=True,
            allow_immediate_execution=True,
            default_choice_to_delegated=True,
        )

    def resolve_input(self, ctx):
        inputs = types.Object()

        # Find existing Detections fields on the dataset
        schema = ctx.dataset.get_field_schema(flat=True)
        det_fields = [
            path
            for path, field in schema.items()
            if isinstance(field, fo.EmbeddedDocumentField)
            and field.document_type is fo.Detections
        ]

        if not det_fields:
            inputs.view(
                "warning",
                types.Warning(label="No detection fields found on this dataset"),
            )
            return types.Property(inputs, view=types.View(label="Clear ROI patches"))

        field_choices = types.DropdownView()
        for field_path in sorted(det_fields):
            field_choices.add_choice(field_path, label=field_path)

        inputs.enum(
            "field_name",
            field_choices.values(),
            required=True,
            label="Field to remove",
            description="Select the ROI patches field to delete",
            view=field_choices,
        )

        return types.Property(inputs, view=types.View(label="Clear ROI patches"))

    def execute(self, ctx):
        field_name = ctx.params.get("field_name")
        if not field_name:
            return

        # On Enterprise, delete_sample_field goes through an RPC layer
        # that may fail. Bypass it by calling the underlying function
        # directly via __wrapped__ (preserved by functools.wraps).
        delete_fn = getattr(ctx.dataset._delete_sample_fields, "__wrapped__", None)
        if delete_fn is not None:
            delete_fn(ctx.dataset, field_name, 0)
        else:
            ctx.dataset.delete_sample_field(field_name)

        ctx.trigger("reload_dataset")


def register(plugin):
    plugin.register(CreateROIPatches)
    plugin.register(ClearROIPatches)
