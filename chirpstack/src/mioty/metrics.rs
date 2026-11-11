use std::sync::LazyLock;

use prometheus_client::metrics::counter::Counter;

fn counter(name: &str, help: &str) -> Counter {
    let value = Counter::default();
    crate::monitoring::prometheus::register(name, help, value.clone());
    value
}

static UPLINK_HANDLED: LazyLock<Counter> = LazyLock::new(|| {
    counter(
        "mioty_uplink_handled",
        "BSSCI uplink operations handled, including duplicate receptions",
    )
});
static UPLINK_REJECTED: LazyLock<Counter> = LazyLock::new(|| {
    counter(
        "mioty_uplink_rejected",
        "BSSCI uplink operations rejected during validation or storage processing",
    )
});
static TX_BLOCKED: LazyLock<Counter> = LazyLock::new(|| {
    counter(
        "mioty_rf_tx_blocked",
        "Downlink reservation attempts blocked by the regional RF policy",
    )
});

pub fn uplink_result(handled: bool) {
    if handled {
        UPLINK_HANDLED.inc();
    } else {
        UPLINK_REJECTED.inc();
    }
}

pub fn tx_blocked() {
    TX_BLOCKED.inc();
}
