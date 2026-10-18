import { getAgentDir, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerProfileCommands } from "./commands.mjs";

export default function (pi: ExtensionAPI) {
  registerProfileCommands(pi, {
    agentDir: getAgentDir(),
    mutate: withFileMutationQueue,
    parameters: Type.Object({
      profile: Type.Object({
        plugins: Type.Array(Type.String()),
        skills: Type.Array(Type.Object({
          source: Type.String(),
          skills: Type.Array(Type.String()),
        }, { additionalProperties: false })),
        "AGENTS.md": Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      globalName: Type.Optional(Type.String({ description: "Register this JSON template globally under a new lowercase-hyphenated name, only if requested by the user." })),
    }, { additionalProperties: false }),
  });
}
