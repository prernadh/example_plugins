import { registerComponent, PluginComponentType } from "@fiftyone/plugins";
import { ModelPickerPanel } from "./ModelPickerPanel";

registerComponent({
  name: "ModelPickerPanel",
  label: "Model Picker",
  component: ModelPickerPanel,
  type: PluginComponentType.Panel,
  activator: myActivator,
});

function myActivator({ dataset }) {
  // Example of activating the plugin in a particular context
  // return dataset.name === 'quickstart'

  return true;
}
