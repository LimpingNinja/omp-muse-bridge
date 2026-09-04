import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerMuseProvider } from "./provider.ts";
import { registerMuseSetupCommands } from "./setup.ts";

export default function museBridge(pi: ExtensionAPI): void {
	registerMuseProvider(pi);
	registerMuseSetupCommands(pi);
}
