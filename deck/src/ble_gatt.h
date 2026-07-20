/**
 * BLE GATT peripheral (PR-S1 spike — link only).
 *
 * Advertises a fixed status service, accepts one central, and notifies a
 * heartbeat when subscribed. Chunked STATUS_CTRL/DATA path lands in PR-S2.
 *
 * Wi‑Fi must remain off for the spike (caller responsibility).
 */

#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Device name prefix; full name is "ACD-" + last 4 hex of public MAC. */
#define BLE_DEVICE_NAME_PREFIX "ACD-"

/**
 * Spike UUIDs (128-bit). Stable for host scripts; S2 reuses the same service.
 * Base: a0cd****-acd0-4c00-9c00-00805f9b34fb
 */
#define BLE_UUID_STATUS_SERVICE "a0cd0001-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_HEARTBEAT      "a0cd0002-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_INFO           "a0cd0003-acd0-4c00-9c00-00805f9b34fb"
/* Reserved for PR-S2 (not registered yet): */
#define BLE_UUID_STATUS_CTRL    "a0cd0010-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_STATUS_DATA    "a0cd0011-acd0-4c00-9c00-00805f9b34fb"
#define BLE_UUID_STATUS_STATE   "a0cd0012-acd0-4c00-9c00-00805f9b34fb"

#define BLE_FW_VERSION          "0.1.0-s1"
#define BLE_MAX_PAYLOAD_BYTES   8192
#define BLE_HEARTBEAT_INTERVAL_MS 5000
#define BLE_HEAP_LOG_INTERVAL_MS  30000

/** Initialize NimBLE stack, GATT, and start advertising. Returns false on init failure. */
bool ble_gatt_begin(void);

/** True while a central is connected. */
bool ble_gatt_is_connected(void);

/** Connection count (0 or 1 for this spike). */
uint8_t ble_gatt_connected_count(void);

/** Negotiated ATT MTU for the active connection (0 if none). */
uint16_t ble_gatt_mtu(void);

/** Cumulative connect / disconnect events since boot (for soak logs). */
uint32_t ble_gatt_connect_events(void);
uint32_t ble_gatt_disconnect_events(void);

/**
 * Periodic work: heartbeat notify when subscribed + optional serial diagnostics.
 * Call from loop().
 */
void ble_gatt_poll(void);

#ifdef __cplusplus
}
#endif
