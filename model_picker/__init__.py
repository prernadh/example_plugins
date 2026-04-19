import fiftyone as fo
import fiftyone.operators as foo
from fiftyone.operators import types
from collections import defaultdict


# Helper functions for notes storage
def get_field_notes(dataset):
    """Get notes for all label fields from dataset metadata"""
    notes_key = "model_picker_field_notes"
    if dataset.info and notes_key in dataset.info:
        return dataset.info[notes_key]
    return {}


def save_field_notes(dataset, notes):
    """Save notes for all label fields to dataset metadata"""
    notes_key = "model_picker_field_notes"
    dataset.info[notes_key] = notes
    dataset.save()


# Helper functions shared across operators
def get_all_label_fields(dataset):
    """Get all label fields from dataset (both sample and frame level)"""
    sample_label_fields = dataset.get_field_schema(embedded_doc_type=fo.Label)
    frame_label_fields = dataset.get_frame_field_schema(embedded_doc_type=fo.Label)

    if sample_label_fields:
        sample_label_fields = list(sample_label_fields.keys())
    else:
        sample_label_fields = []

    if frame_label_fields:
        frame_label_fields = list(frame_label_fields.keys())
    else:
        frame_label_fields = []

    return sample_label_fields + frame_label_fields


def generate_field_eval_mapping(dataset, label_fields):
    """Generate mapping of fields to their associated evaluation fields with role info"""
    label_eval_mapping = defaultdict(list)

    all_eval_keys = dataset.list_evaluations()
    for eval_key in all_eval_keys:
        result = dataset.load_evaluation_results(eval_key)
        config = result.config
        if config.pred_field in label_fields:
            label_eval_mapping[config.pred_field].append({
                "eval_key": eval_key,
                "role": "prediction"
            })
        if config.gt_field in label_fields:
            label_eval_mapping[config.gt_field].append({
                "eval_key": eval_key,
                "role": "ground_truth"
            })
    return label_eval_mapping


def generate_field_exclude_mapping(dataset, label_fields):
    """Generate mapping of fields to exclude when hiding a label field"""
    label_eval_mapping = generate_field_eval_mapping(dataset, label_fields)

    sample_schema = list(dataset.get_field_schema(flat=True).keys())
    frame_schema = dataset.get_frame_field_schema(flat=True)
    if frame_schema is None:
        frame_schema = []
    else:
        frame_schema = list(frame_schema.keys())

    all_fields = sample_schema + frame_schema
    fields_exclude_map = defaultdict(list)

    for field in label_fields:
        associated_fields = [field]
        eval_infos = label_eval_mapping[field]
        for eval_info in eval_infos:
            eval_key = eval_info["eval_key"]
            associated_fields.extend([f for f in all_fields if eval_key in f and not f.startswith(field)])
        fields_exclude_map[field] = list(set(associated_fields))

    return fields_exclude_map


class UpdateFieldNotes(foo.Operator):
    """Updates notes for a specific label field"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="update_field_notes",
            label="Update Field Notes",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def execute(self, ctx):
        """Save notes for the specified field"""
        field_name = ctx.params.get("field_name")
        notes_text = ctx.params.get("notes", "")

        # Get existing notes
        all_notes = get_field_notes(ctx.dataset)

        # Update notes for this field
        if notes_text:
            all_notes[field_name] = notes_text
        elif field_name in all_notes:
            # Remove empty notes
            del all_notes[field_name]

        # Save back to dataset
        save_field_notes(ctx.dataset, all_notes)

        return {"success": True}


class GetLabelFieldsMetadata(foo.Operator):
    """Returns label field information for the panel"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_label_fields_metadata",
            label="Get Label Fields Metadata",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def execute(self, ctx):
        """Return structured label field metadata"""
        sample_schema = ctx.dataset.get_field_schema(embedded_doc_type=fo.Label)
        frame_schema = ctx.dataset.get_frame_field_schema(embedded_doc_type=fo.Label)

        all_label_fields = get_all_label_fields(ctx.dataset)

        label_eval_mapping = generate_field_eval_mapping(ctx.dataset, all_label_fields)

        # Get notes for all fields
        field_notes = get_field_notes(ctx.dataset)

        sample_fields = []
        if sample_schema:
            for field_name, field_obj in sample_schema.items():
                sample_fields.append({
                    "name": field_name,
                    "type": field_obj.document_type.__name__,
                    "level": "sample",
                    "evaluations": label_eval_mapping.get(field_name, []),
                    "notes": field_notes.get(field_name, "")
                })

        frame_fields = []
        if frame_schema:
            for field_name, field_obj in frame_schema.items():
                frame_fields.append({
                    "name": field_name,
                    "type": field_obj.document_type.__name__,
                    "level": "frame",
                    "evaluations": label_eval_mapping.get(field_name, []),
                    "notes": field_notes.get(field_name, "")
                })

        return {
            "sample_fields": sample_fields,
            "frame_fields": frame_fields,
            "total_count": len(sample_fields) + len(frame_fields)
        }


