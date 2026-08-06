/** Oldest daemon protocol this build of rig-connect can read. */
export const MINIMUM_RIG_PROTOCOL_VERSION = 6;
/** Newest daemon protocol this build of rig-connect can read. */
export const MAXIMUM_RIG_PROTOCOL_VERSION = 10;

export type ServerCompatibility =
    | {
          status: "checking";
          maximumSupportedProtocolVersion: number;
          minimumSupportedProtocolVersion: number;
      }
    | {
          status: "compatible";
          maximumSupportedProtocolVersion: number;
          minimumSupportedProtocolVersion: number;
          serverProtocolVersion: number;
      }
    | {
          status: "server_outdated";
          maximumSupportedProtocolVersion: number;
          minimumSupportedProtocolVersion: number;
          serverProtocolVersion: number;
      }
    | {
          status: "client_outdated";
          maximumSupportedProtocolVersion: number;
          minimumSupportedProtocolVersion: number;
          serverProtocolVersion: number;
      };

export const CHECKING_SERVER_COMPATIBILITY: ServerCompatibility = {
    maximumSupportedProtocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION,
    minimumSupportedProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
    status: "checking",
};

/** Classifies one daemon before rig-connect accepts any state from it. */
export function serverCompatibility(protocolVersion: number): ServerCompatibility {
    if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 0) protocolVersion = 0;
    const supported = {
        maximumSupportedProtocolVersion: MAXIMUM_RIG_PROTOCOL_VERSION,
        minimumSupportedProtocolVersion: MINIMUM_RIG_PROTOCOL_VERSION,
        serverProtocolVersion: protocolVersion,
    };
    if (protocolVersion < MINIMUM_RIG_PROTOCOL_VERSION) {
        return { ...supported, status: "server_outdated" };
    }
    if (protocolVersion > MAXIMUM_RIG_PROTOCOL_VERSION) {
        return { ...supported, status: "client_outdated" };
    }
    return { ...supported, status: "compatible" };
}

export function describeServerCompatibility(compatibility: ServerCompatibility): string {
    if (compatibility.status === "server_outdated") {
        return `The Rig server protocol is version ${String(compatibility.serverProtocolVersion)}, but this rig-connect build requires at least version ${String(compatibility.minimumSupportedProtocolVersion)}.`;
    }
    if (compatibility.status === "client_outdated") {
        return `The Rig server protocol is version ${String(compatibility.serverProtocolVersion)}, but this rig-connect build supports at most version ${String(compatibility.maximumSupportedProtocolVersion)}.`;
    }
    return compatibility.status === "compatible"
        ? "The Rig server is compatible."
        : "The Rig server compatibility check is still in progress.";
}
