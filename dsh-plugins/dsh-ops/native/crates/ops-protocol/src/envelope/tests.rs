use super::*;

fn legacy() -> Value { json!({"root":"/workspace","scope":"session","tool":"stat","args":{"path":"/workspace/file"},"read_only":true,"deny_roots":["/secret"]}) }
fn versioned() -> Value { json!({"version":1,"requestId":"req-1","component":"file","budget":{"timeoutMs":300000,"maxBytes":131072},"request":legacy()}) }
fn decoded(value: &Value) -> Result<Decoded> { decode(&serde_json::to_vec(value).unwrap()) }

#[test]
fn formats_preserve_authority_and_use_bounded_budgets() {
    let old = decoded(&legacy()).unwrap();
    let new = decoded(&versioned()).unwrap();
    assert!(old.request_id.is_none());
    assert_eq!(new.request_id.as_deref(), Some("req-1"));
    assert!(matches!(new.component, Some(Component::File)));
    assert_eq!(new.request.root, old.request.root);
    assert_eq!(new.request.scope, old.request.scope);
    assert_eq!(new.request.deny_roots, ["/secret"]);
    assert!(new.request.read_only);
    assert_eq!(old.budget.max_bytes, MAX_OUTPUT_BYTES);
    assert_eq!(new.budget.timeout_ms, DEFAULT_TIMEOUT_MS);
}
#[test]
fn partial_unknown_and_invalid_envelopes_never_downgrade() {
    for key in ["version", "requestId", "component", "budget", "request"] {
        let mut value = legacy();
        value[key] = json!(1);
        assert!(decoded(&value).is_err(), "marker {key}");
        let mut value = versioned();
        value.as_object_mut().unwrap().remove(key);
        assert!(decoded(&value).is_err(), "missing {key}");
    }
    let mut value = versioned();
    value["version"] = json!(2);
    assert_eq!(decoded(&value).err().unwrap().code, "PROTOCOL_VERSION");
    for (key, invalid) in [("requestId", json!("")), ("requestId", json!("a\nb")), ("requestId", json!("x".repeat(129))), ("component", json!("shell")), ("extra", json!(true))] {
        let mut value = versioned(); value[key] = invalid;
        assert!(decoded(&value).is_err(), "invalid {key}");
    }
    let mut value = versioned(); value["request"]["extra"] = json!(true);
    assert!(decoded(&value).is_err());
    // Decode the original bytes so duplicate struct fields cannot be collapsed by Value.
    let old = serde_json::to_string(&legacy()).unwrap();
    let new = serde_json::to_string(&versioned()).unwrap();
    for text in [old.replacen("{", "{\"root\":\"/other\",", 1), new.replacen("{", "{\"version\":1,", 1), new.replace("\"timeoutMs\":", "\"timeoutMs\":1,\"timeoutMs\":")] {
        assert!(decode(text.as_bytes()).is_err());
    }
}
#[test]
fn budgets_reject_tiny_huge_and_unusable_values_before_execution() {
    for (key, value) in [("timeoutMs", json!(0)), ("timeoutMs", json!(-1)), ("timeoutMs", json!(1.5)), ("timeoutMs", json!(2147483648_u64)), ("maxBytes", json!(1023)), ("maxBytes", json!(131073)), ("extra", json!(1))] {
        let mut input = versioned(); input["budget"][key] = value;
        assert!(decoded(&input).is_err(), "invalid {key}");
    }
    assert_eq!(decode(&vec![b' '; MAX_REQUEST_BYTES + 1]).err().unwrap().code, "OUTPUT_LIMIT");
}
#[test]
fn output_budget_counts_encoded_bytes_and_keeps_effects_honest() {
    assert!(encode_result(&json!({}), Budget { max_bytes: 1, ..Budget::default() }, false).is_err());
    let budget = Budget { max_bytes: 1024, ..Budget::default() };
    let value = json!({"status":"completed","text":"\0".repeat(1000)});
    for (mutating, expected) in [(false,"none"),(true,"unknown")] {
        let bytes = encode_result(&value,budget,mutating).unwrap();
        assert!(bytes.len() <= 1024);
        assert_eq!(bytes.last(), Some(&b'\n'));
        let output: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(output["error"]["code"], "OUTPUT_LIMIT");
        assert_eq!(output["error"]["effectState"], expected);
    }
    for effect in ["none","applied","partial","unknown"] {
        let value = json!({"error":{"effectState":effect,"message":"x".repeat(2000)}});
        let output: Value = serde_json::from_slice(&encode_result(&value,budget,true).unwrap()).unwrap();
        assert_eq!(output["error"]["effectState"],effect);
    }
    let exact = json!({"text":"x".repeat(1012)}); // 1023 serialized bytes plus newline.
    assert_eq!(encode_result(&exact,budget,false).unwrap().len(),1024);
}