class GetLabelFieldsStatistics(foo.Operator):
    """Returns statistics about label fields (count, classes)"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_label_fields_statistics",
            label="Get Label Fields Statistics",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def execute(self, ctx):
        """Return label count and class information for each field"""
        sample_schema = ctx.dataset.get_field_schema(embedded_doc_type=fo.Label)
        frame_schema = ctx.dataset.get_frame_field_schema(embedded_doc_type=fo.Label)

        # Get notes for all fields
        field_notes = get_field_notes(ctx.dataset)

        def get_field_stats(field_name, field_obj, level):
            """Get statistics for a single field"""
            doc_type = field_obj.document_type
            stats = {
                "name": field_name,
                "level": level,
                "type": doc_type.__name__,
                "total_labels": 0,
                "classes": [],
                "notes": field_notes.get(field_name, "")
            }

            try:
                if level == "sample":
                    field_path = field_name
                else:  # frame level
                    field_path = f"frames.{field_name}"

                # Count label instances based on label type
                if doc_type == fo.Detections:
                    # Count total detections across all samples
                    stats["total_labels"] = ctx.dataset.count(f"{field_path}.detections")
                    classes = ctx.dataset.distinct(f"{field_path}.detections.label")
                elif doc_type == fo.Classification:
                    # Count non-null classifications
                    stats["total_labels"] = ctx.dataset.count(f"{field_path}.label")
                    classes = ctx.dataset.distinct(f"{field_path}.label")
                elif doc_type == fo.Polylines:
                    # Count total polylines
                    stats["total_labels"] = ctx.dataset.count(f"{field_path}.polylines")
                    classes = ctx.dataset.distinct(f"{field_path}.polylines.label")
                elif doc_type == fo.Keypoints:
                    # Count total keypoints
                    stats["total_labels"] = ctx.dataset.count(f"{field_path}.keypoints")
                    classes = ctx.dataset.distinct(f"{field_path}.keypoints.label")
                else:
                    # Generic fallback - count non-null fields
                    stats["total_labels"] = ctx.dataset.count(field_path)
                    try:
                        classes = ctx.dataset.distinct(f"{field_path}.label")
                    except:
                        classes = []

                stats["classes"] = sorted([c for c in classes if c is not None])
            except Exception:
                # If field doesn't support label counting, leave defaults
                pass

            return stats

        sample_stats = []
        if sample_schema:
            for field_name, field_obj in sample_schema.items():
                sample_stats.append(get_field_stats(field_name, field_obj, "sample"))

        frame_stats = []
        if frame_schema:
            for field_name, field_obj in frame_schema.items():
                frame_stats.append(get_field_stats(field_name, field_obj, "frame"))

        return {
            "sample_fields": sample_stats,
            "frame_fields": frame_stats
        }


class ApplyModelPicker(foo.Operator):
    """Applies model picker filtering based on selected fields"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="apply_model_picker",
            label="Apply Model Picker",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def resolve_input(self, ctx):
        """Accept list of selected field names"""
        inputs = types.Object()
        inputs.list(
            "selected_fields",
            types.String(),
            required=True,
            label="Selected Fields",
            description="List of label fields to keep visible"
        )
        return types.Property(inputs)

    def execute(self, ctx):
        """Filter view to show only selected fields"""
        selected_fields = ctx.params.get("selected_fields", [])

        all_fields = get_all_label_fields(ctx.dataset)
        fields_to_hide = [f for f in all_fields if f not in selected_fields]
        field_exclude_mapping = generate_field_exclude_mapping(ctx.dataset, all_fields)

        exclude_fields = []
        for field in fields_to_hide:
            exclude_fields.extend(field_exclude_mapping.get(field, []))

        if exclude_fields:
            view = ctx.dataset.exclude_fields(list(set(exclude_fields)))
            ctx.ops.set_view(view)

        return {
            "excluded_count": len(fields_to_hide),
            "selected_count": len(selected_fields)
        }


