use std::process::Command;

#[test]
fn stepwise_fragments_expose_the_expected_contract() {
    let suggestions =
        include_str!("../../../../assets/inject/floating-panel/stepwise/suggestions.js")
            .replace("\r\n", "\n");
    let generation =
        include_str!("../../../../assets/inject/floating-panel/stepwise/generation.js")
            .replace("\r\n", "\n");

    assert!(suggestions.starts_with("/* Stepwise suggestions:"));
    assert!(suggestions.contains("function uniquePrompts"));
    assert!(suggestions.contains("function parseStepwiseJson"));
    assert!(suggestions.contains("function extractStepwisePayload"));
    assert!(generation.starts_with("/* Stepwise generation:"));
    assert!(generation.contains("function requestBridgeStepwise"));
    assert!(generation.contains("function forceRefreshStepwise"));
    assert!(generation.contains("function fillComposer"));
    assert!(generation.contains("bridgeCall(\n      \"/stepwise/generate\""));
    assert!(generation.contains("requestEpoch === state.stepwiseEpoch"));
    assert!(generation.contains("contextMatches(requestContext)"));
    assert!(generation.contains("if (!isCurrentRuntime() || !stepwiseEnabled()) return;"));
    assert!(generation.contains("state.activeContext.assistantMessageId"));

    for source in [suggestions.as_str(), generation.as_str()] {
        assert!(!source.contains("import "));
        assert!(!source.contains("export "));
        assert!(!source.contains("fetch("));
        assert!(!source.contains("new WebSocket"));
        assert!(!source.contains("outline"));
    }
}

#[test]
fn unconfigured_stepwise_shows_configuration_state_and_skips_bridge() {
    let host =
        include_str!("../../../../assets/inject/floating-panel/core/host.js").replace("\r\n", "\n");
    let generation =
        include_str!("../../../../assets/inject/floating-panel/stepwise/generation.js")
            .replace("\r\n", "\n");
    let temp = tempfile::tempdir().expect("temp dir should be created");
    let harness_path = temp.path().join("stepwise-unconfigured.cjs");
    let harness = format!(
        r#"
const vm = require("node:vm");
const host = {host};
const generation = {generation};
const settings = {{
  enabled: true,
  baseUrlConfigured: false,
  model: "",
  apiKeyConfigured: false,
  generationMode: "auto",
}};
const hostContext = {{
  state: {{
    settings,
    bridgeStatus: "idle",
    bridgeError: "",
    prompts: [],
    scanBusy: false,
    surpriseUntil: 0,
    scanStatus: "idle",
    activeTab: "next",
    outlineStatus: "idle",
    outlineItems: [],
  }},
  stepwiseEnabled: (value = settings) => value?.enabled === true,
  outlineEnabled: (value = settings) => value?.answerOutlineEnabled === true,
  runtimeEnabled: (value = settings) => value?.enabled === true || value?.answerOutlineEnabled === true,
  stepwiseGenerationMode: (value = settings) => value?.generationMode === "manual" ? "manual" : "auto",
  stepwiseConfigurationReady: (value = settings) => value?.enabled === true
    && value?.baseUrlConfigured === true
    && Boolean(value?.model)
    && value?.apiKeyConfigured === true,
}};
vm.runInNewContext(host + "\nthis.resolveFabExpression = resolveFabExpression;", hostContext);

let bridgeCalls = 0;
const generationContext = {{
  state: {{
    settings,
    bridgePendingHash: "",
    bridgePendingRequestId: 0,
    bridgePendingMode: "auto",
    bridgeCache: new Map(),
    bridgeActiveKey: "",
    stepwiseEpoch: 0,
  }},
  stepwiseEnabled: () => true,
  stepwiseConfigurationReady: () => false,
  normalizeGenerationMode: () => "auto",
  contextSnapshot: () => ({{}}),
  stepwiseGenerationMode: () => "auto",
  renderFloat: () => {{}},
  bridgeCall: () => {{
    bridgeCalls += 1;
    return Promise.resolve({{ status: "ok", items: [] }});
  }},
  pushDiagnostic: () => {{}},
  chatBusy: () => false,
  Promise,
  Map,
}};
vm.runInNewContext(
  generation + "\nthis.requestBridgeStepwise = requestBridgeStepwise;",
  generationContext,
);
generationContext.requestBridgeStepwise("key", "user", "assistant", "auto");
process.stdout.write(JSON.stringify({{
  expression: hostContext.resolveFabExpression(),
  bridgeCalls,
}}));
"#,
        host = serde_json::to_string(&host).expect("host source should serialize"),
        generation =
            serde_json::to_string(&generation).expect("generation source should serialize"),
    );
    std::fs::write(&harness_path, harness).expect("harness should be written");

    let output = Command::new("node")
        .arg(&harness_path)
        .output()
        .expect("node should run stepwise unconfigured harness");
    assert!(
        output.status.success(),
        "node harness failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("harness stdout should be JSON");
    assert_eq!(result["expression"], "curious");
    assert_eq!(result["bridgeCalls"], 0);
}
