// This is a local identification requirement, not an identity, rollout or approval result.
function cppNativeIdentificationReader(runtime, fallback, getTurnMetadata, controlPath) {
  return async function () {
    const info = this.clientInfo;
    const turn = getTurnMetadata(runtime);
    const sessionId = turn?.session_id;
    const turnId = turn?.turn_id;
    const instanceId = info?.metadata?.extensionInstanceId;
    const family = info?.family;
    const extensionId = info?.metadata?.extensionId;
    const managedHeaders = info?.requestHeadersVersion === 1;
    const legacyFlag = typeof info?.agentRequestHeaderEnabled === "boolean";
    const supportedBrowser =
      (family === "edge" && extensionId === "odlomjlbamekndcpllcnffbgeohgkmjh") ||
      (family === "chrome" && extensionId === "hehggadaopoacecdllhhajmbjkdcmajg");
    if (info?.type !== "extension" || !supportedBrowser ||
        (!managedHeaders && !legacyFlag) ||
        typeof instanceId !== "string" || !instanceId ||
        typeof sessionId !== "string" || !sessionId ||
        typeof turnId !== "string" || !turnId || sessionId.length > 256 ||
        /[\x00-\x1f\x7f]/.test(sessionId)) {
      return fallback();
    }
    let control;
    try {
      const fs = await import("node:fs/promises");
      const stat = await fs.lstat(controlPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error("Unsupported local control file");
      control = JSON.parse(await fs.readFile(controlPath, "utf8"));
    } catch {
      return fallback();
    }
    // Recheck after I/O; do not apply a decision to a replaced client or ended turn.
    const current = getTurnMetadata(runtime);
    if (this.clientInfo !== info || info.type !== "extension" || info.family !== family ||
        info.metadata?.extensionId !== extensionId ||
        info.metadata?.extensionInstanceId !== instanceId ||
        (managedHeaders ? info.requestHeadersVersion !== 1 :
          typeof info.agentRequestHeaderEnabled !== "boolean") ||
        current?.session_id !== sessionId || current?.turn_id !== turnId || control?.schema !== 1 ||
        control?.requireIdentification !== true) return fallback();
    if (!managedHeaders) return true;
    const inherited = await fallback();
    const after = getTurnMetadata(runtime);
    if (this.clientInfo !== info || info.requestHeadersVersion !== 1 ||
        after?.session_id !== sessionId || after?.turn_id !== turnId) return fallback();
    if (inherited == null) return [{ name: "x-browser-agent", value: `ChatGPT/${sessionId}` }];
    if (!Array.isArray(inherited) || inherited.length > 16 ||
        inherited.some(header => header == null || typeof header !== "object" ||
          typeof header.name !== "string" || typeof header.value !== "string")) {
      return inherited;
    }
    const replacement = { name: "x-browser-agent", value: `ChatGPT/${sessionId}` };
    const index = inherited.findIndex(header => header.name.toLowerCase() === "x-browser-agent");
    if (index >= 0) return inherited.map((header, position) => position === index ? replacement : header);
    if (inherited.length >= 16) {
      throw new Error("Local identification exceeds the managed request-header limit.");
    }
    return [...inherited, replacement];
  };
}
