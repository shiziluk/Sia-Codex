// First-party test specimen; this module is parsed, never executed.
function metadata(t) {
  let e = t.requestMeta?.["x-codex-turn-metadata"];
  if (typeof e == "string") try { e = JSON.parse(e); } catch { return; }
  if (!(e == null || typeof e != "object" || Array.isArray(e))) return e;
}
function zE(e) {
  if (!Array.isArray(e) || e.length > 16) throw new Error("Invalid request_headers policy.");
  return e.map(r => ({ name: r.name, value: r.value }));
}
var Browser = class extends Base {
  constructor(r,n,o,i,s,a,l) {
    super(r);
    this.apiTransport=r;this.getTurnMetadata=o;this.turnEndedTracker=i;
    this.readRequestHeaders=s;this.browserSurface=a;this.assertAccess=l;
    this.registerRequestHandlerObject(n);
  }
  async getInfo() {
    let r=await this.sendSessionRequest("getInfo",{});
    return this.clientInfo=r,r;
  }
  async sendSessionRequest(r,n) {
    let o=this.getSessionParams();
    let s=await this.readRequestHeaders();
    this.clientInfo.requestHeadersVersion===1&&(o.request_headers=zE(s??[]));
    return this.sendRequest(r,{...n,...o});
  }
};
function refresh() {
  return new Browser(r,this.clientApi,()=>metadata(this.runtime),this.turnEndedTracker,
    async()=>this.preferences?.getExtensionRequestHeaders());
}
