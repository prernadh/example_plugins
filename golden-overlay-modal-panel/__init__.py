"""Golden Overlay — compare samples against a golden reference image."""

import logging

import fiftyone.operators as foo
import fiftyone.operators.types as types

logger = logging.getLogger(__name__)


class GetFilepaths(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_filepaths",
            label="Get Filepaths",
            unlisted=True,
        )

    def execute(self, ctx):
        filepaths = ctx.dataset.values("filepath")
        logger.info("[GoldenOverlay] get_filepaths returning %d paths", len(filepaths))
        return {"filepaths": filepaths}


class GetCurrentSample(foo.Operator):
    @property
    def config(self):
        return foo.OperatorConfig(
            name="get_current_sample",
            label="Get Current Sample",
            unlisted=True,
        )

    def execute(self, ctx):
        logger.info("[GoldenOverlay] get_current_sample called")
        try:
            sample_id = ctx.current_sample
            if sample_id:
                sample = ctx.dataset[sample_id]
                fp = sample.filepath
                logger.info("[GoldenOverlay]   filepath: %s", fp)
                return {"filepath": fp}
        except Exception as e:
            logger.error("[GoldenOverlay]   error: %s", e)
        return {"filepath": None}


def register(p):
    p.register(GetFilepaths)
    p.register(GetCurrentSample)