class ModelPicker(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="model_picker",
            label="Model Picker",
            description="Plugin to pick models to work with in the sidebar",
            allow_immediate_execution=True,
        )
    
    def resolve_placement(self, ctx):
        return types.Placement(
            types.Places.SAMPLES_GRID_ACTIONS,
            types.Button(
                label="Model Picker",
                icon="app_registration",
                prompt=True,
            ),
        )
    
    def resolve_input(self, ctx):
        inputs = types.Object()

        label_fields = get_all_label_fields(ctx.dataset)
        
        for label_name in label_fields:
            inputs.bool(
                label_name,
                default=True,
                label=label_name,
                description=None,
                view=types.CheckboxView(),
            )
        view = types.View(label="Pick the models to work with!")
            
        return types.Property(inputs, view=view)
    
    def execute(self, ctx):
        label_fields = get_all_label_fields(ctx.dataset)
        field_exclude_mapping = generate_field_exclude_mapping(ctx.dataset, label_fields)
        selected_fields = []
        for label in label_fields:
            if not ctx.params[label]:
                selected_fields.append(label)

        exclude_fields = []
        for label in selected_fields:
            exclude_fields.extend(field_exclude_mapping[label])

        view = ctx.dataset.exclude_fields(exclude_fields)
        ctx.ops.set_view(view)

        return {}


class SaveModelPickerView(foo.Operator):
    """Saves current view as a FiftyOne saved view with [Model Picker] prefix"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="save_model_picker_view",
            label="Save Model Picker View",
            unlisted=True,
            dynamic=True,
        )

    def resolve_input(self, ctx):
        """Shows modal to collect view name, description, and color"""
        inputs = types.Object()

        # Get list of existing saved views for autocomplete
        saved_views = ctx.dataset.list_saved_views()
        saved_view_selector = types.AutocompleteView()
        for key in saved_views:
            saved_view_selector.add_choice(key, label=key)

        inputs.str(
            "name",
            required=True,
            label="Name",
            description="A new or existing name for the view",
            view=saved_view_selector,
        )

        inputs.str(
            "description",
            required=False,
            label="Description",
            description="An optional description (will be prefixed with [Model Picker])",
        )

        inputs.str(
            "color",
            required=False,
            label="Color",
            description="An optional RGB color string like `#FF6D04` for the view",
        )

        name = ctx.params.get("name", None)

        if name and name in saved_views:
            inputs.view(
                "overwrite",
                types.Notice(
                    label=f"This will overwrite existing saved view '{name}'"
                ),
            )

        return types.Property(inputs, view=types.View(label="Save Model Picker view"))

    def execute(self, ctx):
        """Save the current view with [Model Picker] prefix in description"""
        name = ctx.params.get("name", None)
        description = ctx.params.get("description", None)
        color = ctx.params.get("color", None)

        # Add [Model Picker] prefix to description
        if description:
            full_description = f"[Model Picker] {description}"
        else:
            full_description = "[Model Picker]"

        # Save the current view (ctx.view contains the filtered view)
        ctx.dataset.save_view(
            name,
            ctx.view,
            description=full_description,
            color=color,
            overwrite=True,
        )

        ctx.trigger("reload_dataset")

        # Return the view name so it can be loaded after saving
        return {"view_name": name}


class ListModelPickerViews(foo.Operator):
    """Lists all saved views created by Model Picker"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="list_model_picker_views",
            label="List Model Picker Views",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def execute(self, ctx):
        """Return list of saved views created by Model Picker"""
        all_saved_views = ctx.dataset.list_saved_views()

        model_picker_views = []
        for view_name in all_saved_views:
            info = ctx.dataset.get_saved_view_info(view_name)
            description = info.get("description", None)

            # Filter for views created by Model Picker
            # Handle case where description could be None
            if description and description.startswith("[Model Picker]"):
                # Remove the [Model Picker] prefix from description
                clean_description = description.replace("[Model Picker]", "").strip()

                model_picker_views.append({
                    "name": view_name,
                    "description": clean_description,
                    "created_at": info.get("created_at"),
                    "last_modified_at": info.get("last_modified_at"),
                })

        return {
            "views": model_picker_views,
            "total_count": len(model_picker_views)
        }


class DeleteModelPickerView(foo.Operator):
    """Deletes a saved view created by Model Picker"""

    @property
    def config(self):
        return foo.OperatorConfig(
            name="delete_model_picker_view",
            label="Delete Model Picker View",
            unlisted=True,
            allow_immediate_execution=True,
        )

    def execute(self, ctx):
        """Delete the specified saved view"""
        view_name = ctx.params.get("name")

        if not view_name:
            return {"success": False, "error": "View name is required"}

        try:
            # Check if the view exists
            all_views = ctx.dataset.list_saved_views()
            if view_name not in all_views:
                return {"success": False, "error": f"View '{view_name}' does not exist"}

            # Delete the saved view
            ctx.dataset.delete_saved_view(view_name)

            return {
                "success": True,
                "deleted_view": view_name
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }


def register(plugin):
    plugin.register(UpdateFieldNotes)
    plugin.register(GetLabelFieldsMetadata)
    plugin.register(GetLabelFieldsStatistics)
    plugin.register(ApplyModelPicker)
    plugin.register(SaveModelPickerView)
    plugin.register(ListModelPickerViews)
    plugin.register(DeleteModelPickerView)
    plugin.register(ModelPicker)
