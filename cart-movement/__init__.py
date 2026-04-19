"""
EgoCart Cart-Movement FiftyOne Plugin
======================================
Provides two capabilities for the ``egocart_videos`` dataset:

1. **FloorplanPanel** – A static Python panel that opens alongside the
   video grid and renders three Plotly charts drawn from the dataset's
   per-frame trajectory fields:

   * Trajectories & Zone Map – sequence paths overlaid on zone scatter
   * KDE density heatmap     – where the cart spent most of its time
   * Orientation field       – sampled heading arrows on a density base

2. **AddFloorplanSlices** – An operator that converts ``egocart_videos``
   from a flat video dataset into a FiftyOne *grouped* dataset in-place.
   For every video sample it renders three Matplotlib figures to PNG files
   and adds them as additional group slices (``kde``, ``trajectories``,
   ``orientation``) alongside the original ``video`` slice.

Dataset contract
----------------
The plugin expects the following fields to exist:

* Sample field  : ``sequence_id``  (str)
* Frame fields  : ``location_x``, ``location_y``  (float)
                  ``orientation_u``, ``orientation_v``  (float)
                  ``zone_id``  (int, values 1–16)

Module layout
-------------
* ``plotting.py``  – constants, data helpers, Plotly builders, Matplotlib renderers
* ``panel.py``     – :class:`FloorplanPanel`
* ``operator.py``  – :class:`AddFloorplanSlices`
* ``__init__.py``  – plugin registration (this file)
"""

import fiftyone.operators as foo

from .operator import AddFloorplanSlices
from .panel import FloorplanPanel


def register(p) -> None:
    """Register all operators and panels with the FiftyOne plugin system.

    Parameters
    ----------
    p:
        The :class:`~fiftyone.operators.Plugin` instance provided by the
        FiftyOne plugin loader.
    """
    p.register(FloorplanPanel)
    p.register(AddFloorplanSlices)
