# Example FiftyOne Plugins

A collection of example FiftyOne plugins demonstrating panels, operators, and custom workflows.

## Plugins

| Plugin | Description |
| --- | --- |
| [cart-movement](cart-movement) | Floorplan visualizations (KDE density, trajectories, zones, orientation) for the `egocart_videos` dataset. |
| [golden-overlay-modal-panel](golden-overlay-modal-panel) | Overlay a golden reference image on samples for manufacturing defect detection. |
| [hello-world](hello-world) | Minimal example combining JS and Python components in a single plugin. |
| [model_picker](model_picker) | Pick models to run and populate corresponding sidebar fields. |
| [roi-patches-plugin](roi-patches-plugin) | Tile images into a grid of ROI patches for region-based analysis. |
| [temporal-detection-plugin](temporal-detection-plugin) | Temporal data explorer with label timeline heatmap and bidirectional video sync. |
| [yolo-model-tuner-runner](yolo-model-tuner-runner) | Panel to run and fine-tune YOLOv8 models on the current dataset. |

## Installation

Install an individual plugin by pointing FiftyOne at its directory:

```bash
fiftyone plugins download https://github.com/<owner>/example_plugins --plugin-names <plugin-dir>
```

Or clone this repo into your plugins directory:

```bash
git clone <repo-url> $FIFTYONE_PLUGINS_DIR/example_plugins
```

See each plugin's own README (where available) for plugin-specific setup and requirements.
