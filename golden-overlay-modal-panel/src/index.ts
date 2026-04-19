import { PluginComponentType, registerComponent } from "@fiftyone/plugins";
import GoldenOverlayPanel from "./GoldenOverlayPanel";

console.log("[GoldenOverlay] Registering GoldenOverlayPanel");

registerComponent({
  name: "GoldenOverlayPanel",
  label: "Golden Overlay",
  component: GoldenOverlayPanel,
  type: PluginComponentType.Panel,
  panelOptions: { surfaces: "modal" },
});
